import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import { MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRuntimeMcpGateway from '../src/index.ts'

const contexts: Context[] = []

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRuntimeMcpGateway, {})
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
  ctx.tools.register(defineTool({
    name: 'hidden',
    description: 'Must not be exposed.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('hidden'),
  }))
  const session = ctx.sessions.create(SessionId('gateway-session'))
  const agent = { id: session.id, session } as Agent
  const submissionId = SubmissionId('submission-1')
  session.append('agent/runtime/facts', snapshotAgentRuntimeFacts({
    runtimeId: AgentRuntimeId('runtime-1'),
    providerId: AgentRuntimeProviderId('provider-1'),
    capabilities: snapshotAgentRuntimeCapabilities([{ id: 'harnessTools' }]),
    phase: 'ready',
  }))
  session.append('turn/start', { turn: 1 })
  session.append('agent/submission/started', {
    submissionId,
    messageId: MessageId('message-1'),
    turn: 1,
  })
  const handle = ctx.agentRuntimeMcpGateway.open({
    agent,
    runtimeId: AgentRuntimeId('runtime-1'),
    providerId: AgentRuntimeProviderId('provider-1'),
    allowedTools: ['echo'],
    signal: new AbortController().signal,
  })
  return { ctx, session, handle }
}

async function request(url: string, token: string | undefined, method: string, params?: object) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...token === undefined ? {} : { authorization: `Bearer ${token}` },
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...params === undefined ? {} : { params },
    }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('AgentRuntimeMcpGateway', () => {
  it('authenticates, exposes the exact allowlist, executes through ToolRuntime, and audits', async () => {
    const { session, handle } = await setup()
    const { url, token } = handle.connection

    await expect(request(url, undefined, 'tools/list')).resolves.toMatchObject({ status: 401 })
    const listed = await request(url, token, 'tools/list')
    expect(listed).toMatchObject({
      status: 200,
      body: { result: { tools: [{ name: 'echo' }] } },
    })
    const called = await request(url, token, 'tools/call', {
      name: 'echo',
      arguments: { value: 'through-mcp' },
    })
    expect(called).toMatchObject({
      status: 200,
      body: { result: { content: [{ type: 'text', text: 'through-mcp' }] } },
    })
    expect(session.events.filter(event => event.type.startsWith('agent/runtime/tool-')))
      .toMatchObject([
        { type: 'agent/runtime/tool-call', data: { name: 'echo', submissionId: 'submission-1' } },
        { type: 'agent/runtime/tool-result', data: { isError: false, submissionId: 'submission-1' } },
      ])

    const hidden = await request(url, token, 'tools/call', { name: 'hidden', arguments: {} })
    expect(hidden.body).toMatchObject({ error: { code: -32602 } })
    await handle.dispose()
    await expect(request(url, token, 'tools/list')).resolves.toMatchObject({ status: 404 })
  })
})
