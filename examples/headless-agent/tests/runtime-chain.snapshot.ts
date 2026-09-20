import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  './fixtures/integration/runtime-chain/',
  import.meta.url,
))
const configPath = join(fixtureDir, 'cordis.yml')
const driver = join(fixtureDir, 'driver.ts')
const mainRuntime = join(fixtureDir, 'fake-app-server.mjs')
const childRuntime = join(fixtureDir, 'fake-acp.mjs')
const expectedPath = fileURLToPath(new URL(
  './snapshots/runtime-chain/summary.expected.json',
  import.meta.url,
))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const childCredential = 'i1-child-secret-canary'
const ambientSecret = 'i1-ambient-secret-canary'

async function bundlePatch(packagePath: string): Promise<string> {
  const packageDir = fileURLToPath(new URL(packagePath, import.meta.url))
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const patch = packageJson.dsh?.bundle?.patch
  if (patch === undefined) throw new Error(`${packagePath} must declare a Bundle patch`)
  return join(packageDir, patch)
}

describe('V1 configurable runtime chain snapshot', () => {
  it('runs an external main through MCP to an isolated one-shot child', async () => {
    const codexPatch = await bundlePatch('../../../packages/core/agent-runtime-codex/')
    const acpPatch = await bundlePatch('../../../packages/core/agent-runtime-acp/')
    const result = await runLoaderSmoke({
      label: 'V1 configurable runtime chain',
      tempDirPrefix: 'dsh-runtime-chain-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, codexPatch, acpPatch],
      tsconfigPath,
      env: {
        DSH_RUNTIME_MAIN_ARGS: JSON.stringify([mainRuntime]),
        DSH_RUNTIME_CHILD_ARGS: JSON.stringify([childRuntime]),
        CHILD_RUNTIME_KEY: childCredential,
        PARENT_SECRET_TOKEN: ambientSecret,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          '--disable-warning=ExperimentalWarning',
        ].filter(Boolean).join(' '),
      },
      inspect: async (cwd) => {
        await expect(readdir(join(cwd, '.runtime-launches'))).resolves.toEqual([])
      },
    })

    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain(childCredential)
    expect(result.stdout).not.toContain(ambientSecret)
    if (refreshing) await writeFile(expectedPath, result.stdout)
    expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
