import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { BackendPlugin, BackendPluginEntry, CapabilityInvocationScope, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { args, hash, SpeechConfig, text } from './backend/config'
import { synthesize } from './backend/provider'
import { SpeechStore } from './backend/store'
import { speechTools } from './backend/tools'
import type { SpeechJob } from './types'

const asJson = (value: unknown) => value as JsonObject
export class SpeechPlugin implements BackendPlugin {
  readonly id = 'text-to-speech'; readonly kind = 'capability' as const; readonly name = '语音合成'; readonly version = '0.1.2'
  readonly tools = speechTools
  readonly capabilities = this.tools.map(tool => ({ id: tool.name, name: tool.title, description: tool.description, support: 'supported' as const, toolName: tool.name }))
  readonly agentInstructions = [{ id: 'text-to-speech.instructions', title: '语音合成与发送', body: '由会话子Agent结合原话、人格和语境决定是否用语音，先组织要说的短口语文本，再调用speech_generate；音色只由主人保存，delivery是本次临时语气，不改全局设置。默认自然口语，需要时才表达情绪，不每句夸张或撒娇。语音为AI合成，首次使用应向听者明确说明，不冒充真人录音。服务只获得待朗读文本和语气，不获得会话历史或工具。提交可能计费，用稳定request_id防重；speech_job_get确认succeeded后，speech_get取得sendable。QQ发送直接传message:[sendable]，其中type=record、data.file为eating-audio引用，不JSON.stringify或当text发。每次语音独立发送，配文另发；只有真实发送成功回执才称已发送。unknown不自动重新生成或重发；已有音频复用资源引用。最多1000字符／60秒，长内容先由会话Agent按语义精简，不机械截断。朗读文本核对失败则不提供可发送音频。' }]
  private readonly configuration: SpeechConfig
  private readonly store: SpeechStore
  private connected = true
  private closed = false
  private lastError: string | null = null
  private active: { id: string; abort: AbortController; done: Promise<void>; finish: () => void } | null = null
  readonly audio = { readTool: 'speech_get', getAsset: async (assetId: string) => { this.assertReady(); return this.store.getAsset(assetId) } }
  constructor(private readonly context: HostPluginContext) { this.configuration = new SpeechConfig(context.dataDirectory); this.store = new SpeechStore(context.dataDirectory) }
  private assertReady(): void { if (this.closed || !this.configuration.public(this.connected).ready) throw new PlatformError('SPEECH_NOT_READY', '请先保存语音服务配置并连接插件。', 409, 'not-sent') }
  getPublicConfiguration(): JsonObject { return asJson(this.configuration.public(this.connected && !this.closed)) }
  getStatus() { return { state: this.closed || !this.connected ? 'disconnected' as const : this.configuration.snapshot().apiKey ? 'connected' as const : 'unconfigured' as const, accountId: null, accountName: null, lastError: this.lastError, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 } }
  async updateConfiguration(input: unknown): Promise<JsonObject> {
    if (this.closed || this.active) throw new PlatformError('SPEECH_BUSY', '请等待任务结束后再保存配置。', 409, 'not-sent')
    this.configuration.update(input); return this.getPublicConfiguration()
  }
  async connect(): Promise<void> { if (this.closed) throw new PlatformError('SPEECH_NOT_READY', '插件已停用。', 409, 'not-sent'); this.connected = true; this.assertReady() }
  async disconnect(): Promise<void> { this.connected = false; if (this.active) { this.active.abort.abort(); await this.active.done } }
  async dispose(): Promise<void> { this.closed = true; await this.disconnect() }
  invoke(name: string, input: unknown, requestId: string): Promise<JsonValue> { return this.execute(name, input, requestId) }
  invokeCapability(name: string, input: unknown, requestId: string, scope: CapabilityInvocationScope): Promise<JsonValue> { return this.execute(name, input, requestId, scope) }
  private async submit(input: unknown, requestId: string, scope?: CapabilityInvocationScope): Promise<SpeechJob> {
    this.assertReady()
    const v = args(input, ['text', 'delivery', 'request_id'], ['text', 'request_id']), spoken = text(v.text, 1000), delivery = v.delivery === undefined ? '' : text(v.delivery, 500, true)
    if (!/[\p{L}\p{N}]/u.test(spoken)) throw new PlatformError('SPEECH_INVALID_INPUT', '请提供包含文字的朗读内容。', 400, 'not-sent')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestId) || requestId !== v.request_id) throw new PlatformError('SPEECH_INVALID_INPUT', '合成需要一致的稳定request_id。', 400, 'not-sent')
    const config = this.configuration.snapshot(), intent = { text: spoken, delivery, model: config.model, voice: config.voice, configuration: hash(JSON.stringify(config)) }, requestHash = hash(JSON.stringify(intent))
    const previous = this.store.existing(requestId, requestHash); if (previous) return previous
    if (this.active) throw new PlatformError('SPEECH_BUSY', '已有合成任务，请先查询。', 409, 'not-sent')
    const authorize = () => { this.assertReady(); if (scope?.signal?.aborted || scope?.source?.signal?.aborted) throw new PlatformError('SPEECH_CANCELLED', '请求提交前授权已撤销。', 409, 'not-sent') }
    authorize()
    let accepted: NonNullable<SpeechPlugin['active']> | null = null
    let result: JsonValue
    try { result = await this.context.executeIdempotent(this.id, 'speech_generate', intent, requestId, async () => {
      authorize()
      if (this.active) throw new PlatformError('SPEECH_BUSY', '已有合成任务，请先查询。', 409, 'not-sent')
      const job = this.store.enqueue({ requestId, requestHash, text: spoken, delivery, model: config.model, voice: config.voice })
      let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve }), active = { id: job.jobId, abort: new AbortController(), done, finish }
      this.active = active; accepted = active
      return { jobId: job.jobId }
    }) } catch (error) {
      const active = accepted as NonNullable<SpeechPlugin['active']> | null
      if (active) { try { this.store.status(active.id, 'unknown', 'SPEECH_STORAGE_FAILED') } finally { this.active = null; active.finish() } }
      throw error
    }
    const active = accepted as NonNullable<SpeechPlugin['active']> | null
    // Provider side effects start only after the durable Host submission receipt.
    if (active) queueMicrotask(() => { void this.run(active, config, spoken, delivery, authorize) })
    if (!isJsonObject(result) || typeof result.jobId !== 'string') throw new PlatformError('SPEECH_RECEIPT_INVALID', '提交回执待核对，不自动重新合成。', 500, 'unknown')
    return this.store.job(result.jobId)
  }
  private async run(active: NonNullable<SpeechPlugin['active']>, config: ReturnType<SpeechConfig['snapshot']>, spoken: string, delivery: string, authorize: () => void) {
    try {
      if (this.active !== active || active.abort.signal.aborted) throw new PlatformError('SPEECH_CANCELLED', '合成已取消。', 409, 'not-sent')
      this.store.status(active.id, 'running')
      const bytes = await synthesize(config, spoken, delivery, active.abort.signal, authorize)
      this.assertReady(); if (active.abort.signal.aborted) throw new PlatformError('SPEECH_CANCELLED', '合成已中断。', 409, 'unknown')
      this.store.complete(active.id, bytes)
    } catch (error) {
      const code = error instanceof PlatformError && /^SPEECH_[A-Z_]+$/.test(error.code) ? error.code : 'SPEECH_STORAGE_FAILED'
      try { this.store.status(active.id, error instanceof PlatformError && error.outcome !== 'unknown' ? 'failed' : 'unknown', code) }
      catch { this.lastError = 'SPEECH_STORAGE_FAILED' }
    } finally { if (this.active === active) this.active = null; active.finish() }
  }
  private async execute(name: string, input: unknown, requestId: string, scope?: CapabilityInvocationScope): Promise<JsonValue> {
    this.assertReady()
    if (scope?.signal?.aborted || scope?.source?.signal?.aborted) throw new PlatformError('SPEECH_CANCELLED', '调用已撤销。', 409, 'not-sent')
    if (name === 'speech_generate') return asJson(await this.submit(input, requestId, scope))
    if (name === 'speech_jobs') return asJson(this.store.page(input))
    if (name === 'speech_job_get') return asJson(await this.job(input))
    if (name === 'speech_get') { const v = args(input, ['assetId'], ['assetId']); return asJson(this.store.preview(v.assetId)) }
    throw new PlatformError('TOOL_NOT_FOUND', '语音工具不存在。', 404, 'not-sent')
  }
  private async job(input: unknown): Promise<SpeechJob> {
    const v = args(input, ['jobId', 'waitMs'], ['jobId']), job = this.store.job(v.jobId), wait = v.waitMs ?? 0
    if (!Number.isSafeInteger(wait) || Number(wait) < 0 || Number(wait) > 20000) throw new PlatformError('SPEECH_INVALID_INPUT', '等待时间无效。', 400, 'not-sent')
    if (this.active?.id === job.jobId && Number(wait) > 0) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([this.active.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Number(wait)) })]) } finally { clearTimeout(timer) } }
    return this.store.job(job.jobId)
  }
  async manage(operation: string, input: unknown): Promise<JsonValue> {
    if (this.closed) this.assertReady()
    if (operation === 'jobs') return asJson(this.store.page(input))
    if (operation === 'job') return asJson(await this.job(input))
    if (operation === 'generate') {
      const v = args(input, ['text', 'request_id', 'confirmed'], ['text', 'request_id', 'confirmed'])
      if (v.confirmed !== true) throw new PlatformError('SPEECH_CONFIRMATION_REQUIRED', '试听会调用云端并可能计费，请确认。', 400, 'not-sent')
      return asJson(await this.submit({ text: v.text, request_id: v.request_id }, String(v.request_id)))
    }
    if (operation === 'preview') { const v = args(input, ['assetId'], ['assetId']), asset = this.store.getAsset(String(v.assetId)); return { mimeType: asset.mimeType, data: Buffer.from(await asset.readBytes()).toString('base64') } }
    if (operation === 'delete') { const v = args(input, ['jobId', 'confirmed'], ['jobId', 'confirmed']); if (v.confirmed !== true) throw new PlatformError('SPEECH_CONFIRMATION_REQUIRED', '请确认删除该任务及音频。', 400, 'not-sent'); this.store.remove(v.jobId); return { deleted: true } }
    throw new PlatformError('SPEECH_OPERATION_NOT_FOUND', '语音管理操作不存在。', 404, 'not-sent')
  }
}
const entry: BackendPluginEntry = { id: 'text-to-speech', kind: 'capability', storageDirectory: 'text-to-speech', create: context => new SpeechPlugin(context) }
export default entry
