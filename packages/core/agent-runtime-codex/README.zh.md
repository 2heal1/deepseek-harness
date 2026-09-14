# @deepseek-ai/dsh-agent-runtime-codex

[English](README.md) | 中文

Codex App Server 0.147.0 的可选 Profile Bundle 和 `ctx.agentRuntimes` Provider。它通过 `ctx.agentRuntimeLauncher` 启动配置的 Codex 可执行文件，在发布前完成 `initialize` 与 `thread/start` 协议握手，并把串行 turn、assistant delta、完整输出与 turn activity 映射到 Router event sink。

## 配置

使用 `dsh plugin --profile <name> add @deepseek-ai/dsh-agent-runtime-codex` 将本包安装到目标 Profile，重启该 Profile，并在 Runtime Profile 中以 `schemaVersion: 1` 选择 `codex-app-server` Provider。加载 Bundle 只注册 Provider，不会启动 Codex。权限策略必须要求 `sandbox: workspace-write`；Provider 设置 Codex `approvalPolicy: never`，因此无人值守的审批请求会 fail closed。需要 session workspace。该 Provider 不支持恢复。

`app-server --stdio` 仅由 Driver 持有。正常 Profile 使用 `launch.args: []`。Profile 对 `app-server` 或 `--stdio` 的任何写入，即使值与 Driver 要求相同，也会在 spawn 前失败。

Provider 使用 Launcher 的精确环境、凭据解析、脱敏、deadline、进程树释放和必需权限执行。一个已准备进程和 ephemeral Codex thread 会接受串行 submission，直至取消、失败、Provider 移除或 Agent dispose 使进程树完全停稳。Runtime facts 把安全 thread id 公开为 external Session identity。`runtimeActivity` capability 会以完整字段报告每个已观察到的 `turn` phase；本地取消可能先于 Codex 终态通知结算，Provider 不会合成该通知。它不声称提供 command、file、diff、usage 或 tool detail。

`maxFrameBytes` 限制 Codex 单个 UTF-8 JSONL frame，默认值为 1 MiB。超限 frame 会暂停协议流并拒绝活动操作。取消会发送一次尽力而为的 `turn/interrupt`。取消、超限 frame 和协议失败会关闭 stdin，并在 settlement 前等待 Launcher 完成进程树静止与临时材料清理。

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
- Runtime activity 仅覆盖观察到的 turn 生命周期；command、file、diff、usage 与 native-tool detail 仍不可用。
