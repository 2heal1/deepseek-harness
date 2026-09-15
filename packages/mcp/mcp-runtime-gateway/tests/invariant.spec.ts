import { Context } from '@deepseek-ai/cordis'
import {
  AgentRuntimeId,
  AgentRuntimeProviderId,
  SubmissionId,
  snapshotAgentRuntimeCapabilities,
  snapshotAgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import * as RuntimeMcpGatewayInvariant from '../src/invariant.ts'
import type {} from '../src/index.ts'

const runtimeId = AgentRuntimeId('runtime-1')
const providerId = AgentRuntimeProviderId('provider-1')
const submissionId = SubmissionId('submission-1')
const callId = CallId('call-1')

function appendFacts(session: Session): void {
  session.append('agent/runtime/facts', snapshotAgentRuntimeFacts({
    runtimeId,
    providerId,
    capabilities: snapshotAgentRuntimeCapabilities([{ id: 'harnessTools' }]),
    phase: 'ready',
  }))
}

function appendActiveSubmission(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('agent/submission/started', {
    submissionId,
    messageId: MessageId('message-1'),
    turn: 1,
  })
}

function appendCall(session: Session, overrides: Partial<{
  runtimeId: AgentRuntimeId
  providerId: AgentRuntimeProviderId
  submissionId: SubmissionId
  turn: number
  callId: CallId
}> = {}): void {
  session.append('agent/runtime/tool-call', {
    runtimeId,
    providerId,
    submissionId,
    turn: 1,
    callId,
    name: 'echo',
    arguments: {},
    ...overrides,
  })
}

function appendResult(session: Session, overrides: Partial<{
  runtimeId: AgentRuntimeId
  providerId: AgentRuntimeProviderId
  submissionId: SubmissionId
  turn: number
  callId: CallId
}> = {}): void {
  session.append('agent/runtime/tool-result', {
    runtimeId,
    providerId,
    submissionId,
    turn: 1,
    callId,
    content: [],
    isError: false,
    ...overrides,
  })
}

async function setup(existing = false) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = existing ? ctx.sessions.create(SessionId('existing')) : undefined
  if (session !== undefined) session.append('turn/start', { turn: 9 })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(RuntimeMcpGatewayInvariant)
  return {
    ctx,
    session: session ?? ctx.sessions.create(SessionId('created')),
  }
}

describe('runtime MCP gateway durable event invariants', () => {
  it.each([false, true])('accepts paired audit events for a %s session', async (existing) => {
    const { ctx, session } = await setup(existing)
    try {
      appendFacts(session)
      appendActiveSubmission(session)
      appendCall(session)
      appendResult(session)
      session.append('agent/runtime/activity', {
        runtimeId,
        kind: 'status',
        phase: 'ready',
        fidelity: 'complete',
        data: {},
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('agent/submission/settled', {
        submissionId,
        messageId: MessageId('message-1'),
        settlement: {
          kind: 'settled',
          turn: 1,
          reason: { kind: 'completed' },
        },
      })
      expect(session.events.at(-1)?.type).toBe('agent/submission/settled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects calls outside their current runtime and active submission', async () => {
    const wrongRuntime = await setup()
    try {
      appendFacts(wrongRuntime.session)
      appendActiveSubmission(wrongRuntime.session)
      expect(() => {
        appendCall(wrongRuntime.session, {
          runtimeId: AgentRuntimeId('other'),
        })
      }).toThrow(/does not match the current runtime/)
    } finally {
      await wrongRuntime.ctx.fiber.dispose()
    }

    const inactive = await setup()
    try {
      appendFacts(inactive.session)
      appendActiveSubmission(inactive.session)
      inactive.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(() => { appendCall(inactive.session) }).toThrow(/active runtime submission/)
    } finally {
      await inactive.ctx.fiber.dispose()
    }

    const settled = await setup()
    try {
      appendFacts(settled.session)
      appendActiveSubmission(settled.session)
      settled.session.append('agent/submission/settled', {
        submissionId,
        messageId: MessageId('message-1'),
        settlement: {
          kind: 'settled',
          turn: 1,
          reason: { kind: 'completed' },
        },
      })
      expect(() => { appendCall(settled.session) }).toThrow(/active runtime submission/)
    } finally {
      await settled.ctx.fiber.dispose()
    }
  })

  it('rejects repeated calls and missing or mismatched results', async () => {
    const repeated = await setup()
    try {
      appendFacts(repeated.session)
      appendActiveSubmission(repeated.session)
      appendCall(repeated.session)
      expect(() => { appendCall(repeated.session) }).toThrow(/repeats call/)
    } finally {
      await repeated.ctx.fiber.dispose()
    }

    const missing = await setup()
    try {
      appendFacts(missing.session)
      appendActiveSubmission(missing.session)
      expect(() => { appendResult(missing.session) }).toThrow(/has no matching call/)
    } finally {
      await missing.ctx.fiber.dispose()
    }

    for (const mismatch of [
      { providerId: AgentRuntimeProviderId('other') },
      { submissionId: SubmissionId('other') },
      { turn: 2 },
    ]) {
      const candidate = await setup()
      try {
        appendFacts(candidate.session)
        appendActiveSubmission(candidate.session)
        appendCall(candidate.session)
        expect(() => { appendResult(candidate.session, mismatch) }).toThrow(/does not match call/)
      } finally {
        await candidate.ctx.fiber.dispose()
      }
    }
  })
})
