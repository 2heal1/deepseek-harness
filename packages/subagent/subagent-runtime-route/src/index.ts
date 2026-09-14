/**
 * Runtime Profile-backed one-shot routes over the existing subagent registry.
 *
 * @module @deepseek-ai/dsh-subagent-runtime-route
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeError,
  AgentRuntimeId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
  SubmissionId,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeActivity,
  AgentRuntimeAssistantChunk,
  AgentRuntimeAssistantOutput,
  AgentRuntimeCapabilities,
  AgentRuntimeEventSink,
  AgentRuntimeFacts,
  AgentRuntimeProvider,
  RuntimeProfileSnapshot,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  ResolvedRuntimeSubagentRoute,
  RuntimeCapacityLease,
} from '@deepseek-ai/dsh-agent-runtime-profile'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {
  AgentCancelCause,
  JsonValue,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { delegationDepthOf, SubagentError } from '@deepseek-ai/dsh-subagent'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'

/** Route Consumer configuration. Route definitions live in Settings. */
export interface Config {}

interface MountedRoute {
  readonly fingerprint: string
  readonly fiber: ReturnType<Context['plugin']>
}

/** Fail an operation that is unavailable before this private Agent is published. */
function unpublished(operation: string): never {
  throw new AgentRuntimeError({
    code: 'SUBMISSION_REJECTED',
    phase: 'publication',
    message: `runtime subagent cannot use Agent.${operation} before publication`,
  })
}

/** Minimal unpublished Agent identity and scope supplied to one Runtime Provider. */
class RuntimeSubagentAgent implements Agent {
  readonly options
  readonly session
  readonly ctx
  private readonly scope: Scope
  private capabilityValue: AgentRuntimeCapabilities = Object.freeze([])
  private statusValue: Agent['status'] = 'idle'

  constructor(
    runtimeCtx: Context,
    readonly id: SessionId,
    profile: RuntimeProfileSnapshot,
    parent: Agent,
    cwd: string,
  ) {
    this.options = { runtimeProfile: profile.profileId }
    this.session = Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      cwd,
      parentSession: parent.session.id,
      origin: 'subagent',
      delegationDepth: delegationDepthOf(parent) + 1,
      runtimeProfile: profile as unknown as JsonValue,
    })
    this.scope = createScope(runtimeCtx, this, { parent })
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get capabilities(): AgentRuntimeCapabilities {
    return this.capabilityValue
  }

  get inbox(): never {
    return unpublished('inbox')
  }

  get status(): Agent['status'] {
    return this.statusValue
  }

  attach(capabilities: AgentRuntimeCapabilities): void {
    this.capabilityValue = snapshotAgentRuntimeCapabilities(capabilities)
  }

  setRunning(running: boolean): void {
    this.statusValue = running ? 'running' : 'idle'
  }

  disposeScope(): Promise<void> {
    return this.scope.dispose()
  }

  cancel(): void {
    unpublished('cancel')
  }

  whenIdle(): Promise<void> {
    return unpublished('whenIdle')
  }

  submit(): never {
    return unpublished('submit')
  }

  cancelSubmission(): never {
    return unpublished('cancelSubmission')
  }

  runMaintenance<T>(): Promise<T> {
    return unpublished('runMaintenance')
  }

  send(): void {
    unpublished('send')
  }

  followup(): void {
    unpublished('followup')
  }

  steer(): void {
    unpublished('steer')
  }

  inject(): void {
    unpublished('inject')
  }
}

/** Collect only assistant output while validating Provider correlations. */
class RuntimeRouteSink implements AgentRuntimeEventSink {
  private open = true
  private readonly text: string[] = []
  private message: readonly ContentBlock[] | undefined

  constructor(
    private readonly runtimeId: ReturnType<typeof AgentRuntimeId>,
    private readonly provider: AgentRuntimeProvider,
    private readonly submissionId: ReturnType<typeof SubmissionId>,
  ) {}

  close(): void {
    this.open = false
  }

  facts(facts: AgentRuntimeFacts): void {
    this.assertOpen()
    const snapshot = snapshotAgentRuntimeFacts(facts)
    if (snapshot.runtimeId !== this.runtimeId || snapshot.providerId !== this.provider.id) {
      throw this.incompatible('runtime facts do not match the prepared runtime identity')
    }
  }

  assistantChunk(submissionId: ReturnType<typeof SubmissionId>, chunk: AgentRuntimeAssistantChunk): void {
    this.assertSubmission(submissionId)
    if (chunk.kind === 'text-delta') this.text.push(chunk.text)
  }

  assistantMessage(submissionId: ReturnType<typeof SubmissionId>, output: AgentRuntimeAssistantOutput): void {
    this.assertSubmission(submissionId)
    if (output.content.length > 0) this.message = output.content
  }

  activity(activity: AgentRuntimeActivity): void {
    this.assertOpen()
    if (activity.runtimeId !== this.runtimeId
      || (activity.submissionId !== undefined && activity.submissionId !== this.submissionId)) {
      throw this.incompatible('runtime activity does not match the prepared runtime identity')
    }
  }

  collect(): ContentBlock[] {
    if (this.message !== undefined) return [...this.message]
    const text = this.text.join('')
    return text.length === 0 ? [] : [{ type: 'text', text }]
  }

  private assertSubmission(submissionId: ReturnType<typeof SubmissionId>): void {
    this.assertOpen()
    if (submissionId !== this.submissionId) {
      throw this.incompatible('runtime assistant output does not match the active submission')
    }
  }

  private assertOpen(): void {
    if (!this.open) throw this.incompatible('runtime subagent event sink is closed')
  }

  private incompatible(message: string): AgentRuntimeError {
    return new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'turn',
      message,
      providerId: this.provider.id,
    })
  }
}

function workspaceOf(profile: RuntimeProfileSnapshot, parent: Agent): string {
  if (profile.launch.cwd.kind === 'fixed') return profile.launch.cwd.path
  const cwd = parent.session.header.cwd
  if (cwd !== undefined) return cwd
  throw new AgentRuntimeError({
    code: 'PROFILE_INVALID',
    phase: 'profile',
    message: `Runtime Profile "${profile.profileId}" requires a parent workspace`,
    providerId: profile.provider.id,
  })
}

function stopReasonOf(reason: TurnEndReason): SubagentStopReason {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'blocked':
      return 'refusal'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    default:
      return 'error'
  }
}

function diagnosticOf(error: unknown): string {
  return error instanceof AgentRuntimeError
    ? error.failure.message
    : 'agent runtime submission failed'
}

/** Own one prepared runtime until its result and disposal both settle. */
function runtimeRun(
  request: ResolvedSubagentStartRequest,
  agent: RuntimeSubagentAgent,
  runtime: Awaited<ReturnType<AgentRuntimeProvider['prepare']>>,
  sink: RuntimeRouteSink,
  submissionId: ReturnType<typeof SubmissionId>,
  lease: RuntimeCapacityLease,
): SubagentRun {
  const submissionAbort = new AbortController()
  const onAbort = (): void => {
    const cause = { kind: 'parent' } as const
    submissionAbort.abort(cause)
    runtime.cancel(submissionId, cause)
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()
  agent.setRunning(true)
  const result = Promise.resolve().then(async (): Promise<SubagentResult> => {
    try {
      const terminal = await runtime.submit({
        submissionId,
        message: createUserMessage({
          content: request.prompt,
          source: { kind: 'user' },
        }),
        signal: submissionAbort.signal,
        started() {},
      })
      return {
        output: sink.collect(),
        stopReason: stopReasonOf(terminal.reason),
        ...(terminal.reason.kind === 'error'
          ? { diagnostic: terminal.reason.error.message }
          : {}),
      }
    } catch (error: unknown) {
      return {
        output: sink.collect(),
        stopReason: 'error',
        diagnostic: diagnosticOf(error),
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      agent.setRunning(false)
      sink.close()
    }
  })
  let disposing: Promise<void> | undefined
  return {
    id: agent.id,
    localAgent: undefined,
    result,
    dispose: () => (disposing ??= (async () => {
      const cause: AgentCancelCause = { kind: 'disposed' }
      submissionAbort.abort(cause)
      runtime.cancel(submissionId, cause)
      const settled = await Promise.allSettled([
        result,
        runtime.dispose(),
        agent.disposeScope(),
      ])
      lease.release()
      const failure = settled.find(item => item.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason as Error
    })()),
  }
}

/** One route provider that delegates to the profile's protocol provider. */
class RuntimeRouteProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: true,
    toolFilter: false,
    persona: false,
  }
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const route = this.ctx.agentRuntimeProfiles.resolveRoute(this.name)
    const depth = delegationDepthOf(request.parent) + 1
    if (depth > route.maxDepth) {
      throw new SubagentError(
        `runtime subagent route "${this.name}" depth ${String(depth)} exceeds maxDepth ${String(route.maxDepth)}`,
        'DEPTH_EXCEEDED',
      )
    }
    const provider = this.ctx.agentRuntimes.getProvider(route.profile.provider.id)
    if (provider === undefined) {
      throw new SubagentError(
        `runtime subagent route "${this.name}" has no runtime provider "${route.profile.provider.id}"`,
        'NO_PROVIDER',
      )
    }
    if (!provider.profileSnapshotVersions.includes(route.profile.schemaVersion)) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_INCOMPATIBLE',
        phase: 'profile',
        message: `agent runtime provider "${provider.id}" does not accept profile snapshot version ${route.profile.schemaVersion}`,
        providerId: provider.id,
      })
    }
    const cwd = workspaceOf(route.profile, request.parent)
    const lease = await this.ctx.agentRuntimeProfiles.acquire(
      route.profile,
      request.signal,
      route.maxConcurrentRuns,
    )
    const id = SessionId(randomUUID())
    const runtimeId = AgentRuntimeId(`runtime-${randomUUID()}`)
    const submissionId = SubmissionId(`submission-${randomUUID()}`)
    const agent = new RuntimeSubagentAgent(this.ctx, id, route.profile, request.parent, cwd)
    const sink = new RuntimeRouteSink(runtimeId, provider, submissionId)
    let runtime: Awaited<ReturnType<AgentRuntimeProvider['prepare']>> | undefined
    try {
      runtime = await provider.prepare({
        kind: 'create',
        runtimeId,
        sessionId: id,
        profile: route.profile,
        agentCtx: agent.ctx,
        sink,
        signal: request.signal,
      })
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
      if (runtime.agentDriver !== undefined) {
        throw new AgentRuntimeError({
          code: 'RUNTIME_INCOMPATIBLE',
          phase: 'prepare',
          message: `runtime subagent route "${this.name}" requires an external one-shot provider`,
          providerId: provider.id,
        })
      }
      agent.attach(runtime.capabilities)
      return runtimeRun(request, agent, runtime, sink, submissionId, lease)
    } catch (error: unknown) {
      const cleanup = await Promise.allSettled([
        runtime?.dispose(),
        agent.disposeScope(),
      ])
      lease.release()
      const failure = cleanup.find(item => item.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw new AggregateError([error, failure.reason], 'runtime subagent startup rollback failed')
      }
      throw error
    }
  }
}

/** Install one route provider and its fixed model-facing delegation tool. */
function routePlugin(route: ResolvedRuntimeSubagentRoute) {
  return Object.assign((ctx: Context) => {
    ctx.subagents.registerProvider(new RuntimeRouteProvider(route.id, ctx))
    toolSubagent.apply(ctx, {
      provider: route.id,
      toolName: route.toolName,
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
      maxDepth: route.maxDepth,
    })
  }, {
    inject: ['agentRuntimes', 'agentRuntimeProfiles', 'subagents', 'tools', 'systemPrompt'],
  })
}

/** Maintains runtime-backed routes as Settings adds, edits, or removes them. */
export class AgentRuntimeSubagentRoutes extends Service {
  static inject = ['agentRuntimes', 'agentRuntimeProfiles', 'subagents', 'tools', 'systemPrompt']
  static Config = z.object({}) as z<Config>

  private readonly mounted = new Map<string, MountedRoute>()
  private reconcileTail: Promise<void> = Promise.resolve()
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'agentRuntimeSubagentRoutes')
    this.runtime = { ctx }
    ctx.on('settings/updated', (namespace) => {
      if (namespace !== 'agent-runtime') return
      this.queueReconcile()
    })
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.reconcile()
    yield async () => {
      await this.reconcileTail
      await Promise.all([...this.mounted.values()].map(route => route.fiber.dispose()))
      this.mounted.clear()
    }
  }

  /** Serialize route replacement so a name is never registered twice. */
  private queueReconcile(): void {
    const run = this.reconcileTail.then(() => this.reconcile())
    this.reconcileTail = run.catch((error: unknown) => {
      this.runtime.ctx.logger.warn(`runtime subagent route reconciliation failed: ${String(error)}`)
    })
  }

  /** Make mounted route fibers exactly match the current validated Settings value. */
  private async reconcile(): Promise<void> {
    const desired = new Map<string, { route: ResolvedRuntimeSubagentRoute; fingerprint: string }>()
    for (const id of this.runtime.ctx.agentRuntimeProfiles.listRoutes()) {
      const route = this.runtime.ctx.agentRuntimeProfiles.resolveRoute(id)
      desired.set(id, { route, fingerprint: JSON.stringify(route) })
    }
    for (const [id, mounted] of [...this.mounted]) {
      const next = desired.get(id)
      if (next?.fingerprint === mounted.fingerprint) {
        desired.delete(id)
        continue
      }
      await mounted.fiber.dispose()
      this.mounted.delete(id)
    }
    for (const [id, { route, fingerprint }] of desired) {
      const fiber = this.runtime.ctx.plugin(routePlugin(route))
      await fiber
      this.mounted.set(id, { fingerprint, fiber })
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimeSubagentRoutes: AgentRuntimeSubagentRoutes
  }
}

export default AgentRuntimeSubagentRoutes
