/** The package node half and its explained empty invariant companion. */

import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RuntimeProfileInvariant from '@deepseek-ai/dsh-client-ui-runtime-profile/invariant'
import { describe, expect, it } from 'vitest'

describe('invariant companion', () => {
  it('reserves package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(RuntimeProfileInvariant).await()).resolves.toBeDefined()
  })

  it('has an empty node half', async () => {
    const { apply } = await import('@deepseek-ai/dsh-client-ui-runtime-profile')

    apply()

    expect(typeof apply).toBe('function')
  })
})
