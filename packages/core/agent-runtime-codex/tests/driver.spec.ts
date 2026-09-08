import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_DRIVER } from '../src/index.ts'

async function runtimeProfile(args: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-driver-'))
  const output = join(root, 'argv.json')
  const ctx = new Context()
  await ctx.plugin(AgentRuntimeProfiles, {
    defaultMainProfile: 'codex',
    profiles: {
      codex: {
        provider: 'codex-app-server',
        launch: {
          executable: process.execPath,
          args: ['-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)))`, ...args],
          resolution: 'absolute',
          cwdPolicy: { fixed: root },
        },
        permissions: { policy: 'never', enforcement: 'required' },
        process: {
          startupTimeoutMs: 1_000,
          turnTimeoutMs: 1_000,
          shutdownTimeoutMs: 1_000,
          terminationTimeoutMs: 1_000,
          maxConcurrentRuns: 1,
        },
      },
    },
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRuntimeLauncher, { temporaryRoot: root })
  return { ctx, output, root }
}

describe('Codex App Server Driver', () => {
  it('injects the protocol arguments once after profile arguments', async () => {
    const { ctx, output, root } = await runtimeProfile([])
    try {
      const profile = ctx.agentRuntimeProfiles.resolve('codex')
      const handle = await ctx.agentRuntimeLauncher.launch({
        profile,
        cwd: root,
        driver: CODEX_APP_SERVER_DRIVER,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        signal: new AbortController().signal,
      })
      await handle.process.done
      await expect(import('node:fs/promises').then(({ readFile }) => readFile(output, 'utf8')))
        .resolves.toBe(JSON.stringify(['app-server', '--stdio']))
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['app-server', '--stdio'])('rejects Profile-owned reserved argument %s before spawn', async (argument) => {
    const { ctx, output, root } = await runtimeProfile([argument])
    try {
      const profile = ctx.agentRuntimeProfiles.resolve('codex')
      await expect(ctx.agentRuntimeLauncher.launch({
        profile,
        cwd: root,
        driver: CODEX_APP_SERVER_DRIVER,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        signal: new AbortController().signal,
      })).rejects.toThrow(`attempts to set reserved argument "${argument}"`)
      await expect(import('node:fs/promises').then(({ access }) => access(output))).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
