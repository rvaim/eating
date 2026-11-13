import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { ImageRequestParameters } from './types'

export const DEFAULT_REQUEST_PARAMETERS: ImageRequestParameters = Object.freeze({ moderation: 'low' })
export const REQUEST_PARAMETERS_MAX_BYTES = 16 * 1024
const reserved = new Set(['model', 'prompt', 'n', 'image', 'image_url', 'images', 'mask', 'source', 'size', 'quality', 'response_format',
  'stream', 'partial_images', 'request_id', 'api_key', 'apikey', 'authorization', 'headers', 'base_url', 'baseurl', 'endpoint', 'url', '__proto__', 'prototype', 'constructor'])

export function parseRequestParameters(input: unknown): ImageRequestParameters {
  const invalid = (): never => { throw new PlatformError('IMAGE_REQUEST_PARAMETERS_INVALID', '请求参数须为最多32项的JSON对象，值仅支持字符串、数字或布尔值；不能覆盖模型、提示词、尺寸、数量、文件、鉴权或流式响应字段。moderation只支持low或auto。', 400, 'not-sent') }
  if (!isJsonObject(input) || Object.keys(input).length > 32) return invalid()
  const entries = Object.entries(input)
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || reserved.has(key.toLowerCase())
      || !['string', 'number', 'boolean'].includes(typeof value)
      || typeof value === 'string' && (value.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
      || typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      || key === 'moderation' && value !== 'low' && value !== 'auto') invalid()
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > REQUEST_PARAMETERS_MAX_BYTES) invalid()
  return Object.fromEntries(entries) as ImageRequestParameters
}
