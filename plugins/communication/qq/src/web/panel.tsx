import type { OneBotConfig } from '../config'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, MutableRefObject, ReactNode } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Check, Copy, RefreshCw, Trash2, X } from 'lucide-react'
import {
  ActionButton,
  createRequestId,
  DurationInput,
  formatNumber,
  FormSaveBar,
  getErrorMessage,
  HostApiError,
  hostRequest,
  PasswordInput,
  SegmentedTabs,
  Switch,
  translate,
  useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { enumValue, parseToolArguments, schemaFields } from './tool-fields'
import type { FieldFormat, SchemaField } from './tool-fields'
import type { AgentTypeDefinition, ConnectionStatus, JsonObject, JsonValue, PluginCapability, PluginToolDefinition } from '@eating/plugin-sdk'
import './panel.css'
import { capabilityDescription, capabilityTitle, parameterDescription, parameterLabel, parameterOptionLabel, toolDescription, toolSchemaHelp, toolTitle } from './i18n'
import type { QQMessage, QQTranslationKey } from './i18n'
import { LiveLogs } from './live-logs'
import { ImageResult, readImagePreview } from './ImageResult'
import { MediaTransportFields } from './media-transport'
import { AudioInputFields } from './audio-input'
import { MessageSplitFields } from './message-split'
import type { ImagePreviewResult } from './ImageResult'
import { AgentPolicyFields, agentPolicyDraft } from './agent-policy-fields'
import { isJsonObject } from '@eating/plugin-sdk'

type Tab = 'configuration' | 'agent-policy' | 'tests' | 'mcp' | 'live-logs'
type ConnectionConfiguration = Pick<OneBotConfig, 'displayName' | 'endpoint' | 'accessToken' | 'autoConnect' | 'forwardToHarness' | 'receiveGroups' | 'timeoutMs'>
type PublicConfiguration = Omit<ConnectionConfiguration, 'accessToken'> & {
  tokenConfigured: boolean
  instanceId: string
  defaultInstanceId: string
  configurationPath: string
  dataDirectory: string
  updatedAt: string | null
  instances: { instanceId: string; label: string; createdAt: string }[]
}
type Draft = Omit<ConnectionConfiguration, 'timeoutMs'> & { timeoutMs: string; clearAccessToken: boolean }
type FieldErrors = Record<string, QQMessage | undefined>
interface QQWorkspacePlugin {
  id: string
  enabled: boolean
  logsSupported?: boolean
  agentTypes: AgentTypeDefinition[]
  configuration: JsonObject
  status: ConnectionStatus
  capabilities: PluginCapability[]
  tools: PluginToolDefinition[]
}
interface Workspace {
  protocolVersion: 1
  plugins: QQWorkspacePlugin[]
  harness: { state: 'not-attached' | 'attached'; pending: number; accepted: number; uncertain: number }
}
interface InvokeResult { ok: true; requestId: string; result: JsonValue }
interface Failure { message: string; code: string; outcome: string; messageKey?: QQTranslationKey; fallbackKey?: QQTranslationKey }
interface Execution {
  tool: PluginToolDefinition
  requestId: string
  arguments: JsonObject
  startedAt: string
  result?: JsonValue
  contentResult?: true
  failure?: Failure
  pending: boolean
}
interface McpRegistration { transport: 'streamable-http'; url: string; headers: { Authorization: string }; note: string }
interface ToolPrefill {
  serial: number
  toolName: string
  values: Record<string, string>
  formats?: Record<string, FieldFormat>
}
type MessageInputMode = 'text' | 'visual' | 'json'
type VisualSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string } }
  | { type: 'at'; data: { qq: string } }

type QQPanelProps = PluginPanelProps

function failureFrom(error: unknown, fallbackKey: QQTranslationKey = 'error.operationFailed'): Failure {
  if (error instanceof HostApiError) return { message: error.message, code: error.code, outcome: error.outcome, fallbackKey }
  return { message: error instanceof Error ? error.message : '', code: 'UNEXPECTED_ERROR', outcome: 'unknown', fallbackKey }
}
function localFailure(code: string, messageKey: QQTranslationKey): Failure {
  return { message: '', code, outcome: 'not-sent', messageKey }
}
function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? 'null' }
  catch { return translate('qq', 'error.preview') }
}
function messageLabel(message: QQMessage | undefined, field?: string): string | undefined {
  if (!message) return undefined
  const params = Object.fromEntries(Object.entries(message.params ?? {}).map(([key, value]) => [key, typeof value === 'number' ? formatNumber(value) : value]))
  return translate('qq', message.key, { ...params, field })
}
export function publicConfiguration(value: unknown): PublicConfiguration {
  const invalid = (): never => { throw new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE')) }
  agentPolicyDraft(value, [])
  if (!isJsonObject(value) || Object.keys(value).some(key => !['displayName', 'endpoint', 'autoConnect', 'forwardToHarness', 'receiveGroups', 'timeoutMs', 'owners', 'administrators', 'agentTools', 'policyRevision', 'tokenConfigured', 'instanceId', 'defaultInstanceId', 'configurationPath', 'dataDirectory', 'updatedAt', 'instances'].includes(key))) return invalid()
  if (typeof value.displayName !== 'string' || !value.displayName || value.displayName !== value.displayName.trim() || value.displayName.length > 40 || typeof value.endpoint !== 'string' || value.endpoint.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(value.endpoint)) return invalid()
  if (value.endpoint) {
    try {
      const endpoint = new URL(value.endpoint)
      if (!['ws:', 'wss:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || value.endpoint.includes('@') || value.endpoint.includes('?') || value.endpoint.includes('#') || /\/(?:api|event)\/?$/.test(endpoint.pathname)) return invalid()
    } catch { return invalid() }
  }
  if (typeof value.autoConnect !== 'boolean' || typeof value.forwardToHarness !== 'boolean' || typeof value.receiveGroups !== 'boolean' || typeof value.tokenConfigured !== 'boolean' || typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 60000) return invalid()
  if (typeof value.instanceId !== 'string' || !value.instanceId || typeof value.defaultInstanceId !== 'string' || !value.defaultInstanceId || typeof value.configurationPath !== 'string' || !value.configurationPath || typeof value.dataDirectory !== 'string' || !value.dataDirectory || value.updatedAt !== null && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) || !Array.isArray(value.instances) || value.instances.length < 1 || value.instances.length > 100) return invalid()
  const instances = value.instances.map(entry => {
    if (!isJsonObject(entry) || Object.keys(entry).some(key => !['instanceId', 'label', 'createdAt'].includes(key)) || typeof entry.instanceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(entry.instanceId) || typeof entry.label !== 'string' || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) return invalid()
    return { instanceId: entry.instanceId, label: entry.label, createdAt: entry.createdAt }
  })
  if (new Set(instances.map(instance => instance.instanceId)).size !== instances.length || !instances.some(instance => instance.instanceId === value.instanceId) || !instances.some(instance => instance.instanceId === value.defaultInstanceId)) return invalid()
  return {
    displayName: value.displayName, endpoint: value.endpoint, autoConnect: value.autoConnect, forwardToHarness: value.forwardToHarness, receiveGroups: value.receiveGroups, timeoutMs: value.timeoutMs, tokenConfigured: value.tokenConfigured,
    instanceId: value.instanceId, defaultInstanceId: value.defaultInstanceId, configurationPath: value.configurationPath, dataDirectory: value.dataDirectory, updatedAt: value.updatedAt, instances,
  }
}
function makeDraft(value: PublicConfiguration): Draft {
  return {
    displayName: value.displayName, endpoint: value.endpoint, accessToken: '', clearAccessToken: false,
    autoConnect: value.autoConnect, forwardToHarness: value.forwardToHarness, receiveGroups: value.receiveGroups, timeoutMs: String(value.timeoutMs),
  }
}
function isConnectionDraftDirty(draft: Draft, saved: PublicConfiguration): boolean {
  return draft.displayName !== saved.displayName
    || draft.endpoint !== saved.endpoint
    || draft.accessToken !== ''
    || draft.clearAccessToken !== false
    || draft.autoConnect !== saved.autoConnect
    || draft.forwardToHarness !== saved.forwardToHarness
    || draft.receiveGroups !== saved.receiveGroups
    || draft.timeoutMs !== String(saved.timeoutMs)
}
function disconnectedStatus(): ConnectionStatus {
  return { state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
}

function parseVisualSegments(raw: string): VisualSegment[] | null {
  const trimmed = raw.trim()
  if (!trimmed) return []
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) }
  catch { return null }
  if (!Array.isArray(parsed)) return null
  const result: VisualSegment[] = []
  for (const item of parsed) {
    if (!isJsonObject(item) || typeof item.type !== 'string' || !isJsonObject(item.data)) return null
    if (item.type === 'text' && Object.keys(item.data).every(k => k === 'text') && typeof item.data.text === 'string') {
      result.push({ type: 'text', data: { text: item.data.text } })
    } else if (item.type === 'image' && Object.keys(item.data).every(k => k === 'file') && typeof item.data.file === 'string') {
      result.push({ type: 'image', data: { file: item.data.file } })
    } else if (item.type === 'at' && Object.keys(item.data).every(k => k === 'qq') && typeof item.data.qq === 'string') {
      result.push({ type: 'at', data: { qq: item.data.qq } })
    } else {
      return null
    }
  }
  return result
}

function ErrorNotice({ failure }: { failure: Failure | null }) {
  const { t } = useI18n('qq')
  if (!failure) return null
  const message = failure.messageKey ? t(failure.messageKey) : failure.code === 'QQ_MESSAGE_FORMAT_INVALID' ? t('error.messageFormat') : getErrorMessage(failure, t(failure.fallbackKey ?? 'error.operationFailed'))
  return <div className="qq-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{message}</p>
    {failure.outcome === 'unknown' && <p>{t('error.unknownOutcome')}</p>}
    <details><summary>{t('error.details')}</summary><small>{t('error.code', { code: failure.code })}</small>{failure.message && <p>{failure.message}</p>}</details>
  </div></div>
}
function JsonPreview({ label, value, onFeedback }: { label: string; value: unknown; onFeedback: (message: string) => void }) {
  const { t } = useI18n('qq')
  const [copyFailure, setCopyFailure] = useState<Failure | null>(null)
  const text = pretty(value)
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopyFailure(null); onFeedback(t('copy.done', { label })) }
    catch { setCopyFailure(localFailure('CLIPBOARD_UNAVAILABLE', 'error.copy')) }
  }
  return <div className="qq-json"><div className="qq-json-heading"><strong>{label}</strong><ActionButton reasonCode="busy" type="button" className="text-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{t('action.copy')}</ActionButton></div><pre tabIndex={0} aria-label={label}>{text}</pre><ErrorNotice failure={copyFailure} /></div>
}
function FormField({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}</label>{children}
    {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}{error && <p className="field-error" id={`${id}-error`}>{error}</p>}
  </div>
}

export function QQPanel({ onFeedback, onRefresh, onDirtyChange }: QQPanelProps) {
  const { t, formatNumber, formatDateTime } = useI18n('qq')
  const { t: commonT } = useI18n('common')
  const prefix = useId()
  const [tab, setTab] = useState<Tab>('configuration')
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [plugin, setPlugin] = useState<QQWorkspacePlugin | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<PublicConfiguration | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const savedRef = useRef<PublicConfiguration | null>(null)
  const [configurationReadFailure, setConfigurationReadFailure] = useState<Failure | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [policyDirty, setPolicyDirty] = useState(false)
  const [mediaTransportDirty, setMediaTransportDirty] = useState(false)
  const [audioInputDirty, setAudioInputDirty] = useState(false)
  const [messageSplitDirty, setMessageSplitDirty] = useState(false)
  const [tokenHiddenCleared, setTokenHiddenCleared] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshFailure, setRefreshFailure] = useState<Failure | null>(null)
  const [configurationFailure, setConfigurationFailure] = useState<Failure | null>(null)
  const [configurationResult, setConfigurationResult] = useState<{ key: QQTranslationKey; state?: ConnectionStatus['state'] } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [mutation, setMutation] = useState<'save' | 'connect' | 'disconnect' | null>(null)
  const [testing, setTesting] = useState(false)
  const [policySaving, setPolicySaving] = useState(false)
  const [mediaSaving, setMediaSaving] = useState(false)
  const [audioSaving, setAudioSaving] = useState(false)
  const [messageSplitSaving, setMessageSplitSaving] = useState(false)
  const [toolPrefill, setToolPrefill] = useState<ToolPrefill | null>(null)
  const actionLock = useRef(false)
  const mounted = useRef(false)
  const workspaceGeneration = useRef(0)
  const workspaceController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const callbacks = useRef({ onFeedback, onRefresh, onDirtyChange })
  callbacks.current = { onFeedback, onRefresh, onDirtyChange }

  const anyDirty = dirty || policyDirty || mediaTransportDirty || audioInputDirty || messageSplitDirty
  useEffect(() => {
    callbacks.current.onDirtyChange?.(anyDirty)
  }, [anyDirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  const refreshWorkspace = useCallback(async () => {
    if (actionLock.current) return
    const generation = ++workspaceGeneration.current
    workspaceController.current?.abort()
    const controller = new AbortController()
    workspaceController.current = controller
    try {
      const response = await hostRequest<Workspace>('/workspace', { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted || generation !== workspaceGeneration.current) return
      if (!isJsonObject(response) || response.protocolVersion !== 1 || !Array.isArray(response.plugins)) throw new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE'))
      const qq = response.plugins.find(entry => entry.id === 'qq')
      if (!qq) { setRefreshFailure(localFailure('PLUGIN_NOT_FOUND', 'error.pluginNotLoaded')); return }
      if (!isJsonObject(qq) || typeof qq.enabled !== 'boolean' || !isJsonObject(qq.status) || !['unconfigured', 'disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(String(qq.status.state)) || !Array.isArray(qq.agentTypes) || !Array.isArray(qq.tools) || qq.tools.some(item => !isJsonObject(item) || !['json', 'content'].includes(String(item.resultFormat))) || !Array.isArray(qq.capabilities)) throw new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE'))
      setWorkspace(response); setPlugin(qq); setRefreshFailure(null)
      try {
        const configuration = publicConfiguration(qq.configuration)
        agentPolicyDraft(qq.configuration, qq.agentTypes)
        savedRef.current = configuration
        setSaved(configuration); setConfigurationReadFailure(null)
        if (!dirtyRef.current) {
          const fresh = makeDraft(configuration)
          draftRef.current = fresh
          setDraft(fresh)
        }
      } catch (error) {
        savedRef.current = null
        setSaved(null); setConfigurationReadFailure(failureFrom(error))
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && generation === workspaceGeneration.current) {
        setRefreshFailure(failureFrom(error, 'error.refreshFailed'))
        if (error instanceof HostApiError && error.code === 'INVALID_HOST_RESPONSE') {
          savedRef.current = null
          setSaved(null); setConfigurationReadFailure(failureFrom(error))
        }
      }
    } finally {
      if (mounted.current && generation === workspaceGeneration.current) setLoading(false)
      if (workspaceController.current === controller) workspaceController.current = null
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refreshWorkspace()
    const interval = window.setInterval(() => { if (!document.hidden && !workspaceController.current) void refreshWorkspace() }, 2000)
    // Strategy 2a: wipe unsaved typed accessToken on document.hidden while preserving all non-secret drafts
    function onVisibilityChange() {
      if (!document.hidden) return
      const current = draftRef.current
      if (!current || !current.accessToken) return
      const next: Draft = { ...current, accessToken: '' }
      draftRef.current = next
      setDraft(next)
      setTokenHiddenCleared(true)
      const stillDirty = savedRef.current ? isConnectionDraftDirty(next, savedRef.current) : false
      dirtyRef.current = stillDirty
      setDirty(stillDirty)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      mounted.current = false
      ++workspaceGeneration.current
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      workspaceController.current?.abort()
      mutationController.current?.abort()
    }
  }, [refreshWorkspace])

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (key === 'accessToken' && typeof value === 'string' && value.length > 0) setTokenHiddenCleared(false)
    const current = draftRef.current
    if (!current) return
    const next: Draft = {
      ...current,
      [key]: value,
      ...(key === 'clearAccessToken' && value === true ? { accessToken: '' } : {}),
    }
    draftRef.current = next
    setDraft(next)
    const isDirty = savedRef.current ? isConnectionDraftDirty(next, savedRef.current) : true
    dirtyRef.current = isDirty
    setDirty(isDirty)
    setFieldErrors(prev => ({ ...prev, [key]: undefined }))
  }
  function discardConnectionDraft() {
    if (!savedRef.current) return
    const fresh = makeDraft(savedRef.current)
    draftRef.current = fresh
    dirtyRef.current = false
    setDraft(fresh)
    setDirty(false)
    setFieldErrors({})
    setConfigurationFailure(null)
    setConfigurationResult(null)
    setTokenHiddenCleared(false)
  }
  function validateDraft(value: Draft): FieldErrors {
    const errors: FieldErrors = {}
    if (!value.displayName.trim() || value.displayName.trim().length > 40) errors.displayName = { key: 'validation.displayName' }
    try {
      const endpoint = new URL(value.endpoint.trim())
      if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) errors.endpoint = { key: 'validation.endpointFormat' }
      else if (/\/(?:api|event)\/?$/.test(endpoint.pathname)) errors.endpoint = { key: 'validation.endpointUnified' }
    } catch { errors.endpoint = { key: 'validation.endpoint' } }
    const timeout = Number(value.timeoutMs)
    if (!value.timeoutMs.trim() || !Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) errors.timeoutMs = { key: 'validation.timeout', params: { min: 1000, max: 60000 } }
    if (value.accessToken.length > 4096 || /[\r\n]/.test(value.accessToken)) errors.accessToken = { key: 'validation.token', params: { max: 4096 } }
    return errors
  }
  async function mutate(operation: 'save' | 'connect' | 'disconnect') {
    if (!draft || !saved || configurationReadFailure || !plugin || actionLock.current) return
    if (operation === 'save') {
      const errors = validateDraft(draft)
      setFieldErrors(errors)
      if (Object.keys(errors).length) { setConfigurationFailure(localFailure('INVALID_CONFIGURATION', 'error.fixConfiguration')); return }
    }
    if (operation === 'connect' && dirtyRef.current) {
      setConfigurationFailure(localFailure('UNSAVED_CONFIGURATION', 'error.unsavedConfiguration')); return
    }
    actionLock.current = true; setMutation(operation); setConfigurationResult(null)
    ++workspaceGeneration.current; workspaceController.current?.abort()
    const controller = new AbortController()
    mutationController.current = controller
    try {
      if (operation === 'save') {
        const response = await hostRequest<JsonObject>('/plugins/qq/configuration', {
          method: 'POST', signal: controller.signal, body: {
            displayName: draft.displayName.trim(), endpoint: draft.endpoint.trim(),
            ...(draft.accessToken && !draft.clearAccessToken ? { accessToken: draft.accessToken } : {}),
            ...(draft.clearAccessToken ? { clearAccessToken: true } : {}),
            autoConnect: draft.autoConnect, forwardToHarness: draft.forwardToHarness, receiveGroups: draft.receiveGroups, timeoutMs: Number(draft.timeoutMs),
          },
        })
        if (!mounted.current || controller.signal.aborted) return
        const configuration = publicConfiguration(response)
        agentPolicyDraft(response, plugin.agentTypes)
        savedRef.current = configuration
        const fresh = makeDraft(configuration)
        draftRef.current = fresh
        dirtyRef.current = false
        setSaved(configuration); setConfigurationReadFailure(null)
        setDraft(fresh); setDirty(false); setTokenHiddenCleared(false)
        setPlugin(current => current ? { ...current, configuration: response, status: disconnectedStatus() } : current)
        setConfigurationResult({ key: 'config.saved' })
        callbacks.current.onFeedback(t('config.savedFeedback'))
      } else {
        const status = await hostRequest<ConnectionStatus>(`/plugins/qq/${operation}`, { method: 'POST', body: {}, signal: controller.signal })
        if (!mounted.current || controller.signal.aborted) return
        setPlugin(current => current ? { ...current, status } : current)
        const result = operation === 'connect' ? { key: 'config.connectedResult' as const, state: status.state } : { key: 'config.disconnectedResult' as const }
        setConfigurationResult(result); callbacks.current.onFeedback(t(result.key, { state: t(`connection.${status.state}`) }))
      }
      setConfigurationFailure(null)
      try { await callbacks.current.onRefresh?.() }
      catch (error) { if (mounted.current) setConfigurationFailure({ ...failureFrom(error), messageKey: 'error.refreshAfterAction' }) }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setConfigurationFailure(failureFrom(error))
        if (error instanceof HostApiError && ['INVALID_HOST_RESPONSE', 'CONFIGURATION_CORRUPTED'].includes(error.code)) {
          savedRef.current = null
          setSaved(null); setConfigurationReadFailure(failureFrom(error))
        }
      }
    } finally {
      if (mutationController.current === controller) mutationController.current = null
      actionLock.current = false
      if (mounted.current) { setMutation(null); void refreshWorkspace() }
    }
  }

  const busy = mutation !== null || testing || policySaving || mediaSaving || audioSaving || messageSplitSaving
  const id = (name: string) => `${prefix}-${name}`
  const describedBy = (name: string) => `${id(name)}-hint${fieldErrors[name] ? ` ${id(name)}-error` : ''}`
  const connectionTabDirty = dirty || mediaTransportDirty || audioInputDirty || messageSplitDirty

  return <div className="qq-panel">
    <div className="qq-connection-strip"><div><strong>{plugin ? t(`connection.${plugin.status.state}`) : t('connection.loading')}</strong>
      {plugin?.status.accountId && <span>{t('connection.account', { name: plugin.status.accountName || 'QQ', id: plugin.status.accountId })}</span>}
      {plugin?.status.lastEventAt && <span>{t('connection.lastEvent', { time: formatDateTime(plugin.status.lastEventAt) })}</span>}
    </div><ActionButton reasonCode="busy" className="text-button" type="button" disabled={busy} onClick={() => void refreshWorkspace()}><RefreshCw size={14} aria-hidden="true" />{t('action.refresh')}</ActionButton></div>
    {plugin?.status.lastError && <ErrorNotice failure={{ message: plugin.status.lastError, code: 'ONEBOT_CONNECTION_ERROR', outcome: 'failed', messageKey: 'error.connection' }} />}
    <ErrorNotice failure={refreshFailure} />
    {refreshFailure && !plugin && <ActionButton reasonCode="busy" className="button button-secondary" type="button" onClick={() => void refreshWorkspace()}>{t('action.reload')}</ActionButton>}
    <SegmentedTabs
      idPrefix={prefix}
      className="qq-tabs"
      sticky
      ariaLabel={t('tabs.label')}
      activeTab={tab}
      onSelect={setTab}
      tabs={[
        { id: 'configuration', label: t('tabs.configuration'), dirty: connectionTabDirty },
        { id: 'agent-policy', label: t('tabs.agentPolicy'), dirty: policyDirty },
        { id: 'live-logs', label: t('tabs.logs') },
        { id: 'tests', label: t('tabs.tests') },
        { id: 'mcp', label: t('tabs.mcp') },
      ]}
    />
    {loading && <p className="qq-loading" role="status">{t('loading.configuration')}</p>}
    {plugin?.status.state === 'unconfigured' && !configurationReadFailure && <p className="qq-help" role="status">{t('config.prerequisite')}</p>}
    <section hidden={tab !== 'configuration'} role="tabpanel" id={`${prefix}-panel-configuration`} aria-labelledby={`${prefix}-tab-configuration`}>
      <div className="section-heading"><h3>{t('tabs.configuration')}</h3><p>{t('config.description')}</p></div>
      {draft && saved && !configurationReadFailure && <form className="form-fields" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate('save') }}>
        <fieldset className="qq-fieldset" disabled={busy}>
          <FormField id={id('displayName')} label={t('config.displayName.label')} hint={t('config.displayName.help')} error={messageLabel(fieldErrors.displayName)}>
            <input id={id('displayName')} aria-describedby={describedBy('displayName')} aria-invalid={Boolean(fieldErrors.displayName)} value={draft.displayName} maxLength={40} autoComplete="off" onChange={event => updateDraft('displayName', event.target.value)} />
          </FormField>
          <FormField id={id('endpoint')} label={t('config.endpoint.label')} hint={t('config.endpoint.help')} error={messageLabel(fieldErrors.endpoint)}>
            <input id={id('endpoint')} type="url" aria-describedby={describedBy('endpoint')} aria-invalid={Boolean(fieldErrors.endpoint)} value={draft.endpoint} placeholder={t('config.endpoint.placeholder')} autoComplete="off" spellCheck={false} onChange={event => updateDraft('endpoint', event.target.value)} />
          </FormField>
          <FormField id={id('accessToken')} label={t('config.token.label')} hint={t(saved.tokenConfigured ? 'config.token.configuredHelp' : 'config.token.emptyHelp')} error={messageLabel(fieldErrors.accessToken)}>
            <PasswordInput
              id={id('accessToken')}
              value={draft.accessToken}
              saved={saved.tokenConfigured}
              clear={draft.clearAccessToken}
              hiddenClearedNotice={tokenHiddenCleared}
              maxLength={4096}
              clearLabel={t('config.token.clear')}
              aria-describedby={describedBy('accessToken')}
              aria-invalid={Boolean(fieldErrors.accessToken)}
              onChange={next => updateDraft('accessToken', next)}
              onClearChange={nextClear => updateDraft('clearAccessToken', nextClear)}
            />
          </FormField>
          <FormField id={id('timeoutMs')} label={t('config.timeout.label')} hint={t('config.timeout.help', { min: formatNumber(1000), max: formatNumber(60000) })} error={messageLabel(fieldErrors.timeoutMs)}>
            <DurationInput
              id={id('timeoutMs')}
              valueMs={draft.timeoutMs}
              presetsSeconds={[3, 10, 30, 60]}
              aria-describedby={describedBy('timeoutMs')}
              aria-invalid={Boolean(fieldErrors.timeoutMs)}
              onChangeMs={next => updateDraft('timeoutMs', next)}
            />
          </FormField>
          <div className="qq-switch-row">
            <Switch
              id={id('autoConnect')}
              checked={draft.autoConnect}
              label={t('config.autoConnect.label')}
              description={t('config.autoConnect.help')}
              onChange={next => updateDraft('autoConnect', next)}
            />
          </div>
          <div className="qq-switch-row">
            <Switch
              id={id('forwardToHarness')}
              checked={draft.forwardToHarness}
              label={t('config.forward.label')}
              description={t('config.forward.help')}
              onChange={next => updateDraft('forwardToHarness', next)}
            />
          </div>
          <div className="qq-switch-row">
            <Switch
              id={id('receiveGroups')}
              checked={draft.receiveGroups}
              label={t('config.groups.label')}
              description={t('config.groups.help')}
              onChange={next => updateDraft('receiveGroups', next)}
            />
          </div>
        </fieldset>
        <FormSaveBar
          alwaysVisible
          dirty={dirty}
          saving={mutation === 'save'}
          disabled={busy}
          disabledReason={commonT('actionReason.busy')}
          saveLabel={t('action.save')}
          savingLabel={t('action.saving')}
          discardLabel={commonT('saveBar.discard')}
          notice={t(dirty ? 'config.dirty' : saved.endpoint ? 'config.savedDraft' : 'config.needsEndpoint')}
          onSave={() => void mutate('save')}
          onDiscard={discardConnectionDraft}
          extraActions={<>
            <ActionButton reasonCode={busy ? 'busy' : dirty ? 'draft' : plugin?.enabled !== true ? 'enable' : !saved.endpoint ? 'configure' : 'running'} type="button" className="button button-secondary" disabled={busy || dirty || !saved.endpoint || plugin?.enabled !== true || ['connected', 'connecting', 'reconnecting'].includes(plugin.status.state)} onClick={() => void mutate('connect')}>{t(mutation === 'connect' ? 'action.connecting' : 'action.connect')}</ActionButton>
            <ActionButton reasonCode={busy ? 'busy' : 'stopped'} type="button" className="button button-secondary" disabled={busy || !plugin || !['connected', 'connecting', 'reconnecting', 'error'].includes(plugin.status.state)} onClick={() => void mutate('disconnect')}>{t(mutation === 'disconnect' ? 'action.disconnecting' : 'action.disconnect')}</ActionButton>
          </>}
        />
      </form>}
      {configurationResult && <p className="qq-operation-result" role="status"><Check size={15} aria-hidden="true" />{t(configurationResult.key, { state: configurationResult.state ? t(`connection.${configurationResult.state}`) : undefined })}</p>}
      <ErrorNotice failure={configurationReadFailure} />
      <ErrorNotice failure={configurationFailure} />
      {plugin && <MessageSplitFields active={tab === 'configuration'} enabled={plugin.enabled} busy={mutation !== null || testing || policySaving || mediaSaving || audioSaving} actionLock={actionLock} onBusy={setMessageSplitSaving} onDirtyChange={setMessageSplitDirty} onFeedback={onFeedback} />}
      {plugin && <MediaTransportFields active={tab === 'configuration'} enabled={plugin.enabled} busy={mutation !== null || testing || policySaving || audioSaving || messageSplitSaving} connectionKey={`${saved?.endpoint ?? ''}:${plugin.status.accountId ?? ''}`} actionLock={actionLock} onBusy={setMediaSaving} onDirtyChange={setMediaTransportDirty} onFeedback={onFeedback} />}
      {plugin && <AudioInputFields active={tab === 'configuration'} enabled={plugin.enabled} busy={mutation !== null || testing || policySaving || mediaSaving || messageSplitSaving} connectionKey={`${saved?.endpoint ?? ''}:${plugin.status.accountId ?? ''}`} actionLock={actionLock} onBusy={setAudioSaving} onDirtyChange={setAudioInputDirty} onFeedback={onFeedback} />}
      {saved && (saved.instanceId || saved.configurationPath || saved.dataDirectory) && <details className="qq-location-details"><summary>{t('config.locations')}</summary><dl className="qq-paths">{saved.instanceId && <div><dt>{t('config.instance')}</dt><dd>{saved.instanceId}</dd></div>}{saved.configurationPath && <div><dt>{t('config.configurationPath')}</dt><dd>{saved.configurationPath}</dd></div>}{saved.dataDirectory && <div><dt>{t('config.dataDirectory')}</dt><dd>{saved.dataDirectory}</dd></div>}</dl></details>}
    </section>
    <section hidden={tab !== 'agent-policy'} role="tabpanel" id={`${prefix}-panel-agent-policy`} aria-labelledby={`${prefix}-tab-agent-policy`}>
      {plugin && <AgentPolicyFields configuration={plugin.configuration} agentTypes={plugin.agentTypes} tools={plugin.tools} enabled={plugin.enabled} configurationFailure={configurationReadFailure} busy={busy} actionLock={actionLock} onDirtyChange={setPolicyDirty} onBusy={value => { if (!mounted.current) return; setPolicySaving(value); if (value) { ++workspaceGeneration.current; workspaceController.current?.abort() } else { void refreshWorkspace(); void callbacks.current.onRefresh?.().catch(error => setRefreshFailure(failureFrom(error, 'error.refreshAfterAction'))) } }} onSaved={configuration => { try { const current = publicConfiguration(configuration); savedRef.current = current; setSaved(current); setConfigurationReadFailure(null); setPlugin(previous => previous ? { ...previous, configuration } : previous) } catch (error) { savedRef.current = null; setSaved(null); setConfigurationReadFailure(failureFrom(error)) } }} onFeedback={onFeedback} />}
    </section>
    <section hidden={tab !== 'live-logs'} role="tabpanel" id={`${prefix}-panel-live-logs`} aria-labelledby={`${prefix}-tab-live-logs`}>
      <LiveLogs
        active={tab === 'live-logs'}
        enabled={plugin?.enabled === true}
        available={plugin?.logsSupported === true}
        tools={plugin?.tools ?? []}
        actionLock={actionLock}
        onFeedback={onFeedback}
        onOpenFullTests={prefill => {
          setToolPrefill(current => ({ serial: (current?.serial ?? 0) + 1, toolName: prefill.toolName, values: prefill.values }))
          setTab('tests')
        }}
      />
    </section>
    <section hidden={tab !== 'tests'} role="tabpanel" id={`${prefix}-panel-tests`} aria-labelledby={`${prefix}-tab-tests`}>
      <ToolTester active={tab === 'tests'} tools={plugin?.tools ?? []} enabled={plugin?.enabled === true} mutationBusy={mutation !== null || policySaving || mediaSaving || audioSaving || messageSplitSaving} actionLock={actionLock} prefill={toolPrefill} onBusy={setTesting} onFeedback={onFeedback} />
    </section>
    <section hidden={tab !== 'mcp'} role="tabpanel" id={`${prefix}-panel-mcp`} aria-labelledby={`${prefix}-tab-mcp`}>
      <McpCapabilities active={tab === 'mcp'} enabled={plugin?.enabled === true} capabilities={plugin?.capabilities ?? []} harness={workspace?.harness} onFeedback={onFeedback} />
    </section>
  </div>
}

const historyLimit = 10

function VisualSegmentEditor({
  rawValue,
  disabled,
  onChangeRaw,
  onSwitchToRaw,
}: {
  rawValue: string
  disabled: boolean
  onChangeRaw: (nextRaw: string) => void
  onSwitchToRaw: () => void
}) {
  const { t } = useI18n('qq')
  const segments = parseVisualSegments(rawValue)
  if (!segments) {
    return (
      <div className="qq-segment-unsupported" role="note">
        <p>{t('tests.segmentBuilder.unsupportedJson')}</p>
        <button type="button" className="button button-secondary" disabled={disabled} onClick={onSwitchToRaw}>
          {t('tests.segmentBuilder.switchToRaw')}
        </button>
      </div>
    )
  }

  function updateSegments(next: VisualSegment[]) {
    onChangeRaw(JSON.stringify(next, null, 2))
  }
  function moveSegment(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= segments!.length) return
    const next = [...segments!]
    const [removed] = next.splice(index, 1)
    if (removed) next.splice(target, 0, removed)
    updateSegments(next)
  }

  return (
    <div className="qq-segment-builder">
      <div className="qq-segment-toolbar">
        <button type="button" className="button button-secondary" disabled={disabled} onClick={() => updateSegments([...segments, { type: 'text', data: { text: '' } }])}>
          {t('tests.segmentBuilder.addText')}
        </button>
        <button type="button" className="button button-secondary" disabled={disabled} onClick={() => updateSegments([...segments, { type: 'image', data: { file: '' } }])}>
          {t('tests.segmentBuilder.addImage')}
        </button>
        <button type="button" className="button button-secondary" disabled={disabled} onClick={() => updateSegments([...segments, { type: 'at', data: { qq: '' } }])}>
          {t('tests.segmentBuilder.addAt')}
        </button>
      </div>
      {segments.length === 0 ? (
        <p className="qq-help">{t('tests.segmentBuilder.empty')}</p>
      ) : (
        <ol className="qq-segment-list">
          {segments.map((segment, index) => (
            <li key={index} className="qq-segment-row">
              <div className="qq-segment-row-head">
                <span className="qq-segment-badge">#{index + 1} · {segment.type}</span>
                <div className="qq-segment-row-controls">
                  <button type="button" className="icon-button" disabled={disabled || index === 0} aria-label={t('tests.segmentBuilder.moveUp')} title={t('tests.segmentBuilder.moveUp')} onClick={() => moveSegment(index, -1)}>
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button" disabled={disabled || index === segments.length - 1} aria-label={t('tests.segmentBuilder.moveDown')} title={t('tests.segmentBuilder.moveDown')} onClick={() => moveSegment(index, 1)}>
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button" disabled={disabled} aria-label={t('tests.segmentBuilder.remove')} title={t('tests.segmentBuilder.remove')} onClick={() => updateSegments(segments.filter((_, i) => i !== index))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {segment.type === 'text' && (
                <textarea
                  rows={2}
                  aria-label={t('tests.segmentBuilder.textLabel')}
                  placeholder={t('tests.segmentBuilder.textPlaceholder')}
                  value={segment.data.text}
                  disabled={disabled}
                  onChange={e => updateSegments(segments.map((s, i) => i === index ? { type: 'text', data: { text: e.target.value } } : s))}
                />
              )}
              {segment.type === 'image' && (
                <input
                  type="text"
                  aria-label={t('tests.segmentBuilder.imageLabel')}
                  placeholder={t('tests.segmentBuilder.imagePlaceholder')}
                  value={segment.data.file}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={e => updateSegments(segments.map((s, i) => i === index ? { type: 'image', data: { file: e.target.value } } : s))}
                />
              )}
              {segment.type === 'at' && (
                <input
                  type="text"
                  aria-label={t('tests.segmentBuilder.atLabel')}
                  placeholder={t('tests.segmentBuilder.atPlaceholder')}
                  value={segment.data.qq}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={e => updateSegments(segments.map((s, i) => i === index ? { type: 'at', data: { qq: e.target.value } } : s))}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ToolTester({ active, tools, enabled, mutationBusy, actionLock, prefill, onBusy, onFeedback }: {
  active: boolean
  tools: PluginToolDefinition[]
  enabled: boolean
  mutationBusy: boolean
  actionLock: MutableRefObject<boolean>
  prefill: ToolPrefill | null
  onBusy: (value: boolean) => void
  onFeedback: (message: string) => void
}) {
  const { t, formatNumber } = useI18n('qq')
  const prefix = useId()
  const [toolName, setToolName] = useState('qq_get_login_info')
  const tool = tools.find(item => item.name === toolName) ?? tools.find(item => item.readOnly) ?? tools[0]
  const fields = useMemo(() => schemaFields(tool), [tool])
  const [values, setValues] = useState<Record<string, string>>({})
  const [formats, setFormats] = useState<Record<string, FieldFormat>>({})
  const [inputModes, setInputModes] = useState<Record<string, MessageInputMode>>({})
  const [requestId, setRequestId] = useState(() => createRequestId())
  const [confirmed, setConfirmed] = useState(false)
  const [unknownReviewed, setUnknownReviewed] = useState(false)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [schemaError, setSchemaError] = useState<QQMessage | undefined>()
  const [validationFailure, setValidationFailure] = useState<Failure | null>(null)
  const [execution, setExecution] = useState<Execution | null>(null)
  const [imagePreview, setImagePreview] = useState<ImagePreviewResult | null>(null)
  const availability = useRef(active && enabled)
  availability.current = active && enabled
  const [history, setHistory] = useState<Execution[]>([])
  const alive = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const pendingSensitive = useRef(false)
  const generation = useRef(0)
  const appliedPrefillSerial = useRef(0)
  const onBusyRef = useRef(onBusy)
  const onFeedbackRef = useRef(onFeedback)
  onBusyRef.current = onBusy
  onFeedbackRef.current = onFeedback

  const unknown = execution?.failure?.outcome === 'unknown'
  const blocked = pending || mutationBusy || Boolean(unknown)

  const clearSensitive = useCallback(() => {
    if (pendingSensitive.current) {
      ++generation.current
      controllerRef.current?.abort(); controllerRef.current = null
      pendingSensitive.current = false; actionLock.current = false
      setPending(false); onBusyRef.current(false)
    }
    setImagePreview(null)
    setExecution(current => current?.tool.sensitiveResult || current?.tool.resultFormat === 'content' ? null : current)
    setHistory(current => current.some(item => item.tool.sensitiveResult || item.tool.resultFormat === 'content') ? current.filter(item => !item.tool.sensitiveResult && item.tool.resultFormat === 'json') : current)
  }, [actionLock])
  useEffect(() => {
    alive.current = true
    function onHidden() { if (document.hidden) clearSensitive() }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', clearSensitive)
    return () => {
      alive.current = false; ++generation.current
      controllerRef.current?.abort(); controllerRef.current = null
      pendingSensitive.current = false
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', clearSensitive)
    }
  }, [clearSensitive])
  useEffect(() => { if (!active || !enabled) clearSensitive() }, [active, enabled, clearSensitive])

  useEffect(() => {
    if (!prefill || prefill.serial <= appliedPrefillSerial.current) return
    appliedPrefillSerial.current = prefill.serial
    if (unknown || pending) {
      onFeedbackRef.current(translate('qq', 'tests.segmentBuilder.prefillBlockedUnknown'))
      return
    }
    clearSensitive()
    setToolName(prefill.toolName)
    setValues(prefill.values)
    setFormats(prefill.formats ?? {})
    setInputModes({})
    setRequestId(createRequestId())
    setConfirmed(false)
    setSchemaError(undefined)
    setValidationFailure(null)
    setErrors({})
  }, [prefill, unknown, pending, clearSensitive])

  const parsed = parseToolArguments(tool, fields, values, formats, requestId, false)
  const hasSideEffect = tool ? !tool.readOnly || tool.destructive : false
  function defaultValueLabel(key: string, schema: JsonObject): string {
    const value = schema.default
    return typeof value === 'boolean' ? t(value ? 'tests.option.true' : 'tests.option.false')
      : typeof value === 'number' ? formatNumber(value)
      : typeof value === 'string' ? value ? parameterOptionLabel(tool, key, value) : t('tests.emptyString') : pretty(value)
  }
  const previewInput = unknown && execution ? execution.arguments : parsed.arguments
  const previewArguments = { ...Object.fromEntries(fields.filter(field => field.schema.default !== undefined).map(field => [field.key, field.schema.default!])), ...previewInput }
  const confirmationKind = tool?.name === 'qq_delete_message' ? 'confirmDelete'
    : tool?.name === 'qq_send_private_message' || tool?.name === 'qq_send_group_message' ? 'confirmSend' : 'confirmAction'

  function invalidateConfirmation() {
    setRequestId(createRequestId()); setConfirmed(false); setSchemaError(undefined); setValidationFailure(null)
  }
  function updateField(key: string, value: string) {
    if (blocked) return
    setValues(current => ({ ...current, [key]: value })); invalidateConfirmation()
    setErrors(current => ({ ...current, [key]: undefined }))
  }
  function updateMessageMode(key: string, mode: MessageInputMode) {
    if (blocked) return
    setInputModes(current => ({ ...current, [key]: mode }))
    if (mode === 'text') {
      setFormats(current => ({ ...current, [key]: 'text' }))
    } else if (mode === 'json') {
      setFormats(current => ({ ...current, [key]: 'json' }))
    } else {
      // Visual segments mode stores JSON array while keeping existing text wrapped cleanly if coming from plain text
      setFormats(current => ({ ...current, [key]: 'json' }))
      const currentRaw = values[key] ?? ''
      const currentFormat = formats[key] ?? 'text'
      if (currentFormat === 'text') {
        const seeded: VisualSegment[] = currentRaw.trim() ? [{ type: 'text', data: { text: currentRaw } }] : []
        setValues(current => ({ ...current, [key]: JSON.stringify(seeded, null, 2) }))
      } else if (!currentRaw.trim()) {
        setValues(current => ({ ...current, [key]: '[]' }))
      }
    }
    invalidateConfirmation()
    setErrors(current => ({ ...current, [key]: undefined }))
  }
  function remember(run: Execution) {
    if (!run.tool.sensitiveResult && run.tool.resultFormat === 'json') setHistory(current => [...current, run].slice(-historyLimit))
  }
  function loadHistoryEntry(entry: Execution) {
    if (blocked || entry.tool.sensitiveResult || entry.tool.resultFormat !== 'json') return
    clearSensitive()
    const targetTool = tools.find(item => item.name === entry.tool.name) ?? entry.tool
    const targetFields: SchemaField[] = schemaFields(targetTool)
    const nextValues: Record<string, string> = {}
    const nextFormats: Record<string, FieldFormat> = {}
    const nextModes: Record<string, MessageInputMode> = {}
    for (const [k, val] of Object.entries(entry.arguments)) {
      if (k === 'request_id' || val === undefined) continue
      const fieldMeta = targetFields.find(item => item.key === k)
      if (typeof val === 'string') {
        nextValues[k] = val
        if (fieldMeta?.kind === 'text-or-json') { nextFormats[k] = 'text'; nextModes[k] = 'text' }
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        nextValues[k] = String(val)
      } else {
        const serialized = JSON.stringify(val, null, 2)
        nextValues[k] = serialized
        if (fieldMeta?.kind === 'text-or-json') {
          nextFormats[k] = 'json'
          nextModes[k] = parseVisualSegments(serialized) ? 'visual' : 'json'
        }
      }
    }
    setToolName(targetTool.name)
    setValues(nextValues)
    setFormats(nextFormats)
    setInputModes(nextModes)
    setErrors({})
    invalidateConfirmation()
    onFeedback(t('tests.segmentBuilder.loadedFeedback'))
  }
  async function execute(retry?: Execution) {
    const selected = retry?.tool ?? tool
    if (!selected || actionLock.current || !active || !enabled || document.hidden) return
    if (unknown && !retry) return
    const input = retry ? { arguments: retry.arguments, errors: {}, schemaError: undefined } : parseToolArguments(selected, fields, values, formats, requestId)
    setErrors(input.errors); setSchemaError(input.schemaError)
    if (Object.keys(input.errors).length || input.schemaError) { setValidationFailure(localFailure('INVALID_INPUT', 'error.fixTestInput')); return }
    if ((!selected.readOnly || selected.destructive) && (!confirmed || (retry && !unknownReviewed))) {
      setValidationFailure(localFailure('ACTION_CONFIRMATION_REQUIRED', 'error.confirmAction')); return
    }
    if (retry && !unknownReviewed) return
    const run: Execution = { tool: selected, requestId: retry?.requestId ?? requestId, arguments: input.arguments, startedAt: new Date().toISOString(), pending: true }
    const currentGeneration = ++generation.current
    const controller = new AbortController()
    controllerRef.current = controller; pendingSensitive.current = selected.sensitiveResult === true || selected.resultFormat === 'content'
    setImagePreview(null)
    actionLock.current = true; setPending(true); onBusy(true); setValidationFailure(null)
    if (execution && !retry) remember(execution)
    setExecution(run)
    try {
      const response = await hostRequest<InvokeResult>('/plugins/qq/invoke', {
        method: 'POST', signal: controller.signal, body: {
          name: selected.name, arguments: run.arguments, requestId: run.requestId,
          ...(!selected.readOnly || selected.destructive ? { confirmed: true } : {}),
        },
      })
      if (!alive.current || currentGeneration !== generation.current || controller.signal.aborted || selected.resultFormat === 'content' && (!availability.current || document.hidden)) return
      if (!isJsonObject(response) || response.ok !== true || response.requestId !== run.requestId || !Object.hasOwn(response, 'result')) throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed')
      if (selected.resultFormat === 'content') {
        setImagePreview(readImagePreview(response.result))
        setExecution({ ...run, pending: false, contentResult: true })
      } else setExecution({ ...run, pending: false, result: response.result })
      setRequestId(createRequestId())
      onFeedback(t('tests.completeFeedback'))
    } catch (error) {
      if (!alive.current || currentGeneration !== generation.current || controller.signal.aborted || selected.resultFormat === 'content' && (!availability.current || document.hidden)) return
      const failure = selected.resultFormat === 'content' && error instanceof HostApiError && error.code === 'INVALID_HOST_RESPONSE'
        ? localFailure('INVALID_HOST_RESPONSE', 'image.invalid') : failureFrom(error)
      setExecution({ ...run, pending: false, failure })
      if (failure.outcome !== 'unknown') setRequestId(createRequestId())
    } finally {
      if (currentGeneration === generation.current && controllerRef.current === controller) {
        controllerRef.current = null; pendingSensitive.current = false; actionLock.current = false
        if (alive.current) { setPending(false); setConfirmed(false); setUnknownReviewed(false); onBusy(false) }
      }
    }
  }
  function allowNewRequest() {
    if (!execution || !unknownReviewed || pending) return
    remember(execution); setExecution(null)
    invalidateConfirmation(); setUnknownReviewed(false)
  }

  return <>
    <div className="section-heading"><h3>{t('tabs.tests')}</h3><p>{t('tests.description')}</p></div>
    {!tools.length ? <p className="qq-empty">{t('tests.empty')}</p> : <form noValidate onSubmit={event => { event.preventDefault(); void execute() }}>
      <fieldset className="qq-fieldset" disabled={blocked || !enabled}>
        <FormField id={`${prefix}-tool`} label={t('tests.tool.label')} hint={t('tests.tool.help')}>
          <select id={`${prefix}-tool`} aria-describedby={`${prefix}-tool-hint`} value={tool?.name ?? ''} onChange={event => {
            clearSensitive(); setToolName(event.target.value); setValues({}); setFormats({}); setInputModes({}); invalidateConfirmation(); setErrors({})
          }}>{tools.map(item => <option key={item.name} value={item.name} title={item.protocolAction}>{t(!item.readOnly || item.destructive ? 'tests.tool.action' : 'tests.tool.readOnly', { title: toolTitle(item) })}</option>)}</select>
        </FormField>
        {tool && <><p className="qq-tool-description">{toolDescription(tool)}</p><details className="qq-tool-help"><summary>{t('tests.parameterHelp')}</summary><p>{toolSchemaHelp(tool)}</p>{tool.protocolAction && <p>{t('tests.protocolAction', { action: tool.protocolAction })}</p>}</details></>}
        {tool?.resultFormat === 'content' && <p className="qq-sensitive" role="note">{t('image.extension')} {t('image.previewHelp')}</p>}
        {tool?.sensitiveResult && <p className="qq-sensitive" role="note">{t('tests.sensitiveHelp')}</p>}
        {fields.map(({ key, schema, required, kind, options }) => {
          const fieldId = `${prefix}-arg-${key}`
          const fieldLabel = parameterLabel(tool, key, schema)
          const label = t(required ? 'tests.field.required' : 'tests.field.optional', { label: fieldLabel })
          const mode: MessageInputMode = kind === 'text-or-json' ? (inputModes[key] ?? (formats[key] === 'json' ? 'json' : 'text')) : 'text'
          const json = kind === 'json' || kind === 'text-or-json' && formats[key] === 'json'
          const defaultLabel = schema.default === undefined ? undefined : defaultValueLabel(key, schema)
          const hint = [parameterDescription(tool, key, schema), json ? t('tests.json.help') : '', defaultLabel === undefined ? '' : t('tests.defaultHelp', { value: defaultLabel })].filter(Boolean).join(' ')
          const attributes = { id: fieldId, 'aria-describedby': `${fieldId}-hint${errors[key] ? ` ${fieldId}-error` : ''}`, 'aria-invalid': Boolean(errors[key]) }
          return <Fragment key={key}>
            {kind === 'text-or-json' && <FormField id={`${fieldId}-format`} label={t('tests.format.label', { label: fieldLabel })} hint={t('tests.format.help')}>
              <select
                id={`${fieldId}-format`}
                value={mode}
                aria-describedby={`${fieldId}-format-hint`}
                onChange={event => updateMessageMode(key, event.target.value as MessageInputMode)}>
                <option value="text">{t('tests.segmentBuilder.modeText')}</option>
                <option value="visual">{t('tests.segmentBuilder.modeVisual')}</option>
                <option value="json">{t('tests.segmentBuilder.modeJson')}</option>
              </select>
            </FormField>}
            <FormField id={fieldId} label={label} hint={hint} error={messageLabel(errors[key], fieldLabel)}>
              {key === 'request_id' ? <input {...attributes} value={requestId} readOnly className="input-readonly" />
                : kind === 'boolean' ? <select {...attributes} value={values[key] ?? ''} onChange={event => updateField(key, event.target.value)}><option value="">{t(required ? 'tests.option.choose' : defaultLabel === undefined ? 'tests.option.unspecified' : 'tests.option.default', { value: defaultLabel })}</option><option value="true">{t('tests.option.true')}</option><option value="false">{t('tests.option.false')}</option></select>
                : kind === 'enum' ? <select {...attributes} value={values[key] ?? ''} onChange={event => updateField(key, event.target.value)}><option value="">{t(required ? 'tests.option.choose' : defaultLabel === undefined ? 'tests.option.unspecified' : 'tests.option.default', { value: defaultLabel })}</option>{options.map(option => <option key={enumValue(option)} value={enumValue(option)}>{parameterOptionLabel(tool, key, enumValue(option))}</option>)}</select>
                : kind === 'text-or-json' && mode === 'visual' ? (
                  <VisualSegmentEditor
                    rawValue={values[key] ?? ''}
                    disabled={blocked || !enabled}
                    onChangeRaw={nextRaw => updateField(key, nextRaw)}
                    onSwitchToRaw={() => updateMessageMode(key, 'json')}
                  />
                )
                : json || kind === 'text-or-json' ? <textarea {...attributes} className={json ? 'qq-json-input' : undefined} value={values[key] ?? ''} rows={5} maxLength={!json && typeof schema.maxLength === 'number' ? schema.maxLength : undefined} spellCheck={false} onChange={event => updateField(key, event.target.value)} />
                : <input {...attributes} type={kind === 'integer' || kind === 'number' ? 'number' : 'text'} inputMode={kind === 'integer' ? 'numeric' : kind === 'number' ? 'decimal' : undefined} min={typeof schema.minimum === 'number' ? schema.minimum : undefined} max={typeof schema.maximum === 'number' ? schema.maximum : undefined} step={kind === 'integer' ? 1 : kind === 'number' ? 'any' : undefined} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined} value={values[key] ?? ''} autoComplete="off" spellCheck={false} onChange={event => updateField(key, event.target.value)} />}
            </FormField>
          </Fragment>
        })}
        {!fields.length && <p className="qq-no-arguments">{t('tests.noArguments')}</p>}
      </fieldset>
      {values.onebot_call_mode && values.onebot_call_mode !== 'sync' && <p className="qq-call-mode" role="note">{t('tests.callModeHelp')}</p>}
      {hasSideEffect && <div className="qq-confirmation"><strong>{t(`tests.${confirmationKind}.title`, { title: tool ? toolTitle(tool) : '' })}</strong><p>{t('tests.confirm.help')}</p>
        <dl className="qq-target-preview">{Object.entries(previewArguments).filter(([key]) => key !== 'request_id').map(([key, value]) => <div key={key}><dt>{parameterLabel(tool, key, fields.find(field => field.key === key)?.schema)}</dt><dd>{typeof value === 'string' ? value || t('tests.emptyString') : <pre>{pretty(value)}</pre>}{!Object.hasOwn(previewInput, key) && <small className="qq-preview-default">{t('tests.previewDefault')}</small>}</dd></div>)}</dl>
        <label className="qq-check"><input type="checkbox" disabled={pending || mutationBusy || !enabled} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{t(`tests.${confirmationKind}.label`)}</span></label>
      </div>}
      {schemaError && <p className="qq-schema-error" role="alert">{t('tests.schemaError', { message: messageLabel(schemaError) })}</p>}
      <ErrorNotice failure={validationFailure} />
      <div className="qq-actions"><ActionButton reasonCode={pending || mutationBusy ? 'busy' : unknown ? 'unknown' : !enabled ? 'connect' : 'confirm'} className="button button-primary" type="submit" disabled={blocked || !enabled || (hasSideEffect && !confirmed)}>{t(pending ? 'action.running' : 'action.runTest')}</ActionButton><span className="qq-request-id">{t('tests.requestId', { id: requestId })}</span></div>
    </form>}
    {unknown && execution && <div className="qq-unknown" role="alert"><h4>{t('tests.unknown.title')}</h4><p>{t('tests.unknown.help')}</p>
      <label className="qq-check"><input type="checkbox" checked={unknownReviewed} disabled={pending} onChange={event => setUnknownReviewed(event.target.checked)} /><span>{t('tests.unknown.reviewed')}</span></label>
      <div className="qq-actions"><ActionButton reasonCode={pending || mutationBusy ? 'busy' : !unknownReviewed ? 'unknown' : !enabled ? 'connect' : 'confirm'} type="button" className="button button-secondary" disabled={!unknownReviewed || pending || mutationBusy || !enabled || ((!execution.tool.readOnly || execution.tool.destructive) && !confirmed)} onClick={() => void execute(execution)}>{t('action.retryRequest')}</ActionButton>
        <ActionButton reasonCode={pending || mutationBusy ? 'busy' : 'unknown'} type="button" className="button button-secondary" disabled={!unknownReviewed || pending || mutationBusy} onClick={allowNewRequest}>{t('action.newRequest')}</ActionButton></div><p className="qq-help">{t('tests.unknown.newRequestHelp')}</p>
    </div>}
    {pending && execution?.tool.resultFormat === 'content' && <ActionButton reasonCode="busy" type="button" className="button button-secondary qq-image-cancel" onClick={clearSensitive}>{t('image.cancel')}</ActionButton>}
    {execution && <ExecutionResult execution={execution} onFeedback={onFeedback} />}
    {imagePreview && active && enabled && !document.hidden && <ImageResult result={imagePreview} onClear={clearSensitive} />}
    <p className="qq-help">{t('tests.historyHelp', { limit: formatNumber(historyLimit) })}</p>
    {history.length > 0 && <details className="qq-history"><summary>{t('tests.history', { count: history.length, value: formatNumber(history.length) })}</summary>{[...history].reverse().map((item, index) => <ExecutionResult key={`${item.requestId}-${item.startedAt}-${index}`} execution={item} onFeedback={onFeedback} onLoadHistory={loadHistoryEntry} loadDisabled={blocked || !enabled} />)}</details>}
  </>
}
function ExecutionResult({ execution, onFeedback, onLoadHistory, loadDisabled = false }: {
  execution: Execution
  onFeedback: (message: string) => void
  onLoadHistory?: (entry: Execution) => void
  loadDisabled?: boolean
}) {
  const { t, formatDateTime } = useI18n('qq')
  return <div className="qq-execution"><div className="qq-execution-heading"><strong>{toolTitle(execution.tool)}</strong>
    <div className="qq-execution-meta">
      <span>{t(execution.pending ? 'execution.pending' : execution.failure ? execution.failure.outcome === 'unknown' ? 'execution.unknown' : 'execution.failed' : 'execution.complete')}</span>
      {onLoadHistory && !execution.tool.sensitiveResult && execution.tool.resultFormat === 'json' && (
        <ActionButton reasonCode="unknown" type="button" className="text-button" disabled={loadDisabled} onClick={() => onLoadHistory(execution)}>
          {t('tests.segmentBuilder.loadHistory')}
        </ActionButton>
      )}
    </div>
  </div>
    {execution.tool.sensitiveResult && <p className="qq-sensitive" role="note">{t('tests.sensitiveResult')}</p>}
    <p className="qq-help">{t('execution.started', { time: formatDateTime(execution.startedAt), id: execution.requestId })}</p><ErrorNotice failure={execution.failure ?? null} />
    {execution.tool.resultFormat === 'content' ? <p className="qq-help">{t('image.safeResult')}</p> : <JsonPreview label={t('execution.json')} value={{ name: execution.tool.name, requestId: execution.requestId, arguments: execution.arguments, startedAt: execution.startedAt,
      ...(execution.pending ? { state: 'pending' } : execution.failure ? { error: { message: execution.failure.message, code: execution.failure.code, outcome: execution.failure.outcome } } : { result: execution.result }) }} onFeedback={onFeedback} />}
  </div>
}

function McpCapabilities({ active, enabled, capabilities, harness, onFeedback }: { active: boolean; enabled: boolean; capabilities: PluginCapability[]; harness?: Workspace['harness']; onFeedback: (message: string) => void }) {
  const { t, formatNumber } = useI18n('qq')
  const modalTitleId = useId()
  const [registration, setRegistration] = useState<McpRegistration | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [copyFailure, setCopyFailure] = useState<Failure | null>(null)
  const alive = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  const hideRegistration = useCallback((restoreFocus = false) => {
    ++generation.current
    controllerRef.current?.abort(); controllerRef.current = null
    setRegistration(null); setPending(false); setCopyFailure(null)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    alive.current = true
    function onVisibility() { if (document.hidden) hideRegistration(false) }
    function onPageHide() { hideRegistration(false) }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      alive.current = false
      ++generation.current
      controllerRef.current?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [hideRegistration])
  useEffect(() => {
    if (!active || !enabled) hideRegistration(false)
  }, [active, enabled, hideRegistration])
  useEffect(() => {
    if (!registration) return
    closeRef.current?.focus()
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        hideRegistration(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [registration, hideRegistration])

  async function revealRegistration() {
    if (controllerRef.current || !enabled || document.hidden) return
    const controller = new AbortController(); controllerRef.current = controller
    const currentGeneration = ++generation.current
    setPending(true)
    try {
      const response = await hostRequest<McpRegistration>('/plugins/qq/mcp-registration', { method: 'POST', body: {}, signal: controller.signal })
      if (alive.current && !controller.signal.aborted && generation.current === currentGeneration && !document.hidden) { setRegistration(response); setFailure(null); setCopyFailure(null) }
    } catch (error) {
      if (alive.current && !controller.signal.aborted && generation.current === currentGeneration) setFailure(failureFrom(error))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (alive.current && generation.current === currentGeneration) setPending(false)
    }
  }
  async function copyValue(label: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopyFailure(null); onFeedback(t('copy.done', { label })) }
    catch { setCopyFailure(localFailure('CLIPBOARD_UNAVAILABLE', 'error.copy')) }
  }

  return <>
    <div className="section-heading"><h3>{t('tabs.mcp')}</h3><p>{t('mcp.description')}</p></div>
    <div className="qq-harness-status"><strong>{t(harness?.state === 'attached' ? 'mcp.harnessAttached' : 'mcp.harnessDetached')}</strong><p>{harness ? t('mcp.delivery', { pending: formatNumber(harness.pending), accepted: formatNumber(harness.accepted), uncertain: formatNumber(harness.uncertain) }) : t('mcp.deliveryLoading')}</p></div>
    <div className="qq-mcp-access"><p>{t('mcp.credentialsHelp')}</p><div className="qq-actions"><ActionButton ref={triggerRef} reasonCode={pending ? 'busy' : 'enable'} className="button button-secondary" type="button" disabled={pending || !enabled} onClick={() => void revealRegistration()}>{t(pending ? 'action.revealingMcp' : 'action.revealMcp')}</ActionButton>{registration && <ActionButton reasonCode="busy" type="button" className="text-button" onClick={() => hideRegistration(false)}>{t('action.hideMcp')}</ActionButton>}</div><ErrorNotice failure={failure} /></div>
    {registration && active && enabled && (
      <div className="qq-mcp-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) hideRegistration(true) }}>
        <div className="qq-mcp-modal" role="dialog" aria-modal="true" aria-labelledby={modalTitleId}>
          <div className="qq-mcp-modal-header">
            <div>
              <h4 id={modalTitleId}>{t('mcp.modalTitle')}</h4>
              <p>{t('mcp.hideHelp')}</p>
            </div>
            <button ref={closeRef} type="button" className="icon-button" aria-label={t('mcp.modalClose')} onClick={() => hideRegistration(true)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <dl className="qq-mcp-modal-details">
            <div>
              <dt>{t('mcp.transportLabel')}</dt>
              <dd><code>{registration.transport}</code></dd>
            </div>
            <div>
              <dt>{t('mcp.urlLabel')}</dt>
              <dd>
                <code>{registration.url}</code>
                <button type="button" className="button button-secondary" onClick={() => void copyValue(t('mcp.urlLabel'), registration.url)}>
                  <Copy size={13} aria-hidden="true" />{t('mcp.copyUrl')}
                </button>
              </dd>
            </div>
            <div>
              <dt>{t('mcp.authLabel')}</dt>
              <dd>
                <code>{registration.headers.Authorization}</code>
                <button type="button" className="button button-secondary" onClick={() => void copyValue(t('mcp.authLabel'), registration.headers.Authorization)}>
                  <Copy size={13} aria-hidden="true" />{t('mcp.copyAuth')}
                </button>
              </dd>
            </div>
            {registration.note && (
              <div>
                <dt>{t('mcp.noteLabel')}</dt>
                <dd><span>{registration.note}</span></dd>
              </div>
            )}
          </dl>
          <pre tabIndex={0} aria-label={t('mcp.configuration')}>{pretty(registration)}</pre>
          <ErrorNotice failure={copyFailure} />
          <div className="qq-mcp-modal-footer">
            <button type="button" className="button button-secondary" onClick={() => hideRegistration(true)}>{t('mcp.modalClose')}</button>
            <button type="button" className="button button-primary" onClick={() => void copyValue(t('mcp.configuration'), pretty(registration))}>
              <Copy size={14} aria-hidden="true" />{t('mcp.copyJson')}
            </button>
          </div>
        </div>
      </div>
    )}
    <div className="qq-capability-heading"><h3>{t('capabilities.title')}</h3><p>{t('capabilities.help')}</p></div>
    {!capabilities.length ? <p className="qq-empty">{t('capabilities.empty')}</p> : <ul className="qq-capability-list">{capabilities.map(capability => <li key={capability.id}><div><strong>{capabilityTitle(capability)}</strong><span className="status-badge">{t(`capabilities.${capability.support}`)}</span></div><p>{capabilityDescription(capability)}</p>{capability.toolName && <code>{capability.toolName}</code>}</li>)}</ul>}
  </>
}
