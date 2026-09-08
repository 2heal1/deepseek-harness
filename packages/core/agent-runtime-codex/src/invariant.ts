/**
 * Package-owned invariant companion for the Codex App Server runtime Provider.
 *
 * @module @deepseek-ai/dsh-agent-runtime-codex/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-runtime-codex'

/** Cordis companion plugin name. */
export const name = 'agent-runtime-codex-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Router-owned submission invariants cover all Codex runtime output. */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant contribution.
 * @param ctx - context carrying invariant diagnostics.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
