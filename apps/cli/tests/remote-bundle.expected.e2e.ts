/** Built-process expectation for remote Bundle subscription management. */

import { createServer, type Server } from 'node:http'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const builtArtifactsExist = existsSync(dshBin)
const roots: string[] = []

if (process.env.DSH_EXAMPLE_MODE === 'lib' && !builtArtifactsExist) {
  throw new Error('remote Bundle expected output requires built CLI artifacts in lib mode')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(root: string): string {
  const published = join(root, 'published')
  const build = join(published, 'builds', 'expected-1')
  mkdirSync(join(build, 'node'), { recursive: true })
  writeFileSync(join(build, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: expected-remote',
    '      name: expected-remote-bundle',
    '',
  ].join('\n'))
  writeFileSync(join(build, 'node', 'remoteEntry.js'), 'module.exports = {}\n')
  writeFileSync(join(published, 'dsh-bundle.json'), `${JSON.stringify({
    schemaVersion: 1,
    name: 'expected-remote-bundle',
    buildId: 'expected-1',
    patch: 'builds/expected-1/cordis.patch.yml',
    node: {
      entry: 'builds/expected-1/node/remoteEntry.js',
      shared: [{ request: '@deepseek-ai/cordis', requiredVersion: '^4.0.0' }],
    },
  }, undefined, 2)}\n`)
  return published
}

async function serve(directory: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
    const path = resolve(directory, pathname.slice(1))
    const contained = path === directory || !relative(directory, path).split(sep).includes('..')
    if (!contained || !existsSync(path)) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' })
    response.end(readFileSync(path))
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('remote Bundle fixture server has no TCP address')
  return { server, url: `http://127.0.0.1:${String(address.port)}/dsh-bundle.json` }
}

function normalize(value: string, root: string): string {
  return value.replaceAll('\\', '/').replaceAll(root.replaceAll('\\', '/'), '{{root}}').replace(/:\d+/gu, ':{{port}}')
}

describe.skipIf(!builtArtifactsExist)('remote Bundle built-process expected output', () => {
  it('subscribes a profile and removes the subscription without pnpm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-bundle-expected-'))
    roots.push(root)
    const publishedDir = fixture(root)
    const home = join(root, '.dsh')
    const published = await serve(publishedDir)
    const env = {
      ...process.env,
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      NODE_NO_WARNINGS: '1',
    }
    try {
      const spec = `expected-remote-bundle@${published.url}`
      const added = await execa(process.execPath, [
        dshBin, 'plugin', '--profile', 'remote', 'add', spec,
      ], { cwd: root, env, stdin: 'ignore', reject: false })
      const afterAdd = JSON.parse(readFileSync(join(home, 'profiles', 'remote', 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown[] } }
      }
      const subscribed = afterAdd.dsh?.profile?.bundles?.find(value => (
        typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'remote'
      )) as { type?: unknown; name?: unknown; url?: unknown } | undefined
      if (subscribed === undefined || typeof subscribed.url !== 'string') {
        throw new Error('dsh plugin add did not persist the remote Bundle subscription')
      }

      const removed = await execa(process.execPath, [
        dshBin, 'plugin', '--profile', 'remote', 'remove', 'expected-remote-bundle',
      ], { cwd: root, env, stdin: 'ignore', reject: false })
      const afterRemove = JSON.parse(readFileSync(join(home, 'profiles', 'remote', 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown[] } }
      }

      expect({
        add: {
          exitCode: added.exitCode,
          stdout: normalize(added.stdout, root),
          stderr: normalize(added.stderr, root),
          subscribed: { ...subscribed, url: normalize(subscribed.url, root) },
        },
        remove: {
          exitCode: removed.exitCode,
          stdout: normalize(removed.stdout, root),
          stderr: normalize(removed.stderr, root),
          remoteSources: afterRemove.dsh?.profile?.bundles?.filter(value => typeof value !== 'string'),
        },
      }).toMatchInlineSnapshot(`
        {
          "add": {
            "exitCode": 0,
            "stderr": "dsh: initialized profile remote at {{root}}/.dsh/profiles/remote",
            "stdout": "",
            "subscribed": {
              "name": "expected-remote-bundle",
              "type": "remote",
              "url": "http://127.0.0.1:{{port}}/dsh-bundle.json",
            },
          },
          "remove": {
            "exitCode": 0,
            "remoteSources": [],
            "stderr": "",
            "stdout": "",
          },
        }
      `)
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        published.server.close((error) => { if (error === undefined) resolveClose(); else reject(error) })
      })
    }
  })
})
