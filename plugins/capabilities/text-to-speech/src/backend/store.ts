import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { checkedAudioBytes, MAX_AUDIO_RESOURCE_BYTES, PlatformError } from '@eating/plugin-sdk'
import type { PluginAudioAsset } from '@eating/plugin-sdk'
import type { SpeechJob } from '../types'
import { args, hash, text } from './config'
import { directory, json, read, storageError, write } from './files'

interface Index { schemaVersion: 2; jobs: SpeechJob[] }
const maximumJobs = 200, maximumStorage = 128 * 1024 * 1024
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const jobKeys = ['jobId', 'requestId', 'requestHash', 'text', 'delivery', 'protocol', 'model', 'voice', 'verification', 'status', 'createdAt', 'updatedAt', 'assetId', 'byteLength', 'durationMs', 'errorCode']
export class SpeechStore {
  private readonly root: string
  private readonly path: string
  private readonly assets: string
  private value: Index
  private stamp: string | null
  private failed = false
  constructor(root: string) {
    this.root = directory(root); this.assets = directory(join(this.root, 'audio')); this.path = join(this.root, 'index.json')
    const bytes = read(this.path, 2 * 1024 * 1024); this.stamp = bytes ? hash(bytes) : null
    try {
      const value = bytes ? JSON.parse(bytes.toString()) : { schemaVersion: 2, jobs: [] }
      args(value, ['schemaVersion', 'jobs'], ['schemaVersion', 'jobs'])
      if (value.schemaVersion !== 2 || !Array.isArray(value.jobs) || value.jobs.length > maximumJobs) storageError()
      const ids = new Set(), requests = new Set()
      for (const job of value.jobs) {
        args(job, jobKeys, jobKeys)
        if (!uuid(job.jobId) || ids.has(job.jobId) || requests.has(job.requestId) || !digest(job.requestHash) || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(job.status)
          || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt)) || job.assetId !== null && !digest(job.assetId)
          || job.errorCode !== null && (typeof job.errorCode !== 'string' || !/^SPEECH_[A-Z_]+$/.test(job.errorCode))) storageError()
        text(job.text, 1000); text(job.delivery, 500, true); if (!['openai-realtime', 'deepseek-tts'].includes(job.protocol) || (job.protocol === 'openai-realtime' ? typeof job.model !== 'string' : job.model !== null) || job.model !== null && !job.model.trim()) storageError(); text(job.voice, 160)
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(job.requestId)) storageError()
        if (job.status === 'succeeded' ? !digest(job.assetId) || !Number.isSafeInteger(job.byteLength) || job.byteLength <= 44 || job.byteLength > MAX_AUDIO_RESOURCE_BYTES || job.durationMs !== (job.byteLength - 44) / 48 || job.errorCode !== null || !['provider-transcript', 'provider-completion'].includes(job.verification) || job.verification !== (job.protocol === 'openai-realtime' ? 'provider-transcript' : 'provider-completion') : job.verification !== null || job.assetId !== null || job.byteLength !== null || job.durationMs !== null) storageError()
        ids.add(job.jobId); requests.add(job.requestId)
      }
      this.value = value
    } catch { storageError() }
    let changed = false
    for (const job of this.value.jobs) if (job.status === 'queued' || job.status === 'running') { job.status = 'unknown'; job.errorCode = 'SPEECH_INTERRUPTED'; job.updatedAt = new Date().toISOString(); changed = true }
    if (changed) this.save()
  }
  private save(): void {
    if (this.failed) storageError()
    const bytes = read(this.path, 2 * 1024 * 1024)
    if ((bytes ? hash(bytes) : null) !== this.stamp) storageError()
    const output = json(this.value)
    try { write(this.path, output); this.stamp = hash(output) } catch (error) { this.failed = true; throw error }
  }
  private find(jobId: unknown): SpeechJob {
    if (!uuid(jobId)) throw new PlatformError('SPEECH_INVALID_INPUT', '任务编号无效。', 400, 'not-sent')
    const job = this.value.jobs.find(job => job.jobId === jobId)
    if (!job) throw new PlatformError('SPEECH_NOT_FOUND', '语音任务不存在。', 404, 'not-sent')
    return job
  }
  job(jobId: unknown): SpeechJob { return { ...this.find(jobId) } }
  page(input: unknown): { items: SpeechJob[]; total: number; offset: number; limit: number } {
    const v = args(input, ['offset', 'limit']), offset = v.offset ?? 0, limit = v.limit ?? 20
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new PlatformError('SPEECH_INVALID_INPUT', '分页参数无效。', 400, 'not-sent')
    return { items: [...this.value.jobs].reverse().slice(Number(offset), Number(offset) + Number(limit)).map(job => ({ ...job })), total: this.value.jobs.length, offset: Number(offset), limit: Number(limit) }
  }
  existing(requestId: string, requestHash: string): SpeechJob | null {
    if (this.failed) storageError()
    const job = this.value.jobs.find(job => job.requestId === requestId)
    if (job && job.requestHash !== requestHash) throw new PlatformError('SPEECH_REQUEST_CONFLICT', '相同请求标识不能用于不同文本、语气或配置。', 409, 'not-sent')
    return job ? { ...job } : null
  }
  enqueue(input: Pick<SpeechJob, 'requestId' | 'requestHash' | 'text' | 'delivery' | 'protocol' | 'model' | 'voice'>): SpeechJob {
    if (this.failed) storageError()
    // Count real files too, including a blob left by an interrupted index commit.
    let used = 0
    for (const name of readdirSync(this.assets)) {
      const stat = lstatSync(join(this.assets, name))
      if (!stat.isFile() || stat.isSymbolicLink()) storageError()
      used += stat.size
    }
    if (this.value.jobs.length >= maximumJobs || used + MAX_AUDIO_RESOURCE_BYTES > maximumStorage) throw new PlatformError('SPEECH_CAPACITY', '语音任务或存储已满，请由主人删除不再需要的任务。', 409, 'not-sent')
    const now = new Date().toISOString(), job: SpeechJob = { ...input, jobId: randomUUID(), status: 'queued', verification: null, createdAt: now, updatedAt: now, assetId: null, byteLength: null, durationMs: null, errorCode: null }
    this.value.jobs.push(job); this.save(); return { ...job }
  }
  status(id: string, status: SpeechJob['status'], errorCode: string | null = null): void {
    const job = this.find(id); if (job.status === 'succeeded') return
    Object.assign(job, { status, errorCode, updatedAt: new Date().toISOString() }); this.save()
  }
  complete(id: string, bytes: Buffer, verification: NonNullable<SpeechJob['verification']>): void {
    checkedAudioBytes(bytes, 'audio/wav')
    const job = this.find(id), assetId = hash(id + ':' + hash(bytes))
    write(join(this.assets, assetId), bytes)
    Object.assign(job, { status: 'succeeded', verification, assetId, byteLength: bytes.length, durationMs: (bytes.length - 44) / 48, updatedAt: new Date().toISOString(), errorCode: null }); this.save()
  }
  preview(assetId: unknown) {
    if (!digest(assetId)) throw new PlatformError('SPEECH_INVALID_INPUT', '语音资源编号无效。', 400, 'not-sent')
    const job = this.value.jobs.find(job => job.status === 'succeeded' && job.assetId === assetId)
    if (!job) throw new PlatformError('SPEECH_NOT_FOUND', '语音资源不存在。', 404, 'not-sent')
    return { item: { ...job }, audio_ref: 'eating-audio://text-to-speech/' + assetId, sendable: { type: 'record', data: { file: 'eating-audio://text-to-speech/' + assetId } } }
  }
  getAsset(assetId: string): PluginAudioAsset {
    const { item } = this.preview(assetId), path = join(this.assets, assetId)
    const readBytes = async () => { const bytes = read(path, MAX_AUDIO_RESOURCE_BYTES); if (!bytes) storageError(); const checked = checkedAudioBytes(bytes, 'audio/wav'); if (checked.byteLength !== item.byteLength || hash(item.jobId + ':' + hash(checked)) !== assetId) storageError(); return checked }
    const bytes = read(path, MAX_AUDIO_RESOURCE_BYTES); if (!bytes) storageError(); checkedAudioBytes(bytes, 'audio/wav')
    if (hash(item.jobId + ':' + hash(bytes)) !== assetId) storageError()
    const sha256 = hash(bytes)
    return { mimeType: 'audio/wav', byteLength: item.byteLength!, durationMs: item.durationMs!, sha256, readBytes }
  }
  remove(jobId: unknown): void {
    const job = this.find(jobId)
    if (job.status === 'running' || job.status === 'queued') throw new PlatformError('SPEECH_BUSY', '运行中的任务不能删除。', 409, 'not-sent')
    this.value.jobs = this.value.jobs.filter(entry => entry.jobId !== job.jobId); this.save()
    if (job.assetId) { const path = join(this.assets, job.assetId); if (read(path, MAX_AUDIO_RESOURCE_BYTES)) unlinkSync(path) }
  }
}
