import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowUp,
  Camera,
  CheckCircle2,
  Cpu,
  File as FileIcon,
  Folder,
  FolderOpen,
  Laptop,
  Play,
  RefreshCw,
  Smartphone,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  ActionButton,
  InlineConfirm,
  SegmentedTabs,
  StringListEditor,
  UnknownOutcomeCard,
  createRequestId,
  hostRequest,
  parseStringArrayJson,
  useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { AdbDetectionSnapshot, AndroidDevicesSnapshot, PublicAndroidConfiguration } from '../types'
import { ConnectionTab, draftFromConfig, isConnectionDraftDirty } from './ConnectionTab'
import type { ConnectionDraft } from './ConnectionTab'
import {
  androidErrorKey,
  base64ToBlobUrl,
  base64ToBytes,
  bytesToBase64,
  decodeToolOutput,
  formatByteSize,
  getErrorCode,
  invokeAndroid,
  isAbortError,
  isUnknownOutcomeError,
  joinHostPath,
  manageAndroid,
  parentHostPath,
  readPublicConfig,
} from './data'
import type { AndroidTranslationKey } from './i18n'
import './panel.css'

type PanelTab = 'console' | 'files-screen' | 'connection'
type OutputMode = 'text' | 'binary' | 'image'
type StreamMode = 'stdout' | 'stderr'

const UPLOAD_CHUNK_BYTES = 49152
const DOWNLOAD_CHUNK_BYTES = 65536

interface UnknownReceipt {
  readonly requestId: string
  readonly message: string
}

interface DirectoryListing {
  readonly path: string
  readonly total: number
  readonly truncated: boolean
  readonly entries: ReadonlyArray<{ readonly name: string; readonly directory: boolean }>
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function AndroidPanel({ enabled, saved, connectionBusy, onRefresh, onFeedback, onDirtyChange }: PluginPanelProps) {
  const { t, formatDateTime, formatNumber } = useI18n('android-control')
  const prefix = useId()

  const initialConfig = useMemo(() => readPublicConfig(saved), [saved])
  const [config, setConfig] = useState<PublicAndroidConfiguration | null>(initialConfig)
  const [detection, setDetection] = useState<AdbDetectionSnapshot | null>(initialConfig?.adbEnvironment ?? null)
  const [devicesSnapshot, setDevicesSnapshot] = useState<AndroidDevicesSnapshot | null>(null)
  const [draft, setDraft] = useState<ConnectionDraft | null>(() => (initialConfig ? draftFromConfig(initialConfig) : null))

  const userPickedTab = useRef(false)
  const [tab, setTab] = useState<PanelTab>(() =>
    initialConfig && (!initialConfig.adbAvailable || initialConfig.configState !== 'ok' || !enabled) ? 'connection' : 'console',
  )

  const [busy, setBusy] = useState(false)
  const [unknownOutcome, setUnknownOutcome] = useState<UnknownReceipt | null>(null)

  // Console & processes state
  const [execSerial, setExecSerial] = useState('')
  const [argvJson, setArgvJson] = useState('["devices","-l"]')
  const [terminal, setTerminal] = useState(false)
  const [waitMs, setWaitMs] = useState('5000')
  const [outputMode, setOutputMode] = useState<OutputMode>('text')
  const [stdin, setStdin] = useState('')
  const [consoleError, setConsoleError] = useState<string | null>(null)
  const [consoleNotice, setConsoleNotice] = useState<string | null>(null)
  const [processes, setProcesses] = useState<Array<Record<string, unknown>>>([])
  const [selectedPid, setSelectedPid] = useState<string | null>(null)
  const [stream, setStream] = useState<StreamMode>('stdout')
  const [readOffset, setReadOffset] = useState('0')
  const [writeInput, setWriteInput] = useState('')
  const [confirmPrune, setConfirmPrune] = useState(false)
  const [outputText, setOutputText] = useState('')
  const [outputPreviewUrl, setOutputPreviewUrl] = useState<string | null>(null)

  // Files & Screen state
  const [filePath, setFilePath] = useState('.')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [filesNotice, setFilesNotice] = useState<string | null>(null)
  const [screenSerial, setScreenSerial] = useState('')
  const [screenUrl, setScreenUrl] = useState<string | null>(null)
  const [screenError, setScreenError] = useState<string | null>(null)
  const [screenProgress, setScreenProgress] = useState<{ readonly processId: string; readonly bytes: number } | null>(null)
  const [screenHiddenCleared, setScreenHiddenCleared] = useState(false)

  // Ephemeral wireless pairing code (visibilitychange cleared!)
  const [pairCode, setPairCode] = useState('')
  const [hiddenClearedPair, setHiddenClearedPair] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mountedRef = useRef(true)
  const dirtyRef = useRef(false)

  const revokeUrl = (url: string | null) => {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }

  const updateOutputUrl = useCallback((next: string | null) => {
    setOutputPreviewUrl(prev => {
      if (prev && prev !== next) revokeUrl(prev)
      return next
    })
  }, [])

  const updateScreenUrl = useCallback((next: string | null) => {
    setScreenUrl(prev => {
      if (prev && prev !== next) revokeUrl(prev)
      return next
    })
  }, [])

  const dirty = isConnectionDraftDirty(draft, config)
  useEffect(() => {
    dirtyRef.current = dirty
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const loadConfigurationSnapshot = useCallback(async (signal?: AbortSignal) => {
    const raw = await hostRequest<unknown>('/plugins/android-control/configuration', { signal })
    const nextConfig = readPublicConfig(raw)
    if (!nextConfig || !mountedRef.current) return
    setConfig(nextConfig)
    setDetection(nextConfig.adbEnvironment)
    if (!dirtyRef.current) {
      setDraft(draftFromConfig(nextConfig))
    }
    if (!userPickedTab.current && (!nextConfig.adbAvailable || nextConfig.configState !== 'ok' || !enabled)) {
      setTab('connection')
    }
  }, [enabled])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadConfigurationSnapshot(controller.signal).catch(() => {})
    return () => {
      controller.abort()
    }
  }, [loadConfigurationSnapshot, enabled, saved])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        abortRef.current?.abort()
        abortRef.current = null
        setPairCode(prev => {
          if (prev.length > 0) setHiddenClearedPair(true)
          return ''
        })
        updateScreenUrl(null)
        setScreenProgress(null)
        setScreenHiddenCleared(true)
        updateOutputUrl(null)
      }
    }
    const onPageHide = () => {
      abortRef.current?.abort()
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setPairCode('')
      updateScreenUrl(null)
      setScreenProgress(null)
      updateOutputUrl(null)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      onDirtyChange?.(false)
    }
  }, [onDirtyChange, updateOutputUrl, updateScreenUrl])

  const formatErr = useCallback((error: unknown): string => {
    const code = getErrorCode(error)
    const translated = t(androidErrorKey(code))
    if (translated !== t('unknownError')) return translated
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message || translated
    }
    return translated
  }, [t])

  const refreshProcesses = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !config?.ready) return
    const state = await manageAndroid('state', {}, signal)
    if (Array.isArray(state.processes) && mountedRef.current) {
      setProcesses(state.processes as Array<Record<string, unknown>>)
    }
  }, [config?.ready, enabled])

  useEffect(() => {
    if (!enabled || !config?.ready) return
    const controller = new AbortController()
    void refreshProcesses(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [enabled, config?.ready, refreshProcesses])

  const runTask = useCallback(async (
    fn: (signal: AbortSignal) => Promise<void>,
    setError: (msg: string | null) => void,
    options: { requestId?: string; skipProcessRefresh?: boolean } = {},
  ) => {
    if (busy) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    try {
      await fn(controller.signal)
      if (!options.skipProcessRefresh && enabled && config?.ready) {
        await refreshProcesses(controller.signal).catch(() => {})
      }
    } catch (error) {
      if (isAbortError(error)) return
      const msg = formatErr(error)
      if (options.requestId && isUnknownOutcomeError(error)) {
        setUnknownOutcome({ requestId: options.requestId, message: msg })
      }
      setError(msg)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (mountedRef.current) setBusy(false)
    }
  }, [busy, config?.ready, enabled, formatErr, refreshProcesses])

  const renderCommandResult = useCallback((raw: Record<string, unknown>) => {
    const { structured, textBlocks, image } = decodeToolOutput(raw)
    if (typeof structured.processId === 'string') setSelectedPid(structured.processId)
    if (typeof structured.nextOffset === 'number') setReadOffset(String(structured.nextOffset))
    if (typeof structured.text === 'string' && structured.text.length > 0) {
      setOutputText(structured.text)
    } else if (textBlocks.length > 0) {
      setOutputText(textBlocks.join('\n'))
    } else {
      setOutputText(JSON.stringify(structured, null, 2))
    }
    if (image) {
      updateOutputUrl(base64ToBlobUrl(image.mimeType, image.data))
    } else {
      updateOutputUrl(null)
    }
    return structured
  }, [updateOutputUrl])

  const handleUpdatedConfig = useCallback((
    nextConfig: PublicAndroidConfiguration | null,
    nextDetection: AdbDetectionSnapshot | null,
    nextDevices: AndroidDevicesSnapshot | null,
  ) => {
    if (nextConfig) setConfig(nextConfig)
    if (nextDetection) setDetection(nextDetection)
    else if (nextConfig?.adbEnvironment) setDetection(nextConfig.adbEnvironment)
    if (nextDevices) setDevicesSnapshot(nextDevices)
    else if (nextConfig) {
      setDevicesSnapshot({
        queried: true,
        devices: nextConfig.devices,
        activeDevice: nextConfig.activeDevice,
        onlineCount: nextConfig.devices.filter(d => d.online).length,
        deviceOnline: nextConfig.deviceOnline,
        errorCode: nextConfig.deviceCheckErrorCode,
        errorMessage: nextConfig.deviceCheckErrorMessage,
        checkedAt: '',
      })
    }
  }, [])

  const activeEnv = detection ?? config?.adbEnvironment ?? null
  const activeDevices = devicesSnapshot?.devices ?? config?.devices ?? []
  const panelBusy = busy || Boolean(connectionBusy)
  const canOperate = Boolean(!panelBusy && enabled && config?.ready)
  const operateDisabledReason = panelBusy
    ? t('unknownError')
    : !enabled
      ? t('err.PLUGIN_DISABLED')
      : !config?.ready
        ? t('disconnectedNotice')
        : undefined

  // Status pills summary
  const adbAvailable = Boolean(config?.configState === 'ok' && (activeEnv?.available ?? config?.adbAvailable))
  const adbPillText = adbAvailable
    ? t('adbStatusAvailable', {
      source: activeEnv?.source === 'manual'
        ? t('adbSourceManual')
        : activeEnv?.source === 'system'
          ? t('adbSourceSystem')
          : t('adbSourcePlugin'),
    })
    : activeEnv?.manualSpecified && !activeEnv.manualValid
      ? t('adbStatusManualInvalid')
      : t('adbStatusMissing')

  const onlineDevices = activeDevices.filter(d => d.online)
  const phonePill = useMemo(() => {
    if (config?.deviceOnline && config.activeDevice?.online) {
      const label = config.activeDevice.model ? `${config.activeDevice.serial} (${config.activeDevice.model})` : config.activeDevice.serial
      return { tone: 'online' as const, text: t('phoneStatusOnline', { device: label }) }
    }
    if (config?.deviceCheckErrorCode === 'ANDROID_DEVICE_UNAUTHORIZED') {
      return { tone: 'error' as const, text: t('phoneStatusUnauthorized', { device: config.activeDevice?.serial ?? config.defaultDevice }) }
    }
    if (config?.deviceCheckErrorCode === 'ANDROID_DEVICE_OFFLINE') {
      return { tone: 'warning' as const, text: t('phoneStatusOffline', { device: config.activeDevice?.serial ?? config.defaultDevice }) }
    }
    if (config?.deviceCheckErrorCode === 'ANDROID_DEFAULT_DEVICE_MISSING') {
      return { tone: 'warning' as const, text: t('phoneStatusMissingDefault', { device: config.defaultDevice }) }
    }
    if (onlineDevices.length > 1 && !config?.defaultDevice) {
      return { tone: 'warning' as const, text: t('phoneStatusMultiUnselected', { count: onlineDevices.length }) }
    }
    return { tone: 'idle' as const, text: t('phoneStatusNone') }
  }, [config, onlineDevices.length, formatNumber, t])

  const parsedArgv = useMemo(() => parseStringArrayJson(argvJson), [argvJson])
  const argvItems = parsedArgv.ok ? parsedArgv.items : []
  const workspacePath = config?.workspace || config?.defaultWorkspace || ''
  const parentDir = directoryListing ? parentHostPath(directoryListing.path) : null

  const listDirectory = async (targetPath: string, clearError = true) => {
    await runTask(async signal => {
      if (clearError) setFilesError(null)
      const res = await invokeAndroid('android_files', { op: 'list', path: targetPath.trim() || '.' }, signal)
      const { structured } = decodeToolOutput(res)
      const entries = Array.isArray(structured.entries)
        ? (structured.entries as Array<{ name: string; directory: boolean }>)
        : []
      setDirectoryListing({
        path: String(structured.path ?? targetPath),
        total: typeof structured.total === 'number' ? structured.total : entries.length,
        truncated: Boolean(structured.truncated),
        entries,
      })
    }, msg => setFilesError(msg), { skipProcessRefresh: true })
  }

  const uploadFile = async (signal: AbortSignal) => {
    if (!selectedFile) return
    const target = filePath.trim()
    const bytes = new Uint8Array(await selectedFile.arrayBuffer())
    let offset = 0
    if (bytes.length === 0) {
      const res = await invokeAndroid('android_files', { op: 'put', path: target, offset: 0, overwrite: true, data: '' }, signal, createRequestId())
      const { structured } = decodeToolOutput(res)
      setFilesNotice(t('uploadSucceeded', { path: String(structured.path ?? target), bytes: 0 }))
      return
    }
    let lastPath = target
    while (offset < bytes.length) {
      const slice = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES)
      const res = await invokeAndroid(
        'android_files',
        {
          op: 'put',
          path: target,
          offset,
          ...(offset === 0 ? { overwrite: true } : {}),
          data: bytesToBase64(slice),
        },
        signal,
        createRequestId(),
      )
      const { structured } = decodeToolOutput(res)
      lastPath = String(structured.path ?? target)
      offset = typeof structured.nextOffset === 'number' ? structured.nextOffset : offset + slice.length
    }
    setFilesNotice(t('uploadSucceeded', { path: lastPath, bytes: bytes.length }))
  }

  const downloadFile = async (signal: AbortSignal) => {
    const target = filePath.trim()
    const statRes = await invokeAndroid('android_files', { op: 'stat', path: target }, signal, createRequestId(), false)
    const { structured: stat } = decodeToolOutput(statRes)
    const total = typeof stat.bytes === 'number' ? stat.bytes : 0
    const resolvedPath = String(stat.path ?? target)
    const chunks: Uint8Array[] = []
    let offset = 0
    while (offset < total || (total === 0 && offset === 0)) {
      const res = await invokeAndroid(
        'android_files',
        { op: 'get', path: target, offset, limit: DOWNLOAD_CHUNK_BYTES, output: 'binary' },
        signal,
        createRequestId(),
        false,
      )
      const { structured } = decodeToolOutput(res)
      if (typeof structured.data === 'string' && structured.data.length > 0) {
        chunks.push(base64ToBytes(structured.data))
      }
      const next = typeof structured.nextOffset === 'number' ? structured.nextOffset : total
      if (next <= offset || next >= total || total === 0) break
      offset = next
    }
    const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
    let cursor = 0
    for (const c of chunks) { merged.set(c, cursor); cursor += c.length }
    const blobUrl = URL.createObjectURL(new Blob([merged.buffer as ArrayBuffer]))
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = resolvedPath.split(/[\\/]/).filter(Boolean).at(-1) || 'download.bin'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    setFilesNotice(t('downloadSucceeded', { path: resolvedPath, bytes: merged.length }))
  }

  const cancelActiveScreenshot = useCallback((processId: string) => {
    abortRef.current?.abort()
    abortRef.current = null
    setScreenProgress(null)
    void invokeAndroid('android_process_stop', { process_id: processId, signal: 'terminate' }, undefined, createRequestId(), false).catch(() => {})
  }, [])

  const captureScreenshot = async (signal: AbortSignal) => {
    setScreenHiddenCleared(false)
    setScreenProgress(null)
    const trimmed = screenSerial.trim()
    try {
      let current = decodeToolOutput(await invokeAndroid(
        'android_screenshot',
        { ...(trimmed ? { serial: trimmed } : {}), wait_ms: 15000 },
        signal,
        createRequestId(),
        true,
      ))
      let attempts = 0
      while (
        !current.image
        && current.structured.output_error === 'ANDROID_IMAGE_PENDING'
        && typeof current.structured.processId === 'string'
        && attempts < 150
      ) {
        const processId = current.structured.processId
        const bytes = typeof current.structured.stdoutBytes === 'number'
          ? current.structured.stdoutBytes
          : typeof current.structured.retainedBytes === 'number'
            ? current.structured.retainedBytes
            : 0
        if (mountedRef.current) setScreenProgress({ processId, bytes })
        await abortableDelay(1200, signal)
        attempts++
        current = decodeToolOutput(await invokeAndroid(
          'android_process_read',
          { process_id: processId, output: 'image' },
          signal,
          createRequestId(),
          true,
        ))
      }
      if (current.image) {
        updateScreenUrl(base64ToBlobUrl(current.image.mimeType, current.image.data))
      } else if (typeof current.structured.output_error === 'string') {
        const code = current.structured.output_error
        if (code === 'ANDROID_IMAGE_PENDING' && typeof current.structured.processId === 'string') {
          setSelectedPid(current.structured.processId)
        }
        setScreenError(t(androidErrorKey(code)))
      }
    } finally {
      if (mountedRef.current) setScreenProgress(null)
    }
  }

  return (
    <div className="android-panel">
      {/* Dual independent status strip (ADB environment vs Android phone) */}
      <div className="android-hero-strip" role="region" aria-label={t('name')}>
        <div className="android-status-pair">
          <div className={`android-status-card ${adbAvailable ? 'is-available' : 'is-unavailable'}`}>
            <span className="android-status-kicker">{t('adbStatusLabel')}</span>
            <strong>{adbPillText}</strong>
            {activeEnv?.version && <small><code>{activeEnv.version}</code></small>}
            {!adbAvailable && tab !== 'connection' && (
              <button
                type="button"
                className="text-button android-quick-link"
                onClick={() => { userPickedTab.current = true; setTab('connection') }}>
                {t('goSetupAdb')}
              </button>
            )}
          </div>

          <div className={`android-status-card is-${phonePill.tone}`}>
            <span className="android-status-kicker">{t('phoneStatusLabel')}</span>
            <strong>
              <Smartphone size={14} aria-hidden="true" />
              {phonePill.text}
            </strong>
            <small className="android-host-chip">
              <Laptop size={12} aria-hidden="true" />
              {t('hostMachineBadge')}
            </small>
          </div>
        </div>
      </div>

      {unknownOutcome && (
        <UnknownOutcomeCard
          body={unknownOutcome.message}
          requestId={unknownOutcome.requestId}
          confirmLabel={t('unknownAckBtn')}
          onConfirmReviewed={() => setUnknownOutcome(null)}
        />
      )}

      <SegmentedTabs<PanelTab>
        ariaLabel={t('name')}
        idPrefix={`${prefix}-tabs`}
        activeTab={tab}
        onSelect={next => { userPickedTab.current = true; setTab(next) }}
        tabs={[
          { id: 'console', label: t('tabConsole') },
          { id: 'files-screen', label: t('tabFilesScreen') },
          { id: 'connection', label: t('tabConnection'), dirty },
        ]}
      />

      {/* Tab 1: Console & Processes */}
      <div
        id={`${prefix}-tabs-panel-console`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tabs-tab-console`}
        hidden={tab !== 'console'}
        className="android-tab-panel">
        <div className="android-context-bar">
          <span className="android-workspace-chip">
            <Cpu size={13} aria-hidden="true" />
            {config?.defaultDevice
              ? t('activeTargetChip', { device: config.defaultDevice })
              : t('activeTargetUnset', { count: onlineDevices.length })}
          </span>
        </div>

        <section className="android-block" aria-labelledby={`${prefix}-exec`}>
          <div className="android-block-heading">
            <div>
              <h3 id={`${prefix}-exec`}>{t('execTitle')}</h3>
              <p>{t('execHelp')}</p>
            </div>
          </div>

          <div className="android-presets">
            <button type="button" className="text-button" disabled={busy} onClick={() => setArgvJson('["devices","-l"]')}>{t('presetDevices')}</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setArgvJson('["version"]')}>{t('presetVersion')}</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setArgvJson('["shell","getprop","ro.product.model"]')}>{t('presetProp')}</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => { setArgvJson('["exec-out","screencap","-p"]'); setOutputMode('image') }}>{t('presetScreencap')}</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => { setArgvJson('["logcat","-v","time"]'); setWaitMs('1000') }}>{t('presetLogcat')}</button>
          </div>

          <div className="android-field">
            <label htmlFor={`${prefix}-exec-serial`}>{t('serialLabel')}</label>
            <input
              id={`${prefix}-exec-serial`}
              list={`${prefix}-serials`}
              aria-label={t('serialLabel')}
              value={execSerial}
              placeholder={config?.defaultDevice || t('serialPlaceholder')}
              disabled={busy}
              onChange={e => setExecSerial(e.target.value)}
            />
            <datalist id={`${prefix}-serials`}>
              {activeDevices.map(d => <option key={d.serial} value={d.serial} />)}
            </datalist>
          </div>

          <div className="android-field">
            <label htmlFor={`${prefix}-argv`}>{t('argvLabel')}</label>
            <StringListEditor
              id={`${prefix}-argv`}
              aria-label={t('argvLabel')}
              jsonText={argvJson}
              onJsonTextChange={setArgvJson}
              placeholder={t('argvPlaceholder')}
              disabled={busy}
            />
          </div>

          <div className="android-fields">
            <div className="android-field">
              <label htmlFor={`${prefix}-wait`}>{t('waitMsLabel')}</label>
              <input
                id={`${prefix}-wait`}
                type="number"
                min={0}
                max={30000}
                value={waitMs}
                disabled={busy}
                onChange={e => setWaitMs(e.target.value)}
              />
            </div>
            <div className="android-field">
              <label htmlFor={`${prefix}-output-mode`}>{t('outputModeLabel')}</label>
              <select
                id={`${prefix}-output-mode`}
                value={outputMode}
                disabled={busy}
                onChange={e => setOutputMode(e.target.value as OutputMode)}>
                <option value="text">{t('outputText')}</option>
                <option value="binary">{t('outputBinary')}</option>
                <option value="image">{t('outputImage')}</option>
              </select>
            </div>
          </div>

          <label className="android-checkbox-row">
            <input type="checkbox" checked={terminal} disabled={busy} onChange={e => setTerminal(e.target.checked)} />
            <span>{t('terminalLabel')}</span>
          </label>

          <div className="android-field">
            <label htmlFor={`${prefix}-stdin`}>{t('stdinLabel')}</label>
            <textarea
              id={`${prefix}-stdin`}
              rows={2}
              value={stdin}
              disabled={busy}
              onChange={e => setStdin(e.target.value)}
            />
          </div>

          <div className="android-actions">
            <ActionButton
              type="button"
              className="button button-primary"
              disabled={!canOperate || !parsedArgv.ok || argvItems.length === 0}
              reason={operateDisabledReason}
              onClick={() => {
                const reqId = createRequestId()
                setConsoleNotice(null)
                void runTask(async signal => {
                  const res = await invokeAndroid(
                    'android_adb_exec',
                    {
                      args: [...argvItems],
                      ...(execSerial.trim() ? { serial: execSerial.trim() } : {}),
                      ...(stdin ? { stdin } : {}),
                      terminal,
                      wait_ms: Math.max(0, Math.min(30000, Number(waitMs) || 5000)),
                      output: outputMode,
                    },
                    signal,
                    reqId,
                  )
                  const structured = renderCommandResult(res)
                  setConsoleNotice(t('commandDone', { status: String(structured.status ?? 'ok') }))
                }, msg => setConsoleError(msg), { requestId: reqId })
              }}>
              <Play size={14} aria-hidden="true" />
              {t('runCommand')}
            </ActionButton>

            <ActionButton
              type="button"
              className="button button-secondary"
              disabled={!canOperate}
              reason={operateDisabledReason}
              onClick={() => void runTask(async signal => { await refreshProcesses(signal) }, msg => setConsoleError(msg), { skipProcessRefresh: true })}>
              <RefreshCw size={14} aria-hidden="true" />
              {t('refreshState')}
            </ActionButton>

            <ActionButton
              type="button"
              className="button button-secondary"
              disabled={!canOperate}
              reason={operateDisabledReason}
              onClick={() => void runTask(async signal => { await manageAndroid('takeover', {}, signal) }, msg => setConsoleError(msg))}>
              {t('takeoverBtn')}
            </ActionButton>
          </div>

          {consoleError && (
            <div className="android-feedback is-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{consoleError}</span>
            </div>
          )}
          {consoleNotice && (
            <div className="android-feedback is-success" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>{consoleNotice}</span>
            </div>
          )}
        </section>

        <div className="android-console-grid">
          <section className="android-block" aria-labelledby={`${prefix}-processes`}>
            <div className="android-block-heading">
              <div>
                <h3 id={`${prefix}-processes`}>{t('processesTitle')}</h3>
                <p>{t('processesHelp')}</p>
              </div>
              <ActionButton
                type="button"
                className="text-button"
                disabled={!canOperate || processes.length === 0}
                reason={operateDisabledReason ?? (processes.length === 0 ? t('noProcesses') : undefined)}
                onClick={() => setConfirmPrune(true)}>
                <Trash2 size={14} aria-hidden="true" />
                {t('pruneBtn')}
              </ActionButton>
            </div>

            {confirmPrune && (
              <InlineConfirm
                open
                variant="danger"
                title={t('confirmPruneTitle')}
                description={t('confirmPruneBody')}
                confirmLabel={t('pruneBtn')}
                cancelLabel={t('cancel')}
                busy={busy}
                onCancel={() => setConfirmPrune(false)}
                onConfirm={() => void runTask(async signal => {
                  await manageAndroid('prune', { confirmed: true }, signal)
                  setConfirmPrune(false)
                  setSelectedPid(null)
                }, msg => setConsoleError(msg))}
              />
            )}

            {processes.length === 0 ? (
              <p className="android-muted-copy">{t('noProcesses')}</p>
            ) : (
              <ul className="android-processes">
                {processes.map(p => {
                  const pid = String(p.processId)
                  const status = String(p.status)
                  const isSelected = selectedPid === pid
                  const statusKey = (`status.${status}`) as AndroidTranslationKey
                  const validStatus = ['status.queued', 'status.running', 'status.exited', 'status.unknown', 'status.failed'].includes(statusKey)
                  return (
                    <li key={pid}>
                      <button
                        type="button"
                        className={`android-process-row${isSelected ? ' is-selected' : ''}`}
                        aria-pressed={isSelected}
                        disabled={busy}
                        onClick={() => {
                          setSelectedPid(pid)
                          void runTask(
                            async signal => { renderCommandResult(await invokeAndroid('android_process_read', { process_id: pid, stream }, signal, createRequestId(), true)) },
                            msg => setConsoleError(msg),
                            { skipProcessRefresh: true },
                          )
                        }}>
                        <span className="android-process-head">
                          <code>{pid.slice(0, 8)}</code>
                          <span className={`android-badge android-status-${status}`}>{validStatus ? t(statusKey) : status}</span>
                          {p.terminal === true && <span className="android-badge">{t('processTerminalTag')}</span>}
                          {p.exitCode !== null && p.exitCode !== undefined && (
                            <span className="android-badge">{t('processExitTag', { code: String(p.exitCode) })}</span>
                          )}
                        </span>
                        <span className="android-process-meta">
                          {typeof p.createdAt === 'string' && <time dateTime={p.createdAt}>{formatDateTime(p.createdAt)}</time>}
                          {typeof p.stdoutBytes === 'number' && typeof p.stderrBytes === 'number' && (
                            <span>{t('processBytesTag', { out: formatNumber(p.stdoutBytes), err: formatNumber(p.stderrBytes) })}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="android-block" aria-labelledby={`${prefix}-read-proc`}>
            <div className="android-block-heading">
              <div>
                <h3 id={`${prefix}-read-proc`}>{t('readProcessTitle')}</h3>
              </div>
            </div>

            <div className="android-fields">
              <div className="android-field">
                <label htmlFor={`${prefix}-stream`}>{t('streamLabel')}</label>
                <select id={`${prefix}-stream`} value={stream} disabled={busy} onChange={e => setStream(e.target.value as StreamMode)}>
                  <option value="stdout">stdout</option>
                  <option value="stderr">stderr</option>
                </select>
              </div>
              <div className="android-field">
                <label htmlFor={`${prefix}-offset`}>{t('offsetLabel')}</label>
                <input id={`${prefix}-offset`} type="number" min={0} value={readOffset} disabled={busy} onChange={e => setReadOffset(e.target.value)} />
              </div>
            </div>

            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !selectedPid}
                reason={operateDisabledReason ?? (!selectedPid ? t('selectProcessHint') : undefined)}
                onClick={() => void runTask(async signal => {
                  renderCommandResult(await invokeAndroid('android_process_read', {
                    process_id: selectedPid!,
                    stream,
                    offset: Math.max(0, Number(readOffset) || 0),
                    output: outputMode,
                  }, signal, createRequestId(), true))
                }, msg => setConsoleError(msg), { skipProcessRefresh: true })}>
                {t('readOutputBtn')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !selectedPid}
                reason={operateDisabledReason ?? (!selectedPid ? t('selectProcessHint') : undefined)}
                onClick={() => void runTask(async signal => {
                  renderCommandResult(await invokeAndroid('android_process_stop', { process_id: selectedPid!, signal: 'interrupt' }, signal))
                }, msg => setConsoleError(msg))}>
                {t('sendCtrlCBtn')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-danger"
                disabled={!canOperate || !selectedPid}
                reason={operateDisabledReason ?? (!selectedPid ? t('selectProcessHint') : undefined)}
                onClick={() => void runTask(async signal => {
                  renderCommandResult(await invokeAndroid('android_process_stop', { process_id: selectedPid!, signal: 'terminate' }, signal))
                }, msg => setConsoleError(msg))}>
                <Square size={12} aria-hidden="true" />
                {t('terminateBtn')}
              </ActionButton>
            </div>

            <div className="android-field">
              <label htmlFor={`${prefix}-write-in`}>{t('writeInputLabel')}</label>
              <textarea id={`${prefix}-write-in`} rows={2} value={writeInput} disabled={busy} onChange={e => setWriteInput(e.target.value)} />
            </div>

            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={!canOperate || !selectedPid}
                reason={operateDisabledReason ?? (!selectedPid ? t('selectProcessHint') : undefined)}
                onClick={() => void runTask(async signal => {
                  renderCommandResult(await invokeAndroid('android_process_write', { process_id: selectedPid!, data: writeInput }, signal))
                }, msg => setConsoleError(msg))}>
                {t('sendStdinBtn')}
              </ActionButton>
              <ActionButton
                type="button"
                className="text-button"
                disabled={!canOperate || !selectedPid}
                reason={operateDisabledReason ?? (!selectedPid ? t('selectProcessHint') : undefined)}
                onClick={() => void runTask(async signal => {
                  renderCommandResult(await invokeAndroid('android_process_write', { process_id: selectedPid!, eof: true }, signal))
                }, msg => setConsoleError(msg))}>
                {t('sendEofBtn')}
              </ActionButton>
            </div>

            {outputPreviewUrl && (
              <div className="android-screen-stage">
                <img src={outputPreviewUrl} alt={t('screenshotAlt')} className="android-screen" />
              </div>
            )}
            <pre className="android-output-pre">{outputText || t('outputDisplayEmpty')}</pre>
          </section>
        </div>
      </div>

      {/* Tab 2: Files & Screenshot */}
      <div
        id={`${prefix}-tabs-panel-files-screen`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tabs-tab-files-screen`}
        hidden={tab !== 'files-screen'}
        className="android-tab-panel">
        <div className="android-files-screen-grid">
          <section className="android-block" aria-labelledby={`${prefix}-files`}>
            <div className="android-block-heading">
              <div>
                <h3 id={`${prefix}-files`}>{t('filesTitle')}</h3>
                <p>{t('filesHelp')}</p>
              </div>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate}
                reason={operateDisabledReason}
                onClick={() => void listDirectory('.', true)}>
                <FolderOpen size={15} aria-hidden="true" />
                {t('listWorkspaceBtn')}
              </ActionButton>
            </div>

            {workspacePath && (
              <p className="android-workspace-chip">
                <Laptop size={13} aria-hidden="true" />
                <span>{t('hostFilesChip', { workspace: workspacePath })}</span>
              </p>
            )}

            <div className="android-field">
              <label htmlFor={`${prefix}-path`}>{t('filePathLabel')}</label>
              <input
                id={`${prefix}-path`}
                aria-label={t('filePathLabel')}
                value={filePath}
                placeholder={t('filePathPlaceholder')}
                disabled={busy}
                onChange={e => setFilePath(e.target.value)}
              />
            </div>

            <div className="android-field android-file-field">
              <div
                className={`android-dropzone${dragOver ? ' is-dragging' : ''}${selectedFile ? ' has-file' : ''}`}
                onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault()
                  setDragOver(false)
                  if (!busy) setSelectedFile(e.dataTransfer.files?.[0] ?? null)
                }}>
                <input
                  ref={fileInputRef}
                  id={`${prefix}-file`}
                  className="android-file-input"
                  type="file"
                  aria-label={t('pickUploadFile')}
                  disabled={busy}
                  onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
                />
                <Upload size={20} aria-hidden="true" />
                <strong>{selectedFile ? t('selectedFileLabel', { name: selectedFile.name, size: formatByteSize(selectedFile.size) }) : t('pickUploadFile')}</strong>
              </div>
              {selectedFile && (
                <div className="android-file-chip-row">
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}>
                    <X size={14} aria-hidden="true" />
                    {t('clearFileBtn')}
                  </button>
                </div>
              )}
            </div>

            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={!canOperate || !filePath.trim() || !selectedFile}
                reason={operateDisabledReason}
                onClick={() => void runTask(uploadFile, msg => setFilesError(msg), { skipProcessRefresh: true })}>
                {t('uploadBtn')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !filePath.trim()}
                reason={operateDisabledReason}
                onClick={() => void runTask(downloadFile, msg => setFilesError(msg), { skipProcessRefresh: true })}>
                {t('downloadBtn')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !filePath.trim()}
                reason={operateDisabledReason}
                onClick={() => void listDirectory(filePath, false)}>
                {t('listDirBtn')}
              </ActionButton>
            </div>

            {filesError && (
              <div className="android-feedback is-error" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <span>{filesError}</span>
              </div>
            )}
            {filesNotice && (
              <div className="android-feedback is-success" role="status">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>{filesNotice}</span>
              </div>
            )}

            {directoryListing && (
              <div className="android-dir-card">
                <div className="android-dir-head">
                  <div>
                    <strong>{t('dirTitle')}</strong>
                    <code>{directoryListing.path}</code>
                  </div>
                  <div className="android-dir-meta">
                    <span>
                      {t('dirCount', { total: directoryListing.total })}
                      {directoryListing.truncated ? t('dirTruncated', { shown: directoryListing.entries.length }) : ''}
                    </span>
                    {parentDir && (
                      <ActionButton type="button" className="text-button" disabled={!canOperate} reason={operateDisabledReason} onClick={() => void listDirectory(parentDir, true)}>
                        <ArrowUp size={14} aria-hidden="true" />
                        {t('dirParent')}
                      </ActionButton>
                    )}
                  </div>
                </div>
                {directoryListing.entries.length === 0 ? (
                  <p className="android-muted-copy">{t('dirEmpty')}</p>
                ) : (
                  <ul className="android-dir-list">
                    {directoryListing.entries.map(entry => {
                      const entryPath = joinHostPath(directoryListing.path, entry.name)
                      return (
                        <li key={entry.name}>
                          <button
                            type="button"
                            className={`android-dir-row${filePath.trim() === entryPath ? ' is-selected' : ''}`}
                            disabled={!canOperate}
                            onClick={() => {
                              if (entry.directory) void listDirectory(entryPath, true)
                              else setFilePath(entryPath)
                            }}>
                            {entry.directory ? <Folder size={15} aria-hidden="true" /> : <FileIcon size={15} aria-hidden="true" />}
                            <span className="android-dir-name">{entry.name}</span>
                            <span className="android-badge">{t(entry.directory ? 'dirTypeDir' : 'dirTypeFile')}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="android-block" aria-labelledby={`${prefix}-screen`}>
            <div className="android-block-heading">
              <div>
                <h3 id={`${prefix}-screen`}>{t('screenshotTitle')}</h3>
                <p>{t('screenshotHelp')}</p>
              </div>
            </div>

            <div className="android-field">
              <label htmlFor={`${prefix}-screen-serial`}>{t('serialLabel')}</label>
              <input
                id={`${prefix}-screen-serial`}
                list={`${prefix}-serials`}
                aria-label={t('serialLabel')}
                value={screenSerial}
                placeholder={config?.defaultDevice || t('serialPlaceholder')}
                disabled={busy}
                onChange={e => setScreenSerial(e.target.value)}
              />
            </div>

            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={!canOperate}
                reason={operateDisabledReason}
                onClick={() => void runTask(captureScreenshot, msg => setScreenError(msg), { skipProcessRefresh: true })}>
                <Camera size={15} aria-hidden="true" />
                {t('captureBtn')}
              </ActionButton>
              {screenProgress && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => cancelActiveScreenshot(screenProgress.processId)}>
                  <Square size={14} aria-hidden="true" />
                  {t('cancelScreenshotBtn')}
                </button>
              )}
            </div>

            {screenProgress && (
              <div className="android-feedback is-info" role="status">
                <RefreshCw size={15} aria-hidden="true" />
                <span>{t('screenshotPendingProgress', { size: formatByteSize(screenProgress.bytes), pid: screenProgress.processId.slice(0, 8) })}</span>
              </div>
            )}
            {screenError && (
              <div className="android-feedback is-error" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <span>{screenError}</span>
              </div>
            )}
            {screenHiddenCleared && !screenUrl && (
              <div className="android-feedback is-info" role="status">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>{t('screenshotHiddenCleared')}</span>
              </div>
            )}

            <div className="android-screen-stage">
              {screenUrl ? (
                <img src={screenUrl} alt={t('screenshotAlt')} className="android-screen" />
              ) : (
                <div className="android-screen-empty">
                  <Smartphone size={26} aria-hidden="true" />
                  <span>{t('screenshotEmpty')}</span>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Tab 3: ADB & Device Connection */}
      <div
        id={`${prefix}-tabs-panel-connection`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tabs-tab-connection`}
        hidden={tab !== 'connection'}
        className="android-tab-panel">
        <ConnectionTab
          enabled={enabled}
          busy={panelBusy}
          config={config}
          detection={detection}
          devicesSnapshot={devicesSnapshot}
          draft={draft}
          setDraft={setDraft}
          hiddenClearedPair={hiddenClearedPair}
          pairCode={pairCode}
          setPairCode={setPairCode}
          clearHiddenNotice={() => setHiddenClearedPair(false)}
          runTask={(fn, setErr) => runTask(fn, setErr, { skipProcessRefresh: true })}
          onUpdated={handleUpdatedConfig}
          onRefresh={onRefresh ?? (async () => {})}
          onFeedback={onFeedback}
        />
      </div>
    </div>
  )
}
