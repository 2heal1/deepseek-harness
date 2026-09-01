import { Context } from '@deepseek-ai/cordis'
import {
  AgentRuntimeError,
  type RuntimeProfileSnapshot,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeProfiles, {
  AGENT_RUNTIME_SETTINGS_NAMESPACE,
  type AgentRuntimeProfileSettings,
} from '@deepseek-ai/dsh-agent-runtime-profile'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'

function settings(overrides: Partial<AgentRuntimeProfileSettings> = {}): AgentRuntimeProfileSettings {
  return {
    defaultMainProfile: 'main',
    profiles: {
      main: {
        provider: 'native',
        launch: {
          executable: '/usr/bin/runtime',
          args: ['serve'],
          resolution: 'absolute',
          cwdPolicy: 'session-workspace',
          ambientEnv: ['LANG'],
          env: { LOG_LEVEL: 'info' },
        },
        model: { default: 'base-model', allowSessionOverride: true },
        providerOptions: { effort: 'high' },
        product: { profile: 'work' },
        permissions: {
          policy: { sandbox: 'workspace-write' },
          enforcement: 'required',
        },
        nativeTools: { allowed: ['filesystem'] },
        harnessTools: { transport: 'mcp', allowed: ['todo_write'] },
        credentials: {
          env: {
            PROVIDER_API_KEY: { credentialRef: 'RUNTIME_MAIN_KEY' },
          },
        },
        process: {
          startupTimeoutMs: 15_000,
          turnTimeoutMs: 30_000,
          shutdownTimeoutMs: 5_000,
          terminationTimeoutMs: 2_000,
          maxConcurrentRuns: 1,
        },
      },
    },
    subagentRoutes: {
      child: {
        runtimeProfile: 'main',
        mode: 'one-shot',
        maxDepth: 2,
        maxConcurrentRuns: 3,
        toolName: 'delegate_child',
      },
    },
    ...overrides,
  }
}

function mainProfile() {
  return settings().profiles.main!
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private stored: Record<string, unknown>

  constructor(ctx: Context, document: Record<string, unknown> = {}) {
    super(ctx)
    this.stored = document
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<CredentialRef, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({
      configured: this.values.has(ref),
      ...(configured ? { source: 'memory' } : {}),
      writable: true,
    })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }
}

async function harness(
  config = settings(),
  document: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, document)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AgentRuntimeProfiles, config)
  return ctx
}

describe('AgentRuntimeProfiles', () => {
  it('resolves omitted optional fields without a Settings or credentials provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRuntimeProfiles, {
      defaultMainProfile: 'minimal',
      profiles: {
        minimal: {
          provider: 'external',
          launch: {
            executable: 'runtime',
            cwdPolicy: { fixed: '/workspace' },
          },
          permissions: {
            policy: {},
            enforcement: 'best-effort',
          },
          process: {
            startupTimeoutMs: 1,
            turnTimeoutMs: 2,
            shutdownTimeoutMs: 3,
            terminationTimeoutMs: 4,
            maxConcurrentRuns: 2,
          },
        },
      },
    })
    const snapshot = ctx.agentRuntimeProfiles.resolve()
    expect(snapshot).toMatchObject({
      settingsRevision: 0,
      provider: { id: 'external', options: {} },
      launch: {
        resolution: { kind: 'search-path', paths: [] },
        args: [],
        cwd: { kind: 'fixed', path: '/workspace' },
        ambientEnv: [],
        env: {},
      },
      model: { allowSessionOverride: false },
      product: {},
      nativeTools: { allowed: [] },
      harnessTools: { transport: 'none', allowed: [] },
      credentials: [],
    })
    expect(ctx.agentRuntimeProfiles.listRoutes()).toEqual([])
    await expect(ctx.agentRuntimeProfiles.resolveCredentials(snapshot)).resolves.toEqual({})
    expect(() => ctx.agentRuntimeProfiles.resolveRoute('missing'))
      .toThrow(expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }))
    await expect(ctx.agentRuntimeProfiles.acquire(snapshot, AbortSignal.abort('cancelled')))
      .rejects.toThrow('runtime capacity wait was cancelled')
    const abortError = new Error('caller cancelled')
    await expect(ctx.agentRuntimeProfiles.acquire(snapshot, AbortSignal.abort(abortError)))
      .rejects.toBe(abortError)
    expect(() => ctx.agentRuntimeProfiles.acquire(
      snapshot,
      new AbortController().signal,
      0,
    )).toThrow('route capacity must be a positive safe integer')
    await ctx.fiber.dispose()
  })

  it('applies resolver defaults to a direct settings-independent composition', () => {
    const ctx = new Context()
    const service = new AgentRuntimeProfiles(ctx, {
      defaultMainProfile: 'minimal',
      profiles: {
        minimal: {
          provider: 'external',
          launch: {
            executable: 'runtime',
            cwdPolicy: 'session-workspace',
          },
          permissions: {
            policy: {},
            enforcement: 'best-effort',
          },
          process: {
            startupTimeoutMs: 1,
            turnTimeoutMs: 2,
            shutdownTimeoutMs: 3,
            terminationTimeoutMs: 4,
            maxConcurrentRuns: 5,
          },
        },
        native: {
          provider: 'native',
          launch: {
            executable: 'node',
            cwdPolicy: 'session-workspace',
          },
          permissions: {
            policy: {},
            enforcement: 'required',
          },
          process: {
            startupTimeoutMs: 1,
            turnTimeoutMs: 1,
            shutdownTimeoutMs: 1,
            terminationTimeoutMs: 1,
            maxConcurrentRuns: 1,
          },
        },
      },
      subagentRoutes: {
        child: {
          runtimeProfile: 'minimal',
          maxDepth: 1,
          maxConcurrentRuns: 1,
          toolName: 'delegate',
        },
      },
    })
    expect(service.resolve()).toMatchObject({
      schemaVersion: 0,
      provider: { optionsVersion: 0, options: {} },
      launch: {
        resolution: { kind: 'search-path', paths: [] },
        args: [],
        ambientEnv: [],
        env: {},
      },
      model: { allowSessionOverride: false },
      product: {},
      permissions: { approval: 'unattended-fail-closed' },
      nativeTools: { allowed: [] },
      harnessTools: { transport: 'none', allowed: [] },
      credentials: [],
    })
    expect(service.resolve('native').provider.options).toEqual({})
    expect(service.listRoutes()).toEqual(['child'])
    expect(service.resolveRoute('child')).toMatchObject({
      id: 'child',
      mode: 'one-shot',
      profile: { profileId: 'minimal' },
    })
    const routeLess = new AgentRuntimeProfiles(new Context(), {
      defaultMainProfile: 'minimal',
      profiles: {
        minimal: {
          provider: 'external',
          launch: {
            executable: 'runtime',
            cwdPolicy: 'session-workspace',
          },
          permissions: {
            policy: {},
            enforcement: 'best-effort',
          },
          process: {
            startupTimeoutMs: 1,
            turnTimeoutMs: 1,
            shutdownTimeoutMs: 1,
            terminationTimeoutMs: 1,
            maxConcurrentRuns: 1,
          },
        },
      },
    })
    expect(routeLess.listRoutes()).toEqual([])
  })

  it('resolves a detached immutable snapshot with caller overrides and references only', async () => {
    const ctx = await harness()
    const snapshot = ctx.agentRuntimeProfiles.resolve('main', {
      model: 'session-model',
      nativeLlmProvider: 'deepseek',
      nativeMaxTokens: 8192,
      cwd: '/workspace',
    })

    expect(snapshot).toMatchObject({
      schemaVersion: 0,
      profileId: 'main',
      settingsRevision: 0,
      provider: {
        id: 'native',
        optionsVersion: 0,
        options: {
          effort: 'high',
          llmProvider: 'deepseek',
          maxTokens: 8192,
        },
      },
      launch: {
        cwd: { kind: 'fixed', path: '/workspace' },
      },
      model: {
        default: 'session-model',
        allowSessionOverride: true,
      },
      credentials: [{
        target: 'PROVIDER_API_KEY',
        credentialRef: 'RUNTIME_MAIN_KEY',
      }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret-value')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.provider.options)).toBe(true)

    await ctx.settings.update(AGENT_RUNTIME_SETTINGS_NAMESPACE, {
      profiles: {
        main: {
          ...mainProfile(),
          model: { default: 'edited-model', allowSessionOverride: true },
        },
      },
    })
    expect(ctx.agentRuntimeProfiles.resolve('main').settingsRevision).toBe(1)
    expect(ctx.agentRuntimeProfiles.resolve('main').model.default).toBe('edited-model')
    expect(snapshot.model.default).toBe('session-model')
    await ctx.fiber.dispose()
  })

  it('rejects missing profiles, invalid references, duplicate targets, and disallowed overrides', async () => {
    const ctx = await harness()
    expect(() => ctx.agentRuntimeProfiles.resolve('missing')).toThrow(
      expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }),
    )
    await ctx.fiber.dispose()

    const invalidRoute = settings({
      subagentRoutes: {
        child: {
          runtimeProfile: 'missing',
          maxDepth: 1,
          maxConcurrentRuns: 1,
          toolName: 'delegate',
        },
      },
    })
    await expect(new Context().plugin(AgentRuntimeProfiles, invalidRoute))
      .rejects.toThrow('references unknown Runtime Profile')

    const external = settings({
      profiles: {
        main: {
          ...mainProfile(),
          provider: 'external',
          model: { allowSessionOverride: false },
        },
      },
    })
    const externalCtx = new Context()
    await externalCtx.plugin(AgentRuntimeProfiles, external)
    expect(() => externalCtx.agentRuntimeProfiles.resolve('main', { model: 'override' }))
      .toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }))
    expect(() => externalCtx.agentRuntimeProfiles.resolve('main', {
      nativeLlmProvider: 'deepseek',
    })).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }))
    await externalCtx.fiber.dispose()

    const overlapping = settings({
      profiles: {
        main: {
          ...mainProfile(),
          launch: {
            ...mainProfile().launch,
            env: { PROVIDER_API_KEY: 'literal' },
          },
        },
      },
    })
    await expect(new Context().plugin(AgentRuntimeProfiles, overlapping))
      .rejects.toThrow('assigns environment target')
  })

  it('re-resolves credential values for every process start and fails when absent', async () => {
    const ctx = await harness()
    const ref = credentialRef('RUNTIME_MAIN_KEY')
    const profile = ctx.agentRuntimeProfiles.resolve()
    const credentials = ctx.credentials as MemoryCredentials

    await expect(ctx.agentRuntimeProfiles.resolveCredentials(profile))
      .rejects.toMatchObject({ code: 'PROFILE_INVALID', phase: 'prepare' })
    credentials.values.set(ref, 'first-secret')
    await expect(ctx.agentRuntimeProfiles.resolveCredentials(profile))
      .resolves.toEqual({ PROVIDER_API_KEY: 'first-secret' })
    credentials.values.set(ref, 'rotated-secret')
    await expect(ctx.agentRuntimeProfiles.resolveCredentials(profile))
      .resolves.toEqual({ PROVIDER_API_KEY: 'rotated-secret' })
    expect(JSON.stringify(profile)).not.toContain('first-secret')
    expect(JSON.stringify(profile)).not.toContain('rotated-secret')
    await ctx.fiber.dispose()

    const withoutCredentials = new Context()
    await withoutCredentials.plugin(AgentRuntimeProfiles, settings())
    await expect(withoutCredentials.agentRuntimeProfiles.resolveCredentials(
      withoutCredentials.agentRuntimeProfiles.resolve(),
    )).rejects.toMatchObject({ code: 'PROFILE_INVALID', phase: 'prepare' })
    await withoutCredentials.fiber.dispose()
  })

  it('admits capacity in cancelable FIFO order and releases leases idempotently', async () => {
    const ctx = await harness()
    const profile: RuntimeProfileSnapshot = ctx.agentRuntimeProfiles.resolve()
    const first = await ctx.agentRuntimeProfiles.acquire(profile, new AbortController().signal)
    const secondSignal = new AbortController()
    const order: string[] = []
    const second = ctx.agentRuntimeProfiles.acquire(profile, secondSignal.signal)
      .then((lease) => {
        order.push('second')
        return lease
      })
    const third = ctx.agentRuntimeProfiles.acquire(profile, new AbortController().signal)
      .then((lease) => {
        order.push('third')
        return lease
      })

    first.release()
    const secondLease = await second
    expect(order).toEqual(['second'])
    secondLease.release()
    const thirdLease = await third
    expect(order).toEqual(['second', 'third'])
    thirdLease.release()
    thirdLease.release()

    const held = await ctx.agentRuntimeProfiles.acquire(profile, new AbortController().signal)
    const cancelled = new AbortController()
    const waiting = ctx.agentRuntimeProfiles.acquire(profile, cancelled.signal)
    cancelled.abort('skip')
    await expect(waiting).rejects.toThrow('runtime capacity wait was cancelled')
    held.release()
    await ctx.fiber.dispose()
  })

  it('rejects synchronous acquisition when the profile is full', async () => {
    const ctx = await harness()
    const profile = ctx.agentRuntimeProfiles.resolve()
    const held = ctx.agentRuntimeProfiles.acquireSync(profile)
    expect(() => ctx.agentRuntimeProfiles.acquireSync(profile)).toThrow(
      expect.objectContaining<Partial<AgentRuntimeError>>({ code: 'AGENT_BUSY' }),
    )
    held.release()
    await ctx.fiber.dispose()
  })

  it.each([
    ['invalid default id', (value: AgentRuntimeProfileSettings) => { value.defaultMainProfile = 'Bad Id' }, 'must match'],
    ['missing default', (value: AgentRuntimeProfileSettings) => { value.defaultMainProfile = 'missing' }, 'is not defined'],
    ['invalid profile id', (value: AgentRuntimeProfileSettings) => {
      value.profiles['Bad Id'] = value.profiles.main!
      delete value.profiles.main
      value.defaultMainProfile = 'Bad Id'
    }, 'must match'],
    ['invalid provider id', (value: AgentRuntimeProfileSettings) => { value.profiles.main!.provider = 'Bad Id' }, 'must match'],
    ['negative schema version', (value: AgentRuntimeProfileSettings) => { value.profiles.main!.schemaVersion = -1 }, 'non-negative'],
    ['negative options version', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.providerOptionsVersion = -1
    }, 'non-negative'],
    ['empty executable', (value: AgentRuntimeProfileSettings) => { value.profiles.main!.launch.executable = '' }, 'executable'],
    ['NUL argument', (value: AgentRuntimeProfileSettings) => { value.profiles.main!.launch.args = ['bad\0arg'] }, 'arguments'],
    ['duplicate ambient', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.launch.ambientEnv = ['LANG', 'LANG']
    }, 'unique non-empty'],
    ['invalid environment', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.launch.env = { 'BAD-NAME': 'value' }
    }, 'environment name'],
    ['invalid credential ref', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.credentials = {
        env: { KEY: { credentialRef: 'bad-ref' } },
      }
    }, 'credential ref'],
    ['duplicate native tool', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.nativeTools = { allowed: ['shell', 'shell'] }
    }, 'unique non-empty'],
    ['duplicate Harness tool', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.harnessTools = { transport: 'mcp', allowed: ['todo', 'todo'] }
    }, 'unique non-empty'],
    ['tools without transport', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.harnessTools = { transport: 'none', allowed: ['todo'] }
    }, 'transport "none"'],
    ['invalid startup timeout', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.process.startupTimeoutMs = 0
    }, 'positive safe integer'],
    ['invalid turn timeout', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.process.turnTimeoutMs = 0
    }, 'positive safe integer'],
    ['invalid shutdown timeout', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.process.shutdownTimeoutMs = 0
    }, 'positive safe integer'],
    ['invalid termination timeout', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.process.terminationTimeoutMs = 0
    }, 'positive safe integer'],
    ['invalid profile capacity', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.process.maxConcurrentRuns = 0
    }, 'positive safe integer'],
    ['empty fixed cwd', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.launch.cwdPolicy = { fixed: '' }
    }, 'fixed working directory'],
    ['invalid route id', (value: AgentRuntimeProfileSettings) => {
      value.subagentRoutes = { 'Bad Id': value.subagentRoutes!.child! }
    }, 'must match'],
    ['invalid route profile id', (value: AgentRuntimeProfileSettings) => {
      value.subagentRoutes!.child!.runtimeProfile = 'Bad Id'
    }, 'must match'],
    ['invalid route depth', (value: AgentRuntimeProfileSettings) => {
      value.subagentRoutes!.child!.maxDepth = -1
    }, 'non-negative'],
    ['invalid route capacity', (value: AgentRuntimeProfileSettings) => {
      value.subagentRoutes!.child!.maxConcurrentRuns = 0
    }, 'positive safe integer'],
    ['empty route tool', (value: AgentRuntimeProfileSettings) => {
      value.subagentRoutes!.child!.toolName = ''
    }, 'unique and non-empty'],
    ['duplicate route tool', (value: AgentRuntimeProfileSettings) => {
      value.subagentRoutes!.other = {
        ...value.subagentRoutes!.child!,
        runtimeProfile: 'main',
      }
    }, 'unique and non-empty'],
  ])('rejects %s', (_label, mutate, message) => {
    const value = structuredClone(settings())
    mutate(value)
    expect(() => new AgentRuntimeProfiles(new Context(), value)).toThrow(message)
  })

  it.each([
    ['provider options', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.providerOptions = { invalid: BigInt(1) }
    }],
    ['product configuration', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.product = { invalid: BigInt(1) }
    }],
    ['permission policy', (value: AgentRuntimeProfileSettings) => {
      value.profiles.main!.permissions.policy = { invalid: BigInt(1) }
    }],
  ])('rejects non-JSON %s', (_label, mutate) => {
    const value = settings()
    mutate(value)
    expect(() => new AgentRuntimeProfiles(new Context(), value)).toThrow('lossless JSON')
  })
})
