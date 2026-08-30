import { createServer, type Server } from 'node:http'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  loadRemoteBundle, RemoteBundleRegistry, type RemoteBundleManifest,
} from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBundle, lintBundle, loadBundleProject } from '../src/index.ts'
import { bundleRules, exactAliases, nodeRuntimePlugin } from '../src/webpack.ts'

const roots: string[] = []
const INSTALL_ANCHOR = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { client?: boolean; clientDeclaration?: boolean; peer?: boolean; peerRange?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-builder-'))
  roots.push(root)
  mkdirSync(join(root, 'src', 'client'), { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-remote-bundle',
    version: '1.0.0',
    type: 'module',
    ...options.peer === false ? {} : { peerDependencies: { '@deepseek-ai/cordis': options.peerRange ?? '^4.0.0' } },
    devDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
    ...options.clientDeclaration === true ? { dsh: { client: { platform: 'web' } } } : {},
  }, undefined, 2)}\n`)
  writeFileSync(join(root, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fixture-remote',
    '      name: fixture-remote-bundle',
    '      config:',
    '        value: loaded-over-http',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'index.ts'), [
    "import { Context } from '@deepseek-ai/cordis'",
    "declare module '@deepseek-ai/cordis' { interface Context { remoteFixture: string } }",
    "export const name = 'fixture-remote'",
    'export const cordisContext = Context',
    'export interface Config { value: string }',
    "export function apply(ctx: Context, config: Config): void { ctx.provide('remoteFixture', config.value) }",
    '',
  ].join('\n'))
  if (options.client === true) {
    writeFileSync(join(root, 'src', 'client', 'index.ts'), [
      "import type { Context } from '@deepseek-ai/cordis'",
      "export const name = 'fixture-remote-client'",
      'export function apply(_ctx: Context): void {}',
      '',
    ].join('\n'))
  }
  return root
}

function installManifest(root: string, name: string, manifest: Record<string, unknown>): void {
  const directory = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(directory, 'index.js'), 'export {}\n')
}

function updateManifest(root: string, update: (manifest: Record<string, unknown>) => void): void {
  const path = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  update(manifest)
  writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

async function serve(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const path = join(root, new URL(request.url ?? '/', 'http://fixture.invalid').pathname)
    try {
      const body = readFileSync(path)
      response.writeHead(200, {
        'content-type': extname(path) === '.json' ? 'application/json' : 'text/javascript',
      })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('fixture server returned no TCP address')
  return { server, url: `http://127.0.0.1:${String(address.port)}/dsh-bundle.json` }
}

describe('DSH Bundle Builder', () => {
  it('provides deterministic Webpack rules, aliases, and the Node runtime plugin', () => {
    expect(bundleRules()).toHaveLength(3)
    expect(exactAliases(new Map([
      ['absolute', '/tmp/absolute.ts'],
      ['windows', 'C:\\project\\entry.ts'],
      ['package', 'dependency'],
    ]))).toEqual({
      'absolute$': '/tmp/absolute.ts',
      'windows$': 'C:\\project\\entry.ts',
    })
    expect(nodeRuntimePlugin()).toContain('@module-federation')
  })

  it('uses the zero-config layout and requires the Cordis singleton peer', () => {
    const root = fixture({ client: true })
    const project = loadBundleProject({ cwd: root, buildId: 'build-1' })
    expect(project).toMatchObject({
      name: 'fixture-remote-bundle',
      target: 'dual',
      buildId: 'build-1',
      client: { inject: [], external: [], immediately: false },
    })
    expect(project.nodeEntry).toBe(join(root, 'src', 'index.ts'))
    expect(project.clientEntry).toBe(join(root, 'src', 'client', 'index.ts'))
    expect(project.modules.get('fixture-remote-bundle')).toBe(project.nodeEntry)
    expect(() => lintBundle({ cwd: fixture({ peer: false }) })).toThrow('must declare @deepseek-ai/cordis')
  })

  it('normalizes workspace peer ranges and rejects incomplete browser artifacts', () => {
    const workspaceRoot = fixture({ peerRange: 'workspace:^' })
    installManifest(workspaceRoot, '@deepseek-ai/cordis', {
      name: '@deepseek-ai/cordis',
      version: '4.7.2',
      type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' },
    })
    expect(loadBundleProject({ cwd: workspaceRoot }).peers['@deepseek-ai/cordis']).toBe('^4.7.2')

    expect(() => loadBundleProject({ cwd: fixture({ clientDeclaration: true }) }))
      .toThrow('declares dsh.client but no browser entry exists')

    const dependencyRoot = fixture()
    installManifest(dependencyRoot, 'browser-dependency', {
      name: 'browser-dependency',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js', './package.json': './package.json' },
      dsh: { client: { platform: 'web' } },
    })
    writeFileSync(join(dependencyRoot, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: fixture-remote',
      '      name: fixture-remote-bundle',
      '    - id: browser-dependency',
      '      name: browser-dependency',
      '',
    ].join('\n'))
    expect(() => lintBundle({ cwd: dependencyRoot, target: 'remote' }))
      .toThrow('remote target cannot include browser plugin "browser-dependency" from a dependency')
    expect(() => lintBundle({ cwd: dependencyRoot, target: 'package' })).not.toThrow()

    const ordinaryRoot = fixture()
    installManifest(ordinaryRoot, 'ordinary-dependency', {
      name: 'ordinary-dependency', version: '1.0.0', main: './index.js', exports: { '.': './index.js' },
    })
    writeFileSync(join(ordinaryRoot, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: fixture',
      '      name: fixture-remote-bundle',
      '    - id: ordinary',
      '      name: ordinary-dependency',
      '    - id: builtin-module',
      '      name: node:fs',
      '',
    ].join('\n'))
    expect(() => lintBundle({ cwd: ordinaryRoot, target: 'remote' })).not.toThrow()

    const scopedRoot = fixture()
    installManifest(scopedRoot, '@scope/browser-plugin', {
      name: '@scope/browser-plugin',
      version: '1.0.0',
      main: './index.js',
      exports: { '.': './index.js' },
      dsh: { client: { platform: 'web' } },
    })
    writeFileSync(join(scopedRoot, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: fixture',
      '      name: fixture-remote-bundle',
      '    - id: scoped-browser',
      '      name: "@scope/browser-plugin"',
      '',
    ].join('\n'))
    expect(() => lintBundle({ cwd: scopedRoot, target: 'remote' })).toThrow('browser plugin "@scope/browser-plugin"')
  })

  it('validates configuration, entries, module sources, and workspace ranges', () => {
    const invalidCases: [string, (manifest: Record<string, unknown>) => void, string][] = [
      ['name', (manifest) => { manifest.name = '' }, 'must declare a non-empty name'],
      ['version', (manifest) => { manifest.version = '' }, 'must declare a non-empty version'],
      ['target', (manifest) => { manifest.dsh = { bundleBuilder: { target: 'other' } } }, 'target must be'],
      ['outDir', (manifest) => { manifest.dsh = { bundleBuilder: { outDir: '' } } }, 'outDir must be'],
      ['patch', (manifest) => { manifest.dsh = { bundleBuilder: { patch: '' } } }, 'patch must be'],
      ['nodeEntry type', (manifest) => { manifest.dsh = { bundleBuilder: { nodeEntry: 1 } } }, 'nodeEntry must be a string'],
      ['nodeEntry missing', (manifest) => { manifest.dsh = { bundleBuilder: { nodeEntry: 'missing.ts' } } }, 'nodeEntry not found'],
      ['modules', (manifest) => { manifest.dsh = { bundleBuilder: { modules: [] } } }, 'modules must be an object'],
      ['peerDependencies', (manifest) => { manifest.peerDependencies = [] }, 'peerDependencies must be an object'],
    ]
    for (const [, mutate, message] of invalidCases) {
      const root = fixture()
      updateManifest(root, (manifest) => { mutate(manifest) })
      expect(() => loadBundleProject({ cwd: root })).toThrow(message)
    }

    const unreadable = fixture()
    rmSync(join(unreadable, 'package.json'))
    expect(() => loadBundleProject({ cwd: unreadable })).toThrow('failed to read')
    const missingPatch = fixture()
    rmSync(join(missingPatch, 'cordis.patch.yml'))
    expect(() => loadBundleProject({ cwd: missingPatch })).toThrow('failed to read patch')
    const invalidClient = fixture({ client: true })
    updateManifest(invalidClient, (manifest) => { manifest.dsh = { client: { inject: [1] } } })
    expect(() => loadBundleProject({ cwd: invalidClient })).toThrow('inject must be a string array')

    for (const [range, expected] of [
      ['workspace:*', '4.7.2'],
      ['workspace:~', '~4.7.2'],
      ['workspace:>=4', '>=4'],
      ['^4.0.0', '^4.0.0'],
    ] as const) {
      const root = fixture({ peerRange: range })
      installManifest(root, '@deepseek-ai/cordis', {
        name: '@deepseek-ai/cordis',
        version: '4.7.2',
        exports: { '.': './index.js', './package.json': './package.json' },
      })
      expect(loadBundleProject({ cwd: root }).peers['@deepseek-ai/cordis']).toBe(expected)
    }
    const absentWorkspace = fixture()
    updateManifest(absentWorkspace, (manifest) => {
      manifest.peerDependencies = { '@deepseek-ai/cordis': '^4.0.0', 'absent-workspace': 'workspace:*' }
    })
    expect(() => loadBundleProject({ cwd: absentWorkspace })).toThrow('cannot resolve workspace dependency')
    const versionlessWorkspace = fixture()
    updateManifest(versionlessWorkspace, (manifest) => {
      manifest.peerDependencies = { '@deepseek-ai/cordis': '^4.0.0', versionless: 'workspace:*' }
    })
    installManifest(versionlessWorkspace, 'versionless', {
      name: 'versionless',
      version: '',
      exports: { '.': './index.js', './package.json': './package.json' },
    })
    expect(() => loadBundleProject({ cwd: versionlessWorkspace })).toThrow('has no package version')

    const configured = fixture({ client: true })
    const extra = join(configured, 'src', 'extra.ts')
    writeFileSync(extra, 'export const extra = true\n')
    writeFileSync(join(configured, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: group',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: nested-dependency',
      '          name: dependency',
      '        - id: builtin',
      '          name: cordis:loader',
      '    - id: dependency',
      '      name: dependency',
      '',
    ].join('\n'))
    updateManifest(configured, (manifest) => {
      manifest.dependencies = { dependency: '1.0.0' }
      manifest.dsh = {
        client: { inject: ['service'], external: ['dependency'], immediately: true },
        bundleBuilder: {
          target: 'package',
          outDir: 'output',
          clientEntry: join(configured, 'src', 'client', 'index.ts'),
          modules: { additional: 'src/extra.ts' },
          buildId: 'configured-build',
        },
      }
    })
    installManifest(configured, 'dependency', {
      name: 'dependency', version: '1.0.0', main: './index.js', exports: { '.': './index.js' },
    })
    const project = loadBundleProject({ cwd: configured })
    expect(project).toMatchObject({
      target: 'package',
      outDir: join(configured, 'output'),
      buildId: 'configured-build',
      client: { inject: ['service'], external: ['dependency'], immediately: true },
    })
    expect(project.modules.get('dependency')).toBe('dependency')
    expect(project.modules.get('additional')).toBe(extra)
    expect(project.modules.has('cordis:loader')).toBe(false)
    expect(loadBundleProject({ cwd: configured, target: 'remote', outDir: 'override', buildId: 'override' }))
      .toMatchObject({ target: 'remote', outDir: join(configured, 'override'), buildId: 'override' })

    const relativeModule = fixture()
    writeFileSync(join(relativeModule, 'cordis.patch.yml'), '- insert:\n    - id: relative\n      name: ./src/index.ts\n')
    expect(() => loadBundleProject({ cwd: relativeModule })).toThrow('relative patch module names are not portable')

    const updateOnly = fixture()
    writeFileSync(join(updateOnly, 'cordis.patch.yml'), '- id: fixture\n  config: {}\n')
    expect(loadBundleProject({ cwd: updateOnly }).modules).toEqual(new Map())

    const current = process.cwd()
    process.chdir(fixture())
    try {
      expect(loadBundleProject()).toMatchObject({ name: 'fixture-remote-bundle' })
    } finally {
      process.chdir(current)
    }

    const missingAbsolute = fixture()
    updateManifest(missingAbsolute, (manifest) => {
      manifest.dsh = { bundleBuilder: { modules: { 'fixture-remote-bundle': join(missingAbsolute, 'missing.ts') } } }
    })
    expect(() => lintBundle({ cwd: missingAbsolute })).toThrow('module "fixture-remote-bundle" not found')
    const missingDependency = fixture()
    writeFileSync(join(missingDependency, 'cordis.patch.yml'), '- insert:\n    - id: absent\n      name: absent-dependency\n')
    expect(() => lintBundle({ cwd: missingDependency })).toThrow('cannot resolve patch module')
    const uninsertedClient = fixture({ client: true })
    writeFileSync(join(uninsertedClient, 'cordis.patch.yml'), '[]\n')
    expect(() => lintBundle({ cwd: uninsertedClient })).toThrow('requires the patch to insert')
  })

  it('builds package-only and remote-only variants, including a Node-only Bundle', async () => {
    const packageRoot = fixture({ client: true })
    updateManifest(packageRoot, (manifest) => {
      manifest.dependencies = { react: '^19.0.0' }
      manifest.dsh = { client: { inject: ['service'], external: ['react'], immediately: true } }
    })
    const packageResult = await buildBundle({ cwd: packageRoot, target: 'package' })
    expect(packageResult.packageDir).toBe(join(packageRoot, 'dist'))
    expect(packageResult).not.toHaveProperty('remoteManifest')
    expect(existsSync(join(packageRoot, 'dist', 'remote'))).toBe(false)
    expect(JSON.parse(readFileSync(join(packageResult.packageDir!, 'package.json'), 'utf8'))).toMatchObject({
      dsh: { client: { platform: 'web', inject: ['service'], external: ['react'], immediately: true } },
    })

    const remoteRoot = fixture()
    rmSync(join(remoteRoot, 'src', 'index.ts'))
    writeFileSync(join(remoteRoot, 'cordis.patch.yml'), '- insert:\n    - id: loader\n      name: cordis:loader\n')
    const packageOnlyNode = await buildBundle({ cwd: remoteRoot, target: 'package' })
    expect(existsSync(join(packageOnlyNode.packageDir!, 'index.js'))).toBe(true)
    const packageOnlyManifest = JSON.parse(
      readFileSync(join(packageOnlyNode.packageDir!, 'package.json'), 'utf8'),
    ) as { exports?: unknown }
    expect(packageOnlyManifest.exports)
      .not.toHaveProperty('./client')

    const remoteOnlyRoot = fixture()
    const remoteResult = await buildBundle({ cwd: remoteOnlyRoot, target: 'remote', buildId: 'node-only' })
    expect(remoteResult).not.toHaveProperty('packageDir')
    expect(existsSync(join(remoteOnlyRoot, 'dist', 'package.json'))).toBe(false)
    expect(JSON.parse(readFileSync(remoteResult.remoteManifest!, 'utf8'))).not.toHaveProperty('web')
  }, 30_000)

  it('rejects invalid generations and removes an incomplete immutable build', async () => {
    await expect(buildBundle({ cwd: fixture(), target: 'remote', buildId: 'bad/id' }))
      .rejects.toThrow('buildId may contain only')

    const broken = fixture()
    writeFileSync(join(broken, 'src', 'index.ts'), "import './missing.ts'\nexport const value = true\n")
    await expect(buildBundle({ cwd: broken, target: 'remote', buildId: 'broken' }))
      .rejects.toThrow('remote build failed')
    expect(existsSync(join(broken, 'dist', 'remote', 'builds', 'broken'))).toBe(false)

    const split = fixture({ client: true })
    writeFileSync(join(split, 'src', 'client', 'lazy.ts'), 'export const lazy = true\n')
    writeFileSync(join(split, 'src', 'client', 'index.ts'), "export const lazy = () => import('./lazy.ts')\n")
    await expect(buildBundle({ cwd: split, target: 'package' }))
      .rejects.toThrow('dynamic-import chunks require the remote target')
  }, 30_000)

  it('emits installable and immutable remote artifacts, then loads the remote with Host Cordis identity', async () => {
    const root = fixture({ client: true })
    const result = await buildBundle({ cwd: root, buildId: 'build-e2e' })
    expect(result.packageDir).toBe(join(root, 'dist'))
    expect(result.remoteManifest).toBe(join(root, 'dist', 'remote', 'dsh-bundle.json'))
    const packageManifest = JSON.parse(readFileSync(join(result.packageDir!, 'package.json'), 'utf8')) as {
      dsh: { bundle: { patch: string }; client: { platform: string } }
      exports: Record<string, unknown>
    }
    expect(packageManifest.dsh).toMatchObject({
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    })
    expect(packageManifest.exports).toHaveProperty('./client')

    const remoteManifest = JSON.parse(readFileSync(result.remoteManifest!, 'utf8')) as RemoteBundleManifest
    expect(remoteManifest).toMatchObject({
      schemaVersion: 1,
      name: 'fixture-remote-bundle',
      buildId: 'build-e2e',
      web: { shared: ['@deepseek-ai/cordis'] },
    })
    expect(() => readFileSync(join(root, 'dist', 'remote', remoteManifest.node.entry))).not.toThrow()
    writeFileSync(join(root, 'dist', 'stale-package-file'), '')
    await buildBundle({ cwd: root, target: 'package' })
    expect(existsSync(join(root, 'dist', 'stale-package-file'))).toBe(false)
    expect(existsSync(result.remoteManifest!)).toBe(true)
    await expect(buildBundle({ cwd: root, target: 'remote', buildId: 'build-e2e' }))
      .rejects.toThrow('immutable remote build already exists')

    const published = await serve(join(root, 'dist', 'remote'))
    try {
      const remote = await loadRemoteBundle(
        'builder test',
        { type: 'remote', name: 'fixture-remote-bundle', url: published.url },
        INSTALL_ANCHOR,
        root,
      )
      const namespace = Object.values(remote.builtins)[0] as { cordisContext?: unknown }
      expect(namespace.cordisContext).toBe(Context)

      const ctx = new Context()
      await ctx.plugin(Loader).await()
      new RemoteBundleRegistry([remote]).install(ctx)
      await ctx.loader.create(remote.patches[0]!.insert![0]!)
      await ctx.loader.await()
      expect(ctx.get('remoteFixture')).toBe('loaded-over-http')
      await ctx.fiber.dispose()
    } finally {
      await new Promise<void>((resolve, reject) => { serverClose(published.server, resolve, reject) })
    }
  }, 30_000)
})

function serverClose(server: Server, resolve: () => void, reject: (error: Error) => void): void {
  server.close((error) => { if (error === undefined) resolve(); else reject(error) })
}
