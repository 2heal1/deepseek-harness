/**
 * Package-owned invariant companion for the secure Agent Runtime launcher.
 *
 * @module @deepseek-ai/dsh-agent-runtime-launcher/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-runtime-launcher'

/** Cordis companion plugin name. */
export const name = 'agent-runtime-launcher-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: every launch is an owner-scoped handle verified during disposal. */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant contribution.
 * @param ctx - Cordis context carrying invariant diagnostics.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
