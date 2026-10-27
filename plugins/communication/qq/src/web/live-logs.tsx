import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { getErrorMessage, HostApiError, subscribePluginLogs, useI18n } from '@eating/ui-sdk'
import type { PluginLogEntry } from '@eating/plugin-sdk'
import './i18n'
import './live-logs.css'

interface LiveLogsProps { active: boolean; enabled: boolean; available: boolean }
type LogStreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
interface LogFailure { message: string; code: string }

const retentionOptions = [50, 100, 200, 500, 1000] as const

function trimEntries(buffer: Map<string, PluginLogEntry>, limit: number) {
  while (buffer.size > limit) {
    const oldest = buffer.keys().next().value
    if (oldest === undefined) break
    buffer.delete(oldest)
  }
}
function failureFrom(error: unknown): LogFailure {
  if (error instanceof HostApiError) return { message: error.message, code: error.code }
  return { message: error instanceof Error ? error.message : '', code: 'LOG_SUBSCRIPTION_FAILED' }
}
function metadataValue(entry: PluginLogEntry, key: string): string | null {
  const value = entry.metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

const LogRow = memo(function LogRow({ entry }: { entry: PluginLogEntry }) {
  const { t, formatDateTime } = useI18n('qq')
  const kind = metadataValue(entry, 'kind')
  const admission = metadataValue(entry, 'queueAdmission')
  const identifiers: [string, string | null][] = [
    [t('logs.delivery'), admission === 'queued' ? t('logs.queued') : admission === 'rejected' ? t('logs.rejected') : admission === 'not-forwarded' ? t('logs.notForwarded') : null],
    [t('logs.sender'), metadataValue(entry, 'senderId')],
    [t('logs.groupId'), kind === 'group' ? metadataValue(entry, 'groupId') : null],
    [t('logs.conversation'), metadataValue(entry, 'conversationId')],
    [t('logs.messageId'), metadataValue(entry, 'messageId')],
    [t('logs.account'), metadataValue(entry, 'accountId')],
    [t('logs.instance'), metadataValue(entry, 'instanceId')],
  ]
  return <li className="qq-live-log-row">
    <div className="qq-live-log-heading">
      <time dateTime={entry.timestamp} title={entry.timestamp}>{formatDateTime(entry.timestamp, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
      <span className="qq-live-log-level" data-level={entry.level}>{t(`logs.level.${entry.level}`)}</span>
      <strong>{entry.event === 'message.received' ? t('logs.received') : entry.event}</strong>
      {(kind === 'private' || kind === 'group') && <span>{t(kind === 'group' ? 'logs.group' : 'logs.private')}</span>}
    </div>
    <dl className="qq-live-log-identifiers">{identifiers.map(([label, value]) => value !== null && <div key={label}><dt>{label}</dt><dd><bdi>{value}</bdi></dd></div>)}</dl>
    <p className="qq-live-log-message">{entry.message}</p>
  </li>
})

export function LiveLogs({ active, enabled, available }: LiveLogsProps) {
  const { t, formatNumber } = useI18n('qq')
  const prefix = useId()
  const [entries, setEntries] = useState<PluginLogEntry[]>([])
  const [limit, setLimit] = useState<number>(100)
  const [streamState, setStreamState] = useState<LogStreamState>('closed')
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden)
  const [failure, setFailure] = useState<LogFailure | null>(null)
  const [announcement, setAnnouncement] = useState<{ count: number; received: number } | null>(null)
  const buffer = useRef(new Map<string, PluginLogEntry>())
  const limitRef = useRef(100)
  const generation = useRef(0)
  const frame = useRef<number | null>(null)
  const announcementTimer = useRef<number | null>(null)
  const pendingAnnouncements = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)

  const clearDisplay = useCallback((updateDisplay = true) => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    if (announcementTimer.current !== null) window.clearTimeout(announcementTimer.current)
    frame.current = null
    announcementTimer.current = null
    pendingAnnouncements.current = 0
    buffer.current.clear()
    followLatest.current = true
    if (updateDisplay) { setEntries([]); setAnnouncement(null) }
  }, [])

  useLayoutEffect(() => {
    let disposed = false
    let pageHidden = false
    let running = false
    let received = 0
    let cleanup: (() => void) | null = null

    function stop() {
      running = false
      ++generation.current
      const cancel = cleanup
      cleanup = null
      cancel?.()
      received = 0
      clearDisplay(!disposed)
      if (!disposed) { setStreamState('closed'); setFailure(null) }
    }
    function start() {
      if (disposed || running || !active || !enabled || !available || document.hidden || pageHidden) return
      running = true
      const current = ++generation.current
      const isCurrent = () => !disposed && running && current === generation.current && active && enabled && available && !document.hidden && !pageHidden
      setStreamState('connecting')
      setFailure(null)
      try {
        const unsubscribe = subscribePluginLogs('qq', {
          onEntry(entry) {
            if (!isCurrent() || buffer.current.has(entry.id)) return
            buffer.current.set(entry.id, entry)
            trimEntries(buffer.current, limitRef.current)
            ++received
            ++pendingAnnouncements.current
            if (frame.current === null) frame.current = window.requestAnimationFrame(() => {
              if (!isCurrent()) return
              frame.current = null
              setEntries(Array.from(buffer.current.values()))
            })
            if (announcementTimer.current === null) announcementTimer.current = window.setTimeout(() => {
              if (!isCurrent()) return
              announcementTimer.current = null
              const count = pendingAnnouncements.current
              pendingAnnouncements.current = 0
              setAnnouncement({ count, received })
            }, 1000)
          },
          onState(state) { if (isCurrent()) setStreamState(state) },
          onError(error) { if (isCurrent()) setFailure(failureFrom(error)) },
        })
        if (isCurrent()) cleanup = unsubscribe
        else unsubscribe()
      } catch (error) {
        if (isCurrent()) { setStreamState('closed'); setFailure(failureFrom(error)) }
      }
    }
    function synchronize() {
      if (disposed) return
      const pageVisible = !document.hidden && !pageHidden
      setVisible(pageVisible)
      if (active && enabled && available && pageVisible) start()
      else stop()
    }
    function onPageHide() { pageHidden = true; synchronize() }
    function onPageShow() { pageHidden = false; synchronize() }

    document.addEventListener('visibilitychange', synchronize)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    synchronize()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', synchronize)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      stop()
    }
  }, [active, enabled, available, clearDisplay])

  useLayoutEffect(() => {
    if (followLatest.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [entries])

  function changeLimit(value: string) {
    const next = Number(value)
    if (!retentionOptions.some(option => option === next)) return
    limitRef.current = next
    setLimit(next)
    trimEntries(buffer.current, next)
    setEntries(Array.from(buffer.current.values()))
  }

  const listening = active && enabled && available && visible
  const displayedState = listening ? streamState : 'closed'
  const stoppedReason = !enabled ? t('logs.disabled') : !available ? t('logs.unavailable') : !visible ? t('logs.hidden') : ''
  const waiting = listening && streamState !== 'closed'

  return <div className="qq-live-logs" hidden={!active} aria-labelledby={`${prefix}-heading`}>
    <div className="section-heading"><h3 id={`${prefix}-heading`}>{t('tabs.logs')}</h3><p id={`${prefix}-notice`}>{t('logs.description')}</p></div>
    <div className="qq-live-logs-toolbar">
      <div className="field qq-live-logs-limit"><label htmlFor={`${prefix}-limit`}>{t('logs.limit.label')}</label><select id={`${prefix}-limit`} value={limit} aria-describedby={`${prefix}-limit-hint`} onChange={event => changeLimit(event.target.value)}>{retentionOptions.map(value => <option key={value} value={value}>{t('logs.limit.option', { count: value, value: formatNumber(value) })}</option>)}</select></div>
      <button className="button button-secondary" type="button" disabled={entries.length === 0} onClick={() => clearDisplay()}>{t('action.clearLogs')}</button>
    </div>
    <p className="qq-help" id={`${prefix}-limit-hint`}>{t('logs.limit.help')}</p>
    <div className="qq-live-logs-status">
      <p role="status" aria-live="polite" aria-atomic="true"><span>{t('logs.channel')}</span><strong data-state={displayedState}>{t(`logs.${displayedState}`)}</strong>{stoppedReason && <span> · {stoppedReason}</span>}</p>
      <span className="qq-live-logs-count">{t('logs.count', { current: formatNumber(entries.length), limit: formatNumber(limit) })}</span>
    </div>
    {failure && <div className="qq-error" role="alert"><div><p>{getErrorMessage(failure, t('logs.failure'))}</p><details><summary>{t('error.details')}</summary><small>{t('error.code', { code: failure.code })}</small>{failure.message && <p>{failure.message}</p>}</details></div></div>}
    <div className="qq-live-logs-scroller" ref={scroller} role="log" aria-label={t('logs.label')} aria-describedby={`${prefix}-notice`} aria-live="off" aria-relevant="additions" aria-atomic="false" tabIndex={entries.length > 0 ? 0 : -1} onScroll={event => {
      const element = event.currentTarget
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    }}>
      {entries.length > 0 ? <ol className="qq-live-logs-list">{entries.map(entry => <LogRow key={entry.id} entry={entry} />)}</ol> : <div className="qq-empty qq-live-logs-empty"><strong>{t(waiting ? 'logs.waiting' : 'logs.stopped')}</strong><p>{t(waiting ? 'logs.waitingHelp' : !enabled ? 'logs.disabledHelp' : !available ? 'logs.unavailableHelp' : 'logs.stoppedHelp')}</p></div>}
    </div>
    <p className="qq-live-logs-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement ? t('logs.announcement', { count: announcement.count, value: formatNumber(announcement.count), total: formatNumber(announcement.received) }) : ''}</p>
  </div>
}
