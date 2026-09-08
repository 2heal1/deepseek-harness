/**
 * Shared mounting for the services required before tests load the concrete
 * agent loop. The caller retains ownership of the context, loop, adapters,
 * optional plugins, and teardown.
 * @module @deepseek-ai/dsh-agent-loop-testkit
 */

import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import AgentRuntimeRouter from '@deepseek-ai/dsh-agent-runtime-router'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config as ToolRuntimeConfig } from '@deepseek-ai/dsh-tools'

/** Configuration forwarded to the prerequisite service plugins. */
export interface AgentLoopTestDependenciesOptions {
  /** Configuration for the system-prompt registry. */
  readonly systemPrompt?: SystemPromptConfig
  /** Configuration for the tool registry. */
  readonly tools?: ToolRuntimeConfig
}

/**
 * Mount the deterministic Native Runtime Profile service used by tests.
 * @param ctx - test context receiving the service.
 * @returns the mounted profile service.
 */
export async function mountNativeTestRuntimeProfiles(ctx: Context): Promise<AgentRuntimeProfiles> {
  await ctx.plugin(AgentRuntimeProfiles, {
    defaultMainProfile: 'native',
    profiles: {
      native: {
        provider: 'native',
        launch: {
          executable: 'node',
          cwdPolicy: 'session-workspace',
        },
        model: { allowSessionOverride: true },
        product: { kind: 'native-agent-loop' },
        permissions: {
          policy: { kind: 'harness' },
          enforcement: 'required',
        },
        process: {
          startupTimeoutMs: 15_000,
          turnTimeoutMs: 1_800_000,
          shutdownTimeoutMs: 5_000,
          terminationTimeoutMs: 5_000,
          maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
        },
      },
    },
  })
  return ctx.agentRuntimeProfiles
}

/**
 * Mount the settings-independent Native Runtime Profile and Router used by tests.
 * @param ctx - test context receiving both services.
 */
export async function mountNativeTestRuntimeRouter(ctx: Context): Promise<void> {
  await mountNativeTestRuntimeProfiles(ctx)
  await ctx.plugin(AgentRuntimeRouter, {})
}

/**
 * Mount the standard prerequisite services for an AgentLoop test.
 *
 * The function deliberately does not mount AgentLoop or register an adapter,
 * so tests retain control of load order and the topology under test. The
 * context owns every mounted service and remains responsible for disposal. A
 * plugin-load failure rejects the promise; services activated earlier in the
 * sequence remain context-owned and unwind with that context.
 * @param ctx - test context that owns the mounted services.
 * @param options - optional service configuration forwarded without mutation.
 * @returns after every prerequisite service has activated.
 */
export async function mountAgentLoopTestDependencies(
  ctx: Context,
  options: AgentLoopTestDependenciesOptions = {},
): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, options.systemPrompt ?? {})
  await ctx.plugin(ToolRuntime, options.tools ?? {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentRuntimeRegistry)
  await mountNativeTestRuntimeRouter(ctx)
}
