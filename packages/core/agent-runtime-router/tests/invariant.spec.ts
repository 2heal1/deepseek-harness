import { Context } from '@deepseek-ai/cordis'
import {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import * as AgentRuntimeRouterInvariant from '@deepseek-ai/dsh-agent-runtime-router/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

const providerId = AgentRuntimeProviderId('external')
const runtimeId = AgentRuntimeId('runtime-1')
const submissionId = SubmissionId('submission-1')

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentRuntimeRouterInvariant)
  return { ctx, session: ctx.sessions.create(SessionId('runtime-events')) }
}

function facts(capabilityIds: Array<'runtimeActivity'> = []) {
  return snapshotAgentRuntimeFacts({
    runtimeId,
    providerId,
    capabilities: snapshotAgentRuntimeCapabilities(
      capabilityIds.map(id => ({ id })),
    ),
    phase: 'ready',
  })
}

function accepted(session: Awaited<ReturnType<typeof setup>>['session']) {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  })
  session.append('agent/submission/accepted', {
    submissionId,
    messageId: message.id,
  })
  return message
}

describe('agent-runtime-router durable event invariants', () => {
  it('accepts one complete external submission and correlated runtime output', async () => {
    const { session } = await setup()
    session.append('agent/runtime/facts', facts(['runtimeActivity']))
    const message = accepted(session)
    session.append('turn/start', { turn: 1 })
    session.append('agent/submission/started', {
      submissionId,
      messageId: message.id,
      turn: 1,
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    const provenance = {
      kind: 'runtime' as const,
      provider: providerId,
      source: 'protocol' as const,
      submissionId,
    }
    session.append('assistant/chunk', {
      turn: 1,
      provenance,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    })
    session.append('assistant/message', {
      turn: 1,
      provenance,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'runtime', provider: providerId, source: 'protocol' },
      }),
    }, { surfaceOp: 'append' })
    session.append('agent/runtime/activity', {
      runtimeId,
      submissionId,
      kind: 'tool',
      phase: 'completed',
      fidelity: 'complete',
      data: {},
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => session.append('agent/submission/settled', {
      submissionId,
      messageId: message.id,
      settlement: {
        kind: 'settled',
        turn: 1,
        reason: { kind: 'completed' },
      },
    })).not.toThrow()
  })

  it('rejects unknown, repeated, mismatched, and out-of-order submission events', async () => {
    const unknown = await setup()
    expect(() => unknown.session.append('agent/submission/started', {
      submissionId,
      messageId: createUserMessage({
        content: [],
        source: { kind: 'user' },
      }).id,
      turn: 1,
    })).toThrow(InvariantError)

    const repeated = await setup()
    const repeatedMessage = accepted(repeated.session)
    expect(() => repeated.session.append('agent/submission/accepted', {
      submissionId,
      messageId: repeatedMessage.id,
    })).toThrow(/repeats submission/)

    const wrongTurn = await setup()
    const wrongTurnMessage = accepted(wrongTurn.session)
    wrongTurn.session.append('turn/start', { turn: 1 })
    expect(() => wrongTurn.session.append('agent/submission/started', {
      submissionId,
      messageId: wrongTurnMessage.id,
      turn: 2,
    })).toThrow(/open turn is 1/)

    const prematureSettlement = await setup()
    const prematureMessage = accepted(prematureSettlement.session)
    expect(() => prematureSettlement.session.append('agent/submission/settled', {
      submissionId,
      messageId: prematureMessage.id,
      settlement: {
        kind: 'settled',
        turn: 1,
        reason: { kind: 'completed' },
      },
    })).toThrow(/does not match started turn/)
  })

  it('rejects runtime output for the wrong runtime, provider, or submission state', async () => {
    const wrongRuntime = await setup()
    wrongRuntime.session.append('agent/runtime/facts', facts(['runtimeActivity']))
    expect(() => wrongRuntime.session.append('agent/runtime/activity', {
      runtimeId: AgentRuntimeId('runtime-2'),
      kind: 'status',
      phase: 'ready',
      fidelity: 'complete',
      data: {},
    })).toThrow(/current runtime is runtime-1/)

    const wrongProvider = await setup()
    wrongProvider.session.append('agent/runtime/facts', facts())
    const wrongProviderMessage = accepted(wrongProvider.session)
    wrongProvider.session.append('turn/start', { turn: 1 })
    wrongProvider.session.append('agent/submission/started', {
      submissionId,
      messageId: wrongProviderMessage.id,
      turn: 1,
    })
    expect(() => wrongProvider.session.append('assistant/chunk', {
      turn: 1,
      provenance: {
        kind: 'runtime',
        provider: 'other',
        source: 'protocol',
        submissionId,
      },
      chunk: { type: 'text-delta', index: 0, text: 'bad' },
    })).toThrow(/current provider is external/)

    const settled = await setup()
    settled.session.append('agent/runtime/facts', facts(['runtimeActivity']))
    const settledMessage = accepted(settled.session)
    settled.session.append('agent/submission/settled', {
      submissionId,
      messageId: settledMessage.id,
      settlement: {
        kind: 'not-started',
        reason: { kind: 'cancelled', cause: { kind: 'user' } },
      },
    })
    expect(() => settled.session.append('agent/runtime/activity', {
      runtimeId,
      submissionId,
      kind: 'status',
      phase: 'late',
      fidelity: 'partial',
      data: {},
    })).toThrow(/non-running submission/)
  })

  it('rejects duplicate identities and invalid started or settled transitions', async () => {
    const mismatchedMessage = await setup()
    accepted(mismatchedMessage.session)
    expect(() => mismatchedMessage.session.append('agent/submission/started', {
      submissionId,
      messageId: createUserMessage({ content: [], source: { kind: 'user' } }).id,
      turn: 1,
    })).toThrow(/does not match accepted message/)

    const repeatedMessage = await setup()
    const duplicateMessage = accepted(repeatedMessage.session)
    expect(() => repeatedMessage.session.append('agent/submission/accepted', {
      submissionId: SubmissionId('submission-2'),
      messageId: duplicateMessage.id,
    })).toThrow(/repeats message/)

    const repeatedStart = await setup()
    const startMessage = accepted(repeatedStart.session)
    repeatedStart.session.append('turn/start', { turn: 1 })
    repeatedStart.session.append('agent/submission/started', {
      submissionId,
      messageId: startMessage.id,
      turn: 1,
    })
    expect(() => repeatedStart.session.append('agent/submission/started', {
      submissionId,
      messageId: startMessage.id,
      turn: 1,
    })).toThrow(/repeats submission/)
    repeatedStart.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => repeatedStart.session.append('agent/submission/settled', {
      submissionId,
      messageId: startMessage.id,
      settlement: {
        kind: 'not-started',
        reason: { kind: 'cancelled', cause: { kind: 'user' } },
      },
    })).toThrow(/marks started submission/)

    const terminal = await setup()
    const terminalMessage = accepted(terminal.session)
    terminal.session.append('agent/submission/settled', {
      submissionId,
      messageId: terminalMessage.id,
      settlement: {
        kind: 'not-started',
        reason: { kind: 'cancelled', cause: { kind: 'user' } },
      },
    })
    expect(() => terminal.session.append('agent/submission/settled', {
      submissionId,
      messageId: terminalMessage.id,
      settlement: {
        kind: 'not-started',
        reason: { kind: 'cancelled', cause: { kind: 'user' } },
      },
    })).toThrow(/references terminal submission/)

    const overlapping = await setup()
    const firstMessage = accepted(overlapping.session)
    const secondMessage = createUserMessage({ content: [], source: { kind: 'user' } })
    overlapping.session.append('agent/submission/accepted', {
      submissionId: SubmissionId('submission-2'),
      messageId: secondMessage.id,
    })
    overlapping.session.append('turn/start', { turn: 1 })
    overlapping.session.append('agent/submission/started', {
      submissionId,
      messageId: firstMessage.id,
      turn: 1,
    })
    expect(() => overlapping.session.append('agent/submission/started', {
      submissionId: SubmissionId('submission-2'),
      messageId: secondMessage.id,
      turn: 1,
    })).toThrow(/overlaps another started submission/)

    const openSettlement = await setup()
    const openMessage = accepted(openSettlement.session)
    openSettlement.session.append('turn/start', { turn: 1 })
    openSettlement.session.append('agent/submission/started', {
      submissionId,
      messageId: openMessage.id,
      turn: 1,
    })
    expect(() => openSettlement.session.append('agent/submission/settled', {
      submissionId,
      messageId: openMessage.id,
      settlement: {
        kind: 'settled',
        turn: 1,
        reason: { kind: 'completed' },
      },
    })).toThrow(/while turn 1 is open/)

  })

  it('rejects runtime activity and assistant provenance without live correlations', async () => {
    const noFacts = await setup()
    expect(() => noFacts.session.append('agent/runtime/activity', {
      runtimeId,
      kind: 'status',
      phase: 'ready',
      fidelity: 'complete',
      data: {},
    })).toThrow(/current runtime is unknown/)

    const unknownSubmission = await setup()
    unknownSubmission.session.append('agent/runtime/facts', facts(['runtimeActivity']))
    expect(() => unknownSubmission.session.append('agent/runtime/activity', {
      runtimeId,
      submissionId,
      kind: 'status',
      phase: 'ready',
      fidelity: 'complete',
      data: {},
    })).toThrow(/non-running submission/)

    const assistant = await setup()
    assistant.session.append('agent/runtime/facts', facts())
    assistant.session.append('turn/start', { turn: 1 })
    expect(() => assistant.session.append('assistant/message', {
      turn: 1,
      provenance: {
        kind: 'runtime',
        provider: providerId,
        source: 'protocol',
        submissionId,
      },
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'runtime', provider: providerId, source: 'protocol' },
      }),
    }, { surfaceOp: 'append' })).toThrow(/non-running submission/)

    expect(() => assistant.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'native' },
    })).not.toThrow()

    const noFactsAssistant = await setup()
    const noFactsMessage = accepted(noFactsAssistant.session)
    noFactsAssistant.session.append('turn/start', { turn: 1 })
    noFactsAssistant.session.append('agent/submission/started', {
      submissionId,
      messageId: noFactsMessage.id,
      turn: 1,
    })
    expect(() => noFactsAssistant.session.append('assistant/chunk', {
      turn: 1,
      provenance: {
        kind: 'runtime',
        provider: providerId,
        source: 'protocol',
        submissionId,
      },
      chunk: { type: 'text-delta', index: 0, text: 'missing facts' },
    })).toThrow(/current provider is unknown/)
  })

  it('seeds traces for sessions that predate invariant installation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('preexisting-runtime-events'))
    const message = accepted(session)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AgentRuntimeRouterInvariant)

    expect(() => session.append('agent/submission/settled', {
      submissionId,
      messageId: message.id,
      settlement: {
        kind: 'not-started',
        reason: { kind: 'cancelled', cause: { kind: 'user' } },
      },
    })).not.toThrow()
  })

  it('seeds a trace when an earlier creation listener appends before registration observes it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    ctx.on('session/created', (session) => {
      accepted(session)
    })
    await ctx.plugin(AgentRuntimeRouterInvariant)

    expect(() => ctx.sessions.create(SessionId('creation-listener-runtime-events')))
      .not.toThrow()
  })
})
