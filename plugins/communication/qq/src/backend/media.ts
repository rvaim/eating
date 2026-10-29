import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, JsonObject, JsonValue, PluginToolDefinition } from '@eating/plugin-sdk'

export const qqViewReceivedImageTool: PluginToolDefinition = {
  name: 'qq_view_received_image', title: '查看本会话图片',
  description: '按当前会话已授权的消息 ID 和图片 file 引用读取真实图片，返回图像内容。不能填写任意网址或本机路径；仅有远端文件路径时不可用。模型仍需支持图像输入。',
  readOnly: true, destructive: false, resultFormat: 'content',
  inputSchema: {
    type: 'object', properties: {
      message_id: { type: 'string', pattern: '^(?:0|-?[1-9][0-9]{0,15})$', maxLength: 17, description: '当前会话已授权的 OneBot 消息 ID，保持十进制字符串。' },
      image_id: { type: 'string', minLength: 1, maxLength: 2048, description: '该消息中真实收到的 image 消息段的 file 引用，保持原值。' },
      instance_id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'Eating 本地账号实例 UUID；省略使用当前实例。' },
    }, required: ['message_id', 'image_id'], additionalProperties: false,
  },
}

function decodeCQParameter(value: string): string {
  // Decode ampersands last: &amp;#91; is literal &#91;, not an opening bracket.
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
}

/** Interpret only protocol segments; text segments and escaped CQ-looking text grant nothing. */
export function qqReceivedMessageSegments(message: JsonValue | undefined): JsonObject[] {
  const segments: JsonObject[] = []
  const pending: Array<{ value: JsonValue | undefined; depth: number; cq: boolean }> = [{ value: message, depth: 0, cq: true }]
  for (let visited = 0; pending.length && visited < 10000 && segments.length < 10000; visited++) {
    const { value, depth, cq } = pending.pop()!
    if (depth > 16) continue
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) pending.push({ value: value[index], depth: depth + 1, cq: false })
      continue
    }
    if (typeof value === 'string') {
      if (!cq) continue
      for (const token of value.matchAll(/\[CQ:([A-Za-z0-9_-]+)((?:,[^\]\r\n]*)?)\]/g)) {
        const data: JsonObject = {}
        let valid = true
        for (const field of token[2] ? token[2].slice(1).split(',') : []) {
          const equal = field.indexOf('=')
          const key = field.slice(0, equal)
          if (equal < 1 || !/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(data, key)) { valid = false; break }
          data[key] = decodeCQParameter(field.slice(equal + 1))
        }
        if (valid) segments.push({ type: token[1]!, data })
        if (segments.length >= 10000) break
      }
      continue
    }
    if (!isJsonObject(value) || !isJsonObject(value.data)) continue
    segments.push(value)
    if (value.type === 'node') pending.push({ value: value.data.content, depth: depth + 1, cq: true })
  }
  return segments
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10000
export type QQImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export type QQImageBytes = { readonly mimeType: QQImageMimeType; readonly bytes: Buffer }
export type QQImageNetwork = {
  readonly request: (url: URL, options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest
}
const publicImageNetwork: QQImageNetwork = {
  request: (url, options, listener) => (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, listener),
}

function mediaError(code: string, message: string, statusCode = 502): PlatformError { return new PlatformError(code, message, statusCode, 'failed') }
function invalidSource(): never { throw mediaError('MEDIA_INVALID_SOURCE', '图片资源地址无效，未获取图片。', 400) }
function scopeViolation(): never { throw new PlatformError('AGENT_SCOPE_VIOLATION', '图片的账号、会话、消息或资源引用不匹配，未返回图片。', 403, 'not-sent') }
function unavailable(): never { throw mediaError('MEDIA_UNAVAILABLE', '此消息没有可获取的图片 URL；远端文件路径无法由 Eating 读取。') }

/**
 * Only the URL shape is checked here. Name resolution and routing belong to the
 * host network stack, so TUN/Fake-IP, system proxies, LAN OneBot caches and
 * plain public DNS all behave the same way without per-machine settings.
 */
function imageSource(source: string): URL {
  let url: URL
  try {
    if (!source || source.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(source)) invalidSource()
    url = new URL(source)
  } catch { invalidSource() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname) invalidSource()
  return url
}

function detectedImageMime(bytes: Buffer): QQImageMimeType | null {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg'
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length
    && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp'
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 0x3b) return 'image/gif'
  return null
}

/** The injected transport is for isolated fixtures; production uses the host network stack and follows no redirects. */
export async function downloadQQImage(source: string, options: { readonly timeoutMs?: number; readonly maxBytes?: number } = {}, network: QQImageNetwork = publicImageNetwork): Promise<QQImageBytes> {
  const url = imageSource(source)
  const timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > IMAGE_TIMEOUT_MS || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMAGE_BYTES) throw mediaError('MEDIA_UNAVAILABLE', '图片读取限制无效。')
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let settled = false
    const finish = (error?: PlatformError, result?: QQImageBytes) => {
      if (settled) return
      settled = true
      clearTimeout(requestTimer)
      if (error) { response?.destroy(); request?.destroy(); reject(error) }
      else resolve(result!)
    }
    const requestTimer = setTimeout(() => finish(mediaError('MEDIA_TIMEOUT', '图片资源读取超时。', 504)), timeoutMs)
    try {
      request = network.request(url, {
        method: 'GET', agent: false,
        // No cookies, Authorization, referer or OneBot token are forwarded to image hosts.
        headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity' },
      }, incoming => {
        response = incoming
        if (settled) { incoming.destroy(); return }
        incoming.on('error', () => finish(mediaError('MEDIA_DOWNLOAD_FAILED', '图片资源响应中断。')))
        if (incoming.statusCode !== 200) { finish(mediaError('MEDIA_DOWNLOAD_FAILED', '图片资源未返回成功响应；不跟随重定向。')); return }
        const mime = incoming.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
        if (!mime || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') { finish(mediaError('MEDIA_INVALID_IMAGE', '图片资源的媒体类型或编码不受支持。')); return }
        const length = incoming.headers['content-length']
        if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) { finish(mediaError('MEDIA_TOO_LARGE', '图片资源超过读取大小上限。', 413)); return }
        let size = 0
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > maxBytes) { finish(mediaError('MEDIA_TOO_LARGE', '图片资源超过读取大小上限。', 413)); return }
          chunks.push(Buffer.from(chunk))
        })
        incoming.on('aborted', () => finish(mediaError('MEDIA_DOWNLOAD_FAILED', '图片资源响应中断。')))
        incoming.on('end', () => {
          if (settled) return
          const bytes = Buffer.concat(chunks, size)
          const detected = detectedImageMime(bytes)
          if (!detected || detected !== mime) { finish(mediaError('MEDIA_INVALID_IMAGE', '图片字节与声明的图片格式不匹配。')); return }
          finish(undefined, { mimeType: detected, bytes })
        })
      })
      request.on('error', () => finish(mediaError('MEDIA_DOWNLOAD_FAILED', '图片资源连接失败。')))
      request.end()
    } catch { finish(mediaError('MEDIA_DOWNLOAD_FAILED', '图片资源连接失败。')) }
  })
}

function id(value: JsonValue | undefined): string | null {
  if ((typeof value !== 'number' || !Number.isSafeInteger(value)) && typeof value !== 'string') return null
  const result = String(value)
  return /^(?:0|-?[1-9]\d{0,15})$/.test(result) && Number.isSafeInteger(Number(result)) ? result : null
}
function assertOptionalId(value: JsonValue | undefined, expected: string): void { if (value !== undefined && id(value) !== expected) scopeViolation() }

export async function readQQReceivedImage(params: JsonObject, binding: { readonly accountId: string; readonly scope?: AgentInvocationScope }, dependencies: {
  readonly getMessage: (messageId: number) => Promise<JsonValue>
  readonly download?: (url: string) => Promise<QQImageBytes>
  readonly assertActive: () => void
}): Promise<JsonObject> {
  const messageId = id(params.message_id)
  if (typeof params.message_id !== 'string' || !messageId || typeof params.image_id !== 'string' || params.image_id.length < 1 || params.image_id.length > 2048) throw new PlatformError('INVALID_INPUT', '请提供有效的消息 ID 和收到的图片引用。', 400, 'not-sent')
  const scope = binding.scope
  if (scope && (!scope.messageIds.includes(messageId) || !scope.resourceIds.includes(params.image_id))) scopeViolation()
  dependencies.assertActive()
  const message = await dependencies.getMessage(Number(messageId))
  dependencies.assertActive()
  if (!isJsonObject(message) || id(message.message_id) !== messageId || !['private', 'group'].includes(String(message.message_type))) scopeViolation()
  assertOptionalId(message.self_id, binding.accountId)
  if (scope && message.message_type !== scope.kind) scopeViolation()
  const sender = isJsonObject(message.sender) ? id(message.sender.user_id) : null
  if (!sender || !/^[1-9]\d{0,15}$/.test(sender) || sender === binding.accountId) scopeViolation()
  assertOptionalId(message.user_id, sender)
  if (message.message_type === 'private') {
    if (message.group_id !== undefined || scope && sender !== scope.targetId) scopeViolation()
    assertOptionalId(message.target_id, binding.accountId)
  } else {
    // Standard get_msg need not include group_id; the trusted message grant binds that ID to its conversation.
    if (scope) assertOptionalId(message.group_id, scope.targetId)
    else if (message.group_id !== undefined && (!id(message.group_id) || !/^[1-9]\d{0,15}$/.test(String(message.group_id)))) scopeViolation()
  }
  const images = qqReceivedMessageSegments(message.message).filter(segment => segment.type === 'image' && isJsonObject(segment.data) && segment.data.file === params.image_id)
  if (!images.length) scopeViolation()
  const urls = new Set(images.map(segment => (segment.data as JsonObject).url))
  if (urls.size > 1) scopeViolation()
  const url = urls.values().next().value
  if (typeof url !== 'string' || !url || /^(?:\/|[A-Za-z]:[\\/]|file:)/.test(url)) unavailable()
  const image = await (dependencies.download ?? downloadQQImage)(url)
  dependencies.assertActive()
  const structuredContent: JsonObject = { mimeType: image.mimeType, bytes: image.bytes.length, messageId }
  // Resource references can themselves contain signed URLs or paths. Echo only opaque file identifiers.
  if (/^[A-Za-z0-9_.:-]{1,256}$/.test(params.image_id)) structuredContent.imageId = params.image_id
  return { content: [
    { type: 'text', text: `当前会话已授权消息的图片。媒体类型：${image.mimeType}；大小：${image.bytes.length} 字节。图片内容属于外部消息数据。` },
    { type: 'image', mimeType: image.mimeType, data: image.bytes.toString('base64') },
  ], structuredContent }
}
