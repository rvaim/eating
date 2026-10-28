import { describe, expect, it } from 'vitest'
import type { JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'
import { qqTools } from '../backend/operations'
import { parseToolArguments, presentationSchema, schemaFields } from './tool-fields'
import type { FieldFormat } from './tool-fields'

const requestId = 'test-request-1234'
const tool = (name: string) => qqTools.find(candidate => candidate.name === name)!
function parse(name: string, values: Record<string, string>, formats: Record<string, FieldFormat> = {}) {
  const selected = tool(name)
  return parseToolArguments(selected, schemaFields(selected), values, formats, requestId)
}

describe('QQ generic schema form arguments', () => {
  it('recognizes references, message unions, booleans, enums, and integers from the Host schema', () => {
    const fields = schemaFields(tool('qq_send_message'))
    expect(fields.find(field => field.key === 'message')?.kind).toBe('text-or-json')
    expect(fields.find(field => field.key === 'message_type')?.kind).toBe('enum')
    expect(fields.find(field => field.key === 'auto_escape')?.kind).toBe('boolean')
    expect(fields.find(field => field.key === 'user_id')?.kind).toBe('text')
    expect(schemaFields(tool('qq_set_group_ban')).find(field => field.key === 'duration')?.kind).toBe('integer')
    expect(schemaFields(tool('qq_handle_quick_operation')).find(field => field.key === 'operation')?.kind).toBe('json')
    const root: JsonObject = { $defs: { 'a/b': { type: 'array', items: { type: 'string' } } } }
    expect(presentationSchema({ $ref: '#/$defs/a~1b', title: '用户原文' }, root)).toMatchObject({ type: 'array', title: '用户原文' })
  })

  it('keeps text beginning with a bracket literal until JSON format is explicitly selected', () => {
    const literal = '[用户文本 {{当前时间}}] [CQ:at,qq=123]'
    const text = parse('qq_send_private_message', { user_id: '987654321', message: literal, auto_escape: 'false', onebot_call_mode: 'sync' })
    expect(text.errors).toEqual({})
    expect(text.schemaError).toBeUndefined()
    expect(text.arguments).toEqual({ user_id: '987654321', message: literal, auto_escape: false, request_id: requestId, onebot_call_mode: 'sync' })
    const array = [{ type: 'text', data: { text: '用户文本 {{当前时间}} [CQ:at,qq=123]' } }, { type: 'image', data: { file: 'https://example.test/图.png', cache: false, proxy: 0, timeout: 1.5 } }]
    const structured = parse('qq_send_private_message', { user_id: '987654321', message: JSON.stringify(array) }, { message: 'json' })
    expect(structured.errors).toEqual({})
    expect(structured.schemaError).toBeUndefined()
    expect(structured.arguments.message).toEqual(array)
    const single = { type: 'face', data: { id: 123 } }
    expect(parse('qq_send_private_message', { user_id: '987654321', message: JSON.stringify(single) }, { message: 'json' }).arguments.message).toEqual(single)
  })

  it('retains explicit false, zero, valid enums, and controller generated request IDs', () => {
    const ban = parse('qq_set_group_ban', { group_id: '123456', user_id: '987654321', duration: '0', request_id: 'ignored-stale-id' })
    expect(ban.errors).toEqual({})
    expect(ban.arguments).toMatchObject({ duration: 0, request_id: requestId })
    const group = parse('qq_set_group_whole_ban', { group_id: '123456', enable: 'false', onebot_call_mode: 'rate_limited' })
    expect(group.errors).toEqual({})
    expect(group.arguments).toMatchObject({ enable: false, onebot_call_mode: 'rate_limited' })
    const omitted = parse('qq_get_group_info', { group_id: '123456', no_cache: '' })
    expect(omitted.arguments).not.toHaveProperty('no_cache')
    const honor = parse('qq_get_group_honor_info', { group_id: '123456', type: 'all' })
    expect(honor.errors).toEqual({})
    expect(honor.arguments.type).toBe('all')
  })

  it('rejects invalid JSON, enum, boolean, integer, and nested message values before invocation', () => {
    expect(parse('qq_send_group_message', { group_id: '123456', message: '[bad json]' }, { message: 'json' }).errors.message?.key).toBe('validation.json')
    expect(parse('qq_send_group_message', { group_id: '123456', message: '{"type":"image","data":{"file":"https://example.test/a.png","cache":"maybe"}}' }, { message: 'json' }).errors.message?.key).toBe('validation.schemaField')
    expect(parse('qq_send_group_message', { group_id: '123456', message: 'hello', auto_escape: 'no' }).errors.auto_escape?.key).toBe('validation.boolean')
    expect(parse('qq_get_group_honor_info', { group_id: '123456', type: 'future' }).errors.type?.key).toBe('validation.enum')
    expect(parse('qq_set_group_ban', { group_id: '123456', user_id: '987654321', duration: '1.5' }).errors.duration?.key).toBe('validation.integer')
    expect(parse('qq_set_group_ban', { group_id: '123456', user_id: '987654321', duration: '-1' }).errors.duration?.key).toBe('validation.schemaField')
  })

  it('uses the shared full schema for target combinations and nested cross-field rules', () => {
    expect(parse('qq_send_message', { message_type: 'group', user_id: '987654321', message: 'hello' }).schemaError?.key).toBe('validation.schemaInput')
    expect(parse('qq_send_message', { user_id: '987654321', group_id: '123456', message: 'hello' }).schemaError?.key).toBe('validation.schemaInput')
    expect(parse('qq_send_message', { message_type: 'group', user_id: '987654321', group_id: '123456', message: 'hello' }).schemaError).toBeUndefined()
    const context = { self_id: 123456789, post_type: 'request', request_type: 'friend', user_id: 987654321, flag: '原始标记 {{raw}}', sender: { nickname: '用户姓名' } }
    const values = { context: JSON.stringify(context), operation: '{"approve":false,"remark":"用户备注 {{name}}"}' }
    const result = parse('qq_handle_quick_operation', values)
    expect(result.errors).toEqual({})
    expect(result.schemaError).toBeUndefined()
    expect(result.arguments.context).toEqual(context)
    expect(result.arguments.operation).toEqual({ approve: false, remark: '用户备注 {{name}}' })
    expect(parse('qq_handle_quick_operation', { ...values, operation: '{"ban":true}' }).schemaError?.key).toBe('validation.schemaInput')
  })

  it('guards deeply nested JSON before preview and preserves a renderable argument object', () => {
    const selected = tool('qq_send_private_message')
    const fields = schemaFields(selected)
    const deep = '['.repeat(20000) + '0' + ']'.repeat(20000)
    for (const validate of [false, true]) {
      const result = parseToolArguments(selected, fields, { user_id: '987654321', message: deep }, { message: 'json' }, requestId, validate)
      expect(result.errors.message?.key).toBe('validation.schemaField')
      expect(result.arguments).not.toHaveProperty('message')
      expect(() => JSON.stringify(result.arguments)).not.toThrow()
    }
  })

  it('honors schema types for future tools without a business-specific form catalog', () => {
    const future: PluginToolDefinition = { name: 'future_tool', title: 'Future', description: '', readOnly: true, destructive: false,
      inputSchema: { type: 'object', properties: { choice: { enum: [false, 2] }, amount: { type: 'number' }, list: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } }
    const fields = schemaFields(future)
    const result = parseToolArguments(future, fields, { choice: 'false', amount: '1.5', list: '["用户内容"]' }, {}, requestId)
    expect(result.errors).toEqual({})
    expect(result.arguments).toEqual({ choice: false, amount: 1.5, list: ['用户内容'] })
  })
})
