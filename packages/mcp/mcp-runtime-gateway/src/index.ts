/**
 * Session-owned Streamable HTTP MCP gateway for external Agent Runtimes.
 *
 * @module @deepseek-ai/dsh-mcp-runtime-gateway
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeError,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
} from '@deepseek-ai/dsh-agent-runtime'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'mcp-runtime-gateway'
export const inject = ['tools']

/** Environment target read by a runtime for its per-session gateway bearer token. */
export const MCP_RUNTIME_GATEWAY_TOKEN_ENV = 'DSH_HARNESS_MCP_TOKEN'

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304

/** Gateway listener and payload limits. */
export interface Config {
  /** Loopback port; zero asks the operating system to select one. */
  port?: number
  /** Maximum JSON request body size. */
  maxRequestBytes?: number
  /** Maximum JSON tool response size. */
  maxResponseBytes?: number
}

interface ResolvedConfig {
  readonly port: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
}

/** Inputs that bind one gateway to one unpublished or live Agent runtime. */
export interface RuntimeMcpGatewayOpenRequest {
  /** Agent whose scope, Session, workspace policy, and delegation depth authorize calls. */
  readonly agent: Agent
  /** Runtime identity owning the endpoint. */
  readonly runtimeId: AgentRuntimeId
  /** Provider identity owning the runtime. */
  readonly providerId: AgentRuntimeProviderId
  /** Exact profile-pinned Harness tool allowlist. */
  readonly allowedTools: readonly string[]
  /** Cancels endpoint creation before ownership transfers to the returned handle. */
  readonly signal: AbortSignal
}

/** Secret-bearing connection material for one runtime-owned MCP endpoint. */
export interface RuntimeMcpGatewayConnection {
  /** Loopback-only Streamable HTTP endpoint. */
  readonly url: string
  /** Environment name from which the external runtime reads the bearer token. */
  readonly tokenEnvironment: typeof MCP_RUNTIME_GATEWAY_TOKEN_ENV
  /** Launch-scoped bearer token; never persist or log this value. */
  readonly token: string
}

/** One session-owned gateway registration and its quiescent teardown. */
export interface RuntimeMcpGatewayHandle {
  /** Connection material passed only to the selected trusted Provider. */
  readonly connection: RuntimeMcpGatewayConnection
  /** Revoke the endpoint, cancel active calls, and await their settlement. */
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimeMcpGateway: AgentRuntimeMcpGateway
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Authorized Harness tool execution accepted from one runtime-owned MCP endpoint. */
    'agent/runtime/tool-call': {
      readonly runtimeId: AgentRuntimeId
      readonly providerId: AgentRuntimeProviderId
      readonly submissionId: SubmissionId
      readonly turn: number
      readonly callId: CallId
      readonly name: string
      readonly arguments: JsonValue
    }
    /** MCP response returned for a prior runtime-owned Harness tool execution. */
    'agent/runtime/tool-result': {
      readonly runtimeId: AgentRuntimeId
      readonly providerId: AgentRuntimeProviderId
      readonly submissionId: SubmissionId
      readonly turn: number
      readonly callId: CallId
      readonly content: JsonValue[]
      readonly isError: boolean
      readonly error?: { readonly name: string; readonly code: string }
    }
  }
}

interface ActiveSubmission {
  readonly id: SubmissionId
  readonly turn: number
}

type GatewayContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

function runtimeError(message: string, providerId: AgentRuntimeProviderId): AgentRuntimeError {
  return new AgentRuntimeError({
    code: 'SECURITY_POLICY_UNSATISFIED',
    phase: 'prepare',
    message,
    providerId,
  })
}

function activeSubmission(agent: Agent): ActiveSubmission | undefined {
  let openTurn: number | undefined
  const started = new Map<SubmissionId, number>()
  for (const event of agent.session.events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        break
      case 'turn/end':
        openTurn = undefined
        break
      case 'agent/submission/started':
        started.set(event.data.submissionId, event.data.turn)
        break
      case 'agent/submission/settled':
        started.delete(event.data.submissionId)
        break
      default:
        break
    }
  }
  if (openTurn === undefined) return
  const active = [...started].find(([, turn]) => turn === openTurn)
  return active === undefined ? undefined : { id: active[0], turn: active[1] }
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const supplied = Buffer.from(header)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function jsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32_000, message },
    id: null,
  }))
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    throw new RangeError('MCP request body exceeds the configured byte limit')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array)
    bytes += value.byteLength
    if (bytes > limit) throw new RangeError('MCP request body exceeds the configured byte limit')
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function fallbackContent(block: ContentBlock): GatewayContent {
  return {
    type: 'text',
    text: block.type === 'reasoning'
      ? block.text
      : JSON.stringify(block),
  }
}

async function projectContent(
  ctx: Context,
  blocks: readonly ContentBlock[],
  signal: AbortSignal,
): Promise<GatewayContent[]> {
  const projected: GatewayContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      projected.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const attachments: AttachmentStore | undefined = ctx.get('attachments')
      if (attachments === undefined) {
        projected.push({ type: 'text', text: '[image result unavailable: attachment service is not mounted]' })
        continue
      }
      const stored = await attachments.readImage(block.attachment, signal)
      projected.push({
        type: 'image',
        data: Buffer.from(stored.data).toString('base64'),
        mimeType: stored.ref.mediaType,
      })
      continue
    }
    projected.push(fallbackContent(block))
  }
  return projected
}

function boundedResult(result: CallToolResult, maxBytes: number): CallToolResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) return result
  return {
    content: [{
      type: 'text',
      text: `Error: Harness tool response exceeds the configured ${maxBytes}-byte MCP limit`,
    }],
    isError: true,
  }
}

class GatewaySession {
  private open = true
  private readonly abort = new AbortController()
  private readonly active = new Set<Promise<void>>()

  constructor(
    private readonly ctx: Context,
    private readonly request: RuntimeMcpGatewayOpenRequest,
    readonly path: string,
    readonly token: string,
    private readonly maxResponseBytes: number,
  ) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    if (!this.open) {
      jsonError(response, 404, 'MCP gateway endpoint is not available')
      return
    }
    const operation = this.handleRequest(request, response, body)
    this.active.add(operation)
    try {
      await operation
    } finally {
      this.active.delete(operation)
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = new McpServer(
      { name: 'deepseek-harness-runtime', version: '0.0.1' },
      { capabilities: { tools: {} } },
    )
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools(),
    }))
    server.server.setRequestHandler(CallToolRequestSchema, async (call, extra) => (
      this.call(call.params.name, call.params.arguments ?? {}, extra.signal)
    ))
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    try {
      await server.connect(transport as Transport)
      await transport.handleRequest(request, response, body)
    } finally {
      await server.close()
    }
  }

  private tools(): Tool[] {
    this.assertOpen()
    const visible = new Map(
      this.ctx.tools.schemas(this.request.agent).map(schema => [schema.name, schema]),
    )
    return this.request.allowedTools.flatMap((name) => {
      const schema = visible.get(name)
      return schema === undefined
        ? []
        : [{
          name: schema.name,
          description: schema.description,
          inputSchema: schema.parameters as Tool['inputSchema'],
        }]
    })
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    requestSignal: AbortSignal,
  ): Promise<CallToolResult> {
    this.assertOpen()
    if (!this.request.allowedTools.includes(name)
      || this.ctx.tools.get(name, this.request.agent) === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Harness tool "${name}" is not authorized`)
    }
    const submission = activeSubmission(this.request.agent)
    if (submission === undefined) {
      throw new McpError(ErrorCode.InvalidRequest, 'Harness tools require an active runtime submission')
    }
    const callId = CallId(`runtime-mcp-${randomUUID()}`)
    this.request.agent.session.append('agent/runtime/tool-call', {
      runtimeId: this.request.runtimeId,
      providerId: this.request.providerId,
      submissionId: submission.id,
      turn: submission.turn,
      callId,
      name,
      arguments: args as JsonValue,
    })
    const signal = AbortSignal.any([requestSignal, this.abort.signal])
    const result = await this.ctx.tools.execute({
      callId,
      name,
      arguments: args,
      agent: this.request.agent,
      signal,
    })
    let response: CallToolResult
    try {
      response = boundedResult({
        content: await projectContent(this.ctx, result.content, signal),
        ...result.isError ? { isError: true } : {},
      }, this.maxResponseBytes)
    } catch {
      response = {
        content: [{ type: 'text', text: 'Error: Harness tool result projection failed' }],
        isError: true,
      }
    }
    this.appendResult(submission, callId, result, response)
    return response
  }

  private appendResult(
    submission: ActiveSubmission,
    callId: CallId,
    result: ToolExecutionResult,
    response: CallToolResult,
  ): void {
    this.request.agent.session.append('agent/runtime/tool-result', {
      runtimeId: this.request.runtimeId,
      providerId: this.request.providerId,
      submissionId: submission.id,
      turn: submission.turn,
      callId,
      content: response.content as JsonValue[],
      isError: response.isError === true,
      ...result.error?.info === undefined ? {} : { error: result.error.info },
    })
  }

  async dispose(): Promise<void> {
    if (!this.open) {
      await Promise.all([...this.active])
      return
    }
    this.open = false
    this.abort.abort(new Error('runtime MCP gateway disposed'))
    await Promise.all([...this.active])
  }

  private assertOpen(): void {
    /* v8 ignore next -- handle() rejects a closed session before the SDK can dispatch its registered handlers. */
    if (!this.open) throw new McpError(ErrorCode.InvalidRequest, 'Harness MCP gateway is closed')
  }
}

/** Loopback listener and registry for per-runtime MCP endpoints. */
export class AgentRuntimeMcpGateway extends Service {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    port: z.natural().max(65_535).default(0),
    maxRequestBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: z.natural().min(1).default(DEFAULT_MAX_RESPONSE_BYTES),
  })

  private readonly config: ResolvedConfig
  private readonly sessions = new Map<string, GatewaySession>()
  private server!: HttpServer
  private port!: number
  private closing = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentRuntimeMcpGateway')
    this.config = {
      port: config.port ?? 0,
      maxRequestBytes: config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    }
  }

  async [Service.init](): Promise<void> {
    this.server = createServer((request, response) => {
      this.route(request, response).catch((error: unknown) => {
        // All owned request paths throw Error subclasses; retain a safe fallback for SDK exceptions.
        this.ctx.logger.warn(error instanceof Error ? error : /* v8 ignore next */ new Error(String(error)))
        /* v8 ignore if -- only a socket failure after the MCP SDK starts its response can reach this state. */
        if (response.headersSent) {
          response.destroy()
          return
        }
        jsonError(
          response,
          error instanceof RangeError ? 413 : 400,
          error instanceof RangeError ? error.message : 'Invalid MCP gateway request',
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, LOOPBACK_HOST, () => {
        this.server.off('error', reject)
        this.server.on('error', (error) => { this.ctx.logger.error(error) })
        this.port = (this.server.address() as AddressInfo).port
        resolve()
      })
    })
    this.ctx.effect(() => async () => {
      this.closing = true
      await Promise.all([...this.sessions.values()].map(session => session.dispose()))
      this.sessions.clear()
      await new Promise<void>((resolve) => {
        this.server.close(() => { resolve() })
        this.server.closeAllConnections()
      })
    }, 'agentRuntimeMcpGateway.listen')
  }

  /**
   * Register one exact per-runtime endpoint.
   * @param request - runtime, Agent, allowlist, and startup ownership.
   * @returns secret connection material and quiescent revocation.
   */
  open(request: RuntimeMcpGatewayOpenRequest): RuntimeMcpGatewayHandle {
    request.signal.throwIfAborted()
    if (this.closing) throw runtimeError('runtime MCP gateway is stopping', request.providerId)
    if (request.agent.id !== request.agent.session.id) {
      throw runtimeError('runtime MCP gateway requires matching Agent and Session identities', request.providerId)
    }
    const allowed = new Set<string>()
    for (const tool of request.allowedTools) {
      if (tool.length === 0 || allowed.has(tool)) {
        throw runtimeError('runtime MCP gateway tool allowlist is invalid or contains duplicates', request.providerId)
      }
      allowed.add(tool)
    }
    const visible = new Set(this.ctx.tools.schemas(request.agent).map(schema => schema.name))
    const missing = [...allowed].filter(tool => !visible.has(tool))
    if (missing.length > 0) {
      throw runtimeError(
        `runtime MCP gateway allowlist names unavailable tool${missing.length === 1 ? '' : 's'} ${missing.map(tool => JSON.stringify(tool)).join(', ')}`,
        request.providerId,
      )
    }
    const path = `/mcp/runtime/${randomUUID()}`
    const token = randomBytes(32).toString('base64url')
    const session = new GatewaySession(
      this.ctx,
      { ...request, allowedTools: Object.freeze([...allowed]) },
      path,
      token,
      this.config.maxResponseBytes,
    )
    this.sessions.set(path, session)
    let disposal: Promise<void> | undefined
    return Object.freeze({
      connection: Object.freeze({
        url: `http://${LOOPBACK_HOST}:${this.port}${path}`,
        tokenEnvironment: MCP_RUNTIME_GATEWAY_TOKEN_ENV,
        token,
      }),
      dispose: () => disposal ??= this.disposeSession(path, session),
    })
  }

  private async disposeSession(path: string, session: GatewaySession): Promise<void> {
    this.sessions.delete(path)
    await session.dispose()
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = request.url
    /* v8 ignore next 2 -- Node supplies a URL for every parsed server request. */
    if (requestUrl === undefined) throw new TypeError('HTTP request URL is unavailable')
    const path = new URL(requestUrl, `http://${LOOPBACK_HOST}`).pathname
    const session = this.sessions.get(path)
    if (session === undefined) {
      jsonError(response, 404, 'MCP gateway endpoint not found')
      return
    }
    if (!authorized(request.headers.authorization, session.token)) {
      response.setHeader('www-authenticate', 'Bearer')
      jsonError(response, 401, 'MCP gateway authorization failed')
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      jsonError(response, 405, 'MCP gateway accepts POST only')
      return
    }
    const body = await readJsonBody(request, this.config.maxRequestBytes)
    await session.handle(request, response, body)
  }
}

export default AgentRuntimeMcpGateway
