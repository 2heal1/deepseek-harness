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
import {
  AgentRuntimeError,
  hasAgentRuntimeCapability,
  snapshotAgentRuntimeCapabilities,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeCapabilityId,
  AgentRuntimeProviderId,
  PreparedAgentRuntime,
} from '@deepseek-ai/dsh-agent-runtime'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

type Admission = 'publishing' | 'open' | 'closed'

/** Router-owned implementation behind the public Agent interface. */
export class RoutedAgent implements Agent {
  readonly ctx: Context
  private readonly scope: Scope
  private admission: Admission = 'publishing'
  private capabilityValue: AgentRuntimeCapabilities = Object.freeze([])
  private driverValue: AgentDriver | undefined

  /**
   * Create one unpublished Agent and its scoped context.
   * @param runtimeCtx - Router dependency context inherited by the Agent scope.
   * @param id - shared Agent and Session identity.
   * @param options - Native model-route options retained during migration.
   * @param session - unpublished Session owned by the Router transaction.
   * @param providerId - selected runtime provider.
   */
  constructor(
    runtimeCtx: Context,
    readonly id: SessionId,
    readonly options: AgentOptions,
    readonly session: Session,
    private readonly providerId: AgentRuntimeProviderId,
  ) {
    this.scope = createScope(runtimeCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get capabilities(): AgentRuntimeCapabilities {
    return this.capabilityValue
  }

  /** Attach the Native compatibility driver returned by the prepared runtime. */
  attachRuntime(runtime: PreparedAgentRuntime): void {
    if (this.driverValue !== undefined) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'prepare',
        message: `agent runtime provider "${this.providerId}" attached more than one driver`,
        providerId: this.providerId,
      })
    }
    if (runtime.agentDriver === undefined) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'prepare',
        message: `agent runtime provider "${this.providerId}" does not expose the Native compatibility driver required before F5`,
        providerId: this.providerId,
      })
    }
    this.capabilityValue = snapshotAgentRuntimeCapabilities(runtime.capabilities)
    this.driverValue = runtime.agentDriver
  }

  /** Open submission admission after synchronous publication succeeds. */
  openAdmission(): void {
    if (this.admission === 'publishing') this.admission = 'open'
  }

  /** Permanently close submission admission before teardown awaits. */
  closeAdmission(): void {
    this.admission = 'closed'
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
    return this.driverValue?.status ?? 'idle'
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.driver().cancel(cause, options)
  }

  whenIdle(): Promise<void> {
    return this.driver().whenIdle()
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
