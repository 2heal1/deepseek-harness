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
  submit: PreparedAgentRuntime['submit'] = () =>
    Promise.resolve({ reason: { kind: 'completed' } }),
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
    submit,
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

  function create(id = 'routed-agent') {
    const session = ctx.sessions.create(SessionId(id))
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

  it('accepts external runtimes and rejects duplicate or capability-incompatible attachment', async () => {
    const { agent, driver } = create()
    expect(agent.status).toBe('idle')
    expect(() => { agent.cancel({ kind: 'user' }) })
      .not.toThrow()
    agent.attachRuntime(runtime(undefined, []))
    expect(() => { agent.attachRuntime(runtime(undefined, [])) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    await agent.disposeScope()

    const native = create('native-agent').agent
    native.attachRuntime(runtime(driver, []))
    expect(() => { native.attachRuntime(runtime(driver, [])) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    expect(() => native.inbox)
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    expect(() => { void native.runMaintenance(() => Promise.resolve()) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'publication' }))

    native.openAdmission()
    native.openAdmission()
    expect(() => { void native.runMaintenance(() => Promise.resolve()) })
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    expect(() => { native.steer(input()) })
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    expect(() => { native.inject(input()) })
      .toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))
    await native.disposeScope()
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

    await agent.closeAdmission()
    agent.openAdmission()
    expect(() => { agent.followup(input()) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'submission' }))
    expect(() => { agent.inject(input()) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'submission' }))
    await agent.disposeScope()
  })

  it('settles a submission cancelled while a Native driver is busy', async () => {
    const { agent, driver } = create()
    const idle = Promise.withResolvers<undefined>()
    driver.status = 'running'
    driver.whenIdle = () => idle.promise
    agent.attachRuntime(runtime(driver, []))
    agent.openAdmission()

    const receipt = agent.submit(input())
    expect(agent.cancelSubmission(receipt.id, { kind: 'user' })).toBe(true)
    await expect(receipt.started).resolves.toMatchObject({
      kind: 'not-started',
      reason: { kind: 'cancelled', cause: { kind: 'user' } },
    })
    idle.resolve(undefined)
    await expect(receipt.settled).resolves.toMatchObject({ kind: 'not-started' })

    const available = Promise.withResolvers<undefined>()
    driver.whenIdle = () => available.promise
    const admitted = agent.submit(input())
    available.resolve(undefined)
    await expect(admitted.settled).resolves.toMatchObject({ kind: 'not-started' })

    const rejected = Promise.withResolvers<undefined>()
    driver.whenIdle = () => rejected.promise
    const cancelled = agent.submit(input())
    expect(agent.cancelSubmission(cancelled.id, { kind: 'user' })).toBe(true)
    rejected.reject(new Error('idle wait failed after cancellation'))
    await expect(cancelled.settled).resolves.toMatchObject({ kind: 'not-started' })
    await agent.disposeScope()
  })

  it('reports missing prepared runtime and Native driver through receipts and capabilities', async () => {
    const missingRuntime = create('missing-runtime').agent
    missingRuntime.openAdmission()
    const receipt = missingRuntime.submit(input())
    await expect(receipt.settled).resolves.toMatchObject({
      kind: 'not-started',
      reason: {
        kind: 'rejected',
        failure: { code: 'RUNTIME_UNAVAILABLE', phase: 'prepare' },
      },
    })
    await missingRuntime.disposeScope()

    const missingDriver = create('missing-driver').agent
    missingDriver.attachRuntime(runtime(undefined, ['queuedInputRead']))
    expect(() => missingDriver.inbox)
      .toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
    await missingDriver.disposeScope()

    const started = create('native-started').agent
    started.attachRuntime(runtime(new Driver(started.session), [], (request) => {
      started.session.append('turn/start', { turn: 1 })
      request.started(1)
      started.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return Promise.resolve({ reason: { kind: 'completed' } })
    }))
    started.openAdmission()
    await expect(started.submit(input()).settled).resolves.toMatchObject({
      kind: 'settled',
      turn: 1,
    })
    await started.disposeScope()

    const failed = create('native-started-failure').agent
    failed.attachRuntime(runtime(new Driver(failed.session), [], (request) => {
      failed.session.append('turn/start', { turn: 1 })
      request.started(1)
      failed.session.append('turn/end', {
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'RUNTIME_FAILED', message: 'started submission failed' },
        },
      })
      return Promise.reject(new Error('started submission failed'))
    }))
    failed.openAdmission()
    await expect(failed.submit(input()).settled).resolves.toMatchObject({
      kind: 'settled',
      reason: {
        kind: 'error',
        error: { code: 'RUNTIME_FAILED', message: 'started submission failed' },
      },
    })
    await failed.disposeScope()
  })
})
