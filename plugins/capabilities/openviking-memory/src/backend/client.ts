import { OpenVikingClient, OpenVikingError } from '@openviking/sdk'
import type { Message } from '@openviking/sdk'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { MemoryHit, MemoryScope } from '@eating/plugin-sdk'
import type { PrivateConfiguration } from './config'
import { allowedLocation, globalRoot, memoryLocation, peerId, peerRoot } from './scopes'
import { checkSignal, error, LIMITS, schema } from './validation'

function httpError(status: number): PlatformError {
  return error(status === 401 ? 'MEMORY_AUTH_FAILED' : status === 403 ? 'MEMORY_ACCESS_DENIED' : status === 404 ? 'MEMORY_NOT_FOUND' : status === 429 ? 'MEMORY_RATE_LIMITED' : status >= 500 ? 'MEMORY_SERVER_ERROR' : 'MEMORY_REQUEST_FAILED', status >= 400 && status < 600 ? status : 502, 'failed')
}
/** SDK methods do not carry a signal; one client is bound to an operation and its lifetime. */
export class MemoryClient {
  readonly sdk: OpenVikingClient
  private readonly lifetime: AbortSignal
  private readonly headers: Headers
  private readonly baseFetch: typeof fetch
  constructor(readonly configuration: PrivateConfiguration, lifetime: AbortSignal, readonly peer = 'self', signal?: AbortSignal, actor = true) {
    this.lifetime = signal ? AbortSignal.any([lifetime, signal]) : lifetime
    this.baseFetch = globalThis.fetch.bind(globalThis)
    this.headers = new Headers()
    if (configuration.apiKey) this.headers.set('X-API-Key', configuration.apiKey)
    if (configuration.account) this.headers.set('X-OpenViking-Account', configuration.account)
    this.headers.set('X-OpenViking-User', configuration.user)
    if (actor) this.headers.set('X-OpenViking-Actor-Peer', peer)
    this.sdk = new OpenVikingClient({ baseUrl: configuration.endpoint, account: configuration.account || undefined, user: configuration.user, apiKey: configuration.apiKey || undefined, actorPeerId: actor ? peer : undefined, timeout: configuration.timeoutMs, fetch: this.fetch })
  }
  readonly fetch: typeof fetch = async (input, init) => {
    checkSignal(this.lifetime)
    const incoming = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const controller = new AbortController(), signals = [this.lifetime, ...(incoming ? [incoming] : []), controller.signal]
    const signal = AbortSignal.any(signals), timer = setTimeout(() => controller.abort(), this.configuration.timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, responseBody: ReadableStream<Uint8Array> | null | undefined
    try {
      const url = new URL(input instanceof Request ? input.url : String(input)), base = new URL(this.configuration.endpoint)
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/+$/, '') + '/')) throw error('MEMORY_REQUEST_FAILED', 502)
      const response = await this.baseFetch(input, { ...init, signal, redirect: 'manual' }); responseBody = response.body
      if (response.status >= 300 && response.status < 400) throw error('MEMORY_REDIRECT_DENIED', 502, 'failed')
      if (!response.ok) throw httpError(response.status)
      const declared = Number(response.headers.get('content-length'))
      if (declared > LIMITS.responseBytes) throw error('MEMORY_RESPONSE_TOO_LARGE', 502, 'failed')
      reader = response.body?.getReader()
      const chunks: Uint8Array[] = []; let bytes = 0
      if (reader) for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > LIMITS.responseBytes) throw error('MEMORY_RESPONSE_TOO_LARGE', 502, 'failed')
        chunks.push(chunk.value)
      }
      checkSignal(this.lifetime)
      let value: unknown
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'failed') }
      schema(isJsonObject(value) && value.status === 'ok' && Object.hasOwn(value, 'result'))
      if (value.error) throw error('MEMORY_REQUEST_FAILED', 502, 'failed')
      // SDK receives a validated envelope; never forward provider error bodies into SDK errors.
      return new Response(JSON.stringify(value), { status: response.status, headers: { 'content-type': 'application/json' } })
    } catch (cause) {
      if (this.lifetime.aborted) throw error('MEMORY_CANCELLED', 409)
      if (signal.aborted) throw error('MEMORY_TIMEOUT', 504, 'unknown')
      if (cause instanceof PlatformError) throw cause
      throw error('MEMORY_NETWORK_ERROR', 502, 'unknown')
    } finally {
      clearTimeout(timer)
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
      else await responseBody?.cancel().catch(() => {})
    }
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    try { checkSignal(this.lifetime); const result = await action(); checkSignal(this.lifetime); return result }
    catch (cause) {
      if (this.lifetime.aborted) throw error('MEMORY_CANCELLED', 409)
      // SDK wraps non-SDK errors. Our transport puts only fixed safe codes in causes.
      let current: unknown = cause
      for (let n = 0; n < 4 && current instanceof Error; n++) {
        if (current instanceof PlatformError) throw current
        if (current instanceof OpenVikingError && current.statusCode) throw httpError(current.statusCode)
        current = current.cause
      }
      throw error('MEMORY_REQUEST_FAILED', 502, 'unknown')
    }
  }
  async identity(): Promise<void> {
    const response = await this.fetch(this.configuration.endpoint + '/api/v1/system/status', { headers: this.headers, method: 'GET' })
    const envelope: unknown = await response.json()
    schema(isJsonObject(envelope) && isJsonObject(envelope.result) && typeof envelope.result.initialized === 'boolean' && typeof envelope.result.user === 'string')
    if (envelope.result.user !== this.configuration.user) throw error('MEMORY_IDENTITY_MISMATCH', 403)
    if (!envelope.result.initialized) throw error('MEMORY_SERVER_NOT_READY', 503)
  }
  async find(query: string, settings: import('../types').MemorySettings, current: MemoryScope, all: boolean): Promise<MemoryHit[]> {
    const targets = [peerRoot(this.configuration.user, peerId(current))]
    if (settings.globalMemory) targets.unshift(globalRoot(this.configuration.user))
    if (all) targets.push(`viking://user/${this.configuration.user}/peers`)
    const result = await this.run(() => this.sdk.find(query, { targetUri: targets, contextType: 'memory', limit: settings.recallLimit, scoreThreshold: settings.scoreThreshold, level: [2] }))
    schema(isJsonObject(result) && Array.isArray(result.memories))
    const hits: MemoryHit[] = [], seen = new Set<string>(); let remaining = settings.recallMaxChars
    const candidates = result.memories.map(item => { schema(isJsonObject(item) && typeof item.uri === 'string' && typeof item.score === 'number' && Number.isFinite(item.score)); return item }).sort((a, b) => Number(b.score) - Number(a.score))
    for (const item of candidates.slice(0, 200)) {
      let uri: string
      try { uri = allowedLocation(item.uri, this.configuration.user, settings, current, all) } catch { continue }
      if (Number(item.score) < settings.scoreThreshold || seen.has(uri)) continue
      if (remaining <= 0 || hits.length >= settings.recallLimit) break
      const body = await this.run(() => this.sdk.read(uri))
      schema(typeof body === 'string')
      const text = body.slice(0, remaining)
      hits.push({ uri, score: Number(item.score), text }); seen.add(uri); remaining -= text.length
    }
    return hits
  }
  async read(uri: string): Promise<string> { memoryLocation(uri, this.configuration.user); const result = await this.run(() => this.sdk.read(uri)); schema(typeof result === 'string'); return result }
  async delete(uri: string): Promise<void> {
    memoryLocation(uri, this.configuration.user)
    const stat = await this.run(() => this.sdk.stat(uri))
    schema(isJsonObject(stat) && typeof stat.isDir === 'boolean')
    if (stat.isDir) throw error('MEMORY_URI_DENIED', 403)
    await this.run(() => this.sdk.remove(uri, { recursive: false, wait: false }))
  }
  async create(sessionId: string, global: boolean): Promise<void> {
    // SDK 0.1.0 createSession cannot disable inherited server auto-commit.
    // This is the current documented HTTP operation, not a private SDK method.
    const response = await this.fetch(this.configuration.endpoint + '/api/v1/sessions', { method: 'POST', headers: new Headers([...this.headers, ['content-type', 'application/json']]), body: JSON.stringify({ session_id: sessionId, memory_policy: { peer: { enabled: true }, self: { enabled: global }, memory_types: ['preferences', 'entities', 'events'] }, auto_commit_policy: null }) })
    const envelope: unknown = await response.json()
    schema(isJsonObject(envelope) && isJsonObject(envelope.result) && envelope.result.session_id === sessionId && envelope.result.auto_commit_policy === null)
  }
  async task(taskId: string): Promise<Record<string, unknown> | null> {
    try { return await this.run(() => this.sdk.getTask(taskId)) }
    catch (cause) { if (cause instanceof PlatformError && cause.code === 'MEMORY_NOT_FOUND') return null; throw cause }
  }
  async add(sessionId: string, messages: Message[]): Promise<void> {
    for (let offset = 0; offset < messages.length; offset += 100) {
      const batch = messages.slice(offset, offset + 100)
      const result = await this.run(() => batch.length === 1 ? this.sdk.addMessage(sessionId, batch[0]!) : this.sdk.batchAddMessages(sessionId, batch))
      schema(isJsonObject(result) && result.session_id === sessionId)
    }
  }
}
