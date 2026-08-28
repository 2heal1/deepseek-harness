# dsh-agent-runtime

English | [中文](README.zh.md)

Provider registry and provider-neutral vocabulary for configurable Agent runtimes. This package is the Service Definition; Router, Native, and external protocol implementations live in separate Consumer and Service Provider packages.

## Service: `AgentRuntimeRegistry` (ctx key: `agentRuntimes`)

`ctx.agentRuntimes` holds the currently selectable runtime providers. Registration is effect-scoped, rejects malformed or duplicate provider identities, and emits `agent-runtime/provider-added` and `agent-runtime/provider-removed` at the matching registry commit points.

- `registerProvider(provider)` registers one trusted same-process Provider and returns its Cordis disposer.
- `getProvider(id)` returns the currently selectable Provider with that branded id.
- `listProviders()` returns a detached array in registration order.

Removing a registration prevents later selection but does not revoke an already prepared handle. A Provider plugin tracks every handle it prepared and drains those handles before disposing its registration.

## Provider Contract

An `AgentRuntimeProvider` declares the Runtime Profile snapshot schema versions it accepts and implements two operations:

- `probe(request)` checks availability, compatibility, effective capabilities, and permission enforcement without creating a Harness Session.
- `prepare(request)` allocates resources for one unpublished Agent and returns a `PreparedAgentRuntime`.

The Router supplies the reserved runtime and Session identities, complete non-secret `RuntimeProfileSnapshot`, unpublished Agent context, cancellation signal, and a restricted `AgentRuntimeEventSink`. Providers cannot append arbitrary Session events, register the Session or Agent, or open submission admission.

A prepared handle fixes its capability set for its lifetime, exposes initial normalized runtime facts, accepts already admitted submissions, receives targeted cancellation, and disposes to resource and process-tree quiescence. `snapshotAgentRuntimeCapabilities()` and `snapshotAgentRuntimeFacts()` detach, validate, and deeply freeze provider-authored values.

## Public Vocabulary

The package owns branded provider, profile, runtime, submission, and external-session identifiers. `RuntimeProfileSnapshot` carries resolved non-secret launch, model, product, permission, tool, credential-reference, deadline, and capacity inputs. It never carries resolved credential values, generated gateway tokens, temporary paths, process ids, negotiated capabilities, or external-session identity.

`SubmissionReceipt` correlates one accepted user message with two promises. `started` resolves with the allocated turn or a durable not-started result; `settled` resolves after the terminal submission event has been synchronously dispatched. Neither promise includes persistence flushes or transport output-queue flushes.

`AgentRuntimeError` extends `HarnessError` with a frozen serializable `failure`: stable code, operation phase, safe message, optional provider id, and optional redacted details. Details must be lossless JSON and serialize to at most 4096 UTF-8 bytes. The local `cause` is not part of the serializable failure.

## Invariants

The optional `@deepseek-ai/dsh-agent-runtime/invariant` companion verifies that provider-added and provider-removed events match the authoritative registry state. The root service does not load diagnostics implicitly.

## Model Experience

### Runtime-provider output

#### What the model sees

The Router Consumer can turn content reported through `assistantMessage()` into canonical Session messages. The registry, snapshots, capabilities, receipts, and errors add no model-visible text.

#### Token effect

The package adds zero tokens directly. A selected Provider's accepted assistant output affects later retained conversation history through the Router.

#### KV Cache effect

The package does not alter request prefixes itself. Provider output appended to canonical history grows the reusable conversation prefix under the Router's event rules.

## Known Limitations and Deferred Work

- **No Router or runtime implementation** — this package does not install `AgentFactory`, publish Agents, or provide Native, Codex, or ACP execution; F2 and protocol Provider packages consume this Service Definition.
- **Profile authoring and validation are separate** — the snapshot type records resolved fields, while Settings schemas, defaults, validation, capacity admission, and credential resolution belong to the profile Consumer.
- **Events are reports, not persistence authority** — F5 defines durable runtime event schemas and Router validation; Providers receive only the restricted report sink declared here.
