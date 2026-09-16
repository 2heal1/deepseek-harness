// @vitest-environment jsdom
// Assembled Activity snapshot: boots the built browser graph over the
// keyless FixtureApiClient, then pins the runtime ledger and the same
// session's durable one-shot child navigation.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasClass, installAssembledBootEnv, mountAssembledApp,
} from './assembled-boot.ts'

const EXPECTED = join(
  process.cwd(),
  'apps/web/tests/snapshots/activity-subagent-tree/activity-and-tree.expected.txt',
)

installAssembledBootEnv()

function activityShape(): string {
  const runtimeHeading = screen.getByRole('heading', { name: 'Runtime' })
  const runtime = runtimeHeading.parentElement?.parentElement
  if (runtime === null || runtime === undefined) throw new Error('runtime section missing')
  const records = [...document.querySelectorAll<HTMLLIElement>('li[data-kind]')]
    .map((row) => {
      const body = [...row.querySelectorAll<HTMLElement>('*')]
        .find(element => hasClass(element, 'record'))
      return `${row.dataset.kind}: ${body?.textContent?.replace(/\s+/g, ' ').trim() ?? '<missing>'}`
    })
  const catalog = screen.getByRole('tree', { name: 'Subagent sessions' })
  const child = within(catalog).getByRole('treeitem')
  return [
    `tabs=${screen.getAllByRole('tab').map(tab => tab.textContent).join(' | ')}`,
    `runtime=${runtime.textContent?.replace(/\s+/g, ' ').trim() ?? ''}`,
    ...records,
    `subagents=${child.textContent?.replace(/\s+/g, ' ').trim() ?? ''}`,
  ].join('\n')
}

describe('assembled Activity and subagent tree', () => {
  it('renders persisted runtime fidelity, structured failure, and child relationship', async () => {
    mountAssembledApp()

    const sessions = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(sessions).findByText('Fixture 历史会话'))
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }, { timeout: 10_000 }))
    await screen.findByText('Fixture runtime rejected a concurrent submission.')

    const trigger = await screen.findByRole('button', { name: '1 subagent' })
    fireEvent.click(trigger)
    await screen.findByRole('treeitem', { name: /Inspect fixture runtime/ })

    await waitFor(() => {
      expect(screen.getByText('partial')).toBeTruthy()
    })
    await expect(activityShape()).toMatchFileSnapshot(EXPECTED)
  })
})
