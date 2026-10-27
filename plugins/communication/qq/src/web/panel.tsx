import type { OneBotConfig } from '../config'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, MutableRefObject, ReactNode } from 'react'
import { AlertCircle, Check, Copy, RefreshCw } from 'lucide-react'
import { formatNumber, getErrorMessage, HostApiError, hostRequest, translate, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import type { ConnectionStatus, JsonObject, JsonValue, PluginCapability, PluginToolDefinition } from '@eating/plugin-sdk'
import './panel.css'
import { capabilityDescription, capabilityTitle, parameterDescription, parameterLabel, toolDescription, toolTitle } from './i18n'
import type { QQMessage, QQTranslationKey } from './i18n'
import { LiveLogs } from './live-logs'

type Tab = 'configuration' | 'tests' | 'mcp' | 'live-logs'
type PublicConfiguration = Omit<OneBotConfig, 'accessToken'> & { tokenConfigured: boolean; instanceId?: string; configurationPath?: string; dataDirectory?: string }
type Draft = Omit<OneBotConfig, 'timeoutMs'> & { timeoutMs: string; clearAccessToken: boolean }
type FieldErrors = Record<string, QQMessage | undefined>
interface QQWorkspacePlugin {
  id: string
  enabled: boolean
  logsSupported?: boolean
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
  failure?: Failure
  pending: boolean
}
interface McpRegistration { transport: 'streamable-http'; url: string; headers: { Authorization: string }; note: string }
type QQPanelProps = PluginPanelProps & { onRefresh?: () => Promise<void> }

const tabs: { id: Tab; title: QQTranslationKey }[] = [
  { id: 'configuration', title: 'tabs.configuration' }, { id: 'live-logs', title: 'tabs.logs' }, { id: 'tests', title: 'tabs.tests' },
  { id: 'mcp', title: 'tabs.mcp' },
]

function failureFrom(error: unknown, fallbackKey: QQTranslationKey = 'error.operationFailed'): Failure {
  if (error instanceof HostApiError) return { message: error.message, code: error.code, outcome: error.outcome, fallbackKey }
  return { message: error instanceof Error ? error.message : '', code: 'UNEXPECTED_ERROR', outcome: 'unknown', fallbackKey }
}
function localFailure(code: string, messageKey: QQTranslationKey): Failure {
  return { message: '', code, outcome: 'not-sent', messageKey }
}
function pretty(value: unknown): string { return JSON.stringify(value, null, 2) ?? 'null' }
function messageLabel(message: QQMessage | undefined, field?: string): string | undefined {
  if (!message) return undefined
  const params = Object.fromEntries(Object.entries(message.params ?? {}).map(([key, value]) => [key, typeof value === 'number' ? formatNumber(value) : value]))
  return translate('qq', message.key, { ...params, field })
}
function publicConfiguration(value: JsonObject): PublicConfiguration {
  return {
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : '',
    autoConnect: value.autoConnect === true, forwardToHarness: value.forwardToHarness === true,
    receiveGroups: value.receiveGroups === true, timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : 10000,
    tokenConfigured: value.tokenConfigured === true,
    ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
    ...(typeof value.configurationPath === 'string' ? { configurationPath: value.configurationPath } : {}),
    ...(typeof value.dataDirectory === 'string' ? { dataDirectory: value.dataDirectory } : {}),
  }
}
function makeDraft(value: PublicConfiguration): Draft {
  return { displayName: value.displayName, endpoint: value.endpoint, accessToken: '', clearAccessToken: false,
    autoConnect: value.autoConnect, forwardToHarness: value.forwardToHarness, receiveGroups: value.receiveGroups, timeoutMs: String(value.timeoutMs) }
}
function disconnectedStatus(): ConnectionStatus {
  return { state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
}

function ErrorNotice({ failure }: { failure: Failure | null }) {
  const { t } = useI18n('qq')
  if (!failure) return null
  const message = failure.messageKey ? t(failure.messageKey) : getErrorMessage(failure, t(failure.fallbackKey ?? 'error.operationFailed'))
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
  return <div className="qq-json"><div className="qq-json-heading"><strong>{label}</strong><button type="button" className="text-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{t('action.copy')}</button></div><pre tabIndex={0} aria-label={label}>{text}</pre><ErrorNotice failure={copyFailure} /></div>
}
function FormField({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}</label>{children}
    {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}{error && <p className="field-error" id={`${id}-error`}>{error}</p>}
  </div>
}

export function QQPanel({ onFeedback, onRefresh }: QQPanelProps) {
  const { t, formatNumber, formatDateTime } = useI18n('qq')
  const prefix = useId()
  const [tab, setTab] = useState<Tab>('configuration')
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [plugin, setPlugin] = useState<QQWorkspacePlugin | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [refreshFailure, setRefreshFailure] = useState<Failure | null>(null)
  const [configurationFailure, setConfigurationFailure] = useState<Failure | null>(null)
  const [configurationResult, setConfigurationResult] = useState<{ key: QQTranslationKey; state?: ConnectionStatus['state'] } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [mutation, setMutation] = useState<'save' | 'connect' | 'disconnect' | null>(null)
  const [testing, setTesting] = useState(false)
  const actionLock = useRef(false)
  const mounted = useRef(false)
  const workspaceGeneration = useRef(0)
  const workspaceController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const feedbackRef = useRef(onFeedback)
  const refreshRef = useRef(onRefresh)
  feedbackRef.current = onFeedback
  refreshRef.current = onRefresh

  const refreshWorkspace = useCallback(async () => {
    if (actionLock.current) return
    const generation = ++workspaceGeneration.current
    workspaceController.current?.abort()
    const controller = new AbortController()
    workspaceController.current = controller
    try {
      const response = await hostRequest<Workspace>('/workspace', { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted || generation !== workspaceGeneration.current) return
      if (response.protocolVersion !== 1 || !Array.isArray(response.plugins)) { setRefreshFailure(localFailure('INVALID_HOST_RESPONSE', 'error.workspaceIncompatible')); return }
      const qq = response.plugins.find(entry => entry.id === 'qq')
      if (!qq) { setRefreshFailure(localFailure('PLUGIN_NOT_FOUND', 'error.pluginNotLoaded')); return }
      setWorkspace(response); setPlugin(qq); setRefreshFailure(null)
      if (!dirtyRef.current) setDraft(makeDraft(publicConfiguration(qq.configuration)))
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && generation === workspaceGeneration.current) setRefreshFailure(failureFrom(error, 'error.refreshFailed'))
    } finally {
      if (mounted.current && generation === workspaceGeneration.current) setLoading(false)
      if (workspaceController.current === controller) workspaceController.current = null
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refreshWorkspace()
    const interval = window.setInterval(() => { if (!document.hidden && !workspaceController.current) void refreshWorkspace() }, 2000)
    return () => {
      mounted.current = false
      ++workspaceGeneration.current
      window.clearInterval(interval)
      workspaceController.current?.abort()
      mutationController.current?.abort()
    }
  }, [refreshWorkspace])

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => current ? { ...current, [key]: value } : current)
    dirtyRef.current = true; setDirty(true)
    setFieldErrors(current => ({ ...current, [key]: undefined }))
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
    if (!draft || !plugin || actionLock.current) return
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
        const response = await hostRequest<JsonObject>('/plugins/qq/configuration', { method: 'POST', signal: controller.signal, body: {
          displayName: draft.displayName.trim(), endpoint: draft.endpoint.trim(),
          ...(draft.accessToken && !draft.clearAccessToken ? { accessToken: draft.accessToken } : {}),
          ...(draft.clearAccessToken ? { clearAccessToken: true } : {}),
          autoConnect: draft.autoConnect, forwardToHarness: draft.forwardToHarness, receiveGroups: draft.receiveGroups, timeoutMs: Number(draft.timeoutMs),
        } })
        if (!mounted.current || controller.signal.aborted) return
        setDraft(makeDraft(publicConfiguration(response))); dirtyRef.current = false; setDirty(false)
        setPlugin(current => current ? { ...current, configuration: response, status: disconnectedStatus() } : current)
        setConfigurationResult({ key: 'config.saved' })
        feedbackRef.current(t('config.savedFeedback'))
      } else {
        const status = await hostRequest<ConnectionStatus>(`/plugins/qq/${operation}`, { method: 'POST', body: {}, signal: controller.signal })
        if (!mounted.current || controller.signal.aborted) return
        setPlugin(current => current ? { ...current, status } : current)
        const result = operation === 'connect' ? { key: 'config.connectedResult' as const, state: status.state } : { key: 'config.disconnectedResult' as const }
        setConfigurationResult(result); feedbackRef.current(t(result.key, { state: t(`connection.${status.state}`) }))
      }
      setConfigurationFailure(null)
      try { await refreshRef.current?.() }
      catch (error) { if (mounted.current) setConfigurationFailure({ ...failureFrom(error), messageKey: 'error.refreshAfterAction' }) }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setConfigurationFailure(failureFrom(error))
    } finally {
      if (mutationController.current === controller) mutationController.current = null
      actionLock.current = false
      if (mounted.current) { setMutation(null); void refreshWorkspace() }
    }
  }
  function switchTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = tabs.length - 1
    const selected = next === undefined ? undefined : tabs[next]
    if (!selected) return
    event.preventDefault(); setTab(selected.id)
    document.getElementById(`${prefix}-tab-${selected.id}`)?.focus()
  }
  const saved = plugin ? publicConfiguration(plugin.configuration) : null
  const busy = mutation !== null || testing
  const id = (name: string) => `${prefix}-${name}`
  const describedBy = (name: string) => `${id(name)}-hint${fieldErrors[name] ? ` ${id(name)}-error` : ''}`

  return <div className="qq-panel">
    <div className="qq-connection-strip"><div><strong>{plugin ? t(`connection.${plugin.status.state}`) : t('connection.loading')}</strong>
      {plugin?.status.accountId && <span>{t('connection.account', { name: plugin.status.accountName || 'QQ', id: plugin.status.accountId })}</span>}
      {plugin?.status.lastEventAt && <span>{t('connection.lastEvent', { time: formatDateTime(plugin.status.lastEventAt) })}</span>}
    </div><button className="text-button" type="button" disabled={busy} onClick={() => void refreshWorkspace()}><RefreshCw size={14} aria-hidden="true" />{t('action.refresh')}</button></div>
    {plugin?.status.lastError && <ErrorNotice failure={{ message: plugin.status.lastError, code: 'ONEBOT_CONNECTION_ERROR', outcome: 'failed', messageKey: 'error.connection' }} />}
    <ErrorNotice failure={refreshFailure} />
    {refreshFailure && !plugin && <button className="button button-secondary" type="button" onClick={() => void refreshWorkspace()}>{t('action.reload')}</button>}
    <div className="qq-tabs" role="tablist" aria-label={t('tabs.label')}>{tabs.map((item, index) => <button key={item.id} type="button" role="tab" id={`${prefix}-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`${prefix}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => switchTab(event, index)}>{t(item.title)}</button>)}</div>
    {loading && <p className="qq-loading" role="status">{t('loading.configuration')}</p>}
    <section hidden={tab !== 'configuration'} role="tabpanel" id={`${prefix}-panel-configuration`} aria-labelledby={`${prefix}-tab-configuration`}>
      <div className="section-heading"><h3>{t('tabs.configuration')}</h3><p>{t('config.description')}</p></div>
      {draft && <form className="form-fields" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate('save') }}>
        <fieldset className="qq-fieldset" disabled={busy}>
          <FormField id={id('displayName')} label={t('config.displayName.label')} hint={t('config.displayName.help')} error={messageLabel(fieldErrors.displayName)}>
            <input id={id('displayName')} aria-describedby={describedBy('displayName')} aria-invalid={Boolean(fieldErrors.displayName)} value={draft.displayName} maxLength={40} autoComplete="off" onChange={event => updateDraft('displayName', event.target.value)} />
          </FormField>
          <FormField id={id('endpoint')} label={t('config.endpoint.label')} hint={t('config.endpoint.help')} error={messageLabel(fieldErrors.endpoint)}>
            <input id={id('endpoint')} type="url" aria-describedby={describedBy('endpoint')} aria-invalid={Boolean(fieldErrors.endpoint)} value={draft.endpoint} placeholder={t('config.endpoint.placeholder')} autoComplete="off" spellCheck={false} onChange={event => updateDraft('endpoint', event.target.value)} />
          </FormField>
          <FormField id={id('accessToken')} label={t('config.token.label')} hint={t(saved?.tokenConfigured ? 'config.token.configuredHelp' : 'config.token.emptyHelp')} error={messageLabel(fieldErrors.accessToken)}>
            <input id={id('accessToken')} type="password" aria-describedby={describedBy('accessToken')} aria-invalid={Boolean(fieldErrors.accessToken)} value={draft.accessToken} disabled={draft.clearAccessToken} maxLength={4096} autoComplete="new-password" spellCheck={false} onChange={event => updateDraft('accessToken', event.target.value)} />
          </FormField>
          <label className="check-field qq-compact-check"><input type="checkbox" checked={draft.clearAccessToken} onChange={event => updateDraft('clearAccessToken', event.target.checked)} /><span><strong>{t('config.token.clear')}</strong><small>{t('config.token.clearHelp')}</small></span></label>
          <FormField id={id('timeoutMs')} label={t('config.timeout.label')} hint={t('config.timeout.help', { min: formatNumber(1000), max: formatNumber(60000) })} error={messageLabel(fieldErrors.timeoutMs)}>
            <input id={id('timeoutMs')} type="number" min={1000} max={60000} step={1} inputMode="numeric" aria-describedby={describedBy('timeoutMs')} aria-invalid={Boolean(fieldErrors.timeoutMs)} value={draft.timeoutMs} onChange={event => updateDraft('timeoutMs', event.target.value)} />
          </FormField>
          <label className="check-field"><input type="checkbox" checked={draft.autoConnect} onChange={event => updateDraft('autoConnect', event.target.checked)} /><span><strong>{t('config.autoConnect.label')}</strong><small>{t('config.autoConnect.help')}</small></span></label>
          <label className="check-field"><input type="checkbox" checked={draft.forwardToHarness} onChange={event => updateDraft('forwardToHarness', event.target.checked)} /><span><strong>{t('config.forward.label')}</strong><small>{t('config.forward.help')}</small></span></label>
          <label className="check-field"><input type="checkbox" checked={draft.receiveGroups} onChange={event => updateDraft('receiveGroups', event.target.checked)} /><span><strong>{t('config.groups.label')}</strong><small>{t('config.groups.help')}</small></span></label>
        </fieldset>
        <div className="form-actions"><button type="submit" className="button button-primary" disabled={busy}>{t(mutation === 'save' ? 'action.saving' : 'action.save')}</button>
          <button type="button" className="button button-secondary" disabled={busy || dirty || !saved?.endpoint || plugin?.enabled !== true || ['connected', 'connecting', 'reconnecting'].includes(plugin.status.state)} onClick={() => void mutate('connect')}>{t(mutation === 'connect' ? 'action.connecting' : 'action.connect')}</button>
          <button type="button" className="button button-secondary" disabled={busy || !plugin || !['connected', 'connecting', 'reconnecting', 'error'].includes(plugin.status.state)} onClick={() => void mutate('disconnect')}>{t(mutation === 'disconnect' ? 'action.disconnecting' : 'action.disconnect')}</button>
          <span className="save-indicator">{t(dirty ? 'config.dirty' : saved?.endpoint ? 'config.savedDraft' : 'config.needsEndpoint')}</span>
        </div>
      </form>}
      {configurationResult && <p className="qq-operation-result" role="status"><Check size={15} aria-hidden="true" />{t(configurationResult.key, { state: configurationResult.state ? t(`connection.${configurationResult.state}`) : undefined })}</p>}
      <ErrorNotice failure={configurationFailure} />
      {saved && (saved.instanceId || saved.configurationPath || saved.dataDirectory) && <details className="qq-location-details"><summary>{t('config.locations')}</summary><dl className="qq-paths">{saved.instanceId && <div><dt>{t('config.instance')}</dt><dd>{saved.instanceId}</dd></div>}{saved.configurationPath && <div><dt>{t('config.configurationPath')}</dt><dd>{saved.configurationPath}</dd></div>}{saved.dataDirectory && <div><dt>{t('config.dataDirectory')}</dt><dd>{saved.dataDirectory}</dd></div>}</dl></details>}
    </section>
    <section hidden={tab !== 'live-logs'} role="tabpanel" id={`${prefix}-panel-live-logs`} aria-labelledby={`${prefix}-tab-live-logs`}>
      <LiveLogs active={tab === 'live-logs'} enabled={plugin?.enabled === true} available={plugin?.logsSupported === true} />
    </section>
    <section hidden={tab !== 'tests'} role="tabpanel" id={`${prefix}-panel-tests`} aria-labelledby={`${prefix}-tab-tests`}>
      <ToolTester tools={plugin?.tools ?? []} enabled={plugin?.enabled === true} mutationBusy={mutation !== null} actionLock={actionLock} onBusy={setTesting} onFeedback={onFeedback} />
    </section>
    <section hidden={tab !== 'mcp'} role="tabpanel" id={`${prefix}-panel-mcp`} aria-labelledby={`${prefix}-tab-mcp`}>
      <McpCapabilities active={tab === 'mcp'} enabled={plugin?.enabled === true} capabilities={plugin?.capabilities ?? []} harness={workspace?.harness} onFeedback={onFeedback} />
    </section>
  </div>
}

interface SchemaField { key: string; schema: JsonObject; required: boolean }
function schemaFields(tool: PluginToolDefinition | undefined): SchemaField[] {
  if (!tool || !isJsonObject(tool.inputSchema.properties)) return []
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
  return Object.entries(tool.inputSchema.properties).filter((entry): entry is [string, JsonObject] => isJsonObject(entry[1]))
    .map(([key, schema]) => ({ key, schema, required: required.includes(key) }))
}
function parseArguments(fields: SchemaField[], values: Record<string, string>, requestId: string): { arguments: JsonObject; errors: FieldErrors } {
  const args: JsonObject = {}
  const errors: FieldErrors = {}
  for (const { key, schema, required } of fields) {
    if (key === 'request_id') { args[key] = requestId; continue }
    const value = values[key] ?? ''
    if (!value && !required) continue
    if (!value && required) { errors[key] = { key: 'validation.required' }; continue }
    if (schema.type === 'integer') {
      const number = Number(value)
      if (!value.trim() || !Number.isSafeInteger(number) || (typeof schema.minimum === 'number' && number < schema.minimum) || (typeof schema.maximum === 'number' && number > schema.maximum)) {
        errors[key] = typeof schema.minimum === 'number' && typeof schema.maximum === 'number' ? { key: 'validation.integerRange', params: { min: schema.minimum, max: schema.maximum } }
          : typeof schema.minimum === 'number' ? { key: 'validation.integerMin', params: { min: schema.minimum } }
          : typeof schema.maximum === 'number' ? { key: 'validation.integerMax', params: { max: schema.maximum } } : { key: 'validation.integer' }
      } else args[key] = number
    } else if (schema.type === 'string') {
      if ((typeof schema.minLength === 'number' && value.length < schema.minLength) || (typeof schema.maxLength === 'number' && value.length > schema.maxLength)) {
        errors[key] = typeof schema.minLength === 'number' && typeof schema.maxLength === 'number' ? { key: 'validation.lengthRange', params: { min: schema.minLength, max: schema.maxLength } }
          : typeof schema.minLength === 'number' ? { key: 'validation.lengthMin', params: { min: schema.minLength } }
          : { key: 'validation.lengthMax', params: { max: typeof schema.maxLength === 'number' ? schema.maxLength : 0 } }
      } else if (typeof schema.pattern === 'string') {
        try { if (!new RegExp(schema.pattern).test(value)) errors[key] = { key: 'validation.pattern' } }
        catch { errors[key] = { key: 'validation.ruleInvalid' } }
      }
      args[key] = value
    } else errors[key] = { key: 'validation.typeUnavailable' }
  }
  return { arguments: args, errors }
}

function ToolTester({ tools, enabled, mutationBusy, actionLock, onBusy, onFeedback }: {
  tools: PluginToolDefinition[]; enabled: boolean; mutationBusy: boolean; actionLock: MutableRefObject<boolean>; onBusy: (value: boolean) => void; onFeedback: (message: string) => void
}) {
  const { t, formatNumber } = useI18n('qq')
  const prefix = useId()
  const [toolName, setToolName] = useState('qq_get_login_info')
  const tool = tools.find(item => item.name === toolName) ?? tools.find(item => item.readOnly) ?? tools[0]
  const fields = schemaFields(tool)
  const [values, setValues] = useState<Record<string, string>>({})
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [confirmed, setConfirmed] = useState(false)
  const [unknownReviewed, setUnknownReviewed] = useState(false)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [validationFailure, setValidationFailure] = useState<Failure | null>(null)
  const [execution, setExecution] = useState<Execution | null>(null)
  const [history, setHistory] = useState<Execution[]>([])
  const alive = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const generation = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current; controllerRef.current?.abort() } }, [])
  const unknown = execution?.failure?.outcome === 'unknown'
  const blocked = pending || mutationBusy || Boolean(unknown)
  const parsed = parseArguments(fields, values, requestId)
  const hasSideEffect = tool ? !tool.readOnly || tool.destructive : false

  function updateField(key: string, value: string) {
    setValues(current => ({ ...current, [key]: value })); setRequestId(crypto.randomUUID()); setConfirmed(false)
    setErrors(current => ({ ...current, [key]: undefined }))
  }
  async function execute(retry?: Execution) {
    const selected = retry?.tool ?? tool
    if (!selected || actionLock.current) return
    if (unknown && !retry) return
    const input = retry ? { arguments: retry.arguments, errors: {} } : parseArguments(fields, values, requestId)
    setErrors(input.errors)
    if (Object.keys(input.errors).length) { setValidationFailure(localFailure('INVALID_INPUT', 'error.fixTestInput')); return }
    if ((!selected.readOnly || selected.destructive) && (!confirmed || (retry && !unknownReviewed))) {
      setValidationFailure(localFailure('ACTION_CONFIRMATION_REQUIRED', 'error.confirmAction')); return
    }
    if (retry && !unknownReviewed) return
    const run: Execution = { tool: selected, requestId: retry?.requestId ?? requestId, arguments: input.arguments, startedAt: new Date().toISOString(), pending: true }
    const currentGeneration = ++generation.current
    const controller = new AbortController()
    controllerRef.current = controller
    actionLock.current = true; setPending(true); onBusy(true); setValidationFailure(null)
    if (execution) setHistory(current => [...current, execution])
    setExecution(run)
    try {
      const response = await hostRequest<InvokeResult>('/plugins/qq/invoke', { method: 'POST', signal: controller.signal, body: {
        name: selected.name, arguments: run.arguments, requestId: run.requestId,
        ...(!selected.readOnly || selected.destructive ? { confirmed: true } : {}),
      } })
      if (!alive.current || currentGeneration !== generation.current || controller.signal.aborted) return
      setExecution({ ...run, pending: false, result: response.result }); setRequestId(crypto.randomUUID())
      onFeedback(t('tests.completeFeedback'))
    } catch (error) {
      if (!alive.current || currentGeneration !== generation.current || controller.signal.aborted) return
      const failure = failureFrom(error)
      setExecution({ ...run, pending: false, failure })
      if (failure.outcome !== 'unknown') setRequestId(crypto.randomUUID())
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      actionLock.current = false
      if (alive.current) { setPending(false); setConfirmed(false); setUnknownReviewed(false); onBusy(false) }
    }
  }
  function allowNewRequest() {
    if (!execution || !unknownReviewed || pending) return
    setHistory(current => [...current, execution]); setExecution(null)
    setRequestId(crypto.randomUUID()); setConfirmed(false); setUnknownReviewed(false); setValidationFailure(null)
  }

  return <>
    <div className="section-heading"><h3>{t('tabs.tests')}</h3><p>{t('tests.description')}</p></div>
    {!tools.length ? <p className="qq-empty">{t('tests.empty')}</p> : <form noValidate onSubmit={event => { event.preventDefault(); void execute() }}>
      <fieldset className="qq-fieldset" disabled={blocked || !enabled}>
        <FormField id={`${prefix}-tool`} label={t('tests.tool.label')} hint={t('tests.tool.help')}>
          <select id={`${prefix}-tool`} aria-describedby={`${prefix}-tool-hint`} value={tool?.name ?? ''} onChange={event => {
            setToolName(event.target.value); setValues({}); setRequestId(crypto.randomUUID()); setConfirmed(false); setErrors({}); setValidationFailure(null)
          }}>{tools.map(item => <option key={item.name} value={item.name}>{t(!item.readOnly || item.destructive ? 'tests.tool.action' : 'tests.tool.readOnly', { title: toolTitle(item) })}</option>)}</select>
        </FormField>
        {tool && <p className="qq-tool-description">{toolDescription(tool)}</p>}
        {fields.map(({ key, schema, required }) => {
          const fieldId = `${prefix}-arg-${key}`
          const fieldLabel = parameterLabel(tool, key, schema)
          const label = t(required ? 'tests.field.required' : 'tests.field.optional', { label: fieldLabel })
          const hint = parameterDescription(tool, key, schema, { max: typeof schema.maxLength === 'number' ? formatNumber(schema.maxLength) : undefined })
          const attributes = { id: fieldId, 'aria-describedby': `${fieldId}-hint${errors[key] ? ` ${fieldId}-error` : ''}`, 'aria-invalid': Boolean(errors[key]) }
          return <FormField key={key} id={fieldId} label={label} hint={hint} error={messageLabel(errors[key], fieldLabel)}>
            {key === 'request_id' ? <input {...attributes} value={requestId} readOnly className="input-readonly" /> : key === 'message' ?
              <textarea {...attributes} value={values[key] ?? ''} rows={5} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined} onChange={event => updateField(key, event.target.value)} /> :
              <input {...attributes} type={schema.type === 'integer' ? 'number' : 'text'} inputMode={schema.type === 'integer' ? 'numeric' : undefined} min={typeof schema.minimum === 'number' ? schema.minimum : undefined} max={typeof schema.maximum === 'number' ? schema.maximum : undefined} step={schema.type === 'integer' ? 1 : undefined} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined} value={values[key] ?? ''} autoComplete="off" spellCheck={false} onChange={event => updateField(key, event.target.value)} />}
          </FormField>
        })}
        {!fields.length && <p className="qq-no-arguments">{t('tests.noArguments')}</p>}
      </fieldset>
      {hasSideEffect && <div className="qq-confirmation"><strong>{t(tool?.destructive ? 'tests.confirmDelete.title' : 'tests.confirmSend.title')}</strong><p>{t('tests.confirm.help')}</p>
        <dl className="qq-target-preview">{Object.entries(unknown && execution ? execution.arguments : parsed.arguments).filter(([key]) => key !== 'request_id').map(([key, value]) => <div key={key}><dt>{parameterLabel(tool, key, fields.find(field => field.key === key)?.schema)}</dt><dd>{typeof value === 'string' ? value : pretty(value)}</dd></div>)}</dl>
        <label className="qq-check"><input type="checkbox" disabled={pending || mutationBusy || !enabled} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{t(tool?.destructive ? 'tests.confirmDelete.label' : 'tests.confirmSend.label')}</span></label>
      </div>}
      <ErrorNotice failure={validationFailure} />
      <div className="qq-actions"><button className="button button-primary" type="submit" disabled={blocked || !enabled || (hasSideEffect && !confirmed)}>{t(pending ? 'action.running' : 'action.runTest')}</button><span className="qq-request-id">{t('tests.requestId', { id: requestId })}</span></div>
    </form>}
    {unknown && execution && <div className="qq-unknown" role="alert"><h4>{t('tests.unknown.title')}</h4><p>{t('tests.unknown.help')}</p>
      <label className="qq-check"><input type="checkbox" checked={unknownReviewed} disabled={pending} onChange={event => setUnknownReviewed(event.target.checked)} /><span>{t('tests.unknown.reviewed')}</span></label>
      <div className="qq-actions"><button type="button" className="button button-secondary" disabled={!unknownReviewed || pending || mutationBusy || !enabled || ((!execution.tool.readOnly || execution.tool.destructive) && !confirmed)} onClick={() => void execute(execution)}>{t('action.retryRequest')}</button>
        <button type="button" className="button button-secondary" disabled={!unknownReviewed || pending || mutationBusy} onClick={allowNewRequest}>{t('action.newRequest')}</button></div><p className="qq-help">{t('tests.unknown.newRequestHelp')}</p>
    </div>}
    {execution && <ExecutionResult execution={execution} onFeedback={onFeedback} />}
    {history.length > 0 && <details className="qq-history"><summary>{t('tests.history', { count: history.length, value: formatNumber(history.length) })}</summary>{[...history].reverse().map((item, index) => <ExecutionResult key={`${item.requestId}-${item.startedAt}-${index}`} execution={item} onFeedback={onFeedback} />)}</details>}
  </>
}
function ExecutionResult({ execution, onFeedback }: { execution: Execution; onFeedback: (message: string) => void }) {
  const { t, formatDateTime } = useI18n('qq')
  return <div className="qq-execution"><div className="qq-execution-heading"><strong>{toolTitle(execution.tool)}</strong><span>{t(execution.pending ? 'execution.pending' : execution.failure ? execution.failure.outcome === 'unknown' ? 'execution.unknown' : 'execution.failed' : 'execution.complete')}</span></div>
    <p className="qq-help">{t('execution.started', { time: formatDateTime(execution.startedAt), id: execution.requestId })}</p><ErrorNotice failure={execution.failure ?? null} />
    <JsonPreview label={t('execution.json')} value={{ name: execution.tool.name, requestId: execution.requestId, arguments: execution.arguments, startedAt: execution.startedAt,
      ...(execution.pending ? { state: 'pending' } : execution.failure ? { error: { message: execution.failure.message, code: execution.failure.code, outcome: execution.failure.outcome } } : { result: execution.result }) }} onFeedback={onFeedback} />
  </div>
}

function McpCapabilities({ active, enabled, capabilities, harness, onFeedback }: { active: boolean; enabled: boolean; capabilities: PluginCapability[]; harness?: Workspace['harness']; onFeedback: (message: string) => void }) {
  const { t, formatNumber } = useI18n('qq')
  const [registration, setRegistration] = useState<McpRegistration | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const alive = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const generation = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current; controllerRef.current?.abort() } }, [])
  useEffect(() => {
    if (!active || !enabled) { ++generation.current; controllerRef.current?.abort(); controllerRef.current = null; setRegistration(null); setPending(false) }
  }, [active, enabled])
  async function revealRegistration() {
    if (controllerRef.current || !enabled) return
    const controller = new AbortController(); controllerRef.current = controller
    const currentGeneration = ++generation.current
    setPending(true)
    try {
      const response = await hostRequest<McpRegistration>('/plugins/qq/mcp-registration', { method: 'POST', body: {}, signal: controller.signal })
      if (alive.current && !controller.signal.aborted && generation.current === currentGeneration) { setRegistration(response); setFailure(null) }
    } catch (error) {
      if (alive.current && !controller.signal.aborted && generation.current === currentGeneration) setFailure(failureFrom(error))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (alive.current && generation.current === currentGeneration) setPending(false)
    }
  }
  return <>
    <div className="section-heading"><h3>{t('tabs.mcp')}</h3><p>{t('mcp.description')}</p></div>
    <div className="qq-harness-status"><strong>{t(harness?.state === 'attached' ? 'mcp.harnessAttached' : 'mcp.harnessDetached')}</strong><p>{harness ? t('mcp.delivery', { pending: formatNumber(harness.pending), accepted: formatNumber(harness.accepted), uncertain: formatNumber(harness.uncertain) }) : t('mcp.deliveryLoading')}</p></div>
    <div className="qq-mcp-access"><p>{t('mcp.credentialsHelp')}</p><div className="qq-actions"><button className="button button-secondary" type="button" disabled={pending || !enabled} onClick={() => void revealRegistration()}>{t(pending ? 'action.revealingMcp' : 'action.revealMcp')}</button>{registration && <button type="button" className="text-button" onClick={() => { ++generation.current; controllerRef.current?.abort(); controllerRef.current = null; setRegistration(null); setPending(false) }}>{t('action.hideMcp')}</button>}</div><ErrorNotice failure={failure} />
      {registration && <><p className="qq-help">{t('mcp.hideHelp')}</p><JsonPreview label={t('mcp.configuration')} value={registration} onFeedback={onFeedback} /></>}
    </div>
    <div className="qq-capability-heading"><h3>{t('capabilities.title')}</h3><p>{t('capabilities.help')}</p></div>
    {!capabilities.length ? <p className="qq-empty">{t('capabilities.empty')}</p> : <ul className="qq-capability-list">{capabilities.map(capability => <li key={capability.id}><div><strong>{capabilityTitle(capability)}</strong><span className="status-badge">{t(`capabilities.${capability.support}`)}</span></div><p>{capabilityDescription(capability)}</p>{capability.toolName && <code>{capability.toolName}</code>}</li>)}</ul>}
  </>
}
