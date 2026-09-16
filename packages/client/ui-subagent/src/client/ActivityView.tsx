import type {
  AgentRuntimeFacts, SourcedRuntimeFact,
} from '@deepseek-ai/dsh-agent-runtime/types'
import {
  displayFailureMessage, type SessionProjectionMap,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityRecord } from './activity-contract.ts'
import { EMPTY_ACTIVITY_SNAPSHOT } from './activity-snapshot-builder.ts'
import { NS } from './locales.ts'
import css from './ActivityView.module.css'

function phaseLabel(phase: AgentRuntimeFacts['phase'], t: ActivityViewProps['t']): string {
  switch (phase) {
    case 'starting': return t('activity.phase.starting')
    case 'ready': return t('activity.phase.ready')
    case 'running': return t('activity.phase.running')
    case 'stopping': return t('activity.phase.stopping')
    case 'stopped': return t('activity.phase.stopped')
    case 'failed': return t('activity.phase.failed')
  }
}

function factValue(
  fact: SourcedRuntimeFact<string> | undefined,
  t: ActivityViewProps['t'],
): string | undefined {
  if (fact === undefined) return undefined
  return `${fact.value} · ${fact.source === 'profile'
    ? t('activity.source.profile')
    : t('activity.source.protocol')}`
}

function timestamp(time: number): string {
  return new Date(time).toISOString().replace('T', ' ').replace('.000Z', 'Z')
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function RuntimeSummary({
  status, t,
}: {
  status: SessionProjectionMap['runtimeStatus'] | undefined
  t: ActivityViewProps['t']
}) {
  if (status === undefined || status === null) {
    return <p className={css.empty}>{t('activity.runtime.empty')}</p>
  }
  const product = [factValue(status.product, t), factValue(status.productVersion, t)]
    .filter((value): value is string => value !== undefined)
    .join(' / ')
  const protocol = [factValue(status.protocol, t), factValue(status.protocolVersion, t)]
    .filter((value): value is string => value !== undefined)
    .join(' / ')
  return (
    <dl className={css.facts}>
      <div>
        <dt>{t('activity.field.process')}</dt>
        <dd><span className={css.phase} data-phase={status.phase}>{phaseLabel(status.phase, t)}</span></dd>
      </div>
      <div><dt>{t('activity.field.provider')}</dt><dd>{status.providerId}</dd></div>
      <div><dt>{t('activity.field.runtime')}</dt><dd>{status.runtimeId}</dd></div>
      {product !== '' && <div><dt>{t('activity.field.product')}</dt><dd>{product}</dd></div>}
      {protocol !== '' && <div><dt>{t('activity.field.protocol')}</dt><dd>{protocol}</dd></div>}
      {status.externalSessionId !== undefined && (
        <div><dt>{t('activity.field.externalSession')}</dt><dd>{status.externalSessionId}</dd></div>
      )}
      <div className={css.wide}>
        <dt>{t('activity.field.capabilities')}</dt>
        <dd>
          {status.capabilities.length === 0
            ? t('activity.capabilities.none')
            : status.capabilities.map(capability => capability.id).join(', ')}
        </dd>
      </div>
    </dl>
  )
}

function RecordBody({ record, t }: { record: ActivityRecord; t: ActivityViewProps['t'] }) {
  switch (record.kind) {
    case 'runtime-facts':
      return (
        <>
          <strong>{t('activity.record.runtime')}</strong>
          <span>{record.facts.providerId} · {phaseLabel(record.facts.phase, t)}</span>
        </>
      )
    case 'runtime-activity':
      return (
        <>
          <strong>{record.activity.kind} · {record.activity.phase}</strong>
          {record.activity.fidelity === 'partial' && (
            <span className={css.partial}>{t('activity.fidelity.partial')}</span>
          )}
          <pre>{json(record.activity.data)}</pre>
        </>
      )
    case 'turn-failure':
      return (
        <>
          <strong>{t('activity.record.turnFailure', { turn: record.turn })}</strong>
          <span className={css.error}>{displayFailureMessage(record.failure)}</span>
          <code>{record.failure.code}</code>
        </>
      )
    case 'submission-rejection':
      return (
        <>
          <strong>{t('activity.record.submissionRejection')}</strong>
          <span className={css.error}>{record.failure.message}</span>
          <code>{record.failure.code} · {record.failure.phase}</code>
        </>
      )
  }
}

/** Full props for the session Activity tab. */
export type ActivityViewProps = ConvViewProps & PropsLocale<typeof NS>

/**
 * Render current runtime status and the durable provider activity ledger.
 * @param props - Session hooks and localized copy supplied by the view slot.
 * @returns Activity view content.
 */
export function ActivityView({ sessionId, useSession, useSessions, t }: ActivityViewProps) {
  const snapshot = useSession(value => value.views.get('activity') ?? EMPTY_ACTIVITY_SNAPSHOT)
  const transientError = useSession(value => value.lastAgentError)
  const runtimeStatus = useSessions(value =>
    value.byId[sessionId]?.projectionValues?.runtimeStatus)

  return (
    <div className={css.root}>
      <section className={css.runtime} aria-labelledby="activity-runtime-heading">
        <div className={css.sectionHeading}>
          <h2 id="activity-runtime-heading">{t('activity.runtime.heading')}</h2>
          <span>{t('activity.runtime.current')}</span>
        </div>
        <RuntimeSummary status={runtimeStatus} t={t} />
        {transientError !== null && (
          <div className={css.transient} role="status">
            <strong>{t('activity.transient.heading')}</strong>
            <span>{transientError}</span>
          </div>
        )}
      </section>
      <section className={css.ledger} aria-labelledby="activity-ledger-heading">
        <div className={css.sectionHeading}>
          <h2 id="activity-ledger-heading">{t('activity.ledger.heading')}</h2>
          <span>{t('activity.ledger.count', { count: snapshot.records.length })}</span>
        </div>
        {snapshot.records.length === 0
          ? <p className={css.empty}>{t('activity.ledger.empty')}</p>
          : (
            <ol>
              {snapshot.records.map(record => (
                <li key={record.seq} data-kind={record.kind}>
                  <time dateTime={new Date(record.time).toISOString()}>{timestamp(record.time)}</time>
                  <div className={css.record}><RecordBody record={record} t={t} /></div>
                </li>
              ))}
            </ol>
          )}
      </section>
    </div>
  )
}
