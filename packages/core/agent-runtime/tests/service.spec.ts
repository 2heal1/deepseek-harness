import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  AgentRuntimeError,
  AgentRuntimeId,
  AgentRuntimeProviderId,
  ExternalSessionId,
  MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES,
  RuntimeProfileId,
  SubmissionId,
  hasAgentRuntimeCapability,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
  type AgentRuntimeEventSink,
  type AgentRuntimeFailure,
  type AgentRuntimePrepareRequest,
  type AgentRuntimeProbeRequest,
  type AgentRuntimeProbeResult,
  type AgentRuntimeProvider,
  type AgentRuntimeSubmissionRequest,
  type AgentRuntimeSubmissionResult,
  type PreparedAgentRuntime,
  type SubmissionReceipt,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeRegistry from '@deepseek-ai/dsh-agent-runtime'

const NOOP_SINK: AgentRuntimeEventSink = {
  facts() {},
  assistantChunk() {},
  assistantMessage() {},
  activity() {},
}

class FakeProvider implements AgentRuntimeProvider {
  readonly profileSnapshotVersions = [0]

  constructor(readonly id = AgentRuntimeProviderId('fake')) {}

  async probe(_request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    return {
      capabilities: snapshotAgentRuntimeCapabilities([{ id: 'runtimeActivity' }]),
      permissionEnforcement: 'enforced',
    }
  }

  async prepare(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    const capabilities = snapshotAgentRuntimeCapabilities([{ id: 'runtimeActivity' }])
    const initialFacts = snapshotAgentRuntimeFacts({
      runtimeId: request.runtimeId,
      providerId: this.id,
      capabilities,
      phase: 'ready',
      externalSessionId: ExternalSessionId('external-1'),
    })
    return {
      runtimeId: request.runtimeId,
      capabilities,
      initialFacts,
      async submit(_submission: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult> {
        return { reason: { kind: 'completed' } }
      },
      cancel() {},
      async dispose() {},
    }
  }
}

async function service(): Promise<{ ctx: Context; runtimes: AgentRuntimeRegistry }> {
  const ctx = new Context()
  await ctx.plugin(AgentRuntimeRegistry)
  return { ctx, runtimes: ctx.agentRuntimes }
}

describe('AgentRuntimeRegistry', () => {
  it('registers, lists, looks up, and effect-disposes providers', async () => {
    const { ctx, runtimes } = await service()
    const added: string[] = []
    const removed: string[] = []
    ctx.on('agent-runtime/provider-added', provider => void added.push(provider.id))
    ctx.on('agent-runtime/provider-removed', id => void removed.push(id))
    const provider = new FakeProvider()

    const dispose = runtimes.registerProvider(provider)
    expect(runtimes.getProvider(provider.id)).toBe(provider)
    expect(runtimes.listProviders()).toEqual([provider])

    dispose()
    expect(runtimes.getProvider(provider.id)).toBeUndefined()
    expect(runtimes.listProviders()).toEqual([])
    expect(added).toEqual(['fake'])
    expect(removed).toEqual(['fake'])
  })

  it('rolls registration back when publication throws', async () => {
    const { ctx, runtimes } = await service()
    const provider = new FakeProvider()
    ctx.on('agent-runtime/provider-added', () => { throw new Error('publication failed') })

    expect(() => { runtimes.registerProvider(provider) }).toThrow('publication failed')
    expect(runtimes.getProvider(provider.id)).toBeUndefined()
  })

  it('removes a provider when its contributing plugin reloads', async () => {
    const { ctx, runtimes } = await service()
    const provider = new FakeProvider()
    const contribution = ctx.plugin(Object.assign((childCtx: Context) => {
      childCtx.agentRuntimes.registerProvider(provider)
    }, { inject: ['agentRuntimes'] }))
    await contribution
    expect(runtimes.getProvider(provider.id)).toBe(provider)

    await contribution.dispose()
    expect(runtimes.getProvider(provider.id)).toBeUndefined()
  })

  it('rejects duplicate and malformed registrations with typed failures', async () => {
    const { runtimes } = await service()
    const provider = new FakeProvider()
    runtimes.registerProvider(provider)

    expect(() => { runtimes.registerProvider(provider) }).toThrow(expect.objectContaining({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'registration',
      providerId: provider.id,
    }))
    expect(() => {
      runtimes.registerProvider(new FakeProvider(AgentRuntimeProviderId('bad id')))
    }).toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    const noVersions = new FakeProvider(AgentRuntimeProviderId('no-versions'))
    Object.defineProperty(noVersions, 'profileSnapshotVersions', { value: [] })
    expect(() => { runtimes.registerProvider(noVersions) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
    const duplicateVersions = new FakeProvider(AgentRuntimeProviderId('duplicate-versions'))
    Object.defineProperty(duplicateVersions, 'profileSnapshotVersions', { value: [0, 0] })
    expect(() => { runtimes.registerProvider(duplicateVersions) })
      .toThrow(expect.objectContaining({ code: 'RUNTIME_INCOMPATIBLE' }))
  })

  it('keeps provider execution behind the published Provider interface', async () => {
    const provider = new FakeProvider()
    const capabilities = snapshotAgentRuntimeCapabilities([{ id: 'runtimeActivity' }])
    const result = await provider.probe({ profile: {
      schemaVersion: 0,
      profileId: RuntimeProfileId('profile'),
      settingsRevision: 1,
      provider: { id: provider.id, optionsVersion: 0, options: {} },
      launch: {
        executable: '/bin/fake',
        resolution: { kind: 'absolute' },
        args: [],
        cwd: { kind: 'session-workspace' },
        ambientEnv: [],
        env: {},
      },
      model: { allowSessionOverride: false },
      product: {},
      permissions: {
        policy: {},
        enforcement: 'required',
        approval: 'unattended-fail-closed',
      },
      nativeTools: { allowed: [] },
      harnessTools: { transport: 'none', allowed: [] },
      credentials: [],
      deadlines: { startupMs: 1, turnMs: 1, shutdownMs: 1, terminationMs: 1 },
      capacity: { maxConcurrentRuns: 1 },
    }, signal: new AbortController().signal })

    expect(result.capabilities).toEqual(capabilities)
    expect(hasAgentRuntimeCapability(result.capabilities, 'runtimeActivity')).toBe(true)
    expect(hasAgentRuntimeCapability(result.capabilities, 'steering')).toBe(false)
    expectTypeOf<FakeProvider>().toExtend<AgentRuntimeProvider>()
    expectTypeOf<SubmissionReceipt['id']>().toEqualTypeOf<ReturnType<typeof SubmissionId>>()
    expectTypeOf<AgentRuntimePrepareRequest['sink']>().toEqualTypeOf<AgentRuntimeEventSink>()
    expect(NOOP_SINK).toBeDefined()
    expect(AgentRuntimeId('runtime')).toBe('runtime')
    expect(SubmissionId('submission')).toBe('submission')
    expect(ExternalSessionId('external')).toBe('external')
  })
})

describe('runtime snapshots and failures', () => {
  it('detaches and freezes capability metadata and runtime facts', () => {
    const metadata = { fidelity: ['commands'] }
    const capabilities = snapshotAgentRuntimeCapabilities([{ id: 'runtimeActivity', metadata }])
    metadata.fidelity.push('diffs')
    expect(capabilities).toEqual([{ id: 'runtimeActivity', metadata: { fidelity: ['commands'] } }])
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(Object.isFrozen(capabilities[0]?.metadata)).toBe(true)

    const facts = snapshotAgentRuntimeFacts({
      runtimeId: AgentRuntimeId('runtime-1'),
      providerId: AgentRuntimeProviderId('fake'),
      capabilities,
      phase: 'ready',
      product: { value: 'Fake CLI', source: 'protocol' },
    })
    expect(Object.isFrozen(facts)).toBe(true)
    expect(Object.isFrozen(facts.product)).toBe(true)
    expect(() => snapshotAgentRuntimeFacts({
      runtimeId: AgentRuntimeId(''),
      providerId: AgentRuntimeProviderId('fake'),
      capabilities: [],
      phase: 'ready',
    })).toThrow(/runtime id must be non-empty/)
    expect(() => snapshotAgentRuntimeFacts({
      runtimeId: AgentRuntimeId('runtime-1'),
      providerId: AgentRuntimeProviderId('fake'),
      capabilities: [],
      phase: 'ready',
      product: { value: undefined, source: 'protocol' } as never,
    })).toThrow(/facts must be lossless JSON/)
  })

  it('rejects duplicate, unknown, and non-JSON capabilities', () => {
    expect(() => snapshotAgentRuntimeCapabilities([
      { id: 'steering' },
      { id: 'steering' },
    ])).toThrow(/duplicate/)
    expect(() => snapshotAgentRuntimeCapabilities([
      { id: 'unknown' as 'steering' },
    ])).toThrow(/unknown/)
    expect(() => snapshotAgentRuntimeCapabilities([
      { id: 'steering', metadata: { bad: undefined } as never },
    ])).toThrow(/lossless JSON/)
  })

  it('carries frozen serializable failure facts and a local cause', () => {
    const cause = new Error('private transport detail')
    const details = { retryable: false }
    const error = new AgentRuntimeError({
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'probe',
      message: 'runtime is unavailable',
      providerId: AgentRuntimeProviderId('fake'),
      details,
    }, { cause })
    details.retryable = true

    expect(error).toMatchObject({
      name: 'AgentRuntimeError',
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'probe',
      providerId: 'fake',
      details: { retryable: false },
      cause,
    })
    expect(Object.isFrozen(error.failure)).toBe(true)
    expect(Object.isFrozen(error.details)).toBe(true)
  })

  it('enforces the serialized UTF-8 byte boundary for failure details', () => {
    const base: Omit<AgentRuntimeFailure, 'details'> = {
      code: 'RUNTIME_FAILED',
      phase: 'turn',
      message: 'runtime failed',
    }
    const exactAscii = 'x'.repeat(MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES - 2)
    const exactMultibyte = `xx${'\u754c'.repeat(
      (MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES - 4) / 3,
    )}`
    const oversizedMultibyte = `${exactMultibyte}\u754c`

    expect(new TextEncoder().encode(JSON.stringify(exactAscii)))
      .toHaveLength(MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES)
    expect(new TextEncoder().encode(JSON.stringify(exactMultibyte)))
      .toHaveLength(MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES)
    expect(new AgentRuntimeError({ ...base, details: exactAscii }).details).toBe(exactAscii)
    expect(new AgentRuntimeError({ ...base, details: exactMultibyte }).details).toBe(exactMultibyte)
    expect(() => new AgentRuntimeError({ ...base, details: oversizedMultibyte }))
      .toThrow(/exceed/)
  })

  it('rejects non-JSON and oversized failure details', () => {
    const base: Omit<AgentRuntimeFailure, 'details'> = {
      code: 'RUNTIME_FAILED',
      phase: 'turn',
      message: 'runtime failed',
    }
    expect(() => new AgentRuntimeError({
      ...base,
      details: { unsupported: undefined } as never,
    })).toThrow(/lossless JSON/)
    expect(() => new AgentRuntimeError({
      ...base,
      details: 'x'.repeat(MAX_AGENT_RUNTIME_ERROR_DETAILS_BYTES),
    })).toThrow(/exceed/)
    expect(new AgentRuntimeError(base).failure).toEqual(base)
  })
})
