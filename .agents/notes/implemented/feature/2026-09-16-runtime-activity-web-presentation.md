# Agent Note: Runtime activity Web presentation

Status: implemented

English | [中文](2026-09-16-runtime-activity-web-presentation.zh.md)

## Problem

Runtime facts and provider-native activity are durable Session events, but the Chat view intentionally excludes them from model conversation. Users otherwise cannot inspect the selected runtime's process state, declared capabilities, observed product activity, or structured failures. The existing subagent catalog provides the relationship tree, but its `running` and `inactive` values are residency observations rather than durable outcomes.

Protocols report different levels of detail. A presentation that parses prose or fills missing command arguments, diffs, usage, model requests, or terminal outcomes would turn absent information into false facts. Current connection errors are also transient and must not be represented as persisted history.

## Decision

`@deepseek-ai/dsh-client-ui-subagent` registers an `activity` conversation target and a session-scoped Activity tab. Its keyed incremental builder orders records by durable event sequence and projects only `agent/runtime/facts`, `agent/runtime/activity`, error `turn/end`, and rejected not-started `agent/submission/settled` events.

The tab reads the latest `runtimeStatus` from the existing Session summary projection. It presents process phase, Provider and runtime identity, optional product and protocol facts with their `profile` or `protocol` source, optional external Session identity, and declared capabilities. The durable ledger preserves each provider activity's `complete` or `partial` fidelity and displays only its bounded JSON data. Missing fields remain absent. The Session's current `lastAgentError` appears in a separate transient region and never enters the durable ledger.

The existing recursive header catalog remains the relationship view. It navigates session-backed children through their exact mode-bearing addresses and retains its existing residency semantics; Activity does not infer a child outcome from catalog state or timing.

The client fixture supplies deterministic runtime facts, partial activity, a structured submission rejection, and a one-shot child so the assembled Web composition exercises the tab and relationship tree without a model or external CLI.

## Alternatives considered

**Add runtime rows to Chat or Trajectory.** Rejected because Chat represents canonical conversation and Trajectory represents request and tool execution. Provider-native observations need a separate target so they cannot masquerade as Harness tool events or model-visible content.

**Add a dedicated Activity Host endpoint.** Rejected because every durable record already arrives through Session history and live event transport, while current runtime facts already use the Session summary projection. A second endpoint would duplicate ordering and reconnect behavior.

**Infer richer details from text or neighboring events.** Rejected because providers may report partial activity and do not necessarily expose model inputs, arguments, diffs, usage, or terminal state. The UI preserves declared fidelity instead.

## Testing

Package tests cover event selection, invalid matched-event defenses, incremental ordering, sparse facts, every process phase, fidelity labels, durable and transient failures, plugin registration, and per-file 100% coverage. A keyless assembled Web snapshot boots the built client graph and pins the Activity records together with the same session's one-shot child row.

## Consequences

Users can inspect durable runtime observations and structured failures without confusing them with canonical conversation or Harness tool execution. The view remains useful for providers with sparse reporting, but its detail is limited to what the provider emitted. Current process facts may be newer than the loaded ledger window, and transient connection errors disappear when the client state clears them.
