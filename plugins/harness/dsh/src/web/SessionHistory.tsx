import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { AlertCircle, Check, Clock, Info, RefreshCw, Search, Trash2 } from 'lucide-react'
import { ActionButton, createRequestId, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { readSessionHistoryPreview, readSessionHistoryResult } from './history-data'
import type { SessionHistoryItem, SessionHistoryPreview } from './history-data'
import './history-i18n'
import type { SessionHistoryTranslationKey } from './history-i18n'
import './history.css'

interface Props {
  readonly active: boolean
  readonly enabled: boolean
  readonly runtimeActive: boolean
  readonly busy: boolean
  readonly actionLock: MutableRefObject<boolean>
  readonly onBusy: (value: boolean) => void
  readonly onRefresh?: () => Promise<void>
}
type Operation = 'scan' | 'clear' | 'delete-selected' | 'residual'
type ConfirmMode = null | 'clear' | 'selected' | 'residual'
interface Failure { readonly key: SessionHistoryTranslationKey; readonly code: string }
interface OutcomeNotice { readonly key: SessionHistoryTranslationKey; readonly count: number; readonly isWarning?: boolean }
interface Request { readonly controller: AbortController; readonly operation: Operation }

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatBytes(bytes: number, formatNumber: (value: number) => string): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round((bytes / 1024) * 10) / 10)} KB`
  return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`
}

function describe(error: unknown, operation: Operation): Failure {
  const code = error instanceof HostApiError ? error.code : 'SESSION_HISTORY_REQUEST_FAILED'
  const mutating = operation !== 'scan'
  if ((mutating && (!(error instanceof HostApiError) || error.outcome === 'unknown')) || ['SESSION_HISTORY_UNKNOWN', 'SESSION_HISTORY_REQUEST_UNKNOWN', 'SESSION_HISTORY_CLEAR_UNKNOWN'].includes(code)) return { key: 'error.unknown', code }
  if (code === 'SESSION_HISTORY_SCHEDULED') return { key: 'error.scheduled', code }
  if (code === 'SESSION_HISTORY_UNSUPPORTED') return { key: 'error.unsupported', code }
  if (code === 'SESSION_HISTORY_PATH_UNSAFE') return { key: 'error.safety', code }
  if (code === 'SESSION_HISTORY_RUNTIME_ACTIVE') return { key: 'error.runtime', code }
  if (code === 'SESSION_HISTORY_RESTART_REQUIRED') return { key: 'error.restartRequired', code }
  if (code === 'SESSION_HISTORY_SESSION_ACTIVE' || code === 'NATIVE_SESSION_ACTIVE') return { key: 'error.sessionActive', code }
  if (code === 'SESSION_HISTORY_UNKNOWN_SESSION') return { key: 'error.unknownSession', code }
  if (code === 'SESSION_HISTORY_QUEUE_PENDING') return { key: 'error.queue', code }
  if (code === 'SESSION_HISTORY_PREVIEW_STALE') return { key: 'error.stale', code }
  if (code === 'SESSION_HISTORY_BUSY') return { key: 'error.busy', code }
  if (code === 'SESSION_HISTORY_RESPONSE_INVALID') return { key: 'error.response', code }
  return { key: operation === 'scan' ? 'error.scan' : 'error.clear', code }
}

function roleKey(role: SessionHistoryItem['role']): SessionHistoryTranslationKey {
  if (role === 'root') return 'role.root'
  if (role === 'conversation') return 'role.conversation'
  if (role === 'proactive') return 'role.proactive'
  if (role === 'execution') return 'role.execution'
  return 'role.other'
}

export function SessionHistorySettings({ active, enabled, runtimeActive, busy, actionLock, onBusy, onRefresh }: Props) {
  const { t, formatNumber, formatDateTime } = useI18n('dsh-history')
  const prefix = useId()
  const [preview, setPreview] = useState<SessionHistoryPreview | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState<Operation | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [outcome, setOutcome] = useState<OutcomeNotice | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const alive = useRef(false)
  const generation = useRef(0)
  const request = useRef<Request | null>(null)
  const cancelButton = useRef<HTMLButtonElement | null>(null)
  const clearButton = useRef<HTMLButtonElement | null>(null)
  const deleteSelectedButton = useRef<HTMLButtonElement | null>(null)
  const clearResidualButton = useRef<HTMLButtonElement | null>(null)
  const lastConfirmOpener = useRef<ConfirmMode>(null)
  const props = useRef({ active, enabled, runtimeActive, busy, onBusy, onRefresh })
  props.current = { active, enabled, runtimeActive, busy, onBusy, onRefresh }

  const cancel = useCallback(() => {
    ++generation.current
    const owned = request.current
    owned?.controller.abort(); request.current = null
    if (owned) { actionLock.current = false; props.current.onBusy(false) }
    if (alive.current) {
      setPreview(null); setSelectedIds(new Set()); setConfirmMode(null); setAcknowledged(false); setPending(null)
      if (owned && owned.operation !== 'scan') setFailure({ key: 'error.unknown', code: 'SESSION_HISTORY_UNKNOWN' })
    }
  }, [actionLock])
  useEffect(() => {
    alive.current = true
    const hidden = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', cancel)
    return () => { alive.current = false; cancel(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cancel) }
  }, [cancel])
  useEffect(() => { if (!active || !enabled) cancel() }, [active, enabled, cancel])
  useEffect(() => {
    if (!preview) return
    setNowMs(Date.now())
    const expiryTimer = window.setTimeout(() => {
      setPreview(null); setSelectedIds(new Set()); setConfirmMode(null); setAcknowledged(false)
      setFailure({ key: 'error.stale', code: 'SESSION_HISTORY_PREVIEW_STALE' })
    }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()))
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => { window.clearTimeout(expiryTimer); window.clearInterval(tick) }
  }, [preview])
  useEffect(() => {
    if (confirmMode) {
      lastConfirmOpener.current = confirmMode
      cancelButton.current?.focus()
    } else if (lastConfirmOpener.current) {
      const opener = lastConfirmOpener.current
      lastConfirmOpener.current = null
      if (opener === 'selected') deleteSelectedButton.current?.focus()
      else if (opener === 'residual') clearResidualButton.current?.focus()
      else clearButton.current?.focus()
    }
  }, [confirmMode])

  const filteredSessions = useMemo(() => {
    if (!preview) return []
    const needle = query.trim().toLowerCase()
    if (!needle) return preview.sessions
    return preview.sessions.filter(item =>
      item.label.toLowerCase().includes(needle)
      || item.id.toLowerCase().includes(needle)
      || (item.agentTypeId?.toLowerCase().includes(needle) ?? false))
  }, [preview, query])

  const selectedItems = useMemo(
    () => preview ? preview.sessions.filter(item => selectedIds.has(item.id)) : [],
    [preview, selectedIds],
  )
  const selectedIncludesRoot = selectedItems.some(item => item.isCurrentRoot)
  const selectedRequiresRestart = Boolean((runtimeActive || preview?.runtimeRunning) && selectedItems.some(item => item.requiresRestart || item.isCurrentRoot || item.live))
  const willRestartOnClear = Boolean(runtimeActive || preview?.runtimeRunning)

  async function perform(operation: Operation) {
    const current = props.current
    if (!alive.current || !current.active || !current.enabled || current.busy || document.hidden || actionLock.current || request.current) return
    if (operation !== 'scan') {
      if (!preview || !acknowledged) return
      if (operation === 'clear' && (confirmMode !== 'clear' || preview.sessionCount === 0)) return
      if (operation === 'residual' && (confirmMode !== 'residual' || preview.sessionCount !== 0 || preview.residualStateCount === 0)) return
      if (operation === 'delete-selected' && (confirmMode !== 'selected' || selectedItems.length === 0)) return
      if (Date.parse(preview.expiresAt) <= Date.now()) {
        setPreview(null); setSelectedIds(new Set()); setConfirmMode(null); setAcknowledged(false)
        setFailure({ key: 'error.stale', code: 'SESSION_HISTORY_PREVIEW_STALE' }); return
      }
    }
    const targetPreview = preview
    const targetSelection = selectedItems.map(item => item.id)
    const restartSelected = selectedRequiresRestart
    const restartClear = Boolean(current.runtimeActive || targetPreview?.runtimeRunning)
    const controller = new AbortController(), ticket = ++generation.current
    request.current = { controller, operation }; actionLock.current = true; current.onBusy(true)
    setPreview(null); setSelectedIds(new Set()); setConfirmMode(null); setAcknowledged(false); setPending(operation); setFailure(null); setOutcome(null)
    if (operation === 'scan') setQuery('')
    const valid = () => alive.current && !controller.signal.aborted && ticket === generation.current && props.current.active && props.current.enabled && !document.hidden
    let refresh = false
    try {
      if (operation === 'scan') {
        const value = readSessionHistoryPreview(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal: controller.signal, body: { operation: 'preview-session-history', input: {} } }))
        if (!valid()) return
        if (Date.parse(value.expiresAt) <= Date.now()) throw new HostApiError('SESSION_HISTORY_PREVIEW_STALE', '')
        setPreview(value)
      } else if (operation === 'delete-selected') {
        const requestId = createRequestId()
        const response = await hostRequest<unknown>('/plugins/dsh/manage', {
          method: 'POST',
          signal: controller.signal,
          body: {
            operation: 'delete-session-history',
            input: {
              previewId: targetPreview!.previewId,
              requestId,
              sessionIds: targetSelection,
              confirmed: true,
              ...(restartSelected ? { allowRestart: true } : {}),
            },
          },
        })
        if (!valid()) return
        const value = readSessionHistoryResult(response, requestId, targetSelection.length)
        if (restartSelected && value.restarted === false) setOutcome({ key: 'completedRestartFailed', count: value.deletedCount, isWarning: true })
        else if (value.mode === 'selected-online') setOutcome({ key: 'completedSelectedOnline', count: value.deletedCount })
        else setOutcome({ key: 'completedSelectedOffline', count: value.deletedCount })
        refresh = true
      } else if (operation === 'residual') {
        const requestId = createRequestId()
        const response = await hostRequest<unknown>('/plugins/dsh/manage', {
          method: 'POST',
          signal: controller.signal,
          body: { operation: 'clear-session-history', input: { previewId: targetPreview!.previewId, requestId, confirmed: true } },
        })
        if (!valid()) return
        const value = readSessionHistoryResult(response, requestId, 0)
        setOutcome({ key: 'completedResidual', count: value.clearedResidualCount ?? targetPreview!.residualStateCount })
        refresh = true
      } else {
        const requestId = createRequestId()
        const response = await hostRequest<unknown>('/plugins/dsh/manage', {
          method: 'POST',
          signal: controller.signal,
          body: {
            operation: 'clear-session-history',
            input: {
              previewId: targetPreview!.previewId,
              requestId,
              confirmed: true,
              ...(restartClear ? { allowRestart: true } : {}),
            },
          },
        })
        if (!valid()) return
        const value = readSessionHistoryResult(response, requestId, targetPreview!.sessionCount)
        if (restartClear && value.restarted === false) setOutcome({ key: 'completedRestartFailed', count: value.deletedCount, isWarning: true })
        else if (value.restarted) setOutcome({ key: 'completedRestarted', count: value.deletedCount })
        else setOutcome({ key: 'completed', count: value.deletedCount })
        refresh = true
      }
    } catch (error) {
      if (valid()) setFailure(describe(error, operation))
    } finally {
      if (request.current?.controller === controller) {
        request.current = null; actionLock.current = false; props.current.onBusy(false)
        if (alive.current && ticket === generation.current) setPending(null)
      }
    }
    if (refresh && valid()) await props.current.onRefresh?.()
  }

  function cancelConfirmation() { setConfirmMode(null); setAcknowledged(false) }
  function toggleSession(id: string) {
    if (confirmMode) return
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function selectBy(predicate: (item: SessionHistoryItem) => boolean) {
    if (!preview || confirmMode) return
    setSelectedIds(new Set(preview.sessions.filter(item => item.deletable && predicate(item)).map(item => item.id)))
  }

  const disabled = !active || !enabled || busy || pending !== null
  const disabledReason = !enabled ? t('reason.disabled') : !active ? t('reason.hidden') : t('reason.busy')
  const queueBlocksRootDelete = Boolean(preview?.hasPendingQueue && selectedIncludesRoot)
  const queueBlocksFullClear = Boolean(preview?.hasPendingQueue && (preview?.sessionCount ?? 0) > 0)
  const remainingMs = preview ? Math.max(0, Date.parse(preview.expiresAt) - nowMs) : 0

  return <section className="dsh-history-settings" aria-labelledby={`${prefix}-title`} aria-busy={pending !== null} onKeyDown={event => { if (event.key === 'Escape' && confirmMode) { event.preventDefault(); cancelConfirmation() } }}>
    <div className="dsh-history-heading"><h3 id={`${prefix}-title`}>{t('title')}</h3><p className="dsh-history-description">{t('description')}</p></div>
    <div className="dsh-history-scope"><h4>{t('scopeTitle')}</h4><p>{t('scope')}</p><p>{t('preserved')}</p><p>{t('after')}</p></div>
    {runtimeActive && <div className="dsh-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('running')}</p></div>}
    <div className="dsh-history-actions"><ActionButton type="button" className="button button-secondary" disabled={disabled} reason={disabledReason} onClick={() => void perform('scan')}><RefreshCw size={15} aria-hidden="true" />{t(pending === 'scan' ? 'scanning' : 'scan')}</ActionButton></div>
    {pending && pending !== 'scan' && <p className="dsh-history-progress" role="status">{t(pending === 'delete-selected' ? 'deleting' : 'clearing')}</p>}
    {failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{t(failure.key)}</p><small>{t('code', { code: failure.code })}</small></div></div>}
    {outcome && <p className={outcome.isWarning ? 'dsh-notice' : 'dsh-result'} role="status">{outcome.isWarning ? <AlertCircle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{t(outcome.key, { value: formatNumber(outcome.count) })}</p>}
    {!preview && !failure && !outcome && !pending && <p className="dsh-history-initial">{t('initial')}</p>}
    {preview && <div className="dsh-history-preview" aria-labelledby={`${prefix}-preview-title`}>
      <div className="dsh-history-preview-head">
        <h4 id={`${prefix}-preview-title`}>{t('previewTitle')}</h4>
        <span className={`dsh-history-runtime-pill${preview.runtimeRunning ? ' is-online' : ''}`}>{t(preview.runtimeRunning ? 'runtimeBadgeOnline' : 'runtimeBadgeStopped')}</span>
      </div>
      <dl className="dsh-history-counts">{(['rootCount', 'childCount', 'sessionCount'] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd>{formatNumber(preview[key])}</dd></div>)}</dl>
      {preview.hasPendingQueue && <div className="dsh-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('pendingQueueHint')}</p></div>}
      <div className="dsh-history-expiry-row">
        <p className="dsh-history-expiry">{t('expires', { time: formatDateTime(preview.expiresAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</p>
        <span className={`dsh-history-countdown${remainingMs <= 30_000 ? ' is-urgent' : ''}`} role="timer">{t('countdown', { remaining: formatCountdown(remainingMs) })}</span>
      </div>

      {preview.sessionCount === 0 && preview.residualStateCount === 0 && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('empty')}</p>}

      {preview.sessionCount === 0 && preview.residualStateCount > 0 && <>
        <div className="dsh-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('residualNotice', { value: formatNumber(preview.residualStateCount) })}</p></div>
        {!confirmMode && <div className="dsh-history-actions">
          <ActionButton ref={clearResidualButton} type="button" className="button button-secondary dsh-history-clear" disabled={disabled} reason={disabledReason} onClick={() => { if (disabled || actionLock.current) return; setConfirmMode('residual'); setAcknowledged(false) }}><Trash2 size={15} aria-hidden="true" />{t('clearResidual')}</ActionButton>
        </div>}
        {confirmMode === 'residual' && <section className="dsh-history-confirm" aria-labelledby={`${prefix}-confirm-title`} aria-describedby={`${prefix}-warning`}>
          <h4 id={`${prefix}-confirm-title`}>{t('confirmResidualTitle')}</h4>
          <p id={`${prefix}-warning`}>{t('warningResidual', { value: formatNumber(preview.residualStateCount) })}</p>
          <label className="dsh-history-acknowledge"><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('acknowledgeResidual')}</span></label>
          <div className="dsh-history-actions">
            <ActionButton ref={cancelButton} type="button" className="button button-secondary" onClick={cancelConfirmation}>{t('cancel')}</ActionButton>
            <ActionButton type="button" className="button button-danger" disabled={disabled || !acknowledged} reason={disabled ? disabledReason : t('reason.confirm')} onClick={() => void perform('residual')}>{t('confirmResidual')}</ActionButton>
          </div>
        </section>}
      </>}

      {preview.sessionCount > 0 && <>
        {preview.sessions.length > 0 && <div className="dsh-history-manager">
          <div className="dsh-history-toolbar">
            <label className="dsh-history-search">
              <Search size={14} aria-hidden="true" />
              <input type="search" value={query} aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} disabled={disabled || confirmMode !== null} onChange={event => setQuery(event.target.value)} />
            </label>
            <div className="dsh-history-quick">
              <button type="button" className="button button-secondary" disabled={disabled || confirmMode !== null} onClick={() => selectBy(item => !item.live && !item.isCurrentRoot)}>{t('selectIdle')}</button>
              <button type="button" className="button button-secondary" disabled={disabled || confirmMode !== null} onClick={() => selectBy(() => true)}>{t('selectAll')}</button>
              <button type="button" className="button button-secondary" disabled={disabled || confirmMode !== null || selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>{t('clearSelection')}</button>
            </div>
          </div>
          {selectedItems.length > 0 && <p className="dsh-history-selection-note" role="status">{t(selectedRequiresRestart ? 'selectionRestartSummary' : 'selectionSummary', { value: formatNumber(selectedItems.length) })}</p>}
          {filteredSessions.length === 0 ? <p className="dsh-history-initial">{t('noFilterMatches')}</p> : <ul className="dsh-history-list">
            {filteredSessions.map(item => {
              const checked = selectedIds.has(item.id)
              const labelText = item.label || t(item.isCurrentRoot || item.isRoot ? 'defaultLabel.root' : 'defaultLabel.child')
              return <li key={item.id} className={`dsh-history-item${checked ? ' is-selected' : ''}${!item.deletable ? ' is-locked' : ''}`}>
                <label className="dsh-history-item-check">
                  <input type="checkbox" checked={checked} disabled={disabled || !item.deletable || confirmMode !== null} aria-label={`${labelText} (${item.id.slice(0, 8)})`} onChange={() => toggleSession(item.id)} />
                  <span className="dsh-history-item-body">
                    <span className="dsh-history-item-top">
                      <strong className="dsh-history-item-title">{labelText}</strong>
                      <code className="dsh-history-item-id" title={item.id}>{item.id.slice(0, 8)}</code>
                    </span>
                    <span className="dsh-history-badges">
                      <span className="dsh-history-badge">{t(roleKey(item.role))}</span>
                      {item.scheduled ? <span className="dsh-history-badge is-warn">{t('status.scheduled')}</span>
                        : item.live ? <span className="dsh-history-badge is-live">{t('status.live')}</span>
                          : <span className="dsh-history-badge">{t('status.idle')}</span>}
                      {item.archived && <span className="dsh-history-badge">{t('status.archived')}</span>}
                      {item.pinned && <span className="dsh-history-badge">{t('status.pinned')}</span>}
                      {item.requiresRestart && <span className="dsh-history-badge is-warn">{t('status.restart')}</span>}
                    </span>
                    <span className="dsh-history-item-meta">
                      <span>{formatBytes(item.sizeBytes, formatNumber)}</span>
                      {item.updatedAt && <span className="dsh-history-item-time"><Clock size={12} aria-hidden="true" />{t('item.updated', { time: formatDateTime(item.updatedAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) })}</span>}
                      {item.agentTypeId && <code>{item.agentTypeId}</code>}
                    </span>
                    {item.scheduled && <span className="dsh-history-item-blocked">{t('item.blockedScheduled')}</span>}
                  </span>
                </label>
              </li>
            })}
          </ul>}
        </div>}

        {!confirmMode && <div className="dsh-history-actions">
          {preview.sessions.length > 0 && <ActionButton ref={deleteSelectedButton} type="button" className="button button-danger" disabled={disabled || selectedItems.length === 0 || queueBlocksRootDelete} reason={queueBlocksRootDelete ? t('reason.queueRoot') : selectedItems.length === 0 ? t('reason.noneSelected') : disabledReason} onClick={() => { if (disabled || selectedItems.length === 0 || queueBlocksRootDelete || actionLock.current) return; setConfirmMode('selected'); setAcknowledged(false) }}><Trash2 size={15} aria-hidden="true" />{t('deleteSelected', { value: formatNumber(selectedItems.length) })}</ActionButton>}
          <ActionButton ref={clearButton} type="button" className="button button-secondary dsh-history-clear" disabled={disabled || queueBlocksFullClear} reason={queueBlocksFullClear ? t('reason.queueRoot') : disabledReason} onClick={() => { if (disabled || queueBlocksFullClear || actionLock.current) return; setConfirmMode('clear'); setAcknowledged(false) }}><Trash2 size={15} aria-hidden="true" />{t('clear')}</ActionButton>
        </div>}

        {confirmMode === 'selected' && <section className="dsh-history-confirm" aria-labelledby={`${prefix}-confirm-title`} aria-describedby={`${prefix}-warning`}>
          <h4 id={`${prefix}-confirm-title`}>{t('confirmSelectedTitle')}</h4>
          <p id={`${prefix}-warning`}>{t(selectedRequiresRestart ? 'warningSelectedRestart' : 'warningSelectedOnline', { value: formatNumber(selectedItems.length) })}</p>
          <label className="dsh-history-acknowledge"><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('acknowledgeSelected')}</span></label>
          <div className="dsh-history-actions">
            <ActionButton ref={cancelButton} type="button" className="button button-secondary" onClick={cancelConfirmation}>{t('cancel')}</ActionButton>
            <ActionButton type="button" className="button button-danger" disabled={disabled || !acknowledged} reason={disabled ? disabledReason : t('reason.confirm')} onClick={() => void perform('delete-selected')}>{t('confirmSelected', { value: formatNumber(selectedItems.length) })}</ActionButton>
          </div>
        </section>}

        {confirmMode === 'clear' && <section className="dsh-history-confirm" aria-labelledby={`${prefix}-confirm-title`} aria-describedby={`${prefix}-warning`}>
          <h4 id={`${prefix}-confirm-title`}>{t('confirmTitle')}</h4>
          <p id={`${prefix}-warning`}>{t(willRestartOnClear ? 'warningRestart' : 'warning', { value: formatNumber(preview.sessionCount) })}</p>
          <label className="dsh-history-acknowledge"><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('acknowledge')}</span></label>
          <div className="dsh-history-actions">
            <ActionButton ref={cancelButton} type="button" className="button button-secondary" onClick={cancelConfirmation}>{t('cancel')}</ActionButton>
            <ActionButton type="button" className="button button-danger" disabled={disabled || !acknowledged} reason={disabled ? disabledReason : t('reason.confirm')} onClick={() => void perform('clear')}>{t('confirm', { value: formatNumber(preview.sessionCount) })}</ActionButton>
          </div>
        </section>}
      </>}
    </div>}
  </section>
}
