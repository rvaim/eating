import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { ChevronDown, ChevronRight, Pause, Play, Search, Terminal, ArrowDown } from 'lucide-react'
import { ActionButton, createRequestId, getErrorMessage, HostApiError, hostRequest, subscribePluginLogs, UnknownOutcomeCard, useI18n } from '@eating/ui-sdk'
import type { JsonObject, JsonValue, PluginLogEntry, PluginToolDefinition } from '@eating/plugin-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import './i18n'
import './live-logs.css'

export interface QuickTestPrefill {
  toolName: string
  values: Record<string, string>
}

interface LiveLogsProps {
  active: boolean
  enabled: boolean
  available: boolean
  tools?: readonly PluginToolDefinition[]
  actionLock?: MutableRefObject<boolean>
  onFeedback?: (message: string) => void
  onOpenFullTests?: (prefill: QuickTestPrefill) => void
}
type LogStreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
type LevelFilter = 'all' | 'info' | 'warn' | 'error'
type KindFilter = 'all' | 'private' | 'group'
type AdmissionFilter = 'all' | 'queued' | 'not-forwarded' | 'rejected'
interface LogFailure { message: string; code: string }
interface QuickFailure { message: string; code: string; outcome: string }
interface QuickExecution { requestId: string; ok: boolean; summary: string; failure?: QuickFailure }

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
function quickFailureFrom(error: unknown): QuickFailure {
  if (error instanceof HostApiError) return { message: error.message, code: error.code, outcome: error.outcome }
  return { message: error instanceof Error ? error.message : '', code: 'UNEXPECTED_ERROR', outcome: 'unknown' }
}
function metadataValue(entry: PluginLogEntry, key: string): string | null {
  const value = entry.metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function admissionLabelKey(admission: string | null): 'logs.queued' | 'logs.rejected' | 'logs.notForwarded' | null {
  if (admission === 'queued') return 'logs.queued'
  if (admission === 'rejected') return 'logs.rejected'
  if (admission === 'not-forwarded') return 'logs.notForwarded'
  return null
}

interface LogRowProps {
  entry: PluginLogEntry
  expanded: boolean
  onToggleExpand: (id: string) => void
  onFillTarget?: (kind: 'private' | 'group', targetId: string) => void
}

const LogRow = memo(function LogRow({ entry, expanded, onToggleExpand, onFillTarget }: LogRowProps) {
  const { t, formatDateTime } = useI18n('qq')
  const kind = metadataValue(entry, 'kind')
  const admission = metadataValue(entry, 'queueAdmission')
  const senderId = metadataValue(entry, 'senderId')
  const groupId = metadataValue(entry, 'groupId')
  const conversationId = metadataValue(entry, 'conversationId')
  const messageId = metadataValue(entry, 'messageId')
  const accountId = metadataValue(entry, 'accountId')
  const instanceId = metadataValue(entry, 'instanceId')
  const admissionKey = admissionLabelKey(admission)

  const summaryTarget = kind === 'group' && groupId
    ? `${t('logs.groupId')} ${groupId}${senderId ? ` · ${senderId}` : ''}`
    : senderId
      ? `${t('logs.sender')} ${senderId}`
      : null

  const fillKind: 'private' | 'group' | null = kind === 'group' && groupId ? 'group' : senderId ? 'private' : null
  const fillId = fillKind === 'group' ? groupId : senderId

  const identifiers: [string, string | null][] = [
    [t('logs.delivery'), admissionKey ? t(admissionKey) : null],
    [t('logs.sender'), senderId],
    [t('logs.groupId'), kind === 'group' ? groupId : null],
    [t('logs.conversation'), conversationId],
    [t('logs.messageId'), messageId],
    [t('logs.account'), accountId],
    [t('logs.instance'), instanceId],
  ]

  return (
    <li className={`qq-live-log-row${expanded ? ' is-expanded' : ''}`}>
      <div className="qq-live-log-main">
        <div className="qq-live-log-heading">
          <time dateTime={entry.timestamp} title={entry.timestamp}>
            {formatDateTime(entry.timestamp, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </time>
          <span className="qq-live-log-level" data-level={entry.level}>{t(`logs.level.${entry.level}`)}</span>
          <strong>{entry.event === 'message.received' ? t('logs.received') : entry.event}</strong>
          {(kind === 'private' || kind === 'group') && (
            <span className="qq-live-log-pill">{t(kind === 'group' ? 'logs.group' : 'logs.private')}</span>
          )}
          {admissionKey && (
            <span className={`qq-live-log-pill is-${admission}`}>
              {t(admissionKey)}
            </span>
          )}
          {summaryTarget && <span className="qq-live-log-target"><bdi>{summaryTarget}</bdi></span>}
        </div>
        <div className="qq-live-log-row-actions">
          {onFillTarget && fillKind && fillId && (
            <button
              type="button"
              className="text-button qq-live-log-action-btn"
              onClick={() => onFillTarget(fillKind, fillId)}>
              {t('logs.fillTarget')}
            </button>
          )}
          <button
            type="button"
            className="text-button qq-live-log-expand-btn"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(entry.id)}>
            {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            {t(expanded ? 'logs.detailsHide' : 'logs.detailsShow')}
          </button>
        </div>
      </div>
      <p className={`qq-live-log-message${expanded ? '' : ' is-compact'}`}>{entry.message}</p>
      {expanded && (
        <dl className="qq-live-log-identifiers">
          {identifiers.map(([label, value]) => value !== null && (
            <div key={label}><dt>{label}</dt><dd><bdi>{value}</bdi></dd></div>
          ))}
        </dl>
      )}
    </li>
  )
})

export function LiveLogs({ active, enabled, available, tools = [], actionLock, onFeedback, onOpenFullTests }: LiveLogsProps) {
  const { t, formatNumber } = useI18n('qq')
  const prefix = useId()
  const [entries, setEntries] = useState<PluginLogEntry[]>([])
  const [limit, setLimit] = useState<number>(100)
  const [streamState, setStreamState] = useState<LogStreamState>('closed')
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden)
  const [failure, setFailure] = useState<LogFailure | null>(null)
  const [announcement, setAnnouncement] = useState<{ count: number; received: number } | null>(null)

  // Filters & interactive viewing state
  const [searchQuery, setSearchQuery] = useState('')
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [admissionFilter, setAdmissionFilter] = useState<AdmissionFilter>('all')
  const [following, setFollowing] = useState(true)
  const [pausedNewCount, setPausedNewCount] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})

  // Pinned Quick Tester drawer state (kept lightweight inside LiveLogs tab)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickKind, setQuickKind] = useState<'private' | 'group'>('private')
  const [quickTargetId, setQuickTargetId] = useState('')
  const [quickText, setQuickText] = useState('')
  const [quickConfirm, setQuickConfirm] = useState(false)
  const [quickRequestId, setQuickRequestId] = useState(() => createRequestId())
  const [quickPending, setQuickPending] = useState(false)
  const [quickExecution, setQuickExecution] = useState<QuickExecution | null>(null)
  const [quickUnknownReviewed, setQuickUnknownReviewed] = useState(false)
  const quickController = useRef<AbortController | null>(null)

  const buffer = useRef(new Map<string, PluginLogEntry>())
  const limitRef = useRef(100)
  const generation = useRef(0)
  const frame = useRef<number | null>(null)
  const announcementTimer = useRef<number | null>(null)
  const pendingAnnouncements = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  followLatest.current = following

  const clearDisplay = useCallback((updateDisplay = true) => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    if (announcementTimer.current !== null) window.clearTimeout(announcementTimer.current)
    frame.current = null
    announcementTimer.current = null
    pendingAnnouncements.current = 0
    buffer.current.clear()
    followLatest.current = true
    if (updateDisplay) {
      setEntries([])
      setAnnouncement(null)
      setPausedNewCount(0)
      setExpandedIds({})
      setFollowing(true)
    }
  }, [])

  const resetQuickSensitive = useCallback(() => {
    quickController.current?.abort()
    quickController.current = null
    setQuickPending(false)
    setQuickExecution(null)
    setQuickConfirm(false)
    setQuickUnknownReviewed(false)
  }, [])

  useEffect(() => {
    if (!active || !enabled) resetQuickSensitive()
  }, [active, enabled, resetQuickSensitive])

  useEffect(() => {
    function onVis() {
      if (document.hidden) resetQuickSensitive()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', resetQuickSensitive)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', resetQuickSensitive)
      resetQuickSensitive()
    }
  }, [resetQuickSensitive])

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
            if (!followLatest.current) {
              setPausedNewCount(count => count + 1)
            }
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
    if (following && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    }
  }, [entries, following])

  function changeLimit(value: string) {
    const next = Number(value)
    if (!retentionOptions.some(option => option === next)) return
    limitRef.current = next
    setLimit(next)
    trimEntries(buffer.current, next)
    setEntries(Array.from(buffer.current.values()))
  }

  function resumeFollowing() {
    setFollowing(true)
    setPausedNewCount(0)
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }

  function handleFillTarget(kind: 'private' | 'group', targetId: string) {
    setQuickKind(kind)
    setQuickTargetId(targetId)
    setQuickConfirm(false)
    setQuickRequestId(createRequestId())
    setQuickOpen(true)
    onFeedback?.(t('logs.targetFilled'))
  }

  async function runQuickReadOnly(toolName: 'qq_get_login_info' | 'qq_get_status') {
    if (!enabled || quickPending || actionLock?.current || document.hidden) return
    const controller = new AbortController()
    quickController.current = controller
    if (actionLock) actionLock.current = true
    setQuickPending(true)
    const reqId = createRequestId()
    try {
      const response = await hostRequest<{ ok: true; requestId: string; result: JsonValue }>('/plugins/qq/invoke', {
        method: 'POST',
        signal: controller.signal,
        body: { name: toolName, arguments: {}, requestId: reqId },
      })
      if (controller.signal.aborted) return
      const summary = isJsonObject(response.result) ? JSON.stringify(response.result) : String(response.result)
      setQuickExecution({ requestId: reqId, ok: true, summary })
    } catch (error) {
      if (!controller.signal.aborted) {
        const fail = quickFailureFrom(error)
        setQuickExecution({ requestId: reqId, ok: false, summary: getErrorMessage(fail, t('error.operationFailed')), failure: fail })
      }
    } finally {
      if (quickController.current === controller) quickController.current = null
      if (actionLock) actionLock.current = false
      setQuickPending(false)
    }
  }

  async function runQuickSend(reuseUnknown = false) {
    if (!enabled || quickPending || actionLock?.current || document.hidden || !quickConfirm) return
    const targetDigits = quickTargetId.trim()
    if (!/^[1-9]\d{0,15}$/.test(targetDigits) || !quickText.trim()) return
    if (!reuseUnknown && quickExecution?.failure?.outcome === 'unknown') return
    if (reuseUnknown && !quickUnknownReviewed) return
    const reqId = reuseUnknown && quickExecution ? quickExecution.requestId : quickRequestId
    const controller = new AbortController()
    quickController.current = controller
    if (actionLock) actionLock.current = true
    setQuickPending(true)
    const args: JsonObject = {
      message_type: quickKind,
      ...(quickKind === 'private' ? { user_id: targetDigits } : { group_id: targetDigits }),
      message: quickText,
      request_id: reqId,
    }
    try {
      const response = await hostRequest<{ ok: true; requestId: string; result: JsonValue }>('/plugins/qq/invoke', {
        method: 'POST',
        signal: controller.signal,
        body: { name: 'qq_send_message', arguments: args, requestId: reqId, confirmed: true },
      })
      if (controller.signal.aborted) return
      setQuickExecution({ requestId: reqId, ok: true, summary: JSON.stringify(response.result) })
      setQuickConfirm(false)
      setQuickUnknownReviewed(false)
      setQuickRequestId(createRequestId())
    } catch (error) {
      if (!controller.signal.aborted) {
        const fail = quickFailureFrom(error)
        setQuickExecution({ requestId: reqId, ok: false, summary: getErrorMessage(fail, t('error.operationFailed')), failure: fail })
        if (fail.outcome !== 'unknown') setQuickRequestId(createRequestId())
        setQuickConfirm(false)
        setQuickUnknownReviewed(false)
      }
    } finally {
      if (quickController.current === controller) quickController.current = null
      if (actionLock) actionLock.current = false
      setQuickPending(false)
    }
  }

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return entries.filter(entry => {
      if (levelFilter !== 'all' && entry.level !== levelFilter) return false
      const kind = metadataValue(entry, 'kind')
      if (kindFilter !== 'all' && kind !== kindFilter) return false
      const admission = metadataValue(entry, 'queueAdmission')
      if (admissionFilter !== 'all' && admission !== admissionFilter) return false
      if (!q) return true
      const hay = [
        entry.message,
        entry.event,
        metadataValue(entry, 'senderId') ?? '',
        metadataValue(entry, 'groupId') ?? '',
        metadataValue(entry, 'conversationId') ?? '',
        metadataValue(entry, 'messageId') ?? '',
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [entries, searchQuery, levelFilter, kindFilter, admissionFilter])

  const hasFilters = Boolean(searchQuery.trim()) || levelFilter !== 'all' || kindFilter !== 'all' || admissionFilter !== 'all'
  const listening = active && enabled && available && visible
  const displayedState = listening ? streamState : 'closed'
  const stoppedReason = !enabled ? t('logs.disabled') : !available ? t('logs.unavailable') : !visible ? t('logs.hidden') : ''
  const waiting = listening && streamState !== 'closed'
  const hasSendMessageTool = tools.length === 0 || tools.some(item => item.name === 'qq_send_message')
  const quickTargetValid = /^[1-9]\d{0,15}$/.test(quickTargetId.trim())
  const quickUnknown = quickExecution?.failure?.outcome === 'unknown'

  return <div className="qq-live-logs" hidden={!active} aria-labelledby={`${prefix}-heading`}>
    <div className="qq-live-logs-head-row">
      <div className="section-heading"><h3 id={`${prefix}-heading`}>{t('tabs.logs')}</h3><p id={`${prefix}-notice`}>{t('logs.description')}</p></div>
      <ActionButton
        reasonCode="busy"
        type="button"
        className={`button button-secondary qq-quick-drawer-toggle${quickOpen ? ' is-open' : ''}`}
        onClick={() => setQuickOpen(open => !open)}>
        <Terminal size={14} aria-hidden="true" />
        {t(quickOpen ? 'logs.quickTesterClose' : 'logs.quickTesterOpen')}
      </ActionButton>
    </div>

    {quickOpen && (
      <section className="qq-quick-drawer" aria-label={t('logs.quickTesterTitle')}>
        <div className="qq-quick-drawer-head">
          <div>
            <strong>{t('logs.quickTesterTitle')}</strong>
            <p>{t('logs.quickTesterHelp')}</p>
          </div>
          {onOpenFullTests && (
            <button
              type="button"
              className="text-button"
              onClick={() => onOpenFullTests({
                toolName: 'qq_send_message',
                values: {
                  message_type: quickKind,
                  ...(quickKind === 'private' ? { user_id: quickTargetId.trim() } : { group_id: quickTargetId.trim() }),
                  ...(quickText ? { message: quickText } : {}),
                },
              })}>
              {t('logs.quickTesterOpenFull')}
            </button>
          )}
        </div>
        <div className="qq-quick-drawer-readonly">
          <span>{t('logs.quickTesterReadOnly')}:</span>
          <ActionButton reasonCode={!enabled ? 'enable' : 'busy'} type="button" className="button button-secondary" disabled={!enabled || quickPending} onClick={() => void runQuickReadOnly('qq_get_login_info')}>
            {t('tool.qq_get_login_info.title')}
          </ActionButton>
          <ActionButton reasonCode={!enabled ? 'enable' : 'busy'} type="button" className="button button-secondary" disabled={!enabled || quickPending} onClick={() => void runQuickReadOnly('qq_get_status')}>
            {t('tool.qq_get_status.title')}
          </ActionButton>
        </div>
        {hasSendMessageTool && (
          <div className="qq-quick-drawer-send">
            <div className="qq-quick-send-grid">
              <div className="qq-quick-field">
                <label htmlFor={`${prefix}-qt-kind`}>{t('logs.quickTesterTargetType')}</label>
                <select id={`${prefix}-qt-kind`} value={quickKind} disabled={!enabled || quickPending || quickUnknown} onChange={e => { setQuickKind(e.target.value as 'private' | 'group'); setQuickConfirm(false); setQuickRequestId(createRequestId()) }}>
                  <option value="private">{t('option.message_type.private')}</option>
                  <option value="group">{t('option.message_type.group')}</option>
                </select>
              </div>
              <div className="qq-quick-field">
                <label htmlFor={`${prefix}-qt-target`}>{t('logs.quickTesterTargetId')}</label>
                <input id={`${prefix}-qt-target`} type="text" inputMode="numeric" value={quickTargetId} disabled={!enabled || quickPending || quickUnknown} placeholder={t('logs.quickTesterTargetPlaceholder')} onChange={e => { setQuickTargetId(e.target.value); setQuickConfirm(false); setQuickRequestId(createRequestId()) }} />
              </div>
              <div className="qq-quick-field qq-quick-field-text">
                <label htmlFor={`${prefix}-qt-text`}>{t('logs.quickTesterTextLabel')}</label>
                <input id={`${prefix}-qt-text`} type="text" value={quickText} disabled={!enabled || quickPending || quickUnknown} placeholder={t('logs.quickTesterTextPlaceholder')} onChange={e => { setQuickText(e.target.value); setQuickConfirm(false); setQuickRequestId(createRequestId()) }} />
              </div>
            </div>
            <label className="qq-check qq-quick-confirm">
              <input type="checkbox" checked={quickConfirm} disabled={!enabled || quickPending || !quickTargetValid || !quickText.trim()} onChange={e => setQuickConfirm(e.target.checked)} />
              <span>{t('tests.confirmSend.label')}</span>
            </label>
            <div className="qq-actions">
              <ActionButton
                reasonCode={!enabled ? 'enable' : quickUnknown ? 'unknown' : 'confirm'}
                type="button"
                className="button button-primary"
                disabled={!enabled || quickPending || quickUnknown || !quickTargetValid || !quickText.trim() || !quickConfirm}
                onClick={() => void runQuickSend(false)}>
                {t(quickPending ? 'action.running' : 'logs.quickTesterSend')}
              </ActionButton>
              <span className="qq-request-id">{t('tests.requestId', { id: quickRequestId })}</span>
            </div>
          </div>
        )}
        {quickUnknown && quickExecution && (
          <UnknownOutcomeCard
            requestId={quickExecution.requestId}
            onConfirmReviewed={() => {
              setQuickExecution(null)
              setQuickRequestId(createRequestId())
              setQuickUnknownReviewed(false)
            }}
          />
        )}
        {quickExecution && !quickUnknown && (
          <div className={quickExecution.ok ? 'qq-operation-result' : 'qq-error'} role={quickExecution.ok ? 'status' : 'alert'}>
            <code>{quickExecution.summary}</code>
          </div>
        )}
      </section>
    )}

    <div className="qq-live-logs-toolbar">
      <div className="qq-live-logs-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label={t('logs.searchLabel')}
          placeholder={t('logs.searchPlaceholder')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="qq-live-logs-filters">
        <select aria-label={t('logs.levelFilter.label')} value={levelFilter} onChange={e => setLevelFilter(e.target.value as LevelFilter)}>
          <option value="all">{t('logs.levelFilter.all')}</option>
          <option value="info">{t('logs.level.info')}</option>
          <option value="warn">{t('logs.level.warn')}</option>
          <option value="error">{t('logs.level.error')}</option>
        </select>
        <select aria-label={t('logs.kindFilter.label')} value={kindFilter} onChange={e => setKindFilter(e.target.value as KindFilter)}>
          <option value="all">{t('logs.kindFilter.all')}</option>
          <option value="private">{t('logs.private')}</option>
          <option value="group">{t('logs.group')}</option>
        </select>
        <select aria-label={t('logs.admissionFilter.label')} value={admissionFilter} onChange={e => setAdmissionFilter(e.target.value as AdmissionFilter)}>
          <option value="all">{t('logs.admissionFilter.all')}</option>
          <option value="queued">{t('logs.queued')}</option>
          <option value="not-forwarded">{t('logs.notForwarded')}</option>
          <option value="rejected">{t('logs.rejected')}</option>
        </select>
      </div>
      <div className="field qq-live-logs-limit">
        <label htmlFor={`${prefix}-limit`}>{t('logs.limit.label')}</label>
        <select id={`${prefix}-limit`} value={limit} aria-describedby={`${prefix}-limit-hint`} onChange={event => changeLimit(event.target.value)}>
          {retentionOptions.map(value => <option key={value} value={value}>{t('logs.limit.option', { count: value, value: formatNumber(value) })}</option>)}
        </select>
      </div>
      <div className="qq-live-logs-controls">
        <button
          type="button"
          className={`button button-secondary qq-live-logs-pause-btn${!following ? ' is-paused' : ''}`}
          aria-pressed={!following}
          onClick={() => {
            if (following) setFollowing(false)
            else resumeFollowing()
          }}>
          {following ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {t(following ? 'logs.pause' : 'logs.resume')}
        </button>
        <ActionButton reasonCode="empty" className="button button-secondary" type="button" disabled={entries.length === 0} onClick={() => clearDisplay()}>{t('action.clearLogs')}</ActionButton>
      </div>
    </div>

    <p className="qq-help" id={`${prefix}-limit-hint`}>{t('logs.limit.help')}</p>
    <div className="qq-live-logs-status">
      <p role="status" aria-live="polite" aria-atomic="true"><span>{t('logs.channel')}</span><strong data-state={displayedState}>{t(`logs.${displayedState}`)}</strong>{stoppedReason && <span> · {stoppedReason}</span>}</p>
      <span className="qq-live-logs-count">{t('logs.count', { current: formatNumber(filteredEntries.length), limit: formatNumber(limit) })}</span>
    </div>
    {failure && <div className="qq-error" role="alert"><div><p>{getErrorMessage(failure, t('logs.failure'))}</p><details><summary>{t('error.details')}</summary><small>{t('error.code', { code: failure.code })}</small>{failure.message && <p>{failure.message}</p>}</details></div></div>}

    {!following && pausedNewCount > 0 && (
      <div className="qq-live-logs-paused-banner" role="status">
        <span>{t('logs.pausedBanner', { count: pausedNewCount })}</span>
        <button type="button" className="button button-primary" onClick={resumeFollowing}>
          <ArrowDown size={13} aria-hidden="true" />
          {t('logs.jumpLatest')}
        </button>
      </div>
    )}

    <div className="qq-live-logs-scroller" ref={scroller} role="log" aria-label={t('logs.label')} aria-describedby={`${prefix}-notice`} aria-live="off" aria-relevant="additions" aria-atomic="false" tabIndex={entries.length > 0 ? 0 : -1} onScroll={event => {
      const element = event.currentTarget
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      if (atBottom && !following) resumeFollowing()
      else if (!atBottom && following) setFollowing(false)
    }}>
      {filteredEntries.length > 0 ? (
        <ol className="qq-live-logs-list">
          {filteredEntries.map(entry => (
            <LogRow
              key={entry.id}
              entry={entry}
              expanded={Boolean(expandedIds[entry.id])}
              onToggleExpand={id => setExpandedIds(current => ({ ...current, [id]: !current[id] }))}
              onFillTarget={hasSendMessageTool ? handleFillTarget : undefined}
            />
          ))}
        </ol>
      ) : entries.length > 0 && hasFilters ? (
        <div className="qq-empty qq-live-logs-empty">
          <strong>{t('logs.filteredEmpty')}</strong>
          <div className="qq-actions">
            <button type="button" className="button button-secondary" onClick={() => { setSearchQuery(''); setLevelFilter('all'); setKindFilter('all'); setAdmissionFilter('all') }}>
              {t('logs.clearFilters')}
            </button>
          </div>
        </div>
      ) : (
        <div className="qq-empty qq-live-logs-empty">
          <strong>{t(waiting ? 'logs.waiting' : 'logs.stopped')}</strong>
          <p>{t(waiting ? 'logs.waitingHelp' : !enabled ? 'logs.disabledHelp' : !available ? 'logs.unavailableHelp' : 'logs.stoppedHelp')}</p>
        </div>
      )}
    </div>
    <p className="qq-live-logs-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement ? t('logs.announcement', { count: announcement.count, value: formatNumber(announcement.count), total: formatNumber(announcement.received) }) : ''}</p>
  </div>
}
