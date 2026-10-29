import type { OneBotConnectionConfig } from '../config'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { VerifyClientCallbackAsync } from 'ws'
import { PlatformError } from '@eating/plugin-sdk'
import type { ConnectionStatus, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { OneBotClient } from './onebot.ts'

type Request = { action: string; params: JsonObject; echo: string }
type ReceivedRequest = Request & { peer: WebSocket }
type FixtureOptions = {
  onRequest?: (request: Request, peer: WebSocket) => boolean | void
  login?: JsonValue
  health?: JsonValue
  holdHandshake?: boolean
  rejectHandshake?: number
  autoPong?: boolean
}

const clients: OneBotClient[] = []
const cleanup: Array<() => Promise<void>> = []

function reply(peer: WebSocket, request: Request, data: JsonValue, status = 'ok', retcode = 0): void {
  peer.send(JSON.stringify({ status, retcode, data, echo: request.echo }))
}

// Only this test file hosts a protocol fixture; no product transport is simulated.
async function fixture(options: FixtureOptions = {}) {
  const approvals: Array<() => void> = []
  const verifyClient: VerifyClientCallbackAsync = (_info, approve) => {
    if (options.rejectHandshake) approve(false, options.rejectHandshake, 'Rejected')
    else if (options.holdHandshake) approvals.push(() => approve(true))
    else approve(true)
  }
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient, autoPong: options.autoPong ?? true })
  const peers: WebSocket[] = []
  const requests: ReceivedRequest[] = []
  const handshakes: Array<{ headers: IncomingHttpHeaders; url: string | undefined }> = []
  server.on('connection', (peer, request) => {
    peers.push(peer)
    handshakes.push({ headers: request.headers, url: request.url })
    peer.on('error', () => { /* A test may deliberately abort or exceed the protocol limit. */ })
    peer.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as Request
      requests.push({ ...request, peer })
      if (options.onRequest?.(request, peer)) return
      if (request.action === 'get_login_info') reply(peer, request, options.login ?? { user_id: 123456789, nickname: '协议测试账号' })
      if (request.action === 'get_status') reply(peer, request, options.health ?? { online: true, good: true })
    })
  })
  await once(server, 'listening')
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const peer of server.clients) peer.terminate()
    // An aborted delayed handshake is released without inventing a connection.
    for (const approve of approvals.splice(0)) approve()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  cleanup.push(close)
  return { endpoint, server, peers, requests, handshakes, approvals, close }
}

function config(endpoint: string, patch: Partial<OneBotConnectionConfig> = {}): OneBotConnectionConfig {
  return { endpoint, accessToken: '', timeoutMs: 500, ...patch }
}

function client(options: Partial<ConstructorParameters<typeof OneBotClient>[0]> = {}): OneBotClient {
  const value = new OneBotClient({ onEvent: () => {}, reconnectDelaysMs: [], ...options })
  clients.push(value)
  return value
}

async function waitFor(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 1500, interval: 5 })
}

function errorFrom(promise: Promise<unknown>): Promise<PlatformError> {
  return promise.then(() => { throw new Error('Expected a rejected protocol operation') }, (error: unknown) => {
    expect(error).toBeInstanceOf(PlatformError)
    return error as PlatformError
  })
}

afterEach(async () => {
  for (const value of clients.splice(0)) await value.dispose()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('OneBotClient forward unified WebSocket', () => {
  it('starts unconfigured and refuses unsent actions before explicit connection', async () => {
    const value = client()
    expect(value.getStatus()).toEqual({
      state: 'unconfigured', accountId: null, accountName: null, connectedAt: null,
      lastEventAt: null, lastError: null, reconnectAttempt: 0,
    })
    expect(await errorFrom(value.call('send_msg', {}))).toMatchObject({ code: 'onebot_not_connected', outcome: 'not-sent' })
  })

  it('authenticates in the header and obtains real account/health data after explicit connect', async () => {
    const remote = await fixture()
    const accessToken = randomUUID()
    const statuses: ConnectionStatus[] = []
    const value = client({ onStatus: (status) => statuses.push(status) })
    await value.connect(config(remote.endpoint, { accessToken }))
    expect(remote.handshakes).toHaveLength(1)
    expect(remote.handshakes[0]?.headers.authorization).toBe(`Bearer ${accessToken}`)
    expect(remote.handshakes[0]?.url).toBe('/')
    expect(remote.requests.map((request) => request.action)).toEqual(['get_login_info', 'get_status'])
    expect(value.getStatus()).toMatchObject({ state: 'connected', accountId: '123456789', accountName: '协议测试账号', lastError: null })
    expect(value.getStatus().connectedAt).toEqual(expect.any(String))
    expect(statuses.map((status) => status.state)).toContain('connecting')
    expect(JSON.stringify(statuses)).not.toContain(accessToken)
    const snapshot = value.getStatus()
    Object.assign(snapshot, { state: 'error', accountName: '篡改' })
    expect(value.getStatus().state).toBe('connected')
    expect(value.getStatus().accountName).toBe('协议测试账号')
  })

  it('does not equate WebSocket open with a healthy QQ account and waits for both echoes', async () => {
    const remote = await fixture({ onRequest: () => true })
    const value = client()
    const connecting = value.connect(config(remote.endpoint))
    await waitFor(() => expect(remote.requests).toHaveLength(2))
    expect(value.getStatus()).toMatchObject({ state: 'connecting', accountId: null, connectedAt: null })
    expect(await errorFrom(value.call('send_private_msg', {}))).toMatchObject({ outcome: 'not-sent' })
    const login = remote.requests.find((request) => request.action === 'get_login_info')!
    const health = remote.requests.find((request) => request.action === 'get_status')!
    reply(health.peer, health, { online: true, good: true })
    await delay(10)
    expect(value.getStatus().state).toBe('connecting')
    reply(login.peer, login, { user_id: 998877, nickname: '真实回应' })
    await connecting
    expect(value.getStatus()).toMatchObject({ state: 'connected', accountId: '998877', accountName: '真实回应' })
  })

  it.each<JsonValue>([
    { online: false, good: true }, { online: null, good: true },
    { online: true, good: false }, {},
  ])('rejects unconfirmed account health %j', async (health) => {
    const remote = await fixture({ health })
    const statuses: string[] = []
    const value = client({ onStatus: (status) => statuses.push(status.state) })
    expect(await errorFrom(value.connect(config(remote.endpoint)))).toMatchObject({ code: 'onebot_account_not_online', outcome: 'failed' })
    expect(value.getStatus().state).toBe('error')
    expect(statuses).not.toContain('connected')
  })

  it.each<JsonValue>([
    { user_id: 0, nickname: '无效' }, { user_id: Number.MAX_SAFE_INTEGER + 1, nickname: '精度丢失' },
    { user_id: 12 }, null,
  ])('rejects invalid successful login data %j', async (login) => {
    const remote = await fixture({ onRequest: (request, peer) => {
      if (request.action !== 'get_login_info') return false
      reply(peer, request, login)
      return true
    } })
    const value = client()
    expect(await errorFrom(value.connect(config(remote.endpoint)))).toMatchObject({ code: 'onebot_invalid_login_info' })
    expect(value.getStatus().state).toBe('error')
  })

  it('correlates concurrent requests out of order with unique UUID echoes and independent events', async () => {
    const onEvent = vi.fn()
    const remote = await fixture()
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint))
    const first = value.call('get_friend_list', {}, { readOnly: true })
    const second = value.call('get_group_list', {}, { readOnly: true })
    const third = value.call('send_private_msg', { user_id: 7, message: '夹具内动作' })
    await waitFor(() => expect(remote.requests).toHaveLength(5))
    const requests = remote.requests.slice(2)
    const [a, b, c] = requests as [ReceivedRequest, ReceivedRequest, ReceivedRequest]
    reply(c.peer, c, { message_id: 789 })
    c.peer.send(JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 8, raw_message: '真实协议事件' }))
    reply(a.peer, a, [{ user_id: 111 }])
    reply(b.peer, b, [{ group_id: 222 }])
    expect(await Promise.all([first, second, third])).toEqual([[{ user_id: 111 }], [{ group_id: 222 }], { message_id: 789 }])
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    const echoes = remote.requests.map((request) => request.echo)
    expect(new Set(echoes).size).toBe(5)
    for (const echo of echoes) expect(echo).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(value.getStatus().lastEventAt).toEqual(expect.any(String))
  })

  it('delivers message, notice, request and real meta events without inventing heartbeat events', async () => {
    const onEvent = vi.fn()
    const remote = await fixture()
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint))
    const events = ['message', 'notice', 'request', 'meta_event'].map((post_type) => ({ post_type, self_id: 123456789 }))
    for (const event of events) remote.peers[0]!.send(JSON.stringify(event))
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(4))
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events)
  })

  it('revokes offline heartbeat state before callbacks and requires fresh login before healthy heartbeats can recover', async () => {
    let holdLogin = false
    const remote = await fixture({ onRequest: request => holdLogin && request.action === 'get_login_info' })
    const events: JsonObject[] = []
    let callbackAttempt: Promise<PlatformError> | undefined
    const value = client({ reconnectDelaysMs: [10], onEvent: event => {
      events.push(event)
      if (isOffline(event)) callbackAttempt = errorFrom(value.call('send_msg', { message: '不能在离线回调中发送' }))
    } })
    function isOffline(event: JsonObject): boolean {
      return event.meta_event_type === 'heartbeat' && event.status !== null
        && typeof event.status === 'object' && !Array.isArray(event.status) && event.status.online === false
    }
    await value.connect(config(remote.endpoint))
    const pending = errorFrom(value.call('send_msg', { message: '结果未确认的旧动作' }, { timeoutMs: 5000 }))
    await waitFor(() => expect(remote.requests).toHaveLength(3))
    holdLogin = true
    const offline = { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 123456789,
      status: { online: false, good: false }, interval: 5000 }
    remote.peers[0]!.send(JSON.stringify(offline))
    expect(await pending).toMatchObject({ code: 'onebot_account_not_online', outcome: 'unknown' })
    expect(await callbackAttempt).toMatchObject({ code: 'onebot_not_connected', outcome: 'not-sent' })
    expect(events[0]).toEqual(offline)
    expect(value.getStatus().state).toBe('reconnecting')
    await waitFor(() => expect(remote.requests.filter(request => request.action === 'get_login_info')).toHaveLength(2))
    const freshLogin = remote.requests.filter(request => request.action === 'get_login_info')[1]!
    freshLogin.peer.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat',
      self_id: 123456789, status: { online: true, good: true }, interval: 5000 }))
    await waitFor(() => expect(events).toHaveLength(2))
    expect(value.getStatus().state).toBe('reconnecting')
    expect(await errorFrom(value.call('send_msg', {}))).toMatchObject({ outcome: 'not-sent' })
    reply(freshLogin.peer, freshLogin, { user_id: 123456789, nickname: '重新核验的账号' })
    await waitFor(() => expect(value.getStatus()).toMatchObject({ state: 'connected', accountName: '重新核验的账号' }))
    expect(remote.requests.filter(request => request.action === 'send_msg')).toHaveLength(1)
  })

  it('returns a queried unknown health state but rejects other pending writes and requires explicit revalidation', async () => {
    let health: JsonObject = { online: true, good: true }
    const remote = await fixture({ onRequest: (request, peer) => {
      if (request.action !== 'get_status') return false
      reply(peer, request, health)
      return true
    } })
    const value = client()
    await value.connect(config(remote.endpoint))
    const pending = errorFrom(value.call('send_msg', {}, { timeoutMs: 5000 }))
    await waitFor(() => expect(remote.requests).toHaveLength(3))
    health = { online: null, good: false }
    expect(await value.call('get_status', {}, { readOnly: true })).toEqual(health)
    expect(await pending).toMatchObject({ code: 'onebot_account_not_online', outcome: 'unknown' })
    expect(value.getStatus()).toMatchObject({ state: 'error', connectedAt: null })
    expect(await errorFrom(value.call('send_msg', {}))).toMatchObject({ code: 'onebot_not_connected', outcome: 'not-sent' })
    health = { online: true, good: true }
    await value.connect(config(remote.endpoint))
    expect(value.getStatus().state).toBe('connected')
    expect(remote.requests.filter(request => request.action === 'get_login_info')).toHaveLength(2)
    expect(remote.requests.filter(request => request.action === 'send_msg')).toHaveLength(1)
  })

  it('uses the latest configuration timeout for a replacement handshake without a constructor override', async () => {
    const initial = await fixture()
    const delayed = await fixture({ holdHandshake: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = client()
    await value.connect(config(initial.endpoint, { timeoutMs: 500 }))
    let completed = false
    const reconnecting = errorFrom(value.connect(config(delayed.endpoint, { timeoutMs: 50 }))).then(error => {
      completed = true
      return error
    })
    await delay(10)
    expect(delayed.approvals).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(49)
    expect(completed).toBe(false)
    expect(value.getStatus().state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(await reconnecting).toMatchObject({ code: 'onebot_connection_timeout', outcome: 'not-sent' })
    expect(value.getStatus().state).toBe('error')
    expect(delayed.requests).toHaveLength(0)
  })

  it.each(['sync', 'async'] as const)('reports %s event callback failures without replaying actions or leaking error text', async (mode) => {
    const secret = randomUUID()
    let count = 0
    const remote = await fixture({ onRequest: (request, peer) => {
      if (request.action !== 'send_msg') return false
      reply(peer, request, { message_id: ++count })
      return true
    } })
    const onEvent = mode === 'sync'
      ? () => { throw new Error(secret) }
      : async () => { throw new Error(secret) }
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint, { accessToken: secret }))
    expect(await value.call('send_msg', { message: '夹具' })).toEqual({ message_id: 1 })
    remote.peers[0]!.send(JSON.stringify({ post_type: 'message', message_id: 123 }))
    await waitFor(() => expect(value.getStatus().lastError).toBe('OneBot 事件回调执行失败'))
    expect(value.getStatus().state).toBe('connected')
    expect(JSON.stringify(value.getStatus())).not.toContain(secret)
    expect(count).toBe(1)
  })

  it('keeps status callback failures visible while completing health verification', async () => {
    const remote = await fixture()
    const value = client({ onStatus: () => { throw new Error('private callback data') } })
    await value.connect(config(remote.endpoint))
    expect(value.getStatus()).toMatchObject({ state: 'connected', lastError: 'OneBot 状态回调执行失败' })
  })

  it('rejects explicit failed retcodes and discards untrusted implementation error messages', async () => {
    const secret = randomUUID()
    const remote = await fixture({ onRequest: (request, peer) => {
      if (request.action !== 'unknown_action') return false
      peer.send(JSON.stringify({ status: 'failed', retcode: 1404, data: null, echo: request.echo, message: secret, wording: secret }))
      return true
    } })
    const value = client()
    await value.connect(config(remote.endpoint, { accessToken: secret }))
    const error = await errorFrom(value.call('unknown_action', {}))
    expect(error).toMatchObject({ code: 'onebot_retcode_1404', outcome: 'failed' })
    expect(error.message).not.toContain(secret)
    expect(value.getStatus().lastError).not.toContain(secret)
  })

  it.each([{ status: 'async', retcode: 1 }, { status: 'ok', retcode: 1 }, { status: 'async', retcode: 0 }])(
    'reports async acknowledgment %j as an unknown outcome', async ({ status, retcode }) => {
      const remote = await fixture({ onRequest: (request, peer) => {
        if (request.action !== 'send_msg') return false
        reply(peer, request, null, status, retcode)
        return true
      } })
      const value = client()
      await value.connect(config(remote.endpoint))
      expect(await errorFrom(value.call('send_msg', {}))).toMatchObject({ code: 'onebot_async_pending', outcome: 'unknown' })
      expect(remote.requests.filter((request) => request.action === 'send_msg')).toHaveLength(1)
    })

  it.each([
    { status: 'ok', retcode: 5, data: null }, { status: 'failed', retcode: 0, data: null },
    { status: 'mystery', retcode: 0, data: null }, { status: 'ok', retcode: 0 },
    { status: 'ok', retcode: '0', data: null },
  ])('rejects a malformed matching response %j conservatively', async (response) => {
    const remote = await fixture({ onRequest: (request, peer) => {
      if (request.action !== 'send_msg') return false
      peer.send(JSON.stringify({ ...response, echo: request.echo }))
      return true
    } })
    const value = client()
    await value.connect(config(remote.endpoint))
    expect(await errorFrom(value.call('send_msg', {}))).toMatchObject({ code: 'onebot_invalid_response', outcome: 'unknown' })
    expect(value.getStatus().state).toBe('connected')
  })

  it('times out a side effect as unknown, ignores its late echo and never resends it', async () => {
    const onEvent = vi.fn()
    const remote = await fixture()
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint))
    const error = await errorFrom(value.call('send_msg', { message: '夹具内超时' }, { timeoutMs: 20 }))
    expect(error).toMatchObject({ code: 'onebot_request_timeout', statusCode: 504, outcome: 'unknown' })
    const timedOut = remote.requests.find((request) => request.action === 'send_msg')!
    const following = value.call('get_friend_list', {}, { readOnly: true })
    await waitFor(() => expect(remote.requests).toHaveLength(4))
    reply(timedOut.peer, timedOut, { message_id: 9 })
    const next = remote.requests[3]!
    reply(next.peer, next, [{ user_id: 17 }])
    expect(await following).toEqual([{ user_id: 17 }])
    await delay(25)
    expect(remote.requests.filter((request) => request.action === 'send_msg')).toHaveLength(1)
    expect(onEvent).not.toHaveBeenCalled()
    expect(value.getStatus().lastError).toContain('无法关联')
  })

  it('uses constructor timeout for a read-only query and never retries that query', async () => {
    const remote = await fixture()
    const value = client({ requestTimeoutMs: 40 })
    await value.connect(config(remote.endpoint, { timeoutMs: 500 }))
    expect(await errorFrom(value.call('get_friend_list', {}, { readOnly: true }))).toMatchObject({ code: 'onebot_request_timeout', outcome: 'failed' })
    expect(remote.requests.filter((request) => request.action === 'get_friend_list')).toHaveLength(1)
  })

  it('uses configured timeout when no constructor or call override is supplied', async () => {
    const remote = await fixture()
    const value = client()
    await value.connect(config(remote.endpoint, { timeoutMs: 80 }))
    expect(await errorFrom(value.call('send_msg', {}))).toMatchObject({ code: 'onebot_request_timeout', outcome: 'unknown' })
  })

  it('rejects all pending requests immediately on remote closure and reconnects without replay', async () => {
    const remote = await fixture()
    const value = client({ reconnectDelaysMs: [10] })
    await value.connect(config(remote.endpoint))
    const effect = errorFrom(value.call('send_msg', {}, { timeoutMs: 5000 }))
    const query = errorFrom(value.call('get_friend_list', {}, { timeoutMs: 5000, readOnly: true }))
    await waitFor(() => expect(remote.requests).toHaveLength(4))
    remote.peers[0]!.close()
    expect(await effect).toMatchObject({ code: 'onebot_connection_closed', outcome: 'unknown' })
    expect(await query).toMatchObject({ code: 'onebot_connection_closed', outcome: 'failed' })
    await waitFor(() => {
      expect(remote.peers).toHaveLength(2)
      expect(value.getStatus().state).toBe('connected')
    })
    expect(remote.requests.filter((request) => request.action === 'send_msg')).toHaveLength(1)
    expect(remote.requests.filter((request) => request.action === 'get_friend_list')).toHaveLength(1)
  })

  it('treats manual disconnect as final and rejects pending actions', async () => {
    const remote = await fixture()
    const value = client({ reconnectDelaysMs: [5, 10] })
    await value.connect(config(remote.endpoint))
    const pending = errorFrom(value.call('send_msg', {}, { timeoutMs: 5000 }))
    await waitFor(() => expect(remote.requests).toHaveLength(3))
    await value.disconnect()
    expect(await pending).toMatchObject({ code: 'onebot_disconnected', outcome: 'unknown' })
    await delay(40)
    expect(value.getStatus().state).toBe('disconnected')
    expect(remote.peers).toHaveLength(1)
  })

  it('cancels a scheduled reconnection when manually disconnected', async () => {
    const remote = await fixture()
    const value = client({ reconnectDelaysMs: [40] })
    await value.connect(config(remote.endpoint))
    remote.peers[0]!.close()
    await waitFor(() => expect(value.getStatus().state).toBe('reconnecting'))
    await value.disconnect()
    await delay(70)
    expect(remote.peers).toHaveLength(1)
    expect(value.getStatus().state).toBe('disconnected')
  })

  it('bounds reconnects even when every reconnection briefly passes health verification', async () => {
    const remote = await fixture()
    let keepClosing = true
    const value = client({ reconnectDelaysMs: [5, 10], onStatus: (status) => {
      if (keepClosing && status.state === 'connected') remote.peers.at(-1)?.close()
    } })
    await value.connect(config(remote.endpoint))
    await waitFor(() => expect(value.getStatus()).toMatchObject({ state: 'error', reconnectAttempt: 2 }))
    expect(remote.peers).toHaveLength(3)
    expect(value.getStatus().lastError).toContain('上限')
    keepClosing = false
    await value.connect(config(remote.endpoint))
    expect(value.getStatus()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    expect(remote.peers).toHaveLength(4)
  })

  it('also bounds reconnect attempts whose health check fails', async () => {
    let online = true
    const remote = await fixture({ onRequest: (request, peer) => {
      if (request.action !== 'get_status') return false
      reply(peer, request, { online, good: online })
      return true
    } })
    const value = client({ reconnectDelaysMs: [5, 10] })
    await value.connect(config(remote.endpoint))
    online = false
    remote.peers[0]!.close()
    await waitFor(() => expect(value.getStatus()).toMatchObject({ state: 'error', reconnectAttempt: 2 }))
    expect(remote.peers).toHaveLength(3)
  })

  it('rejects reconfigured pending work and ignores old connection messages and health responses', async () => {
    const old = await fixture({ onRequest: () => true })
    const current = await fixture({ login: { user_id: 222, nickname: '新连接' } })
    const onEvent = vi.fn()
    const value = client({ onEvent })
    const previous = errorFrom(value.connect(config(old.endpoint)))
    await waitFor(() => expect(old.requests).toHaveLength(2))
    for (const request of old.requests) reply(request.peer, request,
      request.action === 'get_login_info' ? { user_id: 111, nickname: '旧连接' } : { online: true, good: true })
    old.peers[0]!.send(JSON.stringify({ post_type: 'message', message_id: 11 }))
    await value.connect(config(current.endpoint))
    expect(await previous).toMatchObject({ code: 'onebot_reconfigured' })
    await delay(20)
    expect(value.getStatus()).toMatchObject({ state: 'connected', accountId: '222', accountName: '新连接' })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('immediately rejects established requests during reconfiguration without moving them to the new socket', async () => {
    const old = await fixture()
    const current = await fixture({ login: { user_id: 333, nickname: '替换连接' } })
    const value = client()
    await value.connect(config(old.endpoint))
    const pending = errorFrom(value.call('send_msg', {}, { timeoutMs: 5000 }))
    await waitFor(() => expect(old.requests).toHaveLength(3))
    await value.connect(config(current.endpoint))
    expect(await pending).toMatchObject({ code: 'onebot_reconfigured', outcome: 'unknown' })
    expect(current.requests.map((request) => request.action)).toEqual(['get_login_info', 'get_status'])
  })

  it('cancels an old delayed handshake before opening another endpoint', async () => {
    const old = await fixture({ holdHandshake: true })
    const current = await fixture({ login: { user_id: 444, nickname: '当前连接' } })
    const value = client()
    const previous = errorFrom(value.connect(config(old.endpoint)))
    await waitFor(() => expect(old.approvals).toHaveLength(1))
    await value.connect(config(current.endpoint))
    expect(await previous).toMatchObject({ code: 'onebot_reconfigured', outcome: 'not-sent' })
    old.approvals.shift()!()
    await delay(20)
    expect(value.getStatus()).toMatchObject({ state: 'connected', accountId: '444' })
    expect(old.requests).toHaveLength(0)
  })

  it('cancels an unfinished handshake on manual disconnect and cannot be revived by late approval', async () => {
    const remote = await fixture({ holdHandshake: true })
    const value = client({ reconnectDelaysMs: [5] })
    const connecting = errorFrom(value.connect(config(remote.endpoint)))
    await waitFor(() => expect(remote.approvals).toHaveLength(1))
    await value.disconnect()
    expect(await connecting).toMatchObject({ code: 'onebot_disconnected', outcome: 'not-sent' })
    remote.approvals.shift()!()
    await delay(20)
    expect(value.getStatus().state).toBe('disconnected')
    expect(remote.requests).toHaveLength(0)
  })

  it.each([
    { payload: '{broken', binary: false, code: 'onebot_malformed_message' },
    { payload: '[]', binary: false, code: 'onebot_malformed_message' },
    { payload: 'null', binary: false, code: 'onebot_malformed_message' },
    { payload: '{}', binary: true, code: 'onebot_binary_message' },
  ])('rejects malformed/binary transport frames ($code/$payload)', async ({ payload, binary, code }) => {
    const remote = await fixture()
    const onEvent = vi.fn()
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint))
    const pending = errorFrom(value.call('send_msg', {}, { timeoutMs: 5000 }))
    await waitFor(() => expect(remote.requests).toHaveLength(3))
    remote.peers[0]!.send(payload, { binary })
    expect(await pending).toMatchObject({ code, outcome: 'unknown' })
    expect(value.getStatus().state).toBe('error')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('bounds incoming payloads at the WebSocket parser and rejects pending side effects as unknown', async () => {
    const remote = await fixture()
    const value = client()
    await value.connect(config(remote.endpoint))
    const pending = errorFrom(value.call('send_msg', {}, { timeoutMs: 5000 }))
    await waitFor(() => expect(remote.requests).toHaveLength(3))
    remote.peers[0]!.send('x'.repeat(1024 * 1024 + 1))
    expect(await pending).toMatchObject({ code: 'onebot_payload_too_large', outcome: 'unknown' })
    expect(value.getStatus().state).toBe('error')
  })

  it('rejects oversized outgoing requests before sending them', async () => {
    const remote = await fixture()
    const value = client()
    await value.connect(config(remote.endpoint))
    expect(await errorFrom(value.call('send_msg', { message: 'x'.repeat(1024 * 1024) }))).toMatchObject({ code: 'onebot_payload_too_large', outcome: 'not-sent' })
    expect(remote.requests).toHaveLength(2)
  })

  it('ignores unknown, missing, non-string and duplicate echoes without resolving a different action', async () => {
    const onEvent = vi.fn()
    const remote = await fixture()
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint))
    let settled = false
    const pending = value.call('send_msg', {}).finally(() => { settled = true })
    await waitFor(() => expect(remote.requests).toHaveLength(3))
    const request = remote.requests[2]!
    for (const echo of ['unknown-echo', 123, null, { nested: request.echo }]) {
      request.peer.send(JSON.stringify({ status: 'ok', retcode: 0, data: 'wrong', echo }))
    }
    request.peer.send(JSON.stringify({ status: 'ok', retcode: 0, data: 'missing echo' }))
    request.peer.send(JSON.stringify({ post_type: 'notice', echo: request.echo }))
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    reply(request.peer, request, { message_id: 18 })
    expect(await pending).toEqual({ message_id: 18 })
    reply(request.peer, request, { message_id: 19 })
    await waitFor(() => expect(value.getStatus().lastError).toContain('无法关联'))
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(value.getStatus().state).toBe('connected')
  })

  it.each([
    'http://127.0.0.1:1234/', 'ws://user:password@127.0.0.1:1234/',
    'ws://127.0.0.1:1234/?access_token=secret', 'ws://127.0.0.1:1234/?token=secret',
    'ws://127.0.0.1:1234/?', 'ws://127.0.0.1:1234/#',
    'ws://127.0.0.1:1234/#fragment', 'ws://127.0.0.1:1234/api',
    'ws://127.0.0.1:1234/event/', ' ws://127.0.0.1:1234/',
  ])('rejects unsafe or split endpoint %s without echoing it into errors', async (endpoint) => {
    const value = client()
    const error = await errorFrom(value.connect(config(endpoint)))
    expect(error).toMatchObject({ code: 'onebot_invalid_endpoint', outcome: 'not-sent' })
    expect(error.message).not.toContain(endpoint)
    expect(error.message).not.toContain('password')
    expect(error.message).not.toContain('secret')
  })

  it('preserves a healthy connection when a replacement configuration is invalid', async () => {
    const remote = await fixture()
    const value = client()
    await value.connect(config(remote.endpoint))
    await errorFrom(value.connect(config('ws://invalid/?access_token=unsafe')))
    expect(value.getStatus().state).toBe('connected')
    expect(remote.peers).toHaveLength(1)
  })

  it('reports handshake authorization rejection without disclosing the token', async () => {
    const remote = await fixture({ rejectHandshake: 403 })
    const accessToken = randomUUID()
    const value = client()
    const error = await errorFrom(value.connect(config(remote.endpoint, { accessToken })))
    expect(error).toMatchObject({ code: 'onebot_unauthorized', outcome: 'not-sent' })
    expect(error.message).not.toContain(accessToken)
    expect(value.getStatus()).toMatchObject({ state: 'error', accountId: null })
    expect(JSON.stringify(value.getStatus())).not.toContain(accessToken)
  })

  it('reports a refused socket connection and never reports connected', async () => {
    const remote = await fixture()
    await remote.close()
    const states: string[] = []
    const value = client({ onStatus: (status) => states.push(status.state) })
    expect(await errorFrom(value.connect(config(remote.endpoint)))).toMatchObject({ code: 'onebot_connection_failed' })
    expect(value.getStatus().state).toBe('error')
    expect(states).not.toContain('connected')
  })

  it('times out an unfinished WebSocket handshake', async () => {
    const remote = await fixture({ holdHandshake: true })
    const value = client()
    expect(await errorFrom(value.connect(config(remote.endpoint, { timeoutMs: 30 })))).toMatchObject({ code: 'onebot_connection_timeout', outcome: 'not-sent' })
    expect(value.getStatus().state).toBe('error')
  })

  it('times out real health requests instead of treating open as online', async () => {
    const remote = await fixture({ onRequest: () => true })
    const value = client()
    expect(await errorFrom(value.connect(config(remote.endpoint, { timeoutMs: 30 })))).toMatchObject({ code: 'onebot_request_timeout', outcome: 'failed' })
    expect(value.getStatus().state).toBe('error')
  })

  it('rejects invalid request data and timeout values before sending an action', async () => {
    const remote = await fixture()
    const value = client()
    await value.connect(config(remote.endpoint))
    expect(await errorFrom(value.call('send_msg', {}, { timeoutMs: 0 }))).toMatchObject({ code: 'onebot_invalid_timeout', outcome: 'not-sent' })
    const cyclic: JsonObject = {}
    cyclic.self = cyclic
    expect(await errorFrom(value.call('send_msg', cyclic))).toMatchObject({ code: 'onebot_invalid_request', outcome: 'not-sent' })
    expect(await errorFrom(value.call('', {}))).toMatchObject({ code: 'onebot_invalid_request', outcome: 'not-sent' })
    expect(remote.requests).toHaveLength(2)
  })

  it('clears handshake, request, heartbeat and stable-connection timers when disposed', async () => {
    const remote = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = client()
    await value.connect(config(remote.endpoint))
    const pending = errorFrom(value.call('send_msg', {}))
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3)
    await value.dispose()
    expect(await pending).toMatchObject({ outcome: 'unknown' })
    expect(vi.getTimerCount()).toBe(0)
    await value.dispose()
    expect(await errorFrom(value.connect(config(remote.endpoint)))).toMatchObject({ code: 'onebot_disposed', outcome: 'not-sent' })
  })

  it('uses transport ping/pong without fabricating a platform event', async () => {
    const remote = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onEvent = vi.fn()
    const value = client({ onEvent })
    await value.connect(config(remote.endpoint))
    const ping = once(remote.peers[0]!, 'ping')
    await vi.advanceTimersByTimeAsync(30000)
    await ping
    await delay(10)
    await vi.advanceTimersByTimeAsync(10000)
    expect(value.getStatus().state).toBe('connected')
    expect(value.getStatus().lastEventAt).toBeNull()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('detects a missing pong and closes the connection', async () => {
    const remote = await fixture({ autoPong: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = client()
    await value.connect(config(remote.endpoint))
    const ping = once(remote.peers[0]!, 'ping')
    await vi.advanceTimersByTimeAsync(30000)
    await ping
    await vi.advanceTimersByTimeAsync(10000)
    expect(value.getStatus().state).toBe('error')
    expect(value.getStatus().lastError).toContain('存活检查')
  })

  it('replenishes reconnect budget only after a stable healthy interval', async () => {
    const remote = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = client({ reconnectDelaysMs: [5] })
    await value.connect(config(remote.endpoint))
    const closed = once(remote.peers[0]!, 'close')
    remote.peers[0]!.close()
    await closed
    await delay(10)
    expect(value.getStatus()).toMatchObject({ state: 'reconnecting', reconnectAttempt: 1 })
    await vi.advanceTimersByTimeAsync(5)
    // Network I/O remains real while only the protocol deadlines use a controlled clock.
    for (let attempt = 0; attempt < 30 && value.getStatus().state !== 'connected'; attempt++) await delay(5)
    expect(value.getStatus()).toMatchObject({ state: 'connected', reconnectAttempt: 1 })
    const ping = once(remote.peers[1]!, 'ping')
    await vi.advanceTimersByTimeAsync(30000)
    await ping
    await delay(10)
    expect(value.getStatus()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    const closedAgain = once(remote.peers[1]!, 'close')
    remote.peers[1]!.close()
    await closedAgain
    await delay(10)
    expect(value.getStatus()).toMatchObject({ state: 'reconnecting', reconnectAttempt: 1 })
  })
})
