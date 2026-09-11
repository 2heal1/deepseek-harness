/** Runtime Profile control-plane projection, writes, probes, and failure mapping. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry, {
  AgentRuntimeProviderId,
  type AgentRuntimeProvider,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeProfiles, {
  type AgentRuntimeProfileSettings,
} from '@deepseek-ai/dsh-agent-runtime-profile'
import CredentialProvider, {
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import SessionStore from '@deepseek-ai/dsh-session'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest, type RpcResponse } from '../src/api/index.ts'

const DEFAULTS = {
  defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
  cwd: '/tmp',
}

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`runtime-profile-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectError<T>(response: RpcResponse<T>, code: string): void {
  expect(response.result).toMatchObject({ ok: false, error: { code } })
}

function profile(provider = 'external', schemaVersion = 0) {
  return {
    provider,
    schemaVersion,
    providerOptionsVersion: 0,
    providerOptions: {},
    launch: {
      executable: '/usr/bin/external',
      args: [],
      resolution: 'absolute' as const,
      cwdPolicy: 'session-workspace' as const,
      ambientEnv: [],
      env: {},
    },
    model: { default: 'external-model', allowSessionOverride: false },
    product: {},
    permissions: {
      policy: {},
      enforcement: 'required' as const,
      approval: 'unattended-fail-closed' as const,
    },
    nativeTools: { allowed: [] },
    harnessTools: { transport: 'none' as const, allowed: [] },
    credentials: {
      env: { API_KEY: { credentialRef: 'EXTERNAL_API_KEY' } },
    },
    process: {
      startupTimeoutMs: 1,
      turnTimeoutMs: 2,
      shutdownTimeoutMs: 3,
      terminationTimeoutMs: 4,
      maxConcurrentRuns: 1,
    },
  }
}

function configuration(): AgentRuntimeProfileSettings {
  return {
    defaultMainProfile: 'main',
    profiles: {
      main: profile(),
      unavailable: profile('missing'),
      incompatible: profile('external', 1),
    },
    subagentRoutes: {
      child: {
        runtimeProfile: 'main',
        mode: 'one-shot',
        maxDepth: 2,
        maxConcurrentRuns: 1,
        toolName: 'delegate_child',
      },
    },
  }
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private readonly stored: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class MemoryCredentials extends CredentialProvider {
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({
      configured: ref === ('EXTERNAL_API_KEY' as CredentialRef),
      source: 'memory',
      writable: true,
    })
  }

  set(): Promise<void> {
    return Promise.resolve()
  }

  unset(): Promise<void> {
    return Promise.resolve()
  }
}

async function harness(options: {
  settings?: boolean
  credentials?: boolean
  providerVersions?: readonly number[]
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRuntimeRegistry)
  if (options.settings !== false) await ctx.plugin(MemorySettings)
  if (options.credentials !== false) await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AgentRuntimeProfiles, configuration())
  const probe = vi.fn<AgentRuntimeProvider['probe']>((input) => {
    if (input.signal.aborted) return Promise.reject(new Error('probe cancelled'))
    return Promise.resolve({
      productVersion: '1.2.3',
      protocolVersion: 'v1',
      capabilities: [{ id: 'runtimeActivity' }],
      permissionEnforcement: 'enforced',
      details: { profileId: input.profile.profileId },
    })
  })
  ctx.agentRuntimes.registerProvider({
    id: AgentRuntimeProviderId('external'),
    profileSnapshotVersions: options.providerVersions ?? [0],
    probe,
    prepare: () => Promise.reject(new Error('not used')),
  })
  return {
    api: createApiProxy(ctx, DEFAULTS),
    ctx,
    probe,
  }
}

describe('runtimeProfile control plane', () => {
  it('separates the safe catalog from the complete value-free editor document', async () => {
    const { api } = await harness()
    const catalog = expectOk(await api.runtimeProfiles.catalog(request({})))
    expect(catalog).toEqual({
      profiles: [
        {
          id: 'main', provider: 'external', model: 'external-model', isDefault: true,
          providerAvailable: true, schemaCompatible: true,
        },
        {
          id: 'unavailable', provider: 'missing', model: 'external-model', isDefault: false,
          providerAvailable: false, schemaCompatible: false,
        },
        {
          id: 'incompatible', provider: 'external', model: 'external-model', isDefault: false,
          providerAvailable: true, schemaCompatible: false,
        },
      ],
      routes: [{ id: 'child', runtimeProfile: 'main', toolName: 'delegate_child' }],
    })
    expect(JSON.stringify(catalog)).not.toContain('/usr/bin/external')
    expect(JSON.stringify(catalog)).not.toContain('EXTERNAL_API_KEY')

    const document = expectOk(await api.runtimeProfiles.describe(request({})))
    expect(document).toMatchObject({
      revision: 0,
      writable: true,
      defaultMainProfile: 'main',
      credentialStatus: {
        main: { API_KEY: true },
        unavailable: { API_KEY: true },
        incompatible: { API_KEY: true },
      },
    })
    expect(document.profiles.main?.credentials?.env?.API_KEY)
      .toEqual({ credentialRef: 'EXTERNAL_API_KEY' })
    expect(JSON.stringify(document)).not.toContain('secret-value')
  })

  it('writes profiles, routes, and defaults through one revision-fenced document', async () => {
    const { api } = await harness()
    let document = expectOk(await api.runtimeProfiles.describe(request({})))

    document = expectOk(await api.runtimeProfiles.save(request({
      profileId: 'second',
      profile: profile(),
      expectedRevision: document.revision,
    })))
    expect(document.profiles.second).toBeDefined()

    document = expectOk(await api.runtimeProfiles.saveRoute(request({
      routeId: 'second-child',
      route: {
        runtimeProfile: 'second',
        mode: 'one-shot',
        maxDepth: 1,
        maxConcurrentRuns: 2,
        toolName: 'delegate_second',
      },
      expectedRevision: document.revision,
    })))
    expect(document.subagentRoutes['second-child']?.runtimeProfile).toBe('second')

    const referenced = await api.runtimeProfiles.remove(request({
      profileId: 'second',
      expectedRevision: document.revision,
    }))
    expectError(referenced, 'runtime-profile-error')

    document = expectOk(await api.runtimeProfiles.setDefault(request({
      profileId: 'second',
      expectedRevision: document.revision,
    })))
    expect(document.defaultMainProfile).toBe('second')
    document = expectOk(await api.runtimeProfiles.setDefault(request({
      profileId: 'main',
      expectedRevision: document.revision,
    })))
    expect(document.defaultMainProfile).toBe('main')

    const stale = await api.runtimeProfiles.removeRoute(request({
      routeId: 'child',
      expectedRevision: 0,
    }))
    expectError(stale, 'settings-conflict')

    document = expectOk(await api.runtimeProfiles.removeRoute(request({
      routeId: 'second-child',
      expectedRevision: document.revision,
    })))
    expect(document.subagentRoutes['second-child']).toBeUndefined()
    document = expectOk(await api.runtimeProfiles.remove(request({
      profileId: 'second',
      expectedRevision: document.revision,
    })))
    expect(document.profiles.second).toBeUndefined()
  })

  it('validates the complete document before persisting an invalid deletion', async () => {
    const { api } = await harness()
    let document = expectOk(await api.runtimeProfiles.describe(request({})))
    document = expectOk(await api.runtimeProfiles.save(request({
      profileId: 'temporary',
      profile: profile(),
      expectedRevision: document.revision,
    })))
    document = expectOk(await api.runtimeProfiles.saveRoute(request({
      routeId: 'temporary-child',
      route: {
        runtimeProfile: 'temporary',
        maxDepth: 1,
        maxConcurrentRuns: 1,
        toolName: 'delegate_temporary',
      },
      expectedRevision: document.revision,
    })))
    const response = await api.runtimeProfiles.remove(request({
      profileId: 'temporary',
      expectedRevision: document.revision,
    }))
    expectError(response, 'runtime-profile-error')
    expect(expectOk(await api.runtimeProfiles.describe(request({}))).profiles.temporary).toBeDefined()
  })

  it('probes a compatible provider and reports unavailable and incompatible providers', async () => {
    const { api, probe } = await harness()
    expect(expectOk(await api.runtimeProfiles.probe(
      request({ profileId: 'main' }),
      new AbortController().signal,
    ))).toMatchObject({
      productVersion: '1.2.3',
      permissionEnforcement: 'enforced',
    })
    expect(probe).toHaveBeenCalledOnce()

    expectError(await api.runtimeProfiles.probe(
      request({ profileId: 'unavailable' }),
      new AbortController().signal,
    ), 'runtime-profile-error')
    expectError(await api.runtimeProfiles.probe(
      request({ profileId: 'incompatible' }),
      new AbortController().signal,
    ), 'runtime-profile-error')
  })

  it('maps an aborted probe and unavailable services without exposing internals', async () => {
    const { api } = await harness()
    const aborted = new AbortController()
    aborted.abort()
    expectError(await api.runtimeProfiles.probe(
      request({ profileId: 'main' }),
      aborted.signal,
    ), 'cancelled')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const missing = createApiProxy(ctx, DEFAULTS)
    expectError(await missing.runtimeProfiles.catalog(request({})), 'runtime-profile-error')
    expectError(await missing.runtimeProfiles.describe(request({})), 'runtime-profile-error')
    expectError(await missing.runtimeProfiles.save(request({
      profileId: 'main',
      profile: profile(),
      expectedRevision: 0,
    })), 'internal')
  })

  it('reports read-only configuration and unknown credential status without providers', async () => {
    const { api } = await harness({ settings: false, credentials: false })
    expect(expectOk(await api.runtimeProfiles.describe(request({})))).toMatchObject({
      writable: false,
      credentialStatus: {
        main: { API_KEY: null },
      },
    })
  })
})
