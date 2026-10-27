import type { OneBotConfig } from '../config'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, MutableRefObject, ReactNode } from 'react'
import { AlertCircle, Check, Copy, RefreshCw } from 'lucide-react'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import type { ConnectionStatus, JsonObject, JsonValue, PluginCapability, PluginToolDefinition, StoredMessage } from '@eating/plugin-sdk'
import './panel.css'

type Tab = 'configuration' | 'tests' | 'messages' | 'mcp'
type PublicConfiguration = Omit<OneBotConfig, 'accessToken'> & { tokenConfigured: boolean; instanceId?: string; configurationPath?: string; dataDirectory?: string }
type Draft = Omit<OneBotConfig, 'timeoutMs'> & { timeoutMs: string; clearAccessToken: boolean }
interface QQWorkspacePlugin {
  id: string
  enabled: boolean
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
interface Failure { message: string; code: string; outcome: string }
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

const tabs: { id: Tab; title: string }[] = [
  { id: 'configuration', title: '连接配置' }, { id: 'tests', title: '功能测试' },
  { id: 'messages', title: '消息记录' }, { id: 'mcp', title: 'MCP 能力' },
]
const connectionLabels: Record<ConnectionStatus['state'], string> = {
  unconfigured: '尚未配置', disconnected: '已断开', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', error: '连接失败',
}
const harnessLabels: Record<StoredMessage['harnessStatus'], string> = {
  'not-forwarded': '未转交', pending: '等待投递', delivering: '正在投递', accepted: 'Harness 已接收', uncertain: '投递结果未知',
}
const argumentLabels: Record<string, string> = {
  user_id: '收件人 QQ 号', group_id: '目标群号', message: '消息内容', message_id: '消息 ID',
  request_id: '请求 ID', instance_id: '账号实例 ID', conversation_id: '会话 ID', limit: '读取条数', before: '早于消息序号',
}

function failureFrom(error: unknown): Failure {
  if (error instanceof HostApiError) return { message: error.message, code: error.code, outcome: error.outcome }
  return { message: error instanceof Error ? error.message : '操作失败，请检查 Eating Host。', code: 'UNEXPECTED_ERROR', outcome: 'unknown' }
}
function pretty(value: unknown): string { return JSON.stringify(value, null, 2) ?? 'null' }
function dateLabel(value: string | null): string {
  if (!value) return '暂无'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false })
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
  if (!failure) return null
  return <div className="qq-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{failure.message}</p><small>错误代码：{failure.code}{failure.outcome === 'unknown' ? ' · 执行结果未知，请先核查真实状态。' : ''}</small></div></div>
}
function JsonPreview({ label, value, onFeedback }: { label: string; value: unknown; onFeedback: (message: string) => void }) {
  const [copyFailure, setCopyFailure] = useState<Failure | null>(null)
  const text = pretty(value)
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopyFailure(null); onFeedback(`${label}已复制。`) }
    catch { setCopyFailure({ message: '复制失败，可选中下方内容手动复制。', code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-sent' }) }
  }
  return <div className="qq-json"><div className="qq-json-heading"><strong>{label}</strong><button type="button" className="text-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />复制</button></div><pre tabIndex={0} aria-label={label}>{text}</pre><ErrorNotice failure={copyFailure} /></div>
}
function FormField({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}</label>{children}
    {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}{error && <p className="field-error" id={`${id}-error`}>{error}</p>}
  </div>
}

export function QQPanel({ onFeedback, onRefresh }: QQPanelProps) {
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
  const [configurationResult, setConfigurationResult] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
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
      if (response.protocolVersion !== 1 || !Array.isArray(response.plugins)) throw new Error('Host 工作区响应不兼容，请检查前后台版本。')
      const qq = response.plugins.find(entry => entry.id === 'qq')
      if (!qq) throw new Error('Host 未加载 QQ 插件，请检查后台插件注册。')
      setWorkspace(response); setPlugin(qq); setRefreshFailure(null)
      if (!dirtyRef.current) setDraft(makeDraft(publicConfiguration(qq.configuration)))
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && generation === workspaceGeneration.current) setRefreshFailure(failureFrom(error))
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
    setFieldErrors(current => ({ ...current, [key]: '' }))
  }
  function validateDraft(value: Draft): Record<string, string> {
    const errors: Record<string, string> = {}
    if (!value.displayName.trim() || value.displayName.trim().length > 40) errors.displayName = '显示名称需为 1 至 40 个字符。'
    try {
      const endpoint = new URL(value.endpoint.trim())
      if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) errors.endpoint = '请填写 ws:// 或 wss:// 地址，不要包含账号、令牌、查询参数或片段。'
      else if (/\/(?:api|event)\/?$/.test(endpoint.pathname)) errors.endpoint = '请使用同时提供 API 和事件的统一端点，不使用 /api 或 /event。'
    } catch { errors.endpoint = '请填写有效的 OneBot WebSocket 地址。' }
    const timeout = Number(value.timeoutMs)
    if (!value.timeoutMs.trim() || !Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) errors.timeoutMs = '请求超时需为 1000 至 60000 毫秒的整数。'
    if (value.accessToken.length > 4096 || /[\r\n]/.test(value.accessToken)) errors.accessToken = '访问令牌不能包含换行，长度不能超过 4096。'
    return errors
  }
  async function mutate(operation: 'save' | 'connect' | 'disconnect') {
    if (!draft || !plugin || actionLock.current) return
    if (operation === 'save') {
      const errors = validateDraft(draft)
      setFieldErrors(errors)
      if (Object.keys(errors).length) { setConfigurationFailure({ code: 'INVALID_CONFIGURATION', message: '请修正配置字段后再保存。', outcome: 'not-sent' }); return }
    }
    if (operation === 'connect' && dirtyRef.current) {
      setConfigurationFailure({ code: 'UNSAVED_CONFIGURATION', message: '请先保存当前更改，再使用已保存的配置连接。', outcome: 'not-sent' }); return
    }
    actionLock.current = true; setMutation(operation); setConfigurationResult('')
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
        setConfigurationResult('配置已保存到 Eating Host。旧连接已断开，点击“连接 OneBot”核验账号与状态。')
        feedbackRef.current('QQ 配置已保存，尚未重新连接。')
      } else {
        const status = await hostRequest<ConnectionStatus>(`/plugins/qq/${operation}`, { method: 'POST', body: {}, signal: controller.signal })
        if (!mounted.current || controller.signal.aborted) return
        setPlugin(current => current ? { ...current, status } : current)
        const message = operation === 'connect' ? `OneBot 核验结果：${connectionLabels[status.state]}。` : 'QQ 的 OneBot 连接已断开。'
        setConfigurationResult(message); feedbackRef.current(message)
      }
      setConfigurationFailure(null)
      try { await refreshRef.current?.() }
      catch (error) { if (mounted.current) setConfigurationFailure({ ...failureFrom(error), message: '操作已完成，但宿主列表刷新失败。请使用“刷新状态”更新。' }) }
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
    <div className="qq-connection-strip"><div><strong>{plugin ? connectionLabels[plugin.status.state] : '正在读取后台状态'}</strong>
      {plugin?.status.accountId && <span>账号：{plugin.status.accountName || 'QQ'}（{plugin.status.accountId}）</span>}
      {plugin?.status.lastEventAt && <span>最近事件：{dateLabel(plugin.status.lastEventAt)}</span>}
    </div><button className="text-button" type="button" disabled={busy} onClick={() => void refreshWorkspace()}><RefreshCw size={14} aria-hidden="true" />刷新状态</button></div>
    {plugin?.status.lastError && <ErrorNotice failure={{ message: plugin.status.lastError, code: 'ONEBOT_CONNECTION_ERROR', outcome: 'failed' }} />}
    <ErrorNotice failure={refreshFailure} />
    {refreshFailure && !plugin && <button className="button button-secondary" type="button" onClick={() => void refreshWorkspace()}>重新读取后台</button>}
    <div className="qq-tabs" role="tablist" aria-label="QQ 插件功能">{tabs.map((item, index) => <button key={item.id} type="button" role="tab" id={`${prefix}-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`${prefix}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => switchTab(event, index)}>{item.title}</button>)}</div>
    {loading && <p className="qq-loading" role="status">正在读取 Eating Host 中的 QQ 配置与能力…</p>}
    <section hidden={tab !== 'configuration'} role="tabpanel" id={`${prefix}-panel-configuration`} aria-labelledby={`${prefix}-tab-configuration`}>
      <div className="section-heading"><h3>连接配置</h3><p>使用 OneBot v11 正向统一 WebSocket 端点。请先在协议端登录 QQ，Eating 的连接操作不会替你登录账号。</p></div>
      {draft && <form className="form-fields" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate('save') }}>
        <fieldset className="qq-fieldset" disabled={busy}>
          <FormField id={id('displayName')} label="显示名称" hint="用于在 Eating 中识别此 QQ 配置。" error={fieldErrors.displayName}>
            <input id={id('displayName')} aria-describedby={describedBy('displayName')} aria-invalid={Boolean(fieldErrors.displayName)} value={draft.displayName} maxLength={40} autoComplete="off" onChange={event => updateDraft('displayName', event.target.value)} />
          </FormField>
          <FormField id={id('endpoint')} label="OneBot 地址" hint="例如 ws://127.0.0.1:3001。此版本不使用 /api、/event 分离端点或反向 WebSocket。" error={fieldErrors.endpoint}>
            <input id={id('endpoint')} type="url" aria-describedby={describedBy('endpoint')} aria-invalid={Boolean(fieldErrors.endpoint)} value={draft.endpoint} placeholder="ws://127.0.0.1:3001" autoComplete="off" spellCheck={false} onChange={event => updateDraft('endpoint', event.target.value)} />
          </FormField>
          <FormField id={id('accessToken')} label="Bearer 访问令牌" hint={`${saved?.tokenConfigured ? '后台已配置令牌。' : '后台尚未配置令牌。'}只写入，不回显；留空保留原值。`} error={fieldErrors.accessToken}>
            <input id={id('accessToken')} type="password" aria-describedby={describedBy('accessToken')} aria-invalid={Boolean(fieldErrors.accessToken)} value={draft.accessToken} disabled={draft.clearAccessToken} maxLength={4096} autoComplete="new-password" spellCheck={false} onChange={event => updateDraft('accessToken', event.target.value)} />
          </FormField>
          <label className="check-field qq-compact-check"><input type="checkbox" checked={draft.clearAccessToken} onChange={event => updateDraft('clearAccessToken', event.target.checked)} /><span><strong>清除已保存的访问令牌</strong><small>只有勾选此项并保存才会清除。请确认协议端允许无令牌连接。</small></span></label>
          <FormField id={id('timeoutMs')} label="请求超时" hint="单位为毫秒，范围 1000–60000。超时不代表真实动作未发生。" error={fieldErrors.timeoutMs}>
            <input id={id('timeoutMs')} type="number" min={1000} max={60000} step={1} inputMode="numeric" aria-describedby={describedBy('timeoutMs')} aria-invalid={Boolean(fieldErrors.timeoutMs)} value={draft.timeoutMs} onChange={event => updateDraft('timeoutMs', event.target.value)} />
          </FormField>
          <label className="check-field"><input type="checkbox" checked={draft.autoConnect} onChange={event => updateDraft('autoConnect', event.target.checked)} /><span><strong>Host 启动时自动连接</strong><small>保存配置会先断开旧连接；本次保存后仍需手动连接。</small></span></label>
          <label className="check-field"><input type="checkbox" checked={draft.forwardToHarness} onChange={event => updateDraft('forwardToHarness', event.target.checked)} /><span><strong>将接收的消息转交 Harness</strong><small>尚未接入 Harness 时，消息保存在后台等待投递；这不代表 Agent 已读。</small></span></label>
          <label className="check-field"><input type="checkbox" checked={draft.receiveGroups} onChange={event => updateDraft('receiveGroups', event.target.checked)} /><span><strong>群消息转交 Harness</strong><small>仅影响群消息的转交范围；协议端收到的消息仍会保存在本地记录中。</small></span></label>
        </fieldset>
        <div className="form-actions"><button type="submit" className="button button-primary" disabled={busy}>{mutation === 'save' ? '正在保存…' : '保存配置'}</button>
          <button type="button" className="button button-secondary" disabled={busy || dirty || !saved?.endpoint || plugin?.enabled !== true || ['connected', 'connecting', 'reconnecting'].includes(plugin.status.state)} onClick={() => void mutate('connect')}>{mutation === 'connect' ? '正在核验连接…' : '连接 OneBot'}</button>
          <button type="button" className="button button-secondary" disabled={busy || !plugin || !['connected', 'connecting', 'reconnecting', 'error'].includes(plugin.status.state)} onClick={() => void mutate('disconnect')}>{mutation === 'disconnect' ? '正在断开…' : '断开连接'}</button>
          <span className="save-indicator">{dirty ? '有未保存更改，请先保存后连接' : saved?.endpoint ? '使用后台已保存配置' : '请先配置 OneBot 地址'}</span>
        </div>
      </form>}
      {configurationResult && <p className="qq-operation-result" role="status"><Check size={15} aria-hidden="true" />{configurationResult}</p>}
      <ErrorNotice failure={configurationFailure} />
      {saved && (saved.instanceId || saved.configurationPath || saved.dataDirectory) && <dl className="qq-paths">{saved.instanceId && <div><dt>账号实例</dt><dd>{saved.instanceId}（本版仅使用当前默认实例，与实际 QQ 号独立）</dd></div>}{saved.configurationPath && <div><dt>配置文件</dt><dd>{saved.configurationPath}</dd></div>}{saved.dataDirectory && <div><dt>插件数据目录</dt><dd>{saved.dataDirectory}</dd></div>}</dl>}
    </section>
    <section hidden={tab !== 'tests'} role="tabpanel" id={`${prefix}-panel-tests`} aria-labelledby={`${prefix}-tab-tests`}>
      <ToolTester tools={plugin?.tools ?? []} enabled={plugin?.enabled === true} mutationBusy={mutation !== null} actionLock={actionLock} onBusy={setTesting} onFeedback={onFeedback} />
    </section>
    <section hidden={tab !== 'messages'} role="tabpanel" id={`${prefix}-panel-messages`} aria-labelledby={`${prefix}-tab-messages`}>
      <MessageLog active={tab === 'messages'} enabled={plugin?.enabled === true} onFeedback={onFeedback} />
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
function parseArguments(fields: SchemaField[], values: Record<string, string>, requestId: string): { arguments: JsonObject; errors: Record<string, string> } {
  const args: JsonObject = {}
  const errors: Record<string, string> = {}
  for (const { key, schema, required } of fields) {
    if (key === 'request_id') { args[key] = requestId; continue }
    const value = values[key] ?? ''
    const label = typeof schema.title === 'string' ? schema.title : argumentLabels[key] ?? key
    if (!value && !required) continue
    if (!value && required) { errors[key] = `请填写${label}。`; continue }
    if (schema.type === 'integer') {
      const number = Number(value)
      if (!value.trim() || !Number.isSafeInteger(number) || (typeof schema.minimum === 'number' && number < schema.minimum) || (typeof schema.maximum === 'number' && number > schema.maximum)) errors[key] = `请填写范围内的整数${typeof schema.minimum === 'number' ? `，最小 ${schema.minimum}` : ''}${typeof schema.maximum === 'number' ? `，最大 ${schema.maximum}` : ''}。`
      else args[key] = number
    } else if (schema.type === 'string') {
      if ((typeof schema.minLength === 'number' && value.length < schema.minLength) || (typeof schema.maxLength === 'number' && value.length > schema.maxLength)) errors[key] = `${label}长度需在${typeof schema.minLength === 'number' ? schema.minLength : 0}至${typeof schema.maxLength === 'number' ? schema.maxLength : '不限'}个字符之间。`
      else if (typeof schema.pattern === 'string') {
        try { if (!new RegExp(schema.pattern).test(value)) errors[key] = `${label}格式不正确，请根据参数说明填写。` }
        catch { errors[key] = '后台参数规则无效，请检查 QQ 插件版本。' }
      }
      args[key] = value
    } else errors[key] = '此参数类型尚未提供表单，请检查 QQ 插件版本。'
  }
  return { arguments: args, errors }
}

function ToolTester({ tools, enabled, mutationBusy, actionLock, onBusy, onFeedback }: {
  tools: PluginToolDefinition[]; enabled: boolean; mutationBusy: boolean; actionLock: MutableRefObject<boolean>; onBusy: (value: boolean) => void; onFeedback: (message: string) => void
}) {
  const prefix = useId()
  const [toolName, setToolName] = useState('qq_get_login_info')
  const tool = tools.find(item => item.name === toolName) ?? tools.find(item => item.readOnly) ?? tools[0]
  const fields = schemaFields(tool)
  const [values, setValues] = useState<Record<string, string>>({})
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [confirmed, setConfirmed] = useState(false)
  const [unknownReviewed, setUnknownReviewed] = useState(false)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
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
    setErrors(current => ({ ...current, [key]: '' }))
  }
  async function execute(retry?: Execution) {
    const selected = retry?.tool ?? tool
    if (!selected || actionLock.current) return
    if (unknown && !retry) return
    const input = retry ? { arguments: retry.arguments, errors: {} } : parseArguments(fields, values, requestId)
    setErrors(input.errors)
    if (Object.keys(input.errors).length) { setValidationFailure({ code: 'INVALID_INPUT', message: '请修正测试参数后再执行。', outcome: 'not-sent' }); return }
    if ((!selected.readOnly || selected.destructive) && (!confirmed || (retry && !unknownReviewed))) {
      setValidationFailure({ code: 'ACTION_CONFIRMATION_REQUIRED', message: '请核对目标和参数，并勾选真实动作确认。', outcome: 'not-sent' }); return
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
      onFeedback('QQ 功能测试已完成，请查看真实返回结果。')
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
    <div className="section-heading"><h3>功能测试</h3><p>工具与参数来自 QQ 后台能力目录。默认只读查询账号；所有发送与撤回都需要逐次确认。</p></div>
    {!tools.length ? <p className="qq-empty">尚未读取到 QQ 工具，请先确认 Eating Host 正常运行。</p> : <form noValidate onSubmit={event => { event.preventDefault(); void execute() }}>
      <fieldset className="qq-fieldset" disabled={blocked || !enabled}>
        <FormField id={`${prefix}-tool`} label="测试功能" hint="只读功能也可能包含账号、好友或群资料，请仅在可信环境查看。">
          <select id={`${prefix}-tool`} aria-describedby={`${prefix}-tool-hint`} value={tool?.name ?? ''} onChange={event => {
            setToolName(event.target.value); setValues({}); setRequestId(crypto.randomUUID()); setConfirmed(false); setErrors({}); setValidationFailure(null)
          }}>{tools.map(item => <option key={item.name} value={item.name}>{item.title}{!item.readOnly || item.destructive ? ' · 真实动作' : ' · 只读'}</option>)}</select>
        </FormField>
        {tool && <p className="qq-tool-description">{tool.description}</p>}
        {fields.map(({ key, schema, required }) => {
          const fieldId = `${prefix}-arg-${key}`
          const label = `${typeof schema.title === 'string' ? schema.title : argumentLabels[key] ?? key}${required ? '（必填）' : '（选填）'}`
          const hint = key === 'request_id' ? '由 Eating 生成；结果未知时重试复用原值，不能自行改写。' : typeof schema.description === 'string' ? schema.description : key
          const attributes = { id: fieldId, 'aria-describedby': `${fieldId}-hint${errors[key] ? ` ${fieldId}-error` : ''}`, 'aria-invalid': Boolean(errors[key]) }
          return <FormField key={key} id={fieldId} label={label} hint={hint} error={errors[key]}>
            {key === 'request_id' ? <input {...attributes} value={requestId} readOnly className="input-readonly" /> : key === 'message' ?
              <textarea {...attributes} value={values[key] ?? ''} rows={5} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined} onChange={event => updateField(key, event.target.value)} /> :
              <input {...attributes} type={schema.type === 'integer' ? 'number' : 'text'} inputMode={schema.type === 'integer' ? 'numeric' : undefined} min={typeof schema.minimum === 'number' ? schema.minimum : undefined} max={typeof schema.maximum === 'number' ? schema.maximum : undefined} step={schema.type === 'integer' ? 1 : undefined} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined} value={values[key] ?? ''} autoComplete="off" spellCheck={false} onChange={event => updateField(key, event.target.value)} />}
          </FormField>
        })}
        {!fields.length && <p className="qq-no-arguments">此功能无需参数。</p>}
      </fieldset>
      {hasSideEffect && <div className="qq-confirmation"><strong>{tool?.destructive ? '此操作会撤回真实消息' : '此操作会发送真实 QQ 消息'}</strong><p>请核对以下目标和内容。Eating 不会自动重试此动作。</p>
        <dl className="qq-target-preview">{Object.entries(unknown && execution ? execution.arguments : parsed.arguments).filter(([key]) => key !== 'request_id').map(([key, value]) => <div key={key}><dt>{argumentLabels[key] ?? key}</dt><dd>{typeof value === 'string' ? value : pretty(value)}</dd></div>)}</dl>
        <label className="qq-check"><input type="checkbox" disabled={pending || mutationBusy || !enabled} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对目标和内容，确认执行此次真实{tool?.destructive ? '撤回' : '发送'}。</span></label>
      </div>}
      <ErrorNotice failure={validationFailure} />
      <div className="qq-actions"><button className="button button-primary" type="submit" disabled={blocked || !enabled || (hasSideEffect && !confirmed)}>{pending ? '正在执行…' : '执行测试'}</button><span className="qq-request-id">本次请求 ID：{requestId}</span></div>
    </form>}
    {unknown && execution && <div className="qq-unknown" role="alert"><h4>上次动作结果未知</h4><p>保留了原请求 ID、参数与错误。请先查看消息记录或协议端真实状态；相同 ID 的重试用于查询或复用原执行记录，不保证原动作未发生。</p>
      <label className="qq-check"><input type="checkbox" checked={unknownReviewed} disabled={pending} onChange={event => setUnknownReviewed(event.target.checked)} /><span>我已核查真实状态，理解上次动作仍可能已执行。</span></label>
      <div className="qq-actions"><button type="button" className="button button-secondary" disabled={!unknownReviewed || pending || mutationBusy || !enabled || ((!execution.tool.readOnly || execution.tool.destructive) && !confirmed)} onClick={() => void execute(execution)}>重试原请求（复用 ID）</button>
        <button type="button" className="button button-secondary" disabled={!unknownReviewed || pending || mutationBusy} onClick={allowNewRequest}>确认后创建新请求</button></div><p className="qq-help">需要修改参数时，先明确创建新请求；发送或撤回仍需再次勾选确认。</p>
    </div>}
    {execution && <ExecutionResult execution={execution} onFeedback={onFeedback} />}
    {history.length > 0 && <details className="qq-history"><summary>本次打开面板的执行记录（{history.length}）</summary>{[...history].reverse().map((item, index) => <ExecutionResult key={`${item.requestId}-${item.startedAt}-${index}`} execution={item} onFeedback={onFeedback} />)}</details>}
  </>
}
function ExecutionResult({ execution, onFeedback }: { execution: Execution; onFeedback: (message: string) => void }) {
  return <div className="qq-execution"><div className="qq-execution-heading"><strong>{execution.tool.title}</strong><span>{execution.pending ? '执行中，请勿重复点击' : execution.failure ? execution.failure.outcome === 'unknown' ? '结果未知' : '执行失败' : '执行完成'}</span></div>
    <p className="qq-help">{dateLabel(execution.startedAt)} · 请求 ID：{execution.requestId}</p><ErrorNotice failure={execution.failure ?? null} />
    <JsonPreview label="请求与结果 JSON" value={{ name: execution.tool.name, requestId: execution.requestId, arguments: execution.arguments, startedAt: execution.startedAt,
      ...(execution.pending ? { state: 'pending' } : execution.failure ? { error: execution.failure } : { result: execution.result }) }} onFeedback={onFeedback} />
  </div>
}

function MessageLog({ active, enabled, onFeedback }: { active: boolean; enabled: boolean; onFeedback: (message: string) => void }) {
  const prefix = useId()
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const alive = useRef(false)
  const filterRef = useRef(conversationId)
  filterRef.current = conversationId
  const load = useCallback(async () => {
    if (controllerRef.current) return
    const controller = new AbortController(); controllerRef.current = controller
    const currentGeneration = ++generation.current
    setPending(true)
    try {
      const response = await hostRequest<InvokeResult>('/plugins/qq/invoke', { method: 'POST', signal: controller.signal, body: {
        name: 'qq_list_received_messages', arguments: { limit: 50, ...(filterRef.current.trim() ? { conversation_id: filterRef.current.trim() } : {}) }, requestId: crypto.randomUUID(),
      } })
      if (!alive.current || controller.signal.aborted || generation.current !== currentGeneration) return
      if (!isJsonObject(response.result) || !Array.isArray(response.result.messages)) throw new Error('Host 消息记录响应格式不兼容。')
      setMessages(response.result.messages as unknown as StoredMessage[]); setLoaded(true); setFailure(null); setLoadedAt(new Date().toISOString())
    } catch (error) {
      if (alive.current && !controller.signal.aborted && generation.current === currentGeneration) setFailure(failureFrom(error))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (alive.current && generation.current === currentGeneration) setPending(false)
    }
  }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current; controllerRef.current?.abort(); controllerRef.current = null } }, [])
  useEffect(() => {
    if (!active) { ++generation.current; controllerRef.current?.abort(); controllerRef.current = null; setPending(false) }
  }, [active])
  useEffect(() => { if (active && enabled && !loaded && !failure) void load() }, [active, enabled, loaded, failure, load])

  return <>
    <div className="section-heading"><h3>消息记录</h3><p>读取 Eating 后台实际保存的最近 50 条接收记录，断开 QQ 连接后仍可查看。此处不是 QQ 的完整历史。</p></div>
    <form className="qq-message-filter" onSubmit={event => { event.preventDefault(); void load() }}><label htmlFor={`${prefix}-conversation`}>会话 ID（选填）</label><div><input id={`${prefix}-conversation`} disabled={pending} value={conversationId} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => setConversationId(event.target.value)} /><button type="submit" className="button button-secondary" disabled={pending || !enabled}><RefreshCw size={14} aria-hidden="true" />{pending ? '正在读取…' : '刷新记录'}</button></div></form>
    <ErrorNotice failure={failure} />
    {loadedAt && <p className="qq-help">读取时间：{dateLabel(loadedAt)} · 共 {messages.length} 条。Harness 已接收仅表示接收接口确认，不代表 Agent 已读。</p>}
    {!loaded && pending && <p className="qq-loading" role="status">正在读取真实消息记录…</p>}
    {loaded && !messages.length && <div className="qq-empty"><strong>还没有接收记录</strong><p>连接已登录的 OneBot 协议端后，收到的实际消息会显示在这里。也可以清空会话筛选后刷新。</p></div>}
    <ol className="qq-message-list">{messages.map(message => <li key={message.eventId}>
      <div className="qq-message-heading"><strong>{message.conversationId || '未提供会话 ID'}</strong><span className="status-badge">{harnessLabels[message.harnessStatus] ?? message.harnessStatus}</span></div>
      <p className="qq-message-text">{message.text || '此消息没有可提取的文本，请查看原始事件。'}</p>
      <dl className="qq-message-meta"><div><dt>接收时间</dt><dd><time dateTime={message.receivedAt}>{dateLabel(message.receivedAt)}</time></dd></div><div><dt>消息序号</dt><dd>{message.sequence}</dd></div><div><dt>发送者原始字段</dt><dd>{pretty(message.raw.sender ?? message.raw.user_id ?? null)}</dd></div></dl>
      <details><summary>查看原始事件与投递状态</summary><JsonPreview label="消息原始记录" value={message} onFeedback={onFeedback} /></details>
    </li>)}</ol>
  </>
}

function McpCapabilities({ active, enabled, capabilities, harness, onFeedback }: { active: boolean; enabled: boolean; capabilities: PluginCapability[]; harness?: Workspace['harness']; onFeedback: (message: string) => void }) {
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
    <div className="section-heading"><h3>MCP 能力</h3><p>QQ 插件提供独立的 Streamable HTTP MCP 入口。此面板不会自动将 MCP 注册到 Harness，请在可信 Harness 中手动配置。</p></div>
    <div className="qq-harness-status"><strong>{harness?.state === 'attached' ? 'Harness 消息接口已接入' : 'Harness 消息接口尚未接入'}</strong><p>{harness ? `等待投递 ${harness.pending} 条 · 接口已接收 ${harness.accepted} 条 · 结果未知 ${harness.uncertain} 条` : '正在读取后台投递状态。'}。消息接口接入状态与 MCP 工具注册是两个独立事实。</p></div>
    <div className="qq-mcp-access"><p>连接配置含 QQ 插件专属访问令牌，仅在你点击后读取与展示。请只交给可信的主 Harness。</p><div className="qq-actions"><button className="button button-secondary" type="button" disabled={pending || !enabled} onClick={() => void revealRegistration()}>{pending ? '正在读取…' : '查看 / 复制 MCP 配置'}</button>{registration && <button type="button" className="text-button" onClick={() => { ++generation.current; controllerRef.current?.abort(); controllerRef.current = null; setRegistration(null); setPending(false) }}>隐藏配置</button>}</div><ErrorNotice failure={failure} />
      {registration && <><p className="qq-help">{registration.note} 离开此标签会隐藏令牌。</p><JsonPreview label="MCP 连接配置" value={registration} onFeedback={onFeedback} /></>}
    </div>
    <div className="qq-capability-heading"><h3>QQ 后台能力目录</h3><p>支持状态来自插件声明；实际可执行结果仍受连接、协议端与账号权限限制。</p></div>
    {!capabilities.length ? <p className="qq-empty">尚未读取到能力目录，请刷新后台状态。</p> : <ul className="qq-capability-list">{capabilities.map(capability => <li key={capability.id}><div><strong>{capability.name}</strong><span className="status-badge">{{ supported: '已提供', unsupported: '不支持', unknown: '待核实' }[capability.support]}</span></div><p>{capability.description}</p>{capability.toolName && <code>{capability.toolName}</code>}</li>)}</ul>}
  </>
}
