# @deepseek-ai/dsh-agent-runtime-codex

English | [中文](README.zh.md)

Optional Profile Bundle and Codex App Server 0.147.0 Provider for `ctx.agentRuntimes`. It starts the configured Codex executable through `ctx.agentRuntimeLauncher`, completes the `initialize` and `thread/start` protocol handshake before publication, and maps serial turns, assistant deltas, completed output, and turn activity to the Router event sink.

## Configuration

Install this package into the target Profile with `dsh plugin --profile <name> add @deepseek-ai/dsh-agent-runtime-codex`, restart that Profile, and select provider `codex-app-server` with `schemaVersion: 1` in a Runtime Profile. Loading the Bundle registers the Provider without starting Codex. The permission policy must require `sandbox: workspace-write`; the Provider sets Codex `approvalPolicy: never`, so unattended approval requests fail closed. A session workspace is required. The Provider does not support resume.

`app-server --stdio` belongs exclusively to the Driver. Set `launch.args: []` for normal profiles. Any Profile spelling of `app-server` or `--stdio`, including the required spelling, fails before spawn.

The Provider uses the launcher's exact environment, credential resolution, redaction, deadlines, process-tree disposal, and required-permission enforcement. One prepared process and ephemeral Codex thread accept serial submissions until cancellation, failure, Provider removal, or Agent disposal reaches process-tree quiescence. Runtime facts expose the safe thread id as the external Session identity. The `runtimeActivity` capability reports each observed `turn` phase with complete fields; local cancellation may settle before Codex emits a terminal notification, and the Provider does not synthesize one. It does not claim command, file, diff, usage, or tool detail.

`maxFrameBytes` bounds a single UTF-8 JSONL frame from Codex; its default is 1 MiB. An oversized frame pauses the protocol stream and rejects the active operation. Cancellation sends one best-effort `turn/interrupt`. Cancellation, oversized frames, and protocol failures close stdin and wait for Launcher process-tree quiescence and temporary-material cleanup before settlement.

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
- Runtime activity covers the observed turn lifecycle only; command, file, diff, usage, and native-tool details remain unavailable.
