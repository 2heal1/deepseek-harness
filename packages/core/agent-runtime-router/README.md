# dsh-agent-runtime-router

English | [中文](README.zh.md)

The sole `AgentFactory` Consumer for configurable Agent runtimes. It resolves a Runtime Profile, selects its registered Provider, and owns the common Session, Agent, publication, rollback, capacity, and teardown transaction.

## Service: `AgentRuntimeRouter` (ctx key: `agentRuntimeRouter`)

Load `AgentRegistry`, `AgentRuntimeRegistry`, `AgentRuntimeProfiles`, and this package before a concrete Provider. The Router installs itself through `ctx.agents.setFactory()`; Providers never install or replace that factory.

`ctx.agents.create()` and `ctx.agents.resume()` resolve one immutable profile snapshot, then capture one exact registration generation for that profile's Provider before preparing resources. Provider removal aborts persistence loading, preparation, setup, and every live lifecycle from that generation with `RUNTIME_UNAVAILABLE`. A replacement with the same id serves only later transactions.

Publication enters the Session and Agent registries, synchronously announces `session/created` and `agent/created`, emits `agent/session-start`, then opens admission. Registry lookup may expose the Agent during those notifications, but waking input rejects with `SUBMISSION_REJECTED` in phase `publication`. Failure closes admission before rollback and removes both registry entries before rejecting.

The caller context, Router service, and selected Provider generation are structural owners. Any owner teardown converges on one memoized disposal: close admission, cancel and drain the prepared runtime, dispose the Agent scope, detach the Agent, detach the Session, then release the profile capacity lease. Disposal waits for provider quiescence even when cleanup ultimately reports `DISPOSE_FAILED`.

## Native Transition

The existing Native API remains available while Hosts migrate in F5. `RoutedAgent` delegates inbox, status, cancellation, maintenance, and send operations to the Native `AgentDriver` returned by the prepared handle. Capability checks guard optional operations. Non-waking setup injection is permitted during publication; waking input opens only after synchronous publication succeeds.

`AgentOptions.runtimeProfile` selects a profile; omission uses the configured default. Existing `provider`, `model`, and `maxTokens` options become Native profile overrides. External profiles reject Native-only overrides, and every profile rejects a Session model override unless it explicitly allows one. The event sink rejects assistant and activity output until F5 installs canonical durable runtime events, while the Native driver continues to append the established Native Session events.

## Configuration

The Router has no configuration fields. Runtime selection belongs to [`dsh-agent-runtime-profile`](../agent-runtime-profile/README.md). Missing profiles, incompatible snapshot schema versions, and absent or removed Providers fail explicitly; the Router never falls back to Native.

## Invariants

The optional `@deepseek-ai/dsh-agent-runtime-router/invariant` companion is intentionally empty. Session and Agent companions already verify the published registry relationships; Router transaction ordering is covered by direct lifecycle tests rather than a duplicate fixed-example invariant.

## Model Experience

### Runtime routing

#### What the model sees

F2 adds no model-visible content. Native requests retain the same system prompt, tools, messages, and Session events; the Router's `agent/runtime/facts` remain durable metadata rather than prompt content.

#### Token effect

The Router adds zero tokens. Native token use remains determined by the assembled prompt, tool schemas, and retained messages.

#### KV Cache effect

The Router does not rewrite request prefixes. Native cache behavior is unchanged.

## Known Limitations and Deferred Work

- **No provider-neutral submission receipts** - F5 migrates Hosts and the Agent API to receipts and installs canonical runtime event production.
- **No external output admission yet** - assistant and activity reports through the event sink fail until F5 can validate and persist them.
- **Resolved snapshots are not yet Session headers** - F5 owns durable profile identity and resume or fork reconstruction; the Router currently resolves a fresh snapshot for each create or resume transaction.
