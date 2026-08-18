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
