/**
 * Codex App Server 0.147.0 runtime Provider.
 *
 * @module @deepseek-ai/dsh-agent-runtime-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AgentRuntimeError,
  AgentRuntimeProviderId,
  ExternalSessionId,
  snapshotAgentRuntimeCapabilities,
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
import type { RuntimeDriverLaunch } from '@deepseek-ai/dsh-agent-runtime-launcher'
import {
  MCP_RUNTIME_GATEWAY_TOKEN_ENV,
  type RuntimeMcpGatewayHandle,
} from '@deepseek-ai/dsh-mcp-runtime-gateway'
import {
  CodexAppServerWire,
  type CodexPermissionMode,
} from '@deepseek-ai/dsh-subagent-codex'

export const name = 'agent-runtime-codex'
export const inject = ['agentRuntimes', 'agentRuntimeLauncher']

const CODEX_PROVIDER_ID = AgentRuntimeProviderId('codex-app-server')
const CODEX_PROTOCOL_VERSION = '0.147.0'
const CODEX_CAPABILITIES: AgentRuntimeCapabilities = snapshotAgentRuntimeCapabilities([{
  id: 'runtimeActivity',
  metadata: { fidelity: 'complete', kinds: ['turn'] },
}])
const CODEX_MCP_CAPABILITIES: AgentRuntimeCapabilities = snapshotAgentRuntimeCapabilities([
  ...CODEX_CAPABILITIES,
  { id: 'harnessTools', metadata: { transport: 'mcp' } },
])
const DEFAULT_MAX_FRAME_BYTES = 1_048_576
type CodexLaunchHandle = Awaited<ReturnType<Context['agentRuntimeLauncher']['launch']>>
type CodexCancelCause = Parameters<PreparedAgentRuntime['cancel']>[1]

/** Codex Driver-owned launch controls. */
export const CODEX_APP_SERVER_DRIVER: RuntimeDriverLaunch = {
  arguments: [{
    name: 'codex-app-server',
    forms: ['app-server', '--stdio'],
    argv: ['app-server', '--stdio'],
  }],
  environment: {},
  reservedEnvironment: [],
  credentialEnvironment: [],
  runtimeSecretEnvironment: [],
  allowWindowsCommandScript: false,
  permissionEnforcement: 'full',
}

function driverWithGateway(gateway: RuntimeMcpGatewayHandle | undefined): RuntimeDriverLaunch {
  if (gateway === undefined) {
    return {
      ...CODEX_APP_SERVER_DRIVER,
      reservedEnvironment: [],
      runtimeSecretEnvironment: [],
    }
  }
  const { url, tokenEnvironment } = gateway.connection
  return {
    ...CODEX_APP_SERVER_DRIVER,
    reservedEnvironment: [MCP_RUNTIME_GATEWAY_TOKEN_ENV],
    runtimeSecretEnvironment: [MCP_RUNTIME_GATEWAY_TOKEN_ENV],
    arguments: [
      ...CODEX_APP_SERVER_DRIVER.arguments,
      {
        name: 'harness-mcp-server',
        forms: ['mcp_servers.deepseek_harness'],
        argv: [
          '-c',
          `mcp_servers.deepseek_harness.url=${JSON.stringify(url)}`,
          '-c',
          `mcp_servers.deepseek_harness.bearer_token_env_var=${JSON.stringify(tokenEnvironment)}`,
        ],
      },
    ],
  }
}

/** Launcher-independent Codex protocol limits. */
export interface Config {
  /** Maximum UTF-8 bytes accepted for one JSONL frame from Codex. */
  maxFrameBytes: number
}

export const Config: z<Config> = z.object({
  maxFrameBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FRAME_BYTES),
})

function permissionMode(value: unknown): CodexPermissionMode {
  if (value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).sandbox === 'workspace-write') {
    return 'never'
  }
  throw new AgentRuntimeError({
    code: 'PROFILE_INVALID',
    phase: 'profile',
    message: 'Codex App Server requires the workspace-write unattended permission policy',
    providerId: CODEX_PROVIDER_ID,
  })
}

function sessionCwd(request: AgentRuntimePrepareRequest): string {
  const agent = request.agentCtx.agent
  const cwd = agent?.session.header.cwd
  if (agent === undefined || agent.id !== request.sessionId || cwd === undefined) {
    throw new AgentRuntimeError({
      code: 'RUNTIME_INCOMPATIBLE',
      phase: 'prepare',
      message: 'Codex App Server requires the matching unpublished Agent and a session workspace',
      providerId: CODEX_PROVIDER_ID,
    })
  }
  return cwd
}

function textInput(request: AgentRuntimeSubmissionRequest): string[] {
  const texts: string[] = []
  for (const block of request.message.content) {
    if (block.type !== 'text') {
      throw new AgentRuntimeError({
        code: 'SUBMISSION_REJECTED',
        phase: 'submission',
        message: 'Codex App Server accepts text-only user input',
        providerId: CODEX_PROVIDER_ID,
      })
    }
    texts.push(block.text)
  }
  if (texts.length === 0 || texts.every(text => text.trim().length === 0)) {
    throw new AgentRuntimeError({
      code: 'SUBMISSION_REJECTED',
      phase: 'submission',
      message: 'Codex App Server requires non-empty user input',
      providerId: CODEX_PROVIDER_ID,
    })
  }
  return texts
}

function closeProtocolInput(launch: CodexLaunchHandle, wire: CodexAppServerWire): void {
  wire.close()
  launch.process.stdin?.end()
}

class CodexPreparedRuntime implements PreparedAgentRuntime {
  readonly capabilities: AgentRuntimeCapabilities
  readonly initialFacts
  private active: {
    readonly submissionId: SubmissionId
    readonly outputRedactor: ReturnType<CodexLaunchHandle['redactStream']>
  } | undefined
  private cancellation: { readonly submissionId: SubmissionId; readonly cause: CodexCancelCause } | undefined

  constructor(
    readonly runtimeId: AgentRuntimePrepareRequest['runtimeId'],
    private readonly request: AgentRuntimePrepareRequest,
    private readonly launch: CodexLaunchHandle,
    private readonly wire: CodexAppServerWire,
    private readonly gateway: RuntimeMcpGatewayHandle | undefined,
    capabilities: AgentRuntimeCapabilities,
  ) {
    this.capabilities = capabilities
    this.initialFacts = snapshotAgentRuntimeFacts({
      runtimeId,
      providerId: CODEX_PROVIDER_ID,
      capabilities,
      phase: 'ready',
      product: { value: 'Codex', source: 'protocol' },
      productVersion: { value: CODEX_PROTOCOL_VERSION, source: 'profile' },
      protocol: { value: 'codex-app-server', source: 'profile' },
      protocolVersion: { value: CODEX_PROTOCOL_VERSION, source: 'profile' },
      externalSessionId: ExternalSessionId(wire.externalSessionId()),
    })
  }

  async submit(request: AgentRuntimeSubmissionRequest): Promise<AgentRuntimeSubmissionResult> {
    if (this.active !== undefined) {
      throw new AgentRuntimeError({
        code: 'AGENT_BUSY',
        phase: 'submission',
        message: 'Codex App Server already has a running submission',
        providerId: CODEX_PROVIDER_ID,
      })
    }
    const texts = textInput(request)
    const active = {
      submissionId: request.submissionId,
      outputRedactor: this.launch.redactStream(),
    }
    this.active = active
    this.cancellation = undefined
    try {
      const result = await this.launch.runTurn(async (signal) => {
        return this.wire.runTurn(texts, AbortSignal.any([signal, request.signal]))
      }, {
        cancel: () => { this.wire.interrupt() },
        closeInput: () => { closeProtocolInput(this.launch, this.wire) },
      })
      this.flushOutput(active)
      this.request.sink.assistantMessage(request.submissionId, {
        content: this.launch.redact(result.output),
      })
      return { reason: result.stopReason === 'completed' ? { kind: 'completed' } : { kind: 'interrupted' } }
    } catch (error: unknown) {
      try {
        await this.dispose()
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], 'Codex submission and cleanup failed')
      }
      const cancellation = this.cancellationCause(request.submissionId)
      if (cancellation !== undefined) {
        return { reason: { kind: 'aborted', reason: cancellation } }
      }
      throw error
    } finally {
      this.flushOutput(active)
      this.active = undefined
      this.cancellation = undefined
    }
  }

  assistantDelta(delta: string): void {
    const active = this.active
    if (active === undefined) return
    const text = active.outputRedactor.write(delta)
    if (text.length > 0) {
      this.request.sink.assistantChunk(active.submissionId, { kind: 'text-delta', text })
    }
  }

  private flushOutput(active: NonNullable<CodexPreparedRuntime['active']>): void {
    const text = active.outputRedactor.end()
    if (text.length > 0) {
      this.request.sink.assistantChunk(active.submissionId, { kind: 'text-delta', text })
    }
  }

  cancel(submissionId: SubmissionId, cause: CodexCancelCause): void {
    if (submissionId !== this.active?.submissionId) return
    this.cancellation = { submissionId, cause }
    this.wire.interrupt()
  }

  private cancellationCause(submissionId: SubmissionId): CodexCancelCause | undefined {
    const cancellation = this.cancellation
    return cancellation?.submissionId === submissionId ? cancellation.cause : undefined
  }

  async dispose(): Promise<void> {
    let launchError: unknown
    try {
      await this.launch.dispose({
        cancel: () => { this.wire.interrupt() },
        closeInput: () => { closeProtocolInput(this.launch, this.wire) },
      })
    } catch (error: unknown) {
      launchError = error
    }
    try {
      await this.gateway?.dispose()
    } catch (gatewayError: unknown) {
      if (launchError !== undefined) {
        throw new AggregateError([launchError, gatewayError], 'Codex runtime and MCP gateway cleanup failed')
      }
      throw gatewayError
    }
    if (launchError !== undefined) {
      throw launchError instanceof Error
        ? launchError
        : new Error('Codex runtime cleanup failed', { cause: launchError })
    }
  }
}

class CodexAppServerProvider implements AgentRuntimeProvider {
  readonly id = CODEX_PROVIDER_ID
  readonly profileSnapshotVersions = [1]

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    return Promise.resolve().then(() => {
      permissionMode(request.profile.permissions.policy)
      return {
        capabilities: request.profile.harnessTools.transport === 'mcp'
          ? CODEX_MCP_CAPABILITIES
          : CODEX_CAPABILITIES,
        permissionEnforcement: 'enforced',
        productVersion: CODEX_PROTOCOL_VERSION,
        protocolVersion: CODEX_PROTOCOL_VERSION,
      }
    })
  }

  async prepare(request: AgentRuntimePrepareRequest): Promise<PreparedAgentRuntime> {
    if (request.kind === 'resume') {
      throw new AgentRuntimeError({
        code: 'RESUME_UNSUPPORTED',
        phase: 'resume',
        message: 'Codex App Server runtime does not support resume',
        providerId: CODEX_PROVIDER_ID,
      })
    }
    const mode = permissionMode(request.profile.permissions.policy)
    const cwd = sessionCwd(request)
    let active: SubmissionId | undefined
    const agent = request.agentCtx.agent as NonNullable<typeof request.agentCtx.agent>
    const gatewayService = this.ctx.get('agentRuntimeMcpGateway')
    if (request.profile.harnessTools.transport === 'mcp' && gatewayService === undefined) {
      throw new AgentRuntimeError({
        code: 'RUNTIME_UNAVAILABLE',
        phase: 'prepare',
        message: 'Codex App Server requires the Harness MCP runtime gateway',
        providerId: CODEX_PROVIDER_ID,
      })
    }
    const gateway = request.profile.harnessTools.transport === 'mcp'
      ? gatewayService?.open({
        agent,
        runtimeId: request.runtimeId,
        providerId: CODEX_PROVIDER_ID,
        allowedTools: request.profile.harnessTools.allowed,
        signal: request.signal,
      })
      : undefined
    let launch: CodexLaunchHandle
    try {
      launch = await this.ctx.agentRuntimeLauncher.launch({
        profile: request.profile,
        cwd,
        driver: driverWithGateway(gateway),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        signal: request.signal,
        ...gateway === undefined ? {} : {
          runtimeSecrets: {
            [gateway.connection.tokenEnvironment]: gateway.connection.token,
          },
        },
      })
    } catch (error: unknown) {
      await gateway?.dispose()
      throw error
    }
    const prepared: { runtime?: CodexPreparedRuntime } = {}
    const wire = new CodexAppServerWire(
      launch.process.stdout as NonNullable<typeof launch.process.stdout>,
      launch.process.stdin as NonNullable<typeof launch.process.stdin>,
      mode,
      (delta) => { prepared.runtime?.assistantDelta(delta) },
      { approvalPolicy: 'never', sandbox: 'workspace-write' },
      { maxFrameBytes: this.config.maxFrameBytes },
      (activity) => {
        request.sink.activity({
          runtimeId: request.runtimeId,
          submissionId: active as SubmissionId,
          fidelity: 'complete',
          ...activity,
        })
      },
    )
    wire.start()
    await launch.waitUntilReady(
      (async () => {
        await wire.initialize(request.signal)
        await wire.startThread(cwd, request.signal)
      })(),
      {
        cancel: () => { wire.interrupt() },
        closeInput: () => { closeProtocolInput(launch, wire) },
      },
    )
    const runtime = new CodexPreparedRuntime(
      request.runtimeId,
      request,
      launch,
      wire,
      gateway,
      gateway === undefined ? CODEX_CAPABILITIES : CODEX_MCP_CAPABILITIES,
    )
    prepared.runtime = runtime
    const submit = runtime.submit.bind(runtime)
    runtime.submit = async (submission) => {
      active = submission.submissionId
      try {
        return await submit(submission)
      } finally {
        active = undefined
      }
    }
    return runtime
  }
}

/** Register the Codex App Server runtime Provider. */
export function apply(ctx: Context, _config: Config): void {
  ctx.agentRuntimes.registerProvider(new CodexAppServerProvider(ctx, _config))
}
