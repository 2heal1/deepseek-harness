import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, {
  AgentRuntimeProviderId,
  type AgentRuntimeProvider,
} from '@deepseek-ai/dsh-agent-runtime'
import * as AgentRuntimeInvariant from '@deepseek-ai/dsh-agent-runtime/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

function provider(id: string): AgentRuntimeProvider {
  return {
    id: AgentRuntimeProviderId(id),
    profileSnapshotVersions: [0],
    async probe() {
      return { capabilities: [], permissionEnforcement: 'enforced' }
    },
    async prepare() {
      throw new Error('not used')
    },
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRuntimeRegistry)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentRuntimeInvariant)
  return ctx
}

describe('agent runtime invariants', () => {
  it('accepts registry-owned provider transitions', async () => {
    const ctx = await setup()
    const dispose = ctx.agentRuntimes.registerProvider(provider('fake'))
    expect(() => { dispose() }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects provider-added without the matching registry entry', async () => {
    const ctx = await setup()
    const fake = provider('fake')
    expect(() => { ctx.emit('agent-runtime/provider-added', fake) })
      .toThrow(/does not match registry entry "fake"/)
  })

  it('rejects provider-removed while the provider still resolves', async () => {
    const ctx = await setup()
    const fake = provider('fake')
    ctx.agentRuntimes.registerProvider(fake)
    expect(() => { ctx.emit('agent-runtime/provider-removed', fake.id) })
      .toThrow(/still resolves "fake"/)
  })
})
