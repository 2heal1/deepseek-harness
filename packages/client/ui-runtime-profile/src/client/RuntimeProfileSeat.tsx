/** New-session Runtime Profile selector and fixed-session header label. */

import { useEffect, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconCodeOutline16,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RuntimeProfileState } from './controller.ts'
import css from './RuntimeProfileSeat.module.css'

/** Runtime Profile selector injection. */
export interface RuntimeProfileSeatInjected {
  hooks: { runtimeProfiles: SnapshotStore<RuntimeProfileState> }
  load: () => Promise<void>
  select: (id: string) => Promise<void>
}

/** Runtime Profile header-label injection. */
export interface RuntimeProfileLabelInjected {
  hooks: { runtimeProfiles: SnapshotStore<RuntimeProfileState> }
  load: () => Promise<void>
}

export type RuntimeProfileSeatProps =
  PropsRuntime<'conversation.hero.runtimeProfile'>
  & PropsLocale<'settings.runtimeProfile'>
  & InjectFace<RuntimeProfileSeatInjected>

export type RuntimeProfileLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.runtimeProfile'>
  & InjectFace<RuntimeProfileLabelInjected>

function profileLabel(
  id: string,
  profiles: RuntimeProfileState['profiles'],
): string {
  const profile = profiles.find(candidate => candidate.id === id)
  if (profile === undefined) return id
  return profile.model === undefined
    ? `${profile.id} · ${profile.provider}`
    : `${profile.id} · ${profile.model}`
}

/** Select the Provider profile before creating the next Session. */
export function RuntimeProfileSeat({
  load, select, useRuntimeProfiles, useSessions, t,
}: RuntimeProfileSeatProps) {
  const state = useRuntimeProfiles(snapshot => snapshot)
  const current = useSessions(snapshot => snapshot.current === undefined
    ? undefined
    : snapshot.byId[snapshot.current]?.runtimeProfile)
  const [open, setOpen] = useState(false)

  useEffect(() => { void load() }, [load])
  const first = state.profiles[0]
  if (first === undefined) return null
  const selected = current ?? state.profiles.find(profile => profile.isDefault)?.id
    ?? first.id

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      selectedId={selected}
      onSelect={(id) => {
        setOpen(false)
        void select(id)
      }}
      items={state.profiles.map(profile => ({
        id: profile.id,
        disabled: !profile.providerAvailable || !profile.schemaCompatible,
        label: (
          <span className={css.item}>
            <span>{profileLabel(profile.id, state.profiles)}</span>
            <span className={css.meta}>
              {!profile.providerAvailable
                ? t('providerUnavailable')
                : !profile.schemaCompatible ? t('schemaIncompatible') : profile.provider}
            </span>
          </span>
        ),
      }))}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          className={css.seat}
          aria-haspopup="menu"
          aria-expanded={open}
          title={state.error ?? t('seatHint')}
          disabled={state.status === 'loading'}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconCodeOutline16 />
          <span className={css.label}>{profileLabel(selected, state.profiles)}</span>
          <IconChevronDownOutline14 />
        </button>
      )}
    />
  )
}

/** Display the profile identity pinned in this Session's header. */
export function RuntimeProfileLabel({
  sessionId, useSessions, useRuntimeProfiles, load, t,
}: RuntimeProfileLabelProps) {
  const id = useSessions(snapshot => snapshot.byId[sessionId]?.runtimeProfile)
  const profiles = useRuntimeProfiles(snapshot => snapshot.profiles)
  useEffect(() => {
    if (id !== undefined) void load()
  }, [id, load])
  if (id === undefined) return null
  return (
    <span className={css.header} title={t('headerHint')}>
      <IconCodeOutline16 size={14} />
      {profileLabel(id, profiles)}
    </span>
  )
}
