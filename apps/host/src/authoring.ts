import { randomUUID } from 'node:crypto'
import { MAX_REGISTERED_PROMPT_DOCUMENTS, MAX_TEMPLATE_BODY_LENGTH, PlatformError, TEMPLATE_VARIABLES, analyzeTemplate, getPromptTemplateScope } from '@eating/plugin-sdk'
import type { AuthoringSnapshot, HarnessOwnerConfiguration, PersonaDocument, PersonaMutationResult, PersonaSummary, PromptDocument, PromptKind, RegisteredAgentInstructions, RegisteredAgentType, TemplateScope } from '@eating/plugin-sdk'
import { defaultPromptBodies } from './authoring-defaults'
import type { HostStore } from './store'

export const AUTHORING_SETTING_KEY = 'host:authoring'
const maxDocumentBytes = 5 * 1024 * 1024
const maxPersonas = 100
const baseKinds = ['common', 'subagent', 'main'] as const

interface AuthoringData {
  schemaVersion: 2
  revision: number
  /** Three base documents plus owner overrides and reset revision records; null updatedAt follows the current default. */
  prompts: PromptDocument[]
  personas: PersonaDocument[]
  activePersonaId: string | null
}
export interface AuthoringContributions {
  readonly agentTypes: readonly RegisteredAgentType[]
  readonly pluginInstructions: readonly RegisteredAgentInstructions[]
  readonly bindings?: Readonly<Record<string, string>>
}

function defaults(): AuthoringData {
  const titles = { common: '通用提示词', subagent: '通用子代理提示词', main: '主 Agent 提示词' }
  return { schemaVersion: 2, revision: 0, prompts: baseKinds.map(id => ({ id, title: titles[id], body: defaultPromptBodies[id], scope: id, source: 'owner', revision: 0, updatedAt: null })), personas: [], activePersonaId: null }
}
function corrupted(): PlatformError {
  return new PlatformError('AUTHORING_STORAGE_CORRUPTED', '提示词或人格配置损坏，原数据未被覆盖；请检查配置后重试。', 500)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): boolean {
  return Object.keys(value).every(key => expected.includes(key) || optional.includes(key)) && expected.every(key => Object.hasOwn(value, key))
}
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function validBody(value: unknown, scope: TemplateScope): value is string {
  if (typeof value !== 'string' || value.length > MAX_TEMPLATE_BODY_LENGTH || !value.trim()) return false
  return analyzeTemplate(value, scope).valid
}
function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
}
function validLocalizedTitles(value: unknown): value is Readonly<Record<string, string>> | undefined {
  if (value === undefined) return true
  return isRecord(value) && Object.keys(value).length <= 16
    && Object.entries(value).every(([locale, title]) => locale.length <= 35 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(locale) && validTitle(title))
}
function validName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 80
}
function validPromptVersion(prompt: Record<string, unknown>, revision: number): boolean {
  return isRevision(prompt.revision) && prompt.revision <= revision && (prompt.updatedAt === null || prompt.revision > 0 && isTimestamp(prompt.updatedAt))
}
function validatePersonas(value: Record<string, unknown>): void {
  if (!Array.isArray(value.personas) || value.personas.length > maxPersonas) throw corrupted()
  const ids = new Set<string>()
  for (const persona of value.personas) {
    if (!isRecord(persona) || !exactKeys(persona, ['id', 'name', 'body', 'revision', 'createdAt', 'updatedAt'])
      || typeof persona.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(persona.id) || ids.has(persona.id)
      || !validName(persona.name) || !validBody(persona.body, 'persona') || !isRevision(persona.revision) || persona.revision < 1 || persona.revision > Number(value.revision)
      || !isTimestamp(persona.createdAt) || !isTimestamp(persona.updatedAt) || persona.createdAt > persona.updatedAt) throw corrupted()
    ids.add(persona.id)
  }
  if (value.activePersonaId !== null && (typeof value.activePersonaId !== 'string' || !ids.has(value.activePersonaId))) throw corrupted()
}
function validateData(value: unknown): AuthoringData {
  if (!isRecord(value)) throw corrupted()
  if (!exactKeys(value, ['schemaVersion', 'revision', 'prompts', 'personas', 'activePersonaId']) || value.schemaVersion !== 2 || !isRevision(value.revision)
    || !Array.isArray(value.prompts) || value.prompts.length < 3 || value.prompts.length > MAX_REGISTERED_PROMPT_DOCUMENTS + 3) throw corrupted()
  const ids = new Set<string>()
  for (const prompt of value.prompts) {
    if (!isRecord(prompt) || typeof prompt.id !== 'string' || ids.has(prompt.id)) throw corrupted()
    const scope = getPromptTemplateScope(prompt.id)
    const plugin = scope === 'agent' || scope === 'plugin'
    if (!scope || prompt.scope !== scope || prompt.source !== (plugin ? 'plugin' : 'owner')
      || !exactKeys(prompt, ['id', 'title', 'body', 'revision', 'updatedAt', 'scope', 'source'], plugin ? ['pluginId', 'agentTypeId', 'defaultBody'] : [])
      || !validTitle(prompt.title) || !validBody(prompt.body, scope) || !validPromptVersion(prompt, value.revision)) throw corrupted()
    if (plugin && (typeof prompt.pluginId !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(prompt.pluginId) || prompt.pluginId.length > 80
      || !prompt.id.slice(prompt.id.indexOf(':') + 1).startsWith(`${prompt.pluginId}.`) || !validBody(prompt.defaultBody, scope)
      || (scope === 'agent' ? prompt.agentTypeId !== prompt.id.slice(6) : Object.hasOwn(prompt, 'agentTypeId')))) throw corrupted()
    ids.add(prompt.id)
  }
  if (baseKinds.some(id => !ids.has(id))) throw corrupted()
  validatePersonas(value)
  return value as unknown as AuthoringData
}
function summary(persona: PersonaDocument): PersonaSummary {
  return { id: persona.id, name: persona.name, revision: persona.revision, createdAt: persona.createdAt, updatedAt: persona.updatedAt }
}
function checkRevision(actual: number, expected: number): void {
  if (!isRevision(expected) || actual !== expected) throw new PlatformError('AUTHORING_REVISION_CONFLICT', '配置已被其他操作修改，请重新读取后重试。', 409)
}
function incrementRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new PlatformError('AUTHORING_REVISION_EXHAUSTED', '配置版本已达到上限，未保存修改。', 500)
  return revision + 1
}
function requireBody(body: string, scope: TemplateScope): void {
  if (typeof body !== 'string' || !body.trim()) throw new PlatformError('INVALID_TEMPLATE', '模板正文不能为空。')
  if (body.length > MAX_TEMPLATE_BODY_LENGTH) throw new PlatformError('INVALID_TEMPLATE', '模板正文不能超过 50000 个 UTF-16 字符。')
  const analysis = analyzeTemplate(body, scope)
  if (!analysis.valid) throw new PlatformError('INVALID_TEMPLATE', analysis.diagnostics[0]?.message ?? '模板无效。')
}
function requireName(name: string): string {
  if (typeof name !== 'string') throw new PlatformError('INVALID_PERSONA_NAME', '人格名称需为 1 至 80 个字符。')
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 80) throw new PlatformError('INVALID_PERSONA_NAME', '人格名称需为 1 至 80 个字符。')
  return trimmed
}
function contributedPrompts(contributions: AuthoringContributions): PromptDocument[] {
  const invalid = (): never => { throw new PlatformError('INVALID_AGENT_CONTRIBUTION', '插件代理提示词声明无效或数量超过上限。', 500) }
  if (!Array.isArray(contributions.agentTypes) || !Array.isArray(contributions.pluginInstructions)
    || contributions.agentTypes.length + contributions.pluginInstructions.length > MAX_REGISTERED_PROMPT_DOCUMENTS) invalid()
  const result: PromptDocument[] = []
  const add = (id: PromptKind, title: string, body: string, pluginId: string, scope: 'agent' | 'plugin', enabled: boolean, localizedTitles: Readonly<Record<string, string>> | undefined, agentTypeId?: string): void => {
    if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(pluginId) || pluginId.length > 80
      || getPromptTemplateScope(id) !== scope || !id.slice(id.indexOf(':') + 1).startsWith(`${pluginId}.`) || !validTitle(title)
      || !validLocalizedTitles(localizedTitles) || !validBody(body, scope) || typeof enabled !== 'boolean' || result.some(document => document.id === id)) invalid()
    result.push({ id, title, ...(localizedTitles === undefined ? {} : { localizedTitles: { ...localizedTitles } }), body, scope, source: 'plugin', pluginId, ...(agentTypeId === undefined ? {} : { agentTypeId }), defaultBody: body, revision: 0, updatedAt: null, enabled, available: true })
  }
  for (const role of contributions.agentTypes) add(`agent:${role.id}`, role.title, role.defaultPrompt, role.pluginId, 'agent', role.enabled, role.localizedTitles, role.id)
  for (const instruction of contributions.pluginInstructions) add(`plugin:${instruction.id}`, instruction.title, instruction.body, instruction.pluginId, 'plugin', instruction.enabled, instruction.localizedTitles)
  return result
}
function prompts(data: AuthoringData, contributions: AuthoringContributions): PromptDocument[] {
  const registered = contributedPrompts(contributions)
  const overrides = new Map(data.prompts.filter(prompt => prompt.source === 'plugin').map(prompt => [prompt.id, prompt]))
  const result: PromptDocument[] = baseKinds.map(id => {
    const document = data.prompts.find(prompt => prompt.id === id)!
    return { ...document, body: document.updatedAt === null ? defaultPromptBodies[id] : document.body, defaultBody: defaultPromptBodies[id], enabled: true, available: true }
  })
  for (const document of registered) {
    const override = overrides.get(document.id)
    result.push(override ? { ...document, body: override.updatedAt === null ? document.body : override.body, revision: override.revision, updatedAt: override.updatedAt } : { ...document })
    overrides.delete(document.id)
  }
  for (const document of overrides.values()) result.push({ ...document, enabled: false, available: false })
  return result
}
function snapshot(data: AuthoringData, contributions: AuthoringContributions): AuthoringSnapshot {
  return { protocolVersion: 1, revision: data.revision, prompts: prompts(data, contributions),
    personas: data.personas.map(summary), activePersonaId: data.activePersonaId,
    variables: TEMPLATE_VARIABLES.map(variable => ({ ...variable, scopes: [...variable.scopes] })) }
}

/** Synchronous owner-only CAS. Callback collection precedes storage reads; no callback splits a CAS write. */
export class AuthoringService {
  constructor(private readonly store: Pick<HostStore, 'getSetting' | 'setSetting'>,
    private readonly contributions: () => AuthoringContributions = () => ({ agentTypes: [], pluginInstructions: [] })) {}

  private read(): AuthoringData {
    const saved = this.store.getSetting(AUTHORING_SETTING_KEY)
    if (saved === null) return defaults()
    if (Buffer.byteLength(saved, 'utf8') > maxDocumentBytes) throw corrupted()
    let parsed: unknown
    try { parsed = JSON.parse(saved) } catch { throw corrupted() }
    return validateData(parsed)
  }
  private state(): { data: AuthoringData; contributions: AuthoringContributions } {
    const contributions = this.contributions()
    contributedPrompts(contributions)
    return { data: this.read(), contributions }
  }
  private save(data: AuthoringData): void {
    data.revision = incrementRevision(data.revision)
    const saved = JSON.stringify(data)
    if (Buffer.byteLength(saved, 'utf8') > maxDocumentBytes) throw new PlatformError('AUTHORING_CAPACITY_EXCEEDED', '提示词与人格配置总量不能超过 5 MiB，请缩减正文后重试。')
    this.store.setSetting(AUTHORING_SETTING_KEY, saved)
  }
  private findPersona(data: AuthoringData, id: string): PersonaDocument {
    const persona = data.personas.find(document => document.id === id)
    if (!persona) throw new PlatformError('PERSONA_NOT_FOUND', '人格不存在。', 404)
    return persona
  }
  getSnapshot(): AuthoringSnapshot { const state = this.state(); return snapshot(state.data, state.contributions) }
  getPersona(id: string): PersonaDocument { return { ...this.findPersona(this.read(), id) } }
  readOwnerConfiguration(): HarnessOwnerConfiguration {
    const { data, contributions } = this.state()
    const bindings: Record<string, string> = {}
    for (const variable of TEMPLATE_VARIABLES) {
      if (variable.origin === 'persona') continue
      const value = contributions.bindings && Object.hasOwn(contributions.bindings, variable.name) ? contributions.bindings[variable.name] : undefined
      if (value !== undefined && typeof value !== 'string') throw new PlatformError('INVALID_AGENT_CONTRIBUTION', '主人变量配置无效。', 500)
      if (value !== undefined) bindings[variable.name] = value
      else if (variable.name !== '当前时间') bindings[variable.name] = ''
    }
    return { revision: data.revision, prompts: prompts(data, contributions),
      activePersona: data.activePersonaId === null ? null : { ...this.findPersona(data, data.activePersonaId) },
      agentTypes: structuredClone(contributions.agentTypes), pluginInstructions: structuredClone(contributions.pluginInstructions), bindings }
  }
  updatePrompt(id: string, body: string, expectedRevision: number): AuthoringSnapshot {
    const { data, contributions } = this.state()
    const current = prompts(data, contributions).find(prompt => prompt.id === id)
    if (!current) throw new PlatformError('PROMPT_NOT_FOUND', '提示词不存在。', 404)
    if (current.available === false) throw new PlatformError('PROMPT_SOURCE_UNAVAILABLE', '提示词来源插件不可用，未保存修改。', 409)
    checkRevision(current.revision, expectedRevision)
    const scope = getPromptTemplateScope(id)
    if (!scope) throw new PlatformError('PROMPT_NOT_FOUND', '提示词不存在。', 404)
    requireBody(body, scope)
    if (current.body === body) return snapshot(data, contributions)
    const { enabled: _enabled, available: _available, defaultBody: _defaultBody, localizedTitles: _localizedTitles, ...document } = current
    const next: PromptDocument = { ...document, body, scope, source: current.source, revision: incrementRevision(current.revision), updatedAt: new Date().toISOString(),
      ...(current.source === 'plugin' ? { defaultBody: current.defaultBody! } : {}) }
    const index = data.prompts.findIndex(prompt => prompt.id === id)
    if (index === -1) {
      if (data.prompts.length >= MAX_REGISTERED_PROMPT_DOCUMENTS + 3) throw new PlatformError('AUTHORING_PROMPT_LIMIT_REACHED', '保存的插件提示词数量已达到上限。')
      data.prompts.push(next)
    } else data.prompts[index] = next
    this.save(data)
    return snapshot(data, contributions)
  }
  resetPrompt(id: string, expectedRevision: number): AuthoringSnapshot {
    const { data, contributions } = this.state()
    const current = prompts(data, contributions).find(prompt => prompt.id === id)
    if (!current) throw new PlatformError('PROMPT_NOT_FOUND', '提示词不存在。', 404)
    if (current.available === false) throw new PlatformError('PROMPT_SOURCE_UNAVAILABLE', '提示词来源插件不可用，未保存修改。', 409)
    checkRevision(current.revision, expectedRevision)
    if (current.updatedAt === null) return snapshot(data, contributions)
    // Retain plugin records as well: deleting one would allow an earlier CAS revision to recur.
    const index = data.prompts.findIndex(prompt => prompt.id === id)
    data.prompts[index] = { ...data.prompts[index]!, body: current.defaultBody!, revision: incrementRevision(current.revision), updatedAt: null,
      ...(current.source === 'plugin' ? { defaultBody: current.defaultBody! } : {}) }
    this.save(data)
    return snapshot(data, contributions)
  }
  createPersona(name: string, body: string): PersonaMutationResult {
    const { data, contributions } = this.state()
    const normalizedName = requireName(name)
    requireBody(body, 'persona')
    if (data.personas.length >= maxPersonas) throw new PlatformError('PERSONA_LIMIT_REACHED', '最多保存 100 个人格，请先删除不需要的人格。')
    const now = new Date().toISOString()
    const persona: PersonaDocument = { id: randomUUID(), name: normalizedName, body, revision: 1, createdAt: now, updatedAt: now }
    data.personas.push(persona)
    this.save(data)
    return { snapshot: snapshot(data, contributions), persona: { ...persona } }
  }
  updatePersona(id: string, name: string, body: string, expectedRevision: number): PersonaMutationResult {
    const { data, contributions } = this.state()
    const current = this.findPersona(data, id)
    checkRevision(current.revision, expectedRevision)
    const normalizedName = requireName(name)
    requireBody(body, 'persona')
    if (current.name === normalizedName && current.body === body) return { snapshot: snapshot(data, contributions), persona: { ...current } }
    const persona: PersonaDocument = { ...current, name: normalizedName, body, revision: incrementRevision(current.revision), updatedAt: new Date().toISOString() }
    data.personas[data.personas.indexOf(current)] = persona
    this.save(data)
    return { snapshot: snapshot(data, contributions), persona: { ...persona } }
  }
  setPersonaEnabled(id: string, enabled: boolean, expectedRevision: number): AuthoringSnapshot {
    const { data, contributions } = this.state()
    checkRevision(data.revision, expectedRevision)
    this.findPersona(data, id)
    if (typeof enabled !== 'boolean') throw new PlatformError('INVALID_PERSONA_STATE', '人格启用状态需为布尔值。')
    const nextActiveId = enabled ? id : data.activePersonaId === id ? null : data.activePersonaId
    if (nextActiveId === data.activePersonaId) return snapshot(data, contributions)
    data.activePersonaId = nextActiveId
    this.save(data)
    return snapshot(data, contributions)
  }
  deletePersona(id: string, expectedRevision: number): AuthoringSnapshot {
    const { data, contributions } = this.state()
    const persona = this.findPersona(data, id)
    checkRevision(persona.revision, expectedRevision)
    if (data.activePersonaId === id) throw new PlatformError('ACTIVE_PERSONA', '请先停用当前人格或切换到其他人格，再删除。', 409)
    data.personas = data.personas.filter(document => document.id !== id)
    this.save(data)
    return snapshot(data, contributions)
  }
}
