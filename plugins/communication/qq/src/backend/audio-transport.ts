import { createHash } from 'node:crypto'
import { checkedAudioBytes, isJsonObject, parseAudioAssetUri, PlatformError } from '@eating/plugin-sdk'
import type { AudioAssetLease, CapabilityInvocationScope, JsonObject, JsonValue, PluginResourceServices } from '@eating/plugin-sdk'

/** Resolves one authorized voice note; audio is sent alone as required by QQ. */
export async function resolveQQAudioAsset(params: JsonObject, resources: PluginResourceServices | undefined, scope?: CapabilityInvocationScope): Promise<{ params: JsonObject; audioBase64Bytes: number; lease?: AudioAssetLease }> {
  const references: string[] = []
  const inspect = (value: JsonValue | undefined) => {
    if (Array.isArray(value)) { value.forEach(inspect); return }
    if (!isJsonObject(value) || !isJsonObject(value.data)) return
    if (typeof value.data.file === 'string' && value.data.file.startsWith('eating-audio:')) {
      if (value.type !== 'record') throw new PlatformError('INVALID_AUDIO_MESSAGE', '语音资源必须放入 record 消息段。', 400, 'not-sent')
      references.push(value.data.file)
    }
    if (value.type === 'node') inspect(value.data.content)
  }
  inspect(params.message)
  if (isJsonObject(params.operation)) inspect(params.operation.reply)
  if (!references.length) return { params, audioBase64Bytes: 0 }
  const message = Array.isArray(params.message) && params.message.length === 1 ? params.message[0] : params.message
  if (references.length !== 1 || !isJsonObject(message) || message.type !== 'record' || !isJsonObject(message.data) || message.data.file !== references[0]) throw new PlatformError('INVALID_AUDIO_MESSAGE', '每次只发送一条独立语音，不与文字或图片合并。', 400, 'not-sent')
  if (!resources) throw new PlatformError('MEDIA_RESOURCE_SERVICE_UNAVAILABLE', '宿主未提供语音资源服务。', 503, 'not-sent')
  const reference = parseAudioAssetUri(references[0]!)!
  const lease = await resources.getAudioAsset(reference, scope), bytes = checkedAudioBytes(await lease.readBytes(), lease.mimeType)
  if (bytes.byteLength !== lease.byteLength || createHash('sha256').update(bytes).digest('hex') !== lease.sha256) throw new PlatformError('INVALID_AUDIO_RESOURCE', '语音资源内容与摘要不匹配。', 502, 'not-sent')
  await lease.assertActive()
  const encoded = Buffer.from(bytes).toString('base64'), segment = { ...message, data: { ...message.data, file: 'base64://' + encoded } }
  lease.assertCurrent()
  return { params: { ...params, message: Array.isArray(params.message) ? [segment] : segment }, audioBase64Bytes: encoded.length, lease }
}
