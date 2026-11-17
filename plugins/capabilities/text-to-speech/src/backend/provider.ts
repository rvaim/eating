import { performance } from 'node:perf_hooks'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { PrivateConfiguration, OpenAISpeechConfiguration } from './config'
import { synthesizeOpenAI } from './openai'
import { synthesizeDeepSeek } from './deepseek'

const MAX_PROBE_MS = 15_000
const MAX_PROBE_BYTES = 1024 * 1024

export function speechProbeUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) {
    throw new PlatformError('SPEECH_INVALID_CONFIGURATION', '请检查语音服务地址格式。', 400, 'not-sent')
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/realtime')) url.pathname = path.slice(0, -'/realtime'.length) + '/models'
  else if (path.endsWith('/tools/tts')) url.pathname = path.slice(0, -'/tools/tts'.length) + '/models'
  else if (path.endsWith('/v1')) url.pathname = path + '/models'
  else url.pathname = '/v1/models'
  return url
}

export async function testSpeechConnection(configuration: PrivateConfiguration, signal?: AbortSignal): Promise<{ ok: true; latencyMs: number }> {
  if (!configuration.apiKey.trim()) throw new PlatformError('SPEECH_NOT_READY', '请先保存 API Key 再测试连接。', 409, 'not-sent')
  if (signal?.aborted) throw new PlatformError('SPEECH_CANCELLED', '连接测试已取消。', 409, 'not-sent')
  const url = speechProbeUrl(configuration.endpoint)
  const timeout = new AbortController(), combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  let expired = false
  const timer = setTimeout(() => { expired = true; timeout.abort() }, Math.min(configuration.timeoutMs, MAX_PROBE_MS))
  timer.unref?.()
  const started = performance.now()
  let responseBody: ReadableStream<Uint8Array> | null | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: combined,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + configuration.apiKey },
    })
    responseBody = response.body
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new PlatformError('SPEECH_AUTH_FAILED', '语音服务认证失败，请检查已保存的 API Key。', 502, 'not-sent')
      if (response.status === 429) throw new PlatformError('SPEECH_RATE_LIMITED', '语音服务请求过于频繁或额度不足，请稍后重试。', 503, 'not-sent')
      throw new PlatformError('SPEECH_CONNECTION_FAILED', '无法确认语音服务连接，请检查服务地址和状态。', 502, 'not-sent')
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PROBE_BYTES)) {
      throw new PlatformError('SPEECH_CONNECTION_FAILED', '语音服务响应格式无效。', 502, 'not-sent')
    }
    if (!response.body) throw new PlatformError('SPEECH_CONNECTION_FAILED', '语音服务返回空响应。', 502, 'not-sent')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_PROBE_BYTES) throw new PlatformError('SPEECH_CONNECTION_FAILED', '语音服务响应体积过大。', 502, 'not-sent')
      chunks.push(value)
    }
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) }
    catch { throw new PlatformError('SPEECH_CONNECTION_FAILED', '语音服务响应不是有效的 JSON。', 502, 'not-sent') }
    if (!isJsonObject(parsed) || Object.hasOwn(parsed, 'error') || !Array.isArray(parsed.data)) {
      if (isJsonObject(parsed) && isJsonObject(parsed.error)) {
        const code = parsed.error.code ?? parsed.error.type
        if (code === 'invalid_api_key' || code === 'authentication_error') throw new PlatformError('SPEECH_AUTH_FAILED', '语音服务认证失败，请检查已保存的 API Key。', 502, 'not-sent')
        if (code === 'rate_limit_exceeded' || code === 'rate_limit_error' || code === 'insufficient_quota') throw new PlatformError('SPEECH_RATE_LIMITED', '语音服务请求过于频繁或额度不足，请稍后重试。', 503, 'not-sent')
      }
      throw new PlatformError('SPEECH_CONNECTION_FAILED', '语音服务响应格式无效。', 502, 'not-sent')
    }
    return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
  } catch (error) {
    if (error instanceof PlatformError) throw error
    if (signal?.aborted) throw new PlatformError('SPEECH_CANCELLED', '连接测试已取消。', 409, 'not-sent')
    if (expired) throw new PlatformError('SPEECH_TIMEOUT', '连接测试超时，请检查服务地址或网络。', 504, 'not-sent')
    throw new PlatformError('SPEECH_CONNECTION_FAILED', '无法连接语音服务，请检查服务地址和网络状态。', 502, 'not-sent')
  } finally {
    clearTimeout(timer)
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    else await responseBody?.cancel().catch(() => {})
    timeout.abort()
  }
}

export async function synthesize(configuration: PrivateConfiguration, input: string, delivery: string, signal: AbortSignal, authorize: () => void) {
  if (configuration.provider.protocol === 'openai-realtime') return { bytes: await synthesizeOpenAI(configuration as OpenAISpeechConfiguration, input, delivery, signal, authorize), verification: 'provider-transcript' as const }
  if (delivery) throw new PlatformError('SPEECH_UNSUPPORTED_OPTION', 'DeepSeek当前不支持自定义语气；未提交合成。', 400, 'not-sent')
  return { bytes: await synthesizeDeepSeek(configuration, input, signal, authorize), verification: 'provider-completion' as const }
}
