import { describe, expect, it } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue, PluginToolDefinition } from '@eating/plugin-sdk'
import { ONEBOT_V11_HIDDEN_ACTIONS, ONEBOT_V11_PUBLIC_ACTIONS, ONEBOT_V11_SEND_SEGMENTS } from '../../../../../tests/fixtures/onebot-v11-contract'
import { prepareOneBotCall, qqTools, validateToolInput } from './operations'

const requestId = 'onebot-contract-0001'
const instanceId = 'a0c556f5-59bb-42ef-a186-a516498186ac'
const readActions = new Set([
  'get_msg', 'get_forward_msg', 'get_login_info', 'get_stranger_info', 'get_friend_list', 'get_group_info', 'get_group_list',
  'get_group_member_info', 'get_group_member_list', 'get_group_honor_info', 'get_cookies', 'get_csrf_token', 'get_credentials',
  'get_record', 'get_image', 'can_send_image', 'can_send_record', 'get_status', 'get_version_info',
])
const aliases: Record<string, string> = {
  send_private_msg: 'qq_send_private_message', send_group_msg: 'qq_send_group_message', send_msg: 'qq_send_message',
  delete_msg: 'qq_delete_message', get_msg: 'qq_get_message', get_forward_msg: 'qq_get_forward_message', '.handle_quick_operation': 'qq_handle_quick_operation',
}
function tool(action: string): PluginToolDefinition { return qqTools.find(entry => entry.protocolAction === action)! }
function input(action: string, params: JsonObject): JsonObject { return { ...params, ...(!readActions.has(action) ? { request_id: requestId } : {}) } }
function prepare(action: string, params: JsonObject) { return prepareOneBotCall(tool(action), input(action, params)) }
function invalid(action: string, params: unknown) {
  let error: unknown
  try { validateToolInput(tool(action), params) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(PlatformError)
  expect(error).toMatchObject({ code: 'INVALID_INPUT', statusCode: 400, outcome: 'not-sent' })
}
const privateContext: JsonObject = { post_type: 'message', message_type: 'private', self_id: '123', user_id: '456' }
const groupContext: JsonObject = { post_type: 'message', message_type: 'group', self_id: '123', user_id: '456', group_id: '789', message_id: '-17' }
const friendContext: JsonObject = { post_type: 'request', request_type: 'friend', self_id: 123, user_id: 456, flag: 'opaque:friend' }
const groupRequestContext: JsonObject = { post_type: 'request', request_type: 'group', sub_type: 'invite', self_id: 123, user_id: 456, group_id: 789, flag: 'opaque:group' }

describe('official OneBot v11 tool contract', () => {
  it('has one unique tool per 38 public actions and the one hidden quick operation, preserving old names', () => {
    const actions = [...ONEBOT_V11_PUBLIC_ACTIONS, ...ONEBOT_V11_HIDDEN_ACTIONS]
    expect(qqTools).toHaveLength(39)
    expect(new Set(qqTools.map(entry => entry.name)).size).toBe(39)
    expect(new Set(qqTools.map(entry => entry.protocolAction)).size).toBe(39)
    expect(qqTools.map(entry => entry.protocolAction).sort()).toEqual([...actions].sort())
    for (const action of actions) expect(tool(action).name).toBe(aliases[action] ?? `qq_${action}`)
    for (const name of ['qq_get_login_info', 'qq_get_status', 'qq_get_version_info', 'qq_get_friend_list', 'qq_get_group_list', 'qq_get_message', 'qq_send_private_message', 'qq_send_group_message', 'qq_delete_message']) {
      expect(qqTools.some(entry => entry.name === name)).toBe(true)
    }
  })

  it('classifies query, write, destructive and credential tools and exposes common metadata', () => {
    const sensitive = ['get_cookies', 'get_csrf_token', 'get_credentials']
    for (const entry of qqTools) {
      const properties = entry.inputSchema.properties as JsonObject
      expect(entry.inputSchema.type).toBe('object')
      expect(entry.inputSchema.additionalProperties).toBe(false)
      expect(properties.instance_id).toMatchObject({ type: 'string' })
      expect(properties.onebot_call_mode).toMatchObject({ enum: ['sync', 'async', 'rate_limited'], default: 'sync' })
      expect(entry.readOnly).toBe(readActions.has(entry.protocolAction!))
      expect(entry.sensitiveResult === true).toBe(sensitive.includes(entry.protocolAction!))
      if (entry.readOnly) {
        expect(properties.request_id).toBeUndefined()
        expect(entry.destructive).toBe(false)
      } else {
        expect(entry.inputSchema.required).toContain('request_id')
        expect(properties.request_id).toMatchObject({ minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' })
      }
    }
    for (const action of ['delete_msg', 'set_group_kick', 'set_group_ban', 'set_group_anonymous_ban', 'set_group_whole_ban', 'set_group_admin', 'set_group_leave', 'set_restart', 'clean_cache', '.handle_quick_operation']) expect(tool(action).destructive).toBe(true)
    for (const action of ['send_private_msg', 'send_group_msg', 'send_msg', 'send_like']) expect(tool(action).destructive).toBe(false)
  })

  // Handwritten from the fixed official API tables; every public API exercises all its non-alias parameters.
  const cases: Array<{ action: string; params: JsonObject; wire: JsonObject }> = [
    { action: 'send_private_msg', params: { user_id: '456', message: '[CQ:face,id=1]', auto_escape: false }, wire: { user_id: 456, message: '[CQ:face,id=1]', auto_escape: false } },
    { action: 'send_group_msg', params: { group_id: '789', message: [{ type: 'image', data: { file: 'https://example.invalid/p.png', type: 'flash', cache: 'yes', proxy: 0, timeout: '15.5' } }], auto_escape: false }, wire: { group_id: 789, message: [{ type: 'image', data: { file: 'https://example.invalid/p.png', type: 'flash', cache: 'yes', proxy: 0, timeout: '15.5' } }], auto_escape: false } },
    { action: 'send_msg', params: { message_type: 'private', user_id: '456', group_id: '789', message: { type: 'text', data: { text: 'hello' } }, auto_escape: true }, wire: { message_type: 'private', user_id: 456, group_id: 789, message: { type: 'text', data: { text: 'hello' } }, auto_escape: true } },
    { action: 'delete_msg', params: { message_id: '-2147483648' }, wire: { message_id: -2147483648 } },
    { action: 'get_msg', params: { message_id: 2147483647 }, wire: { message_id: 2147483647 } },
    { action: 'get_forward_msg', params: { id: '000001:+/opaque' }, wire: { id: '000001:+/opaque' } },
    { action: 'send_like', params: { user_id: '456', times: 10 }, wire: { user_id: 456, times: 10 } },
    { action: 'set_group_kick', params: { group_id: '789', user_id: 456, reject_add_request: false }, wire: { group_id: 789, user_id: 456, reject_add_request: false } },
    { action: 'set_group_ban', params: { group_id: '789', user_id: '456', duration: 0 }, wire: { group_id: 789, user_id: 456, duration: 0 } },
    { action: 'set_group_anonymous_ban', params: { group_id: '789', anonymous: { id: 2, name: '匿名', flag: 'opaque:anon' }, anonymous_flag: 'ignored', flag: 'also-ignored', duration: 1800 }, wire: { group_id: 789, anonymous: { id: 2, name: '匿名', flag: 'opaque:anon' }, duration: 1800 } },
    { action: 'set_group_whole_ban', params: { group_id: '789', enable: false }, wire: { group_id: 789, enable: false } },
    { action: 'set_group_admin', params: { group_id: '789', user_id: '456', enable: false }, wire: { group_id: 789, user_id: 456, enable: false } },
    { action: 'set_group_anonymous', params: { group_id: '789', enable: false }, wire: { group_id: 789, enable: false } },
    { action: 'set_group_card', params: { group_id: '789', user_id: '456', card: '' }, wire: { group_id: 789, user_id: 456, card: '' } },
    { action: 'set_group_name', params: { group_id: '789', group_name: '测试群' }, wire: { group_id: 789, group_name: '测试群' } },
    { action: 'set_group_leave', params: { group_id: '789', is_dismiss: false }, wire: { group_id: 789, is_dismiss: false } },
    { action: 'set_group_special_title', params: { group_id: '789', user_id: '456', special_title: '', duration: -1 }, wire: { group_id: 789, user_id: 456, special_title: '', duration: -1 } },
    { action: 'set_friend_add_request', params: { flag: '000:friend', approve: false, remark: '' }, wire: { flag: '000:friend', approve: false, remark: '' } },
    { action: 'set_group_add_request', params: { flag: '000:group', sub_type: 'invite', approve: false, reason: '' }, wire: { flag: '000:group', sub_type: 'invite', approve: false, reason: '' } },
    { action: 'get_login_info', params: {}, wire: {} },
    { action: 'get_stranger_info', params: { user_id: '456', no_cache: false }, wire: { user_id: 456, no_cache: false } },
    { action: 'get_friend_list', params: {}, wire: {} },
    { action: 'get_group_info', params: { group_id: '789', no_cache: true }, wire: { group_id: 789, no_cache: true } },
    { action: 'get_group_list', params: {}, wire: {} },
    { action: 'get_group_member_info', params: { group_id: '789', user_id: '456', no_cache: true }, wire: { group_id: 789, user_id: 456, no_cache: true } },
    { action: 'get_group_member_list', params: { group_id: '789' }, wire: { group_id: 789 } },
    { action: 'get_group_honor_info', params: { group_id: '789', type: 'all' }, wire: { group_id: 789, type: 'all' } },
    { action: 'get_cookies', params: { domain: '000.qzone.qq.com' }, wire: { domain: '000.qzone.qq.com' } },
    { action: 'get_csrf_token', params: {}, wire: {} },
    { action: 'get_credentials', params: { domain: '' }, wire: { domain: '' } },
    { action: 'get_record', params: { file: 'opaque.silk', out_format: 'flac' }, wire: { file: 'opaque.silk', out_format: 'flac' } },
    { action: 'get_image', params: { file: 'opaque.jpg' }, wire: { file: 'opaque.jpg' } },
    { action: 'can_send_image', params: {}, wire: {} },
    { action: 'can_send_record', params: {}, wire: {} },
    { action: 'get_status', params: {}, wire: {} },
    { action: 'get_version_info', params: {}, wire: {} },
    { action: 'set_restart', params: { delay: 2000 }, wire: { delay: 2000 } },
    { action: 'clean_cache', params: {}, wire: {} },
    { action: '.handle_quick_operation', params: { context: groupContext, operation: { reply: 'reply', auto_escape: false, at_sender: false, delete: true, kick: true, ban: true, ban_duration: 0 } }, wire: { context: { ...groupContext, self_id: 123, user_id: 456, group_id: 789, message_id: -17 }, operation: { reply: 'reply', auto_escape: false, at_sender: false, delete: true, kick: true, ban: true, ban_duration: 0 } } },
  ]
  it.each(cases)('validates every official parameter and prepares $action without mutation', ({ action, params, wire }) => {
    const original = input(action, { ...params, instance_id: instanceId, onebot_call_mode: 'sync' })
    const snapshot = structuredClone(original)
    expect(validateToolInput(tool(action), original)).toBe(original)
    expect(prepareOneBotCall(tool(action), original)).toEqual({ action, params: wire })
    expect(original).toEqual(snapshot)
  })
  it('keeps the independent full-parameter cases complete', () => {
    expect(cases.map(entry => entry.action).sort()).toEqual([...ONEBOT_V11_PUBLIC_ACTIONS, ...ONEBOT_V11_HIDDEN_ACTIONS].sort())
  })
})

describe('call preparation, defaults, IDs and aliases', () => {
  it('records protocol defaults without inserting them into validation input or arbitrary API calls', () => {
    const cases: Array<[string, JsonObject, string, JsonValue]> = [
      ['send_like', { user_id: 456 }, 'times', 1], ['set_group_ban', { group_id: 789, user_id: 456 }, 'duration', 1800],
      ['set_group_anonymous_ban', { group_id: 789, flag: 'anon' }, 'duration', 1800], ['set_group_special_title', { group_id: 789, user_id: 456 }, 'duration', -1],
      ['set_group_whole_ban', { group_id: 789 }, 'enable', true], ['get_stranger_info', { user_id: 456 }, 'no_cache', false],
      ['set_friend_add_request', { flag: 'friend' }, 'approve', true], ['get_cookies', {}, 'domain', ''], ['set_restart', {}, 'delay', 0],
    ]
    for (const [action, params, key, expected] of cases) {
      const value = input(action, params)
      const snapshot = structuredClone(value)
      expect(((tool(action).inputSchema.properties as JsonObject)[key] as JsonObject).default).toEqual(expected)
      validateToolInput(tool(action), value)
      expect(value).toEqual(snapshot)
      expect(prepareOneBotCall(tool(action), value).params[key]).toBeUndefined()
    }
    expect(prepare('send_private_msg', { user_id: 456, message: '[CQ:face,id=1]' }).params.auto_escape).toBe(true)
    expect(prepare('send_group_msg', { group_id: 789, message: 'hi', auto_escape: false }).params.auto_escape).toBe(false)
    expect(prepare('send_msg', { user_id: 456, message: 'hi' }).params.auto_escape).toBe(true)
    expect(prepare('send_like', { user_id: 456 }).params).not.toHaveProperty('auto_escape')
  })

  it.each(['sync', 'async', 'rate_limited'] as const)('controls the %s suffix and strips local metadata for read and hidden actions', mode => {
    const suffix = mode === 'sync' ? '' : `_${mode}`
    for (const [action, params] of [['get_status', {}], ['.handle_quick_operation', { context: privateContext, operation: { reply: 'hello' } }]] as const) {
      const result = prepare(action, { ...params, instance_id: instanceId, onebot_call_mode: mode })
      expect(result.action).toBe(`${action}${suffix}`)
      for (const key of ['request_id', 'instance_id', 'onebot_call_mode']) expect(result.params).not.toHaveProperty(key)
    }
  })

  it('rejects suffix/action injection, invalid request IDs and malformed local instance IDs', () => {
    for (const onebot_call_mode of ['send_msg', 'sync_async', 'async_rate_limited', '', true]) invalid('clean_cache', { request_id: requestId, onebot_call_mode })
    invalid('get_status', { action: 'set_restart' })
    expect(() => prepareOneBotCall({ ...tool('get_status'), protocolAction: 'set_restart' }, {})).toThrowError(PlatformError)
    expect(() => prepareOneBotCall({ ...tool('get_status'), name: 'qq_arbitrary' }, {})).toThrowError(PlatformError)
    for (const request_id of [undefined, 'short', 'has spaces', '.invalid-key', 'a'.repeat(129), true]) {
      const value: Record<string, unknown> = { request_id }
      if (request_id === undefined) delete value.request_id
      invalid('clean_cache', value)
    }
    for (const request_id of ['a1234567', 'A_.:-012', 'x'.repeat(128)]) expect(prepareOneBotCall(tool('clean_cache'), { request_id }).params).toEqual({})
    for (const instance_id of ['123456', '../instance', '', 'a0c556f5-59bb-42ef-a186-a516498186az']) invalid('get_status', { instance_id })
  })

  it('accepts safe numeric/string IDs and enforces positive IDs and signed int32 messages', () => {
    expect(prepare('get_stranger_info', { user_id: '9007199254740991' }).params.user_id).toBe(Number.MAX_SAFE_INTEGER)
    expect(prepare('get_stranger_info', { user_id: Number.MAX_SAFE_INTEGER }).params.user_id).toBe(Number.MAX_SAFE_INTEGER)
    expect(prepare('get_msg', { message_id: '-2147483648' }).params.message_id).toBe(-2147483648)
    expect(prepare('get_msg', { message_id: '0' }).params.message_id).toBe(0)
    for (const user_id of ['9007199254740992', Number.MAX_SAFE_INTEGER + 1, 0, '0', -1, '-1', 1.5, '1.5', '1e3', ' 123', '01']) invalid('get_stranger_info', { user_id })
    for (const message_id of ['2147483648', '-2147483649', 2147483648, -2147483649, '1.5', 0.5]) invalid('get_msg', { message_id })
  })

  it('infers send_msg only from one target, and requires the correct target for explicit types', () => {
    expect(prepare('send_msg', { user_id: '456', message: 'hi' }).params.user_id).toBe(456)
    expect(prepare('send_msg', { group_id: '789', message: 'hi' }).params.group_id).toBe(789)
    const invalidTargets: JsonObject[] = [{ message: 'hi' }, { user_id: 456, group_id: 789, message: 'hi' }, { message_type: 'group', user_id: 456, message: 'hi' }, { message_type: 'private', group_id: 789, message: 'hi' }, { message_type: 'other', user_id: 456, message: 'hi' }]
    for (const params of invalidTargets) invalid('send_msg', input('send_msg', params))
  })

  it('supports both official request type aliases and rejects conflicts, preserving empty clear fields', () => {
    for (const value of ['add', 'invite']) {
      expect(prepare('set_group_add_request', { flag: 'opaque', type: value, reason: '' }).params).toEqual({ flag: 'opaque', sub_type: value, reason: '' })
      expect(prepare('set_group_add_request', { flag: 'opaque', sub_type: value, type: value }).params).toEqual({ flag: 'opaque', sub_type: value })
    }
    invalid('set_group_add_request', input('set_group_add_request', { flag: 'opaque', sub_type: 'add', type: 'invite' }))
    invalid('set_group_add_request', input('set_group_add_request', { flag: 'opaque' }))
    for (const alias of ['flag', 'anonymous_flag']) expect(prepare('set_group_anonymous_ban', { group_id: 789, [alias]: 'opaque' }).params).toEqual({ group_id: 789, anonymous_flag: 'opaque' })
    invalid('set_group_anonymous_ban', input('set_group_anonymous_ban', { group_id: 789 }))
    invalid('set_group_anonymous_ban', input('set_group_anonymous_ban', { group_id: 789, flag: 'opaque', duration: 0 }))
  })

  it('rejects string booleans, unknown enums and nonstandard parameters instead of silently repairing them', () => {
    invalid('set_group_admin', input('set_group_admin', { group_id: 789, user_id: 456, enable: 'false' }))
    invalid('send_private_msg', input('send_private_msg', { user_id: 456, message: 'hi', auto_escape: 'false' }))
    invalid('get_group_info', { group_id: 789, no_cache: 1 })
    invalid('get_group_honor_info', { group_id: 789, type: 'invented' })
    invalid('get_record', { file: 'sample', out_format: 'aac' })
    invalid('send_like', input('send_like', { user_id: 456, auto_escape: true }))
  })
})

describe('complete OneBot message representations', () => {
  const segments: JsonObject[] = [
    { type: 'text', data: { text: 'hello [CQ:face,id=1]' } }, { type: 'face', data: { id: '178' } },
    { type: 'image', data: { file: 'base64://YWJj', type: 'flash', cache: '0', proxy: 'no', timeout: '30' } },
    { type: 'record', data: { file: 'file:///tmp/example.silk', magic: 'yes', cache: false, proxy: 1, timeout: 30 } },
    { type: 'video', data: { file: 'https://example.invalid/v.mp4', cache: 'true', proxy: 'false', timeout: '30.5' } },
    { type: 'at', data: { qq: 'all' } }, { type: 'rps', data: null }, { type: 'dice', data: {} }, { type: 'shake', data: null },
    { type: 'poke', data: { type: '1', id: '-1' } }, { type: 'anonymous', data: { ignore: 'yes' } },
    { type: 'share', data: { url: 'https://example.invalid', title: '', content: '', image: 'https://example.invalid/p.png' } },
    { type: 'contact', data: { type: 'qq', id: '456' } }, { type: 'location', data: { lat: '39.8', lon: 116.3, title: '', content: '' } },
    { type: 'music', data: { type: '163', id: '123' } }, { type: 'reply', data: { id: '-2147483648' } },
    { type: 'node', data: { user_id: '456', nickname: '成员', content: [{ type: 'text', data: { text: 'inner' } }] } },
    { type: 'xml', data: { data: '<?xml version="1.0"?><msg />' } }, { type: 'json', data: { data: '{"app":"test"}' } },
  ]
  it('covers exactly the independent 19 sendable types and sends both arrays and single segments unchanged', () => {
    expect(segments.map(segment => segment.type).sort()).toEqual([...ONEBOT_V11_SEND_SEGMENTS].sort())
    const whole = prepare('send_private_msg', { user_id: 456, message: segments })
    expect(whole.params.message).toBe(segments)
    for (const segment of segments) expect(prepare('send_private_msg', { user_id: 456, message: segment }).params.message).toBe(segment)
  })

  it('supports music/contact/node variants and every documented boolean segment representation', () => {
    for (const type of ['qq', '163', 'xm']) expect(prepare('send_private_msg', { user_id: 456, message: { type: 'music', data: { type, id: '123' } } }).params.message).toMatchObject({ type: 'music' })
    expect(prepare('send_private_msg', { user_id: 456, message: { type: 'music', data: { type: 'custom', url: 'https://example.invalid', audio: 'https://example.invalid/audio', title: '', content: '', image: '' } } }).params.message).toMatchObject({ type: 'music' })
    expect(prepare('send_private_msg', { user_id: 456, message: { type: 'contact', data: { type: 'group', id: '789' } } }).params.message).toMatchObject({ type: 'contact' })
    expect(prepare('send_private_msg', { user_id: 456, message: { type: 'node', data: { id: '-1' } } }).params.message).toEqual({ type: 'node', data: { id: '-1' } })
    for (const content of ['inner [CQ:face,id=1]', { type: 'face', data: { id: '1' } }, [{ type: 'text', data: { text: 'inner' } }]]) {
      const node: JsonObject = { type: 'node', data: { user_id: '456', nickname: '', content } }
      expect(prepare('send_private_msg', { user_id: 456, message: node }).params.message).toBe(node)
    }
    for (const cache of ['0', '1', 'no', 'yes', 'false', 'true', false, true, 0, 1]) expect(prepare('send_private_msg', { user_id: 456, message: { type: 'image', data: { file: 'sample.jpg', cache } } }).params.message).toMatchObject({ data: { cache } })
    for (const type of ['rps', 'dice', 'shake', 'anonymous']) for (const data of [null, {}]) expect(prepare('send_private_msg', { user_id: 456, message: { type, data } }).params.message).toEqual({ type, data })
  })

  it('rejects unknown or receive-only segments, unknown data fields, malformed variants and nested payloads', () => {
    const bad: JsonValue[] = [
      '', [], { type: 'forward', data: { id: '123' } }, { type: 'unknown', data: {} },
      { type: 'text', data: { text: 'hello', extra: 'forbidden' } }, { type: 'text', data: null },
      { type: 'image', data: { file: 'sample.jpg', url: 'receive-only' } }, { type: 'image', data: { file: 'sample.jpg', type: 'normal' } },
      { type: 'record', data: { file: 'sample.silk', magic: 'maybe' } }, { type: 'music', data: { type: 'custom', url: 'https://example.invalid', title: 'missing audio' } },
      { type: 'contact', data: { type: 'friend', id: '123' } }, { type: 'node', data: { uin: '456', name: 'vendor', content: 'hi' } },
      { type: 'node', data: { id: '1', user_id: '456', nickname: 'ambiguous', content: 'hi' } },
      { type: 'node', data: { user_id: '456', nickname: 'nested', content: [{ type: 'json', data: { extra: 'bad' } }] } },
    ]
    for (const message of bad) invalid('send_private_msg', input('send_private_msg', { user_id: 456, message }))
  })

  it('accepts ordinary large messages at documented local bounds, and rejects overflow', () => {
    expect(prepare('send_private_msg', { user_id: 456, message: 'x'.repeat(262144) }).params.message).toHaveLength(262144)
    invalid('send_private_msg', input('send_private_msg', { user_id: 456, message: 'x'.repeat(262145) }))
    const array = Array.from({ length: 1000 }, () => ({ type: 'face', data: { id: '1' } }))
    expect(prepare('send_private_msg', { user_id: 456, message: array }).params.message).toBe(array)
    invalid('send_private_msg', input('send_private_msg', { user_id: 456, message: [...array, array[0]!] }))
  })
})

describe('quick operations match the original event type', () => {
  it('supports every event family, preserves extra event data and defaults escape only for replies', () => {
    const context = { ...privateContext, time: 1, message: [{ type: 'forward', data: { id: 'receive-only' } }], sender: { user_id: 456, nickname: '成员', role: 'owner', implementation_field: true }, future_event_field: { text: '外部数据' } }
    const cases: Array<[JsonObject, JsonObject]> = [[context, { reply: { type: 'text', data: { text: 'hi' } } }], [groupContext, { reply: [{ type: 'face', data: { id: '1' } }], at_sender: false }], [friendContext, { approve: false, remark: '' }], [groupRequestContext, { approve: false, reason: '' }], [groupContext, { ban: true, ban_duration: 0 }]]
    for (const [event, operation] of cases) {
      const result = prepare('.handle_quick_operation', { context: event, operation })
      expect(result.params.operation).toEqual(operation.reply === undefined ? operation : { ...operation, auto_escape: true })
    }
    const result = prepare('.handle_quick_operation', { context, operation: { reply: 'hi' } })
    expect((result.params.context as JsonObject).message).toBe(context.message)
    expect((result.params.context as JsonObject).future_event_field).toBe(context.future_event_field)
  })

  it('rejects actions from other event families, incomplete targets, no-ops and invented operation fields', () => {
    const cases: Array<[JsonObject, JsonObject]> = [
      [privateContext, {}], [groupContext, {}], [groupContext, { ban: false, kick: false, delete: false }],
      [privateContext, { kick: true }], [privateContext, { reply: 'hi', ban: true }], [friendContext, { approve: true, kick: true }],
      [friendContext, { approve: false, reason: '' }], [groupRequestContext, { approve: true, remark: '' }],
      [friendContext, { remark: '' }], [groupContext, { reply: 'hi', arbitrary_action: 'clean_cache' }],
      [{ ...groupContext, message_id: undefined } as unknown as JsonObject, { delete: true }],
      [{ post_type: 'request', request_type: 'friend', self_id: 123, user_id: 456 }, { approve: true }],
      [{ post_type: 'request', request_type: 'group', self_id: 123, user_id: 456, group_id: 789, flag: 'f' }, { approve: true }],
      [{ ...privateContext, self_id: '9007199254740992' }, { reply: 'hi' }],
      [{ ...groupContext, anonymous: { id: 1, name: '匿名', flag: 'anon' } }, { ban: true, ban_duration: 0 }],
      [{ ...groupContext, sub_type: 'anonymous' }, { ban: true, ban_duration: 0 }],
      [{ post_type: 'notice', self_id: 123, user_id: 456 }, { reply: 'hi' }],
    ]
    for (const [context, operation] of cases) invalid('.handle_quick_operation', input('.handle_quick_operation', { context, operation }))
    const contextWithoutId = { ...groupContext }; delete contextWithoutId.message_id
    invalid('.handle_quick_operation', input('.handle_quick_operation', { context: contextWithoutId, operation: { delete: true } }))
  })
})
