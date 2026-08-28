# dsh-agent-runtime

[English](README.md) | 中文

可配置 Agent 运行时的提供方注册表与提供方无关词汇。本包承担 Service Definition 角色；Router、Native 与外部协议实现分别位于独立的 Consumer 和 Service Provider 包中。

## 服务：`AgentRuntimeRegistry`（ctx key：`agentRuntimes`）

`ctx.agentRuntimes` 保存当前可选择的运行时提供方。注册由 effect 管理生命周期，会拒绝格式错误或重复的提供方 identity，并在对应的注册表提交点发出 `agent-runtime/provider-added` 和 `agent-runtime/provider-removed`。

- `registerProvider(provider)` 注册一个可信的同进程 Provider，并返回其 Cordis disposer。
- `getProvider(id)` 返回具有该品牌化 id 且当前可选择的 Provider。
- `listProviders()` 按注册顺序返回一个分离的数组。

移除注册会阻止后续选择，但不会撤销已经 prepared 的 handle。Provider 插件跟踪自己 prepared 的每个 handle，并在释放注册前排空这些 handle。

## Provider 约定

`AgentRuntimeProvider` 声明其接受的 Runtime Profile 快照 schema version，并实现两个操作：

- `probe(request)` 在不创建 Harness Session 的前提下检查可用性、兼容性、有效 capability 和权限执行情况。
- `prepare(request)` 为一个未发布 Agent 分配资源并返回 `PreparedAgentRuntime`。

Router 提供预留的运行时和 Session identity、完整的非秘密 `RuntimeProfileSnapshot`、未发布的 Agent context、取消 signal 以及受限的 `AgentRuntimeEventSink`。Provider 不能任意追加 Session 事件、注册 Session 或 Agent，也不能打开 submission 准入。

prepared handle 在整个生命周期内固定其 capability 集合，公开初始规范化运行时 facts，接收已经准入的 submission 和定向取消，并通过 dispose 达到资源与进程树完全停稳。`snapshotAgentRuntimeCapabilities()` 和 `snapshotAgentRuntimeFacts()` 会分离、校验并深度冻结 Provider 提供的值。

## 公开词汇

本包拥有品牌化的 provider、profile、runtime、submission 和 external-session identifier。`RuntimeProfileSnapshot` 携带已解析的非秘密启动、模型、产品、权限、工具、凭据引用、deadline 和容量输入。它绝不携带已解析凭据值、生成的 gateway token、临时路径、进程 id、协商出的 capability 或 external-session identity。

`SubmissionReceipt` 通过两个 Promise 关联一条已接受的用户消息。`started` 解析为已分配的 turn 或持久的 not-started 结果；`settled` 在 terminal submission 事件完成同步分发后解析。两个 Promise 都不包含持久化 flush 或传输输出队列 flush。

`AgentRuntimeError` 扩展 `HarnessError`，并携带冻结、可序列化的 `failure`：稳定 code、操作 phase、安全 message、可选 provider id 与可选的已脱敏 details。details 必须是无损 JSON，且序列化后最多为 4096 个 UTF-8 字节。本地 `cause` 不属于可序列化 failure。

## 不变量

可选的 `@deepseek-ai/dsh-agent-runtime/invariant` companion 会验证 provider-added 和 provider-removed 事件与权威注册表状态一致。根服务不会隐式加载诊断。

## 模型体验

### 运行时提供方输出

#### 模型看到的内容

Router Consumer 可以把通过 `assistantMessage()` 报告的内容转换为规范 Session 消息。注册表、快照、capability、receipt 和错误不增加模型可见文本。

#### Token 影响

本包直接增加零 token。所选 Provider 的已接受 assistant 输出会通过 Router 影响后续保留的对话历史。

#### KV Cache 影响

本包自身不改变请求前缀。按照 Router 的事件规则追加到规范历史的 Provider 输出会扩展可复用的对话前缀。

## 已知限制和延后工作

- **不含 Router 或运行时实现** — 本包不安装 `AgentFactory`、不发布 Agent，也不提供 Native、Codex 或 ACP 执行；F2 和协议 Provider 包会消费此 Service Definition。
- **Profile 编写与校验相互独立** — 快照类型记录已解析字段；Settings schema、默认值、校验、容量准入和凭据解析属于 profile Consumer。
- **事件是报告，不是持久化权限** — F5 定义持久运行时事件 schema 与 Router 校验；Provider 只接收这里声明的受限报告 sink。
