/**
 * AgentFactory Router over registered agent runtime Providers.
 *
 * @module @deepseek-ai/dsh-agent-runtime-router
 */

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeError,
  AgentRuntimeId,
  AgentRuntimeProviderId,
  hasAgentRuntimeCapability,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeActivity,
  AgentRuntimeAssistantChunk,
  AgentRuntimeAssistantOutput,
  AgentRuntimeEventSink,
  AgentRuntimeFacts,
  AgentRuntimeProvider,
  AgentRuntimeProviderId as AgentRuntimeProviderIdType,
  PreparedAgentRuntime,
  RuntimeProfileSnapshot,
  SubmissionId,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeProfiles,
  RuntimeCapacityLease,
} from '@deepseek-ai/dsh-agent-runtime-profile'
import {
  forkSeedWithoutRuntimeFacts as retainForkHistory,
  SessionForkError,
  SessionId,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import type { JsonValue, Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { RoutedAgent } from './agent.ts'

/** Fiber states that cannot own or serve a new lifecycle. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimeRouter: AgentRuntimeRouter
  }
}

/** Router has no deployment-varying selection; Runtime Profiles own it. */
export interface Config {}

/** Native-only synchronous preparation used by the legacy AgentLoop create helper. */
interface SynchronousAgentRuntimeProvider extends AgentRuntimeProvider {
  /**
   * Prepare without an asynchronous protocol handshake.
   * @param request - the same Router-owned request accepted by `prepare`.
   * @returns the prepared Native runtime.
   */
  prepareSync(request: Parameters<AgentRuntimeProvider['prepare']>[0]): PreparedAgentRuntime
}

/** One exact Provider registration captured for a Router transaction. */
interface ProviderGeneration {
  readonly provider: AgentRuntimeProvider
  readonly signal: AbortSignal
}

/** Whether a Provider supplies the Native synchronous compatibility path. */
function isSynchronousProvider(
  provider: AgentRuntimeProvider,
): provider is SynchronousAgentRuntimeProvider {
  return 'prepareSync' in provider && typeof provider.prepareSync === 'function'
}

/** Factory-level ownership of live Agent transactions. */
class RouterOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly liveAgents =
    new Map<() => Promise<void>, AgentRuntimeProviderIdType>()
  private startupTasks = new Set<Promise<void>>()

  constructor(private readonly fiber: Fiber) {}

  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  track(providerId: AgentRuntimeProviderIdType, dispose: () => Promise<void>): () => void {
    this.liveAgents.set(dispose, providerId)
    return () => { this.liveAgents.delete(dispose) }
  }

  async disposeProvider(providerId: AgentRuntimeProviderIdType): Promise<void> {
    await Promise.all(
      [...this.liveAgents]
        .filter(([, candidate]) => candidate === providerId)
        .map(([dispose]) => dispose()),
    )
  }

  trackWrapper(job: Promise<unknown>): void {
    const settled = job.then(() => undefined, () => undefined)
    this.startupTasks.add(settled)
    const forget = (): void => { this.startupTasks.delete(settled) }
    void settled.then(forget, forget)
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('agent runtime Router is not active'))
    await Promise.all([
      ...[...this.liveAgents.keys()].map(dispose => dispose()),
      ...this.startupTasks,
    ])
  }
}

/** Await an operation or reject when creation ownership aborts. */
async function raceAbort<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
): Promise<T> {
  const abortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw abortError()
  return new Promise<T>((resolve, reject) => {
    const settle = <A extends unknown[]>(callback: (...args: A) => void) =>
      (...args: A): void => {
        signal.removeEventListener('abort', onAbort)
        callback(...args)
      }
    const onAbort = settle(() => { reject(abortError()) })
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve(operation).then(settle(resolve), settle(reject))
  })
}

/** Start an abortable operation and release a value returned after cancellation. */
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    void pending.then(releaseAbandoned, () => undefined)
    throw error
  }
}

/** Validate the prepared handle before any registry publication. */
function validatePreparedRuntime(
  provider: AgentRuntimeProvider,
  runtimeId: ReturnType<typeof AgentRuntimeId>,
  runtime: PreparedAgentRuntime,
): AgentRuntimeFacts {
  const facts = snapshotAgentRuntimeFacts(runtime.initialFacts)
  if (runtime.runtimeId !== runtimeId
    || facts.runtimeId !== runtimeId
    || facts.providerId !== provider.id) {
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'prepare',
      message: `agent runtime provider "${provider.id}" returned mismatched runtime identity`,
      providerId: provider.id,
    })
  }
  return facts
}

/** Reconstruct Agent-facing Native options from one persisted effective snapshot. */
function restoredAgentOptions(
  profile: RuntimeProfileSnapshot,
  requested: AgentOptions,
  phase: 'profile' | 'resume',
): AgentOptions {
  const providerOptions = profile.provider.options !== null
    && typeof profile.provider.options === 'object'
    && !Array.isArray(profile.provider.options)
    ? profile.provider.options
    : {}
  const restored: AgentOptions = {
    runtimeProfile: profile.profileId,
    ...profile.model.default === undefined ? {} : { model: profile.model.default },
    ...typeof providerOptions['llmProvider'] === 'string'
      ? { provider: providerOptions['llmProvider'] }
      : {},
    ...typeof providerOptions['maxTokens'] === 'number'
      ? { maxTokens: providerOptions['maxTokens'] }
      : {},
  }
  for (const key of ['runtimeProfile', 'provider', 'model', 'maxTokens'] as const) {
    if (requested[key] !== undefined && requested[key] !== restored[key]) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase,
        message: `agent option "${key}" conflicts with the stored Runtime Profile snapshot`,
        providerId: profile.provider.id,
      })
    }
  }
  return restored
}

/** Remove parent runtime identities and remap retained events and the lineage boundary. */
function forkSeedWithoutRuntimeFacts(
  events: readonly SessionEvent[] | undefined,
  seedLength: number | undefined,
): { readonly events: readonly SessionEvent[]; readonly seedLength: number } | undefined {
  if (events === undefined) return undefined
  const lineageBoundary = seedLength ?? events.length
  let retained: readonly SessionEvent[]
  try {
    retained = retainForkHistory(events)
  } catch (error) {
    if (!(error instanceof SessionForkError)) throw error
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'profile',
      message: error.message,
    })
  }
  return {
    events: retained,
    seedLength: events
      .slice(0, lineageBoundary)
      .filter(event => event.type !== 'agent/runtime/facts')
      .length,
  }
}

/** Mutable sink state closed before provider teardown. */
class RouterEventSink implements AgentRuntimeEventSink {
  private open = true
  private agent!: RoutedAgent

  constructor(
    readonly runtimeId: ReturnType<typeof AgentRuntimeId>,
    private readonly providerId: ReturnType<typeof AgentRuntimeProviderId>,
  ) {}

  close(): void {
    this.open = false
  }

  bind(agent: RoutedAgent): void {
    this.agent = agent
  }

  facts(facts: AgentRuntimeFacts): void {
    this.assertOpen()
    const snapshot = snapshotAgentRuntimeFacts(facts)
    if (snapshot.runtimeId !== this.runtimeId || snapshot.providerId !== this.providerId) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'turn',
        message: 'runtime facts do not match the prepared runtime identity',
        providerId: this.providerId,
      })
    }
    this.agent.appendRuntimeFacts(snapshot)
  }

  assistantChunk(submissionId: SubmissionId, chunk: AgentRuntimeAssistantChunk): void {
    this.assertOpen()
    this.agent.appendRuntimeAssistantChunk(submissionId, chunk)
  }

  assistantMessage(submissionId: SubmissionId, output: AgentRuntimeAssistantOutput): void {
    this.assertOpen()
    this.agent.appendRuntimeAssistantMessage(submissionId, output)
  }

  activity(activity: AgentRuntimeActivity): void {
    this.assertOpen()
    if (activity.runtimeId !== this.runtimeId) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'turn',
        message: 'runtime activity does not match the prepared runtime identity',
        providerId: this.providerId,
      })
    }
    this.agent.appendRuntimeActivity(activity)
  }

  private assertOpen(): void {
    if (this.open) return
    throw new AgentRuntimeError({
      code: 'RUNTIME_FAILED',
      phase: 'dispose',
      message: 'agent runtime event sink is closed',
      providerId: this.providerId,
    })
  }
}

/** One unpublished or live Agent lifecycle with memoized reverse teardown. */
class AgentLifecycle {
  private agentValue: RoutedAgent | undefined
  readonly signal: AbortSignal
  private runtime: PreparedAgentRuntime | undefined
  private initialFacts: AgentRuntimeFacts | undefined
  private detachSession: (() => void) | undefined
  private detachAgent: (() => void) | undefined
  private disposing: Promise<void> | undefined
  private readonly abort = new AbortController()
  private readonly sink: RouterEventSink
  /* v8 ignore start -- constructor failure leaves no lifecycle that could invoke this placeholder. */
  private unfollowOwner: () => Promise<void> | void = () => {}
  /* v8 ignore stop */
  private readonly untrack: () => void
  private readonly agentReady = Promise.withResolvers<void>()

  constructor(
    private readonly router: AgentRuntimeRouter,
    private readonly ownerCtx: Context,
    readonly provider: AgentRuntimeProvider,
    providerSignal: AbortSignal,
    session: Session,
    options: AgentOptions,
    private readonly capacityLease: RuntimeCapacityLease,
    callerSignal?: AbortSignal,
  ) {
    ownerCtx.fiber.assertActive()
    router.assertActive()
    if (callerSignal?.aborted === true) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${session.id}" creation aborted`, { cause: callerSignal.reason })
    }
    const runtimeId = AgentRuntimeId(`runtime-${randomUUID()}`)
    this.sink = new RouterEventSink(runtimeId, provider.id)
    this.signal = this.abort.signal
    const onCallerAbort = (): void => {
      this.abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${session.id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onRouterTeardown = (): void => { this.abort.abort(router.ownership.signal.reason) }
    const onProviderTeardown = (): void => { this.abort.abort(providerSignal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    router.ownership.signal.addEventListener('abort', onRouterTeardown, { once: true })
    providerSignal.addEventListener('abort', onProviderTeardown, { once: true })
    this.removeAbortListeners = () => {
      callerSignal?.removeEventListener('abort', onCallerAbort)
      router.ownership.signal.removeEventListener('abort', onRouterTeardown)
      providerSignal.removeEventListener('abort', onProviderTeardown)
    }
    this.untrack = router.ownership.track(provider.id, () => this.dispose())
    try {
      this.unfollowOwner = ownerCtx.effect(() => () => {
        if (this.disposing !== undefined) return
        this.abort.abort(new Error(`agent "${session.id}" setup aborted: owner disposed during setup`))
        return this.dispose(true)
      }, `agentRuntimeRouter.lifecycle(${session.id})`)
      this.agentValue = new RoutedAgent(
        router.runtimeContext,
        session.id,
        options,
        session,
        provider.id,
      )
      this.sink.bind(this.agentValue)
      this.agentReady.resolve()
      this.assertLive()
    } catch (error: unknown) {
      this.agentReady.resolve()
      void this.dispose()
      throw error
    }
  }

  private readonly removeAbortListeners: () => void

  get agent(): RoutedAgent {
    return this.agentValue as RoutedAgent
  }

  async prepare(
    profile: RuntimeProfileSnapshot,
    source: SessionStartSource,
    externalSessionId?: AgentRuntimeFacts['externalSessionId'],
  ): Promise<void> {
    const { runtimeId } = this.sink
    const request = source === 'resume'
      ? {
        kind: 'resume' as const,
        runtimeId,
        sessionId: this.agent.id,
        profile,
        agentCtx: this.agent.ctx,
        sink: this.sink,
        signal: this.signal,
        ...externalSessionId === undefined ? {} : { externalSessionId },
      }
      : {
        kind: 'create' as const,
        runtimeId,
        sessionId: this.agent.id,
        profile,
        agentCtx: this.agent.ctx,
        sink: this.sink,
        signal: this.signal,
      }
    if (isSynchronousProvider(this.provider)) {
      this.attachRuntime(runtimeId, this.provider.prepareSync(request))
      this.assertResumeCapability(source)
      return
    }
    const runtime = await raceAbortCall(
      () => this.provider.prepare(request),
      this.signal,
      this.agent.id,
      abandoned => void abandoned.dispose(),
    )
    this.attachRuntime(runtimeId, runtime)
    this.assertResumeCapability(source)
  }

  prepareSync(profile: RuntimeProfileSnapshot): void {
    if (!isSynchronousProvider(this.provider)) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'prepare',
        message: `agent runtime provider "${this.provider.id}" does not support synchronous Native preparation`,
        providerId: this.provider.id,
      })
    }
    const { runtimeId } = this.sink
    const runtime = this.provider.prepareSync({
      kind: 'create',
      runtimeId,
      sessionId: this.agent.id,
      profile,
      agentCtx: this.agent.ctx,
      sink: this.sink,
      signal: this.signal,
    })
    this.attachRuntime(runtimeId, runtime)
  }

  /** Validate and attach one prepared handle exactly once. */
  private attachRuntime(
    runtimeId: ReturnType<typeof AgentRuntimeId>,
    runtime: PreparedAgentRuntime,
  ): void {
    this.initialFacts = validatePreparedRuntime(this.provider, runtimeId, runtime)
    this.runtime = runtime
    this.agent.attachRuntime(runtime)
  }

  /** Require a resumed Provider to declare the capability before publication. */
  private assertResumeCapability(source: SessionStartSource): void {
    if (source !== 'resume'
      || hasAgentRuntimeCapability(this.agent.capabilities, 'resume')) return
    throw new AgentRuntimeError({
      code: 'RESUME_UNSUPPORTED',
      phase: 'resume',
      message: `agent runtime provider "${this.provider.id}" does not support resume`,
      providerId: this.provider.id,
    })
  }

  publish(source: SessionStartSource): AgentHandle {
    this.assertLive()
    this.detachSession = this.agent.ctx.sessions.enter(this.agent.session)
    this.detachAgent = this.router.runtimeContext.agents.enter(this.agent, this.ownerCtx.agent)
    this.agent.ctx.sessions.announce(this.agent.session)
    this.assertLive()
    this.agent.appendRuntimeFacts(this.initialFacts as AgentRuntimeFacts)
    this.assertLive()
    this.router.runtimeContext.agents.announce(this.agent)
    this.assertLive()
    emitAgentEvent(this.router.runtimeContext, this.agent, 'agent/session-start', { source })
    this.assertLive()
    this.agent.openAdmission()
    return { agent: this.agent, dispose: () => this.dispose() }
  }

  dispose(ownerTriggered = false): Promise<void> {
    return (this.disposing ??= this.disposeOnce(ownerTriggered))
  }

  private async disposeOnce(ownerTriggered: boolean): Promise<void> {
    const id = this.agentValue?.id ?? 'unpublished'
    const submissionsSettled = this.agentValue?.closeAdmission()
    this.abort.abort(new Error(`agent "${id}" lifecycle disposed`))
    this.removeAbortListeners()
    this.sink.close()
    if (this.agentValue === undefined) await this.agentReady.promise
    const agent = this.agentValue
    let failure: unknown
    if (this.runtime !== undefined && agent !== undefined) {
      try {
        agent.cancel({ kind: 'disposed' })
        await this.runtime.dispose()
      } catch (error: unknown) {
        failure = error
      }
    }
    await submissionsSettled
    try {
      await agent?.disposeScope()
    } catch (error: unknown) {
      failure ??= error
    }
    try {
      this.detachAgent?.()
      this.detachSession?.()
    } finally {
      this.untrack()
      this.capacityLease.release()
      if (!ownerTriggered) await this.unfollowOwner()
    }
    if (failure !== undefined) {
      throw new AgentRuntimeError({
        code: 'DISPOSE_FAILED',
        phase: 'dispose',
        message: `agent "${id}" runtime disposal failed`,
        providerId: this.provider.id,
      }, { cause: failure })
    }
  }

  private assertLive(): void {
    if (!this.signal.aborted) return
    throw this.signal.reason as Error
  }
}

/** Configurable runtime Router and the sole AgentFactory implementation. */
export class AgentRuntimeRouter extends Service implements AgentFactory {
  static inject = [
    'agents',
    'sessions',
    'agentRuntimes',
    'agentRuntimeProfiles',
    'llm',
    'tools',
    'systemPrompt',
  ]

  static Config = z.object({}) as z<Config>

  /** Router-owned lifecycle set used by Provider generations and Agent handles. */
  readonly ownership: RouterOwnership
  private readonly providerGenerations = new Map<
    AgentRuntimeProviderIdType,
    { readonly provider: AgentRuntimeProvider; readonly abort: AbortController }
  >()
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'agentRuntimeRouter')
    this.ownership = new RouterOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(() => () => this.ownership.dispose(), 'agentRuntimeRouter.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentRuntimeRouter.setFactory()')
    ctx.on('agent-runtime/provider-added', (provider) => {
      this.providerGenerations.set(provider.id, {
        provider,
        abort: new AbortController(),
      })
    })
    ctx.on('agent-runtime/provider-removed', (providerId) => {
      const generation = this.providerGenerations.get(providerId)
      if (generation !== undefined) {
        generation.abort.abort(this.providerUnavailable(providerId))
        this.providerGenerations.delete(providerId)
      }
      void this.ownership.disposeProvider(providerId).catch((error: unknown) => {
        this.runtime.ctx.logger.warn(
          `agent runtime provider "${providerId}" removal cleanup failed: ${String(error)}`,
        )
      })
    })
  }

  /** Dependency context inherited by Router-owned Agent scopes. */
  get runtimeContext(): Context {
    return this.runtime.ctx
  }

  /** Assert that the Router can accept another Agent lifecycle. */
  assertActive(): void {
    if (!this.ownership.isActive()) throw new Error('agent runtime Router is not active')
  }

  /**
   * Create and publish an Agent through the configured Provider.
   * @param ownerCtx - caller context that owns the returned lifecycle.
   * @param options - fresh Session, Agent, setup, and cancellation options.
   * @returns the published Agent handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const persistedProfile = options.meta?.runtimeProfile
    const profile = persistedProfile === undefined
      ? this.resolveProfile(options.meta?.cwd, options.agentOptions ?? {})
      : this.profiles.restore(persistedProfile)
    const agentOptions = persistedProfile === undefined
      ? options.agentOptions ?? {}
      : restoredAgentOptions(profile, options.agentOptions ?? {}, 'profile')
    const forkSeed = options.meta?.parentSession === undefined
      ? undefined
      : forkSeedWithoutRuntimeFacts(options.seed, options.meta.seedLength)
    const seed = forkSeed?.events ?? options.seed
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...seed === undefined ? {} : { seed },
      meta: {
        ...options.meta,
        ...forkSeed === undefined ? {} : { seedLength: forkSeed.seedLength },
        runtimeProfile: profile as unknown as JsonValue,
      },
    }))
    const published = this.setupAndPublish(
      ownerCtx,
      preparation,
      agentOptions,
      options.setup,
      options.signal,
      'startup',
      profile,
      undefined,
    )
    this.ownership.trackWrapper(published)
    return published
  }

  /**
   * Preserve the Native service's synchronous create helper through the same
   * Router-owned publication and teardown transaction.
   * @param ownerCtx - caller context that owns the lifecycle.
   * @param id - exact Session identity.
   * @param options - Native model-route options.
   * @param meta - fresh Session metadata.
   * @returns the published Agent.
   */
  createNative(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions = {},
    meta: Pick<SessionHeader, 'cwd'> = {},
  ): Agent {
    const profile = this.resolveProfile(meta.cwd, options)
    using preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
      meta: {
        ...meta,
        runtimeProfile: profile as unknown as JsonValue,
      },
    }))
    const providerId = profile.provider.id
    const generation = this.requireProviderGeneration(providerId)
    this.assertProfileCompatible(generation.provider, profile)
    const capacityLease = this.profiles.acquireSync(profile)
    let lifecycle: AgentLifecycle | undefined
    try {
      lifecycle = new AgentLifecycle(
        this,
        ownerCtx,
        generation.provider,
        generation.signal,
        preparation.session,
        options,
        capacityLease,
      )
      lifecycle.prepareSync(profile)
      return lifecycle.publish('startup').agent
    } catch (error: unknown) {
      capacityLease.release()
      void lifecycle?.dispose().catch((disposeError: unknown) => {
        this.runtime.ctx.logger.warn(`agent "${id}": rollback cleanup failed: ${String(disposeError)}`)
      })
      throw error
    }
  }

  /**
   * Load and publish an Agent through the configured Provider.
   * @param ownerCtx - caller context that owns the returned lifecycle.
   * @param options - persisted Session identity, Agent options, setup, and cancellation.
   * @returns the published Agent handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const published = this.resumeWith(ownerCtx, persistence, options)
    this.ownership.trackWrapper(published)
    return published
  }

  /** Resume through an explicit persistence service. */
  private async resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const ownerAbort = new AbortController()
    const unfollowOwner = ownerCtx.effect(() => () => {
      ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
    }, `agentRuntimeRouter.resume-load(${id})`)
    const ownerSignal = AbortSignal.any([
      ...options.signal === undefined ? [] : [options.signal],
      ownerAbort.signal,
      this.ownership.signal,
    ])
    let preparation: SessionPreparation | undefined
    try {
      const listed = await raceAbortCall(
        () => persistence.listSnapshots(ownerSignal),
        ownerSignal,
        id,
        /* v8 ignore next -- a late snapshot array owns no resources. */
        () => undefined,
      )
      const listedHeader = listed.find(snapshot => snapshot.header.id === id)?.header
      const listedProfile = listedHeader?.runtimeProfile === undefined
        ? undefined
        : this.profiles.restore(listedHeader.runtimeProfile)
      const listedGeneration = listedProfile === undefined
        ? undefined
        : this.requireProviderGeneration(listedProfile.provider.id)
      const fused = listedGeneration === undefined
        ? ownerSignal
        : AbortSignal.any([ownerSignal, listedGeneration.signal])
      try {
        preparation = await raceAbortCall(
          () => persistence.prepare(id, fused),
          fused,
          id,
          (abandoned) => { abandoned[Symbol.dispose]() },
        )
      } finally {
        await unfollowOwner()
      }
      ownerCtx.fiber.assertActive()
      this.assertActive()
      const profile = this.profiles.restore(preparation.session.header.runtimeProfile)
      if (listedProfile !== undefined && !isDeepStrictEqual(profile, listedProfile)) {
        throw new AgentRuntimeError({
          code: 'RUNTIME_INCOMPATIBLE',
          phase: 'resume',
          message: `stored Runtime Profile snapshot changed while session "${id}" was loading`,
          providerId: profile.provider.id,
        })
      }
      const generation = listedGeneration
        ?? this.requireProviderGeneration(profile.provider.id)
      this.assertProfileCompatible(generation.provider, profile)
      return await this.setupAndPublish(
        ownerCtx,
        preparation,
        restoredAgentOptions(profile, options.agentOptions ?? {}, 'resume'),
        options.setup,
        options.signal,
        'resume',
        profile,
        generation,
      )
    } finally {
      preparation?.[Symbol.dispose]()
    }
  }

  /** Select a Provider, prepare resources, compose setup, and publish atomically. */
  private async setupAndPublish(
    ownerCtx: Context,
    preparation: SessionPreparation,
    options: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    profile: RuntimeProfileSnapshot,
    selectedGeneration?: ProviderGeneration,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(`agent "${ownedPreparation.session.id}" creation aborted`, {
          cause: signal.reason,
        })
    }
    const providerId = profile.provider.id
    const generation = selectedGeneration ?? this.requireProviderGeneration(providerId)
    this.assertProfileCompatible(generation.provider, profile)
    const capacityLease = await this.acquireCapacity(
      ownerCtx,
      generation,
      profile,
      signal,
      ownedPreparation.session.id,
    )
    let lifecycle: AgentLifecycle | undefined
    try {
      lifecycle = new AgentLifecycle(
        this,
        ownerCtx,
        generation.provider,
        generation.signal,
        ownedPreparation.session,
        options,
        capacityLease,
        signal,
      )
      const previousFacts = source === 'resume'
        ? ownedPreparation.session.events.findLast(
          event => event.type === 'agent/runtime/facts',
        )?.data
        : undefined
      await lifecycle.prepare(profile, source, previousFacts?.externalSessionId)
      const setupCommit = await raceAbort(setup?.(lifecycle.agent.ctx), lifecycle.signal, lifecycle.agent.id)
      setupCommit?.commit()
      return lifecycle.publish(source)
    } catch (error: unknown) {
      capacityLease.release()
      try {
        await lifecycle?.dispose()
      } catch (disposeError: unknown) {
        this.runtime.ctx.logger.warn(
          `agent "${ownedPreparation.session.id}": rollback cleanup failed: ${String(disposeError)}`,
        )
      }
      throw error
    }
  }

  /** Wait for capacity under caller, Router, Provider, and request ownership. */
  private async acquireCapacity(
    ownerCtx: Context,
    generation: ProviderGeneration,
    profile: RuntimeProfileSnapshot,
    callerSignal: AbortSignal | undefined,
    id: SessionId,
  ): Promise<RuntimeCapacityLease> {
    const ownerAbort = new AbortController()
    const unfollowOwner = ownerCtx.effect(() => () => {
      ownerAbort.abort(new Error(`agent "${id}" capacity wait aborted: owner disposed`))
    }, `agentRuntimeRouter.capacity(${id})`)
    const signal = AbortSignal.any([
      ...callerSignal === undefined ? [] : [callerSignal],
      ownerAbort.signal,
      this.ownership.signal,
      generation.signal,
    ])
    let lease: RuntimeCapacityLease | undefined
    try {
      lease = await this.profiles.acquire(profile, signal)
      ownerCtx.fiber.assertActive()
      this.assertActive()
      if (generation.signal.aborted) throw generation.signal.reason
      return lease
    } catch (error: unknown) {
      lease?.release()
      throw error
    } finally {
      await unfollowOwner()
    }
  }

  /** Resolve one selected Provider before runtime resources exist. */
  private requireProviderGeneration(
    providerId: ReturnType<typeof AgentRuntimeProviderId>,
  ): ProviderGeneration {
    const provider = this.runtime.ctx.agentRuntimes.getProvider(providerId)
    if (provider === undefined) throw this.providerUnavailable(providerId)
    const current = this.providerGenerations.get(providerId)
    if (current !== undefined) {
      return { provider: current.provider, signal: current.abort.signal }
    }
    const abort = new AbortController()
    this.providerGenerations.set(providerId, { provider, abort })
    return { provider, signal: abort.signal }
  }

  /** Build the stable failure used when one Provider generation disappears. */
  private providerUnavailable(
    providerId: ReturnType<typeof AgentRuntimeProviderId>,
  ): AgentRuntimeError {
    return new AgentRuntimeError({
      code: 'RUNTIME_UNAVAILABLE',
      phase: 'prepare',
      message: `agent runtime provider "${providerId}" is not registered`,
      providerId,
    })
  }

  /** Resolve one settings-backed profile before runtime resources exist. */
  private resolveProfile(
    cwd: string | undefined,
    options: AgentOptions,
  ): RuntimeProfileSnapshot {
    return this.profiles.resolve(options.runtimeProfile, {
      ...options.model === undefined ? {} : { model: options.model },
      ...options.provider === undefined ? {} : { nativeLlmProvider: options.provider },
      ...options.maxTokens === undefined ? {} : { nativeMaxTokens: options.maxTokens },
      ...cwd === undefined ? {} : { cwd },
    })
  }

  /** Check the selected Provider against the pinned profile representation. */
  private assertProfileCompatible(
    provider: AgentRuntimeProvider,
    profile: RuntimeProfileSnapshot,
  ): void {
    if (provider.profileSnapshotVersions.includes(profile.schemaVersion)) return
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'profile',
      message: `agent runtime provider "${provider.id}" does not accept profile snapshot version ${profile.schemaVersion}`,
      providerId: provider.id,
    })
  }

  /** Untraced Runtime Profile service owned by the Router composition. */
  private get profiles(): AgentRuntimeProfiles {
    return this.runtime.ctx.agentRuntimeProfiles
  }
}

export default AgentRuntimeRouter
