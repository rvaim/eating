import type { JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from '../types'
const jobId: JsonObject = { type: 'string', pattern: '^[a-fA-F0-9-]{36}$' }
const assetId: JsonObject = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const page: JsonObject = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }
const source: JsonObject = { type: 'object', properties: {
  kind: { type: 'string', enum: ['received', 'asset', 'persona'] },
  messageId: { type: 'string', minLength: 1, maxLength: 160, description: '当 kind=received 时必填：当前会话消息 ID。' },
  imageId: { type: 'string', minLength: 1, maxLength: 2048, description: '当 kind=received 时为消息 image 段的原始 file 引用；当 kind=persona 时为当前启用人格的外貌参考图 UUID（来自人格设定清单或 persona_appearance_list/get）。' },
  assetId: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '当 kind=asset 时必填：之前生成图片的 assetId。' },
}, required: ['kind'], additionalProperties: false }
const sources: JsonObject = {
  type: 'array',
  minItems: 1,
  maxItems: 4,
  items: source,
  description: '多张参考图列表（1 至 4 张，可组合人格外貌参考图与当前会话或已生成图片；与 source 互斥）。',
}
const generation: JsonObject = { prompt: { type: 'string', minLength: 1, maxLength: IMAGE_GENERATION_LIMITS.prompt }, size: { type: 'string', maxLength: 64, description: '本次生成或编辑的尺寸，覆盖面板保存的默认尺寸。自定义宽高用 WIDTHxHEIGHT，例如 1024x1024、1536x1024、1024x1536（竖图）；也可原样填写当前服务支持的 portrait、auto、preserve 等关键字。这些只是格式示例，不保证当前模型支持。省略时使用已保存默认值；显式传空字符串则不向服务发送 size，使用服务默认值。以当前服务实际支持为准；没有尺寸能力声明时只校验格式并透传，失败后不自动换尺寸重新计费。', examples: ['1024x1024', '1536x1024', '1024x1536', 'portrait', 'auto', 'preserve', ''] }, quality: { type: 'string', maxLength: 64 }, response_format: { type: 'string', enum: ['', 'b64_json', 'url'] }, source, sources, request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' } }
function tool(name: string, title: string, description: string, properties: JsonObject, required: string[], content = false): PluginToolDefinition {
  return { name, title, description, readOnly: name !== 'image_generate', destructive: false, resultFormat: content ? 'content' : 'json', inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}
export const imageGenerationTools: readonly PluginToolDefinition[] = [
  tool('image_generate', '提交生图或图片编辑任务', '可能产生付费请求。提交一次异步任务后返回 jobId，不代表图片已生成；通过 image_job_get 查询。复用稳定 request_id 防重，unknown 不要以新 ID 自动重试。不传 source/sources 为文生图；传 source 为单图编辑，或传 sources（1 至 4 张）为多图参考编辑：当前会话收到图片用 {kind:"received",messageId,imageId}，已生成图片用 {kind:"asset",assetId}，当前启用人格外貌参考图用 {kind:"persona",imageId}。只接受当前会话已授权图片、本插件资源或当前启用人格外貌图，不接受任意路径/URL；固定 n=1。请求参数使用主人面板保存的JSON配置，默认moderation=low；只影响新任务，不能因服务不支持参数而自动付费重试。', generation, ['prompt', 'request_id']),
  tool('image_job_get', '查询生图任务', '查询实际持久任务状态；waitMs 只作最多20秒有限等待，未知结果不重放。succeeded但assetIds为空表示主人已删除原图，任务记录仍保留；不能为补发自动重新生成。', { jobId, waitMs: { type: 'integer', minimum: 0, maximum: 20000, default: 0 } }, ['jobId']),
  tool('image_jobs', '列出生图任务', '分页读取任务元数据，不含 Key、服务原响应或签名下载地址。', page, []),
  tool('image_list', '列出生成图片', '按生成时间倒序分页读取图片元数据，可按描述或模型搜索，不返回原图或 Base64。已删除图片不在列表中。', { ...page, query: { type: 'string', maxLength: 200 } }, []),
  tool('image_get', '读取生成图片', '读取单张真实图片和 image_ref（另含 sendable 图片段）。发送一张已有图片时复制 image_ref 到 QQ 发送工具同名顶层字段，省略 message 和 auto_escape。重用原 assetId，无需重新生成。', { assetId }, ['assetId'], true),
]
