import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue, PluginToolDefinition } from '@eating/plugin-sdk'
import { SchemaValidationError, validateSchemaInput } from '../validation'
import type { QQMessage } from './i18n'

export type FieldKind = 'text' | 'integer' | 'number' | 'boolean' | 'enum' | 'json' | 'text-or-json'
export type FieldFormat = 'text' | 'json'
export interface SchemaField {
  key: string
  schema: JsonObject
  required: boolean
  kind: FieldKind
  options: JsonValue[]
  validationSchema: JsonObject
}
export interface ParsedArguments {
  arguments: JsonObject
  errors: Record<string, QQMessage | undefined>
  schemaError?: QQMessage
}
const jsonContainerSchema: JsonObject = { type: 'object' }

/** Resolve local references for presentation only; the shared validator owns the rules. */
export function presentationSchema(schema: JsonObject, root: JsonObject, seen = new Set<string>()): JsonObject {
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/') || seen.has(schema.$ref)) return schema
  const path = schema.$ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let value: JsonValue = root
  for (const part of path) {
    if (!isJsonObject(value) || !Object.hasOwn(value, part)) return schema
    value = value[part]!
  }
  if (!isJsonObject(value)) return schema
  const next = new Set(seen).add(schema.$ref)
  const { $ref: _reference, ...own } = schema
  return { ...presentationSchema(value, root, next), ...own }
}
function schemaTypes(schema: JsonObject, root: JsonObject, depth = 0): Set<string> {
  if (depth > 12) return new Set()
  const resolved = presentationSchema(schema, root)
  const types = new Set(typeof resolved.type === 'string' ? [resolved.type] : Array.isArray(resolved.type) ? resolved.type.filter((type): type is string => typeof type === 'string') : [])
  for (const union of [resolved.anyOf, resolved.oneOf, resolved.allOf]) {
    if (!Array.isArray(union)) continue
    for (const variant of union) {
      if (isJsonObject(variant)) for (const type of schemaTypes(variant, root, depth + 1)) types.add(type)
    }
  }
  return types
}
function fieldKind(schema: JsonObject, root: JsonObject): FieldKind {
  if (Array.isArray(schema.enum)) return 'enum'
  const types = schemaTypes(schema, root)
  if (types.has('string') && (types.has('object') || types.has('array'))) return 'text-or-json'
  if (types.has('string')) return 'text'
  if (types.has('object') || types.has('array') || types.size !== 1) return 'json'
  if (types.has('boolean')) return 'boolean'
  if (types.has('integer')) return 'integer'
  if (types.has('number')) return 'number'
  return 'json'
}
export function schemaFields(tool: PluginToolDefinition | undefined): SchemaField[] {
  if (!tool || !isJsonObject(tool.inputSchema.properties)) return []
  const root = tool.inputSchema
  const required = Array.isArray(root.required) ? root.required : []
  return Object.entries(root.properties as JsonObject).filter((entry): entry is [string, JsonObject] => isJsonObject(entry[1])).map(([key, source]) => {
    const schema = presentationSchema(source, root)
    return { key, schema, required: required.includes(key), kind: fieldKind(schema, root), options: Array.isArray(schema.enum) ? schema.enum : [],
      validationSchema: { type: 'object', properties: { [key]: source }, additionalProperties: false, ...(root.$defs ? { $defs: root.$defs } : {}) } }
  })
}
export function enumValue(value: JsonValue): string { return typeof value === 'string' ? value : JSON.stringify(value) }

export function parseToolArguments(tool: PluginToolDefinition | undefined, fields: SchemaField[], values: Record<string, string>, formats: Record<string, FieldFormat>, requestId: string, validate = true): ParsedArguments {
  const args: JsonObject = {}
  const errors: ParsedArguments['errors'] = {}
  for (const { key, kind, required, options, validationSchema } of fields) {
    if (key === 'request_id') { args[key] = requestId; continue }
    const value = values[key]
    if (value === undefined || value === '') {
      if (required) errors[key] = { key: 'validation.required' }
      continue
    }
    if (kind === 'integer' || kind === 'number') {
      const number = Number(value)
      if (!value.trim() || !Number.isFinite(number) || kind === 'integer' && !Number.isSafeInteger(number)) {
        errors[key] = { key: kind === 'integer' ? 'validation.integer' : 'validation.number' }; continue
      }
      args[key] = number
    } else if (kind === 'boolean') {
      if (value !== 'true' && value !== 'false') { errors[key] = { key: 'validation.boolean' }; continue }
      args[key] = value === 'true'
    } else if (kind === 'enum') {
      const selected = options.find(option => enumValue(option) === value)
      if (selected === undefined) { errors[key] = { key: 'validation.enum' }; continue }
      args[key] = selected
    } else if (kind === 'json' || kind === 'text-or-json' && formats[key] === 'json') {
      let parsed: JsonValue
      try { parsed = JSON.parse(value) as JsonValue }
      catch { errors[key] = { key: 'validation.json' }; continue }
      // Preview must apply the same resource/JSON guard before recursive rendering, too.
      try { validateSchemaInput(jsonContainerSchema, { value: parsed }) }
      catch { errors[key] = { key: 'validation.schemaField' }; continue }
      args[key] = parsed
    } else args[key] = value
    if (validate) {
      try { validateSchemaInput(validationSchema, { [key]: args[key]! }) }
      catch { errors[key] = { key: 'validation.schemaField' } }
    }
  }
  if (validate && tool && !Object.keys(errors).length) {
    try { validateSchemaInput(tool.inputSchema, args) }
    catch (error) {
      if (error instanceof SchemaValidationError) for (const issue of error.issues) {
        const pathKey = issue.instancePath.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~')
        const missingKey = issue.instancePath === '' && typeof issue.params?.missingProperty === 'string' ? issue.params.missingProperty : undefined
        const fieldKey = pathKey || missingKey
        if (fieldKey && fields.some(field => field.key === fieldKey)) errors[fieldKey] = { key: 'validation.schemaField' }
      }
      return { arguments: args, errors, schemaError: { key: 'validation.schemaInput' } }
    }
  }
  return { arguments: args, errors }
}
