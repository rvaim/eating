import { PlatformError } from './index'

export type PromptKind = 'main' | 'group' | 'private'
export type TemplateScope = PromptKind | 'persona'

export interface TemplateVariable {
  readonly name: string
  readonly description: string
  readonly scopes: readonly TemplateScope[]
  readonly origin: 'runtime' | 'persona' | 'external'
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
  readonly body: string
  readonly revision: number
  readonly updatedAt: string | null
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
  readonly personas: readonly PersonaSummary[]
  readonly activePersonaId: string | null
  readonly variables: readonly TemplateVariable[]
}

export interface PersonaMutationResult {
  readonly snapshot: AuthoringSnapshot
  readonly persona: PersonaDocument
}

export const MAX_TEMPLATE_BODY_LENGTH = 50_000

const allScopes: readonly TemplateScope[] = Object.freeze(['main', 'group', 'private', 'persona'])
const messageScopes: readonly TemplateScope[] = Object.freeze(['group', 'private'])

/** Only fields available from the current normalized runtime/batch contract. */
export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = Object.freeze([
  Object.freeze({ name: '当前时间', description: '渲染时的当前时间。', scopes: allScopes, origin: 'runtime' as const }),
  Object.freeze({ name: '人格名称', description: '主人当前启用的人格名称；未启用时由调用方明确提供空值。', scopes: allScopes, origin: 'persona' as const }),
  Object.freeze({ name: '平台', description: '本批消息所属平台的实际 platform id。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '机器人账号', description: '本批消息所属的实际机器人账号标识。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '会话编号', description: '本批消息的实际 conversationId。', scopes: messageScopes, origin: 'external' as const }),
  Object.freeze({ name: '会话类型', description: '本批消息的会话类型：group 或 private。', scopes: messageScopes, origin: 'external' as const }),
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
