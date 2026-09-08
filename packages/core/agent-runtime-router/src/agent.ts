/**
 * Router-owned Agent identity and Native compatibility delegation.
 * @module @deepseek-ai/dsh-agent-runtime-router/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentDriver,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  Inbox,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeError,
  hasAgentRuntimeCapability,
  snapshotAgentRuntimeFailure,
  snapshotAgentRuntimeCapabilities,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeActivity,
  AgentRuntimeAssistantChunk,
  AgentRuntimeAssistantOutput,
  AgentRuntimeCapabilities,
  AgentRuntimeCapabilityId,
  AgentRuntimeFacts,
  AgentRuntimeProviderId,
  PreparedAgentRuntime,
  SubmissionId,
  SubmissionReceipt,
  SubmissionSettlement,
  SubmissionStart,
} from '@deepseek-ai/dsh-agent-runtime'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import {
  snapshotJsonValue,
  type Session,
  type SessionId,
  type TurnEndReason,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'

type Admission = 'publishing' | 'open' | 'closed'

interface SubmissionState {
  readonly id: SubmissionId
  readonly message: UserMessage
  readonly abort: AbortController
  readonly started: PromiseWithResolvers<SubmissionStart>
  readonly settled: PromiseWithResolvers<SubmissionSettlement>
  turn?: number
  terminal: boolean
  cancellationRequested: boolean
  nextChunkIndex: number
}

const RUNTIME_ACTIVITY_MAX_BYTES = 16 * 1024

/** Router-owned implementation behind the public Agent interface. */
export class RoutedAgent implements Agent {
  readonly ctx: Context
  private readonly scope: Scope
  private admission: Admission = 'publishing'
  private capabilityValue: AgentRuntimeCapabilities = Object.freeze([])
  private driverValue: AgentDriver | undefined
  private runtimeValue: PreparedAgentRuntime | undefined
  private readonly submissions = new Map<SubmissionId, SubmissionState>()
  private readonly submissionQueue: SubmissionState[] = []
  private activeSubmission: SubmissionState | undefined
  private externalStatus: AgentStatus = 'idle'
  private externalIdle = Promise.withResolvers<void>()

  /**
   * Create one unpublished Agent and its scoped context.
   * @param runtimeCtx - Router dependency context inherited by the Agent scope.
   * @param id - shared Agent and Session identity.
   * @param options - Native model-route options retained during migration.
   * @param session - unpublished Session owned by the Router transaction.
   * @param providerId - selected runtime provider.
   */
  constructor(
    private readonly runtimeCtx: Context,
    readonly id: SessionId,
    readonly options: AgentOptions,
    readonly session: Session,
    private readonly providerId: AgentRuntimeProviderId,
  ) {
    this.externalIdle.resolve()
    this.scope = createScope(runtimeCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get capabilities(): AgentRuntimeCapabilities {
    return this.capabilityValue
  }

  /** Attach the Native compatibility driver returned by the prepared runtime. */
  attachRuntime(runtime: PreparedAgentRuntime): void {
    if (this.runtimeValue !== undefined) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'prepare',
        message: `agent runtime provider "${this.providerId}" attached more than one driver`,
        providerId: this.providerId,
      })
    }
    this.capabilityValue = snapshotAgentRuntimeCapabilities(runtime.capabilities)
    this.runtimeValue = runtime
    this.driverValue = runtime.agentDriver
  }

  /** Open submission admission after synchronous publication succeeds. */
  openAdmission(): void {
    if (this.admission === 'publishing') this.admission = 'open'
  }

  /** Permanently close submission admission before teardown awaits. */
  closeAdmission(): Promise<void> {
    this.admission = 'closed'
    const settlements = [...this.submissions.values()].map(state => state.settled.promise)
    for (const submissionId of this.submissions.keys()) {
      this.cancelSubmission(submissionId, { kind: 'disposed' })
    }
    return Promise.all(settlements).then(() => undefined)
  }

  /** Dispose every Agent-scoped registration and reach scope quiescence. */
  disposeScope(): Promise<void> {
    return this.scope.dispose()
  }

  get inbox(): Inbox {
    this.assertCapability('queuedInputRead', 'inbox')
    return this.driver().inbox
  }

  get status(): AgentStatus {
    return this.driverValue?.status ?? this.externalStatus
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    if (this.driverValue !== undefined) {
      this.driverValue.cancel(cause, options)
      return
    }
    if (this.activeSubmission !== undefined) {
      this.cancelSubmission(this.activeSubmission.id, cause)
    }
  }

  whenIdle(): Promise<void> {
    return this.driverValue?.whenIdle() ?? this.externalIdle.promise
  }

  submit(message: UserMessage): SubmissionReceipt {
    this.assertOpenAdmission()
    const id = `submission-${randomUUID()}` as SubmissionId
    const state: SubmissionState = {
      id,
      message,
      abort: new AbortController(),
      started: Promise.withResolvers<SubmissionStart>(),
      settled: Promise.withResolvers<SubmissionSettlement>(),
      terminal: false,
      cancellationRequested: false,
      nextChunkIndex: 0,
    }
    this.session.append('agent/submission/accepted', {
      submissionId: id,
      messageId: message.id,
    })
    this.submissions.set(id, state)
    this.submissionQueue.push(state)
    if (this.driverValue === undefined && this.externalStatus === 'idle') {
      this.externalIdle = Promise.withResolvers<void>()
      this.setExternalStatus('running')
    }
    this.pumpSubmissions()
    return Object.freeze({
      id,
      messageId: message.id,
      started: state.started.promise,
      settled: state.settled.promise,
    })
  }

  cancelSubmission(submissionId: SubmissionId, cause: AgentCancelCause): boolean {
    const state = this.submissions.get(submissionId)
    if (state === undefined || state.terminal || state.cancellationRequested) return false
    state.cancellationRequested = true
    state.abort.abort(cause)
    if (state.turn === undefined) {
      const index = this.submissionQueue.indexOf(state)
      if (index >= 0) this.submissionQueue.splice(index, 1)
      this.settleNotStarted(state, { kind: 'cancelled', cause })
    } else {
      this.runtime().cancel(submissionId, cause)
    }
    return true
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpenAdmission()
    this.assertCapability('maintenance', 'runMaintenance')
    return this.driver().runMaintenance(task)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (wakeup) this.assertOpenAdmission()
    else this.assertNotClosed()
    if (target === 'next-step') {
      this.assertCapability(wakeup ? 'steering' : 'injection', 'send')
    }
    this.driver().send(message, target, wakeup)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  /** Append one validated runtime-facts snapshot through the restricted sink. */
  appendRuntimeFacts(facts: AgentRuntimeFacts): void {
    this.session.append('agent/runtime/facts', facts)
  }

  /** Append one external-runtime assistant chunk for an open submission. */
  appendRuntimeAssistantChunk(
    submissionId: SubmissionId,
    chunk: AgentRuntimeAssistantChunk,
  ): void {
    const state = this.openStartedSubmission(submissionId)
    const provenance = this.runtimeProvenance(state)
    const index = state.nextChunkIndex++
    switch (chunk.kind) {
      case 'text-delta':
        this.session.append('assistant/chunk', {
          turn: state.turn,
          provenance,
          chunk: { type: 'text-delta', index, text: chunk.text },
        })
        break
      case 'reasoning-delta':
        this.session.append('assistant/chunk', {
          turn: state.turn,
          provenance,
          chunk: { type: 'reasoning-delta', index, text: chunk.text },
        })
        break
      case 'content-block':
        this.session.append('assistant/chunk', {
          turn: state.turn,
          provenance,
          chunk: { type: 'block-start', index, blockType: chunk.block.type },
        })
        this.session.append('assistant/chunk', {
          turn: state.turn,
          provenance,
          chunk: { type: 'block-end', index, block: chunk.block },
        })
        break
    }
  }

  /** Append one completed external-runtime assistant message. */
  appendRuntimeAssistantMessage(
    submissionId: SubmissionId,
    output: AgentRuntimeAssistantOutput,
  ): void {
    const state = this.openStartedSubmission(submissionId)
    const provenance = this.runtimeProvenance(state)
    const message = createMessage({
      role: 'assistant',
      content: [...output.content],
      source: {
        kind: 'runtime',
        provider: this.providerId,
        source: 'protocol',
      },
    })
    this.session.append('assistant/message', {
      turn: state.turn,
      provenance,
      message,
    }, { surfaceOp: 'append' })
  }

  /** Append one bounded runtime activity report outside model history. */
  appendRuntimeActivity(activity: AgentRuntimeActivity): void {
    this.assertCapability('runtimeActivity', 'runtime activity')
    if (activity.submissionId !== undefined) {
      this.openStartedSubmission(activity.submissionId)
    }
    const snapshot = snapshotJsonValue(activity)
    if (snapshot === undefined) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_FAILED',
        phase: 'turn',
        message: 'runtime activity must be lossless JSON',
        providerId: this.providerId,
      })
    }
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
      > RUNTIME_ACTIVITY_MAX_BYTES) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_FAILED',
        phase: 'turn',
        message: `runtime activity exceeds ${RUNTIME_ACTIVITY_MAX_BYTES} UTF-8 bytes`,
        providerId: this.providerId,
      })
    }
    this.session.append('agent/runtime/activity', activity)
  }

  private async runSubmission(state: SubmissionState): Promise<void> {
    try {
      const runtime = this.runtime()
      if (runtime.agentDriver?.status === 'running') {
        await runtime.agentDriver.whenIdle()
        if (state.terminal) return
      }
      if (runtime.agentDriver === undefined) {
        const turn = this.nextTurn()
        this.session.append('turn/start', { turn })
        this.startSubmission(state, turn)
        this.session.append('user/message', state.message, { surfaceOp: 'append' })
      }
      const result = await runtime.submit({
        submissionId: state.id,
        message: state.message,
        signal: state.abort.signal,
        started: (turn) => { this.startSubmission(state, turn) },
      })
      const turn = state.turn
      if (turn === undefined) {
        this.settleNotStarted(state, {
          kind: 'rejected',
          failure: {
            code: 'RUNTIME_FAILED',
            phase: 'turn',
            message: 'runtime settled a submission before opening its turn',
            providerId: this.providerId,
          },
        })
        return
      }
      if (runtime.agentDriver === undefined) {
        this.session.append('turn/end', { turn, reason: result.reason })
      }
      this.settleStarted(state, turn, result.reason)
    } catch (error: unknown) {
      if (state.terminal) return
      const failure = snapshotAgentRuntimeFailure(error instanceof AgentRuntimeError
        ? error.failure
        : {
          code: 'RUNTIME_FAILED',
          phase: state.turn === undefined ? 'submission' : 'turn',
          message: error instanceof Error ? error.message : String(error),
          providerId: this.providerId,
        })
      if (state.turn === undefined) {
        this.settleNotStarted(state, { kind: 'rejected', failure })
      } else {
        const reason: TurnEndReason = {
          kind: 'error',
          error: { code: failure.code, message: failure.message },
        }
        if (this.runtime().agentDriver === undefined) {
          this.session.append('turn/end', { turn: state.turn, reason })
        }
        this.settleStarted(state, state.turn, reason)
      }
    }
  }

  private startSubmission(state: SubmissionState, turn: number): void {
    if (state.terminal || state.turn !== undefined) return
    state.turn = turn
    const event = this.session.append('agent/submission/started', {
      submissionId: state.id,
      messageId: state.message.id,
      turn,
    })
    state.started.resolve({ kind: 'started', turn, eventSeq: event.seq })
  }

  private settleStarted(
    state: SubmissionState,
    turn: number,
    reason: TurnEndReason,
  ): void {
    state.terminal = true
    const event = this.session.append('agent/submission/settled', {
      submissionId: state.id,
      messageId: state.message.id,
      settlement: { kind: 'settled', turn, reason },
    })
    state.settled.resolve({
      kind: 'settled',
      turn,
      reason,
      eventSeq: event.seq,
    })
    this.finishSubmission(state)
  }

  private settleNotStarted(
    state: SubmissionState,
    reason: Extract<SubmissionSettlement, { kind: 'not-started' }>['reason'],
  ): void {
    state.terminal = true
    const event = this.session.append('agent/submission/settled', {
      submissionId: state.id,
      messageId: state.message.id,
      settlement: { kind: 'not-started', reason },
    })
    const result: SubmissionSettlement & SubmissionStart = {
      kind: 'not-started',
      reason,
      eventSeq: event.seq,
    }
    state.started.resolve(result)
    state.settled.resolve(result)
    this.finishSubmission(state)
  }

  private finishSubmission(state: SubmissionState): void {
    this.submissions.delete(state.id)
    if (this.activeSubmission === state) this.activeSubmission = undefined
    if (this.driverValue === undefined && this.submissions.size === 0) {
      this.setExternalStatus('idle')
      this.externalIdle.resolve()
    }
    this.pumpSubmissions()
  }

  private pumpSubmissions(): void {
    if (this.admission === 'closed' || this.activeSubmission !== undefined) return
    const state = this.submissionQueue.shift()
    if (state === undefined) return
    this.activeSubmission = state
    void this.runSubmission(state)
  }

  private setExternalStatus(status: AgentStatus): void {
    this.externalStatus = status
    emitAgentEvent(this.runtimeCtx, this, 'agent/status', { status })
  }

  private openStartedSubmission(submissionId: SubmissionId): SubmissionState & { turn: number } {
    const state = this.submissions.get(submissionId)
    if (state === undefined || state.terminal || state.turn === undefined) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_FAILED',
        phase: 'turn',
        message: `runtime output does not belong to an open submission "${submissionId}"`,
        providerId: this.providerId,
      })
    }
    return state as SubmissionState & { turn: number }
  }

  private runtimeProvenance(
    state: SubmissionState & { turn: number },
  ): {
    kind: 'runtime'
    provider: string
    source: 'protocol'
    submissionId: string
  } {
    return {
      kind: 'runtime',
      provider: this.providerId,
      source: 'protocol',
      submissionId: state.id,
    }
  }

  private nextTurn(): number {
    return (this.session.events.findLast(event => event.type === 'turn/start')
      ?.data.turn ?? 0) + 1
  }

  private runtime(): PreparedAgentRuntime {
    if (this.runtimeValue !== undefined) return this.runtimeValue
    throw new AgentRuntimeError({
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'prepare',
      message: `agent runtime provider "${this.providerId}" has not prepared`,
      providerId: this.providerId,
    })
  }

  /** Require the prepared Native driver. */
  private driver(): AgentDriver {
    if (this.driverValue !== undefined) return this.driverValue
    throw new AgentRuntimeError({
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'prepare',
      message: `agent runtime provider "${this.providerId}" has not prepared its driver`,
      providerId: this.providerId,
    })
  }

  /** Reject input until publication commits and after teardown starts. */
  private assertOpenAdmission(): void {
    if (this.admission === 'open') return
    throw new AgentRuntimeError({
      code: 'SUBMISSION_REJECTED',
      phase: this.admission === 'publishing' ? 'publication' : 'submission',
      message: this.admission === 'publishing'
        ? 'agent publication has not completed'
        : 'agent is closed',
      providerId: this.providerId,
    })
  }

  /** Permit composition-only injection while publishing, but never after close. */
  private assertNotClosed(): void {
    if (this.admission !== 'closed') return
    throw new AgentRuntimeError({
      code: 'SUBMISSION_REJECTED',
      phase: 'submission',
      message: 'agent is closed',
      providerId: this.providerId,
    })
  }

  /** Enforce capability-gated Native compatibility operations. */
  private assertCapability(capability: AgentRuntimeCapabilityId, operation: string): void {
    if (hasAgentRuntimeCapability(this.capabilities, capability)) return
    throw new AgentRuntimeError({
      code: 'AGENT_CAPABILITY_UNSUPPORTED',
      phase: 'submission',
      message: `agent runtime does not support ${operation}`,
      providerId: this.providerId,
      details: { agentId: this.id, capability, operation },
    })
  }
}
