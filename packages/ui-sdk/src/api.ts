import { isJsonObject } from '@eating/plugin-sdk'
import type { PluginLogEntry } from '@eating/plugin-sdk'
import { translate } from './i18n.js'

export class HostApiError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: string = 'failed') { super(message); this.name = 'HostApiError' }
}

let initialization: Promise<string> | null = null

async function initialize(): Promise<string> {
  if (!initialization) initialization = fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(async response => {
    if (!response.ok) throw new HostApiError('HOST_UNAVAILABLE', translate('common', 'errors.HOST_UNAVAILABLE'))
    const value = await response.json() as { csrfToken?: unknown }
    if (typeof value.csrfToken !== 'string') throw new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE'))
    return value.csrfToken
  }).catch(error => { initialization = null; throw error })
  return initialization
}

export async function hostRequest<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (options.signal?.aborted) throw new HostApiError('REQUEST_CANCELLED', translate('common', 'errors.REQUEST_CANCELLED'), 'not-sent')
  const csrfToken = await initialize()
  if (options.signal?.aborted) throw new HostApiError('REQUEST_CANCELLED', translate('common', 'errors.REQUEST_CANCELLED'), 'not-sent')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 65000)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`/api${path}`, { method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Eating-Csrf': csrfToken },
      ...(options.method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}), signal: controller.signal })
    const result = await response.json() as { error?: { code?: string; message?: string; outcome?: string } }
    if (!response.ok) {
      if (response.status === 401 || result.error?.code === 'INVALID_CSRF_TOKEN') initialization = null
      throw new HostApiError(result.error?.code ?? 'HOST_ERROR', result.error?.message ?? translate('common', 'errors.HOST_ERROR'), result.error?.outcome)
    }
    return result as T
  } catch (error) {
    if (error instanceof HostApiError) throw error
    if (controller.signal.aborted) throw new HostApiError('REQUEST_INTERRUPTED', translate('common', 'errors.REQUEST_INTERRUPTED'), 'unknown')
    throw new HostApiError('HOST_UNAVAILABLE', translate('common', 'errors.HOST_UNAVAILABLE'), 'unknown')
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export type PluginLogStreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
export interface PluginLogHandlers {
  readonly onEntry: (entry: PluginLogEntry) => void
  readonly onState?: (state: PluginLogStreamState) => void
  readonly onError?: (error: HostApiError) => void
}

function parseLogEntry(value: unknown): PluginLogEntry {
  if (!isJsonObject(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128
    || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || !['info', 'warn', 'error'].includes(String(value.level)) || typeof value.event !== 'string' || value.event.length > 100
    || typeof value.message !== 'string' || value.message.length > 2000
    || value.metadata !== undefined && !isJsonObject(value.metadata)) throw new HostApiError('INVALID_LOG_ENTRY', translate('common', 'errors.INVALID_LOG_ENTRY'))
  return value as unknown as PluginLogEntry
}

/** A transient live stream. No history, browser storage or background polling. */
export function subscribePluginLogs(pluginId: string, handlers: PluginLogHandlers): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) throw new HostApiError('INVALID_PLUGIN_ID', translate('common', 'errors.INVALID_PLUGIN_ID'), 'not-sent')
  let disposed = false
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  const reconnect = () => {
    if (disposed || retry) return
    handlers.onState?.('reconnecting')
    retry = setTimeout(() => { retry = undefined; initialization = null; void connect(true) }, 2000)
  }
  async function connect(reconnecting = false): Promise<void> {
    if (disposed) return
    handlers.onState?.(reconnecting ? 'reconnecting' : 'connecting')
    try { await initialize() }
    catch {
      if (disposed) return
      handlers.onError?.(new HostApiError('LOG_STREAM_UNAVAILABLE', translate('common', 'errors.LOG_STREAM_UNAVAILABLE')))
      reconnect(); return
    }
    if (disposed) return
    let current: EventSource
    try { current = new EventSource(`/api/plugins/${encodeURIComponent(pluginId)}/logs/stream`) }
    catch {
      handlers.onError?.(new HostApiError('LOG_STREAM_UNAVAILABLE', translate('common', 'errors.LOG_STREAM_UNAVAILABLE')))
      reconnect(); return
    }
    source = current
    current.onopen = () => { if (!disposed && source === current) handlers.onState?.('connected') }
    current.addEventListener('log', event => {
      if (disposed || source !== current) return
      let entry: PluginLogEntry
      try {
        if (typeof event.data !== 'string' || event.data.length > 16384) throw new Error('size')
        entry = parseLogEntry(JSON.parse(event.data))
      } catch {
        current.close(); source = null
        handlers.onState?.('closed')
        handlers.onError?.(new HostApiError('INVALID_LOG_ENTRY', translate('common', 'errors.INVALID_LOG_ENTRY')))
        return
      }
      handlers.onEntry(entry)
    })
    current.onerror = () => {
      if (disposed || source !== current) return
      current.close(); source = null
      reconnect()
    }
  }
  void connect()
  return () => {
    if (disposed) return
    disposed = true
    if (retry) clearTimeout(retry)
    retry = undefined
    source?.close(); source = null
  }
}
