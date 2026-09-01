# @deepseek-ai/dsh-subagent-runtime-route

[English](README.md) | 中文

在现有 `ctx.subagents` 注册表上提供由 Settings 支持的一次性 subagent route。每条已配置 route 把一份 Runtime Profile 绑定到一个面向模型的委派工具，不引入另一套子级路由权威。

## 服务：`AgentRuntimeSubagentRoutes`（ctx key：`agentRuntimeSubagentRoutes`）

本服务从 `ctx.agentRuntimeProfiles` 读取 route 定义。它为每条 route 注册：

- 一个以 route id 命名的 `SubagentProvider`。
- 一个以配置工具名命名的 `dsh-tool-subagent` 实例。

包装 Provider 在请求启动时解析新的不可变 profile 快照，检查绝对委派深度限制，根据快照中的运行时 Provider id 选择底层 `ctx.subagents` Provider，再等待容量。有效限制取 profile 容量和 route 容量中的较小值。所选 Provider 通过 `ResolvedSubagentStartRequest.runtimeProfile` 接收快照。

现有 `ctx.subagents.start()` 仍是公开 dispatch 与生命周期权威。只有外层服务校验 route Provider 声明的能力并发出生命周期事件后，包装层才直接调用所选 Provider；这样可以避免递归执行第二轮路由。

## 生命周期与取消

容量等待使用 FIFO，并由请求 signal 取消。启动失败会在拒绝前释放租约。已发布运行会持有租约，直到底层 `dispose()` 完全停稳；重复 dispose 共享一个 Promise，租约只释放一次。

Settings 更新会串行 reconcile route fiber。未变化的 route 保持挂载。编辑或删除 route 时，会先 dispose 原 Provider 与工具注册，再进行替换。插件 dispose 会等待待处理的 reconcile，并移除全部已挂载 route。Reconcile 失败会写入日志，不会产生未处理的 rejection。

## 配置

本插件没有配置字段。Runtime route 定义存放在 [`dsh-agent-runtime-profile`](../../core/agent-runtime-profile/README.md) 所拥有的 `agent-runtime` Settings 命名空间：

```yaml
subagentRoutes:
  acp-child:
    runtimeProfile: acp-child
    mode: one-shot
    maxDepth: 3
    maxConcurrentRuns: 2
    toolName: delegate_to_acp_child
```

Route id 不得等于所选底层 Provider id，否则会递归选中包装层自身。Provider 缺失或自引用时，以 code 为 `NO_PROVIDER` 的 `SubagentError` 失败；超过深度限制时使用 `DEPTH_EXCEEDED`。

## 不变量

可选的 `@deepseek-ai/dsh-subagent-runtime-route/invariant` companion 有意为空。Route fiber 是 effect-scoped 注册，其 Settings reconcile 与 teardown 由直接测试验证，而不使用固定的全局样例。

## 模型体验

### 委派工具

#### 模型看到的内容

每条已挂载 route 都会以其配置名称贡献 [`dsh-tool-subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent)。它是没有后台选项的前台一次性 route；所选子 agent 在自己的 Runtime Profile 下以全新运行接收任务。

#### Token 影响

每条已挂载 route 向父请求增加一个固定工具 schema。任务和最终子级结果按照 `dsh-tool-subagent` 的规则保留在父级历史中；子级工作上下文保持独立。

#### KV Cache 影响

Route 名称与挂载定义不变时前缀稳定。增加、编辑或删除 route 可能从第一个受影响请求开始改变工具定义。

## 已知限制和延后工作

- **仅支持一次性运行** - 可续接外部子 agent 需要等待公共 submission 与冷恢复行为。
- **不提供运行时 Provider 实现** - 所选 profile id 必须解析到另行注册、且理解 `runtimeProfile` 的 `ctx.subagents` Provider。
- **不执行启动策略** - 安全进程启动、精确环境、沙箱执行与 teardown 升级属于 F4 Provider 和安全启动器。
