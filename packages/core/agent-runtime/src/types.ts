/**
 * Provider-neutral agent-runtime requests, handles, capabilities, snapshots,
 * reports, receipts, and failures.
 *
 * @module @deepseek-ai/dsh-agent-runtime/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause, JsonValue, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'

/** Identifies one registered runtime provider. */
export type AgentRuntimeProviderId = Branded<'AgentRuntimeProviderId'>

/** Identifies one resolved Runtime Profile. */
export type RuntimeProfileId = Branded<'RuntimeProfileId'>

/** Identifies one prepared runtime instance. */
export type AgentRuntimeId = Branded<'AgentRuntimeId'>

/** Correlates one accepted input through start and settlement. */
export type SubmissionId = Branded<'SubmissionId'>

/** Opaque, safe-to-persist session identity assigned by an external product. */
export type ExternalSessionId = Branded<'ExternalSessionId'>

/**
 * Stable optional runtime features. The initial idle submission, targeted
 * cancellation, assistant output, and settlement are mandatory and therefore
 * are not capability ids.
 */
export type AgentRuntimeCapabilityId =
  | 'continuation'
  | 'steering'
  | 'queuedInputRead'
  | 'queuedInputMutation'
  | 'injection'
  | 'maintenance'
  | 'imageInput'
  | 'modelOverride'
  | 'approvals'
  | 'runtimeActivity'
  | 'harnessTools'
  | 'resume'
  | 'coldResume'

/** One effective optional capability and its provider-neutral limits or fidelity metadata. */
export interface AgentRuntimeCapability {
  /** Stable capability identifier. */
  readonly id: AgentRuntimeCapabilityId
  /** Lossless-JSON metadata interpreted by the capability's Consumer. */
  readonly metadata?: JsonValue
}

/** Immutable effective capabilities returned before Agent publication. */
export type AgentRuntimeCapabilities = readonly AgentRuntimeCapability[]

/** How the launcher resolves the configured executable. */
export type RuntimeExecutableResolution =
  | { readonly kind: 'absolute' }
  | { readonly kind: 'search-path'; readonly paths: readonly string[] }

/** How the runtime working directory is selected. */
export type RuntimeWorkingDirectoryPolicy =
  | { readonly kind: 'session-workspace' }
  | { readonly kind: 'parent-workspace' }
  | { readonly kind: 'fixed'; readonly path: string }

/** Non-secret executable and working-directory inputs pinned to a Session. */
export interface RuntimeLaunchSnapshot {
  /** Executable path or bare name. */
  readonly executable: string
  /** Exact resolution policy applied before process creation. */
  readonly resolution: RuntimeExecutableResolution
  /** Argument vector; never a shell command string. */
  readonly args: readonly string[]
  /** Working-directory selection policy. */
  readonly cwd: RuntimeWorkingDirectoryPolicy
  /** Explicit non-secret ambient environment names admitted by policy. */
  readonly ambientEnv: readonly string[]
  /** Explicit non-secret environment literals. */
  readonly env: Readonly<Record<string, string>>
}

/** Model selection policy pinned to a Session. */
export interface RuntimeModelSnapshot {
  /** Default provider-specific model, when configured. */
  readonly default?: string
  /** Whether a Session submission may select a different model. */
  readonly allowSessionOverride: boolean
}

/** Permission claim and enforcement requirement pinned to a Session. */
export interface RuntimePermissionSnapshot {
  /** Provider-neutral policy selected by the profile. */
  readonly policy: JsonValue
  /** Whether preparation must prove enforcement or may report best effort. */
  readonly enforcement: 'required' | 'best-effort'
  /** Unattended approval behavior. */
  readonly approval: 'unattended-fail-closed'
}

/** Product-native tool policy pinned to a Session. */
export interface RuntimeNativeToolSnapshot {
  /** Exact product-native tool names allowed by the profile. */
  readonly allowed: readonly string[]
}

/** Harness-tool transport and allowlist pinned to a Session. */
export interface RuntimeHarnessToolSnapshot {
  /** Transport through which the external runtime reaches Harness tools. */
  readonly transport: 'none' | 'mcp'
  /** Exact Harness tool names exposed through that transport. */
  readonly allowed: readonly string[]
}

/** One environment target resolved from the credential service at process start. */
export interface RuntimeCredentialMapping {
  /** Provider-owned environment variable receiving the resolved value. */
  readonly target: string
  /** Durable reference; the credential value is never part of the snapshot. */
  readonly credentialRef: CredentialRef
}

/** Positive process deadlines pinned to a Session. */
export interface RuntimeProcessDeadlines {
  /** Maximum preparation and protocol-readiness duration. */
  readonly startupMs: number
  /** Maximum duration of one started submission. */
  readonly turnMs: number
  /** Graceful provider-shutdown duration. */
  readonly shutdownMs: number
  /** Final process-tree termination duration. */
  readonly terminationMs: number
}

/** Capacity policy pinned to a Session. */
export interface RuntimeCapacitySnapshot {
  /** Maximum live runtime instances admitted under this profile. */
  readonly maxConcurrentRuns: number
}

/**
 * Complete non-secret effective Runtime Profile pinned to a Session.
 * Defaults and caller overrides are resolved before this value is created.
 */
export interface RuntimeProfileSnapshot {
  /** Snapshot schema understood by the selected provider. */
  readonly schemaVersion: number
  /** User-facing profile identity retained for audit and display. */
  readonly profileId: RuntimeProfileId
  /** Settings document revision from which the snapshot was resolved. */
  readonly settingsRevision: number
  /** Selected provider and its provider-specific option representation. */
  readonly provider: {
    readonly id: AgentRuntimeProviderId
    readonly optionsVersion: number
    readonly options: JsonValue
  }
  /** Executable and launch policy. */
  readonly launch: RuntimeLaunchSnapshot
  /** Model selection policy. */
  readonly model: RuntimeModelSnapshot
  /** Provider-specific non-secret product configuration. */
  readonly product: JsonValue
  /** Permission and enforcement policy. */
  readonly permissions: RuntimePermissionSnapshot
  /** Product-native tool policy. */
  readonly nativeTools: RuntimeNativeToolSnapshot
  /** Harness-tool transport policy. */
  readonly harnessTools: RuntimeHarnessToolSnapshot
  /** Credential references resolved afresh at each process start. */
  readonly credentials: readonly RuntimeCredentialMapping[]
  /** Startup, turn, and teardown deadlines. */
  readonly deadlines: RuntimeProcessDeadlines
  /** Runtime capacity policy. */
  readonly capacity: RuntimeCapacitySnapshot
}

/** Provenance of one normalized runtime fact. */
export type AgentRuntimeFactSource = 'profile' | 'protocol'

/** A fact paired with the source that authoritatively supplied it. */
export interface SourcedRuntimeFact<T extends JsonValue> {
  /** Fact value. */
  readonly value: T
  /** Authority for the value. */
  readonly source: AgentRuntimeFactSource
}

/** Provider process or protocol phase reported independently of Agent scheduling status. */
export type AgentRuntimePhase = 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed'

/** Normalized, non-secret facts reported by a prepared runtime. */
export interface AgentRuntimeFacts {
  /** Prepared runtime identity. */
  readonly runtimeId: AgentRuntimeId
  /** Provider that prepared the runtime. */
  readonly providerId: AgentRuntimeProviderId
  /** Immutable effective optional capabilities. */
  readonly capabilities: AgentRuntimeCapabilities
  /** Current provider process or protocol phase. */
  readonly phase: AgentRuntimePhase
  /** Product name when known. */
  readonly product?: SourcedRuntimeFact<string>
  /** Product version when known. */
  readonly productVersion?: SourcedRuntimeFact<string>
  /** Protocol name when known. */
  readonly protocol?: SourcedRuntimeFact<string>
  /** Negotiated protocol version when known. */
  readonly protocolVersion?: SourcedRuntimeFact<string>
  /** Safe external product session identity when one exists. */
  readonly externalSessionId?: ExternalSessionId
}

/** Fidelity of provider-observed product activity. */
export type AgentRuntimeActivityFidelity = 'complete' | 'partial'

/** One normalized product-native activity report. */
export interface AgentRuntimeActivity {
  /** Prepared runtime that observed the activity. */
  readonly runtimeId: AgentRuntimeId
  /** Correlated submission when the protocol exposes it. */
  readonly submissionId?: SubmissionId
  /** Provider-defined stable activity category. */
  readonly kind: string
  /** Provider-defined stable phase within that category. */
  readonly phase: string
  /** Whether the report contains every field the provider can observe. */
  readonly fidelity: AgentRuntimeActivityFidelity
  /** Redacted bounded lossless-JSON activity data. */
  readonly data: JsonValue
}

/** Provider-neutral incremental assistant content without LLM-adapter finish semantics. */
export type AgentRuntimeAssistantChunk =
  | { readonly kind: 'text-delta'; readonly text: string }
  | { readonly kind: 'reasoning-delta'; readonly text: string }
  | { readonly kind: 'content-block'; readonly block: ContentBlock }

/** Completed assistant content reported without a provider-authored Harness message identity. */
export interface AgentRuntimeAssistantOutput {
  /** Complete provider-observed assistant content. */
  readonly content: readonly ContentBlock[]
}

/** Provider output accepted only while the named submission sink remains open. */
export interface AgentRuntimeEventSink {
  /**
   * Report changed runtime facts.
   * @param facts - complete current normalized facts.
   */
  facts(facts: AgentRuntimeFacts): void
  /**
   * Report one provider stream chunk for an open submission.
   * @param submissionId - submission receiving the chunk.
   * @param chunk - provider-neutral incremental assistant content.
   */
  assistantChunk(submissionId: SubmissionId, chunk: AgentRuntimeAssistantChunk): void
  /**
   * Report one completed assistant message for an open submission.
   * @param submissionId - submission receiving the message.
   * @param output - completed provider-neutral assistant content.
   */
  assistantMessage(submissionId: SubmissionId, output: AgentRuntimeAssistantOutput): void
  /**
   * Report product-native activity.
   * @param activity - normalized activity observation.
   */
  activity(activity: AgentRuntimeActivity): void
}

/** Common fields supplied while preparing a runtime. */
export interface AgentRuntimePrepareBase {
  /** Harness identity reserved for the runtime instance. */
  readonly runtimeId: AgentRuntimeId
  /** Harness Session identity being prepared. */
  readonly sessionId: SessionId
  /** Complete non-secret effective profile. */
  readonly profile: RuntimeProfileSnapshot
  /** Unpublished Agent scope available for provider-owned registrations. */
  readonly agentCtx: Context
  /** Router-owned sink; providers never receive unrestricted Session append authority. */
  readonly sink: AgentRuntimeEventSink
  /** Cancels preparation before ownership transfers to the returned handle. */
  readonly signal: AbortSignal
}

/** Prepare a new external or native product session. */
export interface AgentRuntimeCreateRequest extends AgentRuntimePrepareBase {
  readonly kind: 'create'
}

/** Prepare a runtime against an existing external product session. */
export interface AgentRuntimeResumeRequest extends AgentRuntimePrepareBase {
  readonly kind: 'resume'
  /** External identity recovered from durable runtime facts. */
  readonly externalSessionId: ExternalSessionId
}

/** Provider preparation request selected by the Router. */
export type AgentRuntimePrepareRequest = AgentRuntimeCreateRequest | AgentRuntimeResumeRequest

/** Inputs for an availability and compatibility probe that creates no Session. */
export interface AgentRuntimeProbeRequest {
  /** Complete proposed profile snapshot. */
  readonly profile: RuntimeProfileSnapshot
  /** Cancels the probe and any transient resources it owns. */
  readonly signal: AbortSignal
}

/** Successful provider probe facts suitable for diagnostics and profile validation. */
export interface AgentRuntimeProbeResult {
  /** Product version observed by the provider, when available. */
  readonly productVersion?: string
  /** Protocol version observed or negotiated by the provider, when available. */
  readonly protocolVersion?: string
  /** Capabilities available under the probed profile. */
  readonly capabilities: AgentRuntimeCapabilities
  /** Whether the requested permission policy is enforceable. */
  readonly permissionEnforcement: 'enforced' | 'best-effort' | 'unsupported'
  /** Redacted bounded provider diagnostics. */
  readonly details?: JsonValue
}

/** One accepted submission delivered by the Router to a prepared runtime. */
export interface AgentRuntimeSubmissionRequest {
  /** Harness-owned submission identity. */
  readonly submissionId: SubmissionId
  /** Identified user message already accepted by the Router. */
  readonly message: UserMessage
  /** Cancels only this submission. */
  readonly signal: AbortSignal
}

/** Terminal provider result for one started submission. */
export interface AgentRuntimeSubmissionResult {
  /** Provider-neutral terminal reason recorded by the Router. */
  readonly reason: TurnEndReason
}

/**
 * Provider-owned prepared runtime. It remains unpublished until the Router
 * completes Session and Agent publication.
 */
export interface PreparedAgentRuntime {
  /** Runtime identity from the matching prepare request. */
  readonly runtimeId: AgentRuntimeId
  /** Immutable effective capability set fixed for this runtime lifetime. */
  readonly capabilities: AgentRuntimeCapabilities
  /** Initial facts appended before `agent/created`. */
  readonly initialFacts: AgentRuntimeFacts
  /**
   * Start provider work for an already accepted submission.
   * @param request - correlated message and cancellation signal.
   * @returns the terminal provider-neutral reason.
   */
  submit(request: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult>
  /**
   * Request protocol cancellation for one started submission.
   * @param submissionId - targeted submission identity.
   * @param cause - Harness cancellation cause.
   */
  cancel(submissionId: SubmissionId, cause: AgentCancelCause): void
  /** Stop all work, release resources, and reach process-tree quiescence. */
  dispose(): Promise<void>
}

/** One runtime implementation registered for Router selection. */
export interface AgentRuntimeProvider {
  /** Unique stable registry identity. */
  readonly id: AgentRuntimeProviderId
  /** Runtime Profile snapshot schema versions accepted by this provider. */
  readonly profileSnapshotVersions: readonly number[]
  /**
   * Probe availability and compatibility without creating a Session.
   * @param request - proposed effective profile and cancellation.
   * @returns observed compatibility and capability facts.
   */
  probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult>
  /**
   * Allocate provider resources for one unpublished Agent.
   * @param request - Router-owned identity, profile, scope, sink, and cancellation.
   * @returns a handle whose id and initial facts match the request and provider.
   */
  prepare(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime>
}

/** Why an accepted submission settled before a turn was allocated. */
export type SubmissionNotStartedReason =
  | { readonly kind: 'cancelled'; readonly cause: AgentCancelCause }
  | { readonly kind: 'rejected'; readonly failure: AgentRuntimeFailure }

/** Resolution of the receipt's start promise. */
export type SubmissionStart =
  | { readonly kind: 'started'; readonly turn: number; readonly eventSeq: number }
  | { readonly kind: 'not-started'; readonly reason: SubmissionNotStartedReason; readonly eventSeq: number }

/** Terminal settlement correlated to the durable submission event. */
export type SubmissionSettlement =
  | {
    readonly kind: 'settled'
    readonly turn: number
    readonly reason: TurnEndReason
    readonly eventSeq: number
  }
  | {
    readonly kind: 'not-started'
    readonly reason: SubmissionNotStartedReason
    readonly eventSeq: number
  }

/** Receipt returned after the Router durably accepts one submission. */
export interface SubmissionReceipt {
  /** Stable submission identity. */
  readonly id: SubmissionId
  /** Stable identity of the accepted user message. */
  readonly messageId: MessageId
  /** Resolves when a turn starts or the submission terminalizes before start. */
  readonly started: Promise<SubmissionStart>
  /** Resolves exactly once after the durable settlement event is dispatched. */
  readonly settled: Promise<SubmissionSettlement>
}

/** Stable runtime failure codes shared by creation, probing, submission, and disposal. */
export type AgentRuntimeErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_INVALID'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_INCOMPATIBLE'
  | 'AGENT_CAPABILITY_UNSUPPORTED'
  | 'AGENT_BUSY'
  | 'SUBMISSION_REJECTED'
  | 'RESUME_UNSUPPORTED'
  | 'EXTERNAL_STATE_MISSING'
  | 'SECURITY_POLICY_UNSATISFIED'
  | 'START_TIMEOUT'
  | 'TURN_TIMEOUT'
  | 'RUNTIME_FAILED'
  | 'DISPOSE_FAILED'

/** Stable operation phase attached to an {@link AgentRuntimeFailure}. */
export type AgentRuntimeErrorPhase =
  | 'registration'
  | 'profile'
  | 'probe'
  | 'prepare'
  | 'publication'
  | 'submission'
  | 'turn'
  | 'resume'
  | 'dispose'

/** Serializable, redacted runtime failure facts. */
export interface AgentRuntimeFailure {
  /** Stable machine-routable failure class. */
  readonly code: AgentRuntimeErrorCode
  /** Operation phase in which the failure became terminal. */
  readonly phase: AgentRuntimeErrorPhase
  /** Safe human-readable summary. */
  readonly message: string
  /** Selected provider when one had been resolved. */
  readonly providerId?: AgentRuntimeProviderId
  /** Redacted lossless-JSON diagnostics bounded by the package limit. */
  readonly details?: JsonValue
}
