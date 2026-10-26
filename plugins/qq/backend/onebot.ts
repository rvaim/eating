import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { isJsonObject, PlatformError } from '../../../packages/platform-contract/src/index.ts'
import type { ConnectionStatus, JsonObject, JsonValue, OneBotConfig } from '../../../packages/platform-contract/src/index.ts'

// OneBot v11 d4456ee706f9ada9c2dfde56a2bcfc69752600e4:
// communication/{ws,authorization,http}.md and api/{public,README}.md.
// One forward WebSocket endpoint must carry both API responses and events.
const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_PENDING_REQUESTS = 1024
const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const
const STABLE_CONNECTION_MS = 30000
const PING_INTERVAL_MS = 30000
const PONG_TIMEOUT_MS = 10000
const MAX_TIMER_MS = 2147483647

type Timer = ReturnType<typeof setTimeout>
type ClientOptions = {
  onEvent: (event: JsonObject) => void
  onStatus?: (status: ConnectionStatus) => void
  requestTimeoutMs?: number
  reconnectDelaysMs?: readonly number[]
}
type PendingRequest = {
  action: string
  resolve: (data: JsonValue) => void
  reject: (error: PlatformError) => void
  timer: Timer
  readOnly: boolean
  sent: boolean
}
type Session = {
  generation: number
  config: OneBotConfig
  socket: WebSocket
  pending: Map<string, PendingRequest>
  ready: boolean
  settled: boolean
  reconnecting: boolean
  resolve: () => void
  reject: (error: PlatformError) => void
  handshakeTimer: Timer | null
  heartbeatTimer: Timer | null
  pongTimer: Timer | null
  stableTimer: Timer | null
  pingPayload: string | null
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new PlatformError('onebot_invalid_timeout', 'OneBot 超时必须为有效的正整数毫秒数', 400, 'not-sent')
  }
  return value
}

function validateConfiguration(config: OneBotConfig): OneBotConfig {
  let endpoint: URL
  try {
    if (typeof config?.endpoint !== 'string' || config.endpoint.length > 4096
      || /[\s\u0000-\u001f\u007f]/u.test(config.endpoint)) throw new Error()
    endpoint = new URL(config.endpoint)
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || !endpoint.hostname
      || endpoint.username || endpoint.password || config.endpoint.includes('@')
      || config.endpoint.includes('?') || config.endpoint.includes('#')) throw new Error()
    if (/^\/(api|event)\/?$/u.test(endpoint.pathname)) throw new Error()
  } catch {
    throw new PlatformError('onebot_invalid_endpoint', '请提供 ws/wss 统一端点；地址不能包含凭据、查询参数或片段，也不能使用独立 /api 或 /event 端点', 400, 'not-sent')
  }
  if (typeof config.accessToken !== 'string' || config.accessToken.length > 8192
    || /[^\x21-\x7e]/u.test(config.accessToken)) {
    throw new PlatformError('onebot_invalid_token', 'OneBot 访问令牌格式无效', 400, 'not-sent')
  }
  validateTimeout(config.timeoutMs)
  return { ...config, endpoint: endpoint.href }
}

function requestError(pending: PendingRequest, code: string, message: string, statusCode = 502): PlatformError {
  return new PlatformError(code, message, statusCode, pending.sent ? (pending.readOnly ? 'failed' : 'unknown') : 'not-sent')
}

export class OneBotClient {
  private readonly onEvent: ClientOptions['onEvent']
  private readonly onStatus: ClientOptions['onStatus']
  private readonly requestTimeoutMs: number | undefined
  private readonly reconnectDelaysMs: readonly number[]
  private status: ConnectionStatus = {
    state: 'unconfigured', accountId: null, accountName: null, lastError: null,
    connectedAt: null, lastEventAt: null, reconnectAttempt: 0,
  }
  private session: Session | null = null
  private activeConfig: OneBotConfig | null = null
  private reconnectTimer: Timer | null = null
  private reconnectAttempt = 0
  private generation = 0
  private configured = false
  private disposed = false

  constructor(options: ClientOptions) {
    this.onEvent = options.onEvent
    this.onStatus = options.onStatus
    this.requestTimeoutMs = options.requestTimeoutMs === undefined ? undefined : validateTimeout(options.requestTimeoutMs)
    const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS
    if (delays.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > MAX_TIMER_MS)) {
      throw new PlatformError('onebot_invalid_reconnect_delays', 'OneBot 重连间隔必须为有效的非负整数毫秒数', 400, 'not-sent')
    }
    this.reconnectDelaysMs = [...delays]
  }

  getStatus(): ConnectionStatus {
    return { ...this.status }
  }

  async connect(config: OneBotConfig): Promise<void> {
    if (this.disposed) throw new PlatformError('onebot_disposed', 'OneBot 客户端已释放', 409, 'not-sent')
    // Validate before replacing a healthy connection. Never expose raw URLs or tokens in errors.
    const validated = validateConfiguration(config)
    const generation = ++this.generation
    this.cancelReconnect()
    const previous = this.session
    this.session = null
    if (previous) this.retire(previous, new PlatformError('onebot_reconfigured', 'OneBot 连接已重新配置', 409, 'not-sent'))
    this.activeConfig = validated
    this.configured = true
    this.reconnectAttempt = 0
    this.publish({
      state: 'connecting', accountId: null, accountName: null, connectedAt: null,
      lastEventAt: null, lastError: null, reconnectAttempt: 0,
    })
    if (!this.isActive(generation, validated)) {
      throw new PlatformError('onebot_connect_cancelled', 'OneBot 连接已取消', 409, 'not-sent')
    }
    await this.open(validated, generation, false)
  }

  async disconnect(): Promise<void> {
    ++this.generation
    this.activeConfig = null
    this.cancelReconnect()
    const previous = this.session
    this.session = null
    if (previous) this.retire(previous, new PlatformError('onebot_disconnected', 'OneBot 已手动断开', 409, 'not-sent'))
    this.reconnectAttempt = 0
    this.publish({ state: this.configured ? 'disconnected' : 'unconfigured', connectedAt: null, reconnectAttempt: 0 })
  }

  async call(action: string, params: JsonObject, options?: { timeoutMs?: number; readOnly?: boolean }): Promise<JsonValue> {
    const session = this.session
    if (!session?.ready || !this.isCurrent(session) || session.socket.readyState !== WebSocket.OPEN) {
      throw new PlatformError('onebot_not_connected', 'OneBot 尚未通过在线核验', 409, 'not-sent')
    }
    return this.request(session, action, params, options?.timeoutMs, options?.readOnly === true)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.disconnect()
  }

  private isActive(generation: number, config: OneBotConfig): boolean {
    return !this.disposed && this.generation === generation && this.activeConfig === config
  }

  private isCurrent(session: Session): boolean {
    return this.session === session && this.isActive(session.generation, session.config)
  }

  private publish(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch }
    const generation = this.generation
    try {
      const returned: unknown = this.onStatus?.(this.getStatus())
      void Promise.resolve(returned).catch(() => this.statusCallbackFailed(generation))
    } catch {
      this.statusCallbackFailed(generation)
    }
  }

  private statusCallbackFailed(generation: number): void {
    if (this.generation === generation) this.status = { ...this.status, lastError: 'OneBot 状态回调执行失败' }
  }

  private open(config: OneBotConfig, generation: number, reconnecting: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(config.endpoint, {
          headers: config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {},
          followRedirects: false, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false,
        })
      } catch {
        const error = new PlatformError('onebot_connection_failed', '无法建立 OneBot WebSocket 连接', 502, 'not-sent')
        reject(error)
        if (this.isActive(generation, config)) {
          if (reconnecting) this.scheduleReconnect(generation, config, error)
          else this.publish({ state: 'error', connectedAt: null, lastError: error.message })
        }
        return
      }
      const session: Session = {
        generation, config, socket, pending: new Map(), ready: false, settled: false,
        reconnecting, resolve, reject, handshakeTimer: null, heartbeatTimer: null,
        pongTimer: null, stableTimer: null, pingPayload: null,
      }
      this.session = session
      session.handshakeTimer = setTimeout(() => this.fail(session,
        new PlatformError('onebot_connection_timeout', 'OneBot WebSocket 握手超时', 504, 'not-sent')),
      this.timeout(session))
      socket.on('open', () => {
        if (!this.isCurrent(session)) { socket.terminate(); return }
        if (session.handshakeTimer) clearTimeout(session.handshakeTimer)
        session.handshakeTimer = null
        void this.checkHealth(session)
      })
      socket.on('message', (data, binary) => this.receive(session, data, binary))
      socket.on('pong', (data) => {
        if (!this.isCurrent(session) || session.pingPayload !== data.toString()) return
        if (session.pongTimer) clearTimeout(session.pongTimer)
        session.pongTimer = null
        session.pingPayload = null
        this.schedulePing(session)
      })
      socket.on('unexpected-response', (request, response) => {
        response.resume()
        request.destroy()
        const unauthorized = response.statusCode === 401 || response.statusCode === 403
        this.fail(session, new PlatformError(unauthorized ? 'onebot_unauthorized' : 'onebot_handshake_rejected',
          unauthorized ? 'OneBot 鉴权失败，请检查访问令牌' : 'OneBot 服务拒绝 WebSocket 握手', unauthorized ? 401 : 502, 'not-sent'))
      })
      // Never forward transport messages: they can contain server-provided secrets or URLs.
      socket.on('error', (error: Error & { code?: string }) => this.fail(session,
        error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ? new PlatformError('onebot_payload_too_large', 'OneBot 消息超过大小上限', 502, 'failed')
          : new PlatformError('onebot_connection_failed', 'OneBot WebSocket 连接失败', 502, 'failed')))
      socket.on('close', () => this.fail(session,
        new PlatformError('onebot_connection_closed', 'OneBot WebSocket 连接已关闭', 502, 'failed')))
    })
  }

  private timeout(session: Session, override?: number): number {
    return validateTimeout(override ?? this.requestTimeoutMs ?? session.config.timeoutMs)
  }

  private async checkHealth(session: Session): Promise<void> {
    try {
      const [login, health] = await Promise.all([
        this.request(session, 'get_login_info', {}, undefined, true),
        this.request(session, 'get_status', {}, undefined, true),
      ])
      if (!this.isCurrent(session)) return
      if (!isJsonObject(login) || !(
        (typeof login.user_id === 'number' && Number.isSafeInteger(login.user_id) && login.user_id > 0)
        || (typeof login.user_id === 'string' && /^[1-9]\d{0,19}$/u.test(login.user_id))
      ) || typeof login.nickname !== 'string') {
        throw new PlatformError('onebot_invalid_login_info', 'OneBot 返回的登录信息无效', 502, 'failed')
      }
      this.publish({ accountId: String(login.user_id), accountName: login.nickname })
      if (!this.isCurrent(session)) return
      if (!isJsonObject(health) || health.online !== true || health.good !== true) {
        throw new PlatformError('onebot_account_not_online', 'OneBot 未确认 QQ 在线且运行正常', 503, 'failed')
      }
      session.ready = true
      session.settled = true
      // A flapping server must stay healthy before it earns a fresh retry budget.
      session.stableTimer = setTimeout(() => {
        if (!this.isCurrent(session) || !session.ready) return
        session.stableTimer = null
        this.reconnectAttempt = 0
        this.publish({ reconnectAttempt: 0 })
      }, STABLE_CONNECTION_MS)
      this.schedulePing(session)
      this.publish({ state: 'connected', connectedAt: new Date().toISOString(), reconnectAttempt: this.reconnectAttempt })
      session.resolve()
    } catch (error) {
      this.fail(session, error instanceof PlatformError ? error
        : new PlatformError('onebot_health_check_failed', 'OneBot 在线核验失败', 502, 'failed'))
    }
  }

  private request(session: Session, action: string, params: JsonObject, timeoutMs: number | undefined, readOnly: boolean): Promise<JsonValue> {
    if (!this.isCurrent(session) || session.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new PlatformError('onebot_not_connected', 'OneBot 连接不可用', 409, 'not-sent'))
    }
    let wire: string
    const echo = randomUUID()
    try {
      if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(action) || !isJsonObject(params)) throw new Error()
      wire = JSON.stringify({ action, params, echo })
    } catch {
      return Promise.reject(new PlatformError('onebot_invalid_request', 'OneBot 请求必须包含有效动作与 JSON 参数', 400, 'not-sent'))
    }
    if (Buffer.byteLength(wire) > MAX_PAYLOAD_BYTES) {
      return Promise.reject(new PlatformError('onebot_payload_too_large', 'OneBot 请求超过大小上限', 413, 'not-sent'))
    }
    if (session.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new PlatformError('onebot_too_many_requests', 'OneBot 未完成请求过多', 429, 'not-sent'))
    }
    const timeout = this.timeout(session, timeoutMs)
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        action, resolve, reject, readOnly, sent: false,
        timer: setTimeout(() => {
          if (!session.pending.delete(echo)) return
          const error = requestError(pending, 'onebot_request_timeout',
            readOnly ? 'OneBot 查询超时' : 'OneBot 请求超时，执行结果未知，请先核对实际结果', 504)
          reject(error)
          if (this.isCurrent(session)) this.publish({ lastError: error.message })
        }, timeout),
      }
      session.pending.set(echo, pending)
      // Once handed to the transport, a side effect may have happened even if a
      // later callback reports an error. It is never automatically re-sent.
      pending.sent = true
      try {
        session.socket.send(wire, (error) => {
          if (error) this.fail(session, new PlatformError('onebot_send_failed', 'OneBot 传输中断，未完成请求的结果需要核对', 502, 'failed'))
        })
      } catch {
        this.fail(session, new PlatformError('onebot_send_failed', 'OneBot 传输中断，未完成请求的结果需要核对', 502, 'failed'))
      }
    })
  }

  private receive(session: Session, raw: RawData, binary: boolean): void {
    if (!this.isCurrent(session)) return
    if (binary) {
      this.fail(session, new PlatformError('onebot_binary_message', 'OneBot 仅接受 JSON 文本消息', 502, 'failed'))
      return
    }
    let message: JsonObject
    try {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
        this.fail(session, new PlatformError('onebot_payload_too_large', 'OneBot 消息超过大小上限', 502, 'failed'))
        return
      }
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      if (!isJsonObject(parsed)) throw new Error()
      message = parsed
    } catch {
      this.fail(session, new PlatformError('onebot_malformed_message', 'OneBot 返回了无效 JSON 对象', 502, 'failed'))
      return
    }
    if (typeof message.post_type === 'string' && message.post_type.length > 0) {
      this.publish({ lastEventAt: new Date().toISOString() })
      if (!this.isCurrent(session)) return
      if (message.post_type === 'meta_event' && message.meta_event_type === 'heartbeat'
        && isJsonObject(message.status) && (message.status.online !== true || message.status.good !== true)) {
        this.fail(session, new PlatformError('onebot_account_not_online', 'OneBot 心跳未确认 QQ 在线且运行正常', 503, 'failed'))
      }
      // Deliver the actual event even when its health status invalidated this socket.
      try {
        const returned: unknown = this.onEvent(message)
        void Promise.resolve(returned).catch(() => {
          if (this.isCurrent(session)) this.publish({ lastError: 'OneBot 事件回调执行失败' })
        })
      } catch {
        if (this.isCurrent(session)) this.publish({ lastError: 'OneBot 事件回调执行失败' })
      }
      return
    }
    const pending = typeof message.echo === 'string' ? session.pending.get(message.echo) : undefined
    if (!pending || typeof message.echo !== 'string') {
      // Late replies must not consume another echo, become an event, or replay an action.
      this.publish({ lastError: '收到无法关联的 OneBot API 回应，请求可能已超时或回应格式无效' })
      return
    }
    session.pending.delete(message.echo)
    clearTimeout(pending.timer)
    let error: PlatformError | null = null
    if (message.status === 'async' || message.retcode === 1) {
      error = new PlatformError('onebot_async_pending', 'OneBot 已接受异步请求，最终执行结果尚未确定，请先核对实际结果', 502, 'unknown')
    } else if (message.status === 'ok' && message.retcode === 0 && Object.hasOwn(message, 'data')) {
      const data = message.data as JsonValue
      pending.resolve(data)
      if (pending.action === 'get_status' && session.ready
        && (!isJsonObject(data) || data.online !== true || data.good !== true)) {
        this.fail(session, new PlatformError('onebot_account_not_online', 'OneBot 状态查询未确认 QQ 在线且运行正常', 503, 'failed'))
      }
    } else if (message.status === 'failed' && typeof message.retcode === 'number'
      && Number.isSafeInteger(message.retcode) && message.retcode !== 0) {
      error = new PlatformError(`onebot_retcode_${message.retcode}`, `OneBot API 执行失败（retcode ${message.retcode}）`, 502, 'failed')
    } else {
      error = requestError(pending, 'onebot_invalid_response', 'OneBot API 回应的 status、retcode 或 data 无效')
    }
    if (error) {
      pending.reject(error)
      this.publish({ lastError: error.message })
    }
  }

  private schedulePing(session: Session): void {
    if (!this.isCurrent(session) || !session.ready) return
    session.heartbeatTimer = setTimeout(() => {
      session.heartbeatTimer = null
      if (!this.isCurrent(session)) return
      session.pingPayload = randomUUID()
      session.pongTimer = setTimeout(() => this.fail(session,
        new PlatformError('onebot_heartbeat_timeout', 'OneBot WebSocket 未回应存活检查', 504, 'failed')), PONG_TIMEOUT_MS)
      try {
        session.socket.ping(session.pingPayload, undefined, (error?: Error) => {
          if (error) this.fail(session, new PlatformError('onebot_heartbeat_failed', 'OneBot WebSocket 存活检查发送失败', 502, 'failed'))
        })
      } catch {
        this.fail(session, new PlatformError('onebot_heartbeat_failed', 'OneBot WebSocket 存活检查发送失败', 502, 'failed'))
      }
    }, PING_INTERVAL_MS)
  }

  private fail(session: Session, error: PlatformError): void {
    if (!this.isCurrent(session)) return
    const retry = session.ready || session.reconnecting
    this.session = null
    this.retire(session, error)
    if (retry) this.scheduleReconnect(session.generation, session.config, error)
    else this.publish({ state: 'error', connectedAt: null, lastError: error.message })
  }

  private retire(session: Session, error: PlatformError): void {
    for (const timer of [session.handshakeTimer, session.heartbeatTimer, session.pongTimer, session.stableTimer]) {
      if (timer) clearTimeout(timer)
    }
    session.handshakeTimer = session.heartbeatTimer = session.pongTimer = session.stableTimer = null
    session.pingPayload = null
    session.ready = false
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(requestError(pending, error.code, error.message, error.statusCode))
    }
    session.pending.clear()
    if (!session.settled) {
      session.settled = true
      session.reject(error)
    }
    // Keep error/close handlers to absorb late events, guarded by session identity.
    if (session.socket.readyState !== WebSocket.CLOSED) session.socket.terminate()
  }

  private scheduleReconnect(generation: number, config: OneBotConfig, error: PlatformError): void {
    if (!this.isActive(generation, config)) return
    const delay = this.reconnectDelaysMs[this.reconnectAttempt]
    if (delay === undefined) {
      this.publish({ state: 'error', connectedAt: null, reconnectAttempt: this.reconnectAttempt,
        lastError: `${error.message}；OneBot 重连次数已达上限，请检查服务后手动连接` })
      return
    }
    ++this.reconnectAttempt
    this.reconnectTimer = setTimeout(() => {
      if (!this.isActive(generation, config)) return
      this.reconnectTimer = null
      void this.open(config, generation, true).catch(() => { /* fail() already reported and scheduled recovery. */ })
    }, delay)
    this.publish({ state: 'reconnecting', connectedAt: null, lastError: error.message, reconnectAttempt: this.reconnectAttempt })
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}
