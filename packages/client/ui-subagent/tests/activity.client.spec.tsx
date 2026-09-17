// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import { cleanup, render, screen, within } from '@testing-library/react'
import {
  AgentRuntimeId, AgentRuntimeProviderId, ExternalSessionId, type AgentRuntimeFacts,
} from '@deepseek-ai/dsh-agent-runtime'
import {
  bindSnapshotSelector, makeTranslate,
} from '@deepseek-ai/dsh-client-test-runtime'
import {
  ConversationNodeAssembler, createSnapshotStore, EMPTY_CHAT_SNAPSHOT,
  type ConversationEventInput, type ConversationNodeDefinition,
  type ConversationSnapshot, type ConversationViewDefinition,
  type ConversationViewSnapshotStore, type SessionId, type SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ActivityConversationViewNode, ActivitySnapshot,
} from '../src/client/activity-contract.ts'
import { registerActivityDefinition } from '../src/client/activity-definition.ts'
import {
  ActivitySnapshotBuilder, activityViewDefinition,
} from '../src/client/activity-snapshot-builder.ts'
import { ActivityView, type ActivityViewProps } from '../src/client/ActivityView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SID = 'activity-session' as SessionId
const DEFINITIONS: ConversationNodeDefinition[] = []
const registrationContext = {
  conversationEvents: {
    register: (definition: ConversationNodeDefinition) => {
      DEFINITIONS.push(definition)
      return () => {}
    },
  },
} as unknown as Context

registerActivityDefinition(registrationContext)

class EventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class ViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [activityViewDefinition]
  }
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return {
    event: {
      seq,
      time: Date.UTC(2026, 8, 16, 1, 2, seq),
      type,
      data,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function facts(phase: AgentRuntimeFacts['phase'] = 'running'): AgentRuntimeFacts {
  return {
    runtimeId: AgentRuntimeId('runtime-1'),
    providerId: AgentRuntimeProviderId('codex'),
    phase,
    product: { value: 'Codex CLI', source: 'protocol' },
    productVersion: { value: '1.2.3', source: 'protocol' },
    protocol: { value: 'app-server', source: 'profile' },
    protocolVersion: { value: '2', source: 'protocol' },
    externalSessionId: ExternalSessionId('external-1'),
    capabilities: [{ id: 'runtimeActivity' }, { id: 'harnessTools' }],
  }
}

function assembledSnapshot(): ActivitySnapshot {
  const assembler = new ConversationNodeAssembler(
    new EventDefinitions(),
    new ViewDefinitions(),
  )
  assembler.replaceWindow([
    at(1, 'agent/runtime/facts', facts('ready')),
    at(2, 'agent/runtime/activity', {
      runtimeId: 'runtime-1',
      kind: 'command',
      phase: 'started',
      fidelity: 'partial',
      data: { command: 'pnpm test' },
    }),
    at(3, 'turn/start', { turn: 1 }),
    at(4, 'turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'socket closed' } },
    }),
    at(5, 'agent/submission/accepted', {
      submissionId: 'submission-1',
      messageId: 'message-1',
    }),
    at(6, 'agent/submission/settled', {
      submissionId: 'submission-1',
      messageId: 'message-1',
      settlement: {
        kind: 'not-started',
        reason: {
          kind: 'rejected',
          failure: {
            code: 'AGENT_BUSY',
            phase: 'submission',
            message: 'runtime is busy',
          },
        },
      },
    }),
    at(7, 'turn/start', { turn: 2 }),
    at(8, 'turn/end', {
      turn: 2,
      reason: { kind: 'completed' },
    }),
  ], false)
  assembler.flush()
  const snapshot = assembler.snapshot('activity') as ActivitySnapshot | undefined
  if (snapshot === undefined) throw new Error('activity target was not registered')
  return snapshot
}

function conversation(
  activity: ActivitySnapshot | undefined,
  lastAgentError: string | null,
): ConversationSnapshot {
  const views = {
    get: target => target === 'activity' ? activity : undefined,
  } as ConversationViewSnapshotStore
  return {
    sessionId: SID,
    views,
    chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError,
  }
}

function activityProps(
  activity: ActivitySnapshot | undefined,
  runtimeStatus: ReturnType<typeof facts> | null | undefined,
  lastAgentError: string | null = null,
): ActivityViewProps {
  const list = {
    ids: [SID],
    byId: {
      [SID]: {
        id: SID,
        displayTitle: 'Activity fixture',
        running: false,
        blank: false,
        updatedAt: 0,
        projectionValues: { runtimeStatus },
      },
    },
    current: SID,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
  const useSessions: ActivityViewProps['useSessions'] = select => select(list)
  return {
    sessionId: SID,
    useSession: bindSnapshotSelector(createSnapshotStore(conversation(activity, lastAgentError))),
    useSessions,
    t: makeTranslate(zh),
  } as unknown as ActivityViewProps
}

describe('Activity conversation target', () => {
  it('keeps only durable runtime records and structured failures in sequence order', () => {
    const snapshot = assembledSnapshot()

    expect(snapshot.records.map(record => record.kind)).toEqual([
      'runtime-facts',
      'runtime-activity',
      'turn-failure',
      'submission-rejection',
    ])
    expect(snapshot.records[1]).toMatchObject({
      kind: 'runtime-activity',
      activity: {
        kind: 'command',
        phase: 'started',
        fidelity: 'partial',
        data: { command: 'pnpm test' },
      },
    })
  })

  it('reorders incremental upserts by durable sequence', () => {
    const builder = new ActivitySnapshotBuilder()
    const node = (key: string, seq: number): ActivityConversationViewNode => ({
      key,
      kind: 'test',
      id: key,
      target: 'activity',
      anchorSeq: seq,
      data: { kind: 'runtime-facts', seq, time: seq, facts: facts() },
    })

    builder.replace({ nodes: [node('later', 5), node('z', 2)] })
    expect(builder.apply({ upserts: [node('earlier', 2)] }).records.map(record => record.seq))
      .toEqual([2, 2, 5])
    expect(builder.apply({ upserts: [] }).records.map(record => record.time))
      .toEqual([2, 2, 5])
  })

  it('rejects events that bypass the Activity matcher and handles an empty node state', () => {
    const definition = DEFINITIONS[0]!
    expect(() => definition.start(
      {} as never,
      at(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }) as never,
      {} as never,
    )).toThrow('activity turn/end requires an error reason')
    expect(() => definition.start(
      {} as never,
      at(2, 'agent/submission/settled', {
        settlement: { kind: 'started', reason: { kind: 'completed' } },
      }) as never,
      {} as never,
    )).toThrow('activity submission settlement requires a rejection')
    expect(() => definition.start(
      {} as never,
      at(3, 'turn/start', { turn: 1 }) as never,
      {} as never,
    )).toThrow('activity start does not support turn/start')
    expect(definition.update({ state: facts() } as never, {} as never))
      .toEqual(facts())
    expect(definition.buildViewNode?.({ state: undefined } as never)).toBeNull()
  })

  it('renders current process facts, partial fidelity, durable failures, and transient errors', () => {
    render(<ActivityView {...activityProps(
      assembledSnapshot(),
      facts(),
      'live transport disconnected',
    )} />)

    const runtime = screen.getByRole('heading', { name: '运行时' }).parentElement?.parentElement
    expect(runtime).toBeTruthy()
    expect(within(runtime!).getByText('正在运行')).toBeTruthy()
    expect(within(runtime!).getByText('Codex CLI · 协议 / 1.2.3 · 协议')).toBeTruthy()
    expect(within(runtime!).getByText('app-server · 配置 / 2 · 协议')).toBeTruthy()
    expect(within(runtime!).getByText('runtimeActivity, harnessTools')).toBeTruthy()
    expect(screen.getByText('部分')).toBeTruthy()
    expect(screen.getByText(/"command": "pnpm test"/)).toBeTruthy()
    expect(screen.getByText('socket closed')).toBeTruthy()
    expect(screen.getByText('runtime is busy')).toBeTruthy()
    expect(screen.getByText('live transport disconnected')).toBeTruthy()
    expect(screen.queryByText(/args/i)).toBeNull()
  })

  it('states when no runtime or durable activity has been reported', () => {
    render(<ActivityView {...activityProps(undefined, null)} />)

    expect(screen.getByText('此会话尚未报告运行时状态。')).toBeTruthy()
    expect(screen.getByText('此会话尚无运行时活动或结构化失败记录。')).toBeTruthy()
  })

  it('renders every lifecycle phase and sparse runtime facts', () => {
    const sparse: AgentRuntimeFacts = {
      runtimeId: AgentRuntimeId('runtime-sparse'),
      providerId: AgentRuntimeProviderId('sparse'),
      phase: 'starting',
      capabilities: [],
    }
    const records: ActivitySnapshot = {
      records: (['stopping', 'stopped', 'failed'] as const).map((phase, index) => ({
        kind: 'runtime-facts',
        seq: index + 1,
        time: index + 1,
        facts: facts(phase),
      })),
    }
    render(<ActivityView {...activityProps(records, sparse)} />)

    for (const label of ['正在启动', '无可选能力']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    for (const label of ['正在停止', '已停止', '失败']) {
      expect(screen.getByText(label, { exact: false })).toBeTruthy()
    }
    expect(screen.queryByText('产品')).toBeNull()
    expect(screen.queryByText('协议')).toBeNull()
    expect(screen.queryByText('外部会话')).toBeNull()
  })
})
