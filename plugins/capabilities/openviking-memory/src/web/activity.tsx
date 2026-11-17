import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, RefreshCw, Send } from 'lucide-react'
import { ActionButton, HostApiError, InlineConfirm, UnknownOutcomeCard, useI18n } from '@eating/ui-sdk'
import type { MemoryJob, RuntimeSnapshot, ScopeSummary } from '../types'
import { errorKey, failure, manage, readSnapshot } from './data'
import type { UiFailure } from './data'

export function FailureMessage({ value }: { value: UiFailure }) {
  const { t } = useI18n('openviking-memory')
  return (
    <>
      <p>{t(value.key)}</p>
      {value.code && <small>{t('error.code', { code: value.code })}</small>}
    </>
  )
}

type JobFilter = 'all' | 'active' | 'attention' | 'completed'

function matchesJobFilter(job: MemoryJob, filter: JobFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'completed') return job.status === 'completed'
  if (filter === 'attention') return job.status === 'failed' || job.status === 'unknown'
  return job.status === 'queued' || job.status === 'syncing' || job.status === 'synced' || job.status === 'committing' || job.status === 'processing'
}

export function Activity({
  active,
  visible,
  prefix,
  blocked,
  blockedReason,
  configurationRevision,
  peer,
  onPeerChange,
  onScopesChange,
  memoryDisabled,
  configEnabled,
  onEnableNow,
}: {
  active: boolean
  visible: boolean
  prefix: string
  blocked: boolean
  blockedReason: string
  configurationRevision: number
  peer: string
  onPeerChange: (next: string) => void
  onScopesChange: (scopes: readonly ScopeSummary[]) => void
  memoryDisabled: boolean
  configEnabled: boolean
  onEnableNow: () => void
}) {
  const { t, formatDateTime, formatNumber } = useI18n('openviking-memory')
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<UiFailure | null>(null)
  const [flushUnknown, setFlushUnknown] = useState(false)
  const [busy, setBusy] = useState<'flush' | null>(null)
  const [confirmFlush, setConfirmFlush] = useState(false)
  const [message, setMessage] = useState<'activity.flushDone' | null>(null)
  const [jobFilter, setJobFilter] = useState<JobFilter>('all')

  const mounted = useRef(false)
  const enabled = useRef(false)
  enabled.current = active && visible
  const scopesCallback = useRef(onScopesChange)
  scopesCallback.current = onScopesChange

  const snapshotController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const snapshotGeneration = useRef(0)
  const lock = useRef(false)
  const errorRef = useRef<HTMLDivElement>(null)

  const alive = (controller: AbortController) => mounted.current && enabled.current && !controller.signal.aborted

  const cancelReads = useCallback(() => {
    ++snapshotGeneration.current
    snapshotController.current?.abort()
    snapshotController.current = null
  }, [])

  const load = useCallback(async (quiet = false) => {
    if (!mounted.current || !enabled.current || document.hidden) return
    // A slow read is allowed to finish; a poll never starves it by starting another request.
    if (snapshotController.current) {
      if (quiet) return
      snapshotController.current.abort()
    }
    const ticket = ++snapshotGeneration.current
    const controller = new AbortController()
    snapshotController.current = controller
    if (!quiet) setLoading(true)
    try {
      const value = readSnapshot(await manage('snapshot', {}, controller.signal))
      if (alive(controller) && ticket === snapshotGeneration.current) {
        setSnapshot(value)
        setError(null)
        scopesCallback.current(value.scopes)
      }
    } catch (error) {
      if (alive(controller) && ticket === snapshotGeneration.current) {
        setError(failure(error))
        if (!quiet) requestAnimationFrame(() => errorRef.current?.focus())
      }
    } finally {
      if (snapshotController.current === controller) snapshotController.current = null
      if (mounted.current && ticket === snapshotGeneration.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelReads()
      mutationController.current?.abort()
    }
  }, [cancelReads])

  useEffect(() => {
    if (!active || !visible) {
      cancelReads()
      setLoading(false)
      setConfirmFlush(false)
      mutationController.current?.abort()
      mutationController.current = null
      lock.current = false
      setBusy(null)
      return
    }
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true)
    }, 5000)
    return () => {
      window.clearInterval(timer)
      cancelReads()
    }
  }, [active, visible, configurationRevision, load, cancelReads])

  useEffect(() => {
    const hide = () => {
      if (document.hidden) cancelReads()
    }
    const leave = () => {
      cancelReads()
      mutationController.current?.abort()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
    }
  }, [cancelReads])

  async function flush() {
    if (lock.current || blocked || !snapshot?.ready || !enabled.current) return
    lock.current = true
    setBusy('flush')
    setError(null)
    setFlushUnknown(false)
    setMessage(null)
    const controller = new AbortController()
    mutationController.current = controller
    try {
      const value = readSnapshot(await manage('flush', peer ? { peerId: peer } : {}, controller.signal))
      if (alive(controller)) {
        setSnapshot(value)
        scopesCallback.current(value.scopes)
        setConfirmFlush(false)
        setMessage('activity.flushDone')
      }
    } catch (error) {
      if (alive(controller)) {
        if (error instanceof HostApiError && error.outcome === 'unknown') setFlushUnknown(true)
        setError(failure(error))
        setConfirmFlush(false)
        requestAnimationFrame(() => errorRef.current?.focus())
      }
    } finally {
      if (mutationController.current === controller) {
        mutationController.current = null
        lock.current = false
        if (mounted.current) setBusy(null)
      }
    }
  }

  const scopeOptions = snapshot?.scopes ?? []
  const operationReason = busy ? t('reason.busy') : blocked ? blockedReason : t('reason.connect')
  const jobs = snapshot?.jobs ?? []
  const filteredJobs = jobs.filter(job => matchesJobFilter(job, jobFilter))
  const filterCounts: Record<JobFilter, number> = {
    all: jobs.length,
    active: jobs.filter(j => matchesJobFilter(j, 'active')).length,
    attention: jobs.filter(j => matchesJobFilter(j, 'attention')).length,
    completed: jobs.filter(j => matchesJobFilter(j, 'completed')).length,
  }

  return (
    <>
      <div className="ov-section-heading ov-heading-actions">
        <div>
          <h3>{t('activity.title')}</h3>
          <p>{t('activity.description')}</p>
        </div>
        <div className="ov-actions">
          <span className="ov-live-pill">{t('activity.livePoll')}</span>
          <ActionButton className="button button-secondary" disabled={loading} reason={t('reason.busy')} onClick={() => void load()}>
            <RefreshCw size={16} aria-hidden="true" />
            {t(loading ? 'common.loading' : 'activity.refresh')}
          </ActionButton>
        </div>
      </div>

      {memoryDisabled && (
        <div className="ov-enable-cta" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{t('banner.disabledTitle')}</strong>
            <p>{t('banner.disabledBody')}</p>
          </div>
          <ActionButton className="button button-primary" disabled={blocked} reason={blockedReason} onClick={onEnableNow}>
            {t(configEnabled ? 'banner.enableDraft' : 'banner.enableNow')}
          </ActionButton>
        </div>
      )}

      {error && (
        <div className="ov-notice" role="alert" tabIndex={-1} ref={errorRef}>
          <AlertCircle size={17} aria-hidden="true" />
          <div>
            <FailureMessage value={error} />
          </div>
        </div>
      )}

      {flushUnknown && (
        <UnknownOutcomeCard
          refreshing={loading}
          onRefresh={() => void load()}
          onConfirmReviewed={() => {
            setFlushUnknown(false)
            setError(null)
          }}
        />
      )}

      {loading && !snapshot && (
        <p className="ov-empty" role="status">
          {t('common.loading')}
        </p>
      )}

      {snapshot && (
        <>
          <dl className="ov-runtime">
            <div>
              <dt>{t('activity.status')}</dt>
              <dd className={snapshot.ready ? 'ov-success' : ''}>{t(snapshot.ready ? 'activity.ready' : 'activity.notReady')}</dd>
            </div>
            <div>
              <dt>{t('activity.lastRecall')}</dt>
              <dd>{formatDateTime(snapshot.lastRecallAt)}</dd>
            </div>
            <div>
              <dt>{t('activity.lastCapture')}</dt>
              <dd>{formatDateTime(snapshot.lastCaptureAt)}</dd>
            </div>
            <div>
              <dt>{t('activity.today')}</dt>
              <dd>{formatNumber(snapshot.todayExtractions)}</dd>
            </div>
            <div>
              <dt>{t('activity.pending')}</dt>
              <dd>{formatNumber(snapshot.pending)}</dd>
            </div>
          </dl>

          {snapshot.lastErrorCode && (
            <div className="ov-notice">
              <div>
                <p>{t(errorKey(snapshot.lastErrorCode))}</p>
                {/^[A-Z][A-Z0-9_]{0,100}$/.test(snapshot.lastErrorCode) && (
                  <small>{t('error.code', { code: snapshot.lastErrorCode })}</small>
                )}
              </div>
            </div>
          )}

          <section className="ov-section">
            <h3>{t('activity.scopes')}</h3>
            {!scopeOptions.length ? (
              <p className="ov-empty">{t('activity.noScopes')}</p>
            ) : (
              <ul className="ov-scopes">
                {scopeOptions.map(scope => (
                  <li key={scope.peerId}>
                    <div>
                      <strong>{scope.label || scope.peerId}</strong>
                      <span>{scope.peerId}</span>
                    </div>
                    <p>
                      {t('ranges.capture')} {t(scope.capture ? 'common.on' : 'common.off')} · {t('ranges.recall')}{' '}
                      {t(scope.recall ? 'common.on' : 'common.off')}
                      <br />
                      {t('activity.buffered', { value: formatNumber(scope.bufferedMessages) })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="ov-activity-controls">
              <div className="ov-select-field">
                <label htmlFor={`${prefix}-peer`}>{t('activity.peer')}</label>
                <select
                  id={`${prefix}-peer`}
                  value={peer}
                  disabled={busy !== null}
                  onChange={event => {
                    onPeerChange(event.target.value)
                    setConfirmFlush(false)
                  }}>
                  <option value="">{t('activity.allPeers')}</option>
                  {scopeOptions.map(scope => (
                    <option key={scope.peerId} value={scope.peerId}>
                      {scope.label || scope.peerId}
                    </option>
                  ))}
                </select>
              </div>
              <ActionButton
                className="button button-secondary"
                disabled={busy !== null || blocked || !snapshot.ready}
                reason={operationReason}
                onClick={() => setConfirmFlush(true)}>
                <Send size={16} aria-hidden="true" />
                {t('activity.flush')}
              </ActionButton>
            </div>
            <InlineConfirm
              open={confirmFlush}
              variant="warning"
              title={t('activity.flushTitle')}
              description={t('activity.flushHint')}
              details={[peer || t('activity.allPeers')]}
              confirmLabel={t('activity.flushConfirm')}
              cancelLabel={t('common.cancel')}
              busy={busy === 'flush'}
              onConfirm={() => void flush()}
              onCancel={() => setConfirmFlush(false)}
            />
            {message && (
              <p className="ov-success ov-status-msg" role="status">
                {t(message)}
              </p>
            )}
          </section>

          <section className="ov-section">
            <div className="ov-heading-actions ov-jobs-header">
              <h3>{t('activity.jobs')}</h3>
              {jobs.length > 0 && (
                <div className="ov-job-filters" role="group" aria-label={t('activity.jobs')}>
                  {(['all', 'active', 'attention', 'completed'] as const).map(key => {
                    const labelKey =
                      key === 'all'
                        ? 'activity.filterAll'
                        : key === 'active'
                          ? 'activity.filterActive'
                          : key === 'attention'
                            ? 'activity.filterAttention'
                            : 'activity.filterCompleted'
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`ov-filter-pill${jobFilter === key ? ' is-selected' : ''}`}
                        aria-pressed={jobFilter === key}
                        onClick={() => setJobFilter(key)}>
                        {t(labelKey)} ({formatNumber(filterCounts[key])})
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            {!jobs.length ? (
              <p className="ov-empty">{t('activity.noJobs')}</p>
            ) : !filteredJobs.length ? (
              <p className="ov-empty">{t('activity.noFilteredJobs')}</p>
            ) : (
              <ul className="ov-jobs">
                {filteredJobs.map(job => (
                  <li key={job.id}>
                    <div className="ov-job-heading">
                      <strong className={`ov-job-status ov-job-${job.status}`}>{t(`status.${job.status}`)}</strong>
                      <time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time>
                    </div>
                    <p className="ov-job-peer">{job.peerId}</p>
                    <p className="ov-hint">
                      {t(job.kind === 'commit' ? 'activity.commitJob' : 'activity.appendJob')} ·{' '}
                      {t('activity.messages', { value: formatNumber(job.messages) })}
                      {job.pendingTokens !== null && ` · ${t('activity.pendingTokens', { value: formatNumber(job.pendingTokens) })}`}
                    </p>
                    {job.errorCode && <p className="ov-error">{t(errorKey(job.errorCode))}</p>}
                    {job.trigger && <p className="ov-hint">{t(`trigger.${job.trigger}`)}</p>}
                    {job.status === 'synced' && <p className="ov-hint">{t('activity.awaitingCommit')}</p>}
                    {job.status === 'unknown' && (
                      <p className="ov-hint">{t(job.taskId ? 'activity.knownTaskUnknown' : 'activity.unknownBlocked')}</p>
                    )}
                    <details className="ov-job-details">
                      <summary>
                        {t('activity.jobId')}: {job.id}
                      </summary>
                      <dl>
                        <div>
                          <dt>{t('activity.sessionId')}</dt>
                          <dd>{job.sessionId}</dd>
                        </div>
                        {job.taskId && (
                          <div>
                            <dt>{t('activity.taskId')}</dt>
                            <dd>{job.taskId}</dd>
                          </div>
                        )}
                        {job.archiveUri && (
                          <div>
                            <dt>{t('activity.archiveUri')}</dt>
                            <dd>{job.archiveUri}</dd>
                          </div>
                        )}
                      </dl>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  )
}
