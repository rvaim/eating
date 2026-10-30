import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertCircle, Cable, ChevronDown, LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { McpDirectorySnapshot, McpGrant, McpServiceSummary, PluginToolDefinition } from '@eating/plugin-sdk'
import { getErrorMessage, hostRequest, useI18n } from '@eating/ui-sdk'
import type { HostApiError } from '@eating/ui-sdk'
import { httpSaveInput, readMcpDirectory, readMcpMutationResult, stdioSaveInput } from '../state/mcp'
import type { DirectMcpSaveInput } from '../state/mcp'
import '../i18n/app'
import './Mcp.css'

interface KvRow { readonly key: string; readonly value: string; readonly saved: boolean; readonly clear: boolean }
interface Draft {
  readonly id: string | null
  readonly name: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command: string
  readonly args: string
  readonly url: string
  readonly savedUrl: string
  readonly savedQueryKeys: readonly string[]
  readonly autoConnect: boolean
  readonly grant: McpGrant
  readonly env: readonly KvRow[]
  readonly headers: readonly KvRow[]
}
const emptyGrant = (): McpGrant => ({ agentTypeIds: [], toolNames: [] })
const emptyDraft = (): Draft => ({ id: null, name: '', transport: 'stdio', command: '', args: '', url: '', savedUrl: '', savedQueryKeys: [], autoConnect: false,
  grant: emptyGrant(), env: [], headers: [] })
const stringArray = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const stringValue = (value: unknown): string => typeof value === 'string' ? value : ''
function draftFrom(service: McpServiceSummary): Draft {
  const configuration = service.configuration
  return { id: service.id, name: service.name, transport: service.transport === 'stdio' ? 'stdio' : 'streamable-http',
    command: stringValue(configuration.command), args: stringArray(configuration.args).join('\n'), url: '', savedUrl: stringValue(configuration.url), savedQueryKeys: stringArray(configuration.queryKeys), autoConnect: service.autoConnect,
    grant: { agentTypeIds: [...service.grant.agentTypeIds], toolNames: [...service.grant.toolNames] },
    env: stringArray(configuration.envKeys).map(key => ({ key, value: '', saved: true, clear: false })),
    headers: stringArray(configuration.headerKeys).map(key => ({ key, value: '', saved: true, clear: false })) }
}

export function McpPage({ onFeedback }: { readonly onFeedback: (message: string) => void }) {
  const { t, formatNumber } = useI18n('app')
  const [snapshot, setSnapshot] = useState<McpDirectorySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [editor, setEditor] = useState<Draft | null>(null)
  const mounted = useRef(false)
  const lock = useRef(false)
  const generation = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const actionController = useRef<AbortController | null>(null)
  const feedback = useRef(onFeedback)
  feedback.current = onFeedback

  async function refresh(duringMutation = false) {
    if (!mounted.current || !duringMutation && lock.current) return
    const ticket = ++generation.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    setLoading(true)
    try {
      const value = readMcpDirectory(await hostRequest<unknown>('/mcp', { signal: controller.signal }))
      if (!mounted.current || controller.signal.aborted || ticket !== generation.current) return
      setSnapshot(value); setFailure(null); setStale(false)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === generation.current) setFailure(getErrorMessage(error, t('mcp.loadError')))
    } finally {
      if (mounted.current && ticket === generation.current) setLoading(false)
      if (readController.current === controller) readController.current = null
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    const cancel = () => { readController.current?.abort(); readController.current = null; actionController.current?.abort(); actionController.current = null }
    const hidden = () => {
      if (!document.hidden) return
      cancel()
      setEditor(current => current ? { ...current, url: '', env: current.env.map(row => ({ ...row, value: '' })), headers: current.headers.map(row => ({ ...row, value: '' })) } : current)
    }
    window.addEventListener('pagehide', cancel)
    document.addEventListener('visibilitychange', hidden)
    return () => { mounted.current = false; ++generation.current; cancel(); window.removeEventListener('pagehide', cancel); document.removeEventListener('visibilitychange', hidden) }
    // The page reads once on mount and on explicit actions; polling would hide configuration revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function mutate(key: string, operation: 'save' | 'connect' | 'disconnect' | 'delete' | 'save-grants', input: unknown, success: string): Promise<boolean> {
    if (lock.current || !mounted.current) return false
    lock.current = true; setBusy(key); setFailure(null); setNotice(null)
    const controller = new AbortController()
    actionController.current = controller
    try {
      const value = await hostRequest<unknown>('/mcp', { method: 'POST', body: { operation, input }, signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return false
      try {
        const result = readMcpMutationResult(value)
        setSnapshot(result.snapshot); setStale(false)
        if (result.harnessStopped) setNotice(t('mcp.harnessStopped'))
      } catch { await refresh(true) }
      if (!mounted.current) return false
      feedback.current(success)
      return true
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return false
      const code = (error as HostApiError).code ?? ''
      const conflict = code.includes('CONFLICT') || code.includes('REVISION')
      if (conflict) setStale(true)
      setFailure(code === 'MCP_CONNECTION_BUSY' ? t('mcp.connectionBusy') : conflict ? t('mcp.conflict') : getErrorMessage(error, t('mcp.operationFailed')))
      return false
    } finally {
      if (actionController.current === controller) actionController.current = null
      lock.current = false
      if (mounted.current) setBusy(null)
    }
  }

  const revision = snapshot?.revision ?? 0
  const services = snapshot?.services ?? []
  const agentTypes = snapshot?.agentTypes ?? []

  async function saveDraft(draft: Draft): Promise<boolean> {
    const env: Record<string, string> = {}; const clearEnvKeys: string[] = []
    for (const row of draft.env) {
      if (row.saved && row.clear) clearEnvKeys.push(row.key)
      else if (!row.saved && row.key.trim()) env[row.key.trim()] = row.value
      else if (row.saved && row.value) env[row.key] = row.value
    }
    const headers: Record<string, string> = {}; const clearHeaderKeys: string[] = []
    for (const row of draft.headers) {
      if (row.saved && row.clear) clearHeaderKeys.push(row.key)
      else if (!row.saved && row.key.trim()) headers[row.key.trim()] = row.value
      else if (row.saved && row.value) headers[row.key] = row.value
    }
    const base: DirectMcpSaveInput = { expectedRevision: revision, ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(),
      transport: draft.transport, command: draft.command.trim(), args: draft.args === '' ? [] : draft.args.split(/\r?\n/),
      env, clearEnvKeys, url: draft.url.trim(), headers, clearHeaderKeys, autoConnect: draft.autoConnect, grant: draft.grant }
    const ok = await mutate('save', 'save', draft.transport === 'stdio' ? stdioSaveInput(base) : httpSaveInput(base), t('mcp.savedFeedback'))
    if (ok) setEditor(null)
    return ok
  }

  return <main id="main-content" className="robot-content mcp-page">
    <div className="mcp-toolbar">
      <div className="mcp-toolbar-copy">
        <p className="mcp-summary">{t('mcp.revision', { revision: formatNumber(revision) })}</p>
        {snapshot && <p className="mcp-summary">{t('mcp.count', { count: services.length, value: formatNumber(services.length) })}</p>}
      </div>
      <div className="mcp-toolbar-actions">
        <button type="button" className="button button-secondary" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />{t(loading ? 'mcp.refreshing' : 'mcp.refresh')}</button>
        <button type="button" className="button button-primary" disabled={loading || stale || busy !== null} onClick={() => setEditor(emptyDraft())}><Plus size={16} aria-hidden="true" />{t('mcp.addDirect')}</button>
      </div>
    </div>
    {failure && <div className="mcp-alert" role="alert"><AlertCircle size={17} aria-hidden="true" /><div><p>{failure}</p><p className="mcp-alert-action"><button type="button" className="text-button" onClick={() => void refresh()}>{t('mcp.retry')}</button></p></div></div>}
    {notice && <div className="mcp-notice" role="status"><AlertCircle size={17} aria-hidden="true" /><p>{notice}</p></div>}
    {editor && <McpEditor draft={editor} onChange={setEditor} onCancel={() => setEditor(null)} onSave={saveDraft} saving={busy === 'save'} />}
    {!snapshot && loading && <p className="mcp-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />{t('mcp.loading')}</p>}
    {snapshot && services.length === 0 && <div className="empty-state mcp-empty"><Cable size={30} aria-hidden="true" /><h3>{t('mcp.emptyTitle')}</h3><p>{t('mcp.emptyDescription')}</p><button type="button" className="button button-primary" disabled={stale} onClick={() => setEditor(emptyDraft())}><Plus size={16} aria-hidden="true" />{t('mcp.addDirect')}</button></div>}
    <div className="mcp-service-list" aria-busy={loading}>
      {services.map(service => <ServiceCard key={service.id} service={service} agentTypes={agentTypes} busy={busy} stale={stale}
        onEdit={() => setEditor(draftFrom(service))}
        onConnect={() => void mutate('connect', 'connect', { id: service.id }, t('mcp.connectedFeedback'))}
        onDisconnect={() => void mutate('disconnect', 'disconnect', { id: service.id }, t('mcp.disconnectedFeedback'))}
        onDelete={() => void mutate('delete', 'delete', { id: service.id, expectedRevision: revision }, t('mcp.deletedFeedback'))}
        onSaveGrants={(grant) => mutate('save-grants', 'save-grants', { id: service.id, expectedRevision: revision, agentTypeIds: grant.agentTypeIds, toolNames: grant.toolNames }, t('mcp.grantSavedFeedback'))} />)}
    </div>
  </main>
}

function ServiceCard({ service, agentTypes, busy, stale, onEdit, onConnect, onDisconnect, onDelete, onSaveGrants }: {
  readonly service: McpServiceSummary
  readonly agentTypes: McpDirectorySnapshot['agentTypes']
  readonly busy: string | null
  readonly stale: boolean
  readonly onEdit: () => void
  readonly onConnect: () => void
  readonly onDisconnect: () => void
  readonly onDelete: () => void
  readonly onSaveGrants: (grant: McpGrant) => Promise<boolean>
}) {
  const { t, formatNumber } = useI18n('app')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingGrant, setEditingGrant] = useState(false)
  const [grant, setGrant] = useState<McpGrant>({ agentTypeIds: [...service.grant.agentTypeIds], toolNames: [...service.grant.toolNames] })
  const [grantSaving, setGrantSaving] = useState(false)
  const direct = service.source.kind === 'direct'
  const configuration = service.configuration
  const command = stringValue(configuration.command)
  const args = stringArray(configuration.args)
  const url = stringValue(configuration.url)
  const queryKeys = stringArray(configuration.queryKeys)
  const envKeys = stringArray(configuration.envKeys)
  const headerKeys = stringArray(configuration.headerKeys)
  const pluginKind = stringValue(configuration.pluginKind)
  const permissionsManaged = service.source.kind === 'plugin' && (configuration.permissionsManagedByPlugin === true || pluginKind === 'communication')
  const transport = service.transport === 'stdio' ? t('mcp.transport.stdio') : service.transport === 'streamable-http' ? t('mcp.transport.http') : t('mcp.transport.plugin')
  const partner = (id: string) => agentTypes.find(type => type.id === id)?.title ?? id
  const disabled = busy !== null || stale

  async function saveGrants() {
    if (grantSaving) return
    setGrantSaving(true)
    try { if (await onSaveGrants(grant)) setEditingGrant(false) } finally { setGrantSaving(false) }
  }

  return <section className="mcp-service" aria-labelledby={`mcp-${service.id}`}>
    <header className="mcp-service-head">
      <div className="mcp-service-title"><h2 id={`mcp-${service.id}`}>{service.name}</h2><span className={`status-badge mcp-state mcp-state-${service.state}`}>{t(`mcp.state.${service.state}`)}</span><span className="mcp-source">{service.source.kind === 'direct' ? t('mcp.source.direct') : t('mcp.source.plugin', { name: service.source.pluginName })}</span><span className="mcp-transport">{transport}</span></div>
      <div className="mcp-service-actions">
        {direct && <button type="button" className="button button-secondary" disabled={disabled} onClick={() => void (service.state === 'connected' ? onDisconnect() : onConnect())}>{service.state === 'connected' ? (busy === 'disconnect' ? t('mcp.disconnecting') : t('mcp.disconnect')) : (busy === 'connect' ? t('mcp.connecting') : t('mcp.connect'))}</button>}
        {direct && <button type="button" className="button button-secondary" disabled={disabled || service.state === 'connected'} onClick={onEdit}>{t('mcp.edit')}</button>}
        {service.source.kind === 'plugin' && <a className="text-button" href={`${pluginKind === 'communication' ? '#robots/' : '#plugins/'}${encodeURIComponent(service.source.pluginId)}`}>{t('mcp.openSourcePlugin')}</a>}
      </div>
    </header>
    {service.lastError && <p className="mcp-last-error" role="status">{service.lastError}</p>}
    <div className="mcp-columns">
      <section className="mcp-block" aria-labelledby={`mcp-config-${service.id}`}>
        <h3 id={`mcp-config-${service.id}`}>{t('mcp.config.title')}</h3>
        {service.source.kind === 'plugin' ? <p className="mcp-muted">{t('mcp.managedByPlugin', { name: service.source.pluginName })}</p> : service.transport === 'stdio' ? <dl className="mcp-facts">
          <div><dt>{t('mcp.command')}</dt><dd><code>{command || '—'}</code></dd></div>
          <div><dt>{t('mcp.args')}</dt><dd><code>{args.length ? args.join(' ') : '—'}</code></dd></div>
          {envKeys.length > 0 && <div><dt>{t('mcp.envKeys')}</dt><dd>{envKeys.map(key => <span className="mcp-chip" key={key}>{key}</span>)}<small>{t('mcp.secretsHidden')}</small></dd></div>}
        </dl> : <dl className="mcp-facts">
          <div><dt>{t('mcp.url')}</dt><dd><code>{url || '—'}</code>{queryKeys.length > 0 && <small>{t('mcp.field.urlQueryKeys', { keys: queryKeys.join(', ') })}</small>}</dd></div>
          {headerKeys.length > 0 && <div><dt>{t('mcp.headerKeys')}</dt><dd>{headerKeys.map(key => <span className="mcp-chip" key={key}>{key}</span>)}<small>{t('mcp.secretsHidden')}</small></dd></div>}
        </dl>}
        <p className="mcp-flags">{t(service.enabled ? 'mcp.enabled' : 'mcp.disabled')}{service.autoConnect ? ` · ${t('mcp.autoConnect')}` : ''}</p>
        {direct && service.state === 'connected' && <p className="mcp-hint">{t('mcp.disconnectFirst')}</p>}
      </section>
      <section className="mcp-block" aria-labelledby={`mcp-ready-${service.id}`}>
        <h3 id={`mcp-ready-${service.id}`}>{t('mcp.ready.title')}</h3>
        <p className={`mcp-readiness mcp-readiness-${service.state}`}>{t(`mcp.state.${service.state}`)}</p>
        <p className="mcp-muted">{service.source.kind === 'plugin' ? t('mcp.managedByPlugin', { name: service.source.pluginName }) : t('mcp.readyHint')}</p>
      </section>
      <section className="mcp-block" aria-labelledby={`mcp-grant-${service.id}`}>
        <h3 id={`mcp-grant-${service.id}`}>{t('mcp.grant.title')}</h3>
        {permissionsManaged ? <>
          <p className="mcp-grant-tools">{service.tools.map(tool => tool.name).join('、') || '—'}</p>
          <p className="mcp-hint">{t('mcp.grant.managedByPlugin', { name: service.source.kind === 'plugin' ? service.source.pluginName : '' })}</p>
        </> : !editingGrant ? <>
          <p className="mcp-grant-summary">{service.grant.agentTypeIds.length ? service.grant.agentTypeIds.map(partner).join('、') : t('mcp.grant.none')}</p>
          <p className="mcp-grant-tools">{service.grant.toolNames.length ? service.grant.toolNames.join('、') : '—'}</p>
          <p className="mcp-hint">{t('mcp.grant.note')}</p>
          <button type="button" className="text-button" disabled={disabled} onClick={() => { setGrant({ agentTypeIds: [...service.grant.agentTypeIds], toolNames: [...service.grant.toolNames] }); setEditingGrant(true) }}>{t('mcp.grant.edit')}</button>
        </> : <>
          <GrantPicker agentTypes={agentTypes} tools={service.tools} value={grant} onChange={setGrant} disabled={grantSaving} />
          <p className="mcp-hint">{t('mcp.grant.note')}</p>
          <div className="mcp-inline-actions"><button type="button" className="button button-primary" disabled={grantSaving || stale} onClick={() => void saveGrants()}>{grantSaving ? t('mcp.grant.saving') : t('mcp.grant.save')}</button><button type="button" className="button button-secondary" disabled={grantSaving} onClick={() => setEditingGrant(false)}>{t('mcp.grant.close')}</button></div>
        </>}
      </section>
    </div>
    <details className="mcp-tools"><summary><ChevronDown size={15} aria-hidden="true" />{t('mcp.tools.title', { count: service.tools.length, value: formatNumber(service.tools.length) })}</summary>
      {service.tools.length === 0 ? <p className="mcp-muted">{t('mcp.tools.empty')}</p> : <ul>{service.tools.map(tool => <li key={tool.name}><div className="mcp-tool-head"><strong>{tool.title}</strong><code>{tool.name}</code>{tool.readOnly && <span className="mcp-tool-badge">{t('mcp.tools.readOnly')}</span>}{tool.destructive && <span className="mcp-tool-badge mcp-tool-badge-warn">{t('mcp.tools.destructive')}</span>}</div><p>{tool.description}</p></li>)}</ul>}
    </details>
    {direct && <div className="mcp-danger-zone">
      {!confirmDelete ? <button type="button" className="text-button mcp-danger-trigger" disabled={disabled} onClick={() => setConfirmDelete(true)}><Trash2 size={14} aria-hidden="true" />{t('mcp.delete')}</button> : <div className="mcp-confirm" role="alertdialog" aria-label={t('mcp.deleteConfirmTitle', { name: service.name })}><div><strong>{t('mcp.deleteConfirmTitle', { name: service.name })}</strong><p>{t('mcp.deleteConfirmDescription')}</p></div><div className="mcp-inline-actions"><button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>{t('mcp.cancel')}</button><button type="button" className="button button-danger" disabled={disabled || busy !== null} onClick={onDelete}>{busy === 'delete' ? t('mcp.deleting') : t('mcp.deleteConfirm')}</button></div></div>}
    </div>}
  </section>
}

function GrantPicker({ agentTypes, tools, value, onChange, disabled }: {
  readonly agentTypes: McpDirectorySnapshot['agentTypes']
  readonly tools: readonly PluginToolDefinition[]
  readonly value: McpGrant
  readonly onChange: (value: McpGrant) => void
  readonly disabled: boolean
}) {
  const { t } = useI18n('app')
  const toggle = (list: readonly string[], id: string) => list.includes(id) ? list.filter(item => item !== id) : [...list, id]
  return <div className="mcp-grant-picker">
    <fieldset disabled={disabled}><legend>{t('mcp.grant.agentTypes')}</legend>{agentTypes.length === 0 ? <p className="mcp-muted">{t('mcp.grant.none')}</p> : agentTypes.map(type => <label className="mcp-check" key={type.id}><input type="checkbox" checked={value.agentTypeIds.includes(type.id)} onChange={() => onChange({ ...value, agentTypeIds: toggle(value.agentTypeIds, type.id) })} /><span>{type.title}</span></label>)}</fieldset>
    <fieldset disabled={disabled}><legend>{t('mcp.grant.toolNames')}</legend>{tools.length === 0 ? <p className="mcp-muted">{t('mcp.tools.empty')}</p> : tools.map(tool => <label className="mcp-check" key={tool.name}><input type="checkbox" checked={value.toolNames.includes(tool.name)} onChange={() => onChange({ ...value, toolNames: toggle(value.toolNames, tool.name) })} /><span>{tool.title} · <code>{tool.name}</code></span></label>)}</fieldset>
  </div>
}

function McpEditor({ draft, onChange, onCancel, onSave, saving }: {
  readonly draft: Draft
  readonly onChange: (draft: Draft) => void
  readonly onCancel: () => void
  readonly onSave: (draft: Draft) => Promise<boolean>
  readonly saving: boolean
}) {
  const { t } = useI18n('app')
  const prefix = useId()
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const editable = (key: keyof Draft, value: string | boolean) => onChange({ ...draft, [key]: value })

  function validate(): boolean {
    const next: Record<string, string> = {}
    if (!draft.name.trim()) next.name = t('mcp.validation.name')
    if (draft.transport === 'stdio' && !draft.command.trim()) next.command = t('mcp.validation.command')
    if (draft.transport === 'streamable-http' && !draft.id && !draft.url.trim()) next.url = t('mcp.validation.url')
    if (draft.transport === 'streamable-http' && draft.url.trim()) {
      try { const url = new URL(draft.url.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) next.url = t('mcp.validation.url') }
      catch { next.url = t('mcp.validation.url') }
    }
    for (const [rows, key] of [[draft.env, 'env'], [draft.headers, 'headers']] as const) {
      const seen = new Set<string>()
      for (const row of rows) {
        if (row.saved) continue
        const name = row.key.trim()
        if (!name && row.value) { next[key] = t('mcp.validation.key'); break }
        if (name) { if (seen.has(name)) { next[key] = t('mcp.validation.duplicateKey'); break } seen.add(name) }
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || submitting || !validate()) return
    setSubmitting(true)
    try { await onSave(draft) } finally { setSubmitting(false) }
  }

  const transportId = `${prefix}-transport`
  const rowsFor = (key: 'env' | 'headers') => (draft[key]).map((row, index) => ({ row, index }))
  function setRow(key: 'env' | 'headers', index: number, patch: Partial<KvRow>) {
    onChange({ ...draft, [key]: draft[key].map((row, current) => current === index ? { ...row, ...patch } : row) })
  }
  function addRow(key: 'env' | 'headers') {
    onChange({ ...draft, [key]: [...draft[key], { key: '', value: '', saved: false, clear: false }] })
  }

  return <section className="mcp-editor" aria-labelledby={`${prefix}-title`}>
    <div className="mcp-editor-heading"><div><h2 id={`${prefix}-title`}>{t(draft.id ? 'mcp.form.editTitle' : 'mcp.form.createTitle')}</h2><p>{t('mcp.form.description')}</p></div><button type="button" className="icon-button" aria-label={t('mcp.cancel')} onClick={onCancel}><X size={18} aria-hidden="true" /></button></div>
    <form className="form-fields" noValidate onSubmit={event => void submit(event)}>
      <div className={`field${errors.name ? ' field-invalid' : ''}`}><label htmlFor={`${prefix}-name`}>{t('mcp.field.name')}</label><input id={`${prefix}-name`} value={draft.name} maxLength={200} autoComplete="off" onChange={event => editable('name', event.target.value)} /><p className="field-hint">{t('mcp.field.nameHint')}</p>{errors.name && <p className="field-error">{errors.name}</p>}</div>
      <div className="field"><label htmlFor={transportId}>{t('mcp.field.transport')}</label><div className="mcp-choice-row" id={transportId} role="radiogroup">{([['stdio', 'mcp.transport.stdio'], ['streamable-http', 'mcp.transport.http']] as const).map(([value, label]) => <label className="mcp-choice" key={value}><input type="radio" name="transport" checked={draft.transport === value} onChange={() => onChange({ ...draft, transport: value })} /><span>{t(label)}</span></label>)}</div></div>
      {draft.transport === 'stdio' ? <>
        <div className={`field${errors.command ? ' field-invalid' : ''}`}><label htmlFor={`${prefix}-command`}>{t('mcp.field.command')}</label><input id={`${prefix}-command`} value={draft.command} maxLength={4096} autoComplete="off" spellCheck={false} onChange={event => editable('command', event.target.value)} /><p className="field-hint">{t('mcp.field.commandHint')}</p>{errors.command && <p className="field-error">{errors.command}</p>}</div>
        <div className="field"><label htmlFor={`${prefix}-args`}>{t('mcp.field.args')}</label><textarea id={`${prefix}-args`} className="mcp-textarea" value={draft.args} rows={4} spellCheck={false} onChange={event => editable('args', event.target.value)} /><p className="field-hint">{t('mcp.field.argsHint')}</p></div>
        <div className="field"><label>{t('mcp.field.env')}</label><div><KvEditor rows={rowsFor('env')} onPatch={(index, patch) => setRow('env', index, patch)} onAdd={() => addRow('env')} onRemove={index => onChange({ ...draft, env: draft.env.filter((_, current) => current !== index) })} addLabel={t('mcp.kv.addEnv')} keyLabel={t('mcp.kv.envKey')} error={errors.env} /></div></div>
      </> : <>
        <div className={`field${errors.url ? ' field-invalid' : ''}`}><label htmlFor={`${prefix}-url`}>{t('mcp.field.url')}</label><input id={`${prefix}-url`} value={draft.url} maxLength={4096} autoComplete="off" spellCheck={false} placeholder={draft.savedUrl ? `${t('mcp.field.urlSaved', { url: draft.savedUrl })}${draft.savedQueryKeys.length ? ` · ${t('mcp.field.urlQueryKeys', { keys: draft.savedQueryKeys.join(', ') })}` : ''}` : t('mcp.field.urlPlaceholder')} onChange={event => editable('url', event.target.value)} /><p className="field-hint">{t(draft.id ? 'mcp.field.urlKeep' : 'mcp.field.urlHint')}</p>{errors.url && <p className="field-error">{errors.url}</p>}</div>
        <div className="field"><label>{t('mcp.field.headers')}</label><div><KvEditor rows={rowsFor('headers')} onPatch={(index, patch) => setRow('headers', index, patch)} onAdd={() => addRow('headers')} onRemove={index => onChange({ ...draft, headers: draft.headers.filter((_, current) => current !== index) })} addLabel={t('mcp.kv.addHeader')} keyLabel={t('mcp.kv.headerKey')} error={errors.headers} /></div></div>
      </>}
      <label className="check-field mcp-compact-check"><input type="checkbox" checked={draft.autoConnect} onChange={event => editable('autoConnect', event.target.checked)} /><span><strong>{t('mcp.field.autoConnect')}</strong><small>{t('mcp.field.autoConnectHint')}</small></span></label>
      <div className="form-actions"><button type="submit" className="button button-primary" disabled={saving || submitting}>{saving ? t('mcp.form.saving') : t(draft.id ? 'mcp.form.save' : 'mcp.form.create')}</button><button type="button" className="button button-secondary" disabled={saving || submitting} onClick={onCancel}>{t('mcp.cancel')}</button></div>
    </form>
  </section>
}

function KvEditor({ rows, onPatch, onAdd, onRemove, addLabel, keyLabel, error }: {
  readonly rows: readonly { readonly row: KvRow; readonly index: number }[]
  readonly onPatch: (index: number, patch: Partial<KvRow>) => void
  readonly onAdd: () => void
  readonly onRemove: (index: number) => void
  readonly addLabel: string
  readonly keyLabel: string
  readonly error?: string
}) {
  const { t } = useI18n('app')
  return <div className="mcp-kv-list">
    {rows.map(({ row, index }) => <div className={`mcp-kv-row${row.clear ? ' is-cleared' : ''}`} key={index}>
      <input aria-label={keyLabel} value={row.key} disabled={row.saved} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => onPatch(index, { key: event.target.value })} />
      <input aria-label={t('mcp.kv.value')} type="password" value={row.value} maxLength={4096} autoComplete="new-password" placeholder={row.saved ? t('mcp.kv.savedPlaceholder') : t('mcp.kv.value')} disabled={row.clear} onChange={event => onPatch(index, { value: event.target.value })} />
      {row.saved ? <label className="mcp-check mcp-kv-clear"><input type="checkbox" checked={row.clear} onChange={event => onPatch(index, { clear: event.target.checked })} /><span>{t('mcp.kv.clear')}</span></label> : <button type="button" className="icon-button" aria-label={t('mcp.kv.remove')} onClick={() => onRemove(index)}><X size={15} aria-hidden="true" /></button>}
    </div>)}
    <button type="button" className="text-button mcp-kv-add" onClick={onAdd}><Plus size={14} aria-hidden="true" />{addLabel}</button>
    {error && <p className="field-error">{error}</p>}
  </div>
}
