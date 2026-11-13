import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { PrivateConfiguration } from './config'
export interface TranscriptionResult { text: string; durationMs: number; providerRequestId: string }
/** Explicit protocol selection; no model guessing, retries or alternate endpoints. */
export async function transcribe(config: PrivateConfiguration, bytes: Uint8Array, mime: 'audio/wav' | 'audio/ogg', signal: AbortSignal, authorize: () => void): Promise<TranscriptionResult> {
  if (config.provider.protocol !== 'deepseek-asr') throw new PlatformError('ASR_UNSUPPORTED_PROTOCOL', '识别协议不受支持。', 400, 'not-sent')
  const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, config.timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  let submitted = false
  try {
    authorize(); if (signal.aborted) throw new PlatformError('ASR_CANCELLED', '识别已取消，未提交。', 409, 'not-sent')
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), mime === 'audio/wav' ? 'speech.wav' : 'speech.ogg')
    authorize(); submitted = true
    const response = await fetch(config.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey }, body: form, redirect: 'error', signal: controller.signal })
    try {
      if (!response.ok) throw new PlatformError(response.status === 401 || response.status === 403 ? 'ASR_AUTH_FAILED' : 'ASR_PROVIDER_REJECTED', '识别服务拒绝请求，未自动重试。', 502, 'failed')
      if (!response.body) throw new Error('Empty response')
      const chunks: Uint8Array[] = []; let size = 0
      for await (const part of response.body) { size += part.byteLength; if (size > 1024 * 1024) throw new Error('Oversized response'); chunks.push(part) }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!isJsonObject(result) || Object.keys(result).some(k => !['request_id', 'text', 'duration_ms'].includes(k)) || typeof result.request_id !== 'string' || !result.request_id || result.request_id.length > 256
        || typeof result.text !== 'string' || result.text.length > 32000 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(result.text) || !Number.isSafeInteger(result.duration_ms) || Number(result.duration_ms) < 0 || Number(result.duration_ms) > 120000) throw new Error('Invalid response')
      return { text: result.text, durationMs: Number(result.duration_ms), providerRequestId: result.request_id }
    } finally { await response.body?.cancel().catch(() => {}) }
  } catch (error) {
    if (error instanceof PlatformError) throw error
    throw new PlatformError(controller.signal.aborted ? 'ASR_CANCELLED' : 'ASR_CONNECTION_FAILED', '识别结果待核对，请查询原任务，不要换号重试。', 502, submitted ? 'unknown' : 'not-sent')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
