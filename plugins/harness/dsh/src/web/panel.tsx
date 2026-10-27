import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, Check, Download, Info, RefreshCw } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import { isJsonObject } from '@eating/plugin-sdk'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import { HostApiError, formatNumber, getErrorMessage, hostRequest, translate, useI18n } from '@eating/ui-sdk'
import type { ConfigurationValidation, PluginPanelProps } from '@eating/ui-sdk'
import './i18n'
import type { DshTranslationKey } from './i18n'
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
interface Failure {
  readonly code: string
  readonly error: unknown
  readonly outcome: string
  readonly messageKey?: DshTranslationKey
  readonly detail?: string
}
interface UncertainAction { readonly operation: Operation; readonly afterRead: number }
interface ValidationIssue { readonly key: DshTranslationKey; readonly params?: Readonly<Record<string, number>> }

const stateKeys: Record<ConnectionStatus['state'], DshTranslationKey> = {
  unconfigured: 'state.unconfigured', disconnected: 'state.disconnected', connecting: 'state.connecting',
  connected: 'state.connected', reconnecting: 'state.reconnecting', error: 'state.error',
}
const uncertainKeys: Record<Operation, DshTranslationKey> = {
  save: 'uncertain.save', install: 'uncertain.install', connect: 'uncertain.connect', disconnect: 'uncertain.disconnect',
}
const outcomeKeys: Readonly<Record<string, DshTranslationKey>> = {
  pending: 'outcome.pending', durable: 'outcome.durable', unknown: 'outcome.unknown',
  failed: 'outcome.failed', completed: 'outcome.completed', recovered: 'outcome.recovered',
}
const integerIn = (value: string, min: number, max: number) => value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max

function validateFields(values: PluginConfiguration): Readonly<Record<string, ValidationIssue>> {
  const errors: Record<string, ValidationIssue> = {}
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
  if (!isJsonObject(entry)) throw new HostApiError('HARNESS_NOT_INSTALLED', translate('dsh', 'error.notInstalled'))
  if (entry.kind !== 'harness' || typeof entry.enabled !== 'boolean' || !isJsonObject(entry.status)
    || typeof entry.status.state !== 'string' || !Object.hasOwn(stateKeys, entry.status.state)
    || entry.status.lastError !== null && typeof entry.status.lastError !== 'string') throw incompatible()
  return { enabled: entry.enabled, configuration: readConfiguration(entry.configuration),
    status: { state: entry.status.state as ConnectionStatus['state'], lastError: entry.status.lastError } }
}
function makeDraft(value: PublicConfiguration): Draft {
  return { displayName: value.displayName, endpoint: value.endpoint, model: value.model, apiKey: '', clearApiKey: false,
    autoConnect: value.autoConnect, timeoutMs: String(value.timeoutMs), maxTokens: String(value.maxTokens) }
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
    <p>{message}</p>
    <small>{t('error.code', { code: failure.code })}</small>
    {failure.outcome === 'unknown' && <p className="dsh-error-recovery">{t('error.unknown')}</p>}
    {failure.detail && <details className="dsh-error-details"><summary>{t('error.details')}</summary><p>{failure.detail}</p></details>}
  </div></div>
}
function Field({ id, label, hint, error, children }: { readonly id: string; readonly label: string; readonly hint: string; readonly error?: string; readonly children: ReactNode }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}</label>{children}<p className="field-hint" id={`${id}-hint`}>{hint}</p>{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>
}

export function DSHPanel({ onFeedback, onRefresh }: PluginPanelProps) {
  const { t, formatNumber } = useI18n('dsh')
  const prefix = useId()
  const [plugin, setPlugin] = useState<WorkspacePlugin | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
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
    setFieldIssues(current => { const next = { ...current }; delete next[key]; return next })
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
      const issues = validateFields({ ...draft })
      setFieldIssues(issues)
      if (Object.keys(issues).length > 0) { setActionFailure({ code: 'INVALID_CONFIGURATION', error: { code: 'INVALID_CONFIGURATION' }, messageKey: 'validation.configuration', outcome: 'not-sent' }); return }
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
        setResult('result.saved'); callbacks.current.onFeedback(translate('dsh', 'feedback.saved'))
      } else if (next === 'install') {
        await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal: controller.signal, body: { operation: 'install-runtime', input: {} } })
        if (!mounted.current || controller.signal.aborted) return
        setResult('result.install')
      } else {
        await hostRequest<unknown>(`/plugins/dsh/${next}`, { method: 'POST', signal: controller.signal, body: {} })
        if (!mounted.current || controller.signal.aborted) return
        setResult(next === 'connect' ? 'result.connect' : 'result.disconnect')
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
  const fieldErrors = Object.fromEntries(Object.entries(fieldIssues).map(([name, issue]) => [name, validationMessage(issue)]))
  const id = (name: string) => `${prefix}-${name}`
  const describedBy = (name: string) => `${id(name)}-hint${fieldErrors[name] ? ` ${id(name)}-error` : ''}`
  const processing = t(active && runtime?.ready ? runtime.busy ? 'processing.busy' : 'processing.idle' : starting ? 'processing.starting' : 'processing.stopped')
  const runtimeLabel = t(runtime?.installing ? 'runtime.installing' : runtime?.installed ? 'runtime.installed' : 'runtime.missing')
  const runtimeHelp = t(runtime?.installing ? 'runtime.help.installing' : runtime?.installed ? configured ? 'runtime.help.configured' : 'runtime.help.unconfigured' : 'runtime.help.missing')
  const outcomeKey = runtime?.lastOutcome ? outcomeKeys[runtime.lastOutcome] : undefined

  return <div className="dsh-panel">
    <div className="dsh-status-strip"><div><strong>{plugin ? refreshFailure ? t('state.unconfirmed') : t(stateKeys[plugin.status.state]) : t('state.loading')}</strong>{runtime && <span>{processing}</span>}</div><button type="button" className="text-button" disabled={operation !== null || reading || !visible} onClick={() => void refreshWorkspace()}><RefreshCw size={14} aria-hidden="true" />{t(reading ? 'action.refreshing' : 'action.refresh')}</button></div>
    <ErrorNotice failure={refreshFailure} />
    {plugin?.status.lastError && <ErrorNotice failure={runtimeFailure('HARNESS_STATUS_ERROR', plugin.status.lastError)} />}
    {loading && <p className="dsh-loading" role="status">{t('loading.configuration')}</p>}
    {!plugin && !loading && <button type="button" className="button button-secondary" disabled={reading} onClick={() => void refreshWorkspace()}>{t('action.reload')}</button>}
    {saved && runtime && <section className="dsh-runtime" aria-labelledby={id('runtime-title')}>
      <div className="dsh-runtime-heading"><div><h3 id={id('runtime-title')}>{t('runtime.title')}</h3><p>{runtime.version ? t('runtime.versionedStatus', { status: runtimeLabel, version: runtime.version }) : runtimeLabel}</p></div><button type="button" className="button button-secondary" disabled={blocked || !plugin?.enabled || runtime.installed || active} onClick={() => void mutate('install')}><Download size={16} aria-hidden="true" />{t(operation === 'install' || runtime.installing ? 'action.installing' : runtime.installed ? 'action.installed' : 'action.install')}</button></div>
      <p className="dsh-help">{runtimeHelp}</p>
      {runtime.progress && <p className="dsh-progress" role="status">{t('runtime.progress')}</p>}
      {runtime.lastError && <ErrorNotice failure={runtimeFailure('HARNESS_RUNTIME_ERROR', runtime.lastError)} />}
    </section>}
    {draft && <section aria-labelledby={id('configuration-title')}>
      <div className="section-heading"><h3 id={id('configuration-title')}>{t('configuration.title')}</h3><p>{t('configuration.description')}</p></div>
      {saved?.warning && <div className="dsh-notice"><Info size={16} aria-hidden="true" /><p>{t('notice.httpWarning')}</p></div>}
      <form className="form-fields" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate('save') }}>
        <fieldset className="dsh-fieldset" disabled={operation !== null || runtime?.installing || starting || !visible}>
          <Field id={id('displayName')} label={t('field.displayName.label')} hint={t('field.displayName.hint')} error={fieldErrors.displayName}><input id={id('displayName')} maxLength={80} value={draft.displayName} autoComplete="off" aria-describedby={describedBy('displayName')} aria-invalid={Boolean(fieldErrors.displayName)} onChange={event => updateDraft('displayName', event.target.value)} /></Field>
          <Field id={id('endpoint')} label={t('field.endpoint.label')} hint={t('field.endpoint.hint')} error={fieldErrors.endpoint}><input id={id('endpoint')} type="url" value={draft.endpoint} placeholder={t('field.endpoint.placeholder')} autoComplete="off" spellCheck={false} aria-describedby={describedBy('endpoint')} aria-invalid={Boolean(fieldErrors.endpoint)} onChange={event => updateDraft('endpoint', event.target.value)} /></Field>
          <Field id={id('model')} label={t('field.model.label')} hint={t('field.model.hint')} error={fieldErrors.model}><input id={id('model')} value={draft.model} maxLength={160} autoComplete="off" spellCheck={false} aria-describedby={describedBy('model')} aria-invalid={Boolean(fieldErrors.model)} onChange={event => updateDraft('model', event.target.value)} /></Field>
          <Field id={id('apiKey')} label={t('field.apiKey.label')} hint={t(saved?.apiKeyConfigured ? 'field.apiKey.hint.saved' : 'field.apiKey.hint.empty')} error={fieldErrors.apiKey}><input id={id('apiKey')} type="password" value={draft.apiKey} disabled={draft.clearApiKey} maxLength={4096} autoComplete="new-password" spellCheck={false} aria-describedby={describedBy('apiKey')} aria-invalid={Boolean(fieldErrors.apiKey)} onChange={event => updateDraft('apiKey', event.target.value)} /></Field>
          <label className="check-field dsh-compact-check"><input type="checkbox" checked={draft.clearApiKey} onChange={event => updateDraft('clearApiKey', event.target.checked)} /><span><strong>{t('field.clearApiKey.label')}</strong><small>{t('field.clearApiKey.hint')}</small></span></label>
          <Field id={id('timeoutMs')} label={t('field.timeoutMs.label')} hint={t('field.timeoutMs.hint', { min: formatNumber(1000), max: formatNumber(120000) })} error={fieldErrors.timeoutMs}><input id={id('timeoutMs')} type="number" min={1000} max={120000} step={1} inputMode="numeric" value={draft.timeoutMs} aria-describedby={describedBy('timeoutMs')} aria-invalid={Boolean(fieldErrors.timeoutMs)} onChange={event => updateDraft('timeoutMs', event.target.value)} /></Field>
          <Field id={id('maxTokens')} label={t('field.maxTokens.label')} hint={t('field.maxTokens.hint', { min: formatNumber(1), max: formatNumber(131072) })} error={fieldErrors.maxTokens}><input id={id('maxTokens')} type="number" min={1} max={131072} step={1} inputMode="numeric" value={draft.maxTokens} aria-describedby={describedBy('maxTokens')} aria-invalid={Boolean(fieldErrors.maxTokens)} onChange={event => updateDraft('maxTokens', event.target.value)} /></Field>
          <label className="check-field"><input type="checkbox" checked={draft.autoConnect} onChange={event => updateDraft('autoConnect', event.target.checked)} /><span><strong>{t('field.autoConnect.label')}</strong><small>{t('field.autoConnect.hint')}</small></span></label>
        </fieldset>
        <p className="dsh-save-warning">{t('notice.saveStopsRuntime')}</p>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={blocked || !plugin?.enabled}>{t(operation === 'save' ? 'action.saving' : 'action.save')}</button><button className="button button-secondary" type="button" disabled={blocked || dirty || !configured || !runtime?.installed || !plugin?.enabled || active} onClick={() => void mutate('connect')}>{t(operation === 'connect' || starting ? 'action.starting' : 'action.start')}</button><button className="button button-secondary" type="button" disabled={blocked || !active && state !== 'error'} onClick={() => void mutate('disconnect')}>{t(operation === 'disconnect' ? 'action.stopping' : 'action.stop')}</button><span className="save-indicator">{t(dirty ? 'saveHint.dirty' : !configured ? 'saveHint.unconfigured' : !runtime?.installed ? 'saveHint.missingRuntime' : 'saveHint.saved')}</span></div>
      </form>
      {result && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t(result)}</p>}
      <ErrorNotice failure={actionFailure} />
      {uncertain && <div className="dsh-unknown"><strong>{t(uncertainKeys[uncertain.operation])}</strong><p>{t('uncertain.description')}</p><button type="button" className="button button-secondary" disabled={reading || refreshFailure !== null || readSerial <= uncertain.afterRead} onClick={() => { setUncertain(null); setActionFailure(null); setResult('result.confirmed') }}>{t('uncertain.confirm')}</button></div>}
    </section>}
    {runtime && <dl className="dsh-details"><div><dt>{t('details.processing')}</dt><dd>{refreshFailure ? t('state.unconfirmed') : processing}</dd></div>{runtime.sessionId && <div><dt>{t('details.sessionId')}</dt><dd>{runtime.sessionId}</dd></div>}{runtime.version && <div><dt>{t('details.version')}</dt><dd>{runtime.version}</dd></div>}{runtime.lastOutcome && <div><dt>{t('details.outcome')}</dt><dd>{outcomeKey ? t(outcomeKey) : runtime.lastOutcome}</dd></div>}</dl>}
    {(saved?.dataDirectory || saved?.configurationPath) && <details className="dsh-file-details"><summary>{t('details.files')}</summary><dl className="dsh-details">{saved.dataDirectory && <div><dt>{t('details.dataDirectory')}</dt><dd>{saved.dataDirectory}</dd></div>}{saved.configurationPath && <div><dt>{t('details.configurationPath')}</dt><dd>{saved.configurationPath}</dd></div>}</dl></details>}
    <div className="dsh-notice dsh-boundary"><Info size={16} aria-hidden="true" /><p>{t('notice.authentication')}</p></div>
  </div>
}
