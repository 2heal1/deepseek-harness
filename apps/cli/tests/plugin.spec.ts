import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRemoteBundleArgument, runPlugin } from '../src/plugin.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-plugin-remote-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function manifest(name = 'private-map-tools'): Response {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    name,
    buildId: 'build-1',
    patch: './builds/build-1/cordis.patch.yml',
    node: { entry: './builds/build-1/node/remoteEntry.js', shared: [] },
  }))
}

function profileBundles(): unknown[] {
  const parsed = JSON.parse(readFileSync(join(home, 'profiles', 'remote', 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: unknown[] } }
  }
  return parsed.dsh.profile.bundles
}

describe('remote plugin arguments', () => {
  it('distinguishes URL subscriptions from npm and scoped package specs', () => {
    expect(parseRemoteBundleArgument('private-map-tools@https://plugins.example.test/dsh-bundle.json')).toEqual({
      name: 'private-map-tools',
      url: 'https://plugins.example.test/dsh-bundle.json',
    })
    expect(parseRemoteBundleArgument('@scope/maps@http://127.0.0.1:4173/dsh-bundle.json')).toEqual({
      name: '@scope/maps',
      url: 'http://127.0.0.1:4173/dsh-bundle.json',
    })
    expect(parseRemoteBundleArgument('@scope/maps')).toBeUndefined()
    expect(parseRemoteBundleArgument('pkg@1.2.3')).toBeUndefined()
    expect(() => parseRemoteBundleArgument('bad/name@https://example.test/bundle.json')).toThrow('invalid remote Bundle name')
  })

  it('adds, replaces, and removes a URL subscription without invoking pnpm', async () => {
    const fetchImpl = vi.fn(async () => manifest())
    await expect(runPlugin('remote', [
      'add',
      'private-map-tools@https://plugins.example.test/dsh-bundle.json',
    ], fetchImpl)).resolves.toBe(0)
    expect(profileBundles()).toEqual([
      '@deepseek-ai/dsh-base',
      { type: 'remote', name: 'private-map-tools', url: 'https://plugins.example.test/dsh-bundle.json' },
    ])

    await runPlugin('remote', [
      'add',
      'private-map-tools@https://cdn.example.test/dsh-bundle.json',
    ], fetchImpl)
    expect(profileBundles()).toEqual([
      '@deepseek-ai/dsh-base',
      { type: 'remote', name: 'private-map-tools', url: 'https://cdn.example.test/dsh-bundle.json' },
    ])

    await expect(runPlugin('remote', ['remove', 'private-map-tools'], fetchImpl)).resolves.toBe(0)
    expect(profileBundles()).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('rejects a subscription whose manifest identifies another Bundle', async () => {
    await expect(runPlugin(
      'remote',
      ['add', 'private-map-tools@https://plugins.example.test/dsh-bundle.json'],
      async () => manifest('other-bundle'),
    )).rejects.toThrow('identifies "other-bundle"')
  })
})
