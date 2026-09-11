import { existsSync } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  type AgentRuntimeEventSink,
  type AgentRuntimePrepareRequest,
  type PreparedAgentRuntime,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AcpRuntime from '../src/index.ts'

const fixturePath = fileURLToPath(new URL('./mock-acp-runtime.mjs', import.meta.url))
const fixtureManifestPath = fileURLToPath(new URL(
  '../../../subagent/subagent-acp/tests/fixtures/protocol-v1-sdk-0.25.1/manifest.json',
  import.meta.url,
))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly workspace: string
  readonly temporaryRoot: string
  readonly exitMarker: string
  readonly promptMarker: string
  readonly cancelMarker: string
  readonly provider: NonNullable<ReturnType<Context['agentRuntimes']['getProvider']>>
  readonly runtimePlugin: { dispose(): Promise<void> }
  readonly request: AgentRuntimePrepareRequest
}

async function harness(
  scenario: string,
  options: {
    readonly args?: string[]
    readonly startupMs?: number
    readonly turnMs?: number
    readonly shutdownMs?: number
    readonly maxFrameBytes?: number
    readonly maxOutputBytes?: number
    readonly policy?: unknown
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-runtime-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const temporaryRoot = join(root, 'launches')
  await mkdir(workspace)
  const exitMarker = join(workspace, 'exited')
  const promptMarker = join(workspace, 'prompt')
  const cancelMarker = join(workspace, 'cancel')
  const ctx = new Context()
  await ctx.plugin(AgentRuntimeProfiles, {
    defaultMainProfile: 'acp',
    profiles: {
      acp: {
        provider: 'acp',
        launch: {
          executable: process.execPath,
          args: options.args ?? [fixturePath],
          resolution: 'absolute',
          cwdPolicy: { fixed: workspace },
          env: {
            MOCK_SCENARIO: scenario,
            MOCK_EXIT_MARKER: exitMarker,
            MOCK_PROMPT_MARKER: promptMarker,
            MOCK_CANCEL_MARKER: cancelMarker,
          },
        },
        permissions: {
          policy: options.policy ?? { sandbox: 'workspace-write' },
          enforcement: 'best-effort',
        },
        process: {
          startupTimeoutMs: options.startupMs ?? 1_000,
          turnTimeoutMs: options.turnMs ?? 1_000,
          shutdownTimeoutMs: options.shutdownMs ?? 100,
          terminationTimeoutMs: 1_000,
          maxConcurrentRuns: 1,
        },
      },
    },
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRuntimeLauncher, { temporaryRoot })
  await ctx.plugin(AgentRuntimeRegistry)
  const runtimePlugin = ctx.plugin(AcpRuntime, {
    maxFrameBytes: options.maxFrameBytes ?? 1_048_576,
    maxOutputBytes: options.maxOutputBytes ?? 4_194_304,
    maxStderrBytes: 65_536,
  })
  await runtimePlugin
  const provider = ctx.agentRuntimes.getProvider(AgentRuntimeProviderId('acp'))
  if (provider === undefined) throw new Error('ACP runtime Provider was not registered')
  const sessionId = 'session-1' as AgentRuntimePrepareRequest['sessionId']
  return {
    ctx,
    root,
    workspace,
    temporaryRoot,
    exitMarker,
    promptMarker,
    cancelMarker,
    provider,
    runtimePlugin,
    request: {
      kind: 'create',
      runtimeId: AgentRuntimeId('runtime-1'),
      sessionId,
      profile: ctx.agentRuntimeProfiles.resolve('acp'),
      agentCtx: {
        agent: { id: sessionId, session: { header: { cwd: workspace } } },
        agentRuntimeLauncher: ctx.agentRuntimeLauncher,
      } as unknown as Context,
      sink: {
        facts() {},
        assistantChunk() {},
        assistantMessage() {},
        activity() {},
      },
      signal: new AbortController().signal,
    },
  }
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(async () => {
    await expect(access(path)).resolves.toBeUndefined()
  })
}

async function expectQuiescent(value: Harness, cooperative = true): Promise<void> {
  if (cooperative) {
    await expect(readFile(value.exitMarker, 'utf8')).resolves.toBe('exited')
  }
  await expect(readdir(value.temporaryRoot)).resolves.toEqual([])
}

function failLaunchDisposal(ctx: Context): void {
  const launch = ctx.agentRuntimeLauncher.launch.bind(ctx.agentRuntimeLauncher)
  ctx.agentRuntimeLauncher.launch = async (request) => {
    const handle = await launch(request)
    const dispose = handle.dispose.bind(handle)
    handle.dispose = async (shutdown) => {
      await dispose(shutdown)
      throw new Error('injected cleanup failure')
    }
    return handle
  }
}

function submission(
  id: string,
  signal = new AbortController().signal,
  content = [{ type: 'text' as const, text: 'fixture task' }],
) {
  return {
    submissionId: SubmissionId(id),
    message: createUserMessage({ content, source: { kind: 'user' } }),
    signal,
    started: vi.fn(),
  }
}

describe('ACP one-shot runtime Provider', () => {
  it('pins the P0b SDK and protocol baseline', async () => {
    const manifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8')) as {
      protocol: string
      protocolVersion: number
      sdk: { version: string }
    }
    expect(manifest).toMatchObject({
      protocol: 'acp',
      protocolVersion: 1,
      sdk: { version: '0.25.1' },
    })
  })

  it('injects the trusted protocol argv and rejects Profile-owned forms before spawn', async () => {
    const value = await harness('success', {
      args: ['-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(tmpdir(), 'unused'))}, '')`],
    })
    const output = join(value.workspace, 'argv.json')
    const profile = {
      ...value.request.profile,
      launch: {
        ...value.request.profile.launch,
        args: ['-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)))`],
      },
    }
    const handle = await value.ctx.agentRuntimeLauncher.launch({
      profile,
      cwd: value.workspace,
      driver: AcpRuntime.ACP_AGENT_CLI_DRIVER,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
    })
    await handle.process.done
    await expect(readFile(output, 'utf8')).resolves.toBe(JSON.stringify(['acp', 'serve']))
    await handle.dispose()

    for (const argument of ['acp', 'serve']) {
      await expect(value.ctx.agentRuntimeLauncher.launch({
        profile: {
          ...profile,
          launch: { ...profile.launch, args: [argument] },
        },
        cwd: value.workspace,
        driver: AcpRuntime.ACP_AGENT_CLI_DRIVER,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        signal: new AbortController().signal,
      })).rejects.toThrow(`attempts to set reserved argument "${argument}"`)
    }
    await value.ctx.fiber.dispose()
  })

  it('streams and completes exactly one submission, then reaches quiescence', async () => {
    const value = await harness('success')
    const chunks: string[] = []
    const messages: string[] = []
    const sink: AgentRuntimeEventSink = {
      facts() {},
      assistantChunk(_id, chunk) {
        if (chunk.kind === 'text-delta') chunks.push(chunk.text)
      },
      assistantMessage(_id, output) {
        expect(existsSync(value.exitMarker)).toBe(true)
        for (const block of output.content) {
          if (block.type === 'text') messages.push(block.text)
        }
      },
      activity() {},
    }
    const runtime = await value.provider.prepare({ ...value.request, sink })
    expect(runtime.initialFacts).toMatchObject({
      runtimeId: 'runtime-1',
      providerId: 'acp',
      phase: 'ready',
      product: { value: 'Mock ACP Agent', source: 'protocol' },
      productVersion: { value: '1.2.3', source: 'protocol' },
      protocol: { value: 'acp', source: 'profile' },
      protocolVersion: { value: '1', source: 'protocol' },
      externalSessionId: 'acp-session-1',
    })
    const first = submission('submission-1')
    await expect(runtime.submit(first)).resolves.toEqual({ reason: { kind: 'completed' } })
    expect(first.started).not.toHaveBeenCalled()
    expect(chunks).toEqual(['fixture ', 'answer'])
    expect(messages).toEqual(['fixture answer'])
    await expect(runtime.submit(submission('submission-2')))
      .rejects.toThrow('accepts exactly one submission')
    await runtime.dispose()
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it.each([
    ['no-agent-info', undefined],
    ['update-during-init', { value: 'Mock ACP Agent', source: 'protocol' }],
  ] as const)('handles the %s handshake facts', async (scenario, product) => {
    const value = await harness(scenario)
    const chunks: string[] = []
    const runtime = await value.provider.prepare({
      ...value.request,
      sink: {
        facts() {},
        assistantChunk(_id, chunk) {
          if (chunk.kind === 'text-delta') chunks.push(chunk.text)
        },
        assistantMessage() {},
        activity() {},
      },
    })
    expect(runtime.initialFacts.product).toEqual(product)
    await expect(runtime.submit(submission('submission-1'))).resolves.toEqual({
      reason: { kind: 'completed' },
    })
    expect(chunks).toEqual(['fixture ', 'answer'])
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it.each([
    ['max-tokens', { kind: 'max-tokens' }],
    ['refusal', { kind: 'blocked' }],
    ['permission', { kind: 'interrupted' }],
  ] as const)('maps the %s terminal result', async (scenario, reason) => {
    const value = await harness(scenario)
    const runtime = await value.provider.prepare(value.request)
    await expect(runtime.submit(submission('submission-1'))).resolves.toEqual({ reason })
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('drains and bounds child stderr without blocking the ACP turn', async () => {
    const value = await harness('stderr-flood', { turnMs: 2_000 })
    const runtime = await value.provider.prepare(value.request)
    await expect(runtime.submit(submission('submission-1'))).resolves.toEqual({
      reason: { kind: 'completed' },
    })
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('bounds the joined assistant result by cumulative UTF-8 bytes', async () => {
    const exact = await harness('multibyte-output', { maxOutputBytes: 4 })
    const exactRuntime = await exact.provider.prepare(exact.request)
    await expect(exactRuntime.submit(submission('exact'))).resolves.toEqual({
      reason: { kind: 'completed' },
    })
    await expectQuiescent(exact)
    await exact.ctx.fiber.dispose()

    const oversized = await harness('multibyte-output-overflow', { maxOutputBytes: 3 })
    const chunks: string[] = []
    const oversizedRuntime = await oversized.provider.prepare({
      ...oversized.request,
      sink: {
        facts() {},
        assistantChunk(_id, chunk) {
          if (chunk.kind === 'text-delta') chunks.push(chunk.text)
        },
        assistantMessage() {},
        activity() {},
      },
    })
    await expect(oversizedRuntime.submit(submission('oversized')))
      .rejects.toThrow('ACP assistant output exceeds 3 UTF-8 bytes')
    expect(chunks).toEqual(['好'])
    await expectQuiescent(oversized)
    await oversized.ctx.fiber.dispose()
  })

  it('keeps complete cancellation updates and then settles with the Harness cause', async () => {
    const value = await harness('cancel')
    const chunks: string[] = []
    const messages: string[] = []
    const runtime = await value.provider.prepare({
      ...value.request,
      sink: {
        facts() {},
        assistantChunk(_id, chunk) {
          if (chunk.kind === 'text-delta') chunks.push(chunk.text)
        },
        assistantMessage(_id, output) {
          const block = output.content[0]
          if (block?.type === 'text') messages.push(block.text)
        },
        activity() {},
      },
    })
    const controller = new AbortController()
    const request = submission('submission-1', controller.signal)
    const result = runtime.submit(request)
    await waitForFile(value.promptMarker)
    runtime.cancel(SubmissionId('other'), { kind: 'user' })
    const cause = { kind: 'user' } as const
    controller.abort(cause)
    runtime.cancel(request.submissionId, cause)
    runtime.cancel(request.submissionId, { kind: 'parent' })
    await expect(result).resolves.toEqual({ reason: { kind: 'aborted', reason: cause } })
    runtime.cancel(request.submissionId, cause)
    expect(chunks).toEqual(['fixture ', 'cancelled tail'])
    expect(messages).toEqual(['fixture cancelled tail'])
    await expect(readFile(value.cancelMarker, 'utf8')).resolves.toBe('acp-session-1')
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it.each(['before', 'during'] as const)('observes submission signal cancellation %s prompt', async (timing) => {
    const value = await harness('ignore-cancel', { shutdownMs: 20 })
    const runtime = await value.provider.prepare(value.request)
    const controller = new AbortController()
    const cause = { kind: 'hook', reason: `${timing} prompt` } as const
    if (timing === 'before') controller.abort(cause)
    const result = runtime.submit(submission('submission-1', controller.signal))
    if (timing === 'during') {
      await waitForFile(value.promptMarker)
      controller.abort(cause)
    }
    await expect(result).resolves.toEqual({ reason: { kind: 'aborted', reason: cause } })
    await expectQuiescent(value, false)
    await value.ctx.fiber.dispose()
  })

  it('terminates a non-cooperative cancellation and removes launch material', async () => {
    const value = await harness('ignore-cancel', { shutdownMs: 20 })
    const runtime = await value.provider.prepare(value.request)
    const controller = new AbortController()
    const request = submission('submission-1', controller.signal)
    const result = runtime.submit(request)
    await waitForFile(value.promptMarker)
    const cause = { kind: 'parent' } as const
    controller.abort(cause)
    runtime.cancel(request.submissionId, cause)
    await expect(result).resolves.toEqual({ reason: { kind: 'aborted', reason: cause } })
    await expectQuiescent(value, false)
    await value.ctx.fiber.dispose()
  })

  it.each([
    ['failure', 'ACP submission failed'],
    ['eof', 'ACP submission failed'],
    ['wrong-session', 'ACP agent emitted unsupported assistant output'],
    ['non-text-output', 'ACP agent emitted unsupported assistant output'],
    ['oversized-frame', 'ACP input frame exceeds 512 bytes'],
    ['timeout', 'exceeded 20ms'],
    ['max-turn-requests', 'exhausted its turn-request budget'],
  ] as const)('cleans up the %s path', async (scenario, message) => {
    const value = await harness(scenario, {
      turnMs: scenario === 'timeout' ? 20 : 1_000,
      ...scenario === 'oversized-frame' ? { maxFrameBytes: 512 } : {},
    })
    const runtime = await value.provider.prepare(value.request)
    await expect(runtime.submit(submission('submission-1'))).rejects.toThrow(message)
    await expectQuiescent(value, scenario !== 'timeout')
    await value.ctx.fiber.dispose()
  })

  it('rejects malformed JSON without logging peer-controlled frame contents', async () => {
    const value = await harness('malformed-frame')
    const runtime = await value.provider.prepare(value.request)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(runtime.submit(submission('submission-1')))
        .rejects.toThrow('ACP input contains an invalid JSON-RPC frame')
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it.each(['chunk', 'message', 'both'] as const)(
    'cleans up when the Router %s sink rejects output',
    async (sinkMethod) => {
      const value = await harness('success')
      const runtime = await value.provider.prepare({
        ...value.request,
        sink: {
          facts() {},
          assistantChunk() {
            if (sinkMethod !== 'message') throw new Error('closed chunk sink')
          },
          assistantMessage() {
            if (sinkMethod !== 'chunk') throw new Error('closed message sink')
          },
          activity() {},
        },
      })
      await expect(runtime.submit(submission('submission-1'))).rejects.toThrow('ACP submission failed')
      await expectQuiescent(value)
      await value.ctx.fiber.dispose()
    },
  )

  it.each(['version-mismatch', 'empty-session', 'startup-failure'] as const)(
    'rolls back the %s startup failure',
    async (scenario) => {
      const value = await harness(scenario)
      await expect(value.provider.prepare(value.request)).rejects.toThrow(
        scenario === 'version-mismatch'
          ? 'unsupported protocol version'
          : scenario === 'empty-session'
            ? 'empty session id'
            : 'ACP initialization failed',
      )
      await expectQuiescent(value)
      await value.ctx.fiber.dispose()
    },
  )

  it.each(['success', 'failure'] as const)(
    'reports cleanup failure after %s without leaving the process alive',
    async (scenario) => {
      const value = await harness(scenario)
      failLaunchDisposal(value.ctx)
      const runtime = await value.provider.prepare(value.request)
      await expect(runtime.submit(submission('submission-1'))).rejects.toThrow(
        scenario === 'success' ? 'injected cleanup failure' : 'ACP submission failed',
      )
      await expect(runtime.dispose()).rejects.toThrow('injected cleanup failure')
      await expectQuiescent(value)
      await value.ctx.fiber.dispose()
    },
  )

  it('contains a failed best-effort cancellation request', async () => {
    const value = await harness('crash-cancel')
    const runtime = await value.provider.prepare(value.request)
    const controller = new AbortController()
    const request = submission('submission-1', controller.signal)
    const result = runtime.submit(request)
    await waitForFile(value.promptMarker)
    const cause = { kind: 'user' } as const
    controller.abort(cause)
    runtime.cancel(request.submissionId, cause)
    await expect(result).resolves.toEqual({ reason: { kind: 'aborted', reason: cause } })
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('reports cancellation cleanup failure after the process stops', async () => {
    const value = await harness('ignore-cancel', { shutdownMs: 20 })
    failLaunchDisposal(value.ctx)
    const runtime = await value.provider.prepare(value.request)
    const controller = new AbortController()
    const request = submission('submission-1', controller.signal)
    const result = runtime.submit(request)
    await waitForFile(value.promptMarker)
    const cause = { kind: 'user' } as const
    controller.abort(cause)
    runtime.cancel(request.submissionId, cause)
    await expect(result).resolves.toEqual({ reason: { kind: 'aborted', reason: cause } })
    await expect(runtime.dispose()).rejects.toThrow('injected cleanup failure')
    await expectQuiescent(value, false)
    await value.ctx.fiber.dispose()
  })

  it('disposes an active prompt without waiting for agent cooperation', async () => {
    const value = await harness('ignore-cancel', { shutdownMs: 20 })
    const runtime = await value.provider.prepare(value.request)
    const result = runtime.submit(submission('submission-1'))
    await waitForFile(value.promptMarker)
    await runtime.dispose()
    await expect(result).rejects.toThrow('ACP submission failed')
    await expectQuiescent(value, false)
    await value.ctx.fiber.dispose()
  })

  it('rejects unsupported profile, resume, context, and input before protocol work', async () => {
    const value = await harness('success')
    await expect(value.provider.probe({
      profile: value.request.profile,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      capabilities: [],
      permissionEnforcement: 'unsupported',
      protocolVersion: '1',
      details: { sdkVersion: '0.25.1' },
    })
    await expect(value.provider.probe({
      profile: {
        ...value.request.profile,
        permissions: { ...value.request.profile.permissions, policy: {} },
      },
      signal: new AbortController().signal,
    })).rejects.toThrow('requires the workspace-write unattended permission policy')
    await expect(value.provider.prepare({
      ...value.request,
      kind: 'resume',
    })).rejects.toThrow('does not support resume')
    await expect(value.provider.prepare({
      ...value.request,
      agentCtx: {} as Context,
    })).rejects.toThrow('requires the matching unpublished Agent')
    await expect(value.provider.prepare({
      ...value.request,
      profile: {
        ...value.request.profile,
        permissions: {
          ...value.request.profile.permissions,
          enforcement: 'required',
        },
      },
    })).rejects.toThrow('requires full permission enforcement')

    const runtime = await value.provider.prepare(value.request)
    await expect(runtime.submit(submission('empty', undefined, [])))
      .rejects.toThrow('requires non-empty user input')
    await expect(runtime.submit(submission('image', undefined, [{
      type: 'reasoning',
      text: 'private',
    }] as never))).rejects.toThrow('accepts text-only user input')
    await runtime.dispose()
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('lets Router cancellation win after the ACP prompt settles but before Provider return', async () => {
    const value = await harness('success')
    const cause = { kind: 'hook', reason: 'late cancellation' } as const
    const request = submission('submission-1')
    const runtime: PreparedAgentRuntime = await value.provider.prepare({
      ...value.request,
      sink: {
        facts() {},
        assistantChunk() {},
        assistantMessage() {
          runtime.cancel(request.submissionId, cause)
        },
        activity() {},
      },
    })
    await expect(runtime.submit(request)).resolves.toEqual({
      reason: { kind: 'aborted', reason: cause },
    })
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('drains prepared handles before plugin registration removal', async () => {
    const value = await harness('success')
    await value.provider.prepare(value.request)
    await value.runtimePlugin.dispose()
    expect(value.ctx.agentRuntimes.getProvider(AgentRuntimeProviderId('acp'))).toBeUndefined()
    await expectQuiescent(value)
    await expect(value.provider.probe({
      profile: value.request.profile,
      signal: new AbortController().signal,
    })).rejects.toThrow('Provider is stopping')
    await value.ctx.fiber.dispose()
  })

  it('waits for in-flight preparation and rejects its late publication while draining', async () => {
    const value = await harness('slow-start')
    const preparing = value.provider.prepare(value.request)
    await waitForFile(value.promptMarker)
    const draining = value.runtimePlugin.dispose()
    expect(value.ctx.agentRuntimes.getProvider(AgentRuntimeProviderId('acp'))).toBe(value.provider)
    await writeFile(value.cancelMarker, 'continue')
    await expect(preparing).rejects.toThrow('Provider is stopping')
    await expect(draining).resolves.toBeUndefined()
    expect(value.ctx.agentRuntimes.getProvider(AgentRuntimeProviderId('acp'))).toBeUndefined()
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('unregisters the Provider when prepared-handle drain fails', async () => {
    const value = await harness('success')
    failLaunchDisposal(value.ctx)
    await value.provider.prepare(value.request)
    await value.runtimePlugin.dispose()
    expect(value.ctx.agentRuntimes.getProvider(AgentRuntimeProviderId('acp'))).toBeUndefined()
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })

  it('reports cleanup failure from a preparation caught by concurrent drain', async () => {
    const value = await harness('slow-start')
    failLaunchDisposal(value.ctx)
    const preparing = value.provider.prepare(value.request)
    await waitForFile(value.promptMarker)
    const drain = Reflect.get(value.provider, 'drain') as () => Promise<void>
    const draining = drain.call(value.provider)
    await writeFile(value.cancelMarker, 'continue')
    await expect(preparing).rejects.toThrow('ACP initialization failed')
    await expect(draining).rejects.toThrow(
      'ACP runtime Provider failed to drain prepared handles',
    )
    await value.runtimePlugin.dispose()
    await expectQuiescent(value)
    await value.ctx.fiber.dispose()
  })
})
