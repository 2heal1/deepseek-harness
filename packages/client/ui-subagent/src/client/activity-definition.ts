import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ActivityConversationViewNode, ActivityRecord,
} from './activity-contract.ts'

function activityRecord(match: ConversationMatch): ActivityRecord {
  const event = match.event
  switch (event.type) {
    case 'agent/runtime/facts':
      return {
        kind: 'runtime-facts',
        seq: event.seq,
        time: event.time,
        facts: event.data,
      }
    case 'agent/runtime/activity':
      return {
        kind: 'runtime-activity',
        seq: event.seq,
        time: event.time,
        activity: event.data,
      }
    case 'turn/end':
      if (event.data.reason.kind !== 'error') {
        throw new Error('activity turn/end requires an error reason')
      }
      return {
        kind: 'turn-failure',
        seq: event.seq,
        time: event.time,
        turn: event.data.turn,
        failure: event.data.reason.error,
      }
    case 'agent/submission/settled': {
      const settlement = event.data.settlement
      if (settlement.kind !== 'not-started' || settlement.reason.kind !== 'rejected') {
        throw new Error('activity submission settlement requires a rejection')
      }
      return {
        kind: 'submission-rejection',
        seq: event.seq,
        time: event.time,
        failure: settlement.reason.failure,
      }
    }
    default:
      throw new Error(`activity start does not support ${event.type}`)
  }
}

function activityNode(
  context: ConversationNodeContext<ActivityRecord>,
): ActivityConversationViewNode | null {
  const record = context.state
  if (record === undefined) return null
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'activity',
    anchorSeq: record.seq,
    data: record,
  }
}

const activityDefinition: ConversationNodeDefinition<ActivityRecord> = {
  kind: 'subagent-activity-record',
  target: 'activity',
  match: (event) => {
    if (event.type === 'agent/runtime/facts' || event.type === 'agent/runtime/activity') {
      return { id: String(event.seq), role: 'start' }
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      return { id: String(event.seq), role: 'start' }
    }
    if (event.type === 'agent/submission/settled'
      && event.data.settlement.kind === 'not-started'
      && event.data.settlement.reason.kind === 'rejected') {
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context, match) => activityRecord(match),
  update: context => context.state,
  buildViewNode: activityNode,
}

/**
 * Register durable runtime and failure records for the Activity target.
 * @param ctx - Plugin context receiving the event Definition.
 */
export function registerActivityDefinition(ctx: Context): void {
  ctx.conversationEvents.register(activityDefinition)
}
