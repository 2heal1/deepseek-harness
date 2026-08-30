/**
 * Remote DSH Bundle protocol and Node loader. A profile stores only a stable
 * subscription URL; each process start resolves that URL to one immutable
 * build and loads its Node Module Federation container.
 *
 * @module @deepseek-ai/dsh-app-boot/remote-bundle
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInstance } from '@module-federation/runtime'
import * as Cordis from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { parsePatchSource } from './index.ts'

type Context = Cordis.Context

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote Bundle builds selected by the active profile. */
    remoteBundles: RemoteBundleRegistry
  }
}

/** One host-provided module consumed by a remote container. */
export interface RemoteBundleSharedModule {
  /** Exact module request used as the Module Federation share key. */
  request: string
  /** Version range required by the remote build. */
  requiredVersion: string
}

/** Browser half of one remote Bundle build. */
export interface RemoteBundleWebManifest {
  /** Browser Module Federation entry, relative to the manifest URL or absolute. */
  entry: string
  /** Host-provided browser module identities. */
  shared: string[]
}

/** Version-one DSH remote Bundle manifest. */
export interface RemoteBundleManifest {
  /** Protocol version. */
  schemaVersion: 1
  /** Bundle package name and profile subscription identifier. */
  name: string
  /** Immutable build identifier; a changed value denotes different code. */
  buildId: string
  /** Bundle patch document, relative to the manifest URL or absolute. */
  patch: string
  /** Node Module Federation entry, relative to the manifest URL or absolute. */
  node: {
    entry: string
    shared: RemoteBundleSharedModule[]
  }
  /** Optional browser plugin build. */
  web?: RemoteBundleWebManifest
}

/** Remote source persisted in a profile. */
export interface RemoteProfileBundleSource {
  /** Source discriminant. */
  type: 'remote'
  /** Stable Bundle identifier, matched against the fetched manifest. */
  name: string
  /** HTTP(S) subscription URL fetched at process start. */
  url: string
}

/** Browser build projected into the Web page by the remote-client bridge. */
export interface ResolvedRemoteWebBundle {
  /** Bundle name. */
  name: string
  /** Immutable build identifier. */
  buildId: string
  /** Derived Module Federation container key; never configured by users. */
  container: string
  /** Absolute browser remote-entry URL. */
  entry: string
  /** Host modules supplied to the browser container. */
  shared: string[]
}

/** A shared request paired with the installed Host version. */
export interface ResolvedRemoteSharedModule extends RemoteBundleSharedModule {
  /** Version of the module resolved from this DSH installation or profile. */
  version: string
}

/** One fully loaded remote Bundle layer. */
export interface ResolvedRemoteBundle {
  /** Source that selected this build. */
  source: RemoteProfileBundleSource
  /** Validated remote manifest. */
  manifest: RemoteBundleManifest
  /** Parsed and remote-builtin-rewritten patch layer. */
  patches: PatchOptions[]
  /** Loader builtin key (without `cordis:`) to remote module namespace. */
  builtins: Record<string, unknown>
  /** Optional browser build. */
  web?: ResolvedRemoteWebBundle
}

/** Fixed remote bootstrap module returned by every Builder-produced Node container. */
interface RemoteBundleBootstrap {
  /** Original Loader specifier to module namespace. */
  modules: Record<string, unknown>
}

/** Fetch implementation accepted by protocol helpers and tests. */
export type RemoteBundleFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Return a Module Federation-safe container name derived from a globally unique build id.
 * @param buildId - immutable remote build identifier.
 * @returns deterministic container name for the build.
 */
export function remoteContainerName(buildId: string): string {
  return `dsh_${createHash('sha256').update(buildId).digest('hex').slice(0, 20)}`
}

function expectObject(subject: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectString(subject: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${subject} must be a non-empty string`)
  return value
}

function optionalStrings(subject: string, value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${subject} must be a string array`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    const result = expectString(`${subject}[${String(index)}]`, item)
    if (seen.has(result)) throw new Error(`${subject} contains duplicate value ${JSON.stringify(result)}`)
    seen.add(result)
    return result
  })
}

function parseShared(subject: string, value: unknown): RemoteBundleSharedModule[] {
  if (!Array.isArray(value)) throw new Error(`${subject} must be an array`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    const record = expectObject(`${subject}[${String(index)}]`, item)
    const request = expectString(`${subject}[${String(index)}].request`, record.request)
    if (seen.has(request)) throw new Error(`${subject} contains duplicate request ${JSON.stringify(request)}`)
    seen.add(request)
    return {
      request,
      requiredVersion: expectString(`${subject}[${String(index)}].requiredVersion`, record.requiredVersion),
    }
  })
}

/**
 * Validate a parsed remote manifest.
 * @param value - untrusted JSON value.
 * @param subject - diagnostic name for the manifest.
 * @returns the validated version-one manifest.
 */
export function parseRemoteBundleManifest(value: unknown, subject = 'remote Bundle manifest'): RemoteBundleManifest {
  const record = expectObject(subject, value)
  if (record.schemaVersion !== 1) throw new Error(`${subject}.schemaVersion must be 1`)
  const node = expectObject(`${subject}.node`, record.node)
  let web: RemoteBundleWebManifest | undefined
  if (record.web !== undefined) {
    const raw = expectObject(`${subject}.web`, record.web)
    web = {
      entry: expectString(`${subject}.web.entry`, raw.entry),
      shared: optionalStrings(`${subject}.web.shared`, raw.shared),
    }
  }
  return {
    schemaVersion: 1,
    name: expectString(`${subject}.name`, record.name),
    buildId: expectString(`${subject}.buildId`, record.buildId),
    patch: expectString(`${subject}.patch`, record.patch),
    node: {
      entry: expectString(`${subject}.node.entry`, node.entry),
      shared: parseShared(`${subject}.node.shared`, node.shared),
    },
    ...(web === undefined ? {} : { web }),
  }
}

function httpUrl(subject: string, value: string, base?: string): string {
  let url: URL
  try {
    url = base === undefined ? new URL(value) : new URL(value, base)
  } catch {
    throw new Error(`${subject} must be an HTTP(S) URL, received ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${subject} must be an HTTP(S) URL, received ${JSON.stringify(value)}`)
  }
  return url.href
}

/**
 * Fetch and validate one subscription manifest.
 * @param url - HTTP(S) subscription URL.
 * @param fetchImpl - fetch implementation; defaults to the platform global.
 * @returns the manifest and the final response URL used to resolve artifacts.
 */
export async function fetchRemoteBundleManifest(
  url: string,
  fetchImpl: RemoteBundleFetch = fetch,
): Promise<{ manifest: RemoteBundleManifest; url: string }> {
  const requested = httpUrl('remote Bundle subscription', url)
  let response: Response
  try {
    response = await fetchImpl(requested)
  } catch (cause) {
    throw new Error(`failed to fetch remote Bundle manifest ${requested}: ${String(cause)}`, { cause })
  }
  if (!response.ok) {
    throw new Error(`remote Bundle manifest ${requested} returned HTTP ${String(response.status)}`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (cause) {
    throw new Error(`remote Bundle manifest ${requested} is not valid JSON: ${String(cause)}`, { cause })
  }
  const finalUrl = httpUrl('remote Bundle manifest response URL', response.url === '' ? requested : response.url)
  return { manifest: parseRemoteBundleManifest(parsed, `remote Bundle manifest ${finalUrl}`), url: finalUrl }
}

function packageRootRequest(request: string): string {
  if (request.startsWith('@')) return request.split('/').slice(0, 2).join('/')
  /* v8 ignore next -- splitting a string always returns at least one element. */
  return request.split('/')[0] ?? request
}

function resolvePackageDir(request: string, anchors: readonly string[]): string {
  const packageName = packageRootRequest(request)
  for (const anchor of anchors) {
    // resolve.paths returns null only for Node builtins, which cannot be package shares.
    /* v8 ignore next */
    for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  throw new Error(`cannot resolve shared module ${JSON.stringify(request)} from the DSH installation or active profile`)
}

function resolveShared(
  declaration: RemoteBundleSharedModule,
  anchors: readonly string[],
): ResolvedRemoteSharedModule & { load(): Promise<unknown> } {
  const packageDir = resolvePackageDir(declaration.request, anchors)
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`shared module ${JSON.stringify(declaration.request)} has no package version`)
  }
  const anchor = join(packageDir, 'package.json')
  let modulePath: string | undefined
  try {
    modulePath = createRequire(anchor).resolve(declaration.request)
  } catch {
    // Source launches resolve workspace packages through the ambient tsx
    // module hook even when their package manifests point at unbuilt lib/.
  }
  return {
    ...declaration,
    version: pkg.version,
    load: async () => {
      if (declaration.request === '@deepseek-ai/cordis') return Cordis
      try {
        return modulePath === undefined
          ? await import(declaration.request) as unknown
          : await import(pathToFileURL(modulePath).href) as unknown
      } catch (cause) {
        throw new Error(`cannot load shared module ${JSON.stringify(declaration.request)}`, { cause })
      }
    },
  }
}

function visitInsertedEntries(
  patches: PatchOptions[],
  visit: (entry: { name?: string; group?: boolean | null; config?: unknown }) => void,
): void {
  const walk = (entry: { name?: string; group?: boolean | null; config?: unknown }): void => {
    visit(entry)
    if (entry.group === true && Array.isArray(entry.config)) {
      for (const child of entry.config as { name?: string; group?: boolean | null; config?: unknown }[]) walk(child)
    }
  }
  for (const patch of patches) {
    for (const entry of patch.insert ?? []) walk(entry)
  }
}

function rewriteRemoteNames(
  binName: string,
  bundleName: string,
  buildId: string,
  patches: PatchOptions[],
  modules: Record<string, unknown>,
): Record<string, unknown> {
  const builtins: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const keys = new Map<string, string>()
  visitInsertedEntries(patches, (entry) => {
    const specifier = entry.name
    if (specifier === undefined || specifier.startsWith('cordis:')) return
    let key = keys.get(specifier)
    if (key === undefined) {
      if (!(specifier in modules)) {
        throw new Error(
          `${binName}: remote Bundle ${JSON.stringify(bundleName)} build ${JSON.stringify(buildId)} `
          + `did not export patch module ${JSON.stringify(specifier)}`,
        )
      }
      key = `dsh-remote/${remoteContainerName(buildId)}/${String(keys.size)}`
      keys.set(specifier, key)
      builtins[key] = modules[specifier]
    }
    entry.name = `cordis:${key}`
  })
  return builtins
}

/**
 * Load one remote source, including its patch and Node container.
 * @param binName - diagnostic prefix.
 * @param source - profile subscription source.
 * @param installAnchor - package-resolution anchor inside the DSH installation.
 * @param profileDir - active profile directory, used as the second shared-module anchor.
 * @param fetchImpl - fetch implementation.
 * @returns the resolved patch, Loader builtins, and optional browser descriptor.
 */
export async function loadRemoteBundle(
  binName: string,
  source: RemoteProfileBundleSource,
  installAnchor: string,
  profileDir: string,
  fetchImpl: RemoteBundleFetch = fetch,
): Promise<ResolvedRemoteBundle> {
  const fetched = await fetchRemoteBundleManifest(source.url, fetchImpl)
  const { manifest } = fetched
  if (manifest.name !== source.name) {
    throw new Error(
      `${binName}: remote Bundle subscription ${source.url} identifies ${JSON.stringify(manifest.name)}, `
      + `expected ${JSON.stringify(source.name)}`,
    )
  }
  const patchUrl = httpUrl(`${source.name} patch`, manifest.patch, fetched.url)
  let patchResponse: Response
  try {
    patchResponse = await fetchImpl(patchUrl)
  } catch (cause) {
    throw new Error(`${binName}: failed to fetch remote Bundle patch ${patchUrl}: ${String(cause)}`, { cause })
  }
  if (!patchResponse.ok) throw new Error(`${binName}: remote Bundle patch ${patchUrl} returned HTTP ${String(patchResponse.status)}`)
  const patches = parsePatchSource(binName, patchUrl, await patchResponse.text())
  const anchors = [installAnchor, join(profileDir, 'package.json')]
  const resolvedNodeShared = manifest.node.shared.map(item => resolveShared(item, anchors))
  const shared = Object.fromEntries(resolvedNodeShared.map(item => [item.request, {
    version: item.version,
    scope: 'default',
    shareConfig: {
      singleton: true,
      requiredVersion: false as const,
      strictVersion: true,
    },
    get: async () => {
      const exports = await item.load()
      return () => exports
    },
  }]))
  const container = remoteContainerName(manifest.buildId)
  const runtime = createInstance({
    name: `dsh_host_${container}`,
    remotes: [{
      name: container,
      entry: httpUrl(`${source.name} Node entry`, manifest.node.entry, fetched.url),
      type: 'commonjs-module',
    }],
    shared,
  })
  const bootstrap = await runtime.loadRemote<RemoteBundleBootstrap>(`${container}/bundle`)
  const exports = expectObject(`${source.name} remote bootstrap`, bootstrap)
  const modules = expectObject(`${source.name} remote bootstrap modules`, exports.modules)
  const builtins = rewriteRemoteNames(binName, source.name, manifest.buildId, patches, modules)
  let web: ResolvedRemoteWebBundle | undefined
  if (manifest.web !== undefined) {
    web = {
      name: manifest.name,
      buildId: manifest.buildId,
      container,
      entry: httpUrl(`${source.name} Web entry`, manifest.web.entry, fetched.url),
      shared: [...manifest.web.shared],
    }
  }
  return { source, manifest, patches, builtins, ...(web === undefined ? {} : { web }) }
}

/** Profile-scoped registry consumed by boot and the optional Web bridge. */
export class RemoteBundleRegistry {
  /**
   * @param bundles - resolved remote builds in profile order.
   */
  constructor(readonly bundles: readonly ResolvedRemoteBundle[]) {
    const containers = new Set<string>()
    for (const bundle of bundles) {
      const container = remoteContainerName(bundle.manifest.buildId)
      if (containers.has(container)) {
        throw new Error(`remote Bundle buildId collision at ${JSON.stringify(bundle.manifest.buildId)}`)
      }
      containers.add(container)
    }
  }

  /**
   * Install every remote module namespace into the active Loader.
   * @param ctx - root context after Loader creation and before entries mount.
   */
  install(ctx: Context): void {
    ctx.effect(() => {
      const entries = this.bundles.flatMap(bundle => Object.entries(bundle.builtins))
      const keys = new Set<string>()
      for (const [key] of entries) {
        if (keys.has(key) || key in ctx.loader.builtins) {
          throw new Error(`duplicate remote Loader builtin ${JSON.stringify(key)}`)
        }
        keys.add(key)
      }
      for (const [key, exports] of entries) ctx.loader.builtins[key] = exports
      return () => {
        for (const [key, exports] of entries) {
          if (ctx.loader.builtins[key] === exports) Reflect.deleteProperty(ctx.loader.builtins, key)
        }
      }
    }, 'remote Bundles: Loader builtins')
  }

  /**
   * Return browser builds selected by this profile.
   * @returns browser descriptors in profile order.
   */
  web(): ResolvedRemoteWebBundle[] {
    return this.bundles.flatMap(bundle => bundle.web === undefined ? [] : [bundle.web])
  }
}
