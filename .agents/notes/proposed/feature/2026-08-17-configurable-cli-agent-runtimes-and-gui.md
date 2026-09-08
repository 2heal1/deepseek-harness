# Agent Note: Configurable CLI agent runtimes and Codex-style GUI

Status: proposed

English | [中文](2026-08-17-configurable-cli-agent-runtimes-and-gui.zh.md)

## Problem

DeepSeek Harness has two execution models. The main agent is created through the single `AgentFactory` installed by `dsh-agent-loop`, while [`ctx.subagents`](../../implemented/feature/2026-06-21-subagent-capability-seam.md) selects named child providers. The existing [Codex and Claude Code providers](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) can run official product processes as one-shot children, but they do not provide configurable external main agents, persistent external sessions, intermediate activity, or one configuration model for main and child execution.

The current `Agent` API is also not runtime-neutral. Web Host, ACP, SDK, and Headless code directly use native-loop concepts such as the inbox, `followup`, `steer`, model selection, and maintenance. Replacing the singleton factory with a router while leaving those assumptions intact would make an external runtime appear compatible without defining how it admits input, correlates turns, cancels work, reports capabilities, or resumes.

Users need to select a coding-agent CLI for the main agent and independently select CLIs for child routes. Each selection needs an executable, protocol, model, product configuration, tools, permissions, environment, credential references, timeouts, capacity, continuation policy, and compatibility range. The Web client must present conversation and activity without learning each product protocol or claiming facts the protocol did not report.

Starting an arbitrary command is insufficient. A main runtime needs structured streaming, input admission, cancellation, process ownership, activity, and session identity. Harness must not actively serialize credentials into settings, arguments, events, diagnostics, or another agent's environment. An external main agent also needs an explicitly authorized bridge before it can call Harness tools or delegate to another CLI.

## Proposal

Introduce an agent-runtime capability seam used by main-agent creation and runtime-backed child routes. DeepSeek Harness remains responsible for Harness sessions, profile selection, credentials, common lifecycle transactions, normalized persistence, process policy, and GUI state. Native `dsh-agent-loop`, Codex App Server-compatible CLIs, ACP-compatible CLIs, and later documented protocols become runtime providers behind one router.

The first useful release supports native execution, a Codex App Server-compatible streaming main agent, an ACP-compatible one-shot child, and a per-session MCP gateway. It does not claim cold resume, continuable external children, generic JSONL execution, terminal replay, cross-session process pooling, or desktop packaging.

### P1 frozen contracts

The following contracts are the implementation input for F1 through F5. Those work packages may add private helpers and provider-specific data, but changing these public identities, ownership rules, event producers, persistence rules, or security guarantees requires another decision update.

#### Agent, submissions, and capabilities

| Subject | Frozen contract |
| --- | --- |
| Mandatory `Agent` | Exposes the shared `SessionId`, `Session`, scoped `Context`, declared capabilities, `idle \| running` scheduling status, `submit`, targeted submission cancellation, and `whenIdle`. The creating caller receives the separate `AgentHandle` disposal capability. `whenIdle` remains a whole-agent quiescence primitive and never settles a particular submission. |
| Submission admission | The router owns an admission controller bound to the Agent with states `publishing \| open \| closed`. It starts in `publishing`; registry visibility does not open it. `submit` in `publishing` rejects before allocating a `SubmissionId` or message, appending an event, or returning a receipt, using `AgentRuntimeError` code `SUBMISSION_REJECTED` and phase `publication`. Only the router may transition `publishing` to `open`; `closed` is terminal. |
| Submission acceptance | `submit` validates the request, allocates a branded `SubmissionId` and identified user message, appends `agent/submission/accepted`, and returns a receipt. Failures before that append reject without a receipt; failures afterward settle the receipt. Acceptance means Harness owns the work, not that an external model has observed the message. |
| Start correlation | A receipt exposes a start promise. The router resolves it after allocating the turn and appending `turn/start`, `agent/submission/started`, and the canonical `user/message`, in that order. A submission cancelled or disposed while queued settles as not started and opens no turn. |
| Terminal correlation | A receipt exposes one settlement promise. For started work, the router appends `turn/end`, then `agent/submission/settled`, then resolves the receipt with the turn, `TurnEndReason`, and terminal event sequence. Canonical assistant events have already been appended and synchronously dispatched at that point; persistence flushes and transport output queues remain caller-owned. |
| Cancellation race | Cancellation targets a `SubmissionId`, is idempotent, and returns whether it won before terminal settlement. The first terminal transition wins. Provider output observed after the sink closes cannot enter canonical conversation events. Agent disposal cancels every unsettled receipt with the durable disposed cause before returning. |
| Scheduling status | `Agent.status` remains `idle \| running`: it answers whether the published agent owns unsettled work. Acceptance changes it to `running` before the accepted event is observable; it returns to `idle` only after no submission or maintenance work remains, and `whenIdle` observes that same boundary. Profile availability and process/protocol phases use runtime facts, not extra Agent states. A failed runtime terminalizes its submissions and is disposed; an unavailable profile never publishes an Agent. |
| Optional capabilities | The registered capability set uses stable ids for `continuation`, `steering`, `queuedInputRead`, `queuedInputMutation`, `injection`, `maintenance`, `imageInput`, `modelOverride`, `approvals`, `runtimeActivity`, `harnessTools`, `resume`, and `coldResume`. Provider preparation returns the immutable effective set before publication; losing a guaranteed capability fails the runtime instead of mutating the set. Capability-specific metadata carries fidelity or limits. Initial idle submission, targeted cancellation, canonical assistant output, and settlement are mandatory for a main runtime. |
| Execution enforcement | Every optional operation checks the published Agent's capability set at the service or Host execution boundary. A missing capability raises `AGENT_CAPABILITY_UNSUPPORTED` with the agent id, capability id, and operation; UI visibility is never authorization. |

#### Router lifecycle

The router is the only `AgentFactory` and performs one rollback-covered transaction:

1. Resolve and validate the effective profile, provider registration, caller overrides, Session identity, and immutable snapshot before creating runtime resources.
2. Prepare an unpublished Session, agent scope, and `publishing` admission controller, then ask the provider for a prepared runtime handle containing its immutable effective capabilities and initial normalized runtime facts. Construct the Agent and its prebuilt `AgentHandle` from those results before registry entry. The provider may allocate protocol and process resources but cannot register the Session or Agent, append canonical events, admit input, or change admission state.
3. Run caller setup and its synchronous publication commit. Enter the Session first and the Agent second, announce `session/created`, append the initial `agent/runtime/facts` through the router, then synchronously announce `agent/created`; admission remains `publishing` throughout. After `agent/created` dispatch returns successfully, the router rechecks transaction and owner liveness, transitions admission to `open` as the final non-throwing publication action, and returns the prebuilt handle without another await or fallible step.
4. On any failure, transition admission to terminal `closed` before the first rollback await, terminalize accepted submissions, close the provider event sink, dispose the provider to process-tree quiescence, unwind the agent scope, detach the Agent, and detach the Session. Any creation announcement that began receives its matching disposal announcement. A liveness failure or teardown requested by a synchronous listener closes admission instead of opening it.
5. Normal disposal uses the same memoized reverse path. It stops admission, requests cancellation, and accepts terminal provider output only until every active submission settles or the graceful-shutdown deadline expires. It then closes the sink; when the deadline wins, it terminalizes every remaining receipt with the durable disposed cause. Finally it disposes the provider through final process-tree termination, awaits quiescence, unwinds scope registrations, emits `agent/disposed`, then emits `session/disposed`. Repeated or racing disposal joins the same promise.

`AgentRegistry.enter()` intentionally makes the Agent visible to `get`, `list`, and `roots` before `agent/created`, preserving the existing synchronous lifecycle behavior. A `session/created` listener that finds the Agent and an `agent/created` listener that receives it both get the same `SUBMISSION_REJECTED` publication-phase rejection from `submit`; a continuation running after successful synchronous announcement may submit only after the router opens admission.

If the initial runtime-facts append fails, the router closes admission before rollback. The Agent was entered but not announced, so detaching it emits no `agent/disposed`; the announced Session receives its matching `session/disposed`. Lookup may continue to expose the closed Agent while ordered rollback is in progress, but the router detaches both entries before create or resume rejects, leaving no queryable or submittable Agent. Because no failure point follows the admission-open transition before handle return, creation rollback never has an accepted submission.

The provider owns only resources returned in its prepared handle and must make `dispose` idempotent and quiescent. The router owns the admission controller, Session preparation, scope, registry publication, receipts, and all rollback ordering. Neither the provider, registry, nor lifecycle listeners can open admission. A provider unload drains every handle it prepared before its registration disappears.

#### Durable events and provenance

| Event family | Sole producer and rule |
| --- | --- |
| `session/*`, `agent/created`, `agent/disposed`, `agent/status` | Session Store and router retain their existing ownership. The router wrapper emits the two-state scheduling transition; providers report process phases through runtime facts. |
| `agent/submission/accepted`, `started`, `settled`; `turn/start`, `turn/end`; `user/message` | Router only. Submission events carry `SubmissionId` and `MessageId`; started and settled records carry the allocated turn. A not-started settlement carries no turn. |
| `agent/runtime/facts` | A provider reports facts only through the router sink. Records identify the runtime and provider, carry negotiated product and protocol versions, capabilities, safe external-session id, and `starting \| ready \| running \| stopping \| stopped \| failed` process phase, and label each profile-derived or protocol-observed source. |
| `assistant/chunk`, `assistant/message` | A provider writes only through the router-owned event sink for one open submission. Native records include their step; external records omit step and carry `{ kind: "runtime", provider, source: "protocol" }` provenance. Profile-derived model identity uses `source: "profile"` in runtime facts, not assistant content provenance. |
| `step/*`, `request/*`, `agent/pre-step`, `agent/request*`, `agent/turn-stopping`, `agent/inbox/*` | Native runtime only. F5 permits canonical user and assistant events directly inside an external open turn without inventing a Harness step. |
| `tool/*` and `agent/runtime/activity` | Harness ToolRuntime alone produces `tool/call` and `tool/result`. Providers report product-native command, tool, file, diff, usage, and status observations as runtime activity with runtime id, submission id when known, kind, phase, `complete \| partial` fidelity, and bounded redacted JSON data. |

`deriveMessages` uses an explicit canonical-event allowlist and excludes every runtime fact and activity event. The runtime event sink verifies the open submission and turn, event order, declared activity capability, JSON bounds, provenance, and redaction before append. Providers never receive unrestricted `Session.append` authority.

The current pre-release keeps `SESSION_FORMAT_VERSION` at `0`. F5 does not increment it even when it changes the Session Header or canonical assistant event representation. Loaders validate the current structure and explicitly reject incompatible older data under the pre-release no-compatibility policy; they never infer missing fields, default provenance, or default runtime identity, and F5 adds no compatibility guess or `0`-to-`1` migration.

#### Snapshot, resume, and fork

Every new Session Header contains one immutable `RuntimeProfileSnapshot` with `schemaVersion`, `profileId`, settings revision, provider id and provider-options version, executable plus resolution policy, argument array, working-directory policy, model policy, product configuration, permissions and enforcement claim, native-tool policy, Harness-tool transport and allowlist, credential target-to-`CredentialRef` mappings, process deadlines, and capacity. Defaulting and caller overrides are resolved before this snapshot is created. The snapshot contains no resolved credential, generated gateway token, temporary path, process id, negotiated capability, or external-session id.

Resume uses only the stored snapshot. The named Settings profile may be edited or absent. Resume fails with a typed error when the provider or snapshot version is incompatible, the runtime lacks `resume`, or required product state or external identity is missing; it never selects the current default, creates a replacement external identity, or falls back to Native.

A normal fork copies the parent's snapshot byte-for-byte and records ordinary Session lineage, but excludes negotiated facts and external identity. The child always creates a new external product session and appends its own runtime facts. A new-from-transcript operation may resolve a different profile, but it creates a new Session without resume semantics and is presented as a new identity.

Credentials are resolved from the snapshot's references for every process start. Rotation changes the value supplied to a later start without mutating the snapshot; a missing reference fails before process creation.

#### Errors and consumer migration

Runtime failures use one serializable `AgentRuntimeError` with a stable code, phase, safe message, optional provider id, and redacted bounded details. The frozen codes are `PROFILE_NOT_FOUND`, `PROFILE_INVALID`, `RUNTIME_UNAVAILABLE`, `RUNTIME_INCOMPATIBLE`, `AGENT_CAPABILITY_UNSUPPORTED`, `AGENT_BUSY`, `SUBMISSION_REJECTED`, `RESUME_UNSUPPORTED`, `EXTERNAL_STATE_MISSING`, `SECURITY_POLICY_UNSATISFIED`, `START_TIMEOUT`, `TURN_TIMEOUT`, `RUNTIME_FAILED`, and `DISPOSE_FAILED`. Create, resume, probe, and pre-acceptance failures reject with this error. Post-acceptance failures settle the receipt and, for started work, use the same safe failure in `turn/end`; cancellation is a terminal result, not an exception. `AgentHandle.dispose()` completes all teardown and lifecycle notifications before rejecting with `DISPOSE_FAILED`, so cleanup failure never leaves a published Agent or replaces an earlier submission result.

`SUBMISSION_REJECTED` with phase `publication` is reserved for `submit` while admission is `publishing`. This rejection creates no receipt or durable submission event and is identical whether the caller obtained the Agent from `AgentRegistry.get()` during `session/created` or from the `agent/created` payload.

F1 adds the runtime Service Definition, identifiers, receipt, capability, snapshot, and error types without changing the active factory. F2 installs the router and Native provider and moves Native-only behavior behind capabilities. F5 migrates ACP Host, JSON-RPC SDK Server and Client, Headless, and each new idle Web run to receipts. Web Queue and Steer remain capability-gated Native continuation controls while work is active or queued; they keep inbox identity and return no receipt.

#### F1 Service Definition

`@deepseek-ai/dsh-agent-runtime` installs the `AgentRuntimeRegistry` at `ctx.agentRuntimes`. Its effect-scoped registry exposes `registerProvider`, `getProvider`, and `listProviders`, rejects malformed or duplicate provider metadata with `AgentRuntimeError`, and emits provider-added and provider-removed notifications at the matching registry commit points. Registration removal prevents later selection but does not revoke a prepared handle; each Provider plugin drains every handle it prepared before disposing its registration.

`AgentRuntimeProvider` exposes `probe` and `prepare`. Preparation receives the reserved runtime and Session identities, immutable non-secret `RuntimeProfileSnapshot`, unpublished Agent context, cancellation signal, and restricted `AgentRuntimeEventSink`; it returns a `PreparedAgentRuntime` with immutable capabilities, initial normalized facts, submission execution, targeted cancellation, and quiescent disposal. The Service Definition also owns the branded identifiers, capability ids, normalized fact and activity reports, `SubmissionReceipt`, and the frozen serializable failure carried by `AgentRuntimeError`. Capability and fact snapshot helpers reject duplicate or non-JSON declarations and deep-freeze detached copies; failure details are redacted by their producer, lossless JSON, and limited to 4096 UTF-8 bytes.

The package does not install `AgentFactory`, publish a Session or Agent, resolve Runtime Profiles, or append durable events. Those responsibilities remain with the F2 Router, F3 profile Consumer, and F5 event implementation.

#### F2 Router and Native Provider

`@deepseek-ai/dsh-agent-runtime-router` is the sole `AgentFactory`. It captures one exact Provider registration generation for each create or resume transaction and owns the unpublished `RoutedAgent`, its `publishing | open | closed` admission state, Agent scope, Session and Agent registry publication, rollback, caller ownership, and final teardown. Removing a Provider generation aborts persistence loading, preparation, setup, and live Agents from that generation; a same-id replacement serves only later transactions. Publication opens waking admission only after both synchronous creation notifications and `agent/session-start` return. Rollback and normal disposal close admission before awaiting Provider quiescence and remove the Agent and Session even when cleanup reports `DISPOSE_FAILED`.

`@deepseek-ai/dsh-agent-loop` is the `native` Provider. Its prepared handle fixes the Native capability set and owns a `ReactLoopDriver`; the Router-owned Agent delegates the existing inbox, cancellation, maintenance, and waking operations to that driver. Provider unload drains all prepared handles before removing its registration. Existing Native Session events and Host-facing methods remain unchanged in F2, including the synchronous `ctx.agentLoop.create()` compatibility entry used by declarative startup.

F2 intentionally does not implement the F5 submission receipts and canonical runtime-event sink. Until F5, external assistant and activity reports fail at the sink, while the Native driver remains the producer of existing turn, step, request, inbox, and assistant events. This transition keeps Native behavior stable without claiming that external Providers can yet complete a product-facing run.

#### F3 Runtime Profiles and subagent routes

`@deepseek-ai/dsh-agent-runtime-profile` owns the `agent-runtime` Settings namespace and resolves each new run to a complete deeply frozen non-secret snapshot. The snapshot records the observed Settings revision for audit correlation but Settings does not retain historical revisions. Editing or deleting a stored profile affects only later resolutions. Credential references remain in the snapshot; `resolveCredentials()` reads current values separately for each process start and fails before launch when a required service or value is absent.

The Router selects the Provider generation named by the snapshot and acquires shared profile capacity before preparation. Asynchronous create and resume wait in cancelable FIFO order; the Native synchronous compatibility entry fails with `AGENT_BUSY` when no slot is immediately available. The lease remains held until Provider quiescence and common teardown complete. `AgentOptions.runtimeProfile` selects a profile, while existing provider and token options are accepted only as Native overrides and model overrides require profile permission.

`@deepseek-ai/dsh-subagent-runtime-route` maintains one wrapper `SubagentProvider` and one `dsh-tool-subagent` instance for each configured one-shot route. The existing `ctx.subagents` service remains the public dispatch and lifecycle authority. A start resolves a fresh snapshot, selects the underlying Provider by the snapshot's Provider id, applies the lower of route and profile capacity, and holds that lease through the underlying run's quiescent disposal. Settings reconciliation replaces or removes registrations through their Cordis fibers.

F3 does not interpret launch fields, construct process environments, enforce sandbox policy, or persist snapshots into Session headers. F4 owns secure launch and credential redaction; F5 owns durable snapshot identity, resume and fork reconstruction, submission receipts, and canonical runtime events.

Web RPC schemas move in lockstep during this pre-release. ACP wire behavior remains protocol version 1; the ACP Host translates receipt settlement to the existing ACP response and flushes its own ordered output queue. JSON-RPC `serverInfo.version` becomes `0.0.2`; `session/prompt` returns both message and submission ids, and submission start and settlement notifications replace inbox-splice inference. Old SDK clients fail version/schema validation instead of receiving compatibility emulation. Headless awaits the receipt settlement and then flushes only its correlated Session interval.

#### F5 durable sessions, events, and callers

The Router stores the complete non-secret effective snapshot in every new Session Header. JSONL writes it in the header record; SQLite schema 18 stores it in `sessions.runtime_profile`. Resume restores that snapshot before Provider preparation and rejects a missing or malformed value, a conflicting caller override, an unavailable generation, or missing `resume` capability. Fork copies the snapshot by value, excludes parent `agent/runtime/facts`, remaps retained sequence references, and starts with a fresh runtime identity.

`RoutedAgent.submit()` owns acceptance, serial start, targeted cancellation, and terminal settlement. The Router event sink is the only external producer of canonical runtime facts, activity, and assistant output; its relational invariant rejects unknown or overlapping submissions, mismatched turns and identities, activity outside the running submission, and external assistant provenance inconsistent with the current Provider. Runtime activity is bounded to 16 KiB of UTF-8 JSON and requires `runtimeActivity`.

Web Host publishes the latest runtime facts as the typed `runtimeStatus` Session projection. A new idle Web prompt uses a submission receipt. When a Native Agent is running or retains queued input, Queue uses the declared `continuation` and `queuedInputRead` capabilities and Steer uses `steering`, so pending messages remain addressable; these operations return no receipt and complete through their Native turn events. ACP, Headless, the JSON-RPC server, and both SDKs use submission receipts instead of inbox or whole-Agent-idle inference. JSON-RPC version `0.0.2` returns `{ messageId, submissionId }`; clients collect through the matching durable settlement. F5 does not add an external protocol Provider, main-agent vertical slice, activity UI, or runtime selector.

#### Secure launch

F4 implements one launcher used by every external runtime under these rules:

1. Resolve an executable without a shell. Absolute paths are revalidated immediately before spawn; bare names resolve against the launch policy's explicit search path. Failure never falls back to another executable or Native.
2. Build the child environment from an empty map: launcher-required operating-system entries, driver-required entries, explicitly allowlisted non-secret ambient names, profile literals, and freshly resolved credential targets. Windows key comparison is case-insensitive. Ambient credential-shaped names and every reserved key are rejected even when listed.
3. Each driver declares reserved arguments and environment keys for protocol mode, output mode, model, session, gateway, policy, and credentials. Driver-owned injection is the only writer; duplicates or profile attempts to set them fail before spawn. V1 credentials are environment-only and never enter argv.
4. Spawn native Windows executables directly. A driver may opt into `.cmd` or `.bat` only through the shared `ComSpec /d /s /c` launcher, whose encoder rejects CR, LF, NUL, `%`, `!`, and command metacharacters in dynamic arguments and has native Windows fixtures for spaces, quotes, extension precedence, and rejection. Profiles cannot provide a shell command string.
5. Create authentication files only in a random owner-only directory with exclusive owner-only files. The prepared handle records non-secret cleanup metadata before publication, removes files on every normal or rollback path, and a startup scavenger removes stale files owned by this installation without following links.
6. Install a launch-scoped known-value redactor before any provider diagnostic can reach a logger, error, Session event, API response, or retained output. It handles values split across stream chunks and replaces every non-empty resolved credential value; encoded or transformed secrets remain outside the guarantee.
7. Enforce positive startup, turn, graceful-shutdown, and final-termination deadlines from the snapshot. Timeout stops admission, requests protocol cancellation when available, closes protocol input, escalates through the subprocess process-tree terminator, awaits `waitForExit`, and only then completes rollback or disposal.
8. Capacity remains held until complete process-tree quiescence and temporary-material cleanup. A cancellation or cleanup failure preserves the original terminal reason and independently reports `DISPOSE_FAILED`; no success result may hide incomplete cleanup.

`@deepseek-ai/dsh-agent-runtime-launcher` implements this shared launch path at `ctx.agentRuntimeLauncher`. External Providers supply protocol shutdown hooks and trusted reserved-control and permission-enforcement declarations; the launcher owns executable policy, `envMode: exact`, per-start credential resolution, private launch material, literal known-value redaction, deadlines, and the ordered join with `ctx.subprocess`. The Router or runtime-route Consumer retains the F3 capacity lease until the Provider has disposed this handle. F4 adds no Session event or persisted runtime identity; those remain F5 work.

### Terms and ownership

| Term | Meaning | Owner |
| --- | --- | --- |
| Runtime Profile | Durable user configuration describing what executable and policy to use | Settings provider, with a non-secret effective snapshot pinned to each session |
| Runtime Provider | Code that knows how to start and speak one protocol and reports its actual capabilities | Native, Codex App Server, or ACP provider package |
| `AgentFactoryRouter` | The single `ctx.agents` factory that chooses a provider and owns common creation, publication, rollback, and disposal | Agent-runtime Consumer |
| Runtime handle | A provider result used by the router to drive one prepared native or external runtime | The selected provider until disposal |

The router does more than forward to several complete `AgentFactory` implementations. It owns the common `prepare -> create resources -> publish Session and Agent -> rollback on failure -> dispose` transaction. A provider prepares a protocol-specific runtime handle and cleans up resources it created; it does not independently publish another interpretation of a Harness `Agent`. This keeps native and external runtimes on one lifecycle and prevents every provider from copying the most failure-prone state machine in `agent-loop`.

The Service Definition owns branded runtime, profile, submission, and external-session identifiers; provider registration; capability declarations; prepared-runtime requests; normalized runtime facts; and typed failures. Providers implement protocols. The router is the Consumer that resolves a pinned profile snapshot, coordinates common lifecycle work, and exposes one runtime-neutral `Agent` to callers.

### Cross-runtime Agent behavior

The public `Agent` behavior is split into a mandatory baseline and declared optional capabilities. The mandatory baseline exposes the Harness session and context, observable `idle` or `running` status, `submit` with a stable submission receipt, cancellation, and `whenIdle`. The receipt gives Host, ACP, and SDK code a runtime-neutral way to correlate accepted input with turn completion.

Optional capabilities include continuation, steering, queued-input inspection or mutation, images, model override, approvals, structured product activity, Harness tool bridging, and cold resume. Native inbox operations become an optional native admission implementation rather than a mandatory field on every `Agent`. Host methods check capabilities at the execution boundary and return typed unsupported errors; GUI hiding or disabling a control is presentation, not enforcement.

A provider eligible for a main-agent profile must support input admission, observable completion, cancellation or managed process termination, assistant output, and enough turn correlation to persist an honest conversation. A `final-only` provider may serve a one-shot child, but it is not eligible for the main-agent selector.

Agent Presets remain separate from Runtime Profiles. Native execution continues to consume Harness system prompts and tools from a Preset. An external provider may accept a Preset only when it declares `harnessComposition` and faithfully translates every model-visible prompt and tool into the external product. V1 external profiles reject a non-empty Agent Preset and use explicit product configuration plus an explicit Harness tool allowlist; the UI must not imply that a Harness persona was applied when the CLI never received it.

### Runtime profiles, pinned sessions, and forks

A Runtime Profile contains common fields and typed provider options. Common fields cover the driver, executable and argument array, working-directory policy, model, product profile, non-secret environment, credential references, native-product policy, Harness tool allowlist, startup and turn timeouts, and capacity. Driver validation reserves protocol, output, working-directory, model, and credential arguments. The stored form never contains an interpolated shell command.

```yaml
agentRuntime:
  defaultMainProfile: coding-agent-main
  profiles:
    coding-agent-main:
      driver: codex-app-server
      launch:
        executable: coding-agent-cli
        args: [app-server, --stdio]
        cwdPolicy: session-workspace
        ambientEnv: []
      model:
        default: gpt-5
        allowSessionOverride: true
      cli:
        profile: work
        options:
          model_reasoning_effort: high
      permissions:
        sandbox: workspace-write
        enforcement: required
        approval: unattended-fail-closed
      nativeTools:
        allowed: [filesystem, shell, web]
      harnessTools:
        transport: mcp
        allowed: [subagent.acp-child, todo_write, plan]
      credentials:
        env:
          PROVIDER_API_KEY:
            credentialRef: CODING_AGENT_MAIN_KEY
      process:
        startupTimeoutMs: 15000
        shutdownTimeoutMs: 5000
        turnTimeoutMs: 1800000
        maxConcurrentRuns: 1
    acp-child:
      driver: acp
      launch:
        executable: acp-agent-cli
        args: [acp, serve]
        cwdPolicy: parent-workspace
        ambientEnv: []
      model:
        default: child-model
        allowSessionOverride: false
      permissions:
        sandbox: workspace-write
        enforcement: required
        approval: unattended-fail-closed
      nativeTools:
        allowed: [filesystem, shell]
      harnessTools:
        transport: none
        allowed: []
      credentials:
        env:
          CHILD_PROVIDER_API_KEY:
            credentialRef: CODING_AGENT_CHILD_KEY
      process:
        startupTimeoutMs: 15000
        shutdownTimeoutMs: 5000
        turnTimeoutMs: 900000
        maxConcurrentRuns: 3
subagentRoutes:
  acp-child:
    runtimeProfile: acp-child
    mode: one-shot
    maxDepth: 2
    maxConcurrentRuns: 3
    toolName: delegate_to_acp_child
```

The settings revision is a concurrency and audit marker, not profile history. At session creation the router resolves defaults and stores a complete non-secret `RuntimeProfileSnapshot`, including credential references but not values, in immutable session metadata. Resume reads that snapshot instead of the currently edited profile. A conflicting caller override, missing provider, or incompatible recorded driver fails explicitly; it never silently starts native execution or a fresh external session.

Runtime facts learned after creation, such as negotiated capabilities, product version, process state, and a safe external-session identifier, are appended as session events. Editing a profile affects new sessions only. Credentials are re-resolved from their references at each process start so key rotation does not rewrite historical data.

A normal Harness fork inherits the parent's pinned Runtime Profile snapshot but creates a new Harness session and a new external product session. It never reuses the parent's external-session identifier. An explicit “new session from transcript” action may select another profile, but it is a new identity and is not presented as resume.

### Protocol and secure-launch rules

V1 has two external protocol targets: Codex App Server for the main-agent vertical slice and ACP for a one-shot child. Each provider pins a tested compatibility range and owns handshake, codec, stream, error, cancellation, and shutdown fixtures. A command or method named `app-server` is not compatibility evidence. Terminal prose is never parsed as an automation protocol.

The runtime launcher resolves an executable without a shell, validates reserved arguments and environment keys, and constructs an exact child environment from driver-required operating-system entries, explicitly allowlisted non-secret entries, profile values, and freshly resolved credentials. The existing broadly scrubbed parent environment is not sufficient for this guarantee. Windows executable and `.cmd` resolution and quoting are part of this launch contract, not deferred cleanup.

`CredentialRef` values use the credential service's valid POSIX environment-identifier syntax. Harness never puts resolved values into arguments, profile snapshots, events, API responses, or Harness-owned diagnostic fields. Before persistence or API delivery it redacts known resolved values from provider errors and bounded diagnostic output. This guarantee covers Harness-owned data paths; it cannot undo arbitrary file, network, or terminal side effects performed by a trusted external CLI.

Harness permission presets constrain Harness tools, not a product's native tools. A profile may claim a sandbox or approval policy only when the provider can map it to a verified product policy or the managed process is wrapped by an enforcing sandbox. Loading or probing the profile fails when `enforcement: required` cannot be satisfied. Interactive product approvals remain disabled with an unattended fail-closed policy in V1; Harness gateway tools continue to use Harness approval services.

The subprocess owner observes the whole process tree and provides bounded startup, protocol cancellation, grace-period escalation, final termination, and complete quiescence. Startup rollback removes the process, temporary authentication material, gateway registration, session scope, and unpublished Agent. Temporary files include crash-cleanup metadata so the next host start can remove stale owned files.

### ACP protocol spike baseline

The V1 ACP child compatibility baseline is `@agentclientprotocol/sdk@0.25.1`, ACP protocol version `1`, over newline-delimited JSON-RPC 2.0 on stdio. The client sequence is `initialize` → `session/new` → one `session/prompt`. Assistant text arrives through ordered `session/update` notifications, while the `session/prompt` response supplies only the terminal `stopReason`. The provider must verify the negotiated `InitializeResponse.protocolVersion` because the SDK accepts any integer response without enforcing equality with the requested version.

Cancellation uses a `session/cancel` notification. The agent may still send `session/update` notifications before the outstanding prompt settles with `stopReason: "cancelled"`, so the adapter continues reading updates until prompt settlement; local process cancellation remains authoritative for a non-cooperative agent. A structured agent failure is a JSON-RPC error response that rejects the request promise, while transport EOF independently rejects outstanding requests. Both become provider failures after retaining any assistant text already reported by complete update frames.

ACP protocol version 1 provides `session/close` only as an optional method when the agent advertises `sessionCapabilities.close`; the V1 one-shot baseline does not require that capability. Provider shutdown therefore closes client stdin, observes agent stdout EOF and connection closure, then relies on the subprocess owner for process-tree quiescence. The versioned [fixture manifest](../../../../packages/subagent/subagent-acp/tests/fixtures/protocol-v1-sdk-0.25.1/manifest.json) and [official-SDK replay test](../../../../packages/subagent/subagent-acp/tests/protocol-fixtures.spec.ts) pin the one-shot, cancellation, structured-error, and EOF-shutdown frames.

### Session facts and provenance

The Session Log remains the source of truth for Harness-visible conversation and activity. Runtime adapters record only observed or negotiated facts. Canonical user, assistant, and turn events represent conversation facts; assistant provenance comes from negotiated protocol data or the pinned profile when the driver defines that field as authoritative. A provider that cannot satisfy the canonical assistant provenance requirements is not eligible for V1 main-agent use.

Product-native commands, tools, file edits, and diffs use runtime-owned activity events. They do not masquerade as Harness `tool/call` or `tool/result` events and do not enter derived model history, because Harness did not execute those tools and may not know their complete model-visible inputs. Only tools invoked through the Harness gateway use the normal Harness ToolRuntime events and render intent.

An external approval can map to the Harness approval service only while an associated Harness turn is open and only when the driver maps the complete product decision set to Harness decisions. Partial mappings fail before execution. The GUI renders declared fidelity and never synthesizes token use, tool arguments, diffs, terminal state, or model requests from prose.

### Subagent routes and Harness tool gateway

The existing named [`ctx.subagents`](../../implemented/feature/2026-06-21-subagent-capability-seam.md) registry remains the child-routing authority. A runtime-backed route is a Consumer that resolves a Runtime Profile and registers a `SubagentProvider` plus its delegation tool; it does not create a second subagent router. V1 ACP children use the existing one-shot `SubagentRun` result contract. Continuable external children wait for the common admission and cold-resume behavior.

The repository's MCP support is a client for importing external tools, so external agents calling Harness tools require a new per-session MCP server capability. Discovery and execution both enforce the exact tool allowlist, parent-subset permissions, workspace restrictions, delegation depth, capacity, cancellation, and session ownership. Schema filtering alone is not authorization.

For the example profile, the main CLI discovers `delegate_to_acp_child`. The call enters the Harness subagent route, starts the ACP child with its own snapshot and credential references, records the parent-child relationship, and returns the one-shot result. Neither process receives the other's credential values.

Profile and route capacity combine as the lower limit. Waiting runs use a cancelable FIFO queue. A resident main process consumes its profile slot for its lifetime; a one-shot child consumes one slot until process-tree quiescence. Route capacity cannot increase the selected profile's limit.

### API and GUI

The existing three-column Web shell remains the first client. Runtime Profiles and Subagent Routes receive dedicated settings forms and probe diagnostics. Session creation adds a Runtime Profile selector, and the existing conversation header and activity slot show process state, product, model, pinned profile, capabilities, activity, and child relationships. Diff, terminal, image, model, steering, approval, and resume controls appear only for declared capabilities, while Host methods independently enforce the same checks.

Host exposes typed APIs for profile and route CRUD, executable and version probes, capability diagnostics, session runtime status, cancellation, and credential status. Ordinary clients never receive arbitrary Settings access or credential values. Executable paths, ambient environment, product-native tools, and sandbox policy are writable only through a trusted local or administrative control plane because they authorize code execution.

Headless, ACP Host, and SDK adapters move to the common `submit` receipt and capability behavior after it is frozen. These adapters may be implemented in parallel, but none may recover native inbox semantics by adding transport-specific exceptions.

### Package ownership

The agent-runtime Service Definition owns provider registration, branded identifiers, requests, capabilities, and failures. A router Consumer owns common Agent lifecycle transactions. Native, Codex App Server, and ACP packages provide runtime implementations. Separate profile/route, secure-launch, session-event, and per-session tool-gateway capabilities keep configuration, process security, persistence, and tool execution independently testable.

The current [`AgentRegistry`](../../../../packages/core/agent/src/index.ts) remains the public creation entry. The current [`agent-loop`](../../../../packages/core/agent-loop/src/index.ts) contributes the native prepared runtime instead of installing the registry factory. The existing [`subagent`](../../../../packages/subagent/subagent/src/types.ts) capability remains the named child router. Changes to the Agent behavior and loop lifecycle update [`docs/architecture.md`](../../../../docs/architecture.md) and the owning subsystem and package references in the same implementation change.

### Delivery tracking

Implementation status, hard dependencies, parallel groups, coding-agent level, work branches, PR URLs, and completion evidence live in the mutable [delivery roadmap](../../../roadmaps/configurable-cli-agent-runtimes.md). The roadmap may change as work advances without rewriting this design decision; a scope, ownership, persistence, event, or security change still requires updating this Agent Note.

## Alternatives considered

**Let the router forward to complete provider-owned `AgentFactory` implementations.** This makes initial extraction smaller but duplicates Session publication, rollback, cancellation, and disposal in every provider. The router instead owns the common transaction and providers return prepared runtime handles.

**Hide entered Agents from `AgentRegistry.get()` until `agent/created` completes.** Existing synchronous lifecycle listeners resolve the Agent during `session/created`, and `agent/created` listeners receive the Agent directly even if lookup hides it. A router-owned admission controller preserves registry lifecycle semantics and closes both paths without a reentrant submission window.

**Replace `ctx.agents` with a public multi-factory API.** Every caller would need runtime selection and fallback logic. One router keeps the creation entry centralized while the runtime-neutral Agent behavior makes callers genuinely portable.

**Treat the settings revision as historical profile storage.** Settings retain only the current document and a monotonic revision, so a revision number cannot reconstruct an edited profile. Sessions pin a complete non-secret effective snapshot instead.

**Reuse Agent Presets for CLI process configuration.** Presets describe Harness composition and model-visible inputs. Executables, protocols, credentials, timeouts, and product-native policy have different ownership; an external provider may consume a Preset only through an explicit faithful-composition capability.

**Record product-native tools as ordinary Harness tool events.** Those tools were not selected or executed by Harness and may expose incomplete arguments or results. Runtime activity events preserve observability without corrupting Harness-derived model history.

**Ship a generic JSONL provider in V1.** The repository has no representative product protocol or consumer that fixes its lifecycle semantics. Adding it would create an unsupported public choice, so another documented protocol and fixtures must justify it later.

**Run arbitrary shell command strings or parse an interactive terminal.** Shell strings create quoting and injection differences, while terminal prose cannot reliably express lifecycle facts. Providers use an executable plus argument array and a documented structured protocol.

**Let external CLIs manage all credentials and tools outside Harness.** Product-native configuration remains useful, but exclusive external ownership prevents per-agent credential isolation, Harness delegation, uniform status, and enforceable gateway policy.

**Build a desktop application first.** A desktop shell does not solve runtime ownership, protocol normalization, or security. The existing Web shell validates the service and interaction model before optional packaging.

## Acceptance criteria

- A user can configure the two V1 profiles through typed settings or GUI without storing credential values in ordinary settings, session metadata, arguments, or API responses.
- Native and external sessions use the same `ctx.agents` creation entry and mandatory Agent behavior; unsupported optional operations fail with typed capability errors at the Host boundary.
- A Codex App Server-compatible main profile can create a session, stream assistant output, accept correlated input, show supported activity, cancel work, and remain pinned to its complete non-secret snapshot.
- The main CLI can discover and invoke `delegate_to_acp_child`; the ACP child uses its own executable, model, policy, workspace, capacity, and credential references and returns a one-shot result.
- Product-native activity remains distinguishable from Harness tool events, and persisted conversation provenance contains no facts invented from terminal prose.
- Editing or deleting the source Runtime Profile does not change an existing session; ordinary fork, new-from-transcript, and resume behavior follow the declared identity rules without silent fallback.
- Required sandbox and approval claims fail during validation or probe when the provider and process launcher cannot enforce them.
- Startup failure, handshake failure, timeout, cancellation, queued-run cancellation, and Host disposal leave no managed process tree, gateway, session scope, or temporary authentication file alive.
- Known credential values are absent from Harness-owned events, errors, diagnostics, tool results, snapshots, and GUI state in canary coverage; each process receives only its exact permitted environment.
- A runnable keyless example and snapshot demonstrate a configured external main agent delegating through MCP to a configured external one-shot child.
- Architecture, subsystem, package README, JSDoc, configuration catalog, and bilingual documentation changes accompany each implementation package that changes those facts.

## Risks

Product protocols may change independently of Harness. Explicit compatibility ranges, version probes, recorded fixtures, and fail-fast diagnostics reduce drift but cannot promise support for arbitrary installed versions.

Some protocols expose partial model and tool activity. Honest fidelity may produce a less detailed GUI than the product's own client; Harness does not fill gaps by parsing prose or inventing canonical events.

External resume depends on product-owned state outside the Harness Session Log. The post-V1 resume milestone can fail after that state is deleted or moved even while the Harness transcript remains readable.

MCP bridging and process launch expand the trusted execution path. Executor-side authorization, parent-subset permissions, exact environments, enforceable sandbox claims, local-only administrative writes, and secret canaries are required before remote control is safe.

Known-value redaction limits accidental persistence but is not a complete data-loss-prevention system. A trusted external CLI can transform or transmit a credential or produce filesystem and network side effects that Harness cannot reverse.

One process per session or run costs more memory and startup time than pooling. V1 accepts that cost for credential, workspace, permission, and failure isolation; pooling requires a separate decision.

The proposal does not guarantee feature parity across CLIs, reproduce hidden product prompts, make native product tools obey Harness permission presets, or roll back file and command side effects performed by an external agent.
