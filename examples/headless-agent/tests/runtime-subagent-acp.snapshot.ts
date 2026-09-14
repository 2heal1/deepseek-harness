import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  './fixtures/subagent/runtime-route-acp/',
  import.meta.url,
))
const configPath = join(fixtureDir, 'cordis.yml')
const driver = join(fixtureDir, 'driver.ts')
const acpChild = join(fixtureDir, 'fake-acp.mjs')
const packageDir = fileURLToPath(new URL(
  '../../../packages/core/agent-runtime-acp/',
  import.meta.url,
))
const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: string } }
}
const bundlePatch = packageJson.dsh?.bundle?.patch
if (bundlePatch === undefined) {
  throw new Error('agent-runtime-acp must declare a Bundle patch')
}
const bundlePatchPath = join(packageDir, bundlePatch)
const expectedPath = fileURLToPath(new URL(
  './snapshots/runtime-subagent-acp/summary.expected.json',
  import.meta.url,
))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('Runtime Profile-backed ACP subagent snapshot', () => {
  it('loads the optional Bundle and isolates one child run', async () => {
    const result = await runLoaderSmoke({
      label: 'ACP runtime subagent snapshot',
      tempDirPrefix: 'dsh-runtime-subagent-acp-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, bundlePatchPath],
      tsconfigPath,
      env: {
        DSH_ACP_FIXTURE_ARGS: JSON.stringify([acpChild]),
        CHILD_RUNTIME_KEY: 'child-only-secret',
        PARENT_SECRET_TOKEN: 'must-not-reach-child',
      },
    })

    expect(result.stderr).toBe('')
    if (refreshing) await writeFile(expectedPath, result.stdout)
    expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
