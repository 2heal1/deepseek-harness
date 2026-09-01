/**
 * Secure agent-runtime launch requests, lifecycle hooks, and live handles.
 *
 * @module dsh-agent-runtime-launcher/types
 */

import type { RuntimeProfileSnapshot } from '@deepseek-ai/dsh-agent-runtime'
import type {
  SubprocessHandle,
  SubprocessOutputMode,
  SubprocessStdinMode,
} from '@deepseek-ai/dsh-subprocess'

/** One Driver-owned argument injection and the profile forms it reserves. */
export interface RuntimeReservedArgument {
  /** Stable diagnostic name for this control. */
  readonly name: string
  /** Exact option spellings rejected in profile arguments, including `--name=value` forms. */
  readonly forms: readonly string[]
  /** Complete Driver-owned argv fragment appended after profile arguments. */
  readonly argv: readonly string[]
}

/** Driver-owned launch controls interpreted by the shared launcher. */
export interface RuntimeDriverLaunch {
  /** Reserved argument controls injected only by the Driver. */
  readonly arguments: readonly RuntimeReservedArgument[]
  /** Exact Driver-required environment entries. */
  readonly environment: Readonly<Record<string, string>>
  /** Environment names reserved for Driver or launcher injection. */
  readonly reservedEnvironment: readonly string[]
  /** Reserved environment names that receive profile credential values. */
  readonly credentialEnvironment: readonly string[]
  /** Permit a resolved `.cmd` or `.bat` through the shared Windows encoder. */
  readonly allowWindowsCommandScript: boolean
  /** Whether this launch fully enforces the profile permission policy. */
  readonly permissionEnforcement: 'full' | 'partial' | 'none'
}

/** Sensitive temporary material created before process spawn. */
export interface RuntimeTemporaryFile {
  /** Stable basename used inside the random private launch directory. */
  readonly name: string
  /** File contents; never included in cleanup metadata or errors. */
  readonly content: string | Uint8Array
}

/** Per-stream stdio dispositions for one external runtime process. */
export interface RuntimeLaunchStdio {
  readonly stdin: SubprocessStdinMode
  readonly stdout: SubprocessOutputMode
  readonly stderr: SubprocessOutputMode
}

/** One secure external-runtime process launch. */
export interface AgentRuntimeLaunchRequest {
  /** Immutable non-secret Runtime Profile snapshot. */
  readonly profile: RuntimeProfileSnapshot
  /** Working directory resolved by the Provider from the snapshot policy. */
  readonly cwd: string
  /** Driver-owned argument, environment, platform, and enforcement declarations. */
  readonly driver: RuntimeDriverLaunch
  /** Explicit stdio contract for the protocol transport. */
  readonly stdio: RuntimeLaunchStdio
  /** Caller cancellation covering resolution, spawn, and startup. */
  readonly signal: AbortSignal
  /** Optional sensitive files owned by this launch. */
  readonly temporaryFiles?: readonly RuntimeTemporaryFile[]
}

/** Provider protocol hooks used during timeout and disposal escalation. */
export interface RuntimeProtocolShutdown {
  /** Ask the protocol to cancel outstanding work. */
  readonly cancel?: (reason: Error) => void | Promise<void>
  /** Close protocol input after cancellation has been requested. */
  readonly closeInput?: () => void | Promise<void>
}

/** One deadline-scoped turn supplied with the abort signal it must observe. */
export type RuntimeTurnOperation<T> = (signal: AbortSignal) => Promise<T>

/** One live process and its launch-scoped security resources. */
export interface AgentRuntimeLaunchHandle {
  /** Managed process-tree handle. */
  readonly process: SubprocessHandle
  /** Non-secret paths of temporary files owned by this launch. */
  readonly temporaryPaths: Readonly<Record<string, string>>
  /**
   * Redact one complete diagnostic value before it reaches Harness-owned data.
   * @param value - provider diagnostic, error message, event data, or retained output.
   * @returns a detached value with every known credential replaced.
   */
  redact<T>(value: T): T
  /**
   * Bound protocol readiness by the profile startup deadline.
   * @param readiness - Provider handshake/readiness work.
   * @param shutdown - protocol cancellation and input-close hooks.
   */
  waitUntilReady(readiness: Promise<void>, shutdown?: RuntimeProtocolShutdown): Promise<void>
  /**
   * Run one submission operation under the profile turn deadline.
   * @param operation - Provider operation that observes the supplied signal.
   * @param shutdown - protocol cancellation and input-close hooks used when the deadline wins.
   * @returns the operation result.
   */
  runTurn<T>(operation: RuntimeTurnOperation<T>, shutdown?: RuntimeProtocolShutdown): Promise<T>
  /**
   * Idempotently stop the protocol, terminate and join the process tree, then remove temporary material.
   * @param shutdown - protocol cancellation and input-close hooks.
   */
  dispose(shutdown?: RuntimeProtocolShutdown): Promise<void>
}
