import { readImageLimits } from '@eating/plugin-sdk'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertCircle, Check, ChevronLeft, ChevronRight, ImageOff, ImagePlus, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { JsonObject } from '@eating/plugin-sdk'
import { ActionButton, createRequestId, formatNumber, hostRequest, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type {
  GeneratedImageItem, ImageGenerationConfiguration, ImageGenerationJob, ImageGenerationPage,
  ImageGenerationPreview, ImageGenerationResponseFormat,
} from '../types'
import { IMAGE_GENERATION_LIMITS } from '../types'
import {
  errorTextFrom, fetchConfiguration, imageBlob, jobErrorText, localImage, manage, readAssetPage, readJob, readJobPage, readPreview, updateConfiguration,
} from './data'
import type { ImageGenerationUpload } from './data'
import { it } from './i18n'
import './panel.css'

interface ConfigDraft {
  readonly baseUrl: string
  readonly apiKey: string
  readonly clearApiKey: boolean
  readonly model: string
  readonly timeoutMs: string
  readonly size: string
  readonly quality: string
  readonly responseFormat: ImageGenerationResponseFormat
}
interface RequestIdentity { readonly key: string; readonly id: string }
interface SourceDraft { readonly image: ImageGenerationUpload; readonly name: string; readonly bytes: number; readonly key: string }

const pageLimit = 20
const formats: readonly ImageGenerationResponseFormat[] = ['', 'b64_json', 'url']
function makeDraft(config: ImageGenerationConfiguration): ConfigDraft {
  return { baseUrl: config.baseUrl, apiKey: '', clearApiKey: false, model: config.model,
    timeoutMs: String(config.timeoutMs), size: config.size, quality: config.quality, responseFormat: config.responseFormat }
}
function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KiB`
  return `${formatNumber(bytes / 1024 / 1024, { maximumFractionDigits: 1 })} MiB`
}
function isBusyStatus(status: ImageGenerationJob['status']): boolean { return status === 'queued' || status === 'running' }
function validUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function ImageGenerationPanel({ onFeedback, onRefresh }: PluginPanelProps) {
  const { t, formatNumber, formatDateTime } = useI18n('image-generation')
  const prefix = useId()
  const [config, setConfig] = useState<ImageGenerationConfiguration | null>(null)
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [configDirty, setConfigDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [configLoading, setConfigLoading] = useState(true)
  const [configSaving, setConfigSaving] = useState(false)
  const [configFailure, setConfigFailure] = useState<string | null>(null)
  const [configMessage, setConfigMessage] = useState<string | null>(null)
  const [confirmReload, setConfirmReload] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})
  const [jobsPage, setJobsPage] = useState<ImageGenerationPage<ImageGenerationJob> | null>(null)
  const [assetsPage, setAssetsPage] = useState<ImageGenerationPage<GeneratedImageItem> | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listFailure, setListFailure] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState<SourceDraft | null>(null)
  const [sourceFailure, setSourceFailure] = useState<string | null>(null)
  const [overrideSize, setOverrideSize] = useState('')
  const [useServiceSize, setUseServiceSize] = useState(false)
  const [overrideQuality, setOverrideQuality] = useState('')
  const [overrideFormat, setOverrideFormat] = useState<ImageGenerationResponseFormat>('')
  const [confirming, setConfirming] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateFailure, setGenerateFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<ImageGenerationPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewFailure, setPreviewFailure] = useState<string | null>(null)
  const [visible, setVisible] = useState(() => !document.hidden)
  const mounted = useRef(false)
  const configController = useRef<AbortController | null>(null)
  const jobsController = useRef<AbortController | null>(null)
  const assetsController = useRef<AbortController | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const generateController = useRef<AbortController | null>(null)
  const configGeneration = useRef(0)
  const jobsGeneration = useRef(0)
  const assetsGeneration = useRef(0)
  const previewUrl = useRef<string | null>(null)
  const previewDialog = useRef<HTMLDialogElement | null>(null)
  const sourcePreviewUrl = useRef<string | null>(null)
  const sourceReadController = useRef<AbortController | null>(null)
  const sourceInput = useRef<HTMLInputElement | null>(null)
  const assetsOffsetRef = useRef(0)
  const activeJobs = useRef<ReadonlySet<string>>(new Set())
  const requestIdentity = useRef<RequestIdentity | null>(null)
  const feedback = useRef(onFeedback)
  feedback.current = onFeedback

  const cancelAll = useCallback(() => {
    sourceReadController.current?.abort(); sourceReadController.current = null
    configController.current?.abort(); configController.current = null
    jobsController.current?.abort(); jobsController.current = null
    assetsController.current?.abort(); assetsController.current = null
    previewController.current?.abort(); previewController.current = null
    generateController.current?.abort(); generateController.current = null
  }, [])
  const clearPreview = useCallback(() => {
    previewController.current?.abort(); previewController.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = null
    if (mounted.current) { setPreviewOpen(false); setSelected(null); setPreviewLoading(false); setPreviewFailure(null) }
  }, [])
  useEffect(() => {
    const dialog = previewDialog.current
    if (previewOpen) dialog?.showModal()
    else if (dialog?.open) dialog.close()
  }, [previewOpen])
  const clearSource = useCallback(() => {
    if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
    sourcePreviewUrl.current = null
    setSource(null); setSourceFailure(null)
    if (sourceInput.current) sourceInput.current.value = ''
  }, [])
  const replacePreview = useCallback((preview: ImageGenerationPreview) => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = URL.createObjectURL(imageBlob(preview.image))
    setSelected(preview)
  }, [])

  const loadConfig = useCallback(async (quiet = false, force = false) => {
    if (!mounted.current || document.hidden) return
    const ticket = ++configGeneration.current
    configController.current?.abort()
    const controller = new AbortController(); configController.current = controller
    if (!quiet) setConfigLoading(true)
    try {
      const value = await fetchConfiguration(controller.signal)
      if (!mounted.current || controller.signal.aborted || ticket !== configGeneration.current) return
      // Never advance the CAS revision under an unsaved draft; an explicit discard is required.
      if (dirtyRef.current && !force) return
      setConfig(value)
      setDraft(makeDraft(value))
      setConfigFailure(null)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === configGeneration.current) setConfigFailure(errorTextFrom(error, it('config.loadFailed')))
    } finally {
      if (mounted.current && ticket === configGeneration.current) { setConfigLoading(false); if (configController.current === controller) configController.current = null }
    }
  }, [])

  const loadJobs = useCallback(async (offset = 0, quiet = false) => {
    if (!mounted.current || document.hidden) return
    const ticket = ++jobsGeneration.current
    jobsController.current?.abort()
    const controller = new AbortController(); jobsController.current = controller
    if (!quiet) setListLoading(true)
    try {
      const page = readJobPage(await manage('jobs', { offset, limit: pageLimit }, controller.signal))
      if (!mounted.current || controller.signal.aborted || ticket !== jobsGeneration.current) return
      const wasActive = activeJobs.current
      const nowActive = new Set(page.items.filter(job => isBusyStatus(job.status)).map(job => job.jobId))
      const settled = page.items.some(job => job.status === 'succeeded' && wasActive.has(job.jobId))
      activeJobs.current = nowActive
      setJobsPage(page); setListFailure(null)
      if (settled || !quiet) void loadAssets(assetsOffsetRef.current, true)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === jobsGeneration.current) setListFailure(errorTextFrom(error, it('common.loadFailed')))
    } finally {
      if (mounted.current && ticket === jobsGeneration.current) { setListLoading(false); if (jobsController.current === controller) jobsController.current = null }
    }
  }, [])

  const loadAssets = useCallback(async (offset = 0, quiet = false) => {
    if (!mounted.current || document.hidden) return
    const ticket = ++assetsGeneration.current
    assetsController.current?.abort()
    const controller = new AbortController(); assetsController.current = controller
    if (!quiet) setListLoading(true)
    try {
      const page = readAssetPage(await manage('list', { offset, limit: pageLimit }, controller.signal))
      if (!mounted.current || controller.signal.aborted || ticket !== assetsGeneration.current) return
      assetsOffsetRef.current = page.offset
      setAssetsPage(page); setListFailure(null)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === assetsGeneration.current) setListFailure(errorTextFrom(error, it('common.loadFailed')))
    } finally {
      if (mounted.current && ticket === assetsGeneration.current) { setListLoading(false); if (assetsController.current === controller) assetsController.current = null }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void loadConfig(); void loadJobs(0); void loadAssets(0)
    const visibility = () => {
      const next = !document.hidden
      setVisible(next)
      if (next) { void loadConfig(true); void loadJobs(0, true); void loadAssets(0, true); return }
      cancelAll()
      setDraft(current => current ? { ...current, apiKey: '' } : current)
      setConfigSaving(false); setGenerating(false); setPreviewLoading(false)
      clearPreview(); clearSource()
    }
    const pagehide = () => {
      cancelAll()
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = null
      if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
      sourcePreviewUrl.current = null
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pagehide)
    return () => {
      mounted.current = false
      ++configGeneration.current; ++jobsGeneration.current; ++assetsGeneration.current
      cancelAll()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', pagehide)
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = null
      if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
      sourcePreviewUrl.current = null
    }
    // Network effects intentionally do not depend on locale or draft changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasActiveJob = Boolean(jobsPage?.items.some(job => isBusyStatus(job.status))) || generating
  useEffect(() => {
    if (!visible || !hasActiveJob) return
    const timer = window.setInterval(() => { if (!document.hidden) void loadJobs(jobsPage?.offset ?? 0, true) }, 2500)
    return () => window.clearInterval(timer)
  }, [visible, hasActiveJob, jobsPage?.offset, loadJobs])

  function updateDraft<K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) {
    setDraft(current => current ? { ...current, [key]: value, ...(key === 'clearApiKey' && value === true ? { apiKey: '' } : {}) } : current)
    dirtyRef.current = true; setConfigDirty(true); setConfigMessage(null)
    setFieldErrors(current => { const next = { ...current }; delete next[key]; return next })
  }

  function requestReload() {
    if (dirtyRef.current) { setConfirmReload(true); return }
    void loadConfig()
  }
  function discardAndReload() {
    dirtyRef.current = false; setConfigDirty(false); setConfirmReload(false)
    void loadConfig(false, true)
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!config || !draft || configSaving || !configDirty || hasActiveJob) return
    const errors: Record<string, string> = {}
    if (!validUrl(draft.baseUrl.trim())) errors.baseUrl = it('config.validation.baseUrl')
    if (!draft.model.trim()) errors.model = it('config.validation.model')
    const timeoutMs = Number(draft.timeoutMs)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < IMAGE_GENERATION_LIMITS.minimumTimeoutMs || timeoutMs > IMAGE_GENERATION_LIMITS.maximumTimeoutMs) {
      errors.timeoutMs = it('config.validation.timeout', { min: formatNumber(IMAGE_GENERATION_LIMITS.minimumTimeoutMs), max: formatNumber(IMAGE_GENERATION_LIMITS.maximumTimeoutMs) })
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setConfigSaving(true); setConfigFailure(null)
    const controller = new AbortController(); configController.current = controller
    try {
      const patch: JsonObject = { expectedRevision: config.revision, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
        timeoutMs, size: draft.size.trim(), quality: draft.quality.trim(), responseFormat: draft.responseFormat,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(draft.clearApiKey ? { clearApiKey: true } : {}) }
      const updated = await updateConfiguration(patch, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setConfig(updated); setDraft(makeDraft(updated)); dirtyRef.current = false; setConfigDirty(false); setConfigMessage(it('config.saved')); feedback.current(it('config.saved'))
      void onRefresh?.().catch(() => {})
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setConfigFailure(errorTextFrom(error, it('common.loadFailed')))
    } finally {
      if (configController.current === controller) configController.current = null
      if (mounted.current) setConfigSaving(false)
    }
  }

  async function openAsset(assetId: string) {
    if (!mounted.current || document.hidden) return
    clearPreview()
    const controller = new AbortController(); previewController.current = controller
    setPreviewOpen(true); setPreviewLoading(true)
    try {
      const preview = readPreview(await manage('get', { assetId }, controller.signal))
      if (!mounted.current || controller.signal.aborted || document.hidden) return
      replacePreview(preview)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setPreviewFailure(errorTextFrom(error, it('resources.previewFailed')))
    } finally {
      if (previewController.current === controller) {
        previewController.current = null
        if (mounted.current) setPreviewLoading(false)
      }
    }
  }

  async function chooseSource(file: File | undefined) {
    if (!file) return
    sourceReadController.current?.abort()
    const controller = new AbortController(); sourceReadController.current = controller
    try {
      const limits = readImageLimits(await hostRequest<unknown>('/image-limits', { signal: controller.signal }))
      const image = await localImage(file, limits.imageBytes)
      if (!mounted.current || controller.signal.aborted || document.hidden) return
      if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
      sourcePreviewUrl.current = URL.createObjectURL(file)
      setSource({ image, name: file.name, bytes: file.size, key: `${file.name}:${file.size}:${file.lastModified}` })
      setSourceFailure(null)
      resetRequestIdentity()
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setSourceFailure(errorTextFrom(error, it('generate.sourceInvalid')))
    } finally { if (sourceReadController.current === controller) sourceReadController.current = null }
  }

  function resetRequestIdentity() { requestIdentity.current = null; setConfirming(false); setGenerateFailure(null) }

  async function submitGeneration() {
    if (!config?.ready || configDirty || hasActive || generating || !prompt.trim()) return
    if ([...prompt.trim()].length > IMAGE_GENERATION_LIMITS.prompt) { setGenerateFailure(it('generate.promptTooLong', { max: formatNumber(IMAGE_GENERATION_LIMITS.prompt) })); return }
    const key = JSON.stringify([prompt.trim(), useServiceSize ? '' : overrideSize.trim() || null, overrideQuality.trim(), overrideFormat, source?.key ?? null])
    if (requestIdentity.current?.key !== key) requestIdentity.current = { key, id: createRequestId() }
    const identity = requestIdentity.current
    setGenerating(true); setGenerateFailure(null)
    const controller = new AbortController(); generateController.current = controller
    try {
      const job = readJob(await manage('generate', { prompt: prompt.trim(), request_id: identity.id, confirmed: true,
        ...(source ? { source: { kind: 'upload', data: source.image.data, mimeType: source.image.mimeType } } : {}),
        ...(useServiceSize ? { size: '' } : overrideSize.trim() ? { size: overrideSize.trim() } : {}), ...(overrideQuality.trim() ? { quality: overrideQuality.trim() } : {}),
        ...(overrideFormat ? { response_format: overrideFormat } : {}) }, controller.signal))
      if (!mounted.current || controller.signal.aborted) return
      requestIdentity.current = null; setConfirming(false); setPrompt(''); clearSource(); setGenerateFailure(null)
      setJobsPage(current => current ? { ...current, items: [job, ...current.items].slice(0, pageLimit), total: current.total + 1 } : { items: [job], offset: 0, limit: pageLimit, total: 1, hasMore: false, nextOffset: null })
      feedback.current(it('generate.submitted'))
      void loadJobs(0, true)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setGenerateFailure(errorTextFrom(error, it('generate.failed')))
    } finally {
      if (generateController.current === controller) generateController.current = null
      if (mounted.current) setGenerating(false)
    }
  }

  const hasActive = Boolean(jobsPage?.items.some(job => isBusyStatus(job.status))) || generating
  const canGenerate = Boolean(config?.ready && !configDirty && !hasActive && prompt.trim())
  const jobs = jobsPage?.items ?? []
  const assets = assetsPage?.items ?? []
  const prerequisite = !config || config.ready ? null : !config.baseUrl.trim() && !config.model.trim() ? 'prerequisite.baseUrlModel' : !validUrl(config.baseUrl) ? 'prerequisite.baseUrl' : !config.model.trim() ? 'prerequisite.model' : 'prerequisite.inactive'

  return <section className="image-generation-panel" aria-label={t('plugin.name')}>
    <section className="image-block" aria-labelledby={`${prefix}-config-title`}>
      <div className="image-block-heading"><div><h3 id={`${prefix}-config-title`}>{t('config.title')}</h3><p>{t('config.description')}</p></div>{config && <span className={`status-badge image-ready-${config.ready ? 'yes' : 'no'}`}>{t(config.ready ? 'config.ready' : 'config.notReady')}</span>}</div>
      {configLoading && !config && <p className="image-loading" role="status"><LoaderCircle size={15} aria-hidden="true" />{t('config.loading')}</p>}
      {configFailure && <div className="image-notice" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{configFailure}</span><ActionButton reasonCode="busy" type="button" className="text-button" onClick={requestReload}>{t('config.retry')}</ActionButton></div>}
      {prerequisite && <div className="image-notice" role="status"><AlertCircle size={16} aria-hidden="true" /><span>{t(prerequisite)}</span></div>}
      <p className="image-config-note">{t('config.localCheck')}</p>
      {config && draft && <form className="image-form" noValidate onSubmit={event => void saveConfig(event)}>
        <div className={`image-field${fieldErrors.baseUrl ? ' is-invalid' : ''}`}><label htmlFor={`${prefix}-base-url`}>{t('config.baseUrl')}</label><div><input id={`${prefix}-base-url`} value={draft.baseUrl} maxLength={4096} autoComplete="off" spellCheck={false} onChange={event => updateDraft('baseUrl', event.target.value)} /><p className="image-hint">{t('config.baseUrlHint')}</p>{fieldErrors.baseUrl && <p className="image-error">{fieldErrors.baseUrl}</p>}</div></div>
        <div className="image-field"><label htmlFor={`${prefix}-api-key`}>{t('config.apiKey')}</label><div><input id={`${prefix}-api-key`} type="password" value={draft.apiKey} maxLength={4096} autoComplete="new-password" placeholder={config.apiKeyConfigured ? t('config.apiKeySaved') : t('config.apiKeyEmpty')} aria-describedby={`${prefix}-api-key-hint`} onChange={event => updateDraft('apiKey', event.target.value)} /><p className="image-hint" id={`${prefix}-api-key-hint`}>{t('config.apiKeyHint')}</p><label className="image-check"><input type="checkbox" checked={draft.clearApiKey} onChange={event => updateDraft('clearApiKey', event.target.checked)} /><span>{t('config.clearApiKey')}</span></label></div></div>
        <div className={`image-field${fieldErrors.model ? ' is-invalid' : ''}`}><label htmlFor={`${prefix}-model`}>{t('config.model')}</label><div><input id={`${prefix}-model`} value={draft.model} maxLength={200} autoComplete="off" spellCheck={false} placeholder={t('config.modelPlaceholder')} onChange={event => updateDraft('model', event.target.value)} /><p className="image-hint">{t('config.modelHint')}</p>{fieldErrors.model && <p className="image-error">{fieldErrors.model}</p>}</div></div>
        <div className={`image-field${fieldErrors.timeoutMs ? ' is-invalid' : ''}`}><label htmlFor={`${prefix}-timeout`}>{t('config.timeout')}</label><div><input id={`${prefix}-timeout`} type="number" min={IMAGE_GENERATION_LIMITS.minimumTimeoutMs} max={IMAGE_GENERATION_LIMITS.maximumTimeoutMs} step={1} inputMode="numeric" value={draft.timeoutMs} onChange={event => updateDraft('timeoutMs', event.target.value)} /><p className="image-hint">{t('config.timeoutHint', { min: formatNumber(IMAGE_GENERATION_LIMITS.minimumTimeoutMs), max: formatNumber(IMAGE_GENERATION_LIMITS.maximumTimeoutMs) })}</p>{fieldErrors.timeoutMs && <p className="image-error">{fieldErrors.timeoutMs}</p>}</div></div>
        <div className="image-field"><label htmlFor={`${prefix}-size`}>{t('config.size')}</label><div><input id={`${prefix}-size`} value={draft.size} maxLength={64} autoComplete="off" spellCheck={false} placeholder={t('config.sizePlaceholder')} aria-describedby={`${prefix}-size-hint ${prefix}-size-support`} onChange={event => updateDraft('size', event.target.value)} /><p className="image-hint" id={`${prefix}-size-hint`}>{t('config.sizeHint')}</p><p className="image-hint" id={`${prefix}-size-support`}>{t('config.sizeSupport')}</p></div></div>
        <div className="image-field"><label htmlFor={`${prefix}-quality`}>{t('config.quality')}</label><div><input id={`${prefix}-quality`} value={draft.quality} maxLength={200} autoComplete="off" spellCheck={false} placeholder={t('config.qualityPlaceholder')} onChange={event => updateDraft('quality', event.target.value)} /><p className="image-hint">{t('config.qualityHint')}</p></div></div>
        <div className="image-field"><label htmlFor={`${prefix}-format`}>{t('config.responseFormat')}</label><div><select id={`${prefix}-format`} value={draft.responseFormat} onChange={event => updateDraft('responseFormat', event.target.value as ImageGenerationResponseFormat)}>{formats.map(value => <option key={value || 'empty'} value={value}>{value ? (value === 'b64_json' ? t('config.format.b64') : value) : t('config.format.empty')}</option>)}</select><p className="image-hint">{t('config.responseFormatHint')}</p></div></div>
        <p className="image-config-note">{t('config.readyHint')}</p>
        {hasActive && <p className="image-hint">{t('config.activeLocked')}</p>}
        {confirmReload && <div className="image-confirm" role="alertdialog" aria-label={t('config.discardTitle')}><strong>{t('config.discardTitle')}</strong><p>{t('config.discardText')}</p><div className="image-form-actions"><ActionButton reasonCode="busy" type="button" className="button button-secondary" onClick={() => setConfirmReload(false)}>{t('config.discardCancel')}</ActionButton><ActionButton reasonCode="busy" type="button" className="button button-danger" onClick={discardAndReload}>{t('config.discardConfirm')}</ActionButton></div></div>}
        {configMessage && <p className="image-success" role="status"><Check size={14} aria-hidden="true" />{configMessage}</p>}
        <div className="image-form-actions"><ActionButton reasonCode={configSaving ? 'busy' : hasActive ? 'active' : 'unchanged'} type="submit" className="button button-primary" disabled={configSaving || !configDirty || hasActive}>{configSaving ? t('config.saving') : t('config.save')}</ActionButton><ActionButton reasonCode="busy" type="button" className="button button-secondary" disabled={configSaving} onClick={requestReload}><RefreshCw size={14} aria-hidden="true" />{t('config.retry')}</ActionButton></div>
      </form>}
    </section>

    <section className="image-block" aria-labelledby={`${prefix}-generate-title`}>
      <div className="image-block-heading"><div><h3 id={`${prefix}-generate-title`}>{t('generate.title')}</h3><p>{t('generate.description')}</p></div></div>
      {config && !config.ready && <p className="image-hint">{t(prerequisite ?? 'generate.needConfig')}</p>}
      {configDirty && <p className="image-hint">{t('generate.dirtyConfig')}</p>}
      <div className="image-field"><label htmlFor={`${prefix}-source`}>{t('generate.source')}</label><div>
        <input ref={sourceInput} id={`${prefix}-source`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => void chooseSource(event.target.files?.[0])} />
        <p className="image-hint">{t('generate.sourceHint')}</p>
        {sourceFailure && <p className="image-error" role="alert">{sourceFailure}</p>}
        {source && sourcePreviewUrl.current && <div className="image-source-preview"><img src={sourcePreviewUrl.current} alt={t('generate.sourcePreviewAlt')} /><div className="image-source-copy"><strong dir="auto">{source.name}</strong><small>{bytesLabel(source.bytes)}</small><ActionButton reasonCode="busy" type="button" className="text-button" onClick={() => { clearSource(); resetRequestIdentity() }}>{t('generate.clearSource')}</ActionButton></div></div>}
      </div></div>
      <div className="image-field"><label htmlFor={`${prefix}-prompt`}>{t('generate.prompt')}</label><div><textarea id={`${prefix}-prompt`} rows={5} maxLength={IMAGE_GENERATION_LIMITS.prompt} value={prompt} placeholder={t('generate.promptPlaceholder')} onChange={event => { setPrompt(event.target.value); resetRequestIdentity() }} /><p className="image-hint">{t('generate.promptHint', { max: formatNumber(IMAGE_GENERATION_LIMITS.prompt) })}</p></div></div>
      <details className="image-overrides"><summary>{t('generate.overrides')}</summary><p className="image-hint">{t('generate.overridesHint')}</p><div className="image-field"><label htmlFor={`${prefix}-generate-size`}>{t('generate.size')}</label><div><input id={`${prefix}-generate-size`} value={overrideSize} maxLength={64} disabled={useServiceSize} placeholder={config?.size || t('config.sizePlaceholder')} aria-describedby={`${prefix}-generate-size-hint`} onChange={event => { setOverrideSize(event.target.value); resetRequestIdentity() }} /><p className="image-hint" id={`${prefix}-generate-size-hint`}>{t('generate.sizeHint')}</p><label className="image-check"><input type="checkbox" checked={useServiceSize} aria-describedby={`${prefix}-service-size-hint`} onChange={event => { setUseServiceSize(event.target.checked); resetRequestIdentity() }} /><span>{t('generate.serviceSize')}</span></label><p className="image-hint" id={`${prefix}-service-size-hint`}>{t('generate.serviceSizeHint')}</p></div></div><div className="image-field"><label htmlFor={`${prefix}-generate-quality`}>{t('generate.quality')}</label><div><input id={`${prefix}-generate-quality`} value={overrideQuality} maxLength={200} placeholder={config?.quality || ''} onChange={event => { setOverrideQuality(event.target.value); resetRequestIdentity() }} /></div></div><div className="image-field"><label htmlFor={`${prefix}-generate-format`}>{t('generate.responseFormat')}</label><div><select id={`${prefix}-generate-format`} value={overrideFormat} onChange={event => { setOverrideFormat(event.target.value as ImageGenerationResponseFormat); resetRequestIdentity() }}>{formats.map(value => <option key={value || 'empty'} value={value}>{value ? (value === 'b64_json' ? t('config.format.b64') : value) : t('config.format.empty')}</option>)}</select></div></div></details>
      {generateFailure && <div className="image-notice" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{generateFailure}</span></div>}
      {!confirming ? <ActionButton reasonCode={!config?.ready ? 'configure' : configDirty ? 'draft' : hasActive ? 'active' : 'prompt'} type="button" className="button button-primary" disabled={!canGenerate} onClick={() => { setConfirming(true); setGenerateFailure(null) }}><ImagePlus size={16} aria-hidden="true" />{t(source ? 'generate.editButton' : 'generate.button')}</ActionButton> : <div className="image-confirm" role="group" aria-label={t(source ? 'generate.editConfirmTitle' : 'generate.confirmTitle')}><strong>{t(source ? 'generate.editConfirmTitle' : 'generate.confirmTitle')}</strong><p>{t(source ? 'generate.editConfirmText' : 'generate.confirmText')}</p><div className="image-form-actions"><ActionButton reasonCode="busy" type="button" className="button button-secondary" disabled={generating} onClick={() => setConfirming(false)}>{t('generate.cancel')}</ActionButton><ActionButton reasonCode={generating || hasActive ? 'active' : !config?.ready ? 'configure' : 'draft'} type="button" className="button button-primary" disabled={generating || hasActive || !config?.ready || configDirty} onClick={() => void submitGeneration()}>{generating ? t('generate.submitting') : t('generate.confirm')}</ActionButton></div></div>}
    </section>

    <div className="image-lower">
      <section className="image-block" aria-labelledby={`${prefix}-jobs-title`}>
        <div className="image-block-heading"><div><h3 id={`${prefix}-jobs-title`}>{t('jobs.title')}</h3><p>{t('jobs.description')}</p></div><ActionButton reasonCode={listLoading ? 'loading' : 'active'} type="button" className="text-button" disabled={listLoading || hasActive} onClick={() => void loadJobs(jobsPage?.offset ?? 0)}><RefreshCw size={14} aria-hidden="true" />{t('jobs.refresh')}</ActionButton></div>
        {listFailure && <div className="image-notice" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{listFailure}</span></div>}
        {listLoading && !jobsPage && <p className="image-loading" role="status"><LoaderCircle size={15} aria-hidden="true" />{t('jobs.loading')}</p>}
        {jobsPage && jobs.length === 0 && <div className="image-empty"><ImageOff size={26} aria-hidden="true" /><h4>{t('jobs.empty')}</h4><p>{t('jobs.emptyHelp')}</p></div>}
        {jobs.length > 0 && <ol className="image-jobs">{jobs.map(job => <li key={job.jobId} className="image-job"><div className="image-job-head"><span className={`status-badge image-job-status image-job-status-${job.status}`}>{t(`jobs.status.${job.status}`)}</span><time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time></div><p className="image-job-prompt" dir="auto">{job.prompt}</p><div className="image-job-meta"><span>{t('jobs.model', { model: job.model })}</span>{job.source && <span>{t(job.source.kind === 'received' ? 'jobs.source.received' : job.source.kind === 'asset' ? 'jobs.source.asset' : 'jobs.source.upload')}</span>}{job.assetIds.length > 0 && <span>{t('jobs.assets', { count: job.assetIds.length, value: formatNumber(job.assetIds.length) })}</span>}</div>{job.error && <p className="image-error">{t('jobs.error', { message: jobErrorText(job.error) })}</p>}{job.status === 'unknown' && <p className="image-warning">{t('jobs.unknownNotice')}</p>}{job.assetIds.length > 0 && <div className="image-asset-links">{job.assetIds.map(assetId => <ActionButton reasonCode="preview" key={assetId} type="button" className="text-button" onClick={() => void openAsset(assetId)}>{t('jobs.viewAssets')}</ActionButton>)}</div>}</li>)}</ol>}
        {jobsPage && jobsPage.total > 0 && <nav className="image-pagination" aria-label={t('jobs.title')}><span>{t('jobs.page', { start: formatNumber(jobsPage.total ? jobsPage.offset + 1 : 0), end: formatNumber(Math.min(jobsPage.offset + jobsPage.items.length, jobsPage.total)), total: formatNumber(jobsPage.total) })}</span><div><ActionButton reasonCode={listLoading ? 'loading' : 'firstPage'} type="button" className="button button-secondary" aria-label={t('jobs.previous')} disabled={listLoading || jobsPage.offset === 0} onClick={() => void loadJobs(Math.max(0, jobsPage.offset - jobsPage.limit))}><ChevronLeft size={16} aria-hidden="true" /></ActionButton><ActionButton reasonCode={listLoading ? 'loading' : 'lastPage'} type="button" className="button button-secondary" aria-label={t('jobs.next')} disabled={listLoading || !jobsPage.hasMore} onClick={() => void loadJobs(jobsPage.nextOffset ?? 0)}><ChevronRight size={16} aria-hidden="true" /></ActionButton></div></nav>}
      </section>

      <section className="image-block" aria-labelledby={`${prefix}-assets-title`}>
        <div className="image-block-heading"><div><h3 id={`${prefix}-assets-title`}>{t('resources.title')}</h3><p>{t('resources.description')}</p></div><ActionButton reasonCode="busy" type="button" className="text-button" disabled={listLoading} onClick={() => void loadAssets(assetsPage?.offset ?? 0)}><RefreshCw size={14} aria-hidden="true" />{t('resources.refresh')}</ActionButton></div>
        {assetsPage && assets.length === 0 && <div className="image-empty"><ImageOff size={26} aria-hidden="true" /><h4>{t('resources.empty')}</h4><p>{t('resources.emptyHelp')}</p></div>}
        {assets.length > 0 && <ul className="image-assets">{assets.map(asset => <li key={asset.assetId}><ActionButton reasonCode="preview" type="button" className="image-asset-row" onClick={() => void openAsset(asset.assetId)}><span className="image-asset-copy"><strong dir="auto">{asset.prompt}</strong><small>{t('resources.bytes', { size: bytesLabel(asset.bytes), type: asset.mimeType })} · {t('resources.created', { time: formatDateTime(asset.createdAt) })}</small></span><ChevronRight size={15} aria-hidden="true" /></ActionButton></li>)}</ul>}
        {assetsPage && assetsPage.total > 0 && <nav className="image-pagination" aria-label={t('resources.title')}><span>{t('resources.page', { start: formatNumber(assetsPage.total ? assetsPage.offset + 1 : 0), end: formatNumber(Math.min(assetsPage.offset + assetsPage.items.length, assetsPage.total)), total: formatNumber(assetsPage.total) })}</span><div><ActionButton reasonCode={listLoading ? 'loading' : 'firstPage'} type="button" className="button button-secondary" aria-label={t('resources.previous')} disabled={listLoading || assetsPage.offset === 0} onClick={() => void loadAssets(Math.max(0, assetsPage.offset - assetsPage.limit))}><ChevronLeft size={16} aria-hidden="true" /></ActionButton><ActionButton reasonCode={listLoading ? 'loading' : 'lastPage'} type="button" className="button button-secondary" aria-label={t('resources.next')} disabled={listLoading || !assetsPage.hasMore} onClick={() => void loadAssets(assetsPage.nextOffset ?? 0)}><ChevronRight size={16} aria-hidden="true" /></ActionButton></div></nav>}
      </section>
    </div>
    <dialog ref={previewDialog} className="image-preview" aria-labelledby={`${prefix}-preview-title`}
      onCancel={event => { event.preventDefault(); clearPreview() }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) clearPreview()
      }}>
      <div className="image-preview-heading"><h3 id={`${prefix}-preview-title`}>{t('resources.preview')}</h3><button type="button" className="text-button image-preview-close" autoFocus aria-label={t('resources.closePreview')} onClick={clearPreview}><X size={20} aria-hidden="true" /></button></div>
      <div className="image-preview-stage" aria-busy={previewLoading}>
        {previewLoading && <p className="image-loading" role="status"><LoaderCircle size={18} aria-hidden="true" />{t('resources.previewLoading')}</p>}
        {!previewLoading && selected && previewUrl.current && <img src={previewUrl.current} alt={t('resources.previewAlt')} />}
        {previewFailure && <p className="image-error" role="alert">{previewFailure}</p>}
      </div>
      {selected && <div className="image-preview-caption"><p dir="auto">{selected.item.prompt}</p><small>{t('resources.bytes', { size: bytesLabel(selected.item.bytes), type: selected.item.mimeType })} · {t('resources.created', { time: formatDateTime(selected.item.createdAt) })}</small></div>}
    </dialog>
  </section>
}
