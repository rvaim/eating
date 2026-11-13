import { isJsonObject, parseImageAssetUri, PlatformError } from '@eating/plugin-sdk'
import type { JsonValue } from '@eating/plugin-sdk'

const internalImage = /eating-asset:/i

function invalid(): never {
  throw new PlatformError('QQ_IMAGE_MESSAGE_REQUIRED', '图片消息格式错误，本次未发送。message 必须直接传 image 消息段对象或数组，例如 {"type":"image","data":{"file":"工具返回的原图片引用"}}；不能把图片 JSON 或内部图片引用放进字符串／text 段。复用已有图片，不要重新生图；本次拒绝未登记发送动作，修正后可使用本次 request_id。', 400, 'not-sent')
}

/** Recognize serialized image segments only to reject them, never to repair or send them. */
function serializedImage(value: string): boolean {
  if (!/^[\s]*[\[{]/.test(value)) return false
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return false }
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const item = pending.pop()
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue }
    if (!isJsonObject(item) || !isJsonObject(item.data)) continue
    if (item.type === 'image' && typeof item.data.file === 'string') return true
    if (item.type === 'node') pending.push(item.data.content)
  }
  return false
}

/** Called after the bounded OneBot schema check and before the action ledger or transport. */
export function assertQQImageMessage(message: JsonValue | undefined): void {
  if (typeof message === 'string') {
    if (internalImage.test(message) || serializedImage(message)) invalid()
    return
  }
  if (Array.isArray(message)) { for (const segment of message) assertQQImageMessage(segment); return }
  if (!isJsonObject(message) || !isJsonObject(message.data)) return
  for (const [key, value] of Object.entries(message.data)) {
    if (message.type === 'node' && key === 'content' || message.type === 'text' && key === 'text') {
      assertQQImageMessage(value)
    } else if (typeof value === 'string' && internalImage.test(value)) {
      if (message.type !== 'image' || key !== 'file' || !parseImageAssetUri(value)) invalid()
    }
  }
}
