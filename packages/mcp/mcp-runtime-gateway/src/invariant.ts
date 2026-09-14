/** Durable runtime MCP tool-call invariants. @module @deepseek-ai/dsh-mcp-runtime-gateway/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { SubmissionId } from '@deepseek-ai/dsh-agent-runtime'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-runtime-gateway'

/** Cordis companion plugin name. */
export const name = 'mcp-runtime-gateway-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

interface Trace {
  openTurn: number | null
  runtime?: { readonly runtimeId: string; readonly providerId: string }
  readonly submissions: Map<SubmissionId, number>
  readonly calls: Map<string, {
    readonly runtimeId: string
    readonly providerId: string
    readonly submissionId: SubmissionId
    readonly turn: number
  }>
}

function cloneTrace(source: Trace): Trace {
  return {
    openTurn: source.openTurn,
    ...source.runtime === undefined ? {} : { runtime: source.runtime },
    submissions: new Map(source.submissions),
    calls: new Map(source.calls),
  }
}

function applyChecked(trace: Trace, event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'turn/start':
      trace.openTurn = event.data.turn
      return
    case 'turn/end':
      trace.openTurn = null
      return
    case 'agent/runtime/facts':
      trace.runtime = {
        runtimeId: event.data.runtimeId,
        providerId: event.data.providerId,
      }
      return
    case 'agent/submission/started':
      trace.submissions.set(event.data.submissionId, event.data.turn)
      return
    case 'agent/submission/settled':
      trace.submissions.delete(event.data.submissionId)
      return
    case 'agent/runtime/tool-call': {
      const data = event.data
      if (trace.runtime?.runtimeId !== data.runtimeId
        || trace.runtime.providerId !== data.providerId) {
        fail(`${event.type} does not match the current runtime`)
      }
      if (trace.openTurn !== data.turn || trace.submissions.get(data.submissionId) !== data.turn) {
        fail(`${event.type} does not belong to an active runtime submission`)
      }
      if (trace.calls.has(data.callId)) fail(`${event.type} repeats call ${data.callId}`)
      trace.calls.set(data.callId, data)
      return
    }
    case 'agent/runtime/tool-result': {
      const data = event.data
      const call = trace.calls.get(data.callId)
      if (call === undefined) fail(`${event.type} has no matching call ${data.callId}`)
      if (call.runtimeId !== data.runtimeId
        || call.providerId !== data.providerId
        || call.submissionId !== data.submissionId
        || call.turn !== data.turn) {
        fail(`${event.type} does not match call ${data.callId}`)
      }
      trace.calls.delete(data.callId)
      return
    }
    default:
      return
  }
}

/** Install an independent fold over runtime MCP audit events and their owners. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, Trace>()
  const staged = new WeakMap<SessionEvent, { readonly session: Session; readonly trace: Trace }>()
  const seed = (session: Session): Trace => {
    const trace: Trace = { openTurn: null, submissions: new Map(), calls: new Map() }
    for (const event of session.events) applyChecked(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const current = traces.get(session)
    /* v8 ignore next -- current and future sessions are seeded by the two registrations above. */
    const trace = cloneTrace(current ?? seed(session))
    applyChecked(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  /* jscpd:ignore-start -- package companions share staged event publication plumbing */
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore if -- Cordis always emits internal/dispatch before a public session/event dispatch. */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching runtime MCP validation')
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
  /* jscpd:ignore-end */
}, { inject: ['sessions'] })

/** Register the runtime MCP gateway invariant contribution. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
