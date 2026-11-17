import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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

/** Keeps native disabled behavior while making its explanation pointer, touch and keyboard accessible. */
export function ActionButton({ reason: suppliedReason, reasonCode, disabled = false, ref, ...props }: ActionButtonProps) {
  const { t } = useI18n('common')
  const reason = suppliedReason || (reasonCode ? t(`actionReason.${reasonCode}`) : undefined)
  const generatedId = useId(), buttonId = props.id ?? `eating-action-${generatedId}`, hintId = `${buttonId}-reason`
  const trigger = useRef<HTMLSpanElement | null>(null), tooltip = useRef<HTMLSpanElement | null>(null)
  const lastPointer = useRef<string>('')
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [pinned, setPinned] = useState(false), [dismissed, setDismissed] = useState(false)
  const explained = disabled && Boolean(reason), open = explained && (hovered || focused || pinned) && !dismissed
  useEffect(() => {
    if (!explained) { setHovered(false); setFocused(false); setPinned(false); setDismissed(false) }
  }, [explained])
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
    const dismissKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDismissed(true); setPinned(false) } }
    const dismissOutside = (event: PointerEvent) => {
      const node = event.target as Node | null
      if (node && (target.contains(node) || bubble.contains(node))) return
      setPinned(false); setHovered(false); setFocused(false)
    }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.addEventListener('keydown', dismissKey)
    window.addEventListener('pointerdown', dismissOutside, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('keydown', dismissKey)
      window.removeEventListener('pointerdown', dismissOutside, true)
      if (bubble.matches(':popover-open')) bubble.hidePopover()
    }
  }, [open, reason])
  const button = <button {...props} ref={ref} id={buttonId} disabled={disabled} aria-describedby={[props['aria-describedby'], explained ? hintId : null].filter(Boolean).join(' ') || undefined} />
  if (!explained) return button
  return <span ref={trigger} className="eating-action-hint" role="group" tabIndex={0} aria-labelledby={buttonId} aria-describedby={hintId}
    onPointerDown={event => { lastPointer.current = event.pointerType; if (event.pointerType === 'touch') setHovered(false) }}
    onMouseEnter={() => { if (lastPointer.current !== 'touch') { setHovered(true); setDismissed(false) } }}
    onMouseLeave={() => { if (lastPointer.current !== 'touch') setHovered(false) }}
    onFocus={() => { if (lastPointer.current !== 'touch') { setFocused(true); setDismissed(false) } }}
    onBlur={() => { setFocused(false); setPinned(false) }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); setPinned(false) }
      if (event.key === 'Enter' || event.key === ' ') event.preventDefault()
    }}
    onClick={event => {
      event.preventDefault()
      if (lastPointer.current === 'touch') { setPinned(current => !current); setDismissed(false) }
      else { trigger.current?.focus(); setPinned(true); setDismissed(false) }
    }}>
    {button}
    <span ref={tooltip} id={hintId} className="eating-action-tooltip" role="tooltip" popover="manual">{reason}</span>
  </span>
}
