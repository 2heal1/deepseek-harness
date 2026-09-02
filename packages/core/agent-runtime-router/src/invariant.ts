/** Package-owned durable submission and runtime-event invariants. @module @deepseek-ai/dsh-agent-runtime-router/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRuntimeFacts, SubmissionId } from '@deepseek-ai/dsh-agent-runtime'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-runtime-router'

/** Cordis companion plugin name. */
export const name = 'agent-runtime-router-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

interface SubmissionTrace {
  readonly messageId: MessageId
  turn?: number
  terminal: boolean
}

interface RuntimeTrace {
  openTurn: number | null
  facts?: AgentRuntimeFacts
  readonly submissions: Map<SubmissionId, SubmissionTrace>
}

function cloneTrace(trace: RuntimeTrace): RuntimeTrace {
  return {
    openTurn: trace.openTurn,
    ...trace.facts === undefined ? {} : { facts: trace.facts },
    submissions: new Map(
      [...trace.submissions].map(([id, submission]) => [id, { ...submission }]),
    ),
  }
}

function requireSubmission(
  trace: RuntimeTrace,
  submissionId: SubmissionId,
  messageId: MessageId,
  eventType: string,
  fail: InvariantFailure,
): SubmissionTrace {
  const submission = trace.submissions.get(submissionId)
  if (submission === undefined) {
    fail(`${eventType} references unknown submission ${submissionId}`)
  }
  if (submission.messageId !== messageId) {
    fail(`${eventType} message ${messageId} does not match accepted message ${submission.messageId}`)
  }
  if (submission.terminal) {
    fail(`${eventType} references terminal submission ${submissionId}`)
  }
  return submission
}

function applyChecked(
  trace: RuntimeTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  switch (event.type) {
    case 'turn/start':
      trace.openTurn = event.data.turn
      break
    case 'turn/end':
      trace.openTurn = null
      break
    case 'agent/submission/accepted': {
      if (trace.submissions.has(event.data.submissionId)) {
        fail(`agent/submission/accepted repeats submission ${event.data.submissionId}`)
      }
      if ([...trace.submissions.values()].some(
        submission => submission.messageId === event.data.messageId,
      )) {
        fail(`agent/submission/accepted repeats message ${event.data.messageId}`)
      }
      trace.submissions.set(event.data.submissionId, {
        messageId: event.data.messageId,
        terminal: false,
      })
      break
    }
    case 'agent/submission/started': {
      const submission = requireSubmission(
        trace,
        event.data.submissionId,
        event.data.messageId,
        event.type,
        fail,
      )
      if (submission.turn !== undefined) {
        fail(`agent/submission/started repeats submission ${event.data.submissionId}`)
      }
      if (trace.openTurn !== event.data.turn) {
        fail(`agent/submission/started names turn ${event.data.turn} but open turn is ${trace.openTurn}`)
      }
      if ([...trace.submissions.values()].some(
        candidate => candidate !== submission
          && candidate.turn !== undefined
          && !candidate.terminal,
      )) {
        fail('agent/submission/started overlaps another started submission')
      }
      submission.turn = event.data.turn
      break
    }
    case 'agent/submission/settled': {
      const submission = requireSubmission(
        trace,
        event.data.submissionId,
        event.data.messageId,
        event.type,
        fail,
      )
      if (event.data.settlement.kind === 'not-started') {
        if (submission.turn !== undefined) {
          fail(`agent/submission/settled marks started submission ${event.data.submissionId} as not-started`)
        }
      } else {
        if (submission.turn !== event.data.settlement.turn) {
          fail(`agent/submission/settled turn ${event.data.settlement.turn} does not match started turn ${submission.turn}`)
        }
        if (trace.openTurn !== null) {
          fail(`agent/submission/settled closes turn ${event.data.settlement.turn} while turn ${trace.openTurn} is open`)
        }
      }
      submission.terminal = true
      break
    }
    case 'agent/runtime/facts':
      trace.facts = event.data
      break
    case 'agent/runtime/activity': {
      if (trace.facts === undefined
        || event.data.runtimeId !== trace.facts.runtimeId) {
        fail(`agent/runtime/activity names runtime ${event.data.runtimeId} but current runtime is ${trace.facts?.runtimeId ?? 'unknown'}`)
      }
      if (event.data.submissionId !== undefined) {
        const submission = trace.submissions.get(event.data.submissionId)
        if (submission === undefined
          || submission.terminal
          || submission.turn === undefined) {
          fail(`agent/runtime/activity references non-running submission ${event.data.submissionId}`)
        }
      }
      break
    }
    case 'assistant/chunk':
    case 'assistant/message': {
      const provenance = event.data.provenance
      if (provenance === undefined) break
      const submission = trace.submissions.get(provenance.submissionId as SubmissionId)
      if (submission === undefined
        || submission.terminal
        || submission.turn !== event.data.turn) {
        fail(`${event.type} references non-running submission ${provenance.submissionId}`)
      }
      if (trace.facts === undefined
        || provenance.provider !== trace.facts.providerId) {
        fail(`${event.type} names provider ${provenance.provider} but current provider is ${trace.facts?.providerId ?? 'unknown'}`)
      }
      break
    }
    default:
      break
  }
}

/** Install an independent fold over Router-owned durable events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, RuntimeTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: RuntimeTrace }>()

  const seed = (session: Session): RuntimeTrace => {
    const trace: RuntimeTrace = { openTurn: null, submissions: new Map() }
    for (const event of session.events) applyChecked(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  const traceFor = (session: Session): RuntimeTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const trace = cloneTrace(traceFor(session))
    applyChecked(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching runtime-event validation')
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
