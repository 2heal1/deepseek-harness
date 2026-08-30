/** Browser half that loads and mounts remote Bundle client plugins. */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ResolvedRemoteWebBundle } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-modules/client'

declare global {
  interface Window {
    /** Host-projected remote Bundle browser builds. */
    __DSH_REMOTE_BUNDLES__?: ResolvedRemoteWebBundle[]
  }
}

interface FederationContainer {
  init(scope: FederationShareScope): Promise<void> | void
  get(module: './client'): Promise<() => unknown>
}

interface FederationShareRecord {
  get(): Promise<() => unknown>
  from: string
  eager: boolean
  loaded: boolean
}

type FederationShareScope = Record<string, Record<string, FederationShareRecord>>

const entryLoads = new Map<string, Promise<void>>()
const containerInitializations = new Map<string, Promise<FederationContainer>>()

function loadScript(url: string): Promise<void> {
  const existing = entryLoads.get(url)
  if (existing !== undefined) return existing
  const loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = url
    script.addEventListener('load', () => { resolve() }, { once: true })
    script.addEventListener('error', () => {
      reject(new Error(`remote Bundle browser entry failed to load: ${url}`))
    }, { once: true })
    document.head.append(script)
  })
  entryLoads.set(url, loading)
  return loading.catch((error: unknown) => {
    entryLoads.delete(url)
    throw error
  })
}

function remoteContainer(name: string): FederationContainer {
  const value = Reflect.get(globalThis, name) as Partial<FederationContainer> | undefined
  if (value === undefined || typeof value.init !== 'function' || typeof value.get !== 'function') {
    throw new Error(`remote Bundle entry did not publish container ${JSON.stringify(name)}`)
  }
  return value as FederationContainer
}

function shareScope(ctx: Context, bundle: ResolvedRemoteWebBundle): FederationShareScope {
  return Object.fromEntries(bundle.shared.map(request => [request, {
    '0.0.0': {
      get: async () => {
        const exports = await ctx.modules.import(request, '', {})
        return () => exports
      },
      from: 'dsh',
      eager: true,
      loaded: true,
    },
  }]))
}

async function initializedContainer(ctx: Context, bundle: ResolvedRemoteWebBundle): Promise<FederationContainer> {
  const key = `${bundle.container}\0${bundle.entry}`
  const existing = containerInitializations.get(key)
  if (existing !== undefined) return existing
  const initializing = loadScript(bundle.entry).then(async () => {
    const container = remoteContainer(bundle.container)
    await container.init(shareScope(ctx, bundle))
    return container
  })
  containerInitializations.set(key, initializing)
  return initializing.catch((error: unknown) => {
    containerInitializations.delete(key)
    throw error
  })
}

async function loadRemotePlugin(ctx: Context, bundle: ResolvedRemoteWebBundle): Promise<void> {
  const container = await initializedContainer(ctx, bundle)
  const factory = await container.get('./client')
  const exports = factory()
  if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null) {
    throw new Error(`remote Bundle ${JSON.stringify(bundle.name)} client module returned no Cordis plugin`)
  }
  const plugin: unknown = (exports as { default?: unknown }).default ?? exports
  ctx.plugin(plugin as Plugin)
}

/** Cordis plugin name. */
export const name = 'remote-bundles'
/** Client module system used to supply singleton shares. */
export const inject = ['modules']

/**
 * Load selected browser builds directly from their published URLs and mount
 * each exported Cordis plugin in profile order.
 * @param ctx - browser Cordis context.
 */
export async function apply(ctx: Context): Promise<void> {
  for (const bundle of window.__DSH_REMOTE_BUNDLES__ ?? []) await loadRemotePlugin(ctx, bundle)
}
