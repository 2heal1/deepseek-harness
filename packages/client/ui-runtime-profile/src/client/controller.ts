/** React-free controllers for Runtime Profile selection and trusted editing. */

import type {
  IApiClient,
  RuntimeProfileCatalogEntry,
  RuntimeProfileConfigView,
  RuntimeProfileDocumentView,
  RuntimeProfileProbeView,
  RuntimeSubagentRouteView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Runtime Profile state shared by the picker, header label, and settings page. */
export interface RuntimeProfileState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  profiles: readonly RuntimeProfileCatalogEntry[]
  routes: readonly { id: string; runtimeProfile: string; toolName: string }[]
  document: RuntimeProfileDocumentView | null
  probes: Readonly<Record<string, RuntimeProfileProbeView | string>>
  busy: string | null
  error: string | null
}

const INITIAL: RuntimeProfileState = {
  status: 'idle',
  profiles: [],
  routes: [],
  document: null,
  probes: {},
  busy: null,
  error: null,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Coordinates the safe catalog with the loopback-only editor operations. */
export class RuntimeProfileController {
  /** Observable Runtime Profile data shared by all UI projections. */
  readonly store: SnapshotStore<RuntimeProfileState> = createSnapshotStore(INITIAL)

  constructor(private readonly api: Pick<IApiClient, 'runtimeProfiles'>) {}

  private set(patch: Partial<RuntimeProfileState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Create and open a Session under one catalog profile.
   * @param operation - session creation and navigation owned by the client runtime.
   */
  async selectProfile(operation: () => Promise<void>): Promise<void> {
    this.set({ error: null })
    try {
      await operation()
    } catch (error: unknown) {
      this.set({ error: errorMessage(error) })
    }
  }

  /** Refresh safe selector metadata. */
  async loadCatalog(): Promise<void> {
    if (this.store.getSnapshot().status === 'loading') return
    this.set({ status: 'loading', error: null })
    try {
      const response = await this.api.runtimeProfiles.catalog({})
      if (!response.result.ok) {
        this.set({ status: 'error', error: response.result.error.message })
        return
      }
      this.set({
        status: 'ready',
        profiles: response.result.value.profiles,
        routes: response.result.value.routes,
      })
    } catch (error: unknown) {
      this.set({ status: 'error', error: errorMessage(error) })
    }
  }

  /** Refresh the trusted editor document. */
  async loadDocument(): Promise<void> {
    this.set({ busy: 'load', error: null })
    try {
      const response = await this.api.runtimeProfiles.describe({})
      if (!response.result.ok) {
        this.set({ busy: null, error: response.result.error.message })
        return
      }
      this.set({ busy: null, document: response.result.value })
    } catch (error: unknown) {
      this.set({ busy: null, error: errorMessage(error) })
    }
  }

  private async write(
    key: string,
    operation: () => ReturnType<IApiClient['runtimeProfiles']['save']>,
  ): Promise<void> {
    if (this.store.getSnapshot().busy !== null) return
    this.set({ busy: key, error: null })
    try {
      const response = await operation()
      if (!response.result.ok) {
        this.set({ busy: null, error: response.result.error.message })
        return
      }
      this.set({ busy: null, document: response.result.value })
      await this.loadCatalog()
    } catch (error: unknown) {
      this.set({ busy: null, error: errorMessage(error) })
    }
  }

  /**
   * Save one Runtime Profile against the loaded document revision.
   * @param profileId - stable Runtime Profile identifier.
   * @param profile - complete non-secret Runtime Profile configuration.
   * @returns a promise that settles after the document and catalog refresh.
   */
  saveProfile(profileId: string, profile: RuntimeProfileConfigView): Promise<void> {
    const revision = this.store.getSnapshot().document?.revision
    if (revision === undefined) return Promise.resolve()
    return this.write(`profile:${profileId}`, () =>
      this.api.runtimeProfiles.save({ profileId, profile, expectedRevision: revision }))
  }

  /**
   * Remove one user-layer Runtime Profile against the loaded revision.
   * @param profileId - Runtime Profile identifier to remove.
   * @returns a promise that settles after the document and catalog refresh.
   */
  removeProfile(profileId: string): Promise<void> {
    const revision = this.store.getSnapshot().document?.revision
    if (revision === undefined) return Promise.resolve()
    return this.write(`profile:${profileId}`, () =>
      this.api.runtimeProfiles.remove({ profileId, expectedRevision: revision }))
  }

  /**
   * Set the default Runtime Profile against the loaded revision.
   * @param profileId - Runtime Profile identifier to make the default.
   * @returns a promise that settles after the document and catalog refresh.
   */
  setDefault(profileId: string): Promise<void> {
    const revision = this.store.getSnapshot().document?.revision
    if (revision === undefined) return Promise.resolve()
    return this.write(`default:${profileId}`, () =>
      this.api.runtimeProfiles.setDefault({ profileId, expectedRevision: revision }))
  }

  /**
   * Save one one-shot subagent route against the loaded revision.
   * @param routeId - stable route identifier.
   * @param route - complete one-shot route configuration.
   * @returns a promise that settles after the document and catalog refresh.
   */
  saveRoute(routeId: string, route: RuntimeSubagentRouteView): Promise<void> {
    const revision = this.store.getSnapshot().document?.revision
    if (revision === undefined) return Promise.resolve()
    return this.write(`route:${routeId}`, () =>
      this.api.runtimeProfiles.saveRoute({ routeId, route, expectedRevision: revision }))
  }

  /**
   * Remove one user-layer route against the loaded revision.
   * @param routeId - route identifier to remove.
   * @returns a promise that settles after the document and catalog refresh.
   */
  removeRoute(routeId: string): Promise<void> {
    const revision = this.store.getSnapshot().document?.revision
    if (revision === undefined) return Promise.resolve()
    return this.write(`route:${routeId}`, () =>
      this.api.runtimeProfiles.removeRoute({ routeId, expectedRevision: revision }))
  }

  /**
   * Probe one saved profile and retain either its facts or safe failure text.
   * @param profileId - Runtime Profile identifier to probe.
   */
  async probe(profileId: string): Promise<void> {
    if (this.store.getSnapshot().busy !== null) return
    this.set({ busy: `probe:${profileId}`, error: null })
    try {
      const response = await this.api.runtimeProfiles.probe({ profileId })
      const result = response.result.ok ? response.result.value : response.result.error.message
      this.set({
        busy: null,
        probes: { ...this.store.getSnapshot().probes, [profileId]: result },
      })
    } catch (error: unknown) {
      this.set({
        busy: null,
        probes: { ...this.store.getSnapshot().probes, [profileId]: errorMessage(error) },
      })
    }
  }
}
