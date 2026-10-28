import { Validator } from '@cfworker/json-schema'
import { describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { oneBotMessageDefinitions, oneBotMessageSchema } from './message-schema'
import { MAX_INPUT_BYTES, MAX_INPUT_DEPTH, MAX_INPUT_NODES, SchemaValidationError, validateSchemaInput } from './validation'

const anyObject: JsonObject = { type: 'object' }
function rejected(schema: JsonObject, input: unknown): SchemaValidationError {
  let error: unknown
  try { validateSchemaInput(schema, input) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(PlatformError)
  expect(error).toMatchObject({ code: 'INVALID_INPUT', statusCode: 400, outcome: 'not-sent' })
  return error as SchemaValidationError
}
const structuredSchema: JsonObject = {
  type: 'object', properties: {
    enabled: { type: 'boolean', default: true }, choice: { type: 'string', enum: ['a', 'b'] },
    list: { type: 'array', minItems: 1, maxItems: 4, items: { anyOf: [{ type: 'boolean' }, { type: 'integer', minimum: 0, maximum: 9 }] } },
    tree: { $ref: '#/$defs/tree' },
  },
  allOf: [{ required: ['choice'] }, { anyOf: [{ required: ['enabled'] }, { required: ['tree'] }] }],
  additionalProperties: false,
  $defs: { tree: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object', properties: { child: { $ref: '#/$defs/tree' } }, required: ['child'], additionalProperties: false }] } },
}

describe('shared browser/Node schema validation', () => {
  it('handles booleans, enum, arrays, objects, anyOf, oneOf, allOf and recursive local references', () => {
    const value = { choice: 'a', list: [false, 0, 9], tree: { child: { child: 'leaf' } } }
    const before = structuredClone(value)
    expect(validateSchemaInput(structuredSchema, value)).toBe(value)
    expect(value).toEqual(before)
    expect(value).not.toHaveProperty('enabled')
    for (const invalid of [
      { ...value, enabled: 'true' }, { ...value, choice: 'unknown' }, { ...value, list: ['1'] }, { ...value, list: [10] },
      { ...value, list: [] }, { ...value, list: [1, 2, 3, 4, 5] }, { ...value, tree: { child: 'leaf', extra: true } },
      { choice: 'a' }, { enabled: true }, { ...value, extra: true },
    ]) rejected(structuredSchema, invalid)
    const overlapping: JsonObject = { type: 'object', properties: { value: { oneOf: [{ type: 'number' }, { type: 'integer' }] } }, required: ['value'] }
    rejected(overlapping, { value: 1 })
    expect(validateSchemaInput(overlapping, { value: 1.5 })).toEqual({ value: 1.5 })
  })

  it('supports if/then/else and boolean false schemas with local references', () => {
    const schema: JsonObject = {
      type: 'object', properties: { enabled: { type: 'boolean' }, value: { $ref: '#/$defs/value' }, forbidden: false },
      required: ['enabled', 'value'], additionalProperties: false,
      if: { properties: { enabled: { const: true } } },
      then: { properties: { value: { type: 'integer', minimum: 1 } } },
      else: { properties: { value: { type: 'string', minLength: 1 } } },
      $defs: { value: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
    }
    expect(validateSchemaInput(schema, { enabled: true, value: 1 })).toEqual({ enabled: true, value: 1 })
    expect(validateSchemaInput(schema, { enabled: false, value: 'text' })).toEqual({ enabled: false, value: 'text' })
    for (const value of [{ enabled: true, value: 'text' }, { enabled: false, value: 1 }, { enabled: true, value: 0 }, { enabled: true, value: 1, forbidden: false }]) rejected(schema, value)
  })

  it('validates recursive OneBot messages when Function and eval are unavailable', () => {
    const schema: JsonObject = { type: 'object', title: 'CSP cold validator regression', properties: { message: oneBotMessageSchema }, required: ['message'], additionalProperties: false, $defs: oneBotMessageDefinitions }
    const value: JsonObject = { message: { type: 'node', data: { user_id: '456', nickname: '外部成员', content: [
      { type: 'node', data: { user_id: '456', nickname: '嵌套', content: { type: 'image', data: { file: 'base64://YWJj', cache: false } } } },
      { type: 'xml', data: { data: '<msg />' } },
    ] } } }
    const sourceKeys = Reflect.ownKeys(oneBotMessageDefinitions)
    Object.freeze(schema)
    const dynamicCode = vi.fn(() => { throw new EvalError('Code generation from strings is forbidden by CSP') })
    let output: JsonObject | undefined
    let unexpected: unknown
    let rejectedValue: unknown
    vi.stubGlobal('Function', dynamicCode)
    vi.stubGlobal('eval', dynamicCode)
    try {
      output = validateSchemaInput(schema, value)
      try { validateSchemaInput(schema, { message: { type: 'forward', data: { id: 'receive-only' } } }) }
      catch (error) { rejectedValue = error }
    } catch (error) { unexpected = error }
    finally { vi.unstubAllGlobals() }
    expect(unexpected).toBeUndefined()
    expect(output).toBe(value)
    expect(rejectedValue).toMatchObject({ code: 'INVALID_INPUT', outcome: 'not-sent' })
    expect(dynamicCode).not.toHaveBeenCalled()
    expect(Reflect.ownKeys(schema)).not.toContain('__absolute_uri__')
    expect(Reflect.ownKeys(oneBotMessageDefinitions)).toEqual(sourceKeys)
  })

  it('never coerces values, inserts defaults, strips unknown fields or mutates frozen input', () => {
    const schema: JsonObject = { type: 'object', properties: { value: { type: 'integer', default: 1 }, nested: { type: 'object', properties: { ok: { type: 'boolean', default: false } }, additionalProperties: false } }, additionalProperties: false }
    Object.freeze(schema)
    Object.freeze(schema.properties)
    const nested = Object.freeze({})
    const value = Object.freeze({ nested })
    expect(validateSchemaInput(schema, value)).toBe(value)
    expect(value).toEqual({ nested: {} })
    const bad = { value: '1', additional: 'keep this' }
    const before = structuredClone(bad)
    rejected(schema, bad)
    expect(bad).toEqual(before)
  })

  it('reuses stable schema content across newly parsed UI catalogs and bounds the interpreter cache', () => {
    const validate = vi.spyOn(Validator.prototype, 'validate')
    try {
      const schema: JsonObject = { type: 'object', title: 'LRU reuse regression', additionalProperties: false }
      validateSchemaInput(schema, {})
      const first = validate.mock.contexts[0]
      expect(first).toBeInstanceOf(Validator)
      validateSchemaInput(JSON.parse(JSON.stringify(schema)) as JsonObject, {})
      expect(validate.mock.contexts[1]).toBe(first)
      // More than 128 distinct schemas evicts the initial validator and its private reference lookup.
      for (let index = 0; index < 129; index++) validateSchemaInput({ type: 'object', title: `cache-boundary-${index}` }, {})
      validateSchemaInput(schema, {})
      expect(validate.mock.contexts.at(-1)).not.toBe(first)
    } finally { validate.mockRestore() }
  })

  it('reports only bounded structural issues and never echoes secret values or raw library messages', () => {
    const secret = 'a-secret-that-must-not-appear'
    const schema: JsonObject = { type: 'object', properties: { credential: { type: 'boolean' }, choice: { enum: ['public'] } }, required: ['credential'], additionalProperties: false }
    const error = rejected(schema, { credential: secret })
    expect(error.issues).toContainEqual({ instancePath: '/credential', keyword: 'type' })
    expect(JSON.stringify({ message: error.message, issues: error.issues })).not.toContain(secret)
    expect(rejected(schema, {}).issues).toContainEqual({ instancePath: '', keyword: 'required' })
    const enumError = rejected(schema, { credential: true, choice: secret })
    expect(enumError.issues.every(issue => !issue.params)).toBe(true)
    const additional = rejected(schema, { credential: true, [secret]: secret })
    expect(JSON.stringify(additional.issues)).not.toContain(secret)
    expect(error.issues.length).toBeLessThanOrEqual(12)
    expect(error.message).toBe(additional.message)
    // Malformed schemas or unusual JavaScript objects also produce the fixed input error.
    expect(rejected({ type: 'invented' }, {}).message).toBe(error.message)
  })
})

describe('bounded JSON preflight before recursive validators', () => {
  it('rejects non-JSON values, inherited/custom prototypes, accessors and dangerous keys', () => {
    const getter = vi.fn(() => 'must not be read')
    const withGetter = Object.defineProperty({}, 'value', { enumerable: true, get: getter })
    const withHidden = Object.defineProperty({}, 'value', { enumerable: false, value: 'hidden' })
    const withSymbol = { [Symbol('hidden')]: 'hidden' }
    const cycle: Record<string, unknown> = {}; cycle.value = cycle
    const values: unknown[] = [
      null, [], 'object', true, 1, { value: undefined }, { value: 1n }, { value: Symbol('x') }, { value: () => 'x' },
      Object.create({ inherited: true }), { value: new Date() }, { value: new Map() }, { value: new Uint8Array(1) },
      withGetter, withHidden, withSymbol, cycle,
      JSON.parse('{"value":{"__proto__":{"polluted":true}}}'), JSON.parse('{"constructor":"x"}'), JSON.parse('{"prototype":"x"}'),
      { value: Array(2) }, { value: Object.assign([1], { extra: true }) },
    ]
    for (const value of values) rejected(anyObject, value)
    expect(getter).not.toHaveBeenCalled()
    const shared = { allowed: true }
    expect(validateSchemaInput(anyObject, { left: shared, right: shared })).toEqual({ left: shared, right: shared })
    const nullPrototype = Object.assign(Object.create(null) as JsonObject, { value: true })
    expect(validateSchemaInput(anyObject, nullPrototype)).toBe(nullPrototype)
  })

  it('rejects unsafe and non-finite numbers while preserving finite decimal JSON numbers', () => {
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1]) rejected(anyObject, { nested: [value] })
    for (const value of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0, -0, 1.5, -0.001]) expect(validateSchemaInput(anyObject, { value })).toEqual({ value })
  })

  it('checks depth iteratively, including a very deep object without a recursive stack overflow', () => {
    function chain(depth: number): unknown { let value: unknown = 'leaf'; for (let index = 0; index < depth; index++) value = { child: value }; return value }
    expect(validateSchemaInput(anyObject, chain(MAX_INPUT_DEPTH))).toBeDefined()
    rejected(anyObject, chain(MAX_INPUT_DEPTH + 1))
    const deepError = rejected(anyObject, chain(20000))
    expect(deepError).not.toBeInstanceOf(RangeError)
  })

  it('bounds total visited nodes, including large arrays and object breadth', () => {
    expect(validateSchemaInput(anyObject, { items: Array.from({ length: MAX_INPUT_NODES - 2 }, () => 0) })).toBeDefined()
    rejected(anyObject, { items: Array.from({ length: MAX_INPUT_NODES - 1 }, () => 0) })
    rejected(anyObject, Object.fromEntries(Array.from({ length: MAX_INPUT_NODES }, (_, index) => [`key${index}`, 0])))
  })

  it('uses actual serialized UTF-8 bytes and escaping for the 1 MiB limit', () => {
    const encoder = new TextEncoder()
    const overhead = encoder.encode(JSON.stringify({ value: '' })).byteLength
    const exact = { value: 'x'.repeat(MAX_INPUT_BYTES - overhead) }
    expect(encoder.encode(JSON.stringify(exact))).toHaveLength(MAX_INPUT_BYTES)
    expect(validateSchemaInput(anyObject, exact)).toBe(exact)
    rejected(anyObject, { value: `${exact.value}x` })
    rejected(anyObject, { value: '鱼'.repeat(Math.ceil(MAX_INPUT_BYTES / 3)) })
    rejected(anyObject, { value: '\u0000'.repeat(Math.ceil(MAX_INPUT_BYTES / 6)) })
  })
})
