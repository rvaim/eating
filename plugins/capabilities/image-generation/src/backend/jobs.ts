import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { CapabilityInvocationScope, HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import type { ImageGenerationJob, ImageGenerationJobError, ImageGenerationParameters } from '../types'
import { IMAGE_GENERATION_LIMITS } from '../types'
import { ImageConfigurationStore, configured } from './config'
import { generateImage } from './provider'
import { ImageGenerationStore } from './store'
import { generationHash, generationIntent, identifier, object, parseGeneration, safeInteger } from './validation'

interface ActiveJob {
  jobId: string | null
  readonly controller: AbortController
  readonly done: Promise<void>
  readonly finish: () => void
  readonly assertBeforePost: () => void
  started: boolean
}
const cancellation: ImageGenerationJobError = { code: 'IMAGE_GENERATION_CANCELLED', message: '生图任务取消或授权已撤销；结果未知，未自动重放。', outcome: 'unknown' }
const failure = (error: unknown): ImageGenerationJobError => error instanceof PlatformError
  ? { code: error.code, message: error.message, outcome: error.outcome }
  : { code: 'IMAGE_GENERATION_FAILED', message: '生图任务未能确认完成；请求可能已计费，未自动重放。', outcome: 'unknown' }

/** Submission is durable and quick; only this worker performs the single paid request. */
export class ImageGenerationJobs {
  private active: ActiveJob | null = null
  private enabled = true
  private closed = false
  private lastFailure: string | null = null
  constructor(private readonly context: HostPluginContext, readonly configuration: ImageConfigurationStore, readonly store: ImageGenerationStore) {}
  get busy(): boolean { return this.active !== null }
  get ready(): boolean { return !this.closed && this.enabled && configured(this.configuration.snapshot()) }
  get error(): string | null { return this.lastFailure }
  assertReady(): void { if (!this.ready) throw new PlatformError('IMAGE_GENERATION_NOT_READY', '请先保存完整生图配置并启用插件；连接仅检查本地配置。', 409, 'not-sent') }
  private assertActive(active: ActiveJob): void {
    if (this.active !== active || !this.ready || active.controller.signal.aborted) throw new PlatformError(cancellation.code, cancellation.message, 409, 'unknown')
  }
  async submit(input: unknown, scope?: CapabilityInvocationScope): Promise<ImageGenerationJob> {
    this.assertReady()
    const parameters = parseGeneration(input), requestHash = generationHash(parameters)
    const previous = this.store.existing(parameters.request_id, requestHash)
    if (previous) return previous
    if (scope?.signal?.aborted || scope?.source?.signal?.aborted) throw new PlatformError(cancellation.code, cancellation.message, 409, 'not-sent')
    if (this.active) throw new PlatformError('IMAGE_GENERATION_BUSY', '已有一个生成任务正在执行，请先查询其结果。', 409, 'not-sent')
    this.store.ensureCapacity()
    const configuration = this.configuration.snapshot(), controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>(accept => { finish = accept })
    const signals = [scope?.signal, scope?.source?.signal].filter((signal): signal is AbortSignal => Boolean(signal))
    const assertBeforePost = () => {
      if (signals.some(signal => signal.aborted)) throw new PlatformError('IMAGE_GENERATION_CANCELLED_BEFORE_SEND', '提交权限在请求发出前已撤销，未发送生成请求。', 409, 'not-sent')
    }
    const active: ActiveJob = { jobId: null, controller, done, finish, started: false, assertBeforePost }
    this.active = active
    let created = false
    try {
      const receipt = await this.context.executeIdempotent('image-generation', 'image_generate', generationIntent(parameters), parameters.request_id, async () => {
        this.assertActive(active)
        const existing = this.store.existing(parameters.request_id, requestHash)
        if (existing) return { jobId: existing.jobId, submitted: true }
        const job = this.store.enqueue(parameters.request_id, requestHash, parameters.prompt, configuration.model)
        active.jobId = job.jobId; created = true
        return { jobId: job.jobId, submitted: true }
      })
      if (!isJsonObject(receipt) || typeof receipt.jobId !== 'string') throw new PlatformError('IMAGE_GENERATION_RECEIPT_INVALID', '生图提交回执无效，未再次请求服务。', 500, 'unknown')
      const job = this.store.job(receipt.jobId)
      if (!created) { this.release(active); return job }
      if (controller.signal.aborted || !this.ready) {
        this.store.fail(job.jobId, cancellation); this.release(active)
        return this.store.job(job.jobId)
      }
      // Schedule only after the durable plugin index and Host submission receipt exist.
      queueMicrotask(() => {
        void this.run(active, configuration, parameters).catch(() => {
          this.lastFailure = '生图工作任务异常结束，结果待核对；未自动重放。'
          this.release(active)
        })
      })
      return job
    } catch (error) {
      try {
        const durable = active.jobId ? this.store.job(active.jobId) : this.store.existing(parameters.request_id, requestHash)
        if (durable) this.store.fail(durable.jobId, { ...failure(error), outcome: 'unknown' })
      } catch { this.lastFailure = '生图提交结果与本地任务状态待核对，未自动重放。' }
      finally { this.release(active) }
      throw error
    }
  }
  private async run(active: ActiveJob, configuration: ReturnType<ImageConfigurationStore['snapshot']>, parameters: ImageGenerationParameters): Promise<void> {
    if (this.active !== active) return
    active.started = true
    let generated = false
    try {
      this.assertActive(active)
      this.store.running(active.jobId!)
      const image = await generateImage(configuration, parameters, active.controller.signal, active.assertBeforePost)
      generated = true
      this.assertActive(active)
      this.store.complete(active.jobId!, image, () => this.assertActive(active))
      this.lastFailure = null
    } catch (error) {
      const status = active.controller.signal.aborted ? cancellation : generated ? { ...failure(error), outcome: 'unknown' as const } : failure(error)
      try { if (active.jobId) this.store.fail(active.jobId, status) }
      catch { this.lastFailure = '生图任务状态保存失败，结果待核对；未自动重放。' }
    } finally { this.release(active) }
  }
  private release(active: ActiveJob): void {
    if (this.active === active) this.active = null
    active.finish()
  }
  async job(input: unknown): Promise<ImageGenerationJob> {
    const args = object(input, ['jobId', 'waitMs'], ['jobId']), id = identifier(args.jobId)
    const wait = args.waitMs === undefined ? 0 : safeInteger(args.waitMs, 0, IMAGE_GENERATION_LIMITS.waitMs)
    const job = this.store.job(id), active = this.active
    if (wait > 0 && active?.jobId === id && (job.status === 'queued' || job.status === 'running')) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([active.done, new Promise<void>(accept => { timer = setTimeout(accept, wait) })]) }
      finally { if (timer !== undefined) clearTimeout(timer) }
    }
    return this.store.job(id)
  }
  connect(): void { if (this.closed) throw new PlatformError('IMAGE_GENERATION_NOT_READY', '生图插件已停用。', 409, 'not-sent'); this.enabled = true }
  async disconnect(dispose = false): Promise<void> {
    this.enabled = false
    if (dispose) this.closed = true
    const active = this.active
    if (!active) return
    active.controller.abort()
    if (!active.started) {
      try { if (active.jobId) this.store.fail(active.jobId, cancellation) }
      finally { this.release(active) }
    }
    await active.done
  }
}

export function asJson(value: unknown): JsonObject { return value as JsonObject }
