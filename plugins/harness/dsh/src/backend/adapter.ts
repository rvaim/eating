import { createHash, randomUUID } from 'node:crypto'
import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { DeepSeekHarnessOptions, HarnessSession } from '@deepseek-ai/dsh-sdk-client'
import { PlatformError, renderTemplate } from '@eating/plugin-sdk'
import type { BackendPlugin, ConnectionStatus, HarnessDeliveryBatch, HarnessDeliveryReceipt, HarnessHostServices, HarnessMessageSink, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { DshConfigurationFile, DshSessionFile, parseConfiguration, prepareRestrictedDirectory, readRestrictedJson, writeRestrictedJson } from './config'
import type { DshConfiguration, DshSessionMetadata } from './config'
import { DSH_VERSION, DshRuntimeInstallation } from './runtime'
import { getRuntimeBridgeSource } from './runtime-bridge'

export interface DshHarnessClient {
  start(): Promise<void>
  session(id: string): Pick<HarnessSession, 'id' | 'run' | 'getWorkingDirectory'>
  resumeSession(id: string): Promise<Pick<HarnessSession, 'id' | 'run' | 'getWorkingDirectory'>>
  close(): Promise<void>
}

export interface DshAdapterOptions {
  readonly runtime?: Pick<DshRuntimeInstallation, 'getStatus' | 'install' | 'resolve' | 'dispose'>
  readonly createHarness?: (options: DeepSeekHarnessOptions) => DshHarnessClient
  readonly pollIntervalMs?: number
  readonly startupTimeoutMs?: number
  readonly readyTimeoutMs?: number
  readonly closeTimeoutMs?: number
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

export function createRuntimeEnvironment(dataDirectory: string, configuration: DshConfiguration,
  mcp: { readonly url: string; readonly headers: Readonly<Record<string, string>> }, nonce: string, sessionId: string,
  parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = resolve(dataDirectory)
  const runtimeHome = join(root, 'runtime-home')
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof parent[key] === 'string') environment[key] = parent[key]
  }
  const authorization = mcp.headers.Authorization ?? mcp.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !authorization.slice(7)) {
    throw failure('MCP_CONNECTION_INVALID', 'QQ MCP 连接认证不可用，未启动 DSH。', 'not-sent')
  }
  return { ...environment, HOME: runtimeHome, USERPROFILE: runtimeHome,
    APPDATA: join(runtimeHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(runtimeHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(runtimeHome, '.config'), XDG_CACHE_HOME: join(runtimeHome, '.cache'), XDG_DATA_HOME: join(runtimeHome, '.local', 'share'),
    DSH_HOME: join(root, 'dsh-home'), DSH_AGENTS_HOME: join(root, 'agents-home'),
    EATING_DSH_API_KEY: configuration.apiKey, EATING_QQ_MCP_URL: mcp.url, EATING_QQ_MCP_TOKEN: authorization.slice(7),
    EATING_DSH_BRIDGE_DIRECTORY: join(root, 'bridge'), EATING_DSH_BRIDGE_NONCE: nonce, EATING_DSH_SESSION_ID: sessionId }
}

export function createRuntimePatch(resolved: { readonly providerEntry: string; readonly mcpEntry: string }, bridgePath: string, configuration: DshConfiguration): string {
  const provider = { providers: { 'eating-openai': { api: 'openai-completions', baseURL: configuration.endpoint,
    apiKeyEnv: 'EATING_DSH_API_KEY', models: [{ id: configuration.model, input: ['text'], reasoningEfforts: false }] } } }
  const disabled = ['llm-deepseek', 'tool-fs', 'tool-working-directory', 'persistent-bash', 'persistent-pwsh', 'mcp-resources', 'terminal-bash', 'terminal-pwsh', 'pty', 'subprocess']
  return disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + `- insert:\n` +
    `    - id: eating-provider\n      name: ${JSON.stringify(resolved.providerEntry)}\n      config: ${JSON.stringify(provider)}\n` +
    `    - id: eating-qq\n      name: ${JSON.stringify(resolved.mcpEntry)}\n      config:\n` +
    `        serverName: qq\n        transport: streamable-http\n        url: !!js process.env.EATING_QQ_MCP_URL\n` +
    '        headers:\n          Authorization: !!js "`Bearer ${process.env.EATING_QQ_MCP_TOKEN}`"\n' +
    `        toolCallTimeoutMs: ${configuration.timeoutMs}\n        failOnStartupError: true\n` +
    `    - id: eating-owner-bridge\n      name: ${JSON.stringify(bridgePath)}\n`
}

/** Owns one official SDK runtime and one persisted session; it never forwards model text. */
export class DshPlugin implements BackendPlugin {
  readonly id = 'dsh'
  readonly kind = 'harness' as const
  readonly name = 'DeepSeek Harness'
  readonly version = '0.1.0'
  readonly tools = []
  readonly capabilities = [
    { id: 'dsh.fixed-session', name: '固定 DSH 主会话', support: 'supported' as const, description: '使用独立官方 DSH 运行时与固定原生会话；可靠交接须经持久屏障。' },
    { id: 'dsh.qq-mcp', name: 'QQ MCP 自主发送', support: 'supported' as const, description: '由 DSH 模型决定是否调用已授权 QQ 工具；模型文本不会由 Host 自动转发。' },
    { id: 'dsh.openai-compatible', name: 'OpenAI 兼容模型接口', support: 'supported' as const, description: '首版支持 OpenAI 兼容基础地址与模型配置。' },
  ]
  private readonly host: HarnessHostServices
  private readonly configurationFile: DshConfigurationFile
  private readonly sessionFile: DshSessionFile
  private readonly runtime: Pick<DshRuntimeInstallation, 'getStatus' | 'install' | 'resolve' | 'dispose'>
  private readonly createHarness: (options: DeepSeekHarnessOptions) => DshHarnessClient
  private readonly bridgeDirectory: string
  private configuration: DshConfiguration
  private metadata: DshSessionMetadata | null
  private client: DshHarnessClient | null = null
  private session: Pick<HarnessSession, 'id' | 'run' | 'getWorkingDirectory'> | null = null
  private detach: (() => void) | null = null
  private lifetime: AbortController | null = null
  private delivery: AbortController | null = null
  private connectTask: Promise<void> | null = null
  private stopTask: Promise<void> | null = null
  private installTask: Promise<void> | null = null
  private installController: AbortController | null = null
  private runTask: Promise<void> | null = null
  private nonce = ''
  private state: ConnectionStatus['state'] = 'disconnected'
  private runtimeReady = false
  private busy = false
  private closed = false
  private lastError: string | null = null
  private connectedAt: string | null = null
  private lastEventAt: string | null = null
  private readonly sink: HarnessMessageSink = { id: 'dsh', isReady: () => this.isReady(), deliverBatch: (batch, signal) => this.deliverBatch(batch, signal) }

  constructor(private readonly context: HostPluginContext, private readonly options: DshAdapterOptions = {}) {
    if (!context.harness) throw failure('HARNESS_CONTEXT_REQUIRED', 'DSH 插件需要 Host 提供已授权的 Harness 接口。', 'not-sent')
    this.host = context.harness
    this.configurationFile = new DshConfigurationFile(context.dataDirectory)
    this.configuration = this.configurationFile.read()
    this.sessionFile = new DshSessionFile(context.dataDirectory)
    this.metadata = this.sessionFile.read()
    this.bridgeDirectory = prepareRestrictedDirectory(join(context.dataDirectory, 'bridge'))
    this.runtime = options.runtime ?? new DshRuntimeInstallation(context.dataDirectory)
    this.createHarness = options.createHarness ?? (configuration => new DeepSeekHarness(configuration))
  }

  getStatus(): ConnectionStatus {
    return { state: !this.configuration.endpoint || !this.configuration.model ? 'unconfigured' : this.state,
      accountId: null, accountName: null, lastError: this.lastError, connectedAt: this.connectedAt, lastEventAt: this.lastEventAt, reconnectAttempt: 0 }
  }

  getPublicConfiguration(): JsonObject {
    const installation = this.runtime.getStatus()
    const { apiKey, ...configuration } = this.configuration
    return { ...configuration, apiKeyConfigured: Boolean(apiKey), configurationPath: this.configurationFile.filePath,
      dataDirectory: this.configurationFile.directory, updatedAt: this.configurationFile.updatedAt,
      runtimeStatus: { version: DSH_VERSION, installed: installation.state === 'ready', installing: installation.state === 'installing',
        progress: installation.state === 'installing' ? '正在安装独立官方 DSH 运行时。' : null, lastError: this.lastError ?? installation.error, ready: this.runtimeReady, busy: this.busy,
        sessionId: this.metadata?.sessionId ?? null, lastOutcome: this.metadata?.lastOutcome ?? null },
      warning: this.configuration.endpoint.startsWith('http:') && !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(this.configuration.endpoint).hostname)
        ? '远端 HTTP 模型地址会明文传输请求与 API 密钥，建议使用 HTTPS。' : null }
  }

  async updateConfiguration(input: unknown): Promise<JsonObject> {
    if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent')
    const next = parseConfiguration(input, this.configuration)
    // Stop first: if shutdown or the atomic save fails, the caller receives a failure.
    await this.disconnect()
    this.configurationFile.write(next)
    this.configuration = next
    this.lastError = null
    return this.getPublicConfiguration()
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent'))
    if (this.connectTask) return this.connectTask
    if (this.runtimeReady) return Promise.resolve()
    this.connectTask = this.startRuntime().finally(() => { this.connectTask = null })
    return this.connectTask
  }

  private async startRuntime(): Promise<void> {
    if (!this.configuration.endpoint || !this.configuration.model) throw failure('NOT_CONFIGURED', '请先保存 OpenAI 兼容地址与模型名称。', 'not-sent')
    if (this.installTask) throw failure('RUNTIME_INSTALLING', 'DSH 运行时正在安装，请等待安装完成。', 'not-sent')
    if (this.stopTask) await this.stopTask
    if (this.client) await this.stopRuntime()
    const installation = this.runtime.getStatus()
    if (installation.state === 'missing') throw failure('RUNTIME_NOT_INSTALLED', '尚未安装专属 DSH 运行时，请先执行安装。', 'not-sent')
    if (installation.state === 'installing') throw failure('RUNTIME_INSTALLING', 'DSH 运行时正在安装，请等待安装完成。', 'not-sent')
    let resolved: ReturnType<DshRuntimeInstallation['resolve']>
    try { resolved = this.runtime.resolve() }
    catch { throw failure('RUNTIME_INVALID', '专属 DSH 运行时损坏或版本不匹配，请检查安装状态。', 'not-sent') }
    const controller = new AbortController()
    this.lifetime = controller
    this.state = 'connecting'
    this.lastError = null
    this.nonce = randomUUID()
    try {
      const mcp = this.host.getMcpConnection('qq')
      if (!this.metadata) {
        this.metadata = { sessionId: randomUUID(), created: false }
        this.sessionFile.write(this.metadata)
      }
      const metadata = this.metadata
      const sessionId = metadata.sessionId
      for (const directory of ['runtime-home', 'dsh-home', 'agents-home', 'workspace']) prepareRestrictedDirectory(join(this.context.dataDirectory, directory))
      this.publishPolicy()
      if (metadata.activeBatchId && metadata.digest) this.publishExpected({ nonce: this.nonce, sessionId, batchId: metadata.activeBatchId, digest: metadata.digest })
      else this.clearUnownedExpected()
      const bridgePath = join(this.bridgeDirectory, 'runtime-bridge.mjs')
      const patchPath = join(this.bridgeDirectory, 'runtime.patch.yaml')
      writePrivateSource(bridgePath, getRuntimeBridgeSource())
      writePrivateSource(patchPath, createRuntimePatch(resolved, bridgePath, this.configuration))
      const workspace = join(resolve(this.context.dataDirectory), 'workspace')
      const client = this.createHarness({ dshBin: resolved.dshBin, profile: 'sdk-minimal', patches: [patchPath],
        dshHome: join(resolve(this.context.dataDirectory), 'dsh-home'), env: createRuntimeEnvironment(this.context.dataDirectory, this.configuration, mcp, this.nonce, sessionId),
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

  private publishPolicy(): { readonly revision: number; readonly personaName: string; readonly messageTemplate: (kind: 'group' | 'private') => string } {
    const owner = this.host.readOwnerConfiguration()
    const main = owner.prompts.find(prompt => prompt.id === 'main')
    if (!main) throw failure('OWNER_CONFIGURATION_INVALID', '主人主提示词不可用，未投递消息。', 'not-sent')
    const personaName = owner.activePersona?.name ?? ''
    const bindings = { 当前时间: new Date().toISOString(), 人格名称: personaName }
    const mainBody = renderTemplate(main.body, 'main', bindings)
    const personaBody = owner.activePersona ? renderTemplate(owner.activePersona.body, 'persona', bindings) : ''
    const systemPrompt = personaBody ? `${mainBody}\n\n${personaBody}` : mainBody
    writeRestrictedJson(join(this.bridgeDirectory, 'owner-policy.json'), { schemaVersion: 1, revision: owner.revision, systemPrompt })
    return { revision: owner.revision, personaName, messageTemplate: kind => {
      const prompt = owner.prompts.find(candidate => candidate.id === kind)
      if (!prompt) throw failure('OWNER_CONFIGURATION_INVALID', '主人消息提示词不可用，未投递消息。', 'not-sent')
      return prompt.body
    } }
  }

  private clearUnownedExpected(): void {
    const path = resolve(this.bridgeDirectory, 'expected.json')
    if (dirname(path) !== this.bridgeDirectory || lstatSync(this.bridgeDirectory).isSymbolicLink()) throw failure('BRIDGE_CONFIGURATION_INVALID', 'DSH 桥接目录无效，未启动运行时。', 'not-sent')
    if (!existsSync(path)) return
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw failure('BRIDGE_CONFIGURATION_INVALID', 'DSH 待交接元数据文件无效，未启动运行时。', 'not-sent')
    // No active batch owns this exact private control file; session history and ACKs remain intact.
    unlinkSync(path)
  }

  private retirePreviousAck(metadata: DshSessionMetadata, nextBatchId: string): void {
    const previousId = metadata.activeBatchId
    if (!previousId || previousId === nextBatchId || !metadata.receiptId || !['durable', 'recovered'].includes(metadata.lastOutcome ?? '')) return
    const path = resolve(this.bridgeDirectory, `ack-${previousId}.json`)
    if (!batchIdPattern.test(previousId) || dirname(path) !== this.bridgeDirectory || lstatSync(this.bridgeDirectory).isSymbolicLink()) {
      throw failure('BRIDGE_CONFIGURATION_INVALID', 'DSH 回执目录无效，未投递下一批消息。', 'not-sent')
    }
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure('BRIDGE_CONFIGURATION_INVALID', 'DSH 旧回执文件无效，未投递下一批消息。', 'not-sent')
      // The next batch has committed its metadata. The idle previous batch is already owned by DSH.
      unlinkSync(path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }

  private publishExpected(identity: BatchIdentity): void {
    writeRestrictedJson(join(this.bridgeDirectory, 'expected.json'), { schemaVersion: 1, ...identity })
  }

  private saveMetadata(metadata: DshSessionMetadata): void {
    this.sessionFile.write(metadata)
    this.metadata = metadata
  }

  isReady(): boolean { return this.runtimeReady && !this.busy && !this.delivery && !this.closed && this.session !== null }

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
    if (batch.protocolVersion !== 1 || !batchIdPattern.test(batch.batchId) || !batch.events.length || batch.events.length > 200) return { accepted: false }
    const first = batch.events[0]!
    if (batch.events.some(event => event.protocolVersion !== 1 || event.source.trust !== 'external' || event.conversationId !== batch.conversationId || event.source.kind !== first.source.kind || event.platform !== first.platform || event.accountId !== first.accountId)) return { accepted: false }
    if (this.metadata?.activeBatchId === batch.batchId) {
      const ack = this.metadata.digest ? this.readAck({ nonce: this.nonce, sessionId: this.metadata.sessionId, batchId: batch.batchId, digest: this.metadata.digest }) : null
      if (ack) return { accepted: true, durable: true, receiptId: ack.receiptId }
      throw failure('DELIVERY_OUTCOME_UNKNOWN', '此批消息已有发送记录但缺少可靠回执，未自动重发。', 'unknown')
    }
    this.busy = true
    const controller = new AbortController()
    this.delivery = controller
    const abort = () => controller.abort()
    const lifetimeSignal = this.lifetime?.signal
    signal.addEventListener('abort', abort, { once: true })
    lifetimeSignal?.addEventListener('abort', abort, { once: true })
    const previousMetadata = this.metadata!
    let metadataPrepared = false
    let sent = false
    let runFinished = false
    try {
      const policy = this.publishPolicy()
      const context = { platform: first.platform, accountId: first.accountId, instanceId: first.instanceId, conversationId: batch.conversationId,
        kind: first.source.kind, createdAt: batch.createdAt, reason: batch.reason, ownerRevision: policy.revision }
      const renderedPrompt = renderTemplate(policy.messageTemplate(first.source.kind), first.source.kind, {
        当前时间: new Date().toISOString(), 人格名称: policy.personaName, 平台: first.platform, 机器人账号: first.accountId,
        会话编号: batch.conversationId, 会话类型: first.source.kind, 发送者列表: JSON.stringify([...new Set(batch.events.map(event => event.senderId))]),
        消息列表: JSON.stringify(batch.events), 消息内容: batch.events[batch.events.length - 1]!.text, 消息数量: String(batch.events.length), 批次编号: batch.batchId,
      })
      const body = { context, renderedPrompt, events: batch.events }
      const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const identity = { nonce: this.nonce, sessionId: this.metadata!.sessionId, batchId: batch.batchId, digest }
      const content = JSON.stringify({ eating: { magic: 'eating-harness-delivery', protocolVersion: 1, ...identity }, ...body })
      this.publishExpected(identity)
      this.saveMetadata({ sessionId: identity.sessionId, created: true, activeBatchId: batch.batchId, digest, nonce: identity.nonce, lastOutcome: 'pending' })
      metadataPrepared = true
      if (signal.aborted || controller.signal.aborted || !this.session || !this.runtimeReady) return { accepted: false }
      this.retirePreviousAck(previousMetadata, batch.batchId)
      sent = true
      const run = this.session.run(content)
      this.lastEventAt = new Date().toISOString()
      const task = run.then(result => {
        if (lifetimeSignal?.aborted || this.closed) return
        const failed = result.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')
        if (failed) this.lastError = 'DSH 模型本轮运行失败；消息交接与模型执行结果分别记录，请检查模型配置。'
      }, () => {
        if (lifetimeSignal?.aborted || this.closed) return
        this.lastError = 'DSH 本轮运行失败；已确认的交接回执不代表模型任务成功。'
        this.runtimeReady = false
        this.state = 'error'
      }).finally(() => {
        runFinished = true
        if (this.runTask === task) {
          this.busy = this.delivery !== null
          this.runTask = null
          if (!this.closed && this.isReady()) this.host.wake()
        }
      })
      this.runTask = task
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
      if (!sent && metadataPrepared) {
        try { this.saveMetadata(previousMetadata) }
        catch { this.runtimeReady = false; this.state = 'error'; this.lastError = 'DSH 未发送批次的元数据恢复失败，已停止接收消息。' }
      }
      if (this.delivery === controller) this.delivery = null
      if (!sent || runFinished) {
        this.busy = false
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
    this.runtimeReady = false
    this.detach?.(); this.detach = null
    this.lifetime?.abort()
    this.delivery?.abort()
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
    if (!this.runTask) this.busy = false
  }

  async manage(operation: string, _input: unknown): Promise<JsonValue> {
    if (this.closed) throw failure('PLUGIN_DISPOSED', 'DSH 插件已停用。', 'not-sent')
    if (operation !== 'install-runtime') throw new PlatformError('MANAGEMENT_OPERATION_NOT_FOUND', 'DSH 未提供此管理操作。', 404, 'not-sent')
    if (this.client || this.connectTask) throw failure('RUNTIME_BUSY', '请先停止 DSH，再安装独立运行时。', 'not-sent')
    if (this.installTask) return { started: true }
    const controller = new AbortController()
    this.installController = controller
    this.lastError = null
    this.installTask = this.runtime.install(controller.signal).catch(() => {
      if (!this.closed) this.lastError = 'DSH 独立运行时安装失败，请检查网络与磁盘空间。'
    }).finally(() => {
      if (this.installController === controller) this.installController = null
      this.installTask = null
    })
    return { started: true }
  }

  async invoke(_name: string, _input: unknown, _requestId: string): Promise<JsonValue> {
    throw new PlatformError('TOOL_NOT_FOUND', 'DSH 运行管理仅向主人配置页面提供，不暴露管理 MCP 工具。', 404, 'not-sent')
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.installController?.abort()
    this.runtime.dispose()
    try { await this.disconnect() }
    finally { await this.installTask }
  }
}
