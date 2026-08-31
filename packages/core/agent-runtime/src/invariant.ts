/** Package-owned runtime provider registry invariants. @module @deepseek-ai/dsh-agent-runtime/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { AgentRuntimeProvider, AgentRuntimeProviderId } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-runtime'

/** Cordis companion plugin name. */
export const name = 'agent-runtime-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install checks that tie provider events to the authoritative registry. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'agent-runtime/provider-added') {
      const provider = args[0] as AgentRuntimeProvider
      if (ctx.agentRuntimes.getProvider(provider.id) === undefined) {
        fail(`agent-runtime/provider-added does not match registry entry ${JSON.stringify(provider.id)}`)
      }
      return
    }
    if (eventName !== 'agent-runtime/provider-removed') return
    const providerId = args[0] as AgentRuntimeProviderId
    if (ctx.agentRuntimes.getProvider(providerId) !== undefined) {
      fail(`agent-runtime/provider-removed still resolves ${JSON.stringify(providerId)}`)
    }
  }, { global: true })
}, { inject: ['agentRuntimes'] })

/**
 * Register the agent-runtime invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
