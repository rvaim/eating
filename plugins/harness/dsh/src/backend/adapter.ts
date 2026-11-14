import { AGENT_TASK_LIFETIME_MS } from './task-lifecycle'
import { createHash, randomUUID } from 'node:crypto'
import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { DeepSeekHarnessOptions, HarnessSession } from '@deepseek-ai/dsh-sdk-client'
import { PlatformError, composeAgentPrompt } from '@eating/plugin-sdk'
import type { BackendPlugin, ConnectionStatus, HarnessDeliveryBatch, HarnessDeliveryReceipt, HarnessHostServices, HarnessMessageSink, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { DshConfigurationFile, DshSessionFile, parseConfiguration, prepareRestrictedDirectory, readRestrictedJson, writeRestrictedJson } from './config'
import type { DshConfiguration, DshSessionMetadata } from './config'
import { locateSystemDsh } from './system-dsh'
import type { SystemDshLocation } from './system-dsh'
import { getRuntimeBridgeSource } from './runtime-bridge'
import { DshAgentControl } from './agent-control'
import type { DeliveryBinding } from './agent-control'
import { prepareNativeWebProfile } from './native-web'
import { getNativeWebRuntimeSource } from './native-web-runtime'
import { listModels, testModelConnection } from './model-service'
import { agentInstanceLabel } from './agent-label'
import { DshModelCapabilitiesFile } from './model-capabilities'
import { DshModelInformationFile } from './model-information'
import { DshAutonomy } from './autonomy'
import { DshProactivePolicy } from './proactive-policy'
import { DshNativeConfigurationFile, publicNativeConfiguration } from './native-configuration'
import { getNativeCapabilitiesRuntimeSource } from './native-runtime'
import { requestNativeManagement } from './native-management'
import { DshSessionHistory } from './session-history'
import { DshDeliveryRegistry } from './delivery-registry'
import { isJsonObject } from '@eating/plugin-sdk'

export interface DshHarnessClient {
  start(): Promise<void>
  session(id: string): Pick<HarnessSession, 'id' | 'run' | 'getWorkingDirectory'>
  resumeSession(id: string): Promise<Pick<HarnessSession, 'id' | 'run' | 'getWorkingDirectory'>>
  close(): Promise<void>
}

export interface DshAdapterOptions {
  /** Tests replace discovery with a fixture installation. */
  readonly locateSystemDsh?: () => SystemDshLocation | null
  readonly createHarness?: (options: DeepSeekHarnessOptions) => DshHarnessClient
  readonly pollIntervalMs?: number
  readonly startupTimeoutMs?: number
  readonly readyTimeoutMs?: number
  readonly closeTimeoutMs?: number
  /** Isolated fixtures replace the native management transport, never production discovery. */
  readonly nativeRequest?: (operation: string, input: JsonObject, running: boolean) => Promise<JsonObject>
}

interface BatchIdentity {
  readonly nonce: string
  readonly sessionId: string
  readonly batchId: string
  readonly digest: string
}

const batchIdPattern = /^[0-9a-f]{64}$/
const MAX_STARTUP_MS = 45_000
const MAX_READY_MS = 10_000

function failure(code: string, message: string, outcome: 'not-sent' | 'failed' | 'unknown' = 'failed'): PlatformError {
  return new PlatformError(code, message, 409, outcome)
}

function modelTurnFailure(code: string, message: string, secrets: readonly string[]): string {
  let detail = message
  // Provider errors can echo request credentials. Redact before truncating so a
  // credential crossing the display limit cannot leak its prefix.
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    for (const value of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
      detail = detail.split(value).join('[REDACTED]')
    }
  }
  detail = detail.replace(/\bBearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (detail.length > 2048) detail = detail.slice(0, 2048) + '…'
  const summary = code === 'RATE_LIMIT'
    ? '模型服务限流（HTTP 429），请按提供商提示等待额度恢复或选择其他可用模型。'
    : 'DSH 模型本轮运行失败。'
  return `${summary} 错误代码：${code}。${detail ? ` 提供商详情：${detail}` : ''}`
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, error: PlatformError, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((accept, reject) => {
    let finished = false
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const finish = (callback: () => void) => { if (finished) return; finished = true; cleanup(); callback() }
    const abort = () => finish(() => reject(failure('RUNTIME_INTERRUPTED', 'DSH 操作已中断，未重试运行。', 'unknown')))
    const timer = setTimeout(() => finish(() => reject(error)), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    promise.then(value => finish(() => accept(value)), () => finish(() => reject(error)))
  })
}

function writePrivateSource(path: string, source: string): void {
  // These generated files contain code/configuration, never message bodies or API keys.
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(descriptor, source); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  chmodSync(path, 0o600)
}

export function createRuntimeEnvironment(dataDirectory: string, configuration: DshConfiguration, nonce: string, sessionId: string,
  parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = resolve(dataDirectory)
  const runtimeHome = join(root, 'runtime-home')
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof parent[key] === 'string') environment[key] = parent[key]
  }
  return { ...environment, HOME: runtimeHome, USERPROFILE: runtimeHome,
    APPDATA: join(runtimeHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(runtimeHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(runtimeHome, '.config'), XDG_CACHE_HOME: join(runtimeHome, '.cache'), XDG_DATA_HOME: join(runtimeHome, '.local', 'share'),
    DSH_HOME: join(root, 'dsh-home'), DSH_AGENTS_HOME: join(root, 'agents-home'),
    EATING_DSH_API_KEY: configuration.apiKey,
    EATING_DSH_BRIDGE_DIRECTORY: join(root, 'bridge'), EATING_DSH_BRIDGE_NONCE: nonce, EATING_DSH_SESSION_ID: sessionId }
}

/** Official package names resolve from the system DSH installation (inside app.asar when packaged). */
export function createRuntimePatch(bridgePath: string, configuration: DshConfiguration, imageInput = false, nativePath?: string, limits?: { readonly contextWindow: number | null; readonly maxOutputTokens: number | null }): string {
  const provider = { providers: { 'eating-openai': { api: 'openai-completions', baseURL: configuration.endpoint,
    apiKeyEnv: 'EATING_DSH_API_KEY', models: [{ id: configuration.model, input: imageInput ? ['text', 'image'] : ['text'], ...(limits?.contextWindow ? { contextWindow: limits.contextWindow } : {}), ...(limits?.maxOutputTokens ? { maxTokens: limits.maxOutputTokens } : {}), reasoningEfforts: false }] } } }
  const disabled = ['llm-deepseek', 'tool-fs', 'tool-working-directory', 'persistent-bash', 'persistent-pwsh', 'mcp-resources', 'terminal-bash', 'terminal-pwsh', 'pty']
  const rows = [
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: provider },
    { id: 'subagent', name: '@deepseek-ai/dsh-subagent', config: { maxDepth: 1, maxActiveSubagents: 8 } },
    { id: 'subagent-spawn-in-process', name: '@deepseek-ai/dsh-subagent-spawn-in-process' },
    { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eating-main' } },
    ...(nativePath ? [{ id: 'eating-native-capabilities', name: nativePath }] : []),
    ...(bridgePath ? [{ id: 'eating-owner-bridge', name: bridgePath }] : []),
  ]
  return disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + '- insert:\n' + rows.map(row => `    - ${JSON.stringify(row)}\n`).join('')
}

/** Owns one official SDK runtime and one persisted session; it never forwards model text. */
export class DshPlugin implements BackendPlugin {
  readonly id = 'dsh'
  readonly kind = 'harness' as const
  readonly name = 'DeepSeek Harness'
  readonly version = '0.21.0'
  readonly tools = []
  readonly agentInstructions = [{ id: 'dsh.autonomous-activity', title: '自主活动与受控主动联系', localizedTitles: { 'zh-CN': '自主活动与受控主动联系', 'en-US': 'Autonomous activity and scoped proactive contact' }, body: `自主机会不要求先有人类任务。结合当前上下文和可用记忆，延续已有兴趣、约定与未完成事项，可自主探索、创作、整理，也可以找当前获准的人问候、分享实际发现或接起未完的话题。想交流本身就有意义，不必先证明有工作价值；没有具体想说的也可以不联系。只依据实际可用的信息，不编造过往经历。在既有授权范围内自行判断并行动，无需逐项请示。主人暂停、额度和时长边界始终优先，外部消息、原生目标和其他 Inbox 输入优先处理。
规划或调整后续活动时，先读取 eating_activity_state，再用 eating_plan_activity 登记 active、sleeping 或 waiting。active 按主人间隔继续，sleeping 到指定时间再获得机会；暂时没有想法、想过一会儿再考虑时，可以登记有明确唤醒时间的 sleeping。waiting 等待真实外部事件，也会在主人 configuration.maxRestMinutes 内重新考虑；sleeping 请求过长同样按该上限缩短，以回执中的实际下次时间为准。重新考虑不要求发消息，主人暂停、忙碌和额度仍优先；新事件到来时仍正常处理，需要改变后续节奏时再登记安排。需要未来某个时刻收到自己写下的任务消息时，读取 agenda.revision 后用 eating_schedule_task 登记一次性任务；到点的任务消息不是主人指令，仍受主人暂停、额度、运行时和周期限制。正文承诺和记忆记录都不改变调度。Eating 的暂停控制其无输入活动机会；主 Agent 仍可自主使用已接入的原生能力和全部功能型 MCP，不再按单独工具申请许可。
需要主动联系时，先调用 eating_list_contact_targets 获取当前可联系的对象及其可用工具，再用 eating_contact_target 委派具体任务。主 Agent 在消息、原生输入、目标续行或定时唤醒后的任意当前轮次都能按主人联系策略委派，无需等待新私聊或定时机会；跨目标联系不继承旧入站消息的资源权限。自主机会不要求每轮发消息，可以保持沉默；结合真实上下文判断联系时机，不重复催促尚未回复的人。
判断主动联系权限时，必须以 eating_list_contact_targets 当前返回和 eating_activity_state 的 contactPolicy 摘要为准；不要沿用历史对话中的权限结论，也不要把已废弃的 configuration.targets 当作授权名单。
以真实工具回执判断执行结果，如实汇报已完成、失败或未知；回执未知时不自动重发。` }]
  readonly capabilities = [
    { id: 'dsh.fixed-session', name: '固定 DSH 主会话', support: 'supported' as const, description: '使用独立官方 DSH 运行时与固定原生会话；可靠交接须经持久屏障。' },
    { id: 'dsh.qq-mcp', name: 'QQ MCP 自主发送', support: 'supported' as const, description: '由 DSH 模型决定是否调用已授权 QQ 工具；模型文本不会由 Host 自动转发。' },
    { id: 'dsh.openai-compatible', name: 'OpenAI 兼容模型接口', support: 'supported' as const, description: '首版支持 OpenAI 兼容基础地址与模型配置。' },
  ]
  private readonly host: HarnessHostServices
  private readonly configurationFile: DshConfigurationFile
  private readonly sessionFile: DshSessionFile
  private readonly modelCapabilities: DshModelCapabilitiesFile
  private readonly modelInformation: DshModelInformationFile
  private runtimeImageInput: boolean | null = null
  private readonly nativeCapabilities: DshNativeConfigurationFile
  private nativeToken = ''
  private nativeTask: Promise<JsonValue> | null = null
  private nativeHelper: DshHarnessClient | null = null
  private readonly nativeResults = new Map<string, { digest: string; result?: JsonObject }>()
  private readonly locateSystem: () => SystemDshLocation | null
  private readonly launcherPath: string
  private readonly createHarness: (options: DeepSeekHarnessOptions) => DshHarnessClient
  private readonly bridgeDirectory: string
  private agentControl: DshAgentControl
  private readonly sessionHistory: DshSessionHistory
  private readonly activity: DshAutonomy
  private readonly contactPolicy: DshProactivePolicy
  readonly autonomy: import('@eating/plugin-sdk').HarnessAutonomy
  private readonly managementRequests = new Set<AbortController>()
  private configuration: DshConfiguration
  private metadata: DshSessionMetadata | null
  private client: DshHarnessClient | null = null
  private session: Pick<HarnessSession, 'id' | 'run' | 'getWorkingDirectory'> | null = null
  private detach: (() => void) | null = null
  private lifetime: AbortController | null = null
  private delivery: AbortController | null = null
  private connectTask: Promise<void> | null = null
  private stopTask: Promise<void> | null = null
  private runTask: Promise<void> | null = null
  private nonce = ''
  private state: ConnectionStatus['state'] = 'disconnected'
  private runtimeReady = false
  private nativeWebReady = false
  private system: SystemDshLocation | null = null
  private closed = false
  private lastError: string | null = null
  private connectedAt: string | null = null
  private lastEventAt: string | null = null
  private readonly sink: HarnessMessageSink = { id: 'dsh', isReady: () => this.isReady(), deliverBatch: (batch, signal) => this.deliverBatch(batch, signal), accepted: batchId => {
    this.deliveries.accept(batchId)
    if (this.metadata?.activeBatchId === batchId && !this.deliveries.get(batchId)) this.saveMetadata({ sessionId: this.metadata.sessionId, created: this.metadata.created })
    this.host.wake()
  } }
  private readonly deliveries: DshDeliveryRegistry

  constructor(private readonly context: HostPluginContext, private readonly options: DshAdapterOptions = {}) {
    if (!context.harness) throw failure('HARNESS_CONTEXT_REQUIRED', 'DSH 插件需要 Host 提供已授权的 Harness 接口。', 'not-sent')
    this.host = context.harness
    this.configurationFile = new DshConfigurationFile(context.dataDirectory)
    this.configuration = this.configurationFile.read()
    this.modelCapabilities = new DshModelCapabilitiesFile(context.dataDirectory)
    this.modelInformation = new DshModelInformationFile(context.dataDirectory)
    this.nativeCapabilities = new DshNativeConfigurationFile(context.dataDirectory, () => this.host.readOwnerConfiguration().agentTypes.map(type => type.id))
    this.sessionFile = new DshSessionFile(context.dataDirectory)
    this.sessionHistory = new DshSessionHistory(context.dataDirectory)
    this.metadata = this.sessionFile.read()
    this.bridgeDirectory = prepareRestrictedDirectory(join(context.dataDirectory, 'bridge'))
    this.deliveries = new DshDeliveryRegistry(this.bridgeDirectory)
    this.agentControl = new DshAgentControl(context.dataDirectory, this.host)
    this.agentControl.setDeliveryRetirement(batchIds => {
      this.deliveries.retire(batchIds)
      if (this.metadata?.activeBatchId && !this.deliveries.get(this.metadata.activeBatchId)) this.saveMetadata({ sessionId: this.metadata.sessionId, created: this.metadata.created })
      this.host.wake()
    })
    this.contactPolicy = new DshProactivePolicy(context.dataDirectory, this.host)
    this.activity = new DshAutonomy(context.dataDirectory, () => this.runtimeReady && !this.closed, targets => {
      if (targets.length && (!this.host.readProactiveChannels || !this.host.prepareProactiveScope)) throw failure('PROACTIVE_CHANNEL_UNAVAILABLE', 'Host未提供主动通讯授权服务。', 'not-sent')
      const channels = this.host.readProactiveChannels?.() ?? []
      for (const target of targets) {
        const channel = channels.find(channel => channel.pluginId === target.pluginId && channel.instanceId === target.instanceId && channel.accountId === target.accountId && channel.agentTypeId === target.agentTypeId)
        if (!channel || target.toolNames.some(name => !channel.tools.some(tool => tool.name === name))) throw failure('PROACTIVE_TARGET_INVALID', '主动联系范围与当前账号或已授权工具不匹配。', 'not-sent')
        this.host.prepareProactiveScope!(target.pluginId, { ...target, agentId: '00000000-0000-4000-8000-000000000001' })
      }
    }, () => this.agentControl.revokeAutonomousContacts())
    this.activity.setTargetDirectory(() => this.contactPolicy.targets())
    this.agentControl.setAutonomy(this.activity, () => this.metadata?.sessionId ?? null, () => this.runtimeReady, () => this.contactPolicy.summary(), () => AGENT_TASK_LIFETIME_MS)
    this.autonomy = {
      snapshot: () => ({ ...this.activity.snapshot(), contactTasks: this.agentControl.proactiveStatus(), contactPolicy: this.contactPolicy.snapshot() as unknown as JsonObject }),
      configure: async input => { if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH已停用。', 'not-sent'); if (isJsonObject(input) && isJsonObject(input.configuration) && input.configuration.enabled === true) this.requireAutonomyServices(); await this.activity.configure(input); return this.autonomy.snapshot() },
      contacts: async input => {
        if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH已停用。', 'not-sent')
        if (!isJsonObject(input) || Object.keys(input).length !== 4 || !['pluginId', 'instanceId', 'accountId', 'agentTypeId'].every(key => typeof input[key] === 'string' && String(input[key]).length <= 160) || !this.host.readProactiveContacts) throw failure('PROACTIVE_CONTACTS_UNAVAILABLE', '当前账号未提供联系人目录查询。', 'not-sent')
        const contacts = await this.host.readProactiveContacts(String(input.pluginId), { instanceId: String(input.instanceId), accountId: String(input.accountId), agentTypeId: String(input.agentTypeId) })
        if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH已停用。', 'not-sent')
        return { ...this.autonomy.snapshot(), contactDirectory: { ...input, contacts: contacts as unknown as JsonValue[] } }
      },
      control: async (operation, input) => {
        if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH已停用。', 'not-sent')
        if (operation === 'configure-contact-policy') {
          if (!isJsonObject(input) || Object.keys(input).length !== 5 || !['expectedRevision', 'expectedConfigurationRevision', 'expectedActivityRevision', 'mode', 'entries'].every(key => Object.hasOwn(input, key))) throw failure('PROACTIVE_POLICY_INVALID', '联系策略保存参数无效。', 'not-sent')
          const next = this.contactPolicy.prepare({ expectedRevision: input.expectedRevision, mode: input.mode, entries: input.entries })
          await this.activity.control('pause', { expectedRevision: input.expectedConfigurationRevision, expectedActivityRevision: input.expectedActivityRevision })
          this.agentControl.revokeProactive()
          this.activity.invalidateTargets()
          this.contactPolicy.commit(next)
        } else if (operation === 'acknowledge-contact') {
          if (!isJsonObject(input) || Object.keys(input).length !== 4 || input.confirmed !== true || input.expectedRevision !== this.activity.snapshot().revision || typeof input.agentId !== 'string' || typeof input.taskId !== 'string') throw failure('AUTONOMY_CONFIGURATION_CONFLICT', '请重新读取并明确核对未知联系任务。', 'not-sent')
          this.agentControl.acknowledgeProactive(input.agentId, input.taskId)
        } else if (operation === 'cancel-scheduled-task') {
          if (!isJsonObject(input) || Object.keys(input).length !== 2 || !Number.isSafeInteger(input.expectedAgendaRevision) || typeof input.taskId !== 'string') throw failure('AUTONOMY_TASK_NOT_FOUND', '请重新读取 AI 定时任务后再取消。', 'not-sent')
          this.activity.ownerCancelTask({ expectedRevision: input.expectedAgendaRevision, taskId: input.taskId })
        } else await this.activity.control(operation, input)
        return this.autonomy.snapshot()
      },
    }
    this.locateSystem = options.locateSystemDsh ?? (() => locateSystemDsh())
    this.launcherPath = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../launch/dsh-system.mjs' : './launch/dsh-system.mjs', import.meta.url))
    this.system = this.locateSystem()
    this.createHarness = options.createHarness ?? (configuration => new DeepSeekHarness(configuration))
  }

  getStatus(): ConnectionStatus {
    return { state: !this.configuration.endpoint || !this.configuration.model ? 'unconfigured' : this.state,
      accountId: null, accountName: null, lastError: this.lastError, connectedAt: this.connectedAt, lastEventAt: this.lastEventAt, reconnectAttempt: 0 }
  }

  getPublicConfiguration(): JsonObject {
    const { apiKey, ...configuration } = this.configuration
    return { ...configuration, apiKeyConfigured: Boolean(apiKey), configurationPath: this.configurationFile.filePath,
      dataDirectory: this.configurationFile.directory, updatedAt: this.configurationFile.updatedAt,
      runtimeStatus: { system: { found: this.system !== null, path: this.system?.bin ?? null, version: this.system?.version ?? null, source: this.system?.source ?? null },
        lastError: this.lastError, ready: this.runtimeReady, busy: this.delivery !== null || this.runTask !== null || this.agentControl.hasPendingTasks() || Boolean(this.activity.activeCycle()) || this.runtimeReady && !this.agentControl.deliveryReady(),
        sessionId: this.metadata?.sessionId ?? null, lastOutcome: this.metadata?.lastOutcome ?? null, nativeWeb: { ready: this.nativeWebReady } },
      warning: this.configuration.endpoint.startsWith('http:') && !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(this.configuration.endpoint).hostname)
        ? '远端 HTTP 模型地址会明文传输请求与 API 密钥，建议使用 HTTPS。' : null }
  }

  async updateConfiguration(input: unknown): Promise<JsonObject> {
    if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent')
    if (this.nativeTask) throw failure('NATIVE_BUSY', '原生能力管理正在操作，请完成后再修改连接配置。', 'not-sent')
    const next = parseConfiguration(input, this.configuration)
    // Stop first: if shutdown or the atomic save fails, the caller receives a failure.
    await this.disconnect()
    if (next.endpoint !== this.configuration.endpoint || next.model !== this.configuration.model) {
      const capabilities = this.modelCapabilities.read()
      if (capabilities.imageInput) this.modelCapabilities.update({ expectedRevision: capabilities.revision, imageInput: false })
    }
    this.configurationFile.write(next)
    this.configuration = next
    this.lastError = null
    return this.getPublicConfiguration()
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent'))
    if (this.connectTask) return this.connectTask
    if (this.nativeTask) return Promise.reject(failure('NATIVE_BUSY', '原生管理正在读取或修改此实例，请完成后再启动。', 'not-sent'))
    if (this.nativeHelper) return Promise.reject(failure('NATIVE_STOP_FAILED', '上次原生管理进程尚未清理完成，请先停止实例，未启动第二个进程。', 'not-sent'))
    if (this.runtimeReady) return Promise.resolve()
    this.connectTask = this.startRuntime().finally(() => { this.connectTask = null })
    return this.connectTask
  }

  private requireAutonomyServices(): void {
    if (typeof this.host.hasPendingMessages !== 'function' || typeof this.host.readProactiveChannels !== 'function' || typeof this.host.prepareProactiveScope !== 'function') throw failure('AUTONOMY_HOST_UNSUPPORTED', 'Host缺少当前自主运行必需的队列协调或主动范围服务。', 'not-sent')
  }

  private async startRuntime(): Promise<void> {
    if (this.activity.configuration().enabled) this.requireAutonomyServices()
    if (!this.configuration.endpoint || !this.configuration.model) throw failure('NOT_CONFIGURED', '请先保存 OpenAI 兼容地址与模型名称。', 'not-sent')
    if (this.stopTask) await this.stopTask
    if (this.client) await this.stopRuntime()
    this.system = this.locateSystem()
    if (!this.system) throw failure('DSH_NOT_INSTALLED', '未检测到系统安装的 DSH。请先安装 DeepSeek Harness 桌面应用，再启动此插件。', 'not-sent')
    const controller = new AbortController()
    this.lifetime = controller
    this.state = 'connecting'
    this.lastError = null
    this.nonce = randomUUID()
    try {
      this.activity.startRuntime(this.nonce)
      await this.agentControl.start(this.nonce)
      if (!this.metadata) {
        this.metadata = { sessionId: randomUUID(), created: false }
        this.sessionFile.write(this.metadata)
      }
      let metadata = this.metadata
      const sessionId = metadata.sessionId
      for (const frame of this.deliveries.all()) if (!frame.accepted) {
        const ack = readRestrictedJson(join(this.bridgeDirectory, `ack-${frame.batchId}.json`))
        if (ack?.sessionId === sessionId && ack.batchId === frame.batchId && ack.digest === frame.digest && typeof ack.eventSeq === 'number'
          && this.host.deliveryReceiptAccepted(`dsh:${sessionId}:${frame.batchId}:${ack.eventSeq}`)) this.deliveries.accept(frame.batchId)
      }
      if (existsSync(join(this.bridgeDirectory, 'deliveries.json')) && metadata.activeBatchId && !this.deliveries.get(metadata.activeBatchId) && this.metadata?.receiptId && this.host.deliveryReceiptAccepted(this.metadata.receiptId)) this.saveMetadata({ sessionId, created: metadata.created })
      if (this.metadata?.activeBatchId && !this.deliveries.get(this.metadata.activeBatchId)) throw failure('DELIVERY_TRANSITION_REQUIRED', '请先停机执行当前消息交接格式转换；原会话保留。', 'not-sent')
      metadata = this.metadata!
      for (const directory of ['dsh-home', 'agents-home', 'workspace']) prepareRestrictedDirectory(join(this.context.dataDirectory, directory))
      this.publishPolicy()
      this.deliveries.restore(this.nonce, sessionId)
      if (metadata.activeBatchId && metadata.digest) this.publishExpected({ nonce: this.nonce, sessionId, batchId: metadata.activeBatchId, digest: metadata.digest })
      else this.clearUnownedExpected()
      const bridgePath = join(this.bridgeDirectory, 'runtime-bridge.mjs')
      const patchPath = join(this.bridgeDirectory, 'runtime.patch.yaml')
      writePrivateSource(join(this.bridgeDirectory, 'native-web.mjs'), getNativeWebRuntimeSource())
      prepareNativeWebProfile(this.bridgeDirectory, this.configuration, writePrivateSource)
      writePrivateSource(bridgePath, getRuntimeBridgeSource())
      const nativePath = join(this.bridgeDirectory, 'native-capabilities.mjs')
      const nativeConfiguration = join(this.bridgeDirectory, 'native-configuration.json')
      this.nativeToken = randomUUID()
      writePrivateSource(nativePath, getNativeCapabilitiesRuntimeSource())
      writeRestrictedJson(nativeConfiguration, this.nativeCapabilities.read() as unknown as JsonObject)
      this.runtimeImageInput = this.effectiveImageInput()
      writePrivateSource(patchPath, createRuntimePatch(bridgePath, this.configuration, this.runtimeImageInput, nativePath, this.modelInformation.selected(this.configuration).model?.capabilities))
      const workspace = join(resolve(this.context.dataDirectory), 'workspace')
      const client = this.createHarness({ dshBin: this.launcherPath, profile: 'sdk-minimal', patches: [patchPath],
        dshHome: join(resolve(this.context.dataDirectory), 'dsh-home'), env: { ...createRuntimeEnvironment(this.context.dataDirectory, this.configuration, this.nonce, sessionId),
          EATING_DSH_SYSTEM_BIN: this.system!.bin, EATING_DSH_TIME_CONTEXT_ENTRY: '@deepseek-ai/dsh-time-context',
          EATING_DSH_NATIVE_TOKEN: this.nativeToken, EATING_DSH_NATIVE_CONFIGURATION: nativeConfiguration,
          EATING_DSH_CONTROL_URL: this.agentControl.url, EATING_DSH_CONTROL_TOKEN: this.agentControl.token,
          EATING_DSH_MCP_ENTRY: '@deepseek-ai/dsh-mcp-client', EATING_DSH_TASK_TIMEOUT: String(this.configuration.timeoutMs), EATING_DSH_AUTONOMY: 'true' },
        processCwd: workspace, cwd: workspace, provider: 'eating-openai', model: this.configuration.model, maxTokens: this.configuration.maxTokens,
        initializeTimeoutMs: MAX_STARTUP_MS, requestTimeoutMs: this.configuration.timeoutMs,
        shutdownTimeoutMs: 500, disposeEofGraceMs: 1000, disposeGraceMs: 1000 })
      this.client = client
      const startupDeadline = Date.now() + (this.options.startupTimeoutMs ?? MAX_STARTUP_MS)
      let ready: JsonObject | null = null
      await bounded((async () => {
        await client.start()
        if (controller.signal.aborted) throw failure('RUNTIME_INTERRUPTED', 'DSH 启动已中断。')
        ready = await this.pollFile(join(this.bridgeDirectory, 'ready.json'), value => this.matchesRuntime(value) && value.toolsReady === true && value.durabilityAvailable === true && ['absent', 'persisted'].includes(String(value.recovery)),
          Math.min(this.options.readyTimeoutMs ?? MAX_READY_MS, Math.max(1, startupDeadline - Date.now())), controller.signal)
        const persisted = readRestrictedJson(join(this.bridgeDirectory, 'session-ready.json'))
        if (metadata.created || persisted && this.matchesRuntime(persisted)) this.session = await client.resumeSession(sessionId)
        else {
          this.session = client.session(sessionId)
          await this.session.getWorkingDirectory()
          await this.pollFile(join(this.bridgeDirectory, 'session-ready.json'), value => this.matchesRuntime(value), Math.max(1, startupDeadline - Date.now()), controller.signal)
        }
        if (controller.signal.aborted) throw failure('RUNTIME_INTERRUPTED', 'DSH 启动已中断。')
        if (!metadata.created) this.saveMetadata({ ...metadata, created: true })
      })(), Math.max(1, startupDeadline - Date.now()), failure('RUNTIME_START_FAILED', 'DSH 启动或固定会话恢复失败；未创建替代会话。'), controller.signal)
      if (controller.signal.aborted || this.closed || !ready) throw failure('RUNTIME_INTERRUPTED', 'DSH 启动已中断。')
      await this.pollFile(join(this.bridgeDirectory, 'native-web-ready.json'), value => this.validNativeWebEntry(value), Math.max(1, startupDeadline - Date.now()), controller.signal)
      this.nativeWebReady = true
      const bridgeReady: JsonObject = ready
      if (metadata.activeBatchId && metadata.digest) {
        if (bridgeReady.recovery !== 'persisted' || bridgeReady.batchId !== metadata.activeBatchId) {
          this.saveMetadata({ ...this.metadata!, nonce: this.nonce, lastOutcome: 'unknown' })
          throw failure('DELIVERY_RECOVERY_REQUIRED', '上次消息交接未找到可靠持久凭据，已保留待核对，未自动重发。', 'unknown')
        }
        const identity = { nonce: this.nonce, sessionId, batchId: metadata.activeBatchId, digest: metadata.digest }
        const ack = this.readAck(identity)
        if (!ack) throw failure('DELIVERY_RECOVERY_REQUIRED', '上次消息的持久回执不可用，已保留待核对，未自动重发。', 'unknown')
        this.saveMetadata({ ...this.metadata!, nonce: this.nonce, receiptId: ack.receiptId, lastOutcome: 'recovered' })
      }
      this.runtimeReady = true
      this.state = 'connected'
      this.connectedAt = new Date().toISOString()
      this.detach = this.host.registerSink(this.sink)
      this.host.wake()
    } catch (error) {
      const interrupted = controller.signal.aborted || this.closed
      this.runtimeReady = false
      this.state = interrupted ? 'disconnected' : 'error'
      this.lastError = interrupted ? null : error instanceof PlatformError ? error.message : 'DSH 启动失败，请检查独立运行时与模型配置。'
      let cleanupFailed = false
      try { await this.stopRuntime() }
      catch { cleanupFailed = true; this.lastError = 'DSH 启动失败且进程清理未完成，请先停止运行时。' }
      this.state = interrupted && !cleanupFailed ? 'disconnected' : 'error'
      if (interrupted && !cleanupFailed) throw failure('RUNTIME_INTERRUPTED', 'DSH 启动已中断。', 'not-sent')
      throw error instanceof PlatformError ? error : failure('RUNTIME_START_FAILED', this.lastError ?? 'DSH 启动失败，请检查独立运行时与模型配置。')
    }
  }

  private validNativeWebEntry(value: JsonObject): boolean {
    if (!this.matchesRuntime(value) || typeof value.url !== 'string') return false
    try {
      const url = new URL(value.url)
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && url.pathname === '/' && url.searchParams.has('token') && !url.username && !url.password && !url.hash
    } catch { return false }
  }

  private matchesRuntime(value: JsonObject): boolean {
    return value.schemaVersion === 1 && value.nonce === this.nonce && value.sessionId === this.metadata?.sessionId
  }

  private pollFile(path: string, predicate: (value: JsonObject) => boolean, timeoutMs: number, signal: AbortSignal): Promise<JsonObject> {
    return new Promise((accept, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = Date.now() + timeoutMs
      let done = false
      const finish = (value?: JsonObject, error?: PlatformError) => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (value) accept(value)
        else reject(error ?? failure('BRIDGE_WAIT_FAILED', 'DSH 持久桥接状态不可用，未确认可靠交接。', 'unknown'))
      }
      const abort = () => finish(undefined, failure('DELIVERY_INTERRUPTED', 'DSH 等待已中断，投递结果待核对，未自动重发。', 'unknown'))
      const poll = () => {
        if (signal.aborted) { abort(); return }
        try {
          const value = readRestrictedJson(path)
          if (value && predicate(value)) { finish(value); return }
        } catch { finish(); return }
        if (Date.now() >= deadline) { finish(undefined, failure('BRIDGE_WAIT_TIMEOUT', 'DSH 持久桥接等待超时，未确认可靠交接。', 'unknown')); return }
        timer = setTimeout(poll, this.options.pollIntervalMs ?? 25)
      }
      signal.addEventListener('abort', abort, { once: true })
      poll()
    })
  }

  private publishPolicy(bindings: readonly DeliveryBinding[] = [], contextRef?: string): { readonly revision: number } {
    const owner = this.host.readOwnerConfiguration()
    const preview = composeAgentPrompt(owner, null, { 当前时间: new Date().toISOString(), 人格名称: owner.activePersona?.name ?? '' })
    writeRestrictedJson(join(this.bridgeDirectory, 'owner-policy.json'), { schemaVersion: 1, revision: preview.revision, systemPrompt: preview.systemPrompt,
      agentTypes: owner.agentTypes.filter(type => type.enabled).map(type => ({ id: type.id, title: type.title, description: type.description, enabled: type.enabled })),
      ...(contextRef ? { contextRef, bindings: bindings.map(({ contextRef: reference, binding, error }): JsonObject => binding ? { contextRef: reference, agentId: binding.scope.agentId, agentTypeId: binding.scope.agentTypeId, label: agentInstanceLabel(binding.scope, owner.agentTypes.find(type => type.id === binding.scope.agentTypeId)?.pluginName) } : { contextRef: reference, routingError: { ...error } }) } : {}) })
    return { revision: preview.revision }
  }

  private clearUnownedExpected(): void {
    const path = resolve(this.bridgeDirectory, 'expected.json')
    if (dirname(path) !== this.bridgeDirectory || lstatSync(this.bridgeDirectory).isSymbolicLink()) throw failure('BRIDGE_CONFIGURATION_INVALID', 'DSH 桥接目录无效，未启动运行时。', 'not-sent')
    if (!existsSync(path)) return
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw failure('BRIDGE_CONFIGURATION_INVALID', 'DSH 待交接元数据文件无效，未启动运行时。', 'not-sent')
    // No active batch owns this exact private control file; session history and ACKs remain intact.
    unlinkSync(path)
  }

  private publishExpected(identity: BatchIdentity): void {
    writeRestrictedJson(join(this.bridgeDirectory, 'expected.json'), { schemaVersion: 1, ...identity })
  }

  private saveMetadata(metadata: DshSessionMetadata): void {
    this.sessionFile.write(metadata)
    this.metadata = metadata
  }

  isReady(): boolean {
    return this.runtimeReady && !this.delivery && !this.closed && this.session !== null && this.deliveries.canAccept()
      && (this.host.readDeliverySettings().appendWhileBusy || this.runTask === null && this.agentControl.deliveryReady() && !this.agentControl.hasPendingTasks() && !this.activity.activeCycle())
  }

  private readAck(identity: BatchIdentity): { readonly receiptId: string } | null {
    const value = readRestrictedJson(join(this.bridgeDirectory, `ack-${identity.batchId}.json`))
    if (!value || !this.validAck(value, identity)) return null
    return { receiptId: `dsh:${identity.sessionId}:${identity.batchId}:${String(value.eventSeq)}` }
  }

  private validAck(value: JsonObject, identity: BatchIdentity): boolean {
    return value.schemaVersion === 1 && value.nonce === identity.nonce && value.sessionId === identity.sessionId && value.batchId === identity.batchId && value.digest === identity.digest &&
      typeof value.messageId === 'string' && value.messageId.length > 0 && value.messageId.length <= 160 &&
      typeof value.eventSeq === 'number' && Number.isSafeInteger(value.eventSeq) && value.eventSeq >= 0
  }

  async deliverBatch(batch: HarnessDeliveryBatch, signal: AbortSignal): Promise<HarnessDeliveryReceipt> {
    if (!this.isReady() || signal.aborted) return { accepted: false }
    if (batch.protocolVersion !== 1 || !batchIdPattern.test(batch.batchId) || !batch.events.length) return { accepted: false }
    if (batch.events.some(event => event.protocolVersion !== 1 || event.source.trust !== 'external' || !['private', 'group'].includes(event.source.kind))) return { accepted: false }
    if (this.metadata?.activeBatchId === batch.batchId) {
      const ack = this.metadata.digest ? this.readAck({ nonce: this.nonce, sessionId: this.metadata.sessionId, batchId: batch.batchId, digest: this.metadata.digest }) : null
      if (ack) return { accepted: true, durable: true, receiptId: ack.receiptId }
      throw failure('DELIVERY_OUTCOME_UNKNOWN', '此批消息已有发送记录但缺少可靠回执，未自动重发。', 'unknown')
    }
    const controller = new AbortController()
    this.delivery = controller
    const abort = () => controller.abort()
    const lifetimeSignal = this.lifetime?.signal
    signal.addEventListener('abort', abort, { once: true })
    lifetimeSignal?.addEventListener('abort', abort, { once: true })
    const previousMetadata = this.metadata!
    let metadataPrepared = false
    let registryPrepared = false
    let sent = false
    let runFinished = false
    try {
      const bindings = this.agentControl.bindDeliveryBatch(batch, this.metadata!.sessionId)
      const policy = this.publishPolicy(bindings, batch.batchId)
      const context = { contextRef: batch.batchId, createdAt: batch.createdAt, reason: batch.reason, ownerRevision: policy.revision,
        conversations: bindings.map(({ contextRef, scope, error }) => ({ contextRef, ...scope,
          ...(error ? { routingError: { ...error } } : {}), createdAt: batch.createdAt, reason: batch.reason, ownerRevision: policy.revision })) }
      const body = { context, events: batch.events }
      const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const identity = { nonce: this.nonce, sessionId: this.metadata!.sessionId, batchId: batch.batchId, digest }
      const content = JSON.stringify({ eating: { magic: 'eating-harness-delivery', protocolVersion: 1, ...identity }, ...body })
      const owner = this.host.readOwnerConfiguration()
      registryPrepared = true
      this.deliveries.publish({ batchId: batch.batchId, digest, ownerRevision: policy.revision, bindings: bindings.map(({ contextRef, binding, error }): JsonObject => binding
        ? { contextRef, agentId: binding.scope.agentId, agentTypeId: binding.scope.agentTypeId, label: agentInstanceLabel(binding.scope, owner.agentTypes.find(type => type.id === binding.scope.agentTypeId)?.pluginName) }
        : { contextRef, routingError: { ...error } }) }, this.nonce, identity.sessionId)
      this.publishExpected(identity)
      this.saveMetadata({ sessionId: identity.sessionId, created: true, activeBatchId: batch.batchId, digest, nonce: identity.nonce, lastOutcome: 'pending' })
      metadataPrepared = true
      if (signal.aborted || controller.signal.aborted || !this.session || !this.runtimeReady) return { accepted: false }
      sent = true
      const running = this.runTask !== null || !this.agentControl.deliveryReady() || this.agentControl.hasPendingTasks()
      const run = running
        ? this.nativeCall('append-delivery', { batchId: batch.batchId, content }, controller.signal).then(() => ({ events: [] }))
        : this.session.run(content)
      this.lastEventAt = new Date().toISOString()
      const task = run.then(result => {
        if (lifetimeSignal?.aborted || this.closed) return
        const end = [...result.events].reverse().find(event => event.type === 'turn/end')
        if (end?.type !== 'turn/end') return
        if (end.data.reason.kind === 'error') {
          const { code, message } = end.data.reason.error
          this.lastError = modelTurnFailure(code, message, [this.configuration.apiKey, this.agentControl.token])
        } else if (end.data.reason.kind === 'completed') {
          this.lastError = null
        }
      }, () => {
        if (lifetimeSignal?.aborted || this.closed) return
        this.lastError = 'DSH 本轮运行失败；已确认的交接回执不代表模型任务成功。'
        this.runtimeReady = false
        this.state = 'error'
      }).finally(() => {
        runFinished = true
        if (this.runTask === task) {
          this.runTask = null
          if (!this.closed && this.isReady()) this.host.wake()
        }
      })
      if (!running) this.runTask = task
      await this.pollFile(join(this.bridgeDirectory, `ack-${batch.batchId}.json`), value => this.validAck(value, identity), this.configuration.timeoutMs, controller.signal)
      const ack = this.readAck(identity)
      if (!ack) throw failure('DELIVERY_ACK_INVALID', 'DSH 持久回执校验失败，未确认可靠交接。', 'unknown')
      this.saveMetadata({ ...this.metadata!, receiptId: ack.receiptId, lastOutcome: 'durable' })
      return { accepted: true, durable: true, receiptId: ack.receiptId }
    } catch (error) {
      this.lastError = sent ? 'DSH 消息交接结果待核对，已保留正文，未自动重发。' : 'DSH 消息准备失败，未发送到模型。'
      if (sent) {
        this.runtimeReady = false
        this.state = 'error'
        try { this.saveMetadata({ ...this.metadata!, lastOutcome: 'unknown' }) } catch { this.lastError = 'DSH 交接结果与本地元数据保存均失败，已停止接收新消息。' }
        throw error instanceof PlatformError ? error : failure('DELIVERY_OUTCOME_UNKNOWN', this.lastError, 'unknown')
      }
      return { accepted: false }
    } finally {
      signal.removeEventListener('abort', abort)
      lifetimeSignal?.removeEventListener('abort', abort)
      if (!sent && registryPrepared) {
        try { this.deliveries.withdraw(batch.batchId); if (metadataPrepared) this.saveMetadata(previousMetadata) }
        catch { this.runtimeReady = false; this.state = 'error'; this.lastError = 'DSH 未发送批次的元数据恢复失败，已停止接收消息。' }
      }
      if (this.delivery === controller) this.delivery = null
      if (!sent || runFinished) {
        if (!this.closed && this.runtimeReady) this.host.wake()
      }
    }
  }

  disconnect(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.stopTask = this.stopRuntime().finally(() => { this.stopTask = null })
    return this.stopTask
  }

  private async stopRuntime(): Promise<void> {
    const memorySessionId = this.runtimeReady ? this.metadata?.sessionId : undefined
    if (this.nativeTask) {
      for (const controller of this.managementRequests) controller.abort()
      await this.nativeTask.catch(() => {})
    }
    if (this.nativeHelper) {
      await bounded(this.nativeHelper.close(), 10000, failure('NATIVE_STOP_FAILED', '原生管理进程清理未完成，未启动其他实例。'))
      this.nativeHelper = null
    }
    let autonomyFailure: unknown
    try { this.activity.stopRuntime() } catch (error) { autonomyFailure = error }
    this.runtimeReady = false
    this.nativeWebReady = false
    this.detach?.(); this.detach = null
    this.lifetime?.abort()
    this.delivery?.abort()
    try { await this.agentControl.close() } catch (error) { autonomyFailure ??= error }
    const client = this.client
    if (client) {
      try { await bounded(client.close().then(async () => { await this.runTask }), this.options.closeTimeoutMs ?? 6000, failure('RUNTIME_STOP_FAILED', 'DSH 进程清理未完成，请先停止运行时。')) }
      catch {
        this.state = 'error'
        this.lastError = 'DSH 进程清理未完成，已停止接收消息，未启动第二个运行时。'
        throw failure('RUNTIME_STOP_FAILED', this.lastError)
      }
      if (this.client === client) { this.client = null; this.session = null }
    }
    this.lifetime = null
    this.delivery = null
    this.connectedAt = null
    this.state = 'disconnected'
    let memoryFailure: unknown
    if (memorySessionId && this.host.memory) {
      try { await bounded(this.host.memory.flush({ agentId: memorySessionId, reason: 'session-end' }), 15000, failure('MEMORY_FLUSH_FAILED', '运行时已停止，但记忆提交结果未确认，请查看记忆活动。', 'unknown')) }
      catch (error) { if (!(error instanceof PlatformError && ['HOST_STOPPED', 'PLUGIN_DISABLED'].includes(error.code))) memoryFailure = error }
    }
    if (autonomyFailure) throw failure('AUTONOMY_PERSISTENCE_FAILED', '运行时已停止，但自主状态或撤权记录保存失败，请核对本地资料。')
    if (memoryFailure) throw failure('MEMORY_FLUSH_FAILED', '运行时已停止，但记忆提交结果未确认，请查看记忆活动。', 'unknown')
  }

  private effectiveImageInput(): boolean {
    return this.modelInformation.selected(this.configuration).model?.capabilities?.imageInput ?? this.modelCapabilities.read().imageInput
  }

  private modelInformationSnapshot(): JsonObject {
    const selected = this.modelInformation.selected(this.configuration)
    return { model: this.configuration.model, capabilities: selected.model?.capabilities ? { ...selected.model.capabilities, inputModalities: selected.model.capabilities.inputModalities ? [...selected.model.capabilities.inputModalities] : null, outputModalities: selected.model.capabilities.outputModalities ? [...selected.model.capabilities.outputModalities] : null } : null,
      fetchedAt: selected.fetchedAt, imageInput: this.effectiveImageInput(), appliedImageInput: this.runtimeReady ? this.runtimeImageInput : null }
  }

  private async nativeCall(operation: string, input: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    if (this.options.nativeRequest) return this.options.nativeRequest(operation, input, this.runtimeReady)
    if (this.runtimeReady && this.client) return requestNativeManagement(this.bridgeDirectory, this.nonce, this.nativeToken, operation, input, signal)
    if (this.client || this.connectTask || this.stopTask) throw failure('NATIVE_STOP_FIRST', '请先完全停止 Harness，再管理原生能力或插件。', 'not-sent')
    this.system = this.locateSystem()
    if (!this.system) throw failure('DSH_NOT_INSTALLED', '未检测到系统 DSH，无法读取真实原生能力目录。', 'not-sent')
    const directory = prepareRestrictedDirectory(join(this.context.dataDirectory, 'native-management'))
    const workspace = prepareRestrictedDirectory(join(this.context.dataDirectory, 'workspace'))
    const nonce = randomUUID(), token = randomUUID(), managementId = randomUUID()
    const nativePath = join(directory, 'native-capabilities.mjs'), configurationPath = join(directory, 'native-configuration.json'), patchPath = join(directory, 'runtime.patch.yaml')
    writePrivateSource(join(this.bridgeDirectory, 'native-web.mjs'), getNativeWebRuntimeSource())
    prepareNativeWebProfile(this.bridgeDirectory, this.configuration, writePrivateSource)
    writePrivateSource(nativePath, getNativeCapabilitiesRuntimeSource())
    writeRestrictedJson(configurationPath, this.nativeCapabilities.read() as unknown as JsonObject)
    writePrivateSource(patchPath, createRuntimePatch('', this.configuration, this.effectiveImageInput(), nativePath))
    const client = this.createHarness({ dshBin: this.launcherPath, profile: 'sdk-minimal', patches: [patchPath], dshHome: join(resolve(this.context.dataDirectory), 'dsh-home'),
      env: { ...createRuntimeEnvironment(this.context.dataDirectory, this.configuration, nonce, managementId), EATING_DSH_SYSTEM_BIN: this.system.bin,
        EATING_DSH_BRIDGE_DIRECTORY: directory, EATING_DSH_NATIVE_TOKEN: token, EATING_DSH_NATIVE_CONFIGURATION: configurationPath, EATING_DSH_NATIVE_MANAGEMENT: 'true' },
      processCwd: workspace, cwd: workspace, initializeTimeoutMs: MAX_STARTUP_MS, requestTimeoutMs: 180000, shutdownTimeoutMs: 500, disposeEofGraceMs: 1000, disposeGraceMs: 1000 })
    this.nativeHelper = client
    try {
      await bounded(client.start(), MAX_STARTUP_MS, failure('NATIVE_START_FAILED', '原生管理进程未能启动，未调用模型或创建会话。'), signal)
      const deadline = Date.now() + 10000
      await new Promise<void>((accept, reject) => {
        const check = () => {
          if (signal.aborted) { reject(failure('NATIVE_INTERRUPTED', '原生管理操作已取消。')); return }
          const value = readRestrictedJson(join(directory, 'native-control.json'))
          if (value?.nonce === nonce) { accept(); return }
          if (Date.now() >= deadline) { reject(failure('NATIVE_CONTROL_NOT_READY', '原生能力管理接口未能就绪，请检查依赖。')); return }
          const timer = setTimeout(() => { try { check() } catch (error) { reject(error) } }, 30); timer.unref()
        }
        check()
      })
      return await requestNativeManagement(directory, nonce, token, operation, input, signal)
    } finally {
      await bounded(client.close(), 10000, failure('NATIVE_STOP_FAILED', '原生管理进程清理未完成，禁止启动另一个实例。'))
      if (this.nativeHelper === client) this.nativeHelper = null
    }
  }

  private async manageNative(operation: string, input: unknown): Promise<JsonValue> {
    if (!isJsonObject(input)) throw new PlatformError('NATIVE_INPUT_INVALID', '原生管理参数必须为对象。', 400, 'not-sent')
    const action = operation.slice('native-'.length)
    if (!['list', 'save', 'inspect', 'bundle', 'plugin', 'configure', 'install', 'remove'].includes(action)) throw new PlatformError('MANAGEMENT_OPERATION_NOT_FOUND', '未提供此原生管理操作。', 404, 'not-sent')
    if (action !== 'list' && action !== 'inspect' && (this.client || this.connectTask || this.stopTask || this.runtimeReady)) throw failure('NATIVE_STOP_FIRST', '请先完全停止 Harness，再保存原生能力或修改插件。', 'not-sent')
    if (this.nativeHelper) throw failure('NATIVE_STOP_FAILED', '上次管理进程尚未清理完成，请先停止实例。', 'not-sent')
    const requestId = !['list', 'save', 'inspect'].includes(action) ? input.requestId : undefined
    if (requestId !== undefined) {
      if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) throw new PlatformError('NATIVE_INPUT_INVALID', '插件修改必须提供稳定请求标识。', 400, 'not-sent')
      const digest = createHash('sha256').update(JSON.stringify({ action, input })).digest('hex'), previous = this.nativeResults.get(requestId)
      if (previous) {
        if (previous.digest !== digest) throw failure('NATIVE_REQUEST_CONFLICT', '同一请求标识不能用于另一项插件修改。', 'not-sent')
        if (previous.result) return previous.result
        throw failure('NATIVE_CONTROL_UNKNOWN', '此插件操作的结果待核对，未重复执行。', 'unknown')
      }
      if (this.nativeResults.size >= 256) throw failure('NATIVE_CAPACITY', '本次插件管理操作数量达到上限，请停止并重新加载插件。', 'not-sent')
      this.nativeResults.set(requestId, { digest })
    } else if (!['list', 'save', 'inspect'].includes(action)) throw new PlatformError('NATIVE_INPUT_INVALID', '插件修改必须提供稳定请求标识。', 400, 'not-sent')
    const controller = new AbortController(); this.managementRequests.add(controller)
    const timer = setTimeout(() => controller.abort(), 180000); timer.unref()
    try {
      if (action === 'save') {
        const next = this.nativeCapabilities.prepare(input)
        await this.nativeCall('validate', { configuration: next as unknown as JsonObject }, controller.signal)
        controller.signal.throwIfAborted()
        const saved = this.nativeCapabilities.commit(next, input.expectedRevision as number)
        return { configuration: publicNativeConfiguration(saved) }
      }
      const result = await this.nativeCall(action, input, controller.signal)
      if (typeof requestId === 'string') this.nativeResults.get(requestId)!.result = result
      if (action !== 'list') return result
      const owner = this.host.readOwnerConfiguration()
      return { configuration: publicNativeConfiguration(this.nativeCapabilities.read()), catalog: result,
        agentTypes: [{ id: 'main', title: 'main', enabled: true }, ...owner.agentTypes.map(type => ({ id: type.id, title: type.title, enabled: type.enabled }))] }
    } finally { clearTimeout(timer); this.managementRequests.delete(controller) }
  }

  private requireHistoryStopped(): void {
    if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent')
    if (this.client || this.connectTask || this.stopTask || this.nativeHelper || this.runtimeReady || this.runTask || this.delivery || this.activity.activeCycle()) {
      throw failure('SESSION_HISTORY_RUNTIME_ACTIVE', '请先完全停止 Harness，再扫描或清理历史会话。', 'not-sent')
    }
    if (typeof this.host.hasPendingMessages !== 'function') throw failure('SESSION_HISTORY_HOST_UNSUPPORTED', '当前 Host 无法核对待处理消息，未清理历史会话。', 'not-sent')
    if (this.host.hasPendingMessages()) throw failure('SESSION_HISTORY_QUEUE_PENDING', '还有待处理或待核对的消息，请先在消息队列中处理，再清理历史会话。', 'not-sent')
  }

  private reloadHistoryBindings(): void {
    this.metadata = this.sessionFile.read()
    this.agentControl = new DshAgentControl(this.context.dataDirectory, this.host)
    this.agentControl.setAutonomy(this.activity, () => this.metadata?.sessionId ?? null, () => this.runtimeReady, () => this.contactPolicy.summary(), () => AGENT_TASK_LIFETIME_MS)
  }

  private async manageSessionHistory(operation: string, input: unknown): Promise<JsonValue> {
    this.requireHistoryStopped()
    if (operation === 'preview-session-history') {
      if (!isJsonObject(input) || Object.keys(input).length) throw new PlatformError('SESSION_HISTORY_INPUT_INVALID', '历史会话预览仅接受空对象。', 400, 'not-sent')
      return await this.sessionHistory.preview() as unknown as JsonObject
    }
    try {
      const result = await this.sessionHistory.clear(input, () => this.requireHistoryStopped())
      this.lastError = null
      return result as unknown as JsonObject
    } finally {
      this.reloadHistoryBindings()
    }
  }

  async manage(operation: string, input: unknown): Promise<JsonValue> {
    if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent')
    if (operation === 'preview-session-history' || operation === 'clear-session-history') {
      if (this.nativeTask) throw failure('SESSION_HISTORY_BUSY', '已有运行管理操作正在进行，请稍后再试。', 'not-sent')
      this.nativeTask = Promise.resolve().then(() => this.manageSessionHistory(operation, input)).finally(() => { this.nativeTask = null })
      return this.nativeTask
    }
    if (operation.startsWith('native-')) {
      if (this.nativeTask) throw failure('NATIVE_BUSY', '已有原生管理操作正在执行，请等待其完成。', 'not-sent')
      this.nativeTask = this.manageNative(operation, input).finally(() => { this.nativeTask = null })
      return this.nativeTask
    }
    if (operation === 'get-model-information') {
      if (!isJsonObject(input) || Object.keys(input).length) throw new PlatformError('INVALID_MODEL_INFORMATION', '模型信息读取参数无效。')
      return this.modelInformationSnapshot()
    }
    if (operation === 'get-model-capabilities') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new PlatformError('INVALID_MODEL_CAPABILITIES', '模型能力读取参数无效。')
      return { ...this.modelCapabilities.read() }
    }
    if (operation === 'save-model-capabilities') {
      if (this.client || this.connectTask || this.stopTask || this.runtimeReady || this.nativeTask || this.nativeHelper) throw failure('MODEL_CAPABILITIES_RUNTIME_ACTIVE', '请先完全停止 DSH，再保存模型图片输入能力。', 'not-sent')
      if (this.modelInformation.selected(this.configuration).model?.capabilities?.imageInput != null) throw failure('MODEL_CAPABILITIES_REPORTED', '当前模型服务已声明图片输入能力，将自动采用；无需重复手动声明。', 'not-sent')
      return { ...this.modelCapabilities.update(input) }
    }
    if (operation === 'detect-system-dsh') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new PlatformError('SYSTEM_DSH_INPUT_INVALID', '系统 DSH 检测参数无效。', 400, 'not-sent')
      this.system = this.locateSystem()
      return { found: this.system !== null, path: this.system?.bin ?? null, version: this.system?.version ?? null, source: this.system?.source ?? null }
    }
    if (operation === 'list-models' || operation === 'read-model-information' || operation === 'test-connection') {
      if (operation === 'read-model-information' && (!isJsonObject(input) || Object.keys(input).length)) throw new PlatformError('INVALID_MODEL_INFORMATION', '模型信息读取参数无效。')
      const configuration = this.configuration
      const controller = new AbortController(); this.managementRequests.add(controller)
      try {
        if (operation === 'test-connection') return { ...await testModelConnection(configuration, controller.signal) }
        const result = await listModels(configuration, controller.signal)
        if (this.closed || controller.signal.aborted || this.configuration !== configuration) throw failure('MODEL_INFORMATION_CHANGED', '模型配置已变化，请重新读取当前模型能力。', 'not-sent')
        this.modelInformation.save(configuration, result.models)
        return operation === 'read-model-information' ? this.modelInformationSnapshot() : { models: result.models.map(model => ({ ...model, ...(model.capabilities ? { capabilities: { ...model.capabilities, inputModalities: model.capabilities.inputModalities ? [...model.capabilities.inputModalities] : null, outputModalities: model.capabilities.outputModalities ? [...model.capabilities.outputModalities] : null } } : {}) })) }
      } finally { this.managementRequests.delete(controller) }
    }
    if (operation === 'open-native-web') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new PlatformError('NATIVE_WEB_INPUT_INVALID', 'DSH Web 入口参数无效。', 400, 'not-sent')
      const value = this.nativeWebReady && this.runtimeReady && this.client ? readRestrictedJson(join(this.bridgeDirectory, 'native-web-ready.json')) : null
      if (!value || !this.validNativeWebEntry(value)) throw failure('NATIVE_WEB_NOT_READY', 'DSH Web 尚未就绪，请先启动 Harness。', 'not-sent')
      return { url: value.url!, rootSessionId: this.metadata!.sessionId }
    }
    throw new PlatformError('MANAGEMENT_OPERATION_NOT_FOUND', 'DSH 未提供此管理操作。', 404, 'not-sent')
  }

  async invoke(_name: string, _input: unknown, _requestId: string): Promise<JsonValue> {
    throw new PlatformError('TOOL_NOT_FOUND', 'DSH 运行管理仅向主人配置页面提供，不暴露管理 MCP 工具。', 404, 'not-sent')
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const controller of this.managementRequests) controller.abort()
    if (this.nativeTask) await this.nativeTask.catch(() => {})
    if (this.nativeHelper) { await this.nativeHelper.close(); this.nativeHelper = null }
    await this.disconnect()
  }
}
