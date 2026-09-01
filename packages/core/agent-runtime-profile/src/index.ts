/**
 * Settings-backed Runtime Profile resolution and shared capacity admission.
 *
 * @module @deepseek-ai/dsh-agent-runtime-profile
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AgentRuntimeError,
  AgentRuntimeProviderId,
  RuntimeProfileId,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  RuntimeProfileSnapshot,
  RuntimeWorkingDirectoryPolicy,
} from '@deepseek-ai/dsh-agent-runtime'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  settingsNamespace,
  type SettingsDescriptor,
  type SettingsScope,
} from '@deepseek-ai/dsh-settings'

/** Settings namespace for Runtime Profiles and runtime-backed subagent routes. */
export const AGENT_RUNTIME_SETTINGS_NAMESPACE = settingsNamespace('agent-runtime')

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Search-path executable resolution stored in one Runtime Profile. */
export interface RuntimeProfileExecutableResolution {
  /** Ordered executable search directories. */
  searchPath: string[]
}

/** Stored executable and working-directory configuration. */
export interface RuntimeProfileLaunchConfig {
  /** Executable name or path passed to the secure launcher. */
  executable: string
  /** Literal argument vector, without shell interpolation. */
  args?: string[]
  /** Whether the executable is absolute or searched in these directories. */
  resolution?: 'absolute' | RuntimeProfileExecutableResolution
  /** Working directory source for this runtime. */
  cwdPolicy: 'session-workspace' | 'parent-workspace' | {
    /** Fixed working directory. */
    fixed: string
  }
  /** Explicit ambient environment names the secure launcher may inherit. */
  ambientEnv?: string[]
  /** Literal non-secret environment entries. */
  env?: Record<string, string>
}

/** Stored model selection configuration. */
export interface RuntimeProfileModelConfig {
  /** Provider-owned default model id. */
  default?: string
  /** Whether one Session may select another model. */
  allowSessionOverride?: boolean
}

/** Stored credential reference. */
export interface RuntimeProfileCredentialConfig {
  /** Credential service reference resolved separately for each process start. */
  credentialRef: string
}

/** Stored Runtime Profile. Values are non-secret and JSON-compatible. */
export interface RuntimeProfileConfig {
  /** Registered runtime Provider id. */
  provider: string
  /** Runtime snapshot schema version accepted by the Provider. */
  schemaVersion?: number
  /** Version of the Provider-owned options object. */
  providerOptionsVersion?: number
  /** Provider-owned lossless JSON options. */
  providerOptions?: unknown
  /** Executable and working-directory policy. */
  launch: RuntimeProfileLaunchConfig
  /** Model selection policy. */
  model?: RuntimeProfileModelConfig
  /** Product-owned lossless JSON configuration. */
  product?: unknown
  /** Permission requirements the Provider and launcher must enforce. */
  permissions: {
    /** Provider-owned lossless JSON permission policy. */
    policy: unknown
    /** Whether unavailable enforcement rejects launch. */
    enforcement: 'required' | 'best-effort'
    /** Unattended approval behavior. */
    approval?: 'unattended-fail-closed'
  }
  /** Product-native tool allowlist. */
  nativeTools?: {
    /** Exact product-native tool ids allowed for the runtime. */
    allowed?: string[]
  }
  /** Harness tool-gateway policy. */
  harnessTools?: {
    /** Transport used to expose approved Harness tools. */
    transport?: 'none' | 'mcp'
    /** Exact Harness tool ids allowed through the transport. */
    allowed?: string[]
  }
  /** Credential references mapped onto process environment targets. */
  credentials?: {
    /** Environment target to credential reference mapping. */
    env?: Record<string, RuntimeProfileCredentialConfig>
  }
  /** Runtime deadlines and shared profile capacity. */
  process: {
    /** Maximum milliseconds for process startup and protocol readiness. */
    startupTimeoutMs: number
    /** Maximum milliseconds for one runtime turn. */
    turnTimeoutMs: number
    /** Maximum milliseconds for cooperative shutdown. */
    shutdownTimeoutMs: number
    /** Maximum milliseconds for forced termination and quiescence. */
    terminationTimeoutMs: number
    /** Maximum live runs sharing this profile id. */
    maxConcurrentRuns: number
  }
}

/** Stored one-shot subagent route backed by a Runtime Profile. */
export interface RuntimeSubagentRouteConfig {
  /** Runtime Profile resolved for each new child run. */
  runtimeProfile: string
  /** V1 route mode. */
  mode?: 'one-shot'
  /** Maximum absolute delegation depth accepted by this route. */
  maxDepth: number
  /** Route-local capacity ceiling; cannot raise profile capacity. */
  maxConcurrentRuns: number
  /** Model-facing delegation tool name. */
  toolName: string
}

/** Settings-owned Runtime Profile and route document. */
export interface AgentRuntimeProfileSettings {
  /** Profile selected when AgentOptions omits runtimeProfile. */
  defaultMainProfile: string
  /** Named stored Runtime Profiles. */
  profiles: Record<string, RuntimeProfileConfig>
  /** Named one-shot subagent routes. */
  subagentRoutes?: Record<string, RuntimeSubagentRouteConfig>
}

/** Caller overrides resolved before a new snapshot is returned. */
export interface RuntimeProfileOverrides {
  readonly model?: string
  readonly nativeLlmProvider?: string
  readonly nativeMaxTokens?: number
  readonly cwd?: string
}

/** Resolved route with its immutable effective Runtime Profile snapshot. */
export interface ResolvedRuntimeSubagentRoute {
  readonly id: string
  readonly mode: 'one-shot'
  readonly maxDepth: number
  readonly maxConcurrentRuns: number
  readonly toolName: string
  readonly profile: RuntimeProfileSnapshot
}

/** One held profile or route capacity slot. */
export interface RuntimeCapacityLease {
  /** Release the slot once the runtime reaches complete quiescence. */
  release(): void
}

/** Credential values resolved for one process start and never retained by this service. */
export type ResolvedRuntimeCredentials = Readonly<Record<string, string>>

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimeProfiles: AgentRuntimeProfiles
  }
}

interface CapacityWaiter {
  readonly limit: number
  readonly resolve: (lease: RuntimeCapacityLease) => void
  readonly reject: (reason: unknown) => void
  readonly signal: AbortSignal
  readonly abort: () => void
}

interface CapacityState {
  active: number
  readonly waiting: CapacityWaiter[]
}

/** Shared cancelable FIFO capacity keyed by Runtime Profile id. */
class RuntimeProfileCapacity {
  private readonly states = new Map<string, CapacityState>()

  acquireSync(id: string, limit: number): RuntimeCapacityLease {
    const state = this.states.get(id) ?? { active: 0, waiting: [] }
    this.states.set(id, state)
    if (state.waiting.length > 0 || state.active >= limit) {
      throw new AgentRuntimeError({
        code: 'AGENT_BUSY',
        phase: 'prepare',
        message: `Runtime Profile "${id}" has no available capacity`,
      })
    }
    state.active += 1
    return this.lease(id, state)
  }

  acquire(id: string, limit: number, signal: AbortSignal): Promise<RuntimeCapacityLease> {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    const state = this.states.get(id) ?? { active: 0, waiting: [] }
    this.states.set(id, state)
    if (state.waiting.length === 0 && state.active < limit) {
      state.active += 1
      return Promise.resolve(this.lease(id, state))
    }
    return new Promise<RuntimeCapacityLease>((resolve, reject) => {
      const waiter: CapacityWaiter = {
        limit,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = state.waiting.indexOf(waiter)
          /* v8 ignore else -- the listener is removed whenever dequeue removes this waiter. */
          if (index >= 0) state.waiting.splice(index, 1)
          reject(abortReason(signal))
          this.drain(id, state)
        },
      }
      state.waiting.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
    })
  }

  private lease(id: string, state: CapacityState): RuntimeCapacityLease {
    let held = true
    return {
      release: () => {
        if (!held) return
        held = false
        state.active -= 1
        this.drain(id, state)
      },
    }
  }

  private drain(id: string, state: CapacityState): void {
    while (state.waiting.length > 0) {
      const next = state.waiting[0] as CapacityWaiter
      /* v8 ignore next -- abort dispatch synchronously removes a queued waiter. */
      if (next.signal.aborted) {
        state.waiting.shift()
        next.signal.removeEventListener('abort', next.abort)
        next.reject(abortReason(next.signal))
        continue
      }
      if (state.active >= next.limit) break
      state.waiting.shift()
      next.signal.removeEventListener('abort', next.abort)
      state.active += 1
      next.resolve(this.lease(id, state))
    }
    if (state.active === 0 && state.waiting.length === 0) this.states.delete(id)
  }
}

/** Normalize an AbortSignal reason without losing an Error supplied by the caller. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('runtime capacity wait was cancelled', { cause: signal.reason })
}

/** Assert a positive safe integer and return it. */
function positiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

/** Assert a non-negative safe integer and return it. */
function nonNegativeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

/** Assert an identifier used as a durable profile or route key. */
function profileIdentifier(label: string, value: string): string {
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} "${value}" must match ${String(PROFILE_ID_PATTERN)}`)
  }
  return value
}

/** Assert an environment name and return it. */
function environmentName(label: string, value: string): string {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new TypeError(`${label} "${value}" must match ${String(ENV_NAME_PATTERN)}`)
  }
  return value
}

/** Reject duplicates in a user-authored exact allowlist. */
function uniqueStrings(label: string, values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.map((value) => {
    if (value.length === 0 || seen.has(value)) {
      throw new TypeError(`${label} must contain unique non-empty strings`)
    }
    seen.add(value)
    return value
  })
}

/** Snapshot a provider-owned JSON settings value. */
function json(label: string, value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError(`${label} must be lossless JSON`)
  return snapshot as JsonValue
}

/** Convert the stored working-directory selection to the runtime snapshot form. */
function cwdPolicy(
  configured: RuntimeProfileLaunchConfig['cwdPolicy'],
  override: string | undefined,
): RuntimeWorkingDirectoryPolicy {
  if (override !== undefined) return { kind: 'fixed', path: override }
  if (typeof configured === 'string') return { kind: configured }
  return { kind: 'fixed', path: configured.fixed }
}

/** Validate a full settings document, including cross-profile route references. */
function validateSettings(settings: AgentRuntimeProfileSettings): void {
  profileIdentifier('default Runtime Profile id', settings.defaultMainProfile)
  if (!(settings.defaultMainProfile in settings.profiles)) {
    throw new TypeError(`default Runtime Profile "${settings.defaultMainProfile}" is not defined`)
  }
  for (const [id, profile] of Object.entries(settings.profiles)) validateProfile(id, profile)
  const toolNames = new Set<string>()
  for (const [id, route] of Object.entries(settings.subagentRoutes ?? {})) {
    profileIdentifier('subagent route id', id)
    profileIdentifier('subagent route Runtime Profile id', route.runtimeProfile)
    if (!(route.runtimeProfile in settings.profiles)) {
      throw new TypeError(`subagent route "${id}" references unknown Runtime Profile "${route.runtimeProfile}"`)
    }
    nonNegativeInteger(`subagent route "${id}" maxDepth`, route.maxDepth)
    positiveInteger(`subagent route "${id}" maxConcurrentRuns`, route.maxConcurrentRuns)
    if (route.toolName.length === 0 || toolNames.has(route.toolName)) {
      throw new TypeError('runtime subagent route tool names must be unique and non-empty')
    }
    toolNames.add(route.toolName)
  }
}

/** Validate one stored Runtime Profile before it can become a snapshot. */
function validateProfile(id: string, profile: RuntimeProfileConfig): void {
  profileIdentifier('Runtime Profile id', id)
  profileIdentifier('runtime provider id', profile.provider)
  nonNegativeInteger(`Runtime Profile "${id}" schemaVersion`, profile.schemaVersion ?? 0)
  nonNegativeInteger(
    `Runtime Profile "${id}" providerOptionsVersion`,
    profile.providerOptionsVersion ?? 0,
  )
  if (profile.launch.executable.length === 0 || profile.launch.executable.includes('\0')) {
    throw new TypeError(`Runtime Profile "${id}" executable must be non-empty and contain no NUL`)
  }
  for (const arg of profile.launch.args ?? []) {
    if (arg.includes('\0')) throw new TypeError(`Runtime Profile "${id}" arguments must contain no NUL`)
  }
  if (typeof profile.launch.cwdPolicy === 'object'
    && profile.launch.cwdPolicy.fixed.length === 0) {
    throw new TypeError('fixed working directory must be non-empty')
  }
  const ambient = uniqueStrings(`Runtime Profile "${id}" ambientEnv`, profile.launch.ambientEnv ?? [])
  const literals = Object.keys(profile.launch.env ?? {})
  const credentialTargets = Object.keys(profile.credentials?.env ?? {})
  for (const name of [...ambient, ...literals, ...credentialTargets]) {
    environmentName(`Runtime Profile "${id}" environment name`, name)
  }
  const assigned = new Set<string>()
  for (const name of [...literals, ...credentialTargets]) {
    if (assigned.has(name)) {
      throw new TypeError(`Runtime Profile "${id}" assigns environment target "${name}" more than once`)
    }
    assigned.add(name)
  }
  for (const entry of Object.values(profile.credentials?.env ?? {})) {
    credentialRef(entry.credentialRef)
  }
  uniqueStrings(`Runtime Profile "${id}" native tools`, profile.nativeTools?.allowed ?? [])
  const harnessTools = uniqueStrings(
    `Runtime Profile "${id}" Harness tools`,
    profile.harnessTools?.allowed ?? [],
  )
  if ((profile.harnessTools?.transport ?? 'none') === 'none' && harnessTools.length > 0) {
    throw new TypeError(`Runtime Profile "${id}" cannot allow Harness tools with transport "none"`)
  }
  positiveInteger(`Runtime Profile "${id}" startupTimeoutMs`, profile.process.startupTimeoutMs)
  positiveInteger(`Runtime Profile "${id}" turnTimeoutMs`, profile.process.turnTimeoutMs)
  positiveInteger(`Runtime Profile "${id}" shutdownTimeoutMs`, profile.process.shutdownTimeoutMs)
  positiveInteger(
    `Runtime Profile "${id}" terminationTimeoutMs`,
    profile.process.terminationTimeoutMs,
  )
  positiveInteger(
    `Runtime Profile "${id}" maxConcurrentRuns`,
    profile.process.maxConcurrentRuns,
  )
  json(`Runtime Profile "${id}" provider options`, profile.providerOptions ?? {})
  json(`Runtime Profile "${id}" product configuration`, profile.product ?? {})
  json(`Runtime Profile "${id}" permission policy`, profile.permissions.policy)
}

/** Settings-backed profile resolver shared by the Agent Router and subagent routes. */
export class AgentRuntimeProfiles extends Service {
  static Config: z<AgentRuntimeProfileSettings> = z.object({
    defaultMainProfile: z.string().required(),
    profiles: z.dict(z.object({
      provider: z.string().required(),
      schemaVersion: z.number().default(0),
      providerOptionsVersion: z.number().default(0),
      providerOptions: z.any().default({}),
      launch: z.object({
        executable: z.string().required(),
        args: z.array(z.string()).default([]),
        resolution: z.union([
          z.const('absolute' as const),
          z.object({ searchPath: z.array(z.string()).required() }),
        ]).default({ searchPath: [] }),
        cwdPolicy: z.union([
          z.const('session-workspace' as const),
          z.const('parent-workspace' as const),
          z.object({ fixed: z.string().required() }),
        ]).required(),
        ambientEnv: z.array(z.string()).default([]),
        env: z.dict(z.string()).default({}),
      }).required(),
      model: z.object({
        default: z.string(),
        allowSessionOverride: z.boolean().default(false),
      }).default(undefined as unknown as { default: string; allowSessionOverride: boolean }),
      product: z.any().default({}),
      permissions: z.object({
        policy: z.any().required(),
        enforcement: z.union(['required', 'best-effort'] as const).required(),
        approval: z.const('unattended-fail-closed' as const).default('unattended-fail-closed'),
      }).required(),
      nativeTools: z.object({
        allowed: z.array(z.string()).default([]),
      }).default({ allowed: [] }),
      harnessTools: z.object({
        transport: z.union(['none', 'mcp'] as const).default('none'),
        allowed: z.array(z.string()).default([]),
      }).default({ transport: 'none', allowed: [] }),
      credentials: z.object({
        env: z.dict(z.object({
          credentialRef: z.string().required(),
        })).default({}),
      }).default({ env: {} }),
      process: z.object({
        startupTimeoutMs: z.number().required(),
        turnTimeoutMs: z.number().required(),
        shutdownTimeoutMs: z.number().required(),
        terminationTimeoutMs: z.number().required(),
        maxConcurrentRuns: z.number().required(),
      }).required(),
    })).required(),
    subagentRoutes: z.dict(z.object({
      runtimeProfile: z.string().required(),
      mode: z.const('one-shot' as const).default('one-shot'),
      maxDepth: z.number().required(),
      maxConcurrentRuns: z.number().required(),
      toolName: z.string().required(),
    })).default({}),
  })

  private settings: SettingsScope<AgentRuntimeProfileSettings> | undefined
  private readonly base: AgentRuntimeProfileSettings
  private readonly runtime: { ctx: Context }
  private readonly capacity = new RuntimeProfileCapacity()
  private readonly settingsBinding: ReturnType<Context['inject']>

  constructor(ctx: Context, config: AgentRuntimeProfileSettings) {
    super(ctx, 'agentRuntimeProfiles')
    validateSettings(config)
    this.base = structuredClone(config)
    this.runtime = { ctx }
    this.settingsBinding = ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        AGENT_RUNTIME_SETTINGS_NAMESPACE,
        AgentRuntimeProfileSettingsSchema,
        { base: this.base, validate: validateSettings },
      )
      settingsCtx.effect(() => () => {
        this.settings = undefined
      }, 'agentRuntimeProfiles.settings()')
    })
  }

  async *[Service.init](): AsyncGenerator<void, void, void> {
    await this.settingsBinding
  }

  /**
   * Resolve one complete immutable profile for a new runtime.
   * @param id - profile id, or the current default when omitted.
   * @param overrides - caller values resolved into the returned snapshot.
   * @returns a detached non-secret effective snapshot.
   * @throws {AgentRuntimeError} when the profile is absent or invalid.
   */
  resolve(id?: string, overrides: RuntimeProfileOverrides = {}): RuntimeProfileSnapshot {
    const settings = this.current
    const wanted = id ?? settings.defaultMainProfile
    const profile = settings.profiles[wanted]
    if (profile === undefined) {
      throw new AgentRuntimeError({
        code: 'PROFILE_NOT_FOUND',
        phase: 'profile',
        message: `Runtime Profile "${wanted}" is not configured`,
      })
    }
    return this.snapshot(wanted, profile, this.settingsRevision(), overrides)
  }

  /**
   * Resolve one configured one-shot subagent route.
   * @param id - route id.
   * @returns the immutable route and profile snapshot.
   * @throws {AgentRuntimeError} when the route or profile is absent.
   */
  resolveRoute(id: string): ResolvedRuntimeSubagentRoute {
    const route = this.current.subagentRoutes?.[id]
    if (route === undefined) {
      throw new AgentRuntimeError({
        code: 'PROFILE_NOT_FOUND',
        phase: 'profile',
        message: `runtime subagent route "${id}" is not configured`,
      })
    }
    return deepFreeze({
      id,
      mode: route.mode ?? 'one-shot',
      maxDepth: route.maxDepth,
      maxConcurrentRuns: route.maxConcurrentRuns,
      toolName: route.toolName,
      profile: this.resolve(route.runtimeProfile),
    })
  }

  /**
   * List configured runtime-backed subagent route ids in settings order.
   * @returns detached route ids.
   */
  listRoutes(): string[] {
    return Object.keys(this.current.subagentRoutes ?? {})
  }

  /**
   * Wait for a shared profile slot in cancelable FIFO order.
   * @param profile - immutable snapshot fixing the profile capacity.
   * @param signal - cancellation while waiting.
   * @param upperLimit - optional route limit; cannot raise profile capacity.
   * @returns a lease held until runtime quiescence and cleanup complete.
   */
  acquire(
    profile: RuntimeProfileSnapshot,
    signal: AbortSignal,
    upperLimit?: number,
  ): Promise<RuntimeCapacityLease> {
    const limit = upperLimit === undefined
      ? profile.capacity.maxConcurrentRuns
      : Math.min(profile.capacity.maxConcurrentRuns, positiveInteger('route capacity', upperLimit))
    return this.capacity.acquire(profile.profileId, limit, signal)
  }

  /**
   * Acquire an immediately available slot for the Native synchronous entry.
   * @param profile - immutable snapshot fixing profile capacity.
   * @returns a lease held until Native runtime quiescence.
   * @throws {AgentRuntimeError} code `AGENT_BUSY` rather than queueing.
   */
  acquireSync(profile: RuntimeProfileSnapshot): RuntimeCapacityLease {
    return this.capacity.acquireSync(profile.profileId, profile.capacity.maxConcurrentRuns)
  }

  /**
   * Resolve every credential reference for one process start.
   * @param profile - pinned profile whose references are read.
   * @returns exact target-to-value entries for the launcher.
   * @throws {AgentRuntimeError} before process creation when a reference is missing.
   */
  async resolveCredentials(
    profile: RuntimeProfileSnapshot,
  ): Promise<ResolvedRuntimeCredentials> {
    if (profile.credentials.length === 0) return deepFreeze({})
    const credentials = this.runtime.ctx.get('credentials')
    if (credentials === undefined) {
      throw new AgentRuntimeError({
        code: 'PROFILE_INVALID',
        phase: 'prepare',
        message: `Runtime Profile "${profile.profileId}" requires the credentials service`,
        providerId: profile.provider.id,
      })
    }
    const values: Record<string, string> = {}
    for (const mapping of profile.credentials) {
      const resolved = await credentials.resolve(mapping.credentialRef)
      if (resolved === undefined) {
        throw new AgentRuntimeError({
          code: 'PROFILE_INVALID',
          phase: 'prepare',
          message: `Runtime Profile "${profile.profileId}" credential "${mapping.credentialRef}" is not configured`,
          providerId: profile.provider.id,
        })
      }
      values[mapping.target] = resolved.value
    }
    return deepFreeze(values)
  }

  /** Build the exact detached snapshot after validation and override resolution. */
  private snapshot(
    id: string,
    profile: RuntimeProfileConfig,
    settingsRevision: number,
    overrides: RuntimeProfileOverrides,
  ): RuntimeProfileSnapshot {
    const providerId = AgentRuntimeProviderId(profile.provider)
    const native = providerId === 'native'
    if (!native && (overrides.nativeLlmProvider !== undefined || overrides.nativeMaxTokens !== undefined)) {
      throw new AgentRuntimeError({
        code: 'PROFILE_INVALID',
        phase: 'profile',
        message: `Runtime Profile "${id}" does not accept Native LLM overrides`,
        providerId,
      })
    }
    if (overrides.model !== undefined && profile.model?.allowSessionOverride !== true) {
      throw new AgentRuntimeError({
        code: 'PROFILE_INVALID',
        phase: 'profile',
        message: `Runtime Profile "${id}" does not allow a Session model override`,
        providerId,
      })
    }
    if (overrides.nativeMaxTokens !== undefined) {
      positiveInteger('agent maxTokens', overrides.nativeMaxTokens)
    }
    const configuredResolution = profile.launch.resolution ?? { searchPath: [] }
    const providerOptions = json(
      `Runtime Profile "${id}" provider options`,
      native
        ? {
          ...(profile.providerOptions ?? {}),
          ...(overrides.nativeLlmProvider === undefined
            ? {}
            : { llmProvider: overrides.nativeLlmProvider }),
          ...(overrides.nativeMaxTokens === undefined ? {} : { maxTokens: overrides.nativeMaxTokens }),
        }
        : profile.providerOptions ?? {},
    )
    const credentials = Object.entries(profile.credentials?.env ?? {}).map(
      ([target, entry]) => ({
        target,
        credentialRef: credentialRef(entry.credentialRef),
      }),
    )
    const model = overrides.model ?? profile.model?.default
    return deepFreeze({
      schemaVersion: profile.schemaVersion ?? 0,
      profileId: RuntimeProfileId(id),
      settingsRevision,
      provider: {
        id: providerId,
        optionsVersion: profile.providerOptionsVersion ?? 0,
        options: providerOptions,
      },
      launch: {
        executable: profile.launch.executable,
        resolution: configuredResolution === 'absolute'
          ? { kind: 'absolute' as const }
          : { kind: 'search-path' as const, paths: [...configuredResolution.searchPath] },
        args: [...profile.launch.args ?? []],
        cwd: cwdPolicy(profile.launch.cwdPolicy, overrides.cwd),
        ambientEnv: [...profile.launch.ambientEnv ?? []],
        env: { ...profile.launch.env ?? {} },
      },
      model: {
        ...(model === undefined ? {} : { default: model }),
        allowSessionOverride: profile.model?.allowSessionOverride ?? false,
      },
      product: json(`Runtime Profile "${id}" product configuration`, profile.product ?? {}),
      permissions: {
        policy: json(`Runtime Profile "${id}" permission policy`, profile.permissions.policy),
        enforcement: profile.permissions.enforcement,
        approval: profile.permissions.approval ?? 'unattended-fail-closed',
      },
      nativeTools: { allowed: [...profile.nativeTools?.allowed ?? []] },
      harnessTools: {
        transport: profile.harnessTools?.transport ?? 'none',
        allowed: [...profile.harnessTools?.allowed ?? []],
      },
      credentials,
      deadlines: {
        startupMs: profile.process.startupTimeoutMs,
        turnMs: profile.process.turnTimeoutMs,
        shutdownMs: profile.process.shutdownTimeoutMs,
        terminationMs: profile.process.terminationTimeoutMs,
      },
      capacity: { maxConcurrentRuns: profile.process.maxConcurrentRuns },
    })
  }

  /** Read the namespace's monotonic raw-section revision at resolution time. */
  private settingsRevision(): number {
    const settings = this.runtime.ctx.get('settings')
    if (settings === undefined || this.settings === undefined) return 0
    const descriptor: SettingsDescriptor | undefined = settings
      .describe()
      .find(candidate => candidate.ns === AGENT_RUNTIME_SETTINGS_NAMESPACE)
    /* v8 ignore next -- this.settings exists only while its exact registration is mounted. */
    return (descriptor as SettingsDescriptor).revision
  }

  /** Current Settings-backed value, or composition base without a Settings provider. */
  private get current(): AgentRuntimeProfileSettings {
    return this.settings?.get() ?? this.base
  }
}

/** Schemastery schema for the settings-owned document. */
export const AgentRuntimeProfileSettingsSchema = AgentRuntimeProfiles.Config

export default AgentRuntimeProfiles
