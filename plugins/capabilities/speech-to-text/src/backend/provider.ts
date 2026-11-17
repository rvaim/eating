import { performance } from 'node:perf_hooks'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { PrivateConfiguration } from './config'
export interface TranscriptionResult { text: string; durationMs: number; providerRequestId: string }

const MAX_PROBE_MS = 15_000
const MAX_PROBE_BYTES = 1024 * 1024

export function recognitionProbeUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) {
    throw new PlatformError('ASR_INVALID_CONFIGURATION', '请检查识别服务地址格式。', 400, 'not-sent')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/tools/asr')) url.pathname = path.slice(0, -'/tools/asr'.length) + '/models'
  else if (path.endsWith('/audio/transcriptions')) url.pathname = path.slice(0, -'/audio/transcriptions'.length) + '/models'
  else if (path.endsWith('/v1')) url.pathname = path + '/models'
  else url.pathname = '/v1/models'
  return url
}

export async function testRecognitionConnection(config: PrivateConfiguration, signal?: AbortSignal): Promise<{ ok: true; latencyMs: number }> {
  if (config.provider.protocol !== 'deepseek-asr') throw new PlatformError('ASR_UNSUPPORTED_PROTOCOL', '识别协议不受支持。', 400, 'not-sent')
  if (!config.apiKey.trim()) throw new PlatformError('ASR_NOT_READY', '请先保存 API Key 再测试连接。', 409, 'not-sent')
  if (signal?.aborted) throw new PlatformError('ASR_CANCELLED', '连接测试已取消。', 409, 'not-sent')
  const url = recognitionProbeUrl(config.endpoint)
  const timeout = new AbortController(), combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  let expired = false
  const timer = setTimeout(() => { expired = true; timeout.abort() }, Math.min(config.timeoutMs, MAX_PROBE_MS))
  timer.unref?.()
  const started = performance.now()
  let responseBody: ReadableStream<Uint8Array> | null | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: combined,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + config.apiKey },
    })
    responseBody = response.body
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new PlatformError('ASR_AUTH_FAILED', '识别服务认证失败，请核对已保存的 API Key。', 502, 'not-sent')
      if (response.status === 429) throw new PlatformError('ASR_RATE_LIMITED', '识别服务请求过于频繁或额度不足，请稍后重试。', 503, 'not-sent')
      throw new PlatformError('ASR_CONNECTION_FAILED', '无法确认识别服务连接，请检查服务地址和状态。', 502, 'not-sent')
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PROBE_BYTES)) {
      throw new PlatformError('ASR_CONNECTION_FAILED', '识别服务响应格式无效。', 502, 'not-sent')
    }
    if (!response.body) throw new PlatformError('ASR_CONNECTION_FAILED', '识别服务返回空响应。', 502, 'not-sent')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_PROBE_BYTES) throw new PlatformError('ASR_CONNECTION_FAILED', '识别服务响应体积过大。', 502, 'not-sent')
      chunks.push(value)
    }
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) }
    catch { throw new PlatformError('ASR_CONNECTION_FAILED', '识别服务响应不是有效的 JSON。', 502, 'not-sent') }
    if (!isJsonObject(parsed) || Object.hasOwn(parsed, 'error') || !Array.isArray(parsed.data)) {
      if (isJsonObject(parsed) && isJsonObject(parsed.error)) {
        const code = parsed.error.code ?? parsed.error.type
        if (code === 'invalid_api_key' || code === 'authentication_error') throw new PlatformError('ASR_AUTH_FAILED', '识别服务认证失败，请核对已保存的 API Key。', 502, 'not-sent')
        if (code === 'rate_limit_exceeded' || code === 'rate_limit_error' || code === 'insufficient_quota') throw new PlatformError('ASR_RATE_LIMITED', '识别服务请求过于频繁或额度不足，请稍后重试。', 503, 'not-sent')
      }
      throw new PlatformError('ASR_CONNECTION_FAILED', '识别服务响应格式无效。', 502, 'not-sent')
    }
    return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
  } catch (error) {
    if (error instanceof PlatformError) throw error
    if (signal?.aborted) throw new PlatformError('ASR_CANCELLED', '连接测试已取消。', 409, 'not-sent')
    if (expired) throw new PlatformError('ASR_TIMEOUT', '连接测试超时，请检查服务地址或网络。', 504, 'not-sent')
    throw new PlatformError('ASR_CONNECTION_FAILED', '无法连接识别服务，请检查服务地址和网络状态。', 502, 'not-sent')
  } finally {
    clearTimeout(timer)
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    else await responseBody?.cancel().catch(() => {})
    timeout.abort()
  }
}

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
