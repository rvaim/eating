import type { JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'
import { oneBotIdSchema, oneBotMessageIdSchema, oneBotMessageSchema } from './message-schema'

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const text = (description: string, minimum = 0): JsonObject => ({ type: 'string', minLength: minimum, maxLength: 262144, description })
export const flagProperty = text('来自 OneBot 事件的原始 flag，不作解释或改写。', 1)
export const autoEscapeProperty: JsonObject = {
  type: 'boolean', default: true,
  description: 'Eating 为保留既有纯文本行为默认 true；OneBot 标准默认 false。显式 false 才解析字符串中的 CQ 码，消息段对象／数组不受此参数影响。',
}
export const durationProperty: JsonObject = { type: 'integer', minimum: 0, maximum: MAX_SAFE, default: 1800, description: '禁言秒数，0 表示取消普通成员禁言。' }
export const anonymousProperty: JsonObject = {
  type: 'object', properties: { id: oneBotIdSchema, name: text('匿名名称。'), flag: flagProperty },
  required: ['id', 'name', 'flag'], additionalProperties: true,
  description: 'OneBot 群消息的 anonymous 对象；存在时优先于 anonymous_flag／flag。',
}
export const requestTypeProperty: JsonObject = { type: 'string', enum: ['add', 'invite'], description: '必须与请求事件的 sub_type 相符。' }

const sendContentConstraints: JsonObject = {
  oneOf: [
    { required: ['message'], not: { anyOf: [{ required: ['image_ref'] }, { required: ['audio_ref'] }] } },
    { required: ['image_ref'], not: { anyOf: [{ required: ['message'] }, { required: ['audio_ref'] }, { required: ['auto_escape'] }] } },
    { required: ['audio_ref'], not: { anyOf: [{ required: ['message'] }, { required: ['image_ref'] }, { required: ['auto_escape'] }] } },
  ],
}
const sendTargetConstraints: JsonObject = {
  oneOf: [
    { required: ['message_type', 'user_id'], properties: { message_type: { const: 'private' } } },
    { required: ['message_type', 'group_id'], properties: { message_type: { const: 'group' } } },
    { not: { required: ['message_type'] }, oneOf: [
      { required: ['user_id'], not: { required: ['group_id'] } },
      { required: ['group_id'], not: { required: ['user_id'] } },
    ] },
  ],
}
const groupRequestConstraints: JsonObject = {
  allOf: [
    { anyOf: [{ required: ['sub_type'] }, { required: ['type'] }] },
    { anyOf: [
      { properties: { sub_type: { const: 'add' }, type: { const: 'add' } } },
      { properties: { sub_type: { const: 'invite' }, type: { const: 'invite' } } },
    ] },
  ],
}

// Quick-operation contexts remain external event data. Only the operation object grants an action;
// sender roles, text and additional event fields never become owner authorization.
const eventProperties: JsonObject = {
  time: { type: 'integer', minimum: 0, maximum: MAX_SAFE }, self_id: oneBotIdSchema,
  post_type: { type: 'string', enum: ['message', 'request'] },
  message_type: { type: 'string', enum: ['private', 'group'] }, request_type: { type: 'string', enum: ['friend', 'group'] },
  sub_type: { type: 'string' }, user_id: oneBotIdSchema, group_id: oneBotIdSchema, message_id: oneBotMessageIdSchema,
  // Incoming messages may contain receive-only/vendor segments. Do not apply the send schema to event/result data.
  message: {}, raw_message: text('事件原始消息。'), font: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
  anonymous: { anyOf: [{ type: 'null' }, anonymousProperty] },
  sender: { type: 'object', properties: {
    user_id: oneBotIdSchema, nickname: text('昵称。'), sex: { type: 'string', enum: ['male', 'female', 'unknown'] },
    age: { type: 'integer', minimum: 0, maximum: 2147483647 }, card: text('群名片。'), area: text('地区。'),
    level: text('等级。'), role: { type: 'string', enum: ['owner', 'admin', 'member'] }, title: text('专属头衔。'),
  }, additionalProperties: true },
  comment: text('请求验证信息。'), flag: flagProperty,
}
function eventContext(properties: JsonObject, required: string[]): JsonObject {
  return { type: 'object', properties: { ...eventProperties, ...properties }, required: ['self_id', 'post_type', 'user_id', ...required], additionalProperties: true }
}
function operation(properties: JsonObject, constraints: JsonObject): JsonObject {
  return { type: 'object', properties, additionalProperties: false, minProperties: 1, ...constraints }
}
const replyProperties: JsonObject = { reply: oneBotMessageSchema, auto_escape: autoEscapeProperty }
const privateOperation = operation(replyProperties, { required: ['reply'] })
const groupOperation = operation({
  ...replyProperties, at_sender: { type: 'boolean', default: true }, delete: { type: 'boolean', default: false },
  kick: { type: 'boolean', default: false }, ban: { type: 'boolean', default: false }, ban_duration: durationProperty,
}, { anyOf: [
  { required: ['reply'] },
  ...['delete', 'kick', 'ban'].map(key => ({ required: [key], properties: { [key]: { const: true } } })),
] })
const friendRequestOperation = operation({ approve: { type: 'boolean' }, remark: text('同意后的好友备注，可为空。') }, { required: ['approve'] })
const groupRequestOperation = operation({ approve: { type: 'boolean' }, reason: text('拒绝理由，可为空。') }, { required: ['approve'] })
const quickOperationConstraints: JsonObject = {
  oneOf: [
    { properties: {
      context: eventContext({ post_type: { const: 'message' }, message_type: { const: 'private' }, sub_type: { type: 'string', enum: ['friend', 'group', 'other'] } }, ['message_type']),
      operation: privateOperation,
    } },
    { properties: {
      context: eventContext({ post_type: { const: 'message' }, message_type: { const: 'group' }, sub_type: { type: 'string', enum: ['normal', 'anonymous', 'notice'] } }, ['message_type', 'group_id']),
      operation: groupOperation,
    }, allOf: [
      { if: { properties: { operation: { required: ['delete'], properties: { delete: { const: true } } } } },
        then: { properties: { context: { required: ['message_id'] } } } },
      { if: { properties: {
        context: { anyOf: [
          { required: ['anonymous'], properties: { anonymous: { type: 'object' } } },
          { required: ['sub_type'], properties: { sub_type: { const: 'anonymous' } } },
        ] }, operation: { required: ['ban'], properties: { ban: { const: true } } },
      } }, then: { properties: { operation: { properties: { ban_duration: { minimum: 1 } } } } } },
    ] },
    { properties: {
      context: eventContext({ post_type: { const: 'request' }, request_type: { const: 'friend' } }, ['request_type', 'flag']),
      operation: friendRequestOperation,
    } },
    { properties: {
      context: eventContext({ post_type: { const: 'request' }, request_type: { const: 'group' }, sub_type: requestTypeProperty }, ['request_type', 'group_id', 'sub_type', 'flag']),
      operation: groupRequestOperation,
    } },
  ],
}

/**
 * Cross-field JSON Schema constraints kept out of LLM-advertised `inputSchema` so OpenAI/Gemini/gateways
 * never reject `not`/`if`/`then`/root combinators, while both backend invoke() and web forms enforce them.
 */
export const qqToolConstraints: Readonly<Record<string, JsonObject>> = {
  qq_send_private_message: sendContentConstraints,
  qq_send_group_message: sendContentConstraints,
  qq_send_message: { allOf: [sendTargetConstraints, sendContentConstraints] },
  qq_set_group_anonymous_ban: { anyOf: [{ required: ['anonymous'] }, { required: ['anonymous_flag'] }, { required: ['flag'] }] },
  qq_set_group_add_request: groupRequestConstraints,
  qq_handle_quick_operation: quickOperationConstraints,
}

const fullSchemas = new WeakMap<PluginToolDefinition, JsonObject>()
export function toolValidationSchema(tool: PluginToolDefinition): JsonObject {
  const constraints = qqToolConstraints[tool.name]
  if (!constraints) return tool.inputSchema
  let full = fullSchemas.get(tool)
  if (!full) {
    full = { ...tool.inputSchema, ...constraints }
    fullSchemas.set(tool, full)
  }
  return full
}
