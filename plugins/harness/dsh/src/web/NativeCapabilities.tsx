import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import { AlertCircle, Check, ChevronDown, Info, LockKeyhole, RefreshCw, Search, Wand2 } from 'lucide-react'
import { ActionButton, FormSaveBar, InlineConfirm, Switch, UnknownOutcomeCard, createRequestId, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { NATIVE_FEATURES } from '../native-capabilities'
import type { NativeCapabilitiesConfiguration, NativeFeatureSelection } from '../native-capabilities'
import { clearNativeDraftSecrets, nativeLabel, nativeObject, readNativeConfiguration, readNativeSnapshot } from './native-data'
import type { NativeSnapshot } from './native-data'
import './native-i18n'

interface Props {
  readonly active: boolean
  readonly enabled: boolean
  readonly runtimeActive: boolean
  readonly busy: boolean
  readonly actionLock: MutableRefObject<boolean>
  readonly onBusy: (value: boolean) => void
  readonly onDirtyChange?: (dirty: boolean) => void
}
type Notice = { key: string; params?: Record<string, string>; code?: string }
const configTexts = (configuration: NativeCapabilitiesConfiguration) => Object.fromEntries(configuration.features.map(feature => [feature.id, JSON.stringify(feature.config, null, 2)]))

function inspectJsonObject(raw: string): { readonly valid: boolean; readonly formatted: string | null } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!nativeObject(parsed)) return { valid: false, formatted: null }
    return { valid: true, formatted: JSON.stringify(parsed, null, 2) }
  } catch {
    return { valid: false, formatted: null }
  }
}

function highlightText(value: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return value
  const lower = value.toLocaleLowerCase()
  const target = needle.toLocaleLowerCase()
  const index = lower.indexOf(target)
  if (index < 0) return value
  const parts: ReactNode[] = []
  let cursor = 0
  let match = index
  let key = 0
  while (match >= 0) {
    if (match > cursor) parts.push(value.slice(cursor, match))
    parts.push(<mark className="dsh-highlight" key={key++}>{value.slice(match, match + needle.length)}</mark>)
    cursor = match + needle.length
    match = lower.indexOf(target, cursor)
  }
  if (cursor < value.length) parts.push(value.slice(cursor))
  return <>{parts}</>
}

export function NativeCapabilitiesSettings({ active, enabled, runtimeActive, busy, actionLock, onBusy, onDirtyChange }: Props) {
  const { t, locale, formatNumber } = useI18n('dsh-native')
  const prefix = useId()
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const [draft, setDraft] = useState<NativeCapabilitiesConfiguration | null>(null)
  const [configurationTexts, setConfigurationTexts] = useState<Record<string, string>>({})
  const [moduleTexts, setModuleTexts] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const baseRevision = useRef<number | null>(null)
  const [needsRead, setNeedsRead] = useState(false)
  const [failure, setFailure] = useState<Notice | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [tab, setTab] = useState<'features' | 'plugins' | 'tools'>('features')
  const [query, setQuery] = useState('')
  const [showBase, setShowBase] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null)
  const [inspectedSpec, setInspectedSpec] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [pendingBuilds, setPendingBuilds] = useState<string[]>([])
  const [approveBuilds, setApproveBuilds] = useState(false)
  const alive = useRef(false)
  const requestedRuntime = useRef<boolean | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const mutating = useRef(false)
  const props = useRef({ active, enabled, runtimeActive, busy, onBusy, onDirtyChange })
  props.current = { active, enabled, runtimeActive, busy, onBusy, onDirtyChange }

  useEffect(() => {
    props.current.onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => { props.current.onDirtyChange?.(false) }, [])

  const markDirty = () => { dirtyRef.current = true; setDirty(true); setNotice(null) }
  const api = (operation: string, input: JsonObject, signal: AbortSignal) => hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', signal, body: { operation: `native-${operation}`, input } })
  function describe(error: unknown, reading = false): Notice {
    const code = error instanceof HostApiError ? error.code : 'NATIVE_REQUEST_FAILED'
    if (error instanceof HostApiError && error.outcome === 'unknown') return { key: 'error.unknown', code }
    if (code.includes('CONFLICT') || code === 'NATIVE_TOOL_CHANGED') return { key: 'error.conflict', code }
    if (code === 'NATIVE_STOP_FIRST') return { key: 'error.stop', code }
    if (code === 'NATIVE_BUSY' || code === 'NATIVE_STOP_FAILED') return { key: 'error.busy', code }
    if (code === 'DSH_NOT_INSTALLED') return { key: 'error.missing', code }
    if (code === 'NATIVE_CONFIGURATION_REJECTED' || code === 'NATIVE_DEPENDENCY_UNAVAILABLE' || code === 'NATIVE_OPERATION_FAILED') return { key: 'error.validation', code }
    return { key: reading ? 'error.read' : 'error.operation', code }
  }
  const cancel = useCallback(() => {
    ++generation.current
    const ownedRequest = request.current !== null
    if (ownedRequest) requestedRuntime.current = null
    request.current?.abort(); request.current = null
    if (mutating.current && alive.current) { setNeedsRead(true); setFailure({ key: 'error.unknown' }) }
    mutating.current = false
    if (ownedRequest) { actionLock.current = false; props.current.onBusy(false) }
    if (alive.current) { setConfigurationTexts(current => Object.fromEntries(Object.entries(current).map(([id, text]) => [id, clearNativeDraftSecrets(text, snapshotRef.current?.configuration.features.find(feature => feature.id === id)?.config)]))); setPending(null); setModuleTexts({}); setSpec(''); setInspection(null); setInspectedSpec(''); setTrusted(false); setApproveBuilds(false) }
  }, [actionLock])
  useEffect(() => {
    alive.current = true
    const hidden = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', cancel)
    return () => { alive.current = false; cancel(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cancel) }
  }, [cancel])
  useEffect(() => { if (!active || !enabled) cancel() }, [active, enabled, cancel])
  const read = useCallback(async (preserveFailure = false) => {
    if (!props.current.active || !props.current.enabled || document.hidden || request.current || actionLock.current) return
    requestedRuntime.current = props.current.runtimeActive
    const controller = new AbortController(), ticket = ++generation.current
    request.current = controller; actionLock.current = true; props.current.onBusy(true); setPending('list'); if (!preserveFailure) setFailure(null)
    try {
      const response = readNativeSnapshot(await api('list', {}, controller.signal))
      if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
      setSnapshot(response)
      if (!dirtyRef.current) { setDraft(response.configuration); setConfigurationTexts(configTexts(response.configuration)); baseRevision.current = response.configuration.revision }
      const conflict = dirtyRef.current && baseRevision.current !== response.configuration.revision
      setNeedsRead(conflict)
      if (conflict) setFailure({ key: 'error.conflict' })
    } catch (error) { if (alive.current && !controller.signal.aborted && ticket === generation.current) setFailure(describe(error, true)) }
    finally { if (request.current === controller) { request.current = null; actionLock.current = false; props.current.onBusy(false); if (alive.current) setPending(null) } }
  }, [actionLock])
  useEffect(() => {
    if (!enabled) requestedRuntime.current = null
    else if (active && requestedRuntime.current !== runtimeActive) void read()
  }, [active, enabled, runtimeActive, read])

  async function perform(operation: string, input: JsonObject, apply?: (value: Record<string, unknown>) => void) {
    if (!active || !enabled || document.hidden || request.current || actionLock.current || busy || needsRead || operation !== 'inspect' && runtimeActive) return
    const controller = new AbortController(), ticket = ++generation.current
    request.current = controller; actionLock.current = true; props.current.onBusy(true); mutating.current = operation !== 'inspect'
    setPending(operation); setFailure(null); setNotice(null)
    let refresh = false
    try {
      const response = await api(operation, input, controller.signal)
      if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
      if (!nativeObject(response)) throw new HostApiError('NATIVE_RESPONSE_INVALID', '', 'unknown')
      apply?.(response)
      if (!apply) {
        const application = response.application
        if (!['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(application))) throw new HostApiError('NATIVE_RESPONSE_INVALID', '', 'unknown')
        if (application === 'failed') {
          setFailure({ key: 'resultFailed', params: { stage: String(response.stage), reason: String(response.errorCode ?? (nativeObject(response.package) ? response.package.kind : '') ?? 'NATIVE_OPERATION_FAILED') } })
          setPendingBuilds(Array.isArray(response.pendingBuilds) && response.pendingBuilds.every(value => typeof value === 'string') ? response.pendingBuilds as string[] : [])
        } else setNotice({ key: application === 'overridden' ? 'resultOverridden' : application === 'cancelled' ? 'resultCancelled' : operation === 'install' ? 'resultInstalled' : 'resultSaved' })
        if (operation === 'install' && application !== 'failed') { setTrusted(false); setInspection(null); setPendingBuilds([]); setApproveBuilds(false) }
        refresh = true; setRemoving(null); setModuleTexts({})
      }
    } catch (error) {
      if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
      const description = describe(error); setFailure(description)
      if (description.key === 'error.unknown' || description.key === 'error.conflict') setNeedsRead(true)
    } finally {
      if (request.current === controller) { request.current = null; actionLock.current = false; mutating.current = false; props.current.onBusy(false); if (alive.current) setPending(null) }
    }
    if (refresh && alive.current && !controller.signal.aborted) await read(true)
  }
  function updateFeature(id: string, change: Partial<NativeFeatureSelection>) {
    if (!draft) return
    markDirty(); setDraft({ ...draft, features: draft.features.map(feature => feature.id === id ? { ...feature, ...change } : feature) })
  }
  function updateToolOverride(tool: NativeSnapshot['catalog']['tools'][number], agentTypeIds: readonly string[] | null) {
    if (!draft) return
    markDirty()
    setDraft({ ...draft, toolAccessOverrides: [...(draft.toolAccessOverrides ?? []).filter(row => row.name !== tool.name), ...(agentTypeIds === null ? [] : [{ name: tool.name, fingerprint: tool.fingerprint, agentTypeIds }])] })
  }
  async function save() {
    if (!draft || !snapshot) return
    let features: NativeFeatureSelection[]
    try {
      features = draft.features.map(feature => { const config: unknown = JSON.parse(configurationTexts[feature.id] ?? ''); if (!nativeObject(config) || feature.enabled && feature.agentTypeIds.length === 0) throw new Error('config'); return { ...feature, config: config as JsonObject } })
    } catch { setFailure({ key: 'error.invalid' }); return }
    await perform('save', { expectedRevision: baseRevision.current!, features: features as unknown as JsonObject[], toolGrants: draft.toolGrants as unknown as JsonObject[], ...(draft.toolAccessOverrides ? { toolAccessOverrides: draft.toolAccessOverrides as unknown as JsonObject[] } : {}) }, value => {
      const configuration = readNativeConfiguration(value.configuration)
      setDraft(configuration); setSnapshot(current => current ? { ...current, configuration } : current); setConfigurationTexts(configTexts(configuration)); baseRevision.current = configuration.revision
      dirtyRef.current = false; setDirty(false); setNeedsRead(false); setNotice({ key: 'saved' })
    })
  }
  function discardDraft() {
    if (!snapshot) return
    setDraft(snapshot.configuration)
    setConfigurationTexts(configTexts(snapshot.configuration))
    baseRevision.current = snapshot.configuration.revision
    dirtyRef.current = false
    setDirty(false)
    setNeedsRead(false)
    setFailure(null)
  }
  const disabled = pending !== null || !active || !enabled || runtimeActive || busy || needsRead
  const disabledReason = !enabled ? t('reason.disabled') : pending !== null || busy ? t('reason.busy') : runtimeActive ? t('reason.stop') : needsRead ? t('reason.read') : !active ? t('reason.hidden') : ''
  const readReason = !enabled ? t('reason.disabled') : !active ? t('reason.hidden') : t('reason.busy')
  const readButton = <ActionButton reason={readReason} type="button" className="button button-secondary dsh-native-read" disabled={pending !== null || !active || !enabled || actionLock.current} onClick={() => void read()}><RefreshCw size={15} aria-hidden="true" />{t(pending === 'list' ? 'reading' : 'refresh')}</ActionButton>
  const filter = (values: string[]) => values.some(value => value.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)))
  const typeTitle = (id: string) => id === 'main' ? t('main') : snapshot?.agentTypes.find(type => type.id === id)?.title ?? id
  function scopes(selected: readonly string[], update: (ids: string[]) => void, label = t('scope'), childrenOnly = false) {
    const types = [...(snapshot?.agentTypes ?? []), ...selected.filter(id => !snapshot?.agentTypes.some(type => type.id === id)).map(id => ({ id, title: id, enabled: false }))].filter(type => !childrenOnly || type.id !== 'main')
    return <fieldset className="dsh-native-scopes" disabled={disabled}><legend>{label}</legend><div className="dsh-native-scope-actions"><ActionButton reason={disabledReason} type="button" className="text-button" disabled={disabled} onClick={() => update(types.filter(type => type.enabled).map(type => type.id))}>{t('allowAll')}</ActionButton><ActionButton reason={disabledReason || t('reason.empty')} type="button" className="text-button" disabled={disabled || selected.length === 0} onClick={() => update([])}>{t('clearAll')}</ActionButton></div>{types.map(type => <label key={type.id}><input type="checkbox" checked={selected.includes(type.id)} onChange={event => update(event.target.checked ? [...selected, type.id] : selected.filter(id => id !== type.id))} /><span>{typeTitle(type.id)}{!type.enabled && t('inactiveType')}</span></label>)}</fieldset>
  }
  function phase(valueEnabled: boolean, value: string | null) { return t(!valueEnabled ? 'phaseDisabled' : value === 'active' ? 'phaseActive' : value === 'failed' ? 'phaseFailed' : value === 'pending' || value === 'loading' ? 'phasePending' : 'phaseUnobserved') }
  const features = NATIVE_FEATURES.filter(definition => filter([t(`feature.${definition.id}.title`), t(`feature.${definition.id}.description`), ...definition.modules.map(module => module.name)]))
  const bundles = snapshot?.catalog.bundles.filter(row => (showBase || !row.protected) && filter([row.name, nativeLabel(row.title, locale, ''), nativeLabel(row.description, locale, '')])) ?? []
  const plugins = snapshot?.catalog.plugins.filter(row => (showBase || !row.protected) && filter([row.moduleName, nativeLabel(row.title, locale, '')])) ?? []
  const tools = snapshot?.catalog.tools.filter(row => filter([row.name, row.description])) ?? []
  const hasInvalidFeatureJson = Boolean(draft?.features.some(feature => !inspectJsonObject(configurationTexts[feature.id] ?? '').valid))

  return <section className="dsh-native-settings" aria-labelledby={`${prefix}-title`}>
    <div className="dsh-native-heading"><div><h3 id={`${prefix}-title`}>{t('title')}</h3><p className="dsh-help">{t('description')}</p></div>{!snapshot && readButton}</div>
    {runtimeActive && <p className="dsh-help" role="status">{t('running')}</p>}
    {snapshot && <p className="dsh-native-revision">{t('savedRevision', { revision: formatNumber(snapshot.configuration.revision) })}{snapshot.catalog.runtime.appliedRevision !== null && <span>{t('applied', { revision: formatNumber(snapshot.catalog.runtime.appliedRevision) })}</span>}</p>}
    {failure && (failure.key === 'error.unknown' ? (
      <UnknownOutcomeCard
        title={t('error.unknown')}
        body={t('error.unknown')}
        requestId={failure.code ?? null}
        refreshing={pending === 'list'}
        refreshLabel={t('refresh')}
        onRefresh={() => void read()}
        onConfirmReviewed={() => { setFailure(null); setNeedsRead(false) }}
      />
    ) : (
      <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><div><p>{t(failure.key, failure.params)}</p>{failure.code && <small>{t('code', { code: failure.code })}</small>}</div></div>
    ))}
    {notice && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t(notice.key, notice.params)}</p>}
    {pending === 'list' && !snapshot && <p className="dsh-help" role="status">{t('loading')}</p>}
    {snapshot && draft && <>
      <div className="dsh-native-toolbar workspace-rail"><div className="dsh-native-categories" role="group" aria-label={t('title')}>{(['features', 'plugins', 'tools'] as const).map(id => <ActionButton type="button" className="text-button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{t(`tab.${id}`)}</ActionButton>)}</div><div className="dsh-native-filter-controls">{tab === 'plugins' && <label className="dsh-native-base"><input type="checkbox" checked={showBase} onChange={event => setShowBase(event.target.checked)} /><span>{t('base')}</span></label>}<label className="dsh-native-search"><Search size={15} aria-hidden="true" /><span className="dsh-native-search-label">{t('search')}</span><input type="search" value={query} placeholder={t('searchPlaceholder')} onChange={event => setQuery(event.target.value)} /></label>{readButton}</div></div>
      <div hidden={tab !== 'features'}>
        {features.map(definition => {
          const selection = draft.features.find(feature => feature.id === definition.id)!, status = snapshot.catalog.features.find(feature => feature.id === definition.id)
          const mounted = snapshot.catalog.runtime.mounted.some(row => row.featureId === definition.id)
          const persisted = snapshot.configuration.features.find(feature => feature.id === definition.id)!
          const rawConfig = configurationTexts[definition.id] ?? ''
          const jsonCheck = inspectJsonObject(rawConfig)
          const locallyChanged = JSON.stringify(selection) !== JSON.stringify(persisted) || rawConfig !== JSON.stringify(persisted.config, null, 2)
          const editorId = `${prefix}-feature-config-${definition.id}`
          return <div className="dsh-native-row" key={definition.id}>
            <div className="dsh-native-row-head">
              <div className="dsh-native-row-copy">
                <strong>{highlightText(t(`feature.${definition.id}.title`), query)}</strong>
                <small>{highlightText(t(`feature.${definition.id}.description`), query)}</small>
              </div>
              <div className="dsh-native-row-controls">
                <span className="dsh-native-state">{t(!status?.platformAvailable ? 'wrongPlatform' : !status.available ? 'unavailable' : locallyChanged ? 'draft' : !selection.enabled ? 'disabled' : mounted ? 'mounted' : snapshot.catalog.runtime.running ? 'ready' : 'stopped')}</span>
                <Switch
                  compact
                  checked={selection.enabled}
                  disabled={disabled || !status?.available && !selection.enabled}
                  disabledReason={disabled ? disabledReason : t('unavailable')}
                  label={t('enabled')}
                  aria-label={t('enabled')}
                  onChange={checked => updateFeature(definition.id, { enabled: checked, agentTypeIds: checked && selection.agentTypeIds.length === 0 ? ['main'] : selection.agentTypeIds })}
                />
              </div>
            </div>
            <details className="dsh-native-row-details">
              <summary><ChevronDown size={15} aria-hidden="true" /><span>{t('detailsToggle')}</span></summary>
              <div className="dsh-native-row-body">
                {scopes(selection.agentTypeIds, ids => updateFeature(definition.id, { agentTypeIds: ids }))}
                <ul className="dsh-native-modules">{status?.modules.map(module => <li key={module.id}><code>{highlightText(module.name, query)}</code><span>{t(module.available ? 'available' : 'unavailable')}</span></li>)}</ul>
                <div className="dsh-native-editor">
                  <div className="dsh-native-editor-head">
                    <label htmlFor={editorId}>{t('configuration')}</label>
                    <div className="dsh-native-editor-actions">
                      <span className={`dsh-json-badge ${jsonCheck.valid ? 'is-valid' : 'is-invalid'}`}>{t(jsonCheck.valid ? 'jsonValid' : 'jsonInvalid')}</span>
                      <ActionButton
                        type="button"
                        className="text-button"
                        disabled={disabled || !jsonCheck.valid || jsonCheck.formatted === rawConfig}
                        reason={disabled ? disabledReason : !jsonCheck.valid ? t('jsonInvalidInline') : t('reason.unchanged')}
                        onClick={() => { if (jsonCheck.formatted !== null) { markDirty(); setConfigurationTexts(current => ({ ...current, [definition.id]: jsonCheck.formatted! })) } }}>
                        <Wand2 size={13} aria-hidden="true" />
                        {t('formatJson')}
                      </ActionButton>
                    </div>
                  </div>
                  <textarea id={editorId} spellCheck={false} value={rawConfig} disabled={disabled} maxLength={32768} aria-invalid={!jsonCheck.valid} onChange={event => { markDirty(); setConfigurationTexts(current => ({ ...current, [definition.id]: event.target.value })) }} />
                  {!jsonCheck.valid && <p className="dsh-native-problem" role="alert">{t('jsonInvalidInline')}</p>}
                </div>
                <p className="dsh-help">{t('configHelp')}</p>
              </div>
            </details>
          </div>
        })}
        {features.length === 0 && <p className="dsh-help">{t('noMatches')}</p>}
      </div>
      <div hidden={tab !== 'tools'}><p className="dsh-help">{t('toolHelp')}</p>
        {tools.map(tool => {
          const grant = draft.toolGrants.find(row => row.name === tool.name), children = grant?.agentTypeIds.filter(id => id !== 'main') ?? []
          const override = draft.toolAccessOverrides?.find(row => row.name === tool.name)
          const changed = override ? override.fingerprint !== tool.fingerprint : tool.automaticAccess === 'main' && children.length > 0 && grant?.fingerprint !== tool.fingerprint
          const automaticTypes = tool.automaticAccess === 'all' ? snapshot.agentTypes.map(type => type.id) : ['main', ...(grant?.fingerprint === tool.fingerprint ? children : [])]
          return <div className="dsh-native-row" key={tool.name}>
            <div className="dsh-native-row-head">
              <div className="dsh-native-row-copy">
                <strong><code>{highlightText(tool.name, query)}</code></strong>
                <small>{highlightText(tool.description, query)}</small>
              </div>
              <div className="dsh-native-row-controls">
                <span className="dsh-native-state">{t(override ? override.agentTypeIds.length ? 'customAccess' : 'customDisabled' : tool.automaticAccess === 'all' ? 'automaticAll' : 'automaticMain')}</span>
                {changed && <span className="dsh-native-state">{t('changed')}</span>}
              </div>
            </div>
            <details className="dsh-native-row-details">
              <summary><ChevronDown size={15} aria-hidden="true" /><span>{t('detailsToggle')}</span></summary>
              <div className="dsh-native-row-body">
                <fieldset className="dsh-native-scopes" disabled={disabled}><legend>{t('accessMode', { name: tool.name })}</legend><label><input type="radio" name={`${prefix}-${tool.name}-access`} checked={!override} onChange={() => updateToolOverride(tool, null)} /><span>{t('automaticMode')}</span></label><label><input type="radio" name={`${prefix}-${tool.name}-access`} checked={Boolean(override)} onChange={() => updateToolOverride(tool, automaticTypes)} /><span>{t('customMode')}</span></label></fieldset>
                <p className="dsh-help">{t(tool.automaticAccess === 'all' ? 'automaticAllHelp' : 'automaticMainHelp')}</p>
                {override ? <>
                  <p className="dsh-help">{t('customHelp')}</p>
                  {changed && <div className="dsh-native-problem"><p>{t('changedOverrideHelp')}</p><ActionButton reason={disabledReason} type="button" className="text-button" disabled={disabled} onClick={() => updateToolOverride(tool, override.agentTypeIds)}>{t('reviewTool')}</ActionButton></div>}
                  {scopes(override.agentTypeIds, ids => updateToolOverride(tool, ids), t('customToolScope', { name: tool.name }))}
                </> : tool.automaticAccess === 'main' && scopes(changed ? [] : children, ids => { markDirty(); setDraft({ ...draft, toolGrants: [...draft.toolGrants.filter(row => row.name !== tool.name), { name: tool.name, fingerprint: tool.fingerprint, agentTypeIds: ids }] }) }, t('toolScope', { name: tool.name }), true)}
              </div>
            </details>
          </div>
        })}
        {tools.length === 0 && <p className="dsh-help">{t(snapshot.catalog.tools.length ? 'noMatches' : 'noTools')}</p>}
        {draft.toolAccessOverrides?.filter(override => !snapshot.catalog.tools.some(tool => tool.name === override.name)).map(override => <div className="dsh-native-row dsh-native-stale" key={override.name}><code>{override.name}</code><span>{t('missingOverrideHelp')}</span><ActionButton reason={disabledReason} type="button" className="text-button" disabled={disabled} onClick={() => { markDirty(); setDraft({ ...draft, toolAccessOverrides: draft.toolAccessOverrides?.filter(row => row.name !== override.name) }) }}>{t('restoreAutomatic')}</ActionButton></div>)}
        {draft.toolGrants.filter(grant => grant.agentTypeIds.some(id => id !== 'main') && !snapshot.catalog.tools.some(tool => tool.name === grant.name)).map(grant => <div className="dsh-native-row dsh-native-stale" key={grant.name}><code>{grant.name}</code><span>{t('changed')}</span><ActionButton reason={disabledReason} type="button" className="text-button" disabled={disabled} onClick={() => { markDirty(); setDraft({ ...draft, toolGrants: draft.toolGrants.filter(row => row.name !== grant.name) }) }}>{t('disabled')}</ActionButton></div>)}
      </div>
      {tab !== 'plugins' && (
        <FormSaveBar
          className="dsh-native-save"
          alwaysVisible
          dirty={dirty}
          conflict={needsRead}
          uncertain={failure?.key === 'error.unknown'}
          saving={pending === 'save'}
          disabled={disabled || !dirty || hasInvalidFeatureJson}
          disabledReason={disabled ? disabledReason : hasInvalidFeatureJson ? t('error.invalid') : !dirty ? t('reason.unchanged') : undefined}
          saveLabel={t('save')}
          savingLabel={t('saving')}
          discardLabel={t('discard')}
          reloadLabel={t('refresh')}
          notice={t('independent')}
          onSave={() => void save()}
          onDiscard={discardDraft}
          onReload={() => void read()}
        />
      )}
      <div hidden={tab !== 'plugins'}>
        {bundles.map(row => <div className="dsh-native-row" key={row.name}>
          <div className="dsh-native-row-head">
            <div className="dsh-native-row-copy">
              <strong>{highlightText(nativeLabel(row.title, locale, row.name), query)}</strong>
              <small>{highlightText(row.name, query)}{row.version && ` · ${t('version', { version: row.version })}`}</small>
            </div>
            <div className="dsh-native-row-controls">
              {row.protected ? (
                <span className="dsh-native-state"><LockKeyhole size={13} aria-hidden="true" />{t('required')}</span>
              ) : row.availability !== 'missing' ? (
                <>
                  <span className="dsh-native-state">{t(row.enabled ? 'enabled' : 'disabled')}</span>
                  <Switch
                    compact
                    checked={row.enabled}
                    disabled={disabled}
                    disabledReason={disabledReason}
                    label={t(row.enabled ? 'disableBundle' : 'enableBundle')}
                    aria-label={t(row.enabled ? 'disableBundle' : 'enableBundle')}
                    onChange={checked => void perform('bundle', { requestId: createRequestId(), name: row.name, enabled: checked, expectedFingerprint: row.fingerprint })}
                  />
                </>
              ) : (
                <span className="dsh-native-state">{t('sourceMissing')}</span>
              )}
            </div>
          </div>
          <details className="dsh-native-row-details">
            <summary><ChevronDown size={15} aria-hidden="true" /><span>{t('detailsBundleToggle')}</span></summary>
            <div className="dsh-native-row-body">
              <p className="dsh-help">{t('allInstance')} · {t(row.official ? 'sourceOfficial' : row.availability === 'profile' ? 'sourceProfile' : row.availability === 'installation' ? 'sourceInstallation' : 'sourceMissing')}</p>
              {row.description && <p className="dsh-help">{highlightText(nativeLabel(row.description, locale, ''), query)}</p>}
              {row.errorCode && <p className="dsh-native-problem">{t('code', { code: row.errorCode })}</p>}
              <ul className="dsh-native-modules">{row.rows.map(module => <li key={module.id}><code>{highlightText(module.name, query)}</code></li>)}</ul>{row.overrides.length > 0 && <p className="dsh-help">{t('overrides')}：{row.overrides.join(', ')}</p>}
              {row.protected ? <p className="dsh-help">{t('requiredHelp')}</p> : <div className="dsh-capability-actions">{row.removable && <ActionButton reason={disabledReason || t('reason.disableFirst')} type="button" className="text-button" disabled={disabled || row.enabled} onClick={() => setRemoving(row.name)}>{t('remove')}</ActionButton>}{row.installTarget && row.availability === 'missing' && <ActionButton reason={disabledReason} type="button" className="button button-secondary" disabled={disabled} onClick={() => { setSpec(row.installTarget!); setInspection(null); setTrusted(false) }}>{t('installTitle')}</ActionButton>}</div>}
              {row.removable && <p className="dsh-help">{t('removeHelp')}</p>}
              {!row.protected && (
                <InlineConfirm
                  open={removing === row.name}
                  variant="danger"
                  title={t('confirmRemove', { name: row.name })}
                  description={t('removeHelp')}
                  confirmLabel={t('remove')}
                  cancelLabel={t('cancel')}
                  busy={disabled}
                  confirmDisabled={disabled || row.enabled}
                  confirmReason={disabled ? disabledReason : t('reason.disableFirst')}
                  onConfirm={() => void perform('remove', { requestId: createRequestId(), name: row.name, confirmed: true, expectedFingerprint: row.fingerprint })}
                  onCancel={() => setRemoving(null)}
                />
              )}
            </div>
          </details>
        </div>)}
        {plugins.map(row => {
          const moduleText = moduleTexts[row.entryId] ?? ''
          const moduleCheck = moduleText.trim() ? inspectJsonObject(moduleText) : null
          const moduleEditorId = `${prefix}-module-config-${row.entryId}`
          return <div className="dsh-native-row" key={row.entryId}>
            <div className="dsh-native-row-head">
              <div className="dsh-native-row-copy">
                <strong>{highlightText(nativeLabel(row.title, locale, row.moduleName), query)}</strong>
                <small>{highlightText(row.moduleName, query)}</small>
              </div>
              <div className="dsh-native-row-controls">
                <span className="dsh-native-state">{row.protected ? t('required') : phase(row.enabled, row.phase)}</span>
                {!row.protected && row.manageable && (
                  <Switch
                    compact
                    checked={row.enabled}
                    disabled={disabled}
                    disabledReason={disabledReason}
                    label={t(row.enabled ? 'disableModule' : 'enableModule')}
                    aria-label={t(row.enabled ? 'disableModule' : 'enableModule')}
                    onChange={checked => void perform('plugin', { requestId: createRequestId(), entryId: row.entryId, enabled: checked, expectedFingerprint: row.fingerprint })}
                  />
                )}
              </div>
            </div>
            <details className="dsh-native-row-details">
              <summary><ChevronDown size={15} aria-hidden="true" /><span>{t('detailsPluginToggle')}</span></summary>
              <div className="dsh-native-row-body">
                <p className="dsh-help">{t('allInstance')} · {t(row.configured ? 'configured' : 'unconfigured')}</p>
                {!snapshot.catalog.runtime.running && <p className="dsh-help">{t('inspected')} · {phase(row.enabled, row.observedPhase)}</p>}
                {row.protected ? <p className="dsh-help">{t('requiredHelp')}</p> : row.manageable && <>
                  <div className="dsh-native-preserve-banner"><Info size={15} aria-hidden="true" /><span>{t('pluginConfigPreserveNotice')}</span></div>
                  <div className="dsh-native-editor">
                    <div className="dsh-native-editor-head">
                      <label htmlFor={moduleEditorId}>{t('pluginConfig')}</label>
                      {moduleCheck && (
                        <div className="dsh-native-editor-actions">
                          <span className={`dsh-json-badge ${moduleCheck.valid ? 'is-valid' : 'is-invalid'}`}>{t(moduleCheck.valid ? 'jsonValid' : 'jsonInvalid')}</span>
                          <ActionButton
                            type="button"
                            className="text-button"
                            disabled={disabled || !moduleCheck.valid || moduleCheck.formatted === moduleText}
                            reason={disabled ? disabledReason : !moduleCheck.valid ? t('jsonInvalidInline') : t('reason.unchanged')}
                            onClick={() => { if (moduleCheck.formatted !== null) setModuleTexts(current => ({ ...current, [row.entryId]: moduleCheck.formatted! })) }}>
                            <Wand2 size={13} aria-hidden="true" />
                            {t('formatJson')}
                          </ActionButton>
                        </div>
                      )}
                    </div>
                    <textarea id={moduleEditorId} spellCheck={false} autoComplete="off" value={moduleText} disabled={disabled} maxLength={131072} aria-invalid={moduleCheck ? !moduleCheck.valid : false} onChange={event => setModuleTexts(current => ({ ...current, [row.entryId]: event.target.value }))} />
                    {moduleCheck && !moduleCheck.valid && <p className="dsh-native-problem" role="alert">{t('jsonInvalidInline')}</p>}
                  </div>
                  <p className="dsh-help">{t('pluginConfigHelp')}</p>
                  <ActionButton reason={disabledReason || (!moduleText.trim() ? t('reason.configuration') : t('jsonInvalidInline'))} type="button" className="button button-secondary" disabled={disabled || !moduleText.trim() || !moduleCheck?.valid} onClick={() => { try { const config: unknown = JSON.parse(moduleText); if (!nativeObject(config)) throw new Error('config'); void perform('configure', { requestId: createRequestId(), entryId: row.entryId, config: config as JsonObject, expectedFingerprint: row.fingerprint }) } catch { setFailure({ key: 'error.invalid' }) } }}>{t('configure')}</ActionButton>
                </>}
              </div>
            </details>
          </div>
        })}
        {!bundles.length && !plugins.length && <p className="dsh-help">{t('noMatches')}</p>}
        <section className="dsh-native-install" aria-labelledby={`${prefix}-install`}><h4 id={`${prefix}-install`}>{t('installTitle')}</h4><p className="dsh-help">{t('installHelp')}</p><label className="dsh-native-editor"><span>{t('installSpec')}</span><input value={spec} type="text" spellCheck={false} autoComplete="off" maxLength={2048} disabled={disabled} onChange={event => { setSpec(event.target.value); setInspection(null); setTrusted(false); setPendingBuilds([]); setApproveBuilds(false) }} /></label><ActionButton reason={disabledReason || t('reason.source')} type="button" className="button button-secondary" disabled={disabled || !spec.trim()} onClick={() => void perform('inspect', { spec: spec.trim() }, value => { setInspection(value); setInspectedSpec(spec.trim()); setTrusted(false) })}>{t('inspect')}</ActionButton>
          {inspection && <div className="dsh-native-inspection"><p role="status">{t(inspection.status === 'accepted' ? 'accepted' : 'refused', { problem: String(inspection.problem ?? '') })}</p>{typeof inspection.name === 'string' && <p>{t('package')}：<code>{inspection.name}</code>{typeof inspection.version === 'string' && ` · ${t('version', { version: inspection.version })}`}</p>}{inspection.status === 'accepted' && <><label className="dsh-native-base"><input type="checkbox" checked={trusted} disabled={disabled} onChange={event => setTrusted(event.target.checked)} /><span>{t('trust')}</span></label>{pendingBuilds.length > 0 && <><p className="dsh-help">{t('builds', { names: pendingBuilds.join(', ') })}</p><label className="dsh-native-base"><input type="checkbox" checked={approveBuilds} disabled={disabled} onChange={event => setApproveBuilds(event.target.checked)} /><span>{t('approveBuilds')}</span></label></>}<ActionButton reason={disabledReason || (!trusted ? t('reason.trust') : spec.trim() !== inspectedSpec ? t('reason.inspect') : t('reason.builds'))} type="button" className="button button-primary" disabled={disabled || !trusted || spec.trim() !== inspectedSpec || pendingBuilds.length > 0 && !approveBuilds} onClick={() => void perform('install', { requestId: createRequestId(), spec: inspectedSpec, confirmed: true, ...(approveBuilds ? { approvedBuilds: pendingBuilds } : {}) })}>{t('install')}</ActionButton></>}</div>}
        </section>
      </div>
      <section className="dsh-native-mcp" aria-labelledby={`${prefix}-mcp`}><h4 id={`${prefix}-mcp`}>{t('mcpTitle')}</h4>{snapshot.catalog.runtime.agents.length ? <ul>{snapshot.catalog.runtime.agents.map((agent, index) => <li key={index}>{t('mcpAgent', { type: typeTitle(agent.agentTypeId), value: formatNumber(agent.mcpTools.length) })}</li>)}</ul> : <p className="dsh-help">{t('mcpEmpty')}</p>}<a href="#mcp">{t('mcpLink')}</a></section>
    </>}
  </section>
}
