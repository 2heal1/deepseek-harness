/**
 * Service Definition for configurable agent runtimes (`ctx.agentRuntimes`).
 * The service owns effect-scoped provider discovery and the provider-neutral
 * vocabulary used by Router and Provider packages. It does not create or
 * publish Agents; the Router Consumer owns that transaction.
 *
 * @module @deepseek-ai/dsh-agent-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { AgentRuntimeError } from './error.ts'
import type {
  AgentRuntimeId as AgentRuntimeIdType,
  AgentRuntimeProvider,
  AgentRuntimeProviderId as AgentRuntimeProviderIdType,
  ExternalSessionId as ExternalSessionIdType,
  RuntimeProfileId as RuntimeProfileIdType,
  SubmissionId as SubmissionIdType,
} from './types.ts'

export {
  AgentRuntimeError,
  MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES,
  snapshotAgentRuntimeFailure,
} from './error.ts'
export {
  hasAgentRuntimeCapability,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
} from './snapshot.ts'
export type {
  AgentRuntimeActivity,
  AgentRuntimeActivityFidelity,
  AgentRuntimeAssistantChunk,
  AgentRuntimeAssistantOutput,
  AgentRuntimeCapabilities,
  AgentRuntimeCapability,
  AgentRuntimeCapabilityId,
  AgentRuntimeCreateRequest,
  AgentRuntimeErrorCode,
  AgentRuntimeErrorPhase,
  AgentRuntimeEventSink,
  AgentRuntimeFactSource,
  AgentRuntimeFacts,
  AgentRuntimeFailure,
  AgentRuntimePhase,
  AgentRuntimePrepareBase,
  AgentRuntimePrepareRequest,
  AgentRuntimeProbeRequest,
  AgentRuntimeProbeResult,
  AgentRuntimeProvider,
  AgentRuntimeResumeRequest,
  AgentRuntimeSubmissionRequest,
  AgentRuntimeSubmissionResult,
  PreparedAgentRuntime,
  RuntimeCapacitySnapshot,
  RuntimeCredentialMapping,
  RuntimeExecutableResolution,
  RuntimeHarnessToolSnapshot,
  RuntimeLaunchSnapshot,
  RuntimeModelSnapshot,
  RuntimeNativeToolSnapshot,
  RuntimePermissionSnapshot,
  RuntimeProcessDeadlines,
  RuntimeProfileSnapshot,
  RuntimeWorkingDirectoryPolicy,
  SourcedRuntimeFact,
  SubmissionNotStartedReason,
  SubmissionReceipt,
  SubmissionSettlement,
  SubmissionStart,
} from './types.ts'

/** Identifies one registered runtime provider. */
export type AgentRuntimeProviderId = AgentRuntimeProviderIdType
/** Identifies one resolved Runtime Profile. */
export type RuntimeProfileId = RuntimeProfileIdType
/** Identifies one prepared runtime instance. */
export type AgentRuntimeId = AgentRuntimeIdType
/** Correlates one accepted input through start and settlement. */
export type SubmissionId = SubmissionIdType
/** Opaque, safe-to-persist session identity assigned by an external product. */
export type ExternalSessionId = ExternalSessionIdType

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimes: AgentRuntimeRegistry
  }

  interface Events {
    /**
     * An agent runtime provider became selectable.
     * @param provider - registered provider.
     * @mode emit
     */
    'agent-runtime/provider-added'(provider: AgentRuntimeProvider): void
    /**
     * An agent runtime provider stopped being selectable.
     * @param providerId - provider identity removed from the registry.
     * @mode emit
     */
    'agent-runtime/provider-removed'(providerId: AgentRuntimeProviderId): void
  }
}

/**
 * Brand an opaque runtime provider identifier without validation.
 * @param id - raw provider identifier.
 * @returns the same string, branded.
 */
export function AgentRuntimeProviderId(id: string): AgentRuntimeProviderIdType {
  return id as AgentRuntimeProviderIdType
}

/**
 * Brand an opaque Runtime Profile identifier without validation.
 * @param id - raw profile identifier.
 * @returns the same string, branded.
 */
export function RuntimeProfileId(id: string): RuntimeProfileIdType {
  return id as RuntimeProfileIdType
}

/**
 * Brand an opaque prepared runtime identifier without validation.
 * @param id - raw runtime identifier.
 * @returns the same string, branded.
 */
export function AgentRuntimeId(id: string): AgentRuntimeIdType {
  return id as AgentRuntimeIdType
}

/**
 * Brand an opaque submission identifier without validation.
 * @param id - raw submission identifier.
 * @returns the same string, branded.
 */
export function SubmissionId(id: string): SubmissionIdType {
  return id as SubmissionIdType
}

/**
 * Brand an opaque external product session identifier without validation.
 * @param id - raw external session identifier.
 * @returns the same string, branded.
 */
export function ExternalSessionId(id: string): ExternalSessionIdType {
  return id as ExternalSessionIdType
}

/** Validate provider-owned registration metadata before publication. */
function validateProvider(provider: AgentRuntimeProvider): void {
  if (provider.id.length === 0 || provider.id.trim() !== provider.id || /\s/.test(provider.id)) {
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'registration',
      message: 'agent runtime provider id must be non-empty and contain no whitespace',
      providerId: provider.id,
    })
  }
  if (provider.profileSnapshotVersions.length === 0) {
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'registration',
      message: `agent runtime provider "${provider.id}" accepts no profile snapshot version`,
      providerId: provider.id,
    })
  }
  const seen = new Set<number>()
  for (const version of provider.profileSnapshotVersions) {
    if (!Number.isSafeInteger(version) || version < 0 || seen.has(version)) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'registration',
        message: `agent runtime provider "${provider.id}" has invalid profile snapshot versions`,
        providerId: provider.id,
      })
    }
    seen.add(version)
  }
}

/** Effect-scoped named registry for agent runtime providers. */
export class AgentRuntimeRegistry extends Service {
  private readonly providers = new Map<AgentRuntimeProviderIdType, AgentRuntimeProvider>()

  constructor(ctx: Context) {
    super(ctx, 'agentRuntimes')
  }

  /**
   * Register one provider. Removing it blocks later selection but does not
   * revoke prepared handles; the Provider plugin must drain those handles
   * before disposing this registration.
   *
   * @param provider - trusted same-process Provider implementation.
   * @returns the exact Cordis effect disposer.
   * @throws {AgentRuntimeError} code `RUNTIME_INCOMPATIBLE` for malformed or duplicate registration.
   */
  registerProvider(provider: AgentRuntimeProvider): () => void {
    validateProvider(provider)
    const id = provider.id
    const dispose = this.ctx.effect(function* (this: AgentRuntimeRegistry) {
      if (this.providers.has(id)) {
        throw new AgentRuntimeError({
          code: 'RUNTIME_INCOMPATIBLE',
          phase: 'registration',
          message: `an agent runtime provider named "${id}" is already registered`,
          providerId: id,
        })
      }
      this.providers.set(id, provider)
      yield () => {
        this.providers.delete(id)
        this.ctx.emit('agent-runtime/provider-removed', id)
      }
      this.ctx.emit('agent-runtime/provider-added', provider)
    }.bind(this), 'agentRuntimes.registerProvider()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Look up one currently selectable provider.
   * @param id - stable provider identity.
   * @returns the provider, or `undefined` when absent.
   */
  getProvider(id: AgentRuntimeProviderId): AgentRuntimeProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * List currently selectable providers in registration order.
   * @returns a detached provider array.
   */
  listProviders(): AgentRuntimeProvider[] {
    return [...this.providers.values()]
  }
}

export default AgentRuntimeRegistry
