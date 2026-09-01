import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchRemoteBundleManifest,
  parseRemoteBundleManifest,
  remoteContainerName,
  RemoteBundleRegistry,
  type RemoteBundleManifest,
  type ResolvedRemoteBundle,
} from '../src/index.ts'

const federation = vi.hoisted(() => ({
  createInstance: vi.fn(),
  loadRemote: vi.fn(),
}))

vi.mock('@module-federation/runtime', () => ({
  createInstance: federation.createInstance,
}))

const manifest: RemoteBundleManifest = {
  schemaVersion: 1,
  name: 'example-bundle',
  buildId: 'build-1',
  patch: 'builds/build-1/cordis.patch.yml',
  node: {
    entry: 'builds/build-1/node/remoteEntry.js',
    shared: [{ request: '@deepseek-ai/cordis', requiredVersion: '^4.0.0' }],
  },
  web: {
    entry: 'builds/build-1/web/remoteEntry.js',
    shared: ['@deepseek-ai/cordis', 'react'],
  },
}

beforeEach(() => {
  federation.loadRemote.mockReset()
  federation.createInstance.mockReset()
  federation.createInstance.mockReturnValue({ loadRemote: federation.loadRemote })
})

function stageAnchor(packages: Record<string, { version?: unknown; source?: string }> = {
  '@deepseek-ai/cordis': { version: '4.0.0' },
}): { anchor: string; profileDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-bundle-'))
  const app = join(root, 'app')
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir)
  writeFileSync(join(profileDir, 'package.json'), '{}')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0' }))
  for (const [name, pkg] of Object.entries(packages)) {
    const directory = join(app, 'node_modules', ...name.split('/'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name,
      type: 'module',
      ...pkg.source === undefined ? {} : { main: './index.js' },
      version: pkg.version,
    }))
    if (pkg.source !== undefined) writeFileSync(join(directory, 'index.js'), pkg.source)
  }
  return { anchor: join(app, 'package.json'), profileDir }
}

function makeResponse(body: string, url = ''): Response {
  const result = new Response(body)
  if (url !== '') Object.defineProperty(result, 'url', { value: url })
  return result
}

describe('remote Bundle manifest', () => {
  it('validates the version-one Node and browser descriptors', () => {
    expect(parseRemoteBundleManifest(manifest)).toEqual(manifest)
    expect(remoteContainerName('build-1')).toMatch(/^dsh_[a-f0-9]{20}$/)
    expect(remoteContainerName('build-1')).toBe(remoteContainerName('build-1'))
    expect(remoteContainerName('build-1')).not.toBe(remoteContainerName('build-2'))
  })

  it('rejects malformed protocol fields and duplicate shared requests', () => {
    for (const [value, message] of [
      [null, 'must be an object'],
      [{ ...manifest, schemaVersion: 2 }, 'schemaVersion must be 1'],
      [{ ...manifest, name: '' }, 'name must be a non-empty string'],
      [{ ...manifest, node: [] }, '.node must be an object'],
      [{ ...manifest, node: { ...manifest.node, shared: {} } }, '.node.shared must be an array'],
      [{ ...manifest, node: { ...manifest.node, shared: [null] } }, '.node.shared[0] must be an object'],
      [{ ...manifest, node: { ...manifest.node, shared: [{ request: '', requiredVersion: '*' }] } }, '.request must be a non-empty string'],
      [{ ...manifest, node: { ...manifest.node, shared: [...manifest.node.shared, manifest.node.shared[0]] } }, 'duplicate request'],
      [{ ...manifest, web: { ...manifest.web, shared: {} } }, '.web.shared must be a string array'],
      [{ ...manifest, web: { ...manifest.web, shared: [1] } }, '.web.shared[0] must be a non-empty string'],
      [{ ...manifest, web: { ...manifest.web, shared: ['react', 'react'] } }, 'duplicate value'],
    ] as const) {
      expect(() => parseRemoteBundleManifest(value)).toThrow(message)
    }
    expect(parseRemoteBundleManifest({ ...manifest, web: { entry: 'entry.js' } }).web?.shared).toEqual([])
    expect(parseRemoteBundleManifest({ ...manifest, web: undefined })).not.toHaveProperty('web')
  })

  it('fetches JSON from HTTP(S), preserves the final URL, and labels failures', async () => {
    const response = new Response(JSON.stringify(manifest), { status: 200 })
    Object.defineProperty(response, 'url', { value: 'https://cdn.example.test/release/dsh-bundle.json' })
    const fetchImpl = vi.fn(async () => response)
    await expect(fetchRemoteBundleManifest('https://example.test/dsh-bundle.json', fetchImpl)).resolves.toEqual({
      manifest,
      url: 'https://cdn.example.test/release/dsh-bundle.json',
    })
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/dsh-bundle.json')

    await expect(fetchRemoteBundleManifest('file:///tmp/dsh-bundle.json', fetchImpl)).rejects.toThrow('must be an HTTP(S) URL')
    await expect(fetchRemoteBundleManifest('not a URL', fetchImpl)).rejects.toThrow('must be an HTTP(S) URL')
    await expect(fetchRemoteBundleManifest('https://example.test/missing', async () => new Response('', { status: 404 })))
      .rejects.toThrow('returned HTTP 404')
    await expect(fetchRemoteBundleManifest('https://example.test/broken', async () => new Response('{')))
      .rejects.toThrow('is not valid JSON')
    await expect(fetchRemoteBundleManifest('https://example.test/down', async () => { throw new Error('offline') }))
      .rejects.toThrow('failed to fetch remote Bundle manifest')
    const invalidResponseUrl = makeResponse(JSON.stringify(manifest), 'file:///tmp/dsh-bundle.json')
    await expect(fetchRemoteBundleManifest('https://example.test/invalid-final', async () => invalidResponseUrl))
      .rejects.toThrow('response URL must be an HTTP(S) URL')
  })

  it('loads, validates, and rewrites a remote Node Bundle', async () => {
    const { anchor, profileDir } = stageAnchor()
    const patch = [
      '- insert:',
      '    - id: group',
      '      group: true',
      '      config:',
      '        - id: first',
      '          name: example-bundle',
      '        - id: second',
      '          name: example-bundle',
      '        - id: builtin',
      '          name: cordis:loader',
      '',
    ].join('\n')
    const module = { apply: () => {} }
    federation.loadRemote.mockResolvedValue({ modules: { 'example-bundle': module } })
    const fetchImpl = vi.fn(async (input: string | URL) => (
      String(input).endsWith('dsh-bundle.json')
        ? makeResponse(JSON.stringify(manifest))
        : makeResponse(patch)
    ))

    const loaded = await import('../src/remote-bundle.ts').then(({ loadRemoteBundle }) => loadRemoteBundle(
      'test',
      { type: 'remote', name: 'example-bundle', url: 'https://example.test/dsh-bundle.json' },
      anchor,
      profileDir,
      fetchImpl,
    ))

    const children = loaded.patches[0]?.insert?.[0]?.config as { name: string }[]
    expect(children[0]?.name).toBe(children[1]?.name)
    expect(children[0]?.name).toMatch(/^cordis:dsh-remote\//)
    expect(children[2]?.name).toBe('cordis:loader')
    expect(Object.values(loaded.builtins)).toEqual([module])
    expect(loaded.web).toEqual({
      name: manifest.name,
      buildId: manifest.buildId,
      container: remoteContainerName(manifest.buildId),
      entry: 'https://example.test/builds/build-1/web/remoteEntry.js',
      shared: ['@deepseek-ai/cordis', 'react'],
    })
    const options = federation.createInstance.mock.calls.at(-1)?.[0] as {
      shared: Record<string, { get(): Promise<() => unknown> }>
    }
    const cordisFactory = await options.shared['@deepseek-ai/cordis']!.get()
    expect(cordisFactory()).toHaveProperty('Context')
  })

  it('fails loud for inconsistent sources, artifacts, shares, and bootstrap exports', async () => {
    const staged = stageAnchor()
    const source = { type: 'remote' as const, name: 'example-bundle', url: 'https://example.test/dsh-bundle.json' }
    const patch = '- insert:\n    - id: fixture\n      name: example-bundle\n'
    const load = async (
      candidate: RemoteBundleManifest,
      patchResult: Response | Error = makeResponse(patch),
    ): Promise<unknown> => {
      const fetchImpl = async (input: string | URL): Promise<Response> => {
        if (String(input).endsWith('dsh-bundle.json')) return makeResponse(JSON.stringify(candidate))
        if (patchResult instanceof Error) throw patchResult
        return patchResult
      }
      const { loadRemoteBundle } = await import('../src/remote-bundle.ts')
      return loadRemoteBundle('test', source, staged.anchor, staged.profileDir, fetchImpl)
    }

    await expect(load({ ...manifest, name: 'other' })).rejects.toThrow('expected "example-bundle"')
    await expect(load(manifest, new Error('offline'))).rejects.toThrow('failed to fetch remote Bundle patch')
    await expect(load(manifest, new Response('', { status: 404 }))).rejects.toThrow('patch')
    await expect(load({ ...manifest, node: { ...manifest.node, entry: 'file:///entry.js' } }))
      .rejects.toThrow('Node entry must be an HTTP(S) URL')
    await expect(load({ ...manifest, node: { ...manifest.node, shared: [{ request: 'absent', requiredVersion: '*' }] } }))
      .rejects.toThrow('cannot resolve shared module')

    const versionless = stageAnchor({ versionless: { version: '' } })
    const { loadRemoteBundle } = await import('../src/remote-bundle.ts')
    await expect(loadRemoteBundle('test', source, versionless.anchor, versionless.profileDir, async input => (
      String(input).endsWith('dsh-bundle.json')
        ? makeResponse(JSON.stringify({ ...manifest, node: { ...manifest.node, shared: [{ request: 'versionless', requiredVersion: '*' }] } }))
        : makeResponse(patch)
    ))).rejects.toThrow('has no package version')

    federation.loadRemote.mockResolvedValueOnce({ modules: {} })
    await expect(load(manifest)).rejects.toThrow('did not export patch module')
    federation.loadRemote.mockResolvedValueOnce(null)
    await expect(load(manifest)).rejects.toThrow('remote bootstrap must be an object')
    federation.loadRemote.mockResolvedValueOnce({ modules: null })
    await expect(load(manifest)).rejects.toThrow('remote bootstrap modules must be an object')
  })

  it('loads non-Cordis Host shares and reports module import failures', async () => {
    const staged = stageAnchor({
      good: { version: '1.0.0', source: 'export const value = 42\n' },
      broken: { version: '1.0.0', source: 'this is not JavaScript\n' },
      missing: { version: '1.0.0' },
    })
    const source = { type: 'remote' as const, name: 'example-bundle', url: 'https://example.test/dsh-bundle.json' }
    const patch = '- id: metadata\n  config: {}\n'
    federation.loadRemote.mockResolvedValue({ modules: {} })
    const load = async (request: string): Promise<unknown> => {
      const candidate = {
        ...manifest,
        web: undefined,
        node: { ...manifest.node, shared: [{ request, requiredVersion: '*' }] },
      }
      const { loadRemoteBundle } = await import('../src/remote-bundle.ts')
      const result = await loadRemoteBundle('test', source, staged.anchor, staged.profileDir, async input => (
        String(input).endsWith('dsh-bundle.json')
          ? makeResponse(JSON.stringify(candidate))
          : makeResponse(patch)
      ))
      expect(result.patches[0]).not.toHaveProperty('insert')
      const options = federation.createInstance.mock.calls.at(-1)?.[0] as {
        shared: Record<string, { get(): Promise<() => unknown> }>
      }
      return options.shared[request]!.get().then(factory => factory())
    }

    await expect(load('good')).resolves.toMatchObject({ value: 42 })
    await expect(load('broken')).rejects.toThrow('cannot load shared module "broken"')
    await expect(load('missing')).rejects.toThrow('cannot load shared module "missing"')
  })
})

describe('RemoteBundleRegistry', () => {
  function bundle(buildId: string, builtins: Record<string, unknown> = {}): ResolvedRemoteBundle {
    return {
      source: { type: 'remote', name: 'example-bundle', url: 'https://example.test/dsh-bundle.json' },
      manifest: { ...manifest, buildId },
      patches: [],
      builtins,
    }
  }

  it('installs Loader builtins and rejects build/container collisions', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader).await()
    const namespace = { apply: () => {} }
    const registry = new RemoteBundleRegistry([bundle('build-a', { 'remote/a': namespace })])
    registry.install(ctx)
    expect(ctx.loader.builtins['remote/a']).toBe(namespace)
    expect(registry.web()).toEqual([])
    const browser = {
      name: 'example-bundle',
      buildId: 'build-web',
      container: remoteContainerName('build-web'),
      entry: 'https://example.test/web/remoteEntry.js',
      shared: ['@deepseek-ai/cordis'],
    }
    expect(new RemoteBundleRegistry([{ ...bundle('build-web'), web: browser }]).web()).toEqual([browser])
    expect(() => { registry.install(ctx) }).toThrow('duplicate remote Loader builtin')
    expect(() => new RemoteBundleRegistry([bundle('same'), bundle('same')])).toThrow('buildId collision')
    const builtins = ctx.loader.builtins
    builtins['remote/a'] = { replacement: true }
    await ctx.fiber.dispose()
    expect(builtins['remote/a']).toEqual({ replacement: true })

    const duplicate = new Context()
    await duplicate.plugin(Loader).await()
    expect(() => {
      new RemoteBundleRegistry([
        bundle('build-b', { 'remote/shared': {} }),
        bundle('build-c', { 'remote/shared': {} }),
      ]).install(duplicate)
    }).toThrow('duplicate remote Loader builtin')
    await duplicate.fiber.dispose()

    const removable = new Context()
    await removable.plugin(Loader).await()
    new RemoteBundleRegistry([bundle('build-d', { 'remote/removable': namespace })]).install(removable)
    const removableBuiltins = removable.loader.builtins
    expect(removableBuiltins['remote/removable']).toBe(namespace)
    await removable.fiber.dispose()
    expect(removableBuiltins).not.toHaveProperty('remote/removable')
  })
})
