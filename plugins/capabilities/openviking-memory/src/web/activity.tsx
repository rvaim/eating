import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, RefreshCw, Search, Send, Trash2 } from 'lucide-react'
import { ActionButton, useI18n } from '@eating/ui-sdk'
import type { JsonObject, MemoryHit } from '@eating/plugin-sdk'
import type { RuntimeSnapshot } from '../types'
import { errorKey, failure, manage, readMemory, readSearch, readSnapshot } from './data'
import type { UiFailure } from './data'

export function FailureMessage({ value }: { value: UiFailure }) {
  const { t } = useI18n('openviking-memory')
  return <><p>{t(value.key)}</p>{value.code && <small>{t('error.code', { code: value.code })}</small>}</>
}

export function Activity({ active, visible, prefix, blocked, blockedReason, configurationRevision }: {
  active: boolean; visible: boolean; prefix: string; blocked: boolean; blockedReason: string; configurationRevision: number
}) {
  const { t, formatDateTime, formatNumber } = useI18n('openviking-memory')
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<UiFailure | null>(null)
  const [peer, setPeer] = useState('')
  const [busy, setBusy] = useState<'flush' | 'delete' | null>(null)
  const [confirmFlush, setConfirmFlush] = useState(false)
  const [message, setMessage] = useState<'activity.flushDone' | 'browse.deleted' | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(true)
  const [items, setItems] = useState<MemoryHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [reading, setReading] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ uri: string; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [browseError, setBrowseError] = useState<UiFailure | null>(null)
  const [detailError, setDetailError] = useState<UiFailure | null>(null)
  const mounted = useRef(false), enabled = useRef(false)
  enabled.current = active && visible
  const snapshotController = useRef<AbortController | null>(null), searchController = useRef<AbortController | null>(null)
  const detailController = useRef<AbortController | null>(null), mutationController = useRef<AbortController | null>(null)
  const snapshotGeneration = useRef(0), searchGeneration = useRef(0), detailGeneration = useRef(0)
  const lock = useRef(false), searchButton = useRef<HTMLButtonElement>(null)
  const errorRef = useRef<HTMLDivElement>(null), browseErrorRef = useRef<HTMLDivElement>(null), detailErrorRef = useRef<HTMLDivElement>(null)
  const alive = (controller: AbortController) => mounted.current && enabled.current && !controller.signal.aborted
  const cancelReads = useCallback(() => {
    ++snapshotGeneration.current; ++searchGeneration.current; ++detailGeneration.current
    snapshotController.current?.abort(); searchController.current?.abort(); detailController.current?.abort()
    snapshotController.current = null; searchController.current = null; detailController.current = null
  }, [])
  const clearMemory = useCallback(() => {
    ++searchGeneration.current; ++detailGeneration.current; searchController.current?.abort(); detailController.current?.abort()
    setItems(null); setDetail(null); setReading(null); setSearching(false); setConfirmDelete(false); setBrowseError(null); setDetailError(null)
  }, [])
  const load = useCallback(async (quiet = false) => {
    if (!mounted.current || !enabled.current || document.hidden) return
    // A slow read is allowed to finish; a poll never starves it by starting another request.
    if (snapshotController.current) { if (quiet) return; snapshotController.current.abort() }
    const ticket = ++snapshotGeneration.current, controller = new AbortController(); snapshotController.current = controller
    if (!quiet) setLoading(true)
    try {
      const value = readSnapshot(await manage('snapshot', {}, controller.signal))
      if (alive(controller) && ticket === snapshotGeneration.current) { setSnapshot(value); setError(null) }
    } catch (error) {
      if (alive(controller) && ticket === snapshotGeneration.current) { setError(failure(error)); if (!quiet) requestAnimationFrame(() => errorRef.current?.focus()) }
    } finally {
      if (snapshotController.current === controller) snapshotController.current = null
      if (mounted.current && ticket === snapshotGeneration.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; cancelReads(); mutationController.current?.abort() }
  }, [cancelReads])
  useEffect(() => {
    if (!active || !visible) {
      cancelReads(); clearMemory(); setLoading(false); setConfirmFlush(false)
      mutationController.current?.abort(); mutationController.current = null; lock.current = false; setBusy(null)
      return
    }
    clearMemory(); void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load(true) }, 5000)
    return () => { window.clearInterval(timer); cancelReads() }
  }, [active, visible, configurationRevision, load, cancelReads, clearMemory])
  useEffect(() => {
    const hide = () => { if (document.hidden) { cancelReads(); clearMemory() } }
    const leave = () => { cancelReads(); clearMemory(); mutationController.current?.abort() }
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', leave)
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave) }
  }, [cancelReads, clearMemory])

  async function flush() {
    if (lock.current || blocked || !snapshot?.ready || !enabled.current) return
    lock.current = true; setBusy('flush'); setError(null); setMessage(null)
    const controller = new AbortController(); mutationController.current = controller
    try {
      const value = readSnapshot(await manage('flush', peer ? { peerId: peer } : {}, controller.signal))
      if (alive(controller)) { setSnapshot(value); setConfirmFlush(false); setMessage('activity.flushDone') }
    } catch (error) {
      if (alive(controller)) { setError(failure(error)); setConfirmFlush(false); requestAnimationFrame(() => errorRef.current?.focus()) }
    } finally {
      if (mutationController.current === controller) { mutationController.current = null; lock.current = false; if (mounted.current) setBusy(null) }
    }
  }
  async function search() {
    if (!query.trim() || !enabled.current || (!all && !peer)) return
    clearMemory(); const ticket = ++searchGeneration.current, controller = new AbortController(); searchController.current = controller
    setSearching(true); setBrowseError(null)
    try {
      const input: JsonObject = { query: query.trim(), ...(all ? { all: true } : { peerId: peer }) }
      const value = readSearch(await manage('search', input, controller.signal))
      if (alive(controller) && ticket === searchGeneration.current) setItems(value)
    } catch (error) {
      if (alive(controller) && ticket === searchGeneration.current) { setBrowseError(failure(error)); requestAnimationFrame(() => browseErrorRef.current?.focus()) }
    } finally {
      if (searchController.current === controller) searchController.current = null
      if (mounted.current && ticket === searchGeneration.current) setSearching(false)
    }
  }
  async function open(uri: string) {
    ++detailGeneration.current; detailController.current?.abort(); const ticket = detailGeneration.current
    const controller = new AbortController(); detailController.current = controller
    setReading(uri); setDetail(null); setDetailError(null); setConfirmDelete(false)
    try {
      const value = readMemory(await manage('read', { uri }, controller.signal))
      if (value.uri !== uri) throw new Error('Mismatched URI')
      if (alive(controller) && ticket === detailGeneration.current) { setDetail(value); requestAnimationFrame(() => document.getElementById(`${prefix}-memory-detail`)?.focus()) }
    } catch (error) {
      if (alive(controller) && ticket === detailGeneration.current) { setDetailError(failure(error)); requestAnimationFrame(() => detailErrorRef.current?.focus()) }
    } finally {
      if (detailController.current === controller) detailController.current = null
      if (mounted.current && ticket === detailGeneration.current) setReading(null)
    }
  }
  async function remove() {
    if (!detail || lock.current || blocked || !enabled.current) return
    const uri = detail.uri, controller = new AbortController(); mutationController.current = controller
    lock.current = true; setBusy('delete'); setDetailError(null)
    try {
      const value = await manage('delete', { uri, confirmed: true }, controller.signal)
      if (!value || typeof value !== 'object' || !('deleted' in value) || value.deleted !== true) throw new Error('Invalid deletion response')
      if (alive(controller)) { setItems(current => current?.filter(item => item.uri !== uri) ?? null); setDetail(null); setConfirmDelete(false); setMessage('browse.deleted'); searchButton.current?.focus() }
    } catch (error) {
      if (alive(controller)) { setConfirmDelete(false); setDetailError(failure(error)); requestAnimationFrame(() => detailErrorRef.current?.focus()) }
    } finally {
      if (mutationController.current === controller) { mutationController.current = null; lock.current = false; if (mounted.current) setBusy(null) }
    }
  }
  const scopeOptions = snapshot?.scopes ?? []
  const operationReason = busy ? t('reason.busy') : blocked ? blockedReason : t('reason.connect')
  return <>
    <div className="ov-section-heading ov-heading-actions"><div><h3>{t('activity.title')}</h3><p>{t('activity.description')}</p></div>
      <ActionButton className="button button-secondary" disabled={loading} reason={t('reason.busy')} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />{t(loading ? 'common.loading' : 'activity.refresh')}</ActionButton></div>
    {error && <div className="ov-notice" role="alert" tabIndex={-1} ref={errorRef}><AlertCircle size={17} aria-hidden="true" /><div><FailureMessage value={error} /></div></div>}
    {loading && !snapshot && <p className="ov-empty" role="status">{t('common.loading')}</p>}
    {snapshot && <><dl className="ov-runtime">
      <div><dt>{t('activity.status')}</dt><dd className={snapshot.ready ? 'ov-success' : ''}>{t(snapshot.ready ? 'activity.ready' : 'activity.notReady')}</dd></div>
      <div><dt>{t('activity.lastRecall')}</dt><dd>{formatDateTime(snapshot.lastRecallAt)}</dd></div>
      <div><dt>{t('activity.lastCapture')}</dt><dd>{formatDateTime(snapshot.lastCaptureAt)}</dd></div>
      <div><dt>{t('activity.today')}</dt><dd>{formatNumber(snapshot.todayExtractions)}</dd></div>
      <div><dt>{t('activity.pending')}</dt><dd>{formatNumber(snapshot.pending)}</dd></div>
    </dl>{snapshot.lastErrorCode && <div className="ov-notice"><div><p>{t(errorKey(snapshot.lastErrorCode))}</p>{/^[A-Z][A-Z0-9_]{0,100}$/.test(snapshot.lastErrorCode) && <small>{t('error.code', { code: snapshot.lastErrorCode })}</small>}</div></div>}
    <section className="ov-section"><h3>{t('activity.scopes')}</h3>{!scopeOptions.length ? <p className="ov-empty">{t('activity.noScopes')}</p>
      : <ul className="ov-scopes">{scopeOptions.map(scope => <li key={scope.peerId}><div><strong>{scope.label || scope.peerId}</strong><span>{scope.peerId}</span></div><p>{t('ranges.capture')} {t(scope.capture ? 'common.on' : 'common.off')} · {t('ranges.recall')} {t(scope.recall ? 'common.on' : 'common.off')}<br />{t('activity.buffered', { value: formatNumber(scope.bufferedMessages) })}</p></li>)}</ul>}
      <div className="ov-activity-controls"><div className="ov-select-field"><label htmlFor={`${prefix}-peer`}>{t('activity.peer')}</label><select id={`${prefix}-peer`} value={peer} disabled={busy !== null} onChange={event => { setPeer(event.target.value); setConfirmFlush(false); clearMemory() }}><option value="">{t('activity.allPeers')}</option>{scopeOptions.map(scope => <option key={scope.peerId} value={scope.peerId}>{scope.label || scope.peerId}</option>)}</select></div>
        <ActionButton className="button button-secondary" disabled={busy !== null || blocked || !snapshot.ready} reason={operationReason} onClick={() => setConfirmFlush(true)}><Send size={16} aria-hidden="true" />{t('activity.flush')}</ActionButton></div>
      {confirmFlush && <div className="ov-confirm" role="group" aria-label={t('activity.flush')}><p>{t('activity.flushHint')}</p><strong>{peer || t('activity.allPeers')}</strong><div className="ov-actions"><ActionButton className="button button-primary" reason={t('reason.busy')} disabled={busy !== null} onClick={() => void flush()}>{t('activity.flushConfirm')}</ActionButton><ActionButton className="button button-secondary" disabled={busy !== null} reason={t('reason.busy')} onClick={() => setConfirmFlush(false)}>{t('common.cancel')}</ActionButton></div></div>}
    </section>
    <section className="ov-section"><h3>{t('activity.jobs')}</h3>{!snapshot.jobs.length ? <p className="ov-empty">{t('activity.noJobs')}</p> : <ul className="ov-jobs">{snapshot.jobs.map(job => <li key={job.id}>
      <div className="ov-job-heading"><strong className={`ov-job-status ov-job-${job.status}`}>{t(`status.${job.status}`)}</strong><time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time></div>
      <p className="ov-job-peer">{job.peerId}</p><p className="ov-hint">{t('activity.messages', { value: formatNumber(job.messages) })}{job.changes && ` · ${t('activity.changes', { added: formatNumber(job.changes.added), updated: formatNumber(job.changes.updated), deleted: formatNumber(job.changes.deleted) })}`}</p>
      {job.errorCode && <p className="ov-error">{t(errorKey(job.errorCode))}</p>}
      <details className="ov-job-details"><summary>{t('activity.jobId')}: {job.id}</summary><dl><div><dt>{t('activity.sessionId')}</dt><dd>{job.sessionId}</dd></div>{job.taskId && <div><dt>{t('activity.taskId')}</dt><dd>{job.taskId}</dd></div>}{job.archiveUri && <div><dt>{t('activity.archiveUri')}</dt><dd>{job.archiveUri}</dd></div>}</dl></details>
    </li>)}</ul>}</section></>}
    <details className="ov-disclosure ov-section" open={browseOpen} onToggle={event => { setBrowseOpen(event.currentTarget.open); if (!event.currentTarget.open) clearMemory() }}>
      <summary>{t('browse.title')}</summary><div className="ov-disclosure-body"><p className="ov-hint">{t('browse.description')}</p>
        <form className="ov-memory-search" onSubmit={event => { event.preventDefault(); void search() }}>
          <div className="ov-search"><label htmlFor={`${prefix}-memory-query`}>{t('browse.query')}</label><input id={`${prefix}-memory-query`} type="search" maxLength={2000} value={query} onChange={event => { setQuery(event.target.value); clearMemory() }} /></div>
          <div className="ov-select-field"><label htmlFor={`${prefix}-search-range`}>{t('activity.peer')}</label><select id={`${prefix}-search-range`} value={all ? 'all' : 'peer'} onChange={event => { setAll(event.target.value === 'all'); clearMemory() }}><option value="all">{t('browse.all')}</option><option value="peer">{t('browse.peer')}</option></select></div>
          <ActionButton ref={searchButton} className="button button-secondary" type="submit" disabled={searching || !query.trim() || (!all && !peer)} reason={t(searching ? 'reason.busy' : !query.trim() ? 'reason.query' : 'reason.peer')}><Search size={16} aria-hidden="true" />{t(searching ? 'common.loading' : 'browse.search')}</ActionButton>
        </form>
        {browseError && <div className="ov-notice" role="alert" tabIndex={-1} ref={browseErrorRef}><FailureMessage value={browseError} /></div>}
        {!searching && !browseError && (items === null || !items.length) && <p className="ov-empty">{t(items === null ? 'browse.before' : 'browse.empty')}</p>}
        {items && <ul className="ov-memory-results">{items.map(item => <li key={item.uri}><button type="button" className="ov-memory-result" aria-label={`${t('browse.read')}: ${item.uri}`} aria-busy={reading === item.uri} onClick={() => void open(item.uri)}><span><strong>{item.uri}</strong><span>{item.text.slice(0, 280)}</span><small>{t('browse.score', { value: formatNumber(item.score, { maximumFractionDigits: 2 }) })}</small></span><ChevronRight size={16} aria-hidden="true" /></button></li>)}</ul>}
        {detailError && <div className="ov-notice" role="alert" tabIndex={-1} ref={detailErrorRef}><FailureMessage value={detailError} /></div>}
        {detail && <section className="ov-memory-detail" id={`${prefix}-memory-detail`} tabIndex={-1} aria-label={t('browse.detail')}><div className="ov-heading-actions"><h3>{t('browse.detail')}</h3><ActionButton className="text-button" disabled={busy !== null} reason={t('reason.busy')} onClick={() => { setDetail(null); setConfirmDelete(false); searchButton.current?.focus() }}>{t('common.close')}</ActionButton></div><p className="ov-uri">{detail.uri}</p><pre>{detail.text}</pre>
          {!confirmDelete ? <ActionButton className="text-button ov-danger" disabled={busy !== null || blocked} reason={busy ? t('reason.busy') : blockedReason} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" />{t('browse.delete')}</ActionButton>
            : <div className="ov-confirm" role="group" aria-label={t('browse.confirmTitle')}><strong>{t('browse.confirmTitle')}</strong><p>{t('browse.confirmText')}</p><p className="ov-uri">{detail.uri}</p><div className="ov-actions"><ActionButton className="button button-danger" disabled={busy !== null} reason={t('reason.busy')} onClick={() => void remove()}>{t('browse.confirm')}</ActionButton><ActionButton className="button button-secondary" disabled={busy !== null} reason={t('reason.busy')} onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</ActionButton></div></div>}
        </section>}
      </div>
    </details>
    {message && <p className="ov-success" role="status">{t(message)}</p>}
  </>
}
