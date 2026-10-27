import type { OneBotConfig } from './config'
import { createHash } from 'node:crypto'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { BackendPlugin, BackendPluginEntry, ConnectionStatus, HarnessEvent, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { OneBotClient } from './backend/onebot'
import { qqTools, validateToolInput } from './backend/operations'
import { QQConfigurationFile } from './backend/config-file'
import { QQAccountRegistry } from './backend/accounts'
import { LiveLogChannel } from './backend/live-logs'

const initialConfiguration: OneBotConfig = { displayName: 'QQ', endpoint: '', accessToken: '', autoConnect: false,
  forwardToHarness: true, receiveGroups: true, timeoutMs: 10000 }

function asId(value: JsonValue | undefined): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value)) return value
  return null
}

function textFromMessage(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(segment => {
    if (!isJsonObject(segment)) return ''
    if (segment.type === 'text' && isJsonObject(segment.data) && typeof segment.data.text === 'string') return segment.data.text
    return typeof segment.type === 'string' ? `[${segment.type}]` : ''
  }).join('')
}

function parseConfiguration(input: unknown, previous: OneBotConfig): OneBotConfig {
  if (!isJsonObject(input)) throw new PlatformError('INVALID_CONFIGURATION', 'QQ 配置必须是对象。')
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : previous.displayName
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : previous.endpoint
  if (!displayName || displayName.length > 40) throw new PlatformError('INVALID_CONFIGURATION', '显示名称需为1至40个字符。')
  let url: URL
  try { url = new URL(endpoint) } catch { throw new PlatformError('INVALID_CONFIGURATION', '请填写有效的 ws:// 或 wss:// OneBot 地址。') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new PlatformError('INVALID_CONFIGURATION', 'OneBot 地址只能使用 ws/wss，不要在地址中填写令牌、账号、查询参数或片段。')
  if (/\/(?:api|event)\/?$/.test(url.pathname)) throw new PlatformError('INVALID_CONFIGURATION', '请使用同时支持 API 和事件的统一 WebSocket 端点，不要使用 /api 或 /event 分离接口。')
  const token = input.clearAccessToken === true ? '' : typeof input.accessToken === 'string' && input.accessToken.length > 0 ? input.accessToken : previous.accessToken
  if (token.length > 4096 || /[\r\n]/.test(token)) throw new PlatformError('INVALID_CONFIGURATION', '访问令牌格式不正确。')
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : previous.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new PlatformError('INVALID_CONFIGURATION', '请求超时需在1000至60000毫秒之间。')
  for (const key of ['autoConnect', 'forwardToHarness', 'receiveGroups']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new PlatformError('INVALID_CONFIGURATION', `参数 ${key} 需为布尔值。`)
  return { displayName, endpoint: url.toString(), accessToken: token, timeoutMs,
    autoConnect: typeof input.autoConnect === 'boolean' ? input.autoConnect : previous.autoConnect,
    forwardToHarness: typeof input.forwardToHarness === 'boolean' ? input.forwardToHarness : previous.forwardToHarness,
    receiveGroups: typeof input.receiveGroups === 'boolean' ? input.receiveGroups : previous.receiveGroups }
}

class QQPlugin implements BackendPlugin {
  readonly id = 'qq'
  readonly name = 'QQ'
  readonly version = '0.6.0'
  readonly logs = new LiveLogChannel()
  readonly tools = qqTools
  readonly capabilities = [
    { id: 'onebot.v11.forward-websocket', name: 'OneBot v11 正向 WebSocket', support: 'supported' as const, description: '统一端点接收事件并调用标准 API，支持 Bearer 认证与有限重连。' },
    ...qqTools.map(tool => ({ id: tool.name, name: tool.title, support: 'supported' as const, description: tool.description, toolName: tool.name })),
    { id: 'qzone.publish', name: 'QQ 空间发布', support: 'unsupported' as const, description: '不属于 OneBot v11 标准，本版没有提供实现；后续由独立扩展能力接入。' },
    { id: 'qzone.comment', name: 'QQ 空间评论/回复', support: 'unsupported' as const, description: '不属于 OneBot v11 标准，需核对具体协议端扩展，未提供对应工具。' },
    { id: 'onebot.v11.reverse-websocket', name: '反向 WebSocket', support: 'unsupported' as const, description: '当前版本使用正向统一端点；反向连接暂未实现。' },
  ]
  private configuration: OneBotConfig
  private readonly file: QQConfigurationFile
  private readonly accounts: QQAccountRegistry
  private readonly instanceId: string
  private readonly client: OneBotClient

  constructor(private readonly context: HostPluginContext) {
    this.accounts = new QQAccountRegistry(context.dataDirectory)
    this.instanceId = this.accounts.defaultInstanceId
    this.file = new QQConfigurationFile(this.accounts.directoryFor(this.instanceId))
    const saved = this.file.read()
    this.configuration = saved ? parseConfiguration(saved, initialConfiguration) : initialConfiguration
    this.client = new OneBotClient({ onEvent: event => this.receiveEvent(event) })
  }

  getStatus(): ConnectionStatus {
    if (!this.configuration.endpoint) return { state: 'unconfigured', accountId: null, accountName: null,
      lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
    return this.client.getStatus()
  }

  getPublicConfiguration(): JsonObject {
    const { accessToken, ...publicValues } = this.configuration
    return { ...publicValues, tokenConfigured: Boolean(accessToken), configurationPath: this.file.filePath, dataDirectory: this.file.directory, updatedAt: this.file.updatedAt,
      instanceId: this.instanceId, defaultInstanceId: this.accounts.defaultInstanceId, instances: this.accounts.instances.map(instance => ({ ...instance })) }
  }

  async updateConfiguration(input: unknown): Promise<JsonObject> {
    const next = parseConfiguration(input, this.configuration)
    this.file.write({ ...next })
    await this.client.disconnect()
    this.configuration = next
    return this.getPublicConfiguration()
  }

  async connect(): Promise<void> {
    if (!this.configuration.endpoint) throw new PlatformError('NOT_CONFIGURED', '请先保存 OneBot 地址。', 409, 'not-sent')
    await this.client.connect(this.configuration)
  }
  async disconnect(): Promise<void> { await this.client.disconnect() }
  async dispose(): Promise<void> {
    try { await this.client.dispose() }
    finally { this.logs.dispose() }
  }

  async invoke(name: string, input: unknown, requestId: string): Promise<JsonValue> {
    const tool = this.tools.find(entry => entry.name === name)
    if (!tool) throw new PlatformError('TOOL_NOT_FOUND', '此 QQ 功能未提供。', 404, 'not-sent')
    const params = validateToolInput(tool, input)
    if (params.instance_id !== undefined && params.instance_id !== this.instanceId) throw new PlatformError('ACCOUNT_INSTANCE_NOT_ACTIVE', '此账号实例当前未启用。本版本只支持默认账号，未自动切换。', 409, 'not-sent')
    const map: Record<string, string> = { qq_get_login_info: 'get_login_info', qq_get_status: 'get_status', qq_get_version_info: 'get_version_info',
      qq_get_friend_list: 'get_friend_list', qq_get_group_list: 'get_group_list', qq_get_message: 'get_msg',
      qq_send_private_message: 'send_private_msg', qq_send_group_message: 'send_group_msg', qq_delete_message: 'delete_msg' }
    const action = map[name]
    if (!action) throw new PlatformError('TOOL_NOT_FOUND', '工具映射不存在。', 404, 'not-sent')
    const forwarded: JsonObject = { ...params }
    delete forwarded.request_id
    delete forwarded.instance_id
    for (const key of ['user_id', 'group_id', 'message_id']) {
      if (forwarded[key] !== undefined) {
        const identifier = Number(forwarded[key])
        if (!Number.isSafeInteger(identifier) || key === 'message_id' && (identifier < -2147483648 || identifier > 2147483647)) throw new PlatformError('INVALID_IDENTIFIER', `参数 ${key} 超出 OneBot v11 安全整数范围。`, 400, 'not-sent')
        forwarded[key] = identifier
      }
    }
    if (name.startsWith('qq_send_')) forwarded.auto_escape = true
    const execute = () => this.client.call(action, forwarded, { timeoutMs: this.configuration.timeoutMs, readOnly: tool.readOnly })
    if (tool.readOnly) return execute()
    const accountId = this.client.getStatus().accountId
    if (!accountId || this.client.getStatus().state !== 'connected') throw new PlatformError('NOT_CONNECTED', '账号尚未连接，未发送动作。', 409, 'not-sent')
    return this.context.executeIdempotent(this.id, action, forwarded, typeof params.request_id === 'string' ? params.request_id : requestId, execute, { instanceId: this.instanceId, accountId })
  }

  private receiveEvent(event: JsonObject): void {
    if (event.post_type !== 'message' || !['private', 'group'].includes(String(event.message_type))) return
    const accountId = asId(event.self_id)
    const senderId = asId(event.user_id)
    const messageId = asId(event.message_id)
    if (!accountId || !senderId || !messageId) throw new PlatformError('INVALID_MESSAGE_EVENT', 'OneBot 消息缺少有效的账号、发送者或消息标识。')
    const kind = event.message_type === 'group' ? 'group' : 'private'
    const targetId = kind === 'group' ? asId(event.group_id) : senderId
    if (!targetId) throw new PlatformError('INVALID_MESSAGE_EVENT', '群消息缺少有效的 group_id。')
    const conversationId = `qq:${accountId}:${kind}:${targetId}`
    const text = textFromMessage(event.message)
    const receivedAt = new Date().toISOString()
    const key = `${this.instanceId}:${accountId}:${kind}:${targetId}:${messageId}`
    const eventId = createHash('sha256').update(`qq:${key}`).digest('hex')
    const shouldForward = senderId !== accountId && this.configuration.forwardToHarness && (kind === 'private' || this.configuration.receiveGroups)
    const harness: HarnessEvent | null = shouldForward ? { protocolVersion: 1, eventId, pluginId: this.id, instanceId: this.instanceId,
      platform: 'qq', accountId, conversationId, senderId, messageId, targetId, receivedAt,
      source: { trust: 'external', kind }, content: event.message ?? '', text } : null
    const { inserted, admission } = this.context.recordEvent(this.id, key, event, harness, { conversationId, text, instanceId: this.instanceId })
    if (inserted) this.logs.publish(() => {
      const token = this.configuration.accessToken
      const preview = token ? text.split(token).join('[已隐藏令牌]') : text
      return { id: eventId, timestamp: receivedAt, level: 'info', event: 'message.received', message: preview.slice(0, 500),
        metadata: { kind, accountId, instanceId: this.instanceId, conversationId, senderId, messageId,
          queueAdmission: admission ?? (shouldForward ? 'queued' : 'not-forwarded'),
          ...(kind === 'group' ? { groupId: targetId } : {}) } }
    })
  }
}

const entry: BackendPluginEntry = { id: 'qq', storageDirectory: 'qq-bot', create: context => new QQPlugin(context) }
export default entry
