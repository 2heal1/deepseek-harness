/**
 * Runtime Profile-backed one-shot routes over the existing subagent registry.
 *
 * @module @deepseek-ai/dsh-subagent-runtime-route
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RuntimeProfileSnapshot } from '@deepseek-ai/dsh-agent-runtime'
import type {
  ResolvedRuntimeSubagentRoute,
  RuntimeCapacityLease,
} from '@deepseek-ai/dsh-agent-runtime-profile'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { delegationDepthOf, SubagentError } from '@deepseek-ai/dsh-subagent'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'

declare module '@deepseek-ai/dsh-subagent' {
  interface ResolvedSubagentStartRequest {
    /** Effective profile pinned by a runtime-backed route for its Provider. */
    readonly runtimeProfile?: RuntimeProfileSnapshot
  }
}

/** Route Consumer configuration. Route definitions live in Settings. */
export interface Config {}

interface MountedRoute {
  readonly fingerprint: string
  readonly fiber: ReturnType<Context['plugin']>
}

/** Release one capacity lease exactly once after the underlying run stops. */
function wrapRun(run: SubagentRun, lease: RuntimeCapacityLease): SubagentRun {
  let disposing: Promise<void> | undefined
  return {
    id: run.id,
    localAgent: run.localAgent,
    result: run.result,
    dispose: () => (disposing ??= Promise.resolve()
      .then(() => run.dispose())
      .finally(() => { lease.release() })),
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
    const backing = this.ctx.subagents.getProvider(route.profile.provider.id)
    if (backing === undefined || backing === this) {
      throw new SubagentError(
        `runtime subagent route "${this.name}" has no one-shot provider "${route.profile.provider.id}"`,
        'NO_PROVIDER',
      )
    }
    const lease = await this.ctx.agentRuntimeProfiles.acquire(
      route.profile,
      request.signal,
      route.maxConcurrentRuns,
    )
    try {
      const { maxDepth: _routeOwnedDepth, ...forwarded } = request
      const run = await backing.start({ ...forwarded, runtimeProfile: route.profile })
      return wrapRun(run, lease)
    } catch (error: unknown) {
      lease.release()
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
    inject: ['agentRuntimeProfiles', 'subagents', 'tools', 'systemPrompt'],
  })
}

/** Maintains runtime-backed routes as Settings adds, edits, or removes them. */
export class AgentRuntimeSubagentRoutes extends Service {
  static inject = ['agentRuntimeProfiles', 'subagents', 'tools', 'systemPrompt']
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
