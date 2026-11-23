import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { AlertCircle, Check, Info, RefreshCw, RotateCcw } from 'lucide-react'
import { ActionButton, createRequestId, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { readDshResetPreview, readDshResetResult } from './history-data'
import type { DshResetPreview, DshResetResult } from './history-data'
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
type Operation = 'scan' | 'reset'
type QueueChoice = 'keep' | 'clear' | null
interface Failure { readonly key: SessionHistoryTranslationKey; readonly code: string }
interface OutcomeNotice {
  readonly result: DshResetResult
  readonly isWarning?: boolean
}
interface Request { readonly controller: AbortController; readonly operation: Operation }

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function describe(error: unknown, operation: Operation): Failure {
  const code = error instanceof HostApiError ? error.code : 'DSH_RESET_REQUEST_FAILED'
  const mutating = operation !== 'scan'
  if ((mutating && (!(error instanceof HostApiError) || error.outcome === 'unknown')) || ['DSH_RESET_UNKNOWN', 'DSH_RESET_REQUEST_UNKNOWN', 'DSH_RESET_FAILED'].includes(code)) {
    return { key: 'error.unknown', code }
  }
  if (code === 'DSH_RESET_QUEUE_DECISION_REQUIRED') return { key: 'error.queueDecision', code }
  if (code === 'DSH_RESET_PATH_UNSAFE') return { key: 'error.safety', code }
  if (code === 'DSH_RESET_RUNTIME_ACTIVE') return { key: 'error.runtime', code }
  if (code === 'DSH_RESET_PREVIEW_STALE') return { key: 'error.stale', code }
  if (code === 'DSH_RESET_BUSY') return { key: 'error.busy', code }
  if (code === 'DSH_RESET_RESPONSE_INVALID') return { key: 'error.response', code }
  return { key: operation === 'scan' ? 'error.scan' : 'error.reset', code }
}

export function SessionHistorySettings({ active, enabled, runtimeActive, busy, actionLock, onBusy, onRefresh }: Props) {
  const { t, formatNumber, formatDateTime } = useI18n('dsh-history')
  const prefix = useId()
  const [preview, setPreview] = useState<DshResetPreview | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [queueChoice, setQueueChoice] = useState<QueueChoice>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState<Operation | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [outcome, setOutcome] = useState<OutcomeNotice | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const alive = useRef(false)
  const generation = useRef(0)
  const request = useRef<Request | null>(null)
  const cancelButton = useRef<HTMLButtonElement | null>(null)
  const resetTriggerButton = useRef<HTMLButtonElement | null>(null)
  const hadConfirmOpen = useRef(false)
  const props = useRef({ active, enabled, runtimeActive, busy, onBusy, onRefresh })
  props.current = { active, enabled, runtimeActive, busy, onBusy, onRefresh }

  const cancel = useCallback(() => {
    ++generation.current
    const owned = request.current
    owned?.controller.abort(); request.current = null
    if (owned) { actionLock.current = false; props.current.onBusy(false) }
    if (alive.current) {
      setPreview(null); setConfirming(false); setQueueChoice(null); setAcknowledged(false); setPending(null)
      if (owned && owned.operation !== 'scan') setFailure({ key: 'error.unknown', code: 'DSH_RESET_UNKNOWN' })
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
      setPreview(null); setConfirming(false); setQueueChoice(null); setAcknowledged(false)
      setFailure({ key: 'error.stale', code: 'DSH_RESET_PREVIEW_STALE' })
    }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()))
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => { window.clearTimeout(expiryTimer); window.clearInterval(tick) }
  }, [preview])

  useEffect(() => {
    if (confirming) {
      hadConfirmOpen.current = true
      cancelButton.current?.focus()
    } else if (hadConfirmOpen.current) {
      hadConfirmOpen.current = false
      resetTriggerButton.current?.focus()
    }
  }, [confirming])

  const willRestart = Boolean(runtimeActive || preview?.runtimeRunning)

  async function perform(operation: Operation) {
    const current = props.current
    if (!alive.current || !current.active || !current.enabled || current.busy || document.hidden || actionLock.current || request.current) return
    if (operation === 'reset') {
      if (!preview || !confirming || !acknowledged || !preview.hasResettableData) return
      if (preview.hasPendingQueue && queueChoice === null) return
      if (Date.parse(preview.expiresAt) <= Date.now()) {
        setPreview(null); setConfirming(false); setQueueChoice(null); setAcknowledged(false)
        setFailure({ key: 'error.stale', code: 'DSH_RESET_PREVIEW_STALE' }); return
      }
    }
    const targetPreview = preview
    const chosenQueueAction = queueChoice
    const controller = new AbortController(), ticket = ++generation.current
    request.current = { controller, operation }; actionLock.current = true; current.onBusy(true)
    setPreview(null); setConfirming(false); setQueueChoice(null); setAcknowledged(false); setPending(operation); setFailure(null); setOutcome(null)
    const valid = () => alive.current && !controller.signal.aborted && ticket === generation.current && props.current.active && props.current.enabled && !document.hidden
    let refresh = false
    try {
      if (operation === 'scan') {
        const value = readDshResetPreview(await hostRequest<unknown>('/plugins/dsh/manage', {
          method: 'POST', signal: controller.signal, body: { operation: 'preview-dsh-reset', input: {} },
        }))
        if (!valid()) return
        if (Date.parse(value.expiresAt) <= Date.now()) throw new HostApiError('DSH_RESET_PREVIEW_STALE', '')
        setPreview(value)
      } else {
        const requestId = createRequestId()
        const response = await hostRequest<unknown>('/plugins/dsh/manage', {
          method: 'POST',
          signal: controller.signal,
          body: {
            operation: 'reset-dsh',
            input: {
              previewId: targetPreview!.previewId,
              requestId,
              confirmed: true,
              ...(chosenQueueAction ? { queueAction: chosenQueueAction } : {}),
            },
          },
        })
        if (!valid()) return
        const value = readDshResetResult(response, requestId)
        setOutcome({ result: value, isWarning: value.wasRunning && !value.restarted })
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

  function cancelConfirmation() {
    setConfirming(false)
    setQueueChoice(null)
    setAcknowledged(false)
  }

  const disabled = !active || !enabled || busy || pending !== null
  const disabledReason = !enabled ? t('reason.disabled') : !active ? t('reason.hidden') : t('reason.busy')
  const totalQueued = preview ? preview.pendingQueueCount + preview.uncertainQueueCount : 0
  const needsQueueDecision = Boolean(preview?.hasPendingQueue && queueChoice === null)
  const remainingMs = preview ? Math.max(0, Date.parse(preview.expiresAt) - nowMs) : 0

  const renderOutcomeMessage = (notice: OutcomeNotice) => {
    const r = notice.result
    const baseKey: SessionHistoryTranslationKey = r.wasRunning
      ? (r.restarted ? 'completedRestarted' : 'completedRestartFailed')
      : 'completedStopped'
    const base = t(baseKey, {
      sessions: formatNumber(r.deletedSessions),
      workspace: formatNumber(r.clearedWorkspaceEntries),
    })
    if (r.queueAction === 'clear') {
      return `${base} ${t('completedQueueCleared', { value: formatNumber(r.clearedQueueCount) })}`
    }
    if (r.queueAction === 'keep') {
      return `${base} ${t('completedQueueKept')}`
    }
    return base
  }

  return <section className="dsh-history-settings" aria-labelledby={`${prefix}-title`} aria-busy={pending !== null} onKeyDown={event => { if (event.key === 'Escape' && confirming) { event.preventDefault(); cancelConfirmation() } }}>
    <div className="dsh-history-heading">
      <h3 id={`${prefix}-title`}>{t('title')}</h3>
      <p className="dsh-history-description">{t('description')}</p>
    </div>
    <div className="dsh-history-scope">
      <h4>{t('scopeTitle')}</h4>
      <p>{t('scopeCleared')}</p>
      <p>{t('scopePreserved')}</p>
      <p>{t('scopeAfter')}</p>
    </div>
    {runtimeActive && <div className="dsh-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('running')}</p></div>}
    <div className="dsh-history-actions">
      <ActionButton type="button" className="button button-secondary" disabled={disabled} reason={disabledReason} onClick={() => void perform('scan')}>
        <RefreshCw size={15} aria-hidden="true" />
        {t(pending === 'scan' ? 'scanning' : 'scan')}
      </ActionButton>
    </div>
    {pending === 'reset' && <p className="dsh-history-progress" role="status">{t('resetting')}</p>}
    {failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{t(failure.key)}</p><small>{t('code', { code: failure.code })}</small></div></div>}
    {outcome && <p className={outcome.isWarning ? 'dsh-notice' : 'dsh-result'} role="status">
      {outcome.isWarning ? <AlertCircle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
      {renderOutcomeMessage(outcome)}
    </p>}
    {!preview && !failure && !outcome && !pending && <p className="dsh-history-initial">{t('initial')}</p>}
    {preview && <div className="dsh-history-preview" aria-labelledby={`${prefix}-preview-title`}>
      <div className="dsh-history-preview-head">
        <h4 id={`${prefix}-preview-title`}>{t('previewTitle')}</h4>
        <span className={`dsh-history-runtime-pill${preview.runtimeRunning ? ' is-online' : ''}`}>{t(preview.runtimeRunning ? 'runtimeBadgeOnline' : 'runtimeBadgeStopped')}</span>
      </div>
      <dl className="dsh-history-counts">
        {(['rootCount', 'childCount', 'sessionCount', 'workspaceEntryCount'] as const).map(key => (
          <div key={key}><dt>{t(key)}</dt><dd>{formatNumber(preview[key])}</dd></div>
        ))}
      </dl>
      {preview.scheduledCount > 0 && <div className="dsh-notice" role="status">
        <Info size={16} aria-hidden="true" />
        <p>{t('scheduledNotice', { value: formatNumber(preview.scheduledCount) })}</p>
      </div>}
      {preview.hasPendingQueue && <div className="dsh-notice" role="status">
        <Info size={16} aria-hidden="true" />
        <p>{t('queuePreviewNotice', {
          total: formatNumber(totalQueued),
          pending: formatNumber(preview.pendingQueueCount),
          uncertain: formatNumber(preview.uncertainQueueCount),
        })}</p>
      </div>}
      <div className="dsh-history-expiry-row">
        <p className="dsh-history-expiry">{t('expires', { time: formatDateTime(preview.expiresAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</p>
        <span className={`dsh-history-countdown${remainingMs <= 30_000 ? ' is-urgent' : ''}`} role="timer">{t('countdown', { remaining: formatCountdown(remainingMs) })}</span>
      </div>

      {!preview.hasResettableData && (
        preview.hasPendingQueue
          ? <div className="dsh-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('emptyWithQueue', { total: formatNumber(totalQueued) })}</p></div>
          : <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('empty')}</p>
      )}

      {preview.hasResettableData && !confirming && <div className="dsh-history-actions">
        <ActionButton
          ref={resetTriggerButton}
          type="button"
          className="button button-danger"
          disabled={disabled}
          reason={disabledReason}
          onClick={() => { if (disabled || actionLock.current) return; setConfirming(true); setQueueChoice(null); setAcknowledged(false) }}
        >
          <RotateCcw size={15} aria-hidden="true" />
          {t('resetButton')}
        </ActionButton>
      </div>}

      {preview.hasResettableData && confirming && <section className="dsh-history-confirm" aria-labelledby={`${prefix}-confirm-title`} aria-describedby={`${prefix}-warning`}>
        <h4 id={`${prefix}-confirm-title`}>{t('confirmTitle')}</h4>
        <p id={`${prefix}-warning`}>{t(willRestart ? 'warningRestart' : 'warningStopped', {
          sessions: formatNumber(preview.sessionCount),
          workspace: formatNumber(preview.workspaceEntryCount),
        })}</p>
        {preview.hasPendingQueue && <div className="dsh-reset-queue-box" role="radiogroup" aria-labelledby={`${prefix}-queue-title`}>
          <h5 id={`${prefix}-queue-title`}>{t('queueDecisionTitle', { total: formatNumber(totalQueued) })}</h5>
          <p className="dsh-reset-queue-detail">{t('queueDecisionDetail', {
            pending: formatNumber(preview.pendingQueueCount),
            uncertain: formatNumber(preview.uncertainQueueCount),
          })}</p>
          <div className="dsh-reset-queue-options">
            <label className={`dsh-reset-queue-option${queueChoice === 'keep' ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name={`${prefix}-queue-action`}
                value="keep"
                checked={queueChoice === 'keep'}
                disabled={disabled}
                onChange={() => setQueueChoice('keep')}
              />
              <span className="dsh-reset-queue-option-body">
                <strong>{t('queueKeepTitle')}</strong>
                <span>{t('queueKeepDescription')}</span>
              </span>
            </label>
            <label className={`dsh-reset-queue-option${queueChoice === 'clear' ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name={`${prefix}-queue-action`}
                value="clear"
                checked={queueChoice === 'clear'}
                disabled={disabled}
                onChange={() => setQueueChoice('clear')}
              />
              <span className="dsh-reset-queue-option-body">
                <strong>{t('queueClearTitle')}</strong>
                <span>{t('queueClearDescription')}</span>
              </span>
            </label>
          </div>
        </div>}
        <label className="dsh-history-acknowledge">
          <input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)} />
          <span>{t('acknowledge')}</span>
        </label>
        <div className="dsh-history-actions">
          <ActionButton ref={cancelButton} type="button" className="button button-secondary" onClick={cancelConfirmation}>{t('cancel')}</ActionButton>
          <ActionButton
            type="button"
            className="button button-danger"
            disabled={disabled || needsQueueDecision || !acknowledged}
            reason={disabled ? disabledReason : needsQueueDecision ? t('reason.queueDecision') : t('reason.confirm')}
            onClick={() => void perform('reset')}
          >
            {t('confirmReset')}
          </ActionButton>
        </div>
      </section>}
    </div>}
  </section>
}
