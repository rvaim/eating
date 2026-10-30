import type { JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'

const assetId: JsonObject = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'sticker_list 或 sticker_add 返回的资源 ID。' }
const expectedRevision: JsonObject = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '最新查询得到的表情库版本；不匹配时拒绝修改或继续分页。' }
const description: JsonObject = { type: 'string', minLength: 1, maxLength: 1000, description: '独立描述此表情表达的内容和适用语境。' }
const tags: JsonObject = { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 32 }, description: '最多 32 个标签，每个最多 32 个字符，重复标签会去重。' }
const requestId: JsonObject = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$', minLength: 8, maxLength: 128, description: '稳定请求 ID。重复或结果未知时复用，避免重复修改。' }
function tool(name: string, title: string, help: string, properties: JsonObject, required: string[], readOnly: boolean, content = false): PluginToolDefinition {
  return { name, title, description: help, readOnly, destructive: name === 'sticker_delete', resultFormat: content ? 'content' : 'json',
    inputSchema: { type: 'object', properties: { ...properties, ...(!readOnly ? { request_id: requestId } : {}) }, required: [...required, ...(!readOnly ? ['request_id'] : [])], additionalProperties: false } }
}
export const stickerTools: readonly PluginToolDefinition[] = [
  tool('sticker_add', '收藏会话表情', '从当前可信会话的消息与图片引用收藏表情。描述和标签必填；同图重复收藏保留原资料。不能提供网址、路径或 Base64；无当前会话来源时不可用。', {
    source: { type: 'object', properties: { messageId: { type: 'string', minLength: 1, maxLength: 160 }, imageId: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['messageId', 'imageId'], additionalProperties: false }, description, tags, expectedRevision,
  }, ['source', 'description', 'tags'], false),
  tool('sticker_list', '查找表情', '按关键字和标签筛选表情元数据，不返回图片数据。标签按 AND 匹配；分页时可传 expectedRevision 避免跨版本漏项。', {
    query: { type: 'string', maxLength: 1000 }, tags, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, expectedRevision,
  }, [], true),
  tool('sticker_get', '读取表情图片', '读取指定表情的真实图片和可发送 image 消息段。发送时使用 sendable 中的 eating-asset 引用，无需搬运 Base64。', { assetId, expectedRevision }, ['assetId'], true, true),
  tool('sticker_update', '编辑表情资料', '以表情库版本 CAS 更新指定表情的完整描述和标签，不替换图片内容。', { assetId, description, tags, expectedRevision }, ['assetId', 'description', 'tags', 'expectedRevision'], false),
  tool('sticker_delete', '删除表情', '以表情库版本 CAS 删除表情及库内图片。此操作无法撤销。', { assetId, expectedRevision }, ['assetId', 'expectedRevision'], false),
  tool('sticker_list_tags', '查看表情标签', '列出表情库中所有标签及对应表情数量，不包含图片数据。', { expectedRevision }, [], true),
]
