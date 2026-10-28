import { PlatformError } from './index'
import type { HarnessOwnerConfiguration } from './index'
import type { AgentPromptPreview } from './agents'

export type PromptKind = 'common' | 'subagent' | 'main' | 'group' | 'private' | `agent:${string}` | `plugin:${string}`
export type TemplateScope = 'common' | 'subagent' | 'main' | 'agent' | 'plugin' | 'group' | 'private' | 'persona'

export const TEMPLATE_SCOPES: readonly TemplateScope[] = Object.freeze(['common', 'subagent', 'main', 'agent', 'plugin', 'group', 'private', 'persona'])
export const SYSTEM_TEMPLATE_SCOPES: readonly TemplateScope[] = Object.freeze(['common', 'subagent', 'main', 'agent', 'plugin', 'persona'])
export const MAX_REGISTERED_PROMPT_DOCUMENTS = 256

/** Shared by editors, Host validation and system prompt composition. */
export function getPromptTemplateScope(id: string): TemplateScope | null {
  if (id === 'common' || id === 'subagent' || id === 'main' || id === 'group' || id === 'private') return id
  if (/^agent:[a-z0-9][a-z0-9._-]{0,159}$/u.test(id)) return 'agent'
  if (/^plugin:[a-z0-9][a-z0-9._-]{0,159}$/u.test(id)) return 'plugin'
  return null
}

export interface TemplateVariable {
  readonly name: string
  readonly description: string
  readonly scopes: readonly TemplateScope[]
  readonly origin: 'runtime' | 'persona' | 'owner' | 'external'
}

/** Offsets use JavaScript UTF-16 code units and an exclusive `to`. */
export interface TemplateDiagnostic {
  readonly from: number
  readonly to: number
  readonly code: 'UNKNOWN_VARIABLE' | 'UNAVAILABLE_VARIABLE' | 'UNCLOSED_VARIABLE' | 'MALFORMED_VARIABLE'
  readonly message: string
}

export interface TemplateToken {
  readonly from: number
  readonly to: number
  readonly name: string
  readonly closed: boolean
  readonly valid: boolean
}

export interface TemplateAnalysis {
  readonly valid: boolean
  readonly tokens: readonly TemplateToken[]
  readonly diagnostics: readonly TemplateDiagnostic[]
}

export interface PromptDocument {
  readonly id: PromptKind
  readonly title: string
  readonly localizedTitles?: Readonly<Record<string, string>>
  readonly body: string
  readonly revision: number
  readonly updatedAt: string | null
  readonly scope?: TemplateScope
  readonly source?: 'owner' | 'plugin' | 'legacy-user-input'
  readonly pluginId?: string
  readonly agentTypeId?: string
  readonly defaultBody?: string
  readonly enabled?: boolean
  readonly available?: boolean
}

export interface PersonaSummary {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PersonaDocument extends PersonaSummary {
  readonly body: string
}

export interface AuthoringSnapshot {
  readonly protocolVersion: 1
  readonly revision: number
  readonly prompts: readonly PromptDocument[]
  /** Saved v1 group/private templates: user input only, never system layers. */
  readonly legacyPrompts?: readonly PromptDocument[]
  readonly personas: readonly PersonaSummary[]
  readonly activePersonaId: string | null
  readonly variables: readonly TemplateVariable[]
}

export interface PersonaMutationResult {
  readonly snapshot: AuthoringSnapshot
  readonly persona: PersonaDocument
}

export const MAX_TEMPLATE_BODY_LENGTH = 50_000

const allScopes = TEMPLATE_SCOPES
const runtimeScopes: readonly TemplateScope[] = Object.freeze(['main', 'agent', 'group', 'private'])
const messageScopes: readonly TemplateScope[] = Object.freeze(['group', 'private'])

/** Only fields available from the current normalized runtime/batch contract. */
export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = Object.freeze([
  Object.freeze({ name: '当前时间', description: '渲染时的当前时间。', scopes: allScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '人格名称', description: '主人当前启用的人格名称；未启用时由调用方明确提供空值。', scopes: allScopes, origin: 'persona' as const }),
  Object.freeze({ name: '主人', description: '主人在本地配置的身份列表或带平台前缀的摘要；外部正文不能改变此值。', scopes: allScopes, origin: 'owner' as const }),
  Object.freeze({ name: '管理员', description: '主人在本地配置的管理员身份列表或带平台前缀的摘要。', scopes: allScopes, origin: 'owner' as const }),
  Object.freeze({ name: '平台', description: '本批消息所属平台的实际 platform id。', scopes: runtimeScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '机器人账号', description: '本批消息所属的实际机器人账号标识。', scopes: runtimeScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '会话编号', description: '本批消息的实际 conversationId。', scopes: runtimeScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '会话类型', description: '本批消息的会话类型：group 或 private。', scopes: runtimeScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '目标编号', description: '受信运行上下文的目标 ID；无当前来源时明确为空。', scopes: runtimeScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '发送者列表', description: '本批唯一发送者 ID 的 JSON 列表。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '消息列表', description: '带逐条来源的完整本批 JSON。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '消息内容', description: '本批最新一条文本。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '消息数量', description: '本批消息条数。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '批次编号', description: '本批消息的稳定 batchId。', scopes: messageScopes, origin: 'external' as const }),
])

const variablesByName = new Map(TEMPLATE_VARIABLES.map(variable => [variable.name, variable]))

/**
 * Scan once, keeping nested delimiters inside their outer token. A lone `}}`
 * outside a variable is ordinary text. Empty bodies are valid here; saving
 * nonempty owner configuration is the Host service's responsibility.
 */
export function analyzeTemplate(body: string, scope: TemplateScope): TemplateAnalysis {
  const tokens: TemplateToken[] = []
  const diagnostics: TemplateDiagnostic[] = []
  if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
    return { valid: false, tokens, diagnostics: [{ from: MAX_TEMPLATE_BODY_LENGTH, to: body.length,
      code: 'MALFORMED_VARIABLE', message: '模板正文不能超过 50000 个 UTF-16 字符。' }] }
  }
  let cursor = 0
  while (cursor < body.length) {
    if (body[cursor] !== '{' || body[cursor + 1] !== '{') { cursor += 1; continue }
    const from = cursor
    cursor += 2
    let depth = 1
    let malformedFrom: number | null = null
    let malformedTo = 0
    while (cursor < body.length && depth > 0) {
      if (body[cursor] === '{' && body[cursor + 1] === '{') {
        if (malformedFrom === null) { malformedFrom = cursor; malformedTo = cursor + 2 }
        depth += 1
        cursor += 2
      } else if (body[cursor] === '}' && body[cursor + 1] === '}') {
        depth -= 1
        cursor += 2
      } else {
        if ((body[cursor] === '{' || body[cursor] === '}') && malformedFrom === null) {
          malformedFrom = cursor; malformedTo = cursor + 1
        }
        cursor += 1
      }
    }
    const closed = depth === 0
    const to = cursor
    const name = body.slice(from + 2, closed ? to - 2 : to).trim()
    let valid = true
    if (!closed) {
      valid = false
      diagnostics.push({ from, to, code: 'UNCLOSED_VARIABLE', message: '变量缺少结束标记 }}。' })
    }
    if (malformedFrom !== null || !name || /\s/u.test(name)) {
      valid = false
      diagnostics.push({ from: malformedFrom ?? from, to: malformedFrom === null ? to : malformedTo,
        code: 'MALFORMED_VARIABLE', message: '变量格式无效，请使用 {{变量名称}}，且不要嵌套变量。' })
    }
    if (valid) {
      const variable = variablesByName.get(name)
      if (!variable) {
        valid = false
        diagnostics.push({ from, to, code: 'UNKNOWN_VARIABLE', message: '未知变量，请从可用变量列表中选择。' })
      } else if (!variable.scopes.includes(scope)) {
        valid = false
        diagnostics.push({ from, to, code: 'UNAVAILABLE_VARIABLE', message: '该变量不适用于当前模板。' })
      }
    }
    tokens.push({ from, to, name, closed, valid })
  }
  return { valid: diagnostics.length === 0, tokens, diagnostics }
}

/** Validate everything before substituting; binding contents are never parsed. */
export function renderTemplate(body: string, scope: TemplateScope, bindings: Readonly<Record<string, string>>): string {
  const analysis = analyzeTemplate(body, scope)
  if (!analysis.valid) throw new PlatformError('INVALID_TEMPLATE', analysis.diagnostics[0]?.message ?? '模板无效。')
  const values: string[] = []
  for (const token of analysis.tokens) {
    if (bindings === null || typeof bindings !== 'object' || !Object.hasOwn(bindings, token.name)) {
      throw new PlatformError('MISSING_TEMPLATE_BINDING', '模板变量缺少对应值。')
    }
    const value = bindings[token.name]
    if (typeof value !== 'string') throw new PlatformError('MISSING_TEMPLATE_BINDING', '模板变量值必须为字符串。')
    values.push(value)
  }
  const pieces: string[] = []
  let cursor = 0
  for (let index = 0; index < analysis.tokens.length; index += 1) {
    const token = analysis.tokens[index]!
    pieces.push(body.slice(cursor, token.from), values[index]!)
    cursor = token.to
  }
  pieces.push(body.slice(cursor))
  return pieces.join('')
}

/**
 * Compose only owner-controlled documents. Callers provide verified runtime
 * identifiers, never message bodies; legacy input templates are not consulted.
 * Returned layers contain rendered text, with one shared persona document ID.
 */
export function composeAgentPrompt(configuration: HarnessOwnerConfiguration, agentTypeId: string | null,
  bindings: Readonly<Record<string, string>>): AgentPromptPreview {
  const invalid = (): never => { throw new PlatformError('INVALID_AGENT_PROMPT', '代理提示词配置不完整或无效，未发送模型请求。') }
  if (!Number.isSafeInteger(configuration.revision) || configuration.revision < 0
    || configuration.prompts.length > MAX_REGISTERED_PROMPT_DOCUMENTS * 2 + 5
    || (configuration.agentTypes?.length ?? 0) + (configuration.pluginInstructions?.length ?? 0) > MAX_REGISTERED_PROMPT_DOCUMENTS) invalid()
  const selectedTypes = agentTypeId === null ? [] : configuration.agentTypes?.filter(type => type.id === agentTypeId) ?? []
  if (agentTypeId !== null && (selectedTypes.length !== 1 || selectedTypes[0]!.enabled !== true)) {
    throw new PlatformError('AGENT_TYPE_UNAVAILABLE', '代理类型未注册或已停用，未发送模型请求。', 409)
  }
  const documents = new Map<string, PromptDocument>()
  for (const document of configuration.prompts) {
    if (documents.has(document.id)) invalid()
    documents.set(document.id, document)
  }
  const values: Record<string, string> = {}
  for (const variable of TEMPLATE_VARIABLES) {
    if (variable.origin === 'external') continue
    const ownerValue = configuration.bindings
    const source = variable.origin === 'owner' ? ownerValue
      : Object.hasOwn(bindings, variable.name) ? bindings : ownerValue
    if (source && Object.hasOwn(source, variable.name)) {
      const value = source[variable.name]
      if (typeof value !== 'string') invalid()
      values[variable.name] = value!
    } else if (variable.name !== '当前时间') values[variable.name] = ''
  }
  values.人格名称 = configuration.activePersona?.name ?? ''
  const layers: Array<AgentPromptPreview['layers'][number]> = []
  function layer(id: string, scope: TemplateScope, pluginId?: string): void {
    const document = documents.get(id)
    if (!document || getPromptTemplateScope(id) !== scope || (document.scope !== undefined && document.scope !== scope)
      || document.source === 'legacy-user-input' || document.available === false || document.enabled === false
      || (pluginId !== undefined && document.pluginId !== pluginId)
      || typeof document.body !== 'string' || !document.body.trim()
      || !Number.isSafeInteger(document.revision) || document.revision < 0) invalid()
    layers.push({ id: document!.id, title: document!.title, revision: document!.revision,
      body: renderTemplate(document!.body, scope, values) })
  }
  layer('common', 'common')
  if (agentTypeId === null) {
    layer('main', 'main')
    const seen = new Set<string>()
    for (const instruction of configuration.pluginInstructions ?? []) {
      if (seen.has(instruction.id)) invalid()
      seen.add(instruction.id)
      if (instruction.enabled === true) layer(`plugin:${instruction.id}`, 'plugin', instruction.pluginId)
    }
  } else {
    layer('subagent', 'subagent')
    layer(`agent:${agentTypeId}`, 'agent', selectedTypes[0]!.pluginId)
  }
  const persona = configuration.activePersona
  if (persona !== null) {
    if (typeof persona.body !== 'string' || !persona.body.trim() || !Number.isSafeInteger(persona.revision) || persona.revision < 1) invalid()
    layers.push({ id: `persona:${persona.id}`, title: persona.name, revision: persona.revision, body: renderTemplate(persona.body, 'persona', values) })
  } else layers.push({ id: 'persona', title: '人格', revision: 0, body: '' })
  return { revision: configuration.revision, agentTypeId, layers, systemPrompt: layers.map(item => item.body).join('\n\n'), bindings: { ...values } }
}
