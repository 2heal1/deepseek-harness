/** Convention and optional package.json configuration resolution for Bundle builds. */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { parsePatchSource } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Artifact families emitted by the Builder. */
export type BundleBuilderTarget = 'package' | 'remote' | 'dual'

/** Optional `package.json#dsh.bundleBuilder` overrides. */
export interface BundleBuilderConfig {
  /** Artifact family; defaults to `dual`. */
  target?: BundleBuilderTarget
  /** Output directory; defaults to `dist`. */
  outDir?: string
  /** Patch document; defaults to `cordis.patch.yml`. */
  patch?: string
  /** Node package entry; defaults to `src/index.ts` when present. */
  nodeEntry?: string
  /** Browser plugin entry; defaults to `src/client/index.ts` when present. */
  clientEntry?: string
  /** Explicit patch-specifier to source-entry mappings. */
  modules?: Record<string, string>
  /** Build identifier; defaults to a new UUID for each invocation. */
  buildId?: string
}

/** Command-line overrides over package.json configuration. */
export interface BundleBuilderOverrides {
  /** Project directory; defaults to the current directory. */
  cwd?: string
  /** Artifact target override. */
  target?: BundleBuilderTarget
  /** Output-directory override. */
  outDir?: string
  /** Build-id override. */
  buildId?: string
}

/** Validated project inputs shared by package and remote builds. */
export interface BundleProject {
  /** Absolute project directory. */
  cwd: string
  /** Parsed source package manifest. */
  packageJson: Record<string, unknown>
  /** Bundle package name. */
  name: string
  /** Bundle package version. */
  version: string
  /** Selected artifact target. */
  target: BundleBuilderTarget
  /** Absolute common output directory. */
  outDir: string
  /** Absolute patch path. */
  patchPath: string
  /** Parsed patch list. */
  patches: PatchOptions[]
  /** Optional conventional Node entry. */
  nodeEntry?: string
  /** Optional conventional browser entry. */
  clientEntry?: string
  /** Patch module specifier to source or dependency request. */
  modules: Map<string, string>
  /** Immutable identifier stamped into the remote artifact. */
  buildId: string
  /** Peer dependency ranges used for Host-provided shared modules. */
  peers: Record<string, string>
  /** Declared dependency ranges used to version browser platform shares. */
  versions: Record<string, string>
  /** Browser Cordis dependency metadata. */
  client: {
    inject: string[]
    external: string[]
    immediately: boolean
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function optionalStringArray(subject: string, value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`dsh-bundle: ${subject} must be a string array`)
  }
  return value as string[]
}

function absolute(projectDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectDir, path)
}

function optionalEntry(projectDir: string, configured: unknown, conventional: string, subject: string): string | undefined {
  if (configured !== undefined && typeof configured !== 'string') {
    throw new Error(`dsh-bundle: ${subject} must be a string`)
  }
  const path = absolute(projectDir, configured ?? conventional)
  if (configured !== undefined && !existsSync(path)) throw new Error(`dsh-bundle: ${subject} not found: ${path}`)
  return existsSync(path) ? path : undefined
}

function collectPatchModules(patches: PatchOptions[]): string[] {
  const modules = new Set<string>()
  const visit = (entry: { name?: string; group?: boolean | null; config?: unknown }): void => {
    if (typeof entry.name === 'string' && !entry.name.startsWith('cordis:')) modules.add(entry.name)
    if (entry.group === true && Array.isArray(entry.config)) {
      for (const child of entry.config as { name?: string; group?: boolean | null; config?: unknown }[]) visit(child)
    }
  }
  for (const patch of patches) for (const entry of patch.insert ?? []) visit(entry)
  return [...modules]
}

function stringRecord(subject: string, value: unknown): Record<string, string> {
  if (value === undefined) return {}
  const record = object(value)
  if (record === undefined || Object.values(record).some(item => typeof item !== 'string')) {
    throw new Error(`dsh-bundle: ${subject} must be an object of string values`)
  }
  return record as Record<string, string>
}

function installedVersion(projectDir: string, request: string): string {
  const require = createRequire(join(projectDir, 'package.json'))
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(require.resolve(`${request}/package.json`), 'utf8'))
  } catch (cause) {
    throw new Error(`dsh-bundle: cannot resolve workspace dependency ${JSON.stringify(request)} from ${projectDir}`, { cause })
  }
  const version = object(manifest)?.version
  if (typeof version !== 'string' || version === '') {
    throw new Error(`dsh-bundle: workspace dependency ${JSON.stringify(request)} has no package version`)
  }
  return version
}

function normalizeWorkspaceRanges(projectDir: string, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([request, range]) => {
    if (!range.startsWith('workspace:')) return [request, range]
    const selector = range.slice('workspace:'.length)
    if (selector !== '*' && selector !== '^' && selector !== '~') return [request, selector]
    const version = installedVersion(projectDir, request)
    return [request, selector === '*' ? version : `${selector}${version}`]
  }))
}

/**
 * Resolve and validate one Bundle project.
 * @param overrides - command-line project, target, output, and build-id overrides.
 * @returns normalized project inputs.
 */
export function loadBundleProject(overrides: BundleBuilderOverrides = {}): BundleProject {
  const cwd = resolve(overrides.cwd ?? process.cwd())
  const packagePath = join(cwd, 'package.json')
  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`dsh-bundle: failed to read ${packagePath}: ${String(cause)}`, { cause })
  }
  if (typeof packageJson.name !== 'string' || packageJson.name === '') {
    throw new Error(`dsh-bundle: ${packagePath} must declare a non-empty name`)
  }
  if (typeof packageJson.version !== 'string' || packageJson.version === '') {
    throw new Error(`dsh-bundle: ${packagePath} must declare a non-empty version`)
  }
  const dsh = object(packageJson.dsh)
  const rawConfig = object(dsh?.bundleBuilder) ?? {}
  const configuredTarget = rawConfig.target
  if (configuredTarget !== undefined
    && configuredTarget !== 'package' && configuredTarget !== 'remote' && configuredTarget !== 'dual') {
    throw new Error('dsh-bundle: package.json#dsh.bundleBuilder.target must be "package", "remote", or "dual"')
  }
  const target = overrides.target ?? configuredTarget ?? 'dual'
  const rawOutDir = overrides.outDir ?? rawConfig.outDir ?? 'dist'
  if (typeof rawOutDir !== 'string' || rawOutDir === '') throw new Error('dsh-bundle: outDir must be a non-empty string')
  const patchName = rawConfig.patch ?? 'cordis.patch.yml'
  if (typeof patchName !== 'string' || patchName === '') throw new Error('dsh-bundle: patch must be a non-empty string')
  const patchPath = absolute(cwd, patchName)
  let patchSource: string
  try {
    patchSource = readFileSync(patchPath, 'utf8')
  } catch (cause) {
    throw new Error(`dsh-bundle: failed to read patch ${patchPath}: ${String(cause)}`, { cause })
  }
  const patches = parsePatchSource('dsh-bundle', patchPath, patchSource)
  const nodeEntry = optionalEntry(cwd, rawConfig.nodeEntry, 'src/index.ts', 'nodeEntry')
  const clientEntry = optionalEntry(cwd, rawConfig.clientEntry, 'src/client/index.ts', 'clientEntry')
  const configuredModules = stringRecord('package.json#dsh.bundleBuilder.modules', rawConfig.modules)
  const modules = new Map<string, string>()
  for (const specifier of collectPatchModules(patches)) {
    if (specifier.startsWith('file:')) {
      throw new Error(
        'dsh-bundle: relative patch module names are not portable between package and remote artifacts; '
        + 'use the Bundle package name or a dependency package name',
      )
    }
    const configured = configuredModules[specifier]
    if (configured !== undefined) modules.set(specifier, absolute(cwd, configured))
    else if (specifier === packageJson.name && nodeEntry !== undefined) modules.set(specifier, nodeEntry)
    else modules.set(specifier, specifier)
  }
  for (const [specifier, entry] of Object.entries(configuredModules)) {
    if (!modules.has(specifier)) modules.set(specifier, absolute(cwd, entry))
  }
  const peers = normalizeWorkspaceRanges(cwd, stringRecord('peerDependencies', packageJson.peerDependencies))
  if (peers['@deepseek-ai/cordis'] === undefined) {
    throw new Error('dsh-bundle: peerDependencies must declare @deepseek-ai/cordis so the Host supplies its singleton')
  }
  const versions = {
    ...stringRecord('dependencies', packageJson.dependencies),
    ...stringRecord('devDependencies', packageJson.devDependencies),
    ...peers,
  }
  const clientDecl = object(dsh?.client)
  if (clientDecl !== undefined && clientEntry === undefined) {
    throw new Error('dsh-bundle: package.json declares dsh.client but no browser entry exists at src/client/index.ts or dsh.bundleBuilder.clientEntry')
  }
  return {
    cwd,
    packageJson,
    name: packageJson.name,
    version: packageJson.version,
    target,
    outDir: absolute(cwd, rawOutDir),
    patchPath,
    patches,
    ...(nodeEntry === undefined ? {} : { nodeEntry }),
    ...(clientEntry === undefined ? {} : { clientEntry }),
    modules,
    buildId: overrides.buildId ?? (typeof rawConfig.buildId === 'string' ? rawConfig.buildId : randomUUID()),
    peers,
    versions,
    client: {
      inject: optionalStringArray('package.json#dsh.client.inject', clientDecl?.inject),
      external: optionalStringArray('package.json#dsh.client.external', clientDecl?.external),
      immediately: clientDecl?.immediately === true,
    },
  }
}
