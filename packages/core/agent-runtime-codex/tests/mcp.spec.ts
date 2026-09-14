import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry, {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  type AgentRuntimeEventSink,
  type AgentRuntimePrepareRequest,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import AgentRuntimeMcpGateway from '@deepseek-ai/dsh-mcp-runtime-gateway'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CodexRuntime from '../src/index.ts'

const contexts: Context[] = []
const providerId = AgentRuntimeProviderId('codex-app-server')

function appServerScript(marker: string): string {
  return `
    import { writeFileSync } from 'node:fs'
    let buffer = ''
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
    const config = Object.fromEntries(process.argv.slice(1).flatMap((value, index, argv) =>
      value === '-c' && argv[index + 1]?.includes('=') ? [argv[index + 1].split(/=(.*)/s).slice(0, 2)] : []))
    const gatewayUrl = JSON.parse(config['mcp_servers.deepseek_harness.url'])
    const tokenEnv = JSON.parse(config['mcp_servers.deepseek_harness.bearer_token_env_var'])
    const rpc = async (method, params) => {
      const response = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer ' + process.env[tokenEnv],
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
      })
      return response.json()
    }
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
          send({ id: frame.id, result: { thread: { id: 'thread-mcp', ephemeral: true } } })
        }
        if (frame.method === 'turn/start') {
          send({ id: frame.id, result: { turn: { id: 'turn-mcp' } } })
          void (async () => {
            const listed = await rpc('tools/list')
            const called = await rpc('tools/call', { name: 'echo', arguments: { value: 'from-codex' } })
            writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
              argv: process.argv.slice(1),
              tokenPresent: typeof process.env[tokenEnv] === 'string',
              listed,
              called,
            }))
            send({
              method: 'item/completed',
              params: {
                threadId: 'thread-mcp',
                turnId: 'turn-mcp',
                item: { type: 'agentMessage', text: 'done', phase: 'final_answer' },
              },
            })
            send({
              method: 'turn/completed',
              params: {
                threadId: 'thread-mcp',
                turn: { id: 'turn-mcp', status: 'completed', error: null },
              },
            })
          })()
        }
        if (frame.method === 'turn/interrupt') {
          send({ id: frame.id, result: {} })
          send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-mcp',
              turn: { id: 'turn-mcp', status: 'interrupted', error: null },
            },
          })
        }
      }
    })
    process.stdin.on('end', () => process.exit(0))
    setInterval(() => {}, 1_000)
  `
}

async function setup(options: { readonly gateway?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-mcp-'))
  const marker = join(root, 'mcp.json')
  const temporaryRoot = join(root, 'launches')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRuntimeProfiles, {
    defaultMainProfile: 'codex',
    profiles: {
      codex: {
        provider: 'codex-app-server',
        launch: {
          executable: process.execPath,
          args: ['-e', appServerScript(marker)],
          resolution: 'absolute',
          cwdPolicy: { fixed: root },
        },
        permissions: {
          policy: { sandbox: 'workspace-write' },
          enforcement: 'required',
        },
        harnessTools: {
          transport: 'mcp',
          allowed: ['echo'],
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
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.gateway !== false) await ctx.plugin(AgentRuntimeMcpGateway, {})
  await ctx.plugin(CodexRuntime, { maxFrameBytes: 1_024 })
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo one value.',
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => Promise.resolve(args.value),
  }))
  const sessionId = SessionId('codex-mcp')
  const session = ctx.sessions.create(sessionId, { meta: { cwd: root } })
  const agent = { id: sessionId, session } as Agent
  const profile = ctx.agentRuntimeProfiles.resolve('codex')
  const provider = ctx.agentRuntimes.getProvider(providerId)
  if (provider === undefined) throw new Error('Codex Provider was not registered')
  const sink: AgentRuntimeEventSink = {
    facts() {},
    assistantChunk() {},
    assistantMessage() {},
    activity() {},
  }
  const prepareRequest: AgentRuntimePrepareRequest = {
    kind: 'create',
    runtimeId: AgentRuntimeId('runtime-mcp'),
    sessionId,
    profile,
    agentCtx: { agent } as Context,
    sink,
    signal: new AbortController().signal,
  }
  return { ctx, root, marker, temporaryRoot, session, profile, provider, prepareRequest }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('Codex Harness MCP transport', () => {
  it('injects one launch-scoped gateway and executes an allowlisted Harness tool', async () => {
    const value = await setup()
    try {
      await expect(value.provider.probe({
        profile: value.profile,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        capabilities: [
          { id: 'runtimeActivity' },
          { id: 'harnessTools', metadata: { transport: 'mcp' } },
        ],
      })
      const runtime = await value.provider.prepare(value.prepareRequest)
      expect(runtime.capabilities).toContainEqual({
        id: 'harnessTools',
        metadata: { transport: 'mcp' },
      })
      expect(runtime.initialFacts.capabilities).toEqual(runtime.capabilities)
      value.session.append('agent/runtime/facts', runtime.initialFacts)
      value.session.append('turn/start', { turn: 1 })
      value.session.append('agent/submission/started', {
        submissionId: SubmissionId('submission-1'),
        messageId: MessageId('message-1'),
        turn: 1,
      })
      await expect(runtime.submit({
        submissionId: SubmissionId('submission-1'),
        message: createUserMessage({
          content: [{ type: 'text', text: 'call echo' }],
          source: { kind: 'user' },
        }),
        signal: new AbortController().signal,
        started() {},
      })).resolves.toEqual({ reason: { kind: 'completed' } })
      const observation = JSON.parse(await readFile(value.marker, 'utf8')) as {
        argv: string[]
        tokenPresent: boolean
        listed: unknown
        called: unknown
      }
      expect(observation.argv).toEqual(expect.arrayContaining([
        '-c',
        'mcp_servers.deepseek_harness.bearer_token_env_var="DSH_HARNESS_MCP_TOKEN"',
      ]))
      expect(observation.argv.join(' ')).not.toContain(process.env['DSH_HARNESS_MCP_TOKEN'] ?? '__unset__')
      expect(observation.tokenPresent).toBe(true)
      expect(observation.listed).toMatchObject({ result: { tools: [{ name: 'echo' }] } })
      expect(observation.called).toMatchObject({
        result: { content: [{ type: 'text', text: 'from-codex' }] },
      })
      expect(value.session.events.filter(event => event.type.startsWith('agent/runtime/tool-')))
        .toHaveLength(2)
      await runtime.dispose()
      await expect(readdir(value.temporaryRoot)).resolves.toEqual([])
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  it('fails before launch when an MCP profile has no gateway service', async () => {
    const value = await setup({ gateway: false })
    try {
      await expect(value.provider.prepare(value.prepareRequest))
        .rejects.toThrow('requires the Harness MCP runtime gateway')
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  it('revokes a newly opened gateway when process launch fails', async () => {
    const value = await setup()
    try {
      const gateway = value.ctx.agentRuntimeMcpGateway
      const open = gateway.open.bind(gateway)
      const dispose = vi.fn<() => Promise<void>>()
      gateway.open = (request) => {
        const handle = open(request)
        return {
          connection: handle.connection,
          dispose: async () => {
            await handle.dispose()
            await dispose()
          },
        }
      }
      value.ctx.agentRuntimeLauncher.launch = () => Promise.reject(new Error('spawn failed'))
      await expect(value.provider.prepare(value.prepareRequest)).rejects.toThrow('spawn failed')
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  it.each([
    { launchFailure: new Error('launch cleanup failed'), gatewayFailure: undefined, expected: 'launch cleanup failed' },
    { launchFailure: 'non-error cleanup', gatewayFailure: undefined, expected: 'Codex runtime cleanup failed' },
    { launchFailure: undefined, gatewayFailure: new Error('gateway cleanup failed'), expected: 'gateway cleanup failed' },
    {
      launchFailure: new Error('launch cleanup failed'),
      gatewayFailure: new Error('gateway cleanup failed'),
      expected: 'Codex runtime and MCP gateway cleanup failed',
    },
  ])('reports runtime and gateway cleanup failures', async ({ launchFailure, gatewayFailure, expected }) => {
    const value = await setup()
    try {
      const launch = value.ctx.agentRuntimeLauncher.launch.bind(value.ctx.agentRuntimeLauncher)
      value.ctx.agentRuntimeLauncher.launch = async (request) => {
        const handle = await launch(request)
        const dispose = handle.dispose.bind(handle)
        handle.dispose = async (shutdown) => {
          await dispose(shutdown)
          if (launchFailure !== undefined) throw launchFailure
        }
        return handle
      }
      const gateway = value.ctx.agentRuntimeMcpGateway
      const open = gateway.open.bind(gateway)
      gateway.open = (request) => {
        const handle = open(request)
        const dispose = handle.dispose.bind(handle)
        return {
          connection: handle.connection,
          dispose: async () => {
            await dispose()
            if (gatewayFailure !== undefined) throw gatewayFailure
          },
        }
      }
      const runtime = await value.provider.prepare(value.prepareRequest)
      await expect(runtime.dispose()).rejects.toThrow(expected)
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })
})
