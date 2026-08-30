/**
 * Host half of remote Bundle browser loading. It projects the resolved builds
 * selected by app boot into one JSON page global; the browser half performs
 * direct URL loading.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name. */
export const name = 'client-remote-bundles'

/**
 * Project remote browser descriptors into the generated page.
 * @param ctx - Host context carrying the profile registry and Web server.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    const bundles = ctx.get('remoteBundles')?.web() ?? []
    if (bundles.length === 0) return
    table.push({ kind: 'global', name: '__DSH_REMOTE_BUNDLES__', value: bundles })
  })
}
