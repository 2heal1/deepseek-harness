# @deepseek-ai/dsh-agent-runtime-codex

English | [中文](README.zh.md)

Codex App Server 0.147.0 Provider for `ctx.agentRuntimes`. It starts the configured Codex executable through `ctx.agentRuntimeLauncher`, completes the `initialize` and `thread/start` protocol handshake before publication, and maps protocol assistant deltas and completed output to the Router event sink.

## Configuration

Select provider `codex-app-server` in a Runtime Profile. Its permission policy must require `sandbox: workspace-write`; the Provider sets Codex `approvalPolicy: never`, so unattended approval requests fail closed. A session workspace is required. The Provider does not support resume.

`app-server --stdio` belongs exclusively to the Driver. Set `launch.args: []` for normal profiles. Any Profile spelling of `app-server` or `--stdio`, including the required spelling, fails before spawn.

The Provider uses the launcher's exact environment, credential resolution, redaction, deadlines, process-tree disposal, and required-permission enforcement. It reports no optional runtime capabilities in V1.

## Model Experience

### Codex conversation

#### What the model sees

The Codex process receives accepted `text` user-message blocks. Assistant deltas are transient output; the final assistant message becomes durable Router-owned runtime history for later requests.

#### Token effect

The Provider adds no Harness prompt text or tool schemas. Its completed assistant message contributes to the retained conversation after the turn settles.

#### KV Cache effect

The Provider does not contribute to Harness LLM request caching.

## Known Limitations and Deferred Work

- Codex V1 does not expose resume or Harness tool transport.
- Cancellation, output backpressure, and failure-cleanup state transitions require the D1 advanced state-machine review before release.
