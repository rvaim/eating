import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from '../types'
import type { GeneratedImageItem, ImageGenerationJob, ImageGenerationJobError, ImageGenerationPage, ImageGenerationPreview } from '../types'
import { ImageStorageError, jsonBytes, prepareDirectory, readBytes, removeOwnBlob, writeBytes } from './files'
import { imageBytes } from './image'
import type { GeneratedImageBytes } from './image'
import { assetIdentifier, identifier, pageInput, text } from './validation'

interface StoredJob extends ImageGenerationJob { readonly requestHash: string }
interface State { readonly schemaVersion: 1; readonly revision: number; readonly jobs: readonly StoredJob[]; readonly images: readonly GeneratedImageItem[] }
const MAX_STATE_BYTES = 64 * 1024 * 1024
const hash = (bytes: Buffer | null) => bytes ? createHash('sha256').update(bytes).digest('hex') : null
const stamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const exact = (value: object, keys: string[], optional: string[] = []) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
const interrupted: ImageGenerationJobError = { code: 'IMAGE_GENERATION_INTERRUPTED', message: '上次任务在重启前未确认完成，未自动重放；请求可能已计费。', outcome: 'unknown' }
function corrupt(): never { throw new PlatformError('IMAGE_GENERATION_STATE_CORRUPTED', '生图任务或资源索引损坏或不是当前 schema1，原文件未覆盖。', 500, 'not-sent') }
function publicJob(value: StoredJob): ImageGenerationJob { const { requestHash: _hash, ...job } = value; return structuredClone(job) }

/** Only jobs and generated assets are stored here; provider responses, URLs and keys are never indexed. */
export class ImageGenerationStore {
  private value: State
  private fingerprint: string | null
  private readonly path: string
  private readonly blobs: string
  constructor(directory: string) {
    const root = prepareDirectory(directory)
    this.path = join(root, 'state.json'); this.blobs = join(root, 'blobs')
    if (lstatSync(this.blobs, { throwIfNoEntry: false })?.isSymbolicLink()) corrupt()
    const bytes = readBytes(this.path, MAX_STATE_BYTES)
    this.fingerprint = hash(bytes)
    try { this.value = bytes ? this.validate(JSON.parse(bytes.toString('utf8'))) : { schemaVersion: 1, revision: 0, jobs: [], images: [] } }
    catch { corrupt() }
    if (this.value.jobs.some(job => job.status === 'queued' || job.status === 'running')) {
      const now = new Date().toISOString()
      this.save({ ...this.value, jobs: this.value.jobs.map(job => job.status === 'queued' || job.status === 'running' ? { ...job, status: 'unknown', error: interrupted, updatedAt: now } : job) })
    }
  }
  private validate(value: unknown): State {
    if (!isJsonObject(value) || !exact(value, ['schemaVersion', 'revision', 'jobs', 'images']) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
      || !Array.isArray(value.jobs) || value.jobs.length > IMAGE_GENERATION_LIMITS.jobs || !Array.isArray(value.images) || value.images.length > IMAGE_GENERATION_LIMITS.images) corrupt()
    const images = new Set<string>(), jobs = new Set<string>(), requests = new Set<string>()
    let bytes = 0
    for (const item of value.images) {
      if (!isJsonObject(item) || !exact(item, ['assetId', 'prompt', 'model', 'mimeType', 'bytes', 'createdAt']) || typeof item.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(item.assetId) || images.has(item.assetId)
        || text(item.prompt, IMAGE_GENERATION_LIMITS.prompt, false) !== item.prompt || text(item.model, 160, false) !== item.model || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mimeType))
        || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > IMAGE_GENERATION_LIMITS.imageBytes || !stamp(item.createdAt)) corrupt()
      const stat = lstatSync(join(this.blobs, item.assetId), { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) corrupt()
      images.add(item.assetId); bytes += item.bytes
    }
    if (bytes > IMAGE_GENERATION_LIMITS.libraryBytes) corrupt()
    for (const item of value.jobs) {
      if (!isJsonObject(item) || !exact(item, ['jobId', 'requestId', 'requestHash', 'status', 'prompt', 'model', 'createdAt', 'updatedAt', 'assetIds'], ['error'])
        || typeof item.jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.jobId) || jobs.has(item.jobId) || typeof item.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(item.requestId) || requests.has(item.requestId)
        || typeof item.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.requestHash) || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(item.status))
        || text(item.prompt, IMAGE_GENERATION_LIMITS.prompt, false) !== item.prompt || text(item.model, 160, false) !== item.model || !stamp(item.createdAt) || !stamp(item.updatedAt) || String(item.updatedAt) < String(item.createdAt)
        || !Array.isArray(item.assetIds) || item.assetIds.length > 1 || item.assetIds.some(id => typeof id !== 'string' || !images.has(id)) || item.status === 'succeeded' && item.assetIds.length !== 1) corrupt()
      if (item.error !== undefined && (!isJsonObject(item.error) || !exact(item.error, ['code', 'message', 'outcome']) || typeof item.error.code !== 'string' || item.error.code.length > 160 || typeof item.error.message !== 'string' || item.error.message.length > 2000 || !['not-sent', 'failed', 'unknown'].includes(String(item.error.outcome)))) corrupt()
      jobs.add(item.jobId); requests.add(item.requestId)
    }
    return value as unknown as State
  }
  private save(next: State): void {
    if (hash(readBytes(this.path, MAX_STATE_BYTES)) !== this.fingerprint) throw new PlatformError('IMAGE_GENERATION_STATE_CONFLICT', '生图索引已被其他实例修改，未覆盖原数据。', 409, 'unknown')
    const value = { ...next, revision: this.value.revision + 1 }, bytes = jsonBytes(value)
    if (bytes.length > MAX_STATE_BYTES) throw new ImageStorageError()
    try { writeBytes(this.path, bytes) }
    catch (error) { if (error instanceof ImageStorageError && error.committed) { this.value = value; this.fingerprint = hash(bytes) }; throw error }
    this.value = value; this.fingerprint = hash(bytes)
  }
  existing(requestId: string, requestHash: string): ImageGenerationJob | null {
    const found = this.value.jobs.find(job => job.requestId === requestId)
    if (found && found.requestHash !== requestHash) throw new PlatformError('IMAGE_GENERATION_IDEMPOTENCY_CONFLICT', '同一 request_id 已用于不同生图参数，未重复请求。', 409, 'not-sent')
    return found ? publicJob(found) : null
  }
  ensureCapacity(): void {
    const used = this.value.images.reduce((total, item) => total + item.bytes, 0)
    if (this.value.jobs.length >= IMAGE_GENERATION_LIMITS.jobs || this.value.images.length >= IMAGE_GENERATION_LIMITS.images || used + IMAGE_GENERATION_LIMITS.imageBytes > IMAGE_GENERATION_LIMITS.libraryBytes) throw new PlatformError('IMAGE_GENERATION_CAPACITY_REACHED', '任务或图片容量已满，或剩余空间不足单图 5 MiB 上限；未发送付费请求。', 409, 'not-sent')
  }
  enqueue(requestId: string, requestHash: string, prompt: string, model: string): ImageGenerationJob {
    this.ensureCapacity()
    const now = new Date().toISOString(), job: StoredJob = { jobId: randomUUID(), requestId, requestHash, prompt, model, status: 'queued', createdAt: now, updatedAt: now, assetIds: [] }
    this.save({ ...this.value, jobs: [...this.value.jobs, job] })
    return publicJob(job)
  }
  job(jobId: string): ImageGenerationJob {
    identifier(jobId)
    const job = this.value.jobs.find(job => job.jobId === jobId)
    if (!job) throw new PlatformError('IMAGE_GENERATION_JOB_NOT_FOUND', '生图任务不存在，未重新提交。', 404, 'not-sent')
    return publicJob(job)
  }
  running(jobId: string): void { this.replace(jobId, job => ({ ...job, status: 'running', updatedAt: new Date().toISOString() })) }
  fail(jobId: string, error: ImageGenerationJobError): void { this.replace(jobId, job => ({ ...job, status: error.outcome === 'unknown' ? 'unknown' : 'failed', updatedAt: new Date().toISOString(), error })) }
  private replace(jobId: string, change: (job: StoredJob) => StoredJob): void {
    if (!this.value.jobs.some(job => job.jobId === jobId)) throw new ImageStorageError()
    this.save({ ...this.value, jobs: this.value.jobs.map(job => job.jobId === jobId ? change(job) : job) })
  }
  complete(jobId: string, generated: GeneratedImageBytes, assertActive: () => void): void {
    assertActive()
    const job = this.job(jobId), image = imageBytes(generated.bytes, generated.mimeType), assetId = createHash('sha256').update(image.bytes).digest('hex')
    const present = this.value.images.find(item => item.assetId === assetId)
    prepareDirectory(this.blobs)
    const path = join(this.blobs, assetId), created = !lstatSync(path, { throwIfNoEntry: false })
    try {
      if (present) this.get(assetId)
      else writeBytes(path, image.bytes)
      assertActive()
      const item: GeneratedImageItem = { assetId, prompt: job.prompt, model: job.model, mimeType: image.mimeType, bytes: image.bytes.length, createdAt: new Date().toISOString() }
      this.save({ ...this.value, images: present ? this.value.images : [...this.value.images, item], jobs: this.value.jobs.map(entry => entry.jobId === jobId ? { ...entry, status: 'succeeded', updatedAt: new Date().toISOString(), assetIds: [assetId] } : entry) })
    } catch (error) {
      if (created && !this.value.images.some(item => item.assetId === assetId)) removeOwnBlob(this.blobs, assetId)
      throw error
    }
  }
  get(assetId: string): ImageGenerationPreview {
    assetIdentifier(assetId)
    const item = this.value.images.find(item => item.assetId === assetId)
    if (!item) throw new PlatformError('IMAGE_GENERATION_IMAGE_NOT_FOUND', '生成图片不存在。', 404, 'not-sent')
    const bytes = readBytes(join(this.blobs, assetId), IMAGE_GENERATION_LIMITS.imageBytes)
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== assetId) corrupt()
    imageBytes(bytes, item.mimeType)
    return { item: structuredClone(item), image: { mimeType: item.mimeType, data: bytes.toString('base64') }, sendable: { type: 'image', data: { file: 'eating-asset://image-generation/' + assetId } } }
  }
  private page<T>(items: readonly T[], input: unknown): ImageGenerationPage<T> {
    const { offset, limit } = pageInput(input), selected = structuredClone(items.slice(offset, offset + limit)), hasMore = offset + selected.length < items.length
    return { items: selected, offset, limit, total: items.length, hasMore, nextOffset: hasMore ? offset + selected.length : null }
  }
  jobs(input: unknown): ImageGenerationPage<ImageGenerationJob> { return this.page([...this.value.jobs].reverse().map(publicJob), input) }
  images(input: unknown): ImageGenerationPage<GeneratedImageItem> { return this.page([...this.value.images].reverse(), input) }
}
