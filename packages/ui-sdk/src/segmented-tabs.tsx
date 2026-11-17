import { useId, useLayoutEffect, useRef } from 'react'
import { useI18n } from './i18n.js'
import './segmented-tabs.css'

export interface SegmentedTabItem<Id extends string = string> {
  readonly id: Id
  readonly label: string
  readonly dirty?: boolean
  readonly badge?: string | number
}

export interface SegmentedTabsProps<Id extends string = string> {
  readonly ariaLabel: string
  readonly tabs: readonly SegmentedTabItem<Id>[]
  readonly activeTab: Id
  readonly onSelect: (id: Id) => void
  readonly idPrefix?: string
  readonly sticky?: boolean
  readonly className?: string
}

/** Accessible sticky WAI-ARIA tab rail with dirty indicators, badges, and horizontal mobile scroll. */
export function SegmentedTabs<Id extends string = string>({
  ariaLabel,
  tabs,
  activeTab,
  onSelect,
  idPrefix,
  sticky = true,
  className,
}: SegmentedTabsProps<Id>) {
  const { t, locale } = useI18n('common')
  const generated = useId()
  const prefix = idPrefix ?? `eating-tabs-${generated}`
  const railRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const reveal = () => {
      const selected = rail.querySelector('[aria-selected="true"]')
      if (!selected) return
      const bounds = rail.getBoundingClientRect()
      const target = selected.getBoundingClientRect()
      const style = getComputedStyle(rail)
      const start = bounds.left + (parseFloat(style.paddingLeft) || 0)
      const end = bounds.right - (parseFloat(style.paddingRight) || 0)
      if (target.left < start) rail.scrollLeft += target.left - start
      else if (target.right > end) rail.scrollLeft += target.right - end
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [activeTab, locale, tabs.length])

  function moveFocus(nextIndex: number) {
    const normalized = (nextIndex + tabs.length) % tabs.length
    const target = tabs[normalized]
    if (!target) return
    onSelect(target.id)
    document.getElementById(`${prefix}-tab-${target.id}`)?.focus()
  }

  return (
    <div
      ref={railRef}
      className={`eating-tabs${sticky ? ' workspace-rail' : ''}${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}>
      {tabs.map((tab, index) => {
        const selected = tab.id === activeTab
        return (
          <button
            key={tab.id}
            id={`${prefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${prefix}-panel-${tab.id}`}
            aria-description={tab.dirty ? t('tabs.unsavedMark') : undefined}
            title={tab.dirty ? t('tabs.unsavedMark') : undefined}
            tabIndex={selected ? 0 : -1}
            className={`eating-tab${selected ? ' is-selected' : ''}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(index + 1) }
              else if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(index - 1) }
              else if (event.key === 'Home') { event.preventDefault(); moveFocus(0) }
              else if (event.key === 'End') { event.preventDefault(); moveFocus(tabs.length - 1) }
            }}>
            <span>{tab.label}</span>
            {tab.badge !== undefined && <span className="eating-tab-badge">{tab.badge}</span>}
            {tab.dirty && <span className="eating-tab-dirty" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}
