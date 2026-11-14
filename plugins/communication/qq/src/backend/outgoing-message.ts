import { isJsonObject, parseAudioAssetUri, parseImageAssetUri, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { oneBotMessageDefinitions } from '../message-schema'

const internalImage = /eating-asset:/i
const internalAudio = /eating-audio:/i
const segmentSchemas = (oneBotMessageDefinitions.oneBotSegment as JsonObject).oneOf as JsonObject[]
const segmentTypes = new Set(segmentSchemas.map(schema => ((schema.properties as JsonObject).type as JsonObject).const))

function invalid(field: string, reason: string): never {
  throw new PlatformError('QQ_MESSAGE_FORMAT_INVALID', `${field}：${reason}。本次未发送，未登记发送动作。普通文字直接传正文，例如 {"message":"你好"}；消息段直接传对象或数组，不要 JSON.stringify，也不要放进 text 段。图片使用 image.data.file；发送已有语音请改用顶层 audio_ref，直接复制 speech_get 返回的 audio_ref，例如 {"audio_ref":"speech_get 返回的原引用"}，不要同时提供 message 或 auto_escape；后台会构造独立 record.data.file 并读取真实音频。内部图片／语音引用不能写进文字或 CQ 码，不要猜测本机路径。复用已有图片／语音，不重新生成；本次 not-sent 修正格式后可复用本次 request_id，已成功或 unknown 的动作不得重发。`, 400, 'not-sent')
}

function validAssetReference(value: string, parse: typeof parseImageAssetUri): boolean {
  try { return parse(value) !== null } catch (error) {
    if (error instanceof PlatformError && error.code === 'INVALID_ASSET_REFERENCE') return false
    throw error
  }
}

/** Inspect serialized segments only to reject them. Never decode them into an outgoing message. */
function serializedSegment(value: string): boolean {
  let parsed: unknown = value
  while (typeof parsed === 'string') {
    if (!/^[\s]*[\[{\"]/.test(parsed)) return false
    try { parsed = JSON.parse(parsed) } catch { return false }
  }
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const item = pending.pop()
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue }
    // Parsed JSON is bounded by the input string limit, but can be arbitrarily deep.
    // Do not recursively validate an untrusted serialized tree just to recognize its shape.
    if (item === null || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    if (typeof candidate.type === 'string' && segmentTypes.has(candidate.type) && Object.hasOwn(candidate, 'data')) return true
  }
  return false
}

/** All outgoing message entry points call this before the action ledger and resource reads. */
export function assertQQMessage(message: JsonValue | undefined, field = 'message'): void {
  let audioReferences = 0
  const inspect = (value: JsonValue | undefined, location: string): void => {
    if (typeof value === 'string') {
      if (internalImage.test(value) || internalAudio.test(value)) invalid(location, '内部媒体引用被放进了字符串，未进入受控媒体解析')
      if (serializedSegment(value)) invalid(location, '收到的是序列化消息段字符串，而非真正的消息段对象／数组')
      return
    }
    if (Array.isArray(value)) { value.forEach((segment, index) => inspect(segment, `${location}[${index}]`)); return }
    if (!isJsonObject(value) || !isJsonObject(value.data)) return
    for (const [key, entry] of Object.entries(value.data)) {
      const child = `${location}.data.${key}`
      if (value.type === 'node' && key === 'content' || value.type === 'text' && key === 'text') {
        inspect(entry, child)
      } else if (typeof entry === 'string') {
        if (internalImage.test(entry) && (value.type !== 'image' || key !== 'file' || !validAssetReference(entry, parseImageAssetUri))) invalid(child, '内部图片引用必须完整放在 image.data.file')
        if (internalAudio.test(entry)) {
          if (value.type !== 'record' || key !== 'file' || !validAssetReference(entry, parseAudioAssetUri)) invalid(child, '内部语音引用必须完整放在 record.data.file')
          audioReferences++
        }
      }
    }
  }
  inspect(message, field)
  if (audioReferences) {
    const single = Array.isArray(message) && message.length === 1 ? message[0] : message
    if (field !== 'message' || audioReferences !== 1 || !isJsonObject(single) || single.type !== 'record') {
      invalid(field, '内部语音必须通过发送工具的 message 单独发送一条 record，不与文字／图片混合，不使用快速操作 reply')
    }
  }
}
