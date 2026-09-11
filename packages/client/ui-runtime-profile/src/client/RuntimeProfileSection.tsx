/** Trusted Runtime Profile and one-shot route editor. */

import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  RuntimeProfileConfigView,
  RuntimeSubagentRouteView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RuntimeProfileState } from './controller.ts'
import css from './RuntimeProfileSection.module.css'

/** Settings-page actions supplied by the browser plugin. */
export interface RuntimeProfileSectionInjected {
  hooks: { runtimeProfiles: SnapshotStore<RuntimeProfileState> }
  load: () => Promise<void>
  saveProfile: (id: string, profile: RuntimeProfileConfigView) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  setDefault: (id: string) => Promise<void>
  saveRoute: (id: string, route: RuntimeSubagentRouteView) => Promise<void>
  removeRoute: (id: string) => Promise<void>
  probe: (id: string) => Promise<void>
}

export type RuntimeProfileSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.runtimeProfile'>
  & InjectFace<RuntimeProfileSectionInjected>

interface ProfileDraft {
  id: string
  provider: string
  schemaVersion: number
  providerOptionsVersion: number
  executable: string
  args: string
  resolution: 'absolute' | 'search-path'
  searchPath: string
  cwdPolicy: 'session-workspace' | 'parent-workspace' | 'fixed'
  fixedCwd: string
  model: string
  allowModelOverride: boolean
  enforcement: 'required' | 'best-effort'
  providerOptions: string
  product: string
  permissionPolicy: string
  ambientEnv: string
  literalEnv: string
  nativeTools: string
  harnessTransport: 'none' | 'mcp'
  harnessTools: string
  credentials: string
  startupTimeoutMs: number
  turnTimeoutMs: number
  shutdownTimeoutMs: number
  terminationTimeoutMs: number
  maxConcurrentRuns: number
}

function lines(value: readonly string[] | undefined): string {
  return (value ?? []).join('\n')
}

function entries(value: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(value ?? {}).map(([key, entry]) => `${key}=${entry}`).join('\n')
}

function draftOf(id: string, profile?: RuntimeProfileConfigView): ProfileDraft {
  const resolution = profile?.launch.resolution
  const cwd = profile?.launch.cwdPolicy
  return {
    id,
    provider: profile?.provider ?? '',
    schemaVersion: profile?.schemaVersion ?? 0,
    providerOptionsVersion: profile?.providerOptionsVersion ?? 0,
    executable: profile?.launch.executable ?? '',
    args: lines(profile?.launch.args),
    resolution: resolution === 'absolute' ? 'absolute' : 'search-path',
    searchPath: typeof resolution === 'object' ? lines(resolution.searchPath) : '',
    cwdPolicy: typeof cwd === 'object' ? 'fixed' : cwd ?? 'session-workspace',
    fixedCwd: typeof cwd === 'object' ? cwd.fixed : '',
    model: profile?.model?.default ?? '',
    allowModelOverride: profile?.model?.allowSessionOverride ?? false,
    enforcement: profile?.permissions.enforcement ?? 'best-effort',
    providerOptions: JSON.stringify(profile?.providerOptions ?? {}, null, 2),
    product: JSON.stringify(profile?.product ?? {}, null, 2),
    permissionPolicy: JSON.stringify(profile?.permissions.policy ?? {}, null, 2),
    ambientEnv: lines(profile?.launch.ambientEnv),
    literalEnv: entries(profile?.launch.env),
    nativeTools: lines(profile?.nativeTools?.allowed),
    harnessTransport: profile?.harnessTools?.transport ?? 'none',
    harnessTools: lines(profile?.harnessTools?.allowed),
    credentials: Object.entries(profile?.credentials?.env ?? {})
      .map(([target, value]) => `${target}=${value.credentialRef}`).join('\n'),
    startupTimeoutMs: profile?.process.startupTimeoutMs ?? 15_000,
    turnTimeoutMs: profile?.process.turnTimeoutMs ?? 1_800_000,
    shutdownTimeoutMs: profile?.process.shutdownTimeoutMs ?? 5_000,
    terminationTimeoutMs: profile?.process.terminationTimeoutMs ?? 5_000,
    maxConcurrentRuns: profile?.process.maxConcurrentRuns ?? 1,
  }
}

function listOf(value: string): string[] {
  return value.split('\n').map(entry => entry.trim()).filter(Boolean)
}

function mapOf(value: string): Record<string, string> {
  return Object.fromEntries(listOf(value).map((line) => {
    const at = line.indexOf('=')
    if (at <= 0) throw new Error(`Expected NAME=value, received "${line}"`)
    return [line.slice(0, at).trim(), line.slice(at + 1)]
  }))
}

function jsonObject(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

function profileOf(draft: ProfileDraft): RuntimeProfileConfigView {
  const credentials = mapOf(draft.credentials)
  return {
    provider: draft.provider.trim(),
    schemaVersion: draft.schemaVersion,
    providerOptionsVersion: draft.providerOptionsVersion,
    launch: {
      executable: draft.executable.trim(),
      args: listOf(draft.args),
      resolution: draft.resolution === 'absolute'
        ? 'absolute'
        : { searchPath: listOf(draft.searchPath) },
      cwdPolicy: draft.cwdPolicy === 'fixed'
        ? { fixed: draft.fixedCwd.trim() }
        : draft.cwdPolicy,
      ambientEnv: listOf(draft.ambientEnv),
      env: mapOf(draft.literalEnv),
    },
    model: {
      ...(draft.model.trim() === '' ? {} : { default: draft.model.trim() }),
      allowSessionOverride: draft.allowModelOverride,
    },
    providerOptions: jsonObject(draft.providerOptions, 'Provider options'),
    product: jsonObject(draft.product, 'Product configuration'),
    permissions: {
      policy: jsonObject(draft.permissionPolicy, 'Permission policy'),
      enforcement: draft.enforcement,
      approval: 'unattended-fail-closed',
    },
    nativeTools: { allowed: listOf(draft.nativeTools) },
    harnessTools: {
      transport: draft.harnessTransport,
      allowed: listOf(draft.harnessTools),
    },
    credentials: {
      env: Object.fromEntries(Object.entries(credentials).map(
        ([target, credentialRef]) => [target, { credentialRef }],
      )),
    },
    process: {
      startupTimeoutMs: draft.startupTimeoutMs,
      turnTimeoutMs: draft.turnTimeoutMs,
      shutdownTimeoutMs: draft.shutdownTimeoutMs,
      terminationTimeoutMs: draft.terminationTimeoutMs,
      maxConcurrentRuns: draft.maxConcurrentRuns,
    },
  }
}

function Field(props: {
  label: string
  value: string | number
  disabled: boolean
  type?: 'text' | 'number'
  onChange: (value: string) => void
}) {
  return (
    <label className={css.field}>
      <span>{props.label}</span>
      <input
        value={props.value}
        disabled={props.disabled}
        type={props.type ?? 'text'}
        onChange={(event) => {
          props.onChange(event.target.value)
        }}
      />
    </label>
  )
}

function TextField(props: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className={css.field}>
      <span>{props.label}</span>
      <textarea
        value={props.value}
        disabled={props.disabled}
        rows={3}
        onChange={(event) => {
          props.onChange(event.target.value)
        }}
      />
    </label>
  )
}

/** Render the dedicated profile and route settings page. */
export function RuntimeProfileSection(props: RuntimeProfileSectionProps) {
  const state = props.useRuntimeProfiles(snapshot => snapshot)
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(''))
  const [formError, setFormError] = useState<string | null>(null)
  const document = state.document

  useEffect(() => {
    void props.load()
  }, [props.load])

  useEffect(() => {
    if (document === null) return
    setSelected((current) => {
      const id = current !== '' && document.profiles[current] !== undefined
        ? current
        : document.defaultMainProfile
      setDraft(draftOf(id, document.profiles[id]))
      return id
    })
  }, [document])

  const disabled = document?.writable !== true || state.busy !== null
  const probe = state.probes[draft.id]
  const credentialState = document?.credentialStatus[draft.id] ?? {}
  const profileIds = useMemo(() => Object.keys(document?.profiles ?? {}), [document])

  if (document === null) {
    return (
      <div className={css.section}>
        <h2>{props.t('nav')}</h2>
        <p role={state.error === null ? undefined : 'alert'}>
          {state.error ?? props.t('loading')}
        </p>
        <Button onClick={() => { void props.load() }}>{props.t('retry')}</Button>
      </div>
    )
  }

  const update = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]): void => {
    setDraft(current => ({ ...current, [key]: value }))
    setFormError(null)
  }
  const save = (): void => {
    try {
      void props.saveProfile(draft.id.trim(), profileOf(draft))
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={css.section}>
      <header className={css.heading}>
        <div>
          <h2>{props.t('nav')}</h2>
          <p>{props.t('intro')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<IconPlusOutline16 />}
          disabled={disabled}
          onClick={() => {
            setSelected('')
            setDraft(draftOf(''))
          }}
        >
          {props.t('newProfile')}
        </Button>
      </header>
      {document.writable ? null : <p className={css.notice}>{props.t('readOnly')}</p>}
      {state.error === null && formError === null
        ? null
        : <p className={css.error} role="alert">{formError ?? state.error}</p>}
      <div className={css.body}>
        <nav className={css.list} aria-label={props.t('profiles')}>
          {profileIds.map(id => (
            <button
              type="button"
              key={id}
              className={id === selected ? css.selected : undefined}
              onClick={() => {
                setSelected(id)
                setDraft(draftOf(id, document.profiles[id]))
              }}
            >
              <span>{id}</span>
              <small>{document.profiles[id]?.provider}</small>
            </button>
          ))}
        </nav>
        <form className={css.editor} onSubmit={(event) => {
          event.preventDefault()
          save()
        }}>
          <div className={css.grid}>
            <Field label={props.t('profileId')} value={draft.id} disabled={disabled || selected !== ''} onChange={(value) => { update('id', value) }} />
            <Field label={props.t('provider')} value={draft.provider} disabled={disabled} onChange={(value) => { update('provider', value) }} />
            <Field label={props.t('schemaVersion')} type="number" value={draft.schemaVersion} disabled={disabled} onChange={(value) => { update('schemaVersion', Number(value)) }} />
            <Field label={props.t('providerOptionsVersion')} type="number" value={draft.providerOptionsVersion} disabled={disabled} onChange={(value) => { update('providerOptionsVersion', Number(value)) }} />
            <Field label={props.t('executable')} value={draft.executable} disabled={disabled} onChange={(value) => { update('executable', value) }} />
            <Field label={props.t('model')} value={draft.model} disabled={disabled} onChange={(value) => { update('model', value) }} />
            <label className={css.checkbox}>
              <input type="checkbox" checked={draft.allowModelOverride} disabled={disabled} onChange={(event) => { update('allowModelOverride', event.target.checked) }} />
              <span>{props.t('allowModelOverride')}</span>
            </label>
            <label className={css.field}>
              <span>{props.t('resolution')}</span>
              <select disabled={disabled} value={draft.resolution} onChange={(event) => { update('resolution', event.target.value as ProfileDraft['resolution']) }}>
                <option value="absolute">{props.t('absolute')}</option>
                <option value="search-path">{props.t('searchPath')}</option>
              </select>
            </label>
            <label className={css.field}>
              <span>{props.t('cwdPolicy')}</span>
              <select disabled={disabled} value={draft.cwdPolicy} onChange={(event) => { update('cwdPolicy', event.target.value as ProfileDraft['cwdPolicy']) }}>
                <option value="session-workspace">session-workspace</option>
                <option value="parent-workspace">parent-workspace</option>
                <option value="fixed">fixed</option>
              </select>
            </label>
            <label className={css.field}>
              <span>{props.t('enforcement')}</span>
              <select disabled={disabled} value={draft.enforcement} onChange={(event) => { update('enforcement', event.target.value as ProfileDraft['enforcement']) }}>
                <option value="required">required</option>
                <option value="best-effort">best-effort</option>
              </select>
            </label>
            <label className={css.field}>
              <span>{props.t('harnessTransport')}</span>
              <select disabled={disabled} value={draft.harnessTransport} onChange={(event) => { update('harnessTransport', event.target.value as ProfileDraft['harnessTransport']) }}>
                <option value="none">none</option>
                <option value="mcp">mcp</option>
              </select>
            </label>
            {draft.resolution === 'search-path'
              ? <TextField label={props.t('searchPath')} value={draft.searchPath} disabled={disabled} onChange={(value) => { update('searchPath', value) }} />
              : null}
            {draft.cwdPolicy === 'fixed'
              ? <Field label={props.t('fixedCwd')} value={draft.fixedCwd} disabled={disabled} onChange={(value) => { update('fixedCwd', value) }} />
              : null}
            <TextField label={props.t('args')} value={draft.args} disabled={disabled} onChange={(value) => { update('args', value) }} />
            <TextField label={props.t('ambientEnv')} value={draft.ambientEnv} disabled={disabled} onChange={(value) => { update('ambientEnv', value) }} />
            <TextField label={props.t('literalEnv')} value={draft.literalEnv} disabled={disabled} onChange={(value) => { update('literalEnv', value) }} />
            <TextField label={props.t('credentials')} value={draft.credentials} disabled={disabled} onChange={(value) => { update('credentials', value) }} />
            <TextField label={props.t('nativeTools')} value={draft.nativeTools} disabled={disabled} onChange={(value) => { update('nativeTools', value) }} />
            <TextField label={props.t('harnessTools')} value={draft.harnessTools} disabled={disabled} onChange={(value) => { update('harnessTools', value) }} />
            <TextField label={props.t('providerOptions')} value={draft.providerOptions} disabled={disabled} onChange={(value) => { update('providerOptions', value) }} />
            <TextField label={props.t('product')} value={draft.product} disabled={disabled} onChange={(value) => { update('product', value) }} />
            <TextField label={props.t('permissionPolicy')} value={draft.permissionPolicy} disabled={disabled} onChange={(value) => { update('permissionPolicy', value) }} />
            {([
              ['startupTimeoutMs', 'startupTimeout'],
              ['turnTimeoutMs', 'turnTimeout'],
              ['shutdownTimeoutMs', 'shutdownTimeout'],
              ['terminationTimeoutMs', 'terminationTimeout'],
              ['maxConcurrentRuns', 'capacity'],
            ] as const).map(([key, label]) => (
              <Field
                key={key}
                type="number"
                label={props.t(label)}
                value={draft[key]}
                disabled={disabled}
                onChange={(value) => { update(key, Number(value)) }}
              />
            ))}
          </div>
          {Object.keys(credentialState).length === 0 ? null : (
            <p className={css.meta}>
              {Object.entries(credentialState).map(([target, configured]) =>
                `${target}: ${configured === null
                  ? props.t('credentialUnknown')
                  : configured ? props.t('credentialReady') : props.t('credentialMissing')}`).join(' · ')}
            </p>
          )}
          <div className={css.actions}>
            <Button type="submit" variant="primary" disabled={disabled || draft.id.trim() === ''}>
              {props.t('save')}
            </Button>
            <Button
              variant="outline"
              icon={<IconRefreshOutline16 />}
              disabled={state.busy !== null || selected === ''}
              onClick={() => { void props.probe(selected) }}
            >
              {props.t('probe')}
            </Button>
            {selected !== '' && selected !== document.defaultMainProfile ? (
              <>
                <Button variant="outline" disabled={disabled} onClick={() => { void props.setDefault(selected) }}>
                  {props.t('setDefault')}
                </Button>
                <Button variant="ghost" icon={<IconTrashOutline16 />} disabled={disabled} onClick={() => { void props.removeProfile(selected) }}>
                  {props.t('delete')}
                </Button>
              </>
            ) : null}
          </div>
          {probe === undefined ? null : (
            <pre className={typeof probe === 'string' ? css.error : css.probe}>
              {typeof probe === 'string'
                ? probe
                : JSON.stringify({
                  productVersion: probe.productVersion,
                  protocolVersion: probe.protocolVersion,
                  permissionEnforcement: probe.permissionEnforcement,
                  capabilities: probe.capabilities.map(capability => capability.id),
                }, null, 2)}
            </pre>
          )}
        </form>
      </div>
      <section className={css.routes}>
        <h3>{props.t('routes')}</h3>
        {Object.entries(document.subagentRoutes).map(([id, route]) => (
          <RouteEditor
            key={id}
            id={id}
            route={route}
            profiles={profileIds}
            disabled={disabled}
            labels={props.t}
            onSave={props.saveRoute}
            onRemove={props.removeRoute}
          />
        ))}
        <RouteEditor
          id=""
          profiles={profileIds}
          disabled={disabled}
          labels={props.t}
          onSave={props.saveRoute}
          onRemove={props.removeRoute}
        />
      </section>
    </div>
  )
}

function RouteEditor(props: {
  id: string
  route?: RuntimeSubagentRouteView
  profiles: string[]
  disabled: boolean
  labels: RuntimeProfileSectionProps['t']
  onSave: RuntimeProfileSectionInjected['saveRoute']
  onRemove: RuntimeProfileSectionInjected['removeRoute']
}) {
  const [id, setId] = useState(props.id)
  const [profile, setProfile] = useState(props.route?.runtimeProfile ?? props.profiles[0] ?? '')
  const [toolName, setToolName] = useState(props.route?.toolName ?? '')
  const [maxDepth, setMaxDepth] = useState(props.route?.maxDepth ?? 2)
  const [capacity, setCapacity] = useState(props.route?.maxConcurrentRuns ?? 1)
  const existing = props.id !== ''
  return (
    <div className={css.route}>
      <Field label={props.labels('routeId')} value={id} disabled={props.disabled || existing} onChange={setId} />
      <label className={css.field}>
        <span>{props.labels('runtimeProfile')}</span>
        <select disabled={props.disabled} value={profile} onChange={(event) => { setProfile(event.target.value) }}>
          {props.profiles.map(profileId => <option key={profileId} value={profileId}>{profileId}</option>)}
        </select>
      </label>
      <Field label={props.labels('toolName')} value={toolName} disabled={props.disabled} onChange={setToolName} />
      <Field label={props.labels('maxDepth')} type="number" value={maxDepth} disabled={props.disabled} onChange={(value) => { setMaxDepth(Number(value)) }} />
      <Field label={props.labels('capacity')} type="number" value={capacity} disabled={props.disabled} onChange={(value) => { setCapacity(Number(value)) }} />
      <div className={css.actions}>
        <Button
          size="sm"
          disabled={props.disabled || id.trim() === '' || profile === '' || toolName.trim() === ''}
          onClick={() => { void props.onSave(id.trim(), {
            runtimeProfile: profile,
            mode: 'one-shot',
            maxDepth,
            maxConcurrentRuns: capacity,
            toolName: toolName.trim(),
          }) }}
        >
          {props.labels('save')}
        </Button>
        {existing ? (
          <Button size="sm" variant="ghost" icon={<IconTrashOutline16 />} disabled={props.disabled} onClick={() => { void props.onRemove(id) }}>
            {props.labels('delete')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
