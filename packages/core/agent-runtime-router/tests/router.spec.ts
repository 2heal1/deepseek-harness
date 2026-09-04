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
  AgentRuntimeError,
  AgentRuntimeId,
  AgentRuntimeProviderId,
  ExternalSessionId,
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
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import AgentRuntimeRouter from '@deepseek-ai/dsh-agent-runtime-router'
import LlmRuntime, { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
  SessionPreparation,
  type JsonValue,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

const capabilities = snapshotAgentRuntimeCapabilities([
  { id: 'continuation' },
  { id: 'queuedInputRead' },
])

function profileConfig(provider: string) {
  return {
    defaultMainProfile: 'test',
    profiles: {
      test: {
        provider,
        launch: {
          executable: process.execPath,
          resolution: 'absolute' as const,
          cwdPolicy: 'session-workspace' as const,
        },
        model: { allowSessionOverride: true },
        product: { kind: 'test' },
        permissions: {
          policy: { kind: 'test' },
          enforcement: 'required' as const,
        },
        process: {
          startupTimeoutMs: 1_000,
          turnTimeoutMs: 1_000,
          shutdownTimeoutMs: 1_000,
          terminationTimeoutMs: 1_000,
          maxConcurrentRuns: 8,
        },
      },
    },
  }
}

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
  readonly submissionRequests: AgentRuntimeSubmissionRequest[] = []
  readonly cancelCalls: Array<[SubmissionId, AgentCancelCause]> = []
  disposeCalls = 0
  prepareStarted?: () => void
  prepareGate?: Promise<void>
  ignorePrepareAbort = false
  disposeGate?: Promise<void>
  disposeError?: Error
  request?: AgentRuntimePrepareRequest
  runtimeIdOverride?: PreparedAgentRuntime['runtimeId']
  factsProviderOverride?: AgentRuntimeProvider['id']
  externalSessionIdOverride?: ReturnType<typeof ExternalSessionId>
  omitDriver = false
  capabilitiesOverride = capabilities
  submitHandler?: (
    request: AgentRuntimeSubmissionRequest,
  ) => Promise<AgentRuntimeSubmissionResult>
  disposeHandler?: () => void

  probe(_request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    return Promise.resolve({
      capabilities: this.capabilitiesOverride,
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
      capabilities: this.capabilitiesOverride,
      initialFacts: snapshotAgentRuntimeFacts({
        runtimeId: request.runtimeId,
        providerId: this.factsProviderOverride ?? this.id,
        capabilities: this.capabilitiesOverride,
        phase: 'ready',
        ...this.externalSessionIdOverride === undefined
          ? {}
          : { externalSessionId: this.externalSessionIdOverride },
      }),
      ...this.omitDriver ? {} : { agentDriver: driver },
      submit: (submission: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult> => {
        this.submissionRequests.push(submission)
        return this.submitHandler?.(submission)
          ?? Promise.resolve({ reason: { kind: 'completed' } })
      },
      cancel: (submissionId: SubmissionId, cause: AgentCancelCause): void => {
        this.cancelCalls.push([submissionId, cause])
      },
      dispose: async () => {
        this.disposeCalls += 1
        this.disposeHandler?.()
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
      runtimeId: AgentRuntimeId('wrong-runtime'),
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
  await ctx.plugin(AgentRuntimeProfiles, profileConfig(provider.id))
  await ctx.plugin(AgentRuntimeRouter, {})
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
  await ctx.plugin(AgentRuntimeProfiles, profileConfig(provider.id))
  const providerFiber = ctx.plugin(Object.assign((inner: Context) => {
    inner.agentRuntimes.registerProvider(provider)
  }, { inject: ['agentRuntimes'] }))
  await providerFiber
  await ctx.plugin(AgentRuntimeRouter, {})
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

  it('validates Provider presence and profile versions', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentRuntimeRegistry)
    await ctx.plugin(AgentRuntimeProfiles, profileConfig('missing'))
    await ctx.plugin(AgentRuntimeRouter, {})
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

  it('resolves profile overrides and rejects malformed prepared handles', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId('profile-options'),
      meta: { cwd: '/workspace' },
      agentOptions: { model: 'model' },
    })
    const profile = provider.request?.profile as RuntimeProfileSnapshot
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

    const external = new FakeProvider()
    external.omitDriver = true
    const externalRuntime = await harness(external)
    await expect(externalRuntime.ctx.agents.create({ sessionId: SessionId('external-runtime') }))
      .resolves.toMatchObject({ agent: { id: 'external-runtime' } })
    await externalRuntime.ctx.fiber.dispose()
  })

  it('resumes only from the stored profile snapshot and rejects conflicting overrides', async () => {
    const provider = new FakeProvider()
    provider.externalSessionIdOverride = ExternalSessionId('external-session')
    provider.capabilitiesOverride = snapshotAgentRuntimeCapabilities([
      { id: 'resume' },
    ])
    const { ctx } = await harness(provider)
    const original = await ctx.agents.create({
      sessionId: SessionId('snapshot-resume'),
      agentOptions: {
        model: 'stored-model',
      },
    })
    const originalHeader = structuredClone(original.agent.session.header)
    const profile = originalHeader.runtimeProfile as unknown as RuntimeProfileSnapshot
    const header: SessionHeader = {
      ...originalHeader,
      runtimeProfile: {
        ...profile,
        provider: {
          ...profile.provider,
          options: { llmProvider: 'stored-provider', maxTokens: 321 },
        },
      } as unknown as JsonValue,
    }
    const events = structuredClone(original.agent.session.events)
    await original.dispose()
    ctx.provide('sessionPersistence', {
      listSnapshots: () => Promise.resolve([{ header, revision: 'revision-1' }]),
      prepare: (id: SessionId) => SessionPreparation.create(
        Session.fromRestore(id, structuredClone(events), structuredClone(header)),
      ),
    } as never)
    const resolve = vi.spyOn(ctx.agentRuntimeProfiles, 'resolve')
      .mockImplementation(() => { throw new Error('current Settings must not be read') })

    const resumed = await ctx.agents.resume({
      resumeSessionId: SessionId('snapshot-resume'),
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(provider.request).toMatchObject({
      kind: 'resume',
      profile: header.runtimeProfile,
      externalSessionId: 'external-session',
    })
    expect(resumed.agent.options).toEqual({
      runtimeProfile: 'test',
      provider: 'stored-provider',
      model: 'stored-model',
      maxTokens: 321,
    })
    await resumed.dispose()

    await expect(ctx.agents.resume({
      resumeSessionId: SessionId('snapshot-resume'),
      agentOptions: { model: 'current-model' },
    })).rejects.toMatchObject({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'resume',
    })
    await ctx.fiber.dispose()
  })

  it('rejects a Runtime Profile snapshot changed during persistence loading', async () => {
    const provider = new FakeProvider()
    provider.capabilitiesOverride = snapshotAgentRuntimeCapabilities([
      { id: 'resume' },
    ])
    const { ctx } = await harness(provider)
    const original = await ctx.agents.create({
      sessionId: SessionId('snapshot-race'),
    })
    const header = structuredClone(original.agent.session.header)
    const events = structuredClone(original.agent.session.events)
    await original.dispose()
    const profile = header.runtimeProfile as unknown as RuntimeProfileSnapshot
    const changedProfile = {
      ...profile,
      model: { ...profile.model, default: 'changed-during-load' },
    }
    ctx.provide('sessionPersistence', {
      listSnapshots: () => Promise.resolve([{ header, revision: 'revision-1' }]),
      prepare: (id: SessionId) => SessionPreparation.create(
        Session.fromRestore(id, structuredClone(events), {
          ...structuredClone(header),
          runtimeProfile: changedProfile as unknown as JsonValue,
        }),
      ),
    } as never)

    await expect(ctx.agents.resume({
      resumeSessionId: SessionId('snapshot-race'),
    })).rejects.toMatchObject({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'resume',
      message: expect.stringContaining('changed while') as unknown,
    })
    await ctx.fiber.dispose()
  })

  it('restores from the prepared Header when snapshot listing has no matching row', async () => {
    const provider = new FakeProvider()
    provider.capabilitiesOverride = snapshotAgentRuntimeCapabilities([
      { id: 'resume' },
    ])
    const { ctx } = await harness(provider)
    const original = await ctx.agents.create({
      sessionId: SessionId('snapshot-list-miss'),
    })
    const originalHeader = structuredClone(original.agent.session.header)
    const profile = originalHeader.runtimeProfile as unknown as RuntimeProfileSnapshot
    const header: SessionHeader = {
      ...originalHeader,
      runtimeProfile: {
        ...profile,
        provider: { ...profile.provider, options: null },
      } as unknown as JsonValue,
    }
    const events = structuredClone(original.agent.session.events)
    await original.dispose()
    ctx.provide('sessionPersistence', {
      listSnapshots: () => Promise.resolve([]),
      prepare: (id: SessionId) => SessionPreparation.create(
        Session.fromRestore(id, structuredClone(events), structuredClone(header)),
      ),
    } as never)

    const resumed = await ctx.agents.resume({
      resumeSessionId: SessionId('snapshot-list-miss'),
    })
    expect(provider.request).toMatchObject({
      kind: 'resume',
      profile: header.runtimeProfile,
    })
    expect(resumed.agent.options).toEqual({ runtimeProfile: 'test' })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes a prepared Session that arrives after resume cancellation', async () => {
    const provider = new FakeProvider()
    provider.capabilitiesOverride = snapshotAgentRuntimeCapabilities([
      { id: 'resume' },
    ])
    const { ctx } = await harness(provider)
    const original = await ctx.agents.create({
      sessionId: SessionId('snapshot-abandoned-prepare'),
    })
    const header = structuredClone(original.agent.session.header)
    const events = structuredClone(original.agent.session.events)
    await original.dispose()
    const preparation = SessionPreparation.create(
      Session.fromRestore(
        SessionId('snapshot-abandoned-prepare'),
        structuredClone(events),
        structuredClone(header),
      ),
    )
    const dispose = vi.spyOn(preparation, Symbol.dispose)
    const release = Promise.withResolvers<SessionPreparation>()
    const prepareStarted = Promise.withResolvers<undefined>()
    ctx.provide('sessionPersistence', {
      listSnapshots: () => Promise.resolve([{ header, revision: 'revision-1' }]),
      prepare: () => {
        prepareStarted.resolve(undefined)
        return release.promise
      },
    } as never)
    const abort = new AbortController()
    const resumed = ctx.agents.resume({
      resumeSessionId: SessionId('snapshot-abandoned-prepare'),
      signal: abort.signal,
    })
    await prepareStarted.promise
    abort.abort(new Error('resume cancelled'))
    await expect(resumed).rejects.toThrow('resume cancelled')
    release.resolve(preparation)
    await expect.poll(() => dispose.mock.calls.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects resume when the prepared runtime omits the resume capability', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const created = await ctx.agents.create({
      sessionId: SessionId('resume-unsupported'),
    })
    const header = structuredClone(created.agent.session.header)
    const events = structuredClone(created.agent.session.events)
    await created.dispose()
    ctx.provide('sessionPersistence', {
      listSnapshots: () => Promise.resolve([{ header, revision: 'revision-1' }]),
      prepare: (id: SessionId) => SessionPreparation.create(
        Session.fromRestore(id, structuredClone(events), structuredClone(header)),
      ),
    } as never)

    await expect(ctx.agents.resume({
      resumeSessionId: SessionId('resume-unsupported'),
    })).rejects.toMatchObject({
      code: 'RESUME_UNSUPPORTED',
      phase: 'resume',
    })
    expect(ctx.agents.get(SessionId('resume-unsupported'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forks the stored snapshot but replaces runtime facts and identity', async () => {
    const provider = new FakeProvider()
    const { ctx } = await harness(provider)
    const parent = await ctx.agents.create({
      sessionId: SessionId('snapshot-parent'),
      agentOptions: { model: 'pinned-model' },
    })
    parent.agent.session.append('turn/start', { turn: 1 })
    parent.agent.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    })
    const original = parent.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })
    parent.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })
    const parentFacts = parent.agent.session.events.find(
      event => event.type === 'agent/runtime/facts',
    )
    if (parentFacts === undefined) throw new Error('missing parent runtime facts')
    const runtimeProfile = parent.agent.session.header.runtimeProfile
    if (runtimeProfile === undefined) throw new Error('missing Runtime Profile snapshot')
    const child = await ctx.agents.create({
      sessionId: SessionId('snapshot-child'),
      seed: parent.agent.session.events,
      meta: {
        parentSession: parent.agent.id,
        runtimeProfile,
      },
    })

    expect(child.agent.session.header.runtimeProfile)
      .toEqual(parent.agent.session.header.runtimeProfile)
    expect(child.agent.session.header.runtimeProfile)
      .not.toBe(parent.agent.session.header.runtimeProfile)
    expect(child.agent.session.header.seedLength).toBe(
      parent.agent.session.events.length - 1,
    )
    expect(child.agent.session.events.find(
      event => event.type === 'user/message' && event.sourceEventSeqs !== undefined,
    )).toMatchObject({
      seq: 3,
      sourceEventSeqs: [2],
      surfaceOp: { op: 'replace', start: 2, end: 2 },
    })
    const childFacts = child.agent.session.events.filter(
      event => event.type === 'agent/runtime/facts',
    )
    expect(childFacts).toHaveLength(1)
    expect(childFacts[0]?.data.runtimeId).not.toBe(parentFacts?.data.runtimeId)
    expect(child.agent.options).toMatchObject({
      runtimeProfile: 'test',
      model: 'pinned-model',
    })

    const invalidSeed = structuredClone(parent.agent.session.events)
    const invalidReference = invalidSeed.find(
      event => event.type === 'user/message' && event.sourceEventSeqs !== undefined,
    )
    if (invalidReference === undefined) throw new Error('missing reference fixture')
    Reflect.set(invalidReference, 'sourceEventSeqs', [parentFacts.seq])
    await expect(ctx.agents.create({
      sessionId: SessionId('snapshot-invalid-child'),
      seed: invalidSeed,
      meta: {
        parentSession: parent.agent.id,
        runtimeProfile,
      },
    })).rejects.toMatchObject({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'profile',
    })

    const unexpected = new Error('unexpected fork projection failure')
    const throwingSeed = structuredClone(parent.agent.session.events)
    vi.spyOn(throwingSeed, 'filter').mockImplementationOnce(() => {
      throw unexpected
    })
    await expect(ctx.agents.create({
      sessionId: SessionId('snapshot-broken-child'),
      seed: throwingSeed,
      meta: {
        parentSession: parent.agent.id,
        runtimeProfile,
      },
    })).rejects.toBe(unexpected)

    await child.dispose()
    await parent.dispose()
    await ctx.fiber.dispose()
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
      .toThrow(expect.objectContaining({ code: 'RUNTIME_FAILED' }))
    expect(() => { sink.assistantMessage(SubmissionId('submission'), {} as never) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_FAILED' }))
    expect(() => { sink.activity({} as never) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    await handle.dispose()
    expect(() => { sink.facts(facts!) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_FAILED', phase: 'dispose' }))
    await ctx.fiber.dispose()
  })

  it('persists serial external submission receipts, provenance, and activity', async () => {
    const provider = new FakeProvider()
    provider.omitDriver = true
    provider.capabilitiesOverride = snapshotAgentRuntimeCapabilities([
      { id: 'runtimeActivity' },
    ])
    const gates = [
      Promise.withResolvers<AgentRuntimeSubmissionResult>(),
      Promise.withResolvers<AgentRuntimeSubmissionResult>(),
    ]
    provider.submitHandler = () => gates[provider.submissionRequests.length - 1]!.promise
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('external-receipts') })
    const first = handle.agent.submit(message('first'))
    let idleResolved = false
    const idle = handle.agent.whenIdle().then(() => { idleResolved = true })
    await Promise.resolve()
    expect(idleResolved).toBe(false)
    expect(handle.agent.status).toBe('running')
    let returned = false
    const accepted = handle.agent.session.events.at(-1)
    returned = true
    expect(returned).toBe(true)
    expect(accepted).toMatchObject({
      type: 'user/message',
      data: { id: first.messageId },
    })
    expect(handle.agent.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent/submission/accepted',
        data: { submissionId: first.id, messageId: first.messageId },
      }),
    ]))

    const second = handle.agent.submit(message('second'))
    expect(provider.submissionRequests).toHaveLength(1)
    expect(handle.agent.cancelSubmission(second.id, { kind: 'user' })).toBe(true)
    expect(await second.started).toMatchObject({
      kind: 'not-started',
      reason: { kind: 'cancelled', cause: { kind: 'user' } },
    })
    expect(await second.settled).toMatchObject({ kind: 'not-started' })

    const request = provider.request
    if (request === undefined) throw new Error('missing Provider request')
    request.sink.assistantChunk(first.id, { kind: 'text-delta', text: 'hello' })
    request.sink.assistantChunk(first.id, { kind: 'reasoning-delta', text: 'thinking' })
    request.sink.assistantChunk(first.id, {
      kind: 'content-block',
      block: { type: 'text', text: 'block' },
    })
    request.sink.assistantMessage(first.id, {
      content: [{ type: 'text', text: 'hello' }],
    })
    request.sink.activity({
      runtimeId: request.runtimeId,
      kind: 'status',
      phase: 'running',
      fidelity: 'complete',
      data: {},
    })
    request.sink.activity({
      runtimeId: request.runtimeId,
      submissionId: first.id,
      kind: 'tool',
      phase: 'completed',
      fidelity: 'complete',
      data: { name: 'external-tool' },
    })
    expect(() => {
      request.sink.activity({
        runtimeId: request.runtimeId,
        kind: 'status',
        phase: 'invalid',
        fidelity: 'partial',
        data: { value: BigInt(1) } as never,
      })
    }).toThrow(/lossless JSON/)
    expect(() => {
      request.sink.activity({
        runtimeId: request.runtimeId,
        kind: 'status',
        phase: 'oversized',
        fidelity: 'partial',
        data: { value: 'x'.repeat(16 * 1024) },
      })
    }).toThrow(/exceeds 16384 UTF-8 bytes/)
    gates[0]!.resolve({ reason: { kind: 'completed' } })

    const started = await first.started
    const settled = await first.settled
    expect(started).toMatchObject({ kind: 'started', turn: 1 })
    expect(settled).toMatchObject({ kind: 'settled', turn: 1 })
    const events = handle.agent.session.events
    expect(events.map(event => event.type)).toEqual([
      'agent/runtime/facts',
      'agent/submission/accepted',
      'turn/start',
      'agent/submission/started',
      'user/message',
      'agent/submission/accepted',
      'agent/submission/settled',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'agent/runtime/activity',
      'agent/runtime/activity',
      'turn/end',
      'agent/submission/settled',
    ])
    expect(events[started.eventSeq]).toMatchObject({
      type: 'agent/submission/started',
      data: { submissionId: first.id, messageId: first.messageId, turn: 1 },
    })
    expect(events[settled.eventSeq]).toMatchObject({
      type: 'agent/submission/settled',
      data: {
        submissionId: first.id,
        messageId: first.messageId,
        settlement: { kind: 'settled', turn: 1, reason: { kind: 'completed' } },
      },
    })
    expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
      data: {
        turn: 1,
        provenance: {
          kind: 'runtime',
          provider: provider.id,
          source: 'protocol',
          submissionId: first.id,
        },
        message: {
          source: { kind: 'runtime', provider: provider.id, source: 'protocol' },
        },
      },
    })
    expect(handle.agent.status).toBe('idle')
    await idle
    expect(idleResolved).toBe(true)

    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('settles submissions rejected before and after a turn starts', async () => {
    const nativeProvider = new FakeProvider()
    const native = await harness(nativeProvider)
    const nativeHandle = await native.ctx.agents.create({
      sessionId: SessionId('native-rejected-submission'),
    })
    const notStarted = nativeHandle.agent.submit(message('native'))
    await expect(notStarted.started).resolves.toMatchObject({
      kind: 'not-started',
      reason: {
        kind: 'rejected',
        failure: {
          code: 'RUNTIME_FAILED',
          message: 'runtime settled a submission before opening its turn',
        },
      },
    })
    await expect(notStarted.settled).resolves.toMatchObject({ kind: 'not-started' })

    nativeProvider.submitHandler = () => Promise.reject(new Error('native failed'))
    const failedBeforeStart = nativeHandle.agent.submit(message('native failure'))
    await expect(failedBeforeStart.settled).resolves.toMatchObject({
      kind: 'not-started',
      reason: {
        kind: 'rejected',
        failure: { phase: 'submission', message: 'native failed' },
      },
    })

    // A Provider is an asynchronous extension boundary and may reject with a non-Error value.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    nativeProvider.submitHandler = () => Promise.reject('raw provider failure')
    const rawFailure = nativeHandle.agent.submit(message('raw failure'))
    await expect(rawFailure.settled).resolves.toMatchObject({
      kind: 'not-started',
      reason: {
        kind: 'rejected',
        failure: { message: 'raw provider failure' },
      },
    })
    await nativeHandle.dispose()
    await native.ctx.fiber.dispose()

    const externalProvider = new FakeProvider()
    externalProvider.omitDriver = true
    externalProvider.submitHandler = (request) => {
      request.started(1)
      throw new AgentRuntimeError({
        code: 'RUNTIME_UNAVAILABLE',
        phase: 'turn',
        message: 'provider unavailable',
      })
    }
    const external = await harness(externalProvider)
    const externalHandle = await external.ctx.agents.create({
      sessionId: SessionId('external-failed-submission'),
    })
    const failed = externalHandle.agent.submit(message('external'))
    await expect(failed.settled).resolves.toMatchObject({
      kind: 'settled',
      reason: {
        kind: 'error',
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'provider unavailable' },
      },
    })
    await externalHandle.dispose()
    await external.ctx.fiber.dispose()
  })

  it('rejects runtime activity without capability and output after settlement', async () => {
    const provider = new FakeProvider()
    provider.omitDriver = true
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId('external-invalid-output'),
    })
    const request = provider.request
    if (request === undefined) throw new Error('missing Provider request')
    expect(() => {
      request.sink.activity({
        runtimeId: request.runtimeId,
        kind: 'status',
        phase: 'ready',
        fidelity: 'complete',
        data: {},
      })
    }).toThrow(expect.objectContaining({ code: 'AGENT_CAPABILITY_UNSUPPORTED' }))

    const receipt = handle.agent.submit(message('done'))
    await receipt.settled
    expect(() => {
      request.sink.assistantChunk(receipt.id, {
        kind: 'text-delta',
        text: 'late',
      })
    }).toThrow(/does not belong to an open submission/)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('targets started cancellation once', async () => {
    const provider = new FakeProvider()
    provider.omitDriver = true
    const pending = new Map<SubmissionId, PromiseWithResolvers<AgentRuntimeSubmissionResult>>()
    provider.submitHandler = (request) => {
      const gate = Promise.withResolvers<AgentRuntimeSubmissionResult>()
      pending.set(request.submissionId, gate)
      return gate.promise
    }
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('cancel-receipt') })
    const receipt = handle.agent.submit(message('work'))
    await receipt.started
    handle.agent.cancel({ kind: 'user' })
    expect(handle.agent.cancelSubmission(receipt.id, { kind: 'user' })).toBe(false)
    expect(provider.cancelCalls).toEqual([
      [receipt.id, { kind: 'user' }],
    ])
    pending.get(receipt.id)?.resolve({
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    await expect(receipt.settled).resolves.toMatchObject({
      kind: 'settled',
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(handle.agent.cancelSubmission(receipt.id, { kind: 'user' })).toBe(false)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('waits for durable receipt settlement during disposal', async () => {
    const provider = new FakeProvider()
    provider.omitDriver = true
    const pending = new Map<SubmissionId, PromiseWithResolvers<AgentRuntimeSubmissionResult>>()
    provider.submitHandler = (request) => {
      const gate = Promise.withResolvers<AgentRuntimeSubmissionResult>()
      pending.set(request.submissionId, gate)
      return gate.promise
    }
    provider.disposeHandler = () => {
      for (const gate of pending.values()) {
        gate.resolve({
          reason: { kind: 'aborted', reason: { kind: 'disposed' } },
        })
      }
    }
    const { ctx } = await harness(provider)
    const handle = await ctx.agents.create({ sessionId: SessionId('dispose-receipt') })
    const receipt = handle.agent.submit(message('work'))
    await receipt.started
    const disposing = handle.dispose()
    const settlement = await receipt.settled
    await disposing
    expect(settlement).toMatchObject({
      kind: 'settled',
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'disposed' } },
    })
    expect(handle.agent.session.events[settlement.eventSeq]).toMatchObject({
      type: 'agent/submission/settled',
      data: { submissionId: receipt.id },
    })
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
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

  it('reports runtime cleanup failure without replacing the setup failure', async () => {
    const provider = new FakeProvider()
    provider.disposeError = new Error('rollback cleanup failed')
    const { ctx } = await harness(provider)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await expect(ctx.agents.create({
      sessionId: SessionId('setup-rollback-failure'),
      setup: () => {
        throw new Error('setup failed')
      },
    })).rejects.toThrow('setup failed')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rollback cleanup failed'))
    expect(ctx.agents.get(SessionId('setup-rollback-failure'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('releases capacity when cancellation or Provider removal wins after admission', async () => {
    const provider = new FakeProvider()
    const { ctx, providerFiber } = await harness(provider)
    const release = vi.fn()
    const cancelled = new AbortController()
    vi.spyOn(ctx.agentRuntimeProfiles, 'acquire').mockImplementationOnce(async () => {
      cancelled.abort('late cancellation')
      return { release }
    })
    await expect(ctx.agents.create({
      sessionId: SessionId('late-cancellation'),
      signal: cancelled.signal,
    })).rejects.toThrow('creation aborted')
    expect(release).toHaveBeenCalledOnce()

    const cancelledWithError = new AbortController()
    vi.spyOn(ctx.agentRuntimeProfiles, 'acquire').mockImplementationOnce(async () => {
      cancelledWithError.abort(new Error('late cancellation error'))
      return { release }
    })
    await expect(ctx.agents.create({
      sessionId: SessionId('late-cancellation-error'),
      signal: cancelledWithError.signal,
    })).rejects.toThrow('late cancellation error')
    expect(release).toHaveBeenCalledTimes(2)

    vi.spyOn(ctx.agentRuntimeProfiles, 'acquire').mockImplementationOnce(async () => {
      await providerFiber.dispose()
      return { release }
    })
    await expect(ctx.agents.create({ sessionId: SessionId('late-provider-removal') }))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(release).toHaveBeenCalledTimes(3)
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
