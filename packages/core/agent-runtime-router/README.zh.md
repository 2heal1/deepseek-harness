# dsh-agent-runtime-router

[English](README.md) | 中文

可配置 Agent 运行时唯一的 `AgentFactory` Consumer。它解析 Runtime Profile，选择对应的已注册 Provider，并拥有公共的 Session、Agent、发布、回滚、容量与 teardown 事务。

## 服务：`AgentRuntimeRouter`（ctx key：`agentRuntimeRouter`）

先加载 `AgentRegistry`、`AgentRuntimeRegistry`、`AgentRuntimeProfiles` 与本包，再加载具体 Provider。Router 通过 `ctx.agents.setFactory()` 安装自身；Provider 不会安装或替换该 Factory。

`ctx.agents.create()` 与 `ctx.agents.resume()` 会先解析一份不可变 profile 快照，再在准备资源前捕获该 profile 所选 Provider 的一个确切注册 generation。移除 Provider 会以 `RUNTIME_UNAVAILABLE` 中止该 generation 的持久化加载、preparation、setup 与所有实时 lifecycle。使用同一 id 的替代项只服务后续事务。

发布过程依次进入 Session 与 Agent 注册表，同步通知 `session/created` 和 `agent/created`，发出 `agent/session-start`，再打开准入。注册表查询在这些通知期间可能暴露 Agent，但 waking input 会以 phase 为 `publication` 的 `SUBMISSION_REJECTED` 拒绝。失败会先关闭准入，并在拒绝操作前通过回滚移除两个注册表条目。

调用方 context、Router service 与所选 Provider generation 都是结构化 owner。任一 owner teardown 都汇聚到同一个 memoized disposal：关闭准入、取消并排空 prepared runtime、释放 Agent scope、detach Agent、detach Session，最后释放 profile 容量租约。即使清理最终报告 `DISPOSE_FAILED`，disposal 也会等待 Provider 完全停稳。

## Submission 与事件

`RoutedAgent.submit()` 会同步追加 `agent/submission/accepted`，并返回 receipt；其 `started` 和 `settled` Promise 跟随持久生命周期记录。Router 串行执行 Provider submission，以 `SubmissionId` 定向取消，并在所有已接纳 submission 结算前保持 `Agent.status` 为 running。Disposal 会关闭准入、取消未完成工作，并在释放 Provider 前等待持久结算。

受限 event sink 会追加规范化运行时事实与 activity，以及外部 assistant chunk 和 message。追加前，它会校验 runtime、Provider、submission、turn、capability、provenance 与 JSON 大小关系。Native 执行继续拥有自己的 step、request、inbox、tool 与模型输出事件；精确 turn 关联通过 Native submission request 到达 Router。

## 配置

Router 没有配置字段。运行时选择属于 [`dsh-agent-runtime-profile`](../agent-runtime-profile/README.md)。新 Session 会把完整的已解析快照存入 Header。Resume 只恢复该快照，并拒绝有冲突的调用方覆盖、缺失的 Provider、不兼容的 snapshot version 以及不具备 `resume` 的 runtime；它不会读取当前 Settings 或回退到 Native。Fork 按值复制快照，移除父 runtime facts 与 external identity，重映射保留事件的引用，再准备新的 runtime。

## 不变量

可选的 `@deepseek-ai/dsh-agent-runtime-router/invariant` companion 会独立折叠每个 Session。它校验 submission identity 与顺序、至多一个已启动活动 submission、open-turn 关联、runtime activity 所有权，以及外部 assistant provenance 与最新 runtime facts 的一致性。

## 模型体验

### 运行时路由

#### 模型看到的内容

Native 请求保留既有 system prompt、工具与消息。外部 assistant message 会成为带 `source.kind: 'runtime'` provenance 的规范对话历史；runtime facts、activity 与 submission 生命周期记录不会进入模型输入。

#### Token 影响

Router 增加零 token。Native token 用量仍由组装后的提示词、工具 schema 与保留消息决定。

#### KV Cache 影响

Router 不重写请求前缀。Native cache 行为保持不变。

## 已知限制和延后工作

- **外部协议 Provider 属于后续工作** - Router 已能持久化并投影其规范输出，但 Codex App Server 与 ACP runtime 实现由后续工作包交付。
- **持久化 flush 仍由调用方负责** - Receipt settlement 跟随同步事件追加与分发；Host 在自己的响应边界 flush 存储与 transport 队列。
