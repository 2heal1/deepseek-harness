import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  Inbox,
  type AgentCancelCause,
  type AgentDriver,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
  type AgentRuntimeCapabilityId,
  type PreparedAgentRuntime,
} from '@deepseek-ai/dsh-agent-runtime'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it } from 'vitest'
import { RoutedAgent } from '../src/agent.ts'

class Driver implements AgentDriver {
  readonly inbox
  readonly sent: [UserMessage, InboxTarget, boolean][] = []
  status: AgentStatus = 'idle'
  cancelled: [AgentCancelCause, CancelOptions | undefined][] = []

  constructor(session: ReturnType<Context['sessions']['create']>) {
    this.inbox = new Inbox(session, {
      inserted() {},
      discarded() {},
      claimed() {},
    })
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.cancelled.push([cause, options])
  }

  whenIdle(): Promise<void> {
    return Promise.resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.sent.push([message, target, wakeup])
  }
}

function runtime(
  driver: AgentDriver | undefined,
  capabilityIds: AgentRuntimeCapabilityId[],
): PreparedAgentRuntime {
  const runtimeId = AgentRuntimeId('runtime-agent-test')
  const providerId = AgentRuntimeProviderId('fake')
  const capabilities = snapshotAgentRuntimeCapabilities(
    capabilityIds.map(id => ({ id })),
  )
  return {
    runtimeId,
    capabilities,
    initialFacts: snapshotAgentRuntimeFacts({
      runtimeId,
      providerId,
      capabilities,
      phase: 'ready',
    }),
    ...(driver === undefined ? {} : { agentDriver: driver }),
    submit: () => Promise.resolve({ reason: { kind: 'completed' } }),
    cancel() {},
    dispose: () => Promise.resolve(),
  }
}

function input(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'input' }],
    source: { kind: 'user' },
  })
}

describe('RoutedAgent', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
  })

  function create() {
    const session = ctx.sessions.create(SessionId('routed-agent'))
    return {
      agent: new RoutedAgent(
        ctx,
        session.id,
        {},
        session,
        AgentRuntimeProviderId('fake'),
      ),
      driver: new Driver(session),
    }
  }

  it('rejects missing, duplicate, and capability-incompatible drivers', async () => {
    const { agent, driver } = create()
    expect(agent.status).toBe('idle')
    expect(() => { agent.cancel({ kind: 'user' }) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
    expect(() => { agent.attachRuntime(runtime(undefined, [])) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))

    agent.attachRuntime(runtime(driver, []))
    expect(() => { agent.attachRuntime(runtime(driver, [])) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    expect(() => agent.inbox)
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    expect(() => { void agent.runMaintenance(() => Promise.resolve()) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'publication' }))

    agent.openAdmission()
    agent.openAdmission()
    expect(() => { void agent.runMaintenance(() => Promise.resolve()) })
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    expect(() => { agent.steer(input()) })
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    expect(() => { agent.inject(input()) })
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    await agent.disposeScope()
  })

  it('delegates every supported operation and closes admission permanently', async () => {
    const { agent, driver } = create()
    agent.attachRuntime(runtime(driver, [
      'queuedInputRead',
      'maintenance',
      'steering',
      'injection',
    ]))
    expect(agent.inbox).toBe(driver.inbox)
    driver.status = 'running'
    expect(agent.status).toBe('running')
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()

    agent.inject(input())
    agent.openAdmission()
    await expect(agent.runMaintenance(() => Promise.resolve('done'))).resolves.toBe('done')
    agent.followup(input())
    agent.steer(input())
    agent.send(input(), 'next-turn', false)
    expect(driver.sent.map(([, target, wakeup]) => [target, wakeup])).toEqual([
      ['next-step', false],
      ['next-turn', true],
      ['next-step', true],
      ['next-turn', false],
    ])
    expect(driver.cancelled).toEqual([[{ kind: 'user' }, { keepInbox: true }]])

    agent.closeAdmission()
    agent.openAdmission()
    expect(() => { agent.followup(input()) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'submission' }))
    expect(() => { agent.inject(input()) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'submission' }))
    await agent.disposeScope()
  })
})
