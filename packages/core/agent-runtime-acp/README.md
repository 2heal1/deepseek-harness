# @deepseek-ai/dsh-agent-runtime-acp

English | [中文](README.zh.md)

ACP protocol-v1 one-shot Provider for `ctx.agentRuntimes`, using `@agentclientprotocol/sdk@0.25.1`. It starts the configured executable through `ctx.agentRuntimeLauncher`, validates the negotiated protocol version, creates one ACP session before publication, and accepts one submission.

## Configuration

Select provider `acp` in a Runtime Profile. The profile requires a session workspace and the `workspace-write` unattended permission policy. The illustrative Driver does not prove product-native sandbox enforcement, so it accepts `enforcement: best-effort` and rejects `enforcement: required` before spawn. The Provider advertises no optional runtime capabilities and does not support resume.

`maxFrameBytes` limits each inbound JSONL frame by UTF-8 bytes and defaults to 1048576. `maxOutputBytes` limits the cumulative assistant text for the submission and defaults to 4194304. `maxStderrBytes` bounds the diagnostic tail continuously drained from child stderr and defaults to 65536. Malformed and oversized input fails with diagnostics that do not include peer-controlled frame contents.

The trusted `acp-agent-cli` Driver injects `acp serve`. Set `launch.args: []` for normal profiles. Any Profile spelling of `acp` or `serve`, including the required spelling, fails before spawn.

The Provider advertises no ACP client filesystem or terminal capabilities and rejects every ACP permission request. It uses the launcher's exact environment, credential resolution, redaction, deadlines, and process-tree disposal.

Assistant text from ordered `session/update` notifications is streamed to the Router sink and joined into one final assistant message. `end_turn`, `max_tokens`, `refusal`, and `cancelled` map to provider-neutral terminal reasons; `max_turn_requests` is a runtime failure.

Cancellation sends one best-effort `session/cancel` and continues accepting complete update frames until the prompt settles. If the agent does not cooperate before the shared shutdown deadline, the Launcher closes protocol input, terminates the process tree, and waits for complete quiescence. The Provider waits for ACP connection closure before publishing the joined final message. Success, cancellation, timeout, protocol failure, startup rollback, and explicit disposal all remove launch resources before settling.

## Model Experience

### ACP conversation

#### What the model sees

The ACP process receives accepted `text` user-message blocks. Assistant text updates are transient output; their joined final message becomes durable Router-owned runtime history.

#### Token effect

The Provider adds no Harness prompt text or tool schemas. Its completed assistant message contributes to retained conversation after settlement.

#### KV Cache effect

The Provider does not contribute to Harness LLM request caching.

## Known Limitations and Deferred Work

- V1 accepts exactly one text-only submission and does not expose resume, images, ACP tool activity, or Harness tool transport.
- The trusted `acp-agent-cli` launch declaration is product-specific; another ACP-compatible executable requires a separately reviewed Driver declaration rather than Profile-owned protocol arguments.
