import { PlatformError, isJsonObject, isJsonValue } from '@eating/plugin-sdk'
import type { JsonValue, PluginToolDefinition } from '@eating/plugin-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const maxImageBytes = 5 * 1024 * 1024
const maxBatchBytes = 10 * 1024 * 1024
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const exactKeys = (value: object, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))

export function assertToolResultFormat(tool: PluginToolDefinition): void {
  if (tool.resultFormat !== 'json' && tool.resultFormat !== 'content') throw new PlatformError('INVALID_TOOL_RESULT_FORMAT', '工具未声明当前支持的结果格式。', 500, 'not-sent')
}
function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

/** A declared content tool yields real MCP blocks; ordinary JSON is never reinterpreted. */
export function toolResult(tool: PluginToolDefinition, result: JsonValue, requestId: string): CallToolResult {
  assertToolResultFormat(tool)
  const invalid = (): never => { throw new PlatformError('INVALID_TOOL_RESULT', '工具返回的内容格式无效或超过允许大小。', 502, tool.readOnly ? 'failed' : 'unknown') }
  if (!isJsonValue(result)) return invalid()
  if (tool.resultFormat === 'json') return { isError: false, structuredContent: { result, request_id: requestId }, content: [{ type: 'text', text: JSON.stringify(result) }] }
  if (!isJsonObject(result) || !exactKeys(result, ['content'], ['structuredContent']) || !Array.isArray(result.content) || result.content.length < 1 || result.content.length > 8
    || result.structuredContent !== undefined && (!isJsonObject(result.structuredContent) || Buffer.byteLength(JSON.stringify(result.structuredContent)) > 65536)) return invalid()
  let imageBytes = 0, imageCount = 0
  const content: CallToolResult['content'] = result.content.map(block => {
    if (!isJsonObject(block)) return invalid()
    if (block.type === 'text') {
      if (!exactKeys(block, ['type', 'text']) || typeof block.text !== 'string' || block.text.length > 131072) return invalid()
      return { type: 'text', text: block.text }
    }
    if (block.type !== 'image' || !exactKeys(block, ['type', 'data', 'mimeType']) || typeof block.mimeType !== 'string' || !mediaTypes.has(block.mimeType)
      || typeof block.data !== 'string' || !block.data || block.data.length > Math.ceil(maxImageBytes / 3) * 4 || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(block.data)) return invalid()
    const bytes = Buffer.from(block.data, 'base64')
    imageBytes += bytes.length; imageCount += 1
    if (bytes.length > maxImageBytes || imageBytes > maxBatchBytes || imageCount > 4 || bytes.toString('base64') !== block.data || imageType(bytes) !== block.mimeType) return invalid()
    return { type: 'image', data: block.data, mimeType: block.mimeType }
  })
  return { isError: false, content, structuredContent: { ...(isJsonObject(result.structuredContent) ? result.structuredContent : {}), request_id: requestId } }
}
