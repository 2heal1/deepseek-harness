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

  it('unregisters the Provider when its plugin fiber is disposed', async () => {
    const { ctx, root } = await runtimeProfile([])
    try {
      await ctx.plugin(AgentRuntimeRegistry)
      const fiber = await ctx.plugin(CodexRuntime, { maxFrameBytes: 512 })
      const providerId = AgentRuntimeProviderId('codex-app-server')

      expect(ctx.agentRuntimes.getProvider(providerId)).toBeDefined()
      await fiber.dispose()
      expect(ctx.agentRuntimes.getProvider(providerId)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'overflow',
    'failure',
    'cancellation',
    'success',
    'max-tokens',
    'empty',
    'blank',
    'non-text',
    'busy',
    'timeout',
    'cleanup-failure',
    'startup-failure',
  ] as const)(
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
      const send = (...values) => process.stdout.write(values.map(value => JSON.stringify(value)).join('\\n') + '\\n')
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\\n')
          if (newline < 0) break
          const frame = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          if (frame.method === 'initialize') {
            if (scenario === 'startup-failure') {
              send({ id: frame.id, error: { code: -32603, message: 'startup failed' } })
            } else {
              send({ id: frame.id, result: {} })
            }
          }
          if (frame.method === 'thread/start') {
            send({ id: frame.id, result: { thread: { id: 'thread-1', ephemeral: true } } })
          }
          if (frame.method === 'turn/start') {
            send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
            writeFileSync(${JSON.stringify(turnMarker)}, 'started')
            if (scenario === 'overflow') {
              setImmediate(() => process.stdout.write('x'.repeat(513)))
            }
            if (scenario === 'failure' || scenario === 'cleanup-failure') {
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
            if (scenario === 'max-tokens') {
              setImmediate(() => send({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-1',
                  turn: {
                    id: 'turn-1',
                    status: 'failed',
                    error: { codexErrorInfo: 'contextWindowExceeded' },
                  },
                },
              }))
            }
            if (scenario === 'success') {
              setImmediate(() => {
                send(
                  {
                    method: 'item/agentMessage/delta',
                    params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'live' },
                  },
                  {
                    method: 'item/completed',
                    params: {
                      threadId: 'thread-1',
                      turnId: 'turn-1',
                      item: { type: 'agentMessage', text: 'answer', phase: 'final_answer' },
                    },
                  },
                  {
                    method: 'turn/completed',
                    params: {
                      threadId: 'thread-1',
                      turn: { id: 'turn-1', status: 'completed', error: null },
                    },
                  },
                )
                setTimeout(() => send({
                  method: 'item/agentMessage/delta',
                  params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'late' },
                }), 10)
              })
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
                turnTimeoutMs: scenario === 'timeout' ? 20 : 1_000,
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
        const profile = ctx.agentRuntimeProfiles.resolve('codex')
        if (scenario === 'overflow') {
          await expect(provider.probe({
            profile,
            signal: new AbortController().signal,
          })).resolves.toMatchObject({
            permissionEnforcement: 'enforced',
            protocolVersion: '0.147.0',
          })
          for (const policy of [null, [], {}, { sandbox: 'other' }]) {
            await expect(provider.probe({
              profile: {
                ...profile,
                permissions: {
                  ...profile.permissions,
                  policy: policy,
                },
              },
              signal: new AbortController().signal,
            })).rejects.toThrow('requires the workspace-write unattended permission policy')
          }
          await expect(provider.prepare({
            kind: 'resume',
            runtimeId: AgentRuntimeId('runtime-resume'),
            sessionId,
            profile,
            agentCtx: {} as Context,
            sink: {
              facts() {},
              assistantChunk() {},
              assistantMessage() {},
              activity() {},
            },
            signal: new AbortController().signal,
          })).rejects.toThrow('does not support resume')
          for (const agent of [
            undefined,
            { id: 'other', session: { header: { cwd: workspace } } },
            { id: sessionId, session: { header: {} } },
          ]) {
            await expect(provider.prepare({
              kind: 'create',
              runtimeId: AgentRuntimeId('runtime-invalid'),
              sessionId,
              profile,
              agentCtx: { agent } as unknown as Context,
              sink: {
                facts() {},
                assistantChunk() {},
                assistantMessage() {},
                activity() {},
              },
              signal: new AbortController().signal,
            })).rejects.toThrow('requires the matching unpublished Agent')
          }
        }
        const chunks: string[] = []
        const messages: string[] = []
        const sink: AgentRuntimeEventSink = {
          facts() {},
          assistantChunk(_submissionId, chunk) {
            if (chunk.kind === 'text-delta') chunks.push(chunk.text)
          },
          assistantMessage(_submissionId, message) {
            for (const block of message.content) {
              if (block.type === 'text') messages.push(block.text)
            }
          },
          activity() {},
        }
        const preparing = provider.prepare({
          kind: 'create',
          runtimeId: AgentRuntimeId('runtime-1'),
          sessionId,
          profile,
          agentCtx: {
            agent: { id: sessionId, session: { header: { cwd: workspace } } },
            agentRuntimeLauncher: ctx.agentRuntimeLauncher,
          } as unknown as Context,
          sink,
          signal: new AbortController().signal,
        })
        if (scenario === 'startup-failure') {
          await expect(preparing).rejects.toThrow('startup failed')
          await expect(readFile(exitMarker, 'utf8')).resolves.toBe('exited')
          await expect(readdir(temporaryRoot)).resolves.toEqual([])
          return
        }
        const runtime = await preparing

        const submissionId = SubmissionId('submission-1')
        const submissionAbort = new AbortController()
        const content = scenario === 'empty'
          ? []
          : scenario === 'blank'
            ? [{ type: 'text' as const, text: '  ' }]
            : scenario === 'non-text'
              ? [{ type: 'reasoning' as const, text: 'private' }]
              : [{ type: 'text' as const, text: 'trigger overflow' }]
        const submission = runtime.submit({
          submissionId,
          message: createUserMessage({
            content,
            source: { kind: 'user' },
          }),
          signal: submissionAbort.signal,
          started() {},
        })
        if (scenario === 'empty' || scenario === 'blank' || scenario === 'non-text') {
          await expect(submission).rejects.toThrow(
            scenario === 'non-text' ? 'accepts text-only user input' : 'requires non-empty user input',
          )
          runtime.cancel(SubmissionId('other'), { kind: 'user' })
          await runtime.dispose()
        } else if (scenario === 'cancellation' || scenario === 'busy') {
          await vi.waitFor(async () => {
            await expect(readFile(turnMarker, 'utf8')).resolves.toBe('started')
          })
          if (scenario === 'busy') {
            await expect(runtime.submit({
              submissionId: SubmissionId('submission-2'),
              message: createUserMessage({
                content: [{ type: 'text', text: 'second' }],
                source: { kind: 'user' },
              }),
              signal: new AbortController().signal,
              started() {},
            })).rejects.toThrow('already has a running submission')
          }
          const cause = { kind: 'user' } as const
          submissionAbort.abort(cause)
          runtime.cancel(submissionId, cause)
          await expect(submission).resolves.toEqual({
            reason: { kind: 'aborted', reason: cause },
          })
          await expect(readFile(interruptMarker, 'utf8')).resolves.toBe('interrupted')
        } else if (scenario === 'success' || scenario === 'max-tokens') {
          await expect(submission).resolves.toEqual({
            reason: scenario === 'success' ? { kind: 'completed' } : { kind: 'interrupted' },
          })
          if (scenario === 'success') {
            await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
            expect(chunks).toEqual(['live'])
            expect(messages).toEqual(['answer'])
          }
          await runtime.dispose()
        } else if (scenario === 'cleanup-failure') {
          const dispose = runtime.dispose.bind(runtime)
          runtime.dispose = async () => {
            throw new Error('cleanup failed')
          }
          await expect(submission).rejects.toThrow('Codex submission and cleanup failed')
          await dispose()
        } else {
          await expect(submission).rejects.toThrow(
            scenario === 'overflow'
              ? 'JSON-RPC input frame exceeds 512 bytes'
              : scenario === 'timeout'
                ? 'exceeded 20ms'
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
