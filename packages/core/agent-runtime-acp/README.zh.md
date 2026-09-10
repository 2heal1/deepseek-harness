# @deepseek-ai/dsh-agent-runtime-acp

[English](README.md) | 中文

使用 `@agentclientprotocol/sdk@0.25.1` 的 ACP（Agent Client Protocol）协议 v1 一次性 `ctx.agentRuntimes` Provider。它通过 `ctx.agentRuntimeLauncher` 启动配置的可执行文件，校验协商协议版本，在发布前创建一个 ACP session，并接收一次 submission。

## 配置

在 Runtime Profile 中选择 `acp` Provider。Profile 需要 session workspace 和 `workspace-write` 无人值守权限策略。示例 Driver 不能证明产品原生沙箱的强制执行能力，因此接受 `enforcement: best-effort`，并在 spawn 前拒绝 `enforcement: required`。Provider 不声明可选 runtime capability，也不支持 resume。

`maxFrameBytes` 按 UTF-8 字节数限制每个输入 JSONL frame，默认值为 1048576。`maxOutputBytes` 限制本次 submission 的累计 assistant 文本，默认值为 4194304。`maxStderrBytes` 限制从子进程 stderr 持续排空的诊断尾部，默认值为 65536。格式错误或超限的输入会触发失败，诊断中不包含由对端控制的 frame 内容。

可信的 `acp-agent-cli` Driver 注入 `acp serve`。正常 Profile 使用 `launch.args: []`。Profile 对 `acp` 或 `serve` 的任何写入，即使值与 Driver 要求相同，也会在 spawn 前失败。

Provider 不声明 ACP Client 文件系统或终端能力，并拒绝所有 ACP 权限请求。它使用 Launcher 的精确环境、凭据解析、脱敏、deadline 和进程树释放。

来自有序 `session/update` 通知的 assistant 文本会流式写入 Router sink，并合并为一条最终 assistant 消息。`end_turn`、`max_tokens`、`refusal` 和 `cancelled` 映射到提供方无关的终止原因；`max_turn_requests` 属于运行时失败。

取消会发送一次尽力而为的 `session/cancel`，并继续接收完整更新帧，直至 prompt 结算。如果 agent 未在共享 shutdown deadline 前协作，Launcher 会关闭协议输入、终止进程树并等待完全停稳。Provider 会在发布合并后的最终消息前等待 ACP connection 关闭。成功、取消、超时、协议失败、启动回滚和显式释放都会在结算前移除启动资源。

## 模型体验

### ACP 对话

#### 模型可见内容

ACP 进程接收已接纳的 `text` 用户消息块。Assistant 文本更新是暂态输出；合并后的最终消息会成为 Router 自有的持久运行时历史。

#### Token 影响

Provider 不增加 Harness prompt 文本或工具 schema。其完整 assistant 消息会在结算后进入保留对话。

#### KV Cache 影响

Provider 不参与 Harness LLM 请求缓存。

## 已知限制和延后工作

- V1 只接受一次纯文本 submission，不提供 resume、图片、ACP 工具活动或 Harness 工具传输。
- 可信的 `acp-agent-cli` 启动声明是产品专用声明；其他 ACP 兼容可执行文件需要单独评审的 Driver 声明，不能通过 Profile 自有协议参数接入。
