# @deepseek-ai/dsh-agent-runtime-profile

English | [中文](README.zh.md)

Settings-backed Runtime Profile resolution shared by the Agent Router and runtime-backed subagent routes. The service validates one complete non-secret settings document and resolves each new run to an immutable `RuntimeProfileSnapshot`.

## Service: `AgentRuntimeProfiles` (ctx key: `agentRuntimeProfiles`)

The plugin config is the base value for the `agent-runtime` Settings namespace. When `ctx.settings` is present, saved settings replace that base and each snapshot records the namespace revision observed at resolution. Without a Settings provider, the base remains usable and snapshots carry revision `0`.

- `resolve(id?, overrides?)` selects the named or default profile, applies permitted per-session values, and returns a detached deeply frozen snapshot.
- `resolveRoute(id)` returns a configured one-shot route and the profile snapshot resolved at that call.
- `listRoutes()` returns the current route ids in settings order.
- `acquire(profile, signal, upperLimit?)` waits in cancelable FIFO order for shared profile capacity. A route limit can lower, but never raise, the profile limit.
- `acquireSync(profile)` serves the Native synchronous compatibility entry and fails with `AGENT_BUSY` instead of queueing.
- `resolveCredentials(profile)` resolves each credential reference immediately before a process start and returns target-to-value entries without retaining them.

Editing settings affects later resolutions only. A returned snapshot does not observe later edits or credential values. Credential rotation affects the next `resolveCredentials()` call because the snapshot stores references, not values.

## Configuration

`defaultMainProfile` must name an entry in `profiles`. Each profile records:

- Provider id, snapshot schema version, and versioned provider-owned JSON options.
- Executable, argument array, resolution policy, working-directory policy, ambient environment names, and literal non-secret environment entries.
- Model default and whether a Session may override it.
- Product configuration, permission policy and enforcement, Native and Harness tool allowlists, and credential references.
- Startup, turn, shutdown, and termination deadlines plus positive shared capacity.

Identifiers use lowercase letters, digits, and hyphens and begin with a letter. Environment targets use POSIX environment names. JSON-owned fields must round-trip without loss; allowlists contain unique non-empty values; credential and literal environment targets cannot overlap. Runtime-backed route entries add a profile id, tool name, depth limit, and positive route capacity. The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-runtime-profile) contains the exact schema.

The package validates configuration and resolves policy inputs; it does not execute commands, construct a child environment, enforce a sandbox, or write Session headers. The [Router](../agent-runtime-router/README.md) persists resolved snapshots, while the [secure launcher](../agent-runtime-launcher/README.md) and Provider own launch and protocol behavior.

## Failure and ownership

Missing profiles use `PROFILE_NOT_FOUND`. Disallowed overrides and missing credential services or values use `PROFILE_INVALID`. Capacity cancellation preserves an `Error` supplied as the signal reason; the Native synchronous path uses `AGENT_BUSY` when no slot is immediately available.

A capacity lease is caller-owned and idempotent. The caller must retain it until runtime shutdown and cleanup reach quiescence, then call `release()`. The Router and runtime-backed route Consumer enforce that lifetime for their respective runs.

## Invariants

The optional `@deepseek-ai/dsh-agent-runtime-profile/invariant` companion is intentionally empty. The complete settings document is validated before publication, while snapshots and capacity are request-scoped values without an authoritative global relationship to scan.

## Model Experience

### Runtime selection

#### What the model sees

The service adds no text directly. Its resolved `RuntimeProfileSnapshot` determines which Provider, model, product policy, and tool allowlists later runtime and tool Consumers may place in a model request.

#### Token effect

Zero direct tokens. Selecting another profile may change the downstream Provider, model context, or available tools.

#### KV Cache effect

The service does not build requests. A different snapshot can select downstream request content with a different prefix; an already resolved snapshot remains unchanged.

## Known Limitations and Deferred Work

- **No profile history** - resume uses the Session Header snapshot even when the named Settings profile has changed or disappeared.
- **Launch policy is data only** - the secure launcher resolves executables, constructs exact environments, protects reserved controls, manages process-tree teardown, and supplies known-value redaction; the selected Provider supplies protocol behavior and any claimed sandbox mechanism.
- **Credential values are intentionally ephemeral** - callers receive resolved values for one process start; this service does not cache, persist, or redact values after returning them.
