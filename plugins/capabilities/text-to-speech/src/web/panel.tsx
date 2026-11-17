import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, Copy, LoaderCircle, Plug, RefreshCw, Volume2, X } from 'lucide-react'
import {
  ActionButton,
  DurationInput,
  FormSaveBar,
  InlineConfirm,
  PasswordInput,
  SegmentedTabs,
  Switch,
  UnknownOutcomeCard,
  createRequestId,
  hostRequest,
  useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { speechDefaults, speechVoices } from '../types'
import type { SpeechConfiguration, SpeechJob, SpeechProvider } from '../types'
import { audioBlob, errorKey, manageSpeech, readConfig, readPage, readTestConnection } from './data'
import './i18n'
import './panel.css'

type PanelTab = 'workbench' | 'configuration'
type StatusFilter = 'all' | 'active' | 'attention' | 'succeeded'

interface Draft {
  endpoint: string
  provider: SpeechProvider
  timeoutMs: string
  key: string
  clear: boolean
}

type ProtocolDraftMap = Partial<Record<SpeechProvider['protocol'], { endpoint: string; provider: SpeechProvider }>>

const draftOf = (v: SpeechConfiguration): Draft => ({
  endpoint: v.endpoint,
  provider: structuredClone(v.provider),
  timeoutMs: String(v.timeoutMs),
  key: '',
  clear: false,
})

function isDraftDirty(draft: Draft | null, config: SpeechConfiguration | null): boolean {
  if (!draft || !config) return false
  return (
    draft.endpoint !== config.endpoint ||
    draft.timeoutMs !== String(config.timeoutMs) ||
    draft.key.length > 0 ||
    draft.clear ||
    JSON.stringify(draft.provider) !== JSON.stringify(config.provider)
  )
}

function validSpeechEndpoint(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'wss:' || (u.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) &&
      !u.username && !u.password && !u.search && !u.hash
  } catch {
    return false
  }
}

function matchesFilter(job: SpeechJob, filter: StatusFilter): boolean {
  if (filter === 'active') return job.status === 'queued' || job.status === 'running'
  if (filter === 'attention') return job.status === 'failed' || job.status === 'unknown'
  if (filter === 'succeeded') return job.status === 'succeeded'
  return true
}

export function SpeechPanel({ onRefresh, onFeedback, onDirtyChange, enabled }: PluginPanelProps) {
  const { t, formatDateTime, formatNumber } = useI18n('text-to-speech')
  const prefix = useId()
  const [tab, setTab] = useState<PanelTab>('workbench')
  const [config, setConfig] = useState<SpeechConfiguration | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [hiddenClearedNotice, setHiddenClearedNotice] = useState(false)
  const [configConflict, setConfigConflict] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [configNotice, setConfigNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: true; latencyMs: number } | { ok: false; key: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [page, setPage] = useState<ReturnType<typeof readPage> | null>(null)
  const [offset, setOffset] = useState(0)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [input, setInput] = useState('')
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [uncertainMutation, setUncertainMutation] = useState<{ requestId: string | null } | null>(null)
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState<'generate' | 'reload' | string | null>(null)
  const [preview, setPreview] = useState<{ jobId: string; url: string } | null>(null)
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [visible, setVisible] = useState(() => !document.hidden)

  const alive = useRef(false)
  const reads = useRef(new Set<AbortController>())
  const mutation = useRef<AbortController | null>(null)
  const testController = useRef<AbortController | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const previewUrl = useRef<string | null>(null)
  const previewTicket = useRef(0)
  const identity = useRef<{ intent: string; id: string } | null>(null)
  const offsetRef = useRef(0)
  const listRequest = useRef<AbortController | null>(null)
  const protocolDrafts = useRef<ProtocolDraftMap>({})
  const configRef = useRef<SpeechConfiguration | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const enabledRef = useRef(enabled)
  const callbacks = useRef({ onRefresh, onFeedback, onDirtyChange })
  const confirmHostRef = useRef<HTMLDivElement | null>(null)

  enabledRef.current = enabled
  configRef.current = config
  draftRef.current = draft
  offsetRef.current = offset
  callbacks.current = { onRefresh, onFeedback, onDirtyChange }

  const dirty = isDraftDirty(draft, config)

  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  const clearPreview = useCallback(() => {
    ++previewTicket.current
    previewController.current?.abort()
    previewController.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = null
    if (alive.current) {
      setPreview(null)
      setPreviewLoadingId(null)
    }
  }, [])

  const list = useCallback(async () => {
    if (!enabledRef.current || listRequest.current || document.hidden) return
    const controller = new AbortController()
    reads.current.add(controller)
    const at = offsetRef.current
    listRequest.current = controller
    try {
      const value = readPage(await manageSpeech('jobs', { offset: at, limit: 20 }, controller.signal))
      if (alive.current && enabledRef.current && !controller.signal.aborted && offsetRef.current === at) {
        setPage(value)
        setJobsError(null)
      }
    } catch (e) {
      if (alive.current && !controller.signal.aborted) setJobsError(errorKey(e))
    } finally {
      reads.current.delete(controller)
      if (listRequest.current === controller) listRequest.current = null
    }
  }, [])

  const load = useCallback(async (force = false) => {
    const controller = new AbortController()
    reads.current.add(controller)
    try {
      const value = readConfig(await hostRequest<unknown>('/plugins/text-to-speech/configuration', { signal: controller.signal }))
      if (!alive.current || controller.signal.aborted) return
      setConfig(value)
      if (force || !draftRef.current || !isDraftDirty(draftRef.current, configRef.current)) {
        const next = draftOf(value)
        setDraft(next)
        protocolDrafts.current = { [value.provider.protocol]: { endpoint: value.endpoint, provider: structuredClone(value.provider) } }
        setHiddenClearedNotice(false)
        setConfigConflict(false)
      }
      setConfigError(null)
    } catch (e) {
      if (alive.current && !controller.signal.aborted) setConfigError(errorKey(e))
    } finally {
      reads.current.delete(controller)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    const onHideOrLeave = (event: Event) => {
      const hidden = document.hidden || event.type === 'pagehide'
      setVisible(!hidden)
      if (hidden) {
        reads.current.forEach(c => c.abort())
        reads.current.clear()
        listRequest.current?.abort()
        listRequest.current = null
        mutation.current?.abort()
        mutation.current = null
        testController.current?.abort()
        testController.current = null
        setPending(false)
        setTesting(false)
        setConfirm(null)
        setDraft(v => {
          if (!v) return null
          const hadKey = v.key.length > 0
          if (hadKey) setHiddenClearedNotice(true)
          return hadKey ? { ...v, key: '', clear: false } : v
        })
        clearPreview()
      }
    }
    document.addEventListener('visibilitychange', onHideOrLeave)
    window.addEventListener('pagehide', onHideOrLeave)
    void load(true)
    return () => {
      alive.current = false
      reads.current.forEach(c => c.abort())
      reads.current.clear()
      listRequest.current?.abort()
      mutation.current?.abort()
      testController.current?.abort()
      clearPreview()
      document.removeEventListener('visibilitychange', onHideOrLeave)
      window.removeEventListener('pagehide', onHideOrLeave)
    }
  }, [load, clearPreview])

  useEffect(() => {
    if (!enabled || !visible) return
    void list()
    return () => {
      listRequest.current?.abort()
      listRequest.current = null
    }
  }, [enabled, visible, offset, list])

  const hasActiveJobs = page?.items.some(job => ['queued', 'running'].includes(job.status)) ?? false
  useEffect(() => {
    if (!enabled || !visible || !hasActiveJobs) return
    const timer = setInterval(() => { void list() }, 2000)
    return () => clearInterval(timer)
  }, [enabled, visible, hasActiveJobs, list])

  useEffect(() => {
    if (!enabled) {
      listRequest.current?.abort()
      listRequest.current = null
      mutation.current?.abort()
      mutation.current = null
      testController.current?.abort()
      testController.current = null
      setPending(false)
      setTesting(false)
      setConfirm(null)
      setJobsError(null)
      setGenerateError(null)
      setTestResult(null)
      clearPreview()
    }
  }, [enabled, clearPreview])

  useEffect(() => {
    if (!confirm) return
    requestAnimationFrame(() => {
      confirmHostRef.current?.querySelector('button')?.focus()
    })
  }, [confirm])

  async function runMutation(
    onError: (key: string, requestId?: string) => void,
    run: (signal: AbortSignal) => Promise<void>,
  ) {
    if (mutation.current || document.hidden) return
    const controller = new AbortController()
    mutation.current = controller
    setPending(true)
    setConfigError(null)
    setConfigNotice(null)
    setGenerateError(null)
    setJobsError(null)
    try {
      await run(controller.signal)
    } catch (e) {
      if (alive.current && !controller.signal.aborted) {
        onError(errorKey(e))
      }
    } finally {
      if (alive.current && mutation.current === controller) {
        mutation.current = null
        setPending(false)
        setConfirm(null)
      }
    }
  }

  function changeDraft(values: Partial<Draft>) {
    setDraft(current => {
      if (!current) return null
      const next: Draft = { ...current, ...values }
      protocolDrafts.current[next.provider.protocol] = {
        endpoint: next.endpoint,
        provider: structuredClone(next.provider),
      }
      return next
    })
    setConfigNotice(null)
    setConfigError(null)
    setTestResult(null)
  }

  function switchProtocol(protocol: SpeechProvider['protocol']) {
    if (!draft || draft.provider.protocol === protocol) return
    protocolDrafts.current[draft.provider.protocol] = {
      endpoint: draft.endpoint,
      provider: structuredClone(draft.provider),
    }
    const remembered = protocolDrafts.current[protocol]
    const fallback = speechDefaults(protocol)
    changeDraft({
      endpoint: remembered?.endpoint ?? fallback.endpoint,
      provider: remembered ? structuredClone(remembered.provider) : structuredClone(fallback.provider),
      clear: false,
    })
    setTestResult(null)
  }

  async function save(signal: AbortSignal) {
    if (!draft || !config) return
    const ms = Number(draft.timeoutMs)
    if (
      !validSpeechEndpoint(draft.endpoint) ||
      (draft.provider.protocol === 'openai-realtime' && !draft.provider.model.trim()) ||
      !/^\d+$/.test(draft.timeoutMs) ||
      !Number.isSafeInteger(ms) ||
      ms < 10000 ||
      ms > 300000
    ) {
      setConfigError('invalid')
      return
    }
    const saved = readConfig(
      await hostRequest('/plugins/text-to-speech/configuration', {
        method: 'POST',
        signal,
        body: {
          expectedRevision: config.revision,
          endpoint: draft.endpoint,
          provider: draft.provider,
          timeoutMs: ms,
          apiKey: draft.key,
          clearApiKey: draft.clear,
        },
      }),
    )
    if (!alive.current || signal.aborted) return
    setConfig(saved)
    setDraft(draftOf(saved))
    protocolDrafts.current = { [saved.provider.protocol]: { endpoint: saved.endpoint, provider: structuredClone(saved.provider) } }
    setHiddenClearedNotice(false)
    setConfigConflict(false)
    setConfigNotice('saved')
    setTestResult(null)
    callbacks.current.onFeedback?.(t('saved'))
    await callbacks.current.onRefresh?.()
  }

  async function handleTestConnection() {
    if (!enabled || !config || dirty || !config.apiKeyConfigured || pending || testing || document.hidden) return
    const controller = new AbortController()
    testController.current = controller
    setTesting(true)
    setConfigError(null)
    setConfigNotice(null)
    setTestResult(null)
    try {
      const result = readTestConnection(await manageSpeech('test-connection', {}, controller.signal))
      if (alive.current && !controller.signal.aborted) {
        setTestResult(result)
      }
    } catch (e) {
      if (alive.current && !controller.signal.aborted) {
        setTestResult({ ok: false, key: errorKey(e) })
      }
    } finally {
      if (alive.current && testController.current === controller) {
        testController.current = null
        setTesting(false)
      }
    }
  }

  async function generate(signal: AbortSignal) {
    const intent = JSON.stringify([input, config?.revision])
    if (identity.current?.intent !== intent) identity.current = { intent, id: createRequestId() }
    const reqId = identity.current.id
    try {
      await manageSpeech('generate', { text: input, request_id: reqId, confirmed: true }, signal)
      if (alive.current && !signal.aborted) {
        setUncertainMutation(null)
        setOffset(0)
        offsetRef.current = 0
        await list()
      }
    } catch (e) {
      if (alive.current && !signal.aborted) {
        if ((e as { outcome?: string })?.outcome === 'unknown') {
          setUncertainMutation({ requestId: reqId })
        }
        setGenerateError(errorKey(e))
      }
    }
  }

  async function play(jobId: string, assetId: string) {
    if (preview?.jobId === jobId) {
      clearPreview()
      return
    }
    clearPreview()
    const ticket = previewTicket.current
    const controller = new AbortController()
    previewController.current = controller
    reads.current.add(controller)
    setPreviewLoadingId(jobId)
    setJobsError(null)
    try {
      const blob = audioBlob(await manageSpeech('preview', { assetId }, controller.signal))
      if (alive.current && !controller.signal.aborted && ticket === previewTicket.current) {
        const url = URL.createObjectURL(blob)
        previewUrl.current = url
        setPreview({ jobId, url })
      }
    } catch (e) {
      if (alive.current && !controller.signal.aborted) setJobsError(errorKey(e))
    } finally {
      reads.current.delete(controller)
      if (previewController.current === controller) previewController.current = null
      if (alive.current) setPreviewLoadingId(current => current === jobId ? null : current)
    }
  }

  async function copyRequestId(requestId: string) {
    try {
      await navigator.clipboard.writeText(requestId)
      setCopiedId(requestId)
      window.setTimeout(() => {
        if (alive.current) setCopiedId(current => current === requestId ? null : current)
      }, 1800)
    } catch {
      /* Clipboard unavailable; text code remains selectable. */
    }
  }

  const sameServiceAsSaved = Boolean(
    config && draft && draft.provider.protocol === config.provider.protocol && draft.endpoint === config.endpoint,
  )

  const counts = useMemo(() => {
    const items = page?.items ?? []
    return {
      all: items.length,
      active: items.filter(j => matchesFilter(j, 'active')).length,
      attention: items.filter(j => matchesFilter(j, 'attention')).length,
      succeeded: items.filter(j => matchesFilter(j, 'succeeded')).length,
    }
  }, [page])

  const filteredItems = useMemo(
    () => (page?.items ?? []).filter(job => matchesFilter(job, filter)),
    [page, filter],
  )

  const unknownJob = page?.items.find(j => j.status === 'unknown')
  const showUnknownCard = Boolean(uncertainMutation || unknownJob)

  return (
    <div
      className="speech-panel"
      onKeyDown={e => {
        if (e.key === 'Escape' && confirm) {
          e.stopPropagation()
          setConfirm(null)
        }
      }}>
      <p className="speech-description">{t('description')}</p>

      <SegmentedTabs
        idPrefix={prefix}
        sticky
        className="speech-tabs"
        ariaLabel={t('tabs.label')}
        activeTab={tab}
        onSelect={next => {
          setConfirm(null)
          setTab(next)
        }}
        tabs={[
          {
            id: 'workbench',
            label: t('tabs.workbench'),
            badge: counts.active + counts.attention > 0 ? counts.active + counts.attention : undefined,
          },
          { id: 'configuration', label: t('tabs.configuration'), dirty },
        ]}
      />

      {!draft || !config ? (
        <div className="speech-loading">
          {configError && <p role="alert" className="speech-error">{t(configError)}</p>}
          <p role="status">{t('loading')}</p>
          <button type="button" className="text-button" onClick={() => void load(true)}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('refresh')}
          </button>
        </div>
      ) : (
        <>
          <div
            id={`${prefix}-panel-workbench`}
            role="tabpanel"
            aria-labelledby={`${prefix}-tab-workbench`}
            hidden={tab !== 'workbench'}
            className="speech-tab-panel">
            {(!enabled || !config.ready) && (
              <div className="speech-setup-cta" role="status">
                <AlertCircle size={18} aria-hidden="true" />
                <div>
                  <strong>{t(!enabled ? 'setupCta.disabledTitle' : 'setupCta.unconfiguredTitle')}</strong>
                  <p>{t(!enabled ? 'setupCta.disabledBody' : 'setupCta.unconfiguredBody')}</p>
                </div>
                {!config.ready && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setTab('configuration')}>
                    {t('setupCta.goToConfig')}
                  </button>
                )}
              </div>
            )}

            <section className="speech-card" aria-labelledby={`${prefix}-try`}>
              <div className="speech-card-head">
                <div>
                  <h3 id={`${prefix}-try`}>{t('preview')}</h3>
                  <p className="speech-description">{t('previewHelp')}</p>
                </div>
                <div className="speech-summary-pill" aria-label={t('savedSummary')}>
                  <Volume2 size={14} aria-hidden="true" />
                  <span>
                    {config.provider.protocol === 'deepseek-tts' ? 'DeepSeek TTS' : 'OpenAI Realtime'} · {config.provider.voice}
                  </span>
                </div>
              </div>

              <label className="speech-field speech-field-wide">
                <span>{t('text')}</span>
                <textarea
                  aria-label={t('text')}
                  maxLength={1000}
                  value={input}
                  onChange={e => {
                    setInput(e.target.value)
                    setGenerateError(null)
                  }}
                  disabled={pending}
                />
                <small className="speech-char-count">{t('charCount', { count: input.length })}</small>
              </label>

              {generateError && (
                <p role="alert" className="speech-error speech-inline-feedback">
                  <AlertCircle size={15} aria-hidden="true" />
                  {t(generateError)}
                </p>
              )}

              <div className="speech-actions">
                <ActionButton
                  reason={t(pending ? 'working' : !enabled ? 'disabled' : dirty ? 'needSave' : !config.ready ? 'notReady' : 'needInputText')}
                  className="button button-primary"
                  disabled={!enabled || pending || dirty || !input.trim() || !config.ready}
                  onClick={() => setConfirm('generate')}>
                  {t(pending && confirm === 'generate' ? 'working' : 'generate')}
                </ActionButton>
              </div>

              {confirm === 'generate' && (
                <div ref={confirmHostRef} className="speech-inline-confirm">
                  <InlineConfirm
                    variant="warning"
                    title={t('generateConfirmTitle')}
                    description={t('charge')}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    busy={pending}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => void runMutation(key => setGenerateError(key), generate)}
                  />
                </div>
              )}
            </section>

            {showUnknownCard && (
              <UnknownOutcomeCard
                title={t('unknownTitle')}
                body={t('unknownBody')}
                requestId={uncertainMutation?.requestId ?? unknownJob?.requestId ?? null}
                onRefresh={() => void list()}
                onConfirmReviewed={() => setUncertainMutation(null)}
                className="speech-unknown-card"
              />
            )}

            <section className="speech-card speech-jobs-section" aria-labelledby={`${prefix}-jobs`}>
              <div className="speech-jobs-head">
                <div>
                  <h3 id={`${prefix}-jobs`}>{t('jobs')}</h3>
                  {hasActiveJobs && (
                    <span className="speech-live-pill" role="status">
                      <LoaderCircle size={12} className="speech-spin" aria-hidden="true" />
                      {t('livePolling')}
                    </span>
                  )}
                </div>
                <div className="speech-jobs-tools">
                  <button
                    type="button"
                    className="text-button"
                    disabled={!enabled || pending}
                    onClick={() => void list()}>
                    <RefreshCw size={14} aria-hidden="true" />
                    {t('refreshJobs')}
                  </button>
                </div>
              </div>

              {jobsError && (
                <p role="alert" className="speech-error">
                  <AlertCircle size={15} aria-hidden="true" />
                  {t(jobsError)}
                </p>
              )}

              {!enabled ? (
                <p className="speech-description">{t('disabled')}</p>
              ) : !page?.items.length ? (
                <p className="speech-description">{t('empty')}</p>
              ) : (
                <>
                  <div className="speech-filters" role="group" aria-label={t('jobs')}>
                    {(['all', 'active', 'attention', 'succeeded'] as const).map(key => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={filter === key}
                        className={`speech-filter-pill${filter === key ? ' is-selected' : ''}`}
                        onClick={() => setFilter(key)}>
                        {t(`filter.${key}`, { count: counts[key] })}
                      </button>
                    ))}
                  </div>

                  {!filteredItems.length ? (
                    <p className="speech-description">{t('filterEmpty')}</p>
                  ) : (
                    <ul className="speech-jobs">
                      {filteredItems.map(job => {
                        const playingThis = preview?.jobId === job.jobId
                        const loadingThis = previewLoadingId === job.jobId
                        const confirmingDelete = confirm === job.jobId
                        const isUnknown = job.status === 'unknown'
                        return (
                          <li className={`speech-job is-${job.status}`} key={job.jobId}>
                            <header className="speech-job-header">
                              <strong className={`speech-job-status is-${job.status}`}>
                                {t('status.' + job.status)}
                              </strong>
                              <span className="speech-job-badge">{job.voice}</span>
                              <small>{job.protocol === 'deepseek-tts' ? 'DeepSeek TTS' : 'OpenAI Realtime'}</small>
                              {job.verification && (
                                <small className="speech-job-verified">
                                  {t('verification.' + job.verification)}
                                </small>
                              )}
                              {job.durationMs !== null && (
                                <small>
                                  {t('seconds', { value: formatNumber(job.durationMs / 1000, { maximumFractionDigits: 1 }) })}
                                </small>
                              )}
                              <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
                            </header>

                            <p className="speech-job-text">{job.text}</p>

                            {job.errorCode && (
                              <p role="alert" className="speech-error speech-job-error">
                                {t(errorKey(job.errorCode))}
                              </p>
                            )}

                            {isUnknown && (
                              <div className="speech-job-unknown-note">
                                <p>{t('unknown')}</p>
                                <div className="speech-job-id-row">
                                  <span>{t('requestIdLabel')}:</span>
                                  <code>{job.requestId}</code>
                                  <button
                                    type="button"
                                    className="button button-secondary speech-mini-btn"
                                    onClick={() => void copyRequestId(job.requestId)}>
                                    {copiedId === job.requestId ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                                    {copiedId === job.requestId ? t('copied') : t('copyId')}
                                  </button>
                                </div>
                              </div>
                            )}

                            <div className="speech-actions speech-job-actions">
                              {job.assetId && (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  disabled={loadingThis}
                                  onClick={() => void play(job.jobId, job.assetId!)}>
                                  {playingThis ? <X size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
                                  {loadingThis ? t('loadingAudio') : playingThis ? t('stopPlayer') : t('play')}
                                </button>
                              )}
                              {!['queued', 'running'].includes(job.status) && (
                                <button
                                  type="button"
                                  className="text-button speech-delete-btn"
                                  disabled={pending}
                                  onClick={() => setConfirm(confirmingDelete ? null : job.jobId)}>
                                  {t('delete')}
                                </button>
                              )}
                            </div>

                            {playingThis && preview && (
                              <div className="speech-job-player-box">
                                <audio
                                  className="speech-player"
                                  controls
                                  src={preview.url}
                                  aria-label={t('audioLabel')}
                                />
                              </div>
                            )}

                            {confirmingDelete && (
                              <div ref={confirmHostRef} className="speech-inline-confirm">
                                <InlineConfirm
                                  variant="danger"
                                  title={t('deleteConfirmTitle')}
                                  description={t('deleteHelp')}
                                  confirmLabel={t('confirmDelete')}
                                  cancelLabel={t('cancel')}
                                  busy={pending}
                                  onCancel={() => setConfirm(null)}
                                  onConfirm={() =>
                                    void runMutation(
                                      key => setJobsError(key),
                                      async signal => {
                                        await manageSpeech('delete', { jobId: job.jobId, confirmed: true }, signal)
                                        if (preview?.jobId === job.jobId) clearPreview()
                                        await list()
                                      },
                                    )
                                  }
                                />
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  <div className="speech-actions speech-pagination">
                    <button
                      type="button"
                      className="text-button"
                      disabled={!enabled || offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - 20))}>
                      {t('previous')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!enabled || !page || offset + 20 >= page.total}
                      onClick={() => setOffset(offset + 20)}>
                      {t('next')}
                    </button>
                    {page && (
                      <small>{t('page', { count: page.total, formatted: formatNumber(page.total), offset: formatNumber(offset + 1) })}</small>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>

          <div
            id={`${prefix}-panel-configuration`}
            role="tabpanel"
            aria-labelledby={`${prefix}-tab-configuration`}
            hidden={tab !== 'configuration'}
            className="speech-tab-panel">
            <section className="speech-card" aria-labelledby={`${prefix}-settings`}>
              <div className="speech-card-head">
                <div>
                  <h3 id={`${prefix}-settings`}>{t('configuration')}</h3>
                  <p className="speech-description">{t('configurationHelp')}</p>
                </div>
              </div>

              <div className="speech-fields">
                <label className="speech-field speech-field-wide">
                  <span>{t('protocol')}</span>
                  <select
                    aria-label={t('protocol')}
                    value={draft.provider.protocol}
                    disabled={pending}
                    onChange={e => {
                      const next = e.target.value
                      if (next === 'openai-realtime' || next === 'deepseek-tts') {
                        switchProtocol(next)
                      }
                    }}>
                    <option value="openai-realtime">OpenAI Realtime</option>
                    <option value="deepseek-tts">DeepSeek TTS</option>
                  </select>
                  <small>{t('provider.' + draft.provider.protocol)}</small>
                </label>

                <label className="speech-field speech-field-wide">
                  <span>{t('endpoint')}</span>
                  <input
                    aria-label={t('endpoint')}
                    value={draft.endpoint}
                    disabled={pending}
                    onChange={e => changeDraft({ endpoint: e.target.value })}
                  />
                  <small>{t('endpointHelp')}</small>
                </label>

                {draft.provider.protocol === 'openai-realtime' && (
                  <label className="speech-field">
                    <span>{t('model')}</span>
                    <input
                      aria-label={t('model')}
                      value={draft.provider.model}
                      disabled={pending}
                      onChange={e => {
                        if (draft.provider.protocol === 'openai-realtime') {
                          changeDraft({ provider: { ...draft.provider, model: e.target.value } })
                        }
                      }}
                    />
                  </label>
                )}

                <label className="speech-field">
                  <span>{t('voice')}</span>
                  <select
                    aria-label={t('voice')}
                    value={draft.provider.voice}
                    disabled={pending}
                    onChange={e =>
                      changeDraft({ provider: { ...draft.provider, voice: e.target.value } as SpeechProvider })
                    }>
                    {speechVoices(draft.provider.protocol).map(v => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <small>{t('voiceHelp')}</small>
                </label>

                {draft.provider.protocol === 'deepseek-tts' && (
                  <div className="speech-field speech-field-wide speech-switch-wrap">
                    <Switch
                      compact
                      id={`${prefix}-filter-md`}
                      aria-label={t('filterMarkdown')}
                      label={t('filterMarkdown')}
                      checked={draft.provider.filterMarkdown}
                      disabled={pending}
                      onChange={checked => {
                        if (draft.provider.protocol === 'deepseek-tts') {
                          changeDraft({ provider: { ...draft.provider, filterMarkdown: checked } })
                        }
                      }}
                    />
                  </div>
                )}

                <div className="speech-field">
                  <label htmlFor={`${prefix}-key`}>{t('key')}</label>
                  <PasswordInput
                    id={`${prefix}-key`}
                    aria-label={t('key')}
                    value={draft.key}
                    saved={config.apiKeyConfigured && sameServiceAsSaved}
                    clear={draft.clear}
                    hiddenClearedNotice={hiddenClearedNotice}
                    disabled={pending}
                    savedPlaceholder={t('keySaved')}
                    placeholder={!sameServiceAsSaved || !config.apiKeyConfigured ? t('keyEmpty') : undefined}
                    clearLabel={t('clearKey')}
                    onChange={key => {
                      setHiddenClearedNotice(false)
                      changeDraft({ key })
                    }}
                    onClearChange={clear => changeDraft({ clear })}
                  />
                  {config.apiKeyConfigured && !sameServiceAsSaved && !draft.key && (
                    <small className="speech-field-warning">{t('keyServiceChanged')}</small>
                  )}
                </div>

                <div className="speech-field">
                  <label htmlFor={`${prefix}-timeout`}>{t('timeout')}</label>
                  <DurationInput
                    id={`${prefix}-timeout`}
                    aria-label={t('timeout')}
                    valueMs={draft.timeoutMs}
                    disabled={pending}
                    presetsSeconds={[15, 30, 60, 120]}
                    onChangeMs={timeoutMs => changeDraft({ timeoutMs })}
                  />
                </div>
              </div>

              {configError && (
                <p role="alert" className="speech-error speech-inline-feedback">
                  <AlertCircle size={15} aria-hidden="true" />
                  {t(configError)}
                </p>
              )}

              {testResult && (
                <p
                  role={testResult.ok ? 'status' : 'alert'}
                  className={testResult.ok ? 'speech-success speech-inline-feedback' : 'speech-error speech-inline-feedback'}>
                  {testResult.ok ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertCircle size={15} aria-hidden="true" />}
                  {testResult.ok ? t('testSuccess', { ms: formatNumber(testResult.latencyMs) }) : t(testResult.key)}
                </p>
              )}

              <FormSaveBar
                alwaysVisible
                dirty={dirty}
                saving={pending}
                disabled={pending}
                disabledReason={t(pending ? 'working' : 'needSave')}
                conflict={configConflict}
                saveLabel={t(pending ? 'working' : 'save')}
                discardLabel={t('refresh')}
                reloadLabel={t('refresh')}
                notice={configNotice ? t(configNotice) : null}
                onSave={() => void runMutation(key => {
                  setConfigError(key)
                  if (key === 'conflict') setConfigConflict(true)
                }, save)}
                onDiscard={configConflict ? undefined : () => setConfirm('reload')}
                onReload={() => (dirty ? setConfirm('reload') : void load(true))}
                extraActions={
                  <>
                    {!dirty && !configConflict && (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={pending}
                        onClick={() => void load(true)}>
                        {t('refresh')}
                      </button>
                    )}
                    <ActionButton
                      className="button button-secondary"
                      disabled={!enabled || pending || testing || dirty || !config.apiKeyConfigured}
                      reason={t(
                        !enabled
                          ? 'testDisabled'
                          : dirty
                            ? 'testNeedSave'
                            : !config.apiKeyConfigured
                              ? 'testNeedKey'
                              : 'working',
                      )}
                      onClick={() => void handleTestConnection()}>
                      <Plug size={14} aria-hidden="true" />
                      {t(testing ? 'testingConnection' : 'testConnection')}
                    </ActionButton>
                  </>
                }
              />

              {confirm === 'reload' && (
                <div ref={confirmHostRef} className="speech-inline-confirm">
                  <InlineConfirm
                    variant="warning"
                    title={t('reloadConfirmTitle')}
                    description={t('reloadQuestion')}
                    confirmLabel={t('reload')}
                    cancelLabel={t('cancel')}
                    busy={pending}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                      setConfirm(null)
                      void load(true)
                    }}
                  />
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
