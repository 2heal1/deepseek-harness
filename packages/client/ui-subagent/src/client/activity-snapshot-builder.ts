import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationViewBuilder, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ActivityConversationViewNode, ActivitySnapshot,
} from './activity-contract.ts'

const EMPTY_RECORDS: readonly never[] = []

/** Stable empty Activity target used before matching records arrive. */
export const EMPTY_ACTIVITY_SNAPSHOT: ActivitySnapshot = {
  records: EMPTY_RECORDS,
}

/** Incremental keyed builder for the ordered durable Activity ledger. */
export class ActivitySnapshotBuilder implements ConversationViewBuilder<
  ActivityConversationViewNode,
  ActivitySnapshot
> {
  private readonly nodes = new Map<string, ActivityConversationViewNode>()
  private ordered: ActivityConversationViewNode[] = []
  readonly empty = EMPTY_ACTIVITY_SNAPSHOT

  replace(input: {
    readonly nodes: readonly ActivityConversationViewNode[]
  }): ActivitySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.rebuild()
  }

  apply(input: {
    readonly upserts: readonly ActivityConversationViewNode[]
  }): ActivitySnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.rebuild()
  }

  private rebuild(): ActivitySnapshot {
    this.ordered = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    return { records: this.ordered.map(node => node.data) }
  }
}

/** Activity target factory. */
export const activityViewDefinition: ConversationViewDefinition<
  ActivityConversationViewNode,
  ActivitySnapshot
> = {
  target: 'activity',
  create: () => new ActivitySnapshotBuilder(),
}

/**
 * Register the Activity target builder.
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerActivityConversationView(ctx: Context): void {
  ctx.conversationViews.register(activityViewDefinition)
}
