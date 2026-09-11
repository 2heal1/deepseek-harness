/** Session creation behavior of the shared client test runtime. */

import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import { TestSessions } from '../src/sessions.ts'

const stabilize = async (operation: () => void | Promise<void>): Promise<void> => {
  await operation()
}

describe('TestSessions.create', () => {
  it('creates unselected sessions with generated or caller-owned identity and metadata', async () => {
    const sessions = new TestSessions(stabilize, new Context())

    const generated = await sessions.create()
    const explicit = await sessions.create({
      sessionId: 'chosen' as SessionId,
      cwd: '/workspace',
      runtimeProfile: 'external',
    })

    expect(generated).toBe('test-created-1')
    expect(explicit).toBe('chosen')
    expect(sessions.list.getSnapshot()).toMatchObject({
      current: undefined,
      ids: ['test-created-1', 'chosen'],
      byId: {
        'test-created-1': { blank: true },
        chosen: {
          blank: true,
          cwd: '/workspace',
          runtimeProfile: 'external',
        },
      },
    })
    expect(sessions.calls).toEqual([
      { method: 'create', args: [{}] },
      {
        method: 'create',
        args: [{
          sessionId: 'chosen',
          cwd: '/workspace',
          runtimeProfile: 'external',
        }],
      },
    ])
  })
})
