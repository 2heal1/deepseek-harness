/** Runtime Profile browser surfaces over the safe catalog and trusted editor API. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RuntimeProfileController } from './controller.ts'
import { en, zh } from './locales.ts'
import {
  RuntimeProfileLabel,
  RuntimeProfileSeat,
  type RuntimeProfileLabelInjected,
  type RuntimeProfileSeatInjected,
} from './RuntimeProfileSeat.tsx'
import {
  RuntimeProfileSection,
  type RuntimeProfileSectionInjected,
} from './RuntimeProfileSection.tsx'

export type { RuntimeProfileState } from './controller.ts'
export {
  RuntimeProfileLabel,
  RuntimeProfileSeat,
  type RuntimeProfileLabelInjected,
  type RuntimeProfileLabelProps,
  type RuntimeProfileSeatInjected,
  type RuntimeProfileSeatProps,
} from './RuntimeProfileSeat.tsx'
export {
  RuntimeProfileSection,
  type RuntimeProfileSectionInjected,
  type RuntimeProfileSectionProps,
} from './RuntimeProfileSection.tsx'

/** Required client services. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the safe session selector and loopback-only configuration page.
 * @param ctx - browser client context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new RuntimeProfileController(connection.api)

  ctx.effect(
    () => ctx.locale.register('settings.runtimeProfile', { zh, en }),
    'ui-runtime-profile: dictionaries',
  )

  if (connection.isLoopback) {
    const sectionInjected = (): RuntimeProfileSectionInjected => ({
      hooks: { runtimeProfiles: controller.store },
      load: async () => {
        await Promise.all([controller.loadCatalog(), controller.loadDocument()])
      },
      saveProfile: (id, profile) => controller.saveProfile(id, profile),
      removeProfile: id => controller.removeProfile(id),
      setDefault: id => controller.setDefault(id),
      saveRoute: (id, route) => controller.saveRoute(id, route),
      removeRoute: id => controller.removeRoute(id),
      probe: id => controller.probe(id),
    })
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'runtime-profiles',
      order: 30,
      label: () => ctx.locale.bind('settings.runtimeProfile')('nav'),
      locale: 'settings.runtimeProfile',
      inject: sectionInjected,
    }, RuntimeProfileSection))
  }

  ctx.inject(['slots', 'conversation', 'sessions', 'workspaces'], (scope: ClientContext) => {
    const load = (): Promise<void> => controller.loadCatalog()
    const seatInjected = (): RuntimeProfileSeatInjected => ({
      hooks: { runtimeProfiles: controller.store },
      load,
      select: profileId => controller.selectProfile(async () => {
        const sessions = scope.sessions.list.getSnapshot()
        const workspaces = scope.workspaces.list.getSnapshot()
        const current = sessions.current
        const workspaceId = current === undefined
          ? workspaces.recentWorkspaceId
          : workspaces.items.find(item => item.sessionIds.includes(current))?.workspaceId
            ?? workspaces.recentWorkspaceId
        const sessionId = await scope.sessions.create({
          ...(workspaceId === undefined ? {} : { workspaceId }),
          runtimeProfile: profileId,
        })
        scope.sessions.open(sessionId)
      }),
    })
    const labelInjected = (): RuntimeProfileLabelInjected => ({
      hooks: { runtimeProfiles: controller.store },
      load,
    })

    const seat = scope.slots.register({
      name: 'conversation.hero.runtimeProfile',
      locale: 'settings.runtimeProfile',
      inject: seatInjected,
    }, RuntimeProfileSeat)
    const label = scope.slots.register({
      name: 'conversation.session.header.actions',
      id: 'runtime-profile',
      order: -9,
      locale: 'settings.runtimeProfile',
      inject: labelInjected,
    }, RuntimeProfileLabel)
    return () => {
      seat()
      label()
    }
  })
}
