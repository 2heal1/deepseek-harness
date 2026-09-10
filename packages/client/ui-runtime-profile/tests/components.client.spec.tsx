// @vitest-environment jsdom
/** Runtime Profile selector, fixed label, editor fields, disabled states, and actions. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { RuntimeProfileDocumentView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RuntimeProfileState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import {
  RuntimeProfileLabel,
  RuntimeProfileSeat,
  type RuntimeProfileLabelProps,
  type RuntimeProfileSeatProps,
} from '../src/client/RuntimeProfileSeat.tsx'
import {
  RuntimeProfileSection,
  type RuntimeProfileSectionInjected,
  type RuntimeProfileSectionProps,
} from '../src/client/RuntimeProfileSection.tsx'

afterEach(cleanup)

const PROFILE = {
  provider: 'external',
  schemaVersion: 0,
  providerOptionsVersion: 0,
  providerOptions: { effort: 'high' },
  launch: {
    executable: '/usr/bin/external',
    args: ['serve'],
    resolution: 'absolute' as const,
    cwdPolicy: 'session-workspace' as const,
    ambientEnv: ['LANG'],
    env: { LOG_LEVEL: 'info' },
  },
  model: { default: 'model-a', allowSessionOverride: true },
  product: { profile: 'work' },
  permissions: {
    policy: { sandbox: 'workspace' },
    enforcement: 'required' as const,
    approval: 'unattended-fail-closed' as const,
  },
  nativeTools: { allowed: ['filesystem'] },
  harnessTools: { transport: 'mcp' as const, allowed: ['todo_write'] },
  credentials: { env: { API_KEY: { credentialRef: 'EXTERNAL_KEY' } } },
  process: {
    startupTimeoutMs: 10,
    turnTimeoutMs: 20,
    shutdownTimeoutMs: 30,
    terminationTimeoutMs: 40,
    maxConcurrentRuns: 2,
  },
}

function document(writable = true): RuntimeProfileDocumentView {
  return {
    revision: 3,
    writable,
    defaultMainProfile: 'main',
    profiles: {
      main: PROFILE,
      other: { ...PROFILE, provider: 'missing' },
    },
    subagentRoutes: {
      child: {
        runtimeProfile: 'main',
        mode: 'one-shot',
        maxDepth: 2,
        maxConcurrentRuns: 1,
        toolName: 'delegate_child',
      },
    },
    credentialStatus: {
      main: { API_KEY: true, MISSING: false, UNKNOWN: null },
      other: { API_KEY: false },
    },
  }
}

function state(overrides: Partial<RuntimeProfileState> = {}): RuntimeProfileState {
  return {
    status: 'ready',
    profiles: [
      {
        id: 'main',
        provider: 'external',
        model: 'model-a',
        isDefault: true,
        providerAvailable: true,
        schemaCompatible: true,
      },
      {
        id: 'other',
        provider: 'missing',
        isDefault: false,
        providerAvailable: false,
        schemaCompatible: false,
      },
      {
        id: 'incompatible',
        provider: 'external',
        isDefault: false,
        providerAvailable: true,
        schemaCompatible: false,
      },
    ],
    routes: [],
    document: document(),
    probes: {},
    busy: null,
    error: null,
    ...overrides,
  }
}

const t = (key: keyof typeof en): string => en[key]

describe('RuntimeProfileSeat and RuntimeProfileLabel', () => {
  it('loads the catalog, disables unavailable choices, and selects a usable profile', async () => {
    const runtime = createSnapshotStore(state())
    const sessions = createSnapshotStore<{
      current: string | undefined
      byId: Record<string, { runtimeProfile?: string }>
    }>({
      current: undefined,
      byId: {},
    })
    const load = vi.fn(() => Promise.resolve())
    const select = vi.fn(() => Promise.resolve())
    render(<RuntimeProfileSeat {...({
      load,
      select,
      useRuntimeProfiles: bindSnapshotSelector(runtime),
      useSessions: bindSnapshotSelector(sessions),
      t,
    } as unknown as RuntimeProfileSeatProps)} />)

    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(screen.getByRole('button').textContent).toContain('main · model-a')
    fireEvent.click(screen.getByRole('button'))
    const unavailable = screen.getByText('other · missing').closest('[role="menuitem"]')
      ?? screen.getByText('other · missing').closest('button')
    expect((unavailable as HTMLButtonElement | null)?.disabled).toBe(true)
    expect(screen.getByText(en.schemaIncompatible)).toBeTruthy()
    fireEvent.click(screen.getAllByText('main · model-a')[1]!)
    expect(select).toHaveBeenCalledWith('main')
  })

  it('shows fallback identity and loading or error state while the menu toggles', async () => {
    const runtime = createSnapshotStore(state({
      status: 'loading',
      error: 'catalog pending',
      profiles: [{
        id: 'fallback',
        provider: 'native',
        isDefault: false,
        providerAvailable: true,
        schemaCompatible: true,
      }],
    }))
    const sessions = createSnapshotStore<{
      current: string | undefined
      byId: Record<string, { runtimeProfile?: string }>
    }>({
      current: 'missing',
      byId: {},
    })
    const view = render(<RuntimeProfileSeat {...({
      load: () => Promise.resolve(),
      select: () => Promise.resolve(),
      useRuntimeProfiles: bindSnapshotSelector(runtime),
      useSessions: bindSnapshotSelector(sessions),
      t,
    } as unknown as RuntimeProfileSeatProps)} />)
    const button = screen.getByRole<HTMLButtonElement>('button')
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('catalog pending')
    expect(button.textContent).toContain('fallback · native')

    await act(async () => {
      runtime.set({ ...runtime.getSnapshot(), status: 'ready', error: null })
    })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(window.document, { key: 'Escape' })
    await waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })

    sessions.set({
      current: 's1',
      byId: { s1: { runtimeProfile: 'unknown' } },
    })
    await waitFor(() => { expect(button.textContent).toContain('unknown') })
    expect(view.container.textContent).toContain('unknown')
  })

  it('uses the Session Header identity for the trigger and read-only label', async () => {
    const runtime = createSnapshotStore(state())
    const sessions = createSnapshotStore<{
      current: string | undefined
      byId: Record<string, { runtimeProfile?: string }>
    }>({
      current: 's1',
      byId: { s1: { runtimeProfile: 'main' } },
    })
    const load = vi.fn(() => Promise.resolve())
    const { rerender } = render(<RuntimeProfileLabel {...({
      sessionId: 's1',
      load,
      useRuntimeProfiles: bindSnapshotSelector(runtime),
      useSessions: bindSnapshotSelector(sessions),
      t,
    } as unknown as RuntimeProfileLabelProps)} />)
    expect(screen.getByText('main · model-a').closest('span[title]')?.getAttribute('title'))
      .toBe(en.headerHint)
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })

    sessions.set({ current: 's1', byId: { s1: {} } })
    rerender(<RuntimeProfileLabel {...({
      sessionId: 's1',
      load,
      useRuntimeProfiles: bindSnapshotSelector(runtime),
      useSessions: bindSnapshotSelector(sessions),
      t,
    } as unknown as RuntimeProfileLabelProps)} />)
    expect(screen.queryByTitle(en.headerHint)).toBeNull()
  })

  it('renders no selector without a safe catalog', () => {
    const runtime = createSnapshotStore(state({ profiles: [] }))
    const sessions = createSnapshotStore({ current: undefined, byId: {} })
    const view = render(<RuntimeProfileSeat {...({
      load: () => Promise.resolve(),
      select: () => Promise.resolve(),
      useRuntimeProfiles: bindSnapshotSelector(runtime),
      useSessions: bindSnapshotSelector(sessions),
      t,
    } as unknown as RuntimeProfileSeatProps)} />)
    expect(view.container.innerHTML).toBe('')
  })
})

function renderSection(snapshot: RuntimeProfileState) {
  const store = createSnapshotStore(snapshot)
  const actions = {
    load: vi.fn<RuntimeProfileSectionInjected['load']>(() => Promise.resolve()),
    saveProfile: vi.fn<RuntimeProfileSectionInjected['saveProfile']>(() => Promise.resolve()),
    removeProfile: vi.fn<RuntimeProfileSectionInjected['removeProfile']>(() => Promise.resolve()),
    setDefault: vi.fn<RuntimeProfileSectionInjected['setDefault']>(() => Promise.resolve()),
    saveRoute: vi.fn<RuntimeProfileSectionInjected['saveRoute']>(() => Promise.resolve()),
    removeRoute: vi.fn<RuntimeProfileSectionInjected['removeRoute']>(() => Promise.resolve()),
    probe: vi.fn<RuntimeProfileSectionInjected['probe']>(() => Promise.resolve()),
  }
  render(<RuntimeProfileSection {...({
    ...actions,
    useRuntimeProfiles: bindSnapshotSelector(store),
    t,
  } as unknown as RuntimeProfileSectionProps)} />)
  return { store, actions }
}

describe('RuntimeProfileSection', () => {
  it('shows load failure with a retry action', async () => {
    const { actions } = renderSection(state({
      status: 'error',
      document: null,
      error: 'document unavailable',
    }))
    expect(screen.getByRole('alert').textContent).toContain('document unavailable')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(2) })
  })

  it('shows loading text before the trusted document arrives', () => {
    renderSection(state({ status: 'loading', document: null }))
    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('renders a read-only document with every write control disabled', async () => {
    renderSection(state({ document: document(false) }))
    await screen.findByLabelText(en.profileId)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.newProfile }).disabled)
      .toBe(true)
    expect((screen.getAllByRole('button', { name: en.save })[0] as HTMLButtonElement).disabled)
      .toBe(true)
    for (const button of screen.getAllByRole('button', { name: en.delete })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('loads search-path and fixed-directory profile values', async () => {
    const configured = document()
    configured.profiles.main = {
      ...PROFILE,
      launch: {
        ...PROFILE.launch,
        resolution: { searchPath: ['/opt/bin'] },
        cwdPolicy: { fixed: '/opt/workspace' },
      },
    }
    renderSection(state({ document: configured }))
    await screen.findByLabelText(en.profileId)
    expect(screen.getByLabelText<HTMLTextAreaElement>(en.searchPath).value).toBe('/opt/bin')
    expect(screen.getByLabelText<HTMLInputElement>(en.fixedCwd).value).toBe('/opt/workspace')
  })

  it('edits, saves, probes, defaults, and removes an existing profile', async () => {
    const { store, actions } = renderSection(state())
    await screen.findByLabelText(en.profileId)
    expect(screen.getByText(new RegExp(`API_KEY: ${en.credentialReady}`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`MISSING: ${en.credentialMissing}`))).toBeTruthy()
    expect(screen.getByText(new RegExp(`UNKNOWN: ${en.credentialUnknown}`))).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'model-b' } })
    fireEvent.change(screen.getByLabelText(en.resolution), { target: { value: 'search-path' } })
    fireEvent.change(screen.getByLabelText(en.searchPath), { target: { value: '/bin\n/usr/bin' } })
    fireEvent.change(screen.getByLabelText(en.cwdPolicy), { target: { value: 'fixed' } })
    fireEvent.change(screen.getByLabelText(en.fixedCwd), { target: { value: '/workspace' } })
    fireEvent.click(screen.getByLabelText(en.allowModelOverride))
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)

    expect(actions.saveProfile).toHaveBeenCalledOnce()
    const savedProfile = actions.saveProfile.mock.calls[0]?.[1]
    expect(savedProfile?.model).toEqual({ default: 'model-b', allowSessionOverride: false })
    expect(savedProfile?.launch.resolution).toEqual({ searchPath: ['/bin', '/usr/bin'] })
    expect(savedProfile?.launch.cwdPolicy).toEqual({ fixed: '/workspace' })

    fireEvent.click(within(screen.getByRole('navigation')).getByText('other'))
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(en.profileId).value).toBe('other')
    })
    fireEvent.click(screen.getByRole('button', { name: en.probe }))
    fireEvent.click(screen.getByRole('button', { name: en.setDefault }))
    fireEvent.click(screen.getAllByRole('button', { name: en.delete })[0]!)
    expect(actions.probe).toHaveBeenCalledWith('other')
    expect(actions.setDefault).toHaveBeenCalledWith('other')
    expect(actions.removeProfile).toHaveBeenCalledWith('other')

    await act(async () => {
      store.set({
        ...store.getSnapshot(),
        probes: {
          other: {
            productVersion: '2',
            protocolVersion: 'v2',
            capabilities: [{ id: 'runtimeActivity' }],
            permissionEnforcement: 'best-effort',
          },
        },
      })
    })
    await waitFor(() => {
      expect(screen.getByText(/"productVersion": "2"/)).toBeTruthy()
    })
    await act(async () => {
      store.set({
        ...store.getSnapshot(),
        document: { ...document(), revision: 4 },
        probes: { other: 'probe unavailable' },
      })
    })
    await waitFor(() => {
      expect(screen.getByText('probe unavailable')).toBeTruthy()
      expect(screen.getByLabelText<HTMLInputElement>(en.profileId).value).toBe('other')
    })
  })

  it('creates a profile, validates text formats, and operates route rows', async () => {
    const { actions } = renderSection(state())
    await screen.findByLabelText(en.profileId)
    fireEvent.click(screen.getByRole('button', { name: en.newProfile }))
    fireEvent.change(screen.getByLabelText(en.profileId), { target: { value: 'new-profile' } })
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'external' } })
    fireEvent.change(screen.getByLabelText(en.schemaVersion), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(en.providerOptionsVersion), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(en.executable), { target: { value: 'external' } })
    fireEvent.change(screen.getByLabelText(en.resolution), { target: { value: 'absolute' } })
    fireEvent.change(screen.getByLabelText(en.cwdPolicy), { target: { value: 'parent-workspace' } })
    fireEvent.change(screen.getByLabelText(en.enforcement), { target: { value: 'required' } })
    fireEvent.change(screen.getByLabelText(en.harnessTransport), { target: { value: 'mcp' } })
    fireEvent.change(screen.getByLabelText(en.args), { target: { value: '--stdio\n--verbose' } })
    fireEvent.change(screen.getByLabelText(en.ambientEnv), { target: { value: 'LANG\nTERM' } })
    fireEvent.change(screen.getByLabelText(en.credentials), { target: { value: 'API_KEY=secret-ref' } })
    fireEvent.change(screen.getByLabelText(en.nativeTools), { target: { value: 'filesystem' } })
    fireEvent.change(screen.getByLabelText(en.harnessTools), { target: { value: 'todo_write' } })
    fireEvent.change(screen.getByLabelText(en.product), { target: { value: '{"profile":"test"}' } })
    fireEvent.change(screen.getByLabelText(en.permissionPolicy), { target: { value: '{"sandbox":"workspace"}' } })
    fireEvent.change(screen.getByLabelText(en.startupTimeout), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(en.turnTimeout), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText(en.shutdownTimeout), { target: { value: '300' } })
    fireEvent.change(screen.getByLabelText(en.terminationTimeout), { target: { value: '400' } })
    fireEvent.change(screen.getAllByLabelText(en.capacity)[0]!, { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(en.literalEnv), { target: { value: 'BROKEN' } })
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)
    expect(screen.getByRole('alert').textContent).toContain('Expected NAME=value')

    fireEvent.change(screen.getByLabelText(en.literalEnv), { target: { value: 'MODE=test' } })
    fireEvent.change(screen.getByLabelText(en.providerOptions), { target: { value: '{' } })
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)
    expect(screen.getByRole('alert').textContent).toContain('Provider options must be valid JSON')

    fireEvent.change(screen.getByLabelText(en.providerOptions), { target: { value: '{"mode":"test"}' } })
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)
    expect(actions.saveProfile).toHaveBeenCalledTimes(1)
    const createdProfile = actions.saveProfile.mock.calls[0]?.[1]
    expect(actions.saveProfile.mock.calls[0]?.[0]).toBe('new-profile')
    expect(createdProfile?.provider).toBe('external')
    expect(createdProfile?.schemaVersion).toBe(2)
    expect(createdProfile?.providerOptionsVersion).toBe(3)
    expect(createdProfile?.launch.args).toEqual(['--stdio', '--verbose'])
    expect(createdProfile?.launch.resolution).toBe('absolute')
    expect(createdProfile?.launch.cwdPolicy).toBe('parent-workspace')
    expect(createdProfile?.launch.env).toEqual({ MODE: 'test' })
    expect(createdProfile?.credentials?.env).toEqual({
      API_KEY: { credentialRef: 'secret-ref' },
    })
    expect(createdProfile?.providerOptions).toEqual({ mode: 'test' })
    expect(createdProfile?.process).toEqual({
      startupTimeoutMs: 100,
      turnTimeoutMs: 200,
      shutdownTimeoutMs: 300,
      terminationTimeoutMs: 400,
      maxConcurrentRuns: 5,
    })

    const routes = screen.getByRole('heading', { name: en.routes }).parentElement!
    const routeIds = within(routes).getAllByLabelText(en.routeId)
    fireEvent.click(within(routes).getAllByRole('button', { name: en.save })[0]!)
    expect(actions.saveRoute).toHaveBeenCalledWith('child', expect.objectContaining({
      runtimeProfile: 'main',
      toolName: 'delegate_child',
    }))
    fireEvent.click(within(routes).getByRole('button', { name: en.delete }))
    expect(actions.removeRoute).toHaveBeenCalledWith('child')

    fireEvent.change(routeIds[1]!, { target: { value: 'new-route' } })
    const runtimeProfiles = within(routes).getAllByLabelText(en.runtimeProfile)
    fireEvent.change(runtimeProfiles[1]!, { target: { value: 'other' } })
    const toolNames = within(routes).getAllByLabelText(en.toolName)
    fireEvent.change(toolNames[1]!, { target: { value: 'delegate_new' } })
    const maxDepths = within(routes).getAllByLabelText(en.maxDepth)
    fireEvent.change(maxDepths[1]!, { target: { value: '4' } })
    const capacities = within(routes).getAllByLabelText(en.capacity)
    fireEvent.change(capacities[1]!, { target: { value: '3' } })
    fireEvent.click(within(routes).getAllByRole('button', { name: en.save })[1]!)
    expect(actions.saveRoute).toHaveBeenCalledWith('new-route', expect.objectContaining({
      runtimeProfile: 'other',
      maxDepth: 4,
      maxConcurrentRuns: 3,
      toolName: 'delegate_new',
    }))
  })

  it('reports non-Error JSON failures and supports an empty profile catalog', async () => {
    const empty = document()
    empty.defaultMainProfile = ''
    empty.profiles = {}
    empty.subagentRoutes = {}
    empty.credentialStatus = {}
    renderSection(state({ document: empty, error: 'stale document' }))
    await screen.findByLabelText(en.profileId)
    expect(screen.getByRole('alert').textContent).toContain('stale document')

    fireEvent.change(screen.getByLabelText(en.profileId), { target: { value: 'new' } })
    const entries = vi.spyOn(Object, 'entries').mockImplementationOnce(() => {
      throw 'serialization failed'
    })
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)
    expect(screen.getByRole('alert').textContent).toContain('serialization failed')
    entries.mockRestore()
  })
})
