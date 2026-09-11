#!/usr/bin/env node
/** Exercise the optional Codex main-runtime Bundle through a real Loader tree. */

import { boot, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubmissionId } from '@deepseek-ai/dsh-agent-runtime'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-runtime-profile'

const configPath = process.argv[2]
const bundlePatchPath = process.argv[3]
if (configPath === undefined || bundlePatchPath === undefined) {
  throw new Error('agent-runtime-codex fixture requires config and Bundle patch paths')
}

async function waitForTurnStart(agent: Agent, submissionId: SubmissionId): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const observed = agent.session.events.some(event =>
      event.type === 'agent/runtime/activity'
      && event.data.submissionId === submissionId
      && event.data.kind === 'turn'
      && event.data.phase === 'started')
    if (observed) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('fixture did not observe the second Codex turn start')
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

const ctx = await boot(
  'agent-runtime-codex-main-fixture',
  resolveConfigPath(configPath, undefined),
  loadOverlayPatches('agent-runtime-codex-main-fixture', bundlePatchPath),
)

let summary: object
try {
  const handle = await ctx.agents.create({
    sessionId: SessionId('external-main'),
    meta: { cwd: process.cwd() },
    agentOptions: { runtimeProfile: 'codex-main' },
  })
  try {
    const first = handle.agent.submit(userMessage('complete the external main turn'))
    const firstStarted = await first.started
    const firstSettled = await first.settled

    const second = handle.agent.submit(userMessage('cancel the external main turn'))
    const secondStarted = await second.started
    await waitForTurnStart(handle.agent, second.id)
    const cancelWon = handle.agent.cancelSubmission(second.id, { kind: 'user' })
    const secondSettled = await second.settled
    await handle.agent.whenIdle()

    const events = handle.agent.session.events
    const facts = events.find(event => event.type === 'agent/runtime/facts')
    const profile = handle.agent.session.header.runtimeProfile
    if (profile === undefined || profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('external main Session did not pin its Runtime Profile')
    }
    const pinned = profile as Record<string, unknown>
    summary = {
      providers: ctx.agentRuntimes.listProviders().map(provider => provider.id),
      profile: {
        profileId: pinned.profileId,
        schemaVersion: pinned.schemaVersion,
        provider: pinned.provider,
        frozen: Object.isFrozen(profile),
      },
      capabilities: handle.agent.capabilities,
      runtime: facts?.type === 'agent/runtime/facts'
        ? {
          providerId: facts.data.providerId,
          phase: facts.data.phase,
          externalSessionId: facts.data.externalSessionId,
        }
        : null,
      first: {
        started: firstStarted.kind === 'started'
          ? { kind: firstStarted.kind, turn: firstStarted.turn }
          : { kind: firstStarted.kind },
        settled: firstSettled.kind === 'settled'
          ? {
            kind: firstSettled.kind,
            turn: firstSettled.turn,
            reason: firstSettled.reason,
          }
          : { kind: firstSettled.kind },
      },
      second: {
        started: secondStarted.kind === 'started'
          ? { kind: secondStarted.kind, turn: secondStarted.turn }
          : { kind: secondStarted.kind },
        cancelWon,
        settled: secondSettled.kind === 'settled'
          ? {
            kind: secondSettled.kind,
            turn: secondSettled.turn,
            reason: secondSettled.reason,
          }
          : { kind: secondSettled.kind },
      },
      assistantDeltas: events.flatMap(event =>
        event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta'
          ? [event.data.chunk.text]
          : []),
      assistantMessages: events.flatMap(event =>
        event.type === 'assistant/message'
          ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
          : []),
      activities: events.flatMap(event =>
        event.type === 'agent/runtime/activity'
          ? [{
            kind: event.data.kind,
            phase: event.data.phase,
            fidelity: event.data.fidelity,
          }]
          : []),
      eventTypes: events.map(event => event.type),
      finalStatus: handle.agent.status,
    }
  } finally {
    await handle.dispose()
  }
} finally {
  await ctx.fiber.dispose()
}

process.stdout.write(`${JSON.stringify(summary!, null, 2)}\n`)
