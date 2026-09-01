/**
 * Runtime Profile invariant companion.
 *
 * @module @deepseek-ai/dsh-agent-runtime-profile/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-runtime-profile'

/** Cordis companion plugin name. */
export const name = 'agent-runtime-profile-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: Settings validates the complete document before commit. */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant contribution.
 * @param ctx - Cordis context carrying invariant diagnostics.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
