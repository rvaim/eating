import { EventEmitter } from 'node:events'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendPlugin, BackendPluginEntry, JsonObject, PluginLogEntry, PluginLogSource } from '@eating/plugin-sdk'
import { EatingHost } from './app.ts'
import { servePluginLogStream } from './plugin-log-stream.ts'

const streamPath = '/api/plugins/test-log/logs/stream'
const cleanups: Array<() => Promise<void>> = []
const temporaryRoots: Array<{ path: string; parent: string }> = []
const sources: Array<{ listeners: Set<(entry: PluginLogEntry) => void> }> = []

function until(changed: EventEmitter, predicate: () => boolean, label: string): Promise<void> {
  return new Promise((done, reject) => {
    const check = () => {
      if (!predicate()) return
      clearTimeout(deadline)
      changed.off('change', check)
      done()
    }
    const deadline = setTimeout(() => {
      changed.off('change', check)
      reject(new Error(`Timed out waiting for ${label}`))
    }, 2000)
    changed.on('change', check)
    check()
  })
}

function logSource() {
  const listeners = new Set<(entry: PluginLogEntry) => void>()
  const changed = new EventEmitter()
  const unsubscribe = vi.fn((listener: (entry: PluginLogEntry) => void) => {
    listeners.delete(listener)
    changed.emit('change')
  })
  const subscribe = vi.fn((listener: (entry: PluginLogEntry) => void) => {
    listeners.add(listener)
    changed.emit('change')
    return () => unsubscribe(listener)
  })
  const source = {
    listeners, subscribe, unsubscribe,
    emit(entry: PluginLogEntry) { for (const listener of [...listeners]) listener(entry) },
    waitForListeners(count: number) { return until(changed, () => listeners.size === count, `${count} log listeners`) },
  }
  sources.push(source)
  return source
}

function log(id: string, level: PluginLogEntry['level'] = 'info'): PluginLogEntry {
  return { id, timestamp: '2026-10-27T12:00:00.000Z', level, event: 'test.fixture', message: `临时测试日志 ${id}`, metadata: { fixture: true } }
}

function heartbeatMonitor() {
  const scheduled = vi.spyOn(globalThis, 'setInterval')
  const cleared = vi.spyOn(globalThis, 'clearInterval')
  return {
    started: () => scheduled.mock.calls.filter(call => call[1] === 15000).length,
    active: () => scheduled.mock.calls.reduce((count, call, index) => {
      if (call[1] !== 15000) return count
      const result = scheduled.mock.results[index]
      return count + (result?.type === 'return' && !cleared.mock.calls.some(args => args[0] === result.value) ? 1 : 0)
    }, 0),
  }
}

interface HttpOptions {
  method?: string
  body?: JsonObject
  headers?: Record<string, string>
}

function http(base: string, path: string, options: HttpOptions = {}) {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: JsonObject }>((done, reject) => {
    const req = request(new URL(path, base), {
      method: options.method ?? 'GET', agent: false,
      headers: { Host: new URL(base).host, Origin: base, Connection: 'close',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }),
        ...options.headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        try { done({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('Finite HTTP request timed out')))
    cleanups.push(async () => { req.destroy() })
    req.end(payload)
  })
}

class Viewer {
  readonly logs: PluginLogEntry[] = []
  readonly comments: string[] = []
  readonly changed = new EventEmitter()
  readonly closed: Promise<void>
  private pending = ''
  private ended = false

  constructor(readonly response: IncomingMessage) {
    response.setEncoding('utf8')
    this.closed = new Promise(done => {
      response.once('close', () => { this.ended = true; this.changed.emit('change'); done() })
    })
    response.on('error', () => { /* Client cancellation may surface as ECONNRESET. */ })
    response.on('data', (chunk: string) => {
      this.pending += chunk
      for (let end = this.pending.indexOf('\n\n'); end !== -1; end = this.pending.indexOf('\n\n')) {
        const frame = this.pending.slice(0, end)
        this.pending = this.pending.slice(end + 2)
        if (frame.startsWith(':')) this.comments.push(frame)
        else {
          const lines = frame.split('\n')
          if (lines.includes('event: log')) {
            const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
            this.logs.push(JSON.parse(data) as PluginLogEntry)
          }
        }
        this.changed.emit('change')
      }
    })
  }

  ready() { return until(this.changed, () => this.comments.length > 0, 'the SSE comment handshake') }
  received(count: number) { return until(this.changed, () => this.logs.length >= count, `${count} pushed SSE logs`) }
  finished() { return until(this.changed, () => this.ended, 'the SSE response to close') }
  close() { this.response.destroy() }
}

async function createHost(withLogs = true) {
  const parent = await realpath(tmpdir())
  const path = await realpath(await mkdtemp(join(parent, 'eating_log_stream_test_')))
  temporaryRoots.push({ path, parent })
  const source = logSource()
  const backend: BackendPlugin = {
    id: 'test-log', name: '测试日志插件', version: '1.0.0',
    ...(withLogs ? { logs: source } : {}), capabilities: [], tools: [],
    getPublicConfiguration: () => ({ autoConnect: false }),
    getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, lastError: null,
      connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
    updateConfiguration: async () => ({}), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    invoke: async () => null, dispose: vi.fn(async () => {}),
  }
  const entry: BackendPluginEntry = { id: 'test-log', storageDirectory: 'test-log-bot', create: () => backend }
  const host = new EatingHost({ dataDirectory: path, entries: [entry], allowedUiOrigins: [], port: 0 })
  cleanups.push(() => host.close())
  const url = await host.listen()
  const bootstrap = await http(url, '/api/bootstrap')
  expect(bootstrap.status).toBe(200)
  const cookie = bootstrap.headers['set-cookie']?.[0]?.split(';')[0]
  const csrf = bootstrap.body.csrfToken
  if (!cookie || typeof csrf !== 'string') throw new Error('Bootstrap omitted the session cookie or CSRF token')
  const api = (target: string, options: HttpOptions = {}) => http(url, target, {
    ...options, headers: { Cookie: cookie, 'X-Eating-CSRF': csrf, ...options.headers },
  })
  return { host, url, cookie, api, source, backend }
}

function openViewer(context: Awaited<ReturnType<typeof createHost>>, extraHeaders: Record<string, string> = {}): Promise<Viewer> {
  return new Promise((done, reject) => {
    let viewer: Viewer | undefined
    const req = request(new URL(streamPath, context.url), {
      agent: false, headers: { Host: new URL(context.url).host, Origin: context.url, Cookie: context.cookie, ...extraHeaders },
    }, response => {
      req.setTimeout(0)
      viewer = new Viewer(response)
      try {
        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toMatch(/^text\/event-stream/u)
        expect(response.headers['cache-control']).toContain('no-cache')
        done(viewer)
      } catch (error) { viewer.close(); reject(error) }
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('SSE handshake timed out')))
    cleanups.push(async () => { viewer?.close(); req.destroy(); await viewer?.closed })
    req.end()
  })
}

async function readyViewer(context: Awaited<ReturnType<typeof createHost>>, headers: Record<string, string> = {}) {
  const viewer = await openViewer(context, headers)
  await viewer.ready()
  return viewer
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  for (const source of sources.splice(0)) {
    if (source.listeners.size !== 0) failures.push(new Error('Log source retained listeners after cleanup'))
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const root of temporaryRoots.splice(0).reverse()) {
    const target = await realpath(root.path)
    if (target !== root.path || dirname(target) !== root.parent || !basename(target).startsWith('eating_log_stream_test_')
      || resolve(target) !== target || (await lstat(target)).isSymbolicLink()) throw new Error('Refusing cleanup outside the verified log test root')
    await rm(target, { recursive: true })
  }
  if (failures.length) throw new AggregateError(failures, 'SSE test resources did not close cleanly')
})

describe('real Host temporary plugin log SSE', () => {
  it('does not subscribe or start log heartbeats without a viewer', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    expect((await context.api('/api/workspace')).status).toBe(200)
    context.source.emit(log('unobserved'))
    expect(context.source.listeners.size).toBe(0)
    expect(context.source.subscribe).not.toHaveBeenCalled()
    expect(heartbeats.started()).toBe(0)
    expect(context.backend.connect).not.toHaveBeenCalled()
  })

  it.each<{ name: string; headers: Record<string, string>; status: number; code: string }>([
    { name: 'missing session', headers: {}, status: 401, code: 'UNAUTHENTICATED' },
    { name: 'untrusted Origin', headers: { Origin: 'https://untrusted.invalid' }, status: 403, code: 'INVALID_ORIGIN' },
    { name: 'untrusted Host', headers: { Host: 'untrusted.invalid' }, status: 403, code: 'INVALID_HOST' },
    { name: 'cross-site request', headers: { 'Sec-Fetch-Site': 'cross-site' }, status: 403, code: 'CROSS_SITE_REQUEST' },
  ])('rejects $name before subscribing', async ({ name, headers, status, code }) => {
    const context = await createHost()
    const result = name === 'missing session' ? await http(context.url, streamPath) : await context.api(streamPath, { headers })
    expect(result.status).toBe(status)
    expect(result.body).toMatchObject({ ok: false, error: { code } })
    expect(context.source.subscribe).not.toHaveBeenCalled()
  })

  it('returns 404 when the registered backend has no log source', async () => {
    const context = await createHost(false)
    const result = await context.api(streamPath)
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ error: { code: 'PLUGIN_LOGS_UNSUPPORTED' } })
    expect(context.source.subscribe).not.toHaveBeenCalled()
  })

  it('pushes exactly the emitted event after the comment handshake and releases it on client close', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const viewer = await readyViewer(context)
    expect(context.source.listeners.size).toBe(1)
    expect(heartbeats.started()).toBe(1)
    const entry = log('one-push', 'warn')
    context.source.emit(entry)
    await viewer.received(1)
    expect(viewer.logs).toEqual([entry])
    viewer.close()
    await viewer.finished()
    await context.source.waitForListeners(0)
    expect(context.source.unsubscribe).toHaveBeenCalledTimes(1)
    expect(heartbeats.active()).toBe(0)
  })

  it('does not replay earlier logs to a new viewer or a reconnect with Last-Event-ID', async () => {
    const context = await createHost()
    context.source.emit(log('before-any-viewer'))
    const first = await readyViewer(context)
    context.source.emit(log('first-only'))
    await first.received(1)
    first.close()
    await context.source.waitForListeners(0)
    context.source.emit(log('between-viewers'))
    const second = await readyViewer(context, { 'Last-Event-ID': 'first-only' })
    expect(second.logs).toEqual([])
    const fresh = log('second-only')
    context.source.emit(fresh)
    await second.received(1)
    expect(first.logs.map(entry => entry.id)).toEqual(['first-only'])
    expect(second.logs).toEqual([fresh])
  })

  it('keeps simultaneous viewers independent when one client closes', async () => {
    const context = await createHost()
    const first = await readyViewer(context)
    const second = await readyViewer(context)
    expect(context.source.listeners.size).toBe(2)
    const shared = log('both-viewers')
    context.source.emit(shared)
    await Promise.all([first.received(1), second.received(1)])
    expect(first.logs).toEqual([shared])
    expect(second.logs).toEqual([shared])
    first.close()
    await context.source.waitForListeners(1)
    const remaining = log('remaining-viewer', 'error')
    context.source.emit(remaining)
    await second.received(2)
    expect(first.logs).toEqual([shared])
    expect(second.logs).toEqual([shared, remaining])
    second.close()
    await context.source.waitForListeners(0)
  })

  it('ends active streams on disable, rejects future requests with 409, and enables a fresh stream', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const viewers = [await readyViewer(context), await readyViewer(context)]
    expect((await context.api('/api/plugins/test-log/disable', { method: 'POST', body: {} })).status).toBe(200)
    await Promise.all(viewers.map(viewer => viewer.finished()))
    expect(context.source.listeners.size).toBe(0)
    expect(heartbeats.active()).toBe(0)
    expect(context.backend.disconnect).toHaveBeenCalledTimes(1)
    const rejected = await context.api(streamPath)
    expect(rejected.status).toBe(409)
    expect(rejected.body).toMatchObject({ error: { code: 'PLUGIN_DISABLED' } })
    expect(context.source.subscribe).toHaveBeenCalledTimes(2)
    context.source.emit(log('disabled'))
    expect((await context.api('/api/plugins/test-log/enable', { method: 'POST', body: {} })).status).toBe(200)
    const resumed = await readyViewer(context)
    const fresh = log('after-enable')
    context.source.emit(fresh)
    await resumed.received(1)
    expect(resumed.logs).toEqual([fresh])
  })

  it('rejects new viewers while disable waits for disconnect and finishes with no log resources', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const viewers = [await readyViewer(context), await readyViewer(context)]
    let finishDisconnect!: () => void
    const disconnected = new Promise<void>(done => { finishDisconnect = done })
    const disconnect = vi.spyOn(context.backend, 'disconnect').mockReturnValue(disconnected)
    const disabling = context.api('/api/plugins/test-log/disable', { method: 'POST', body: {} })
    cleanups.push(async () => { finishDisconnect(); await disabling })

    await context.source.waitForListeners(0)
    await Promise.all(viewers.map(viewer => viewer.finished()))
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(context.source.unsubscribe).toHaveBeenCalledTimes(2)
    expect(heartbeats.active()).toBe(0)
    expect((await context.api('/api/workspace')).body).toMatchObject({
      registeredIds: [], plugins: [{ id: 'test-log', enabled: false, logViewerCount: 0 }],
    })
    const busy = await context.api(streamPath)
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ error: { code: 'PLUGIN_DISABLED' } })
    expect(context.source.subscribe).toHaveBeenCalledTimes(2)
    expect(heartbeats.started()).toBe(2)

    finishDisconnect()
    expect((await disabling).status).toBe(200)
    const disabled = await context.api(streamPath)
    expect(disabled.status).toBe(409)
    expect(disabled.body).toMatchObject({ error: { code: 'PLUGIN_DISABLED' } })
    expect((await context.api('/api/workspace')).body).toMatchObject({
      registeredIds: [], plugins: [{ id: 'test-log', enabled: false, logViewerCount: 0 }],
    })
    expect(context.source.listeners.size).toBe(0)
    expect(heartbeats.active()).toBe(0)
  })

  it('releases the log viewer barrier after disconnect rejects without restoring old streams', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const oldViewer = await readyViewer(context)
    const oldEntry = log('before-failed-disable')
    context.source.emit(oldEntry)
    await oldViewer.received(1)
    let failDisconnect!: (error: Error) => void
    const disconnected = new Promise<void>((_, reject) => { failDisconnect = reject })
    vi.spyOn(context.backend, 'disconnect').mockReturnValue(disconnected)
    const disabling = context.api('/api/plugins/test-log/disable', { method: 'POST', body: {} })
    cleanups.push(async () => { failDisconnect(new Error('test disconnect failed')); await disabling })

    await context.source.waitForListeners(0)
    await oldViewer.finished()
    expect(heartbeats.active()).toBe(0)
    const busy = await context.api(streamPath)
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ error: { code: 'PLUGIN_DISABLED' } })
    failDisconnect(new Error('test disconnect failed'))
    const failed = await disabling
    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
    expect((await context.api('/api/workspace')).body).toMatchObject({
      registeredIds: [], plugins: [{ id: 'test-log', enabled: false, logViewerCount: 0 }],
    })
    expect(context.source.listeners.size).toBe(0)
    const stillDisabled = await context.api(streamPath)
    expect(stillDisabled.status).toBe(409)
    expect(stillDisabled.body).toMatchObject({ error: { code: 'PLUGIN_DISABLED' } })
    expect(context.source.subscribe).toHaveBeenCalledTimes(1)
    expect(heartbeats.active()).toBe(0)
    expect((await context.api('/api/plugins/test-log/enable', { method: 'POST', body: {} })).status).toBe(200)

    const resumed = await readyViewer(context)
    expect(resumed.logs).toEqual([])
    const fresh = log('after-failed-disable')
    context.source.emit(fresh)
    await resumed.received(1)
    expect(resumed.logs).toEqual([fresh])
    expect(oldViewer.logs).toEqual([oldEntry])
    expect(context.source.subscribe).toHaveBeenCalledTimes(2)
    expect((await context.api('/api/workspace')).body).toMatchObject({
      plugins: [{ id: 'test-log', enabled: true, logViewerCount: 1 }],
    })
    resumed.close()
    await context.source.waitForListeners(0)
    expect(context.source.unsubscribe).toHaveBeenCalledTimes(2)
    expect(heartbeats.active()).toBe(0)
  })

  it('finishes Host.close within a deadline while SSE clients are still open', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const viewers = [await readyViewer(context), await readyViewer(context)]
    const completion = new EventEmitter()
    let stopped = false
    const closing = context.host.close().then(() => { stopped = true; completion.emit('change') })
    await until(completion, () => stopped, 'Host.close with active SSE clients')
    await closing
    await Promise.all(viewers.map(viewer => viewer.finished()))
    expect(context.source.listeners.size).toBe(0)
    expect(heartbeats.active()).toBe(0)
    expect(context.backend.dispose).toHaveBeenCalledTimes(1)
  })

  it('caps active viewers at eight, frees a cancelled slot, and leaves no subscriptions or heartbeats', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const viewers: Viewer[] = []
    for (let index = 0; index < 8; index += 1) viewers.push(await readyViewer(context))
    expect(context.source.listeners.size).toBe(8)
    expect(heartbeats.active()).toBe(8)
    const rejected = await context.api(streamPath)
    expect(rejected.status).toBe(429)
    expect(rejected.body).toMatchObject({ error: { code: 'TOO_MANY_LOG_VIEWERS' } })
    expect(context.source.subscribe).toHaveBeenCalledTimes(8)
    viewers[0]!.close()
    await context.source.waitForListeners(7)
    const replacement = await readyViewer(context)
    expect(context.source.listeners.size).toBe(8)
    const entry = log('eight-live-viewers')
    context.source.emit(entry)
    const remaining = [...viewers.slice(1), replacement]
    await Promise.all(remaining.map(viewer => viewer.received(1)))
    for (const viewer of remaining) expect(viewer.logs).toEqual([entry])
    for (const viewer of remaining) viewer.close()
    await context.source.waitForListeners(0)
    expect(context.source.unsubscribe).toHaveBeenCalledTimes(9)
    expect(heartbeats.active()).toBe(0)
  })

  it('cleans up a client cancelled at the HTTP response handshake', async () => {
    const heartbeats = heartbeatMonitor()
    const context = await createHost()
    const viewer = await openViewer(context)
    viewer.close()
    await viewer.finished()
    await context.source.waitForListeners(0)
    expect(context.source.subscribe).toHaveBeenCalledTimes(1)
    expect(context.source.unsubscribe).toHaveBeenCalledTimes(1)
    expect(heartbeats.active()).toBe(0)
    const replacement = await readyViewer(context)
    const entry = log('after-handshake-cancel')
    context.source.emit(entry)
    await replacement.received(1)
    expect(replacement.logs).toEqual([entry])
  })
})

// Only transport conditions that cannot be made deterministic with a TCP client
// use this response fixture; all routing, authentication and viewer limits use Host.
class FakeResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  readonly writes: string[] = []
  readonly writeHead = vi.fn(() => this)
  readonly flushHeaders = vi.fn(() => this)
  readonly write = vi.fn((data: string) => { this.writes.push(data); return true })
  readonly end = vi.fn(() => { this.writableEnded = true; this.emit('close'); return this })
  readonly destroy = vi.fn(() => { this.destroyed = true; this.emit('close'); return this })
}

function transport(source: PluginLogSource = logSource()) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const request = new EventEmitter()
  const response = new FakeResponse()
  const onClose = vi.fn()
  return { request, response, onClose, start() {
    const stop = servePluginLogStream(request as IncomingMessage, response as unknown as ServerResponse, source, onClose)
    cleanups.push(async () => { stop() })
    return stop
  } }
}

function expectReleased(context: ReturnType<typeof transport>, source: ReturnType<typeof logSource>) {
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(context.onClose).toHaveBeenCalledTimes(1)
  expect(context.request.listenerCount('aborted')).toBe(0)
  expect(context.response.listenerCount('close')).toBe(0)
  expect(context.response.listenerCount('error')).toBe(0)
}

describe('temporary log stream transport cancellation and backpressure', () => {
  it('uses only comment heartbeats every 15 seconds and cancels the timer on stop', () => {
    const source = logSource()
    const context = transport(source)
    const stop = context.start()
    expect(vi.getTimerCount()).toBe(1)
    expect(context.response.writes).toEqual([': temporary log stream\n\n'])
    vi.advanceTimersByTime(14999)
    expect(context.response.writes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(context.response.writes).toEqual([': temporary log stream\n\n', ': keepalive\n\n'])
    stop()
    vi.advanceTimersByTime(30000)
    expect(context.response.writes).toHaveLength(2)
    expectReleased(context, source)
  })

  it.each(['request-aborted', 'response-close', 'response-error'] as const)('releases the subscription and heartbeat on %s', reason => {
    const source = logSource()
    const context = transport(source)
    const stop = context.start()
    const lateListener = [...source.listeners][0]!
    if (reason === 'request-aborted') context.request.emit('aborted')
    else context.response.emit(reason === 'response-close' ? 'close' : 'error', new Error('test transport failure'))
    const writes = context.response.writes.length
    lateListener(log('late-after-close'))
    stop()
    expect(context.response.writes).toHaveLength(writes)
    expect(source.unsubscribe).toHaveBeenCalledTimes(1)
    expectReleased(context, source)
  })

  it.each(['headers', 'comment', 'subscribe'] as const)('cleans up cancellation during the %s handshake phase', phase => {
    const source = logSource()
    const context = transport(source)
    if (phase === 'headers') context.response.flushHeaders.mockImplementation(() => { context.request.emit('aborted'); return context.response })
    if (phase === 'comment') context.response.write.mockImplementation(() => { context.request.emit('aborted'); return true })
    if (phase === 'subscribe') {
      const subscribe = source.subscribe.getMockImplementation()!
      source.subscribe.mockImplementation(listener => {
        const unsubscribe = subscribe(listener)
        context.request.emit('aborted')
        return unsubscribe
      })
    }
    const stop = context.start()
    stop()
    expect(source.unsubscribe.mock.calls.length).toBe(source.subscribe.mock.calls.length)
    expectReleased(context, source)
  })

  it('does not subscribe or create a timer when the initial comment hits backpressure', () => {
    const source = logSource()
    const context = transport(source)
    context.response.write.mockReturnValue(false)
    context.start()
    expect(source.subscribe).not.toHaveBeenCalled()
    expect(context.response.destroy).toHaveBeenCalledTimes(1)
    expectReleased(context, source)
  })

  it.each(['false', 'throw'] as const)('disconnects a slow or failed viewer when a log write returns %s', failure => {
    const source = logSource()
    const context = transport(source)
    const stop = context.start()
    context.response.write.mockImplementation(() => {
      if (failure === 'throw') throw new Error('test write failure')
      return false
    })
    source.emit(log('backpressure'))
    stop()
    expect(context.response.destroy).toHaveBeenCalledTimes(1)
    expect(source.unsubscribe).toHaveBeenCalledTimes(1)
    expectReleased(context, source)
  })

  it('unsubscribes when a synchronous subscribe callback loses the transport before returning its cleanup', () => {
    const source = logSource()
    const context = transport(source)
    const subscribe = source.subscribe.getMockImplementation()!
    source.subscribe.mockImplementation(listener => {
      const unsubscribe = subscribe(listener)
      listener(log('synchronous-subscribe'))
      return unsubscribe
    })
    context.response.write.mockImplementation(data => !data.startsWith('event: log'))
    context.start()
    expect(source.unsubscribe).toHaveBeenCalledTimes(1)
    expectReleased(context, source)
  })
})
