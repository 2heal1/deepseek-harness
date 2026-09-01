// @vitest-environment jsdom

import * as Cordis from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import { RemoteBundleRegistry, type ResolvedRemoteBundle, type ResolvedRemoteWebBundle } from '@deepseek-ai/dsh-app-boot'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyHost, inject as hostInject } from '../src/index.ts'
import { apply as applyClient, inject as clientInject } from '../src/client/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserLate: string
    browserRemoteValue: string
  }
}

const globals: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  document.head.replaceChildren()
  delete window.__DSH_REMOTE_BUNDLES__
  for (const name of globals.splice(0)) Reflect.deleteProperty(globalThis, name)
})

function browserBundle(suffix: string): ResolvedRemoteWebBundle {
  return {
    name: `remote-${suffix}`,
    buildId: `build-${suffix}`,
    container: `dsh_container_${suffix}`,
    entry: `https://plugins.example.test/${suffix}/remoteEntry.js`,
    shared: ['@deepseek-ai/cordis'],
  }
}

function resolvedBundle(web: ResolvedRemoteWebBundle): ResolvedRemoteBundle {
  return {
    source: { type: 'remote', name: web.name, url: `https://plugins.example.test/${web.name}/dsh-bundle.json` },
    manifest: {
      schemaVersion: 1,
      name: web.name,
      buildId: web.buildId,
      patch: './cordis.patch.yml',
      node: { entry: './node/remoteEntry.js', shared: [] },
      web: { entry: web.entry, shared: web.shared },
    },
    patches: [],
    builtins: {},
    web,
  }
}

function collect(ctx: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  return table
}

describe('remote Bundles Host bridge', () => {
  it('projects the current profile descriptors and removes its listener on disposal', async () => {
    const web = browserBundle('host')
    const ctx = new Context()
    ctx.provide('remoteBundles', new RemoteBundleRegistry([resolvedBundle(web)]))
    const fiber = ctx.plugin({ inject: [...hostInject], apply: applyHost })
    await fiber.await()
    expect(collect(ctx)).toEqual([{ kind: 'global', name: '__DSH_REMOTE_BUNDLES__', value: [web] }])
    await fiber.dispose()
    expect(collect(ctx)).toEqual([])
  })

  it('is idle when the profile remote registry is empty', async () => {
    const ctx = new Context()
    ctx.provide('remoteBundles', new RemoteBundleRegistry([]))
    await ctx.plugin({ inject: [...hostInject], apply: applyHost }).await()
    expect(collect(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('remote Bundles browser bridge', () => {
  it('is idle without projected browser builds', async () => {
    const ctx = new Context()
    ctx.provide('modules', { import: async () => Cordis } as unknown as ClientModuleLoader)
    await ctx.plugin({ inject: [...clientInject], apply: applyClient }).await()
    await ctx.fiber.dispose()
  })

  it('loads a direct remote entry, supplies Host Cordis, and remounts without reinitializing the container', async () => {
    const web = browserBundle('client')
    window.__DSH_REMOTE_BUNDLES__ = [web]
    const remotePlugin = {
      apply(ctx: Context) { ctx.provide('browserRemoteValue', 'loaded') },
    }
    const init = vi.fn(async (scope: Record<string, Record<string, { get(): Promise<() => unknown> }>>) => {
      const factory = await scope['@deepseek-ai/cordis']!['0.0.0']!.get()
      expect(factory()).toBe(Cordis)
    })
    const container = {
      init,
      get: vi.fn(async () => () => remotePlugin),
    }
    globals.push(web.container)
    Reflect.set(globalThis, web.container, container)
    const append = vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected remote script')
      expect(script.src).toBe(web.entry)
      queueMicrotask(() => script.dispatchEvent(new Event('load')))
      return script
    })

    const ctx = new Context()
    ctx.provide('modules', {
      import: async (request: string) => {
        if (request !== '@deepseek-ai/cordis') throw new Error(`unexpected browser share ${request}`)
        return Cordis
      },
    } as unknown as ClientModuleLoader)
    const mount = async () => {
      const fiber = ctx.plugin({ inject: [...clientInject], apply: applyClient })
      await fiber.await()
      expect(ctx.get('browserRemoteValue')).toBe('loaded')
      await fiber.dispose()
      expect(ctx.get('browserRemoteValue')).toBeUndefined()
    }
    await mount()
    await mount()
    expect(append).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledTimes(1)
    expect(container.get).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('lets a remote plugin wait for a service mounted later in the Web graph', async () => {
    const web = browserBundle('late-service')
    window.__DSH_REMOTE_BUNDLES__ = [web]
    const remotePlugin = {
      inject: ['browserLate'],
      apply(ctx: Context) { ctx.provide('browserRemoteValue', ctx.browserLate) },
    }
    const container = {
      init: vi.fn(),
      get: vi.fn(async () => () => ({ default: remotePlugin })),
    }
    globals.push(web.container)
    Reflect.set(globalThis, web.container, container)
    vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected remote script')
      queueMicrotask(() => script.dispatchEvent(new Event('load')))
      return script
    })

    const ctx = new Context()
    ctx.provide('modules', { import: async () => Cordis } as unknown as ClientModuleLoader)
    const bridge = ctx.plugin({ inject: [...clientInject], apply: applyClient })
    await bridge.await()
    expect(ctx.get('browserRemoteValue')).toBeUndefined()

    await ctx.plugin((inner) => { inner.provide('browserLate', 'available') }).await()
    await vi.waitFor(() => { expect(ctx.get('browserRemoteValue')).toBe('available') })
    await ctx.fiber.dispose()
  })

  it('reports an entry that loads without publishing its named container', async () => {
    const web = browserBundle('missing')
    window.__DSH_REMOTE_BUNDLES__ = [web]
    vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected remote script')
      queueMicrotask(() => script.dispatchEvent(new Event('load')))
      return script
    })
    const ctx = new Context()
    ctx.provide('modules', { import: async () => Cordis } as unknown as ClientModuleLoader)
    await expect(ctx.plugin({ inject: [...clientInject], apply: applyClient }).await())
      .rejects.toThrow('did not publish container')
    await ctx.fiber.dispose()
  })

  it('retries failed entry loads and failed container initialization', async () => {
    const entryFailure = browserBundle('entry-failure')
    window.__DSH_REMOTE_BUNDLES__ = [entryFailure]
    const append = vi.spyOn(document.head, 'append')
      .mockImplementation((...nodes: (Node | string)[]) => {
        const script = nodes[0]
        if (!(script instanceof HTMLScriptElement)) throw new Error('expected remote script')
        script.dispatchEvent(new Event('load'))
        return script
      })
      .mockImplementationOnce((...nodes: (Node | string)[]) => {
        const script = nodes[0]
        if (!(script instanceof HTMLScriptElement)) throw new Error('expected remote script')
        script.dispatchEvent(new Event('error'))
        return script
      })
    const entryContainer = {
      init: vi.fn(),
      get: vi.fn(async () => () => ({ default: () => {} })),
    }
    globals.push(entryFailure.container)
    Reflect.set(globalThis, entryFailure.container, entryContainer)
    const mount = async (): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> => {
      const ctx = new Context()
      ctx.provide('modules', { import: async () => Cordis } as unknown as ClientModuleLoader)
      const fiber = ctx.plugin({ inject: [...clientInject], apply: applyClient })
      return { ctx, fiber }
    }
    const failedEntry = await mount()
    await expect(failedEntry.fiber.await()).rejects.toThrow('browser entry failed to load')
    await failedEntry.ctx.fiber.dispose()
    const retriedEntry = await mount()
    await retriedEntry.fiber.await()
    expect(append).toHaveBeenCalledTimes(2)
    await retriedEntry.ctx.fiber.dispose()

    const initFailure = browserBundle('init-failure')
    window.__DSH_REMOTE_BUNDLES__ = [initFailure]
    const init = vi.fn()
      .mockRejectedValueOnce(new Error('initialization failed'))
      .mockResolvedValueOnce(undefined)
    const initContainer = {
      init,
      get: vi.fn(async () => () => ({ default: () => {} })),
    }
    globals.push(initFailure.container)
    Reflect.set(globalThis, initFailure.container, initContainer)
    const failedInit = await mount()
    await expect(failedInit.fiber.await()).rejects.toThrow('initialization failed')
    await failedInit.ctx.fiber.dispose()
    const retriedInit = await mount()
    await retriedInit.fiber.await()
    expect(init).toHaveBeenCalledTimes(2)
    await retriedInit.ctx.fiber.dispose()
  })

  it('rejects malformed containers and client module exports', async () => {
    vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected remote script')
      queueMicrotask(() => script.dispatchEvent(new Event('load')))
      return script
    })

    for (const [suffix, container] of [
      ['missing-init', { get: vi.fn() }],
      ['missing-get', { init: vi.fn() }],
    ] as const) {
      const web = browserBundle(suffix)
      window.__DSH_REMOTE_BUNDLES__ = [web]
      globals.push(web.container)
      Reflect.set(globalThis, web.container, container)
      const ctx = new Context()
      ctx.provide('modules', { import: async () => Cordis } as unknown as ClientModuleLoader)
      await expect(ctx.plugin({ inject: [...clientInject], apply: applyClient }).await())
        .rejects.toThrow('did not publish container')
      await ctx.fiber.dispose()
    }

    for (const [suffix, exports] of [
      ['null-module', null],
      ['primitive-module', 'not a plugin'],
    ] as const) {
      const web = browserBundle(suffix)
      window.__DSH_REMOTE_BUNDLES__ = [web]
      const container = {
        init: vi.fn(),
        get: vi.fn(async () => () => exports),
      }
      globals.push(web.container)
      Reflect.set(globalThis, web.container, container)
      const ctx = new Context()
      ctx.provide('modules', { import: async () => Cordis } as unknown as ClientModuleLoader)
      await expect(ctx.plugin({ inject: [...clientInject], apply: applyClient }).await())
        .rejects.toThrow('returned no Cordis plugin')
      await ctx.fiber.dispose()
    }
  })
})
