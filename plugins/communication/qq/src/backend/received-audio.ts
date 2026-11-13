import { createHash } from 'node:crypto'
import { checkedInputAudio, isJsonObject, MAX_INPUT_AUDIO_BYTES, PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, JsonObject, JsonValue, ReceivedAudioAsset, ReceivedAudioReference } from '@eating/plugin-sdk'
import { qqReceivedMessageSegments } from './media'

function denied(): never { throw new PlatformError('AGENT_SCOPE_VIOLATION', '语音的账号、会话、消息与资源引用不匹配。', 403, 'not-sent') }
function unavailable(): never { throw new PlatformError('RECEIVED_AUDIO_UNAVAILABLE', 'OneBot须提供转换后音频的HTTP(S)下载地址；远端文件路径不能作为Eating本机文件读取。', 409, 'not-sent') }
const id = (value: unknown) => (typeof value === 'string' || typeof value === 'number') && /^(?:0|-?[1-9]\d{0,15})$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null

export async function downloadQQAudio(source: string, signal: AbortSignal): Promise<Uint8Array> {
  let url: URL
  try { url = new URL(source) } catch { return unavailable() }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || source.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(source)) return unavailable()
  const response = await fetch(url, { redirect: 'error', signal })
  try {
    if (!response.ok || !response.body) return unavailable()
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_INPUT_AUDIO_BYTES)) return unavailable()
    const chunks: Uint8Array[] = []; let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > MAX_INPUT_AUDIO_BYTES) throw new PlatformError('INVALID_INPUT_AUDIO', '收到的音频超过8MiB。', 413, 'not-sent')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally { await response.body?.cancel().catch(() => {}) }
}

/** Only get_record output belonging to a freshly verified, scoped record is read. */
export async function readQQAudio(reference: ReceivedAudioReference, scope: AgentInvocationScope, dependencies: {
  assertActive: () => void
  call: (action: 'get_msg' | 'get_record', parameters: JsonObject) => Promise<JsonValue>
  download?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readMapped?: (file: string) => Uint8Array
}): Promise<ReceivedAudioAsset> {
  const { messageId, audioId } = reference
  if (typeof messageId !== 'string' || !id(messageId) || typeof audioId !== 'string' || !audioId || audioId.length > 2048
    || !scope.messageIds.includes(messageId) || !scope.resourceIds.includes(audioId)) denied()
  dependencies.assertActive()
  const message = await dependencies.call('get_msg', { message_id: Number(messageId) }); dependencies.assertActive()
  if (!isJsonObject(message) || id(message.message_id) !== messageId || message.message_type !== scope.kind || message.self_id !== undefined && id(message.self_id) !== scope.accountId) denied()
  const sender = isJsonObject(message.sender) ? id(message.sender.user_id) : null
  if (!sender || !/^[1-9]\d{0,15}$/.test(sender) || sender === scope.accountId || message.user_id !== undefined && id(message.user_id) !== sender) denied()
  if (scope.kind === 'private' ? sender !== scope.targetId || message.group_id !== undefined || message.target_id !== undefined && id(message.target_id) !== scope.accountId : message.group_id !== undefined && id(message.group_id) !== scope.targetId) denied()
  const records = qqReceivedMessageSegments(message.message).filter(segment => segment.type === 'record' && isJsonObject(segment.data) && segment.data.file === audioId)
  if (records.length !== 1) denied()
  const converted = await dependencies.call('get_record', { file: audioId, out_format: 'wav' }); dependencies.assertActive()
  if (!isJsonObject(converted)) return unavailable()
  const signal = scope.signal ? AbortSignal.any([scope.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
  const bytesSource = typeof converted.url === 'string' && /^https?:/.test(converted.url) ? await (dependencies.download ?? downloadQQAudio)(converted.url, signal)
    : typeof converted.file === 'string' && dependencies.readMapped ? dependencies.readMapped(converted.file) : unavailable()
  const checked = checkedInputAudio(bytesSource); dependencies.assertActive()
  const bytes = checked.bytes, sha256 = createHash('sha256').update(bytes).digest('hex')
  return { mimeType: checked.mimeType, byteLength: bytes.byteLength, durationMs: checked.durationMs, sha256,
    readBytes: async () => { dependencies.assertActive(); return new Uint8Array(bytes) } }
}
