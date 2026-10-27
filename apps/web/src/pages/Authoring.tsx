import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronRight, FileText, Info, Plus, Power, RefreshCw, Save, Trash2, UserRound } from 'lucide-react'
import { analyzeTemplate } from '@eating/plugin-sdk'
import type { AuthoringSnapshot, PersonaDocument, PersonaMutationResult, PersonaSummary, PromptDocument, PromptKind, TemplateScope } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import { TemplateEditor } from '../components/TemplateEditor'
import './Authoring.css'

export interface AuthoringProps {
  readonly mode: 'prompts' | 'personas'
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onFeedback: (message: string) => void
}

type Notice = { readonly kind: 'error' | 'success' | 'info'; readonly message: string }
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
const promptLabels: Readonly<Record<PromptKind, string>> = { main: '主Agent提示词', group: '群聊提示词', private: '私聊提示词' }
const promptDescriptions: Readonly<Record<PromptKind, string>> = {
  main: '管理同一 AI 的通用指引与行为约定。',
  group: '管理群聊消息交给 AI 时使用的提示词。',
  private: '管理私聊消息交给 AI 时使用的提示词。',
}
const personaIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const promptKind = (id: string | null): PromptKind => promptKinds.includes(id as PromptKind) ? id as PromptKind : 'main'
const revisionValid = (value: number) => Number.isSafeInteger(value) && value >= 0
const responseError = () => new HostApiError('INVALID_HOST_RESPONSE', '后台返回的提示词或人格数据不完整，请重新读取。')

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
  if (isConflict(error)) return '内容或使用状态已在其他位置更改。原草稿与保存版本已保留，请重新读取；有未保存修改时需先确认放弃。'
  if (error instanceof HostApiError) {
    if (error.outcome === 'unknown' && kind !== 'read') return '操作结果尚未确认。原草稿已保留，请重新读取核对真实结果后再操作。'
    if (error.code === 'ACTIVE_PERSONA') return `${error.message} 请重新读取核对使用状态，先停用后再删除。`
    return error.message
  }
  return kind === 'read' ? '无法读取数据，请检查后台运行状态后重新读取。' : '操作未完成，原草稿已保留，请稍后重试。'
}

function updatedLabel(value: string | null): string {
  if (!value) return '尚未修改'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '更新时间不可用' : `更新于 ${date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
}

export function Authoring({ mode, selectedId, onSelect, onFeedback }: AuthoringProps) {
  const [snapshot, setSnapshot] = useState<AuthoringSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [operation, setOperation] = useState<{ readonly kind: Operation; readonly key: string | null } | null>({ kind: 'read', key: null })
  const [readError, setReadError] = useState<{ readonly key: string | null; readonly message: string } | null>(null)
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
  const bodyError = currentDraft && currentDraft.body.length > 50000 ? '内容不能超过 50000 个字符。'
    : currentDraft && !currentDraft.body.trim() ? '内容不能为空，请填写后保存。' : null
  const nameError = currentDraft?.scope === 'persona' && (!currentDraft.name.trim() || currentDraft.name.trim().length > 80) ? '人格名称需为 1 至 80 个字符。' : null
  const valid = Boolean(currentDraft && !bodyError && !nameError && analysis?.valid)
  const busy = operation !== null
  const mutating = busy && operation.kind !== 'read'
  const active = Boolean(currentDraft?.saved && snapshot?.activePersonaId === currentDraft.id && mode === 'personas')
  const blocked = snapshotNeedsRead || Boolean(currentDraft?.requiresRead)
  const currentReadError = readError && (readError.key === null || readError.key === selection.key) ? readError.message : null
  const title = mode === 'prompts' ? promptLabels[promptKind(resolvedId)] : !snapshot ? '人格管理' : resolvedId === 'new' ? '新增人格' : currentDraft?.saved && 'name' in currentDraft.saved ? currentDraft.saved.name : snapshot.personas.find(persona => persona.id === resolvedId)?.name ?? '人格设定'

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
      if (draft) replaceDrafts({ ...draftsRef.current, [draft.key]: { ...draft, requiresRead: true, notice: { kind: 'error', message: '操作已中断，结果尚未确认。原草稿已保留，请重新读取核对后再操作。' } } })
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
      if (isCurrent(ticket)) setReadError({ key: target?.key ?? null, message: errorMessage(error, 'read') })
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
            if (isCurrent(ticket)) setReadError({ key, message: errorMessage(error, 'read') })
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
      let message: string
      if (kind === 'save' && draft.scope !== 'persona') {
        if (!draft.saved) throw responseError()
        next = checkSnapshot(await hostRequest<AuthoringSnapshot>(`/prompts/${encodeURIComponent(draft.id)}`, {
          method: 'POST', signal: ticket.controller.signal, body: { expectedRevision: draft.saved.revision, body: draft.body },
        }))
        const doc = next.prompts.find(prompt => prompt.id === draft.id)
        if (!doc) throw responseError()
        savedDraft = promptDraft(doc)
        message = '提示词已保存'
      } else if (kind === 'save') {
        const result = checkMutation(await hostRequest<PersonaMutationResult>(draft.saved ? `/personas/${encodeURIComponent(draft.id)}` : '/personas', {
          method: 'POST', signal: ticket.controller.signal,
          body: { ...(draft.saved ? { expectedRevision: draft.saved.revision } : {}), name: draft.name.trim(), body: draft.body },
        }), draft.saved ? draft.id : undefined)
        next = result.snapshot
        savedDraft = personaDraft(result.persona)
        if (!draft.saved) createdId = result.persona.id
        message = draft.saved ? '人格已保存' : '人格已保存，可单独启用'
      } else if (kind === 'activate') {
        next = checkSnapshot(await hostRequest<AuthoringSnapshot>(`/personas/${encodeURIComponent(draft.id)}/activate`, {
          method: 'POST', signal: ticket.controller.signal, body: { expectedRevision: index.revision, enabled: !currentlyActive },
        }))
        message = currentlyActive ? '人格已停用' : '人格已设为使用中'
      } else {
        if (!draft.saved) throw responseError()
        next = checkSnapshot(await hostRequest<AuthoringSnapshot>(`/personas/${encodeURIComponent(draft.id)}/delete`, {
          method: 'POST', signal: ticket.controller.signal, body: { expectedRevision: draft.saved.revision, confirmed: true },
        }))
        message = '人格已删除'
      }
      if (!isCurrent(ticket)) return
      const nextDrafts = { ...draftsRef.current }
      if (kind === 'delete') delete nextDrafts[draft.key]
      else if (savedDraft) {
        nextDrafts[savedDraft.key] = { ...savedDraft, notice: { kind: 'success', message } }
        if (createdId) nextDrafts[draft.key] = emptyPersona()
      } else nextDrafts[draft.key] = { ...draft, notice: { kind: 'success', message } }
      replaceDrafts(nextDrafts)
      replaceSnapshot(next)
      feedback.current(message)
    } catch (error) {
      if (!isCurrent(ticket)) return
      const original = draftsRef.current[draft.key] ?? draft
      replaceDrafts({ ...draftsRef.current, [draft.key]: { ...original, requiresRead: needsRead(error) || original.requiresRead, notice: { kind: 'error', message: errorMessage(error, kind) } } })
      if (needsRead(error)) requireSnapshotRead(true)
    } finally { finishRequest(ticket) }
    if (!mounted.current || selectedKey.current !== draft.key) return
    if (createdId && draftsRef.current[`personas:${createdId}`]) select.current(createdId)
    else if (kind === 'delete' && !draftsRef.current[draft.key]) select.current('new')
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void mutate('save') }

  return <div className="robot-workspace authoring-workspace">
    <aside className="platform-sidebar authoring-sidebar">
      <p className="platform-nav-heading">{mode === 'prompts' ? '提示词分类' : '已保存人格'}{mode === 'personas' && snapshot && <span>{snapshot.personas.length}</span>}</p>
      <nav aria-label={mode === 'prompts' ? '提示词分类' : '人格列表'}>
        {mode === 'prompts' ? promptKinds.map(id => <button key={id} type="button" disabled={!snapshot || mutating} className={`platform-nav-item ${resolvedId === id ? 'is-selected' : ''}`} aria-current={resolvedId === id ? 'page' : undefined} onClick={() => choose(id)}><FileText size={18} /><span>{promptLabels[id]}</span>{resolvedId === id && <ChevronRight size={15} className="nav-chevron" />}</button>) : <>
          {!snapshot ? <p className="authoring-sidebar-state">{busy ? '正在读取人格列表…' : '人格列表尚未读取'}</p> : snapshot.personas.length === 0 ? <p className="authoring-sidebar-state">尚未保存人格</p> : snapshot.personas.map(persona => <button key={persona.id} type="button" disabled={mutating} className={`platform-nav-item authoring-persona-item ${resolvedId === persona.id ? 'is-selected' : ''}`} aria-current={resolvedId === persona.id ? 'page' : undefined} onClick={() => choose(persona.id)}><UserRound size={18} /><span title={persona.name}>{persona.name}</span>{snapshot.activePersonaId === persona.id && <small className="authoring-active-label">使用中</small>}{drafts[`personas:${persona.id}`] && isDirty(drafts[`personas:${persona.id}`]!) && <span className="authoring-draft-mark" aria-label="有未保存修改" />}</button>)}
          <button type="button" disabled={!snapshot || mutating} className={`platform-nav-item authoring-new-button ${snapshot && resolvedId === 'new' ? 'is-selected' : ''}`} aria-current={snapshot && resolvedId === 'new' ? 'page' : undefined} onClick={() => choose('new')}><Plus size={18} /><span>新增人格</span></button>
        </>}
      </nav>
      <div className="platform-sidebar-footer"><Info size={17} /><p>{mode === 'prompts' ? <>各分类独立保存，<br />切换时保留本页草稿。</> : <>同一 AI 的候选配置，<br />一次仅一个生效。</>}</p></div>
    </aside>
    <main id="main-content" className="robot-content authoring-content" aria-busy={busy}>
      <div className="authoring-title-row"><div><div className="panel-title-row"><h2>{title}</h2>{active && <span className="status-badge authoring-active-badge"><Check size={12} />使用中</span>}</div><p className="panel-description">{mode === 'prompts' ? promptDescriptions[promptKind(resolvedId)] : '人格是同一 AI 的候选配置，可保存多个，也可以全部停用。'}</p></div><button ref={readTrigger} type="button" className="button button-secondary authoring-read-button" disabled={busy} onClick={requestRead}><RefreshCw size={15} />{operation?.kind === 'read' ? '正在读取…' : mode === 'prompts' ? '重新读取提示词' : '重新读取人格'}</button></div>
      <div className="authoring-runtime-note"><Info size={16} /><p>保存内容由 Eating 持久保管。接入 Harness 后用于后续消息，编辑不会打断当前轮次。</p></div>
      {snapshotNeedsRead && <p className="authoring-notice authoring-notice-error" role="alert">内容或操作结果需要重新核对，请点击“{mode === 'prompts' ? '重新读取提示词' : '重新读取人格'}”后继续。各文档的原草稿已保留。</p>}
      {currentReadError && <p className="authoring-notice authoring-notice-error" role="alert">{currentReadError}{currentDraft ? ' 原草稿与保存版本均已保留。' : ''}</p>}
      {confirmRead === selection.key && <div className="authoring-confirmation" role="group" aria-label="确认放弃当前文档修改并重新读取"><div><strong>放弃当前文档的未保存修改？</strong><p>重新读取成功后，将以后台最新内容替换当前草稿。其他文档的草稿保留；读取失败时当前草稿也会保留。</p></div><div className="authoring-confirm-actions"><button ref={readCancel} type="button" className="button button-secondary" onClick={() => { setConfirmRead(null); readTrigger.current?.focus() }}>继续编辑</button><button type="button" className="button button-danger" onClick={() => void readSnapshot(selection)}>放弃修改并重新读取</button></div></div>}
      {!snapshot ? <p className="authoring-read-state" role="status">{busy ? '正在读取后台保存的内容…' : '读取成功后即可编辑提示词和人格。'}</p> : !currentDraft ? <p className="authoring-read-state" role="status">{busy ? '正在读取人格设定…' : '当前文档尚未读取，请重新读取或选择其他人格。'}</p> : <form className="authoring-form" onSubmit={submit}>
        {mode === 'personas' && !currentDraft.saved && <div className="authoring-new-note"><h3>{snapshot.personas.length === 0 ? '还没有已保存的人格' : '创建一个候选人格'}</h3><p>填写名称与设定后保存。保存不会自动启用人格。</p></div>}
        {mode === 'personas' && <div className="authoring-name-field"><label htmlFor="authoring-persona-name">人格名称</label><input id="authoring-persona-name" type="text" autoComplete="off" value={currentDraft.name} disabled={busy} aria-describedby="authoring-name-hint" aria-invalid={Boolean(nameError && (currentDraft.name || currentDraft.saved))} onChange={event => updateDraft('name', event.target.value)} /><p id="authoring-name-hint" className={nameError && (currentDraft.name || currentDraft.saved) ? 'authoring-field-error' : 'authoring-field-hint'}>{nameError && (currentDraft.name || currentDraft.saved) ? nameError : '1 至 80 个字符，用于区分同一 AI 的不同候选配置。'}</p></div>}
        <div className="authoring-editor-heading"><h3>{mode === 'prompts' ? '提示词内容' : '人格设定'}</h3><span className={currentDraft.body.length > 50000 ? 'authoring-field-error' : ''}>{currentDraft.body.length.toLocaleString('zh-CN')} / 50,000 字符</span></div>
        <div className="authoring-editor"><TemplateEditor docKey={currentDraft.key} scope={currentDraft.scope} value={currentDraft.body} onChange={value => updateDraft('body', value)} disabled={busy} ariaLabel={mode === 'prompts' ? '提示词内容' : '人格设定'} variables={snapshot.variables} /></div>
        {bodyError && (currentDraft.body.length > 0 || currentDraft.saved !== null) && <p className="authoring-field-error" role="alert">{bodyError}</p>}
        <div className="authoring-actions"><button type="submit" className="button button-primary" disabled={busy || blocked || !valid || !dirty}><Save size={15} />{operation?.kind === 'save' ? '正在保存…' : mode === 'prompts' ? '保存提示词' : '保存人格'}</button>{mode === 'personas' && currentDraft.saved && <button type="button" className="button button-secondary" disabled={busy || blocked || !active && dirty} aria-describedby={!active && dirty ? 'authoring-activation-hint' : undefined} onClick={() => void mutate('activate')}><Power size={15} />{operation?.kind === 'activate' ? active ? '正在停用…' : '正在启用…' : active ? '停用人格' : '启用人格'}</button>}<span className="authoring-save-state">{blocked ? '等待重新读取' : !currentDraft.saved ? '尚未保存' : dirty ? '有未保存修改' : '已保存'}</span></div>
        {mode === 'personas' && currentDraft.saved && dirty && <p id="authoring-activation-hint" className="authoring-field-hint">{active ? '正在使用已保存的版本；保存后才会更新后续消息使用的内容。' : '请先保存修改，再启用人格，避免启用旧版本。'}</p>}
        {currentDraft.notice && <p className={`authoring-notice authoring-result authoring-notice-${currentDraft.notice.kind}`} role={currentDraft.notice.kind === 'error' ? 'alert' : 'status'}>{currentDraft.notice.message}</p>}
        <p className="authoring-draft-hint">切换{mode === 'prompts' ? '分类' : '人格'}会保留本页各文档的未保存草稿。离开此管理页前请保存。</p>
        {mode === 'personas' && currentDraft.saved && <section className="authoring-delete-section" aria-label="删除人格"><div><h3>删除人格</h3><p>{active ? '使用中的人格不能删除，请先停用或启用另一个已保存人格。' : '删除这个候选配置，不影响其他人格的内容与使用状态。'}{currentDraft.saved.updatedAt && <span className="authoring-updated">{updatedLabel(currentDraft.saved.updatedAt)}</span>}</p></div><button ref={deleteTrigger} type="button" className="text-button authoring-delete-trigger" disabled={busy || blocked || active} onClick={() => { setConfirmRead(null); setConfirmDelete(currentDraft.key) }}><Trash2 size={15} />删除人格</button></section>}
        {confirmDelete === currentDraft.key && <div className="authoring-confirmation" role="group" aria-label={`确认删除人格${currentDraft.name}`}><div><strong>确定删除“{currentDraft.saved && 'name' in currentDraft.saved ? currentDraft.saved.name : currentDraft.name}”？</strong><p>删除后无法恢复{dirty ? '，此人格未保存的修改也会丢弃' : ''}。其他人格与当前使用状态保持不变。</p></div><div className="authoring-confirm-actions"><button ref={deleteCancel} type="button" className="button button-secondary" onClick={() => { setConfirmDelete(null); deleteTrigger.current?.focus() }}>取消</button><button type="button" className="button button-danger" disabled={busy || blocked || active} onClick={() => void mutate('delete')}><Trash2 size={15} />确认删除人格</button></div></div>}
      </form>}
    </main>
  </div>
}
