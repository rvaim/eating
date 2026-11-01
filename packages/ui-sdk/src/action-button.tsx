import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, Ref } from 'react'
import { useI18n } from './i18n.js'
import './action-button.css'
export type ActionReasonCode = 'busy' | 'loading' | 'unchanged' | 'draft' | 'configure' | 'enable' | 'connect' | 'stop' | 'running' | 'stopped' | 'confirm' | 'read' | 'unknown' | 'invalid' | 'deactivate' | 'source' | 'firstPage' | 'lastPage' | 'empty' | 'active' | 'prompt' | 'runtime' | 'preview'

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Specific owner-facing reason, localized by the component's caller. */
  readonly reason?: string
  readonly reasonCode?: ActionReasonCode
  readonly ref?: Ref<HTMLButtonElement>
}

/** Keeps native disabled behavior while making its explanation pointer and keyboard accessible. */
export function ActionButton({ reason: suppliedReason, reasonCode, disabled = false, ref, ...props }: ActionButtonProps) {
  const { t } = useI18n('common')
  const reason = suppliedReason || (reasonCode ? t(`actionReason.${reasonCode}`) : undefined)
  const generatedId = useId(), buttonId = props.id ?? `eating-action-${generatedId}`, hintId = `${buttonId}-reason`
  const trigger = useRef<HTMLSpanElement | null>(null), tooltip = useRef<HTMLSpanElement | null>(null)
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false)
  const explained = disabled && Boolean(reason), open = explained && (hovered || focused) && !dismissed
  useLayoutEffect(() => {
    const target = trigger.current, bubble = tooltip.current
    if (!open || !target || !bubble) return
    bubble.showPopover()
    const position = () => {
      const box = target.getBoundingClientRect(), hint = bubble.getBoundingClientRect(), gap = 8
      bubble.style.left = `${Math.max(gap, Math.min(box.left + box.width / 2 - hint.width / 2, innerWidth - hint.width - gap))}px`
      bubble.style.top = `${box.bottom + gap + hint.height <= innerHeight - gap ? box.bottom + gap : Math.max(gap, box.top - hint.height - gap)}px`
    }
    position()
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setDismissed(true) }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.addEventListener('keydown', dismiss)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); window.removeEventListener('keydown', dismiss); if (bubble.matches(':popover-open')) bubble.hidePopover() }
  }, [open, reason])
  const button = <button {...props} ref={ref} id={buttonId} disabled={disabled} aria-describedby={[props['aria-describedby'], explained ? hintId : null].filter(Boolean).join(' ') || undefined} />
  if (!explained) return button
  return <span ref={trigger} className={explained ? 'eating-action-hint' : 'eating-action'} role={explained ? 'group' : undefined} tabIndex={explained ? 0 : undefined} aria-labelledby={explained ? buttonId : undefined} aria-describedby={explained ? hintId : undefined}
    onMouseEnter={() => { if (explained) { setHovered(true); setDismissed(false) } }} onMouseLeave={() => setHovered(false)}
    onFocus={() => { if (explained) { setFocused(true); setDismissed(false) } }} onBlur={() => setFocused(false)}
    onKeyDown={event => { if (explained && event.key === 'Escape') { event.preventDefault(); setDismissed(true) }; if (explained && (event.key === 'Enter' || event.key === ' ')) event.preventDefault() }}
    onClick={event => { if (explained) { event.preventDefault(); trigger.current?.focus(); setDismissed(false) } }}>
    {button}
    {explained && <span ref={tooltip} id={hintId} className="eating-action-tooltip" role="tooltip" popover="manual">{reason}</span>}
  </span>
}
