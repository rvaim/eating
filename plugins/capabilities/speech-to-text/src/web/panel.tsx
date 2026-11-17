import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, ChevronUp, Copy, FileAudio, LoaderCircle, Plug, RefreshCw, Upload, X } from 'lucide-react'
import { checkedInputAudio, MAX_INPUT_AUDIO_BYTES } from '@eating/plugin-sdk'
import {
  ActionButton,
  DurationInput,
  FormSaveBar,
  InlineConfirm,
  PasswordInput,
  SegmentedTabs,
  UnknownOutcomeCard,
  createRequestId,
  hostRequest,
  useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { RecognitionConfiguration, RecognitionJobSummary } from '../types'
import { errorKey, manageRecognition, readConfig, readPage, readTestConnection } from './data'
import './i18n'
import './panel.css'

type PanelTab = 'workbench' | 'configuration'
type StatusFilter = 'all' | 'active' | 'attention' | 'succeeded'

interface Draft {
  endpoint: string
  timeoutMs: string
  key: string
  clear: boolean
}

interface SelectedAudio {
  bytes: Uint8Array
  mimeType: 'audio/wav' | 'audio/ogg'
  durationMs: number
  name: string
  sizeBytes: number
  ticket: number
}

const draftOf = (v: RecognitionConfiguration): Draft => ({
  endpoint: v.endpoint,
  timeoutMs: String(v.timeoutMs),
  key: '',
  clear: false,
})

function isDraftDirty(draft: Draft | null, config: RecognitionConfiguration | null): boolean {
  if (!draft || !config) return false
  return (
    draft.endpoint !== config.endpoint ||
    draft.timeoutMs !== String(config.timeoutMs) ||
    draft.key.length > 0 ||
    draft.clear
  )
}

function validAsrEndpoint(value: string): boolean {
  try {
    const u = new URL(value)
    return (
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) &&
      !u.username && !u.password && !u.hash && !u.search && !value.includes('?') && !value.includes('#')
    )
  } catch {
    return false
  }
}

function matchesFilter(job: RecognitionJobSummary, filter: StatusFilter): boolean {
  if (filter === 'active') return job.status === 'queued' || job.status === 'running'
  if (filter === 'attention') return job.status === 'failed' || job.status === 'unknown'
  if (filter === 'succeeded') return job.status === 'succeeded'
  return true
}

export function RecognitionPanel({ enabled, onRefresh, onFeedback, onDirtyChange }: PluginPanelProps) {
  const { t, formatNumber, formatDateTime } = useI18n('speech-to-text')
  const prefix = useId()
  const [tab, setTab] = useState<PanelTab>('workbench')
  const [config, setConfig] = useState<RecognitionConfiguration | null>(null)
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
  const [upload, setUpload] = useState<SelectedAudio | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [uncertainMutation, setUncertainMutation] = useState<{ requestId: string | null } | null>(null)
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState<'generate' | 'reload' | string | null>(null)
  const [fullTranscript, setFullTranscript] = useState<{ jobId: string; text: string } | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [visible, setVisible] = useState(() => !document.hidden)

  const alive = useRef(false)
  const reads = useRef(new Set<AbortController>())
  const listRequest = useRef<AbortController | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const testController = useRef<AbortController | null>(null)
  const enabledRef = useRef(enabled)
  const offsetRef = useRef(offset)
  const configRef = useRef<RecognitionConfiguration | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const callbacks = useRef({ onRefresh, onFeedback, onDirtyChange })
  const fileInput = useRef<HTMLInputElement | null>(null)
  const confirmHostRef = useRef<HTMLDivElement | null>(null)
  const ticket = useRef(0)
  const identity = useRef<{ intent: string; id: string } | null>(null)

  enabledRef.current = enabled
  offsetRef.current = offset
  configRef.current = config
  draftRef.current = draft
  callbacks.current = { onRefresh, onFeedback, onDirtyChange }

  const dirty = isDraftDirty(draft, config)

  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  const clearUpload = useCallback(() => {
    ++ticket.current
    setUpload(null)
    setUploadError(null)
    if (fileInput.current) fileInput.current.value = ''
  }, [])

  const list = useCallback(async () => {
    if (!enabledRef.current || listRequest.current || document.hidden) return
    const controller = new AbortController()
    const at = offsetRef.current
    listRequest.current = controller
    reads.current.add(controller)
    try {
      const value = readPage(await manageRecognition('jobs', { offset: at, limit: 20 }, controller.signal))
      if (alive.current && enabledRef.current && !controller.signal.aborted && at === offsetRef.current) {
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
      const value = readConfig(await hostRequest('/plugins/speech-to-text/configuration', { signal: controller.signal }))
      if (!alive.current || controller.signal.aborted) return
      setConfig(value)
      if (force || !draftRef.current || !isDraftDirty(draftRef.current, configRef.current)) {
        setDraft(draftOf(value))
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
      const isPageHide = event.type === 'pagehide'
      const hidden = document.hidden || isPageHide
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
        setFullTranscript(null)
        setDraft(v => {
          if (!v) return null
          const hadKey = v.key.length > 0
          if (hadKey) setHiddenClearedNotice(true)
          return hadKey ? { ...v, key: '', clear: false } : v
        })
        if (isPageHide) clearUpload()
      }
    }
    document.addEventListener('visibilitychange', onHideOrLeave)
    window.addEventListener('pagehide', onHideOrLeave)
    void load(true)
    return () => {
      alive.current = false
      ++ticket.current
      reads.current.forEach(c => c.abort())
      reads.current.clear()
      listRequest.current?.abort()
      mutation.current?.abort()
      testController.current?.abort()
      if (fileInput.current) fileInput.current.value = ''
      document.removeEventListener('visibilitychange', onHideOrLeave)
      window.removeEventListener('pagehide', onHideOrLeave)
    }
  }, [load, clearUpload])

  useEffect(() => {
    if (!enabled || !visible) return
    void list()
    return () => {
      listRequest.current?.abort()
      listRequest.current = null
    }
  }, [enabled, visible, offset, list])

  const hasActiveJobs = page?.items.some(j => ['queued', 'running'].includes(j.status)) ?? false
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
      setUploadError(null)
      setTestResult(null)
      setFullTranscript(null)
      clearUpload()
    }
  }, [enabled, clearUpload])

  useEffect(() => {
    if (!confirm) return
    requestAnimationFrame(() => {
      confirmHostRef.current?.querySelector('button')?.focus()
    })
  }, [confirm])

  function changeDraft(values: Partial<Draft>) {
    setDraft(current => (current ? { ...current, ...values } : null))
    setConfigNotice(null)
    setConfigError(null)
    setTestResult(null)
  }

  async function runMutation(
    onError: (key: string) => void,
    run: (signal: AbortSignal) => Promise<void>,
  ) {
    if (mutation.current || document.hidden) return
    const controller = new AbortController()
    mutation.current = controller
    setPending(true)
    setConfigError(null)
    setConfigNotice(null)
    setUploadError(null)
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

  async function save(signal: AbortSignal) {
    if (!draft || !config) return
    const ms = Number(draft.timeoutMs)
    if (
      !validAsrEndpoint(draft.endpoint) ||
      !/^\d+$/.test(draft.timeoutMs) ||
      !Number.isSafeInteger(ms) ||
      ms < 10000 ||
      ms > 600000
    ) {
      setConfigError('invalid')
      return
    }
    const saved = readConfig(
      await hostRequest('/plugins/speech-to-text/configuration', {
        method: 'POST',
        signal,
        body: {
          expectedRevision: config.revision,
          endpoint: draft.endpoint,
          provider: { protocol: 'deepseek-asr' },
          timeoutMs: ms,
          apiKey: draft.key,
          clearApiKey: draft.clear,
        },
      }),
    )
    if (!alive.current || signal.aborted) return
    setConfig(saved)
    setDraft(draftOf(saved))
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
      const result = readTestConnection(await manageRecognition('test-connection', {}, controller.signal))
      if (alive.current && !controller.signal.aborted) setTestResult(result)
    } catch (e) {
      if (alive.current && !controller.signal.aborted) setTestResult({ ok: false, key: errorKey(e) })
    } finally {
      if (alive.current && testController.current === controller) {
        testController.current = null
        setTesting(false)
      }
    }
  }

  async function selectFile(file: File | undefined) {
    if (!file || document.hidden) return
    const at = ++ticket.current
    setUpload(null)
    setUploadError(null)
    try {
      if (file.size > MAX_INPUT_AUDIO_BYTES) throw new Error('Too large')
      const checked = checkedInputAudio(new Uint8Array(await file.arrayBuffer()))
      if (alive.current && at === ticket.current && !document.hidden) {
        setUpload({
          ...checked,
          name: file.name,
          sizeBytes: checked.bytes.byteLength,
          ticket: at,
        })
      }
    } catch {
      if (alive.current && at === ticket.current) {
        setUploadError('invalidAudio')
        if (fileInput.current) fileInput.current.value = ''
      }
    }
  }

  async function showTranscript(jobId: string) {
    const controller = new AbortController()
    reads.current.add(controller)
    setJobsError(null)
    try {
      const job = (await manageRecognition('job', { jobId }, controller.signal)) as { jobId: string; text: string | null }
      if (alive.current && !controller.signal.aborted && job.jobId === jobId && typeof job.text === 'string' && job.text.length <= 32000) {
        setFullTranscript({ jobId, text: job.text })
      }
    } catch (e) {
      if (alive.current && !controller.signal.aborted) setJobsError(errorKey(e))
    } finally {
      reads.current.delete(controller)
    }
  }

  async function generate(signal: AbortSignal) {
    if (!upload) {
      setUploadError('noFile')
      return
    }
    const intent = JSON.stringify([upload.ticket, config?.revision])
    if (identity.current?.intent !== intent) identity.current = { intent, id: createRequestId() }
    const reqId = identity.current.id
    let binary = ''
    for (let at = 0; at < upload.bytes.length; at += 32768) {
      binary += String.fromCharCode(...upload.bytes.subarray(at, at + 32768))
    }
    try {
      await manageRecognition('transcribe', { data: btoa(binary), request_id: reqId, confirmed: true }, signal)
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
        setUploadError(errorKey(e))
      }
    }
  }

  async function copyText(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(id)
      window.setTimeout(() => {
        if (alive.current) setCopiedId(current => (current === id ? null : current))
      }, 1800)
    } catch {
      /* Clipboard unavailable; displayed text remains selectable. */
    }
  }

  const formatSize = useCallback(
    (bytes: number) =>
      bytes >= 1024 * 1024
        ? t('mib', { value: formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 2 }) })
        : t('kib', { value: formatNumber(Math.max(1, Math.round(bytes / 1024))) }),
    [t, formatNumber],
  )

  const sameServiceAsSaved = Boolean(config && draft && draft.endpoint === config.endpoint)

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
      className="recognition-panel"
      onKeyDown={e => {
        if (e.key === 'Escape' && confirm) {
          e.stopPropagation()
          setConfirm(null)
        }
      }}>
      <p className="recognition-description">{t('description')}</p>

      <SegmentedTabs
        idPrefix={prefix}
        sticky
        className="recognition-tabs"
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

      {!config || !draft ? (
        <div className="recognition-loading">
          {configError && <p role="alert" className="recognition-error">{t(configError)}</p>}
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
            className="recognition-tab-panel">
            {(!enabled || !config.ready) && (
              <div className="recognition-setup-cta" role="status">
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

            <section className="recognition-card" aria-labelledby={`${prefix}-upload`}>
              <div className="recognition-card-head">
                <div>
                  <h3 id={`${prefix}-upload`}>{t('preview')}</h3>
                  <p className="recognition-description">{t('previewHelp')}</p>
                </div>
                <div className="recognition-summary-pill">
                  <FileAudio size={14} aria-hidden="true" />
                  <span>{t('savedSummary')}</span>
                </div>
              </div>

              <label
                htmlFor={`${prefix}-file`}
                className={`recognition-dropzone${dragOver ? ' is-dragging' : ''}${upload ? ' has-file' : ''}`}
                onDragOver={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!pending) setDragOver(true)
                }}
                onDragLeave={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOver(false)
                }}
                onDrop={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOver(false)
                  if (!pending) void selectFile(e.dataTransfer.files?.[0])
                }}>
                <input
                  id={`${prefix}-file`}
                  ref={fileInput}
                  className="recognition-file-input"
                  aria-label={t('file')}
                  type="file"
                  accept=".wav,.ogg,.opus,audio/wav,audio/ogg"
                  disabled={pending}
                  onChange={e => void selectFile(e.target.files?.[0])}
                />
                <Upload size={22} className="recognition-dropzone-icon" aria-hidden="true" />
                <strong>{t('dropZoneTitle')}</strong>
                <span className="recognition-dropzone-meta">{t('fileHelp')}</span>
                <small>{t('dropZoneHint')}</small>
              </label>

              {upload && (
                <div className="recognition-selected-bar" role="status">
                  <div className="recognition-selected-info">
                    <FileAudio size={16} aria-hidden="true" />
                    <strong className="recognition-selected-name">{upload.name}</strong>
                    <span className="recognition-badge">
                      {upload.mimeType === 'audio/wav' ? t('audioFormatWav') : t('audioFormatOgg')}
                    </span>
                    <span className="recognition-badge">{formatSize(upload.sizeBytes)}</span>
                    <span className="recognition-badge">
                      {t('seconds', { value: formatNumber(upload.durationMs / 1000, { maximumFractionDigits: 1 }) })}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={pending}
                    onClick={() => clearUpload()}>
                    <X size={14} aria-hidden="true" />
                    {t('clearFile')}
                  </button>
                </div>
              )}

              {uploadError && (
                <p role="alert" className="recognition-error recognition-inline-feedback">
                  <AlertCircle size={15} aria-hidden="true" />
                  {t(uploadError)}
                </p>
              )}

              <div className="recognition-actions">
                <ActionButton
                  reason={t(
                    pending
                      ? 'working'
                      : !enabled
                        ? 'disabled'
                        : dirty
                          ? 'needSave'
                          : !config.ready
                            ? 'notReady'
                            : 'noFile',
                  )}
                  className="button button-primary"
                  disabled={!enabled || pending || dirty || !config.ready || !upload}
                  onClick={() => setConfirm('generate')}>
                  {t(pending && confirm === 'generate' ? 'working' : 'generate')}
                </ActionButton>
              </div>

              {confirm === 'generate' && (
                <div ref={confirmHostRef} className="recognition-inline-confirm">
                  <InlineConfirm
                    variant="warning"
                    title={t('generateConfirmTitle')}
                    description={t('charge')}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    busy={pending}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => void runMutation(key => setUploadError(key), generate)}
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
              />
            )}

            <section className="recognition-card" aria-labelledby={`${prefix}-jobs`}>
              <div className="recognition-jobs-head">
                <div>
                  <h3 id={`${prefix}-jobs`}>{t('jobs')}</h3>
                  {hasActiveJobs && (
                    <span className="recognition-live-pill" role="status">
                      <LoaderCircle size={12} className="recognition-spin" aria-hidden="true" />
                      {t('livePolling')}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-button"
                  disabled={!enabled || pending}
                  onClick={() => void list()}>
                  <RefreshCw size={14} aria-hidden="true" />
                  {t('refreshJobs')}
                </button>
              </div>

              {jobsError && (
                <p role="alert" className="recognition-error recognition-inline-feedback">
                  <AlertCircle size={15} aria-hidden="true" />
                  {t(jobsError)}
                </p>
              )}

              {!enabled ? (
                <p className="recognition-description">{t('disabled')}</p>
              ) : !page?.items.length ? (
                <p className="recognition-description">{t('empty')}</p>
              ) : (
                <>
                  <div className="recognition-filters" role="group" aria-label={t('jobs')}>
                    {(['all', 'active', 'attention', 'succeeded'] as const).map(key => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={filter === key}
                        className={`recognition-filter-pill${filter === key ? ' is-selected' : ''}`}
                        onClick={() => setFilter(key)}>
                        {t(`filter.${key}`, { count: counts[key] })}
                      </button>
                    ))}
                  </div>

                  {!filteredItems.length ? (
                    <p className="recognition-description">{t('filterEmpty')}</p>
                  ) : (
                    <ul className="recognition-jobs">
                      {filteredItems.map(j => {
                        const expanded = fullTranscript?.jobId === j.jobId
                        const displayedText = expanded ? fullTranscript.text : j.textPreview
                        const isUnknown = j.status === 'unknown'
                        const confirmingDelete = confirm === j.jobId
                        const copyTargetId = `text:${j.jobId}`
                        return (
                          <li className={`recognition-job is-${j.status}`} key={j.jobId}>
                            <header className="recognition-job-header">
                              <strong className={`recognition-job-status is-${j.status}`}>
                                {t('status.' + j.status)}
                              </strong>
                              <span className="recognition-badge">
                                {j.source.kind === 'upload' ? t('source.upload') : t('source.received')}
                              </span>
                              <span className="recognition-badge">
                                {j.mimeType === 'audio/wav' ? 'WAV' : 'Ogg'}
                              </span>
                              <small>{formatSize(j.byteLength)}</small>
                              <small>
                                {t('seconds', {
                                  value: formatNumber((j.durationMs ?? j.inputDurationMs) / 1000, { maximumFractionDigits: 1 }),
                                })}
                              </small>
                              <time dateTime={j.createdAt}>{formatDateTime(j.createdAt)}</time>
                            </header>

                            {displayedText !== null && (
                              <p className="recognition-result">{displayedText || t('silence')}</p>
                            )}

                            {j.errorCode && (
                              <p role="alert" className="recognition-error">
                                {t(errorKey(j.errorCode))}
                              </p>
                            )}

                            {isUnknown && (
                              <div className="recognition-job-unknown-note">
                                <p>{t('unknown')}</p>
                                <div className="recognition-job-id-row">
                                  <span>{t('requestIdLabel')}:</span>
                                  <code>{j.requestId}</code>
                                  <button
                                    type="button"
                                    className="button button-secondary recognition-mini-btn"
                                    onClick={() => void copyText(`req:${j.requestId}`, j.requestId)}>
                                    {copiedId === `req:${j.requestId}` ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                                    {copiedId === `req:${j.requestId}` ? t('copied') : t('copyId')}
                                  </button>
                                </div>
                              </div>
                            )}

                            <div className="recognition-actions recognition-job-actions">
                              {j.textTruncated && !expanded && (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  onClick={() => void showTranscript(j.jobId)}>
                                  {t('fullTranscript')}
                                </button>
                              )}
                              {j.textTruncated && expanded && (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  onClick={() => setFullTranscript(null)}>
                                  <ChevronUp size={15} aria-hidden="true" />
                                  {t('collapseTranscript')}
                                </button>
                              )}
                              {displayedText && (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  onClick={() => void copyText(copyTargetId, displayedText)}>
                                  {copiedId === copyTargetId ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                                  {copiedId === copyTargetId ? t('copiedTranscript') : t('copyTranscript')}
                                </button>
                              )}
                              {!['queued', 'running'].includes(j.status) && (
                                <button
                                  type="button"
                                  className="text-button recognition-delete-btn"
                                  disabled={pending}
                                  onClick={() => setConfirm(confirmingDelete ? null : j.jobId)}>
                                  {t('delete')}
                                </button>
                              )}
                            </div>

                            {confirmingDelete && (
                              <div ref={confirmHostRef} className="recognition-inline-confirm">
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
                                        await manageRecognition('delete', { jobId: j.jobId, confirmed: true }, signal)
                                        setFullTranscript(current => (current?.jobId === j.jobId ? null : current))
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

                  <div className="recognition-actions recognition-pagination">
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
                      <small>
                        {t('page', {
                          count: page.total,
                          formatted: formatNumber(page.total),
                          offset: formatNumber(offset + 1),
                        })}
                      </small>
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
            className="recognition-tab-panel">
            <section className="recognition-card" aria-labelledby={`${prefix}-settings`}>
              <div className="recognition-card-head">
                <div>
                  <h3 id={`${prefix}-settings`}>{t('configuration')}</h3>
                  <p className="recognition-description">{t('configurationHelp')}</p>
                </div>
              </div>

              <div className="recognition-fields">
                <label className="recognition-field recognition-field-wide">
                  <span>{t('protocol')}</span>
                  <select aria-label={t('protocol')} value="deepseek-asr" disabled={pending} onChange={() => {}}>
                    <option value="deepseek-asr">DeepSeek ASR</option>
                  </select>
                  <small>{t('protocolHelp')}</small>
                </label>

                <label className="recognition-field recognition-field-wide">
                  <span>{t('endpoint')}</span>
                  <input
                    aria-label={t('endpoint')}
                    value={draft.endpoint}
                    disabled={pending}
                    onChange={e => changeDraft({ endpoint: e.target.value })}
                  />
                  <small>{t('endpointHelp')}</small>
                </label>

                <div className="recognition-field">
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
                    <small className="recognition-field-warning">{t('keyServiceChanged')}</small>
                  )}
                </div>

                <div className="recognition-field">
                  <label htmlFor={`${prefix}-timeout`}>{t('timeout')}</label>
                  <DurationInput
                    id={`${prefix}-timeout`}
                    aria-label={t('timeout')}
                    valueMs={draft.timeoutMs}
                    disabled={pending}
                    presetsSeconds={[30, 60, 120, 300]}
                    onChangeMs={timeoutMs => changeDraft({ timeoutMs })}
                  />
                </div>
              </div>

              {configError && (
                <p role="alert" className="recognition-error recognition-inline-feedback">
                  <AlertCircle size={15} aria-hidden="true" />
                  {t(configError)}
                </p>
              )}

              {testResult && (
                <p
                  role={testResult.ok ? 'status' : 'alert'}
                  className={testResult.ok ? 'recognition-success recognition-inline-feedback' : 'recognition-error recognition-inline-feedback'}>
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
                <div ref={confirmHostRef} className="recognition-inline-confirm">
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
