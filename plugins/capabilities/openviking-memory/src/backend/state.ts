import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryScope } from '@eating/plugin-sdk'
import type { MemoryJob, ScopeSummary } from '../types'
import { directory, readBytes, writeJson } from './files'
import { parsePeer, peerId, scope } from './scopes'
import { bool, error, identifier, integer, LIMITS, object, serviceIdentity, text, timestamp } from './validation'

export interface RequestKey { id: string; hash: string }
export interface StoredJob extends MemoryJob { configurationKey: string; global: boolean; requests: RequestKey[]; staged: boolean; commitAttempted: boolean; terminalStatus: 'completed' | 'failed' | null; extractionErrorCode: string | null }
interface State { schemaVersion: 1; jobs: StoredJob[]; scopes: ScopeSummary[]; lastRecallAt: string | null; lastCaptureAt: string | null; lastErrorCode: string | null; extractionDay: string; extractionCount: number }
const now = (): string => new Date().toISOString()
export function localDay(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const nullableTime = (value: unknown): string | null => value === null ? null : timestamp(value)
const code = (value: unknown): string | null => { if (value === null) return null; if (typeof value !== 'string' || !/^MEMORY_[A-Z_]+$/.test(value)) throw error('MEMORY_STATE_CORRUPTED', 500); return value }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw error('MEMORY_STATE_CORRUPTED', 500); return value }
function changes(value: unknown): MemoryJob['changes'] { if (value === null) return null; const input = object(value, ['added', 'updated', 'deleted']); return { added: integer(input.added, 0, Number.MAX_SAFE_INTEGER), updated: integer(input.updated, 0, Number.MAX_SAFE_INTEGER), deleted: integer(input.deleted, 0, Number.MAX_SAFE_INTEGER) } }
function storedJob(value: unknown): StoredJob {
  const job = object(value, ['id', 'peerId', 'sessionId', 'taskId', 'archiveUri', 'status', 'createdAt', 'updatedAt', 'messages', 'changes', 'errorCode', 'configurationKey', 'global', 'requests', 'staged', 'commitAttempted', 'terminalStatus', 'extractionErrorCode'])
  const id = identifier(job.id, 64), peer = text(job.peerId, 240); parsePeer(peer)
  if (!/^[a-f0-9-]{36}$/.test(id) || job.sessionId !== 'eating-' + id || !['queued', 'submitting', 'processing', 'cleaning', 'completed', 'failed', 'unknown'].includes(String(job.status)) || !Array.isArray(job.requests) || job.requests.length > LIMITS.messages) throw error('MEMORY_STATE_CORRUPTED', 500)
  const taskId = job.taskId === null ? null : identifier(job.taskId, 160), archiveUri = job.archiveUri === null ? null : archive(job.archiveUri, 'eating-' + id)
  const staged = bool(job.staged), commitAttempted = bool(job.commitAttempted)
  if (job.terminalStatus !== null && (!['completed', 'failed'].includes(String(job.terminalStatus)) || !taskId)) throw error('MEMORY_STATE_CORRUPTED', 500)
  if (commitAttempted && !staged || Boolean(taskId) !== Boolean(archiveUri) || taskId && !commitAttempted || ['processing', 'completed'].includes(String(job.status)) && !taskId || job.status === 'cleaning' && !taskId && (!staged || commitAttempted)) throw error('MEMORY_STATE_CORRUPTED', 500)
  return { id, peerId: peer, sessionId: 'eating-' + id, taskId, archiveUri, status: job.status as StoredJob['status'], createdAt: timestamp(job.createdAt), updatedAt: timestamp(job.updatedAt), messages: integer(job.messages, 0, LIMITS.messages), changes: changes(job.changes), errorCode: code(job.errorCode), configurationKey: digest(job.configurationKey), global: bool(job.global), staged, commitAttempted, terminalStatus: job.terminalStatus as StoredJob['terminalStatus'], extractionErrorCode: code(job.extractionErrorCode), requests: job.requests.map(value => { const key = object(value, ['id', 'hash']); return { id: digest(key.id), hash: digest(key.hash) } }) }
}
export function archive(value: unknown, sessionId: string, user?: string): string {
  const uri = text(value, 768), prefix = 'viking://user/', parts = uri.slice(prefix.length).split('/')
  try {
    const owner = serviceIdentity(parts[0])
    if (!uri.startsWith(prefix) || parts.length !== 5 || user !== undefined && owner !== serviceIdentity(user) || parts[1] !== 'sessions' || parts[2] !== identifier(sessionId, 64) || parts[3] !== 'history' || !/^archive_[0-9]{3,}$/.test(parts[4]!)) throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'unknown')
  } catch { throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'unknown') }
  return uri
}
function summary(value: unknown): ScopeSummary {
  const input = object(value, ['peerId', 'scope', 'label', 'capture', 'recall', 'bufferedMessages', 'lastSeenAt']), current = scope(input.scope)
  if (input.peerId !== peerId(current)) throw error('MEMORY_STATE_CORRUPTED', 500)
  return { peerId: peerId(current), scope: current, label: text(input.label, 240, true), capture: bool(input.capture), recall: bool(input.recall), bufferedMessages: integer(input.bufferedMessages, 0, LIMITS.messages), lastSeenAt: nullableTime(input.lastSeenAt) }
}
function state(value: unknown): State {
  const input = object(value, ['schemaVersion', 'jobs', 'scopes', 'lastRecallAt', 'lastCaptureAt', 'lastErrorCode', 'extractionDay', 'extractionCount'])
  if (input.schemaVersion !== 1 || !Array.isArray(input.jobs) || input.jobs.length > LIMITS.jobs || !Array.isArray(input.scopes) || input.scopes.length > LIMITS.scopes) throw error('MEMORY_STATE_CORRUPTED', 500)
  const jobs = input.jobs.map(storedJob), scopes = input.scopes.map(summary)
  if (new Set(jobs.map(job => job.id)).size !== jobs.length || new Set(scopes.map(item => item.peerId)).size !== scopes.length || typeof input.extractionDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.extractionDay) || jobs.reduce((count, job) => count + job.requests.length, 0) > 4096) throw error('MEMORY_STATE_CORRUPTED', 500)
  return { schemaVersion: 1, jobs, scopes, lastRecallAt: nullableTime(input.lastRecallAt), lastCaptureAt: nullableTime(input.lastCaptureAt), lastErrorCode: code(input.lastErrorCode), extractionDay: input.extractionDay, extractionCount: integer(input.extractionCount, 0, Number.MAX_SAFE_INTEGER) }
}
export class StateStore {
  readonly value: State
  private readonly path: string
  constructor(root: string) {
    this.path = join(directory(root), 'state.json')
    try { const bytes = readBytes(this.path, 4 * 1024 * 1024); this.value = bytes ? state(JSON.parse(bytes.toString('utf8'))) : { schemaVersion: 1, jobs: [], scopes: [], lastRecallAt: null, lastCaptureAt: null, lastErrorCode: null, extractionDay: localDay(), extractionCount: 0 } }
    catch { throw error('MEMORY_STATE_CORRUPTED', 500) }
    let changed = false
    for (const job of this.value.jobs) {
      if (job.status === 'queued') { job.status = 'failed'; job.errorCode = 'MEMORY_BUFFER_LOST'; job.updatedAt = now(); changed = true }
      if (job.status === 'submitting') { job.status = job.staged && !job.commitAttempted ? 'cleaning' : 'unknown'; job.errorCode = job.status === 'cleaning' ? 'MEMORY_BUFFER_LOST' : 'MEMORY_SUBMISSION_UNKNOWN'; job.updatedAt = now(); changed = true }
    }
    for (const item of this.value.scopes) { if (item.bufferedMessages) changed = true; item.bufferedMessages = 0 }
    if (changed) this.save()
  }
  save(): void { writeJson(this.path, this.value) }
  existing(request: RequestKey, peer: string): StoredJob | undefined {
    for (const job of this.value.jobs) {
      const previous = job.requests.find(key => key.id === request.id)
      if (!previous) continue
      if (previous.hash !== request.hash || job.peerId !== peer) throw error('MEMORY_IDEMPOTENCY_CONFLICT', 409)
      return job
    }
    return undefined
  }
  capacity(newJob = true): void {
    while (newJob && this.value.jobs.length >= LIMITS.jobs || this.value.jobs.reduce((count, job) => count + job.requests.length, 0) >= 4096) {
      const index = this.value.jobs.findIndex(job => job.status === 'completed' || job.status === 'failed')
      if (index < 0) throw error('MEMORY_CAPACITY', 409)
      this.value.jobs.splice(index, 1)
    }
  }
  create(peer: string, configurationKey: string, global: boolean): StoredJob {
    this.capacity()
    const id = randomUUID(), at = now(), job: StoredJob = { id, peerId: peer, sessionId: 'eating-' + id, taskId: null, archiveUri: null, status: 'queued', createdAt: at, updatedAt: at, messages: 0, changes: null, errorCode: null, configurationKey, global, requests: [], staged: false, commitAttempted: false, terminalStatus: null, extractionErrorCode: null }
    this.value.jobs.push(job); return job
  }
  update(job: StoredJob, patch: Partial<Pick<StoredJob, 'taskId' | 'archiveUri' | 'status' | 'messages' | 'changes' | 'errorCode' | 'staged' | 'commitAttempted' | 'terminalStatus' | 'extractionErrorCode'>>): void {
    if (patch.status === 'completed' && job.status !== 'completed') {
      const today = localDay()
      if (this.value.extractionDay !== today) { this.value.extractionDay = today; this.value.extractionCount = 0 }
      this.value.extractionCount++
    }
    Object.assign(job, patch, { updatedAt: now() }); this.save()
  }
  touch(current: MemoryScope, capture: boolean, recall: boolean, bufferedMessages: number, seen = true): void {
    const peer = peerId(current); let item = this.value.scopes.find(item => item.peerId === peer)
    if (!item) {
      if (this.value.scopes.length >= LIMITS.scopes) {
        const index = this.value.scopes.findIndex(item => item.bufferedMessages === 0)
        if (index < 0) throw error('MEMORY_CAPACITY', 409)
        this.value.scopes.splice(index, 1)
      }
      item = { peerId: peer, scope: { ...current, owner: false }, label: peer, capture, recall, bufferedMessages, lastSeenAt: null }; this.value.scopes.push(item)
    }
    item.capture = capture; item.recall = recall; item.bufferedMessages = bufferedMessages
    if (seen) item.lastSeenAt = now()
  }
  publicJobs(): MemoryJob[] { return [...this.value.jobs].reverse().map(({ configurationKey: _configurationKey, global: _global, requests: _requests, staged: _staged, commitAttempted: _commitAttempted, terminalStatus: _terminalStatus, extractionErrorCode: _extractionErrorCode, ...job }) => structuredClone(job)) }
}
