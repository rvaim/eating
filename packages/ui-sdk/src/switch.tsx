import { useId } from 'react'
import { ActionButton } from './action-button.js'
import type { ActionReasonCode } from './action-button.js'
import './switch.css'

export interface SwitchProps {
  readonly id?: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly reasonCode?: ActionReasonCode
  readonly label?: string
  readonly description?: string
  readonly compact?: boolean
  readonly 'aria-label'?: string
  readonly 'aria-labelledby'?: string
  readonly 'aria-describedby'?: string
  readonly onChange: (checked: boolean) => void
  readonly className?: string
}

export function Switch({
  id,
  checked,
  disabled = false,
  disabledReason,
  reasonCode,
  label,
  description,
  compact = false,
  onChange,
  className,
  ...aria
}: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? `eating-switch-${generatedId}`
  const labelId = label ? `${switchId}-label` : undefined
  const control = (
    <ActionButton
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label'] ?? (!label ? undefined : undefined)}
      aria-labelledby={aria['aria-labelledby'] ?? (aria['aria-label'] ? undefined : labelId)}
      aria-describedby={aria['aria-describedby']}
      disabled={disabled}
      reason={disabledReason}
      reasonCode={reasonCode}
      className={`eating-switch-btn${compact ? ' is-compact' : ''}${checked ? ' is-checked' : ''}`}
      onClick={() => onChange(!checked)}>
      <span className="eating-switch-track" aria-hidden="true">
        <span className="eating-switch-thumb" />
      </span>
    </ActionButton>
  )
  if (!label && !description) return control
  return (
    <div className={`eating-switch-field${compact ? ' is-compact' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}>
      {control}
      <div className="eating-switch-copy">
        {label && (
          <label id={labelId} htmlFor={switchId} className="eating-switch-label">
            {label}
          </label>
        )}
        {description && <small className="eating-switch-desc">{description}</small>}
      </div>
    </div>
  )
}
