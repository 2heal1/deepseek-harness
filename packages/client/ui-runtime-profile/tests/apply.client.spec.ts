/** Slot registration, trust split, and pre-publication Session creation. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import {
  RuntimeProfileLabel,
  RuntimeProfileSeat,
  type RuntimeProfileSeatInjected,
} from '../src/client/RuntimeProfileSeat.tsx'
import {
  RuntimeProfileSection,
  type RuntimeProfileSectionInjected,
} from '../src/client/RuntimeProfileSection.tsx'

const CATALOG = {
  rpcId: 'catalog',
  result: {
    ok: true as const,
    value: {
      profiles: [{
        id: 'native',
        provider: 'native',
        isDefault: true,
        providerAvailable: true,
        schemaCompatible: true,
      }],
      routes: [],
    },
  },
}

const DOCUMENT = {
  rpcId: 'document',
  result: {
    ok: true as const,
    value: {
      revision: 0,
      writable: true,
      defaultMainProfile: 'native',
      profiles: {
        native: {
          provider: 'native',
          launch: { executable: 'node', cwdPolicy: 'session-workspace' as const },
          permissions: { policy: {}, enforcement: 'required' as const },
          process: {
            startupTimeoutMs: 1,
            turnTimeoutMs: 2,
            shutdownTimeoutMs: 3,
            terminationTimeoutMs: 4,
            maxConcurrentRuns: 1,
          },
        },
      },
      subagentRoutes: {},
      credentialStatus: { native: {} },
    },
  },
}

async function bench(isLoopback: boolean) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const catalog = vi.fn(() => Promise.resolve(CATALOG))
  const describeDocument = vi.fn(() => Promise.resolve(DOCUMENT))
  const save = vi.fn(() => Promise.resolve(DOCUMENT))
  const remove = vi.fn(() => Promise.resolve(DOCUMENT))
  const saveRoute = vi.fn(() => Promise.resolve(DOCUMENT))
  const removeRoute = vi.fn(() => Promise.resolve(DOCUMENT))
  const setDefault = vi.fn(() => Promise.resolve(DOCUMENT))
  const probe = vi.fn(() => Promise.resolve({
    rpcId: 'probe',
    result: {
      ok: true as const,
      value: { capabilities: [], permissionEnforcement: 'enforced' as const },
    },
  }))
  ctx.provide('connection', {
    isLoopback,
    api: {
      runtimeProfiles: {
        catalog,
        describe: describeDocument,
        save,
        remove,
        saveRoute,
        removeRoute,
        setDefault,
        probe,
      },
    },
  } as never)
  return {
    ctx,
    slots: ctx.get('slots') as SlotRegistry,
    locale,
    catalog,
    describeDocument,
    runtimeProfiles: { save, remove, saveRoute, removeRoute, setDefault, probe },
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'conversation',
    children: {
      'conversation.hero.runtimeProfile': { kind: 'single', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

function provideConversation(ctx: Context) {
  const create = vi.fn(() => Promise.resolve('created'))
  const open = vi.fn()
  ctx.provide('conversation', {} as never)
  const sessionList = createSnapshotStore<{
    ids: string[]
    byId: Record<string, {
      id: string
      displayTitle: string
      blank: boolean
      running: boolean
      updatedAt: number
    }>
    current: string | undefined
    phase: string
    subagentsByParent: Record<string, never>
    jobsBySession: Record<string, never>
    currentAddress: undefined
  }>({
    ids: ['current'],
    byId: {
      current: {
        id: 'current',
        displayTitle: 'current',
        blank: false,
        running: false,
        updatedAt: 1,
      },
    },
    current: 'current',
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  ctx.provide('sessions', {
    list: sessionList,
    create,
    open,
  } as never)
  const workspaceList = createSnapshotStore<{
    items: Array<{
      workspaceId: string
      path: string
      title: string
      sessionIds: string[]
      createdAt: string
      updatedAt: string
    }>
    archivedSessionIds: string[]
    state: string
    phase: string
    error: null
    baselinesReady: boolean
    recentWorkspaceId: string | undefined
  }>({
    items: [{
      workspaceId: 'workspace',
      path: '/workspace',
      title: 'workspace',
      sessionIds: ['current'],
      createdAt: '0',
      updatedAt: '0',
    }],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: 'workspace',
  })
  ctx.provide('workspaces', {
    list: workspaceList,
  } as never)
  return { create, open, sessionList, workspaceList }
}

describe('ui-runtime-profile apply', () => {
  it('declares the root services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers the trusted settings page with a locale-following label', async () => {
    const b = await bench(true)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(RuntimeProfileSection)
    expect(entry.options).toMatchObject({ id: 'runtime-profiles', order: 30 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Agent runtimes')
    const injected = (entry.inject as unknown as () => RuntimeProfileSectionInjected)()
    await injected.load()
    expect(injected.hooks.runtimeProfiles.getSnapshot()).toMatchObject({
      profiles: [{ id: 'native' }],
      document: { defaultMainProfile: 'native' },
    })
    const profile = DOCUMENT.result.value.profiles.native
    await injected.saveProfile('native', profile)
    await injected.removeProfile('native')
    await injected.setDefault('native')
    await injected.saveRoute('child', {
      runtimeProfile: 'native',
      mode: 'one-shot',
      maxDepth: 1,
      maxConcurrentRuns: 1,
      toolName: 'delegate_child',
    })
    await injected.removeRoute('child')
    await injected.probe('native')
    expect(Object.values(b.runtimeProfiles).every(mock => mock.mock.calls.length === 1)).toBe(true)

    b.locale.setLocale('zh')
    expect(resolveSlotLabel(entry.options.label)).toBe('Agent 运行时')
  })

  it('withholds the editor from non-loopback clients but keeps the safe selector', async () => {
    const b = await bench(false)
    declare(b.slots)
    declareConversation(b.slots)
    provideConversation(b.ctx)
    await b.ctx.plugin({
      inject: [...inject, 'conversation', 'sessions', 'workspaces'],
      apply,
    }).await()

    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.runtimeProfile')[0]?.component)
      .toBe(RuntimeProfileSeat)
    const injectSeat: () => RuntimeProfileSeatInjected =
      b.slots.entries('conversation.hero.runtimeProfile')[0]!.inject as never
    const seat = injectSeat()
    await seat.load()
    expect(seat.hooks.runtimeProfiles.getSnapshot().profiles).toHaveLength(1)
    expect(b.describeDocument).not.toHaveBeenCalled()
  })

  it('creates and opens a new Session in the current Workspace when a profile is selected', async () => {
    const b = await bench(true)
    declare(b.slots)
    declareConversation(b.slots)
    const sessions = provideConversation(b.ctx)
    const fiber = b.ctx.plugin({
      inject: [...inject, 'conversation', 'sessions', 'workspaces'],
      apply,
    })
    await fiber.await()

    const injectSeat: () => RuntimeProfileSeatInjected =
      b.slots.entries('conversation.hero.runtimeProfile')[0]!.inject as never
    const seat = injectSeat()
    await seat.select('native')
    expect(sessions.create).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      runtimeProfile: 'native',
    })
    expect(sessions.open).toHaveBeenCalledWith('created')
    const labelEntry = b.slots.entries('conversation.session.header.actions')[0]!
    expect(labelEntry).toMatchObject({
      component: RuntimeProfileLabel,
      options: { id: 'runtime-profile', order: -9 },
    })
    const injectLabel: () => RuntimeProfileSeatInjected = labelEntry.inject as never
    await injectLabel().load()

    sessions.sessionList.set({
      ...sessions.sessionList.getSnapshot(),
      current: undefined,
    })
    await seat.select('native')
    expect(sessions.create).toHaveBeenLastCalledWith({
      workspaceId: 'workspace',
      runtimeProfile: 'native',
    })

    sessions.sessionList.set({
      ...sessions.sessionList.getSnapshot(),
      current: 'missing',
    })
    await seat.select('native')
    expect(sessions.create).toHaveBeenLastCalledWith({
      workspaceId: 'workspace',
      runtimeProfile: 'native',
    })

    sessions.sessionList.set({
      ...sessions.sessionList.getSnapshot(),
      current: undefined,
    })
    sessions.workspaceList.set({
      ...sessions.workspaceList.getSnapshot(),
      recentWorkspaceId: undefined,
    })
    await seat.select('native')
    expect(sessions.create).toHaveBeenLastCalledWith({
      runtimeProfile: 'native',
    })

    await fiber.dispose()
    expect(b.slots.entries('conversation.hero.runtimeProfile')).toHaveLength(0)
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(b.slots.entries('settings.section')).toHaveLength(0)
  })
})
