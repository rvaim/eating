import { Validator } from '@cfworker/json-schema'
import type { OutputUnit, ValidationResult } from '@cfworker/json-schema'
import { PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

export const MAX_INPUT_BYTES = 1024 * 1024
export const MAX_INPUT_DEPTH = 64
export const MAX_INPUT_NODES = 50000

export interface SchemaValidationIssue {
  readonly instancePath: string
  readonly keyword: string
  readonly params?: Record<string, unknown>
}

const errorMessage = '工具参数不符合格式要求，或超出允许的大小、深度与数值范围。'
export class SchemaValidationError extends PlatformError {
  constructor(readonly issues: readonly SchemaValidationIssue[] = []) {
    super('INVALID_INPUT', errorMessage, 400, 'not-sent')
  }
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const encoder = new TextEncoder()
const validators = new Map<string, Validator>()
const MAX_CACHED_SCHEMAS = 128

function invalid(issues: readonly SchemaValidationIssue[] = []): never { throw new SchemaValidationError(issues) }

/** Bound and check JSON before calling any recursive SDK/schema validator. Never reads accessors. */
function checkJson(input: unknown): asserts input is JsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  const active = new WeakSet<object>()
  const pending: Array<{ value: unknown; depth: number; leave?: boolean }> = [{ value: input, depth: 0 }]
  let nodes = 0
  let bytes = 0
  const addBytes = (count: number) => { bytes += count; if (bytes > MAX_INPUT_BYTES) invalid() }
  const stringBytes = (value: string): number => {
    if (value.length > MAX_INPUT_BYTES) invalid()
    return encoder.encode(JSON.stringify(value)).byteLength
  }
  while (pending.length) {
    const entry = pending.pop()!
    const { value, depth } = entry
    if (entry.leave) { active.delete(value as object); continue }
    if (++nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) invalid()
    if (value === null) { addBytes(4); continue }
    if (typeof value === 'string') { addBytes(stringBytes(value)); continue }
    if (typeof value === 'boolean') { addBytes(value ? 4 : 5); continue }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid()
      addBytes(String(value).length)
      continue
    }
    if (typeof value !== 'object') invalid()
    if (active.has(value)) invalid()
    active.add(value)
    pending.push({ value, depth, leave: true })
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > MAX_INPUT_NODES) invalid()
    addBytes(2)
    if (array) {
      if (value.length > MAX_INPUT_NODES || keys.length !== value.length + 1) invalid()
      if (value.length) addBytes(value.length - 1)
      for (let index = value.length - 1; index >= 0; index--) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid()
        pending.push({ value: descriptor.value, depth: depth + 1 })
      }
    } else {
      if (keys.length) addBytes(keys.length - 1)
      for (const key of keys) {
        if (typeof key !== 'string' || forbiddenKeys.has(key)) invalid()
        const descriptor = descriptors[key]!
        if (!descriptor.enumerable || !('value' in descriptor)) invalid()
        addBytes(stringBytes(key) + 1)
        pending.push({ value: descriptor.value, depth: depth + 1 })
      }
    }
  }
}

function issuesFrom(errors: readonly OutputUnit[]): readonly SchemaValidationIssue[] {
  return errors.slice(0, 12).map(error => {
    const path = error.instanceLocation.startsWith('#') ? error.instanceLocation.slice(1) : ''
    const instancePath = /^(?:\/(?:[A-Za-z_][A-Za-z0-9_]{0,127}|[0-9]{1,6}))*$/.test(path) ? path : ''
    // OutputUnit.error can include input values. Never forward it or parse English text for field names.
    return { instancePath, keyword: error.keyword }
  })
}

/** Shared browser/Node JSON Schema validation. Defaults are annotations; input is returned unchanged. */
export function validateSchemaInput(schema: JsonObject, input: unknown): JsonObject {
  try { checkJson(input) } catch { invalid() }
  let result: ValidationResult
  try {
    // UI polling replaces catalog object identities. Key only the schema, never input or credentials.
    const key = JSON.stringify(schema)
    let validator = validators.get(key)
    if (validator) {
      validators.delete(key)
      validators.set(key, validator)
    } else {
      // dereference() annotates schemas. Clone privately to preserve frozen/shared catalogs and
      // keep independent reference locations when callers reuse the same schema object in several places.
      validator = new Validator(JSON.parse(key) as JsonObject, '2019-09', true)
      validators.set(key, validator)
      if (validators.size > MAX_CACHED_SCHEMAS) validators.delete(validators.keys().next().value!)
    }
    result = validator.validate(input)
  } catch { invalid() }
  if (!result.valid) invalid(issuesFrom(result.errors))
  return input as JsonObject
}
