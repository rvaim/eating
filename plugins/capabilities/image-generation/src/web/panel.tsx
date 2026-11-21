import { readImageLimits } from '@eating/plugin-sdk'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertCircle, Check, ChevronLeft, ChevronRight, Copy, ImageOff, ImagePlus,
  LoaderCircle, Pencil, RefreshCw, RotateCcw, Search, Trash2, Upload, X,
} from 'lucide-react'
import type { JsonObject } from '@eating/plugin-sdk'
import {
  ActionButton, DurationInput, FormSaveBar, HostApiError, InlineConfirm, PasswordInput,
  SegmentedTabs, UnknownOutcomeCard, createRequestId, hostRequest, useGalleryThumbnails, useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type {
  GeneratedImageItem, ImageGenerationConfiguration, ImageGenerationJob, ImageGenerationPage,
  ImageGenerationPreview, ImageGenerationResponseFormat,
} from '../types'
import { IMAGE_GENERATION_LIMITS } from '../types'
import {
  errorTextFrom, fetchConfiguration, imageBlob, jobErrorText, localImage, manage,
  readAssetPage, readDeleteResult, readJob, readJobPage, readPreview, updateConfiguration,
} from './data'
import type { ImageGenerationUpload } from './data'
import { it } from './i18n'
import { RequestParameters } from './RequestParameters'
import './panel.css'

type PanelTab = 'studio' | 'configuration'
type JobFilter = 'all' | 'active' | 'attention' | 'succeeded'

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

type SourceDraft =
  | { readonly kind: 'upload'; readonly image: ImageGenerationUpload; readonly name: string; readonly bytes: number; readonly key: string }
  | { readonly kind: 'asset'; readonly assetId: string; readonly name: string; readonly bytes: number; readonly key: string }

interface DeleteSelection { readonly revision: number; readonly items: readonly GeneratedImageItem[] }

const pageLimit = 20
const noAssets: readonly GeneratedImageItem[] = []
const formats: readonly ImageGenerationResponseFormat[] = ['', 'b64_json', 'url']
const SIZE_PRESETS = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const

function makeDraft(config: ImageGenerationConfiguration): ConfigDraft {
  return {
    baseUrl: config.baseUrl,
    apiKey: '',
    clearApiKey: false,
    model: config.model,
    timeoutMs: String(config.timeoutMs),
    size: config.size,
    quality: config.quality,
    responseFormat: config.responseFormat,
  }
}

function isConfigDraftDirty(draft: ConfigDraft | null, config: ImageGenerationConfiguration | null): boolean {
  if (!draft || !config) return false
  return (
    draft.baseUrl !== config.baseUrl ||
    draft.apiKey.length > 0 ||
    draft.clearApiKey ||
    draft.model !== config.model ||
    draft.timeoutMs !== String(config.timeoutMs) ||
    draft.size !== config.size ||
    draft.quality !== config.quality ||
    draft.responseFormat !== config.responseFormat
  )
}

function bytesLabel(bytes: number, formatNumber: (n: number, opts?: Intl.NumberFormatOptions) => string): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KiB`
  return `${formatNumber(bytes / 1024 / 1024, { maximumFractionDigits: 1 })} MiB`
}

function isBusyStatus(status: ImageGenerationJob['status']): boolean {
  return status === 'queued' || status === 'running'
}

function matchesJobFilter(job: ImageGenerationJob, filter: JobFilter): boolean {
  if (filter === 'active') return isBusyStatus(job.status)
  if (filter === 'attention') return job.status === 'failed' || job.status === 'unknown'
  if (filter === 'succeeded') return job.status === 'succeeded'
  return true
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

export function ImageGenerationPanel({ enabled, status, onFeedback, onRefresh, onDirtyChange }: PluginPanelProps) {
  const { t, formatNumber, formatDateTime } = useI18n('image-generation')
  const prefix = useId()
  const [tab, setTab] = useState<PanelTab>('studio')
  const [jobFilter, setJobFilter] = useState<JobFilter>('all')

  const [config, setConfig] = useState<ImageGenerationConfiguration | null>(null)
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [hiddenClearedNotice, setHiddenClearedNotice] = useState(false)
  const [configConflict, setConfigConflict] = useState(false)
  const [parametersReady, setParametersReady] = useState(false)
  const [parametersDirty, setParametersDirty] = useState(false)
  const [configLoading, setConfigLoading] = useState(true)
  const [configSaving, setConfigSaving] = useState(false)
  const [configFailure, setConfigFailure] = useState<string | null>(null)
  const [configMessage, setConfigMessage] = useState<string | null>(null)
  const [confirmReload, setConfirmReload] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})

  const [jobsPage, setJobsPage] = useState<ImageGenerationPage<ImageGenerationJob> | null>(null)
  const [assetsPage, setAssetsPage] = useState<ImageGenerationPage<GeneratedImageItem> | null>(null)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [jobsFailure, setJobsFailure] = useState<string | null>(null)
  const [assetsFailure, setAssetsFailure] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const searchQuery = useRef('')
  const [checkedIds, setCheckedIds] = useState<readonly string[]>([])
  const [deleteSelection, setDeleteSelection] = useState<DeleteSelection | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deletingRef = useRef(false)
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null)
  const deleteDialog = useRef<HTMLDialogElement | null>(null)
  const selectPage = useRef<HTMLInputElement | null>(null)
  const deleteController = useRef<AbortController | null>(null)

  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState<SourceDraft | null>(null)
  const [sourcePreparing, setSourcePreparing] = useState(false)
  const [sourceFailure, setSourceFailure] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [overrideSize, setOverrideSize] = useState('')
  const [useServiceSize, setUseServiceSize] = useState(false)
  const [overrideQuality, setOverrideQuality] = useState('')
  const [overrideFormat, setOverrideFormat] = useState<ImageGenerationResponseFormat>('')
  const [confirming, setConfirming] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateFailure, setGenerateFailure] = useState<string | null>(null)
  const [uncertainSubmit, setUncertainSubmit] = useState<{ requestId: string } | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const [selected, setSelected] = useState<ImageGenerationPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewFailure, setPreviewFailure] = useState<string | null>(null)
  const [visible, setVisible] = useState(() => !document.hidden)

  const mounted = useRef(false)
  const enabledRef = useRef(enabled)
  const configRef = useRef<ImageGenerationConfiguration | null>(null)
  const draftRef = useRef<ConfigDraft | null>(null)
  const configDirtyRef = useRef(false)
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
  const sourceKindRef = useRef<'upload' | 'asset' | null>(null)
  const sourceReadController = useRef<AbortController | null>(null)
  const sourceInput = useRef<HTMLInputElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const confirmHostRef = useRef<HTMLDivElement | null>(null)
  const discardHostRef = useRef<HTMLDivElement | null>(null)
  const assetsOffsetRef = useRef(0)
  const jobsOffsetRef = useRef(0)
  const needsRead = useRef({ config: true, jobs: true, assets: true })
  const activeJobs = useRef<ReadonlySet<string>>(new Set())
  const requestIdentity = useRef<RequestIdentity | null>(null)
  const callbacks = useRef({ onFeedback, onRefresh, onDirtyChange })

  enabledRef.current = enabled
  configRef.current = config
  draftRef.current = draft
  callbacks.current = { onFeedback, onRefresh, onDirtyChange }

  const configDirty = isConfigDraftDirty(draft, config)
  configDirtyRef.current = configDirty
  sourceKindRef.current = source?.kind ?? null

  useEffect(() => {
    callbacks.current.onDirtyChange?.(configDirty || parametersDirty)
  }, [configDirty, parametersDirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  const cancelAll = useCallback(() => {
    const taskChanged = Boolean(generateController.current || deleteController.current)
    needsRead.current.config ||= Boolean(configController.current)
    needsRead.current.jobs ||= Boolean(jobsController.current) || taskChanged
    needsRead.current.assets ||= Boolean(assetsController.current) || taskChanged
    deleteController.current?.abort()
    sourceReadController.current?.abort()
    sourceReadController.current = null
    configController.current?.abort()
    configController.current = null
    jobsController.current?.abort()
    jobsController.current = null
    assetsController.current?.abort()
    assetsController.current = null
    previewController.current?.abort()
    previewController.current = null
    generateController.current?.abort()
    generateController.current = null
  }, [])

  const clearPreview = useCallback(() => {
    previewController.current?.abort()
    previewController.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = null
    if (mounted.current) {
      setPreviewOpen(false)
      setSelected(null)
      setPreviewLoading(false)
      setPreviewFailure(null)
    }
  }, [])

  const clearSource = useCallback(() => {
    sourceReadController.current?.abort()
    sourceReadController.current = null
    if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
    sourcePreviewUrl.current = null
    if (mounted.current) {
      setSource(null)
      setSourcePreparing(false)
      setSourceFailure(null)
    }
    if (sourceInput.current) sourceInput.current.value = ''
  }, [])

  const replacePreview = useCallback((preview: ImageGenerationPreview) => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = URL.createObjectURL(imageBlob(preview.image))
    setSelected(preview)
  }, [])

  useEffect(() => {
    const dialog = previewDialog.current
    if (previewOpen) dialog?.showModal()
    else if (dialog?.open) dialog.close()
  }, [previewOpen])

  useEffect(() => {
    const dialog = deleteDialog.current
    if (deleteSelection) dialog?.showModal()
    else if (dialog?.open) dialog.close()
  }, [deleteSelection])

  useEffect(() => {
    if (selectPage.current) {
      selectPage.current.indeterminate = checkedIds.length > 0 && checkedIds.length < (assetsPage?.items.length ?? 0)
    }
  }, [checkedIds, assetsPage])

  useEffect(() => {
    if (!confirming) return
    requestAnimationFrame(() => {
      confirmHostRef.current?.querySelector('button')?.focus()
    })
  }, [confirming])

  useEffect(() => {
    if (!confirmReload) return
    requestAnimationFrame(() => {
      discardHostRef.current?.querySelector('button')?.focus()
    })
  }, [confirmReload])

  const loadConfig = useCallback(async (quiet = false, force = false) => {
    needsRead.current.config = true
    if (!mounted.current || document.hidden) return
    needsRead.current.config = false
    const ticket = ++configGeneration.current
    configController.current?.abort()
    const controller = new AbortController()
    configController.current = controller
    if (!quiet) setConfigLoading(true)
    try {
      const value = await fetchConfiguration(controller.signal)
      if (!mounted.current || controller.signal.aborted || ticket !== configGeneration.current) return
      // Never advance the CAS revision under an unsaved draft; an explicit discard is required.
      if (configDirtyRef.current && !force) return
      setConfig(value)
      setDraft(makeDraft(value))
      if (!quiet || force) setHiddenClearedNotice(false)
      setConfigConflict(false)
      setConfigFailure(null)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === configGeneration.current) {
        setConfigFailure(errorTextFrom(error, it('config.loadFailed')))
      }
    } finally {
      if (mounted.current && ticket === configGeneration.current) {
        setConfigLoading(false)
        if (configController.current === controller) configController.current = null
      }
    }
  }, [])

  const loadAssets = useCallback(async (offset = 0, quiet = false) => {
    assetsOffsetRef.current = offset
    needsRead.current.assets = true
    if (!mounted.current || document.hidden || !enabledRef.current) return
    needsRead.current.assets = false
    const ticket = ++assetsGeneration.current
    assetsController.current?.abort()
    const controller = new AbortController()
    assetsController.current = controller
    if (!quiet) {
      setCheckedIds([])
      setAssetsLoading(true)
    }
    try {
      let page = readAssetPage(await manage('list', { offset, limit: pageLimit, query: searchQuery.current }, controller.signal))
      if (page.offset > 0 && !page.items.length) {
        page = readAssetPage(
          await manage('list', { offset: Math.max(0, Math.floor((page.total - 1) / pageLimit) * pageLimit), limit: pageLimit, query: searchQuery.current }, controller.signal),
        )
      }
      if (!mounted.current || controller.signal.aborted || !enabledRef.current || ticket !== assetsGeneration.current) return
      assetsOffsetRef.current = page.offset
      setAssetsPage(current => (
        current &&
        current.revision === page.revision &&
        current.offset === page.offset &&
        current.total === page.total &&
        current.items.length === page.items.length &&
        current.items.every((item, index) => item.assetId === page.items[index]?.assetId)
          ? current
          : page
      ))
      if (quiet) setCheckedIds(current => current.filter(id => page.items.some(item => item.assetId === id)))
      setAssetsFailure(null)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && enabledRef.current && ticket === assetsGeneration.current) {
        setAssetsFailure(errorTextFrom(error, it(error instanceof HostApiError && error.code === 'INVALID_HOST_RESPONSE'
          ? 'resources.invalidResponse' : 'resources.loadFailed')))
      }
    } finally {
      if (mounted.current && ticket === assetsGeneration.current) {
        setAssetsLoading(false)
        if (assetsController.current === controller) assetsController.current = null
      }
    }
  }, [])

  const loadJobs = useCallback(async (offset = 0, quiet = false) => {
    jobsOffsetRef.current = offset
    needsRead.current.jobs = true
    if (!mounted.current || document.hidden || !enabledRef.current) return
    needsRead.current.jobs = false
    const ticket = ++jobsGeneration.current
    jobsController.current?.abort()
    const controller = new AbortController()
    jobsController.current = controller
    if (!quiet) setJobsLoading(true)
    try {
      const page = readJobPage(await manage('jobs', { offset, limit: pageLimit }, controller.signal))
      if (!mounted.current || controller.signal.aborted || !enabledRef.current || ticket !== jobsGeneration.current) return
      const wasActive = activeJobs.current
      const nowActive = new Set(page.items.filter(job => isBusyStatus(job.status)).map(job => job.jobId))
      const settled = page.items.some(job => job.status === 'succeeded' && wasActive.has(job.jobId))
      activeJobs.current = nowActive
      setJobsPage(page)
      setJobsFailure(null)
      if (settled) void loadAssets(assetsOffsetRef.current, true)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && enabledRef.current && ticket === jobsGeneration.current) {
        setJobsFailure(errorTextFrom(error, it(error instanceof HostApiError && error.code === 'INVALID_HOST_RESPONSE'
          ? 'jobs.invalidResponse' : 'jobs.loadFailed')))
      }
    } finally {
      if (mounted.current && ticket === jobsGeneration.current) {
        setJobsLoading(false)
        if (jobsController.current === controller) jobsController.current = null
      }
    }
  }, [loadAssets])

  useEffect(() => {
    mounted.current = true
    const suspend = () => {
      cancelAll()
      setConfigSaving(false)
      setGenerating(false)
      setConfirming(false)
      setPreviewLoading(false)
      setSourcePreparing(false)
      setDeleteSelection(null)
      clearPreview()
      if (sourceKindRef.current === 'asset') clearSource()
      setDraft(current => {
        if (!current) return current
        if (current.apiKey.length > 0) setHiddenClearedNotice(true)
        return current.apiKey.length > 0 ? { ...current, apiKey: '' } : current
      })
    }
    const visibility = () => {
      setVisible(!document.hidden)
      if (document.hidden) suspend()
    }
    const pagehide = () => {
      setVisible(false)
      suspend()
      setCheckedIds([])
      clearSource()
    }
    const pageshow = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('pageshow', pageshow)
    return () => {
      mounted.current = false
      ++configGeneration.current
      ++jobsGeneration.current
      ++assetsGeneration.current
      cancelAll()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('pageshow', pageshow)
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = null
      if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
      sourcePreviewUrl.current = null
    }
  }, [cancelAll, clearPreview, clearSource])

  useEffect(() => {
    if (!enabled) {
      ++jobsGeneration.current
      ++assetsGeneration.current
      jobsController.current?.abort()
      jobsController.current = null
      assetsController.current?.abort()
      assetsController.current = null
      generateController.current?.abort()
      generateController.current = null
      deleteController.current?.abort()
      deleteController.current = null
      needsRead.current.jobs = true
      needsRead.current.assets = true
      assetsOffsetRef.current = 0
      jobsOffsetRef.current = 0
      clearPreview()
      clearSource()
      activeJobs.current = new Set()
      requestIdentity.current = null
      setJobsPage(null)
      setAssetsPage(null)
      setJobsLoading(false)
      setAssetsLoading(false)
      setJobsFailure(null)
      setAssetsFailure(null)
      setDeleteFailure(null)
      setGenerateFailure(null)
      setUncertainSubmit(null)
      setGenerating(false)
      setConfirming(false)
      setCheckedIds([])
      setDeleteSelection(null)
    }
  }, [enabled, clearPreview, clearSource])

  useEffect(() => { void loadConfig(Boolean(configRef.current)) }, [enabled, status?.state, loadConfig])

  useEffect(() => {
    if (!visible) return
    if (needsRead.current.config) void loadConfig(Boolean(configRef.current))
    if (!enabled) return
    if (needsRead.current.jobs) void loadJobs(jobsOffsetRef.current)
    if (needsRead.current.assets) void loadAssets(assetsOffsetRef.current, Boolean(assetsPage))
  }, [enabled, visible, loadConfig, loadJobs, loadAssets, assetsPage])

  const fetchThumbnail = useCallback(async (assetId: string, signal: AbortSignal) => {
    const preview = readPreview(await manage('get', { assetId }, signal))
    return imageBlob(preview.image)
  }, [])
  const thumbs = useGalleryThumbnails(assetsPage?.items ?? noAssets, enabled, visible && tab === 'studio', fetchThumbnail)

  const hasActiveJob = Boolean(jobsPage?.items.some(job => isBusyStatus(job.status))) || generating
  useEffect(() => {
    if (!enabled || !visible || !hasActiveJob) return
    const timer = window.setInterval(() => {
      if (!document.hidden && enabledRef.current && !jobsController.current) void loadJobs(jobsOffsetRef.current, true)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [enabled, visible, hasActiveJob, loadJobs])

  function searchAssets(event: FormEvent) {
    event.preventDefault()
    if (!enabled) return
    searchQuery.current = query.trim()
    setDeleteFailure(null)
    void loadAssets(0)
  }

  function confirmDelete(items: readonly GeneratedImageItem[]) {
    if (!enabled || !assetsPage || !items.length || deletingRef.current) return
    setDeleteFailure(null)
    setDeleteSelection({ revision: assetsPage.revision, items })
  }

  async function deleteImages() {
    if (!enabled || !deleteSelection || deletingRef.current) return
    const target = deleteSelection
    deletingRef.current = true
    setDeleting(true)
    const controller = new AbortController()
    deleteController.current = controller
    clearPreview()
    try {
      const result = readDeleteResult(
        await manage('delete', { assetIds: target.items.map(item => item.assetId), expectedRevision: target.revision, confirmed: true }, controller.signal),
      )
      if (
        result.revision !== target.revision + 1 ||
        result.deletedAssetIds.length !== target.items.length ||
        result.deletedAssetIds.some(id => !target.items.some(item => item.assetId === id))
      ) {
        throw new Error('Unexpected deletion receipt')
      }
      if (mounted.current && !controller.signal.aborted) {
        if (source?.kind === 'asset' && result.deletedAssetIds.includes(source.assetId)) clearSource()
        callbacks.current.onFeedback(it('resources.deleted', { count: result.deletedAssetIds.length }))
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setDeleteFailure(errorTextFrom(error, it('resources.deleteUnknown')))
      }
    } finally {
      deletingRef.current = false
      deleteController.current = null
      if (mounted.current) {
        setDeleting(false)
        setDeleteSelection(null)
        setCheckedIds([])
        if (enabledRef.current) {
          void loadAssets(assetsOffsetRef.current)
          void loadJobs(jobsPage?.offset ?? 0, true)
        }
      }
    }
  }

  function updateDraft<K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) {
    setDraft(current => (
      current
        ? { ...current, [key]: value, ...(key === 'clearApiKey' && value === true ? { apiKey: '' } : {}) }
        : current
    ))
    setConfigMessage(null)
    setConfigFailure(null)
    if (key === 'apiKey') setHiddenClearedNotice(false)
    setFieldErrors(current => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function requestReload() {
    if (configDirtyRef.current) {
      setConfirmReload(true)
      return
    }
    void loadConfig(false, true)
  }

  function discardAndReload() {
    setConfirmReload(false)
    void loadConfig(false, true)
  }

  async function saveConfig() {
    if (!config || !draft || configSaving || !configDirty || hasActiveJob) return
    const errors: Record<string, string> = {}
    if (!validUrl(draft.baseUrl.trim())) errors.baseUrl = it('config.validation.baseUrl')
    if (!draft.model.trim()) errors.model = it('config.validation.model')
    const timeoutMs = Number(draft.timeoutMs)
    if (
      !/^\d+$/.test(draft.timeoutMs.trim()) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < IMAGE_GENERATION_LIMITS.minimumTimeoutMs ||
      timeoutMs > IMAGE_GENERATION_LIMITS.maximumTimeoutMs
    ) {
      errors.timeoutMs = it('config.validation.timeout', {
        min: formatNumber(IMAGE_GENERATION_LIMITS.minimumTimeoutMs),
        max: formatNumber(IMAGE_GENERATION_LIMITS.maximumTimeoutMs),
      })
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    setConfigSaving(true)
    setConfigFailure(null)
    setConfigMessage(null)
    const controller = new AbortController()
    configController.current = controller
    try {
      const patch: JsonObject = {
        expectedRevision: config.revision,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        timeoutMs,
        size: draft.size.trim(),
        quality: draft.quality.trim(),
        responseFormat: draft.responseFormat,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        ...(draft.clearApiKey ? { clearApiKey: true } : {}),
      }
      const updated = await updateConfiguration(patch, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setConfig(updated)
      setDraft(makeDraft(updated))
      setHiddenClearedNotice(false)
      setConfigConflict(false)
      setConfigMessage(it('config.saved'))
      callbacks.current.onFeedback(it('config.saved'))
      void callbacks.current.onRefresh?.().catch(() => {})
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setConfigFailure(errorTextFrom(error, it('common.loadFailed')))
        if (error instanceof HostApiError && error.code === 'IMAGE_GENERATION_CONFIGURATION_CONFLICT') {
          setConfigConflict(true)
        }
      }
    } finally {
      if (configController.current === controller) configController.current = null
      if (mounted.current) setConfigSaving(false)
    }
  }

  async function openAsset(assetId: string) {
    if (!enabledRef.current || !mounted.current || document.hidden) return
    clearPreview()
    const controller = new AbortController()
    previewController.current = controller
    setPreviewOpen(true)
    setPreviewLoading(true)
    try {
      const preview = readPreview(await manage('get', { assetId }, controller.signal))
      if (!mounted.current || controller.signal.aborted || document.hidden || !enabledRef.current) return
      replacePreview(preview)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setPreviewFailure(errorTextFrom(error, it('resources.previewFailed')))
      }
    } finally {
      if (previewController.current === controller) {
        previewController.current = null
        if (mounted.current) setPreviewLoading(false)
      }
    }
  }

  function resetRequestIdentity() {
    requestIdentity.current = null
    setConfirming(false)
    setGenerateFailure(null)
  }

  async function chooseSource(file: File | undefined) {
    if (!file || document.hidden) return
    sourceReadController.current?.abort()
    const controller = new AbortController()
    sourceReadController.current = controller
    setSourcePreparing(true)
    setSourceFailure(null)
    try {
      const limits = readImageLimits(await hostRequest<unknown>('/image-limits', { signal: controller.signal }))
      const image = await localImage(file, limits.imageBytes)
      if (!mounted.current || controller.signal.aborted || document.hidden) return
      if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
      sourcePreviewUrl.current = URL.createObjectURL(file)
      setSource({
        kind: 'upload',
        image,
        name: file.name,
        bytes: file.size,
        key: `upload:${file.name}:${file.size}:${file.lastModified}`,
      })
      setSourceFailure(null)
      resetRequestIdentity()
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setSourceFailure(errorTextFrom(error, it('generate.sourceInvalid')))
      }
    } finally {
      if (sourceReadController.current === controller) sourceReadController.current = null
      if (mounted.current) setSourcePreparing(false)
    }
  }

  async function useAssetAsSource(asset: GeneratedImageItem) {
    if (!enabledRef.current || !mounted.current || document.hidden) return
    sourceReadController.current?.abort()
    const controller = new AbortController()
    sourceReadController.current = controller
    setSourcePreparing(true)
    setSourceFailure(null)
    try {
      const preview = readPreview(await manage('get', { assetId: asset.assetId }, controller.signal))
      const blob = imageBlob(preview.image)
      const url = URL.createObjectURL(blob)
      if (!mounted.current || controller.signal.aborted || document.hidden || !enabledRef.current) {
        URL.revokeObjectURL(url)
        return
      }
      if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
      sourcePreviewUrl.current = url
      if (sourceInput.current) sourceInput.current.value = ''
      setSource({
        kind: 'asset',
        assetId: asset.assetId,
        name: asset.prompt,
        bytes: asset.bytes,
        key: `asset:${asset.assetId}`,
      })
      resetRequestIdentity()
      setTab('studio')
      requestAnimationFrame(() => promptRef.current?.focus())
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setSourceFailure(errorTextFrom(error, it('resources.previewFailed')))
      }
    } finally {
      if (sourceReadController.current === controller) sourceReadController.current = null
      if (mounted.current) setSourcePreparing(false)
    }
  }

  function usePreviewAsSource() {
    if (!selected || !mounted.current) return
    const url = URL.createObjectURL(imageBlob(selected.image))
    if (sourcePreviewUrl.current) URL.revokeObjectURL(sourcePreviewUrl.current)
    sourcePreviewUrl.current = url
    if (sourceInput.current) sourceInput.current.value = ''
    setSource({
      kind: 'asset',
      assetId: selected.item.assetId,
      name: selected.item.prompt,
      bytes: selected.item.bytes,
      key: `asset:${selected.item.assetId}`,
    })
    resetRequestIdentity()
    clearPreview()
    setTab('studio')
    requestAnimationFrame(() => promptRef.current?.focus())
  }

  async function copyRequestId(requestId: string) {
    try {
      await navigator.clipboard.writeText(requestId)
      setCopiedId(requestId)
      window.setTimeout(() => {
        if (mounted.current) setCopiedId(current => (current === requestId ? null : current))
      }, 1800)
    } catch {
      /* Clipboard unavailable; visible code remains selectable. */
    }
  }

  async function submitGeneration() {
    if (!enabled || !config?.ready || configDirty || !parametersReady || parametersDirty || hasActive || generating || deletingRef.current || !prompt.trim()) return
    if ([...prompt.trim()].length > IMAGE_GENERATION_LIMITS.prompt) {
      setGenerateFailure(it('generate.promptTooLong', { max: formatNumber(IMAGE_GENERATION_LIMITS.prompt) }))
      return
    }
    const key = JSON.stringify([prompt.trim(), useServiceSize ? '' : overrideSize.trim() || null, overrideQuality.trim(), overrideFormat, source?.key ?? null])
    if (requestIdentity.current?.key !== key) requestIdentity.current = { key, id: createRequestId() }
    const identity = requestIdentity.current
    setGenerating(true)
    setGenerateFailure(null)
    const controller = new AbortController()
    generateController.current = controller
    try {
      const sourceObject: JsonObject | undefined = source
        ? source.kind === 'asset'
          ? { kind: 'asset', assetId: source.assetId }
          : { kind: 'upload', data: source.image.data, mimeType: source.image.mimeType }
        : undefined
      const job = readJob(
        await manage(
          'generate',
          {
            prompt: prompt.trim(),
            request_id: identity.id,
            confirmed: true,
            ...(sourceObject ? { source: sourceObject } : {}),
            ...(useServiceSize ? { size: '' } : overrideSize.trim() ? { size: overrideSize.trim() } : {}),
            ...(overrideQuality.trim() ? { quality: overrideQuality.trim() } : {}),
            ...(overrideFormat ? { response_format: overrideFormat } : {}),
          },
          controller.signal,
        ),
      )
      if (!mounted.current || controller.signal.aborted) return
      requestIdentity.current = null
      setConfirming(false)
      setUncertainSubmit(null)
      setPrompt('')
      clearSource()
      setGenerateFailure(null)
      setJobsPage(current => (
        current
          ? { ...current, items: [job, ...current.items].slice(0, pageLimit), total: current.total + 1 }
          : { revision: 0, items: [job], offset: 0, limit: pageLimit, total: 1, hasMore: false, nextOffset: null }
      ))
      if (isBusyStatus(job.status)) activeJobs.current = new Set([...activeJobs.current, job.jobId])
      callbacks.current.onFeedback(it('generate.submitted'))
      void loadJobs(0, true)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        if (error instanceof HostApiError && error.outcome === 'unknown') {
          setUncertainSubmit({ requestId: identity.id })
        }
        setGenerateFailure(errorTextFrom(error, it('generate.failed')))
      }
    } finally {
      if (generateController.current === controller) generateController.current = null
      if (mounted.current) setGenerating(false)
    }
  }

  const jobs = jobsPage?.items ?? []
  const assets = assetsPage?.items ?? []
  const hasActive = jobs.some(job => isBusyStatus(job.status)) || generating
  const canGenerate = Boolean(enabled && config?.ready && !configDirty && parametersReady && !parametersDirty && !hasActive && !deleting && !sourcePreparing && prompt.trim())

  const prerequisite = !config || config.ready
    ? null
    : !config.baseUrl.trim() && !config.model.trim()
      ? 'prerequisite.baseUrlModel'
      : !validUrl(config.baseUrl)
        ? 'prerequisite.baseUrl'
        : !config.model.trim()
          ? 'prerequisite.model'
          : 'prerequisite.inactive'

  const jobCounts = useMemo(() => ({
    all: jobs.length,
    active: jobs.filter(job => matchesJobFilter(job, 'active')).length,
    attention: jobs.filter(job => matchesJobFilter(job, 'attention')).length,
    succeeded: jobs.filter(job => matchesJobFilter(job, 'succeeded')).length,
  }), [jobs])

  const filteredJobs = useMemo(
    () => jobs.filter(job => matchesJobFilter(job, jobFilter)),
    [jobs, jobFilter],
  )

  const unknownJob = jobs.find(job => job.status === 'unknown')
  const showUnknownCard = Boolean(uncertainSubmit || unknownJob)

  return (
    <section
      className="image-generation-panel"
      aria-label={t('plugin.name')}
      onKeyDown={event => {
        if (event.key === 'Escape' && confirming && !generating) {
          event.stopPropagation()
          setConfirming(false)
        }
      }}>
      <SegmentedTabs
        idPrefix={prefix}
        sticky
        className="image-tabs"
        ariaLabel={t('tabs.label')}
        activeTab={tab}
        onSelect={next => setTab(next)}
        tabs={[
          {
            id: 'studio',
            label: t('tabs.studio'),
            badge: jobCounts.active + jobCounts.attention > 0 ? jobCounts.active + jobCounts.attention : undefined,
          },
          {
            id: 'configuration',
            label: t('tabs.configuration'),
            dirty: configDirty || parametersDirty,
          },
        ]}
      />

      <div
        id={`${prefix}-panel-studio`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tab-studio`}
        hidden={tab !== 'studio'}
        className="image-tab-panel">
        {(!enabled || prerequisite || configDirty || parametersDirty) && (
          <div className="image-setup-cta" role="status">
            <AlertCircle size={18} aria-hidden="true" />
            <div>
              <strong>
                {!enabled
                  ? t('setupCta.disabledTitle')
                  : configDirty || parametersDirty
                    ? t('setupCta.dirtyTitle')
                    : t(prerequisite!)}
              </strong>
              <p>
                {!enabled
                  ? t('setupCta.disabledBody')
                  : configDirty || parametersDirty
                    ? t('setupCta.dirtyBody')
                    : t('setupCta.unconfiguredBody')}
              </p>
            </div>
            {enabled && (prerequisite || configDirty || parametersDirty) && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setTab('configuration')}>
                {t(configDirty || parametersDirty ? 'setupCta.goToSave' : 'setupCta.goToConfig')}
              </button>
            )}
          </div>
        )}

        <section className="image-block" aria-labelledby={`${prefix}-generate-title`}>
          <div className="image-block-heading">
            <div>
              <h3 id={`${prefix}-generate-title`}>{t('generate.title')}</h3>
              <p>{t('generate.description')}</p>
            </div>
            {config && (
              <span className={`status-badge image-ready-${config.ready && enabled ? 'yes' : 'no'}`}>
                {config.model ? `${config.model} · ` : ''}{t(config.ready ? 'config.ready' : 'config.notReady')}
              </span>
            )}
          </div>

          <div className="image-field">
            <label htmlFor={`${prefix}-source`}>{t('generate.source')}</label>
            <div>
              <div
                className={`image-dropzone${dragOver ? ' is-dragging' : ''}${source ? ' has-file' : ''}`}
                onDragOver={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!generating && enabled) setDragOver(true)
                }}
                onDragLeave={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  setDragOver(false)
                }}
                onDrop={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  setDragOver(false)
                  if (!generating) void chooseSource(event.dataTransfer.files?.[0])
                }}>
                <input
                  ref={sourceInput}
                  id={`${prefix}-source`}
                  className="image-file-input"
                  aria-label={t('generate.source')}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={generating}
                  onChange={event => void chooseSource(event.target.files?.[0])}
                />
                <Upload size={20} className="image-dropzone-icon" aria-hidden="true" />
                <strong>{t('generate.sourceDropTitle')}</strong>
                <span className="image-hint">{t('generate.sourceHint')}</span>
              </div>

              {sourcePreparing && (
                <p className="image-loading" role="status">
                  <LoaderCircle size={15} className="image-spin" aria-hidden="true" />
                  {t('resources.loadingSourceAsset')}
                </p>
              )}

              {sourceFailure && <p className="image-error" role="alert">{sourceFailure}</p>}

              {source && sourcePreviewUrl.current && (
                <div className="image-source-preview">
                  <img src={sourcePreviewUrl.current} alt={t('generate.sourcePreviewAlt')} />
                  <div className="image-source-copy">
                    <div className="image-source-badges">
                      <span className="image-badge">
                        {t(source.kind === 'asset' ? 'generate.sourceBadgeAsset' : 'generate.sourceBadgeUpload')}
                      </span>
                      <small>{bytesLabel(source.bytes, formatNumber)}</small>
                    </div>
                    <strong dir="auto">{source.name}</strong>
                    {source.kind === 'asset' && (
                      <small>{t('generate.sourceAssetHint')}</small>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      disabled={generating}
                      onClick={() => { clearSource(); resetRequestIdentity() }}>
                      <X size={14} aria-hidden="true" />
                      {t('generate.clearSource')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="image-field">
            <label htmlFor={`${prefix}-prompt`}>{t('generate.prompt')}</label>
            <div>
              <textarea
                ref={promptRef}
                id={`${prefix}-prompt`}
                rows={5}
                maxLength={IMAGE_GENERATION_LIMITS.prompt}
                value={prompt}
                placeholder={t('generate.promptPlaceholder')}
                onChange={event => { setPrompt(event.target.value); resetRequestIdentity() }}
              />
              <p className="image-hint">
                {t('generate.promptHint', { max: formatNumber(IMAGE_GENERATION_LIMITS.prompt) })} ({formatNumber([...prompt].length)} / {formatNumber(IMAGE_GENERATION_LIMITS.prompt)})
              </p>
            </div>
          </div>

          <details className="image-overrides">
            <summary>{t('generate.overrides')}</summary>
            <p className="image-hint">{t('generate.overridesHint')}</p>
            <div className="image-field">
              <label htmlFor={`${prefix}-generate-size`}>{t('generate.size')}</label>
              <div>
                <div className="image-preset-chips">
                  <span className="image-preset-label">{t('generate.sizePresetsLabel')}</span>
                  {SIZE_PRESETS.map(size => (
                    <button
                      key={size}
                      type="button"
                      className={`image-chip-btn${!useServiceSize && overrideSize === size ? ' is-selected' : ''}`}
                      disabled={generating}
                      onClick={() => {
                        setUseServiceSize(false)
                        setOverrideSize(size)
                        resetRequestIdentity()
                      }}>
                      {size}
                    </button>
                  ))}
                </div>
                <input
                  id={`${prefix}-generate-size`}
                  value={overrideSize}
                  maxLength={64}
                  disabled={useServiceSize}
                  placeholder={config?.size || t('config.sizePlaceholder')}
                  aria-describedby={`${prefix}-generate-size-hint`}
                  onChange={event => { setOverrideSize(event.target.value); resetRequestIdentity() }}
                />
                <p className="image-hint" id={`${prefix}-generate-size-hint`}>{t('generate.sizeHint')}</p>
                <label className="image-check">
                  <input
                    type="checkbox"
                    checked={useServiceSize}
                    aria-describedby={`${prefix}-service-size-hint`}
                    onChange={event => { setUseServiceSize(event.target.checked); resetRequestIdentity() }}
                  />
                  <span>{t('generate.serviceSize')}</span>
                </label>
                <p className="image-hint" id={`${prefix}-service-size-hint`}>{t('generate.serviceSizeHint')}</p>
              </div>
            </div>
            <div className="image-field">
              <label htmlFor={`${prefix}-generate-quality`}>{t('generate.quality')}</label>
              <div>
                <input
                  id={`${prefix}-generate-quality`}
                  value={overrideQuality}
                  maxLength={200}
                  placeholder={config?.quality || ''}
                  onChange={event => { setOverrideQuality(event.target.value); resetRequestIdentity() }}
                />
              </div>
            </div>
            <div className="image-field">
              <label htmlFor={`${prefix}-generate-format`}>{t('generate.responseFormat')}</label>
              <div>
                <select
                  id={`${prefix}-generate-format`}
                  value={overrideFormat}
                  onChange={event => { setOverrideFormat(event.target.value as ImageGenerationResponseFormat); resetRequestIdentity() }}>
                  {formats.map(value => (
                    <option key={value || 'empty'} value={value}>
                      {value ? (value === 'b64_json' ? t('config.format.b64') : value) : t('config.format.empty')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </details>

          {generateFailure && (
            <div className="image-notice" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{generateFailure}</span>
            </div>
          )}

          {!confirming ? (
            <ActionButton
              reasonCode={
                !enabled
                  ? 'enable'
                  : !config?.ready
                    ? 'configure'
                    : !parametersReady
                      ? 'loading'
                      : configDirty || parametersDirty
                        ? 'draft'
                        : hasActive
                          ? 'active'
                          : 'prompt'
              }
              type="button"
              className="button button-primary"
              disabled={!canGenerate}
              onClick={() => { setConfirming(true); setGenerateFailure(null) }}>
              <ImagePlus size={16} aria-hidden="true" />
              {t(source ? 'generate.editButton' : 'generate.button')}
            </ActionButton>
          ) : (
            <div ref={confirmHostRef} className="image-inline-confirm">
              <InlineConfirm
                variant="warning"
                title={t(source ? 'generate.editConfirmTitle' : 'generate.confirmTitle')}
                description={t(source ? 'generate.editConfirmText' : 'generate.confirmText')}
                confirmLabel={t('generate.confirm')}
                busyLabel={t('generate.submitting')}
                cancelLabel={t('generate.cancel')}
                busy={generating}
                confirmDisabled={hasActive && !generating ? true : !enabled || !config?.ready || configDirty || !parametersReady || parametersDirty}
                confirmReason={t(!config?.ready ? 'generate.needConfig' : 'config.activeLocked')}
                onCancel={() => setConfirming(false)}
                onConfirm={() => void submitGeneration()}
              />
            </div>
          )}
        </section>

        {showUnknownCard && (
          <UnknownOutcomeCard
            title={t('generate.unknownTitle')}
            body={t('generate.unknownBody')}
            requestId={uncertainSubmit?.requestId ?? unknownJob?.requestId ?? null}
            onRefresh={() => {
              void loadJobs(jobsOffsetRef.current)
              void loadAssets(assetsOffsetRef.current, true)
            }}
            onConfirmReviewed={() => setUncertainSubmit(null)}
          />
        )}

        <div className="image-lower">
          <section className="image-block" aria-labelledby={`${prefix}-jobs-title`}>
            <div className="image-block-heading">
              <div>
                <h3 id={`${prefix}-jobs-title`}>{t('jobs.title')}</h3>
                <p>{t('jobs.description')}</p>
                {hasActiveJob && (
                  <span className="image-live-pill" role="status">
                    <LoaderCircle size={12} className="image-spin" aria-hidden="true" />
                    {t('jobs.livePolling')}
                  </span>
                )}
              </div>
              <ActionButton
                reasonCode={!enabled ? 'enable' : jobsLoading ? 'loading' : 'active'}
                type="button"
                className="text-button"
                disabled={!enabled || jobsLoading || hasActive}
                onClick={() => void loadJobs(jobsPage?.offset ?? 0)}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('jobs.refresh')}
              </ActionButton>
            </div>

            {!enabled ? (
              <p className="image-hint">{t('setupCta.disabledBody')}</p>
            ) : (
              <>
                {jobsFailure && (
                  <div className="image-notice" role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>{jobsFailure}</span>
                  </div>
                )}
                {jobsLoading && !jobsPage && (
                  <p className="image-loading" role="status">
                    <LoaderCircle size={15} className="image-spin" aria-hidden="true" />
                    {t('jobs.loading')}
                  </p>
                )}
                {jobsPage && jobs.length === 0 && (
                  <div className="image-empty">
                    <ImageOff size={26} aria-hidden="true" />
                    <h4>{t('jobs.empty')}</h4>
                    <p>{t('jobs.emptyHelp')}</p>
                  </div>
                )}
                {jobs.length > 0 && (
                  <>
                    <div className="image-filters" role="group" aria-label={t('jobs.title')}>
                      {(['all', 'active', 'attention', 'succeeded'] as const).map(key => (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={jobFilter === key}
                          className={`image-filter-pill${jobFilter === key ? ' is-selected' : ''}`}
                          onClick={() => setJobFilter(key)}>
                          {t(`jobs.filter.${key}`, { count: jobCounts[key] })}
                        </button>
                      ))}
                    </div>

                    {!filteredJobs.length ? (
                      <p className="image-hint">{t('jobs.filterEmpty')}</p>
                    ) : (
                      <ol className="image-jobs">
                        {filteredJobs.map(job => (
                          <li key={job.jobId} className="image-job">
                            <div className="image-job-head">
                              <span className={`status-badge image-job-status image-job-status-${job.status}`}>
                                {t(`jobs.status.${job.status}`)}
                              </span>
                              <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
                            </div>
                            <p className="image-job-prompt" dir="auto">{job.prompt}</p>
                            <div className="image-job-meta">
                              <span>{t('jobs.model', { model: job.model })}</span>
                              {job.source && (
                                <span>{t(`jobs.source.${job.source.kind}`)}</span>
                              )}
                              {job.source?.count && <span>{t('jobs.sourceCount', { count: job.source.count })}</span>}
                              {job.assetIds.length > 0 && (
                                <span>{t('jobs.assets', { count: job.assetIds.length, value: formatNumber(job.assetIds.length) })}</span>
                              )}
                            </div>
                            {job.status === 'succeeded' && job.assetIds.length === 0 && (
                              <p className="image-deleted-note">{t('jobs.imageDeleted')}</p>
                            )}
                            {job.error && (
                              <p className="image-error">{t('jobs.error', { message: jobErrorText(job.error) })}</p>
                            )}
                            {job.status === 'unknown' && (
                              <div className="image-warning">
                                <p>{t('jobs.unknownNotice')}</p>
                                <div className="image-job-id-row">
                                  <code>{job.requestId}</code>
                                  <button
                                    type="button"
                                    className="button button-secondary image-mini-btn"
                                    onClick={() => void copyRequestId(job.requestId)}>
                                    {copiedId === job.requestId ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                                    {copiedId === job.requestId ? t('jobs.copiedRequestId') : t('jobs.copyRequestId')}
                                  </button>
                                </div>
                              </div>
                            )}
                            <div className="image-asset-links">
                              {job.assetIds.map(assetId => (
                                <ActionButton
                                  reasonCode="preview"
                                  key={assetId}
                                  type="button"
                                  className="text-button"
                                  onClick={() => void openAsset(assetId)}>
                                  {t('jobs.viewAssets')}
                                </ActionButton>
                              ))}
                              <button
                                type="button"
                                className="text-button"
                                disabled={generating}
                                onClick={() => {
                                  setPrompt(job.prompt)
                                  resetRequestIdentity()
                                  requestAnimationFrame(() => promptRef.current?.focus())
                                }}>
                                <RotateCcw size={13} aria-hidden="true" />
                                {t('jobs.reusePrompt')}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </>
                )}
                {jobsPage && jobsPage.total > 0 && (
                  <nav className="image-pagination" aria-label={t('jobs.title')}>
                    <span>
                      {t('jobs.page', {
                        start: formatNumber(jobsPage.total ? jobsPage.offset + 1 : 0),
                        end: formatNumber(Math.min(jobsPage.offset + jobsPage.items.length, jobsPage.total)),
                        total: formatNumber(jobsPage.total),
                      })}
                    </span>
                    <div>
                      <ActionButton
                        reasonCode={jobsLoading ? 'loading' : 'firstPage'}
                        type="button"
                        className="button button-secondary"
                        aria-label={t('jobs.previous')}
                        disabled={jobsLoading || jobsPage.offset === 0}
                        onClick={() => void loadJobs(Math.max(0, jobsPage.offset - jobsPage.limit))}>
                        <ChevronLeft size={16} aria-hidden="true" />
                      </ActionButton>
                      <ActionButton
                        reasonCode={jobsLoading ? 'loading' : 'lastPage'}
                        type="button"
                        className="button button-secondary"
                        aria-label={t('jobs.next')}
                        disabled={jobsLoading || !jobsPage.hasMore}
                        onClick={() => void loadJobs(jobsPage.nextOffset ?? 0)}>
                        <ChevronRight size={16} aria-hidden="true" />
                      </ActionButton>
                    </div>
                  </nav>
                )}
              </>
            )}
          </section>

          <section className="image-block image-history" aria-labelledby={`${prefix}-assets-title`}>
            <div className="image-block-heading">
              <div>
                <h3 id={`${prefix}-assets-title`}>
                  {t('resources.title')}
                  {assetsPage && <span className="image-history-count">{formatNumber(assetsPage.total)}</span>}
                </h3>
                <p>{t('resources.description')}</p>
              </div>
              <ActionButton
                reasonCode={!enabled ? 'enable' : 'busy'}
                type="button"
                className="text-button"
                disabled={!enabled || assetsLoading || deleting}
                onClick={() => void loadAssets(assetsPage?.offset ?? 0)}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('resources.refresh')}
              </ActionButton>
            </div>

            {!enabled ? (
              <p className="image-hint">{t('setupCta.disabledBody')}</p>
            ) : (
              <>
                <form className="image-history-search" role="search" onSubmit={searchAssets}>
                  <label htmlFor={`${prefix}-search`}>{t('resources.search')}</label>
                  <div>
                    <input
                      id={`${prefix}-search`}
                      type="search"
                      maxLength={200}
                      value={query}
                      placeholder={t('resources.searchPlaceholder')}
                      onChange={event => setQuery(event.target.value)}
                    />
                    <button type="submit" className="button button-secondary" disabled={assetsLoading || deleting}>
                      <Search size={16} aria-hidden="true" />
                      {t('resources.searchButton')}
                    </button>
                    {searchQuery.current && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={assetsLoading || deleting}
                        onClick={() => { setQuery(''); searchQuery.current = ''; void loadAssets(0) }}>
                        {t('resources.clearSearch')}
                      </button>
                    )}
                  </div>
                </form>

                {assetsFailure && <p className="image-error" role="alert">{assetsFailure}</p>}
                {deleteFailure && <p className="image-error" role="alert">{deleteFailure}</p>}
                {assetsLoading && <p className="image-loading" role="status">{t('resources.loading')}</p>}
                {assetsPage && assets.length === 0 && (
                  <div className="image-empty">
                    <ImageOff size={26} aria-hidden="true" />
                    <h4>{t(searchQuery.current ? 'resources.noMatches' : 'resources.empty')}</h4>
                    <p>{t(searchQuery.current ? 'resources.noMatchesHelp' : 'resources.emptyHelp')}</p>
                  </div>
                )}

                {assets.length > 0 && (
                  <>
                    <div className="image-selection-bar">
                      <label>
                        <input
                          ref={selectPage}
                          type="checkbox"
                          checked={checkedIds.length === assets.length}
                          disabled={assetsLoading || deleting}
                          onChange={event => setCheckedIds(event.target.checked ? assets.map(item => item.assetId) : [])}
                        />
                        {t('resources.selectPage')}
                      </label>
                      <span aria-live="polite">{t('resources.selected', { count: checkedIds.length })}</span>
                      <ActionButton
                        reasonCode={hasActive ? 'active' : 'empty'}
                        type="button"
                        className="button button-danger"
                        disabled={!checkedIds.length || assetsLoading || deleting || hasActive}
                        onClick={() => confirmDelete(assets.filter(item => checkedIds.includes(item.assetId)))}>
                        <Trash2 size={15} aria-hidden="true" />
                        {t('resources.deleteSelected')}
                      </ActionButton>
                    </div>

                    <ul className="image-assets">
                      {assets.map(asset => {
                        const thumb = thumbs[asset.assetId]
                        return (
                          <li key={asset.assetId} className={checkedIds.includes(asset.assetId) ? 'is-selected' : ''}>
                            <label className="image-row-check">
                              <input
                                type="checkbox"
                                aria-label={t('resources.selectImage', { prompt: asset.prompt })}
                                checked={checkedIds.includes(asset.assetId)}
                                disabled={assetsLoading || deleting}
                                onChange={event => setCheckedIds(current => (
                                  event.target.checked
                                    ? [...current, asset.assetId]
                                    : current.filter(id => id !== asset.assetId)
                                ))}
                              />
                            </label>
                            <button
                              type="button"
                              className="image-asset-row"
                              onClick={() => void openAsset(asset.assetId)}>
                              <span className="image-asset-thumb-box" aria-hidden="true">
                                {thumb?.status === 'ready' && thumb.url ? (
                                  <img className="image-asset-thumb" src={thumb.url} alt="" />
                                ) : thumb?.status === 'loading' ? (
                                  <LoaderCircle size={16} className="image-spin" />
                                ) : (
                                  <ImageOff size={16} />
                                )}
                              </span>
                              <span className="image-asset-copy">
                                <strong dir="auto">{asset.prompt}</strong>
                                <small>
                                  {asset.model} · {bytesLabel(asset.bytes, formatNumber)}
                                  <br />
                                  {formatDateTime(asset.createdAt)}
                                </small>
                              </span>
                              <ChevronRight size={15} aria-hidden="true" />
                            </button>
                            <div className="image-asset-actions">
                              <button
                                type="button"
                                className="button button-secondary image-asset-edit-btn"
                                disabled={generating || sourcePreparing}
                                title={t('resources.editAsset')}
                                onClick={() => void useAssetAsSource(asset)}>
                                <Pencil size={14} aria-hidden="true" />
                                <span>{t('resources.editAsset')}</span>
                              </button>
                              <ActionButton
                                reasonCode={hasActive ? 'active' : 'busy'}
                                type="button"
                                className="text-button image-row-delete"
                                aria-label={t('resources.deleteImage', { prompt: asset.prompt })}
                                disabled={assetsLoading || deleting || hasActive}
                                onClick={() => confirmDelete([asset])}>
                                <Trash2 size={16} aria-hidden="true" />
                              </ActionButton>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}

                {assetsPage && assetsPage.total > 0 && (
                  <nav className="image-pagination" aria-label={t('resources.title')}>
                    <span>
                      {t('resources.page', {
                        start: formatNumber(assetsPage.total ? assetsPage.offset + 1 : 0),
                        end: formatNumber(Math.min(assetsPage.offset + assetsPage.items.length, assetsPage.total)),
                        total: formatNumber(assetsPage.total),
                      })}
                    </span>
                    <div>
                      <ActionButton
                        reasonCode={assetsLoading ? 'loading' : 'firstPage'}
                        type="button"
                        className="button button-secondary"
                        aria-label={t('resources.previous')}
                        disabled={assetsLoading || deleting || assetsPage.offset === 0}
                        onClick={() => void loadAssets(Math.max(0, assetsPage.offset - assetsPage.limit))}>
                        <ChevronLeft size={16} aria-hidden="true" />
                      </ActionButton>
                      <ActionButton
                        reasonCode={assetsLoading ? 'loading' : 'lastPage'}
                        type="button"
                        className="button button-secondary"
                        aria-label={t('resources.next')}
                        disabled={assetsLoading || deleting || !assetsPage.hasMore}
                        onClick={() => void loadAssets(assetsPage.nextOffset ?? 0)}>
                        <ChevronRight size={16} aria-hidden="true" />
                      </ActionButton>
                    </div>
                  </nav>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      <div
        id={`${prefix}-panel-configuration`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tab-configuration`}
        hidden={tab !== 'configuration'}
        className="image-tab-panel"
        onKeyDown={event => {
          if (event.key === 'Escape' && confirmReload) {
            event.stopPropagation()
            setConfirmReload(false)
          }
        }}>
        <section className="image-block" aria-labelledby={`${prefix}-config-title`}>
          <div className="image-block-heading">
            <div>
              <h3 id={`${prefix}-config-title`}>{t('config.title')}</h3>
              <p>{t('config.description')}</p>
            </div>
            {config && (
              <span className={`status-badge image-ready-${config.ready ? 'yes' : 'no'}`}>
                {t(config.ready ? 'config.ready' : 'config.notReady')}
              </span>
            )}
          </div>

          {configLoading && !config && (
            <p className="image-loading" role="status">
              <LoaderCircle size={15} className="image-spin" aria-hidden="true" />
              {t('config.loading')}
            </p>
          )}
          {configFailure && !config && (
            <div className="image-notice" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{configFailure}</span>
              <ActionButton reasonCode="busy" type="button" className="text-button" onClick={requestReload}>
                {t('config.retry')}
              </ActionButton>
            </div>
          )}
          {prerequisite && (
            <div className="image-notice image-notice-status" role="status">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{t(prerequisite)}</span>
            </div>
          )}

          <p className="image-config-note">{t('config.localCheck')}</p>

          {config && draft && (
            <form className="image-form" noValidate onSubmit={event => { event.preventDefault(); void saveConfig() }}>
              <div className={`image-field${fieldErrors.baseUrl ? ' is-invalid' : ''}`}>
                <label htmlFor={`${prefix}-base-url`}>{t('config.baseUrl')}</label>
                <div>
                  <input
                    id={`${prefix}-base-url`}
                    value={draft.baseUrl}
                    maxLength={4096}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => updateDraft('baseUrl', event.target.value)}
                  />
                  <p className="image-hint">{t('config.baseUrlHint')}</p>
                  {fieldErrors.baseUrl && <p className="image-error">{fieldErrors.baseUrl}</p>}
                </div>
              </div>

              <div className="image-field">
                <label htmlFor={`${prefix}-api-key`}>{t('config.apiKey')}</label>
                <div>
                  <PasswordInput
                    id={`${prefix}-api-key`}
                    aria-label={t('config.apiKey')}
                    aria-describedby={`${prefix}-api-key-hint`}
                    value={draft.apiKey}
                    saved={config.apiKeyConfigured}
                    clear={draft.clearApiKey}
                    hiddenClearedNotice={hiddenClearedNotice}
                    disabled={configSaving}
                    savedPlaceholder={t('config.apiKeySaved')}
                    placeholder={!config.apiKeyConfigured ? t('config.apiKeyEmpty') : undefined}
                    clearLabel={t('config.clearApiKey')}
                    onChange={value => updateDraft('apiKey', value)}
                    onClearChange={clear => updateDraft('clearApiKey', clear)}
                  />
                  <p className="image-hint" id={`${prefix}-api-key-hint`}>{t('config.apiKeyHint')}</p>
                </div>
              </div>

              <div className={`image-field${fieldErrors.model ? ' is-invalid' : ''}`}>
                <label htmlFor={`${prefix}-model`}>{t('config.model')}</label>
                <div>
                  <input
                    id={`${prefix}-model`}
                    value={draft.model}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('config.modelPlaceholder')}
                    onChange={event => updateDraft('model', event.target.value)}
                  />
                  <p className="image-hint">{t('config.modelHint')}</p>
                  {fieldErrors.model && <p className="image-error">{fieldErrors.model}</p>}
                </div>
              </div>

              <div className={`image-field${fieldErrors.timeoutMs ? ' is-invalid' : ''}`}>
                <label htmlFor={`${prefix}-timeout`}>{t('config.timeout')}</label>
                <div>
                  <DurationInput
                    id={`${prefix}-timeout`}
                    aria-label={t('config.timeout')}
                    aria-describedby={`${prefix}-timeout-hint`}
                    valueMs={draft.timeoutMs}
                    disabled={configSaving}
                    presetsSeconds={[30, 60, 120, 300]}
                    onChangeMs={ms => updateDraft('timeoutMs', ms)}
                  />
                  <p className="image-hint" id={`${prefix}-timeout-hint`}>
                    {t('config.timeoutHint', {
                      min: formatNumber(IMAGE_GENERATION_LIMITS.minimumTimeoutMs),
                      max: formatNumber(IMAGE_GENERATION_LIMITS.maximumTimeoutMs),
                    })}
                  </p>
                  {fieldErrors.timeoutMs && <p className="image-error">{fieldErrors.timeoutMs}</p>}
                </div>
              </div>

              <div className="image-field">
                <label htmlFor={`${prefix}-size`}>{t('config.size')}</label>
                <div>
                  <div className="image-preset-chips">
                    <span className="image-preset-label">{t('config.sizePresetsLabel')}</span>
                    {SIZE_PRESETS.map(size => (
                      <button
                        key={size}
                        type="button"
                        className={`image-chip-btn${draft.size === size ? ' is-selected' : ''}`}
                        disabled={configSaving}
                        onClick={() => updateDraft('size', size)}>
                        {size}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`image-chip-btn${draft.size === '' ? ' is-selected' : ''}`}
                      disabled={configSaving}
                      onClick={() => updateDraft('size', '')}>
                      {t('config.sizeDefaultReset')}
                    </button>
                  </div>
                  <input
                    id={`${prefix}-size`}
                    value={draft.size}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('config.sizePlaceholder')}
                    aria-describedby={`${prefix}-size-hint ${prefix}-size-support`}
                    onChange={event => updateDraft('size', event.target.value)}
                  />
                  <p className="image-hint" id={`${prefix}-size-hint`}>{t('config.sizeHint')}</p>
                  <p className="image-hint" id={`${prefix}-size-support`}>{t('config.sizeSupport')}</p>
                </div>
              </div>

              <div className="image-field">
                <label htmlFor={`${prefix}-quality`}>{t('config.quality')}</label>
                <div>
                  <input
                    id={`${prefix}-quality`}
                    value={draft.quality}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('config.qualityPlaceholder')}
                    onChange={event => updateDraft('quality', event.target.value)}
                  />
                  <p className="image-hint">{t('config.qualityHint')}</p>
                </div>
              </div>

              <div className="image-field">
                <label htmlFor={`${prefix}-format`}>{t('config.responseFormat')}</label>
                <div>
                  <select
                    id={`${prefix}-format`}
                    value={draft.responseFormat}
                    onChange={event => updateDraft('responseFormat', event.target.value as ImageGenerationResponseFormat)}>
                    {formats.map(value => (
                      <option key={value || 'empty'} value={value}>
                        {value ? (value === 'b64_json' ? t('config.format.b64') : value) : t('config.format.empty')}
                      </option>
                    ))}
                  </select>
                  <p className="image-hint">{t('config.responseFormatHint')}</p>
                </div>
              </div>

              <p className="image-config-note">{t('config.readyHint')}</p>
              {hasActive && <p className="image-hint">{t('config.activeLocked')}</p>}

              <FormSaveBar
                alwaysVisible
                dirty={configDirty}
                saving={configSaving}
                disabled={hasActive}
                disabledReason={hasActive ? t('config.activeLocked') : undefined}
                conflict={configConflict}
                saveLabel={t('config.save')}
                savingLabel={t('config.saving')}
                discardLabel={t('config.retry')}
                reloadLabel={t('config.retry')}
                error={configFailure}
                notice={configMessage}
                onSave={() => void saveConfig()}
                onDiscard={configConflict ? undefined : requestReload}
                onReload={requestReload}
                extraActions={
                  !configDirty && !configConflict ? (
                    <ActionButton
                      reasonCode="busy"
                      type="button"
                      className="button button-secondary"
                      disabled={configSaving}
                      onClick={requestReload}>
                      <RefreshCw size={14} aria-hidden="true" />
                      {t('config.retry')}
                    </ActionButton>
                  ) : undefined
                }
              />

              {confirmReload && (
                <div ref={discardHostRef} className="image-inline-confirm">
                  <InlineConfirm
                    variant="warning"
                    title={t('config.discardTitle')}
                    description={t('config.discardText')}
                    confirmLabel={t('config.discardConfirm')}
                    cancelLabel={t('config.discardCancel')}
                    busy={configSaving}
                    onCancel={() => setConfirmReload(false)}
                    onConfirm={discardAndReload}
                  />
                </div>
              )}
            </form>
          )}
        </section>

        <RequestParameters
          enabled={enabled}
          blocked={hasActive}
          onDirtyChange={setParametersDirty}
          onReadyChange={setParametersReady}
        />
      </div>

      <dialog
        ref={deleteDialog}
        className="image-delete-dialog"
        aria-labelledby={`${prefix}-delete-title`}
        onCancel={event => { event.preventDefault(); if (!deleting) setDeleteSelection(null) }}>
        {deleteSelection && (
          <>
            <h3 id={`${prefix}-delete-title`}>{t('resources.deleteTitle', { count: deleteSelection.items.length })}</h3>
            <p>{t('resources.deleteHelp')}</p>
            <ul>{deleteSelection.items.map(item => <li key={item.assetId} dir="auto">{item.prompt}</li>)}</ul>
            <p className="image-delete-size">
              {t('resources.deleteSize', { size: bytesLabel(deleteSelection.items.reduce((sum, item) => sum + item.bytes, 0), formatNumber) })}
            </p>
            <div className="image-form-actions">
              <button type="button" className="button button-secondary" autoFocus disabled={deleting} onClick={() => setDeleteSelection(null)}>
                {t('generate.cancel')}
              </button>
              <button type="button" className="button button-danger" disabled={deleting} onClick={() => void deleteImages()}>
                {t(deleting ? 'resources.deleting' : 'resources.confirmDelete', { count: deleteSelection.items.length })}
              </button>
            </div>
          </>
        )}
      </dialog>

      <dialog
        ref={previewDialog}
        className="image-preview"
        aria-labelledby={`${prefix}-preview-title`}
        onCancel={event => { event.preventDefault(); clearPreview() }}
        onClick={event => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
            clearPreview()
          }
        }}>
        <div className="image-preview-heading">
          <h3 id={`${prefix}-preview-title`}>{t('resources.preview')}</h3>
          <div className="image-preview-heading-actions">
            {selected && (
              <button
                type="button"
                className="button button-secondary image-preview-edit-btn"
                disabled={previewLoading || generating}
                onClick={usePreviewAsSource}>
                <Pencil size={15} aria-hidden="true" />
                {t('resources.editFromPreview')}
              </button>
            )}
            <button
              type="button"
              className="text-button image-preview-close"
              autoFocus
              aria-label={t('resources.closePreview')}
              onClick={clearPreview}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="image-preview-stage" aria-busy={previewLoading}>
          {previewLoading && (
            <p className="image-loading" role="status">
              <LoaderCircle size={18} className="image-spin" aria-hidden="true" />
              {t('resources.previewLoading')}
            </p>
          )}
          {!previewLoading && selected && previewUrl.current && (
            <img src={previewUrl.current} alt={t('resources.previewAlt')} />
          )}
          {previewFailure && <p className="image-error" role="alert">{previewFailure}</p>}
        </div>
        {selected && assets.some(item => item.assetId === selected.item.assetId) && (
          <div className="image-preview-navigation">
            <button
              type="button"
              className="text-button"
              disabled={previewLoading || assets[0]?.assetId === selected.item.assetId}
              onClick={() => {
                const index = assets.findIndex(item => item.assetId === selected.item.assetId)
                if (index > 0) void openAsset(assets[index - 1]!.assetId)
              }}>
              <ChevronLeft size={18} aria-hidden="true" />
              {t('resources.previousImage')}
            </button>
            <span>
              {assets.findIndex(item => item.assetId === selected.item.assetId) + 1} / {assets.length}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={previewLoading || assets.at(-1)?.assetId === selected.item.assetId}
              onClick={() => {
                const index = assets.findIndex(item => item.assetId === selected.item.assetId)
                if (index >= 0 && index + 1 < assets.length) void openAsset(assets[index + 1]!.assetId)
              }}>
              {t('resources.nextImage')}
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
        )}
        {selected && (
          <div className="image-preview-caption">
            <p dir="auto">{selected.item.prompt}</p>
            <small>
              {t('resources.bytes', { size: bytesLabel(selected.item.bytes, formatNumber), type: selected.item.mimeType })} · {t('resources.created', { time: formatDateTime(selected.item.createdAt) })}
            </small>
          </div>
        )}
      </dialog>
    </section>
  )
}
