import { useEffect, useId, useRef, useState } from 'react'
import { RefreshCw, Search, UserRound, Users, X } from 'lucide-react'
import { ActionButton, hostRequest, useI18n } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, ProactiveChannel, ProactiveContact, ProactiveContactEntry, ProactiveContactPolicy } from '@eating/plugin-sdk'
import { channelKey } from './autonomy-data'
import './AutonomyContacts.css'
const identity = (entry: ProactiveContactEntry) => JSON.stringify([entry.pluginId, entry.instanceId, entry.accountId, entry.agentTypeId, entry.targetId])
const accountKey = (entry: Pick<ProactiveChannel, 'pluginId' | 'instanceId' | 'accountId'>) => JSON.stringify([entry.pluginId, entry.instanceId, entry.accountId])
export function AutonomyContacts({ harnessId, value, channels, active, disabled, configurationRevision, activityRevision, onSave, onDirtyChange }: {
  readonly harnessId: string; readonly value: ProactiveContactPolicy; readonly channels: readonly ProactiveChannel[]; readonly active: boolean; readonly disabled: boolean
  readonly configurationRevision: number; readonly activityRevision: number; readonly onSave: (input: JsonObject) => Promise<unknown>; readonly onDirtyChange: (dirty: boolean) => void
}) {
  const { t, formatNumber } = useI18n('autonomy'), prefix = useId()
  const [mode, setMode] = useState(value.mode), [entries, setEntries] = useState<ProactiveContactEntry[]>(() => structuredClone([...value.entries]))
  const [account, setAccount] = useState(''), [kind, setKind] = useState<'private' | 'group'>('private'), [query, setQuery] = useState(''), [manual, setManual] = useState('')
  const [directories, setDirectories] = useState<Record<string, readonly ProactiveContact[]>>({}), [loading, setLoading] = useState(false), [failure, setFailure] = useState(''), [revision, setRevision] = useState(value.revision)
  const dirty = mode !== value.mode || JSON.stringify(entries) !== JSON.stringify(value.entries), dirtyRef = useRef(dirty), base = useRef(value.revision), request = useRef<AbortController | null>(null), issue = useRef<HTMLParagraphElement | null>(null)
  const latest = useRef({ channels, active, disabled }); latest.current = { channels, active, disabled }; dirtyRef.current = dirty
  const accounts = [...new Map(channels.map(channel => [accountKey(channel), channel])).values()]
  const currentAccount = accounts.some(channel => accountKey(channel) === account) ? account : accounts[0] ? accountKey(accounts[0]) : ''
  const channel = channels.find(channel => accountKey(channel) === currentAccount && channel.kind === kind), scope = channel ? channelKey(channel) : ''
  const conflicted = dirty && base.current !== value.revision
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => { if (!dirtyRef.current) { base.current = value.revision; setRevision(value.revision); setMode(value.mode); setEntries(structuredClone([...value.entries])) } }, [value])
  useEffect(() => { const protect = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault() }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect) }, [])
  useEffect(() => { const hide = () => { if (document.hidden) { request.current?.abort(); setLoading(false) } }; document.addEventListener('visibilitychange', hide); return () => { request.current?.abort(); document.removeEventListener('visibilitychange', hide) } }, [])
  async function readContacts() {
    const current = latest.current.channels.find(channel => channelKey(channel) === scope)
    if (!current || !latest.current.active || latest.current.disabled || document.hidden) return
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setFailure('')
    try {
      const value = await hostRequest<unknown>('/autonomy', { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), body: { harnessId, operation: 'list-contacts', input: { pluginId: current.pluginId, instanceId: current.instanceId, accountId: current.accountId, agentTypeId: current.agentTypeId } } })
      if (controller.signal.aborted || document.hidden || request.current !== controller) return
      if (!isJsonObject(value) || !isJsonObject(value.contactDirectory) || channelKey(value.contactDirectory as unknown as ProactiveChannel) !== scope || !Array.isArray(value.contactDirectory.contacts) || value.contactDirectory.contacts.length > 1000 || value.contactDirectory.contacts.some(row => !isJsonObject(row) || typeof row.id !== 'string' || typeof row.name !== 'string')) throw new Error('Invalid contact directory')
      const contacts = value.contactDirectory.contacts as unknown as ProactiveContact[]
      setDirectories(previous => ({ ...Object.fromEntries(Object.entries(previous).slice(-19)), [scope]: contacts }))
    } catch { if (!controller.signal.aborted) setFailure('policy.readFailed') }
    finally { if (request.current === controller) { request.current = null; setLoading(false) } }
  }
  useEffect(() => { request.current?.abort(); setLoading(false); if (active && scope && mode !== 'all' && !directories[scope]) void readContacts(); return () => request.current?.abort() }, [harnessId, scope, active, mode])
  const list = directories[scope] ?? [], selected = new Set(entries.map(identity))
  const filtered = list.filter(entry => `${entry.name} ${entry.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const entryFrom = (contact: ProactiveContact): ProactiveContactEntry => ({ pluginId: channel!.pluginId, instanceId: channel!.instanceId, accountId: channel!.accountId, agentTypeId: channel!.agentTypeId, targetId: contact.id, label: (contact.name || contact.id).slice(0, 80) })
  const toggle = (contact: ProactiveContact) => { const entry = entryFrom(contact), key = identity(entry); setEntries(current => selected.has(key) ? current.filter(item => identity(item) !== key) : [...current, entry]); setFailure('') }
  const reset = () => { base.current = value.revision; setRevision(value.revision); setMode(value.mode); setEntries(structuredClone([...value.entries])); setFailure('') }
  function addManual() {
    if (!channel || disabled) return
    const ids = manual.trim().split(/[\s,，;；]+/).filter(Boolean)
    if (!ids.length || ids.some(id => !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) { setFailure('policy.invalidIds'); requestAnimationFrame(() => issue.current?.focus()); return }
    const next = [...entries], seen = new Set(next.map(identity))
    for (const id of ids) { const entry = entryFrom({ id, name: list.find(contact => contact.id === id)?.name || id }); if (!seen.has(identity(entry))) { next.push(entry); seen.add(identity(entry)) } }
    if (next.length > 1000) { setFailure('policy.tooMany'); return }
    setEntries(next); setManual(''); setFailure('')
  }
  async function save() {
    if (entries.length > 1000) { setFailure('policy.tooMany'); return }
    const result = await onSave({ expectedRevision: revision, expectedConfigurationRevision: configurationRevision, expectedActivityRevision: activityRevision, mode, entries: entries as unknown as JsonObject[] })
    if (result) { base.current = value.revision + 1; setRevision(value.revision + 1); setFailure('') }
  }
  return <section className="autonomy-contact-policy" aria-labelledby={`${prefix}-title`}>
    <div className="autonomy-section-heading"><div><h3 id={`${prefix}-title`} tabIndex={-1}>{t('policy.title')}</h3><p className="autonomy-field-hint">{t('policy.description')}</p></div></div>
    <fieldset className="autonomy-policy-modes" disabled={disabled}><legend>{t('policy.mode')}</legend>{(['all', 'allowlist', 'denylist'] as const).map(option => <label key={option} className={mode === option ? 'is-selected' : ''}><input type="radio" name={`${prefix}-mode`} value={option} checked={mode === option} onChange={() => { setMode(option); setFailure('') }} /><span>{t(`policy.mode.${option}`)}</span></label>)}</fieldset>
    <p className={`autonomy-policy-help${mode !== 'allowlist' ? ' is-broad' : ''}`}>{t(`policy.help.${mode}`)}</p>
    {mode !== 'all' && <>
      <div className="autonomy-policy-account">{accounts.length > 1 ? <><label htmlFor={`${prefix}-account`}>{t('policy.account')}</label><select id={`${prefix}-account`} value={currentAccount} disabled={disabled} onChange={event => { setAccount(event.target.value); setQuery('') }}>{accounts.map(channel => <option key={accountKey(channel)} value={accountKey(channel)}>{channel.pluginName} · {channel.accountId}</option>)}</select></> : <p>{accounts[0] ? `${accounts[0].pluginName} · ${accounts[0].accountId}` : t('policy.offline')}</p>}<ActionButton type="button" className="text-button" reasonCode={loading || disabled ? 'busy' : 'connect'} disabled={disabled || loading || !channel} onClick={() => void readContacts()}><RefreshCw size={14} aria-hidden="true" />{t(loading ? 'policy.reading' : 'policy.refresh')}</ActionButton></div>
      <div className="autonomy-policy-toolbar"><div className="autonomy-policy-kinds" role="tablist" aria-label={t('policy.objectType')}>{(['private', 'group'] as const).map(option => <ActionButton reasonCode="busy" key={option} type="button" role="tab" id={`${prefix}-kind-${option}`} tabIndex={kind === option ? 0 : -1} aria-selected={kind === option} aria-controls={`${prefix}-objects`} disabled={disabled} onClick={() => { setKind(option); setQuery('') }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'private' : event.key === 'End' ? 'group' : option === 'private' ? 'group' : 'private'; setKind(next); setQuery(''); document.getElementById(`${prefix}-kind-${next}`)?.focus() } }}>{option === 'private' ? <UserRound size={16} aria-hidden="true" /> : <Users size={16} aria-hidden="true" />}{t(`policy.kind.${option}`)}</ActionButton>)}</div><label className="autonomy-policy-search"><Search size={15} aria-hidden="true" /><input aria-label={t('policy.search')} type="search" value={query} placeholder={t('policy.search')} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="autonomy-policy-object-list" id={`${prefix}-objects`} role="tabpanel" aria-labelledby={`${prefix}-kind-${kind}`}>{loading ? <p className="autonomy-field-hint" role="status">{t('policy.reading')}</p> : filtered.length ? filtered.map(contact => { const entry = entryFrom(contact); return <label key={contact.id} className={selected.has(identity(entry)) ? 'is-selected' : ''}><input type="checkbox" checked={selected.has(identity(entry))} disabled={disabled} onChange={() => toggle(contact)} /><span><strong>{contact.name || contact.id}</strong><small>{contact.id}</small></span></label> }) : <p className="autonomy-field-hint">{t(!channel ? 'policy.offline' : query ? 'policy.noMatches' : 'policy.emptyDirectory')}</p>}</div>
      {!channel && <a className="text-button" href="#robots">{t('contact.openConnection')}</a>}
      <details className="autonomy-policy-manual"><summary>{t('policy.manual')}</summary><label htmlFor={`${prefix}-manual`}>{t(kind === 'private' ? 'policy.privateIds' : 'policy.groupIds')}</label><textarea id={`${prefix}-manual`} rows={3} maxLength={20000} inputMode="numeric" disabled={disabled || !channel} value={manual} onChange={event => setManual(event.target.value)} /><p className="autonomy-field-hint">{t('policy.idsHelp')}</p><ActionButton type="button" className="button button-secondary" reasonCode={disabled ? 'busy' : !channel ? 'connect' : 'empty'} disabled={disabled || !channel || !manual.trim()} onClick={addManual}>{t('policy.addIds')}</ActionButton></details>
      <div className="autonomy-policy-selected"><div><strong>{t('policy.selected', { value: formatNumber(entries.length) })}</strong><ActionButton type="button" className="text-button" reasonCode={disabled ? 'busy' : 'empty'} disabled={disabled || !entries.length} onClick={() => setEntries([])}>{t('policy.clear')}</ActionButton></div><p className="autonomy-field-hint">{t(mode === 'allowlist' ? 'policy.selectedAllow' : 'policy.selectedDeny')}</p><ul>{entries.map(entry => <li key={identity(entry)}><span>{entry.label}<small>{channels.find(channel => channelKey(channel) === channelKey(entry))?.title || entry.accountId} · {entry.targetId}</small></span><ActionButton type="button" className="icon-button" reasonCode="busy" disabled={disabled} aria-label={t('policy.remove', { name: entry.label })} onClick={() => setEntries(current => current.filter(item => identity(item) !== identity(entry)))}><X size={15} aria-hidden="true" /></ActionButton></li>)}</ul></div>
    </>}
    <p className="autonomy-field-hint autonomy-policy-tools">{t('policy.tools')} <a href="#robots">{t('policy.managePermissions')}</a></p>
    {failure && <p className="autonomy-field-error" role="alert" ref={issue} tabIndex={-1}>{t(failure)}</p>}
    {conflicted && <div className="autonomy-group-conflict" role="alert"><p>{t('policy.conflict')}</p><details><summary>{t('policy.latest')}</summary><p>{t(`policy.mode.${value.mode}`)}</p><p>{value.entries.map(entry => `${entry.label} (${entry.targetId})`).join(', ') || t('none')}</p></details><ActionButton type="button" className="text-button" disabled={disabled} reasonCode="busy" onClick={() => { base.current = value.revision; setRevision(value.revision) }}>{t('policy.rebase')}</ActionButton></div>}
    {dirty && <div className="autonomy-policy-save"><p>{t('policy.saveHelp')}</p><div><ActionButton type="button" className="button button-primary" reasonCode={disabled ? 'busy' : 'read'} disabled={disabled || conflicted} onClick={() => void save()}>{t('policy.save')}</ActionButton><ActionButton type="button" className="text-button" reasonCode="busy" disabled={disabled} onClick={reset}>{t('discardShort')}</ActionButton></div></div>}
  </section>
}
