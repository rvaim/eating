import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { ActionButton, FormSaveBar, HostApiError, InlineConfirm, SegmentedTabs, Switch, UnknownOutcomeCard, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { MemoryConfiguration, ScopeSummary } from '../types'
import { Activity, FailureMessage } from './activity'
import { Browse } from './browse'
import { Connection } from './connection'
import { connect, failure, fetchConfiguration, manage, updateConfiguration } from './data'
import type { UiFailure } from './data'
import { configurationInput, isConnectionDirty, isDirty, isRangesDirty, makeDraft, validateDraft } from './draft'
import type { ConfigurationDraft, FieldIssues, SettingsDraft } from './draft'
import { fieldId, revealTarget } from './fields'
import type { MemoryTranslationKey } from './i18n'
import { Ranges } from './ranges'
import './i18n'
import './panel.css'

type Tab = 'connection' | 'ranges' | 'activity' | 'browse'
const connectionFields = ['endpoint', 'user', 'account', 'timeoutMs']

export function MemoryPanel({ onFeedback, onRefresh, onDirtyChange }: PluginPanelProps) {
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
  const [secretClearedOnHide, setSecretClearedOnHide] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [ruleQuery, setRuleQuery] = useState('')
  const [peer, setPeer] = useState('')
  const [scopes, setScopes] = useState<readonly ScopeSummary[]>([])
  const [reset, setReset] = useState(0)
  const [focusRequest, setFocusRequest] = useState<{
    id: number
    target: 'error' | 'validation' | 'saveStatus' | 'discardConfirm' | { field: string }
  } | null>(null)

  const mounted = useRef(false)
  const lock = useRef(false)
  const dirtyRef = useRef(false)
  const configRef = useRef(config)
  const draftRef = useRef(draft)
  const configController = useRef<AbortController | null>(null)
  const actionController = useRef<AbortController | null>(null)
  const configGeneration = useRef(0)
  const actionGeneration = useRef(0)
  const errorRef = useRef<HTMLDivElement>(null)
  const validationRef = useRef<HTMLDivElement>(null)
  const saveFocusRef = useRef<HTMLDivElement>(null)
  const discardConfirmBtnRef = useRef<HTMLButtonElement>(null)
  const panelRoot = useRef<HTMLDivElement>(null)
  const saveRail = useRef<HTMLDivElement>(null)
  const focusFrame = useRef(0)
  const focusSeq = useRef(0)
  const handledFocusSeq = useRef(0)
  const callbacks = useRef({ onFeedback, onRefresh, onDirtyChange })

  callbacks.current = { onFeedback, onRefresh, onDirtyChange }
  configRef.current = config
  draftRef.current = draft

  const connectionDirty = isConnectionDirty(draft, config)
  const rangesDirty = isRangesDirty(draft, config)
  const dirty = connectionDirty || rangesDirty
  dirtyRef.current = dirty

  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  useLayoutEffect(() => {
    const root = panelRoot.current
    const rail = saveRail.current
    if (!root || !rail) return
    let frame = 0
    const measure = () => {
      const sticky = !rail.hidden && rail.classList.contains('is-sticky')
      const height = sticky ? rail.getBoundingClientRect().height : 0
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
    observer.observe(rail)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      cancelAnimationFrame(focusFrame.current)
    }
  }, [dirty, conflict, uncertain, confirmDiscard, tab, busy, message])

  const tabRef = useRef(tab)
  tabRef.current = tab

  const queueFocus = useCallback((target: 'error' | 'validation' | 'saveStatus' | 'discardConfirm' | { field: string }) => {
    setFocusRequest({ id: ++focusSeq.current, target })
  }, [])

  const focusSaveStatus = useCallback(() => {
    queueFocus('saveStatus')
  }, [queueFocus])

  useEffect(() => {
    if (!focusRequest || focusRequest.id === handledFocusSeq.current) return
    handledFocusSeq.current = focusRequest.id
    const req = focusRequest.target
    const target =
      req === 'error'
        ? errorRef.current
        : req === 'validation'
          ? validationRef.current
          : req === 'discardConfirm'
            ? discardConfirmBtnRef.current
            : req === 'saveStatus'
              ? saveFocusRef.current?.getClientRects().length
                ? saveFocusRef.current
                : document.getElementById(`${prefix}-panel-${tabRef.current}`)
              : document.getElementById(fieldId(prefix, req.field))
    if (!target?.isConnected || !target.getClientRects().length) return
    if (req === 'saveStatus' || req === 'discardConfirm') {
      target.focus()
      return
    }
    target.focus({ preventScroll: true })
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === target) revealTarget(target, 'center')
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRequest, prefix])

  const load = useCallback(async (force = false, quiet = false) => {
    if (!mounted.current || document.hidden) return
    const ticket = ++configGeneration.current
    const controller = new AbortController()
    configController.current?.abort()
    configController.current = controller
    if (!quiet) setLoading(true)
    try {
      const value = await fetchConfiguration(controller.signal)
      if (!mounted.current || controller.signal.aborted || ticket !== configGeneration.current) return
      // A read never advances the expected revision underneath a draft, including after a lost response.
      if (dirtyRef.current && !force) return
      setConfig(value)
      configRef.current = value
      const next = makeDraft(value)
      setDraft(next)
      draftRef.current = next
      dirtyRef.current = false
      setError(null)
      setIssues({})
      setSubmitted(false)
      setConflict(false)
      setUncertain(false)
      setConfirmDiscard(false)
      if (force) {
        setReset(current => current + 1)
        setExpanded(null)
        setRuleQuery('')
        setMessage(null)
        setSecretClearedOnHide(false)
        focusSaveStatus()
      }
    } catch (err) {
      if (mounted.current && !controller.signal.aborted && ticket === configGeneration.current) {
        setError(failure(err, 'error.load'))
      }
    } finally {
      if (configController.current === controller) configController.current = null
      if (mounted.current && ticket === configGeneration.current) setLoading(false)
    }
  }, [focusSaveStatus])

  useEffect(() => {
    mounted.current = true
    void load()
    let resumeRead = false
    const hide = () => {
      resumeRead ||= Boolean(configController.current)
      ++configGeneration.current
      configController.current?.abort()
      configController.current = null
      ++actionGeneration.current
      actionController.current?.abort()
      actionController.current = null
      if (lock.current) {
        setUncertain(true)
        setMessage('save.uncertain')
      }
      lock.current = false
      setBusy(null)
      setLoading(false)
      if (draftRef.current?.apiKey) {
        setMessage('save.secretCleared')
        setSecretClearedOnHide(true)
      }
      setDraft(current => {
        if (!current) return current
        const next = { ...current, apiKey: '' }
        draftRef.current = next
        dirtyRef.current = isDirty(next, configRef.current)
        return next
      })
    }
    const visibility = () => {
      const next = !document.hidden
      setVisible(next)
      if (!next) hide()
      else if (resumeRead || !configRef.current) {
        resumeRead = false
        void load(false, Boolean(configRef.current))
      }
    }
    const pagehide = () => {
      setVisible(false)
      hide()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('pageshow', visibility)
    return () => {
      mounted.current = false
      ++configGeneration.current
      ++actionGeneration.current
      configController.current?.abort()
      actionController.current?.abort()
      lock.current = false
      draftRef.current = null
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('pageshow', visibility)
    }
    // Locale and drafts are presentation state and never initiate requests.
  }, [load])

  function change<K extends keyof ConfigurationDraft>(key: K, value: ConfigurationDraft[K]) {
    if (lock.current) return
    if (key === 'apiKey' && typeof value === 'string' && value) setSecretClearedOnHide(false)
    setDraft(current => {
      if (!current) return current
      const next = { ...current, [key]: value, ...(key === 'clearApiKey' && value ? { apiKey: '' } : {}) }
      draftRef.current = next
      dirtyRef.current = isDirty(next, configRef.current)
      return next
    })
    setMessage(null)
    setIssues(current =>
      Object.fromEntries(Object.entries(current).filter(([name]) => (key === 'settings' ? !name.startsWith('rule-') : name !== key))),
    )
  }

  function changeSettingsKey<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    if (!draftRef.current || lock.current) return
    change('settings', { ...draftRef.current.settings, [key]: value })
  }

  function blur(name: string) {
    const current = draftRef.current
    if (!current) return
    const issue = validateDraft(current)[name]
    setIssues(previous => {
      const next = { ...previous }
      if (issue) next[name] = issue
      else delete next[name]
      return next
    })
  }

  function selectTab(next: Tab) {
    setTab(next)
    setConfirmDiscard(false)
  }

  function focusIssue(name: string) {
    setTab(connectionFields.includes(name) ? 'connection' : 'ranges')
    if (name.startsWith('rule-')) {
      const rule = draft?.settings.rules.find(entry => name.startsWith(`rule-${entry.id}-`))
      if (rule) {
        setExpanded(rule.id)
        setRuleQuery('')
      }
    }
    queueFocus({ field: name })
  }

  function requestDiscard() {
    if (dirtyRef.current) {
      setConfirmDiscard(true)
      queueFocus('discardConfirm')
    } else {
      void load(true)
    }
  }

  async function save(andConnect: boolean, overrideDraft?: ConfigurationDraft) {
    const activeDraft = overrideDraft ?? draftRef.current
    if (!config || !activeDraft || lock.current || conflict || uncertain) return
    if (!overrideDraft && !isDirty(activeDraft, config)) return
    const errors = validateDraft(activeDraft)
    setIssues(errors)
    setSubmitted(true)
    if (Object.keys(errors).length) {
      queueFocus('validation')
      return
    }
    const input = configurationInput(activeDraft, config.revision)
    const ticket = ++actionGeneration.current
    const controller = new AbortController()
    actionController.current = controller
    lock.current = true
    setBusy('save')
    setError(null)
    setMessage(null)
    setConfirmDiscard(false)
    let saved = false
    try {
      const updated = await updateConfiguration(input, controller.signal)
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      saved = true
      const next = makeDraft(updated)
      setConfig(updated)
      configRef.current = updated
      setDraft(next)
      draftRef.current = next
      dirtyRef.current = false
      setIssues({})
      setSubmitted(false)
      setSecretClearedOnHide(false)
      setReset(value => value + 1)
      setMessage('save.saved')
      if (andConnect) {
        setBusy('connect')
        await connect(controller.signal)
        if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
        setMessage('save.savedConnected')
        await load(false, true)
      }
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      callbacks.current.onFeedback(t(andConnect ? 'save.savedConnected' : 'save.saved'))
      focusSaveStatus()
      void callbacks.current.onRefresh?.().catch(() => {
        /* Saved configuration is authoritative; a workspace refresh can be retried separately. */
      })
    } catch (err) {
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      const value = failure(err)
      if (saved) {
        await load(false, true)
        setMessage('save.partial')
      }
      if (err instanceof HostApiError && err.outcome === 'unknown') {
        await load(false, true)
        setUncertain(true)
        setMessage('save.uncertain')
      }
      setError(value)
      if (value.key === 'error.conflict') setConflict(true)
      queueFocus('error')
    } finally {
      if (actionController.current === controller) {
        actionController.current = null
        lock.current = false
        if (mounted.current) setBusy(null)
      }
    }
  }

  function enableMemoryNow() {
    if (lock.current || !config || !draft || conflict || uncertain) return
    const nextDraft: ConfigurationDraft = {
      ...draft,
      settings: { ...draft.settings, enabled: true },
    }
    if (!config.settings.enabled && !isDirty(draft, config) && Object.keys(validateDraft(nextDraft)).length === 0) {
      setDraft(nextDraft)
      draftRef.current = nextDraft
      dirtyRef.current = true
      void save(false, nextDraft)
      return
    }
    changeSettingsKey('enabled', true)
  }

  async function check(mode: 'connect' | 'test') {
    if (!config || !draft || dirty || lock.current || conflict || uncertain || !config.endpoint || !config.user) return
    const ticket = ++actionGeneration.current
    const controller = new AbortController()
    actionController.current = controller
    lock.current = true
    setBusy(mode)
    setError(null)
    setMessage(null)
    try {
      if (mode === 'connect') await connect(controller.signal)
      else {
        const value = await manage('test-connection', {}, controller.signal)
        if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) throw new HostApiError('INVALID_HOST_RESPONSE', '')
      }
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      setMessage(mode === 'connect' ? 'connection.connected' : 'connection.testOk')
      await load(false, true)
      void callbacks.current.onRefresh?.().catch(() => {})
    } catch (err) {
      if (!mounted.current || controller.signal.aborted || ticket !== actionGeneration.current) return
      if (err instanceof HostApiError && err.outcome === 'unknown') {
        await load(false, true)
        setUncertain(true)
        setMessage('save.uncertain')
      }
      setError(failure(err))
      queueFocus('error')
    } finally {
      if (actionController.current === controller) {
        actionController.current = null
        lock.current = false
        if (mounted.current) setBusy(null)
      }
    }
  }

  const locked = busy !== null || loading
  const reason = t(
    busy
      ? 'reason.busy'
      : conflict
        ? 'reason.conflict'
        : uncertain
          ? 'reason.uncertain'
          : dirty
            ? 'reason.draft'
            : !config?.settings.enabled
              ? 'reason.enable'
              : 'reason.configure',
  )
  const canConnect = Boolean(config?.endpoint && config.user && config.settings.enabled && !locked && !dirty && !conflict && !uncertain)
  const saveDisabled = locked || !dirty || conflict || uncertain
  const saveReason = t(locked ? 'reason.busy' : conflict ? 'reason.conflict' : uncertain ? 'reason.uncertain' : 'reason.unchanged')
  const stickyRail = dirty || conflict || uncertain || confirmDiscard
  const showSaveRail = stickyRail || busy !== null || tab === 'connection' || tab === 'ranges' || message === 'save.secretCleared'
  const masterSwitchChanged = Boolean(config && draft && config.settings.enabled !== draft.settings.enabled)

  return (
    <div
      className="ov-panel"
      ref={panelRoot}
      onFocusCapture={event => {
        const target = event.target
        if (!(target instanceof HTMLElement) || !target.matches('input, select, textarea') || target.closest('.ov-save-rail')) return
        cancelAnimationFrame(focusFrame.current)
        focusFrame.current = requestAnimationFrame(() => {
          if (document.activeElement === target) revealTarget(target)
        })
      }}>
      {config && draft && (
        <div className={`ov-master-banner${!draft.settings.enabled ? ' is-off' : ''}`}>
          <Switch
            id={fieldId(prefix, 'enabled')}
            checked={draft.settings.enabled}
            disabled={locked || conflict || uncertain}
            disabledReason={locked ? t('reason.busy') : conflict ? t('reason.conflict') : uncertain ? t('reason.uncertain') : undefined}
            label={t('ranges.enabled')}
            description={t('ranges.enabledHint')}
            onChange={value => changeSettingsKey('enabled', value)}
          />
          {masterSwitchChanged && (
            <span className="ov-master-pending" role="status">
              {t('banner.saveToApply')}
            </span>
          )}
        </div>
      )}

      <SegmentedTabs
        idPrefix={prefix}
        sticky
        className="ov-tabs"
        ariaLabel={t('tabs.label')}
        activeTab={tab}
        onSelect={selectTab}
        tabs={[
          { id: 'connection', label: t('tabs.connection'), dirty: connectionDirty },
          { id: 'ranges', label: t('tabs.ranges'), dirty: rangesDirty },
          { id: 'activity', label: t('tabs.activity') },
          { id: 'browse', label: t('tabs.browse') },
        ]}
      />

      {error && (
        <div className="ov-notice" role="alert" tabIndex={-1} ref={errorRef}>
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <FailureMessage value={error} />
          </div>
          <ActionButton className="text-button" disabled={locked} reason={t('reason.busy')} onClick={requestDiscard}>
            <RefreshCw size={15} aria-hidden="true" />
            {t('common.retry')}
          </ActionButton>
        </div>
      )}

      {uncertain && (
        <UnknownOutcomeCard
          title={t('save.uncertainTitle')}
          body={t('save.uncertain')}
          refreshing={loading}
          onRefresh={requestDiscard}
          onConfirmReviewed={requestDiscard}
        />
      )}

      {submitted && Object.keys(issues).length > 0 && (
        <div className="ov-notice ov-validation" role="alert" tabIndex={-1} ref={validationRef}>
          <strong>{t('validation.summary')}</strong>
          <ul>
            {Object.entries(issues).map(([name, issue]) => (
              <li key={name}>
                <button type="button" className="text-button" onClick={() => focusIssue(name)}>
                  {t(issue.key, {
                    min: issue.min === undefined ? '' : formatNumber(issue.min),
                    max: issue.max === undefined ? '' : formatNumber(issue.max),
                  })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && !config && (
        <p className="ov-empty" role="status">
          {t('common.loading')}
        </p>
      )}

      {config && draft && (
        <>
          <div id={`${prefix}-panel-connection`} role="tabpanel" aria-labelledby={`${prefix}-tab-connection`} hidden={tab !== 'connection'} tabIndex={0} className="ov-tab-panel">
            <Connection
              prefix={prefix}
              config={config}
              draft={draft}
              errors={issues}
              locked={locked}
              canConnect={canConnect}
              actionReason={reason}
              checking={busy === 'connect' || busy === 'test'}
              secretClearedOnHide={secretClearedOnHide}
              onChange={change}
              onBlur={blur}
              onConnect={() => void check('connect')}
              onTest={() => void check('test')}
              onEnableNow={enableMemoryNow}
            />
          </div>
          <div id={`${prefix}-panel-ranges`} role="tabpanel" aria-labelledby={`${prefix}-tab-ranges`} hidden={tab !== 'ranges'} tabIndex={0} className="ov-tab-panel">
            <Ranges
              key={reset}
              prefix={prefix}
              draft={draft}
              errors={issues}
              locked={locked}
              expanded={expanded}
              setExpanded={setExpanded}
              query={ruleQuery}
              setQuery={setRuleQuery}
              onChange={value => change('settings', value)}
              onBlur={blur}
            />
          </div>
          <div id={`${prefix}-panel-activity`} role="tabpanel" aria-labelledby={`${prefix}-tab-activity`} hidden={tab !== 'activity'} tabIndex={0} className="ov-tab-panel">
            <Activity
              prefix={prefix}
              active={tab === 'activity'}
              visible={visible}
              blocked={locked || conflict || uncertain || !config.settings.enabled}
              blockedReason={reason}
              configurationRevision={config.revision}
              peer={peer}
              onPeerChange={setPeer}
              onScopesChange={setScopes}
              memoryDisabled={!config.settings.enabled || !draft.settings.enabled}
              configEnabled={config.settings.enabled}
              onEnableNow={enableMemoryNow}
            />
          </div>
          <div id={`${prefix}-panel-browse`} role="tabpanel" aria-labelledby={`${prefix}-tab-browse`} hidden={tab !== 'browse'} tabIndex={0} className="ov-tab-panel">
            <Browse
              prefix={prefix}
              active={tab === 'browse'}
              visible={visible}
              blocked={locked || conflict || uncertain}
              blockedReason={reason}
              configurationRevision={config.revision}
              peer={peer}
              onPeerChange={setPeer}
              scopes={scopes}
              rules={draft.settings.rules}
              user={draft.user}
            />
          </div>
        </>
      )}

      <div className={`ov-save-rail${stickyRail ? ' is-sticky' : ''}`} ref={saveRail} hidden={!showSaveRail}>
        <div className="ov-save-focus" ref={saveFocusRef} tabIndex={-1} aria-live="polite">
          <FormSaveBar
            dirty={dirty}
            saving={busy === 'save' || busy === 'connect'}
            disabled={saveDisabled || !config}
            disabledReason={saveReason}
            conflict={conflict}
            uncertain={uncertain}
            alwaysVisible={tab === 'connection' || tab === 'ranges' || dirty || conflict || uncertain}
            saveLabel={busy === 'save' ? t('save.saving') : t('save.button')}
            discardLabel={uncertain || conflict ? t('common.retry') : t('save.discard')}
            reloadLabel={t('common.retry')}
            notice={message ? t(message) : null}
            onSave={() => void save(false)}
            onDiscard={conflict ? undefined : requestDiscard}
            onReload={requestDiscard}
            extraActions={
              <ActionButton
                className="button button-secondary ov-save-connect-btn"
                disabled={saveDisabled || !config || !draft?.settings.enabled}
                reason={draft?.settings.enabled ? saveReason : t('reason.enable')}
                onClick={() => void save(true)}>
                {t('save.connect')}
              </ActionButton>
            }
          />
        </div>
        <InlineConfirm
          open={confirmDiscard}
          variant="danger"
          title={t('save.discardTitle')}
          description={t('save.discardText')}
          confirmLabel={t('save.discardConfirm')}
          cancelLabel={t('save.keep')}
          busy={locked}
          confirmButtonRef={discardConfirmBtnRef}
          onConfirm={() => void load(true)}
          onCancel={() => {
            setConfirmDiscard(false)
            focusSaveStatus()
          }}
        />
      </div>
    </div>
  )
}
