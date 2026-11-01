import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertCircle, Check, RefreshCw, Save } from 'lucide-react'
import { ActionButton, HostApiError, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { MemoryConfiguration } from '../types'
import { Activity, FailureMessage } from './activity'
import { Connection } from './connection'
import { connect, failure, fetchConfiguration, manage, updateConfiguration } from './data'
import type { UiFailure } from './data'
import { configurationInput, isDirty, makeDraft, validateDraft } from './draft'
import type { ConfigurationDraft, FieldIssues } from './draft'
import { fieldId, focusAndReveal, revealTarget } from './fields'
import type { MemoryTranslationKey } from './i18n'
import { Ranges } from './ranges'
import './i18n'
import './panel.css'

type Tab = 'connection' | 'ranges' | 'activity'
const tabs: readonly Tab[] = ['connection', 'ranges', 'activity']
const connectionFields = ['endpoint', 'user', 'account', 'timeoutMs']

export function MemoryPanel({ onFeedback, onRefresh }: PluginPanelProps) {
  const { t, formatNumber } = useI18n('openviking-memory')
  const prefix = useId()
  const [tab, setTab] = useState<Tab>('connection')
  const [config, setConfig] = useState<MemoryConfiguration | null>(null)
  const [draft, setDraft] = useState<ConfigurationDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'connect' | 'test' | null>(null)
  const [error, setError] = useState<UiFailure | null>(null)
  const [issues, setIssues] = useState<FieldIssues>({})
  const [submitted, setSubmitted] = useState(false)
  const [message, setMessage] = useState<MemoryTranslationKey | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [ruleQuery, setRuleQuery] = useState('')
  const [reset, setReset] = useState(0)
  const mounted = useRef(false), lock = useRef(false), dirtyRef = useRef(false), draftRef = useRef(draft)
  const configController = useRef<AbortController | null>(null), actionController = useRef<AbortController | null>(null)
  const configGeneration = useRef(0), actionGeneration = useRef(0)
  const errorRef = useRef<HTMLDivElement>(null), validationRef = useRef<HTMLDivElement>(null)
  const railStatus = useRef<HTMLDivElement>(null), discardConfirmRef = useRef<HTMLDivElement>(null)
  const panelRoot = useRef<HTMLDivElement>(null), saveRail = useRef<HTMLDivElement>(null)
  const focusFrame = useRef(0)
  const feedback = useRef(onFeedback), refresh = useRef(onRefresh)
  feedback.current = onFeedback; refresh.current = onRefresh; draftRef.current = draft
  const dirty = isDirty(draft, config)
  dirtyRef.current = dirty
  useLayoutEffect(() => {
    const root = panelRoot.current, rail = saveRail.current
    if (!root || !rail) return
    let frame = 0
    const measure = () => {
      const height = rail.hidden ? 0 : rail.getBoundingClientRect().height
      root.style.setProperty('--ov-save-rail-height', `${height}px`)
      const focused = document.activeElement
      if (focused instanceof HTMLElement && root.contains(focused) && !rail.contains(focused) && focused.closest('.ov-tab-panel')) {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (document.activeElement === focused) revealTarget(focused)
        })
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(rail); measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame.current) }
  }, [])
  function focusSaveStatus() {
    requestAnimationFrame(() => {
      if (railStatus.current?.getClientRects().length) railStatus.current.focus()
      else document.getElementById(`${prefix}-panel-activity`)?.focus()
    })
  }

  const load = useCallback(async (force = false, quiet = false) => {
    if (!mounted.current || document.hidden) return
    const ticket = ++configGeneration.current, controller = new AbortController()
    configController.current?.abort(); configController.current = controller
    if (!quiet) setLoading(true)
    try {
      const value = await fetchConfiguration(controller.signal)
      if (!mounted.current || controller.signal.aborted || ticket !== configGeneration.current) return
      // A read never advances the expected revision underneath a draft, including after a lost response.
      if (dirtyRef.current && !force) return
      setConfig(value); const next = makeDraft(value); setDraft(next); draftRef.current = next; dirtyRef.current = false
      setError(null); setIssues({}); setSubmitted(false); setConflict(false); setUncertain(false); setConfirmDiscard(false)
      if (force) { setReset(current => current + 1); setExpanded(null); setRuleQuery(''); setMessage(null); focusSaveStatus() }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === configGeneration.current) setError(failure(error, 'error.load'))
    } finally {
      if (configController.current === controller) configController.current = null
      if (mounted.current && ticket === configGeneration.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true; void load()
    const hide = () => {
      ++configGeneration.current; configController.current?.abort(); configController.current = null
      ++actionGeneration.current; actionController.current?.abort(); actionController.current = null
      if (lock.current) { setUncertain(true); setMessage('save.uncertain') }
      lock.current = false; setBusy(null); setLoading(false)
      if (draftRef.current?.apiKey) setMessage('save.secretCleared')
      setDraft(current => {
        if (!current) return current
        const next = { ...current, apiKey: '' }; draftRef.current = next; return next
      })
    }
    const visibility = () => { const next = !document.hidden; setVisible(next); if (!next) hide(); else void load(false, true) }
    const pagehide = () => { setVisible(false); hide() }
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide)
    return () => {
      mounted.current = false; ++configGeneration.current; ++actionGeneration.current
      configController.current?.abort(); actionController.current?.abort(); lock.current = false
      draftRef.current = null
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide)
    }
    // Locale and drafts are presentation state and never initiate requests.
  }, [load])

  function change<K extends keyof ConfigurationDraft>(key: K, value: ConfigurationDraft[K]) {
    if (lock.current) return
    setDraft(current => {
      if (!current) return current
      const next = { ...current, [key]: value, ...(key === 'clearApiKey' && value ? { apiKey: '' } : {}) }
      draftRef.current = next; dirtyRef.current = true; return next
    })
    setMessage(null)
    setIssues(current => Object.fromEntries(Object.entries(current).filter(([name]) => key === 'settings' ? !name.startsWith('rule-') : name !== key)))
  }
  function blur(name: string) {
    const current = draftRef.current
    if (!current) return
    const issue = validateDraft(current)[name]
    setIssues(previous => { const next = { ...previous }; if (issue) next[name] = issue; else delete next[name]; return next })
  }
  function selectTab(next: Tab) { setTab(next); setConfirmDiscard(false) }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    event.preventDefault(); const value = tabs[next]!; selectTab(value)
    document.getElementById(`${prefix}-tab-${value}`)?.focus()
  }
  function focusIssue(name: string) {
    setTab(connectionFields.includes(name) ? 'connection' : 'ranges')
    if (name.startsWith('rule-')) {
      const rule = draft?.settings.rules.find(rule => name.startsWith(`rule-${rule.id}-`))
      if (rule) { setExpanded(rule.id); setRuleQuery('') }
    }
    focusAndReveal(() => document.getElementById(fieldId(prefix, name)))
  }
  function requestDiscard() {
    if (dirty) { setConfirmDiscard(true); requestAnimationFrame(() => discardConfirmRef.current?.focus()) }
    else void load(true)
  }
  async function save(andConnect: boolean) {
    if (!config || !draft || lock.current || !dirty || conflict || uncertain) return
    const errors = validateDraft(draft); setIssues(errors); setSubmitted(true)
    if (Object.keys(errors).length) { focusAndReveal(() => validationRef.current); return }
    const input = configurationInput(draft, config.revision)
    const ticket = ++actionGeneration.current, controller = new AbortController(); actionController.current = controller
    lock.current = true; setBusy('save'); setError(null); setMessage(null); setConfirmDiscard(false)
    let saved = false
    try {
      const updated = await updateConfiguration(input, controller.signal)
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      saved = true
      const next = makeDraft(updated); setConfig(updated); setDraft(next); draftRef.current = next; dirtyRef.current = false
      setIssues({}); setSubmitted(false); setReset(value => value + 1); setMessage('save.saved')
      if (andConnect) {
        setBusy('connect'); await connect(controller.signal)
        if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
        setMessage('save.savedConnected')
        await load(false, true)
      }
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      feedback.current(t(andConnect ? 'save.savedConnected' : 'save.saved'))
      focusSaveStatus()
      void refresh.current?.().catch(() => { /* Saved configuration is authoritative; a workspace refresh can be retried separately. */ })
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      const value = failure(error)
      if (saved) { await load(false, true); setMessage('save.partial') }
      if (error instanceof HostApiError && error.outcome === 'unknown') { await load(false, true); setUncertain(true); setMessage('save.uncertain') }
      setError(value)
      if (value.key === 'error.conflict') setConflict(true)
      focusAndReveal(() => errorRef.current)
    } finally {
      if (actionController.current === controller) { actionController.current = null; lock.current = false; if (mounted.current) setBusy(null) }
    }
  }
  async function check(mode: 'connect' | 'test') {
    if (!config || !draft || dirty || lock.current || conflict || uncertain || !config.endpoint || !config.user) return
    const ticket = ++actionGeneration.current, controller = new AbortController(); actionController.current = controller
    lock.current = true; setBusy(mode); setError(null); setMessage(null)
    try {
      if (mode === 'connect') await connect(controller.signal)
      else {
        const value = await manage('test-connection', {}, controller.signal)
        if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) throw new HostApiError('INVALID_HOST_RESPONSE', '')
      }
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      setMessage(mode === 'connect' ? 'connection.connected' : 'connection.testOk')
      await load(false, true)
      void refresh.current?.().catch(() => {})
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      if (error instanceof HostApiError && error.outcome === 'unknown') { await load(false, true); setUncertain(true); setMessage('save.uncertain') }
      setError(failure(error))
      focusAndReveal(() => errorRef.current)
    } finally {
      if (actionController.current === controller) { actionController.current = null; lock.current = false; if (mounted.current) setBusy(null) }
    }
  }
  const locked = busy !== null || loading
  const reason = t(busy ? 'reason.busy' : conflict ? 'reason.conflict' : uncertain ? 'reason.uncertain' : dirty ? 'reason.draft' : !config?.settings.enabled ? 'reason.enable' : 'reason.configure')
  const canConnect = Boolean(config?.endpoint && config.user && config.settings.enabled && !locked && !dirty && !conflict && !uncertain)
  const saveDisabled = locked || !dirty || conflict || uncertain
  const saveReason = t(locked ? 'reason.busy' : conflict ? 'reason.conflict' : uncertain ? 'reason.uncertain' : 'reason.unchanged')
  const showSaveRail = tab !== 'activity' || dirty || busy !== null || conflict || uncertain || confirmDiscard
  return <div className="ov-panel" ref={panelRoot} onFocusCapture={event => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.matches('input, select, textarea') || target.closest('.ov-save-rail')) return
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => { if (document.activeElement === target) revealTarget(target) })
  }}>
    <div className="ov-tabs workspace-rail" role="tablist" aria-label={t('tabs.label')}>{tabs.map((value, index) => <button key={value} type="button" role="tab" id={`${prefix}-tab-${value}`} aria-selected={tab === value} aria-controls={`${prefix}-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => selectTab(value)} onKeyDown={event => tabKey(event, index)}>{t(`tabs.${value}`)}</button>)}</div>
    {error && <div className="ov-notice" role="alert" tabIndex={-1} ref={errorRef}><AlertCircle size={18} aria-hidden="true" /><div><FailureMessage value={error} /></div><ActionButton className="text-button" disabled={locked} reason={t('reason.busy')} onClick={requestDiscard}><RefreshCw size={15} aria-hidden="true" />{t('common.retry')}</ActionButton></div>}
    {submitted && Object.keys(issues).length > 0 && <div className="ov-notice ov-validation" role="alert" tabIndex={-1} ref={validationRef}><strong>{t('validation.summary')}</strong><ul>{Object.entries(issues).map(([name, issue]) => <li key={name}><button type="button" className="text-button" onClick={() => focusIssue(name)}>{t(issue.key, { min: issue.min === undefined ? '' : formatNumber(issue.min), max: issue.max === undefined ? '' : formatNumber(issue.max) })}</button></li>)}</ul></div>}
    {loading && !config && <p className="ov-empty" role="status">{t('common.loading')}</p>}
    {config && draft && <>
      <div id={`${prefix}-panel-connection`} role="tabpanel" aria-labelledby={`${prefix}-tab-connection`} hidden={tab !== 'connection'} tabIndex={0} className="ov-tab-panel"><Connection prefix={prefix} config={config} draft={draft} errors={issues} locked={locked} canConnect={canConnect} actionReason={reason} checking={busy === 'connect' || busy === 'test'} onChange={change} onBlur={blur} onConnect={() => void check('connect')} onTest={() => void check('test')} /></div>
      <div id={`${prefix}-panel-ranges`} role="tabpanel" aria-labelledby={`${prefix}-tab-ranges`} hidden={tab !== 'ranges'} tabIndex={0} className="ov-tab-panel"><Ranges key={reset} prefix={prefix} draft={draft} errors={issues} locked={locked} expanded={expanded} setExpanded={setExpanded} query={ruleQuery} setQuery={setRuleQuery} onChange={value => change('settings', value)} onBlur={blur} /></div>
      <div id={`${prefix}-panel-activity`} role="tabpanel" aria-labelledby={`${prefix}-tab-activity`} hidden={tab !== 'activity'} tabIndex={0} className="ov-tab-panel"><Activity prefix={prefix} active={tab === 'activity'} visible={visible} blocked={locked || conflict || uncertain} blockedReason={reason} configurationRevision={config.revision} /></div>
    </>}
    <div className="ov-save-rail" ref={saveRail} hidden={!showSaveRail}>
      <div className="ov-save-state" ref={railStatus} tabIndex={-1} role="status" aria-live="polite"><strong>{!dirty && config ? <Check size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}{t(dirty ? 'save.dirty' : config ? 'save.clean' : 'save.initial')}</strong><p>{message ? t(message) : t('save.note')}</p>{uncertain && message !== 'save.uncertain' && <p>{t('save.uncertain')}</p>}</div>
      <div className="ov-actions"><ActionButton className="text-button" disabled={locked || (!dirty && !uncertain && !conflict)} reason={saveReason} onClick={requestDiscard}>{t(uncertain || conflict ? 'common.retry' : 'save.discard')}</ActionButton>
        <ActionButton className="button button-secondary" disabled={saveDisabled || !config} reason={saveReason} onClick={() => void save(false)}>{t(busy === 'save' ? 'save.saving' : 'save.button')}</ActionButton>
        <ActionButton className="button button-primary" disabled={saveDisabled || !config || !draft?.settings.enabled} reason={draft?.settings.enabled ? saveReason : t('reason.enable')} onClick={() => void save(true)}>{t('save.connect')}</ActionButton></div>
      {confirmDiscard && <div className="ov-confirm" ref={discardConfirmRef} tabIndex={-1} role="group" aria-label={t('save.discardTitle')}><strong>{t('save.discardTitle')}</strong><p>{t('save.discardText')}</p><div className="ov-actions"><ActionButton className="button button-secondary" disabled={locked} reason={t('reason.busy')} onClick={() => { setConfirmDiscard(false); focusSaveStatus() }}>{t('save.keep')}</ActionButton><ActionButton className="button button-danger" disabled={locked} reason={t('reason.busy')} onClick={() => void load(true)}>{t('save.discardConfirm')}</ActionButton></div></div>}
    </div>
  </div>
}
