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
  allowWindowsCommandScript: false,
  permissionEnforcement: 'full',
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
  readonly capabilities = CODEX_CAPABILITIES
  readonly initialFacts
  private active: SubmissionId | undefined
  private cancellation: { readonly submissionId: SubmissionId; readonly cause: CodexCancelCause } | undefined

  constructor(
    readonly runtimeId: AgentRuntimePrepareRequest['runtimeId'],
    private readonly request: AgentRuntimePrepareRequest,
    private readonly launch: CodexLaunchHandle,
    private readonly wire: CodexAppServerWire,
  ) {
    this.initialFacts = snapshotAgentRuntimeFacts({
      runtimeId,
      providerId: CODEX_PROVIDER_ID,
      capabilities: CODEX_CAPABILITIES,
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
    this.active = request.submissionId
    this.cancellation = undefined
    try {
      const result = await this.launch.runTurn(async (signal) => {
        return this.wire.runTurn(texts, AbortSignal.any([signal, request.signal]))
      }, {
        cancel: () => { this.wire.interrupt() },
        closeInput: () => { closeProtocolInput(this.launch, this.wire) },
      })
      this.request.sink.assistantMessage(request.submissionId, { content: result.output })
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
      this.active = undefined
      this.cancellation = undefined
    }
  }

  cancel(submissionId: SubmissionId, cause: CodexCancelCause): void {
    if (submissionId !== this.active) return
    this.cancellation = { submissionId, cause }
    this.wire.interrupt()
  }

  private cancellationCause(submissionId: SubmissionId): CodexCancelCause | undefined {
    const cancellation = this.cancellation
    return cancellation?.submissionId === submissionId ? cancellation.cause : undefined
  }

  async dispose(): Promise<void> {
    await this.launch.dispose({
      cancel: () => { this.wire.interrupt() },
      closeInput: () => { closeProtocolInput(this.launch, this.wire) },
    })
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
        capabilities: CODEX_CAPABILITIES,
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
    const launch = await this.ctx.agentRuntimeLauncher.launch({
      profile: request.profile,
      cwd,
      driver: CODEX_APP_SERVER_DRIVER,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      signal: request.signal,
    })
    const wire = new CodexAppServerWire(
      launch.process.stdout as NonNullable<typeof launch.process.stdout>,
      launch.process.stdin as NonNullable<typeof launch.process.stdin>,
      mode,
      (delta) => {
        if (active !== undefined) {
          request.sink.assistantChunk(active, { kind: 'text-delta', text: delta })
        }
      },
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
    const runtime = new CodexPreparedRuntime(request.runtimeId, request, launch, wire)
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
