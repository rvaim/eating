import type { OneBotConfig } from './config'
import { createHash } from 'node:crypto'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { AgentInvocationScope, BackendPlugin, BackendPluginEntry, ConnectionStatus, HarnessEvent, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { assertQQAgentInvocation, createDefaultAgentPolicy, parseQQAgentPolicy, parseQQAgentPolicySave, qqAgentInstructions, qqAgentTypes, qqMessageResourceIds, qqSenderRole } from './backend/agent-policy'
import { OneBotClient } from './backend/onebot'
import { qqTools, validateToolInput, prepareOneBotCall } from './backend/operations'
import { QQConfigurationFile, readConfiguration } from './backend/config-file'
import { QQAccountRegistry } from './backend/accounts'
import { LiveLogChannel } from './backend/live-logs'
import { downloadQQImage, qqViewReceivedImageTool, readQQReceivedImage } from './backend/media'

type Configuration = OneBotConfig

function createDefaultConfiguration(): Configuration {
  return { displayName: 'QQ', endpoint: '', accessToken: '', autoConnect: false,
    forwardToHarness: true, receiveGroups: true, timeoutMs: 10000, ...createDefaultAgentPolicy() }
}

function asId(value: JsonValue | undefined): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value)) return value
  return null
}

function asQQId(value: JsonValue | undefined): string | null {
  const id = asId(value)
  return id && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null
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

function parseConfiguration(input: unknown, previous: Configuration): Configuration {
  if (!isJsonObject(input) || Object.keys(input).some(key => !['displayName', 'endpoint', 'accessToken', 'autoConnect', 'forwardToHarness', 'receiveGroups', 'timeoutMs', 'clearAccessToken', 'owners', 'administrators', 'agentTools', 'policyRevision'].includes(key))) throw new PlatformError('INVALID_CONFIGURATION', 'QQ 配置必须是对象，且不能包含未知字段。')
  if (Object.hasOwn(input, 'clearAccessToken') && typeof input.clearAccessToken !== 'boolean') throw new PlatformError('INVALID_CONFIGURATION', '清除访问令牌设置需为布尔值。')
  const policy = parseQQAgentPolicy({
    owners: Object.hasOwn(input, 'owners') ? input.owners : previous.owners,
    administrators: Object.hasOwn(input, 'administrators') ? input.administrators : previous.administrators,
    agentTools: Object.hasOwn(input, 'agentTools') ? input.agentTools : previous.agentTools,
    policyRevision: Object.hasOwn(input, 'policyRevision') ? input.policyRevision : previous.policyRevision,
  })
  if (JSON.stringify(policy) !== JSON.stringify({ owners: previous.owners, administrators: previous.administrators, agentTools: previous.agentTools, policyRevision: previous.policyRevision })) throw new PlatformError('INVALID_AGENT_POLICY', '请在代理与权限页面保存身份和工具权限。', 400, 'not-sent')
  const { clearAccessToken, ...values } = input
  const next = readConfiguration({ ...previous, ...values,
    displayName: typeof input.displayName === 'string' ? input.displayName.trim() : Object.hasOwn(input, 'displayName') ? input.displayName : previous.displayName,
    endpoint: typeof input.endpoint === 'string' ? input.endpoint.trim() : Object.hasOwn(input, 'endpoint') ? input.endpoint : previous.endpoint,
    accessToken: clearAccessToken === true ? '' : input.accessToken === '' ? previous.accessToken : Object.hasOwn(input, 'accessToken') ? input.accessToken : previous.accessToken,
  })
  if (Object.hasOwn(input, 'endpoint') && !next.endpoint && previous.endpoint) throw new PlatformError('INVALID_CONFIGURATION', '请填写有效的 ws:// 或 wss:// OneBot 地址。')
  return { ...next, endpoint: next.endpoint ? new URL(next.endpoint).toString() : '' }
}

class QQPlugin implements BackendPlugin {
  readonly id = 'qq'
  readonly kind = 'communication' as const
  readonly name = 'QQ'
  readonly version = '0.10.1'
  readonly logs = new LiveLogChannel()
  readonly tools = [...qqTools, qqViewReceivedImageTool]
  readonly capabilities = [
    { id: 'onebot.v11.forward-websocket', name: 'OneBot v11 正向 WebSocket', support: 'supported' as const, description: '统一端点接收事件并调用标准 API，支持 Bearer 认证与有限重连。' },
    ...this.tools.map(tool => ({ id: tool.name, name: tool.title, support: 'supported' as const, description: tool.description, toolName: tool.name })),
  ]
  readonly agentInstructions = qqAgentInstructions
  get agentTypes() { return qqAgentTypes(this.configuration) }
  getAgentIdentity() { return { owners: [...this.configuration.owners], administrators: [...this.configuration.administrators] } }
  private configuration: Configuration
  private readonly file: QQConfigurationFile
  private readonly accounts: QQAccountRegistry
  private readonly instanceId: string
  private readonly client: OneBotClient

  constructor(private readonly context: HostPluginContext) {
    this.accounts = new QQAccountRegistry(context.dataDirectory)
    this.instanceId = this.accounts.defaultInstanceId
    this.file = new QQConfigurationFile(this.accounts.directoryFor(this.instanceId))
    this.configuration = this.file.read() ?? createDefaultConfiguration()
    this.client = new OneBotClient({ onEvent: event => this.receiveEvent(event) })
  }

  getStatus(): ConnectionStatus {
    if (!this.configuration.endpoint) return { state: 'unconfigured', accountId: null, accountName: null,
      lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
    return this.client.getStatus()
  }

  getPublicConfiguration(): JsonObject {
    const { accessToken, ...publicValues } = this.configuration
    return { ...structuredClone(publicValues), tokenConfigured: Boolean(accessToken), configurationPath: this.file.filePath, dataDirectory: this.file.directory, updatedAt: this.file.updatedAt,
      instanceId: this.instanceId, defaultInstanceId: this.accounts.defaultInstanceId, instances: this.accounts.instances.map(instance => ({ ...instance })) }
  }

  async updateConfiguration(input: unknown): Promise<JsonObject> {
    const next = parseConfiguration(input, this.configuration)
    this.file.write({ ...next })
    this.configuration = next
    await this.client.disconnect()
    return this.getPublicConfiguration()
  }

  async manage(operation: string, input: unknown): Promise<JsonValue> {
    if (operation !== 'save-agent-policy') throw new PlatformError('UNKNOWN_MANAGEMENT_OPERATION', '此 QQ 管理操作未提供。', 404, 'not-sent')
    const policy = parseQQAgentPolicySave(input, this.configuration)
    const next = { ...this.configuration, ...policy }
    this.file.write({ ...next })
    this.configuration = next
    return this.getPublicConfiguration()
  }

  async invokeScoped(name: string, input: unknown, requestId: string, scope: AgentInvocationScope): Promise<JsonValue> {
    // The Host alone supplies scope. No argument field can replace this binding.
    const tool = this.tools.find(entry => entry.name === name)
    assertQQAgentInvocation(name, undefined, scope, this.configuration, { instanceId: this.instanceId, accountId: this.client.getStatus().accountId })
    if (!tool) throw new PlatformError('AGENT_SCOPE_VIOLATION', '当前子代理未获准使用此 QQ 工具。', 403, 'not-sent')
    const params = validateToolInput(tool, input)
    assertQQAgentInvocation(name, params, scope, this.configuration, { instanceId: this.instanceId, accountId: this.client.getStatus().accountId })
    if (name === qqViewReceivedImageTool.name) return this.viewReceivedImage(params, scope)
    return this.invoke(name, params, requestId)
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
    if (name === qqViewReceivedImageTool.name) return this.viewReceivedImage(params)
    const { action, params: forwarded } = prepareOneBotCall(tool, params)
    if (tool.protocolAction === '.handle_quick_operation' && isJsonObject(forwarded.context)
      && forwarded.context.self_id !== undefined && String(forwarded.context.self_id) !== this.client.getStatus().accountId) {
      throw new PlatformError('INVALID_INPUT', '快速操作上下文不属于当前登录账号，未执行动作。', 400, 'not-sent')
    }
    const execute = () => this.client.call(action, forwarded, { timeoutMs: this.configuration.timeoutMs, readOnly: tool.readOnly })
    if (tool.readOnly) return execute()
    const accountId = this.client.getStatus().accountId
    if (!accountId || this.client.getStatus().state !== 'connected') throw new PlatformError('NOT_CONNECTED', '账号尚未连接，未发送动作。', 409, 'not-sent')
    return this.context.executeIdempotent(this.id, action, forwarded, typeof params.request_id === 'string' ? params.request_id : requestId, execute, { instanceId: this.instanceId, accountId })
  }

  private async viewReceivedImage(params: JsonObject, scope?: AgentInvocationScope): Promise<JsonObject> {
    const accountId = this.client.getStatus().accountId
    if (!accountId || this.client.getStatus().state !== 'connected') throw new PlatformError('NOT_CONNECTED', '账号尚未连接，无法读取图片。', 409, 'not-sent')
    const assertActive = () => {
      const status = this.client.getStatus()
      if (scope) assertQQAgentInvocation(qqViewReceivedImageTool.name, params, scope, this.configuration, { instanceId: this.instanceId, accountId: status.accountId })
      if (status.state !== 'connected' || status.accountId !== accountId) throw new PlatformError('AGENT_SCOPE_VIOLATION', '图片读取期间账号连接已改变，未返回图片。', 403, 'not-sent')
    }
    return readQQReceivedImage(params, { accountId, ...(scope ? { scope } : {}) }, {
      getMessage: messageId => this.client.call('get_msg', { message_id: messageId }, { timeoutMs: this.configuration.timeoutMs, readOnly: true }),
      download: url => downloadQQImage(url),
      assertActive,
    })
  }

  private receiveEvent(event: JsonObject): void {
    if (event.post_type !== 'message' || !['private', 'group'].includes(String(event.message_type))) return
    const accountId = asQQId(event.self_id)
    const senderId = asQQId(event.user_id)
    const messageId = asId(event.message_id)
    if (!accountId || !senderId || !messageId) throw new PlatformError('INVALID_MESSAGE_EVENT', 'OneBot 消息缺少有效的账号、发送者或消息标识。')
    if (accountId !== this.client.getStatus().accountId) throw new PlatformError('INVALID_MESSAGE_EVENT', 'OneBot 消息来源与当前实际登录账号不一致，未接收消息。', 400, 'not-sent')
    const kind = event.message_type === 'group' ? 'group' : 'private'
    const targetId = kind === 'group' ? asQQId(event.group_id) : senderId
    if (!targetId) throw new PlatformError('INVALID_MESSAGE_EVENT', '群消息缺少有效的 group_id。')
    const conversationId = `qq:${accountId}:${kind}:${targetId}`
    const text = textFromMessage(event.message)
    const receivedAt = new Date().toISOString()
    const key = `${this.instanceId}:${accountId}:${kind}:${targetId}:${messageId}`
    const eventId = createHash('sha256').update(`qq:${key}`).digest('hex')
    const shouldForward = senderId !== accountId && this.configuration.forwardToHarness && (kind === 'private' || this.configuration.receiveGroups)
    const harness: HarnessEvent | null = shouldForward ? { protocolVersion: 1, eventId, pluginId: this.id, instanceId: this.instanceId,
      platform: 'qq', accountId, conversationId, senderId, messageId, targetId, receivedAt,
      resourceIds: qqMessageResourceIds(event.message),
      source: { trust: 'external', kind, senderRole: qqSenderRole(senderId, this.configuration) }, content: event.message ?? '', text } : null
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

const entry: BackendPluginEntry = { id: 'qq', kind: 'communication', storageDirectory: 'qq-bot', create: context => new QQPlugin(context) }
export default entry
