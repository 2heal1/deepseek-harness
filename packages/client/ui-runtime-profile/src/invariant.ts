/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-runtime-profile`.
 * @module @deepseek-ai/dsh-client-ui-runtime-profile/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-runtime-profile'

/** Cordis companion plugin name. */
export const name = 'client-ui-runtime-profile-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Host validation owns profile and route relationships,
 * while this browser package owns no event stream or mutable runtime data.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
