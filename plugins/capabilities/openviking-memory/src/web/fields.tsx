import type { ReactNode } from 'react'
import { useI18n } from '@eating/ui-sdk'
import type { FieldIssue } from './draft'

export function fieldId(prefix: string, name: string): string { return `${prefix}-${name}` }
export function revealTarget(target: HTMLElement, block: 'center' | 'nearest' = 'nearest'): void {
  const options = { block, inline: 'nearest', behavior: 'instant', container: 'nearest' } as const
  target.scrollIntoView(options)
}
export function focusAndReveal(getTarget: () => HTMLElement | null): void {
  requestAnimationFrame(() => {
    const target = getTarget()
    if (!target?.isConnected || !target.getClientRects().length) return
    target.focus({ preventScroll: true })
    // ResizeObserver measures wrapped sticky controls before the next frame reveals the target.
    requestAnimationFrame(() => {
      if (document.activeElement === target) revealTarget(target, 'center')
    })
  })
}
export function Field({ prefix, name, label, hint, issue, children }: {
  prefix: string; name: string; label: string; hint?: string; issue?: FieldIssue; children: ReactNode
}) {
  const { t, formatNumber } = useI18n('openviking-memory')
  const id = fieldId(prefix, name)
  return <div className={`ov-field${issue ? ' is-invalid' : ''}`}>
    <label htmlFor={id}>{label}</label><div>{children}
      {hint && <p className="ov-hint" id={`${id}-hint`}>{hint}</p>}
      {issue && <p className="ov-error" id={`${id}-error`}>{t(issue.key, { min: issue.min === undefined ? '' : formatNumber(issue.min), max: issue.max === undefined ? '' : formatNumber(issue.max) })}</p>}
    </div>
  </div>
}
export function TextField({ prefix, name, label, hint, issue, value, onChange, onBlur, type = 'text', multiline = false, disabled = false, maxLength, inputMode }: {
  prefix: string; name: string; label: string; hint?: string; issue?: FieldIssue; value: string; onChange: (value: string) => void
  onBlur?: () => void; type?: 'text' | 'password' | 'url' | 'number' | 'search'; multiline?: boolean; disabled?: boolean; maxLength?: number
  inputMode?: 'text' | 'decimal' | 'numeric' | 'url'
}) {
  const id = fieldId(prefix, name)
  const describedBy = [hint ? `${id}-hint` : '', issue ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  const props = { id, name, value, disabled, maxLength, 'aria-invalid': issue ? true as const : undefined, 'aria-describedby': describedBy,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    onBlur: (event: { relatedTarget: EventTarget | null }) => {
      // Submission validates the whole draft. Deferring this blur keeps its pointer target in place until click.
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.ov-save-rail')) return
      onBlur?.()
    } }
  return <Field prefix={prefix} name={name} label={label} hint={hint} issue={issue}>
    {multiline ? <textarea {...props} rows={5} spellCheck={false} autoComplete="off" />
      : <input {...props} type={type} inputMode={inputMode} autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false} />}
  </Field>
}
export function CheckField({ label, hint, checked, onChange, disabled = false }: {
  label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean
}) {
  return <label className="ov-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span><strong>{label}</strong>{hint && <span className="ov-hint">{hint}</span>}</span>
  </label>
}
