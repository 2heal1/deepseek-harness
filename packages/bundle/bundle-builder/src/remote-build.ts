/** Build the URL-loadable DSH Bundle artifact. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModuleFederationPlugin } from '@module-federation/enhanced'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  remoteContainerName,
  type RemoteBundleManifest,
  type RemoteBundleSharedModule,
} from '@deepseek-ai/dsh-app-boot'
import type { Configuration } from 'webpack'
import type { BundleProject } from './project.ts'
import { bundleRules, exactAliases, nodeRuntimePlugin, runWebpack } from './webpack.ts'

const WEB_PLATFORM_SHARES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

function packageRootRequest(request: string): string {
  if (request.startsWith('@')) return request.split('/').slice(0, 2).join('/')
  /* v8 ignore next -- splitting a string always returns at least one element. */
  return request.split('/')[0] ?? request
}

function nodeShares(project: BundleProject): RemoteBundleSharedModule[] {
  return Object.entries(project.peers).map(([request, requiredVersion]) => ({ request, requiredVersion }))
}

function webShares(project: BundleProject): string[] {
  if (project.clientEntry === undefined) return []
  const requests = new Set<string>(project.client.external)
  for (const request of WEB_PLATFORM_SHARES) {
    if (project.versions[request] !== undefined || project.versions[packageRootRequest(request)] !== undefined) {
      requests.add(request)
    }
  }
  return [...requests]
}

function federationShared(shared: readonly RemoteBundleSharedModule[]): Record<string, object> {
  return Object.fromEntries(shared.map(item => [item.request, {
    import: false,
    singleton: true,
    strictVersion: true,
    requiredVersion: item.requiredVersion,
  }]))
}

function browserFederationShared(shared: readonly string[]): Record<string, object> {
  return Object.fromEntries(shared.map(request => [request, {
    import: false,
    singleton: true,
    requiredVersion: false,
  }]))
}

function bootstrapSource(project: BundleProject): string {
  const imports: string[] = []
  const fields: string[] = []
  let index = 0
  for (const [specifier, entry] of project.modules) {
    const local = `module${String(index++)}`
    imports.push(`import * as ${local} from ${JSON.stringify(entry)}`)
    fields.push(`${JSON.stringify(specifier)}: ${local}`)
  }
  return `${imports.join('\n')}\nexport const modules = Object.freeze({${fields.join(',')}})\n`
}

async function buildNodeRemote(
  project: BundleProject,
  outDir: string,
  container: string,
  shared: readonly RemoteBundleSharedModule[],
): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-bundle-remote-node-'))
  try {
    const bootstrap = join(temporary, 'bootstrap.ts')
    const empty = join(temporary, 'empty.ts')
    writeFileSync(bootstrap, bootstrapSource(project))
    writeFileSync(empty, 'export {}\n')
    const config: Configuration = {
      mode: 'production',
      target: 'async-node',
      context: project.cwd,
      cache: false,
      devtool: false,
      entry: { main: empty },
      output: {
        path: outDir,
        filename: '[name].[contenthash].js',
        chunkFilename: '[name].[contenthash].js',
        library: { type: 'commonjs-module', name: container },
        uniqueName: container,
        publicPath: 'auto',
        clean: true,
      },
      externalsPresets: { node: true },
      resolve: {
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
        alias: exactAliases(project.modules),
      },
      module: { rules: bundleRules() },
      optimization: { minimize: true, runtimeChunk: false },
      plugins: [new ModuleFederationPlugin({
        name: container,
        dts: false,
        manifest: false,
        library: { type: 'commonjs-module', name: container },
        filename: 'remoteEntry.js',
        exposes: { './bundle': bootstrap },
        shared: federationShared(shared),
        runtimePlugins: [nodeRuntimePlugin()],
      })],
    }
    await runWebpack(config)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

async function buildWebRemote(
  project: BundleProject,
  outDir: string,
  container: string,
  shared: readonly string[],
): Promise<void> {
  if (project.clientEntry === undefined) return
  const config: Configuration = {
    mode: 'production',
    target: ['web', 'es2022'],
    context: project.cwd,
    cache: false,
    devtool: 'source-map',
    entry: {},
    output: {
      path: outDir,
      filename: '[name].[contenthash].js',
      chunkFilename: '[name].[contenthash].js',
      library: { type: 'var', name: container },
      uniqueName: container,
      publicPath: 'auto',
      clean: true,
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
      alias: exactAliases(project.modules),
    },
    module: { rules: bundleRules() },
    optimization: { minimize: true, runtimeChunk: false },
    plugins: [new ModuleFederationPlugin({
      name: container,
      dts: false,
      manifest: false,
      library: { type: 'var', name: container },
      filename: 'remoteEntry.js',
      exposes: { './client': project.clientEntry },
      shared: browserFederationShared(shared),
    })],
  }
  await runWebpack(config)
}

async function writeManifest(path: string, manifest: RemoteBundleManifest): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o644 })
}

/**
 * Build one immutable remote generation and update `<outDir>/remote/dsh-bundle.json`.
 * @param project - normalized Bundle project.
 * @returns the stable subscription-manifest path.
 */
export async function buildRemoteBundle(project: BundleProject): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(project.buildId)) {
    throw new Error('dsh-bundle: buildId may contain only ASCII letters, digits, dot, underscore, and hyphen')
  }
  const remoteDir = join(project.outDir, 'remote')
  const buildRelative = `builds/${project.buildId}`
  const buildDir = join(remoteDir, buildRelative)
  if (existsSync(buildDir)) {
    throw new Error(`dsh-bundle: immutable remote build already exists: ${buildDir}`)
  }
  mkdirSync(buildDir, { recursive: true })
  const node = nodeShares(project)
  const web = webShares(project)
  const container = remoteContainerName(project.buildId)
  try {
    copyFileSync(project.patchPath, join(buildDir, 'cordis.patch.yml'))
    const builds = await Promise.allSettled([
      buildNodeRemote(project, join(buildDir, 'node'), container, node),
      buildWebRemote(project, join(buildDir, 'web'), container, web),
    ])
    const failures = builds.flatMap((result): unknown[] => (
      result.status === 'rejected' ? [result.reason as unknown] : []
    ))
    if (failures.length > 0) throw new AggregateError(failures, 'dsh-bundle: remote build failed')
    const manifest: RemoteBundleManifest = {
      schemaVersion: 1,
      name: project.name,
      buildId: project.buildId,
      patch: `${buildRelative}/cordis.patch.yml`,
      node: { entry: `${buildRelative}/node/remoteEntry.js`, shared: node },
      ...(project.clientEntry === undefined ? {} : {
        web: {
          entry: `${buildRelative}/web/remoteEntry.js`,
          shared: web,
        },
      }),
    }
    mkdirSync(remoteDir, { recursive: true })
    const manifestPath = join(remoteDir, 'dsh-bundle.json')
    await writeManifest(manifestPath, manifest)
    return manifestPath
  } catch (error) {
    rmSync(buildDir, { recursive: true, force: true })
    throw error
  }
}
