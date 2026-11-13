import type { JsonObject, PluginToolDefinition } from '@eating/plugin-sdk'
const id: JsonObject = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
function tool(name: string, title: string, description: string, properties: JsonObject, required: string[]): PluginToolDefinition {
  return { name, title, description, readOnly: name !== 'speech_generate', destructive: false, resultFormat: 'json', inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}
export function speechTools(supportsDelivery: boolean) { return [
  tool('speech_generate', '合成语音', '提交可能计费的异步合成，返回jobId不代表完成。text由当前会话Agent组织。' + (supportsDelivery ? 'delivery只描述本次语气，不修改主人音色。' : '当前DeepSeek无自定义语气参数，不得提供delivery。') + '用speech_job_get查询；相同意图复用request_id，unknown不换号重试。', { text: { type: 'string', minLength: 1, maxLength: 1000 }, ...(supportsDelivery ? { delivery: { type: 'string', maxLength: 500, description: '本段临时语气，例如轻柔、平稳、轻快；只影响读法，不改变原文。省略为自然口语。' } } : {}), request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' } }, ['text', 'request_id']),
  tool('speech_job_get', '查询语音任务', '读取真实任务状态，waitMs最多等待20秒。succeeded后读取speech_get；unknown可能已计费，不自动重新合成。', { jobId: id, waitMs: { type: 'integer', minimum: 0, maximum: 20000 } }, ['jobId']),
  tool('speech_jobs', '列出语音任务', '找回已提交任务，返回分页元数据，不返回音频字节。', { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, []),
  tool('speech_get', '取得语音发送引用', '返回已完成语音的元数据与record消息段。message直接传sendable或[sendable]，不JSON.stringify，不将URI当文字发送；一条语音单独发送，配文另发。合成成功不等于QQ发送成功，以通讯工具回执为准，未知发送不重发。', { assetId: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['assetId']),
] }
