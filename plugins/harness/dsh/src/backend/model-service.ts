import { performance } from 'node:perf_hooks'
import { PlatformError } from '@eating/plugin-sdk'
import type { DshConfiguration } from './config'

type ModelConfiguration = Pick<DshConfiguration, 'endpoint' | 'apiKey' | 'timeoutMs'>
type ModelOperation = 'list' | 'test'
interface Model { readonly id: string; readonly name?: string }

const MAX_REQUEST_MS = 15_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_MODELS = 2000
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidResponse(): PlatformError {
  return new PlatformError('MODEL_RESPONSE_INVALID', '模型服务返回的内容不符合 OpenAI 兼容接口格式。', 502, 'failed')
}

function requestUrl(configuration: ModelConfiguration, path: string): URL {
  if (!configuration.endpoint.trim()) throw new PlatformError('NOT_CONFIGURED', '请先保存 OpenAI 兼容基础地址。', 409, 'not-sent')
  let url: URL
  try { url = new URL(configuration.endpoint) }
  catch { throw new PlatformError('INVALID_CONFIGURATION', '请填写有效的 OpenAI 兼容 HTTP 或 HTTPS 基础地址。', 400, 'not-sent') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || /^[a-z]+:\/\/[^/?#]*@/i.test(url.href) || url.search || url.hash || /[?#]/.test(configuration.endpoint) || configuration.endpoint.length > 2048) {
    throw new PlatformError('INVALID_CONFIGURATION', '模型地址仅支持 HTTP/HTTPS，且不能包含账号、密码、查询参数或片段。', 400, 'not-sent')
  }
  if (!Number.isSafeInteger(configuration.timeoutMs) || configuration.timeoutMs < 1000 || configuration.timeoutMs > 120_000 || configuration.apiKey.length > 4096 || /[\r\n\0]/.test(configuration.apiKey)) {
    throw new PlatformError('INVALID_CONFIGURATION', '模型连接配置无效，请检查请求超时与 API 密钥格式。', 400, 'not-sent')
  }
  // A leading slash in new URL(path, base) would silently discard a custom base path.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`
  return url
}

function statusFailure(status: number, operation: ModelOperation): PlatformError {
  if (status === 401 || status === 403) return new PlatformError('MODEL_AUTH_FAILED', '模型服务认证失败，请检查已保存的 API 密钥与访问权限。', 502, 'failed')
  if (status === 429) return new PlatformError('MODEL_RATE_LIMITED', '模型服务请求过于频繁或额度不足，请稍后重试并检查账户额度。', 503, 'failed')
  if (operation === 'list' && [404, 405, 501].includes(status)) return new PlatformError('MODEL_LIST_UNSUPPORTED', '此基础地址未提供可用的模型列表接口，请手动填写模型名称。', 502, 'failed')
  return operation === 'list'
    ? new PlatformError('MODEL_LIST_FAILED', '获取模型列表失败，请检查已保存的基础地址和提供商服务状态。', 502, 'failed')
    : new PlatformError('MODEL_CONNECTION_FAILED', '所选模型的实际请求失败，请检查模型名称、访问权限与提供商服务状态。', 502, 'failed')
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw invalidResponse()
  if (!response.body) throw invalidResponse()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse()
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown }
  catch { throw invalidResponse() }
}

async function request(configuration: ModelConfiguration, operation: ModelOperation, signal?: AbortSignal, payload?: object): Promise<unknown> {
  const url = requestUrl(configuration, operation === 'list' ? 'models' : 'chat/completions')
  if (signal?.aborted) throw new PlatformError('MODEL_REQUEST_ABORTED', '模型请求已取消。', 503, 'not-sent')
  const timeout = new AbortController()
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  let expired = false
  const timer = setTimeout(() => { expired = true; timeout.abort() }, Math.min(configuration.timeoutMs, MAX_REQUEST_MS))
  timer.unref()
  try {
    const response = await fetch(url, {
      method: operation === 'list' ? 'GET' : 'POST', redirect: 'error', signal: combined,
      headers: { Accept: 'application/json', ...(configuration.apiKey.trim() ? { Authorization: `Bearer ${configuration.apiKey}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    // HTTP error bodies and redirect destinations are never returned to the caller.
    if (!response.ok) throw statusFailure(response.status, operation)
    const value = await boundedJson(response)
    if (object(value) && Object.hasOwn(value, 'error')) {
      const code = object(value.error) ? value.error.code ?? value.error.type : undefined
      if (code === 'invalid_api_key' || code === 'authentication_error') throw statusFailure(401, operation)
      if (code === 'rate_limit_exceeded' || code === 'rate_limit_error' || code === 'insufficient_quota') throw statusFailure(429, operation)
      throw statusFailure(500, operation)
    }
    return value
  } catch (error) {
    if (signal?.aborted) throw new PlatformError('MODEL_REQUEST_ABORTED', '模型请求已取消。', 503, 'failed')
    if (expired) throw new PlatformError('MODEL_REQUEST_TIMEOUT', '模型请求超时，请检查服务状态或稍后重试。', 503, 'failed')
    if (error instanceof PlatformError) throw error
    // Native fetch errors can include URLs, TLS details or caller-provided abort reasons.
    throw new PlatformError('MODEL_REQUEST_FAILED', '无法连接模型服务，请检查基础地址、网络与服务状态。', 503, 'failed')
  } finally {
    clearTimeout(timer)
    // Also terminate unread/oversized streams instead of draining an untrusted body.
    timeout.abort()
  }
}

/** Queries only the saved provider configuration; it never changes config or runtime state. */
export async function listModels(configuration: Pick<DshConfiguration, 'endpoint' | 'apiKey' | 'timeoutMs'>, signal?: AbortSignal): Promise<{ models: readonly { id: string; name?: string }[] }> {
  const value = await request(configuration, 'list', signal)
  if (!object(value) || !Array.isArray(value.data)) throw invalidResponse()
  const models: Model[] = []
  const seen = new Set<string>()
  const secret = configuration.apiKey.trim()
  for (const entry of value.data) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || entry.id !== entry.id.trim() || entry.id.length > 160 || controlCharacters.test(entry.id) || seen.has(entry.id) || secret && entry.id.includes(secret)) continue
    seen.add(entry.id)
    const name = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 256 && !controlCharacters.test(entry.name) && !(secret && entry.name.includes(secret)) ? entry.name : undefined
    models.push({ id: entry.id, ...(name ? { name } : {}) })
    if (models.length === MAX_MODELS) break
  }
  if (!models.length) throw invalidResponse()
  return { models }
}

function validChoice(value: unknown): boolean {
  if (!object(value) || !object(value.message) || value.message.role !== 'assistant') return false
  const message = value.message
  if (typeof message.content === 'string' || message.content === null) return true
  if (Object.hasOwn(message, 'content')) return false
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && message.tool_calls.every(call => object(call) && typeof call.id === 'string' && call.id.length > 0 && call.type === 'function' && object(call.function) && typeof call.function.name === 'string' && call.function.name.length > 0 && typeof call.function.arguments === 'string')
}

/** A real, minimal provider request; success does not imply the DSH runtime can start. */
export async function testModelConnection(configuration: Pick<DshConfiguration, 'endpoint' | 'apiKey' | 'timeoutMs' | 'model'>, signal?: AbortSignal): Promise<{ ok: true; model: string; latencyMs: number }> {
  if (!configuration.model.trim()) throw new PlatformError('NOT_CONFIGURED', '请先保存要测试的模型名称。', 409, 'not-sent')
  if (configuration.model.length > 160 || controlCharacters.test(configuration.model)) throw new PlatformError('INVALID_CONFIGURATION', '模型名称需为 1 至 160 个有效字符。', 400, 'not-sent')
  const started = performance.now()
  const value = await request(configuration, 'test', signal, { model: configuration.model, messages: [{ role: 'user', content: 'Ping.' }], max_tokens: 1, stream: false })
  if (!object(value) || !Array.isArray(value.choices) || !value.choices.length || !value.choices.every(validChoice)) throw invalidResponse()
  return { ok: true, model: configuration.model, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
}
