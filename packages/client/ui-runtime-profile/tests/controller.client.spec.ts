/** React-free Runtime Profile catalog, editor, write, and probe state. */

import type {
  IApiClient,
  RpcResponse,
  RuntimeProfileDocumentView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProfileController } from '../src/client/controller.ts'

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'test' as never, result: { ok: true, value } }
}

function failure<T>(message: string): RpcResponse<T> {
  return {
    rpcId: 'test' as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

const PROFILE = {
  provider: 'native',
  launch: {
    executable: '/usr/bin/node',
    cwdPolicy: 'session-workspace' as const,
  },
  permissions: {
    policy: {},
    enforcement: 'required' as const,
  },
  process: {
    startupTimeoutMs: 1,
    turnTimeoutMs: 2,
    shutdownTimeoutMs: 3,
    terminationTimeoutMs: 4,
    maxConcurrentRuns: 1,
  },
}

function document(revision: number): RuntimeProfileDocumentView {
  return {
    revision,
    writable: true,
    defaultMainProfile: 'main',
    profiles: { main: PROFILE },
    subagentRoutes: {},
    credentialStatus: { main: {} },
  }
}

function fakeApi() {
  let revision = 1
  const nextDocument = (): RuntimeProfileDocumentView => document(++revision)
  const runtimeProfiles = {
    catalog: vi.fn<IApiClient['runtimeProfiles']['catalog']>(() => Promise.resolve(ok({
      profiles: [{
        id: 'main',
        provider: 'native',
        isDefault: true,
        providerAvailable: true,
        schemaCompatible: true,
      }],
      routes: [{ id: 'child', runtimeProfile: 'main', toolName: 'delegate_child' }],
    }))),
    describe: vi.fn<IApiClient['runtimeProfiles']['describe']>(() => Promise.resolve(ok(document(revision)))),
    save: vi.fn<IApiClient['runtimeProfiles']['save']>(() => Promise.resolve(ok(nextDocument()))),
    remove: vi.fn<IApiClient['runtimeProfiles']['remove']>(() => Promise.resolve(ok(nextDocument()))),
    saveRoute: vi.fn<IApiClient['runtimeProfiles']['saveRoute']>(() => Promise.resolve(ok(nextDocument()))),
    removeRoute: vi.fn<IApiClient['runtimeProfiles']['removeRoute']>(() => Promise.resolve(ok(nextDocument()))),
    setDefault: vi.fn<IApiClient['runtimeProfiles']['setDefault']>(() => Promise.resolve(ok(nextDocument()))),
    probe: vi.fn<IApiClient['runtimeProfiles']['probe']>(() => Promise.resolve(ok({
      productVersion: '1',
      capabilities: [{ id: 'runtimeActivity' as const }],
      permissionEnforcement: 'enforced' as const,
    }))),
  } satisfies IApiClient['runtimeProfiles']
  return {
    api: { runtimeProfiles } as Pick<IApiClient, 'runtimeProfiles'>,
    runtimeProfiles,
  }
}

describe('RuntimeProfileController', () => {
  it('loads the safe catalog and trusted document into one shared snapshot', async () => {
    const { api } = fakeApi()
    const controller = new RuntimeProfileController(api)

    await Promise.all([controller.loadCatalog(), controller.loadCatalog()])
    await controller.loadDocument()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      profiles: [{ id: 'main' }],
      routes: [{ id: 'child' }],
      document: { revision: 1 },
      busy: null,
      error: null,
    })
  })

  it('sends every write under the current revision and adopts each returned document', async () => {
    const { api, runtimeProfiles } = fakeApi()
    const controller = new RuntimeProfileController(api)
    await controller.loadDocument()

    await controller.saveProfile('main', PROFILE)
    expect(runtimeProfiles.save).toHaveBeenCalledWith({
      profileId: 'main', profile: PROFILE, expectedRevision: 1,
    })
    await controller.saveRoute('child', {
      runtimeProfile: 'main',
      maxDepth: 1,
      maxConcurrentRuns: 1,
      toolName: 'delegate_child',
    })
    expect(runtimeProfiles.saveRoute).toHaveBeenCalledWith(expect.objectContaining({
      routeId: 'child', expectedRevision: 2,
    }))
    await controller.setDefault('main')
    await controller.removeRoute('child')
    await controller.removeProfile('main')
    expect(controller.store.getSnapshot().document?.revision).toBe(6)
    expect(runtimeProfiles.catalog).toHaveBeenCalledTimes(5)
  })

  it('does not write before describe or while another write is active', async () => {
    const { api, runtimeProfiles } = fakeApi()
    const controller = new RuntimeProfileController(api)
    await controller.saveProfile('main', PROFILE)
    await controller.removeProfile('main')
    await controller.setDefault('main')
    await controller.saveRoute('child', {
      runtimeProfile: 'main',
      maxDepth: 1,
      maxConcurrentRuns: 1,
      toolName: 'delegate_child',
    })
    await controller.removeRoute('child')
    expect(runtimeProfiles.save).not.toHaveBeenCalled()
    expect(runtimeProfiles.remove).not.toHaveBeenCalled()
    expect(runtimeProfiles.setDefault).not.toHaveBeenCalled()
    expect(runtimeProfiles.saveRoute).not.toHaveBeenCalled()
    expect(runtimeProfiles.removeRoute).not.toHaveBeenCalled()

    await controller.loadDocument()
    let settle!: (value: RpcResponse<RuntimeProfileDocumentView>) => void
    runtimeProfiles.save.mockReturnValueOnce(new Promise((resolve) => { settle = resolve }))
    const first = controller.saveProfile('main', PROFILE)
    await controller.removeProfile('main')
    await controller.probe('main')
    expect(runtimeProfiles.remove).not.toHaveBeenCalled()
    expect(runtimeProfiles.probe).not.toHaveBeenCalled()
    settle(ok(document(2)))
    await first
  })

  it('retains safe failure text for catalog, document, write, probe, and selection failures', async () => {
    const { api, runtimeProfiles } = fakeApi()
    const controller = new RuntimeProfileController(api)

    runtimeProfiles.catalog.mockResolvedValueOnce(failure('catalog failed'))
    await controller.loadCatalog()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'catalog failed',
    })

    runtimeProfiles.describe.mockRejectedValueOnce('describe threw')
    await controller.loadDocument()
    expect(controller.store.getSnapshot().error).toBe('describe threw')
    runtimeProfiles.describe.mockResolvedValueOnce(failure('describe failed'))
    await controller.loadDocument()
    expect(controller.store.getSnapshot().error).toBe('describe failed')
    runtimeProfiles.describe.mockResolvedValueOnce(ok(document(1)))
    await controller.loadDocument()

    runtimeProfiles.save.mockResolvedValueOnce(failure('write failed'))
    await controller.saveProfile('main', PROFILE)
    expect(controller.store.getSnapshot().error).toBe('write failed')

    runtimeProfiles.probe.mockResolvedValueOnce(failure('probe failed'))
    await controller.probe('main')
    expect(controller.store.getSnapshot().probes.main).toBe('probe failed')
    runtimeProfiles.probe.mockRejectedValueOnce(new Error('probe threw'))
    await controller.probe('main')
    expect(controller.store.getSnapshot().probes.main).toBe('probe threw')

    await controller.selectProfile(() => Promise.reject(new Error('create failed')))
    expect(controller.store.getSnapshot().error).toBe('create failed')
    await controller.selectProfile(() => Promise.resolve())
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('stores successful probe facts and catches thrown catalog and write failures', async () => {
    const { api, runtimeProfiles } = fakeApi()
    const controller = new RuntimeProfileController(api)
    runtimeProfiles.catalog.mockRejectedValueOnce(new Error('wire down'))
    await controller.loadCatalog()
    expect(controller.store.getSnapshot().error).toBe('wire down')

    await controller.loadDocument()
    runtimeProfiles.remove.mockRejectedValueOnce(new Error('remove threw'))
    await controller.removeProfile('main')
    expect(controller.store.getSnapshot().error).toBe('remove threw')

    await controller.probe('main')
    expect(controller.store.getSnapshot().probes.main).toMatchObject({
      productVersion: '1',
      permissionEnforcement: 'enforced',
    })
  })
})
