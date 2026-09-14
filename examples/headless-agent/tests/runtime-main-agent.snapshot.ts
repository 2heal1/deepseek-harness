import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  './fixtures/core/agent-runtime-codex/',
  import.meta.url,
))
const configPath = join(fixtureDir, 'cordis.yml')
const driver = join(fixtureDir, 'driver.ts')
const appServer = join(fixtureDir, 'fake-app-server.mjs')
const packageDir = fileURLToPath(new URL(
  '../../../packages/core/agent-runtime-codex/',
  import.meta.url,
))
const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: string } }
}
const bundlePatch = packageJson.dsh?.bundle?.patch
if (bundlePatch === undefined) {
  throw new Error('agent-runtime-codex must declare a Bundle patch')
}
const bundlePatchPath = join(packageDir, bundlePatch)
const expectedPath = fileURLToPath(new URL(
  './snapshots/runtime-main-agent/summary.expected.json',
  import.meta.url,
))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('external main Agent snapshot', () => {
  it('creates, streams, settles, cancels, reports activity, and pins the profile', async () => {
    const result = await runLoaderSmoke({
      label: 'Codex external main Agent snapshot',
      tempDirPrefix: 'dsh-runtime-main-codex-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, bundlePatchPath],
      tsconfigPath,
      env: {
        DSH_CODEX_FIXTURE_ARGS: JSON.stringify([appServer]),
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          '--disable-warning=ExperimentalWarning',
        ].filter(Boolean).join(' '),
      },
      inspect: async (cwd) => {
        await expect(readFile(join(cwd, '.codex-exited'), 'utf8')).resolves.toBe('exited\n')
      },
    })

    expect(result.stderr).toBe('')
    if (refreshing) await writeFile(expectedPath, result.stdout)
    expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
