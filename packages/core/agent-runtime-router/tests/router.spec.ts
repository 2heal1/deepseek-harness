import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentDriver,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry, {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
  type AgentRuntimePrepareRequest,
  type AgentRuntimeProbeRequest,
  type AgentRuntimeProbeResult,
  type AgentRuntimeProvider,
  type AgentRuntimeEventSink,
  type AgentRuntimeSubmissionRequest,
  type AgentRuntimeSubmissionResult,
  type PreparedAgentRuntime,
  type RuntimeProfileSnapshot,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeRouter from '@deepseek-ai/dsh-agent-runtime-router'
import LlmRuntime, { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

const capabilities = snapshotAgentRuntimeCapabilities([
  { id: 'continuation' },
  { id: 'queuedInputRead' },
])

function message(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

class FakeDriver implements AgentDriver {
  readonly inbox: Inbox
  readonly sent: UserMessage[] = []
  readonly status: AgentStatus = 'idle'

  constructor(session: Agent['session']) {
    this.inbox = new Inbox(session, {
      inserted() {},
      discarded() {},
      claimed() {},
    })
  }

  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {}

  whenIdle(): Promise<void> {
    return Promise.resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  send(value: UserMessage, _target: InboxTarget, _wakeup: boolean): void {
    this.sent.push(value)
  }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly id = AgentRuntimeProviderId('fake')
  profileSnapshotVersions = [0]
  readonly drivers: FakeDriver[] = []
  disposeCalls = 0
  prepareStarted?: () => void
  prepareGate?: Promise<void>
  ignorePrepareAbort = false
  disposeGate?: Promise<void>
  disposeError?: Error
  request?: AgentRuntimePrepareRequest
  runtimeIdOverride?: PreparedAgentRuntime['runtimeId']
  factsProviderOverride?: AgentRuntimeProvider['id']
  omitDriver = false

  probe(_request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    return Promise.resolve({
      capabilities,
      permissionEnforcement: 'enforced',
    })
  }

  async prepare(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    this.request = request
    this.prepareStarted?.()
    if (this.prepareGate !== undefined) {
      if (this.ignorePrepareAbort) {
        await this.prepareGate
      } else {
        await Promise.race([
          this.prepareGate,
          new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              reject(request.signal.reason instanceof Error
                ? request.signal.reason
                : new Error('preparation aborted', { cause: request.signal.reason }))
            }, {
              once: true,
            })
          }),
        ])
      }
    }
    const agent = request.agentCtx.agent
    if (agent === undefined) throw new Error('missing Router Agent')
    const driver = new FakeDriver(agent.session)
    this.drivers.push(driver)
    return {
      runtimeId: this.runtimeIdOverride ?? request.runtimeId,
      capabilities,
      initialFacts: snapshotAgentRuntimeFacts({
        runtimeId: request.runtimeId,
        providerId: this.factsProviderOverride ?? this.id,
        capabilities,
        phase: 'ready',
      }),
      ...this.omitDriver ? {} : { agentDriver: driver },
      submit(_submission: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult> {
        return Promise.resolve({ reason: { kind: 'completed' } })
      },
      cancel(_submissionId: SubmissionId, _cause: AgentCancelCause): void {},
      dispose: async () => {
        this.disposeCalls += 1
        await this.disposeGate
        if (this.disposeError !== undefined) throw this.disposeError
      },
    }
  }
}

class FailingSynchronousProvider extends FakeProvider {
  prepareSync(request: AgentRuntimePrepareRequest): PreparedAgentRuntime {
    const agent = request.agentCtx.agent
    if (agent === undefined) throw new Error('missing Router Agent')
    const scope = Reflect.get(agent, 'scope') as { dispose(): Promise<void> }
    vi.spyOn(scope, 'dispose').mockRejectedValueOnce(new Error('rollback scope failure'))
    return {
      runtimeId: request.runtimeId,
      capabilities,
      initialFacts: snapshotAgentRuntimeFacts({
        runtimeId: request.runtimeId,
        providerId: this.id,
        capabilities,
        phase: 'ready',
      }),
      submit: () => Promise.resolve({ reason: { kind: 'completed' } }),
      cancel() {},
      dispose: () => Promise.resolve(),
    }
  }
}

async function harness(provider: FakeProvider): Promise<{
  ctx: Context
  providerFiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentRuntimeRegistry)
  await ctx.plugin(AgentRuntimeRouter, { provider: provider.id })
  const providerFiber = ctx.plugin(Object.assign((inner: Context) => {
    inner.agentRuntimes.registerProvider(provider)
  }, { inject: ['agentRuntimes'] }))
  await providerFiber
  return { ctx, providerFiber }
}

async function preRegisteredHarness(provider: FakeProvider): Promise<{
  ctx: Context
  providerFiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentRuntimeRegistry)
  const providerFiber = ctx.plugin(Object.assign((inner: Context) => {
    inner.agentRuntimes.registerProvider(provider)
  }, { inject: ['agentRuntimes'] }))
  await providerFiber
  await ctx.plugin(AgentRuntimeRouter, { provider: provider.id })
  return { ctx, providerFiber }
}

describe('AgentRuntimeRouter', () => {
  it('keeps waking submission closed through synchronous publication', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const failures: unknown[] = []
    ctx.on('session/created', (session) => {
      try {
        ctx.agents.get(session.id)?.followup(message('too early'))
      } catch (error: unknown) {
        failures.push(error)
      }
    })
    ctx.on('agent/created', ({ agent }) => {
      try {
        agent.followup(message('still too early'))
      } catch (error: unknown) {
        failures.push(error)
      }
    })

    const handle = await ctx.agents.create({ sessionId: SessionId('publication') })
    expect(failures).toHaveLength(2)
    expect(failures).toEqual([
      expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'publication' }),
      expect.objectContaining({ code: 'SUBMISSION_REJECTED', phase: 'publication' }),
    ])
    handle.agent.followup(message('accepted'))
    expect(provider.drivers[0]?.sent).toHaveLength(1)

    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rolls back both registries and permanently closes admission after publication failure', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    let observed: Agent | undefined
    ctx.on('session/created', (session) => {
      observed = ctx.agents.get(session.id)
      throw new Error('publication failed')
    })

    await expect(ctx.agents.create({ sessionId: SessionId('rollback') }))
      .rejects.toThrow('publication failed')
    expect(ctx.agents.get(SessionId('rollback'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('rollback'))).toBeUndefined()
    expect(provider.disposeCalls).toBe(1)
    expect(() => { observed?.followup(message('rejected')) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED' }))

    await ctx.fiber.dispose()
  })

  it('aborts asynchronous preparation when its Provider generation is removed', async () => {
    const provider = new FakeProvider()
    const started = Promise.withResolvers<undefined>()
    provider.prepareStarted = () => { started.resolve(undefined) }
    provider.prepareGate = new Promise(() => {})
    const { ctx, providerFiber } = await harness(provider)
    const creating = ctx.agents.create({ sessionId: SessionId('provider-removal') })
    await started.promise

    await providerFiber.dispose()
    await expect(creating).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'prepare',
      providerId: provider.id,
    })
    expect(ctx.agents.get(SessionId('provider-removal'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('provider-removal'))).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('closes live admission on Provider removal and accepts a replacement generation', async () => {
    const original = new FakeProvider()
    const { ctx, providerFiber } = await harness(original)
    const first = await ctx.agents.create({ sessionId: SessionId('first-generation') })

    await providerFiber.dispose()
    expect(() => { first.agent.followup(message('closed')) })
      .toThrow(expect.objectContaining({ code: 'SUBMISSION_REJECTED' }))
    await expect.poll(() => original.disposeCalls).toBe(1)
    expect(ctx.agents.get(first.agent.id)).toBeUndefined()

    const replacement = new FakeProvider()
    const replacementFiber = ctx.plugin(Object.assign((inner: Context) => {
      inner.agentRuntimes.registerProvider(replacement)
    }, { inject: ['agentRuntimes'] }))
    await replacementFiber
    const second = await ctx.agents.create({ sessionId: SessionId('second-generation') })
    second.agent.followup(message('accepted'))
    expect(replacement.drivers[0]?.sent).toHaveLength(1)

    await second.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps owner disposal pending until runtime teardown is quiescent', async () => {
    const provider = new FakeProvider()
    const release = Promise.withResolvers<undefined>()
    provider.disposeGate = release.promise
    const { ctx } = await harness(provider)
    let creating!: ReturnType<typeof ctx.agents.create>
    const owner = ctx.plugin(Object.assign((inner: Context) => {
      creating = inner.agents.create({ sessionId: SessionId('owner') })
    }, { inject: ['agents'] }))
    await owner
    const handle = await creating

    let settled = false
    const disposing = owner.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(ctx.agents.get(handle.agent.id)).toBe(handle.agent)
    release.resolve(undefined)
    await disposing
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
    await handle.dispose()

    await ctx.fiber.dispose()
  })

  it('detaches both registries when runtime disposal fails', async () => {
    const provider = new FakeProvider()
    provider.disposeError = new Error('provider dispose failed')
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('dispose-failure') })

    await expect(handle.dispose()).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
      phase: 'dispose',
      providerId: provider.id,
    })
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'DISPOSE_FAILED' })

    await ctx.fiber.dispose()
  })

  it('validates Router configuration, Provider presence, and profile versions', async () => {
    expect(() => new AgentRuntimeRouter(new Context(), { provider: ' ' }))
      .toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentRuntimeRegistry)
    await ctx.plugin(AgentRuntimeRouter, { provider: 'missing' })
    await expect(ctx.agents.create({ sessionId: SessionId('missing') }))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(() => ctx.agentRuntimeRouter.createNative(
      ctx,
      SessionId('missing-sync'),
    )).toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('missing-persistence') }))
      .rejects.toThrow('session persistence is not configured')
    await ctx.fiber.dispose()

    const provider = new FakeProvider()
    provider.profileSnapshotVersions = [1]
    const incompatible = await harness(provider)
    await expect(incompatible.ctx.agents.create({ sessionId: SessionId('profile-version') }))
      .rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE', phase: 'profile' })
    await incompatible.ctx.fiber.dispose()
  })

  it('snapshots Native options and rejects malformed prepared handles', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId('profile-options'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'llm-provider', model: 'model', maxTokens: 123 },
    })
    const profile = provider.request?.profile as RuntimeProfileSnapshot
    expect(profile.provider.options).toEqual({ llmProvider: 'llm-provider', maxTokens: 123 })
    expect(profile.launch.cwd).toEqual({ kind: 'fixed', path: '/workspace' })
    expect(profile.model.default).toBe('model')
    await handle.dispose()
    await ctx.fiber.dispose()

    const badRuntime = new FakeProvider()
    badRuntime.runtimeIdOverride = AgentRuntimeId('wrong-runtime')
    const mismatched = await harness(badRuntime)
    await expect(mismatched.ctx.agents.create({ sessionId: SessionId('bad-runtime') }))
      .rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })
    await mismatched.ctx.fiber.dispose()

    const badFacts = new FakeProvider()
    badFacts.factsProviderOverride = AgentRuntimeProviderId('other')
    const factsMismatch = await harness(badFacts)
    await expect(factsMismatch.ctx.agents.create({ sessionId: SessionId('bad-facts') }))
      .rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })
    await factsMismatch.ctx.fiber.dispose()

    const missingDriver = new FakeProvider()
    missingDriver.omitDriver = true
    missingDriver.disposeError = new Error('rollback also failed')
    const incompatibleDriver = await harness(missingDriver)
    await expect(incompatibleDriver.ctx.agents.create({ sessionId: SessionId('missing-driver') }))
      .rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })
    await incompatibleDriver.ctx.fiber.dispose()
  })

  it('closes and validates the Provider event sink', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('sink') })
    const sink = provider.request?.sink as AgentRuntimeEventSink
    const facts = provider.request === undefined
      ? undefined
      : snapshotAgentRuntimeFacts({
        runtimeId: provider.request.runtimeId,
        providerId: provider.id,
        capabilities,
        phase: 'ready',
      })
    expect(() => { sink.facts(facts!) }).not.toThrow()
    expect(() => {
      sink.facts(snapshotAgentRuntimeFacts({
        ...facts!,
        providerId: AgentRuntimeProviderId('wrong'),
      }))
    }).toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    expect(() => { sink.assistantChunk(SubmissionId('submission'), {} as never) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    expect(() => { sink.assistantMessage(SubmissionId('submission'), {} as never) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    expect(() => { sink.activity({} as never) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    await handle.dispose()
    expect(() => { sink.facts(facts!) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_FAILED', phase: 'dispose' }))
    await ctx.fiber.dispose()
  })

  it('rejects caller cancellation before and during setup', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const preAborted = new AbortController()
    preAborted.abort('cancelled')
    await expect(ctx.agents.create({
      sessionId: SessionId('pre-aborted'),
      signal: preAborted.signal,
    })).rejects.toThrow('creation aborted')

    const setupStarted = Promise.withResolvers<undefined>()
    const setupGate = Promise.withResolvers<undefined>()
    const duringSetup = new AbortController()
    const creating = ctx.agents.create({
      sessionId: SessionId('setup-abort'),
      signal: duringSetup.signal,
      setup: async () => {
        setupStarted.resolve(undefined)
        await setupGate.promise
      },
    })
    await setupStarted.promise
    duringSetup.abort(new Error('setup cancelled'))
    setupGate.resolve(undefined)
    await expect(creating).rejects.toThrow('setup cancelled')
    await ctx.fiber.dispose()
  })

  it('releases a prepared handle that arrives after Provider cancellation', async () => {
    const provider = new FakeProvider()
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    provider.prepareStarted = () => { started.resolve(undefined) }
    provider.prepareGate = release.promise
    provider.ignorePrepareAbort = true
    const { ctx, providerFiber } = await harness(provider)
    const creating = ctx.agents.create({ sessionId: SessionId('abandoned-runtime') })
    await started.promise
    await providerFiber.dispose()
    release.resolve(undefined)
    await expect(creating).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await expect.poll(() => provider.disposeCalls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('handles Providers registered before the Router observes an add event', async () => {
    const unused = new FakeProvider()
    const first = await preRegisteredHarness(unused)
    await first.providerFiber.dispose()
    await first.ctx.fiber.dispose()

    const provider = new FakeProvider()
    const { ctx } = await preRegisteredHarness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('pre-registered') })
    expect(handle.agent.id).toBe(SessionId('pre-registered'))
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects synchronous creation through an asynchronous Provider', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    expect(() => ctx.agentRuntimeRouter.createNative(ctx, SessionId('async-native')))
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    await ctx.fiber.dispose()
  })

  it('reports scope cleanup failure and rejects new work after Router teardown', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId('scope-dispose-failure'),
    })
    const scope = Reflect.get(handle.agent, 'scope') as { dispose(): Promise<void> }
    vi.spyOn(scope, 'dispose').mockRejectedValueOnce(new Error('scope cleanup failed'))
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'DISPOSE_FAILED' })
    const { agentRuntimeRouter } = ctx
    await ctx.fiber.dispose()
    expect(() => { agentRuntimeRouter.assertActive() })
      .toThrow('agent runtime Router is not active')
  })

  it('settles Provider removal cleanup failures without leaking the lifecycle', async () => {
    const provider = new FakeProvider()
    provider.disposeError = new Error('provider removal cleanup failed')
    const { ctx, providerFiber } = await harness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('provider-cleanup-failure') })
    await providerFiber.dispose()
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'DISPOSE_FAILED' })
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('cleans up when caller ownership registration fails before Agent creation', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const owner = await ctx.plugin(() => {})
    vi.spyOn(owner.ctx, 'effect').mockImplementationOnce(() => {
      throw new Error('owner effect failed')
    })
    await expect(ctx.agentRuntimeRouter.createAgent(owner.ctx, {
      sessionId: SessionId('owner-effect-failure'),
    })).rejects.toThrow('owner effect failed')
    await owner.dispose()
    await ctx.fiber.dispose()
  })

  it('logs asynchronous rollback cleanup failure for synchronous creation', async () => {
    const provider = new FailingSynchronousProvider()
    const { ctx } = await harness(provider)
    expect(() => ctx.agentRuntimeRouter.createNative(ctx, SessionId('sync-rollback-failure')))
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    await expect.poll(() => ctx.sessions.get(SessionId('sync-rollback-failure'))).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
