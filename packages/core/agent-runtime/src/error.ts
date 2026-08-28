/** Serializable agent-runtime failure construction. @module @deepseek-ai/dsh-agent-runtime/error */

import { HarnessError, deepFreeze } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { AgentRuntimeFailure } from './types.ts'

/** Maximum UTF-8 size of serialized runtime failure details. */
export const MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES = 4_096

const utf8Encoder = new TextEncoder()

/**
 * Detach, validate, bound, and freeze serializable runtime failure facts.
 * The producer must redact details before calling this function.
 *
 * @param failure - safe provider-neutral failure facts.
 * @returns a detached deeply frozen failure.
 * @throws {TypeError} when details are not lossless JSON.
 * @throws {RangeError} when serialized details exceed the package limit.
 */
export function snapshotAgentRuntimeFailure(failure: AgentRuntimeFailure): AgentRuntimeFailure {
  let details: JsonValue | undefined
  if (failure.details !== undefined) {
    details = snapshotJsonValue(failure.details)
    if (details === undefined) {
      throw new TypeError('agent runtime failure details must be lossless JSON')
    }
    if (utf8Encoder.encode(JSON.stringify(details)).byteLength > MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES) {
      throw new RangeError(
        `agent runtime failure details exceed ${MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES} UTF-8 bytes`,
      )
    }
  }
  return deepFreeze({
    code: failure.code,
    phase: failure.phase,
    message: failure.message,
    ...(failure.providerId === undefined ? {} : { providerId: failure.providerId }),
    ...(details === undefined ? {} : { details }),
  })
}

/** Runtime failure carrying the same serializable facts used by events and APIs. */
export class AgentRuntimeError extends HarnessError {
  /** Detached, deeply frozen provider-neutral failure. */
  readonly failure: AgentRuntimeFailure
  /** Operation phase in which the failure became terminal. */
  readonly phase: AgentRuntimeFailure['phase']
  /** Selected provider when one had been resolved. */
  readonly providerId: AgentRuntimeFailure['providerId']
  /** Redacted bounded diagnostic detail. */
  readonly details: AgentRuntimeFailure['details']

  /**
   * Construct a typed runtime error.
   * @param failure - serializable safe failure facts.
   * @param options - optional local cause, excluded from serialized facts.
   */
  constructor(failure: AgentRuntimeFailure, options?: ErrorOptions) {
    const snapshot = snapshotAgentRuntimeFailure(failure)
    super(snapshot.message, snapshot.code, options)
    this.failure = snapshot
    this.phase = snapshot.phase
    this.providerId = snapshot.providerId
    this.details = snapshot.details
    this.name = 'AgentRuntimeError'
  }
}
