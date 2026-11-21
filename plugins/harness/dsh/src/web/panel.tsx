import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, Check, Info, RefreshCw } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import { isJsonObject } from '@eating/plugin-sdk'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import { ActionButton, DurationInput, FormSaveBar, HostApiError, PasswordInput, SegmentedTabs, Switch, UnknownOutcomeCard, formatNumber, getErrorMessage, hostRequest, translate, useI18n } from '@eating/ui-sdk'
import type { ConfigurationValidation, PluginPanelProps } from '@eating/ui-sdk'
import { DSH_API_PROTOCOLS, GOOGLE_GEMINI_DEFAULT_ENDPOINT, isDshApiProtocol, protocolRequiresApiKey } from '../protocol'
import type { DshApiProtocol } from '../protocol'
import './i18n'
import type { DshTranslationKey } from './i18n'
import { NativeWebButton } from './NativeWebButton'
import { ModelCapabilitiesSettings } from './ModelCapabilities'
import { NativeCapabilitiesSettings } from './NativeCapabilities'
import { SessionHistorySettings } from './SessionHistory'
import { readModels, readModelTest, readNativeWebStatus, readSystemDsh } from './panel-data'
import type { ModelOption, ModelTestResult, NativeWebStatus, SystemDshStatus } from './panel-data'
import './panel.css'

type Operation = 'save' | 'save-and-start' | 'connect' | 'disconnect' | 'detect'
type ModelOperation = 'list-models' | 'test-connection'
interface RuntimeStatus {
  readonly system: SystemDshStatus
  readonly lastError: string | null
  readonly ready: boolean
  readonly busy: boolean
  readonly sessionId: string | null
  readonly lastOutcome: string | null
  readonly nativeWeb: NativeWebStatus
}
interface PublicConfiguration {
  readonly displayName: string
  readonly protocol: DshApiProtocol
  readonly endpoint: string
  readonly model: string
  readonly autoConnect: boolean
  readonly timeoutMs: number
  readonly maxTokens: number
  readonly apiKeyConfigured: boolean
  readonly updatedAt: string | null
  readonly runtimeStatus: RuntimeStatus
  readonly configurationPath?: string
  readonly dataDirectory?: string
  readonly warning?: string
}
interface WorkspacePlugin {
  readonly enabled: boolean
  readonly configuration: PublicConfiguration
  readonly status: Pick<ConnectionStatus, 'state' | 'lastError'>
}
interface Draft {
  readonly displayName: string
  readonly protocol: DshApiProtocol
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
  readonly clearApiKey: boolean
  readonly autoConnect: boolean
  readonly timeoutMs: string
  readonly maxTokens: string
}
type ProtocolDraftMap = Partial<Record<DshApiProtocol, { readonly endpoint: string; readonly model: string }>>
interface Failure {
  readonly code: string
  readonly error: unknown
  readonly outcome: string
  readonly messageKey?: DshTranslationKey
  readonly detail?: string
}
interface UncertainAction { readonly operation: Exclude<Operation, 'save-and-start'>; readonly afterRead: number }
interface ValidationIssue { readonly key: DshTranslationKey; readonly params?: Readonly<Record<string, number>> }

const stateKeys: Record<ConnectionStatus['state'], DshTranslationKey> = {
  unconfigured: 'state.unconfigured', disconnected: 'state.disconnected', connecting: 'state.connecting',
  connected: 'state.connected', reconnecting: 'state.reconnecting', error: 'state.error',
}
const uncertainKeys: Record<Exclude<Operation, 'save-and-start'>, DshTranslationKey> = {
  save: 'uncertain.save', connect: 'uncertain.connect', disconnect: 'uncertain.disconnect', detect: 'uncertain.detect',
}
const outcomeKeys: Readonly<Record<string, DshTranslationKey>> = {
  pending: 'outcome.pending', durable: 'outcome.durable', unknown: 'outcome.unknown',
  failed: 'outcome.failed', completed: 'outcome.completed', recovered: 'outcome.recovered',
}
const protocolCopy: Record<DshApiProtocol, { readonly label: DshTranslationKey; readonly caption: DshTranslationKey }> = {
  'openai-completions': { label: 'protocol.openai.label', caption: 'protocol.openai.caption' },
  'google-generative-ai': { label: 'protocol.gemini.label', caption: 'protocol.gemini.caption' },
}
const panelTabs = ['connection', 'native', 'history'] as const
const integerIn = (value: string, min: number, max: number) => value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max

function validateFields(values: PluginConfiguration): Readonly<Record<string, ValidationIssue>> {
  const errors: Record<string, ValidationIssue> = {}
  if (!isDshApiProtocol(values.protocol)) errors.protocol = { key: 'validation.protocol' }
  if (typeof values.displayName !== 'string' || !values.displayName.trim() || values.displayName.trim().length > 80) errors.displayName = { key: 'validation.displayName', params: { max: 80 } }
  if (typeof values.endpoint !== 'string') errors.endpoint = { key: 'validation.endpointRequired' }
  else if (values.endpoint.trim()) {
    try {
      const url = new URL(values.endpoint.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || values.endpoint.includes('?') || values.endpoint.includes('#')) errors.endpoint = { key: 'validation.endpointParts' }
      else if (values.endpoint.trim().length > 2048) errors.endpoint = { key: 'validation.endpointLength', params: { max: 2048 } }
    } catch { errors.endpoint = { key: 'validation.endpointInvalid' } }
  }
  if (typeof values.model !== 'string' || values.model.trim().length > 160 || /[\r\n\0]/.test(values.model)) errors.model = { key: 'validation.model', params: { max: 160 } }
  if (typeof values.timeoutMs !== 'string' || !integerIn(values.timeoutMs, 1000, 120000)) errors.timeoutMs = { key: 'validation.timeoutMs', params: { min: 1000, max: 120000 } }
  if (typeof values.maxTokens !== 'string' || !integerIn(values.maxTokens, 1, 131072)) errors.maxTokens = { key: 'validation.maxTokens', params: { min: 1, max: 131072 } }
  if (typeof values.apiKey === 'string' && (values.apiKey.length > 4096 || /[\r\n\0]/.test(values.apiKey))) errors.apiKey = { key: 'validation.apiKey', params: { max: 4096 } }
  return errors
}
function validationMessage(issue: ValidationIssue): string {
  return translate('dsh', issue.key, issue.params && Object.fromEntries(Object.entries(issue.params).map(([name, value]) => [name, formatNumber(value)])))
}
export function validateConfiguration(values: PluginConfiguration): ConfigurationValidation {
  const errors = Object.fromEntries(Object.entries(validateFields(values)).map(([name, issue]) => [name, validationMessage(issue)]))
  return { valid: Object.keys(errors).length === 0, errors }
}

function incompatible(): HostApiError { return new HostApiError('INVALID_HOST_RESPONSE', translate('dsh', 'error.incompatible')) }
function readConfiguration(value: unknown): PublicConfiguration {
  if (!isJsonObject(value) || typeof value.displayName !== 'string' || !isDshApiProtocol(value.protocol) || typeof value.endpoint !== 'string' || typeof value.model !== 'string'
    || typeof value.autoConnect !== 'boolean' || typeof value.timeoutMs !== 'number' || typeof value.maxTokens !== 'number'
    || typeof value.apiKeyConfigured !== 'boolean' || value.updatedAt !== null && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) || !isJsonObject(value.runtimeStatus)) throw incompatible()
  const runtime = value.runtimeStatus
  if (!['ready', 'busy'].every(key => typeof runtime[key] === 'boolean')
    || ['lastError', 'sessionId', 'lastOutcome'].some(key => runtime[key] !== null && typeof runtime[key] !== 'string')
    || !isJsonObject(runtime.nativeWeb)) throw incompatible()
  return {
    displayName: value.displayName, protocol: value.protocol, endpoint: value.endpoint, model: value.model, autoConnect: value.autoConnect,
    timeoutMs: value.timeoutMs, maxTokens: value.maxTokens, apiKeyConfigured: value.apiKeyConfigured, updatedAt: value.updatedAt as string | null,
    runtimeStatus: { system: readSystemDsh(runtime.system),
      lastError: runtime.lastError as string | null, ready: runtime.ready === true,
      busy: runtime.busy === true, sessionId: runtime.sessionId as string | null, lastOutcome: runtime.lastOutcome as string | null,
      nativeWeb: readNativeWebStatus(runtime.nativeWeb) },
    ...(typeof value.configurationPath === 'string' ? { configurationPath: value.configurationPath } : {}),
    ...(typeof value.dataDirectory === 'string' ? { dataDirectory: value.dataDirectory } : {}),
    ...(typeof value.warning === 'string' ? { warning: value.warning } : {}),
  }
}
function readPlugin(value: unknown): WorkspacePlugin {
  if (!isJsonObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.plugins)) throw incompatible()
  const entry = value.plugins.find(item => isJsonObject(item) && item.id === 'dsh')
  if (!isJsonObject(entry)) throw new HostApiError('HARNESS_NOT_INSTALLED', translate('dsh', 'error.notInstalled'))
  if (entry.kind !== 'harness' || typeof entry.enabled !== 'boolean' || !isJsonObject(entry.status)
    || typeof entry.status.state !== 'string' || !Object.hasOwn(stateKeys, entry.status.state)
    || entry.status.lastError !== null && typeof entry.status.lastError !== 'string') throw incompatible()
  return { enabled: entry.enabled, configuration: readConfiguration(entry.configuration),
    status: { state: entry.status.state as ConnectionStatus['state'], lastError: entry.status.lastError } }
}
function makeDraft(value: PublicConfiguration): Draft {
  return { displayName: value.displayName, protocol: value.protocol, endpoint: value.endpoint, model: value.model, apiKey: '', clearApiKey: false,
    autoConnect: value.autoConnect, timeoutMs: String(value.timeoutMs), maxTokens: String(value.maxTokens) }
}
function isNonSecretDraftDirty(draft: Draft | null, saved: PublicConfiguration | undefined): boolean {
  if (!draft || !saved) return false
  return (
    draft.displayName !== saved.displayName ||
    draft.protocol !== saved.protocol ||
    draft.endpoint !== saved.endpoint ||
    draft.model !== saved.model ||
    draft.autoConnect !== saved.autoConnect ||
    draft.timeoutMs !== String(saved.timeoutMs) ||
    draft.maxTokens !== String(saved.maxTokens)
  )
}
function failureFrom(error: unknown): Failure {
  return error instanceof HostApiError ? { code: error.code, error, outcome: error.outcome }
    : { code: 'UNEXPECTED_ERROR', error, outcome: 'unknown' }
}
function runtimeFailure(code: string, detail: string): Failure {
  return { code, error: { code }, outcome: 'failed', messageKey: 'error.runtime', detail }
}
function ErrorNotice({ failure }: { readonly failure: Failure | null }) {
  const { t } = useI18n('dsh')
  if (!failure) return null
  const message = failure.messageKey ? t(failure.messageKey) : getErrorMessage(failure.error)
  return <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div>
    <p>{failure.detail ?? message}</p>
    <small>{t('error.code', { code: failure.code })}</small>
    {failure.outcome === 'unknown' && <p className="dsh-error-recovery">{t('error.unknown')}</p>}
  </div></div>
}
function Field({ id, label, hint, error, children }: { readonly id: string; readonly label: string; readonly hint: ReactNode; readonly error?: string; readonly children: ReactNode }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}</label>{children}<p className="field-hint" id={`${id}-hint`}>{hint}</p>{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>
}

export function DSHPanel({ onFeedback, onRefresh, onDirtyChange }: PluginPanelProps) {
  const { t, formatNumber } = useI18n('dsh')
  const { t: commonT } = useI18n('common')
  const { t: nativeT } = useI18n('dsh-native')
  const { t: historyT } = useI18n('dsh-history')
  const prefix = useId()
  const [panelTab, setPanelTab] = useState<typeof panelTabs[number]>('connection')
  const [plugin, setPlugin] = useState<WorkspacePlugin | null>(null)
  const savedConfigRef = useRef<PublicConfiguration | undefined>(undefined)
  savedConfigRef.current = plugin?.configuration
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [nativeDirty, setNativeDirty] = useState(false)
  const dirtyRef = useRef(false)
  const protocolDrafts = useRef<ProtocolDraftMap>({})
  const [secretClearedOnHide, setSecretClearedOnHide] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [refreshFailure, setRefreshFailure] = useState<Failure | null>(null)
  const [actionFailure, setActionFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState<DshTranslationKey | ''>('')
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, ValidationIssue>>>({})
  const [operation, setOperation] = useState<Operation | null>(null)
  const [uncertain, setUncertain] = useState<UncertainAction | null>(null)
  const [readSerial, setReadSerial] = useState(0)
  const [visible, setVisible] = useState(() => !document.hidden)
  const [modelOperation, setModelOperation] = useState<ModelOperation | null>(null)
  const [capabilitySaving, setCapabilitySaving] = useState(false)
  const [models, setModels] = useState<readonly ModelOption[] | null>(null)
  const [modelTest, setModelTest] = useState<ModelTestResult | null>(null)
  const [modelFailure, setModelFailure] = useState<Failure | null>(null)
  const modelController = useRef<AbortController | null>(null)
  const modelGeneration = useRef(0)
  const mounted = useRef(false)
  const actionLock = useRef(false)
  const generation = useRef(0)
  const readCount = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const actionController = useRef<AbortController | null>(null)
  const callbacks = useRef({ onFeedback, onRefresh, onDirtyChange })
  callbacks.current = { onFeedback, onRefresh, onDirtyChange }

  const overallDirty = dirty || nativeDirty
  useEffect(() => {
    callbacks.current.onDirtyChange?.(overallDirty)
  }, [overallDirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  const refreshWorkspace = useCallback(async (duringMutation = false) => {
    if (!mounted.current || document.hidden || actionLock.current && !duringMutation) return
    const ticket = ++generation.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    setReading(true)
    try {
      const response = readPlugin(await hostRequest<unknown>('/workspace', { signal: controller.signal }))
      if (!mounted.current || controller.signal.aborted || ticket !== generation.current) return
      setPlugin(response); setRefreshFailure(null)
      if (!response.enabled) setDraft(current => current ? { ...current, apiKey: '', clearApiKey: false } : current)
      else if (!dirtyRef.current) {
        protocolDrafts.current = {}
        setDraft(makeDraft(response.configuration))
      }
      setReadSerial(++readCount.current)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === generation.current) setRefreshFailure(failureFrom(error))
    } finally {
      if (mounted.current && ticket === generation.current) { setLoading(false); setReading(false) }
      if (readController.current === controller) readController.current = null
    }
  }, [])

  const abortInFlightModels = useCallback(() => {
    ++modelGeneration.current
    if (modelController.current) {
      modelController.current.abort()
      modelController.current = null
      actionLock.current = false
    }
    setModelOperation(null)
  }, [])

  const clearModelsState = useCallback(() => {
    abortInFlightModels()
    setModelTest(null)
    setModelFailure(null)
    setModels(null)
  }, [abortInFlightModels])

  useEffect(() => {
    mounted.current = true
    let timer: number | undefined
    const stopPolling = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      ++generation.current
      readController.current?.abort(); readController.current = null
      setReading(false)
    }
    const clearSecretsOnHide = () => {
      setDraft(current => {
        if (!current) return current
        const hadSecret = current.apiKey.length > 0 || current.clearApiKey
        if (hadSecret) setSecretClearedOnHide(true)
        const nextDraft = hadSecret ? { ...current, apiKey: '', clearApiKey: false } : current
        const stillDirty = isNonSecretDraftDirty(nextDraft, savedConfigRef.current)
        dirtyRef.current = stillDirty
        setDirty(stillDirty)
        return nextDraft
      })
    }
    const startPolling = () => {
      stopPolling()
      if (document.hidden) return
      void refreshWorkspace()
      timer = window.setInterval(() => { if (!readController.current && !document.hidden) void refreshWorkspace() }, 2000)
    }
    const visibilityChanged = () => {
      setVisible(!document.hidden)
      if (document.hidden) {
        stopPolling()
        clearSecretsOnHide()
        abortInFlightModels()
        setModelTest(null)
      }
      else startPolling()
    }
    const pageHidden = () => { stopPolling(); clearSecretsOnHide(); clearModelsState(); setVisible(false) }
    const pageShown = () => { setVisible(!document.hidden); if (!document.hidden) startPolling() }
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('pagehide', pageHidden)
    window.addEventListener('pageshow', pageShown)
    startPolling()
    return () => {
      mounted.current = false
      if (timer !== undefined) window.clearInterval(timer)
      ++generation.current
      readController.current?.abort(); readController.current = null
      actionController.current?.abort(); actionController.current = null
      ++modelGeneration.current; modelController.current?.abort(); modelController.current = null
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', pageHidden)
      window.removeEventListener('pageshow', pageShown)
    }
  }, [refreshWorkspace, abortInFlightModels, clearModelsState])

  useEffect(() => { if (plugin && !plugin.enabled) clearModelsState() }, [plugin?.enabled, clearModelsState])

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => {
      if (!current) return current
      const next = { ...current, [key]: value, ...(key === 'clearApiKey' && value === true ? { apiKey: '' } : {}) }
      const nextDirty = next.apiKey.length > 0 || next.clearApiKey || isNonSecretDraftDirty(next, savedConfigRef.current)
      dirtyRef.current = nextDirty
      setDirty(nextDirty)
      return next
    })
    setResult(''); setModelTest(null)
    if (key === 'apiKey' || key === 'clearApiKey') setSecretClearedOnHide(false)
    if (key === 'endpoint' || key === 'apiKey' || key === 'clearApiKey') { setModels(null); setModelFailure(null) }
    setFieldIssues(current => { const next = { ...current }; delete next[key]; return next })
  }

  function selectProtocol(nextProtocol: DshApiProtocol) {
    setDraft(current => {
      if (!current || current.protocol === nextProtocol) return current
      protocolDrafts.current[current.protocol] = { endpoint: current.endpoint, model: current.model }
      const savedConfig = savedConfigRef.current
      const restored = protocolDrafts.current[nextProtocol]
        ?? (savedConfig && savedConfig.protocol === nextProtocol
          ? { endpoint: savedConfig.endpoint, model: savedConfig.model }
          : nextProtocol === 'google-generative-ai'
            ? { endpoint: GOOGLE_GEMINI_DEFAULT_ENDPOINT, model: '' }
            : { endpoint: '', model: '' })
      const next: Draft = {
        ...current,
        protocol: nextProtocol,
        endpoint: restored.endpoint,
        model: restored.model,
        clearApiKey: false,
      }
      const nextDirty = next.apiKey.length > 0 || next.clearApiKey || isNonSecretDraftDirty(next, savedConfig)
      dirtyRef.current = nextDirty
      setDirty(nextDirty)
      return next
    })
    setResult(''); setModelTest(null); setModels(null); setModelFailure(null)
    setFieldIssues(current => {
      const next = { ...current }
      delete next.protocol; delete next.endpoint; delete next.model
      return next
    })
  }

  const saved = plugin?.configuration
  const runtime = saved?.runtimeStatus
  const state = plugin?.status.state
  const starting = state === 'connecting' || state === 'reconnecting'
  const active = state === 'connected'
  const needsSavedKey = Boolean(saved && protocolRequiresApiKey(saved.protocol) && !saved.apiKeyConfigured)
  const configured = Boolean(saved?.endpoint.trim() && saved.model.trim() && !needsSavedKey)
  const protocolChanged = Boolean(draft && saved && draft.protocol !== saved.protocol)
  const endpointOrKeyDirty = Boolean(draft && saved && (draft.protocol !== saved.protocol || draft.endpoint.trim() !== saved.endpoint.trim() || draft.apiKey.length > 0 || draft.clearApiKey))
  const modelIdentityDirty = endpointOrKeyDirty || Boolean(draft && saved && draft.model.trim() !== saved.model.trim())
  const blocked = operation !== null || modelOperation !== null || capabilitySaving || starting || !visible || refreshFailure !== null || uncertain !== null

  async function requestModel(next: ModelOperation) {
    if (!plugin?.enabled || !saved?.endpoint.trim() || needsSavedKey || endpointOrKeyDirty) return
    if (next === 'test-connection' && (!configured || modelIdentityDirty)) return
    if (blocked || actionLock.current) return
    actionLock.current = true; setModelOperation(next); setModelFailure(null); setModelTest(null)
    if (next === 'list-models') setModels(null)
    ++generation.current; readController.current?.abort(); setReading(false)
    const ticket = ++modelGeneration.current
    const controller = new AbortController()
    const deadline = new AbortController()
    modelController.current = controller
    const timer = window.setTimeout(() => deadline.abort(), 15_000)
    const valid = () => mounted.current && !document.hidden && !controller.signal.aborted && modelGeneration.current === ticket
    try {
      const value = await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: next, input: {} }, signal: AbortSignal.any([controller.signal, deadline.signal]) })
      if (!valid()) return
      if (next === 'list-models') setModels(readModels(value))
      else setModelTest(readModelTest(value, saved.model))
    } catch (error) {
      if (valid()) setModelFailure({ ...failureFrom(deadline.signal.aborted ? new HostApiError('MODEL_REQUEST_TIMEOUT', '') : error), outcome: 'failed' })
    } finally {
      window.clearTimeout(timer)
      deadline.abort()
      if (modelController.current === controller) {
        modelController.current = null; actionLock.current = false
        if (mounted.current && modelGeneration.current === ticket) setModelOperation(null)
      }
    }
  }

  async function mutate(next: Operation) {
    if (!draft || !plugin || !visible || actionLock.current || blocked || !plugin.enabled) return
    const savesConfig = next === 'save' || next === 'save-and-start'
    if (savesConfig) {
      const issues = validateFields({ ...draft })
      setFieldIssues(issues)
      if (Object.keys(issues).length > 0) { setActionFailure({ code: 'INVALID_CONFIGURATION', error: { code: 'INVALID_CONFIGURATION' }, messageKey: 'validation.configuration', outcome: 'not-sent' }); return }
    }
    const draftHasEffectiveKey = draft.apiKey.trim().length > 0 || (saved?.apiKeyConfigured === true && draft.protocol === saved.protocol && !draft.clearApiKey)
    if (next === 'save-and-start' && (!draft.endpoint.trim() || !draft.model.trim() || (protocolRequiresApiKey(draft.protocol) && !draftHasEffectiveKey) || !runtime?.system.found || active)) return
    if (next === 'connect' && (dirtyRef.current || !configured || !runtime?.system.found || active)) return
    if (next === 'disconnect' && !active && state !== 'error') return
    actionLock.current = true; setOperation(next); setResult(''); setActionFailure(null)
    ++generation.current; readController.current?.abort(); setReading(false)
    const controller = new AbortController()
    actionController.current = controller
    let stage: Exclude<Operation, 'save-and-start'> = savesConfig ? 'save' : next
    try {
      if (savesConfig) {
        const shouldClearKey = draft.clearApiKey && draft.protocol === saved?.protocol
        const response = readConfiguration(await hostRequest<unknown>('/plugins/dsh/configuration', { method: 'POST', signal: controller.signal, body: {
          displayName: draft.displayName.trim(), protocol: draft.protocol, endpoint: draft.endpoint.trim(), model: draft.model.trim(), autoConnect: draft.autoConnect,
          timeoutMs: Number(draft.timeoutMs), maxTokens: Number(draft.maxTokens),
          ...(draft.apiKey.trim() && !shouldClearKey ? { apiKey: draft.apiKey } : {}),
          ...(shouldClearKey ? { clearApiKey: true } : {}),
        } }))
        if (!mounted.current || controller.signal.aborted) return
        protocolDrafts.current = {}
        dirtyRef.current = false; setDirty(false); setDraft(makeDraft(response)); setSecretClearedOnHide(false); setModelTest(null); setModelFailure(null)
        if (next === 'save') setModels(null)
        setPlugin(current => current ? { ...current, configuration: response } : current)
        setResult('result.saved'); callbacks.current.onFeedback(translate('dsh', 'feedback.saved'))
      }
      if (next === 'save-and-start' || next === 'connect' || next === 'disconnect') {
        stage = next === 'disconnect' ? 'disconnect' : 'connect'
        if (next === 'save-and-start' && mounted.current) setOperation('connect')
        await hostRequest<unknown>(`/plugins/dsh/${stage}`, { method: 'POST', signal: controller.signal, body: {} })
        if (!mounted.current || controller.signal.aborted) return
        setResult(stage === 'connect' ? 'result.connect' : 'result.disconnect')
      }
      await refreshWorkspace(true)
      if (mounted.current && !controller.signal.aborted) void callbacks.current.onRefresh?.().catch(() => {})
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      const failure = failureFrom(error)
      setActionFailure(failure)
      if (failure.outcome === 'unknown') {
        setUncertain({ operation: stage, afterRead: readCount.current })
        setDraft(current => current ? { ...current, apiKey: '', clearApiKey: false } : current)
      }
      await refreshWorkspace(true)
    } finally {
      if (actionController.current === controller) actionController.current = null
      actionLock.current = false
      if (mounted.current) setOperation(null)
    }
  }
  async function detectSystem() {
    if (!plugin || !visible || actionLock.current || blocked) return
    actionLock.current = true; setOperation('detect'); setResult(''); setActionFailure(null)
    const controller = new AbortController(); actionController.current = controller
    try {
      await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal: controller.signal, body: { operation: 'detect-system-dsh', input: {} } })
      if (!mounted.current || controller.signal.aborted) return
      setResult('result.detected')
      await refreshWorkspace(true)
      if (mounted.current && !controller.signal.aborted) void callbacks.current.onRefresh?.().catch(() => {})
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      setActionFailure(failureFrom(error))
    } finally {
      if (actionController.current === controller) actionController.current = null
      actionLock.current = false
      if (mounted.current) setOperation(null)
    }
  }

  const fieldErrors = Object.fromEntries(Object.entries(fieldIssues).map(([name, issue]) => [name, validationMessage(issue)]))
  const id = (name: string) => `${prefix}-${name}`
  const describedBy = (name: string) => `${id(name)}-hint${fieldErrors[name] ? ` ${id(name)}-error` : ''}`
  const processing = t(active && runtime?.ready ? runtime.busy ? 'processing.busy' : 'processing.idle' : starting ? 'processing.starting' : 'processing.stopped')
  const systemFound = runtime?.system.found === true
  const systemChecking = loading || operation === 'detect'
  const systemUnconfirmed = refreshFailure !== null || !runtime
  const systemRuntimeError = systemFound && Boolean(plugin?.status.lastError || runtime?.lastError)
  const runtimeCompact = systemFound && !systemRuntimeError && !systemChecking && !systemUnconfirmed
  const runtimeLabel = t(systemChecking ? 'system.checking' : systemUnconfirmed ? 'system.unknown' : systemRuntimeError ? 'system.runtimeError' : systemFound ? 'system.detected' : 'system.missing')
  const runtimeHelp = t(systemChecking ? 'system.help.checking' : systemUnconfirmed ? 'system.help.unknown' : systemRuntimeError ? 'system.help.runtimeError' : systemFound ? configured ? 'system.help.configured' : 'system.help.unconfigured' : 'system.help.missing')
  const outcomeKey = runtime?.lastOutcome ? outcomeKeys[runtime.lastOutcome] : undefined
  const statusLabel = plugin ? refreshFailure ? t('state.unconfirmed') : t(stateKeys[plugin.status.state]) : t('state.loading')
  const statusDotClass = active && runtime?.ready ? 'is-live' : starting ? 'is-starting' : state === 'error' || systemRuntimeError ? 'is-error' : ''
  const draftHasEffectiveKey = Boolean(draft && (draft.apiKey.trim().length > 0 || (saved?.apiKeyConfigured === true && !protocolChanged && !draft.clearApiKey)))
  const canSaveAndStart = Boolean(draft && dirty && draft.endpoint.trim() && draft.model.trim() && (!protocolRequiresApiKey(draft.protocol) || draftHasEffectiveKey) && systemFound && !active)
  const isGemini = draft?.protocol === 'google-generative-ai'
  const apiKeyHintKey: DshTranslationKey = protocolChanged && saved?.apiKeyConfigured
    ? 'field.apiKey.hint.protocolSwitched'
    : saved?.apiKeyConfigured && !protocolChanged
      ? 'field.apiKey.hint.saved'
      : isGemini
        ? 'field.apiKey.hint.empty.gemini'
        : 'field.apiKey.hint.empty.openai'
  const modelActionHelpKey: DshTranslationKey = endpointOrKeyDirty
    ? 'models.saveEndpointFirst'
    : needsSavedKey
      ? 'models.saveKeyFirst'
      : modelIdentityDirty
        ? 'models.saveFirst'
        : 'models.savedOnly'
  const saveNoticeKey: DshTranslationKey = dirty
    ? 'saveHint.dirty'
    : needsSavedKey
      ? 'saveHint.missingApiKey'
      : !configured
        ? 'saveHint.unconfigured'
        : !systemFound
          ? 'saveHint.missingRuntime'
          : 'notice.saveStopsRuntime'

  return <div className="dsh-panel">
    <div className="dsh-status-strip">
      <div className="dsh-status-summary">
        <span className={`dsh-status-dot${statusDotClass ? ` ${statusDotClass}` : ''}`} aria-hidden="true" />
        <strong>{statusLabel}</strong>
        {runtime && processing !== statusLabel && <span>{processing}</span>}
      </div>
      <div className="dsh-status-actions">
        <ActionButton reasonCode="busy" type="button" className="text-button" disabled={operation !== null || modelOperation !== null || reading || !visible} onClick={() => void refreshWorkspace()}><RefreshCw size={14} aria-hidden="true" />{t(reading ? 'action.refreshing' : 'action.refresh')}</ActionButton>
        <NativeWebButton enabled={plugin?.enabled === true} ready={active && runtime?.ready === true && runtime?.nativeWeb.ready === true} blocked={operation !== null || modelOperation !== null || capabilitySaving || starting || refreshFailure !== null || uncertain !== null} visible={visible} />
      </div>
    </div>
    <section className={`dsh-runtime${runtimeCompact ? ' is-compact' : ''}`} aria-labelledby={id('runtime-title')}>
      <div className="dsh-runtime-heading">
        <div className="dsh-runtime-meta">
          <div className="dsh-runtime-title-row">
            <h3 id={id('runtime-title')}>{t('system.title')}</h3>
            <p className="dsh-runtime-status" role="status">{runtime?.system.version && !systemChecking && !systemUnconfirmed ? t('system.versionedStatus', { status: runtimeLabel, version: runtime.system.version }) : runtimeLabel}</p>
          </div>
          {runtimeCompact && (
            <p className="dsh-runtime-inline-detail">
              <span>{runtimeHelp}</span>
              {runtime?.system.path && <code>{runtime.system.path}</code>}
            </p>
          )}
        </div>
        <ActionButton reasonCode="busy" type="button" className="button button-secondary dsh-runtime-detect" disabled={blocked || !plugin?.enabled || operation !== null || loading} onClick={() => void detectSystem()}><RefreshCw size={15} aria-hidden="true" />{t(operation === 'detect' ? 'action.detecting' : 'action.detect')}</ActionButton>
      </div>
      {!runtimeCompact && <>
        <p className="dsh-help">{runtimeHelp}</p>
        {runtime?.system.path && <p className="dsh-help"><code>{runtime.system.path}</code></p>}
      </>}
      {systemFound && !runtime?.system.version && !systemChecking && !systemUnconfirmed && <p className="dsh-help">{t('system.help.versionUnknown')}</p>}
      {!systemFound && !systemChecking && !systemUnconfirmed && (
        <details className="dsh-system-guide-details">
          <summary>{t('system.installToggle')}</summary>
          <div className="dsh-notice">
            <Info size={16} aria-hidden="true" />
            <div>
              <p>{t('system.installGuide')} <a className="text-button" href="https://www.deepseek.com/en/harness/" target="_blank" rel="noreferrer">{t('system.installLink')}</a></p>
              <p className="dsh-help">{t('system.installCommand')}</p>
              <p className="dsh-help"><code>npm install -g @deepseek-ai/dsh</code></p>
            </div>
          </div>
        </details>
      )}
      {runtime?.lastError && runtime.lastError !== plugin?.status.lastError && <ErrorNotice failure={runtimeFailure('HARNESS_RUNTIME_ERROR', runtime.lastError)} />}
    </section>
    <ErrorNotice failure={refreshFailure} />
    {plugin?.status.lastError && <ErrorNotice failure={runtimeFailure('HARNESS_STATUS_ERROR', plugin.status.lastError)} />}
    {loading && <p className="dsh-loading" role="status">{t('loading.configuration')}</p>}
    {!plugin && !loading && <ActionButton reasonCode="busy" type="button" className="button button-secondary" disabled={reading} onClick={() => void refreshWorkspace()}>{t('action.reload')}</ActionButton>}
    <SegmentedTabs
      idPrefix={prefix}
      className="dsh-tabs"
      ariaLabel={nativeT('tabs.label')}
      activeTab={panelTab}
      onSelect={setPanelTab}
      tabs={[
        { id: 'connection', label: nativeT('tabs.connection'), dirty },
        { id: 'native', label: nativeT('tabs.native'), dirty: nativeDirty },
        { id: 'history', label: historyT('tab') },
      ]}
    />
    <div className="dsh-settings-page" role="tabpanel" id={`${prefix}-panel-connection`} aria-labelledby={`${prefix}-tab-connection`} hidden={panelTab !== 'connection'}>
    {draft && <section aria-labelledby={id('configuration-title')}>
      <div className="section-heading"><h3 id={id('configuration-title')}>{t('configuration.title')}</h3><p>{t('configuration.description')}</p></div>
      {saved?.warning && <div className="dsh-notice"><Info size={16} aria-hidden="true" /><p>{t('notice.httpWarning')}</p></div>}
      <form className="form-fields" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate('save') }}>
        <fieldset className="dsh-fieldset" disabled={operation !== null || modelOperation !== null || starting || !visible}>
          <div className="dsh-form-group">
            <div className="dsh-form-group-head">
              <h4>{t('section.connection.title')}</h4>
              <p>{t('section.connection.description')}</p>
            </div>
            <div className={`field${fieldErrors.protocol ? ' field-invalid' : ''}`}>
              <span className="dsh-field-label" id={id('protocol-label')}>{t('field.protocol.label')}</span>
              <div className="dsh-protocol-grid" role="radiogroup" aria-labelledby={id('protocol-label')} aria-describedby={describedBy('protocol')}>
                {DSH_API_PROTOCOLS.map(protocol => {
                  const selected = draft.protocol === protocol
                  return (
                    <label key={protocol} className={`dsh-protocol-option${selected ? ' is-selected' : ''}`}>
                      <input
                        type="radio"
                        name={`${prefix}-protocol`}
                        value={protocol}
                        checked={selected}
                        onChange={() => selectProtocol(protocol)}
                      />
                      <span className="dsh-protocol-indicator" aria-hidden="true" />
                      <span className="dsh-protocol-copy">
                        <strong>{t(protocolCopy[protocol].label)}</strong>
                        <code>{t(protocolCopy[protocol].caption)}</code>
                      </span>
                    </label>
                  )
                })}
              </div>
              <p className="field-hint" id={`${id('protocol')}-hint`}>{t('field.protocol.hint')}</p>
              {fieldErrors.protocol && <p className="field-error" id={`${id('protocol')}-error`}>{fieldErrors.protocol}</p>}
            </div>
            <Field
              id={id('endpoint')}
              label={t('field.endpoint.label')}
              hint={<>
                <span>{t(isGemini ? 'field.endpoint.hint.gemini' : 'field.endpoint.hint.openai')}</span>
                {isGemini && draft.endpoint.trim() !== GOOGLE_GEMINI_DEFAULT_ENDPOINT && (
                  <button type="button" className="text-button dsh-inline-action" onClick={() => updateDraft('endpoint', GOOGLE_GEMINI_DEFAULT_ENDPOINT)}>
                    {t('field.endpoint.fillGeminiDefault')}
                  </button>
                )}
              </>}
              error={fieldErrors.endpoint}
            >
              <input
                id={id('endpoint')}
                type="url"
                value={draft.endpoint}
                placeholder={t(isGemini ? 'field.endpoint.placeholder.gemini' : 'field.endpoint.placeholder.openai')}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={describedBy('endpoint')}
                aria-invalid={Boolean(fieldErrors.endpoint)}
                onChange={event => updateDraft('endpoint', event.target.value)}
              />
            </Field>
            <Field id={id('apiKey')} label={t('field.apiKey.label')} hint={t(apiKeyHintKey)} error={fieldErrors.apiKey}>
              <PasswordInput
                id={id('apiKey')}
                value={draft.apiKey}
                saved={saved?.apiKeyConfigured === true && !protocolChanged}
                clear={draft.clearApiKey}
                hiddenClearedNotice={secretClearedOnHide}
                maxLength={4096}
                clearLabel={t('field.clearApiKey.label')}
                undoClearLabel={t('field.clearApiKey.undo')}
                aria-describedby={describedBy('apiKey')}
                aria-invalid={Boolean(fieldErrors.apiKey)}
                onChange={value => updateDraft('apiKey', value)}
                onClearChange={saved?.apiKeyConfigured === true && !protocolChanged ? checked => updateDraft('clearApiKey', checked) : undefined}
              />
            </Field>
          </div>

          <div className="dsh-form-group">
            <div className="dsh-form-group-head">
              <h4>{t('section.model.title')}</h4>
              <p>{t('section.model.description')}</p>
            </div>
            <Field id={id('model')} label={t('field.model.label')} hint={t('field.model.hint')} error={fieldErrors.model}>
              <div className="dsh-model-input-row">
                <input
                  id={id('model')}
                  value={draft.model}
                  placeholder={t(isGemini ? 'field.model.placeholder.gemini' : 'field.model.placeholder.openai')}
                  list={models && models.length > 0 ? id('model-datalist') : undefined}
                  maxLength={160}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={describedBy('model')}
                  aria-invalid={Boolean(fieldErrors.model)}
                  onChange={event => updateDraft('model', event.target.value)}
                />
                {models && models.length > 0 && (
                  <datalist id={id('model-datalist')}>
                    {models.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? model.name : undefined}</option>)}
                  </datalist>
                )}
                <select
                  id={id('model-choice')}
                  aria-label={t('models.choose')}
                  disabled={!models || models.length === 0}
                  value={models && models.some(model => model.id === draft.model) ? draft.model : ''}
                  onChange={event => { if (event.target.value) updateDraft('model', event.target.value) }}>
                  <option value="" disabled>
                    {models === null ? t('models.choiceEmpty') : models.length === 0 ? t('models.noneReturned') : t('models.choosePlaceholder')}
                  </option>
                  {models?.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}</option>)}
                </select>
              </div>
            </Field>
            <div className="dsh-model-feedback">
              <div className="dsh-model-actions">
                <ActionButton
                  reasonCode={!plugin?.enabled ? 'enable' : blocked ? 'busy' : endpointOrKeyDirty ? 'draft' : 'configure'}
                  reason={endpointOrKeyDirty ? t('models.saveEndpointFirst') : needsSavedKey ? t('models.saveKeyFirst') : undefined}
                  className="button button-secondary"
                  type="button"
                  disabled={blocked || endpointOrKeyDirty || !saved?.endpoint.trim() || needsSavedKey || !plugin?.enabled}
                  onClick={() => void requestModel('list-models')}>
                  <RefreshCw size={15} aria-hidden="true" />
                  {t(modelOperation === 'list-models' ? 'models.fetching' : 'models.fetch')}
                </ActionButton>
                <ActionButton
                  reasonCode={!plugin?.enabled ? 'enable' : blocked ? 'busy' : modelIdentityDirty ? 'draft' : 'configure'}
                  reason={needsSavedKey && !modelIdentityDirty ? t('models.saveKeyFirst') : undefined}
                  className="button button-secondary"
                  type="button"
                  disabled={blocked || modelIdentityDirty || !configured || !plugin?.enabled}
                  onClick={() => void requestModel('test-connection')}>
                  {t(modelOperation === 'test-connection' ? 'models.testing' : 'models.test')}
                </ActionButton>
              </div>
              <p className="dsh-model-help">{t(modelActionHelpKey)}</p>
              <p className="dsh-model-help dsh-model-note">{t('models.testNotice')}</p>
              {models !== null && <p className="dsh-result" role="status">{t(models.length ? 'models.loaded' : 'models.empty', { count: models.length, value: formatNumber(models.length) })}</p>}
              {models && models.length > 0 && draft.model && !models.some(model => model.id === draft.model) && <p className="dsh-model-help">{t('models.currentManual')}</p>}
              {modelTest && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('models.success', { model: modelTest.model, latency: formatNumber(modelTest.latencyMs) })}</p>}
              <ErrorNotice failure={modelFailure} />
              <ModelCapabilitiesSettings
                routeKey={JSON.stringify([saved?.protocol, saved?.endpoint, saved?.model])}
                catalogKey={JSON.stringify([saved?.protocol, saved?.endpoint, saved?.model, saved?.updatedAt])}
                configured={configured}
                savedModel={saved?.model ?? ''}
                draftModel={draft.model}
                identityMatches={!endpointOrKeyDirty}
                models={models}
                active={visible && panelTab === 'connection'}
                enabled={plugin?.enabled === true}
                runtimeActive={active || starting || runtime?.ready === true || runtime?.busy === true}
                busy={operation !== null || modelOperation !== null || refreshFailure !== null || uncertain !== null}
                actionLock={actionLock}
                onBusy={setCapabilitySaving}
              />
            </div>
          </div>

          <div className="dsh-form-group">
            <div className="dsh-form-group-head">
              <h4>{t('section.runtime.title')}</h4>
              <p>{t('section.runtime.description')}</p>
            </div>
            <Field id={id('displayName')} label={t('field.displayName.label')} hint={t('field.displayName.hint')} error={fieldErrors.displayName}>
              <input id={id('displayName')} maxLength={80} value={draft.displayName} autoComplete="off" aria-describedby={describedBy('displayName')} aria-invalid={Boolean(fieldErrors.displayName)} onChange={event => updateDraft('displayName', event.target.value)} />
            </Field>
            <Field id={id('timeoutMs')} label={t('field.timeoutMs.label')} hint={t('field.timeoutMs.hint', { min: formatNumber(1000), max: formatNumber(120000) })} error={fieldErrors.timeoutMs}>
              <DurationInput
                id={id('timeoutMs')}
                valueMs={draft.timeoutMs}
                presetsSeconds={[10, 30, 60, 120]}
                aria-describedby={describedBy('timeoutMs')}
                aria-invalid={Boolean(fieldErrors.timeoutMs)}
                onChangeMs={next => updateDraft('timeoutMs', next)}
              />
            </Field>
            <Field id={id('maxTokens')} label={t('field.maxTokens.label')} hint={t('field.maxTokens.hint', { min: formatNumber(1), max: formatNumber(131072) })} error={fieldErrors.maxTokens}>
              <input id={id('maxTokens')} className="dsh-numeric-input" type="number" min={1} max={131072} step={1} inputMode="numeric" value={draft.maxTokens} aria-describedby={describedBy('maxTokens')} aria-invalid={Boolean(fieldErrors.maxTokens)} onChange={event => updateDraft('maxTokens', event.target.value)} />
            </Field>
            <div className="dsh-switch-row">
              <Switch
                id={id('autoConnect')}
                checked={draft.autoConnect}
                label={t('field.autoConnect.label')}
                description={t('field.autoConnect.hint')}
                onChange={checked => updateDraft('autoConnect', checked)}
              />
            </div>
          </div>
        </fieldset>
        <FormSaveBar
          alwaysVisible
          dirty={dirty}
          saving={operation === 'save'}
          disabled={blocked || !plugin?.enabled}
          disabledReason={commonT(!plugin?.enabled ? 'actionReason.enable' : starting ? 'actionReason.loading' : 'actionReason.busy')}
          uncertain={uncertain !== null}
          saveLabel={t('action.save')}
          savingLabel={t('action.saving')}
          discardLabel={t('action.discard')}
          notice={t(saveNoticeKey)}
          onSave={() => void mutate('save')}
          onDiscard={() => {
            if (!saved) return
            protocolDrafts.current = {}
            dirtyRef.current = false
            setDirty(false)
            setDraft(makeDraft(saved))
            setFieldIssues({})
            setActionFailure(null)
            setResult('')
            setSecretClearedOnHide(false)
            setModels(null)
            setModelTest(null)
            setModelFailure(null)
          }}
          extraActions={<>
            {canSaveAndStart && (
              <ActionButton
                reasonCode={!plugin?.enabled ? 'enable' : 'busy'}
                className="button button-secondary"
                type="button"
                disabled={blocked || !plugin?.enabled}
                onClick={() => void mutate('save-and-start')}>
                {t(operation === 'save-and-start' || starting ? 'action.starting' : 'action.saveAndStart')}
              </ActionButton>
            )}
            <ActionButton
              reasonCode={!plugin?.enabled ? 'enable' : blocked ? 'busy' : dirty ? 'draft' : !configured ? 'configure' : !systemFound ? 'runtime' : 'running'}
              reason={!dirty && needsSavedKey ? t('saveHint.missingApiKey') : undefined}
              className="button button-secondary"
              type="button"
              disabled={blocked || dirty || !configured || !systemFound || !plugin?.enabled || active}
              onClick={() => void mutate('connect')}>
              {t(operation === 'connect' || starting ? 'action.starting' : 'action.start')}
            </ActionButton>
            <ActionButton
              reasonCode={blocked ? 'busy' : 'stopped'}
              className="button button-secondary"
              type="button"
              disabled={blocked || !active && state !== 'error'}
              onClick={() => void mutate('disconnect')}>
              {t(operation === 'disconnect' ? 'action.stopping' : 'action.stop')}
            </ActionButton>
          </>}
        />
      </form>
      {result && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t(result)}</p>}
      <ErrorNotice failure={actionFailure} />
      {uncertain && (
        <UnknownOutcomeCard
          title={t(uncertainKeys[uncertain.operation])}
          body={t('uncertain.description')}
          refreshing={reading}
          refreshLabel={t('action.refresh')}
          confirmLabel={t('uncertain.confirm')}
          onRefresh={() => void refreshWorkspace()}
          onConfirmReviewed={() => {
            if (reading || refreshFailure !== null || readSerial <= uncertain.afterRead) {
              void refreshWorkspace()
              return
            }
            setUncertain(null)
            setActionFailure(null)
            setResult('result.confirmed')
          }}
        />
      )}
    </section>}
    {runtime && <dl className="dsh-details">
      <div><dt>{t('details.processing')}</dt><dd>{refreshFailure ? t('state.unconfirmed') : processing}</dd></div>
      {saved && <div><dt>{t('details.protocol')}</dt><dd>{t(protocolCopy[saved.protocol].label)}</dd></div>}
      {runtime.sessionId && <div><dt>{t('details.sessionId')}</dt><dd className="dsh-mono">{runtime.sessionId}</dd></div>}
      {runtime.system.version && <div><dt>{t('details.version')}</dt><dd className="dsh-mono">{runtime.system.version}</dd></div>}
      {runtime.lastOutcome && <div><dt>{t('details.outcome')}</dt><dd>{outcomeKey ? t(outcomeKey) : runtime.lastOutcome}</dd></div>}
    </dl>}
    {(saved?.dataDirectory || saved?.configurationPath) && <details className="dsh-file-details"><summary>{t('details.files')}</summary><dl className="dsh-details">{saved.dataDirectory && <div><dt>{t('details.dataDirectory')}</dt><dd className="dsh-mono">{saved.dataDirectory}</dd></div>}{saved.configurationPath && <div><dt>{t('details.configurationPath')}</dt><dd className="dsh-mono">{saved.configurationPath}</dd></div>}</dl></details>}
    <div className="dsh-notice dsh-boundary"><Info size={16} aria-hidden="true" /><p>{t('notice.authentication')}</p></div>
    </div>
    <div className="dsh-settings-page" role="tabpanel" id={`${prefix}-panel-native`} aria-labelledby={`${prefix}-tab-native`} hidden={panelTab !== 'native'}>
      <NativeCapabilitiesSettings active={visible && panelTab === 'native' && systemFound && !loading} enabled={plugin?.enabled === true} runtimeActive={active || starting || runtime?.ready === true || runtime?.busy === true} busy={operation !== null || modelOperation !== null || refreshFailure !== null || uncertain !== null} actionLock={actionLock} onBusy={setCapabilitySaving} onDirtyChange={setNativeDirty} />
    </div>
    <div className="dsh-settings-page" role="tabpanel" id={`${prefix}-panel-history`} aria-labelledby={`${prefix}-tab-history`} hidden={panelTab !== 'history'}>
      <SessionHistorySettings active={visible && panelTab === 'history'} enabled={plugin?.enabled === true} runtimeActive={active || starting || runtime?.ready === true || runtime?.busy === true} busy={operation !== null || modelOperation !== null || refreshFailure !== null || uncertain !== null} actionLock={actionLock} onBusy={setCapabilitySaving} onRefresh={refreshWorkspace} />
    </div>
  </div>
}
