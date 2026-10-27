import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronRight, FileText, Info, Plus, Power, RefreshCw, Save, Trash2, UserRound } from 'lucide-react'
import { analyzeTemplate } from '@eating/plugin-sdk'
import type { AuthoringSnapshot, PersonaDocument, PersonaMutationResult, PersonaSummary, PromptDocument, PromptKind, TemplateScope } from '@eating/plugin-sdk'
import { HostApiError, formatDateTime, getErrorMessage, hostRequest, translate, useI18n } from '@eating/ui-sdk'
import '../i18n/authoring'
import { TemplateEditor } from '../components/TemplateEditor'
import './Authoring.css'

export interface AuthoringProps {
  readonly mode: 'prompts' | 'personas'
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onFeedback: (message: string) => void
}

type Notice = { readonly kind: 'error' | 'success' | 'info'; readonly key: string }
  | { readonly kind: 'error'; readonly error: unknown; readonly operation: Operation }
type Operation = 'read' | 'save' | 'activate' | 'delete'
type Selection = { readonly key: string; readonly id: string; readonly scope: TemplateScope }
interface Draft extends Selection {
  readonly name: string
  readonly body: string
  readonly saved: PromptDocument | PersonaDocument | null
  readonly requiresRead: boolean
  readonly notice: Notice | null
}
interface RequestTicket {
  readonly generation: number
  readonly controller: AbortController
  readonly key: string | null
  readonly kind: Operation
}

const promptKinds: readonly PromptKind[] = ['main', 'group', 'private']
const authoringText = (key: string, params?: Record<string, string | number | boolean | null | undefined>) => translate('authoring', key, params)
const personaIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const promptKind = (id: string | null): PromptKind => promptKinds.includes(id as PromptKind) ? id as PromptKind : 'main'
const revisionValid = (value: number) => Number.isSafeInteger(value) && value >= 0
const responseError = () => new HostApiError('INVALID_HOST_RESPONSE', authoringText('error.response'))

function summaryValid(value: PersonaSummary): boolean {
  return Boolean(value && typeof value.id === 'string' && personaIdPattern.test(value.id)
    && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.trim().length <= 80
    && revisionValid(value.revision) && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string')
}

function checkSnapshot(value: AuthoringSnapshot): AuthoringSnapshot {
  if (!value || value.protocolVersion !== 1 || !revisionValid(value.revision)
    || !Array.isArray(value.prompts) || !Array.isArray(value.personas) || !Array.isArray(value.variables)
    || value.prompts.length !== promptKinds.length || new Set(value.prompts.map(doc => doc?.id)).size !== promptKinds.length
    || value.prompts.some(doc => !doc || !promptKinds.includes(doc.id) || typeof doc.title !== 'string'
      || typeof doc.body !== 'string' || !revisionValid(doc.revision) || !(doc.updatedAt === null || typeof doc.updatedAt === 'string'))
    || value.personas.some(persona => !summaryValid(persona)) || new Set(value.personas.map(persona => persona.id)).size !== value.personas.length
    || !(value.activePersonaId === null || value.personas.some(persona => persona.id === value.activePersonaId))
    || value.variables.some(variable => !variable || typeof variable.name !== 'string' || typeof variable.description !== 'string'
      || !Array.isArray(variable.scopes) || variable.scopes.some((scope: string) => !['main', 'group', 'private', 'persona'].includes(scope)))) throw responseError()
  return value
}

function checkPersona(value: PersonaDocument, expectedId?: string): PersonaDocument {
  if (!summaryValid(value) || typeof value.body !== 'string' || expectedId !== undefined && value.id !== expectedId) throw responseError()
  return value
}

function checkMutation(value: PersonaMutationResult, expectedId?: string): PersonaMutationResult {
  if (!value) throw responseError()
  checkSnapshot(value.snapshot)
  checkPersona(value.persona, expectedId)
  if (!value.snapshot.personas.some(persona => persona.id === value.persona.id && persona.revision === value.persona.revision)) throw responseError()
  return value
}

function promptDraft(doc: PromptDocument): Draft {
  return { key: `prompts:${doc.id}`, id: doc.id, scope: doc.id, name: doc.title, body: doc.body, saved: doc, requiresRead: false, notice: null }
}

function personaDraft(doc: PersonaDocument): Draft {
  return { key: `personas:${doc.id}`, id: doc.id, scope: 'persona', name: doc.name, body: doc.body, saved: doc, requiresRead: false, notice: null }
}

function emptyPersona(): Draft {
  return { key: 'personas:new', id: 'new', scope: 'persona', name: '', body: '', saved: null, requiresRead: false, notice: null }
}

function isDirty(draft: Draft): boolean {
  if (!draft.saved) return draft.name !== '' || draft.body !== ''
  return draft.body !== draft.saved.body || 'name' in draft.saved && draft.name !== draft.saved.name
}

function isConflict(error: unknown): boolean {
  return error instanceof HostApiError && error.code === 'AUTHORING_REVISION_CONFLICT'
}

function needsRead(error: unknown): boolean {
  return isConflict(error) || error instanceof HostApiError && (error.outcome === 'unknown' || error.code === 'INVALID_HOST_RESPONSE' || error.code === 'ACTIVE_PERSONA')
}

function errorMessage(error: unknown, kind: Operation): string {
  if (isConflict(error)) return authoringText('error.conflict')
  if (error instanceof HostApiError) {
    if (error.outcome === 'unknown' && kind !== 'read') return authoringText('error.unknown')
    if (error.code === 'ACTIVE_PERSONA') return authoringText('error.activePersona')
  }
  return getErrorMessage(error, authoringText(kind === 'read' ? 'error.read' : 'error.mutate'))
}

function noticeMessage(notice: Notice): string {
  return 'key' in notice ? authoringText(notice.key) : errorMessage(notice.error, notice.operation)
}

function updatedLabel(value: string | null): string {
  if (!value) return authoringText('updated.none')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? authoringText('updated.invalid')
    : authoringText('updated.label', { date: formatDateTime(date, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
}

export function Authoring({ mode, selectedId, onSelect, onFeedback }: AuthoringProps) {
  const { t, formatNumber } = useI18n('authoring')
  const [snapshot, setSnapshot] = useState<AuthoringSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [operation, setOperation] = useState<{ readonly kind: Operation; readonly key: string | null } | null>({ kind: 'read', key: null })
  const [readError, setReadError] = useState<{ readonly key: string | null; readonly error: unknown } | null>(null)
  const [snapshotNeedsRead, setSnapshotNeedsRead] = useState(false)
  const [confirmRead, setConfirmRead] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const activeRequest = useRef<RequestTicket | null>(null)
  const lock = useRef(false)
  const snapshotRef = useRef<AuthoringSnapshot | null>(null)
  const draftsRef = useRef<Readonly<Record<string, Draft>>>({})
  const snapshotNeedsReadRef = useRef(false)
  const feedback = useRef(onFeedback)
  const select = useRef(onSelect)
  const readTrigger = useRef<HTMLButtonElement>(null)
  const readCancel = useRef<HTMLButtonElement>(null)
  const deleteTrigger = useRef<HTMLButtonElement>(null)
  const deleteCancel = useRef<HTMLButtonElement>(null)
  feedback.current = onFeedback
  select.current = onSelect

  const resolvedId = mode === 'prompts' ? promptKind(selectedId) : selectedId ?? snapshot?.activePersonaId ?? snapshot?.personas[0]?.id ?? 'new'
  const selection: Selection = { key: `${mode}:${resolvedId}`, id: resolvedId, scope: mode === 'prompts' ? promptKind(resolvedId) : 'persona' }
  const selectedKey = useRef(selection.key)
  selectedKey.current = selection.key
  const currentDraft = drafts[selection.key] ?? null
  const dirty = currentDraft ? isDirty(currentDraft) : false
  const analysis = useMemo(() => currentDraft ? analyzeTemplate(currentDraft.body, currentDraft.scope) : null, [currentDraft?.body, currentDraft?.scope])
  const bodyError = currentDraft && currentDraft.body.length > 50000 ? t('error.bodyLength', { limit: formatNumber(50000) })
    : currentDraft && !currentDraft.body.trim() ? t('error.bodyEmpty') : null
  const nameError = currentDraft?.scope === 'persona' && (!currentDraft.name.trim() || currentDraft.name.trim().length > 80) ? t('error.name') : null
  const valid = Boolean(currentDraft && !bodyError && !nameError && analysis?.valid)
  const busy = operation !== null
  const mutating = busy && operation.kind !== 'read'
  const active = Boolean(currentDraft?.saved && snapshot?.activePersonaId === currentDraft.id && mode === 'personas')
  const blocked = snapshotNeedsRead || Boolean(currentDraft?.requiresRead)
  const currentReadError = readError && (readError.key === null || readError.key === selection.key) ? errorMessage(readError.error, 'read') : null
  const title = mode === 'prompts' ? t(`prompt.${promptKind(resolvedId)}.title`) : !snapshot ? t('persona.title') : resolvedId === 'new' ? t('persona.new') : currentDraft?.saved && 'name' in currentDraft.saved ? currentDraft.saved.name : snapshot.personas.find(persona => persona.id === resolvedId)?.name ?? t('persona.fallbackTitle')

  const replaceDrafts = useCallback((next: Readonly<Record<string, Draft>>) => {
    draftsRef.current = next
    setDrafts(next)
  }, [])

  const replaceSnapshot = useCallback((next: AuthoringSnapshot) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const requireSnapshotRead = useCallback((required: boolean) => {
    snapshotNeedsReadRef.current = required
    setSnapshotNeedsRead(required)
  }, [])

  const cancelRequest = useCallback((markUncertain = true) => {
    const request = activeRequest.current
    ++generation.current
    request?.controller.abort()
    activeRequest.current = null
    lock.current = false
    if (!mounted.current) return
    setOperation(null)
    if (request && request.kind !== 'read' && markUncertain) {
      requireSnapshotRead(true)
      const draft = request.key ? draftsRef.current[request.key] : null
      if (draft) replaceDrafts({ ...draftsRef.current, [draft.key]: { ...draft, requiresRead: true, notice: { kind: 'error', key: 'error.interrupted' } } })
    }
  }, [replaceDrafts, requireSnapshotRead])

  const beginRequest = useCallback((kind: Operation, key: string | null): RequestTicket | null => {
    if (!mounted.current || lock.current) return null
    lock.current = true
    const ticket = { generation: ++generation.current, controller: new AbortController(), key, kind }
    activeRequest.current = ticket
    setOperation({ kind, key })
    setConfirmRead(null)
    setConfirmDelete(null)
    setReadError(null)
    return ticket
  }, [])

  const isCurrent = useCallback((ticket: RequestTicket) => mounted.current && generation.current === ticket.generation
    && !ticket.controller.signal.aborted && (ticket.key === null || selectedKey.current === ticket.key), [])

  const finishRequest = useCallback((ticket: RequestTicket) => {
    if (!mounted.current || generation.current !== ticket.generation) return
    if (ticket.kind !== 'read' && ticket.key !== selectedKey.current) { cancelRequest(); return }
    activeRequest.current = null
    lock.current = false
    setOperation(null)
  }, [cancelRequest])

  const readSnapshot = useCallback(async (target: Selection | null) => {
    const ticket = beginRequest('read', target?.key ?? null)
    if (!ticket) return
    try {
      const next = checkSnapshot(await hostRequest<AuthoringSnapshot>('/authoring', { signal: ticket.controller.signal }))
      let replacement: Draft | null = null
      if (target?.scope === 'persona') replacement = target.id === 'new' ? emptyPersona()
        : personaDraft(checkPersona(await hostRequest<PersonaDocument>(`/personas/${encodeURIComponent(target.id)}`, { signal: ticket.controller.signal }), target.id))
      else if (target) {
        const doc = next.prompts.find(prompt => prompt.id === target.id)
        if (!doc) throw responseError()
        replacement = promptDraft(doc)
      }
      if (!isCurrent(ticket)) return
      const nextDrafts = { ...draftsRef.current }
      for (const doc of next.prompts) if (!nextDrafts[`prompts:${doc.id}`]) nextDrafts[`prompts:${doc.id}`] = promptDraft(doc)
      if (replacement) nextDrafts[replacement.key] = replacement
      replaceDrafts(nextDrafts)
      replaceSnapshot(next)
      requireSnapshotRead(false)
    } catch (error) {
      if (isCurrent(ticket)) setReadError({ key: target?.key ?? null, error })
    } finally { finishRequest(ticket) }
  }, [beginRequest, finishRequest, isCurrent, replaceDrafts, replaceSnapshot, requireSnapshotRead])

  useEffect(() => {
    mounted.current = true
    void readSnapshot(null)
    return () => { mounted.current = false; cancelRequest(false) }
  }, [cancelRequest, readSnapshot])

  const ready = snapshot !== null
  useEffect(() => {
    if (!ready) return
    setConfirmRead(null)
    setConfirmDelete(null)
    setReadError(null)
    const key = `${mode}:${resolvedId}`
    if (!draftsRef.current[key]) {
      if (mode === 'prompts') {
        const doc = snapshotRef.current?.prompts.find(prompt => prompt.id === resolvedId)
        if (doc) replaceDrafts({ ...draftsRef.current, [key]: promptDraft(doc) })
      } else if (resolvedId === 'new') replaceDrafts({ ...draftsRef.current, [key]: emptyPersona() })
      else {
        const ticket = beginRequest('read', key)
        if (ticket) void (async () => {
          try {
            const doc = checkPersona(await hostRequest<PersonaDocument>(`/personas/${encodeURIComponent(resolvedId)}`, { signal: ticket.controller.signal }), resolvedId)
            if (isCurrent(ticket)) replaceDrafts({ ...draftsRef.current, [key]: personaDraft(doc) })
          } catch (error) {
            if (isCurrent(ticket)) setReadError({ key, error })
          } finally { finishRequest(ticket) }
        })()
      }
    }
    return () => { if (activeRequest.current?.key === key) cancelRequest() }
  }, [ready, mode, resolvedId, beginRequest, cancelRequest, finishRequest, isCurrent, replaceDrafts])

  useEffect(() => {
    if (!snapshot) return
    if (mode === 'prompts' && selectedId !== promptKind(selectedId) || mode === 'personas' && selectedId === null) select.current(resolvedId)
  }, [mode, resolvedId, selectedId, snapshot])

  useEffect(() => { if (confirmRead) readCancel.current?.focus() }, [confirmRead])
  useEffect(() => { if (confirmDelete) deleteCancel.current?.focus() }, [confirmDelete])

  function choose(id: string) {
    if (!snapshotRef.current || id === resolvedId || activeRequest.current?.kind && activeRequest.current.kind !== 'read') return
    cancelRequest()
    setConfirmRead(null)
    setConfirmDelete(null)
    select.current(id)
  }

  function updateDraft(field: 'name' | 'body', value: string) {
    if (lock.current) return
    const draft = draftsRef.current[selection.key]
    if (!draft) return
    replaceDrafts({ ...draftsRef.current, [draft.key]: { ...draft, [field]: value, notice: draft.notice?.kind === 'error' ? draft.notice : null } })
    setConfirmRead(null)
    setConfirmDelete(null)
  }

  function requestRead() {
    if (lock.current) return
    const draft = draftsRef.current[selection.key]
    if (draft && isDirty(draft)) { setConfirmDelete(null); setConfirmRead(selection.key); return }
    void readSnapshot(snapshotRef.current ? selection : null)
  }

  async function mutate(kind: Exclude<Operation, 'read'>) {
    const draft = draftsRef.current[selection.key]
    const index = snapshotRef.current
    if (lock.current || selectedKey.current !== draft?.key || !draft || !index || draft.requiresRead || snapshotNeedsReadRef.current) return
    const currentlyActive = draft.scope === 'persona' && index.activePersonaId === draft.id
    if (kind === 'save' && (!isDirty(draft) || !draft.body.trim() || draft.body.length > 50000
      || draft.scope === 'persona' && (!draft.name.trim() || draft.name.trim().length > 80)
      || !analyzeTemplate(draft.body, draft.scope).valid)) return
    if (kind === 'activate' && (!draft.saved || !currentlyActive && isDirty(draft))) return
    if (kind === 'delete' && (!draft.saved || currentlyActive || confirmDelete !== draft.key)) return
    const ticket = beginRequest(kind, draft.key)
    if (!ticket) return
    let createdId: string | null = null
    try {
      let next: AuthoringSnapshot
      let savedDraft: Draft | null = null
      let messageKey: string
      if (kind === 'save' && draft.scope !== 'persona') {
        if (!draft.saved) throw responseError()
        next = checkSnapshot(await hostRequest<AuthoringSnapshot>(`/prompts/${encodeURIComponent(draft.id)}`, {
          method: 'POST', signal: ticket.controller.signal, body: { expectedRevision: draft.saved.revision, body: draft.body },
        }))
        const doc = next.prompts.find(prompt => prompt.id === draft.id)
        if (!doc) throw responseError()
        savedDraft = promptDraft(doc)
        messageKey = 'success.promptSaved'
      } else if (kind === 'save') {
        const result = checkMutation(await hostRequest<PersonaMutationResult>(draft.saved ? `/personas/${encodeURIComponent(draft.id)}` : '/personas', {
          method: 'POST', signal: ticket.controller.signal,
          body: { ...(draft.saved ? { expectedRevision: draft.saved.revision } : {}), name: draft.name.trim(), body: draft.body },
        }), draft.saved ? draft.id : undefined)
        next = result.snapshot
        savedDraft = personaDraft(result.persona)
        if (!draft.saved) createdId = result.persona.id
        messageKey = draft.saved ? 'success.personaSaved' : 'success.personaCreated'
      } else if (kind === 'activate') {
        next = checkSnapshot(await hostRequest<AuthoringSnapshot>(`/personas/${encodeURIComponent(draft.id)}/activate`, {
          method: 'POST', signal: ticket.controller.signal, body: { expectedRevision: index.revision, enabled: !currentlyActive },
        }))
        messageKey = currentlyActive ? 'success.personaDeactivated' : 'success.personaActivated'
      } else {
        if (!draft.saved) throw responseError()
        next = checkSnapshot(await hostRequest<AuthoringSnapshot>(`/personas/${encodeURIComponent(draft.id)}/delete`, {
          method: 'POST', signal: ticket.controller.signal, body: { expectedRevision: draft.saved.revision, confirmed: true },
        }))
        messageKey = 'success.personaDeleted'
      }
      if (!isCurrent(ticket)) return
      const nextDrafts = { ...draftsRef.current }
      if (kind === 'delete') delete nextDrafts[draft.key]
      else if (savedDraft) {
        nextDrafts[savedDraft.key] = { ...savedDraft, notice: { kind: 'success', key: messageKey } }
        if (createdId) nextDrafts[draft.key] = emptyPersona()
      } else nextDrafts[draft.key] = { ...draft, notice: { kind: 'success', key: messageKey } }
      replaceDrafts(nextDrafts)
      replaceSnapshot(next)
      feedback.current(authoringText(messageKey))
    } catch (error) {
      if (!isCurrent(ticket)) return
      const original = draftsRef.current[draft.key] ?? draft
      replaceDrafts({ ...draftsRef.current, [draft.key]: { ...original, requiresRead: needsRead(error) || original.requiresRead, notice: { kind: 'error', error, operation: kind } } })
      if (needsRead(error)) requireSnapshotRead(true)
    } finally { finishRequest(ticket) }
    if (!mounted.current || selectedKey.current !== draft.key) return
    if (createdId && draftsRef.current[`personas:${createdId}`]) select.current(createdId)
    else if (kind === 'delete' && !draftsRef.current[draft.key]) select.current('new')
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void mutate('save') }

  return <div className="robot-workspace authoring-workspace">
    <aside className="platform-sidebar authoring-sidebar">
      <p className="platform-nav-heading">{t(mode === 'prompts' ? 'nav.prompts' : 'nav.personas')}{mode === 'personas' && snapshot && <span>{formatNumber(snapshot.personas.length)}</span>}</p>
      <nav aria-label={t(mode === 'prompts' ? 'nav.prompts' : 'nav.personaList')}>
        {mode === 'prompts' ? promptKinds.map(id => <button key={id} type="button" disabled={!snapshot || mutating} className={`platform-nav-item ${resolvedId === id ? 'is-selected' : ''}`} aria-current={resolvedId === id ? 'page' : undefined} onClick={() => choose(id)}><FileText size={18} aria-hidden="true" /><span>{t(`prompt.${id}.title`)}</span>{resolvedId === id && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}</button>) : <>
          {!snapshot ? <p className="authoring-sidebar-state">{t(busy ? 'nav.loadingPersonas' : 'nav.personasNotLoaded')}</p> : snapshot.personas.length === 0 ? <p className="authoring-sidebar-state">{t('nav.personasEmpty')}</p> : snapshot.personas.map(persona => <button key={persona.id} type="button" disabled={mutating} className={`platform-nav-item authoring-persona-item ${resolvedId === persona.id ? 'is-selected' : ''}`} aria-current={resolvedId === persona.id ? 'page' : undefined} onClick={() => choose(persona.id)}><UserRound size={18} aria-hidden="true" /><span title={persona.name}>{persona.name}</span>{snapshot.activePersonaId === persona.id && <small className="authoring-active-label">{t('status.active')}</small>}{drafts[`personas:${persona.id}`] && isDirty(drafts[`personas:${persona.id}`]!) && <span className="authoring-draft-mark" aria-label={t('status.unsaved')} />}</button>)}
          <button type="button" disabled={!snapshot || mutating} className={`platform-nav-item authoring-new-button ${snapshot && resolvedId === 'new' ? 'is-selected' : ''}`} aria-current={snapshot && resolvedId === 'new' ? 'page' : undefined} onClick={() => choose('new')}><Plus size={18} aria-hidden="true" /><span>{t('persona.new')}</span></button>
        </>}
      </nav>
      <div className="platform-sidebar-footer"><Info size={17} aria-hidden="true" /><p>{t(mode === 'prompts' ? 'nav.promptHint' : 'nav.personaHint')}</p></div>
    </aside>
    <main id="main-content" className="robot-content authoring-content" aria-busy={busy}>
      <div className="authoring-title-row"><div><div className="panel-title-row"><h2>{title}</h2>{active && <span className="status-badge authoring-active-badge"><Check size={12} aria-hidden="true" />{t('status.active')}</span>}</div><p className="panel-description">{t(mode === 'prompts' ? `prompt.${promptKind(resolvedId)}.description` : 'persona.description')}</p></div><button ref={readTrigger} type="button" className="button button-secondary authoring-read-button" disabled={busy} onClick={requestRead}><RefreshCw size={15} aria-hidden="true" />{t(operation?.kind === 'read' ? 'action.reading' : mode === 'prompts' ? 'action.readPrompt' : 'action.readPersona')}</button></div>
      <div className="authoring-runtime-note"><Info size={16} aria-hidden="true" /><p>{t('runtimeNote')}</p></div>
      {snapshotNeedsRead && <p className="authoring-notice authoring-notice-error" role="alert">{t(mode === 'prompts' ? 'read.requiredPrompt' : 'read.requiredPersona')}</p>}
      {currentReadError && <p className="authoring-notice authoring-notice-error" role="alert">{currentDraft ? t('read.errorWithDraft', { message: currentReadError }) : currentReadError}</p>}
      {confirmRead === selection.key && <div className="authoring-confirmation" role="group" aria-label={t('read.confirmLabel')}><div><strong>{t('read.confirmTitle')}</strong><p>{t('read.confirmDescription')}</p></div><div className="authoring-confirm-actions"><button ref={readCancel} type="button" className="button button-secondary" onClick={() => { setConfirmRead(null); readTrigger.current?.focus() }}>{t('action.continue')}</button><button type="button" className="button button-danger" onClick={() => void readSnapshot(selection)}>{t('read.confirmAction')}</button></div></div>}
      {!snapshot ? <p className="authoring-read-state" role="status">{t(busy ? 'read.loading' : 'read.empty')}</p> : !currentDraft ? <p className="authoring-read-state" role="status">{t(busy ? 'read.loadingPersona' : 'read.documentEmpty')}</p> : <form className="authoring-form" onSubmit={submit}>
        {mode === 'personas' && !currentDraft.saved && <div className="authoring-new-note"><h3>{t(snapshot.personas.length === 0 ? 'new.emptyTitle' : 'new.title')}</h3><p>{t('new.description')}</p></div>}
        {mode === 'personas' && <div className="authoring-name-field"><label htmlFor="authoring-persona-name">{t('name.label')}</label><input id="authoring-persona-name" type="text" autoComplete="off" value={currentDraft.name} disabled={busy} aria-describedby="authoring-name-hint" aria-invalid={Boolean(nameError && (currentDraft.name || currentDraft.saved))} onChange={event => updateDraft('name', event.target.value)} /><p id="authoring-name-hint" className={nameError && (currentDraft.name || currentDraft.saved) ? 'authoring-field-error' : 'authoring-field-hint'}>{nameError && (currentDraft.name || currentDraft.saved) ? nameError : t('name.hint')}</p></div>}
        <div className="authoring-editor-heading"><h3>{t(mode === 'prompts' ? 'body.prompt' : 'body.persona')}</h3><span className={currentDraft.body.length > 50000 ? 'authoring-field-error' : ''}>{t('body.count', { countText: formatNumber(currentDraft.body.length), limitText: formatNumber(50000) })}</span></div>
        <div className="authoring-editor"><TemplateEditor docKey={currentDraft.key} scope={currentDraft.scope} value={currentDraft.body} onChange={value => updateDraft('body', value)} disabled={busy} ariaLabel={t(mode === 'prompts' ? 'body.prompt' : 'body.persona')} variables={snapshot.variables} /></div>
        {bodyError && (currentDraft.body.length > 0 || currentDraft.saved !== null) && <p className="authoring-field-error" role="alert">{bodyError}</p>}
        <div className="authoring-actions"><button type="submit" className="button button-primary" disabled={busy || blocked || !valid || !dirty}><Save size={15} aria-hidden="true" />{t(operation?.kind === 'save' ? 'action.saving' : mode === 'prompts' ? 'action.savePrompt' : 'action.savePersona')}</button>{mode === 'personas' && currentDraft.saved && <button type="button" className="button button-secondary" disabled={busy || blocked || !active && dirty} aria-describedby={!active && dirty ? 'authoring-activation-hint' : undefined} onClick={() => void mutate('activate')}><Power size={15} aria-hidden="true" />{t(operation?.kind === 'activate' ? active ? 'action.deactivating' : 'action.activating' : active ? 'action.deactivate' : 'action.activate')}</button>}<span className="authoring-save-state">{t(blocked ? 'status.waitingRead' : !currentDraft.saved ? 'status.notSaved' : dirty ? 'status.unsaved' : 'status.saved')}</span></div>
        {mode === 'personas' && currentDraft.saved && dirty && <p id="authoring-activation-hint" className="authoring-field-hint">{t(active ? 'activation.activeDirty' : 'activation.inactiveDirty')}</p>}
        {currentDraft.notice && <p className={`authoring-notice authoring-result authoring-notice-${currentDraft.notice.kind}`} role={currentDraft.notice.kind === 'error' ? 'alert' : 'status'}>{noticeMessage(currentDraft.notice)}</p>}
        <p className="authoring-draft-hint">{t(mode === 'prompts' ? 'draft.promptHint' : 'draft.personaHint')}</p>
        {mode === 'personas' && currentDraft.saved && <section className="authoring-delete-section" aria-label={t('delete.title')}><div><h3>{t('delete.title')}</h3><p>{t(active ? 'delete.activeHint' : 'delete.hint')}{currentDraft.saved.updatedAt && <span className="authoring-updated">{updatedLabel(currentDraft.saved.updatedAt)}</span>}</p></div><button ref={deleteTrigger} type="button" className="text-button authoring-delete-trigger" disabled={busy || blocked || active} onClick={() => { setConfirmRead(null); setConfirmDelete(currentDraft.key) }}><Trash2 size={15} aria-hidden="true" />{t('delete.title')}</button></section>}
        {confirmDelete === currentDraft.key && <div className="authoring-confirmation" role="group" aria-label={t('delete.confirmLabel', { name: currentDraft.name })}><div><strong>{t('delete.confirmTitle', { name: currentDraft.saved && 'name' in currentDraft.saved ? currentDraft.saved.name : currentDraft.name })}</strong><p>{t(dirty ? 'delete.confirmDirtyDescription' : 'delete.confirmDescription')}</p></div><div className="authoring-confirm-actions"><button ref={deleteCancel} type="button" className="button button-secondary" onClick={() => { setConfirmDelete(null); deleteTrigger.current?.focus() }}>{t('action.cancel')}</button><button type="button" className="button button-danger" disabled={busy || blocked || active} onClick={() => void mutate('delete')}><Trash2 size={15} aria-hidden="true" />{t('delete.confirmAction')}</button></div></div>}
      </form>}
    </main>
  </div>
}
