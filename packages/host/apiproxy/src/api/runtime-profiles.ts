/** Runtime Profile and runtime-backed route management API. */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Stored executable resolution policy. */
export type RuntimeProfileResolution =
  | 'absolute'
  | { searchPath: string[] }

/** Stored working-directory policy. */
export type RuntimeProfileCwdPolicy =
  | 'session-workspace'
  | 'parent-workspace'
  | { fixed: string }

/** One credential reference mapped to a child-process environment target. */
export interface RuntimeProfileCredential {
  credentialRef: string
}

/** Complete non-secret Runtime Profile configuration editable by the trusted control plane. */
export interface RuntimeProfileConfigView {
  provider: string
  schemaVersion?: number
  providerOptionsVersion?: number
  providerOptions?: unknown
  launch: {
    executable: string
    args?: string[]
    resolution?: RuntimeProfileResolution
    cwdPolicy: RuntimeProfileCwdPolicy
    ambientEnv?: string[]
    env?: Record<string, string>
  }
  model?: {
    default?: string
    allowSessionOverride?: boolean
  }
  product?: unknown
  permissions: {
    policy: unknown
    enforcement: 'required' | 'best-effort'
    approval?: 'unattended-fail-closed'
  }
  nativeTools?: { allowed?: string[] }
  harnessTools?: {
    transport?: 'none' | 'mcp'
    allowed?: string[]
  }
  credentials?: {
    env?: Record<string, RuntimeProfileCredential>
  }
  process: {
    startupTimeoutMs: number
    turnTimeoutMs: number
    shutdownTimeoutMs: number
    terminationTimeoutMs: number
    maxConcurrentRuns: number
  }
}

/** One stored one-shot route. */
export interface RuntimeSubagentRouteView {
  runtimeProfile: string
  mode?: 'one-shot'
  maxDepth: number
  maxConcurrentRuns: number
  toolName: string
}

/** Safe Runtime Profile row available to every session-creation client. */
export interface RuntimeProfileCatalogEntry {
  id: string
  provider: string
  model?: string
  isDefault: boolean
  providerAvailable: boolean
  schemaCompatible: boolean
}

/** One configured route without executable, environment, or credential metadata. */
export interface RuntimeRouteCatalogEntry {
  id: string
  runtimeProfile: string
  toolName: string
}

/** Trusted editor snapshot of the complete runtime configuration document. */
export interface RuntimeProfileDocumentView {
  revision: number
  writable: boolean
  defaultMainProfile: string
  profiles: Record<string, RuntimeProfileConfigView>
  subagentRoutes: Record<string, RuntimeSubagentRouteView>
  /** Credential target status; null means no credential service is composed. */
  credentialStatus: Record<string, Record<string, boolean | null>>
}

/** Successful provider probe result. */
export interface RuntimeProfileProbeView {
  productVersion?: string
  protocolVersion?: string
  capabilities: readonly {
    id:
      | 'continuation'
      | 'steering'
      | 'queuedInputRead'
      | 'queuedInputMutation'
      | 'injection'
      | 'maintenance'
      | 'imageInput'
      | 'modelOverride'
      | 'approvals'
      | 'runtimeActivity'
      | 'harnessTools'
      | 'resume'
      | 'coldResume'
    metadata?: unknown
  }[]
  permissionEnforcement: 'enforced' | 'best-effort' | 'unsupported'
  details?: unknown
}

/** Runtime Profile domain methods. */
export interface RuntimeProfilesApi {
  /** List safe profile and route identities for ordinary selection surfaces. */
  catalog(request: RpcRequest<{}>): Promise<RpcResponse<{
    profiles: RuntimeProfileCatalogEntry[]
    routes: RuntimeRouteCatalogEntry[]
  }>>

  /** Read the complete non-secret document and credential configured states. */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<RuntimeProfileDocumentView>>

  /** Create or replace one profile under the supplied revision fence. */
  save(request: RpcRequest<{
    profileId: string
    profile: RuntimeProfileConfigView
    expectedRevision: number
  }>): Promise<RpcResponse<RuntimeProfileDocumentView>>

  /**
   * Remove one user-layer profile entry.
   *
   * A composition-base entry at the same id becomes effective again. References
   * or default selection make complete-document validation reject.
   */
  remove(request: RpcRequest<{
    profileId: string
    expectedRevision: number
  }>): Promise<RpcResponse<RuntimeProfileDocumentView>>

  /** Create or replace one one-shot route under the supplied revision fence. */
  saveRoute(request: RpcRequest<{
    routeId: string
    route: RuntimeSubagentRouteView
    expectedRevision: number
  }>): Promise<RpcResponse<RuntimeProfileDocumentView>>

  /** Remove one user-layer route; a composition-base entry may become effective again. */
  removeRoute(request: RpcRequest<{
    routeId: string
    expectedRevision: number
  }>): Promise<RpcResponse<RuntimeProfileDocumentView>>

  /** Select the profile used when session.create omits runtimeProfile. */
  setDefault(request: RpcRequest<{
    profileId: string
    expectedRevision: number
  }>): Promise<RpcResponse<RuntimeProfileDocumentView>>

  /** Probe one stored profile without creating a Harness Session. */
  probe(
    request: RpcRequest<{ profileId: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<RuntimeProfileProbeView>>
}
