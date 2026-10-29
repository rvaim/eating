import type { HarnessSessionRecord, HarnessSessionSummary } from '@eating/plugin-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import { useI18n } from '@eating/ui-sdk'
import { recordText, safeRecordData } from './panel-data'
import type { DshTranslationKey } from './i18n'

const classificationKeys: Partial<Record<NonNullable<HarnessSessionRecord['classification']>, DshTranslationKey>> = {
  'platform-message': 'sessions.record.platform', 'agent-message': 'sessions.record.agent', 'subagent-settled': 'sessions.record.settled',
  'time-context': 'sessions.record.time', 'system-context': 'sessions.record.system', 'tool-call': 'sessions.record.toolCall',
  'tool-result': 'sessions.record.toolResult', 'user-message': 'sessions.record.input', 'runtime-context': 'sessions.record.runtime',
}
const outcomeKeys: Record<string, DshTranslationKey> = {
  success: 'sessions.receipt.success', completed: 'sessions.receipt.success', failed: 'sessions.receipt.failed',
  'not-sent': 'sessions.receipt.notSent', unknown: 'sessions.receipt.unknown', pending: 'sessions.receipt.pending',
}

export function SessionRecord({ record, session }: { readonly record: HarnessSessionRecord; readonly session: HarnessSessionSummary }) {
  const { t, formatDateTime, formatNumber } = useI18n('dsh')
  const classification = record.classification
  const text = recordText(record.content)
  const modelOutput = classification === 'model-output' || record.role === 'assistant'
  const context = classification === 'system-context' || classification === 'time-context' || classification === 'runtime-context' || record.role === 'system'
  const tool = classification === 'tool-call' || classification === 'tool-result' || record.role === 'tool'
  const label = modelOutput ? t(session.parentId === null ? 'sessions.record.mainOutput' : 'sessions.record.childOutput')
    : classification && classificationKeys[classification] ? t(classificationKeys[classification]!)
    : t(record.role === 'tool' ? 'sessions.role.tool' : record.role === 'system' ? 'sessions.record.system' : 'sessions.record.input')
  const value = isJsonObject(record.content) ? record.content : null
  const receipt = value && isJsonObject(value.receipt) ? value.receipt : value
  const outcome = receipt && typeof receipt.outcome === 'string' ? outcomeKeys[receipt.outcome]
    : value && isJsonObject(value.error) && value.error.code === 'NOT_SENT' ? 'sessions.receipt.notSent'
    : value?.isError === true ? 'sessions.receipt.failed' : undefined
  const events = classification === 'platform-message' ? record.platformEvents ?? [] : []
  const body = <>
    {events.length ? <ul className="dsh-platform-messages">{events.map(event => <li key={event.eventId}>
      <div className="dsh-platform-sender"><strong>{event.senderName ? `${event.senderName} · ${event.senderId}` : event.senderId}</strong><time dateTime={event.receivedAt}>{formatDateTime(event.receivedAt)}</time></div>
      <dl className="dsh-platform-meta"><div><dt>{t('sessions.platform.account')}</dt><dd>{event.accountId}</dd></div><div><dt>{t(event.conversationKind === 'group' ? 'sessions.platform.group' : 'sessions.platform.private')}</dt><dd>{event.targetId}</dd></div><div><dt>{t('sessions.platform.source')}</dt><dd>{event.pluginId}</dd></div>{event.messageId && <div><dt>{t('sessions.platform.messageId')}</dt><dd>{event.messageId}</dd></div>}</dl>
      <p className="dsh-record-text" dir="auto">{event.text ?? t('sessions.platform.noText')}</p>
    </li>)}</ul> : text !== null ? text.length <= 800 || context || tool ? <p className="dsh-record-text" dir="auto">{text || t('sessions.emptyText')}</p>
      : <details className="dsh-record-details"><summary>{t('sessions.longText')}</summary><p className="dsh-record-text" dir="auto">{text}</p></details>
      : <p className="dsh-record-muted">{t(tool ? 'sessions.record.structuredTool' : 'sessions.record.structured')}</p>}
    {modelOutput && <p className="dsh-record-muted">{t('sessions.record.outputNotice')}</p>}
    {record.source && <dl className="dsh-record-source">
      {record.source.summary && <div><dt>{t('sessions.source.summary')}</dt><dd dir="auto">{record.source.summary}</dd></div>}
      {record.source.senderSessionId && <div><dt>{t('sessions.source.session')}</dt><dd>{record.source.senderSessionId}</dd></div>}
      {(record.source.provider || record.source.model) && <div><dt>{t('sessions.source.model')}</dt><dd>{[record.source.provider, record.source.model].filter(Boolean).join(' · ')}</dd></div>}
    </dl>}
    {record.callId && <p className="dsh-record-muted">{t('sessions.source.callId', { id: record.callId })}</p>}
    {(tool || context) && typeof record.content !== 'string' && <details className="dsh-record-details"><summary>{t('sessions.recordDetails')}</summary><pre dir="auto">{JSON.stringify(safeRecordData(record.content), null, 2)}</pre></details>}
  </>
  return <li className={`dsh-session-record${context ? ' dsh-record-context' : ''}`} data-classification={classification}>
    <div className="dsh-record-heading"><strong>{label}</strong><span>{t('sessions.sequence', { sequence: formatNumber(record.sequence) })}</span><time dateTime={record.timestamp ?? undefined}>{formatDateTime(record.timestamp)}</time>{outcome && <span className="dsh-record-outcome">{t(outcome)}</span>}</div>
    {context || tool ? <details className="dsh-record-details dsh-record-disclosure"><summary>{t(context ? 'sessions.record.viewContext' : 'sessions.record.viewTool')}</summary>{body}</details> : body}
  </li>
}
