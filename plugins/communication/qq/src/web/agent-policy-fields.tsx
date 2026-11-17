import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { isJsonObject } from '@eating/plugin-sdk'
import type { AgentTypeDefinition, JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'
import { ActionButton, FormSaveBar, getErrorMessage, HostApiError, hostRequest, splitTagTokens, TagChipsInput, translate, useI18n } from '@eating/ui-sdk'
import type { QQAgentTools, QQAgentTypeId } from '../config'
import { toolDescription, toolTitle } from './i18n'
import type { QQTranslationKey } from './i18n'

export interface AgentPolicyDraft {
  owners: string
  administrators: string
  agentTools: QQAgentTools
  expectedRevision: number
}

export function parseIdentityText(text: string): string[] | null {
  const values = text.split(/[\s,，]+/u).filter(Boolean)
  if (values.length > 100 || values.some(value => !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))) return null
  return [...new Set(values)]
}

export function agentPolicyDraft(configuration: unknown, types: readonly AgentTypeDefinition[]): AgentPolicyDraft {
  const invalid = (): never => { throw new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE')) }
  if (!isJsonObject(configuration)) return invalid()
  if (Object.hasOwn(configuration, 'initializationError')) {
    if (Object.keys(configuration).length !== 1 || typeof configuration.initializationError !== 'string' || !configuration.initializationError) return invalid()
    throw new HostApiError('CONFIGURATION_CORRUPTED', configuration.initializationError)
  }
  const identities = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) return invalid()
    return [...value] as string[]
  }
  const names = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name) || new Set(value).size !== value.length) return invalid()
    return [...value] as string[]
  }
  if (!Array.isArray(types) || new Set(types.map(type => type?.id)).size !== types.length) return invalid()
  for (const type of types) {
    if (!isJsonObject(type) || !['qq.private', 'qq.group'].includes(type.id as string) || typeof type.title !== 'string' || !type.title || typeof type.description !== 'string' || typeof type.defaultPrompt !== 'string' || type.conversationKind !== (type.id === 'qq.private' ? 'private' : 'group')
      || type.localizedTitles !== undefined && (!isJsonObject(type.localizedTitles) || Object.values(type.localizedTitles).some(title => typeof title !== 'string'))) return invalid()
    const available = names(type.availableTools)
    if ([...names(type.defaultTools), ...names(type.enabledTools)].some(name => !available.includes(name))) return invalid()
  }
  if (!isJsonObject(configuration.agentTools) || Object.keys(configuration.agentTools).length !== 2 || Object.keys(configuration.agentTools).some(id => !['qq.private', 'qq.group'].includes(id))) return invalid()
  const selections = configuration.agentTools
  const selected = (id: QQAgentTypeId): string[] => {
    const tools = names(selections[id])
    const type = types.find(candidate => candidate.id === id)
    if (type && tools.some(name => !type.availableTools.includes(name))) return invalid()
    return tools
  }
  if (typeof configuration.policyRevision !== 'number' || !Number.isSafeInteger(configuration.policyRevision) || configuration.policyRevision < 0) return invalid()
  return { owners: identities(configuration.owners).join('\n'), administrators: identities(configuration.administrators).join('\n'), agentTools: { 'qq.private': selected('qq.private'), 'qq.group': selected('qq.group') }, expectedRevision: configuration.policyRevision }
}

type ToolCategoryFilter = 'all' | 'readonly' | 'send' | 'group'

const sendToolNames = new Set([
  'qq_send_private_message',
  'qq_send_group_message',
  'qq_send_message',
  'qq_send_like',
  'qq_delete_message',
  'qq_handle_quick_operation',
])

function toolCategory(tool: PluginToolDefinition): Exclude<ToolCategoryFilter, 'all'> {
  if (tool.readOnly && !tool.destructive) return 'readonly'
  if (sendToolNames.has(tool.name)) return 'send'
  return 'group'
}

interface Props {
  configuration: JsonObject
  agentTypes: readonly AgentTypeDefinition[]
  tools: readonly PluginToolDefinition[]
  enabled: boolean
  configurationFailure?: Failure | null
  busy: boolean
  actionLock: MutableRefObject<boolean>
  onBusy: (value: boolean) => void
  onSaved: (configuration: JsonObject) => void
  onFeedback: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
}
interface Failure { code: string; message: string; outcome: string }

export function AgentPolicyFields({ configuration, agentTypes, tools, enabled, configurationFailure, busy, actionLock, onBusy, onSaved, onFeedback, onDirtyChange }: Props) {
  const { t, locale, formatNumber } = useI18n('qq')
  const prefix = useId()
  const reading = useMemo(() => {
    try { return { draft: agentPolicyDraft(configuration, agentTypes), failure: null } }
    catch (error) { return { draft: null, failure: error instanceof HostApiError ? error : new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE')) } }
  }, [configuration, agentTypes])
  const [draft, setDraft] = useState<AgentPolicyDraft | null>(() => reading.draft)
  const [dirty, setDirty] = useState(false)
  const [pendingInputs, setPendingInputs] = useState<{ owners: string; administrators: string }>({ owners: '', administrators: '' })
  const [chipReset, setChipReset] = useState(0)
  const dirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<'owners' | 'administrators', QQTranslationKey>>>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [saved, setSaved] = useState(false)
  const [queries, setQueries] = useState<Record<QQAgentTypeId, string>>({ 'qq.private': '', 'qq.group': '' })
  const [categories, setCategories] = useState<Record<QQAgentTypeId, ToolCategoryFilter>>({ 'qq.private': 'all', 'qq.group': 'all' })
  const alive = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const callbacks = useRef({ onBusy, onDirtyChange })
  callbacks.current = { onBusy, onDirtyChange }
  const effectiveDirty = dirty || Boolean(pendingInputs.owners.trim()) || Boolean(pendingInputs.administrators.trim())
  useEffect(() => {
    callbacks.current.onDirtyChange?.(effectiveDirty)
  }, [effectiveDirty])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      controller.current?.abort()
      if (controller.current) { actionLock.current = false; callbacks.current.onBusy(false) }
      callbacks.current.onDirtyChange?.(false)
    }
  }, [actionLock])
  useEffect(() => { if (!dirtyRef.current && reading.draft) setDraft(reading.draft) }, [reading])

  function update(next: AgentPolicyDraft) {
    setDraft(next); dirtyRef.current = true; setDirty(true); setSaved(false)
  }
  async function discard() {
    if (actionLock.current) return
    const pending = new AbortController(); controller.current = pending
    actionLock.current = true; setReloading(true); onBusy(true)
    try {
      const response = await hostRequest<JsonObject>('/plugins/qq/configuration', { signal: pending.signal })
      if (!alive.current || pending.signal.aborted) return
      setDraft(agentPolicyDraft(response, agentTypes))
      dirtyRef.current = false; setDirty(false)
      setPendingInputs({ owners: '', administrators: '' })
      setChipReset(count => count + 1)
      setErrors({}); setFailure(null); setSaved(false)
      onSaved(response)
    } catch (error) {
      if (alive.current && !pending.signal.aborted) setFailure(error instanceof HostApiError ? error : { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : '', outcome: 'not-sent' })
    } finally {
      if (controller.current === pending) { controller.current = null; actionLock.current = false; if (alive.current) { setReloading(false); onBusy(false) } }
    }
  }
  async function save() {
    if (actionLock.current || !enabled || !agentTypes.length || !draft || reading.failure || configurationFailure || failure?.code === 'INVALID_HOST_RESPONSE' || failure?.code === 'CONFIGURATION_CORRUPTED') return
    const mergedOwnersText = [draft.owners, pendingInputs.owners].filter(Boolean).join('\n')
    const mergedAdminsText = [draft.administrators, pendingInputs.administrators].filter(Boolean).join('\n')
    const owners = parseIdentityText(mergedOwnersText)
    const administrators = parseIdentityText(mergedAdminsText)
    const issues: typeof errors = { ...(owners === null ? { owners: 'policy.invalidIdentity' as const } : {}), ...(administrators === null ? { administrators: 'policy.invalidIdentity' as const } : {}) }
    setErrors(issues)
    if (!owners || !administrators) return
    const pending = new AbortController(); controller.current = pending
    actionLock.current = true; setSaving(true); onBusy(true); setFailure(null); setSaved(false)
    try {
      const response = await hostRequest<JsonObject>('/plugins/qq/manage', { method: 'POST', signal: pending.signal, body: { operation: 'save-agent-policy', input: { expectedRevision: draft.expectedRevision, owners, administrators, agentTools: draft.agentTools } } })
      if (!alive.current || pending.signal.aborted) return
      setDraft(agentPolicyDraft(response, agentTypes))
      dirtyRef.current = false; setDirty(false)
      setPendingInputs({ owners: '', administrators: '' })
      setChipReset(count => count + 1)
      setSaved(true)
      onSaved(response); onFeedback(t('policy.saved'))
    } catch (error) {
      if (alive.current && !pending.signal.aborted) setFailure(error instanceof HostApiError ? error : { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : '', outcome: 'not-sent' })
    } finally {
      if (controller.current === pending) { controller.current = null; actionLock.current = false; if (alive.current) { setSaving(false); onBusy(false) } }
    }
  }
  const blocked = busy || saving || reloading
  const unreadable = reading.failure ?? configurationFailure ?? (failure?.code === 'INVALID_HOST_RESPONSE' || failure?.code === 'CONFIGURATION_CORRUPTED' ? failure : null)
  if (unreadable || !draft) return <>
    <div className="section-heading"><h3>{t('tabs.agentPolicy')}</h3><p>{t('policy.description')}</p></div>
    <div className="qq-error" role="alert"><div><p>{getErrorMessage(unreadable)}</p><details><summary>{t('error.details')}</summary><small>{t('error.code', { code: unreadable?.code ?? 'INVALID_HOST_RESPONSE' })}</small>{unreadable?.message && <p>{unreadable.message}</p>}</details></div></div>
    <ActionButton reasonCode="busy" type="button" className="button button-secondary" disabled={blocked} onClick={() => void discard()}>{t(reloading ? 'policy.reloading' : 'policy.discard')}</ActionButton>
  </>
  const visibleTypes = agentTypes.filter(type => type.id === 'qq.private' || type.id === 'qq.group')
  const conflict = failure?.code === 'AGENT_POLICY_CONFLICT'
  const validateChip = (item: string) => (/^[1-9]\d{0,15}$/.test(item) && Number.isSafeInteger(Number(item)) ? null : t('policy.itemInvalid'))
  const categoryOptions: readonly { id: ToolCategoryFilter; key: QQTranslationKey }[] = [
    { id: 'all', key: 'policy.filterAll' },
    { id: 'readonly', key: 'policy.filterReadonly' },
    { id: 'send', key: 'policy.filterSend' },
    { id: 'group', key: 'policy.filterGroup' },
  ]

  return <>
    <div className="section-heading"><h3>{t('tabs.agentPolicy')}</h3><p>{t('policy.description')}</p></div>
    <form noValidate onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="qq-fieldset form-fields" disabled={blocked}>
        {(['owners', 'administrators'] as const).map(field => <div className={`field${errors[field] ? ' field-invalid' : ''}`} key={field}>
          <label htmlFor={`${prefix}-${field}`}>{t(`policy.${field}.label`)}</label>
          <div className="qq-chip-field-body">
            <TagChipsInput
              key={`${field}-${chipReset}`}
              id={`${prefix}-${field}`}
              values={splitTagTokens(draft[field], 'line-comma-space')}
              delimiter="line-comma-space"
              maxItems={100}
              disabled={blocked}
              placeholder={t(`policy.${field}.placeholder`)}
              addLabel={t('policy.addIdentity')}
              validateItem={validateChip}
              aria-describedby={`${prefix}-${field}-help${errors[field] ? ` ${prefix}-${field}-error` : ''}`}
              onPendingInputChange={next => {
                setPendingInputs(current => ({ ...current, [field]: next }))
                setErrors(current => ({ ...current, [field]: undefined }))
              }}
              onChange={chips => {
                update({ ...draft, [field]: chips.join('\n') })
                setErrors(current => ({ ...current, [field]: undefined }))
              }}
            />
          </div>
          <p className="field-hint" id={`${prefix}-${field}-help`}>{t(`policy.${field}.help`)}</p>
          {errors[field] && <p className="field-error" id={`${prefix}-${field}-error`}>{t(errors[field])}</p>}
        </div>)}
        <p className="qq-policy-notice">{t('policy.identityHelp')}</p>
        <div className="qq-agent-types">{visibleTypes.map(type => {
          const id = type.id as QQAgentTypeId
          const available = type.availableTools.map(name => tools.find(tool => tool.name === name)).filter((tool): tool is PluginToolDefinition => Boolean(tool))
          const query = queries[id].trim().toLowerCase()
          const category = categories[id]
          const filtered = available.filter(tool => {
            if (category !== 'all' && toolCategory(tool) !== category) return false
            if (!query) return true
            return toolTitle(tool).toLowerCase().includes(query) || toolDescription(tool).toLowerCase().includes(query) || tool.name.toLowerCase().includes(query)
          })
          const isFiltered = query.length > 0 || category !== 'all'
          return <fieldset key={id} className="qq-agent-type">
            <legend>{type.localizedTitles?.[locale] ?? type.title}</legend>
            <p>{t(id === 'qq.private' ? 'policy.private.help' : 'policy.group.help')}</p>
            <div className="qq-policy-toolbar">
              <div className="qq-policy-tools-heading">
                <span>
                  {t('policy.selected', { selected: formatNumber(draft.agentTools[id].length), total: formatNumber(available.length) })}
                  {isFiltered ? ` · ${t('policy.visibleCount', { visible: formatNumber(filtered.length) })}` : ''}
                </span>
                <div>
                  <ActionButton reasonCode="busy" disabled={blocked} className="text-button" type="button" onClick={() => update({ ...draft, agentTools: { ...draft.agentTools, [id]: available.map(tool => tool.name) } })}>{t('policy.allowAll')}</ActionButton>
                  <ActionButton reasonCode="busy" disabled={blocked} className="text-button" type="button" onClick={() => update({ ...draft, agentTools: { ...draft.agentTools, [id]: [...type.defaultTools] } })}>{t('policy.defaults')}</ActionButton>
                  <ActionButton reasonCode={blocked ? 'busy' : 'empty'} disabled={blocked || draft.agentTools[id].length === 0} className="text-button" type="button" onClick={() => update({ ...draft, agentTools: { ...draft.agentTools, [id]: [] } })}>{t('policy.clear')}</ActionButton>
                </div>
              </div>
              <div className="qq-policy-filter-row">
                <input
                  type="search"
                  className="qq-policy-search"
                  value={queries[id]}
                  placeholder={t('policy.searchPlaceholder')}
                  aria-label={`${type.localizedTitles?.[locale] ?? type.title} ${t('policy.searchLabel')}`}
                  onChange={event => setQueries(current => ({ ...current, [id]: event.target.value }))}
                />
                <div className="qq-filter-pills" role="group" aria-label={t('policy.filterLabel')}>
                  {categoryOptions.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`qq-filter-pill${category === opt.id ? ' is-selected' : ''}`}
                      aria-pressed={category === opt.id}
                      onClick={() => setCategories(current => ({ ...current, [id]: opt.id }))}>
                      {t(opt.key)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="qq-policy-empty-filter">
                <p>{t('policy.noMatch')}</p>
                <button type="button" className="text-button" onClick={() => { setQueries(current => ({ ...current, [id]: '' })); setCategories(current => ({ ...current, [id]: 'all' })) }}>{t('logs.clearFilters')}</button>
              </div>
            ) : (
              <div className="qq-policy-tools">{filtered.map(tool => <label className="qq-policy-tool" key={tool.name}>
                <input type="checkbox" checked={draft.agentTools[id].includes(tool.name)} onChange={event => update({ ...draft, agentTools: { ...draft.agentTools, [id]: event.target.checked ? [...draft.agentTools[id], tool.name] : draft.agentTools[id].filter(name => name !== tool.name) } })} />
                <span><strong>{toolTitle(tool)}</strong><small>{toolDescription(tool)}</small>{(!tool.readOnly || tool.destructive) && <small className="qq-policy-action">{t('policy.realAction')}</small>}</span>
              </label>)}</div>
            )}
          </fieldset>
        })}</div>
      </fieldset>
      {!visibleTypes.length && <p className="qq-empty" role="status">{t('policy.empty')}</p>}
      {!enabled && <p className="qq-help">{t('policy.disabled')}</p>}
      <p className="qq-help">{t('policy.applyHelp')}</p>
      {failure && <div className="qq-error" role="alert"><div><p>{conflict ? t('policy.conflict') : getErrorMessage(failure, t('policy.saveFailed'))}</p><details><summary>{t('error.details')}</summary><small>{t('error.code', { code: failure.code })}</small><p>{failure.message}</p></details></div></div>}
      <FormSaveBar
        alwaysVisible
        dirty={effectiveDirty}
        saving={saving}
        disabled={blocked || !enabled || !visibleTypes.length || !effectiveDirty || conflict}
        disabledReason={blocked ? undefined : !enabled ? t('policy.disabled') : !visibleTypes.length ? t('policy.empty') : conflict ? t('policy.conflict') : undefined}
        conflict={conflict}
        saveLabel={t('policy.save')}
        savingLabel={t('action.saving')}
        discardLabel={t('policy.discard')}
        reloadLabel={reloading ? t('policy.reloading') : t('policy.discard')}
        onSave={() => void save()}
        onDiscard={conflict ? undefined : () => void discard()}
        onReload={() => void discard()}
        extraActions={!conflict && !effectiveDirty && failure ? <ActionButton reasonCode={blocked ? 'busy' : 'read'} type="button" className="button button-secondary" disabled={blocked} onClick={() => void discard()}>{t(reloading ? 'policy.reloading' : 'policy.discard')}</ActionButton> : undefined}
      />
      {saved && <p className="qq-operation-result" role="status">{t('policy.saved')}</p>}
    </form>
  </>
}
