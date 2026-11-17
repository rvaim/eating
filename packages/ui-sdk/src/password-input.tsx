import { useEffect, useId, useState } from 'react'
import { Eye, EyeOff, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react'
import { useI18n } from './i18n.js'
import './password-input.css'

export interface PasswordInputProps {
  readonly id?: string
  readonly value: string
  readonly onChange: (next: string) => void
  readonly saved?: boolean
  readonly clear?: boolean
  readonly onClearChange?: (nextClear: boolean) => void
  readonly hiddenClearedNotice?: boolean
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly maxLength?: number
  readonly placeholder?: string
  readonly savedPlaceholder?: string
  readonly clearLabel?: string
  readonly undoClearLabel?: string
  readonly className?: string
  readonly 'aria-label'?: string
  readonly 'aria-describedby'?: string
  readonly 'aria-invalid'?: boolean
}

/** Write-only secret field: reveal only affects the unsaved local draft, never stored secrets. */
export function PasswordInput({
  id,
  value,
  onChange,
  saved = false,
  clear = false,
  onClearChange,
  hiddenClearedNotice = false,
  disabled = false,
  readOnly = false,
  maxLength = 4096,
  placeholder,
  savedPlaceholder,
  clearLabel,
  undoClearLabel,
  className,
  ...aria
}: PasswordInputProps) {
  const { t } = useI18n('common')
  const generatedId = useId()
  const inputId = id ?? `eating-password-${generatedId}`
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (!value) setRevealed(false)
  }, [value])

  const inputPlaceholder = placeholder ?? (saved ? savedPlaceholder ?? t('password.savedPlaceholder') : undefined)
  return (
    <div className={`eating-password${className ? ` ${className}` : ''}`}>
      <div className="eating-password-box">
        <input
          id={inputId}
          type={revealed && value.length > 0 ? 'text' : 'password'}
          value={value}
          disabled={disabled || clear}
          readOnly={readOnly}
          maxLength={maxLength}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={inputPlaceholder}
          aria-label={aria['aria-label']}
          aria-describedby={aria['aria-describedby']}
          aria-invalid={aria['aria-invalid']}
          onChange={event => {
            const next = event.target.value
            if (clear && next && onClearChange) onClearChange(false)
            onChange(next)
          }}
        />
        <button
          type="button"
          className="eating-password-toggle"
          disabled={disabled || value.length === 0 || clear}
          aria-label={t(revealed ? 'password.hide' : 'password.show')}
          aria-pressed={revealed}
          title={t(revealed ? 'password.hide' : 'password.show')}
          onClick={() => setRevealed(current => !current)}>
          {revealed ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {(saved || hiddenClearedNotice) && (
        <div className="eating-password-meta">
          {saved && !clear && !value && (
            <span className="eating-password-badge">
              <ShieldCheck size={13} aria-hidden="true" />
              {t('password.savedBadge')}
            </span>
          )}
          {saved && clear && (
            <span className="eating-password-badge is-clearing">
              {t('password.clearingBadge')}
            </span>
          )}
          {saved && onClearChange && (
            <button
              type="button"
              className={`eating-password-clear${clear ? ' is-undo' : ''}`}
              disabled={disabled}
              aria-pressed={clear}
              onClick={() => {
                const next = !clear
                if (next && value) onChange('')
                onClearChange(next)
              }}>
              {clear ? <RotateCcw size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
              {clear ? (undoClearLabel ?? t('password.undoClear')) : (clearLabel ?? t('password.clear'))}
            </button>
          )}
          {hiddenClearedNotice && !value && (
            <span className="eating-password-cleared-note" role="status">
              {t('password.hiddenClearedNotice')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
