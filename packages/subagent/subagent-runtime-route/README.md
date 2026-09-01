# @deepseek-ai/dsh-subagent-runtime-route

English | [中文](README.zh.md)

Settings-backed one-shot subagent routes over the existing `ctx.subagents` registry. Each configured route binds one Runtime Profile to one model-facing delegation tool without introducing another child-routing authority.

## Service: `AgentRuntimeSubagentRoutes` (ctx key: `agentRuntimeSubagentRoutes`)

The service reads route definitions from `ctx.agentRuntimeProfiles`. For each route it registers:

- A `SubagentProvider` under the route id.
- One `dsh-tool-subagent` instance under the configured tool name.

The wrapper resolves a fresh immutable profile snapshot when a request starts, checks the absolute delegation-depth limit, selects the underlying `ctx.subagents` Provider from the snapshot's runtime Provider id, and waits for capacity. The effective limit is the lower of profile capacity and route capacity. The selected Provider receives the snapshot through `ResolvedSubagentStartRequest.runtimeProfile`.

The existing `ctx.subagents.start()` remains the public dispatch and lifecycle authority. The wrapper calls the selected Provider directly only after that outer service has validated the route provider's declared capabilities and emitted its lifecycle events; this avoids a recursive second routing pass.

## Lifecycle and cancellation

Capacity waits are FIFO and use the request signal for cancellation. A startup failure releases the lease before rejecting. A published run keeps the lease until its underlying `dispose()` reaches quiescence; repeated disposal shares one promise and releases exactly once.

Settings updates reconcile route fibers serially. An unchanged route remains mounted. Editing or deleting a route disposes its previous Provider and tool registrations before replacement. Plugin disposal waits for pending reconciliation and removes every mounted route. Reconciliation failures are logged and do not create an unhandled rejection.

## Configuration

This plugin has no fields. Runtime route definitions live in the `agent-runtime` Settings namespace owned by [`dsh-agent-runtime-profile`](../../core/agent-runtime-profile/README.md):

```yaml
subagentRoutes:
  acp-child:
    runtimeProfile: acp-child
    mode: one-shot
    maxDepth: 3
    maxConcurrentRuns: 2
    toolName: delegate_to_acp_child
```

Route ids must not equal the selected underlying Provider id, because that would recursively select the wrapper itself. A missing or self-referential Provider fails with `SubagentError` code `NO_PROVIDER`; an exceeded depth limit uses `DEPTH_EXCEEDED`.

## Invariants

The optional `@deepseek-ai/dsh-subagent-runtime-route/invariant` companion is intentionally empty. Route fibers are effect-scoped registrations whose Settings reconciliation and teardown are verified directly rather than through fixed global examples.

## Model Experience

### Delegation tool

#### What the model sees

Each mounted route contributes the [`dsh-tool-subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under its configured name. It is a foreground one-shot route with no background option; the selected child receives the task as a fresh run under its own Runtime Profile.

#### Token effect

Each mounted route adds one fixed tool schema to the parent request. The task and final child result remain in parent history according to `dsh-tool-subagent`; child working context remains separate.

#### KV Cache effect

Prefix-stable while route names and mounted definitions remain unchanged. Adding, editing, or deleting a route can change tool definitions from the first affected request.

## Known Limitations and Deferred Work

- **One-shot only** - continuable external children wait for the common submission and cold-resume behavior.
- **No runtime Provider implementation** - the selected profile id must resolve to a separately registered `ctx.subagents` Provider that understands `runtimeProfile`.
- **No launch enforcement** - secure process launch, exact environments, sandbox enforcement, and teardown escalation belong to F4 Providers and the secure launcher.
