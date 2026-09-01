/**
 * `dsh plugin --profile <name> <args...>` — profile Bundle management. Package
 * arguments pass through pnpm and reconcile against installed `dsh.bundle`
 * declarations; `name@https://…` arguments add remote Bundle subscriptions to
 * the same ordered profile layer list.
 * @module @deepseek-ai/dsh/plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  fetchRemoteBundleManifest,
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileBundleSource,
  type ProfileManifest,
  type RemoteBundleFetch,
  type RemoteProfileBundleSource,
} from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/**
 * Whether a resolved dependency exports a profile patch, i.e. is a bundle.
 * @param packageName - the dependency's package name.
 * @param profileDir - the profile directory (resolution anchor).
 * @returns true when the package manifest declares `dsh.bundle`.
 */
function exportsPatch(packageName: string, profileDir: string): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
  } catch {
    return false // pnpm reported success yet the package is unresolvable — treat as plain
  }
  const manifest = readProfileManifest(NAME, dir)
  return manifest.dsh?.bundle?.patch !== undefined
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state: pnpm has
 * already written the real installed names (so a git/path/tarball/alias spec
 * on the command line reconciles by its true package name) and materialized
 * the packages. A dependency that resolves to a `dsh.bundle`-declaring
 * package joins the layer stack (appended in dependency order); a
 * dependency-listed name that no longer does — removed, or the installed
 * version dropped the declaration — leaves it. In-box bundles from the
 * profile template are not dependencies and are never touched. Warns once
 * per newly-added bundle-less dependency (a plain library is fine; the
 * warning is orientation).
 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  const packagePlugins = plugins.filter((source): source is string => typeof source === 'string')
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !packagePlugins.includes(packageName)) {
      plugins.push(packageName)
      packagePlugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      process.stderr.write(
        `${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)\n',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...packagePlugins]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles (dsh-base and friends) are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
  writeProfileManifest(profileDir, after)
}

/** Parsed `name@https://…` remote subscription argument. */
export interface RemoteBundleArgument {
  /** Bundle identifier. */
  name: string
  /** Subscription URL. */
  url: string
}

/**
 * Parse the explicit remote syntax without mistaking scoped npm names for it.
 * @param argument - one `dsh plugin add` argument.
 * @returns the remote name and URL, or undefined for an ordinary pnpm spec.
 */
export function parseRemoteBundleArgument(argument: string): RemoteBundleArgument | undefined {
  const marker = Math.max(argument.lastIndexOf('@https://'), argument.lastIndexOf('@http://'))
  if (marker <= 0) return undefined
  const name = argument.slice(0, marker)
  const url = argument.slice(marker + 1)
  if (!/^(?:@[^/\s]+\/)?[^/@\s]+$/.test(name)) {
    throw new Error(`${NAME}: invalid remote Bundle name ${JSON.stringify(name)}`)
  }
  return { name, url }
}

async function resolveRemoteAdds(
  arguments_: readonly string[],
  fetchImpl: RemoteBundleFetch,
): Promise<{ remote: RemoteProfileBundleSource[]; rest: string[] }> {
  const parsed = arguments_.map(argument => ({ argument, remote: parseRemoteBundleArgument(argument) }))
  const resolved = await Promise.all(parsed.map(async ({ remote }) => {
    if (remote === undefined) return undefined
    const { manifest } = await fetchRemoteBundleManifest(remote.url, fetchImpl)
    if (manifest.name !== remote.name) {
      throw new Error(
        `${NAME}: remote Bundle subscription ${remote.url} identifies ${JSON.stringify(manifest.name)}, `
        + `expected ${JSON.stringify(remote.name)}`,
      )
    }
    return { type: 'remote' as const, ...remote }
  }))
  return {
    remote: resolved.filter((source): source is RemoteProfileBundleSource => source !== undefined),
    rest: parsed.filter(item => item.remote === undefined).map(item => item.argument),
  }
}

function mergeRemoteSources(
  current: readonly ProfileBundleSource[],
  additions: readonly RemoteProfileBundleSource[],
): ProfileBundleSource[] {
  const next = [...current]
  for (const source of additions) {
    const index = next.findIndex(existing => (
      typeof existing === 'string' ? existing === source.name : existing.name === source.name
    ))
    if (index === -1) next.push(source)
    else if (typeof next[index] === 'string') {
      throw new Error(
        `${NAME}: ${JSON.stringify(source.name)} is already an installed package Bundle; remove it before adding a remote subscription`,
      )
    } else {
      next[index] = source
    }
  }
  return next
}

function removeRemoteSources(
  current: readonly ProfileBundleSource[],
  names: ReadonlySet<string>,
): { bundles: ProfileBundleSource[]; removed: Set<string> } {
  const removed = new Set<string>()
  const bundles = current.filter((source) => {
    if (typeof source === 'string' || !names.has(source.name)) return true
    removed.add(source.name)
    return false
  })
  return { bundles, removed }
}

/**
 * Rewrite relative filesystem specs against the user's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile
 * — `add .` from a plugin checkout would self-link the profile. Absolute
 * specs, registry names, and every other pnpm argument pass through
 * untouched.
 * @param argument - one pnpm argument, verbatim from argv.
 * @param cwd - the directory `dsh` was invoked from.
 * @returns the argument with a relative path spec anchored to `cwd`.
 */
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  // A bare path stays bare and a prefixed spec keeps its prefix: pnpm's
  // link-vs-copy semantics differ between `file:` and a plain directory
  // path, and the anchor must not change which one the user asked for.
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}

/**
 * Run one `dsh plugin` invocation: init if needed, forward to pnpm, reconcile.
 * @param profile - the profile name.
 * @param args - pnpm arguments with relative path specs anchored to the invoking directory.
 * @returns the pnpm exit code.
 */
export async function runPlugin(
  profile: string,
  args: readonly string[],
  fetchImpl: RemoteBundleFetch = fetch,
): Promise<number> {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[profile]
    initProfile(
      dir,
      template?.bundles ?? DEFAULT_PROFILE_BUNDLES,
      template?.patchReload,
    )
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  let pnpmArgs = [...args]
  let remoteAdds: RemoteProfileBundleSource[] = []
  let remoteRemovals = new Set<string>()
  if (args[0] === 'add' && args.length > 1) {
    const resolved = await resolveRemoteAdds(args.slice(1), fetchImpl)
    remoteAdds = resolved.remote
    pnpmArgs = resolved.rest.length === 0 ? [] : ['add', ...resolved.rest]
  } else if (args[0] === 'remove' && args.length > 1) {
    const sources = before.dsh?.profile?.bundles ?? []
    const remoteNames = new Set(sources
      .filter((source): source is RemoteProfileBundleSource => typeof source !== 'string')
      .map(source => source.name))
    remoteRemovals = new Set(args.slice(1).filter(name => remoteNames.has(name)))
    const rest = args.slice(1).filter(name => !remoteRemovals.has(name))
    pnpmArgs = rest.length === 0 ? [] : ['remove', ...rest]
  }
  if (pnpmArgs.length === 0) {
    const latest = readProfileManifest(NAME, dir)
    const current = latest.dsh?.profile?.bundles ?? []
    const removed = removeRemoteSources(current, remoteRemovals)
    const bundles = mergeRemoteSources(removed.bundles, remoteAdds)
    latest.dsh = { ...latest.dsh, profile: { ...latest.dsh?.profile, bundles } }
    writeProfileManifest(dir, latest)
    return 0
  }
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', pnpmArgs.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    reconcilePlugins(before, dir)
    if (remoteAdds.length > 0 || remoteRemovals.size > 0) {
      const latest = readProfileManifest(NAME, dir)
      const current = latest.dsh?.profile?.bundles ?? []
      const removed = removeRemoteSources(current, remoteRemovals)
      const bundles = mergeRemoteSources(removed.bundles, remoteAdds)
      latest.dsh = { ...latest.dsh, profile: { ...latest.dsh?.profile, bundles } }
      writeProfileManifest(dir, latest)
    }
  } else {
    // pnpm's own diagnostics name pnpm-workspace.yaml without saying WHICH
    // one; the profile owns it, and the commonest failure here is pnpm ≥10
    // blocking a git dependency's prepare (build) script until allowlisted.
    process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
    if (pnpmArgs.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
      process.stderr.write(
        `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — `
        + `add the exact key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`,
      )
    }
  }
  return exitCode
}
