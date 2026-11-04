import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { AlertCircle, Check, Info, RefreshCw, Trash2 } from 'lucide-react'
import { ActionButton, createRequestId, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { readSessionHistoryPreview, readSessionHistoryResult } from './history-data'
import type { SessionHistoryPreview } from './history-data'
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
type Operation = 'scan' | 'clear'
interface Failure { readonly key: SessionHistoryTranslationKey; readonly code: string }
interface Request { readonly controller: AbortController; readonly operation: Operation }

function describe(error: unknown, operation: Operation): Failure {
  const code = error instanceof HostApiError ? error.code : 'SESSION_HISTORY_REQUEST_FAILED'
  if ((operation === 'clear' && (!(error instanceof HostApiError) || error.outcome === 'unknown')) || ['SESSION_HISTORY_UNKNOWN', 'SESSION_HISTORY_REQUEST_UNKNOWN', 'SESSION_HISTORY_CLEAR_UNKNOWN'].includes(code)) return { key: 'error.unknown', code }
  if (code === 'SESSION_HISTORY_SCHEDULED') return { key: 'error.scheduled', code }
  if (code === 'SESSION_HISTORY_UNSUPPORTED') return { key: 'error.unsupported', code }
  if (code === 'SESSION_HISTORY_PATH_UNSAFE') return { key: 'error.safety', code }
  if (code === 'SESSION_HISTORY_RUNTIME_ACTIVE') return { key: 'error.runtime', code }
  if (code === 'SESSION_HISTORY_QUEUE_PENDING') return { key: 'error.queue', code }
  if (code === 'SESSION_HISTORY_PREVIEW_STALE') return { key: 'error.stale', code }
  if (code === 'SESSION_HISTORY_BUSY') return { key: 'error.busy', code }
  if (code === 'SESSION_HISTORY_RESPONSE_INVALID') return { key: 'error.response', code }
  return { key: operation === 'scan' ? 'error.scan' : 'error.clear', code }
}

export function SessionHistorySettings({ active, enabled, runtimeActive, busy, actionLock, onBusy, onRefresh }: Props) {
  const { t, formatNumber, formatDateTime } = useI18n('dsh-history')
  const prefix = useId()
  const [preview, setPreview] = useState<SessionHistoryPreview | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState<Operation | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [deletedCount, setDeletedCount] = useState<number | null>(null)
  const alive = useRef(false)
  const generation = useRef(0)
  const request = useRef<Request | null>(null)
  const cancelButton = useRef<HTMLButtonElement | null>(null)
  const clearButton = useRef<HTMLButtonElement | null>(null)
  const wasConfirming = useRef(false)
  const props = useRef({ active, enabled, runtimeActive, busy, onBusy, onRefresh })
  props.current = { active, enabled, runtimeActive, busy, onBusy, onRefresh }

  const cancel = useCallback(() => {
    ++generation.current
    const owned = request.current
    owned?.controller.abort(); request.current = null
    if (owned) { actionLock.current = false; props.current.onBusy(false) }
    if (alive.current) {
      setPreview(null); setConfirming(false); setAcknowledged(false); setPending(null)
      if (owned?.operation === 'clear') setFailure({ key: 'error.unknown', code: 'SESSION_HISTORY_UNKNOWN' })
    }
  }, [actionLock])
  useEffect(() => {
    alive.current = true
    const hidden = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', cancel)
    return () => { alive.current = false; cancel(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cancel) }
  }, [cancel])
  useEffect(() => { if (!active || !enabled || runtimeActive) cancel() }, [active, enabled, runtimeActive, cancel])
  useEffect(() => {
    if (!preview) return
    const timer = window.setTimeout(() => {
      setPreview(null); setConfirming(false); setAcknowledged(false)
      setFailure({ key: 'error.stale', code: 'SESSION_HISTORY_PREVIEW_STALE' })
    }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [preview])
  useEffect(() => {
    if (confirming) cancelButton.current?.focus()
    else if (wasConfirming.current) clearButton.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  async function perform(operation: Operation) {
    const current = props.current
    if (!alive.current || !current.active || !current.enabled || current.runtimeActive || current.busy || document.hidden || actionLock.current || request.current) return
    if (operation === 'clear' && (!preview || !confirming || !acknowledged || preview.sessionCount === 0)) return
    if (operation === 'clear' && Date.parse(preview!.expiresAt) <= Date.now()) {
      setPreview(null); setConfirming(false); setAcknowledged(false); setFailure({ key: 'error.stale', code: 'SESSION_HISTORY_PREVIEW_STALE' }); return
    }
    const controller = new AbortController(), ticket = ++generation.current
    request.current = { controller, operation }; actionLock.current = true; current.onBusy(true)
    setPreview(null); setConfirming(false); setAcknowledged(false); setPending(operation); setFailure(null); setDeletedCount(null)
    const valid = () => alive.current && !controller.signal.aborted && ticket === generation.current && props.current.active && props.current.enabled && !props.current.runtimeActive && !document.hidden
    let refresh = false
    try {
      if (operation === 'scan') {
        const value = readSessionHistoryPreview(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal: controller.signal, body: { operation: 'preview-session-history', input: {} } }))
        if (!valid()) return
        if (Date.parse(value.expiresAt) <= Date.now()) throw new HostApiError('SESSION_HISTORY_PREVIEW_STALE', '')
        setPreview(value)
      } else {
        const requestId = createRequestId()
        const response = await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal: controller.signal, body: { operation: 'clear-session-history', input: { previewId: preview!.previewId, requestId, confirmed: true } } })
        if (!valid()) return
        const value = readSessionHistoryResult(response, requestId, preview!.sessionCount)
        setDeletedCount(value.deletedCount); refresh = true
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
  function cancelConfirmation() { setConfirming(false); setAcknowledged(false) }
  const disabled = !active || !enabled || runtimeActive || busy || pending !== null
  const disabledReason = !enabled ? t('reason.disabled') : !active ? t('reason.hidden') : runtimeActive ? t('reason.running') : t('reason.busy')

  return <section className="dsh-history-settings" aria-labelledby={`${prefix}-title`} aria-busy={pending !== null} onKeyDown={event => { if (event.key === 'Escape' && confirming) { event.preventDefault(); cancelConfirmation() } }}>
    <div className="dsh-history-heading"><h3 id={`${prefix}-title`}>{t('title')}</h3><p className="dsh-history-description">{t('description')}</p></div>
    <div className="dsh-history-scope"><h4>{t('scopeTitle')}</h4><p>{t('scope')}</p><p>{t('preserved')}</p><p>{t('after')}</p></div>
    {runtimeActive && <div className="dsh-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('running')}</p></div>}
    <div className="dsh-history-actions"><ActionButton type="button" className="button button-secondary" disabled={disabled} reason={disabledReason} onClick={() => void perform('scan')}><RefreshCw size={15} aria-hidden="true" />{t(pending === 'scan' ? 'scanning' : 'scan')}</ActionButton></div>
    {pending === 'clear' && <p className="dsh-history-progress" role="status">{t('clearing')}</p>}
    {failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{t(failure.key)}</p><small>{t('code', { code: failure.code })}</small></div></div>}
    {deletedCount !== null && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('completed', { value: formatNumber(deletedCount) })}</p>}
    {!preview && !failure && deletedCount === null && !pending && <p className="dsh-history-initial">{t('initial')}</p>}
    {preview && <div className="dsh-history-preview" aria-labelledby={`${prefix}-preview-title`}>
      <h4 id={`${prefix}-preview-title`}>{t('previewTitle')}</h4>
      <dl className="dsh-history-counts">{(['rootCount', 'childCount', 'sessionCount'] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd>{formatNumber(preview[key])}</dd></div>)}</dl>
      {preview.sessionCount === 0 ? <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('empty')}</p> : <>
        <p className="dsh-history-expiry">{t('expires', { time: formatDateTime(preview.expiresAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</p>
        {!confirming && <div className="dsh-history-actions"><ActionButton ref={clearButton} type="button" className="button button-secondary dsh-history-clear" disabled={disabled} reason={disabledReason} onClick={() => { if (disabled || actionLock.current) return; setConfirming(true); setAcknowledged(false) }}><Trash2 size={15} aria-hidden="true" />{t('clear')}</ActionButton></div>}
        {confirming && <section className="dsh-history-confirm" aria-labelledby={`${prefix}-confirm-title`} aria-describedby={`${prefix}-warning`}>
          <h4 id={`${prefix}-confirm-title`}>{t('confirmTitle')}</h4><p id={`${prefix}-warning`}>{t('warning', { value: formatNumber(preview.sessionCount) })}</p>
          <label className="dsh-history-acknowledge"><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('acknowledge')}</span></label>
          <div className="dsh-history-actions"><ActionButton ref={cancelButton} type="button" className="button button-secondary" onClick={cancelConfirmation}>{t('cancel')}</ActionButton><ActionButton type="button" className="button button-danger" disabled={disabled || !acknowledged} reason={disabled ? disabledReason : t('reason.confirm')} onClick={() => void perform('clear')}>{t('confirm', { value: formatNumber(preview.sessionCount) })}</ActionButton></div>
        </section>}
      </>}
    </div>}
  </section>
}
