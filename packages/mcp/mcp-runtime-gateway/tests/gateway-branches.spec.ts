import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import AttachmentStore, {
  AttachmentId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { CallId, HarnessError, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRuntimeMcpGateway, {
  type Config,
  type RuntimeMcpGatewayOpenRequest,
} from '../src/index.ts'

const contexts: Context[] = []
const runtimeId = AgentRuntimeId('runtime-1')
const providerId = AgentRuntimeProviderId('provider-1')
const submissionId = SubmissionId('submission-1')
const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'1'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

class FixtureAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 10,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 10,
    maxImagePixels: 1,
    maxImageDimension: 1,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve(imageRef)
  }

  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    return Promise.resolve({ ref, data: Uint8Array.of(1, 2, 3) })
  }
}

interface SetupOptions {
  readonly active?: 'open' | 'ended' | 'settled' | 'none'
  readonly allowedTools?: readonly string[]
  readonly config?: Config
  readonly attachments?: boolean
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.attachments === true) await ctx.plugin(FixtureAttachments)
  await ctx.plugin(AgentRuntimeMcpGateway, options.config ?? {})
  const unregisterEcho = ctx.tools.register(defineTool({
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
    name: 'fail',
    description: 'Return a structured failure.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.reject(new HarnessError('denied', 'DENIED')),
  }))
  ctx.tools.register(defineTool({
    name: 'mixed',
    description: 'Return all projected content kinds.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: () => [
        { type: 'reasoning', text: 'thought' },
        { type: 'image', attachment: imageRef },
        { type: 'tool-call', id: CallId('nested'), name: 'nested', arguments: '{}' },
      ],
    },
    execute: () => Promise.resolve('mixed'),
  }))
  const session = ctx.sessions.create(SessionId('gateway-branches'))
  const agent = { id: session.id, session } as Agent
  session.append('agent/runtime/facts', snapshotAgentRuntimeFacts({
    runtimeId,
    providerId,
    capabilities: snapshotAgentRuntimeCapabilities([{ id: 'harnessTools' }]),
    phase: 'ready',
  }))
  const active = options.active ?? 'open'
  if (active !== 'none') {
    session.append('turn/start', { turn: 1 })
    session.append('agent/submission/started', {
      submissionId,
      messageId: MessageId('message-1'),
      turn: 1,
    })
    if (active === 'ended') {
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    if (active === 'settled') {
      session.append('agent/submission/settled', {
        submissionId,
        messageId: MessageId('message-1'),
        settlement: {
          kind: 'settled',
          turn: 1,
          reason: { kind: 'completed' },
        },
      })
    }
  }
  const openRequest: RuntimeMcpGatewayOpenRequest = {
    agent,
    runtimeId,
    providerId,
    allowedTools: options.allowedTools ?? ['echo', 'fail', 'mixed'],
    signal: new AbortController().signal,
  }
  return { ctx, session, agent, openRequest, unregisterEcho }
}

async function rpc(
  url: string,
  token: string,
  method: string,
  params?: object,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...params === undefined ? {} : { params },
    }),
  })
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
    headers: response.headers,
  }
}

function rawRequest(
  url: string,
  options: {
    readonly method?: string
    readonly token?: string
    readonly body?: string
    readonly contentLength?: number
    readonly chunks?: readonly string[]
  },
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: options.method ?? 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        'content-type': 'application/json',
        ...options.contentLength === undefined ? {} : { 'content-length': options.contentLength },
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          headers: response.headers,
        })
      })
    })
    request.on('error', reject)
    for (const chunk of options.chunks ?? [options.body ?? '']) request.write(chunk)
    request.end()
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('AgentRuntimeMcpGateway edge behavior', () => {
  it('rejects invalid ownership, startup state, and allowlists before registration', async () => {
    const { ctx, agent, openRequest } = await setup({ allowedTools: [] })
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    expect(() => ctx.agentRuntimeMcpGateway.open({
      ...openRequest,
      signal: aborted.signal,
    })).toThrow('cancelled')
    expect(() => ctx.agentRuntimeMcpGateway.open({
      ...openRequest,
      agent: { ...agent, id: SessionId('other') },
    })).toThrow('matching Agent and Session identities')
    for (const allowedTools of [[''], ['echo', 'echo']]) {
      expect(() => ctx.agentRuntimeMcpGateway.open({
        ...openRequest,
        allowedTools,
      })).toThrow('allowlist is invalid or contains duplicates')
    }
    expect(() => ctx.agentRuntimeMcpGateway.open({
      ...openRequest,
      allowedTools: ['missing'],
    })).toThrow('names unavailable tool "missing"')
    expect(() => ctx.agentRuntimeMcpGateway.open({
      ...openRequest,
      allowedTools: ['missing-1', 'missing-2'],
    })).toThrow('names unavailable tools "missing-1", "missing-2"')
  })

  it('uses distinct credentials and rejects unknown routes, wrong tokens, and methods', async () => {
    const { ctx, openRequest } = await setup({ allowedTools: ['echo'] })
    const first = ctx.agentRuntimeMcpGateway.open(openRequest)
    const second = ctx.agentRuntimeMcpGateway.open(openRequest)
    expect(first.connection.url).not.toBe(second.connection.url)
    expect(first.connection.token).not.toBe(second.connection.token)

    await expect(rawRequest(`${new URL(first.connection.url).origin}/unknown`, {
      token: first.connection.token,
    })).resolves.toMatchObject({ status: 404 })
    await expect(rawRequest(first.connection.url, { token: 'short' })).resolves.toMatchObject({ status: 401 })
    await expect(rawRequest(first.connection.url, {
      token: 'x'.repeat(first.connection.token.length),
    })).resolves.toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
    })
    await expect(rawRequest(first.connection.url, {
      method: 'GET',
      token: first.connection.token,
    })).resolves.toMatchObject({
      status: 405,
      headers: { allow: 'POST' },
    })
  })

  it('rejects malformed and oversized request bodies', async () => {
    const declared = await setup({ allowedTools: ['echo'], config: { maxRequestBytes: 8 } })
    const declaredHandle = declared.ctx.agentRuntimeMcpGateway.open(declared.openRequest)
    await expect(rawRequest(declaredHandle.connection.url, {
      token: declaredHandle.connection.token,
      contentLength: 9,
    })).resolves.toMatchObject({ status: 413 })

    const streamed = await setup({ allowedTools: ['echo'], config: { maxRequestBytes: 8 } })
    const streamedHandle = streamed.ctx.agentRuntimeMcpGateway.open(streamed.openRequest)
    await expect(rawRequest(streamedHandle.connection.url, {
      token: streamedHandle.connection.token,
      chunks: ['{"json"', ':"too large"}'],
    })).resolves.toMatchObject({ status: 413 })

    const malformed = await setup({ allowedTools: ['echo'] })
    const malformedHandle = malformed.ctx.agentRuntimeMcpGateway.open(malformed.openRequest)
    await expect(rawRequest(malformedHandle.connection.url, {
      token: malformedHandle.connection.token,
      body: '{',
    })).resolves.toMatchObject({ status: 400 })
  })

  it.each(['none', 'ended', 'settled'] as const)(
    'requires an active runtime submission when state is %s',
    async (active) => {
      const { ctx, openRequest } = await setup({ active, allowedTools: ['echo'] })
      const handle = ctx.agentRuntimeMcpGateway.open(openRequest)
      await expect(rpc(handle.connection.url, handle.connection.token, 'tools/call', {
        name: 'echo',
        arguments: { value: 'x' },
      })).resolves.toMatchObject({
        body: { error: { code: -32600 } },
      })
    },
  )

  it('rechecks tool visibility for discovery and execution', async () => {
    const { ctx, openRequest, unregisterEcho } = await setup({ allowedTools: ['echo'] })
    const handle = ctx.agentRuntimeMcpGateway.open(openRequest)
    unregisterEcho()
    await expect(rpc(handle.connection.url, handle.connection.token, 'tools/list')).resolves.toMatchObject({
      body: { result: { tools: [] } },
    })
    await expect(rpc(handle.connection.url, handle.connection.token, 'tools/call', {
      name: 'echo',
    })).resolves.toMatchObject({
      body: { error: { code: -32602 } },
    })
  })

  it('projects failures and every supported content form without an attachment service', async () => {
    const { ctx, session, openRequest } = await setup({ allowedTools: ['fail', 'mixed'] })
    const handle = ctx.agentRuntimeMcpGateway.open(openRequest)
    await expect(rpc(handle.connection.url, handle.connection.token, 'tools/call', {
      name: 'fail',
    })).resolves.toMatchObject({
      body: {
        result: {
          isError: true,
        },
      },
    })
    await expect(rpc(handle.connection.url, handle.connection.token, 'tools/call', {
      name: 'mixed',
    })).resolves.toMatchObject({
      body: {
        result: {
          content: [
            { type: 'text', text: 'thought' },
            { type: 'text', text: '[image result unavailable: attachment service is not mounted]' },
            { type: 'text' },
          ],
        },
      },
    })
    expect(session.events.at(-3)).toMatchObject({
      type: 'agent/runtime/tool-result',
      data: { error: { name: 'HarnessError', code: 'DENIED' } },
    })
  })

  it('projects stored images and bounds oversized responses', async () => {
    const image = await setup({ attachments: true, allowedTools: ['mixed'] })
    const imageHandle = image.ctx.agentRuntimeMcpGateway.open(image.openRequest)
    await expect(rpc(imageHandle.connection.url, imageHandle.connection.token, 'tools/call', {
      name: 'mixed',
    })).resolves.toMatchObject({
      body: {
        result: {
          content: [
            { type: 'text', text: 'thought' },
            { type: 'image', data: 'AQID', mimeType: 'image/png' },
            { type: 'text' },
          ],
        },
      },
    })

    const bounded = await setup({
      allowedTools: ['echo'],
      config: { port: 0, maxRequestBytes: 1_024, maxResponseBytes: 32 },
    })
    const boundedHandle = bounded.ctx.agentRuntimeMcpGateway.open(bounded.openRequest)
    const oversized = await rpc(boundedHandle.connection.url, boundedHandle.connection.token, 'tools/call', {
      name: 'echo',
      arguments: { value: 'x'.repeat(100) },
    })
    expect(oversized.body).toMatchObject({ result: { isError: true } })
    expect(JSON.stringify(oversized.body)).toContain('exceeds the configured 32-byte')
  })

  it('returns and audits a bounded error when attachment projection fails', async () => {
    const value = await setup({ attachments: true, allowedTools: ['mixed'] })
    value.ctx.attachments.readImage = () => Promise.reject(new Error('storage offline'))
    const handle = value.ctx.agentRuntimeMcpGateway.open(value.openRequest)
    await expect(rpc(handle.connection.url, handle.connection.token, 'tools/call', {
      name: 'mixed',
    })).resolves.toMatchObject({
      body: {
        result: {
          content: [{ type: 'text', text: 'Error: Harness tool result projection failed' }],
          isError: true,
        },
      },
    })
    expect(value.session.events.at(-1)).toMatchObject({
      type: 'agent/runtime/tool-result',
      data: { isError: true },
    })
  })

  it('makes handle and service disposal idempotent and rejects later opens', async () => {
    const { ctx, openRequest } = await setup({ allowedTools: ['echo'] })
    const gateway = ctx.agentRuntimeMcpGateway
    const disposedHandle = gateway.open(openRequest)
    await disposedHandle.dispose()
    await disposedHandle.dispose()
    const serviceOwnedHandle = gateway.open(openRequest)
    await ctx.fiber.dispose()
    await serviceOwnedHandle.dispose()
    expect(() => gateway.open(openRequest)).toThrow('runtime MCP gateway is stopping')
  })

  it('uses constructor defaults and contains listener errors after startup', async () => {
    const detached = new AgentRuntimeMcpGateway(new Context())
    expect(detached).toBeInstanceOf(AgentRuntimeMcpGateway)

    const { ctx } = await setup({ allowedTools: [] })
    const gateway = ctx.agentRuntimeMcpGateway as unknown as {
      server: { emit(name: string, error: Error): void }
    }
    expect(() => {
      gateway.server.emit('error', new Error('listener failure'))
    }).not.toThrow()
  })

  it('revokes an endpoint while its request body is still arriving', async () => {
    const { ctx, openRequest } = await setup({ allowedTools: ['echo'] })
    const handle = ctx.agentRuntimeMcpGateway.open(openRequest)
    const target = new URL(handle.connection.url)
    const response = new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${handle.connection.token}`,
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      }, (incoming) => {
        incoming.resume()
        incoming.on('end', () => { resolve(incoming.statusCode ?? 0) })
      })
      request.on('error', reject)
      request.write('{"jsonrpc":"2.0",')
      setTimeout(() => {
        void handle.dispose().then(() => {
          request.end('"id":1,"method":"tools/list"}')
        })
      }, 10)
    })
    await expect(response).resolves.toBe(404)
  })

  it('cancels an active ToolRuntime call and waits for quiescence on dispose', async () => {
    const { ctx, session, agent, openRequest } = await setup({ allowedTools: [] })
    let settled = false
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    ctx.tools.register({
      name: 'slow',
      description: 'Wait for cancellation.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(_args, exec) {
        started()
        await new Promise<void>((resolve) => {
          exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        settled = true
        return 'settled'
      },
    })
    const handle = ctx.agentRuntimeMcpGateway.open({
      ...openRequest,
      agent,
      allowedTools: ['slow'],
    })
    const call = rpc(handle.connection.url, handle.connection.token, 'tools/call', { name: 'slow' })
    await began
    await handle.dispose()
    expect(settled).toBe(true)
    await expect(call).resolves.toMatchObject({
      body: { result: { isError: true } },
    })
    expect(session.events.at(-1)?.type).toBe('agent/runtime/tool-result')
  })
})
