import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry, {
  AgentRuntimeError,
  AgentRuntimeId,
  AgentRuntimeProviderId,
  snapshotAgentRuntimeFacts,
  SubmissionId,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimePrepareRequest,
  AgentRuntimeProvider,
  AgentRuntimeSubmissionRequest,
  PreparedAgentRuntime,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import AgentRuntimeSubagentRoutes from '@deepseek-ai/dsh-subagent-runtime-route'
import SettingsProvider, {
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

function profileSettings(
  routeCapacity = 1,
  profileCapacity = 2,
  cwdPolicy: 'parent-workspace' | { readonly fixed: string } = 'parent-workspace',
) {
  return {
    defaultMainProfile: 'child-profile',
    profiles: {
      'child-profile': {
        provider: 'acp',
        launch: {
          executable: '/usr/bin/acp',
          resolution: 'absolute' as const,
          cwdPolicy,
        },
        permissions: {
          policy: { sandbox: 'workspace-write' },
          enforcement: 'best-effort' as const,
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

function parent(depth = 0, cwd: string | null = '/workspace'): Agent {
  return {
    id: SessionId('parent'),
    options: {},
    capabilities: [],
    session: {
      id: SessionId('parent'),
      header: {
        id: SessionId('parent'),
        createdAt: 1,
        ...(cwd === null ? {} : { cwd }),
        delegationDepth: depth,
      },
    },
    ctx: new Context(),
  } as unknown as Agent
}

function request(signal: AbortSignal, depth = 0, cwd?: string): ResolvedSubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'work' }],
    parent: parent(depth, cwd ?? '/workspace'),
    signal,
    descriptor: {
      version: 0,
      mode: 'one-shot',
      provider: 'child',
    },
  }
}

class FakeRuntimeProvider implements AgentRuntimeProvider {
  readonly id = AgentRuntimeProviderId('acp')
  readonly profileSnapshotVersions = [0]
  readonly requests: AgentRuntimePrepareRequest[] = []
  readonly submissions: AgentRuntimeSubmissionRequest[] = []
  readonly cancellations: Array<{
    id: AgentRuntimeSubmissionRequest['submissionId']
    cause: Parameters<PreparedAgentRuntime['cancel']>[1]
  }> = []
  readonly disposals: Array<ReturnType<typeof Promise.withResolvers<undefined>>> = []
  prepareFailure: Error | undefined
  submitFailure: Error | undefined
  waitForCancellation = false
  disposeFailure: Error | undefined
  emitOutput = true
  mismatch: 'runtime' | 'facts-runtime' | 'facts-provider' | undefined
  onPrepare: ((request: AgentRuntimePrepareRequest) => void) | undefined
  onSubmit: ((
    prepare: AgentRuntimePrepareRequest,
    submission: AgentRuntimeSubmissionRequest,
  ) => void) | undefined
  terminal: Awaited<ReturnType<PreparedAgentRuntime['submit']>>['reason'] = { kind: 'completed' }
  native = false

  probe() {
    return Promise.resolve({
      capabilities: [],
      permissionEnforcement: 'best-effort' as const,
    })
  }

  async prepare(value: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    this.requests.push(value)
    this.onPrepare?.(value)
    if (this.prepareFailure !== undefined) throw this.prepareFailure
    const disposal = Promise.withResolvers<undefined>()
    this.disposals.push(disposal)
    const runtime: PreparedAgentRuntime = {
      runtimeId: this.mismatch === 'runtime' ? AgentRuntimeId('wrong-runtime') : value.runtimeId,
      capabilities: [],
      initialFacts: snapshotAgentRuntimeFacts({
        runtimeId: this.mismatch === 'facts-runtime'
          ? AgentRuntimeId('wrong-runtime')
          : value.runtimeId,
        providerId: this.mismatch === 'facts-provider'
          ? AgentRuntimeProviderId('wrong-provider')
          : this.id,
        capabilities: [],
        phase: 'ready',
      }),
      submit: async (submission) => {
        this.submissions.push(submission)
        submission.started(1)
        this.onSubmit?.(value, submission)
        if (this.waitForCancellation) {
          await new Promise<void>((resolve) => {
            submission.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        if (this.submitFailure !== undefined) throw this.submitFailure
        if (this.emitOutput) {
          value.sink.assistantChunk(submission.submissionId, {
            kind: 'text-delta',
            text: 'streamed',
          })
          value.sink.assistantMessage(submission.submissionId, {
            content: [{ type: 'text', text: 'final' }],
          })
        }
        return { reason: this.terminal }
      },
      cancel: (id, cause) => {
        this.cancellations.push({ id, cause })
      },
      dispose: async () => {
        if (this.disposeFailure !== undefined) throw this.disposeFailure
        await disposal.promise
      },
      ...(this.native
        ? { agentDriver: {} as NonNullable<PreparedAgentRuntime['agentDriver']> }
        : {}),
    }
    return runtime
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

async function harness(
  routeCapacity = 1,
  profileCapacity = 2,
  cwdPolicy: 'parent-workspace' | { readonly fixed: string } = 'parent-workspace',
) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentRuntimeRegistry)
  await ctx.plugin(
    AgentRuntimeProfiles,
    profileSettings(routeCapacity, profileCapacity, cwdPolicy),
  )
  const backing = new FakeRuntimeProvider()
  const backingFiber = ctx.plugin(Object.assign((child: Context) => {
    child.agentRuntimes.registerProvider(backing)
  }, { inject: ['agentRuntimes'] }))
  await backingFiber
  const routesFiber = ctx.plugin(AgentRuntimeSubagentRoutes, {})
  await routesFiber
  return { ctx, backing, backingFiber, routesFiber }
}

describe('AgentRuntimeSubagentRoutes', () => {
  it('runs a Provider under the pinned profile and returns its final assistant output', async () => {
    const { ctx, backing, routesFiber } = await harness()
    expect(ctx.subagents.getProvider('child')).toBeDefined()
    expect(ctx.tools.get('delegate_child')).toBeDefined()

    const run = await ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'final' }],
      stopReason: 'completed',
    })
    expect(run.localAgent).toBeUndefined()
    expect(backing.requests[0]?.profile).toMatchObject({
      profileId: 'child-profile',
      provider: { id: 'acp' },
    })
    expect(backing.requests[0]?.agentCtx.agent).toMatchObject({
      id: run.id,
      status: 'idle',
      capabilities: [],
      session: {
        header: {
          cwd: '/workspace',
          parentSession: 'parent',
          origin: 'subagent',
          delegationDepth: 1,
        },
      },
    })
    const privateAgent = backing.requests[0]!.agentCtx.agent!
    expect(() => privateAgent.inbox).toThrow('before publication')
    for (const operation of [
      'cancel',
      'whenIdle',
      'submit',
      'cancelSubmission',
      'runMaintenance',
      'send',
      'followup',
      'steer',
      'inject',
    ] as const) {
      expect(() => {
        Reflect.apply(privateAgent[operation], privateAgent, [])
      }).toThrow(`Agent.${operation}`)
    }
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
    const firstDisposal = first.dispose()
    backing.disposals[0]?.resolve(undefined)
    await firstDisposal
    const thirdRun = await third
    expect(backing.requests).toHaveLength(2)
    const thirdDisposal = thirdRun.dispose()
    backing.disposals[1]?.resolve(undefined)
    await thirdDisposal
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
    const secondDisposal = secondRun.dispose()
    backing.disposals[1]?.resolve(undefined)
    await secondDisposal
    await secondRun.dispose()
    await ctx.fiber.dispose()
  })

  it('releases capacity after startup and disposal failures', async () => {
    const { ctx, backing } = await harness()
    backing.prepareFailure = new Error('startup failed')
    const route = ctx.subagents.getProvider('child')!
    await expect(route.start(request(new AbortController().signal))).rejects.toThrow('startup failed')
    backing.prepareFailure = undefined
    backing.disposeFailure = new Error('dispose failed')
    const first = await route.start(request(new AbortController().signal))
    await expect(first.dispose()).rejects.toThrow('dispose failed')
    backing.disposeFailure = undefined
    const second = await route.start(request(new AbortController().signal))
    const secondDisposal = second.dispose()
    backing.disposals[1]?.resolve(undefined)
    await secondDisposal
    await ctx.fiber.dispose()
  })

  it('fails before preparation for missing providers, profile versions, and workspaces', async () => {
    const { ctx, backingFiber } = await harness()
    const route = ctx.subagents.getProvider('child')!
    await backingFiber.dispose()
    await expect(route.start(request(new AbortController().signal)))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })

    const replacement = new FakeRuntimeProvider()
    replacement.profileSnapshotVersions[0] = 1
    ctx.agentRuntimes.registerProvider(replacement)
    await expect(route.start(request(new AbortController().signal)))
      .rejects.toMatchObject({ failure: { code: 'RUNTIME_INCOMPATIBLE' } })
    await ctx.fiber.dispose()

    const missingWorkspace = await harness()
    const withoutCwd = {
      ...request(new AbortController().signal),
      parent: parent(0, null),
    }
    await expect(missingWorkspace.ctx.subagents.getProvider('child')!.start(withoutCwd))
      .rejects.toMatchObject({ failure: { code: 'PROFILE_INVALID' } })
    expect(missingWorkspace.backing.requests).toHaveLength(0)
    await missingWorkspace.ctx.fiber.dispose()
  })

  it.each([
    [{ kind: 'max-tokens' }, 'max-tokens'],
    [{ kind: 'blocked' }, 'refusal'],
    [{ kind: 'aborted', reason: { kind: 'parent' } }, 'aborted'],
    [{ kind: 'interrupted' }, 'aborted'],
    [{ kind: 'error', error: { code: 'FAILED', message: 'safe failure' } }, 'error'],
  ] as const)('maps runtime terminal reason $0 to $1', async (terminal, expected) => {
    const { ctx, backing } = await harness()
    backing.terminal = terminal
    const run = await ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )
    await expect(run.result).resolves.toMatchObject({
      output: [{ type: 'text', text: 'final' }],
      stopReason: expected,
    })
    const disposal = run.dispose()
    backing.disposals[0]?.resolve(undefined)
    await disposal
    await ctx.fiber.dispose()
  })

  it('maps a post-publication Provider failure and forwards cancellation', async () => {
    const { ctx, backing } = await harness()
    const controller = new AbortController()
    backing.waitForCancellation = true
    backing.submitFailure = new AgentRuntimeError({
      code: 'RUNTIME_FAILED',
      phase: 'turn',
      message: 'safe provider failure',
      providerId: backing.id,
    })
    const run = await ctx.subagents.getProvider('child')!.start(request(controller.signal))
    controller.abort()
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'error',
      diagnostic: 'safe provider failure',
    })
    expect(backing.cancellations).toMatchObject([{ cause: { kind: 'parent' } }])
    const disposal = run.dispose()
    backing.disposals[0]?.resolve(undefined)
    await disposal
    await ctx.fiber.dispose()
  })

  it('validates sink correlations and uses streamed text when no final message exists', async () => {
    const { ctx, backing } = await harness(1, 2, { fixed: '/fixed-child' })
    backing.emitOutput = false
    backing.onSubmit = (prepare, submission) => {
      const facts = {
        runtimeId: prepare.runtimeId,
        providerId: backing.id,
        capabilities: [],
        phase: 'running' as const,
      }
      prepare.sink.facts(facts)
      expect(() => {
        prepare.sink.facts({
          ...facts,
          runtimeId: AgentRuntimeId('wrong-runtime'),
        })
      }).toThrow('runtime facts do not match')
      expect(() => {
        prepare.sink.facts({
          ...facts,
          providerId: AgentRuntimeProviderId('wrong-provider'),
        })
      }).toThrow('runtime facts do not match')
      prepare.sink.activity({
        runtimeId: prepare.runtimeId,
        kind: 'turn',
        phase: 'started',
        fidelity: 'complete',
        data: {},
      })
      prepare.sink.activity({
        runtimeId: prepare.runtimeId,
        submissionId: submission.submissionId,
        kind: 'turn',
        phase: 'completed',
        fidelity: 'complete',
        data: {},
      })
      expect(() => {
        prepare.sink.activity({
          runtimeId: AgentRuntimeId('wrong-runtime'),
          kind: 'turn',
          phase: 'started',
          fidelity: 'complete',
          data: {},
        })
      }).toThrow('runtime activity does not match')
      expect(() => {
        prepare.sink.activity({
          runtimeId: prepare.runtimeId,
          submissionId: SubmissionId('wrong-submission'),
          kind: 'turn',
          phase: 'started',
          fidelity: 'complete',
          data: {},
        })
      }).toThrow('runtime activity does not match')
      prepare.sink.assistantChunk(submission.submissionId, {
        kind: 'reasoning-delta',
        text: 'ignored reasoning',
      })
      prepare.sink.assistantChunk(submission.submissionId, {
        kind: 'content-block',
        block: { type: 'text', text: 'ignored block' },
      })
      prepare.sink.assistantMessage(submission.submissionId, { content: [] })
      prepare.sink.assistantChunk(submission.submissionId, {
        kind: 'text-delta',
        text: 'streamed fallback',
      })
      expect(() => {
        prepare.sink.assistantChunk(SubmissionId('wrong-submission'), {
          kind: 'text-delta',
          text: 'wrong',
        })
      }).toThrow('assistant output does not match')
    }
    const run = await ctx.subagents.getProvider('child')!.start({
      ...request(new AbortController().signal),
      parent: parent(0, null),
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'streamed fallback' }],
      stopReason: 'completed',
    })
    expect(backing.requests[0]?.agentCtx.agent?.session.header.cwd).toBe('/fixed-child')
    expect(() => {
      backing.requests[0]!.sink.facts({
        runtimeId: backing.requests[0]!.runtimeId,
        providerId: backing.id,
        capabilities: [],
        phase: 'stopped',
      })
    }).toThrow('event sink is closed')
    const disposal = run.dispose()
    backing.disposals[0]?.resolve(undefined)
    await disposal
    await ctx.fiber.dispose()
  })

  it.each(['runtime', 'facts-runtime', 'facts-provider'] as const)(
    'rejects a prepared handle with mismatched %s identity',
    async (mismatch) => {
      const { ctx, backing } = await harness()
      backing.mismatch = mismatch
      const start = ctx.subagents.getProvider('child')!.start(
        request(new AbortController().signal),
      )
      await vi.waitFor(() => { expect(backing.disposals).toHaveLength(1) })
      backing.disposals[0]?.resolve(undefined)
      await expect(start).rejects.toMatchObject({
        failure: { code: 'RUNTIME_INCOMPATIBLE' },
      })
      await ctx.fiber.dispose()
    },
  )

  it('maps unknown failures and future terminal reasons conservatively', async () => {
    const failed = await harness()
    failed.backing.submitFailure = new Error('private failure')
    const failedRun = await failed.ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )
    await expect(failedRun.result).resolves.toEqual({
      output: [],
      stopReason: 'error',
      diagnostic: 'agent runtime submission failed',
    })
    const failedDisposal = failedRun.dispose()
    failed.backing.disposals[0]?.resolve(undefined)
    await failedDisposal
    await failed.ctx.fiber.dispose()

    const future = await harness()
    future.backing.terminal = { kind: 'future-runtime-reason' } as never
    const futureRun = await future.ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )
    await expect(futureRun.result).resolves.toMatchObject({ stopReason: 'error' })
    const futureDisposal = futureRun.dispose()
    future.backing.disposals[0]?.resolve(undefined)
    await futureDisposal
    await future.ctx.fiber.dispose()
  })

  it('forwards a cancellation that wins while Provider preparation completes', async () => {
    const { ctx, backing } = await harness()
    const controller = new AbortController()
    backing.onPrepare = () => { controller.abort() }
    const run = await ctx.subagents.getProvider('child')!.start(request(controller.signal))
    await run.result
    expect(backing.cancellations[0]?.cause).toEqual({ kind: 'parent' })
    const disposal = run.dispose()
    backing.disposals[0]?.resolve(undefined)
    await disposal
    await ctx.fiber.dispose()
  })

  it('rejects a Native driver and releases its prepared runtime', async () => {
    const { ctx, backing } = await harness()
    backing.native = true
    backing.disposeFailure = new Error('native cleanup failed')
    const start = ctx.subagents.getProvider('child')!.start(
      request(new AbortController().signal),
    )
    await expect(start).rejects.toThrow('runtime subagent startup rollback failed')
    await ctx.fiber.dispose()
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

  it('contains asynchronous reconciliation failure', async () => {
    const { ctx } = await harness()
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
