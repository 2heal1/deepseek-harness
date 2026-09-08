# @deepseek-ai/dsh-agent-runtime-codex

[English](README.md) | 中文

Codex App Server 0.147.0 的 `ctx.agentRuntimes` Provider。它通过 `ctx.agentRuntimeLauncher` 启动配置的 Codex 可执行文件，在发布前完成 `initialize` 与 `thread/start` 协议握手，并把协议 assistant delta 与完整输出映射到 Router event sink。

## 配置

在 Runtime Profile 中选择 `codex-app-server` Provider。其权限策略必须要求 `sandbox: workspace-write`；Provider 设置 Codex `approvalPolicy: never`，因此无人值守的审批请求会 fail closed。需要 session workspace。该 Provider 不支持恢复。

`app-server --stdio` 仅由 Driver 持有。正常 Profile 使用 `launch.args: []`。Profile 对 `app-server` 或 `--stdio` 的任何写入，即使值与 Driver 要求相同，也会在 spawn 前失败。

Provider 使用 Launcher 的精确环境、凭据解析、脱敏、deadline、进程树释放和必需权限执行。V1 不报告可选 runtime capability。

## 模型体验

### Codex 对话

#### 模型可见内容

Codex 进程接收已接受的 `text` 用户消息块。Assistant delta 是暂态输出；最终 assistant 消息会成为后续请求的 Router 自有持久历史。

#### Token 影响

Provider 不增加 Harness prompt text 或 tool schema。其完整 assistant 消息会在 turn settlement 后进入保留的对话。

#### KV Cache 影响

Provider 不参与 Harness LLM 请求缓存。

## 已知限制和延后工作

- Codex V1 不提供恢复或 Harness tool transport。
- 取消、输出背压和失败清理状态转换必须在发布前完成 D1 高级状态机评审。
