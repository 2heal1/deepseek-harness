import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  type AgentRuntimeEventSink,
  type AgentRuntimePrepareRequest,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import * as CodexRuntime from '../src/index.ts'

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
        driver: CodexRuntime.CODEX_APP_SERVER_DRIVER,
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
        driver: CodexRuntime.CODEX_APP_SERVER_DRIVER,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        signal: new AbortController().signal,
      })).rejects.toThrow(`attempts to set reserved argument "${argument}"`)
      await expect(import('node:fs/promises').then(({ access }) => access(output))).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['overflow', 'failure', 'cancellation'] as const)(
    'stops the process and removes launch material after %s',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-codex-overflow-'))
      const workspace = join(root, 'workspace')
      const temporaryRoot = join(root, 'launches')
      const exitMarker = join(workspace, 'exited')
      const turnMarker = join(workspace, 'turn-started')
      const interruptMarker = join(workspace, 'interrupted')
      await mkdir(workspace)
      const script = `
      import { appendFileSync, writeFileSync } from 'node:fs'
      const scenario = ${JSON.stringify(scenario)}
      let buffer = ''
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\\n')
          if (newline < 0) break
          const frame = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          if (frame.method === 'initialize') send({ id: frame.id, result: {} })
          if (frame.method === 'thread/start') {
            send({ id: frame.id, result: { thread: { id: 'thread-1', ephemeral: true } } })
          }
          if (frame.method === 'turn/start') {
            send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
            writeFileSync(${JSON.stringify(turnMarker)}, 'started')
            if (scenario === 'overflow') {
              setImmediate(() => process.stdout.write('x'.repeat(513)))
            }
            if (scenario === 'failure') {
              setImmediate(() => send({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-1',
                  turn: {
                    id: 'turn-1',
                    status: 'failed',
                    error: { codexErrorInfo: 'other' },
                  },
                },
              }))
            }
          }
          if (frame.method === 'turn/interrupt') {
            appendFileSync(${JSON.stringify(interruptMarker)}, 'interrupted')
            send({ id: frame.id, result: {} })
            send({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: { id: 'turn-1', status: 'interrupted', error: null },
              },
            })
          }
        }
      })
      process.stdin.on('end', () => process.exit(0))
      process.on('exit', () => writeFileSync(${JSON.stringify(exitMarker)}, 'exited'))
      setInterval(() => {}, 1_000)
    `
      const ctx = new Context()
      try {
        await ctx.plugin(AgentRuntimeProfiles, {
          defaultMainProfile: 'codex',
          profiles: {
            codex: {
              provider: 'codex-app-server',
              launch: {
                executable: process.execPath,
                args: ['-e', script],
                resolution: 'absolute',
                cwdPolicy: { fixed: workspace },
              },
              permissions: {
                policy: { sandbox: 'workspace-write' },
                enforcement: 'required',
              },
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
        await ctx.plugin(AgentRuntimeLauncher, { temporaryRoot })
        await ctx.plugin(AgentRuntimeRegistry)
        await ctx.plugin(CodexRuntime, { maxFrameBytes: 512 })
        const provider = ctx.agentRuntimes.getProvider(AgentRuntimeProviderId('codex-app-server'))
        if (provider === undefined) throw new Error('Codex Provider was not registered')
        const sessionId = 'session-1' as AgentRuntimePrepareRequest['sessionId']
        const sink: AgentRuntimeEventSink = {
          facts() {},
          assistantChunk() {},
          assistantMessage() {},
          activity() {},
        }
        const runtime = await provider.prepare({
          kind: 'create',
          runtimeId: AgentRuntimeId('runtime-1'),
          sessionId,
          profile: ctx.agentRuntimeProfiles.resolve('codex'),
          agentCtx: {
            agent: { id: sessionId, session: { header: { cwd: workspace } } },
            agentRuntimeLauncher: ctx.agentRuntimeLauncher,
          } as unknown as Context,
          sink,
          signal: new AbortController().signal,
        })

        const submissionId = SubmissionId('submission-1')
        const submissionAbort = new AbortController()
        const submission = runtime.submit({
          submissionId,
          message: createUserMessage({
            content: [{ type: 'text', text: 'trigger overflow' }],
            source: { kind: 'user' },
          }),
          signal: submissionAbort.signal,
          started() {},
        })
        if (scenario === 'cancellation') {
          await vi.waitFor(async () => {
            await expect(readFile(turnMarker, 'utf8')).resolves.toBe('started')
          })
          const cause = { kind: 'user' } as const
          submissionAbort.abort(cause)
          runtime.cancel(submissionId, cause)
          await expect(submission).resolves.toEqual({
            reason: { kind: 'aborted', reason: cause },
          })
          await expect(readFile(interruptMarker, 'utf8')).resolves.toBe('interrupted')
        } else {
          await expect(submission).rejects.toThrow(
            scenario === 'overflow'
              ? 'JSON-RPC input frame exceeds 512 bytes'
              : 'Codex turn ended with status failed',
          )
        }
        await expect(readFile(exitMarker, 'utf8')).resolves.toBe('exited')
        await expect(readdir(temporaryRoot)).resolves.toEqual([])
      } finally {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
