/** Immutable runtime capability and fact snapshots. @module @deepseek-ai/dsh-agent-runtime/snapshot */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { AgentRuntimeError } from './error.ts'
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeCapability,
  AgentRuntimeCapabilityId,
  AgentRuntimeFacts,
  AgentRuntimeId,
  AgentRuntimeProvider,
  PreparedAgentRuntime,
} from './types.ts'

const CAPABILITY_IDS = new Set<AgentRuntimeCapabilityId>([
  'continuation',
  'steering',
  'queuedInputRead',
  'queuedInputMutation',
  'injection',
  'maintenance',
  'imageInput',
  'modelOverride',
  'approvals',
  'runtimeActivity',
  'harnessTools',
  'resume',
  'coldResume',
])

/** Assert one opaque runtime identifier is non-empty and has no surrounding whitespace. */
function assertOpaqueId(label: string, value: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty and have no surrounding whitespace`)
  }
}

/**
 * Detach, validate, and deeply freeze an effective capability set.
 *
 * @param capabilities - provider-authored capability declarations.
 * @returns an immutable detached snapshot in provider order.
 * @throws {TypeError} for an unknown or duplicate id or non-JSON metadata.
 */
export function snapshotAgentRuntimeCapabilities(
  capabilities: AgentRuntimeCapabilities,
): AgentRuntimeCapabilities {
  const seen = new Set<AgentRuntimeCapabilityId>()
  const snapshot: AgentRuntimeCapability[] = []
  for (const capability of capabilities) {
    if (!CAPABILITY_IDS.has(capability.id)) {
      throw new TypeError(`unknown agent runtime capability ${JSON.stringify(capability.id)}`)
    }
    if (seen.has(capability.id)) {
      throw new TypeError(`duplicate agent runtime capability ${JSON.stringify(capability.id)}`)
    }
    seen.add(capability.id)
    if (capability.metadata === undefined) {
      snapshot.push({ id: capability.id })
      continue
    }
    const metadata = snapshotJsonValue(capability.metadata)
    if (metadata === undefined) {
      throw new TypeError(
        `agent runtime capability ${JSON.stringify(capability.id)} metadata must be lossless JSON`,
      )
    }
    snapshot.push({ id: capability.id, metadata })
  }
  return deepFreeze(snapshot)
}

/**
 * Test whether an immutable capability set declares one capability.
 * @param capabilities - effective runtime capabilities.
 * @param id - capability required by an operation.
 * @returns whether the id is present.
 */
export function hasAgentRuntimeCapability(
  capabilities: AgentRuntimeCapabilities,
  id: AgentRuntimeCapabilityId,
): boolean {
  return capabilities.some(capability => capability.id === id)
}

/**
 * Detach and deeply freeze normalized runtime facts.
 *
 * @param facts - provider-authored facts.
 * @returns an immutable snapshot with a separately validated capability set.
 * @throws {TypeError} when identities are blank or any value is not lossless JSON.
 */
export function snapshotAgentRuntimeFacts(facts: AgentRuntimeFacts): AgentRuntimeFacts {
  assertOpaqueId('agent runtime id', facts.runtimeId)
  assertOpaqueId('agent runtime provider id', facts.providerId)
  const detached = snapshotJsonValue({
    ...facts,
    capabilities: snapshotAgentRuntimeCapabilities(facts.capabilities),
  })
  if (detached === undefined) {
    throw new TypeError('agent runtime facts must be lossless JSON')
  }
  return deepFreeze(detached)
}

/**
 * Validate a prepared handle's provider and runtime identities.
 *
 * @param provider - Provider that returned the handle.
 * @param runtimeId - runtime identity reserved by the Consumer.
 * @param runtime - prepared handle to validate.
 * @returns detached initial runtime facts.
 * @throws {AgentRuntimeError} when the handle or facts report another identity.
 */
export function snapshotPreparedAgentRuntimeFacts(
  provider: AgentRuntimeProvider,
  runtimeId: AgentRuntimeId,
  runtime: PreparedAgentRuntime,
): AgentRuntimeFacts {
  const facts = snapshotAgentRuntimeFacts(runtime.initialFacts)
  if (runtime.runtimeId === runtimeId
    && facts.runtimeId === runtimeId
    && facts.providerId === provider.id) {
    return facts
  }
  throw new AgentRuntimeError({
    code: 'RUNTIME_INCOMPATIBLE',
    phase: 'prepare',
    message: `agent runtime provider "${provider.id}" returned mismatched runtime identity`,
    providerId: provider.id,
  })
}
