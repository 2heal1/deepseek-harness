# @deepseek-ai/dsh-subagent-runtime-route

English | [中文](README.zh.md)

Settings-backed one-shot subagent routes over the existing `ctx.subagents` registry. Each configured route binds one Runtime Profile to one model-facing delegation tool without introducing another child-routing authority.

## Service: `AgentRuntimeSubagentRoutes` (ctx key: `agentRuntimeSubagentRoutes`)

The service reads route definitions from `ctx.agentRuntimeProfiles`. For each route it registers:

- A `SubagentProvider` under the route id.
- One `dsh-tool-subagent` instance under the configured tool name.

The wrapper resolves a fresh immutable profile snapshot when a request starts, checks the absolute delegation-depth limit and Provider snapshot-version support, selects the underlying `ctx.agentRuntimes` Provider, and waits for capacity. The effective limit is the lower of profile capacity and route capacity.

The existing `ctx.subagents.start()` remains the public dispatch and lifecycle authority. The wrapper prepares the runtime directly after that outer service validates the route provider's declared capabilities and emits its lifecycle events; it does not introduce another subagent routing pass.

## Lifecycle and cancellation

Each start creates a detached Harness Session and unpublished private Agent scope with fresh child, runtime, and submission identities. The Session Header records the parent Session, delegation depth, child workspace, and complete non-secret Runtime Profile snapshot. Neither identity enters the public Session or Agent registries.

The child sends one text submission to the prepared external runtime. The route sink validates runtime, Provider, and submission correlation, returns a non-empty final assistant message when present, and otherwise joins streamed text deltas. Runtime terminal reasons map to the existing `SubagentResult` stop reasons. Runtime facts and activity are correlation-checked but are not persisted for the detached child.

Capacity waits are FIFO and use the request signal for cancellation. Parent cancellation targets the child submission. Disposal requests a separate disposed cancellation and waits for the result, Provider quiescence, and private Agent scope disposal before releasing capacity. Startup rollback releases all acquired resources before rejecting; repeated disposal shares one promise and releases exactly once.

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

A missing runtime Provider fails with `SubagentError` code `NO_PROVIDER`; an incompatible snapshot version fails with `AgentRuntimeError` code `RUNTIME_INCOMPATIBLE`; an exceeded depth limit uses `DEPTH_EXCEEDED`. `parent-workspace` profiles require a parent Session working directory, while a fixed working-directory policy uses its configured path.

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
- **External Providers only** - a Provider that returns a Native `agentDriver` is rejected because this route owns a detached one-shot result rather than a published Agent.
- **No durable child transcript or activity** - the detached Session supplies runtime context but is not registered or persisted; only the final `SubagentResult` returns to the parent.
- **Provider-owned launch enforcement** - secure process launch, exact environments, credential isolation, sandbox enforcement, and process-tree teardown remain obligations of the selected runtime Provider and shared launcher.
