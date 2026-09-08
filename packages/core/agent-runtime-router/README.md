# dsh-agent-runtime-router

English | [中文](README.zh.md)

The sole `AgentFactory` Consumer for configurable Agent runtimes. It resolves a Runtime Profile, selects its registered Provider, and owns the common Session, Agent, publication, rollback, capacity, and teardown transaction.

## Service: `AgentRuntimeRouter` (ctx key: `agentRuntimeRouter`)

Load `AgentRegistry`, `AgentRuntimeRegistry`, `AgentRuntimeProfiles`, and this package before a concrete Provider. The Router installs itself through `ctx.agents.setFactory()`; Providers never install or replace that factory.

`ctx.agents.create()` and `ctx.agents.resume()` resolve one immutable profile snapshot, then capture one exact registration generation for that profile's Provider before preparing resources. Provider removal aborts persistence loading, preparation, setup, and every live lifecycle from that generation with `RUNTIME_UNAVAILABLE`. A replacement with the same id serves only later transactions.

Publication enters the Session and Agent registries, synchronously announces `session/created` and `agent/created`, emits `agent/session-start`, then opens admission. Registry lookup may expose the Agent during those notifications, but waking input rejects with `SUBMISSION_REJECTED` in phase `publication`. Failure closes admission before rollback and removes both registry entries before rejecting.

The caller context, Router service, and selected Provider generation are structural owners. Any owner teardown converges on one memoized disposal: close admission, cancel and drain the prepared runtime, dispose the Agent scope, detach the Agent, detach the Session, then release the profile capacity lease. Disposal waits for provider quiescence even when cleanup ultimately reports `DISPOSE_FAILED`.

## Submission and events

`RoutedAgent.submit()` synchronously appends `agent/submission/accepted` and returns a receipt whose `started` and `settled` promises follow the durable lifecycle records. The Router serializes Provider submissions, targets cancellation by `SubmissionId`, and keeps `Agent.status` running until every admitted submission settles. Disposal closes admission, cancels outstanding work, and waits for durable settlement before releasing the Provider.

The restricted event sink appends normalized runtime facts and activity plus external assistant chunks and messages. It verifies runtime, Provider, submission, turn, capability, provenance, and JSON-size relationships before append. Native execution continues to own its step, request, inbox, tool, and model-output events; exact turn correlation reaches the Router through the Native submission request.

## Configuration

The Router has no configuration fields. Runtime selection belongs to [`dsh-agent-runtime-profile`](../agent-runtime-profile/README.md). A new Session stores its complete resolved snapshot in the Header. Resume restores only that snapshot and rejects conflicting caller overrides, missing Providers, incompatible snapshot versions, and runtimes without `resume`; it never consults current Settings or falls back to Native. Fork copies the snapshot by value, removes parent runtime facts and external identity, remaps retained event references, and prepares a new runtime.

## Invariants

The optional `@deepseek-ai/dsh-agent-runtime-router/invariant` companion folds each Session independently. It verifies submission identity and ordering, one active started submission, open-turn correlation, runtime activity ownership, and external assistant provenance against the latest runtime facts.

## Model Experience

### Runtime routing

#### What the model sees

Native requests retain their existing system prompt, tools, and messages. External assistant messages become canonical conversation history with `source.kind: 'runtime'` provenance; runtime facts, activity, and submission lifecycle records remain model-hidden.

#### Token effect

The Router adds zero tokens. Native token use remains determined by the assembled prompt, tool schemas, and retained messages.

#### KV Cache effect

The Router does not rewrite request prefixes. Native cache behavior is unchanged.

## Known Limitations and Deferred Work

- **External protocol Providers remain separate work** - the Router can persist and project their canonical output, but Codex App Server and ACP runtime implementations are delivered by later work packages.
- **Persistence flushing remains caller-owned** - receipt settlement follows synchronous event append and dispatch; Hosts flush storage and transport queues at their own response boundary.
