import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'

async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux') {
        const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
        const state = raw.slice(raw.lastIndexOf(')') + 2, raw.lastIndexOf(')') + 3)
        if (state === 'Z' || state === 'X') return
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`runtime descendant ${pid} remained live`)
}

describe('secure launcher with local subprocess provider', () => {
  it('does not return from disposal until the runtime process tree is quiescent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-launcher-local-'))
    const childScript = [
      'const { spawn } = require("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRuntimeProfiles, {
        defaultMainProfile: 'local',
        profiles: {
          local: {
            provider: 'external',
            launch: {
              executable: process.execPath,
              args: ['-e', childScript],
              resolution: 'absolute',
              cwdPolicy: 'session-workspace',
            },
            permissions: {
              policy: {},
              enforcement: 'best-effort',
            },
            process: {
              startupTimeoutMs: 1_000,
              turnTimeoutMs: 1_000,
              shutdownTimeoutMs: 50,
              terminationTimeoutMs: 3_000,
              maxConcurrentRuns: 1,
            },
          },
        },
      })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(AgentRuntimeLauncher, { temporaryRoot: root })
      const profile = ctx.agentRuntimeProfiles.resolve('local')
      const handle = await ctx.agentRuntimeLauncher.launch({
        profile,
        cwd: process.cwd(),
        driver: {
          arguments: [],
          environment: {},
          reservedEnvironment: [],
          credentialEnvironment: [],
          allowWindowsCommandScript: false,
          permissionEnforcement: 'none',
        },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        signal: new AbortController().signal,
      })
      const [chunk] = await once(handle.process.stdout!, 'data') as [Buffer]
      const descendantPid = Number(chunk.toString('utf8').trim())
      expect(Number.isSafeInteger(descendantPid)).toBe(true)
      process.kill(descendantPid, 0)

      await handle.waitUntilReady(Promise.resolve())
      await handle.dispose()

      await waitGone(descendantPid)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
