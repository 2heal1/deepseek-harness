/**
 * Native agent runtime Provider backed by the Harness React loop.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeError,
  AgentRuntimeProviderId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeCapabilities,
  AgentRuntimePrepareRequest,
  AgentRuntimeProbeRequest,
  AgentRuntimeProbeResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderId as AgentRuntimeProviderIdType,
  AgentRuntimeSubmissionRequest,
  AgentRuntimeSubmissionResult,
  PreparedAgentRuntime,
  SubmissionId,
} from '@deepseek-ai/dsh-agent-runtime'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent-runtime-router'
import { ReactLoopDriver } from './agent.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'

/** Stable Provider identity selected by the F2 Router composition. */
export const NATIVE_AGENT_RUNTIME_PROVIDER_ID = AgentRuntimeProviderId('native')

/** Native optional operations backed by the current loop. */
const NATIVE_CAPABILITIES: AgentRuntimeCapabilities = snapshotAgentRuntimeCapabilities([
  { id: 'continuation' },
  { id: 'steering' },
  { id: 'queuedInputRead' },
  { id: 'queuedInputMutation' },
  { id: 'injection' },
  { id: 'maintenance' },
  { id: 'imageInput' },
  { id: 'modelOverride' },
  { id: 'approvals' },
  { id: 'harnessTools' },
  { id: 'resume' },
  { id: 'coldResume' },
])

/** Fiber states that cannot prepare another Native runtime. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/** Provider ownership: prepared runtimes plus declarative startup work. */
class NativeOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly runtimes = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()

  constructor(private readonly fiber: Fiber) {}

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  trackRuntime(dispose: () => Promise<void>): () => void {
    this.runtimes.add(dispose)
    return () => { this.runtimes.delete(dispose) }
  }

  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    const forget = (): void => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  async waitWhileActive(job: Promise<void>): Promise<void> {
    await Promise.race([job, this.inactive.promise])
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('Native agent runtime provider is not active'))
    this.inactive.resolve()
    await Promise.all([
      ...[...this.runtimes].map(dispose => dispose()),
      ...this.startupTasks,
    ])
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    /**
     * Launcher-owned exact session identities for configured agents, keyed by
     * the agent's config id.
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * A declarative agent entry failed before it could publish a live agent.
     * @param payload.sessionId - exact shared Agent and Session identity.
     * @param payload.error - preparation, setup, or publication failure.
     * @mode emit
     */
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/** One launcher-selected session identity for a configured Agent. */
export interface LauncherAgentIdentity {
  /** Exact session identity to create or resume. */
  id: SessionId
  /** Resume persisted history instead of creating a fresh Session. */
  resume: boolean
}

/** Launcher-selected identities keyed by configured Agent id. */
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/** Context key populated by launchers before Loader entries mount. */
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/** Settings namespace carrying Native tool-call parallelism. */
export const AGENT_LOOP_SETTINGS_NAMESPACE = settingsNamespace('agent-loop')

/** User-owned Native loop settings. */
export interface AgentLoopSettings {
  /** Maximum parallel-safe calls in flight per Agent step. */
  maxParallelToolCalls: number
}

/** Agent-loop settings schema. */
export const AGENT_LOOP_SETTINGS_SCHEMA: z<AgentLoopSettings> = z.object({
  maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
})

/** Native Provider plugin configuration. */
export interface Config {
  /** Maximum parallel-safe calls in flight per Agent step. */
  maxParallelToolCalls?: number
  /** Native Agents created or resumed at plugin startup. */
  agents: (AgentOptions & {
    /** Stable config label used when a fresh identity must be minted. */
    id: string
    /** Optional stable fresh-or-resume identity. */
    sessionId?: SessionId
    /** Optional workspace for a fresh Session. */
    cwd?: string
    /** Existing persisted Session to resume. */
    resumeSessionId?: SessionId
  })[]
}

type ResolvedConfig = Config & { maxParallelToolCalls: number }

/** Apply launcher-owned identities over configured entries. */
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** Resolve and validate the Native scheduler cap. */
function resolveMaxParallelToolCalls(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return resolved
}

/** Reject an output-token cap that cannot be represented on the model wire. */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/** Validate configured Session identity ownership. */
function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    exactIdentities.set(exactIdentity, id)
  }
}

/** Native runtime handle over one React loop driver. */
class NativePreparedRuntime implements PreparedAgentRuntime {
  readonly runtimeId
  readonly capabilities = NATIVE_CAPABILITIES
  readonly initialFacts
  readonly agentDriver: ReactLoopDriver
  private disposing: Promise<void> | undefined
  private disposed = false
  private readonly release: () => void

  constructor(
    request: AgentRuntimePrepareRequest,
    driver: ReactLoopDriver,
    private readonly agent: Agent,
    ownership: NativeOwnership,
  ) {
    this.runtimeId = request.runtimeId
    this.agentDriver = driver
    this.initialFacts = snapshotAgentRuntimeFacts({
      runtimeId: request.runtimeId,
      providerId: NATIVE_AGENT_RUNTIME_PROVIDER_ID,
      capabilities: NATIVE_CAPABILITIES,
      phase: 'ready',
      product: { value: 'DeepSeek Harness Native', source: 'profile' },
      protocol: { value: 'dsh-agent-loop', source: 'profile' },
    })
    this.release = ownership.trackRuntime(() => this.dispose())
  }

  async submit(request: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult> {
    if (this.disposed) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_FAILED',
        phase: 'submission',
        message: 'Native agent runtime is disposed',
        providerId: NATIVE_AGENT_RUNTIME_PROVIDER_ID,
      })
    }
    if (this.agentDriver.status !== 'idle') {
      throw new AgentRuntimeError({
        code: 'AGENT_BUSY',
        phase: 'submission',
        message: 'Native agent runtime already has active work',
        providerId: NATIVE_AGENT_RUNTIME_PROVIDER_ID,
      })
    }
    if (request.signal.aborted) {
      return { reason: { kind: 'aborted', reason: { kind: 'user' } } }
    }
    const cancel = (): void => {
      this.agentDriver.cancel({ kind: 'user' })
    }
    request.signal.addEventListener('abort', cancel, { once: true })
    try {
      this.agentDriver.send(request.message, 'next-turn', true)
      await this.agentDriver.whenIdle()
    } finally {
      request.signal.removeEventListener('abort', cancel)
    }
    const ending = this.agent.session.events.findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') {
      throw new AgentRuntimeError({
        code: 'RUNTIME_FAILED',
        phase: 'turn',
        message: 'Native agent runtime completed without a turn result',
        providerId: NATIVE_AGENT_RUNTIME_PROVIDER_ID,
      })
    }
    return { reason: ending.data.reason }
  }

  cancel(_submissionId: SubmissionId, cause: Parameters<ReactLoopDriver['cancel']>[0]): void {
    this.agentDriver.cancel(cause)
  }

  dispose(): Promise<void> {
    return (this.disposing ??= (async () => {
      this.disposed = true
      this.agentDriver.cancel({ kind: 'disposed' })
      await this.agentDriver.whenIdle()
      this.release()
    })())
  }
}

/** Native Provider and loop configuration service. */
export class AgentLoop extends Service implements AgentRuntimeProvider {
  static inject = [
    'agents',
    'sessions',
    'agentRuntimeRouter',
    'agentRuntimes',
    'llm',
    'tools',
    'systemPrompt',
  ]

  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<Config>

  readonly id: AgentRuntimeProviderIdType = NATIVE_AGENT_RUNTIME_PROVIDER_ID
  readonly profileSnapshotVersions: readonly number[] = Object.freeze([0])
  /** Resolved Native Provider configuration, including the live settings source. */
  readonly config: ResolvedConfig
  private readonly ownership: NativeOwnership
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')
    const entry: AgentLoopSettings = {
      maxParallelToolCalls: resolveMaxParallelToolCalls(config.maxParallelToolCalls),
    }
    let source: () => AgentLoopSettings = () => entry
    this.config = {
      ...config,
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      get maxParallelToolCalls() {
        return source().maxParallelToolCalls
      },
    }
    installSettingsSection(ctx, AGENT_LOOP_SETTINGS_NAMESPACE, AGENT_LOOP_SETTINGS_SCHEMA, entry, {
      validate: value => void resolveMaxParallelToolCalls(value.maxParallelToolCalls),
      setSource: (current) => { source = current },
      onChange: () => {},
    })
    validateConfiguredAgents(this.config.agents)
    this.ownership = new NativeOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
  }

  /** Register after an overlapping old Provider drains, then start configured Agents. */
  async *[Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    await this.waitForProviderSlot()
    yield this.ctx.agentRuntimes.registerProvider(this)
    yield () => this.ownership.dispose()
    this.startConfiguredAgents()
  }

  /** Start declarative Agents only after this Provider is selectable. */
  private startConfiguredAgents(): void {
    const { ctx } = this.runtime
    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      const meta = cwd === undefined ? {} : { cwd }
      const configuredId = sessionId ?? SessionId(`${id}-session-${randomUUID()}`)
      const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
      if (hasResumeId) {
        ctx.effect(() => {
          const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
            const startup = childCtx.agents.resume({
              resumeSessionId,
              agentOptions: options,
            }).then(() => undefined).catch((error: unknown) => {
              this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
            })
            this.ownership.trackStartup(startup)
          })
          return fiber.dispose
        }, `agentLoop.resume(${id})`)
        continue
      }
      const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
      if (persistence === undefined) {
        try {
          this.create(configuredId, options, meta)
        } catch (error: unknown) {
          this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
        }
        continue
      }
      const startup = this.restoreOrCreateConfigured(ctx, configuredId, options, meta)
      const reported = startup.catch((error: unknown) => {
        this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
      })
      this.ownership.trackStartup(reported)
    }
  }

  /** Wait for an older draining Native Provider to release the registry id. */
  private async waitForProviderSlot(): Promise<void> {
    if (this.ctx.agentRuntimes.getProvider(this.id) === undefined) return
    const released = Promise.withResolvers<void>()
    const dispose = this.ctx.on('agent-runtime/provider-removed', (providerId) => {
      if (providerId === this.id) released.resolve()
    })
    try {
      await released.promise
    } finally {
      dispose()
    }
    if (!this.ownership.isActive()) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_UNAVAILABLE',
        phase: 'registration',
        message: 'Native agent runtime provider is not active',
        providerId: this.id,
      })
    }
  }

  /**
   * Report the capabilities and protocol metadata of the Native runtime.
   * @param _request - probe context supplied by the Router.
   * @returns the current Native runtime metadata.
   */
  probe(_request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    return Promise.resolve({
      capabilities: NATIVE_CAPABILITIES,
      permissionEnforcement: 'enforced',
      protocolVersion: '1',
      productVersion: '0.1.0',
    })
  }

  /**
   * Prepare a Native runtime for an unpublished Router-owned Agent.
   * @param request - resolved runtime request and unpublished Agent context.
   * @returns the prepared Native runtime.
   */
  prepare(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    return Promise.resolve().then(() => this.prepareSync(request))
  }

  /**
   * Prepare the in-process Native driver without an asynchronous handshake.
   * @param request - Router-owned unpublished Agent and runtime identity.
   * @returns the prepared Native runtime.
   */
  prepareSync(request: AgentRuntimePrepareRequest): PreparedAgentRuntime {
    if (!this.ownership.isActive()) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_UNAVAILABLE',
        phase: 'prepare',
        message: 'Native agent runtime provider is not active',
        providerId: this.id,
      })
    }
    const agent = request.agentCtx.agent
    if (agent === undefined || agent.id !== request.sessionId) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'prepare',
        message: 'Native agent runtime requires the matching unpublished Agent context',
        providerId: this.id,
      })
    }
    assertAgentOptions(agent.options)
    const driver = new ReactLoopDriver(this.runtime.ctx, agent)
    return new NativePreparedRuntime(request, driver, agent, this.ownership)
  }

  /**
   * Compatibility helper for callers that still name the Native service.
   * @param id - exact Session identity.
   * @param options - Native model route.
   * @param meta - fresh Session workspace metadata.
   * @returns the published Router-owned Agent.
   */
  create(
    id: SessionId,
    options: AgentOptions = {},
    meta: Pick<SessionHeader, 'cwd'> = {},
  ): Agent {
    return this.ctx.agentRuntimeRouter.createNative(this.ctx, id, options, meta)
  }

  /**
   * Compatibility forwarding entry for existing package consumers.
   * @param ownerCtx - lifecycle owner.
   * @param options - Agent creation options.
   * @returns the Router-owned handle.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    return ownerCtx.agents.create(options)
  }

  /**
   * Compatibility forwarding entry for existing package consumers.
   * @param ownerCtx - lifecycle owner.
   * @param options - Agent resume options.
   * @returns the Router-owned handle.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    return ownerCtx.agents.resume(options)
  }

  /** Restore a stable configured identity, or create it on first use. */
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
    if (!this.ownership.isActive()) return
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      try {
        await ownerCtx.agents.resume({ resumeSessionId: sessionId, agentOptions })
        return
      } catch (error: unknown) {
        if (!this.ownership.isActive()) return
        const exists = (await persistence.list()).some(header => header.id === sessionId)
        if (exists) throw error
      }
    }
    await ownerCtx.agents.create({ sessionId, agentOptions, meta })
  }

  /** Wait for an earlier same-id lifecycle to leave both registries. */
  private async waitForDrainingConfiguredIdentity(
    ownerCtx: Context,
    sessionId: SessionId,
  ): Promise<void> {
    if (ownerCtx.agents.get(sessionId) === undefined
      && ownerCtx.sessions.get(sessionId) === undefined) return
    const released = Promise.withResolvers<void>()
    const checkReleased = (): void => {
      if (ownerCtx.agents.get(sessionId) === undefined
        && ownerCtx.sessions.get(sessionId) === undefined) released.resolve()
    }
    const disposeAgentListener = ownerCtx.on('agent/disposed', checkReleased)
    const disposeSessionListener = ownerCtx.on('session/disposed', checkReleased)
    try {
      checkReleased()
      await this.ownership.waitWhileActive(released.promise)
    } finally {
      disposeAgentListener()
      disposeSessionListener()
    }
  }

  /** Report one contained declarative-start failure. */
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    if (!this.ownership.isActive()) return
    this.ctx.logger.warn(
      `agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`,
    )
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(
            `agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`,
          )
        })
      } catch (listenerError: unknown) {
        this.ctx.logger.warn(
          `agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`,
        )
      }
    }
  }
}

export default AgentLoop
