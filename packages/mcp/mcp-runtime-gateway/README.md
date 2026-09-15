# @deepseek-ai/dsh-mcp-runtime-gateway

English | [中文](README.zh.md)

Loopback Streamable HTTP MCP server that exposes a Runtime Profile's exact Harness-tool allowlist to one external Agent Runtime.

## Service

`AgentRuntimeMcpGateway.open()` binds an Agent, runtime id, Provider id, and tool allowlist to an unguessable URL and bearer token. Each handle owns its endpoint; `dispose()` revokes it, cancels active calls, and waits for them to settle. The shared listener accepts POST requests only and enforces configured request and response byte limits.

Discovery intersects the profile allowlist with tools currently visible in the Agent scope. Execution repeats both checks, requires the runtime's active submission and open turn, and calls `ctx.tools.execute()` with the owning Agent and cancellation signal. Existing approval, workspace, delegation-depth, capacity, and tool-policy plugins therefore remain authoritative.

The token is launch-scoped secret material. Providers must pass it only through the launcher's Driver-reserved secret environment and must not persist or log it.

## Audit

Accepted calls append non-surface `agent/runtime/tool-call` and `agent/runtime/tool-result` events. They identify the runtime, Provider, submission, turn, and call without creating a Native Agent step or adding tool output to model history.

## Configuration

`port` defaults to `0`, selecting an operating-system-assigned loopback port. `maxRequestBytes` defaults to 1 MiB and `maxResponseBytes` defaults to 4 MiB.

## Model Experience

### Allowed Harness tools

#### What the model sees

The external runtime discovers each currently visible tool named by the Runtime Profile allowlist, such as `delegate_to_acp_child`, including its description and JSON input schema. Tool responses contain rendered text or image content.

#### Token effect

The external runtime pays the schema cost of the allowed tools according to its MCP implementation. This package adds no Harness prompt or Harness LLM request tokens.

#### KV Cache effect

The package does not change Harness LLM cache inputs. External-runtime cache reuse depends on that product's handling of MCP tool definitions.

## Known Limitations and Deferred Work

- The gateway supports Streamable HTTP over IPv4 loopback only.
- Runtime resume and continuable external child sessions are outside this package.
