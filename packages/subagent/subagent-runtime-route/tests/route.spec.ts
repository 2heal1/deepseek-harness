import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import AgentRuntimeSubagentRoutes from '@deepseek-ai/dsh-subagent-runtime-route'
import SettingsProvider, {
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

function profileSettings(routeCapacity = 1, profileCapacity = 2) {
  return {
    defaultMainProfile: 'child-profile',
    profiles: {
      'child-profile': {
        provider: 'acp',
        launch: {
          executable: '/usr/bin/acp',
          resolution: 'absolute' as const,
          cwdPolicy: 'parent-workspace' as const,
        },
        permissions: {
          policy: { sandbox: 'workspace-write' },
          enforcement: 'required' as const,
        },
        credentials: {
          env: {
            CHILD_API_KEY: { credentialRef: 'CHILD_RUNTIME_KEY' },
          },
        },
        process: {
          startupTimeoutMs: 1_000,
          turnTimeoutMs: 1_000,
          shutdownTimeoutMs: 1_000,
          terminationTimeoutMs: 1_000,
          maxConcurrentRuns: profileCapacity,
        },
      },
    },
    subagentRoutes: {
      child: {
        runtimeProfile: 'child-profile',
        maxDepth: 2,
        maxConcurrentRuns: routeCapacity,
        toolName: 'delegate_child',
      },
    },
  }
}

function parent(depth = 0): Agent {
  return {
    id: SessionId('parent'),
    options: {},
    capabilities: [],
    session: {
      id: SessionId('parent'),
      header: { id: SessionId('parent'), createdAt: 1, delegationDepth: depth },
    },
    ctx: new Context(),
  } as unknown as Agent
}

function request(signal: AbortSignal, depth = 0): ResolvedSubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'work' }],
    parent: parent(depth),
    signal,
    descriptor: {
      version: 0,
      mode: 'one-shot',
      provider: 'child',
    },
  }
}

class FakeAcpProvider implements SubagentProvider {
  readonly name = 'acp'
  readonly capabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  readonly inheritsParentContext = false
  readonly requests: ResolvedSubagentStartRequest[] = []
  readonly disposals: Array<ReturnType<typeof Promise.withResolvers<undefined>>> = []

  async start(value: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(value)
    const disposal = Promise.withResolvers<undefined>()
    this.disposals.push(disposal)
    return {
      id: SessionId(`child-${String(this.requests.length)}`),
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: () => disposal.promise,
    }
  }
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private stored: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(
    ns: SettingsNamespace,
    section: Record<string, unknown>,
  ): Promise<void> {
    this.stored[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function harness(routeCapacity = 1, profileCapacity = 2) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentRuntimeProfiles, profileSettings(routeCapacity, profileCapacity))
  const backing = new FakeAcpProvider()
  const backingFiber = ctx.plugin(Object.assign((child: Context) => {
    child.subagents.registerProvider(backing)
  }, { inject: ['subagents'] }))
  await backingFiber
  const routesFiber = ctx.plugin(AgentRuntimeSubagentRoutes, {})
  await routesFiber
  return { ctx, backing, backingFiber, routesFiber }
}

describe('AgentRuntimeSubagentRoutes', () => {
  it('registers the route and tool and pins the profile on the delegated request', async () => {
    const { ctx, backing, routesFiber } = await harness()
    expect(ctx.subagents.getProvider('child')).toBeDefined()
    expect(ctx.tools.get('delegate_child')).toBeDefined()

    const run = await ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )
    expect(backing.requests[0]?.runtimeProfile).toMatchObject({
      profileId: 'child-profile',
      provider: { id: 'acp' },
      credentials: [{ target: 'CHILD_API_KEY', credentialRef: 'CHILD_RUNTIME_KEY' }],
    })
    backing.disposals[0]?.resolve(undefined)
    await run.dispose()

    await routesFiber.dispose()
    expect(ctx.subagents.getProvider('child')).toBeUndefined()
    expect(ctx.tools.get('delegate_child')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('uses the lower route capacity, preserves FIFO, and cancels queued starts', async () => {
    const { ctx, backing } = await harness(1, 2)
    const route = ctx.subagents.getProvider('child')!
    const first = await route.start(request(new AbortController().signal))
    const secondController = new AbortController()
    const second = route.start(request(secondController.signal))
    const third = route.start(request(new AbortController().signal))
    await Promise.resolve()
    expect(backing.requests).toHaveLength(1)

    secondController.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    backing.disposals[0]?.resolve(undefined)
    await first.dispose()
    const thirdRun = await third
    expect(backing.requests).toHaveLength(2)
    backing.disposals[1]?.resolve(undefined)
    await thirdRun.dispose()
    await ctx.fiber.dispose()
  })

  it('holds capacity through quiescent disposal and enforces route depth', async () => {
    const { ctx, backing } = await harness()
    const route = ctx.subagents.getProvider('child')!
    await expect(route.start(request(new AbortController().signal, 2)))
      .rejects.toMatchObject({ code: 'DEPTH_EXCEEDED' })

    const first = await route.start(request(new AbortController().signal))
    const dispose = first.dispose()
    const second = route.start(request(new AbortController().signal))
    await Promise.resolve()
    expect(backing.requests).toHaveLength(1)
    backing.disposals[0]?.resolve(undefined)
    await dispose
    const secondRun = await second
    expect(backing.requests).toHaveLength(2)
    backing.disposals[1]?.resolve(undefined)
    await secondRun.dispose()
    await secondRun.dispose()
    await ctx.fiber.dispose()
  })

  it('releases capacity when backing startup rejects', async () => {
    const { ctx, backing } = await harness()
    vi.spyOn(backing, 'start').mockRejectedValueOnce(new Error('startup failed'))
    const route = ctx.subagents.getProvider('child')!
    await expect(route.start(request(new AbortController().signal))).rejects.toThrow('startup failed')
    const run = await route.start(request(new AbortController().signal))
    backing.disposals[0]?.resolve(undefined)
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('fails explicitly when the profile provider is absent or resolves to the route itself', async () => {
    const { ctx, backingFiber } = await harness()
    await backingFiber.dispose()
    await expect(ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()

    const self = new Context()
    await self.plugin(LlmRuntime)
    await self.plugin(SessionStore)
    await self.plugin(SystemPrompt, {})
    await self.plugin(ToolRuntime, {})
    await self.plugin(SubagentRuntime)
    const configured = profileSettings()
    configured.profiles['child-profile'].provider = 'child'
    await self.plugin(AgentRuntimeProfiles, configured)
    await self.plugin(AgentRuntimeSubagentRoutes, {})
    await expect(self.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await self.fiber.dispose()
  })

  it('reconciles Settings edits and removals without remounting unchanged routes', async () => {
    const { ctx } = await harness()
    const original = ctx.subagents.getProvider('child')
    ctx.emit('settings/updated', 'unrelated' as SettingsNamespace, {}, {}, 'update')
    ctx.emit('settings/updated', 'agent-runtime' as SettingsNamespace, {}, {}, 'update')
    await expect.poll(() => ctx.subagents.getProvider('child')).toBe(original)

    const updated = profileSettings()
    updated.subagentRoutes.child.toolName = 'delegate_updated'
    await ctx.settings.replace('agent-runtime' as SettingsNamespace, updated)
    await expect.poll(() => ctx.tools.get('delegate_updated')).toBeDefined()
    expect(ctx.tools.get('delegate_child')).toBeUndefined()

    await ctx.settings.replace('agent-runtime' as SettingsNamespace, {
      ...updated,
      subagentRoutes: {},
    })
    await expect.poll(() => ctx.subagents.getProvider('child')).toBeUndefined()
    expect(ctx.tools.get('delegate_updated')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('contains asynchronous reconciliation failure and releases after dispose rejection', async () => {
    const { ctx, backing } = await harness()
    const route = ctx.subagents.getProvider('child')!
    const first = await route.start(request(new AbortController().signal))
    backing.disposals[0]?.reject(new Error('dispose failed'))
    await expect(first.dispose()).rejects.toThrow('dispose failed')
    const second = await route.start(request(new AbortController().signal))
    backing.disposals[1]?.resolve(undefined)
    await second.dispose()

    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(ctx.agentRuntimeProfiles, 'resolveRoute').mockImplementationOnce(() => {
      throw new Error('reconcile failed')
    })
    ctx.emit('settings/updated', 'agent-runtime' as SettingsNamespace, {}, {}, 'update')
    await expect.poll(() => warn).toHaveBeenCalledWith(
      expect.stringContaining('reconcile failed'),
    )
    await ctx.fiber.dispose()
  })
})
