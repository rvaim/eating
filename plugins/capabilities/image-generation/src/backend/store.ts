import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_IMAGE_LIMITS, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { PluginImageAsset } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from '../types'
import type { GeneratedImageItem, ImageGenerationDeleteResult, ImageGenerationJob, ImageGenerationJobError, ImageGenerationPage, ImageGenerationPreview, ImageGenerationSourceSummary } from '../types'
import { ImageStorageError, jsonBytes, prepareDirectory, readBytes, removeOwnBlob, writeBytes } from './files'
import { imageBytes } from './image'
import type { GeneratedImageBytes } from './image'
import { assetIdentifier, identifier, invalid, object, pageInput, safeInteger, text } from './validation'
import type { ResolvedSourceImage } from './validation'

interface StoredJob extends ImageGenerationJob { readonly requestHash: string; readonly sourceHash?: string }
interface State { readonly schemaVersion: 1; readonly revision: number; readonly jobs: readonly StoredJob[]; readonly images: readonly GeneratedImageItem[] }
const MAX_STATE_BYTES = 64 * 1024 * 1024
const hash = (bytes: Buffer | null) => bytes ? createHash('sha256').update(bytes).digest('hex') : null
const stamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const exact = (value: object, keys: string[], optional: string[] = []) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
const interrupted: ImageGenerationJobError = { code: 'IMAGE_GENERATION_INTERRUPTED', message: '上次任务在重启前未确认完成，未自动重放；请求可能已计费。', outcome: 'unknown' }
function corrupt(): never { throw new PlatformError('IMAGE_GENERATION_STATE_CORRUPTED', '生图任务或资源索引损坏或不是当前 schema1，原文件未覆盖。', 500, 'not-sent') }
function publicJob(value: StoredJob): ImageGenerationJob { const { requestHash: _hash, sourceHash: _sourceHash, ...job } = value; return structuredClone(job) }
function sourceSummary(source: ResolvedSourceImage): ImageGenerationSourceSummary {
  return { kind: source.kind, mimeType: source.mimeType, bytes: source.bytes.length, ...(source.assetId ? { assetId: source.assetId } : {}) }
}
function validSource(value: unknown): value is ImageGenerationSourceSummary {
  return isJsonObject(value) && exact(value, ['kind', 'mimeType', 'bytes'], ['assetId']) && ['received', 'asset', 'upload'].includes(String(value.kind))
    && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mimeType)) && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= IMAGE_GENERATION_LIMITS.imageBytes
    && (value.kind === 'asset' ? typeof value.assetId === 'string' && /^[a-f0-9]{64}$/.test(value.assetId) : value.assetId === undefined)
}

/** Only jobs and generated assets are stored here; provider responses, URLs and keys are never indexed. */
export class ImageGenerationStore {
  private value: State
  private fingerprint: string | null
  private readonly path: string
  private readonly blobs: string
  private readonly deletionPath: string
  constructor(directory: string) {
    const root = prepareDirectory(directory)
    this.path = join(root, 'state.json'); this.blobs = join(root, 'blobs')
    this.deletionPath = join(root, 'image-deletion.json')
    if (lstatSync(this.blobs, { throwIfNoEntry: false })?.isSymbolicLink()) corrupt()
    const bytes = readBytes(this.path, MAX_STATE_BYTES)
    this.fingerprint = hash(bytes)
    try { this.value = bytes ? this.validate(JSON.parse(bytes.toString('utf8'))) : { schemaVersion: 1, revision: 0, jobs: [], images: [] } }
    catch { corrupt() }
    this.finishDeletion()
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
      if (!isJsonObject(item) || !exact(item, ['jobId', 'requestId', 'requestHash', 'status', 'prompt', 'model', 'createdAt', 'updatedAt', 'assetIds'], ['error', 'source', 'sourceHash'])
        || typeof item.jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.jobId) || jobs.has(item.jobId) || typeof item.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(item.requestId) || requests.has(item.requestId)
        || typeof item.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.requestHash) || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(item.status))
        || text(item.prompt, IMAGE_GENERATION_LIMITS.prompt, false) !== item.prompt || text(item.model, 160, false) !== item.model || !stamp(item.createdAt) || !stamp(item.updatedAt) || String(item.updatedAt) < String(item.createdAt)
        || !Array.isArray(item.assetIds) || item.assetIds.length > 1 || item.assetIds.some(id => typeof id !== 'string' || !images.has(id))
        || item.source !== undefined && !validSource(item.source)
        || item.sourceHash !== undefined && (typeof item.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceHash))
        || (item.source === undefined) !== (item.sourceHash === undefined)) corrupt()
      if (item.error !== undefined && (!isJsonObject(item.error) || !exact(item.error, ['code', 'message', 'outcome']) || typeof item.error.code !== 'string' || item.error.code.length > 160 || typeof item.error.message !== 'string' || item.error.message.length > 2000 || !['not-sent', 'failed', 'unknown'].includes(String(item.error.outcome)))) corrupt()
      jobs.add(item.jobId); requests.add(item.requestId)
    }
    return value as unknown as State
  }
  private save(next: State, deleting = false): void {
    if (!deleting) this.finishDeletion()
    if (this.value.revision >= Number.MAX_SAFE_INTEGER) throw new ImageStorageError()
    if (hash(readBytes(this.path, MAX_STATE_BYTES)) !== this.fingerprint) throw new PlatformError('IMAGE_GENERATION_STATE_CONFLICT', '生图索引已被其他实例修改，未覆盖原数据。', 409, 'unknown')
    const value = { ...next, revision: this.value.revision + 1 }, bytes = jsonBytes(value)
    if (bytes.length > MAX_STATE_BYTES) throw new ImageStorageError()
    try { writeBytes(this.path, bytes) }
    catch (error) { if (error instanceof ImageStorageError && error.committed) { this.value = value; this.fingerprint = hash(bytes) }; throw error }
    this.value = value; this.fingerprint = hash(bytes)
  }
  private finishDeletion(): void {
    const bytes = readBytes(this.deletionPath, 16 * 1024)
    if (!bytes) return
    let pending: unknown
    try { pending = JSON.parse(bytes.toString('utf8')) } catch { corrupt() }
    if (!isJsonObject(pending) || !exact(pending, ['schemaVersion', 'expectedRevision', 'assetIds']) || pending.schemaVersion !== 1
      || !Number.isSafeInteger(pending.expectedRevision) || Number(pending.expectedRevision) < 0 || !Array.isArray(pending.assetIds)
      || pending.assetIds.length < 1 || pending.assetIds.length > IMAGE_GENERATION_LIMITS.page || new Set(pending.assetIds).size !== pending.assetIds.length
      || pending.assetIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) corrupt()
    if (hash(readBytes(this.path, MAX_STATE_BYTES)) !== this.fingerprint) throw new PlatformError('IMAGE_GENERATION_STATE_CONFLICT', '生图索引已变化，未继续删除。', 409, 'unknown')
    const ids = pending.assetIds as string[], present = ids.filter(id => this.value.images.some(item => item.assetId === id))
    if (this.value.revision === pending.expectedRevision && present.length === ids.length) {
      // The atomic index replacement never committed: retain every original image.
      unlinkSync(this.deletionPath); return
    }
    if (this.value.revision !== Number(pending.expectedRevision) + 1 || present.length) corrupt()
    try {
      for (const id of ids) removeOwnBlob(this.blobs, id)
      unlinkSync(this.deletionPath)
    } catch { throw new PlatformError('IMAGE_GENERATION_DELETE_INCOMPLETE', '图片已从列表移除，但文件清理未完成；请重新读取核对，不要重复提交删除。', 500, 'unknown') }
  }
  remove(input: unknown): ImageGenerationDeleteResult {
    const args = object(input, ['assetIds', 'expectedRevision', 'confirmed'], ['assetIds', 'expectedRevision', 'confirmed'])
    if (args.confirmed !== true) throw new PlatformError('IMAGE_GENERATION_DELETE_CONFIRMATION_REQUIRED', '请确认所选图片和删除数量。', 400, 'not-sent')
    const expectedRevision = safeInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
    if (!Array.isArray(args.assetIds) || args.assetIds.length < 1 || args.assetIds.length > IMAGE_GENERATION_LIMITS.page) invalid()
    const ids = args.assetIds.map(assetIdentifier)
    if (new Set(ids).size !== ids.length) invalid()
    this.finishDeletion()
    if (expectedRevision !== this.value.revision) throw new PlatformError('IMAGE_GENERATION_REVISION_CONFLICT', '图片列表已变化，请刷新后重新选择；未删除。', 409, 'not-sent')
    if (this.value.jobs.some(job => job.status === 'queued' || job.status === 'running')) throw new PlatformError('IMAGE_GENERATION_BUSY', '生成任务仍在执行，请完成后删除。', 409, 'not-sent')
    const selected = this.value.images.filter(item => ids.includes(item.assetId))
    if (selected.length !== ids.length) throw new PlatformError('IMAGE_GENERATION_IMAGE_NOT_FOUND', '所选图片已不存在，请刷新列表；未删除。', 404, 'not-sent')
    if (lstatSync(this.blobs).isSymbolicLink() || realpathSync(this.blobs) !== join(realpathSync(dirname(this.blobs)), 'blobs')) corrupt()
    for (const item of selected) {
      const file = join(this.blobs, item.assetId), stat = lstatSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) corrupt()
    }
    if (hash(readBytes(this.path, MAX_STATE_BYTES)) !== this.fingerprint) throw new PlatformError('IMAGE_GENERATION_STATE_CONFLICT', '生图索引已变化，未删除。', 409, 'not-sent')
    writeBytes(this.deletionPath, jsonBytes({ schemaVersion: 1, expectedRevision, assetIds: ids }))
    this.save({ ...this.value, images: this.value.images.filter(item => !ids.includes(item.assetId)),
      jobs: this.value.jobs.map(job => ({ ...job, assetIds: job.assetIds.filter(id => !ids.includes(id)) })) }, true)
    this.finishDeletion()
    return { revision: this.value.revision, deletedAssetIds: ids, deletedBytes: selected.reduce((total, item) => total + item.bytes, 0) }
  }
  existing(requestId: string, requestHash: string): ImageGenerationJob | null {
    const found = this.value.jobs.find(job => job.requestId === requestId)
    if (found && found.requestHash !== requestHash) throw new PlatformError('IMAGE_GENERATION_IDEMPOTENCY_CONFLICT', '同一 request_id 已用于不同生图参数，未重复请求。', 409, 'not-sent')
    return found ? publicJob(found) : null
  }
  ensureCapacity(maximum = DEFAULT_IMAGE_LIMITS.imageBytes): void {
    const used = this.value.images.reduce((total, item) => total + item.bytes, 0)
    if (this.value.jobs.length >= IMAGE_GENERATION_LIMITS.jobs || this.value.images.length >= IMAGE_GENERATION_LIMITS.images || used + maximum > IMAGE_GENERATION_LIMITS.libraryBytes) throw new PlatformError('IMAGE_GENERATION_CAPACITY_REACHED', '任务或图片容量已满，或剩余空间不足当前单图大小上限；未发送付费请求。', 409, 'not-sent')
  }
  enqueue(requestId: string, requestHash: string, prompt: string, model: string, source?: ResolvedSourceImage, maximum = DEFAULT_IMAGE_LIMITS.imageBytes): ImageGenerationJob {
    this.ensureCapacity(maximum)
    const now = new Date().toISOString(), job: StoredJob = { jobId: randomUUID(), requestId, requestHash, prompt, model, status: 'queued', createdAt: now, updatedAt: now, assetIds: [],
      ...(source ? { source: sourceSummary(source), sourceHash: source.hash } : {}) }
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
    const job = this.job(jobId), image = imageBytes(generated.bytes, generated.mimeType, IMAGE_GENERATION_LIMITS.imageBytes), assetId = createHash('sha256').update(image.bytes).digest('hex')
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
  private assetBytes(assetId: string): { item: GeneratedImageItem; bytes: Buffer; path: string } {
    assetIdentifier(assetId)
    const item = this.value.images.find(item => item.assetId === assetId)
    if (!item) throw new PlatformError('IMAGE_GENERATION_IMAGE_NOT_FOUND', '生成图片不存在。', 404, 'not-sent')
    try {
      const root = dirname(this.blobs), path = join(this.blobs, assetId)
      if (lstatSync(root).isSymbolicLink() || lstatSync(this.blobs).isSymbolicLink() || !lstatSync(this.blobs).isDirectory()
        || realpathSync(this.blobs) !== join(realpathSync(root), 'blobs') || realpathSync(path) !== join(realpathSync(this.blobs), assetId)) corrupt()
      const bytes = readBytes(path, IMAGE_GENERATION_LIMITS.imageBytes)
      if (!bytes || bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== assetId) corrupt()
      imageBytes(bytes, item.mimeType, IMAGE_GENERATION_LIMITS.imageBytes)
      return { item, bytes, path: realpathSync(path) }
    } catch { corrupt() }
  }
  getAsset(assetId: string): PluginImageAsset {
    const { item } = this.assetBytes(assetId)
    return Object.freeze({ mimeType: item.mimeType, byteLength: item.bytes, sha256: item.assetId,
      readBytes: async () => this.assetBytes(assetId).bytes,
      localFile: async () => this.assetBytes(assetId).path,
    })
  }
  get(assetId: string, maximum = IMAGE_GENERATION_LIMITS.imageBytes): ImageGenerationPreview {
    const existing = this.value.images.find(item => item.assetId === assetId)
    if (existing && existing.bytes > maximum) throw new PlatformError('IMAGE_GENERATION_INVALID_IMAGE', '图片超过当前图片大小设置；原图已保留，请调整上限后读取。', 413, 'not-sent')
    const { item, bytes } = this.assetBytes(assetId)
    return { item: structuredClone(item), image: { mimeType: item.mimeType, data: bytes.toString('base64') }, sendable: { type: 'image', data: { file: 'eating-asset://image-generation/' + assetId } } }
  }
  private page<T>(items: readonly T[], input: unknown): ImageGenerationPage<T> {
    const { offset, limit } = pageInput(input), selected = structuredClone(items.slice(offset, offset + limit)), hasMore = offset + selected.length < items.length
    return { revision: this.value.revision, items: selected, offset, limit, total: items.length, hasMore, nextOffset: hasMore ? offset + selected.length : null }
  }
  jobs(input: unknown): ImageGenerationPage<ImageGenerationJob> { return this.page([...this.value.jobs].reverse().map(publicJob), input) }
  images(input: unknown): ImageGenerationPage<GeneratedImageItem> {
    const args = object(input, ['offset', 'limit', 'query']), query = args.query === undefined ? '' : text(args.query, 200).toLocaleLowerCase()
    const { query: _query, ...page } = args
    return this.page([...this.value.images].reverse().filter(item => !query || `${item.prompt}\n${item.model}`.toLocaleLowerCase().includes(query)), page)
  }
}
