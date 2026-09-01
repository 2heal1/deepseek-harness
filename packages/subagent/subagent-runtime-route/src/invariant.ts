/**
 * Runtime-backed subagent route invariant companion.
 *
 * @module @deepseek-ai/dsh-subagent-runtime-route/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-runtime-route'

/** Cordis companion plugin name. */
export const name = 'subagent-runtime-route-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the subagent registry companion owns provider lifecycle relations. */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant contribution.
 * @param ctx - Cordis context carrying invariant diagnostics.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
