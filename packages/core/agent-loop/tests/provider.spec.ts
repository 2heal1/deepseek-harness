import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry, {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  type AgentRuntimeEventSink,
  type AgentRuntimePrepareRequest,
  type AgentRuntimeProvider,
  type RuntimeProfileSnapshot,
} from '@deepseek-ai/dsh-agent-runtime'
import { mountNativeTestRuntimeRouter } from './runtime-router.ts'
import AgentLoop, { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const profile = {} as RuntimeProfileSnapshot

const sink: AgentRuntimeEventSink = {
  facts() {},
  assistantChunk() {},
  assistantMessage() {},
  activity() {},
}

async function harness(adapter = new MockAdapter([])): Promise<{
  ctx: Context
  loopFiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentRuntimeRegistry)
  await mountNativeTestRuntimeRouter(ctx)
  const loopFiber = ctx.plugin(AgentLoop, { agents: [] })
  await loopFiber
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, loopFiber }
}

function request(
  agentCtx: Context,
  sessionId: SessionId,
  signal = new AbortController().signal,
): AgentRuntimePrepareRequest {
  return {
    kind: 'create',
    runtimeId: AgentRuntimeId(`runtime-${sessionId}`),
    sessionId,
    profile,
    agentCtx,
    sink,
    signal,
  }
}

function message() {
  return createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  })
}

describe('Native Agent runtime Provider', () => {
  it('probes and validates the unpublished Router Agent identity', async () => {
    const { ctx } = await harness()
    await expect(ctx.agentLoop.probe({
      profile,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      permissionEnforcement: 'enforced',
      protocolVersion: '1',
      productVersion: '0.1.0',
    })
    await expect(ctx.agentLoop.prepare(request(ctx, SessionId('missing-agent'))))
      .rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })

    const handle = await ctx.agents.create({
      sessionId: SessionId('identity'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(() => ctx.agentLoop.prepareSync(request(
      handle.agent.ctx,
      SessionId('wrong-identity'),
    ))).toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects invalid output-token caps at the Provider boundary', async () => {
    const { ctx } = await harness()
    const agentOptions = { provider: 'mock', model: 'mock', maxTokens: 1 }
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-invalid-max-tokens'),
      agentOptions,
    })

    for (const maxTokens of [0, Number.NaN]) {
      agentOptions.maxTokens = maxTokens
      expect(() => ctx.agentLoop.prepareSync(request(handle.agent.ctx, handle.agent.id)))
        .toThrow('agent maxTokens must be a positive safe integer')
    }

    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('runs provider-neutral submissions and memoizes disposal', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('done')]))
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-submit'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const runtime = await ctx.agentLoop.prepare(request(handle.agent.ctx, handle.agent.id))
    const result = await runtime.submit({
      submissionId: SubmissionId('submission'),
      message: message(),
      signal: new AbortController().signal,
      started() {},
    })
    expect(result.reason).toEqual({ kind: 'completed' })
    runtime.cancel(SubmissionId('submission'), { kind: 'user' })
    await runtime.dispose()
    await runtime.dispose()
    await expect(runtime.submit({
      submissionId: SubmissionId('disposed'),
      message: message(),
      signal: new AbortController().signal,
      started() {},
    })).rejects.toMatchObject({ code: 'RUNTIME_FAILED', phase: 'submission' })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects busy work and a submission without a turn result', async () => {
    const { ctx } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-edges'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const maintenanceGate = Promise.withResolvers<undefined>()
    const maintenance = handle.agent.runMaintenance(() => maintenanceGate.promise)
    expect(() => handle.agent.runMaintenance(() => Promise.resolve()))
      .toThrow('already has active work')
    maintenanceGate.resolve(undefined)
    await maintenance
    const busy = ctx.agentLoop.prepareSync(request(handle.agent.ctx, handle.agent.id))
    vi.spyOn(busy.agentDriver!, 'status', 'get').mockReturnValueOnce('running')
    await expect(busy.submit({
      submissionId: SubmissionId('busy'),
      message: message(),
      signal: new AbortController().signal,
      started() {},
    })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    await busy.dispose()

    const empty = ctx.agentLoop.prepareSync(request(handle.agent.ctx, handle.agent.id))
    vi.spyOn(empty.agentDriver!, 'send').mockImplementationOnce(() => {})
    vi.spyOn(empty.agentDriver!, 'whenIdle').mockResolvedValueOnce()
    await expect(empty.submit({
      submissionId: SubmissionId('empty'),
      message: message(),
      signal: new AbortController().signal,
      started() {},
    })).rejects.toMatchObject({ code: 'RUNTIME_FAILED', phase: 'turn' })
    await empty.dispose()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('does not start a submission whose signal is already aborted', async () => {
    const { ctx } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-pre-aborted'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const runtime = ctx.agentLoop.prepareSync(request(handle.agent.ctx, handle.agent.id))
    const send = vi.spyOn(runtime.agentDriver!, 'send')
    const aborted = new AbortController()
    aborted.abort()
    await expect(runtime.submit({
      submissionId: SubmissionId('pre-aborted'),
      message: message(),
      signal: aborted.signal,
      started() {},
    })).resolves.toEqual({
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(send).not.toHaveBeenCalled()
    expect(handle.agent.session.events).not.toContainEqual(
      expect.objectContaining({ type: 'turn/start' }),
    )
    await runtime.dispose()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('cancels a started submission when its signal aborts', async () => {
    const { ctx } = await harness(new MockAdapter(['hang']))
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-abort'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const runtime = ctx.agentLoop.prepareSync(request(handle.agent.ctx, handle.agent.id))
    const controller = new AbortController()
    const submission = runtime.submit({
      submissionId: SubmissionId('abort'),
      message: message(),
      signal: controller.signal,
      started() {},
    })
    controller.abort()
    await expect(submission).resolves.toEqual({
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    await runtime.dispose()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('forwards compatibility create/resume and rejects preparation after unload', async () => {
    const { ctx, loopFiber } = await harness()
    const loop = ctx.agentLoop
    const handle = await loop.createAgent(ctx, { sessionId: SessionId('forward-create') })
    await handle.dispose()
    await expect(loop.resume(ctx, { resumeSessionId: SessionId('forward-resume') }))
      .rejects.toThrow('session persistence is not configured')
    await loopFiber.dispose()
    expect(() => loop.prepareSync(request(ctx, SessionId('inactive'))))
      .toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
    await ctx.fiber.dispose()
  })

  it('waits for the previous Native Provider generation to drain', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentRuntimeRegistry)
    await mountNativeTestRuntimeRouter(ctx)
    const oldProvider: AgentRuntimeProvider = {
      id: AgentRuntimeProviderId('native'),
      profileSnapshotVersions: [0],
      probe: () => Promise.reject(new Error('unused')),
      prepare: () => Promise.reject(new Error('unused')),
    }
    const oldProviderFiber = ctx.plugin(Object.assign((inner: Context) => {
      inner.agentRuntimes.registerProvider(oldProvider)
    }, { inject: ['agentRuntimes'] }))
    await oldProviderFiber
    let replacementSettled = false
    const replacement = ctx.plugin(AgentLoop, { agents: [] })
    void replacement.then(() => { replacementSettled = true })
    await Promise.resolve()
    expect(replacementSettled).toBe(false)
    const otherProvider: AgentRuntimeProvider = {
      ...oldProvider,
      id: 'other' as AgentRuntimeProvider['id'],
    }
    const otherFiber = ctx.plugin(Object.assign((inner: Context) => {
      inner.agentRuntimes.registerProvider(otherProvider)
    }, { inject: ['agentRuntimes'] }))
    await otherFiber
    await otherFiber.dispose()
    await oldProviderFiber.dispose()
    await replacement
    expect(ctx.agentRuntimes.getProvider(ctx.agentLoop.id)).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('rejects a waiting replacement that is disposed before the old Provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentRuntimeRegistry)
    await mountNativeTestRuntimeRouter(ctx)
    const oldProvider: AgentRuntimeProvider = {
      id: 'native' as AgentRuntimeProvider['id'],
      profileSnapshotVersions: [0],
      probe: () => Promise.reject(new Error('unused')),
      prepare: () => Promise.reject(new Error('unused')),
    }
    const oldProviderFiber = ctx.plugin(Object.assign((inner: Context) => {
      inner.agentRuntimes.registerProvider(oldProvider)
    }, { inject: ['agentRuntimes'] }))
    await oldProviderFiber
    let replacementService: AgentLoop | undefined
    const captureReplacement = (service: AgentLoop): void => { replacementService = service }
    class CapturingAgentLoop extends AgentLoop {
      constructor(inner: Context, config: AgentLoopConfig) {
        super(inner, config)
        captureReplacement(this)
      }
    }
    const replacement = ctx.plugin(CapturingAgentLoop, { agents: [] })
    await expect.poll(() => replacementService).toBeDefined()
    const replacementOwnership = Reflect.get(replacementService!, 'ownership') as {
      dispose(): Promise<void>
    }
    await replacementOwnership.dispose()
    await oldProviderFiber.dispose()
    let failure: unknown
    await replacement.then(
      () => { throw new Error('replacement unexpectedly loaded') },
      (error: unknown) => { failure = error },
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure as Error & { code: string; phase: string }).toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'registration',
    })
    await ctx.fiber.dispose()
  })

  it('reports synchronous configured creation failures', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentRuntimeRegistry)
    await mountNativeTestRuntimeRouter(ctx)
    ctx.sessions.create(SessionId('occupied'))
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', payload => failures.push(payload.error))
    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'configured', sessionId: SessionId('occupied') }],
    })
    expect(failures).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('creates a configured identity when persistence disappears while waiting', async () => {
    const { ctx } = await harness()
    const restore = Reflect.get(ctx.agentLoop, 'restoreOrCreateConfigured') as (
      ownerCtx: Context,
      sessionId: SessionId,
      options: {},
      meta: {},
    ) => Promise<void>
    await restore.call(
      ctx.agentLoop,
      ctx,
      SessionId('persistence-disappeared'),
      {},
      {},
    )
    expect(ctx.agents.get(SessionId('persistence-disappeared'))).toBeDefined()
    await ctx.fiber.dispose()
  })
})
