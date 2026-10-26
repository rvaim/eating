import { PlatformError, isJsonObject } from '../../../packages/platform-contract/src/index'
import type { JsonObject, PluginToolDefinition } from '../../../packages/platform-contract/src/index'

const idProperty: JsonObject = { type: 'string', pattern: '^[1-9][0-9]{0,15}$', description: 'QQ 或群号码，使用十进制字符串避免精度丢失。' }
const messageIdProperty: JsonObject = { type: 'string', pattern: '^-?[0-9]{1,16}$', description: 'OneBot 消息 ID。' }
const requestProperty: JsonObject = { type: 'string', minLength: 8, maxLength: 128, description: '稳定请求 ID；超时重试时必须复用原值，防止重复发送。' }

const baseTools: readonly PluginToolDefinition[] = [
  { name: 'qq_get_login_info', title: '获取登录账号', description: '查询 OneBot 当前实际登录的 QQ 账号。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_get_status', title: '检查协议端状态', description: '查询 OneBot 的 online/good 状态。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_get_version_info', title: '获取协议端版本', description: '获取 OneBot 实现与协议版本信息。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_get_friend_list', title: '读取好友列表', description: '读取当前账号的好友列表，包含个人联系信息。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_get_group_list', title: '读取群列表', description: '读取当前账号加入的群。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_get_message', title: '读取一条消息', description: '通过 OneBot 标准 get_msg 获取指定消息；是否可查询取决于协议端保存范围。', inputSchema: { type: 'object', properties: { message_id: messageIdProperty }, required: ['message_id'], additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_list_received_messages', title: '读取已接收消息', description: '读取 Eating 已持久保存的消息，可按 conversation_id 过滤；不是任意平台完整历史。', inputSchema: { type: 'object', properties: { conversation_id: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, before: { type: 'integer', minimum: 1 } }, additionalProperties: false }, readOnly: true, destructive: false },
  { name: 'qq_send_private_message', title: '发送私聊消息', description: '向指定 QQ 号发送真实文本消息。明确确认收件人和内容，使用 request_id 防重复；不解析 CQ 码。', inputSchema: { type: 'object', properties: { user_id: idProperty, message: { type: 'string', minLength: 1, maxLength: 20000 }, request_id: requestProperty }, required: ['user_id', 'message', 'request_id'], additionalProperties: false }, readOnly: false, destructive: false },
  { name: 'qq_send_group_message', title: '发送群消息', description: '向指定群发送真实文本消息。使用 request_id 防重复，不解析 CQ 码。', inputSchema: { type: 'object', properties: { group_id: idProperty, message: { type: 'string', minLength: 1, maxLength: 20000 }, request_id: requestProperty }, required: ['group_id', 'message', 'request_id'], additionalProperties: false }, readOnly: false, destructive: false },
  { name: 'qq_delete_message', title: '撤回消息', description: '撤回指定 message_id 的真实消息，受账号与群权限限制。使用稳定 request_id。', inputSchema: { type: 'object', properties: { message_id: messageIdProperty, request_id: requestProperty }, required: ['message_id', 'request_id'], additionalProperties: false }, readOnly: false, destructive: true },
]

export const qqTools: readonly PluginToolDefinition[] = baseTools.map((tool): PluginToolDefinition => ({ ...tool, inputSchema: { ...tool.inputSchema,
  properties: { ...(isJsonObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}),
    instance_id: { type: 'string', minLength: 1, maxLength: 80, description: '本地账号实例 ID，省略时使用默认实例；本版本仅启用一个实例，不等同 QQ 号码。' } },
} }))

export function validateToolInput(tool: PluginToolDefinition, input: unknown): JsonObject {
  if (!isJsonObject(input)) throw new PlatformError('INVALID_INPUT', '工具参数必须是 JSON 对象。')
  const properties = isJsonObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
  for (const key of required) if (typeof key === 'string' && input[key] === undefined) throw new PlatformError('INVALID_INPUT', `缺少参数 ${key}。`)
  for (const [key, value] of Object.entries(input)) {
    const rule = properties[key]
    if (!isJsonObject(rule)) throw new PlatformError('INVALID_INPUT', `不支持参数 ${key}。`)
    if (rule.type === 'string') {
      if (typeof value !== 'string' || typeof rule.minLength === 'number' && value.length < rule.minLength || typeof rule.maxLength === 'number' && value.length > rule.maxLength || typeof rule.pattern === 'string' && !new RegExp(rule.pattern).test(value)) throw new PlatformError('INVALID_INPUT', `参数 ${key} 格式不正确。`)
    } else if (rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || typeof rule.minimum === 'number' && value < rule.minimum || typeof rule.maximum === 'number' && value > rule.maximum) throw new PlatformError('INVALID_INPUT', `参数 ${key} 需为范围内整数。`)
    }
  }
  return input
}
