import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertCircle, ArrowRight, Check, ChevronDown, Clock3, Pause, Play, RefreshCw, Settings2 } from 'lucide-react'
import type { JsonObject } from '@eating/plugin-sdk'
import { ActionButton, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { AutonomyContacts } from './AutonomyContacts'
import { fields, makeDraft, readDirectory } from './autonomy-data'
import type { Directory, Draft, NumericKey, Snapshot } from './autonomy-data'
import '../i18n/autonomy'
import './AutonomySettings.css'

type Tab = 'status' | 'configuration' | 'contacts'
type Failure = { key: string; code?: string; kind: 'read' | 'mutation' }
const primaryFields: readonly NumericKey[] = ['minIntervalSeconds', 'maxRestMinutes', 'maxCyclesPerHour']
const advancedFields: readonly NumericKey[] = ['maxRunMinutes', 'cycleTimeoutSeconds', 'maxConsecutiveFailures', 'maxContactsPerHour']
const fieldId = (name: NumericKey) => `autonomy-field-${name}`
const tabs: readonly Tab[] = ['status', 'configuration', 'contacts']
const sameDraft = (draft: Draft, saved: Snapshot['configuration']) => draft.enabled === saved.enabled && draft.autoResume === saved.autoResume && fields.every(field => draft[field.name] === String(saved[field.name])) && JSON.stringify(draft.targets) === JSON.stringify(saved.targets)

export function AutonomySettings({ active }: { readonly active: boolean }) {
  const { t, formatNumber, formatDateTime } = useI18n('autonomy')
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [selected, setSelected] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const dirty = useRef(new Set<string>()), revisions = useRef<Record<string, number>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mustRead, setMustRead] = useState(false)
  const [contactsDirty, setContactsDirty] = useState(false)
  const [lastReadAt, setLastReadAt] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('status')
  const [advanced, setAdvanced] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [validationSubmitted, setValidationSubmitted] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const alive = useRef(false), generation = useRef(0), request = useRef<AbortController | null>(null), mutation = useRef(false), activeRef = useRef(active)
  const errorSummary = useRef<HTMLDivElement | null>(null), saveButton = useRef<HTMLButtonElement | null>(null)
  const surface = useRef<HTMLElement | null>(null)
  activeRef.current = active

  const read = useCallback(async (manual = false) => {
    if (!activeRef.current || document.hidden || request.current) return
    const controller = new AbortController(), ticket = ++generation.current
    request.current = controller
    if (manual) setPending('read')
    try {
      const data = readDirectory(await hostRequest<unknown>('/autonomy', { signal: controller.signal }))
      if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
      setDirectory(data)
      setSelected(current => data.harnesses.some(row => row.id === current) ? current : data.harnesses.find(row => row.supported)?.id || data.harnesses[0]?.id || '')
      setDrafts(previous => {
        const next = { ...previous }
        for (const harness of data.harnesses) if (harness.snapshot && !dirty.current.has(harness.id)) { next[harness.id] = makeDraft(harness.snapshot.configuration); revisions.current[harness.id] = harness.snapshot.revision }
        return next
      })
      setLastReadAt(Date.now())
      setFailure(current => manual || current?.kind === 'read' ? null : current)
      if (manual) setMustRead(false)
    } catch (error) {
      if (alive.current && !controller.signal.aborted && ticket === generation.current) setFailure(current => current?.kind === 'mutation' ? current : { key: 'error.read', kind: 'read', code: error instanceof HostApiError ? error.code : undefined })
    } finally {
      if (request.current === controller) { request.current = null; if (alive.current && manual) setPending(null) }
    }
  }, [])

  useEffect(() => {
    alive.current = true
    const hidden = () => {
      setVisible(!document.hidden)
      if (document.hidden) {
        ++generation.current; request.current?.abort(); request.current = null
        if (mutation.current) { setMustRead(true); setFailure({ key: 'error.unknown', kind: 'mutation' }) }
        mutation.current = false; setPending(null)
      }
    }
    document.addEventListener('visibilitychange', hidden)
    return () => { alive.current = false; ++generation.current; request.current?.abort(); request.current = null; document.removeEventListener('visibilitychange', hidden) }
  }, [])
  useEffect(() => {
    if (!active || !visible) {
      if (request.current) {
        ++generation.current; request.current.abort(); request.current = null
        if (mutation.current) { setMustRead(true); setFailure({ key: 'error.unknown', kind: 'mutation' }) }
        mutation.current = false; setPending(null)
      }
      return
    }
    void read(true)
    const timer = setInterval(() => { void read() }, 5000)
    return () => clearInterval(timer)
  }, [active, visible, read])

  useEffect(() => {
    const root = surface.current
    if (!root) return
    let frame = 0
    const keepFocusVisible = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement
        if (!activeRef.current || document.hidden || !(focused instanceof HTMLElement) || !root.contains(focused) || focused.closest('.autonomy-tabs, .autonomy-save')) return
        const scroll = root.closest<HTMLElement>('.settings-content')
        if (!scroll) return
        const main = scroll.getBoundingClientRect(), box = focused.getBoundingClientRect(), rail = root.querySelector('.autonomy-tabs')?.getBoundingClientRect(), footer = root.querySelector('.autonomy-save')?.getBoundingClientRect()
        const top = Math.max(main.top + 12, rail ? rail.bottom + 12 : main.top + 12), bottom = Math.min(main.bottom - 12, footer && footer.top < main.bottom ? footer.top - 12 : main.bottom - 12)
        if (box.top < top) scroll.scrollBy({ top: box.top - top, behavior: 'instant' })
        else if (box.bottom > bottom) scroll.scrollBy({ top: box.bottom - bottom, behavior: 'instant' })
      })
    }
    root.addEventListener('focusin', keepFocusVisible)
    window.addEventListener('resize', keepFocusVisible)
    const observer = new ResizeObserver(keepFocusVisible)
    observer.observe(root)
    return () => { cancelAnimationFrame(frame); root.removeEventListener('focusin', keepFocusVisible); window.removeEventListener('resize', keepFocusVisible); observer.disconnect() }
  }, [])

  const harness = directory?.harnesses.find(row => row.id === selected), snapshot = harness?.snapshot, draft = drafts[selected], state = snapshot?.state
  const agenda = snapshot?.agenda, scheduledTasks = agenda?.tasks ?? []
  const isDirty = dirty.current.has(selected), isMutating = pending !== null && pending !== 'read'
  const versionChanged = Boolean(snapshot && isDirty && revisions.current[selected] !== snapshot.revision)
  const blocked = isMutating || !harness?.enabled || !snapshot || mustRead
  const disabledReason = isMutating ? t('why.busy') : !harness?.enabled ? t('why.plugin') : !snapshot ? t('why.read') : mustRead ? t('why.review') : ''
  const errorIds = Object.keys(errors)
  const time = (value: number | null | undefined) => value == null ? t('none') : formatDateTime(value)
  const statusText = (value: string) => ['disabled', 'status-unavailable', 'pausing', 'owner-paused', 'runtime-stopped', 'run-limit', 'error', 'running', 'waiting-event', 'sleeping', 'hourly-limit', 'interval', 'ready', 'busy', 'external-pending', 'native-goal'].includes(value) ? t(`reason.${value}`) : t('reason.unknown')
  const arrangement = state && state.mode === 'active' && state.lastStartedAt === null && !state.note ? t('mode.initial') : state ? t(`mode.${state.mode}`) : t('none')
  const outcomeText = (value: string | null) => value && ['completed', 'failed', 'unknown', 'cancelled', 'pending', 'reviewed'].includes(value) ? t(`outcome.${value}`) : t('none')

  function navigateTab(next: Tab, focusId?: string) {
    setTab(next)
    requestAnimationFrame(() => {
      if (focusId) document.getElementById(focusId)?.focus()
      else document.getElementById(`autonomy-panel-${next}`)?.scrollIntoView({ block: 'start', behavior: 'instant' })
    })
  }
  function update(change: Partial<Draft>) {
    if (!draft || !snapshot) return
    const next = { ...draft, ...change }
    if (sameDraft(next, snapshot.configuration)) dirty.current.delete(selected)
    else dirty.current.add(selected)
    setDrafts(current => ({ ...current, [selected]: next })); setNotice(null)
  }
  function numberIssue(name: NumericKey) {
    if (!draft) return null
    const field = fields.find(field => field.name === name)!
    if (!/^\d+$/.test(draft[name]) || Number(draft[name]) < field.min || Number(draft[name]) > field.max) return 'validation.number'
    if (name === 'maxRestMinutes' && /^\d+$/.test(draft.minIntervalSeconds) && Number(draft.minIntervalSeconds) > Number(draft.maxRestMinutes) * 60) return 'validation.restInterval'
    return null
  }
  function validateNumber(name: NumericKey) {
    const names: readonly NumericKey[] = name === 'minIntervalSeconds' || name === 'maxRestMinutes' ? ['minIntervalSeconds', 'maxRestMinutes'] : [name]
    setErrors(previous => {
      const next = { ...previous }
      for (const field of names) { const id = fieldId(field), issue = numberIssue(field); if (issue) next[id] = issue; else delete next[id] }
      return next
    })
  }
  function revealError(id: string) {
    if (id.startsWith('autonomy-field-')) {
      setTab('configuration')
      if (advancedFields.some(name => fieldId(name) === id)) setAdvanced(true)
    } else {
      setTab('contacts')
    }
    requestAnimationFrame(() => { const element = document.getElementById(id); element?.focus(); element?.scrollIntoView({ block: 'center', behavior: 'instant' }) })
  }
  async function perform(operation: string, input: JsonObject, startAfterSave = false) {
    if (!active || document.hidden || isMutating || !harness?.enabled || !snapshot || mustRead || mutation.current || contactsDirty && (operation === 'resume' || operation === 'wake' || startAfterSave)) return
    if (request.current) { ++generation.current; request.current.abort(); request.current = null }
    const controller = new AbortController(), ticket = ++generation.current, harnessId = selected
    request.current = controller; mutation.current = true; setPending(startAfterSave ? 'save-start' : operation); setFailure(null); setNotice(null)
    let configurationSaved = false
    const accept = (value: unknown) => readDirectory({ protocolVersion: 1, harnesses: [{ ...harness, snapshot: value }], channels: [] }).harnesses[0]!.snapshot!
    const apply = (data: Snapshot) => setDirectory(current => current ? { ...current, harnesses: current.harnesses.map(row => row.id === harnessId ? { ...row, snapshot: data } : row) } : current)
    try {
      const data = accept(await hostRequest<unknown>('/autonomy', { method: 'POST', signal: controller.signal, body: { harnessId, operation, input } }))
      if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
      apply(data); setLastReadAt(Date.now())
      if (operation === 'configure') {
        configurationSaved = true; dirty.current.delete(harnessId); revisions.current[harnessId] = data.revision
        setDrafts(current => ({ ...current, [harnessId]: makeDraft(data.configuration) })); setErrors({})
      }
      if (startAfterSave) {
        if (!data.state.runtimeReady) throw new HostApiError('AUTONOMY_RUNTIME_NOT_READY', '', 'not-sent')
        const resumed = accept(await hostRequest<unknown>('/autonomy', { method: 'POST', signal: controller.signal, body: { harnessId, operation: 'resume', input: { expectedRevision: data.revision, expectedActivityRevision: data.state.revision } } }))
        if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
        apply(resumed); setTab('status'); setNotice('savedAndStarted')
      } else setNotice(operation === 'configure' ? data.configuration.enabled ? 'saved' : 'savedDisabled' : operation === 'configure-contact-policy' ? 'policy.saved' : operation === 'acknowledge-contact' ? 'reviewed' : operation === 'cancel-scheduled-task' ? 'agenda.cancelled' : operation === 'pause' ? 'pausedNotice' : 'startedNotice')
      requestAnimationFrame(() => operation === 'configure-contact-policy' ? document.querySelector<HTMLElement>('.autonomy-contact-policy h3')?.focus() : document.getElementById('autonomy-status-title')?.focus())
      return data
    } catch (error) {
      if (alive.current && !controller.signal.aborted && ticket === generation.current) {
        const code = error instanceof HostApiError ? error.code : undefined
        setFailure({ key: configurationSaved ? 'error.savedNotStarted' : code?.includes('CONFLICT') ? 'error.conflict' : error instanceof HostApiError && error.outcome === 'unknown' ? 'error.unknown' : 'error.operation', kind: 'mutation', code }); setMustRead(true)
      }
    } finally {
      if (request.current === controller) { request.current = null; mutation.current = false; if (alive.current) setPending(null) }
    }
  }
  function save(startAfterSave = false) {
    if (!draft || !snapshot) return
    const issues: Record<string, string> = {}
    for (const field of fields) { const issue = numberIssue(field.name); if (issue) issues[fieldId(field.name)] = issue }
    setErrors(issues); setValidationSubmitted(Object.keys(issues).length > 0)
    if (Object.keys(issues).length) {
      requestAnimationFrame(() => { errorSummary.current?.focus(); errorSummary.current?.scrollIntoView({ block: 'center', behavior: 'instant' }) })
      return
    }
    const configuration = { enabled: draft.enabled, autoResume: draft.autoResume, targets: draft.targets, ...Object.fromEntries(fields.map(field => [field.name, Number(draft[field.name])])) }
    void perform('configure', { expectedRevision: revisions.current[selected]!, configuration: configuration as unknown as JsonObject }, startAfterSave)
  }
  function discard() {
    if (!snapshot) return
    dirty.current.delete(selected); revisions.current[selected] = snapshot.revision
    setDrafts(current => ({ ...current, [selected]: makeDraft(snapshot.configuration) })); setErrors({}); setMustRead(false); setFailure(null); setNotice('discarded')
    requestAnimationFrame(() => document.getElementById(`autonomy-tab-${tab}`)?.focus())
  }
  function renderNumber(name: NumericKey) {
    if (!draft) return null
    const field = fields.find(field => field.name === name)!, id = fieldId(name)
    return <div className="autonomy-field" key={name}>
      <div><label htmlFor={id}>{t(`field.${name}`)}</label><p id={`${id}-hint`} className="autonomy-field-hint">{t(`hint.${name}`)}</p></div>
      <div className="autonomy-number-control"><input id={id} type="number" min={field.min} max={field.max} step="1" value={draft[name]} disabled={isMutating || !harness?.enabled} aria-invalid={Boolean(errors[id])} aria-describedby={`${id}-hint${errors[id] ? ` ${id}-error` : ''}`} onChange={event => { update({ [name]: event.target.value }); if (errors[id]) setErrors(previous => { const next = { ...previous }; delete next[id]; return next }) }} onBlur={() => validateNumber(name)} />{errors[id] && <p className="autonomy-field-error" id={`${id}-error`}>{t(errors[id], { min: formatNumber(field.min), max: formatNumber(field.max) })}</p>}</div>
    </div>
  }
  const controls = () => {
    if (!snapshot || !state) return null
    if (!harness?.enabled) return <a className="button button-secondary" href="#plugins">{t('openPlugins')}<ArrowRight size={15} aria-hidden="true" /></a>
    if (!snapshot.configuration.enabled) return tab !== 'configuration' ? <ActionButton reason={disabledReason || t('why.busy')} type="button" className="button button-primary" onClick={() => navigateTab('configuration', 'autonomy-enabled')}><Settings2 size={16} aria-hidden="true" />{t('setup')}</ActionButton> : null
    const pause = !state.ownerPaused && <ActionButton reason={disabledReason || t('why.busy')} type="button" className="button button-secondary" disabled={blocked} onClick={() => void perform('pause', { expectedRevision: snapshot.revision, expectedActivityRevision: state.revision })}><Pause size={15} aria-hidden="true" />{t(pending === 'pause' ? 'pausingAction' : 'pause')}</ActionButton>
    if (!state.runtimeReady) return <>{pause}<a className="button button-primary" href={`#harness/${encodeURIComponent(selected)}`}>{t('openHarness')}<ArrowRight size={15} aria-hidden="true" /></a></>
    if (state.ownerPaused) return <ActionButton reason={disabledReason || (contactsDirty ? t('policy.unsavedControl') : t('why.active'))} type="button" className="button button-primary" disabled={blocked || Boolean(state.active) || contactsDirty} onClick={() => isDirty ? saveButton.current?.focus() : void perform('resume', { expectedRevision: snapshot.revision, expectedActivityRevision: state.revision })}><Play size={15} aria-hidden="true" />{t(isDirty ? 'saveFirst' : pending === 'resume' ? 'starting' : state.errorCode === 'AUTONOMY_RUN_LIMIT' && state.lastOutcome !== 'unknown' ? 'resumeAfterLimit' : state.errorCode ? 'resumeAfterReview' : 'resume')}</ActionButton>
    return <>{pause}{['sleeping', 'waiting'].includes(state.mode) && !state.active && <ActionButton reason={disabledReason || (contactsDirty ? t('policy.unsavedControl') : t('why.draft'))} type="button" className="button button-secondary" disabled={blocked || isDirty || contactsDirty} onClick={() => void perform('wake', { expectedRevision: snapshot.revision, expectedActivityRevision: state.revision })}><Play size={15} aria-hidden="true" />{t(pending === 'wake' ? 'starting' : 'wake')}</ActionButton>}</>
  }
  const statusHelp = !harness?.enabled ? 'help.pluginDisabled' : !snapshot?.configuration.enabled ? 'help.disabled' : !state?.runtimeReady ? 'help.runtimeStopped' : state.errorCode === 'AUTONOMY_RUN_LIMIT' ? 'help.runLimit' : state.errorCode ? 'help.error' : state.ownerPaused ? 'help.paused' : state.mode === 'sleeping' ? 'help.sleeping' : state.mode === 'waiting' ? 'help.waiting' : 'help.running'
  const combinedSave = Boolean(draft?.enabled && state?.runtimeReady && !contactsDirty)

  return <section ref={surface} className="autonomy-settings" aria-labelledby="autonomy-title" aria-busy={isMutating}>
    <div className="autonomy-heading"><div><h2 id="autonomy-title">{t('title')}</h2><p className="panel-description">{t('description')}</p></div><ActionButton reason={disabledReason || t('why.busy')} type="button" className="autonomy-refresh text-button" disabled={pending !== null} onClick={() => void read(true)}><RefreshCw size={15} className={pending === 'read' ? 'is-spinning' : ''} aria-hidden="true" />{t(pending === 'read' ? 'reading' : 'refresh')}</ActionButton></div>
    {!directory ? <div className="autonomy-loading" role="status"><Activity size={20} aria-hidden="true" /><p>{t(failure ? 'loadFailed' : 'loading')}</p></div> : directory.harnesses.length === 0 ? <div className="autonomy-empty"><h3>{t('noHarnessTitle')}</h3><p>{t('noHarness')}</p><a className="button button-secondary" href="#plugins">{t('openPlugins')}</a></div> : <>
      <div className="autonomy-context">{directory.harnesses.length > 1 ? <label className="autonomy-harness"><span>{t('harness')}</span><select value={selected} disabled={isMutating} onChange={event => { setSelected(event.target.value); setFailure(null); setNotice(null); setMustRead(false); setErrors({}) }}>{directory.harnesses.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label> : <span className="autonomy-harness-name"><Activity size={15} aria-hidden="true" />{harness?.name}</span>}<span className="autonomy-context-status">{harness?.enabled ? state?.runtimeReady ? t('runtime.ready') : t('runtime.stopped') : t('pluginDisabled')}</span></div>
      {!harness?.supported || !snapshot || !draft || !state ? <div className="autonomy-empty"><h3>{t('unsupportedTitle')}</h3><p>{t('unsupported')}</p></div> : <>
        <div className="autonomy-tabs workspace-rail" role="tablist" aria-label={t('sections')}>{tabs.map((id, index) => <ActionButton reason={disabledReason || t('why.busy')} type="button" role="tab" id={`autonomy-tab-${id}`} aria-selected={tab === id} aria-controls={`autonomy-panel-${id}`} tabIndex={tab === id ? 0 : -1} key={id} onClick={() => setTab(id)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + 3) % 3; setTab(tabs[next]!); document.getElementById(`autonomy-tab-${tabs[next]}`)?.focus() } }}>{t(`tab.${id}`)}</ActionButton>)}</div>
        <div className="autonomy-status-banner"><div className="autonomy-status-copy"><h3 id="autonomy-status-title" tabIndex={-1}>{harness.enabled ? statusText(state.reason) : t('pluginDisabled')}</h3><p>{t(statusHelp, { minutes: formatNumber(snapshot.configuration.maxRunMinutes) })}</p>{state.errorCode && <p>{t('code', { code: state.errorCode })}</p>}<p>{t('executionBudget', { used: formatNumber(state.runUsedMs / 60000, { maximumFractionDigits: 2 }), limit: formatNumber(snapshot.configuration.maxRunMinutes) })}</p></div><div className="autonomy-controls">{controls()}</div></div>
        {failure && <div className="autonomy-notice" role="alert"><AlertCircle size={17} aria-hidden="true" /><div><p>{t(failure.key)}</p>{failure.code && <details><summary>{t('errorDetails')}</summary><code>{failure.code}</code></details>}{mustRead && <ActionButton reason={disabledReason || t('why.busy')} type="button" className="text-button" disabled={pending !== null} onClick={() => void read(true)}>{t('refreshToContinue')}</ActionButton>}</div></div>}
        {notice && <p className="autonomy-success" role="status"><Check size={16} aria-hidden="true" />{t(notice)}</p>}
        {validationSubmitted && errorIds.length > 0 && <div className="autonomy-error-summary" role="alert" tabIndex={-1} ref={errorSummary}><h3>{t('validation.summary')}</h3><ul>{errorIds.map(id => { const field = fields.find(field => fieldId(field.name) === id); const target = draft.targets.find(target => id.startsWith(`autonomy-contact-${target.id}-`)); return <li key={id}><a href={`#${id}`} onClick={event => { event.preventDefault(); revealError(id) }}>{field ? t(`field.${field.name}`) : target?.label || t('newContact')}: {t(errors[id]!, field ? { min: formatNumber(field.min), max: formatNumber(field.max) } : undefined)}</a></li> })}</ul></div>}
        {versionChanged && <div className="autonomy-review" role="alert"><h3>{t('conflictTitle')}</h3><p>{t('conflictHelp')}</p><details><summary>{t('latestConfiguration')}</summary><dl className="settings-stat-list"><div><dt>{t('enabled')}</dt><dd>{t(snapshot.configuration.enabled ? 'yes' : 'no')}</dd></div><div><dt>{t('autoResume')}</dt><dd>{t(snapshot.configuration.autoResume ? 'yes' : 'no')}</dd></div>{fields.map(field => <div key={field.name}><dt>{t(`field.${field.name}`)}</dt><dd>{formatNumber(snapshot.configuration[field.name])}</dd></div>)}</dl><p>{t('latestContacts', { count: snapshot.configuration.targets.length })}</p><ul>{snapshot.configuration.targets.map(target => <li key={target.id}>{target.label} · {target.pluginId} · {target.accountId} · {target.targetId}<small>{target.toolNames.join(', ')}</small></li>)}</ul></details><div className="autonomy-inline-actions"><ActionButton reason={disabledReason || t('why.busy')} type="button" className="button button-secondary" disabled={isMutating || mustRead} onClick={() => { revisions.current[selected] = snapshot.revision; setFailure(null); setNotice('rebased') }}>{t('rebase')}</ActionButton><ActionButton reason={disabledReason || t('why.busy')} type="button" className="text-button" disabled={isMutating} onClick={discard}>{t('discard')}</ActionButton></div></div>}
        <div role="tabpanel" id="autonomy-panel-status" aria-labelledby="autonomy-tab-status" hidden={tab !== 'status'} tabIndex={-1}>
          <section className="autonomy-arrangement"><div><Clock3 size={18} aria-hidden="true" /><h3>{t('info.arrangement')}</h3></div><strong>{arrangement}</strong>{state.note ? <p className="autonomy-arrangement-note">{state.note}</p> : <p className="autonomy-field-hint">{t('noArrangement')}</p>}{state.nextWakeAt !== null && <p className="autonomy-next-wake">{t('info.wake')} <time dateTime={new Date(state.nextWakeAt).toISOString()}>{time(state.nextWakeAt)}</time></p>}</section>
          {agenda && scheduledTasks.length > 0 && <section className="autonomy-agenda" aria-labelledby="autonomy-agenda-title"><div className="autonomy-section-heading"><div><h3 id="autonomy-agenda-title">{t('agenda.title')}</h3><p className="autonomy-field-hint">{t('agenda.help')}</p></div><span>{t('agenda.count', { count: scheduledTasks.length, formatted: formatNumber(scheduledTasks.length) })}</span></div><ul>{scheduledTasks.map(task => <li key={task.id}><div className="autonomy-agenda-copy"><strong>{task.message}</strong><time dateTime={new Date(task.dueAt).toISOString()}>{time(task.dueAt)}</time></div><ActionButton reason={disabledReason || t('why.busy')} type="button" className="text-button" disabled={blocked} onClick={() => void perform('cancel-scheduled-task', { expectedAgendaRevision: agenda.revision, taskId: task.id })}>{t('agenda.cancel')}</ActionButton></li>)}</ul></section>}
          <dl className="autonomy-usage"><div><dt>{t('info.cycles')}</dt><dd>{formatNumber(state.cycles)} <span>/ {formatNumber(snapshot.configuration.maxCyclesPerHour)}</span></dd></div><div><dt>{t('info.contacts')}</dt><dd>{formatNumber(state.contacts)} <span>/ {formatNumber(snapshot.configuration.maxContactsPerHour)}</span></dd></div><div><dt>{t('info.outcome')}</dt><dd>{outcomeText(state.lastOutcome)}</dd>{state.lastFinishedAt !== null && <small>{time(state.lastFinishedAt)}</small>}</div></dl>
          <section className="autonomy-history"><div className="autonomy-section-heading"><h3>{t('history')}</h3><span>{t('historyCount', { count: state.history.length, formatted: formatNumber(state.history.length) })}</span></div>{state.history.length ? <ul>{[...state.history].reverse().map(row => <li key={row.cycleId}><span className={`autonomy-outcome-dot is-${row.outcome}`} aria-hidden="true" /><strong>{outcomeText(row.outcome)}</strong><time dateTime={new Date(row.finishedAt).toISOString()}>{time(row.finishedAt)}</time>{row.code && <code>{row.code}</code>}</li>)}</ul> : <div className="autonomy-history-empty"><p>{t('emptyHistory')}</p><span>{t('historyEmptyHelp')}</span></div>}</section>
          {snapshot.contactTasks.filter(task => ['unknown', 'pending'].includes(task.state)).map(task => <section className="autonomy-review" key={task.agentId}><h3>{task.label} · {outcomeText(task.state)}</h3><p>{t('unknownContact', { status: outcomeText(task.state) })}</p><details><summary>{t('taskDetails')}</summary><code>{task.taskId}</code></details><ActionButton reason={disabledReason || t('why.active')} type="button" className="button button-secondary" disabled={blocked || Boolean(state.active)} onClick={() => void perform('acknowledge-contact', { confirmed: true, expectedRevision: snapshot.revision, agentId: task.agentId, taskId: task.taskId })}>{t('acknowledgeContact')}</ActionButton></section>)}
          <details className="autonomy-diagnostics"><summary>{t('diagnostics')}</summary><dl className="settings-stat-list"><div><dt>{t('info.runtime')}</dt><dd>{t(state.runtimeReady ? 'runtime.ready' : 'runtime.stopped')}</dd></div><div><dt>{t('info.failures')}</dt><dd>{formatNumber(state.failures)} / {formatNumber(snapshot.configuration.maxConsecutiveFailures)}</dd></div><div><dt>{t('info.lastStart')}</dt><dd>{time(state.lastStartedAt)}</dd></div><div><dt>{t('info.lastEnd')}</dt><dd>{time(state.lastFinishedAt)}</dd></div>{state.active && <><div><dt>{t('info.cycle')}</dt><dd><code>{state.active.id}</code></dd></div><div><dt>{t('info.deadline')}</dt><dd>{time(state.active.deadline)}</dd></div></>}{state.errorCode && <div><dt>{t('info.error')}</dt><dd><code>{state.errorCode}</code></dd></div>}</dl></details>
        </div>
        <div role="tabpanel" id="autonomy-panel-configuration" aria-labelledby="autonomy-tab-configuration" hidden={tab !== 'configuration'} tabIndex={-1}>
          <div className="autonomy-enable-row"><div><label htmlFor="autonomy-enabled">{t('enabled')}</label><p className="autonomy-field-hint">{t('enabledHelp')}</p></div><label className="autonomy-enable-hit" htmlFor="autonomy-enabled"><input id="autonomy-enabled" type="checkbox" checked={draft.enabled} disabled={isMutating || !harness.enabled} onChange={event => update({ enabled: event.target.checked })} /></label></div>
          <section className="autonomy-config-section" aria-labelledby="autonomy-rhythm-heading"><h3 id="autonomy-rhythm-heading">{t('rhythm')}</h3><p className="autonomy-field-hint">{t('rhythmHelp')}</p>{primaryFields.map(renderNumber)}</section>
          <details className="autonomy-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary><span><Settings2 size={17} aria-hidden="true" /><strong>{t('advanced')}</strong><small>{t('advancedSummary')}</small></span><ChevronDown size={17} aria-hidden="true" /></summary><div className="autonomy-advanced-content">{advancedFields.map(renderNumber)}<label className="autonomy-check"><span><strong>{t('autoResume')}</strong><small>{t('autoResumeHelp')}</small></span><input type="checkbox" checked={draft.autoResume} disabled={isMutating || !harness.enabled} onChange={event => update({ autoResume: event.target.checked })} /></label></div></details>
        </div>
        <div role="tabpanel" id="autonomy-panel-contacts" aria-labelledby="autonomy-tab-contacts" hidden={tab !== 'contacts'} tabIndex={-1}>
          {snapshot.contactPolicy && <AutonomyContacts key={selected} harnessId={selected} value={snapshot.contactPolicy} channels={directory.channels} active={active && visible && tab === 'contacts'} configurationRevision={snapshot.revision} activityRevision={state.revision} disabled={blocked} onSave={input => perform('configure-contact-policy', input)} onDirtyChange={setContactsDirty} />}
        </div>
        {isDirty && <div className="autonomy-save" aria-label={t('saveRegion')}><div><strong>{t('dirty')}</strong><p>{t(combinedSave ? 'saveStartHelp' : draft.enabled ? 'saveHelp' : 'saveDisableHelp')}</p></div><div className="autonomy-save-actions"><ActionButton reason={disabledReason || t('why.busy')} type="button" className="text-button" disabled={isMutating} onClick={discard}>{t('discardShort')}</ActionButton>{combinedSave && <ActionButton reason={disabledReason || t('why.conflict')} type="button" className="button button-secondary" disabled={blocked || versionChanged} onClick={() => save(false)}>{t('saveOnly')}</ActionButton>}<ActionButton reason={disabledReason || t('why.conflict')} ref={saveButton} type="button" className="button button-primary" disabled={blocked || versionChanged} onClick={() => save(combinedSave)}>{t(isMutating ? pending === 'save-start' ? 'savingStarting' : 'saving' : combinedSave ? state.ownerPaused || !snapshot.configuration.enabled ? 'saveAndStart' : 'saveAndContinue' : 'save')}</ActionButton></div></div>}
        <p className="autonomy-updated">{lastReadAt !== null && t('updatedAt', { time: formatDateTime(lastReadAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</p>
      </>}
    </>}
    {failure && !snapshot && <p className="autonomy-notice" role="alert">{t(failure.key)}</p>}
  </section>
}
