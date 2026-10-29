import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { isJsonObject } from '@eating/plugin-sdk'
import type { AgentTypeDefinition, JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'
import { getErrorMessage, HostApiError, hostRequest, translate, useI18n } from '@eating/ui-sdk'
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
}
interface Failure { code: string; message: string; outcome: string }

export function AgentPolicyFields({ configuration, agentTypes, tools, enabled, configurationFailure, busy, actionLock, onBusy, onSaved, onFeedback }: Props) {
  const { t, locale, formatNumber } = useI18n('qq')
  const prefix = useId()
  const reading = useMemo(() => {
    try { return { draft: agentPolicyDraft(configuration, agentTypes), failure: null } }
    catch (error) { return { draft: null, failure: error instanceof HostApiError ? error : new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE')) } }
  }, [configuration, agentTypes])
  const [draft, setDraft] = useState<AgentPolicyDraft | null>(() => reading.draft)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<'owners' | 'administrators', QQTranslationKey>>>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [saved, setSaved] = useState(false)
  const alive = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const onBusyRef = useRef(onBusy)
  onBusyRef.current = onBusy
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); if (controller.current) { actionLock.current = false; onBusyRef.current(false) } } }, [actionLock])
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
      setDraft(agentPolicyDraft(response, agentTypes)); dirtyRef.current = false; setDirty(false); setErrors({}); setFailure(null); setSaved(false)
      onSaved(response)
    } catch (error) {
      if (alive.current && !pending.signal.aborted) setFailure(error instanceof HostApiError ? error : { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : '', outcome: 'not-sent' })
    } finally {
      if (controller.current === pending) { controller.current = null; actionLock.current = false; if (alive.current) { setReloading(false); onBusy(false) } }
    }
  }
  async function save() {
    if (actionLock.current || !enabled || !agentTypes.length || !draft || reading.failure || configurationFailure || failure?.code === 'INVALID_HOST_RESPONSE' || failure?.code === 'CONFIGURATION_CORRUPTED') return
    const owners = parseIdentityText(draft.owners)
    const administrators = parseIdentityText(draft.administrators)
    const issues: typeof errors = { ...(owners === null ? { owners: 'policy.invalidIdentity' as const } : {}), ...(administrators === null ? { administrators: 'policy.invalidIdentity' as const } : {}) }
    setErrors(issues)
    if (!owners || !administrators) return
    const pending = new AbortController(); controller.current = pending
    actionLock.current = true; setSaving(true); onBusy(true); setFailure(null); setSaved(false)
    try {
      const response = await hostRequest<JsonObject>('/plugins/qq/manage', { method: 'POST', signal: pending.signal, body: { operation: 'save-agent-policy', input: { expectedRevision: draft.expectedRevision, owners, administrators, agentTools: draft.agentTools } } })
      if (!alive.current || pending.signal.aborted) return
      setDraft(agentPolicyDraft(response, agentTypes)); dirtyRef.current = false; setDirty(false); setSaved(true)
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
    <button type="button" className="button button-secondary" disabled={blocked} onClick={() => void discard()}>{t(reloading ? 'policy.reloading' : 'policy.discard')}</button>
  </>
  const visibleTypes = agentTypes.filter(type => type.id === 'qq.private' || type.id === 'qq.group')
  return <>
    <div className="section-heading"><h3>{t('tabs.agentPolicy')}</h3><p>{t('policy.description')}</p></div>
    <form noValidate onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="qq-fieldset form-fields" disabled={blocked}>
        {(['owners', 'administrators'] as const).map(field => <div className={`field${errors[field] ? ' field-invalid' : ''}`} key={field}>
          <label htmlFor={`${prefix}-${field}`}>{t(`policy.${field}.label`)}</label>
          <textarea id={`${prefix}-${field}`} rows={3} maxLength={1800} autoComplete="off" spellCheck={false} value={draft[field]} aria-invalid={Boolean(errors[field])} aria-describedby={`${prefix}-${field}-help${errors[field] ? ` ${prefix}-${field}-error` : ''}`} onChange={event => { update({ ...draft, [field]: event.target.value }); setErrors(current => ({ ...current, [field]: undefined })) }} />
          <p className="field-hint" id={`${prefix}-${field}-help`}>{t(`policy.${field}.help`)}</p>
          {errors[field] && <p className="field-error" id={`${prefix}-${field}-error`}>{t(errors[field])}</p>}
        </div>)}
        <p className="qq-policy-notice">{t('policy.identityHelp')}</p>
        <div className="qq-agent-types">{visibleTypes.map(type => {
          const id = type.id as QQAgentTypeId
          const available = type.availableTools.map(name => tools.find(tool => tool.name === name)).filter((tool): tool is PluginToolDefinition => Boolean(tool))
          return <fieldset key={id} className="qq-agent-type">
            <legend>{type.localizedTitles?.[locale] ?? type.title}</legend>
            <p>{t(id === 'qq.private' ? 'policy.private.help' : 'policy.group.help')}</p>
            <div className="qq-policy-tools-heading"><span>{t('policy.selected', { selected: formatNumber(draft.agentTools[id].length), total: formatNumber(available.length) })}</span><div>
              <button className="text-button" type="button" onClick={() => update({ ...draft, agentTools: { ...draft.agentTools, [id]: [...type.defaultTools] } })}>{t('policy.defaults')}</button>
              <button className="text-button" type="button" onClick={() => update({ ...draft, agentTools: { ...draft.agentTools, [id]: [] } })}>{t('policy.clear')}</button>
            </div></div>
            <div className="qq-policy-tools">{available.map(tool => <label className="qq-policy-tool" key={tool.name}>
              <input type="checkbox" checked={draft.agentTools[id].includes(tool.name)} onChange={event => update({ ...draft, agentTools: { ...draft.agentTools, [id]: event.target.checked ? [...draft.agentTools[id], tool.name] : draft.agentTools[id].filter(name => name !== tool.name) } })} />
              <span><strong>{toolTitle(tool)}</strong><small>{toolDescription(tool)}</small>{(!tool.readOnly || tool.destructive) && <small className="qq-policy-action">{t('policy.realAction')}</small>}</span>
            </label>)}</div>
          </fieldset>
        })}</div>
      </fieldset>
      {!visibleTypes.length && <p className="qq-empty" role="status">{t('policy.empty')}</p>}
      {!enabled && <p className="qq-help">{t('policy.disabled')}</p>}
      <p className="qq-help">{t('policy.applyHelp')}</p>
      {failure && <div className="qq-error" role="alert"><div><p>{failure.code === 'AGENT_POLICY_CONFLICT' ? t('policy.conflict') : getErrorMessage(failure, t('policy.saveFailed'))}</p><details><summary>{t('error.details')}</summary><small>{t('error.code', { code: failure.code })}</small><p>{failure.message}</p></details></div></div>}
      <div className="qq-actions"><button type="submit" className="button button-primary" disabled={blocked || !enabled || !visibleTypes.length || !dirty || failure?.code === 'AGENT_POLICY_CONFLICT'}>{t(saving ? 'action.saving' : 'policy.save')}</button>
        <button type="button" className="button button-secondary" disabled={blocked || !dirty && !failure} onClick={() => void discard()}>{t(reloading ? 'policy.reloading' : 'policy.discard')}</button>
        <span className="save-indicator">{t(dirty ? 'policy.dirty' : 'policy.current')}</span>
      </div>
      {saved && <p className="qq-operation-result" role="status">{t('policy.saved')}</p>}
    </form>
  </>
}
