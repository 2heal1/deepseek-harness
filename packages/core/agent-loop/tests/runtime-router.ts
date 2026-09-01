/** Native Runtime Profile and Router composition shared by AgentLoop tests. */

import type { Context } from '@deepseek-ai/cordis'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import AgentRuntimeRouter from '@deepseek-ai/dsh-agent-runtime-router'

/** Mount the settings-independent Native profile and Router used by package tests. */
export async function mountNativeTestRuntimeRouter(ctx: Context): Promise<void> {
  await ctx.plugin(AgentRuntimeProfiles, {
    defaultMainProfile: 'native',
    profiles: {
      native: {
        provider: 'native',
        launch: {
          executable: process.execPath,
          resolution: 'absolute',
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
  await ctx.plugin(AgentRuntimeRouter, {})
}
