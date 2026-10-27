import { describe, expect, it } from 'vitest'
import { PlatformError } from './index'
import { MAX_TEMPLATE_BODY_LENGTH, TEMPLATE_VARIABLES, analyzeTemplate, renderTemplate } from './authoring'
import type { TemplateScope } from './authoring'

const scopes: readonly TemplateScope[] = ['main', 'group', 'private', 'persona']

function errorCode(operation: () => unknown): string {
  try { operation() } catch (error) {
    expect(error).toBeInstanceOf(PlatformError)
    return (error as PlatformError).code
  }
  throw new Error('Expected an error.')
}

describe('authoring template catalog', () => {
  it('exposes exactly the eleven currently available variables with their true scopes and origin', () => {
    expect(TEMPLATE_VARIABLES.map(variable => variable.name)).toEqual(['当前时间', '人格名称', '平台', '机器人账号', '会话编号', '会话类型', '发送者列表', '消息列表', '消息内容', '消息数量', '批次编号'])
    expect(new Set(TEMPLATE_VARIABLES.map(variable => variable.name)).size).toBe(11)
    for (const variable of TEMPLATE_VARIABLES) {
      expect(variable.scopes).toEqual(variable.name === '当前时间' || variable.name === '人格名称' ? scopes : ['group', 'private'])
      expect(variable.origin).toBe(variable.name === '当前时间' ? 'runtime' : variable.name === '人格名称' ? 'persona' : 'external')
      expect(variable.description).not.toBe('')
      expect(Object.isFrozen(variable)).toBe(true)
      expect(Object.isFrozen(variable.scopes)).toBe(true)
    }
    expect(Object.isFrozen(TEMPLATE_VARIABLES)).toBe(true)
    expect(TEMPLATE_VARIABLES.find(variable => variable.name === '消息内容')?.description).toBe('本批最新一条文本。')
    expect(TEMPLATE_VARIABLES.find(variable => variable.name === '消息列表')?.description).toBe('带逐条来源的完整本批 JSON。')
  })
})

describe('analyzeTemplate', () => {
  it.each(scopes)('accepts empty and ordinary text for %s', scope => {
    expect(analyzeTemplate('', scope)).toEqual({ valid: true, tokens: [], diagnostics: [] })
    expect(analyzeTemplate('普通文字与单个 { 和 }，孤立 }} 保持正文。', scope)).toEqual({ valid: true, tokens: [], diagnostics: [] })
  })

  it('normalizes surrounding whitespace and reports exact exclusive UTF16 token ranges', () => {
    const body = '🐟甲{{ 当前时间 }}\n{{人格名称}}末'
    const firstFrom = body.indexOf('{{')
    const firstTo = body.indexOf('}}') + 2
    const secondFrom = body.indexOf('{{', firstTo)
    expect(firstFrom).toBe(3)
    expect(analyzeTemplate(body, 'main')).toEqual({ valid: true,
      tokens: [{ from: firstFrom, to: firstTo, name: '当前时间', closed: true, valid: true },
        { from: secondFrom, to: body.lastIndexOf('}}') + 2, name: '人格名称', closed: true, valid: true }], diagnostics: [] })
    expect(analyzeTemplate('{{\t当前时间\n}}', 'main').valid).toBe(true)
  })

  it('marks only an unknown token invalid and preserves following known token ranges', () => {
    const body = '🐟{{不存在}}{{当前时间}}'
    const result = analyzeTemplate(body, 'main')
    expect(result.valid).toBe(false)
    expect(result.tokens).toEqual([{ from: 2, to: 9, name: '不存在', closed: true, valid: false },
      { from: 9, to: body.length, name: '当前时间', closed: true, valid: true }])
    expect(result.diagnostics).toEqual([{ from: 2, to: 9, code: 'UNKNOWN_VARIABLE', message: expect.any(String) }])
  })

  it.each(['main', 'persona'] as const)('rejects external variables in %s with exact ranges', scope => {
    const body = '🧭{{消息内容}}'
    expect(analyzeTemplate(body, scope)).toMatchObject({ valid: false, tokens: [{ from: 2, to: body.length, valid: false }],
      diagnostics: [{ from: 2, to: body.length, code: 'UNAVAILABLE_VARIABLE' }] })
  })

  it.each(['group', 'private'] as const)('accepts all catalog variables in %s', scope => {
    const body = TEMPLATE_VARIABLES.map(variable => `{{${variable.name}}}`).join('\n')
    const result = analyzeTemplate(body, scope)
    expect(result.valid).toBe(true)
    expect(result.tokens).toHaveLength(11)
    expect(result.diagnostics).toEqual([])
  })

  it('does not offer persona body as a recursive variable', () => {
    expect(analyzeTemplate('{{人格正文}}', 'persona')).toMatchObject({ valid: false, diagnostics: [{ code: 'UNKNOWN_VARIABLE' }] })
  })

  it.each(['{{', '{{当前时间', '前文{{ 人格名称 '])('reports an unclosed variable: %s', body => {
    const result = analyzeTemplate(body, 'main')
    expect(result.valid).toBe(false)
    expect(result.tokens).toMatchObject([{ from: body.indexOf('{{'), to: body.length, closed: false, valid: false }])
    expect(result.diagnostics).toContainEqual({ from: body.indexOf('{{'), to: body.length, code: 'UNCLOSED_VARIABLE', message: expect.any(String) })
  })

  it('keeps a nested valid variable inside one malformed outer token', () => {
    const body = '🐟{{外层{{当前时间}}尾部}}后{{人格名称}}'
    const outerTo = body.indexOf('}}后') + 2
    const nestedFrom = body.indexOf('{{', 4)
    const result = analyzeTemplate(body, 'main')
    expect(result.valid).toBe(false)
    expect(result.tokens).toEqual([{ from: 2, to: outerTo, name: '外层{{当前时间}}尾部', closed: true, valid: false },
      { from: outerTo + 1, to: body.length, name: '人格名称', closed: true, valid: true }])
    expect(result.diagnostics).toEqual([{ from: nestedFrom, to: nestedFrom + 2, code: 'MALFORMED_VARIABLE', message: expect.any(String) }])
  })

  it('reports both unclosed outer delimiter and nested syntax without exposing an inner valid token', () => {
    const body = '🐟{{外层{{当前时间}}'
    const result = analyzeTemplate(body, 'main')
    expect(result.tokens).toEqual([{ from: 2, to: body.length, name: '外层{{当前时间}}', closed: false, valid: false }])
    expect(result.diagnostics).toMatchObject([{ from: 2, to: body.length, code: 'UNCLOSED_VARIABLE' },
      { from: body.indexOf('{{', 4), to: body.indexOf('{{', 4) + 2, code: 'MALFORMED_VARIABLE' }])
  })

  it.each(['{{}}', '{{  }}', '{{当前 时间}}', '{{{当前时间}}}', '{{当前}时间}}', '{{当前{时间}}'])('rejects malformed syntax: %s', body => {
    const result = analyzeTemplate(body, 'main')
    expect(result.valid).toBe(false)
    expect(result.tokens.every(token => !token.valid)).toBe(true)
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'MALFORMED_VARIABLE')).toBe(true)
  })

  it.each(['__proto__', 'constructor', 'prototype', 'toString'])('treats prototype key %s as unknown', name => {
    expect(analyzeTemplate(`{{${name}}}`, 'main')).toMatchObject({ valid: false, diagnostics: [{ code: 'UNKNOWN_VARIABLE' }] })
  })

  it('handles the 50000 code-unit boundary and bounded adversarial nesting', () => {
    expect(analyzeTemplate('字'.repeat(MAX_TEMPLATE_BODY_LENGTH), 'persona')).toEqual({ valid: true, tokens: [], diagnostics: [] })
    const tooLong = '字'.repeat(MAX_TEMPLATE_BODY_LENGTH + 1)
    expect(analyzeTemplate(tooLong, 'persona')).toMatchObject({ valid: false, tokens: [], diagnostics: [{ from: 50000, to: 50001, code: 'MALFORMED_VARIABLE' }] })
    const nested = '{{'.repeat(12_500) + '}}'.repeat(12_500)
    const result = analyzeTemplate(nested, 'main')
    expect(result.tokens).toHaveLength(1)
    expect(result.tokens[0]).toMatchObject({ from: 0, to: 50000, closed: true, valid: false })
  })
})

describe('renderTemplate', () => {
  it('replaces once, accepts empty strings, and keeps template syntax or replacement metacharacters in values literal', () => {
    const value = '{{消息内容}} $& $1 ${process.exit()} <script>'
    expect(renderTemplate('前{{ 人格名称 }}后{{当前时间}}{{人格名称}}', 'persona', { 人格名称: value, 当前时间: '' })).toBe(`前${value}后${value}`)
    expect(renderTemplate('孤立 }} 与正文', 'main', {})).toBe('孤立 }} 与正文')
    expect(renderTemplate('', 'main', {})).toBe('')
  })

  it('checks all template validity before reading binding values', () => {
    let reads = 0
    const bindings = Object.defineProperty({}, '当前时间', { get: () => { reads += 1; return 'now' } })
    expect(errorCode(() => renderTemplate('{{当前时间}}{{不存在}}', 'main', bindings))).toBe('INVALID_TEMPLATE')
    expect(reads).toBe(0)
    expect(errorCode(() => renderTemplate('{{消息内容}}', 'persona', { 消息内容: 'x' }))).toBe('INVALID_TEMPLATE')
  })

  it('requires every referenced binding, including references occurring later in the body', () => {
    expect(errorCode(() => renderTemplate('{{当前时间}}{{人格名称}}', 'main', { 当前时间: 'now' }))).toBe('MISSING_TEMPLATE_BINDING')
    expect(errorCode(() => renderTemplate('{{当前时间}}', 'main', { 当前时间: 1 } as unknown as Record<string, string>))).toBe('MISSING_TEMPLATE_BINDING')
  })

  it('rejects inherited values and prototype keys even when explicitly bound', () => {
    const inherited = Object.create({ 当前时间: 'inherited' }) as Record<string, string>
    expect(errorCode(() => renderTemplate('{{当前时间}}', 'main', inherited))).toBe('MISSING_TEMPLATE_BINDING')
    expect(errorCode(() => renderTemplate('{{__proto__}}', 'main', JSON.parse('{"__proto__":"bypass"}') as Record<string, string>))).toBe('INVALID_TEMPLATE')
    const nullPrototype = Object.create(null) as Record<string, string>
    nullPrototype.当前时间 = 'real'
    expect(renderTemplate('{{当前时间}}', 'main', nullPrototype)).toBe('real')
  })
})
