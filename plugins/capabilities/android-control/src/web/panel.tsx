import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowUp, CheckCircle2, File as FileIcon, Folder, FolderOpen,
  ImageOff, Plug, RefreshCw, Terminal, Trash2, Upload, X,
} from 'lucide-react'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import {
  ActionButton, FormSaveBar, HostApiError, InlineConfirm, PasswordInput,
  SegmentedTabs, StringListEditor, UnknownOutcomeCard, createRequestId, hostRequest,
  parseStringArrayJson, useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { PublicAndroidConfiguration } from '../types'
import { at } from './i18n'
import type { AndroidTranslationKey } from './i18n'
import './panel.css'

type PanelTab = 'console' | 'files-screen' | 'connection'

interface Draft {
  readonly mode: 'local' | 'remote'
  readonly adbPath: string
  readonly workspace: string
  readonly endpoint: string
  readonly token: string
  readonly clear: boolean
}

interface DirectoryEntry {
  readonly name: string
  readonly directory: boolean
}

interface DirectoryListing {
  readonly path: string
  readonly entries: readonly DirectoryEntry[]
  readonly total: number
  readonly nextOffset: number
  readonly truncated: boolean
}

const draftOf = (c: PublicAndroidConfiguration): Draft => ({
  mode: c.mode,
  adbPath: c.adbPath,
  workspace: c.workspace,
  endpoint: c.endpoint,
  token: '',
  clear: false,
})

function isConfigDirty(draft: Draft | null, config: PublicAndroidConfiguration | null): boolean {
  if (!draft || !config) return false
  return (
    draft.mode !== config.mode ||
    draft.adbPath !== config.adbPath ||
    draft.workspace !== config.workspace ||
    draft.endpoint !== config.endpoint ||
    draft.token.length > 0 ||
    draft.clear
  )
}

function configOf(v: unknown): PublicAndroidConfiguration {
  if (
    !isJsonObject(v) ||
    v.schemaVersion !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    (v.mode !== 'local' && v.mode !== 'remote') ||
    !['adbPath', 'workspace', 'endpoint'].every(key => typeof v[key] === 'string') ||
    typeof v.tokenConfigured !== 'boolean' ||
    typeof v.ready !== 'boolean'
  ) {
    throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
  }
  return v as unknown as PublicAndroidConfiguration
}

function structured(v: unknown): JsonObject {
  if (!isJsonObject(v)) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
  if (isJsonObject(v.structuredContent)) return v.structuredContent
  return v
}

function directoryFromMeta(meta: JsonObject): DirectoryListing | null {
  if (
    typeof meta.path !== 'string' ||
    !Array.isArray(meta.entries) ||
    typeof meta.total !== 'number' ||
    !Number.isSafeInteger(meta.total) ||
    typeof meta.nextOffset !== 'number' ||
    !Number.isSafeInteger(meta.nextOffset) ||
    typeof meta.truncated !== 'boolean'
  ) {
    return null
  }
  const entries: DirectoryEntry[] = []
  for (const item of meta.entries) {
    if (!isJsonObject(item) || typeof item.name !== 'string' || typeof item.directory !== 'boolean') return null
    entries.push({ name: item.name, directory: item.directory })
  }
  return {
    path: meta.path,
    entries,
    total: meta.total,
    nextOffset: meta.nextOffset,
    truncated: meta.truncated,
  }
}

const manage = (operation: string, input: object, signal: AbortSignal) =>
  hostRequest<unknown>('/plugins/android-control/manage', { method: 'POST', body: { operation, input }, signal })

function bytesFrom(data: string): Uint8Array<ArrayBuffer> {
  const text = atob(data)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  }
  return btoa(text)
}

function detectSeparator(value: string): string {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/'
}

function joinExecutorPath(base: string, entry: string): string {
  const trimmed = base.trim()
  if (!trimmed || trimmed === '.') return entry
  const sep = detectSeparator(trimmed)
  if (trimmed === '/' || /^[A-Za-z]:\\?$/.test(trimmed)) {
    return trimmed.endsWith(sep) ? `${trimmed}${entry}` : `${trimmed}${sep}${entry}`
  }
  const clean = trimmed.replace(/[\\/]+$/, '')
  return `${clean}${sep}${entry}`
}

function parentExecutorPath(base: string): string | null {
  const trimmed = base.trim().replace(/[\\/]+$/, '')
  if (!trimmed || trimmed === '.' || trimmed === '/' || /^[A-Za-z]:$/.test(trimmed)) return null
  const sepIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (sepIndex < 0) return '.'
  if (sepIndex === 0) return '/'
  const prefix = trimmed.slice(0, sepIndex)
  return /^[A-Za-z]:$/.test(prefix) ? `${prefix}${detectSeparator(trimmed)}` : prefix
}

function errorCode(error: unknown): AndroidTranslationKey {
  if (error instanceof Error && error.message === 'invalidArgs') return 'invalidArgs'
  if (error instanceof HostApiError) {
    if (error.code === 'ANDROID_REMOTE_STOP_UNKNOWN') return 'remoteStopUnknown'
    if (error.outcome === 'unknown') return 'unknown'
    if (error.code === 'ANDROID_CONFIGURATION_CONFLICT') return 'conflict'
    if (error.code === 'ANDROID_EXECUTOR_BUSY') return 'busy'
    if (error.code === 'ANDROID_ADB_NOT_FOUND') return 'notFound'
    if (error.code === 'ANDROID_STOP_FIRST') return 'stopFirst'
    if (error.code === 'ANDROID_RESPONSE_INVALID') return 'invalidResponse'
  }
  return 'error'
}

export function AndroidPanel({ enabled, saved, onRefresh, onDirtyChange, connectionBusy = false }: PluginPanelProps) {
  const { t, formatDateTime, formatNumber } = useI18n('android-control')
  const prefix = useId()
  const [tab, setTab] = useState<PanelTab>('console')

  const [config, setConfig] = useState<PublicAndroidConfiguration | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [hiddenClearedNotice, setHiddenClearedNotice] = useState(false)
  const [configConflict, setConfigConflict] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [configNotice, setConfigNotice] = useState<string | null>(null)
  const [confirmReconnect, setConfirmReconnect] = useState(false)

  const [argv, setArgv] = useState('["devices", "-l"]')
  const [terminal, setTerminal] = useState(false)
  const [stdin, setStdin] = useState('')
  const [serial, setSerial] = useState('')
  const [processes, setProcesses] = useState<JsonObject[]>([])
  const [workspacePath, setWorkspacePath] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout')
  const [lastMeta, setLastMeta] = useState<JsonObject | null>(null)
  const [confirmPrune, setConfirmPrune] = useState(false)
  const [consoleError, setConsoleError] = useState<string | null>(null)
  const [unknownSubmit, setUnknownSubmit] = useState<{ requestId: string | null } | null>(null)

  const [path, setPath] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [filesNotice, setFilesNotice] = useState<string | null>(null)
  const [image, setImage] = useState<string | null>(null)

  const [pending, setPending] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)

  const cursors = useRef<Record<string, number>>({})
  const writeIdentity = useRef<{ intent: string; id: string } | null>(null)
  const identity = useRef<{ intent: string; id: string } | null>(null)
  const uploadIdentity = useRef<{ file: File; path: string; offset: number; id: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pruneConfirmRef = useRef<HTMLDivElement | null>(null)
  const reconnectConfirmRef = useRef<HTMLDivElement | null>(null)
  const alive = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const mutation = useRef<AbortController | null>(null)
  const imageRef = useRef<string | null>(null)
  const enabledRef = useRef(enabled)
  const readyRef = useRef(false)
  const callbacks = useRef({ onRefresh, onDirtyChange })

  enabledRef.current = enabled
  readyRef.current = config?.ready === true
  callbacks.current = { onRefresh, onDirtyChange }

  const dirty = isConfigDirty(draft, config)
  const parsedArgs = useMemo(() => parseStringArrayJson(argv), [argv])
  const argsValid = parsedArgs.ok && parsedArgs.items.length > 0

  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  const hostReady = saved?.values.ready === true
  useEffect(() => {
    setConfig(current => (current ? { ...current, ready: hostReady } : current))
  }, [hostReady])

  useEffect(() => {
    if (!confirmPrune) return
    requestAnimationFrame(() => { pruneConfirmRef.current?.querySelector('button')?.focus() })
  }, [confirmPrune])

  useEffect(() => {
    if (!confirmReconnect) return
    requestAnimationFrame(() => { reconnectConfirmRef.current?.querySelector('button')?.focus() })
  }, [confirmReconnect])

  const clearImage = useCallback(() => {
    if (imageRef.current) URL.revokeObjectURL(imageRef.current)
    imageRef.current = null
    if (alive.current) setImage(null)
  }, [])

  const clearFile = useCallback(() => {
    uploadIdentity.current = null
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (alive.current) setFile(null)
  }, [])

  const read = useCallback(async (onError: (key: AndroidTranslationKey) => void, callback: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      await callback(controller.signal)
    } catch (e) {
      if (alive.current && !controller.signal.aborted) onError(errorCode(e))
    } finally {
      requests.current.delete(controller)
    }
  }, [])

  const load = useCallback(async (resetErrors = true) => {
    await read(
      key => { if (alive.current) setConfigError(at(key)) },
      async signal => {
        const value = configOf(await hostRequest('/plugins/android-control/configuration', { signal }))
        if (!alive.current || signal.aborted) return
        setConfig(value)
        setDraft(draftOf(value))
        setHiddenClearedNotice(false)
        setConfigConflict(false)
        setConfirmReconnect(false)
        if (resetErrors) setConfigError(null)
      },
    )
  }, [read])

  const refreshProcesses = useCallback(async () => {
    if (!enabledRef.current || !readyRef.current || document.hidden) return
    await read(
      key => { if (alive.current) setConsoleError(at(key)) },
      async signal => {
        const value = structured(await manage('state', {}, signal))
        if (
          !Array.isArray(value.processes) ||
          value.processes.some(p => !isJsonObject(p) || typeof p.processId !== 'string' || typeof p.status !== 'string')
        ) {
          throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
        }
        if (!alive.current || signal.aborted) return
        setProcesses(value.processes as JsonObject[])
        if (typeof value.workspace === 'string' && value.workspace) setWorkspacePath(value.workspace)
      },
    )
  }, [read])

  useEffect(() => {
    alive.current = true
    void load()
    const handleVisibilityOrPageHide = (event: Event) => {
      const hidden = document.hidden || event.type === 'pagehide'
      setVisible(!hidden)
      if (!hidden) return
      requests.current.forEach(c => c.abort())
      requests.current.clear()
      mutation.current?.abort()
      mutation.current = null
      setPending(false)
      setConfirmPrune(false)
      setConfirmReconnect(false)
      clearImage()
      setOutput('')
      setLastMeta(null)
      setProcesses([])
      setDirectoryListing(null)
      setWorkspacePath('')
      cursors.current = {}
      setDraft(current => {
        if (!current) return null
        if (current.token.length > 0) setHiddenClearedNotice(true)
        return current.token.length > 0 ? { ...current, token: '' } : current
      })
      if (event.type === 'pagehide') clearFile()
    }
    document.addEventListener('visibilitychange', handleVisibilityOrPageHide)
    window.addEventListener('pagehide', handleVisibilityOrPageHide)
    return () => {
      alive.current = false
      requests.current.forEach(c => c.abort())
      requests.current.clear()
      mutation.current?.abort()
      mutation.current = null
      if (imageRef.current) URL.revokeObjectURL(imageRef.current)
      imageRef.current = null
      uploadIdentity.current = null
      document.removeEventListener('visibilitychange', handleVisibilityOrPageHide)
      window.removeEventListener('pagehide', handleVisibilityOrPageHide)
    }
  }, [load, clearImage, clearFile])

  useEffect(() => {
    if (!enabled) {
      requests.current.forEach(c => c.abort())
      requests.current.clear()
      mutation.current?.abort()
      mutation.current = null
      setPending(false)
      setConfirmPrune(false)
      setConfirmReconnect(false)
      clearImage()
      clearFile()
      setProcesses([])
      setDirectoryListing(null)
      setWorkspacePath('')
      setOutput('')
      setLastMeta(null)
      cursors.current = {}
      return
    }
    if (!visible || !config?.ready) {
      if (!config?.ready) {
        setProcesses([])
        clearImage()
      }
      return
    }
    void refreshProcesses()
    const timer = setInterval(() => { void refreshProcesses() }, 2000)
    return () => clearInterval(timer)
  }, [enabled, visible, config?.ready, refreshProcesses, clearImage, clearFile])

  async function action(
    onError: (key: AndroidTranslationKey) => void,
    callback: (signal: AbortSignal) => Promise<void>,
    options?: { readonly skipProcessRefresh?: boolean },
  ) {
    if (mutation.current || document.hidden) return
    const controller = new AbortController()
    mutation.current = controller
    setPending(true)
    setConfigError(null)
    setConfigNotice(null)
    setConsoleError(null)
    setFilesError(null)
    setFilesNotice(null)
    try {
      await callback(controller.signal)
      if (alive.current && !controller.signal.aborted && !options?.skipProcessRefresh) {
        await refreshProcesses()
      }
    } catch (e) {
      if (alive.current && !controller.signal.aborted) {
        onError(errorCode(e))
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (alive.current) setPending(false)
    }
  }

  function display(value: unknown, append = false, target: 'console' | 'image' = 'console') {
    const meta = structured(value)
    const hasImage = isJsonObject(value) && Array.isArray(value.content) && value.content.some(b => isJsonObject(b) && b.type === 'image')
    if (target === 'console' && !hasImage) {
      const textValue = typeof meta.text === 'string' ? meta.text : JSON.stringify(meta, null, 2)
      setOutput(previous => (append ? previous + textValue : textValue).slice(-262144))
      setLastMeta(meta)
    }
    if (typeof meta.processId === 'string' && typeof meta.stream === 'string' && typeof meta.nextOffset === 'number') {
      cursors.current[meta.processId + '.' + meta.stream] = meta.nextOffset
    }
    if (typeof meta.processId === 'string') setSelected(meta.processId)
    if (isJsonObject(value) && Array.isArray(value.content)) {
      const block = value.content.find(b => isJsonObject(b) && b.type === 'image')
      if (isJsonObject(block) && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        clearImage()
        const url = URL.createObjectURL(new Blob([bytesFrom(block.data)], { type: block.mimeType }))
        imageRef.current = url
        setImage(url)
      }
    }
  }

  async function invoke(name: string, args: JsonObject, signal: AbortSignal, requestId?: string, readOnly = false): Promise<unknown> {
    const automatic = requestId === undefined && !readOnly
    if (automatic) {
      const intent = JSON.stringify([name, args])
      if (writeIdentity.current?.intent !== intent) writeIdentity.current = { intent, id: createRequestId() }
      requestId = writeIdentity.current.id
    }
    requestId ??= createRequestId()
    try {
      const value = await hostRequest<unknown>('/plugins/android-control/invoke', {
        method: 'POST',
        body: {
          name,
          arguments: { ...args, ...(!readOnly ? { request_id: requestId } : {}) },
          requestId,
          confirmed: !readOnly,
        },
        signal,
      })
      if (!isJsonObject(value) || value.ok !== true || !Object.hasOwn(value, 'result')) {
        throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'unknown')
      }
      if (automatic) writeIdentity.current = null
      setUnknownSubmit(null)
      return value.result
    } catch (err) {
      if (err instanceof HostApiError && err.outcome === 'unknown') {
        if (alive.current && !signal.aborted) setUnknownSubmit({ requestId })
        throw err
      }
      if (automatic) writeIdentity.current = null
      throw err
    }
  }

  async function run(signal: AbortSignal) {
    if (!parsedArgs.ok || parsedArgs.items.length === 0) throw new Error('invalidArgs')
    const args = [...parsedArgs.items]
    const intent = JSON.stringify([args, terminal])
    if (identity.current?.intent !== intent) identity.current = { intent, id: createRequestId() }
    try {
      const value = await invoke('android_adb_exec', { args, terminal }, signal, identity.current.id)
      if (alive.current && !signal.aborted) {
        display(value)
        identity.current = null
      }
    } catch (err) {
      if (!(err instanceof HostApiError && err.outcome === 'unknown')) identity.current = null
      throw err
    }
  }

  async function postConfiguration(signal: AbortSignal, currentConfig: PublicAndroidConfiguration, currentDraft: Draft) {
    const value = configOf(await hostRequest('/plugins/android-control/configuration', {
      method: 'POST',
      body: {
        expectedRevision: currentConfig.revision,
        mode: currentDraft.mode,
        adbPath: currentDraft.adbPath,
        workspace: currentDraft.workspace,
        endpoint: currentDraft.endpoint,
        token: currentDraft.token,
        clearToken: currentDraft.clear,
      },
      signal,
    }))
    return value
  }

  async function saveOnly(signal: AbortSignal) {
    if (!config || !draft) return
    try {
      const value = await postConfiguration(signal, config, draft)
      if (!alive.current || signal.aborted) return
      setConfig(value)
      setDraft(draftOf(value))
      setHiddenClearedNotice(false)
      setConfigConflict(false)
      setConfigNotice(at('saved'))
      await callbacks.current.onRefresh?.()
    } catch (err) {
      if (err instanceof HostApiError && err.code === 'ANDROID_CONFIGURATION_CONFLICT' && alive.current) {
        setConfigConflict(true)
      }
      throw err
    }
  }

  async function saveAndReconnect(signal: AbortSignal) {
    if (!config || !draft) return
    setConfirmReconnect(false)
    if (config.ready) {
      await hostRequest('/plugins/android-control/disconnect', { method: 'POST', body: {}, signal })
      if (!alive.current || signal.aborted) return
    }
    let savedConfig: PublicAndroidConfiguration
    try {
      savedConfig = await postConfiguration(signal, config, draft)
    } catch (err) {
      if (alive.current && !signal.aborted) {
        setConfig(current => (current ? { ...current, ready: false } : current))
        if (err instanceof HostApiError && err.code === 'ANDROID_CONFIGURATION_CONFLICT') setConfigConflict(true)
        await callbacks.current.onRefresh?.()
      }
      throw err
    }
    if (!alive.current || signal.aborted) return
    setConfig(savedConfig)
    setDraft(draftOf(savedConfig))
    setHiddenClearedNotice(false)
    setConfigConflict(false)
    try {
      await hostRequest('/plugins/android-control/connect', { method: 'POST', body: {}, signal })
      const fresh = configOf(await hostRequest('/plugins/android-control/configuration', { signal }))
      if (alive.current && !signal.aborted) {
        setConfig(fresh)
        setDraft(draftOf(fresh))
        setConfigNotice(at('reconnected'))
      }
    } finally {
      await callbacks.current.onRefresh?.()
    }
  }

  function updateDraft(patch: Partial<Draft>) {
    setDraft(current => (current ? { ...current, ...patch } : current))
    if (patch.token !== undefined && patch.token.length > 0) setHiddenClearedNotice(false)
    setConfigError(null)
    setConfigNotice(null)
    setConfirmReconnect(false)
  }

  function handleSelectFile(selectedFile: File | null) {
    uploadIdentity.current = null
    setFilesError(null)
    setFilesNotice(null)
    setFile(selectedFile)
    if (selectedFile && !path.trim()) setPath(selectedFile.name)
  }

  async function upload(signal: AbortSignal) {
    if (!file || !path.trim()) return
    const targetPath = path.trim()
    if (!uploadIdentity.current || uploadIdentity.current.file !== file || uploadIdentity.current.path !== targetPath) {
      uploadIdentity.current = { file, path: targetPath, offset: 0, id: createRequestId() }
    }
    const current = uploadIdentity.current
    do {
      const bytes = new Uint8Array(await file.slice(current.offset, current.offset + 65536).arrayBuffer())
      const value = structured(await invoke('android_files', {
        op: 'put',
        path: targetPath,
        data: base64(bytes),
        offset: current.offset,
        overwrite: current.offset === 0,
      }, signal, current.id))
      if (value.nextOffset !== current.offset + bytes.length) {
        throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'unknown')
      }
      current.offset += bytes.length
      current.id = createRequestId()
      if (signal.aborted) return
    } while (current.offset < file.size)
    const uploadedName = file.name
    uploadIdentity.current = null
    if (alive.current) {
      setFilesNotice(at('uploaded', { name: uploadedName }))
    }
  }

  async function download(signal: AbortSignal) {
    const targetPath = path.trim()
    if (!targetPath) return
    const parts: Uint8Array<ArrayBuffer>[] = []
    let offset = 0
    let total = 0
    do {
      const value = structured(await invoke('android_files', { op: 'get', path: targetPath, offset, output: 'binary' }, signal))
      if (
        typeof value.data !== 'string' ||
        typeof value.nextOffset !== 'number' ||
        typeof value.bytes !== 'number' ||
        value.nextOffset < offset ||
        (value.nextOffset === offset && value.bytes > offset)
      ) {
        throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
      }
      total = value.bytes
      parts.push(bytesFrom(value.data))
      offset = value.nextOffset
    } while (offset < total && !signal.aborted)
    if (signal.aborted) return
    const url = URL.createObjectURL(new Blob(parts))
    const link = document.createElement('a')
    link.href = url
    link.download = targetPath.split(/[\\/]/).at(-1) || 'download'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function listDirectory(targetPath: string, syncInput = false) {
    const resolvedInput = targetPath.trim() || '.'
    await action(
      key => setFilesError(at(key)),
      async signal => {
        const result = structured(await invoke('android_files', { op: 'list', path: resolvedInput }, signal))
        const parsed = directoryFromMeta(result)
        if (!parsed) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
        if (!alive.current || signal.aborted) return
        setDirectoryListing(parsed)
        if (syncInput) setPath(parsed.path)
      },
      { skipProcessRefresh: true },
    )
  }

  const busy = pending || connectionBusy
  const ready = enabled && config?.ready === true
  const canOperate = ready && !busy && !dirty
  const baseDisabledReason = !enabled
    ? t('disabled')
    : dirty
      ? t('dirty')
      : !config?.ready
        ? t('disconnected')
        : busy
          ? t('working')
          : undefined

  const activeProcessCount = useMemo(
    () => processes.filter(p => p.status === 'running' || p.status === 'queued' || p.status === 'unknown').length,
    [processes],
  )

  const endpointChangedTokenWarn = Boolean(
    draft && config && draft.mode === 'remote' && config.tokenConfigured && draft.endpoint !== config.endpoint && !draft.token && !draft.clear,
  )

  const parentDir = directoryListing ? parentExecutorPath(directoryListing.path) : null

  return (
    <div className="android-panel">
      <p className="android-description">{t('description')}</p>

      {(!enabled || dirty || (config && !config.ready)) && tab !== 'connection' && (
        <div className="android-setup-cta" role="status">
          <AlertCircle size={17} aria-hidden="true" />
          <div>
            <strong>{t(!enabled ? 'cta.disabledTitle' : dirty ? 'cta.dirtyTitle' : 'cta.disconnectedTitle')}</strong>
            <p>{t(!enabled ? 'cta.disabledBody' : dirty ? 'cta.dirtyBody' : 'cta.disconnectedBody')}</p>
          </div>
          <div className="android-cta-actions">
            {enabled && !dirty && config && !config.ready && (
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={busy}
                reasonCode="busy"
                onClick={() => void action(
                  key => setConsoleError(at(key)),
                  async signal => {
                    await hostRequest('/plugins/android-control/connect', { method: 'POST', body: {}, signal })
                    await load()
                    await callbacks.current.onRefresh?.()
                  },
                )}>
                <Plug size={14} aria-hidden="true" />
                {t('cta.connectNow')}
              </ActionButton>
            )}
            <button type="button" className="button button-secondary" onClick={() => setTab('connection')}>
              {t('cta.openConnection')}
            </button>
          </div>
        </div>
      )}

      <SegmentedTabs
        className="android-tabs"
        idPrefix={prefix + '-tabs'}
        ariaLabel={t('tabs.aria')}
        activeTab={tab}
        onSelect={setTab}
        tabs={[
          { id: 'console', label: t('tabs.console'), badge: activeProcessCount > 0 ? activeProcessCount : undefined },
          { id: 'files-screen', label: t('tabs.filesScreen') },
          { id: 'connection', label: t('tabs.connection'), dirty },
        ]}
      />

      {unknownSubmit && (
        <UnknownOutcomeCard
          className="android-unknown"
          title={t('unknownTitle')}
          body={t('unknown')}
          requestId={unknownSubmit.requestId}
          refreshing={busy}
          onRefresh={ready ? () => void refreshProcesses() : undefined}
          onConfirmReviewed={() => {
            identity.current = null
            writeIdentity.current = null
            uploadIdentity.current = null
            setUnknownSubmit(null)
            setConsoleError(null)
            setFilesError(null)
          }}
        />
      )}

      {/* Tab 1: Console & Processes */}
      <div
        id={`${prefix}-tabs-panel-console`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tabs-tab-console`}
        hidden={tab !== 'console'}
        className="android-tab-panel">
        <section className="android-block" aria-labelledby={prefix + '-console'}>
          <div className="android-block-heading">
            <div>
              <h3 id={prefix + '-console'}>{t('console')}</h3>
              <p>{t('consoleHelp')}</p>
            </div>
            <ActionButton
              type="button"
              className="button button-secondary"
              disabled={!enabled || !config?.ready || busy}
              reason={!enabled ? t('disabled') : !config?.ready ? t('disconnected') : busy ? t('working') : undefined}
              onClick={() => void action(
                key => setConsoleError(at(key)),
                async signal => { await manage('takeover', {}, signal) },
              )}>
              {t('takeover')}
            </ActionButton>
          </div>

          <div className="android-field">
            <label htmlFor={`${prefix}-argv`}>{t('arguments')}</label>
            <StringListEditor
              id={`${prefix}-argv`}
              aria-label={t('arguments')}
              jsonText={argv}
              onJsonTextChange={setArgv}
              disabled={busy}
              presets={[
                { label: t('preset.devices'), items: ['devices', '-l'] },
                { label: t('preset.screenSize'), items: ['shell', 'wm', 'size'] },
                { label: t('preset.logcat'), items: ['logcat', '-d', '-t', '50'] },
                { label: t('preset.version'), items: ['version'] },
              ]}
            />
            <small>{t('argsHelp')}</small>
          </div>

          <div className="android-actions">
            <label className="android-check">
              <input type="checkbox" checked={terminal} disabled={busy} onChange={e => setTerminal(e.target.checked)} />
              <span>{t('terminal')}</span>
            </label>
            <ActionButton
              className="button button-primary"
              disabled={!canOperate || !argsValid}
              reason={baseDisabledReason ?? (!parsedArgs.ok ? t('invalidArgs') : parsedArgs.items.length === 0 ? t('emptyArgs') : undefined)}
              onClick={() => void action(key => setConsoleError(at(key)), run)}>
              <Terminal size={15} aria-hidden="true" />
              {busy ? t('working') : t('run')}
            </ActionButton>
          </div>

          {consoleError && (
            <div className="android-feedback is-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{consoleError}</span>
            </div>
          )}
        </section>

        <div className="android-console-grid">
          <section className="android-block" aria-labelledby={prefix + '-processes'}>
            <div className="android-block-heading">
              <div>
                <h3 id={prefix + '-processes'}>{t('processes')}</h3>
                <p>{t('processesHelp')}</p>
              </div>
              <ActionButton
                type="button"
                className="text-button"
                disabled={!canOperate || processes.length === 0}
                reason={baseDisabledReason ?? (processes.length === 0 ? t('noProcesses') : undefined)}
                onClick={() => setConfirmPrune(true)}>
                <Trash2 size={14} aria-hidden="true" />
                {t('prune')}
              </ActionButton>
            </div>

            {confirmPrune && (
              <div ref={pruneConfirmRef} className="android-inline-confirm">
                <InlineConfirm
                  open
                  variant="danger"
                  title={t('confirmPrune')}
                  description={t('confirmPruneBody')}
                  confirmLabel={t('prune')}
                  cancelLabel={t('cancel')}
                  busy={busy}
                  onCancel={() => setConfirmPrune(false)}
                  onConfirm={() => void action(
                    key => setConsoleError(at(key)),
                    async signal => {
                      await manage('prune', { confirmed: true }, signal)
                      setConfirmPrune(false)
                      setSelected(null)
                    },
                  )}
                />
              </div>
            )}

            {!processes.length ? (
              <p className="android-description">{t('noProcesses')}</p>
            ) : (
              <ul className="android-processes">
                {processes.map(p => {
                  const pid = String(p.processId)
                  const status = String(p.status)
                  const isSelected = selected === pid
                  const statusKey = (`status.${status}`) as AndroidTranslationKey
                  return (
                    <li key={pid}>
                      <button
                        type="button"
                        className={`android-process-row${isSelected ? ' is-selected' : ''}`}
                        aria-pressed={isSelected}
                        disabled={busy}
                        onClick={() => {
                          setSelected(pid)
                          void action(
                            key => setConsoleError(at(key)),
                            async signal => display(await invoke('android_process_read', { process_id: pid, stream }, signal, createRequestId(), true)),
                            { skipProcessRefresh: true },
                          )
                        }}>
                        <span className="android-process-head">
                          <code>{pid.slice(0, 8)}</code>
                          <span className={`android-badge android-status-${status}`}>{isAndroidStatus(status) ? t(statusKey) : status}</span>
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

            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !selected}
                reason={baseDisabledReason ?? (!selected ? t('selectProcess') : undefined)}
                onClick={() => void action(
                  key => setConsoleError(at(key)),
                  async signal => display(
                    await invoke('android_process_read', { process_id: selected!, stream, offset: cursors.current[selected! + '.' + stream] ?? 0 }, signal, createRequestId(), true),
                    true,
                  ),
                )}>
                {t('read')}
              </ActionButton>
              <ActionButton
                type="button"
                className="text-button"
                disabled={!canOperate || !selected}
                reason={baseDisabledReason ?? (!selected ? t('selectProcess') : undefined)}
                onClick={() => void action(
                  key => setConsoleError(at(key)),
                  async signal => display(await invoke('android_process_stop', { process_id: selected!, signal: 'interrupt' }, signal)),
                )}>
                {t('interrupt')}
              </ActionButton>
              <ActionButton
                type="button"
                className="text-button"
                disabled={!canOperate || !selected}
                reason={baseDisabledReason ?? (!selected ? t('selectProcess') : undefined)}
                onClick={() => void action(
                  key => setConsoleError(at(key)),
                  async signal => display(await invoke('android_process_stop', { process_id: selected! }, signal)),
                )}>
                {t('stop')}
              </ActionButton>
            </div>
          </section>

          <section className="android-block" aria-labelledby={prefix + '-output'}>
            <div className="android-block-heading">
              <div>
                <h3 id={prefix + '-output'}>{t('output')}</h3>
                {selected && <p>{t('selectedProcessLabel', { id: selected.slice(0, 8) })}</p>}
              </div>
              <div className="android-output-controls">
                <label className="android-stream-select">
                  <span>{t('stream')}</span>
                  <select
                    aria-label={t('stream')}
                    value={stream}
                    onChange={e => { setStream(e.target.value as 'stdout' | 'stderr'); setOutput('') }}>
                    <option value="stdout">stdout</option>
                    <option value="stderr">stderr</option>
                  </select>
                </label>
                {output && (
                  <button type="button" className="text-button" onClick={() => setOutput('')}>
                    {t('clearOutput')}
                  </button>
                )}
              </div>
            </div>

            {lastMeta?.exitCode !== undefined && lastMeta.exitCode !== null && (
              <p className="android-exit-code">{t('exitCode')}: <strong>{String(lastMeta.exitCode)}</strong></p>
            )}
            <pre className="android-output" aria-label={t('output')}>{output || t('emptyOutput')}</pre>

            <div className="android-field android-stdin-field">
              <label htmlFor={`${prefix}-stdin`}>{t('stdin')}</label>
              <textarea
                id={`${prefix}-stdin`}
                aria-label={t('stdin')}
                placeholder={t('stdinPlaceholder')}
                value={stdin}
                disabled={busy}
                onChange={e => setStdin(e.target.value)}
              />
            </div>
            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !selected}
                reason={baseDisabledReason ?? (!selected ? t('selectProcess') : undefined)}
                onClick={() => void action(
                  key => setConsoleError(at(key)),
                  async signal => {
                    display(await invoke('android_process_write', { process_id: selected!, data: stdin }, signal))
                    setStdin('')
                  },
                )}>
                {t('send')}
              </ActionButton>
              <ActionButton
                type="button"
                className="text-button"
                disabled={!canOperate || !selected}
                reason={baseDisabledReason ?? (!selected ? t('selectProcess') : undefined)}
                onClick={() => void action(
                  key => setConsoleError(at(key)),
                  async signal => display(await invoke('android_process_write', { process_id: selected!, eof: true }, signal)),
                )}>
                {t('eof')}
              </ActionButton>
            </div>
          </section>
        </div>
      </div>

      {/* Tab 2: Screen & Files */}
      <div
        id={`${prefix}-tabs-panel-files-screen`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tabs-tab-files-screen`}
        hidden={tab !== 'files-screen'}
        className="android-tab-panel">
        <div className="android-files-screen-grid">
          <section className="android-block" aria-labelledby={prefix + '-files'}>
            <div className="android-block-heading">
              <div>
                <h3 id={prefix + '-files'}>{t('files')}</h3>
                <p>{t('filesHelp')}</p>
              </div>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate}
                reason={baseDisabledReason}
                onClick={() => void listDirectory('.', true)}>
                <FolderOpen size={15} aria-hidden="true" />
                {t('listWorkspace')}
              </ActionButton>
            </div>

            {workspacePath && (
              <p className="android-workspace-chip">
                <span>{t('workspaceLabel')}:</span> <code>{workspacePath}</code>
              </p>
            )}

            <div className="android-field">
              <label htmlFor={`${prefix}-path`}>{t('path')}</label>
              <input
                id={`${prefix}-path`}
                aria-label={t('path')}
                value={path}
                placeholder={t('pathPlaceholder')}
                disabled={busy}
                onChange={e => setPath(e.target.value)}
              />
            </div>

            <div className="android-field android-file-field">
              <label htmlFor={`${prefix}-file`}>{t('file')}</label>
              <div
                className={`android-dropzone${dragOver ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
                onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault()
                  setDragOver(false)
                  if (!busy) handleSelectFile(e.dataTransfer.files?.[0] ?? null)
                }}>
                <input
                  ref={fileInputRef}
                  id={`${prefix}-file`}
                  className="android-file-input"
                  type="file"
                  aria-label={t('file')}
                  disabled={busy}
                  onChange={e => handleSelectFile(e.target.files?.[0] ?? null)}
                />
                <Upload size={20} className="android-dropzone-icon" aria-hidden="true" />
                <strong>{file ? t('selectedFile', { name: file.name, size: formatNumber(file.size) + ' B' }) : t('dropFile')}</strong>
                <small>{t('dropFileHelp')}</small>
              </div>
              {file && (
                <div className="android-file-chip-row">
                  <button type="button" className="text-button" disabled={busy} onClick={clearFile}>
                    <X size={14} aria-hidden="true" />
                    {t('clearFile')}
                  </button>
                </div>
              )}
            </div>

            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={!canOperate || !path.trim() || !file}
                reason={baseDisabledReason ?? (!path.trim() ? t('pathRequired') : !file ? t('uploadNeedFile') : undefined)}
                onClick={() => void action(key => setFilesError(at(key)), upload, { skipProcessRefresh: true })}>
                {t('upload')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !path.trim()}
                reason={baseDisabledReason ?? (!path.trim() ? t('pathRequired') : undefined)}
                onClick={() => void action(key => setFilesError(at(key)), download, { skipProcessRefresh: true })}>
                {t('download')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!canOperate || !path.trim()}
                reason={baseDisabledReason ?? (!path.trim() ? t('pathRequired') : undefined)}
                onClick={() => void listDirectory(path, false)}>
                {t('list')}
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
                    <strong>{t('directoryTitle')}</strong>
                    <code>{directoryListing.path}</code>
                  </div>
                  <div className="android-dir-meta">
                    <span>
                      {t('directoryCount', { total: directoryListing.total })}
                      {directoryListing.truncated ? t('directoryShown', { shown: directoryListing.entries.length }) : ''}
                    </span>
                    {parentDir && (
                      <ActionButton
                        type="button"
                        className="text-button"
                        disabled={!canOperate}
                        reason={baseDisabledReason}
                        onClick={() => void listDirectory(parentDir, true)}>
                        <ArrowUp size={14} aria-hidden="true" />
                        {t('directoryParent')}
                      </ActionButton>
                    )}
                  </div>
                </div>
                <p className="android-dir-hint">{t('directoryHint')}</p>
                {directoryListing.entries.length === 0 ? (
                  <p className="android-description">{t('directoryEmpty')}</p>
                ) : (
                  <ul className="android-dir-list">
                    {directoryListing.entries.map(entry => {
                      const entryPath = joinExecutorPath(directoryListing.path, entry.name)
                      const isPathMatch = path.trim() === entryPath
                      return (
                        <li key={entry.name}>
                          <button
                            type="button"
                            className={`android-dir-row${isPathMatch ? ' is-selected' : ''}`}
                            disabled={!canOperate}
                            onClick={() => {
                              if (entry.directory) void listDirectory(entryPath, true)
                              else setPath(entryPath)
                            }}>
                            {entry.directory ? <Folder size={15} aria-hidden="true" /> : <FileIcon size={15} aria-hidden="true" />}
                            <span className="android-dir-name">{entry.name}</span>
                            <span className="android-badge">{t(entry.directory ? 'directoryTypeDir' : 'directoryTypeFile')}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="android-block" aria-labelledby={prefix + '-screen'}>
            <div className="android-block-heading">
              <div>
                <h3 id={prefix + '-screen'}>{t('screenshot')}</h3>
                <p>{t('screenshotHelp')}</p>
              </div>
            </div>
            <div className="android-field">
              <label htmlFor={`${prefix}-serial`}>{t('serial')}</label>
              <input
                id={`${prefix}-serial`}
                aria-label={t('serial')}
                value={serial}
                disabled={busy}
                onChange={e => setSerial(e.target.value)}
              />
            </div>
            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={!canOperate}
                reason={baseDisabledReason}
                onClick={() => void action(
                  key => setFilesError(at(key)),
                  async signal => display(await invoke('android_screenshot', serial.trim() ? { serial: serial.trim() } : {}, signal, createRequestId(), true), false, 'image'),
                  { skipProcessRefresh: true },
                )}>
                {t('takeScreenshot')}
              </ActionButton>
              {image && (
                <button type="button" className="button button-secondary" onClick={clearImage}>
                  {t('clearImage')}
                </button>
              )}
            </div>
            <div className="android-screen-stage">
              {image ? (
                <img className="android-screen" src={image} alt={t('image')} />
              ) : (
                <div className="android-screen-empty">
                  <ImageOff size={24} aria-hidden="true" />
                  <p>{t('emptyImage')}</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Tab 3: Connection Config */}
      <div
        id={`${prefix}-tabs-panel-connection`}
        role="tabpanel"
        aria-labelledby={`${prefix}-tabs-tab-connection`}
        hidden={tab !== 'connection'}
        className="android-tab-panel">
        <section className="android-block" aria-labelledby={prefix + '-configuration'}>
          <div className="android-block-heading">
            <div>
              <h3 id={prefix + '-configuration'}>{t('configuration')}</h3>
              <p>{t('configurationHelp')}</p>
            </div>
          </div>

          {!config || !draft ? (
            <p role="status">{t('loading')}</p>
          ) : (
            <>
              {config.ready && (
                <div className="android-info-note" role="status">
                  <AlertCircle size={15} aria-hidden="true" />
                  <span>{t('reconnectHint')}</span>
                </div>
              )}

              <div className="android-fields">
                <div className="android-field">
                  <label htmlFor={`${prefix}-mode`}>{t('mode')}</label>
                  <select
                    id={`${prefix}-mode`}
                    aria-label={t('mode')}
                    disabled={busy}
                    value={draft.mode}
                    onChange={e => updateDraft({ mode: e.target.value as Draft['mode'] })}>
                    <option value="local">{t('local')}</option>
                    <option value="remote">{t('remote')}</option>
                  </select>
                </div>

                {draft.mode === 'local' ? (
                  <>
                    <div className="android-field">
                      <label htmlFor={`${prefix}-adb`}>{t('adb')}</label>
                      <input
                        id={`${prefix}-adb`}
                        aria-label={t('adb')}
                        value={draft.adbPath}
                        disabled={busy}
                        onChange={e => updateDraft({ adbPath: e.target.value })}
                      />
                      <small>{t('adbHelp')}</small>
                    </div>
                    <div className="android-field android-field-wide">
                      <label htmlFor={`${prefix}-workspace`}>{t('workspace')}</label>
                      <input
                        id={`${prefix}-workspace`}
                        aria-label={t('workspace')}
                        value={draft.workspace}
                        disabled={busy}
                        onChange={e => updateDraft({ workspace: e.target.value })}
                      />
                      <small>{t('workspaceHelp')}</small>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="android-field android-field-wide">
                      <label htmlFor={`${prefix}-endpoint`}>{t('endpoint')}</label>
                      <input
                        id={`${prefix}-endpoint`}
                        aria-label={t('endpoint')}
                        value={draft.endpoint}
                        disabled={busy}
                        onChange={e => updateDraft({ endpoint: e.target.value })}
                      />
                      {endpointChangedTokenWarn && <small className="android-inline-warn">{t('endpointChangedTokenWarn')}</small>}
                    </div>
                    <div className="android-field android-field-wide">
                      <label htmlFor={`${prefix}-token`}>{t('token')}</label>
                      <PasswordInput
                        id={`${prefix}-token`}
                        aria-label={t('token')}
                        value={draft.token}
                        saved={config.tokenConfigured}
                        clear={draft.clear}
                        hiddenClearedNotice={hiddenClearedNotice}
                        savedPlaceholder={t('tokenSaved')}
                        placeholder={t('tokenEmpty')}
                        clearLabel={t('clearToken')}
                        disabled={busy}
                        onChange={token => updateDraft({ token })}
                        onClearChange={clear => updateDraft({ clear })}
                      />
                    </div>
                  </>
                )}
              </div>

              {confirmReconnect && (
                <div ref={reconnectConfirmRef} className="android-inline-confirm">
                  <InlineConfirm
                    open
                    variant="warning"
                    title={t('reconnectConfirmTitle')}
                    description={t('reconnectConfirmBody')}
                    confirmLabel={t('reconnectConfirmAccept')}
                    cancelLabel={t('cancel')}
                    busy={busy}
                    onCancel={() => setConfirmReconnect(false)}
                    onConfirm={() => void action(
                      key => setConfigError(at(key)),
                      saveAndReconnect,
                    )}
                  />
                </div>
              )}

              <FormSaveBar
                className="android-save-bar"
                alwaysVisible
                dirty={dirty}
                saving={busy}
                conflict={configConflict}
                saveLabel={config.ready ? t('saveAndReconnect') : t('save')}
                savingLabel={config.ready ? t('reconnecting') : t('saving')}
                disabled={!dirty}
                disabledReason={t('unchanged')}
                error={configError}
                notice={configNotice}
                onSave={() => {
                  if (config.ready) setConfirmReconnect(true)
                  else void action(key => setConfigError(at(key)), saveOnly, { skipProcessRefresh: true })
                }}
                onDiscard={() => {
                  setDraft(draftOf(config))
                  setHiddenClearedNotice(false)
                  setConfigConflict(false)
                  setConfigError(null)
                  setConfigNotice(null)
                  setConfirmReconnect(false)
                }}
                onReload={() => void load(true)}
                extraActions={(
                  <>
                    <ActionButton
                      type="button"
                      className="button button-secondary"
                      disabled={!enabled || busy || dirty}
                      reason={!enabled ? t('disabled') : busy ? t('working') : dirty ? t('dirty') : undefined}
                      onClick={() => void action(
                        key => setConfigError(at(key)),
                        async signal => {
                          await hostRequest('/plugins/android-control/' + (config.ready ? 'disconnect' : 'connect'), { method: 'POST', body: {}, signal })
                          await load()
                          await callbacks.current.onRefresh?.()
                        },
                      )}>
                      {t(config.ready ? 'disconnect' : 'connect')}
                    </ActionButton>
                    {!dirty && !configConflict && (
                      <ActionButton
                        type="button"
                        className="button button-secondary"
                        disabled={busy}
                        reasonCode="busy"
                        onClick={() => void load(true)}>
                        <RefreshCw size={14} aria-hidden="true" />
                        {t('refresh')}
                      </ActionButton>
                    )}
                  </>
                )}
              />
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function isAndroidStatus(status: string): status is 'queued' | 'running' | 'exited' | 'failed' | 'unknown' {
  return ['queued', 'running', 'exited', 'failed', 'unknown'].includes(status)
}
