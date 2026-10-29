import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AlertCircle, ChevronRight, RefreshCw } from 'lucide-react'
import type { HarnessSessionContent, HarnessSessionList, HarnessSessionSummary } from '@eating/plugin-sdk'
import { getErrorMessage, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { appendSessionRecords, readSessionContent, readSessionList, sessionRows, visibleSessionRecord } from './panel-data'
import type { DshTranslationKey } from './i18n'
import { SessionRecord } from './SessionRecord'
import './SessionDashboard.css'

const statusKeys: Record<string, DshTranslationKey> = { running: 'sessions.status.running', idle: 'sessions.status.idle', stopped: 'sessions.status.stopped', unknown: 'sessions.status.unknown' }

/** Explicit reads of the current Harness's native sessions, with no polling or subscriptions. */
export function SessionDashboard({ enabled }: { readonly enabled: boolean }) {
  const { t, locale, formatDateTime, formatNumber } = useI18n('dsh')
  const prefix = useId()
  const [list, setList] = useState<HarnessSessionList | null>(null)
  const [content, setContent] = useState<HarnessSessionContent | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState<'list' | 'content' | 'more' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const selection = useRef<string | null>(null)
  const dashboardRef = useRef<HTMLElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const navigationRef = useRef<HTMLElement>(null)
  const hasSessions = Boolean(list?.sessions.length)

  useLayoutEffect(() => {
    const dashboard = dashboardRef.current, layout = layoutRef.current, navigation = navigationRef.current
    if (!hasSessions || !dashboard || !layout || !navigation) return
    let viewport = dashboard.parentElement
    while (viewport && !/auto|scroll/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement
    if (!viewport) return
    const scrollport = viewport
    let frame: number | null = null
    const measure = () => {
      frame = null
      const bounds = scrollport.getBoundingClientRect(), region = layout.getBoundingClientRect()
      const parentStyle = getComputedStyle(scrollport), navigationStyle = getComputedStyle(navigation)
      const gap = parseFloat(parentStyle.getPropertyValue('--panel-sticky-gap'))
      const stickyTop = bounds.top + scrollport.clientTop + parseFloat(parentStyle.paddingTop) + parseFloat(navigationStyle.top)
      const top = Math.max(region.top + parseFloat(getComputedStyle(layout).paddingTop), stickyTop)
      const bottom = Math.min(bounds.top + scrollport.clientTop + scrollport.clientHeight - gap, region.bottom)
      const available = `${Math.max(44, Math.floor(bottom - top))}px`
      if (navigation.style.getPropertyValue('--session-navigation-available-block-size') !== available) navigation.style.setProperty('--session-navigation-available-block-size', available)
      const height = `${navigation.offsetHeight}px`
      if (dashboard.style.getPropertyValue('--session-navigation-sticky-block-size') !== height) dashboard.style.setProperty('--session-navigation-sticky-block-size', height)
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(scrollport); observer.observe(dashboard); observer.observe(layout); observer.observe(navigation)
    scrollport.addEventListener('scroll', schedule, { passive: true })
    measure()
    return () => {
      observer.disconnect(); scrollport.removeEventListener('scroll', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
      navigation.style.removeProperty('--session-navigation-available-block-size')
      dashboard.style.removeProperty('--session-navigation-sticky-block-size')
    }
  }, [hasSessions, locale])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++generation.current; controller.current?.abort(); controller.current = null; selection.current = null }
  }, [])

  useEffect(() => {
    if (enabled) return
    ++generation.current; controller.current?.abort(); controller.current = null; selection.current = null
    setList(null); setContent(null); setSelected(null); setLoading(null); setError(null)
  }, [enabled])

  function begin(next: 'list' | 'content' | 'more') {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    const ticket = ++generation.current
    setLoading(next); setError(null)
    return { current, ticket }
  }
  const current = (signal: AbortSignal, ticket: number) => mounted.current && !document.hidden && !signal.aborted && generation.current === ticket

  async function refresh() {
    if (!enabled || document.hidden || loading === 'list') return
    const { current: request, ticket } = begin('list')
    selection.current = null; setSelected(null); setContent(null)
    try {
      const response = readSessionList(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: 'list-sessions', input: {} }, signal: request.signal }))
      if (current(request.signal, ticket)) setList(response)
    } catch (failure) { if (current(request.signal, ticket)) { setError(failure); setList(null) } }
    finally { if (current(request.signal, ticket)) setLoading(null); if (controller.current === request) controller.current = null }
  }

  async function read(sessionId: string, offset = 0) {
    if (!enabled || document.hidden || loading === 'list' || offset > 0 && (selection.current !== sessionId || loading !== null || !content)) return
    const previous = offset === 0 ? [] : content?.records ?? []
    const { current: request, ticket } = begin(offset === 0 ? 'content' : 'more')
    selection.current = sessionId; setSelected(sessionId)
    if (offset === 0) setContent(null)
    try {
      const response = readSessionContent(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: 'read-session', input: { sessionId, offset, limit: 50 } }, signal: request.signal }), sessionId, offset)
      if (!current(request.signal, ticket) || selection.current !== sessionId) return
      setContent({ ...response, records: appendSessionRecords(previous, response, sessionId) })
    } catch (failure) { if (current(request.signal, ticket) && selection.current === sessionId) setError(failure) }
    finally { if (current(request.signal, ticket)) setLoading(null); if (controller.current === request) controller.current = null }
  }

  const rows = sessionRows(list?.sessions ?? [])
  const records = content?.records.filter(visibleSessionRecord) ?? []
  const selectedSummary = content?.session ?? rows.find(row => row.session.id === selected)?.session
  const failureCode = error instanceof HostApiError ? error.code : 'UNEXPECTED_ERROR'
  const sessionTitle = (session: HarnessSessionSummary) => session.pluginId && session.accountId && session.targetId && session.conversationKind
    ? t(`sessions.target.${session.conversationKind}`, { plugin: session.pluginName || session.pluginId, account: session.accountId, target: session.targetId }) : session.title || t('sessions.untitled')

  return <section ref={dashboardRef} className="dsh-sessions" aria-labelledby={`${prefix}-heading`}>
    <div className="dsh-sessions-heading"><div><h3 id={`${prefix}-heading`}>{t('sessions.title')}</h3><p>{t('sessions.description')}</p></div><button className="button button-secondary" type="button" disabled={!enabled || loading === 'list'} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{t(loading === 'list' ? 'sessions.refreshing' : 'sessions.refresh')}</button></div>
    <p className="dsh-session-privacy">{t('sessions.privacy')}</p>
    {error !== null && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{getErrorMessage(error, t('sessions.error'))}</p><small>{t('error.code', { code: failureCode })}</small></div></div>}
    {!enabled && <p className="dsh-session-empty">{t('sessions.disabled')}</p>}
    {enabled && !list && loading !== 'list' && error === null && <p className="dsh-session-empty">{t('sessions.initial')}</p>}
    {loading === 'list' && <p className="dsh-session-empty" role="status">{t('sessions.loadingList')}</p>}
    {list && <>
      <div className="dsh-sessions-meta"><span>{t('sessions.count', { count: rows.length, value: formatNumber(rows.length) })}</span><span>{t('sessions.refreshed', { time: formatDateTime(list.refreshedAt) })}</span></div>
      {list.truncated && <p className="dsh-session-warning" role="status">{t('sessions.truncated', { limit: formatNumber(100) })}</p>}
      {rows.length === 0 ? <p className="dsh-session-empty">{t('sessions.empty')}</p> : <div ref={layoutRef} className="dsh-session-layout">
        <nav ref={navigationRef} className="dsh-session-navigation" aria-label={t('sessions.navigation')}><ul>{rows.map(({ session, depth, issue }) => <li key={session.id} style={{ '--session-depth': Math.min(depth, 5) } as CSSProperties}>
          <button type="button" className="dsh-session-select" aria-current={selected === session.id ? 'true' : undefined} disabled={loading === 'list'} onClick={() => void read(session.id)}>
            <span className="dsh-session-title"><ChevronRight size={14} aria-hidden="true" /><span dir="auto">{sessionTitle(session)}</span></span>
            <span className="dsh-session-subtitle">{session.parentId === null ? t('sessions.main') : t('sessions.child')} · {t(statusKeys[session.status]!)}</span>
            {issue && <span className="dsh-session-issue">{t(issue === 'cycle' ? 'sessions.cycle' : 'sessions.parentMissing')}</span>}
          </button>
        </li>)}</ul></nav>
        <section className="dsh-session-content" aria-labelledby={`${prefix}-content-heading`} aria-busy={loading === 'content' || loading === 'more'}>
          <h4 id={`${prefix}-content-heading`}>{selectedSummary ? sessionTitle(selectedSummary) : t(selected ? 'sessions.untitled' : 'sessions.contentTitle')}</h4>
          {!selected && <p className="dsh-session-empty">{t('sessions.select')}</p>}
          {selectedSummary && <dl className="dsh-session-info"><div><dt>{t('sessions.id')}</dt><dd>{selectedSummary.id}</dd></div><div><dt>{t('sessions.updated')}</dt><dd>{formatDateTime(selectedSummary.updatedAt)}</dd></div>{selectedSummary.agentTypeId && <div><dt>{t('sessions.agentType')}</dt><dd>{selectedSummary.agentTypeId}</dd></div>}{selectedSummary.parentId && <div><dt>{t('sessions.parent')}</dt><dd>{selectedSummary.parentId}</dd></div>}</dl>}
          {loading === 'content' && <p className="dsh-session-empty" role="status">{t('sessions.loadingContent')}</p>}
          {selected && !content && loading === null && error !== null && <button className="button button-secondary" type="button" onClick={() => void read(selected)}>{t('sessions.retryContent')}</button>}
          {content && <>
            {records.length === 0 ? <p className="dsh-session-empty">{t('sessions.emptyContent')}</p> : <ol className="dsh-session-records">{records.map(record => <SessionRecord key={record.sequence} record={record} session={content.session} />)}</ol>}
            {content.nextOffset !== null && content.records.length < 1000 && <button className="button button-secondary dsh-session-more" type="button" disabled={loading !== null} onClick={() => void read(content.session.id, content.nextOffset!)}>{t(loading === 'more' ? 'sessions.loadingMore' : 'sessions.more')}</button>}
            {content.nextOffset !== null && content.records.length >= 1000 && <p className="dsh-session-warning">{t('sessions.recordLimit', { limit: formatNumber(1000) })}</p>}
          </>}
        </section>
      </div>}
    </>}
  </section>
}
