# dsh-agent-runtime-router

[English](README.md) | 中文

可配置 Agent 运行时唯一的 `AgentFactory` Consumer。它解析 Runtime Profile，选择对应的已注册 Provider，并拥有公共的 Session、Agent、发布、回滚、容量与 teardown 事务。

## 服务：`AgentRuntimeRouter`（ctx key：`agentRuntimeRouter`）

先加载 `AgentRegistry`、`AgentRuntimeRegistry`、`AgentRuntimeProfiles` 与本包，再加载具体 Provider。Router 通过 `ctx.agents.setFactory()` 安装自身；Provider 不会安装或替换该 Factory。

`ctx.agents.create()` 与 `ctx.agents.resume()` 会先解析一份不可变 profile 快照，再在准备资源前捕获该 profile 所选 Provider 的一个确切注册 generation。移除 Provider 会以 `RUNTIME_UNAVAILABLE` 中止该 generation 的持久化加载、preparation、setup 与所有实时 lifecycle。使用同一 id 的替代项只服务后续事务。

发布过程依次进入 Session 与 Agent 注册表，同步通知 `session/created` 和 `agent/created`，发出 `agent/session-start`，再打开准入。注册表查询在这些通知期间可能暴露 Agent，但 waking input 会以 phase 为 `publication` 的 `SUBMISSION_REJECTED` 拒绝。失败会先关闭准入，并在拒绝操作前通过回滚移除两个注册表条目。

调用方 context、Router service 与所选 Provider generation 都是结构化 owner。任一 owner teardown 都汇聚到同一个 memoized disposal：关闭准入、取消并排空 prepared runtime、释放 Agent scope、detach Agent、detach Session，最后释放 profile 容量租约。即使清理最终报告 `DISPOSE_FAILED`，disposal 也会等待 Provider 完全停稳。

## Native 过渡

在 Host 于 F5 迁移期间，现有 Native API 仍保持可用。`RoutedAgent` 把 inbox、status、取消、maintenance 与 send 操作委托给 prepared handle 返回的 Native `AgentDriver`。可选操作由 capability 检查保护。发布期间允许不唤醒的 setup injection；waking input 只有在同步发布成功后才开放。

`AgentOptions.runtimeProfile` 选择 profile；省略时使用已配置的默认项。既有 `provider`、`model` 与 `maxTokens` option 成为 Native profile 覆盖。外部 profile 拒绝仅适用于 Native 的覆盖；除非 profile 明确允许，否则任何 profile 都拒绝 Session 模型覆盖。在 F5 安装规范持久运行时事件前，event sink 会拒绝 assistant 与 activity 输出，而 Native driver 继续追加既有 Native Session 事件。

## 配置

Router 没有配置字段。运行时选择属于 [`dsh-agent-runtime-profile`](../agent-runtime-profile/README.md)。Profile 缺失、snapshot schema version 不兼容、Provider 缺失或被移除时都会明确失败；Router 绝不会回退到 Native。

## 不变量

可选的 `@deepseek-ai/dsh-agent-runtime-router/invariant` companion 有意为空。Session 与 Agent companion 已验证已发布的注册表关系；Router 事务顺序由直接生命周期测试覆盖，而不使用重复的固定样例 invariant。

## 模型体验

### 运行时路由

#### 模型看到的内容

F2 不增加模型可见内容。Native 请求保留相同的 system prompt、工具、消息与 Session 事件；Router 的 `agent/runtime/facts` 是持久元数据，不进入提示词。

#### Token 影响

Router 增加零 token。Native token 用量仍由组装后的提示词、工具 schema 与保留消息决定。

#### KV Cache 影响

Router 不重写请求前缀。Native cache 行为保持不变。

## 已知限制和延后工作

- **没有提供方无关的 submission receipt** - F5 会把 Host 与 Agent API 迁移到 receipt，并安装规范运行时事件生产。
- **尚不接纳外部输出** - 在 F5 可以校验并持久化输出前，通过 event sink 报告 assistant 与 activity 会失败。
- **已解析快照尚未进入 Session Header** - F5 负责持久 profile 身份以及 resume 或 fork 重建；Router 目前为每次 create 或 resume 事务重新解析快照。
