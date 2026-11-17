import { useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { AlertTriangle, Check, Copy, Info, RefreshCw, ShieldAlert } from 'lucide-react'
import { ActionButton } from './action-button.js'
import { useI18n } from './i18n.js'
import './confirm-inline.css'

export interface InlineConfirmProps {
  readonly open?: boolean
  readonly variant?: 'danger' | 'warning' | 'info'
  readonly title: string
  readonly description?: string
  readonly details?: readonly string[]
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly busyLabel?: string
  readonly busy?: boolean
  readonly confirmDisabled?: boolean
  readonly confirmReason?: string
  readonly error?: string | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly className?: string
  readonly confirmButtonRef?: Ref<HTMLButtonElement>
}

export function InlineConfirm({
  open = true,
  variant = 'warning',
  title,
  description,
  details = [],
  confirmLabel,
  cancelLabel,
  busyLabel,
  busy = false,
  confirmDisabled = false,
  confirmReason,
  error = null,
  onConfirm,
  onCancel,
  className,
  confirmButtonRef,
}: InlineConfirmProps) {
  const { t } = useI18n('common')
  if (!open) return null
  const Icon = variant === 'danger' ? ShieldAlert : variant === 'warning' ? AlertTriangle : Info
  return (
    <div className={`eating-confirm is-${variant}${className ? ` ${className}` : ''}`} role="alertdialog" aria-label={title}>
      <div className="eating-confirm-head">
        <Icon size={17} aria-hidden="true" />
        <div className="eating-confirm-copy">
          <strong>{title}</strong>
          {description && <p>{description}</p>}
          {details.length > 0 && (
            <ul className="eating-confirm-details">
              {details.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          )}
        </div>
      </div>
      <div className="eating-confirm-actions">
        <ActionButton
          type="button"
          className="button button-secondary"
          disabled={busy}
          reasonCode="busy"
          onClick={onCancel}>
          {cancelLabel ?? t('confirm.cancel')}
        </ActionButton>
        <ActionButton
          ref={confirmButtonRef}
          type="button"
          className={`button ${variant === 'danger' ? 'button-danger' : 'button-primary'}`}
          disabled={busy || confirmDisabled}
          reason={busy ? t('actionReason.busy') : confirmReason}
          onClick={onConfirm}>
          {busy ? (busyLabel ?? confirmLabel ?? t('confirm.proceed')) : (confirmLabel ?? t('confirm.proceed'))}
        </ActionButton>
      </div>
      {error && <p className="eating-confirm-error" role="alert">{error}</p>}
    </div>
  )
}

export interface FormSaveBarProps {
  readonly dirty: boolean
  readonly saving?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly conflict?: boolean
  readonly uncertain?: boolean
  readonly alwaysVisible?: boolean
  readonly saveLabel?: string
  readonly savingLabel?: string
  readonly discardLabel?: string
  readonly reloadLabel?: string
  readonly extraActions?: ReactNode
  readonly error?: string | null
  readonly notice?: string | null
  readonly onSave: () => void
  readonly onDiscard?: () => void
  readonly onReload?: () => void
  readonly className?: string
}

export function FormSaveBar({
  dirty,
  saving = false,
  disabled = false,
  disabledReason,
  conflict = false,
  uncertain = false,
  alwaysVisible = false,
  saveLabel,
  savingLabel,
  discardLabel,
  reloadLabel,
  extraActions,
  error = null,
  notice = null,
  onSave,
  onDiscard,
  onReload,
  className,
}: FormSaveBarProps) {
  const { t } = useI18n('common')
  const sticky = dirty || conflict || uncertain
  if (!alwaysVisible && !sticky && !error && !notice) return null
  return (
    <div className={`eating-save-bar${sticky ? ' is-sticky' : ''}${conflict ? ' is-conflict' : ''}${className ? ` ${className}` : ''}`}>
      <div className="eating-save-bar-status">
        {sticky && <span className="eating-save-bar-dot" aria-hidden="true" />}
        <span>{dirty ? t('saveBar.unsaved') : t('saveBar.saved')}</span>
      </div>
      <div className="eating-save-bar-actions">
        {extraActions}
        {conflict && onReload && (
          <ActionButton
            type="button"
            className="button button-secondary"
            disabled={saving}
            reasonCode="busy"
            onClick={onReload}>
            <RefreshCw size={14} aria-hidden="true" />
            {reloadLabel ?? t('saveBar.reload')}
          </ActionButton>
        )}
        {dirty && onDiscard && (
          <ActionButton
            type="button"
            className="button button-secondary"
            disabled={saving}
            reasonCode="busy"
            onClick={onDiscard}>
            {discardLabel ?? t('saveBar.discard')}
          </ActionButton>
        )}
        <ActionButton
          type="button"
          className="button button-primary"
          disabled={saving || disabled || (!dirty && !alwaysVisible)}
          reason={saving ? t('actionReason.busy') : disabledReason ?? (!dirty ? t('actionReason.unchanged') : undefined)}
          onClick={onSave}>
          {saving ? (savingLabel ?? t('saveBar.saving')) : (saveLabel ?? t('saveBar.save'))}
        </ActionButton>
      </div>
      {error && <p className="eating-save-bar-feedback is-error" role="alert">{error}</p>}
      {!error && notice && <p className="eating-save-bar-feedback" role="status">{notice}</p>}
    </div>
  )
}

export interface UnknownOutcomeCardProps {
  readonly title?: string
  readonly body?: string
  readonly requestId?: string | null
  readonly refreshing?: boolean
  readonly refreshLabel?: string
  readonly confirmLabel?: string
  readonly onRefresh?: () => void
  readonly onConfirmReviewed: () => void
  readonly className?: string
}

export function UnknownOutcomeCard({
  title,
  body,
  requestId,
  refreshing = false,
  refreshLabel,
  confirmLabel,
  onRefresh,
  onConfirmReviewed,
  className,
}: UnknownOutcomeCardProps) {
  const { t } = useI18n('common')
  const [copied, setCopied] = useState(false)

  async function copyRequestId() {
    if (!requestId) return
    try {
      await navigator.clipboard.writeText(requestId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className={`eating-unknown-card${className ? ` ${className}` : ''}`} role="alert">
      <div className="eating-unknown-head">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>{title ?? t('unknownOutcome.title')}</strong>
          <p>{body ?? t('unknownOutcome.body')}</p>
        </div>
      </div>
      {requestId && (
        <div className="eating-unknown-id-row">
          <span>{t('unknownOutcome.requestIdLabel')}:</span>
          <code>{requestId}</code>
          <button type="button" className="button button-secondary" onClick={() => void copyRequestId()}>
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? t('unknownOutcome.copiedId') : t('unknownOutcome.copyId')}
          </button>
        </div>
      )}
      <div className="eating-unknown-actions">
        {onRefresh && (
          <ActionButton
            type="button"
            className="button button-secondary"
            disabled={refreshing}
            reasonCode="busy"
            onClick={onRefresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {refreshLabel ?? t('unknownOutcome.refresh')}
          </ActionButton>
        )}
        <button type="button" className="button button-primary" onClick={onConfirmReviewed}>
          <Check size={14} aria-hidden="true" />
          {confirmLabel ?? t('unknownOutcome.confirmReviewed')}
        </button>
      </div>
    </section>
  )
}
