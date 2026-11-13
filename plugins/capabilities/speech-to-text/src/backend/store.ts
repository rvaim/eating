import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { args, hash, text } from './config'
import { directory, json, read, storageError, write } from './files'
import type { RecognitionJob } from '../types'
const keys = ['jobId', 'requestId', 'requestHash', 'owner', 'source', 'protocol', 'audioSha256', 'byteLength', 'mimeType', 'inputDurationMs', 'status', 'createdAt', 'updatedAt', 'text', 'durationMs', 'providerRequestId', 'errorCode']
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v)
export class RecognitionStore {
  private readonly path: string; private stamp: string | null; private jobs: RecognitionJob[]; private failed = false
  constructor(root: string) {
    this.path = join(directory(root), 'index.json'); const bytes = read(this.path, 16 * 1024 * 1024); this.stamp = bytes ? hash(bytes) : null
    try {
      const v = bytes ? args(JSON.parse(bytes.toString()), ['schemaVersion', 'jobs'], ['schemaVersion', 'jobs']) : { schemaVersion: 1, jobs: [] }
      if (v.schemaVersion !== 1 || !Array.isArray(v.jobs) || v.jobs.length > 100) storageError()
      const ids = new Set(), requests = new Set()
      for (const raw of v.jobs) {
        const job = args(raw, keys, keys); const source = args(job.source, job.owner === null ? ['kind'] : ['kind', 'messageId', 'audioId'], job.owner === null ? ['kind'] : ['kind', 'messageId', 'audioId'])
        if (job.owner === null ? source.kind !== 'upload' : !digest(job.owner) || source.kind !== 'received' || !/^(?:0|-?[1-9]\d{0,15})$/.test(String(source.messageId)) || typeof source.messageId !== 'string' || typeof source.audioId !== 'string' || !source.audioId || source.audioId.length > 2048) storageError()
        if (!uuid(job.jobId) || !digest(job.requestHash) || !digest(job.audioSha256) || ids.has(job.jobId) || requests.has(job.requestId) || job.protocol !== 'deepseek-asr'
          || !Number.isSafeInteger(job.byteLength) || Number(job.byteLength) < 44 || Number(job.byteLength) > 8 * 1024 * 1024 || !['audio/wav', 'audio/ogg'].includes(String(job.mimeType))
          || typeof job.inputDurationMs !== 'number' || !(job.inputDurationMs > 0 && job.inputDurationMs <= 120000) || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(job.status))
          || typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string' || !Number.isFinite(Date.parse(String(job.createdAt))) || !Number.isFinite(Date.parse(String(job.updatedAt))) || typeof job.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(job.requestId)
          || job.errorCode !== null && (typeof job.errorCode !== 'string' || !/^[A-Z_]+$/.test(job.errorCode))) storageError()
        if (job.status === 'succeeded') { text(job.text, 32000, true); text(job.providerRequestId, 256); if (!Number.isSafeInteger(job.durationMs) || Number(job.durationMs) < 0 || Number(job.durationMs) > 120000 || job.errorCode !== null) storageError() }
        else if (job.text !== null || job.providerRequestId !== null || job.durationMs !== null) storageError()
        ids.add(job.jobId); requests.add(job.requestId)
      }
      this.jobs = v.jobs as RecognitionJob[]
    } catch { storageError() }
    let changed = false
    for (const job of this.jobs) if (['queued', 'running'].includes(job.status)) { job.status = 'unknown'; job.errorCode = 'ASR_INTERRUPTED'; job.updatedAt = new Date().toISOString(); changed = true }
    if (changed) this.save()
  }
  private save() {
    if (this.failed) storageError()
    const bytes = read(this.path, 16 * 1024 * 1024)
    if ((bytes ? hash(bytes) : null) !== this.stamp) storageError()
    const output = json({ schemaVersion: 1, jobs: this.jobs }); if (output.byteLength > 16 * 1024 * 1024) storageError()
    try { write(this.path, output); this.stamp = hash(output) } catch (error) { this.failed = true; throw error }
  }
  job(id: unknown): RecognitionJob {
    if (!uuid(id)) throw new Error('ASR_INVALID_INPUT')
    const job = this.jobs.find(j => j.jobId === id); if (!job) throw new Error('ASR_NOT_FOUND')
    return structuredClone(job)
  }
  existing(id: string, requestHash: string): RecognitionJob | null {
    if (this.failed) storageError()
    const job = this.jobs.find(j => j.requestId === id)
    if (job && job.requestHash !== requestHash) throw new Error('ASR_REQUEST_CONFLICT')
    return job ? structuredClone(job) : null
  }
  page(input: unknown, visible: (j: RecognitionJob) => boolean = () => true) {
    const v = args(input, ['offset', 'limit']), offset = v.offset ?? 0, limit = v.limit ?? 20
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new Error('ASR_INVALID_INPUT')
    const all = [...this.jobs].reverse().filter(visible)
    return { items: all.slice(Number(offset), Number(offset) + Number(limit)).map(job => { const { text, ...metadata } = structuredClone(job); return { ...metadata, textPreview: text === null ? null : text.slice(0, 160), textTruncated: text !== null && text.length > 160 } }), total: all.length, offset: Number(offset), limit: Number(limit) }
  }
  enqueue(input: Omit<RecognitionJob, 'jobId' | 'status' | 'createdAt' | 'updatedAt' | 'text' | 'durationMs' | 'providerRequestId' | 'errorCode'>) {
    if (this.jobs.length >= 100) throw new Error('ASR_CAPACITY')
    const now = new Date().toISOString(), job: RecognitionJob = { ...input, jobId: randomUUID(), status: 'queued', createdAt: now, updatedAt: now, text: null, durationMs: null, providerRequestId: null, errorCode: null }
    this.jobs.push(job); this.save(); return structuredClone(job)
  }
  status(id: string, status: RecognitionJob['status'], errorCode: string | null = null) {
    const j = this.jobs.find(j => j.jobId === id); if (!j || j.status === 'succeeded') return
    Object.assign(j, { status, errorCode, updatedAt: new Date().toISOString() }); this.save()
  }
  complete(id: string, result: { text: string; durationMs: number; providerRequestId: string }) {
    const job = this.jobs.find(j => j.jobId === id); if (!job) storageError()
    Object.assign(job, result, { status: 'succeeded', errorCode: null, updatedAt: new Date().toISOString() }); this.save()
  }
  remove(id: unknown) { const job = this.job(id); if (['queued', 'running'].includes(job.status)) throw new Error('ASR_BUSY'); this.jobs = this.jobs.filter(j => j.jobId !== id); this.save() }
}
