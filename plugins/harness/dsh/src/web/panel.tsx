import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, Check, Download, Info, RefreshCw } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import { isJsonObject } from '@eating/plugin-sdk'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import type { ConfigurationValidation, PluginPanelProps } from '@eating/ui-sdk'
import './panel.css'

type Operation = 'save' | 'install' | 'connect' | 'disconnect'
interface RuntimeStatus {
  readonly version: string
  readonly installed: boolean
  readonly installing: boolean
  readonly progress: string | null
  readonly lastError: string | null
  readonly ready: boolean
  readonly busy: boolean
  readonly sessionId: string | null
  readonly lastOutcome: string | null
}
interface PublicConfiguration {
  readonly displayName: string
  readonly endpoint: string
  readonly model: string
  readonly autoConnect: boolean
  readonly timeoutMs: number
  readonly maxTokens: number
  readonly apiKeyConfigured: boolean
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
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
  readonly clearApiKey: boolean
  readonly autoConnect: boolean
  readonly timeoutMs: string
  readonly maxTokens: string
}
interface Failure { readonly code: string; readonly message: string; readonly outcome: string }
interface UncertainAction { readonly operation: Operation; readonly afterRead: number }

const stateLabels: Record<ConnectionStatus['state'], string> = {
  unconfigured: '待配置', disconnected: '未启动', connecting: '正在启动', connected: '运行中', reconnecting: '正在恢复', error: '启动异常',
}
const operationLabels: Record<Operation, string> = { save: '保存配置', install: '安装运行时', connect: '启动 Harness', disconnect: '停止 Harness' }
const outcomeLabels: Readonly<Record<string, string>> = { pending: '处理中', durable: '已可靠接管，尚未确认处理完成', unknown: '结果待核对', failed: '处理失败', completed: '处理完成', recovered: '已恢复' }
const integerIn = (value: string, min: number, max: number) => value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max

export function validateConfiguration(values: PluginConfiguration): ConfigurationValidation {
  const errors: Record<string, string> = {}
  if (typeof values.displayName !== 'string' || !values.displayName.trim() || values.displayName.trim().length > 80) errors.displayName = '显示名称需为 1 至 80 个字符。'
  if (typeof values.endpoint !== 'string') errors.endpoint = '请填写 API 地址。'
  else if (values.endpoint.trim()) {
    try {
      const url = new URL(values.endpoint.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || values.endpoint.includes('?') || values.endpoint.includes('#')) errors.endpoint = '请使用不含账号、密码、查询参数或片段的 http:// 或 https:// 地址。'
      else if (values.endpoint.trim().length > 2048) errors.endpoint = 'API 地址不能超过 2048 个字符。'
    } catch { errors.endpoint = '请填写有效的 http:// 或 https:// API 地址。' }
  }
  if (typeof values.model !== 'string' || values.model.trim().length > 160 || /[\r\n\0]/.test(values.model)) errors.model = '模型名称需为空草稿或不超过 160 个字符，且不能包含换行或空字符。'
  if (typeof values.timeoutMs !== 'string' || !integerIn(values.timeoutMs, 1000, 120000)) errors.timeoutMs = '请求超时需为 1000 至 120000 毫秒的整数。'
  if (typeof values.maxTokens !== 'string' || !integerIn(values.maxTokens, 1, 131072)) errors.maxTokens = '最大输出需为 1 至 131072 的整数。'
  if (typeof values.apiKey === 'string' && (values.apiKey.length > 4096 || /[\r\n\0]/.test(values.apiKey))) errors.apiKey = 'API Key 不能包含换行或空字符，长度不能超过 4096。'
  return { valid: Object.keys(errors).length === 0, errors }
}

function incompatible(): HostApiError { return new HostApiError('INVALID_HOST_RESPONSE', '后台返回的 Harness 状态不完整，请检查插件与 Host 版本。') }
function readConfiguration(value: unknown): PublicConfiguration {
  if (!isJsonObject(value) || typeof value.displayName !== 'string' || typeof value.endpoint !== 'string' || typeof value.model !== 'string'
    || typeof value.autoConnect !== 'boolean' || typeof value.timeoutMs !== 'number' || typeof value.maxTokens !== 'number'
    || typeof value.apiKeyConfigured !== 'boolean' || !isJsonObject(value.runtimeStatus)) throw incompatible()
  const runtime = value.runtimeStatus
  if (typeof runtime.version !== 'string' || ['installed', 'installing', 'ready', 'busy'].some(key => typeof runtime[key] !== 'boolean')
    || ['progress', 'lastError', 'sessionId', 'lastOutcome'].some(key => runtime[key] !== null && typeof runtime[key] !== 'string')) throw incompatible()
  return {
    displayName: value.displayName, endpoint: value.endpoint, model: value.model, autoConnect: value.autoConnect,
    timeoutMs: value.timeoutMs, maxTokens: value.maxTokens, apiKeyConfigured: value.apiKeyConfigured,
    runtimeStatus: { version: runtime.version, installed: runtime.installed === true, installing: runtime.installing === true,
      progress: runtime.progress as string | null, lastError: runtime.lastError as string | null, ready: runtime.ready === true,
      busy: runtime.busy === true, sessionId: runtime.sessionId as string | null, lastOutcome: runtime.lastOutcome as string | null },
    ...(typeof value.configurationPath === 'string' ? { configurationPath: value.configurationPath } : {}),
    ...(typeof value.dataDirectory === 'string' ? { dataDirectory: value.dataDirectory } : {}),
    ...(typeof value.warning === 'string' ? { warning: value.warning } : {}),
  }
}
function readPlugin(value: unknown): WorkspacePlugin {
  if (!isJsonObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.plugins)) throw incompatible()
  const entry = value.plugins.find(item => isJsonObject(item) && item.id === 'dsh')
  if (!isJsonObject(entry)) throw new HostApiError('HARNESS_NOT_INSTALLED', 'Host 未加载 DeepSeek Harness 插件，请检查安装状态。')
  if (entry.kind !== 'harness' || typeof entry.enabled !== 'boolean' || !isJsonObject(entry.status)
    || typeof entry.status.state !== 'string' || !Object.hasOwn(stateLabels, entry.status.state)
    || entry.status.lastError !== null && typeof entry.status.lastError !== 'string') throw incompatible()
  return { enabled: entry.enabled, configuration: readConfiguration(entry.configuration),
    status: { state: entry.status.state as ConnectionStatus['state'], lastError: entry.status.lastError } }
}
function makeDraft(value: PublicConfiguration): Draft {
  return { displayName: value.displayName, endpoint: value.endpoint, model: value.model, apiKey: '', clearApiKey: false,
    autoConnect: value.autoConnect, timeoutMs: String(value.timeoutMs), maxTokens: String(value.maxTokens) }
}
function failureFrom(error: unknown): Failure {
  return error instanceof HostApiError ? { code: error.code, message: error.message, outcome: error.outcome }
    : { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : '操作失败，请检查 Eating Host。', outcome: 'unknown' }
}
function ErrorNotice({ failure }: { readonly failure: Failure | null }) {
  return failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{failure.message}</p><small>错误代码：{failure.code}{failure.outcome === 'unknown' ? ' · 结果未知，请先核对真实状态。' : ''}</small></div></div>
}
function Field({ id, label, hint, error, children }: { readonly id: string; readonly label: string; readonly hint: string; readonly error?: string; readonly children: ReactNode }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}</label>{children}<p className="field-hint" id={`${id}-hint`}>{hint}</p>{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>
}

export function DSHPanel({ onFeedback, onRefresh }: PluginPanelProps) {
  const prefix = useId()
  const [plugin, setPlugin] = useState<WorkspacePlugin | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [refreshFailure, setRefreshFailure] = useState<Failure | null>(null)
  const [actionFailure, setActionFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})
  const [operation, setOperation] = useState<Operation | null>(null)
  const [uncertain, setUncertain] = useState<UncertainAction | null>(null)
  const [readSerial, setReadSerial] = useState(0)
  const [visible, setVisible] = useState(() => !document.hidden)
  const mounted = useRef(false)
  const actionLock = useRef(false)
  const generation = useRef(0)
  const readCount = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const actionController = useRef<AbortController | null>(null)
  const callbacks = useRef({ onFeedback, onRefresh })
  callbacks.current = { onFeedback, onRefresh }

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
      else if (!dirtyRef.current) setDraft(makeDraft(response.configuration))
      setReadSerial(++readCount.current)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === generation.current) setRefreshFailure(failureFrom(error))
    } finally {
      if (mounted.current && ticket === generation.current) { setLoading(false); setReading(false) }
      if (readController.current === controller) readController.current = null
    }
  }, [])

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
    const clearSecret = () => setDraft(current => current ? { ...current, apiKey: '', clearApiKey: false } : current)
    const startPolling = () => {
      stopPolling()
      if (document.hidden) return
      void refreshWorkspace()
      timer = window.setInterval(() => { if (!readController.current && !document.hidden) void refreshWorkspace() }, 2000)
    }
    const visibilityChanged = () => {
      setVisible(!document.hidden)
      if (document.hidden) { stopPolling(); clearSecret() }
      else startPolling()
    }
    const pageHidden = () => { stopPolling(); clearSecret(); setVisible(false) }
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
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', pageHidden)
      window.removeEventListener('pageshow', pageShown)
    }
  }, [refreshWorkspace])

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => current ? { ...current, [key]: value, ...(key === 'clearApiKey' && value === true ? { apiKey: '' } : {}) } : current)
    dirtyRef.current = true; setDirty(true); setResult('')
    setFieldErrors(current => ({ ...current, [key]: '' }))
  }
  const saved = plugin?.configuration
  const runtime = saved?.runtimeStatus
  const state = plugin?.status.state
  const starting = state === 'connecting' || state === 'reconnecting'
  const active = state === 'connected'
  const configured = Boolean(saved?.endpoint.trim() && saved.model.trim())
  const blocked = operation !== null || runtime?.installing === true || starting || !visible || refreshFailure !== null || uncertain !== null

  async function mutate(next: Operation) {
    if (!draft || !plugin || !visible || actionLock.current || blocked || !plugin.enabled) return
    if (next === 'save') {
      const validation = validateConfiguration({ ...draft })
      setFieldErrors(validation.errors)
      if (!validation.valid) { setActionFailure({ code: 'INVALID_CONFIGURATION', message: '请修正配置字段后再保存。', outcome: 'not-sent' }); return }
    }
    if (next === 'connect' && (dirtyRef.current || !configured || !runtime?.installed || active)) return
    if (next === 'install' && runtime?.installed || next === 'disconnect' && !active && state !== 'error') return
    actionLock.current = true; setOperation(next); setResult(''); setActionFailure(null)
    ++generation.current; readController.current?.abort(); setReading(false)
    const controller = new AbortController()
    actionController.current = controller
    try {
      if (next === 'save') {
        const response = readConfiguration(await hostRequest<unknown>('/plugins/dsh/configuration', { method: 'POST', signal: controller.signal, body: {
          displayName: draft.displayName.trim(), endpoint: draft.endpoint.trim(), model: draft.model.trim(), autoConnect: draft.autoConnect,
          timeoutMs: Number(draft.timeoutMs), maxTokens: Number(draft.maxTokens),
          ...(draft.apiKey.trim() && !draft.clearApiKey ? { apiKey: draft.apiKey } : {}),
          ...(draft.clearApiKey ? { clearApiKey: true } : {}),
        } }))
        if (!mounted.current || controller.signal.aborted) return
        dirtyRef.current = false; setDirty(false); setDraft(makeDraft(response))
        setPlugin(current => current ? { ...current, configuration: response } : current)
        const message = '配置已保存，运行时已停止。启动 Harness 将使用已保存配置。'
        setResult(message); callbacks.current.onFeedback('DeepSeek Harness 配置已保存。')
      } else if (next === 'install') {
        await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal: controller.signal, body: { operation: 'install-runtime', input: {} } })
        if (!mounted.current || controller.signal.aborted) return
        setResult('已提交运行时安装请求，安装进度以下方后台状态为准。')
      } else {
        await hostRequest<unknown>(`/plugins/dsh/${next}`, { method: 'POST', signal: controller.signal, body: {} })
        if (!mounted.current || controller.signal.aborted) return
        setResult(`${operationLabels[next]}请求已完成，请核对当前运行状态。`)
      }
      await refreshWorkspace(true)
      if (mounted.current && !controller.signal.aborted) void callbacks.current.onRefresh?.().catch(() => {})
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      const failure = failureFrom(error)
      setActionFailure(failure)
      if (failure.outcome === 'unknown') {
        setUncertain({ operation: next, afterRead: readCount.current })
        setDraft(current => current ? { ...current, apiKey: '', clearApiKey: false } : current)
      }
      await refreshWorkspace(true)
    } finally {
      if (actionController.current === controller) actionController.current = null
      actionLock.current = false
      if (mounted.current) setOperation(null)
    }
  }
  const id = (name: string) => `${prefix}-${name}`
  const describedBy = (name: string) => `${id(name)}-hint${fieldErrors[name] ? ` ${id(name)}-error` : ''}`
  const processing = active && runtime?.ready ? runtime.busy ? '正在处理' : '空闲' : starting ? '正在启动' : '未启动'
  const runtimeLabel = runtime?.installing ? '正在安装运行时' : runtime?.installed ? '运行时已安装' : '尚未安装运行时'

  return <div className="dsh-panel">
    <div className="dsh-status-strip"><div><strong>{plugin ? refreshFailure ? '状态待确认' : stateLabels[plugin.status.state] : '正在读取后台状态'}</strong>{runtime && <span>{processing}</span>}</div><button type="button" className="text-button" disabled={operation !== null || reading || !visible} onClick={() => void refreshWorkspace()}><RefreshCw size={14} aria-hidden="true" />{reading ? '正在读取…' : '刷新状态'}</button></div>
    <ErrorNotice failure={refreshFailure} />
    {plugin?.status.lastError && <ErrorNotice failure={{ code: 'HARNESS_STATUS_ERROR', message: plugin.status.lastError, outcome: 'failed' }} />}
    {loading && <p className="dsh-loading" role="status">正在读取 DeepSeek Harness 的配置与运行状态…</p>}
    {!plugin && !loading && <button type="button" className="button button-secondary" disabled={reading} onClick={() => void refreshWorkspace()}>重新读取后台</button>}
    {saved && runtime && <section className="dsh-runtime" aria-labelledby={id('runtime-title')}>
      <div className="dsh-runtime-heading"><div><h3 id={id('runtime-title')}>独立运行时</h3><p>{runtimeLabel}{runtime.version ? ` · ${runtime.version}` : ''}</p></div><button type="button" className="button button-secondary" disabled={blocked || !plugin?.enabled || runtime.installed || active} onClick={() => void mutate('install')}><Download size={16} aria-hidden="true" />{operation === 'install' || runtime.installing ? '正在安装…' : runtime.installed ? '已安装' : '安装运行时'}</button></div>
      <p className="dsh-help">由 Eating 管理此插件专用的 DeepSeek Harness 运行时和独立数据目录。</p>
      {runtime.progress && <p className="dsh-progress" role="status">{runtime.progress}</p>}
      {runtime.lastError && <ErrorNotice failure={{ code: 'HARNESS_RUNTIME_ERROR', message: runtime.lastError, outcome: 'failed' }} />}
    </section>}
    {draft && <section aria-labelledby={id('configuration-title')}>
      <div className="section-heading"><h3 id={id('configuration-title')}>模型配置</h3><p>首版使用 OpenAI-compatible API。填写服务商的 API 地址、模型名称与 API Key；启动只表示 Harness 运行时就绪，模型请求结果以实际处理状态为准。</p></div>
      {saved?.warning && <div className="dsh-notice"><Info size={16} aria-hidden="true" /><p>{saved.warning}</p></div>}
      <form className="form-fields" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate('save') }}>
        <fieldset className="dsh-fieldset" disabled={operation !== null || runtime?.installing || starting || !visible}>
          <Field id={id('displayName')} label="显示名称" hint="用于在 Eating 中识别此 Harness 配置。" error={fieldErrors.displayName}><input id={id('displayName')} maxLength={80} value={draft.displayName} autoComplete="off" aria-describedby={describedBy('displayName')} aria-invalid={Boolean(fieldErrors.displayName)} onChange={event => updateDraft('displayName', event.target.value)} /></Field>
          <Field id={id('endpoint')} label="API 地址" hint="填写服务商的 base URL，例如 https://api.example.com/v1。留空可保存草稿，启动前必须填写。" error={fieldErrors.endpoint}><input id={id('endpoint')} type="url" value={draft.endpoint} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} aria-describedby={describedBy('endpoint')} aria-invalid={Boolean(fieldErrors.endpoint)} onChange={event => updateDraft('endpoint', event.target.value)} /></Field>
          <Field id={id('model')} label="模型名称" hint="填写服务商支持的精确模型名称，不自动发现模型候选。" error={fieldErrors.model}><input id={id('model')} value={draft.model} maxLength={160} autoComplete="off" spellCheck={false} aria-describedby={describedBy('model')} aria-invalid={Boolean(fieldErrors.model)} onChange={event => updateDraft('model', event.target.value)} /></Field>
          <Field id={id('apiKey')} label="API Key" hint={`${saved?.apiKeyConfigured ? '后台已保存 API Key。' : '后台尚未配置 API Key。'}只写入、不回显；留空保留原值。`} error={fieldErrors.apiKey}><input id={id('apiKey')} type="password" value={draft.apiKey} disabled={draft.clearApiKey} maxLength={4096} autoComplete="new-password" spellCheck={false} aria-describedby={describedBy('apiKey')} aria-invalid={Boolean(fieldErrors.apiKey)} onChange={event => updateDraft('apiKey', event.target.value)} /></Field>
          <label className="check-field dsh-compact-check"><input type="checkbox" checked={draft.clearApiKey} onChange={event => updateDraft('clearApiKey', event.target.checked)} /><span><strong>清除已保存的 API Key</strong><small>仅在勾选并保存后清除，适用于允许无密钥的 API 服务。</small></span></label>
          <Field id={id('timeoutMs')} label="请求超时" hint="单位为毫秒，范围 1000–120000。超时不表示模型或工具动作未发生。" error={fieldErrors.timeoutMs}><input id={id('timeoutMs')} type="number" min={1000} max={120000} step={1} inputMode="numeric" value={draft.timeoutMs} aria-describedby={describedBy('timeoutMs')} aria-invalid={Boolean(fieldErrors.timeoutMs)} onChange={event => updateDraft('timeoutMs', event.target.value)} /></Field>
          <Field id={id('maxTokens')} label="最大输出 token" hint="范围 1–131072；实际支持上限由所填模型决定。" error={fieldErrors.maxTokens}><input id={id('maxTokens')} type="number" min={1} max={131072} step={1} inputMode="numeric" value={draft.maxTokens} aria-describedby={describedBy('maxTokens')} aria-invalid={Boolean(fieldErrors.maxTokens)} onChange={event => updateDraft('maxTokens', event.target.value)} /></Field>
          <label className="check-field"><input type="checkbox" checked={draft.autoConnect} onChange={event => updateDraft('autoConnect', event.target.checked)} /><span><strong>Host 启动时自动启动 Harness</strong><small>需要有效配置和已安装的运行时。保存配置会先停止旧运行时，本次保存后仍需手动启动。</small></span></label>
        </fieldset>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={blocked || !plugin?.enabled}>{operation === 'save' ? '正在保存…' : '保存配置'}</button><button className="button button-secondary" type="button" disabled={blocked || dirty || !configured || !runtime?.installed || !plugin?.enabled || active} onClick={() => void mutate('connect')}>{operation === 'connect' || starting ? '正在启动…' : '启动 Harness'}</button><button className="button button-secondary" type="button" disabled={blocked || !active && state !== 'error'} onClick={() => void mutate('disconnect')}>{operation === 'disconnect' ? '正在停止…' : '停止 Harness'}</button><span className="save-indicator">{dirty ? '有未保存更改，请先保存后启动' : !configured ? '待配置：请填写 API 地址与模型名称' : !runtime?.installed ? '请先安装独立运行时' : '使用后台已保存配置'}</span></div>
      </form>
      {result && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{result}</p>}
      <ErrorNotice failure={actionFailure} />
      {uncertain && <div className="dsh-unknown"><strong>{operationLabels[uncertain.operation]}的结果待核对</strong><p>请求可能已经执行。请刷新并核对后台配置、运行时与会话状态；确认前已暂停新的管理操作。</p><button type="button" className="button button-secondary" disabled={reading || refreshFailure !== null || readSerial <= uncertain.afterRead} onClick={() => { setUncertain(null); setActionFailure(null); setResult('已确认核对当前后台状态，可继续管理。') }}>我已核对当前状态</button></div>}
    </section>}
    {runtime && <dl className="dsh-details"><div><dt>运行状态</dt><dd>{refreshFailure ? '状态待确认' : processing}</dd></div>{runtime.sessionId && <div><dt>主会话 ID</dt><dd>{runtime.sessionId}</dd></div>}{runtime.version && <div><dt>运行时版本</dt><dd>{runtime.version}</dd></div>}{runtime.lastOutcome && <div><dt>最近处理结果</dt><dd>{outcomeLabels[runtime.lastOutcome] ?? runtime.lastOutcome}</dd></div>}{saved?.dataDirectory && <div><dt>插件数据目录</dt><dd>{saved.dataDirectory}</dd></div>}{saved?.configurationPath && <div><dt>配置文件</dt><dd>{saved.configurationPath}</dd></div>}</dl>}
    <div className="dsh-notice dsh-boundary"><Info size={16} aria-hidden="true" /><p>首版对接 QQ。普通文本不会自动发送到 QQ，是否回复及调用哪些已授权 QQ 工具由主 Agent 决定。Eating 不提供原生会话或聊天历史查看页。</p></div>
  </div>
}
