import type {
  AgentRuntimeActivity, AgentRuntimeFacts, AgentRuntimeFailure,
} from '@deepseek-ai/dsh-agent-runtime/types'
import type {
  ConversationEventInput, ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'

type TurnEndEvent = Extract<ConversationEventInput['event'], { readonly type: 'turn/end' }>
type TurnFailure = Extract<TurnEndEvent['data']['reason'], { readonly kind: 'error' }>['error']

/** One durable runtime or failure record shown by the Activity view. */
export type ActivityRecord =
  | {
    readonly kind: 'runtime-facts'
    readonly seq: number
    readonly time: number
    readonly facts: AgentRuntimeFacts
  }
  | {
    readonly kind: 'runtime-activity'
    readonly seq: number
    readonly time: number
    readonly activity: AgentRuntimeActivity
  }
  | {
    readonly kind: 'turn-failure'
    readonly seq: number
    readonly time: number
    readonly turn: number
    readonly failure: TurnFailure
  }
  | {
    readonly kind: 'submission-rejection'
    readonly seq: number
    readonly time: number
    readonly failure: AgentRuntimeFailure
  }

/** Activity target envelope produced from one durable Session event. */
export interface ActivityConversationViewNode extends ConversationViewNode {
  readonly target: 'activity'
  readonly anchorSeq: number
  readonly data: ActivityRecord
}

/** Ordered durable records consumed by the Activity tab. */
export interface ActivitySnapshot {
  readonly records: readonly ActivityRecord[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Runtime facts, provider activity, and structured failures. */
    activity: ActivitySnapshot
  }
}
