import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import {
  type RuntimeProfileSnapshot,
} from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeLauncher, {
  buildRuntimeEnvironment,
  type RuntimeDriverLaunch,
  type RuntimeTemporaryMaterialOwner,
} from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles, {
  type AgentRuntimeProfileSettings,
} from '@deepseek-ai/dsh-agent-runtime-profile'
import CredentialProvider, {
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'

class MemoryCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: Readonly<Record<string, string>>) {
    super(ctx)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values[ref] !== undefined, source: 'memory', writable: true })
  }

  set(): Promise<void> {
    return Promise.resolve()
  }

  unset(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 123
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly collected = {}
  private readonly outcome = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  readonly done = this.outcome.promise
  terminated = 0
  exited = false
  terminateFailure: Error | undefined
  readonly waitOutcomes: Array<boolean | Error> = []

  terminate(): void {
    this.terminated += 1
    if (this.terminateFailure !== undefined) throw this.terminateFailure
    this.exit()
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    const scripted = this.waitOutcomes.shift()
    if (scripted instanceof Error) return Promise.reject(scripted)
    if (scripted !== undefined) return Promise.resolve(scripted)
    if (this.exited) return Promise.resolve(true)
    if (signal === undefined) return this.done.then(() => true)
    if (signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve(false) }, { once: true })
    })
  }

  exit(): void {
    if (this.exited) return
    this.exited = true
    this.outcome.resolve({ exitCode: 0, signal: null })
  }

  fail(error: Error): void {
    if (this.exited) return
    this.exited = true
    this.outcome.reject(error)
  }
}

class FakeSubprocess extends SubprocessRuntime {
  readonly resolutions: Array<{ command: string; env?: Readonly<Record<string, string>> }> = []
  readonly spawns: SubprocessSpawnSpec[] = []
  readonly handles: FakeHandle[] = []
  resolution = process.execPath
  resolutionFailure: Error | undefined
  resolutionHook: (() => void) | undefined
  spawnFailure: Error | undefined

  resolveExecutable(command: string, env?: Readonly<Record<string, string>>): Promise<string> {
    this.resolutions.push({ command, ...(env === undefined ? {} : { env }) })
    this.resolutionHook?.()
    if (this.resolutionFailure !== undefined) return Promise.reject(this.resolutionFailure)
    return Promise.resolve(command.startsWith('/') ? command : this.resolution)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.spawnFailure !== undefined) throw this.spawnFailure
    this.spawns.push(spec)
    const handle = new FakeHandle()
    this.handles.push(handle)
    return handle
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('not used'))
  }
}

function settings(executable = process.execPath): AgentRuntimeProfileSettings {
  return {
    defaultMainProfile: 'main',
    profiles: {
      main: {
        provider: 'external',
        launch: {
          executable,
          args: ['serve'],
          resolution: 'absolute',
          cwdPolicy: 'session-workspace',
          ambientEnv: ['DSH_F4_ALLOWED'],
          env: { LOG_LEVEL: 'info' },
        },
        permissions: {
          policy: { sandbox: 'workspace-write' },
          enforcement: 'required',
        },
        credentials: {
          env: {
            PROVIDER_API_KEY: { credentialRef: 'RUNTIME_MAIN_KEY' },
          },
        },
        process: {
          startupTimeoutMs: 20,
          turnTimeoutMs: 20,
          shutdownTimeoutMs: 20,
          terminationTimeoutMs: 20,
          maxConcurrentRuns: 1,
        },
      },
    },
  }
}

function driver(overrides: Partial<RuntimeDriverLaunch> = {}): RuntimeDriverLaunch {
  return {
    arguments: [{
      name: 'model',
      forms: ['--model'],
      argv: ['--model', 'driver-model'],
    }],
    environment: { DSH_PROTOCOL: 'stdio' },
    reservedEnvironment: ['DSH_PROTOCOL', 'PROVIDER_API_KEY'],
    credentialEnvironment: ['PROVIDER_API_KEY'],
    allowWindowsCommandScript: false,
    permissionEnforcement: 'full',
    ...overrides,
  }
}

async function harness(profileSettings = settings()): Promise<{
  ctx: Context
  launcher: AgentRuntimeLauncher
  subprocess: FakeSubprocess
  profile: RuntimeProfileSnapshot
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-launcher-'))
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, { RUNTIME_MAIN_KEY: 'split-secret-value' })
  await ctx.plugin(AgentRuntimeProfiles, profileSettings)
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(AgentRuntimeLauncher, { temporaryRoot: root })
  return {
    ctx,
    launcher: ctx.agentRuntimeLauncher,
    subprocess: ctx.subprocess as FakeSubprocess,
    profile: ctx.agentRuntimeProfiles.resolve('main'),
    root,
  }
}

async function cleanup(ctx: Context, root: string): Promise<void> {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

function request(
  profile: RuntimeProfileSnapshot,
  launchDriver: RuntimeDriverLaunch = driver(),
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    profile,
    cwd: process.cwd(),
    driver: launchDriver,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } as const,
    signal,
  }
}

afterEach(() => {
  vi.useRealTimers()
  delete process.env.DSH_F4_ALLOWED
  delete process.env.DSH_F4_SECRET_TOKEN
})

describe('secure runtime launch', () => {
  it('builds an exact environment and injects only Driver-owned reserved arguments', async () => {
    process.env.DSH_F4_ALLOWED = 'ambient'
    process.env.DSH_F4_SECRET_TOKEN = 'must-not-leak'
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: driver(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
      temporaryFiles: [{ name: 'auth.json', content: '{"token":"temporary"}' }],
    })

    expect(subprocess.spawns[0]).toMatchObject({
      argv: [process.execPath, 'serve', '--model', 'driver-model'],
      envMode: 'exact',
      env: {
        DSH_F4_ALLOWED: 'ambient',
        LOG_LEVEL: 'info',
        DSH_PROTOCOL: 'stdio',
        PROVIDER_API_KEY: 'split-secret-value',
      },
    })
    expect(subprocess.spawns[0]!.env).not.toHaveProperty('DSH_F4_SECRET_TOKEN')
    expect(await readFile(handle.temporaryPaths['auth.json']!, 'utf8')).toBe('{"token":"temporary"}')
    if (process.platform !== 'win32') {
      expect((await stat(handle.temporaryPaths['auth.json']!)).mode & 0o777).toBe(0o600)
    }
    subprocess.handles[0]!.exit()
    await handle.waitUntilReady(Promise.resolve())
    await handle.dispose()
    await expect(stat(handle.temporaryPaths['auth.json']!)).rejects.toMatchObject({ code: 'ENOENT' })
    await cleanup(ctx, root)
  })

  it('resolves bare executables only through the profile search path and revalidates the absolute result', async () => {
    const config = settings('runtime-cli')
    config.profiles.main!.launch.resolution = { searchPath: ['/trusted/bin', '/fallback/bin'] }
    const { ctx, launcher, subprocess, profile, root } = await harness(config)
    launcher.internals.platform = 'linux'
    subprocess.resolution = '/trusted/bin/runtime-cli'
    const handle = await launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: driver(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
    })
    expect(subprocess.resolutions).toEqual([
      {
        command: 'runtime-cli',
        env: { PATH: ['/trusted/bin', '/fallback/bin'].join(delimiter) },
      },
      { command: '/trusted/bin/runtime-cli' },
    ])
    subprocess.handles[0]!.exit()
    await handle.dispose()
    await cleanup(ctx, root)
  })

  it.each([
    ['native executable', '/runtime/agent.exe', false, ['/runtime/agent.exe', 'serve', '--model', 'driver-model']],
    [
      'command script',
      '/runtime/agent.cmd',
      true,
      [
        'C:\\Windows\\System32\\cmd.exe',
        '/d',
        '/s',
        '/c',
        '""/runtime/agent.cmd" "serve" "--model" "driver-model""',
      ],
    ],
  ])('launches a Windows %s under the shared policy', async (_name, executable, allowScript, expectedArgv) => {
    const originalSystemRoot = process.env.SystemRoot
    const originalComSpec = process.env.ComSpec
    process.env.SystemRoot = 'C:\\Windows'
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const config = settings(executable)
    const { ctx, launcher, subprocess, profile, root } = await harness(config)
    launcher.internals.platform = 'win32'
    subprocess.resolution = 'C:\\Windows\\System32\\cmd.exe'
    try {
      const handle = await launcher.launch(request(profile, driver({
        allowWindowsCommandScript: allowScript,
      })))
      expect(subprocess.spawns[0]!.argv).toEqual(expectedArgv)
      expect(subprocess.spawns[0]!.env).toMatchObject({
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: allowScript ? '.COM;.EXE;.BAT;.CMD' : '.COM;.EXE',
      })
      subprocess.handles[0]!.exit()
      await handle.dispose()
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = originalSystemRoot
      if (originalComSpec === undefined) delete process.env.ComSpec
      else process.env.ComSpec = originalComSpec
      await cleanup(ctx, root)
    }
  })

  it.each([
    [false, '/runtime/agent.exe', '.COM;.EXE'],
    [true, '/runtime/agent.cmd', '.COM;.EXE;.BAT;.CMD'],
  ])('uses the Driver Windows search policy when command scripts are %s', async (
    allowScript,
    resolvedExecutable,
    expectedPathExt,
  ) => {
    const originalSystemRoot = process.env.SystemRoot
    const originalComSpec = process.env.ComSpec
    process.env.SystemRoot = 'C:\\Windows'
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const config = settings('runtime-cli')
    config.profiles.main!.launch.resolution = { searchPath: ['C:\\Runtime'] }
    const { ctx, launcher, subprocess, profile, root } = await harness(config)
    launcher.internals.platform = 'win32'
    subprocess.resolution = resolvedExecutable
    try {
      const handle = await launcher.launch(request(profile, driver({
        allowWindowsCommandScript: allowScript,
      })))
      expect(subprocess.resolutions[0]).toEqual({
        command: 'runtime-cli',
        env: {
          PATH: 'C:\\Runtime',
          PATHEXT: expectedPathExt,
        },
      })
      subprocess.handles[0]!.exit()
      await handle.dispose()
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = originalSystemRoot
      if (originalComSpec === undefined) delete process.env.ComSpec
      else process.env.ComSpec = originalComSpec
      await cleanup(ctx, root)
    }
  })

  it.each([
    ['/runtime/agent.cmd', driver(), 'executable policy was not satisfied'],
    ['/runtime/agent.ps1', driver(), 'executable policy was not satisfied'],
  ])('rejects a Windows executable outside Driver policy: %s', async (executable, launchDriver, message) => {
    const originalSystemRoot = process.env.SystemRoot
    const originalComSpec = process.env.ComSpec
    process.env.SystemRoot = 'C:\\Windows'
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const { ctx, launcher, subprocess, profile, root } = await harness(settings(executable))
    launcher.internals.platform = 'win32'
    try {
      await expect(launcher.launch(request(profile, launchDriver))).rejects.toThrow(message)
      expect(subprocess.spawns).toHaveLength(0)
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = originalSystemRoot
      if (originalComSpec === undefined) delete process.env.ComSpec
      else process.env.ComSpec = originalComSpec
      await cleanup(ctx, root)
    }
  })

  it('rejects a Windows command script on a non-Windows platform', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness(settings('/runtime/agent.bat'))
    launcher.internals.platform = 'linux'

    await expect(launcher.launch(request(profile, driver({ allowWindowsCommandScript: true }))))
      .rejects.toThrow('Windows command scripts cannot run on this platform')
    expect(subprocess.spawns).toHaveLength(0)
    await cleanup(ctx, root)
  })

  it.each([
    ['reserved profile argument', (config: AgentRuntimeProfileSettings) => {
      config.profiles.main!.launch.args!.push('--model=override')
    }, driver(), 'reserved argument'],
    ['reserved profile environment', (config: AgentRuntimeProfileSettings) => {
      config.profiles.main!.launch.env!.DSH_PROTOCOL = 'override'
    }, driver(), 'reserved environment'],
    ['credential-shaped ambient environment', (config: AgentRuntimeProfileSettings) => {
      config.profiles.main!.launch.ambientEnv!.push('DSH_F4_SECRET_TOKEN')
    }, driver(), 'credential-shaped ambient'],
    ['unenforced required permission', () => {}, driver({ permissionEnforcement: 'partial' }), 'full permission enforcement'],
  ])('rejects %s before spawn', async (_name, mutate, launchDriver, message) => {
    const config = settings()
    mutate(config)
    const { ctx, launcher, subprocess, profile, root } = await harness(config)
    await expect(launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: launchDriver,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
    })).rejects.toThrow(message)
    expect(subprocess.spawns).toHaveLength(0)
    await cleanup(ctx, root)
  })

  it.each([
    ['empty control name', driver({
      arguments: [{ name: '', forms: ['--model'], argv: ['--model', 'x'] }],
    }), 'invalid or duplicate reserved argument declarations'],
    ['duplicate control name', driver({
      arguments: [
        { name: 'model', forms: ['--model'], argv: ['--model', 'x'] },
        { name: 'model', forms: ['--other'], argv: ['--other', 'x'] },
      ],
    }), 'invalid or duplicate reserved argument declarations'],
    ['missing control forms', driver({
      arguments: [{ name: 'model', forms: [], argv: ['--model', 'x'] }],
    }), 'invalid or duplicate reserved argument declarations'],
    ['empty control form', driver({
      arguments: [{ name: 'model', forms: [''], argv: ['--model', 'x'] }],
    }), 'invalid or duplicate reserved argument forms'],
    ['duplicate control form', driver({
      arguments: [
        { name: 'model', forms: ['--model'], argv: ['--model', 'x'] },
        { name: 'other', forms: ['--model'], argv: ['--other', 'x'] },
      ],
    }), 'invalid or duplicate reserved argument forms'],
    ['missing injection', driver({
      arguments: [{ name: 'model', forms: ['--model'], argv: [] }],
    }), 'has no injection'],
  ])('rejects a Driver with %s', async (_name, launchDriver, message) => {
    const { ctx, launcher, subprocess, profile, root } = await harness()

    await expect(launcher.launch(request(profile, launchDriver))).rejects.toThrow(message)
    expect(subprocess.spawns).toHaveLength(0)
    await cleanup(ctx, root)
  })

  it('rejects an invalid deadline at the launcher boundary', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const invalid = structuredClone(profile)
    ;(invalid.deadlines as { startupMs: number }).startupMs = 0

    await expect(launcher.launch(request(invalid))).rejects.toThrow('deadline "startupMs" is not representable')
    expect(subprocess.spawns).toHaveLength(0)
    await cleanup(ctx, root)
  })

  it('rejects a relative path under absolute executable resolution', async () => {
    const config = settings('runtime-cli')
    const { ctx, launcher, subprocess, profile, root } = await harness(config)

    await expect(launcher.launch(request(profile))).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(subprocess.spawns).toHaveLength(0)
    await cleanup(ctx, root)
  })

  it('maps executable lookup failures to RUNTIME_UNAVAILABLE', async () => {
    const config = settings('runtime-cli')
    config.profiles.main!.launch.resolution = { searchPath: ['/trusted/bin'] }
    const { ctx, launcher, subprocess, profile, root } = await harness(config)
    subprocess.resolutionFailure = new Error('not found')

    await expect(launcher.launch(request(profile))).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(await readdir(root)).toEqual([])
    await cleanup(ctx, root)
  })

  it('rejects a relative temporary root while loading the service', async () => {
    const ctx = new Context()
    expect(() => new AgentRuntimeLauncher(ctx, { temporaryRoot: 'relative' }))
      .toThrow('temporaryRoot must be absolute')
    await ctx.fiber.dispose()
  })

  it('redacts complete and split credential diagnostics', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: driver(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
    })
    expect(handle.redact({
      message: 'failed with split-secret-value',
      nested: ['split-secret-value'],
    })).toEqual({
      message: 'failed with [REDACTED]',
      nested: ['[REDACTED]'],
    })
    subprocess.handles[0]!.exit()
    await handle.dispose()
    await cleanup(ctx, root)
  })

  it('requires readiness once and runs successful turns only after readiness', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))

    await expect(handle.runTurn(async () => 'early')).rejects.toThrow('is not ready')
    await handle.waitUntilReady(Promise.resolve())
    await expect(handle.runTurn(async signal => signal.aborted ? 'aborted' : 'complete'))
      .resolves.toBe('complete')
    await expect(handle.waitUntilReady(Promise.resolve())).rejects.toThrow('already settled')
    subprocess.handles[0]!.exit()
    await handle.dispose()
    await cleanup(ctx, root)
  })

  it('rolls back startup and wraps a non-Error cancellation reason', async () => {
    const controller = new AbortController()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile, driver(), controller.signal))
    subprocess.handles[0]!.exit()
    const readiness = handle.waitUntilReady(new Promise(() => {}))
    controller.abort('startup rejected')

    await expect(readiness).rejects.toThrow('agent runtime operation was cancelled')
    await cleanup(ctx, root)
  })

  it('returns an ordinary turn rejection without terminating the runtime', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    await handle.waitUntilReady(Promise.resolve())
    const failure = new Error('provider rejected turn')

    await expect(handle.runTurn(async () => { throw failure })).rejects.toBe(failure)
    expect(subprocess.handles[0]!.terminated).toBe(0)
    subprocess.handles[0]!.exit()
    await handle.dispose()
    await cleanup(ctx, root)
  })

  it('caller cancellation during a turn terminates and joins the process tree', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile, driver(), controller.signal))
    await handle.waitUntilReady(Promise.resolve())
    const failure = new Error('caller cancelled')
    const pending = handle.runTurn(() => new Promise(() => {}))
    controller.abort(failure)
    await vi.runAllTimersAsync()

    await expect(pending).rejects.toBe(failure)
    expect(subprocess.handles[0]!.terminated).toBe(1)
    await handle.dispose()
    await cleanup(ctx, root)
  })

  it('dispose interrupts startup and shares one teardown with the readiness waiter', async () => {
    vi.useFakeTimers()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    const readiness = handle.waitUntilReady(new Promise(() => {}))
    const first = handle.dispose()
    const second = handle.dispose()
    expect(second).toBe(first)
    await vi.runAllTimersAsync()

    await expect(first).resolves.toBeUndefined()
    await expect(readiness).rejects.toThrow('agent runtime disposed')
    expect(subprocess.handles[0]!.terminated).toBe(1)
    await cleanup(ctx, root)
  })

  it('turn timeout terminates and joins the process tree before rejecting', async () => {
    vi.useFakeTimers()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: driver(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
    })
    await handle.waitUntilReady(Promise.resolve())
    const pending = handle.runTurn(() => new Promise(() => {}))
    await vi.runAllTimersAsync()
    await expect(pending).rejects.toMatchObject({ code: 'TURN_TIMEOUT' })
    expect(subprocess.handles[0]!.terminated).toBe(1)
    await handle.dispose()
    await cleanup(ctx, root)
  })

  it('continues joining and cleaning after terminate throws', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      ...request(profile),
      temporaryFiles: [{ name: 'auth', content: 'secret' }],
    })
    const processHandle = subprocess.handles[0]!
    processHandle.waitOutcomes.push(false, false)
    processHandle.terminateFailure = new Error('terminate failed')

    await expect(handle.dispose()).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
    })
    await expect(stat(handle.temporaryPaths.auth!)).rejects.toMatchObject({ code: 'ENOENT' })
    await cleanup(ctx, root)
  })

  it('aggregates process probe and outcome failures while still cleaning', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      ...request(profile),
      temporaryFiles: [{ name: 'auth', content: 'secret' }],
    })
    const processHandle = subprocess.handles[0]!
    processHandle.waitOutcomes.push(new Error('probe failed'), true)
    processHandle.fail(new Error('process failed'))

    await expect(handle.dispose()).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
    })
    await expect(stat(handle.temporaryPaths.auth!)).rejects.toMatchObject({ code: 'ENOENT' })
    await cleanup(ctx, root)
  })

  it('reports cleanup failure after the process reaches quiescence', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      ...request(profile),
      temporaryFiles: [{ name: 'auth', content: 'secret' }],
    })
    const directory = dirname(handle.temporaryPaths.auth!)
    const retained = `${directory}-old`
    await rename(directory, retained)
    await writeFile(directory, 'replacement')
    subprocess.handles[0]!.exit()

    await expect(handle.dispose()).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
    })
    await rm(directory)
    await rename(retained, directory)
    await rm(directory, { recursive: true })
    await cleanup(ctx, root)
  })

  it('records protocol shutdown failures without skipping process cleanup', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    subprocess.handles[0]!.exit()

    await expect(handle.dispose({
      cancel: () => { throw new Error('cancel failed') },
      closeInput: async () => {},
    })).rejects.toMatchObject({ code: 'DISPOSE_FAILED' })
    await cleanup(ctx, root)
  })

  it('startup timeout preserves START_TIMEOUT when cleanup also fails', async () => {
    vi.useFakeTimers()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: driver(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
    })
    const pending = handle.waitUntilReady(new Promise(() => {}), {
      cancel: () => { throw new Error('split-secret-value cleanup') },
    })
    await vi.runAllTimersAsync()
    const failure = await pending.then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'START_TIMEOUT',
      message: 'agent runtime startup exceeded 20ms',
    })
    expect(String((failure as Error).cause)).not.toContain('split-secret-value')
    expect(subprocess.handles[0]!.terminated).toBe(1)
    await cleanup(ctx, root)
  })

  it('reports a clean startup timeout as START_TIMEOUT', async () => {
    vi.useFakeTimers()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    const pending = handle.waitUntilReady(new Promise(() => {}))
    await vi.runAllTimersAsync()

    await expect(pending).rejects.toMatchObject({
      code: 'START_TIMEOUT',
    })
    expect(subprocess.handles[0]!.terminated).toBe(1)
    await cleanup(ctx, root)
  })

  it('reports startup rollback failure when rejected readiness cannot stop the process', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    const processHandle = subprocess.handles[0]!
    processHandle.waitOutcomes.push(false, false)
    processHandle.terminateFailure = new Error('terminate failed')

    await expect(handle.waitUntilReady(Promise.reject(new Error('not ready'))))
      .rejects.toMatchObject({ code: 'DISPOSE_FAILED' })
    await cleanup(ctx, root)
  })

  it('reports cleanup failure when caller cancellation cannot stop a turn', async () => {
    const controller = new AbortController()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile, driver(), controller.signal))
    await handle.waitUntilReady(Promise.resolve())
    const processHandle = subprocess.handles[0]!
    processHandle.waitOutcomes.push(false, false)
    processHandle.terminateFailure = new Error('terminate failed')
    const pending = handle.runTurn(() => new Promise(() => {}))
    controller.abort(new Error('caller cancelled'))

    await expect(pending).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
    })
    await cleanup(ctx, root)
  })

  it('bounds a hanging protocol shutdown hook and still terminates the process', async () => {
    vi.useFakeTimers()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    const pending = handle.dispose({
      cancel: () => new Promise(() => {}),
      closeInput: () => { throw new Error('must not run after the deadline') },
    })
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toBeUndefined()
    expect(subprocess.handles[0]!.terminated).toBe(1)
    await cleanup(ctx, root)
  })

  it('records a termination-wait failure and still removes temporary material', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch({
      ...request(profile),
      temporaryFiles: [{ name: 'auth', content: 'secret' }],
    })
    const processHandle = subprocess.handles[0]!
    processHandle.waitOutcomes.push(false, new Error('termination probe failed'))

    await expect(handle.dispose()).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
    })
    await expect(stat(handle.temporaryPaths.auth!)).rejects.toMatchObject({ code: 'ENOENT' })
    await cleanup(ctx, root)
  })

  it('rejects readiness immediately after disposal', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const handle = await launcher.launch(request(profile))
    subprocess.handles[0]!.exit()
    await handle.dispose()

    await expect(handle.waitUntilReady(new Promise(() => {}))).rejects.toThrow('agent runtime disposed')
    await cleanup(ctx, root)
  })

  it('cleans temporary material when spawn throws', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    subprocess.spawnFailure = new Error('spawn failed')
    await expect(launcher.launch({
      profile,
      cwd: process.cwd(),
      driver: driver(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: new AbortController().signal,
      temporaryFiles: [{ name: 'secret', content: 'value' }],
    })).rejects.toThrow('spawn failed')
    expect(await readdir(root)).toEqual([])
    await cleanup(ctx, root)
  })

  it('reports both spawn and temporary cleanup failures during launch rollback', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const temporary = Reflect.get(launcher, 'temporary') as RuntimeTemporaryMaterialOwner
    vi.spyOn(temporary, 'create').mockResolvedValue({
      paths: {},
      cleanup: () => Promise.reject(new Error('cleanup failed')),
    })
    subprocess.spawnFailure = new Error('spawn failed')

    await expect(launcher.launch(request(profile))).rejects.toMatchObject({
      code: 'DISPOSE_FAILED',
    })
    await cleanup(ctx, root)
  })

  it('rejects an aborted launch before creating temporary material', async () => {
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const failure = new Error('cancelled before launch')

    await expect(launcher.launch({
      ...request(profile, driver(), AbortSignal.abort(failure)),
      temporaryFiles: [{ name: 'auth', content: 'secret' }],
    })).rejects.toBe(failure)
    expect(subprocess.spawns).toHaveLength(0)
    expect(await readdir(root)).toEqual([])
    await cleanup(ctx, root)
  })

  it('rechecks caller cancellation immediately before spawn', async () => {
    const controller = new AbortController()
    const { ctx, launcher, subprocess, profile, root } = await harness()
    const failure = new Error('cancelled during executable resolution')
    subprocess.resolutionHook = () => { controller.abort(failure) }

    await expect(launcher.launch(request(profile, driver(), controller.signal))).rejects.toBe(failure)
    expect(subprocess.spawns).toHaveLength(0)
    expect(await readdir(root)).toEqual([])
    await cleanup(ctx, root)
  })
})

describe('environment policy', () => {
  it.each([
    ['invalid reserved name', settings(), driver({
      reservedEnvironment: ['BAD-NAME'],
      credentialEnvironment: [],
      environment: {},
    }), {}, 'environment name is invalid'],
    ['duplicate reserved name', settings(), driver({
      reservedEnvironment: ['DSH_PROTOCOL', 'DSH_PROTOCOL'],
    }), {}, 'repeats reserved environment key'],
    ['unreserved credential target', settings(), driver({
      credentialEnvironment: ['OTHER_KEY'],
    }), {}, 'is not reserved by the Driver'],
    ['duplicate credential target', settings(), driver({
      credentialEnvironment: ['PROVIDER_API_KEY', 'PROVIDER_API_KEY'],
    }), {}, 'repeats credential target'],
    ['reserved ambient key', (() => {
      const config = settings()
      config.profiles.main!.launch.ambientEnv!.push('DSH_PROTOCOL')
      return config
    })(), driver(), {}, 'allowlists reserved environment key'],
    ['NUL profile environment value', (() => {
      const config = settings()
      config.profiles.main!.launch.env!.BAD_VALUE = 'before\0after'
      return config
    })(), driver(), {}, 'environment value contains NUL'],
    ['unreserved Driver environment', settings(), driver({
      environment: { DSH_PROTOCOL: 'stdio', DRIVER_EXTRA: 'value' },
    }), {}, 'is not declared reserved'],
    ['Driver-written credential target', settings(), driver({
      environment: { DSH_PROTOCOL: 'stdio', PROVIDER_API_KEY: 'forbidden' },
    }), {}, 'writes credential environment key'],
    ['undeclared resolved credential', settings(), driver(), {
      PROVIDER_API_KEY: 'secret',
      OTHER_KEY: 'secret',
    }, 'is not declared by the Driver'],
  ])('rejects %s', async (_name, config, launchDriver, credentials, message) => {
    const { ctx, profile, root } = await harness(config)
    try {
      expect(() => buildRuntimeEnvironment(ctx, profile, launchDriver, credentials))
        .toThrow(message)
    } finally {
      await cleanup(ctx, root)
    }
  })

  it('rejects an invalid profile environment name at the launcher boundary', async () => {
    const { ctx, profile, root } = await harness()
    const invalid = structuredClone(profile)
    ;(invalid.launch.env as Record<string, string>)['BAD-NAME'] = 'value'

    expect(() => buildRuntimeEnvironment(ctx, invalid, driver(), {}))
      .toThrow('environment name is invalid')
    await cleanup(ctx, root)
  })

  it('rejects duplicate environment sources even when neither is reserved', async () => {
    process.env.DSH_F4_ALLOWED = 'ambient'
    const config = settings()
    config.profiles.main!.launch.env!.DSH_F4_ALLOWED = 'profile'
    const { ctx, profile, root } = await harness(config)

    expect(() => buildRuntimeEnvironment(ctx, profile, driver(), {}))
      .toThrow('assigned by both ambient allowlist and profile')
    await cleanup(ctx, root)
  })

  it.each(['SystemRoot', 'ComSpec'] as const)(
    'requires the Windows %s launcher environment entry',
    async (missing) => {
      const originalSystemRoot = process.env.SystemRoot
      const originalComSpec = process.env.ComSpec
      process.env.SystemRoot = 'C:\\Windows'
      process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
      if (missing === 'SystemRoot') delete process.env.SystemRoot
      else delete process.env.ComSpec
      const { ctx, profile, root } = await harness()
      try {
        expect(() => buildRuntimeEnvironment(ctx, profile, driver(), {}, 'win32'))
          .toThrow(`requires Windows environment entry "${missing}"`)
      } finally {
        if (originalSystemRoot === undefined) delete process.env.SystemRoot
        else process.env.SystemRoot = originalSystemRoot
        if (originalComSpec === undefined) delete process.env.ComSpec
        else process.env.ComSpec = originalComSpec
        await cleanup(ctx, root)
      }
    },
  )

  it('folds names on Windows and rejects duplicate case variants', async () => {
    const originalSystemRoot = process.env.SystemRoot
    const originalComSpec = process.env.ComSpec
    process.env.SystemRoot = 'C:\\Windows'
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const config = settings()
    config.profiles.main!.launch.env!.dsh_protocol = 'override'
    const { ctx, profile, root } = await harness(config)
    try {
      expect(() => buildRuntimeEnvironment(
        ctx,
        profile,
        driver(),
        { PROVIDER_API_KEY: 'secret' },
        'win32',
      )).toThrow(/reserved environment/u)
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = originalSystemRoot
      if (originalComSpec === undefined) delete process.env.ComSpec
      else process.env.ComSpec = originalComSpec
      await cleanup(ctx, root)
    }
  })
})
