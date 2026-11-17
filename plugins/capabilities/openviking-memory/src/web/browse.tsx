import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Eraser, Search, Trash2 } from 'lucide-react'
import { ActionButton, InlineConfirm, useI18n } from '@eating/ui-sdk'
import type { JsonObject, MemoryHit } from '@eating/plugin-sdk'
import type { ScopeSummary } from '../types'
import { failure, manage, readMemory, readSearch } from './data'
import type { UiFailure } from './data'
import type { RuleDraft } from './draft'
import { rulePath } from './draft'

function FailureInline({ value }: { value: UiFailure }) {
  const { t } = useI18n('openviking-memory')
  return (
    <>
      <p>{t(value.key)}</p>
      {value.code && <small>{t('error.code', { code: value.code })}</small>}
    </>
  )
}

export interface PeerChoice {
  readonly peerId: string
  readonly label: string
}

export function buildPeerChoices(scopes: readonly ScopeSummary[], rules: readonly RuleDraft[], user: string): readonly PeerChoice[] {
  const map = new Map<string, string>()
  for (const scope of scopes) {
    map.set(scope.peerId, scope.label || scope.peerId)
  }
  for (const rule of rules) {
    if (!rule.platform.trim() || !rule.accountId.trim() || !rule.targetId.trim()) continue
    const peerId = `${rule.platform.trim()}-${rule.accountId.trim()}-${rule.kind}-${rule.targetId.trim()}`
    if (!map.has(peerId) && rulePath(user.trim(), rule)) {
      map.set(peerId, rule.label.trim() || peerId)
    }
  }
  return Array.from(map.entries()).map(([peerId, label]) => ({ peerId, label }))
}

export function Browse({
  prefix,
  active,
  visible,
  blocked,
  blockedReason,
  configurationRevision,
  peer,
  onPeerChange,
  scopes,
  rules,
  user,
}: {
  prefix: string
  active: boolean
  visible: boolean
  blocked: boolean
  blockedReason: string
  configurationRevision: number
  peer: string
  onPeerChange: (next: string) => void
  scopes: readonly ScopeSummary[]
  rules: readonly RuleDraft[]
  user: string
}) {
  const { t, formatNumber } = useI18n('openviking-memory')
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(true)
  const [items, setItems] = useState<MemoryHit[] | null>(null)
  const [stale, setStale] = useState(false)
  const [searching, setSearching] = useState(false)
  const [reading, setReading] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ uri: string; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [browseError, setBrowseError] = useState<UiFailure | null>(null)
  const [detailError, setDetailError] = useState<UiFailure | null>(null)
  const [message, setMessage] = useState<'browse.deleted' | null>(null)

  const mounted = useRef(false)
  const enabled = useRef(false)
  enabled.current = active && visible
  const searchController = useRef<AbortController | null>(null)
  const detailController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const searchGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const searchButton = useRef<HTMLButtonElement>(null)
  const browseErrorRef = useRef<HTMLDivElement>(null)
  const detailErrorRef = useRef<HTMLDivElement>(null)

  const alive = (controller: AbortController) => mounted.current && enabled.current && !controller.signal.aborted

  const clearMemory = useCallback(() => {
    ++searchGeneration.current
    ++detailGeneration.current
    searchController.current?.abort()
    detailController.current?.abort()
    searchController.current = null
    detailController.current = null
    setItems(null)
    setStale(false)
    setDetail(null)
    setReading(null)
    setSearching(false)
    setConfirmDelete(false)
    setBrowseError(null)
    setDetailError(null)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++searchGeneration.current
      ++detailGeneration.current
      searchController.current?.abort()
      detailController.current?.abort()
      mutationController.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!active || !visible) {
      clearMemory()
      mutationController.current?.abort()
      mutationController.current = null
      setDeleting(false)
      setMessage(null)
      return
    }
    return () => {
      clearMemory()
    }
  }, [active, visible, configurationRevision, clearMemory])

  useEffect(() => {
    const hide = () => {
      if (document.hidden) clearMemory()
    }
    const leave = () => {
      clearMemory()
      mutationController.current?.abort()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
    }
  }, [clearMemory])

  const peerChoices = buildPeerChoices(scopes, rules, user)

  async function search() {
    if (!query.trim() || !enabled.current || (!all && !peer)) return
    ++searchGeneration.current
    ++detailGeneration.current
    searchController.current?.abort()
    detailController.current?.abort()
    const ticket = searchGeneration.current
    const controller = new AbortController()
    searchController.current = controller
    setSearching(true)
    setBrowseError(null)
    setDetailError(null)
    setConfirmDelete(false)
    setMessage(null)
    try {
      const input: JsonObject = { query: query.trim(), ...(all ? { all: true } : { peerId: peer }) }
      const value = readSearch(await manage('search', input, controller.signal))
      if (alive(controller) && ticket === searchGeneration.current) {
        setItems(value)
        setStale(false)
        setDetail(null)
      }
    } catch (error) {
      if (alive(controller) && ticket === searchGeneration.current) {
        setBrowseError(failure(error))
        requestAnimationFrame(() => browseErrorRef.current?.focus())
      }
    } finally {
      if (searchController.current === controller) searchController.current = null
      if (mounted.current && ticket === searchGeneration.current) setSearching(false)
    }
  }

  async function open(uri: string) {
    ++detailGeneration.current
    detailController.current?.abort()
    const ticket = detailGeneration.current
    const controller = new AbortController()
    detailController.current = controller
    setReading(uri)
    setDetail(null)
    setDetailError(null)
    setConfirmDelete(false)
    setMessage(null)
    try {
      const value = readMemory(await manage('read', { uri }, controller.signal))
      if (value.uri !== uri) throw new Error('Mismatched URI')
      if (alive(controller) && ticket === detailGeneration.current) {
        setDetail(value)
        requestAnimationFrame(() => document.getElementById(`${prefix}-memory-detail`)?.focus())
      }
    } catch (error) {
      if (alive(controller) && ticket === detailGeneration.current) {
        setDetailError(failure(error))
        requestAnimationFrame(() => detailErrorRef.current?.focus())
      }
    } finally {
      if (detailController.current === controller) detailController.current = null
      if (mounted.current && ticket === detailGeneration.current) setReading(null)
    }
  }

  async function remove() {
    if (!detail || deleting || blocked || !enabled.current) return
    const uri = detail.uri
    const controller = new AbortController()
    mutationController.current = controller
    setDeleting(true)
    setDetailError(null)
    try {
      const value = await manage('delete', { uri, confirmed: true }, controller.signal)
      if (!value || typeof value !== 'object' || !('deleted' in value) || value.deleted !== true) {
        throw new Error('Invalid deletion response')
      }
      if (alive(controller)) {
        setItems(current => current?.filter(item => item.uri !== uri) ?? null)
        setDetail(null)
        setConfirmDelete(false)
        setMessage('browse.deleted')
        searchButton.current?.focus()
      }
    } catch (error) {
      if (alive(controller)) {
        setConfirmDelete(false)
        setDetailError(failure(error))
        requestAnimationFrame(() => detailErrorRef.current?.focus())
      }
    } finally {
      if (mutationController.current === controller) {
        mutationController.current = null
        if (mounted.current) setDeleting(false)
      }
    }
  }

  return (
    <>
      <div className="ov-section-heading">
        <h3>{t('browse.title')}</h3>
        <p>{t('browse.description')}</p>
      </div>
      <form
        className="ov-memory-search"
        onSubmit={event => {
          event.preventDefault()
          void search()
        }}>
        <div className="ov-search">
          <label htmlFor={`${prefix}-memory-query`}>{t('browse.query')}</label>
          <input
            id={`${prefix}-memory-query`}
            type="search"
            maxLength={2000}
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              if (items !== null) setStale(true)
            }}
          />
        </div>
        <div className="ov-select-field">
          <label htmlFor={`${prefix}-search-range`}>{t('activity.peer')}</label>
          <select
            id={`${prefix}-search-range`}
            value={all ? 'all' : 'peer'}
            onChange={event => {
              const nextAll = event.target.value === 'all'
              setAll(nextAll)
              if (!nextAll && !peer && peerChoices.length > 0) {
                onPeerChange(peerChoices[0]!.peerId)
              }
              if (items !== null) setStale(true)
            }}>
            <option value="all">{t('browse.all')}</option>
            <option value="peer">{t('browse.peer')}</option>
          </select>
        </div>
        {!all && (
          <div className="ov-select-field">
            <label htmlFor={`${prefix}-browse-peer`}>{t('browse.peer')}</label>
            <select
              id={`${prefix}-browse-peer`}
              value={peer}
              onChange={event => {
                onPeerChange(event.target.value)
                if (items !== null) setStale(true)
              }}>
              <option value="">{t('common.none')}</option>
              {peerChoices.map(choice => (
                <option key={choice.peerId} value={choice.peerId}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="ov-actions">
          <ActionButton
            ref={searchButton}
            className="button button-primary"
            type="submit"
            disabled={searching || !query.trim() || (!all && !peer)}
            reason={t(searching ? 'reason.busy' : !query.trim() ? 'reason.query' : 'reason.peer')}>
            <Search size={16} aria-hidden="true" />
            {t(searching ? 'common.loading' : 'browse.search')}
          </ActionButton>
          {items !== null && (
            <button type="button" className="button button-secondary" onClick={clearMemory}>
              <Eraser size={15} aria-hidden="true" />
              {t('browse.clear')}
            </button>
          )}
        </div>
      </form>
      {stale && items !== null && (
        <p className="ov-stale-banner" role="status">
          {t('browse.staleHint')}
        </p>
      )}
      {browseError && (
        <div className="ov-notice" role="alert" tabIndex={-1} ref={browseErrorRef}>
          <FailureInline value={browseError} />
        </div>
      )}
      {message && (
        <p className="ov-success ov-status-msg" role="status">
          {t(message)}
        </p>
      )}
      {!searching && !browseError && (items === null || !items.length) && (
        <p className="ov-empty">{t(items === null ? 'browse.before' : 'browse.empty')}</p>
      )}
      {(items && items.length > 0 || detail || detailError) && (
        <div className="ov-browse-layout">
          <div className="ov-browse-list-col">
            {items && items.length > 0 && (
              <ul className={`ov-memory-results${stale ? ' is-stale' : ''}`} aria-busy={searching}>
                {items.map(item => (
                  <li key={item.uri}>
                    <button
                      type="button"
                      className={`ov-memory-result${detail?.uri === item.uri ? ' is-selected' : ''}`}
                      aria-label={`${t('browse.read')}: ${item.uri}`}
                      aria-busy={reading === item.uri}
                      onClick={() => void open(item.uri)}>
                      <span>
                        <strong>{item.uri}</strong>
                        <span>{item.text.slice(0, 280)}</span>
                        <small>{t('browse.score', { value: formatNumber(item.score, { maximumFractionDigits: 2 }) })}</small>
                      </span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="ov-browse-detail-col">
            {detailError && (
              <div className="ov-notice" role="alert" tabIndex={-1} ref={detailErrorRef}>
                <FailureInline value={detailError} />
              </div>
            )}
            {detail ? (
              <section className="ov-memory-detail" id={`${prefix}-memory-detail`} tabIndex={-1} aria-label={t('browse.detail')}>
                <div className="ov-heading-actions">
                  <h3>{t('browse.detail')}</h3>
                  <ActionButton
                    className="text-button"
                    disabled={deleting}
                    reason={t('reason.busy')}
                    onClick={() => {
                      setDetail(null)
                      setConfirmDelete(false)
                      searchButton.current?.focus()
                    }}>
                    {t('common.close')}
                  </ActionButton>
                </div>
                <p className="ov-uri">{detail.uri}</p>
                <pre>{detail.text}</pre>
                {!confirmDelete ? (
                  <ActionButton
                    className="button button-secondary ov-danger"
                    disabled={deleting || blocked}
                    reason={deleting ? t('reason.busy') : blockedReason}
                    onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={16} aria-hidden="true" />
                    {t('browse.delete')}
                  </ActionButton>
                ) : (
                  <InlineConfirm
                    open={confirmDelete}
                    variant="danger"
                    title={t('browse.confirmTitle')}
                    description={t('browse.confirmText')}
                    details={[detail.uri]}
                    confirmLabel={t('browse.confirm')}
                    cancelLabel={t('common.cancel')}
                    busy={deleting}
                    onConfirm={() => void remove()}
                    onCancel={() => setConfirmDelete(false)}
                  />
                )}
              </section>
            ) : (
              !detailError && <p className="ov-empty ov-detail-placeholder">{t('browse.selectHint')}</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
