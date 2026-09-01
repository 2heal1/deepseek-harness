/**
 * Package-owned invariant companion for the agent runtime Router.
 *
 * The Router publishes through the authoritative Session and Agent registries;
 * their companions validate those event/data relationships. Admission has no
 * independent event stream before F5 adds durable submission events.
 *
 * @module @deepseek-ai/dsh-agent-runtime-router/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-runtime-router'

/** Cordis companion plugin name. */
export const name = 'agent-runtime-router-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: Session and Agent companions own the published registry relations. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
