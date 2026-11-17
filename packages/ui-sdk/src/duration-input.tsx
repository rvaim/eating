import { useEffect, useId, useState } from 'react'
import { useI18n } from './i18n.js'
import './duration-input.css'

export function msToSecondsString(valueMs: string): string {
  const trimmed = valueMs.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return ''
  const ms = Number(trimmed)
  if (!Number.isSafeInteger(ms)) return ''
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)))
}

export function secondsStringToMs(secondsText: string): string | null {
  const trimmed = secondsText.trim()
  if (!trimmed) return ''
  if (!/^\d+(?:\.\d{1,3})?$/.test(trimmed)) return null
  const num = Number(trimmed)
  if (!Number.isFinite(num)) return null
  const ms = Math.round(num * 1000)
  return Number.isSafeInteger(ms) ? String(ms) : null
}

export interface DurationInputProps {
  readonly id?: string
  readonly valueMs: string
  readonly onChangeMs: (nextValueMs: string) => void
  readonly presetsSeconds?: readonly number[]
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly className?: string
  readonly 'aria-label'?: string
  readonly 'aria-describedby'?: string
  readonly 'aria-invalid'?: boolean
}

const DEFAULT_PRESETS: readonly number[] = [10, 30, 60]

/** Displays and edits durations in seconds while storing/emitting exact millisecond strings. */
export function DurationInput({
  id,
  valueMs,
  onChangeMs,
  presetsSeconds = DEFAULT_PRESETS,
  disabled = false,
  readOnly = false,
  className,
  ...aria
}: DurationInputProps) {
  const { t, formatNumber } = useI18n('common')
  const generatedId = useId()
  const inputId = id ?? `eating-duration-${generatedId}`
  const [secondsDraft, setSecondsDraft] = useState(() => msToSecondsString(valueMs) || valueMs)

  useEffect(() => {
    const trimmed = valueMs.trim()
    if (!trimmed) {
      setSecondsDraft('')
      return
    }
    if (/^\d+$/.test(trimmed)) {
      if (secondsStringToMs(secondsDraft) !== trimmed) {
        setSecondsDraft(msToSecondsString(trimmed))
      }
    } else if (secondsDraft !== valueMs) {
      setSecondsDraft(valueMs)
    }
    // Synchronize external prop updates without clobbering intermediate decimal typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueMs])

  const parsedMs = /^\d+$/.test(valueMs.trim()) ? Number(valueMs.trim()) : null
  const activeSeconds = parsedMs !== null ? parsedMs / 1000 : null

  return (
    <div className={`eating-duration${className ? ` ${className}` : ''}`}>
      <div className="eating-duration-row">
        <div className="eating-duration-input-wrap">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={secondsDraft}
            disabled={disabled}
            readOnly={readOnly}
            aria-label={aria['aria-label']}
            aria-describedby={aria['aria-describedby']}
            aria-invalid={aria['aria-invalid']}
            onChange={event => {
              const raw = event.target.value
              setSecondsDraft(raw)
              const converted = secondsStringToMs(raw)
              onChangeMs(converted !== null ? converted : raw.trim())
            }}
          />
          <span className="eating-duration-unit" aria-hidden="true">{t('duration.unitSeconds')}</span>
        </div>
        {parsedMs !== null && (
          <span className="eating-duration-ms">
            {t('duration.equivalentMs', { ms: formatNumber(parsedMs) })}
          </span>
        )}
      </div>
      {presetsSeconds.length > 0 && !readOnly && (
        <div className="eating-duration-presets">
          {presetsSeconds.map(seconds => {
            const active = activeSeconds === seconds
            return (
              <button
                key={seconds}
                type="button"
                className={`eating-duration-preset${active ? ' is-active' : ''}`}
                disabled={disabled}
                aria-pressed={active}
                onClick={() => {
                  const msText = String(Math.round(seconds * 1000))
                  setSecondsDraft(String(seconds))
                  onChangeMs(msText)
                }}>
                {t('duration.presetLabel', { seconds })}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
