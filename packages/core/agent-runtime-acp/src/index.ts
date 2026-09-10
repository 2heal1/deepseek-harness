/**
 * ACP protocol-v1 one-shot runtime Provider.
 *
 * @module @deepseek-ai/dsh-agent-runtime-acp
 */

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type ContentBlock as AcpContentBlock,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentRuntimeError,
  AgentRuntimeProviderId,
  ExternalSessionId,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeCapabilities,
  AgentRuntimePrepareRequest,
  AgentRuntimeProbeRequest,
  AgentRuntimeProbeResult,
  AgentRuntimeProvider,
  AgentRuntimeSubmissionRequest,
  AgentRuntimeSubmissionResult,
  PreparedAgentRuntime,
  SubmissionId,
} from '@deepseek-ai/dsh-agent-runtime'
import type {
  AgentRuntimeLaunchHandle,
  AgentRuntimeLaunchRequest,
  RuntimeDriverLaunch,
  RuntimeProtocolShutdown,
} from '@deepseek-ai/dsh-agent-runtime-launcher'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { AcpTransportError, acpNdJsonStream } from './transport.ts'

export const name = 'agent-runtime-acp'
export const inject = ['agentRuntimes', 'agentRuntimeLauncher']

const ACP_PROVIDER_ID = AgentRuntimeProviderId('acp')
const ACP_PROTOCOL_NAME = 'acp'
const ACP_PROTOCOL_VERSION = String(PROTOCOL_VERSION)
const ACP_SDK_VERSION = '0.25.1'
const ACP_CAPABILITIES: AgentRuntimeCapabilities = []
const DEFAULT_MAX_FRAME_BYTES = 1_048_576
const DEFAULT_MAX_OUTPUT_BYTES = 4_194_304
const DEFAULT_MAX_STDERR_BYTES = 65_536

type ActiveSubmission = {
  readonly id: SubmissionId
  readonly sessionId: string
  readonly output: string[]
  outputBytes: number
  readonly failure: PromiseWithResolvers<never>
  prompt?: Promise<PromptResponse>
  cancelRequest?: Promise<void>
  cancelCause?: AgentCancelCause
  failed: boolean
  settled: boolean
}

/** Trusted launch declaration for the illustrative `acp-agent-cli`. */
export const ACP_AGENT_CLI_DRIVER: RuntimeDriverLaunch = {
  arguments: [{
    name: 'acp-stdio',
    forms: ['acp', 'serve'],
    argv: ['acp', 'serve'],
  }],
  environment: {},
  reservedEnvironment: [],
  credentialEnvironment: [],
  allowWindowsCommandScript: false,
  permissionEnforcement: 'none',
}

/** ACP protocol limits independent of the shared process Launcher. */
export interface Config {
  /** Maximum UTF-8 bytes accepted for one JSONL frame from the ACP agent. */
  maxFrameBytes: number
  /** Maximum cumulative UTF-8 bytes accepted for one assistant result. */
  maxOutputBytes: number
  /** Maximum diagnostic bytes drained from ACP stderr. */
  maxStderrBytes: number
}

export const Config: z<Config> = z.object({
  maxFrameBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FRAME_BYTES),
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  maxStderrBytes: z.number().step(1).min(1).default(DEFAULT_MAX_STDERR_BYTES),
})

function providerError(
  phase: 'prepare' | 'submission' | 'turn',
  message: string,
  cause?: unknown,
): AgentRuntimeError {
  return new AgentRuntimeError({
    code: phase === 'submission' ? 'SUBMISSION_REJECTED' : 'RUNTIME_FAILED',
    phase,
    message,
    providerId: ACP_PROVIDER_ID,
  }, cause === undefined ? undefined : { cause })
}

function permissionPolicy(value: unknown): void {
  if (value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).sandbox === 'workspace-write') {
    return
  }
  throw new AgentRuntimeError({
    code: 'PROFILE_INVALID',
    phase: 'profile',
    message: 'ACP runtime requires the workspace-write unattended permission policy',
    providerId: ACP_PROVIDER_ID,
  })
}

function sessionCwd(request: AgentRuntimePrepareRequest): string {
  const agent: Agent | undefined = request.agentCtx.agent
  const cwd = agent?.session.header.cwd
  if (agent === undefined || agent.id !== request.sessionId || cwd === undefined) {
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'prepare',
      message: 'ACP runtime requires the matching unpublished Agent and a session workspace',
      providerId: ACP_PROVIDER_ID,
    })
  }
  return cwd
}

function promptBlocks(request: AgentRuntimeSubmissionRequest): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  for (const block of request.message.content) {
    if (block.type !== 'text') {
      throw providerError('submission', 'ACP runtime accepts text-only user input')
    }
    blocks.push({ type: 'text', text: block.text })
  }
  if (blocks.length === 0 || blocks.every(block => block.type === 'text' && block.text.trim().length === 0)) {
    throw providerError('submission', 'ACP runtime requires non-empty user input')
  }
  return blocks
}

function stopReason(reason: StopReason): TurnEndReason {
  switch (reason) {
    case 'end_turn':
      return { kind: 'completed' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'blocked' }
    case 'cancelled':
      return { kind: 'interrupted' }
    case 'max_turn_requests':
      throw providerError('turn', 'ACP agent exhausted its turn-request budget')
  }
}

function closeProtocolInput(launch: AgentRuntimeLaunchHandle): void {
  launch.process.stdin?.end()
}

class AcpPreparedRuntime implements PreparedAgentRuntime {
  readonly capabilities = ACP_CAPABILITIES
  readonly initialFacts
  private active: ActiveSubmission | undefined
  private consumed = false
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    readonly runtimeId: AgentRuntimePrepareRequest['runtimeId'],
    private readonly request: AgentRuntimePrepareRequest,
    private readonly launch: AgentRuntimeLaunchHandle,
    private readonly connection: ClientSideConnection,
    sessionId: string,
    product: { readonly name: string; readonly version: string } | undefined,
    private readonly maxOutputBytes: number,
    private readonly onDisposed: () => void,
  ) {
    this.initialFacts = snapshotAgentRuntimeFacts({
      runtimeId,
      providerId: ACP_PROVIDER_ID,
      capabilities: ACP_CAPABILITIES,
      phase: 'ready',
      ...(product === undefined ? {} : {
        product: { value: product.name, source: 'protocol' as const },
        productVersion: { value: product.version, source: 'protocol' as const },
      }),
      protocol: { value: ACP_PROTOCOL_NAME, source: 'profile' },
      protocolVersion: { value: ACP_PROTOCOL_VERSION, source: 'protocol' },
      externalSessionId: ExternalSessionId(sessionId),
    })
  }

  sessionUpdate(params: SessionNotification): Promise<void> {
    const active = this.active
    const update = params.update
    if (active === undefined || active.failed || update.sessionUpdate !== 'agent_message_chunk') {
      return Promise.resolve()
    }
    if (params.sessionId !== active.sessionId || update.content.type !== 'text') {
      active.failed = true
      active.failure.reject(providerError('turn', 'ACP agent emitted unsupported assistant output'))
      return Promise.resolve()
    }
    try {
      const outputBytes = Buffer.byteLength(update.content.text)
      if (active.outputBytes + outputBytes > this.maxOutputBytes) {
        active.failed = true
        active.failure.reject(providerError(
          'turn',
          `ACP assistant output exceeds ${this.maxOutputBytes} UTF-8 bytes`,
        ))
        return Promise.resolve()
      }
      active.outputBytes += outputBytes
      active.output.push(update.content.text)
      this.request.sink.assistantChunk(active.id, {
        kind: 'text-delta',
        text: update.content.text,
      })
    } catch (error: unknown) {
      active.failed = true
      active.failure.reject(error)
    }
    return Promise.resolve()
  }

  async submit(request: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult> {
    if (this.disposed || this.consumed) {
      throw providerError('submission', 'ACP runtime accepts exactly one submission')
    }
    const prompt = promptBlocks(request)
    this.consumed = true
    const active: ActiveSubmission = {
      id: request.submissionId,
      sessionId: this.initialFacts.externalSessionId as string,
      output: [],
      outputBytes: 0,
      failure: Promise.withResolvers<never>(),
      failed: false,
      settled: false,
    }
    this.active = active
    const shutdown = this.shutdownHooks(active)
    const onAbort = (): void => {
      this.cancel(
        request.submissionId,
        request.signal.reason as AgentCancelCause,
      )
    }
    let outcome: { readonly response: PromptResponse } | { readonly failure: unknown }
    if (request.signal.aborted) {
      onAbort()
      outcome = { failure: request.signal.reason }
    } else {
      request.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await this.launch.runTurn(() => {
          const pending = this.connection.prompt({
            sessionId: active.sessionId,
            prompt,
          })
          active.prompt = pending
          void pending.finally(() => { active.settled = true }).catch(() => {})
          return Promise.race([pending, active.failure.promise])
        }, shutdown)
        outcome = { response }
      } catch (error: unknown) {
        outcome = { failure: error }
      }
    }

    let cleanupFailure: unknown
    const cleanup = await Promise.allSettled([this.dispose(), this.connection.closed])
    for (const result of cleanup) {
      if (result.status === 'rejected') cleanupFailure ??= result.reason as unknown
    }

    if (active.output.length > 0) {
      const content: ContentBlock[] = [{ type: 'text', text: active.output.join('') }]
      try {
        this.request.sink.assistantMessage(request.submissionId, { content })
      } catch (error: unknown) {
        outcome = 'failure' in outcome
          ? { failure: new AggregateError([outcome.failure, error]) }
          : { failure: error }
      }
    }

    request.signal.removeEventListener('abort', onAbort)
    this.active = undefined
    this.disposed = true

    if ('failure' in outcome) {
      if (active.cancelCause !== undefined) {
        return { reason: { kind: 'aborted', reason: active.cancelCause } }
      }
      if (outcome.failure instanceof AgentRuntimeError) throw outcome.failure
      if (outcome.failure instanceof AcpTransportError) {
        throw providerError('turn', outcome.failure.message, outcome.failure)
      }
      throw providerError('turn', 'ACP submission failed', this.launch.redact(outcome.failure))
    }
    if (active.cancelCause !== undefined) {
      return { reason: { kind: 'aborted', reason: active.cancelCause } }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure as Error
    return { reason: stopReason(outcome.response.stopReason) }
  }

  cancel(submissionId: SubmissionId, cause: AgentCancelCause): void {
    const active = this.active
    if (active === undefined || active.id !== submissionId) return
    active.cancelCause ??= cause
    if (!active.settled) void this.dispose().catch(() => {})
  }

  dispose(): Promise<void> {
    this.disposed = true
    return this.disposal ??= this.disposeOnce()
  }

  private shutdownHooks(active: ActiveSubmission): RuntimeProtocolShutdown {
    return {
      cancel: async () => {
        if (active.settled || active.prompt === undefined) return
        /* v8 ignore next -- best-effort notification may race an already closed ACP connection. */
        active.cancelRequest ??= this.connection.cancel({ sessionId: active.sessionId }).catch(() => {})
        await active.cancelRequest
        await active.prompt.catch(() => {})
      },
      closeInput: () => { closeProtocolInput(this.launch) },
    }
  }

  private async disposeOnce(): Promise<void> {
    try {
      await this.launch.dispose(this.active === undefined ? {
        closeInput: () => { closeProtocolInput(this.launch) },
      } : this.shutdownHooks(this.active))
    } finally {
      this.onDisposed()
    }
  }
}

class AcpRuntimeProvider implements AgentRuntimeProvider {
  readonly id = ACP_PROVIDER_ID
  readonly profileSnapshotVersions = [0]
  private readonly handles = new Set<AcpPreparedRuntime>()
  private readonly preparations = new Set<Promise<void>>()
  private readonly preparationFailures: unknown[] = []
  private stopping = false

  constructor(
    private readonly config: Config,
    private readonly launchRuntime: (
      request: AgentRuntimeLaunchRequest,
    ) => Promise<AgentRuntimeLaunchHandle>,
  ) {}

  probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    return Promise.resolve().then(() => {
      this.assertSelectable('probe')
      request.signal.throwIfAborted()
      permissionPolicy(request.profile.permissions.policy)
      return {
        capabilities: ACP_CAPABILITIES,
        permissionEnforcement: 'unsupported',
        protocolVersion: ACP_PROTOCOL_VERSION,
        details: { sdkVersion: ACP_SDK_VERSION },
      }
    })
  }

  prepare(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    this.assertSelectable('prepare')
    const preparation = this.prepareOnce(request)
    const settlement = preparation.then(
      () => {},
      (error: unknown) => {
        if (this.stopping
          && !(error instanceof AgentRuntimeError && error.failure.code === 'RUNTIME_UNAVAILABLE')) {
          this.preparationFailures.push(error)
        }
      },
    ).finally(() => { this.preparations.delete(settlement) })
    this.preparations.add(settlement)
    return preparation
  }

  private async prepareOnce(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    if (request.kind === 'resume') {
      throw new AgentRuntimeError({
        code: 'RESUME_UNSUPPORTED',
        phase: 'resume',
        message: 'ACP one-shot runtime does not support resume',
        providerId: ACP_PROVIDER_ID,
      })
    }
    permissionPolicy(request.profile.permissions.policy)
    const cwd = sessionCwd(request)
    const launch = await this.launchRuntime({
      profile: request.profile,
      cwd,
      driver: ACP_AGENT_CLI_DRIVER,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: this.config.maxStderrBytes },
      },
      signal: request.signal,
    })
    const runtimeRef: { current?: AcpPreparedRuntime } = {}
    const connection = new ClientSideConnection(
      (_agent: AcpAgent): Client => ({
        sessionUpdate(params): Promise<void> {
          return runtimeRef.current?.sessionUpdate(params) ?? Promise.resolve()
        },
        requestPermission(): Promise<RequestPermissionResponse> {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        },
      }),
      acpNdJsonStream(
        launch.process.stdin as NonNullable<typeof launch.process.stdin>,
        launch.process.stdout as NonNullable<typeof launch.process.stdout>,
        this.config.maxFrameBytes,
      ),
    )

    try {
      let initialized: InitializeResponse | undefined
      let session: NewSessionResponse | undefined
      await launch.waitUntilReady((async () => {
        initialized = await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new AgentRuntimeError({
            code: 'RUNTIME_INCOMPATIBLE',
            phase: 'prepare',
            message: `ACP agent negotiated unsupported protocol version ${initialized.protocolVersion}`,
            providerId: ACP_PROVIDER_ID,
          })
        }
        session = await connection.newSession({ cwd, mcpServers: [] })
        if (session.sessionId.length === 0) {
          throw providerError('prepare', 'ACP agent returned an empty session id')
        }
      })(), {
        closeInput: () => { closeProtocolInput(launch) },
      })
      // The readiness operation cannot resolve without assigning both values.
      /* v8 ignore next 3 */
      if (initialized === undefined || session === undefined) {
        throw new Error('unreachable: ACP readiness completed without session facts')
      }
      const product = initialized.agentInfo === undefined || initialized.agentInfo === null
        ? undefined
        : {
          name: initialized.agentInfo.name,
          version: initialized.agentInfo.version,
        }
      const runtime = new AcpPreparedRuntime(
        request.runtimeId,
        request,
        launch,
        connection,
        session.sessionId,
        product,
        this.config.maxOutputBytes,
        () => { this.handles.delete(runtime) },
      )
      runtimeRef.current = runtime
      if (this.stopping) {
        await runtime.dispose()
        this.assertSelectable('prepare')
      }
      this.handles.add(runtime)
      return runtime
    } catch (error: unknown) {
      if (error instanceof AgentRuntimeError) throw error
      throw providerError('prepare', 'ACP initialization failed', launch.redact(error))
    }
  }

  async drain(): Promise<void> {
    this.stopping = true
    await Promise.all([...this.preparations])
    const results = await Promise.allSettled([...this.handles].map(handle => handle.dispose()))
    const failures = this.preparationFailures.splice(0)
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'ACP runtime Provider failed to drain prepared handles')
    }
  }

  private assertSelectable(phase: 'probe' | 'prepare'): void {
    if (!this.stopping) return
    throw new AgentRuntimeError({
      code: 'RUNTIME_UNAVAILABLE',
      phase,
      message: 'ACP runtime Provider is stopping',
      providerId: ACP_PROVIDER_ID,
    })
  }
}

/**
 * Register the ACP protocol-v1 one-shot runtime Provider.
 * @param ctx - context carrying the runtime registry and secure launcher.
 * @param _config - validated ACP transport limits.
 * @returns nothing.
 */
export function apply(ctx: Context, _config: Config): void {
  const provider = new AcpRuntimeProvider(
    _config,
    request => ctx.agentRuntimeLauncher.launch(request),
  )
  ctx.effect(function* () {
    const unregister = ctx.agentRuntimes.registerProvider(provider)
    yield unregister
    yield async () => {
      let failure: unknown
      try {
        await provider.drain()
      } catch (error: unknown) {
        failure = error
      }
      unregister()
      if (failure !== undefined) throw failure as Error
    }
  }, 'agentRuntimeAcp.provider()')
}
