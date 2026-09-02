/**
 * Secure launcher shared by external Agent Runtime Providers.
 *
 * @module @deepseek-ai/dsh-agent-runtime-launcher
 */

import { delimiter, extname, isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AgentRuntimeError,
} from '@deepseek-ai/dsh-agent-runtime'
import type { AgentRuntimeErrorCode, RuntimeProfileSnapshot } from '@deepseek-ai/dsh-agent-runtime'
import type { ResolvedRuntimeCredentials } from '@deepseek-ai/dsh-agent-runtime-profile'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { KnownValueRedactor } from './redactor.ts'
import { RuntimeTemporaryMaterialOwner } from './temporary.ts'
import type { RuntimeTemporaryMaterial } from './temporary.ts'
import type {
  AgentRuntimeLaunchHandle,
  AgentRuntimeLaunchRequest,
  RuntimeDriverLaunch,
  RuntimeProtocolShutdown,
  RuntimeReservedArgument,
  RuntimeTurnOperation,
} from './types.ts'
import {
  assertSupportedWindowsExecutable,
  isWindowsCommandScript,
  windowsCommandScriptArgv,
} from './windows.ts'

export { KnownValueRedactor, KnownValueStreamRedactor } from './redactor.ts'
export { RuntimeTemporaryMaterialOwner } from './temporary.ts'
export type { RuntimeTemporaryMaterial } from './temporary.ts'
export {
  assertSupportedWindowsExecutable,
  isWindowsCommandScript,
  windowsCommandScriptArgv,
} from './windows.ts'
export type {
  AgentRuntimeLaunchHandle,
  AgentRuntimeLaunchRequest,
  RuntimeDriverLaunch,
  RuntimeProtocolShutdown,
  RuntimeReservedArgument,
  RuntimeTemporaryFile,
  RuntimeTurnOperation,
} from './types.ts'

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const WINDOWS_COMMAND_EXTENSIONS = '.COM;.EXE;.BAT;.CMD'
const WINDOWS_NATIVE_EXTENSIONS = '.COM;.EXE'

/** Launcher-owned configuration. */
export interface Config {
  /** Installation-owned root for crash-recoverable temporary launch material. */
  temporaryRoot?: string
}

interface ResolvedConfig extends Config {
  temporaryRoot: string
}

interface LauncherInternals {
  platform?: NodeJS.Platform
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimeLauncher: AgentRuntimeLauncher
  }
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason })
}

function securityError(message: string, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError({
    code: 'SECURITY_POLICY_UNSATISFIED',
    phase: 'prepare',
    message,
  }, cause === undefined ? undefined : { cause })
}

function runtimeError(
  code: AgentRuntimeErrorCode,
  message: string,
  redactor: KnownValueRedactor,
  cause: unknown,
): AgentRuntimeError {
  return new AgentRuntimeError({
    code,
    phase: code === 'DISPOSE_FAILED' ? 'dispose' : code === 'TURN_TIMEOUT' ? 'turn' : 'prepare',
    message: redactor.redact(message),
  }, { cause: redactor.redact(cause) })
}

function environmentKey(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name
}

function assertEnvironmentName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw securityError(`agent runtime environment name is invalid: ${JSON.stringify(name)}`)
  }
}

function setEnvironment(
  target: Map<string, readonly [source: string, name: string, value: string]>,
  name: string,
  value: string,
  source: string,
  platform: NodeJS.Platform,
): void {
  assertEnvironmentName(name)
  if (value.includes('\0')) throw securityError(`agent runtime ${source} environment value contains NUL`)
  const key = environmentKey(name, platform)
  const prior = target.get(key)
  if (prior !== undefined) {
    throw securityError(
      `agent runtime environment key ${JSON.stringify(name)} is assigned by both ${prior[0]} and ${source}`,
    )
  }
  target.set(key, [source, name, value])
}

function validateReservedArguments(profile: RuntimeProfileSnapshot, controls: readonly RuntimeReservedArgument[]): string[] {
  const names = new Set<string>()
  const forms = new Set<string>()
  const injected: string[] = []
  for (const control of controls) {
    if (control.name.length === 0 || names.has(control.name) || control.forms.length === 0) {
      throw securityError('agent runtime Driver has invalid or duplicate reserved argument declarations')
    }
    names.add(control.name)
    for (const form of control.forms) {
      if (form.length === 0 || forms.has(form)) {
        throw securityError('agent runtime Driver has invalid or duplicate reserved argument forms')
      }
      forms.add(form)
    }
    if (control.argv.length === 0) {
      throw securityError(`agent runtime Driver reserved argument "${control.name}" has no injection`)
    }
    injected.push(...control.argv)
  }
  for (const argument of profile.launch.args) {
    for (const form of forms) {
      if (argument === form || argument.startsWith(`${form}=`)) {
        throw securityError(`Runtime Profile "${profile.profileId}" attempts to set reserved argument "${form}"`)
      }
    }
  }
  return injected
}

function requiredWindowsEnvironment(name: 'SystemRoot' | 'ComSpec'): string {
  const value = Object.entries(process.env)
    .find(([candidate]) => candidate.toUpperCase() === name.toUpperCase())?.[1]
  if (value === undefined || value.length === 0) {
    throw securityError(`agent runtime launcher requires Windows environment entry "${name}"`)
  }
  return value
}

/**
 * Build one exact child environment from the permitted launch sources.
 * @param ctx - context carrying the immutable launch-environment snapshot.
 * @param profile - non-secret profile literals and ambient allowlist.
 * @param driver - trusted reserved targets and required values.
 * @param credentials - freshly resolved credential target values.
 * @param platform - target environment-key semantics.
 * @returns the complete child environment.
 */
export function buildRuntimeEnvironment(
  ctx: Context,
  profile: RuntimeProfileSnapshot,
  driver: RuntimeDriverLaunch,
  credentials: ResolvedRuntimeCredentials,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const reserved = new Set<string>()
  for (const name of driver.reservedEnvironment) {
    assertEnvironmentName(name)
    const key = environmentKey(name, platform)
    if (reserved.has(key)) throw securityError(`agent runtime Driver repeats reserved environment key "${name}"`)
    reserved.add(key)
  }
  const credentialTargets = new Set<string>()
  for (const name of driver.credentialEnvironment) {
    const key = environmentKey(name, platform)
    if (!reserved.has(key)) {
      throw securityError(`agent runtime credential target "${name}" is not reserved by the Driver`)
    }
    if (credentialTargets.has(key)) {
      throw securityError(`agent runtime Driver repeats credential target "${name}"`)
    }
    credentialTargets.add(key)
  }

  const environment = new Map<string, readonly [source: string, name: string, value: string]>()
  if (platform === 'win32') {
    setEnvironment(environment, 'SystemRoot', requiredWindowsEnvironment('SystemRoot'), 'launcher', platform)
    setEnvironment(environment, 'ComSpec', requiredWindowsEnvironment('ComSpec'), 'launcher', platform)
    setEnvironment(environment, 'PATHEXT', driver.allowWindowsCommandScript
      ? WINDOWS_COMMAND_EXTENSIONS
      : WINDOWS_NATIVE_EXTENSIONS, 'launcher', platform)
  }

  const launchEnvironment = launchEnvironmentOf(ctx)
  for (const name of profile.launch.ambientEnv) {
    assertEnvironmentName(name)
    const key = environmentKey(name, platform)
    if (SENSITIVE_ENV_PATTERN.test(name)) {
      throw securityError(`Runtime Profile "${profile.profileId}" allowlists credential-shaped ambient key "${name}"`)
    }
    if (reserved.has(key)) {
      throw securityError(`Runtime Profile "${profile.profileId}" allowlists reserved environment key "${name}"`)
    }
    const entry = launchEnvironment.getFrom(name, ['process'])
    if (entry !== undefined) setEnvironment(environment, name, entry.value, 'ambient allowlist', platform)
  }

  for (const [name, value] of Object.entries(profile.launch.env)) {
    if (reserved.has(environmentKey(name, platform))) {
      throw securityError(`Runtime Profile "${profile.profileId}" sets reserved environment key "${name}"`)
    }
    setEnvironment(environment, name, value, 'profile', platform)
  }

  for (const [name, value] of Object.entries(driver.environment)) {
    if (!reserved.has(environmentKey(name, platform))) {
      throw securityError(`agent runtime Driver environment key "${name}" is not declared reserved`)
    }
    if (credentialTargets.has(environmentKey(name, platform))) {
      throw securityError(`agent runtime Driver writes credential environment key "${name}"`)
    }
    setEnvironment(environment, name, value, 'Driver', platform)
  }

  for (const [name, value] of Object.entries(credentials)) {
    if (!credentialTargets.has(environmentKey(name, platform))) {
      throw securityError(`Runtime Profile credential target "${name}" is not declared by the Driver`)
    }
    setEnvironment(environment, name, value, 'credential', platform)
  }

  return Object.fromEntries([...environment.values()].map(([, name, value]) => [name, value]))
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason, 'agent runtime operation was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(asError(signal.reason, 'agent runtime operation was cancelled'))
    }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(asError(error, 'agent runtime operation failed')) },
    )
  })
}

class SecureRuntimeLaunchHandle implements AgentRuntimeLaunchHandle {
  readonly temporaryPaths: Readonly<Record<string, string>>
  private readonly startupDeadline
  private readonly lifecycle = new AbortController()
  private disposal: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private ready = false

  constructor(
    readonly process: SubprocessHandle,
    private readonly profile: RuntimeProfileSnapshot,
    private readonly callerSignal: AbortSignal,
    private readonly redactor: KnownValueRedactor,
    private readonly temporary: RuntimeTemporaryMaterial,
  ) {
    this.temporaryPaths = temporary.paths
    this.startupDeadline = deadline(
      AbortSignal.any([callerSignal, this.lifecycle.signal]),
      profile.deadlines.startupMs,
      'AGENT_RUNTIME_START',
    )
  }

  redact<T>(value: T): T {
    return this.redactor.redact(value)
  }

  async waitUntilReady(readiness: Promise<void>, shutdown?: RuntimeProtocolShutdown): Promise<void> {
    if (this.ready) throw new Error('agent runtime launch readiness was already settled')
    try {
      await waitWithSignal(readiness, this.startupDeadline.signal)
      this.ready = true
    } catch (error: unknown) {
      const timedOut = timeoutOf(this.startupDeadline.signal, 'AGENT_RUNTIME_START')
      let cleanupFailure: unknown
      try {
        await this.stop(shutdown, asError(error, 'agent runtime startup was cancelled'))
      } catch (cleanupError: unknown) {
        cleanupFailure = cleanupError
      }
      if (timedOut !== undefined) {
        throw runtimeError(
          'START_TIMEOUT',
          `agent runtime startup exceeded ${timedOut.timeoutMs}ms`,
          this.redactor,
          cleanupFailure ?? error,
        )
      }
      if (cleanupFailure !== undefined) {
        throw runtimeError(
          'DISPOSE_FAILED',
          'agent runtime startup rollback failed',
          this.redactor,
          new AggregateError([error, cleanupFailure]),
        )
      }
      throw asError(error, 'agent runtime startup was cancelled')
    } finally {
      this.startupDeadline[Symbol.dispose]()
    }
  }

  async runTurn<T>(operation: RuntimeTurnOperation<T>, shutdown?: RuntimeProtocolShutdown): Promise<T> {
    if (!this.ready) throw new Error('agent runtime launch is not ready')
    using turnDeadline = deadline(
      AbortSignal.any([this.callerSignal, this.lifecycle.signal]),
      this.profile.deadlines.turnMs,
      'AGENT_RUNTIME_TURN',
    )
    try {
      return await waitWithSignal(operation(turnDeadline.signal), turnDeadline.signal)
    } catch (error: unknown) {
      const timedOut = timeoutOf(turnDeadline.signal, 'AGENT_RUNTIME_TURN')
      if (!turnDeadline.signal.aborted) throw error
      let cleanupFailure: unknown
      try {
        await this.stop(shutdown, asError(error, 'agent runtime turn was cancelled'))
      } catch (cleanupError: unknown) {
        cleanupFailure = cleanupError
      }
      if (timedOut === undefined) {
        if (cleanupFailure !== undefined) {
          throw runtimeError(
            'DISPOSE_FAILED',
            'agent runtime turn cancellation cleanup failed',
            this.redactor,
            new AggregateError([error, cleanupFailure]),
          )
        }
        throw error
      }
      throw runtimeError(
        'TURN_TIMEOUT',
        `agent runtime turn exceeded ${timedOut.timeoutMs}ms`,
        this.redactor,
        cleanupFailure ?? error,
      )
    }
  }

  dispose(shutdown?: RuntimeProtocolShutdown): Promise<void> {
    this.lifecycle.abort(new Error('agent runtime disposed'))
    this.startupDeadline[Symbol.dispose]()
    return this.disposal ??= this.stop(shutdown, new Error('agent runtime disposed'))
  }

  private async stop(shutdown: RuntimeProtocolShutdown | undefined, reason: Error): Promise<void> {
    this.stopping ??= this.stopOnce(shutdown, reason)
    await this.stopping
  }

  private async stopOnce(shutdown: RuntimeProtocolShutdown | undefined, reason: Error): Promise<void> {
    this.lifecycle.abort(reason)
    const failures: unknown[] = []
    using graceful = deadline(undefined, this.profile.deadlines.shutdownMs, 'AGENT_RUNTIME_SHUTDOWN')
    for (const action of [shutdown?.cancel, shutdown?.closeInput]) {
      if (action === undefined || graceful.signal.aborted) continue
      try {
        await waitWithSignal(Promise.resolve(action(reason)), graceful.signal)
      } catch (error: unknown) {
        if (timeoutOf(graceful.signal, 'AGENT_RUNTIME_SHUTDOWN') === undefined) failures.push(error)
      }
    }

    let quiescent = false
    try {
      quiescent = await this.process.waitForExit(graceful.signal)
    } catch (error: unknown) {
      failures.push(error)
    }
    if (!quiescent) {
      try {
        this.process.terminate()
      } catch (error: unknown) {
        failures.push(error)
      }
      using termination = deadline(undefined, this.profile.deadlines.terminationMs, 'AGENT_RUNTIME_TERMINATION')
      try {
        quiescent = await this.process.waitForExit(termination.signal)
      } catch (error: unknown) {
        failures.push(error)
      }
      if (!quiescent) failures.push(new Error('agent runtime process tree did not reach quiescence'))
    }
    if (quiescent) {
      try {
        await this.process.done
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    try {
      await this.temporary.cleanup()
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw runtimeError(
        'DISPOSE_FAILED',
        'agent runtime disposal did not complete cleanly',
        this.redactor,
        failures.length === 1 ? failures[0] : new AggregateError(failures),
      )
    }
  }
}

/** Shared secure launcher for all external Agent Runtime Providers. */
export class AgentRuntimeLauncher extends Service {
  static inject = ['subprocess', 'agentRuntimeProfiles']

  static Config: z<Config> = z.object({
    temporaryRoot: z.string().default(dshHomePath('runtime-launches')),
  })

  /** Test-only platform override. */
  internals: LauncherInternals = {}
  private readonly temporary: RuntimeTemporaryMaterialOwner
  private readonly initialization: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentRuntimeLauncher')
    const resolved = config as ResolvedConfig
    if (!isAbsolute(resolved.temporaryRoot)) {
      throw new Error('agent-runtime-launcher: temporaryRoot must be absolute')
    }
    this.temporary = new RuntimeTemporaryMaterialOwner(resolved.temporaryRoot)
    this.initialization = this.temporary.initialize()
  }

  async *[Service.init](): AsyncGenerator<void, void, void> {
    await this.initialization
  }

  /**
   * Resolve credentials, validate launch controls, create temporary material, and spawn one managed process.
   * @param request - complete profile, Driver controls, protocol stdio, and caller cancellation.
   * @returns the launch-scoped process, redactor, deadlines, and teardown owner.
   */
  async launch(request: AgentRuntimeLaunchRequest): Promise<AgentRuntimeLaunchHandle> {
    await this.initialization
    request.signal.throwIfAborted()
    const platform = this.internals.platform ?? process.platform
    const credentials = await this.ctx.agentRuntimeProfiles.resolveCredentials(request.profile)
    request.signal.throwIfAborted()
    const redactor = new KnownValueRedactor(Object.values(credentials))
    for (const [name, value] of Object.entries(request.profile.deadlines)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw securityError(`Runtime Profile "${request.profile.profileId}" deadline "${name}" is not representable`)
      }
    }
    if (request.profile.permissions.enforcement === 'required'
      && request.driver.permissionEnforcement !== 'full') {
      throw securityError(`Runtime Profile "${request.profile.profileId}" requires full permission enforcement`)
    }
    const injectedArguments = validateReservedArguments(request.profile, request.driver.arguments)
    const environment = buildRuntimeEnvironment(this.ctx, request.profile, request.driver, credentials, platform)
    const material = await this.temporary.create(request.temporaryFiles ?? [])
    try {
      let executable: string
      try {
        if (request.profile.launch.resolution.kind === 'absolute'
          && !isAbsolute(request.profile.launch.executable)) {
          throw new Error('absolute executable resolution requires an absolute configured path')
        }
        const lookupEnvironment = request.profile.launch.resolution.kind === 'search-path'
          ? {
            PATH: request.profile.launch.resolution.paths.join(delimiter),
            ...(platform === 'win32'
              ? { PATHEXT: request.driver.allowWindowsCommandScript
                ? WINDOWS_COMMAND_EXTENSIONS
                : WINDOWS_NATIVE_EXTENSIONS }
              : {}),
          }
          : undefined
        executable = await this.ctx.subprocess.resolveExecutable(
          request.profile.launch.executable,
          lookupEnvironment,
          request.signal,
        )
        executable = await this.ctx.subprocess.resolveExecutable(executable, undefined, request.signal)
      } catch (error: unknown) {
        throw runtimeError('RUNTIME_UNAVAILABLE', 'agent runtime executable could not be resolved', redactor, error)
      }

      let argv = [executable, ...request.profile.launch.args, ...injectedArguments]
      if (platform === 'win32') {
        try {
          assertSupportedWindowsExecutable(executable)
          if (isWindowsCommandScript(executable)) {
            if (!request.driver.allowWindowsCommandScript) {
              throw new Error('the Driver does not allow Windows command scripts')
            }
            const resolvedComspec = await this.ctx.subprocess.resolveExecutable(
              requiredWindowsEnvironment('ComSpec'),
              undefined,
              request.signal,
            )
            argv = [...windowsCommandScriptArgv(resolvedComspec, executable, argv.slice(1))]
          }
        } catch (error: unknown) {
          throw securityError('agent runtime Windows executable policy was not satisfied', error)
        }
      } else if (extname(executable).toLowerCase() === '.cmd' || extname(executable).toLowerCase() === '.bat') {
        throw securityError('Windows command scripts cannot run on this platform')
      }

      request.signal.throwIfAborted()
      const processHandle = this.ctx.subprocess.spawn({
        argv,
        cwd: request.cwd,
        stdio: request.stdio,
        graceMs: request.profile.deadlines.terminationMs,
        signal: request.signal,
        envMode: 'exact',
        env: environment,
      })
      return new SecureRuntimeLaunchHandle(
        processHandle,
        request.profile,
        request.signal,
        redactor,
        material,
      )
    } catch (error: unknown) {
      try {
        await material.cleanup()
      } catch (cleanupError: unknown) {
        throw runtimeError(
          'DISPOSE_FAILED',
          'agent runtime launch rollback failed',
          redactor,
          new AggregateError([error, cleanupError]),
        )
      }
      throw error
    }
  }
}

export default AgentRuntimeLauncher
