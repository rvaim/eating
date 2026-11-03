import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryScope } from '@eating/plugin-sdk'
import type { CommitTrigger, MemoryJob, ScopeSummary } from '../types'
import { directory, readBytes, writeJson } from './files'
import { parsePeer, peerId, scope } from './scopes'
import { bool, error, identifier, integer, LIMITS, object, serviceIdentity, text, timestamp } from './validation'

export interface RequestKey { id: string; hash: string }
export interface StoredJob extends MemoryJob {
  configurationKey: string
  global: boolean
  requests: RequestKey[]
  mutation: 'create' | 'append' | 'commit' | null
}
interface State { schemaVersion: 3; jobs: StoredJob[]; scopes: ScopeSummary[]; lastRecallAt: string | null; lastCaptureAt: string | null; lastErrorCode: string | null; extractionDay: string; extractionCount: number }
const now = (): string => new Date().toISOString()
export function localDay(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function sessionId(peer: string, global: boolean): string { parsePeer(peer); return 'eating-standard-' + peer + (global ? '' : '-local') }
const nullableTime = (value: unknown): string | null => value === null ? null : timestamp(value)
const code = (value: unknown): string | null => { if (value === null) return null; if (typeof value !== 'string' || !/^MEMORY_[A-Z_]+$/.test(value)) throw error('MEMORY_STATE_CORRUPTED', 500); return value }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw error('MEMORY_STATE_CORRUPTED', 500); return value }
function storedJob(value: unknown): StoredJob {
  const job = object(value, ['id', 'kind', 'trigger', 'peerId', 'sessionId', 'commitId', 'taskId', 'archiveUri', 'status', 'createdAt', 'updatedAt', 'messages', 'syncedMessages', 'pendingTokens', 'errorCode', 'configurationKey', 'global', 'requests', 'mutation'])
  const id = identifier(job.id, 64), peer = text(job.peerId, 240), global = bool(job.global), session = identifier(job.sessionId, 255)
  if (!/^[a-f0-9-]{36}$/.test(id) || session !== sessionId(peer, global) || !['append', 'commit'].includes(String(job.kind)) || !['queued', 'syncing', 'synced', 'committing', 'processing', 'completed', 'failed', 'unknown'].includes(String(job.status)) || !Array.isArray(job.requests) || job.requests.length > 1) throw error('MEMORY_STATE_CORRUPTED', 500)
  const taskId = job.taskId === null ? null : identifier(job.taskId, 160), archiveUri = job.archiveUri === null ? null : archive(job.archiveUri, session)
  const commitId = job.commitId === null ? null : identifier(job.commitId, 64), pendingTokens = job.pendingTokens === null ? null : integer(job.pendingTokens, 0, Number.MAX_SAFE_INTEGER)
  const messages = integer(job.messages, 0, LIMITS.messages * LIMITS.jobs), syncedMessages = integer(job.syncedMessages, 0, messages)
  if (job.trigger !== null && !['threshold', 'manual', 'compaction', 'shutdown'].includes(String(job.trigger)) || job.mutation !== null && !['create', 'append', 'commit'].includes(String(job.mutation)) || job.kind === 'append' && (job.trigger !== null || job.requests.length !== 1) || job.kind === 'commit' && (job.trigger === null || commitId !== null || job.requests.length !== 0) || taskId !== null && archiveUri === null || job.status === 'processing' && taskId === null || job.status === 'synced' && (job.kind !== 'append' || syncedMessages !== messages) || job.status === 'completed' && taskId === null) throw error('MEMORY_STATE_CORRUPTED', 500)
  return { id, kind: job.kind as StoredJob['kind'], trigger: job.trigger as StoredJob['trigger'], peerId: peer, sessionId: session, commitId, taskId, archiveUri, status: job.status as StoredJob['status'], createdAt: timestamp(job.createdAt), updatedAt: timestamp(job.updatedAt), messages, syncedMessages, pendingTokens, errorCode: code(job.errorCode), configurationKey: digest(job.configurationKey), global, mutation: job.mutation as StoredJob['mutation'], requests: job.requests.map(value => { const key = object(value, ['id', 'hash']); return { id: digest(key.id), hash: digest(key.hash) } }) }
}
export function archive(value: unknown, session: string, user?: string): string {
  const uri = text(value, 768), prefix = 'viking://user/', parts = uri.slice(prefix.length).split('/')
  try {
    const owner = serviceIdentity(parts[0])
    if (!uri.startsWith(prefix) || parts.length !== 5 || user !== undefined && owner !== serviceIdentity(user) || parts[1] !== 'sessions' || parts[2] !== identifier(session, 255) || parts[3] !== 'history' || !/^archive_[0-9]{3,}$/.test(parts[4]!)) throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'unknown')
  } catch { throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'unknown') }
  return uri
}
function summary(value: unknown): ScopeSummary {
  const input = object(value, ['peerId', 'scope', 'label', 'capture', 'recall', 'bufferedMessages', 'lastSeenAt']), current = scope(input.scope)
  if (input.peerId !== peerId(current)) throw error('MEMORY_STATE_CORRUPTED', 500)
  return { peerId: peerId(current), scope: current, label: text(input.label, 240, true), capture: bool(input.capture), recall: bool(input.recall), bufferedMessages: integer(input.bufferedMessages, 0, LIMITS.messages * LIMITS.jobs), lastSeenAt: nullableTime(input.lastSeenAt) }
}
function state(value: unknown): State {
  const input = object(value, ['schemaVersion', 'jobs', 'scopes', 'lastRecallAt', 'lastCaptureAt', 'lastErrorCode', 'extractionDay', 'extractionCount'])
  if (input.schemaVersion !== 3 || !Array.isArray(input.jobs) || input.jobs.length > LIMITS.jobs || !Array.isArray(input.scopes) || input.scopes.length > LIMITS.scopes) throw error('MEMORY_STATE_CORRUPTED', 500)
  const jobs = input.jobs.map(storedJob), scopes = input.scopes.map(summary)
  if (jobs.filter(job => job.kind === 'append').length > LIMITS.appendJobs || new Set(jobs.map(job => job.id)).size !== jobs.length || new Set(scopes.map(item => item.peerId)).size !== scopes.length || typeof input.extractionDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.extractionDay)) throw error('MEMORY_STATE_CORRUPTED', 500)
  for (const job of jobs) if (job.commitId && !jobs.some(parent => parent.id === job.commitId && parent.kind === 'commit' && parent.sessionId === job.sessionId && parent.configurationKey === job.configurationKey)) throw error('MEMORY_STATE_CORRUPTED', 500)
  return { schemaVersion: 3, jobs, scopes, lastRecallAt: nullableTime(input.lastRecallAt), lastCaptureAt: nullableTime(input.lastCaptureAt), lastErrorCode: code(input.lastErrorCode), extractionDay: input.extractionDay, extractionCount: integer(input.extractionCount, 0, Number.MAX_SAFE_INTEGER) }
}
export class StateStore {
  readonly value: State
  private readonly path: string
  constructor(root: string) {
    this.path = join(directory(root), 'state.json')
    try { const bytes = readBytes(this.path, 4 * 1024 * 1024); this.value = bytes ? state(JSON.parse(bytes.toString('utf8'))) : { schemaVersion: 3, jobs: [], scopes: [], lastRecallAt: null, lastCaptureAt: null, lastErrorCode: null, extractionDay: localDay(), extractionCount: 0 } }
    catch { throw error('MEMORY_STATE_CORRUPTED', 500) }
    let changed = false
    for (const job of this.value.jobs) {
      if (job.kind === 'append' && (job.status === 'queued' || job.status === 'syncing')) {
        job.status = job.mutation ? 'unknown' : 'failed'; job.errorCode = job.mutation ? 'MEMORY_SUBMISSION_UNKNOWN' : 'MEMORY_BUFFER_LOST'; changed = true
      }
      if (job.kind === 'commit' && job.status === 'committing') { job.status = job.mutation ? 'unknown' : 'queued'; job.errorCode = job.mutation ? 'MEMORY_SUBMISSION_UNKNOWN' : null; changed = true }
      if (job.kind === 'commit' && job.status === 'unknown') for (const child of this.value.jobs.filter(child => child.commitId === job.id)) { child.status = 'unknown'; child.errorCode = job.errorCode; changed = true }
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
  capacity(kind: StoredJob['kind']): void {
    while (this.value.jobs.length >= LIMITS.jobs || kind === 'append' && this.value.jobs.filter(job => job.kind === 'append').length >= LIMITS.appendJobs) {
      const index = this.value.jobs.findIndex(job => (job.status === 'completed' || job.status === 'failed') && !this.value.jobs.some(child => child.commitId === job.id))
      if (index < 0) throw error('MEMORY_CAPACITY', 409)
      this.value.jobs.splice(index, 1)
    }
  }
  create(peer: string, configurationKey: string, global: boolean, request?: RequestKey, trigger?: CommitTrigger): StoredJob {
    this.capacity(trigger ? 'commit' : 'append')
    const at = now(), job: StoredJob = { id: randomUUID(), kind: trigger ? 'commit' : 'append', trigger: trigger ?? null, peerId: peer, sessionId: sessionId(peer, global), commitId: null, taskId: null, archiveUri: null, status: 'queued', createdAt: at, updatedAt: at, messages: 0, syncedMessages: 0, pendingTokens: null, errorCode: null, configurationKey, global, requests: request ? [request] : [], mutation: null }
    this.value.jobs.push(job); return job
  }
  update(job: StoredJob, patch: Partial<Pick<StoredJob, 'commitId' | 'taskId' | 'archiveUri' | 'status' | 'messages' | 'syncedMessages' | 'pendingTokens' | 'errorCode' | 'mutation'>>): void {
    if (job.kind === 'commit' && patch.status === 'completed' && job.status !== 'completed') {
      const today = localDay()
      if (this.value.extractionDay !== today) { this.value.extractionDay = today; this.value.extractionCount = 0 }
      this.value.extractionCount++
    }
    Object.assign(job, patch, { updatedAt: now() }); this.save()
  }
  settle(job: StoredJob, patch: Partial<Pick<StoredJob, 'taskId' | 'archiveUri' | 'status' | 'pendingTokens' | 'errorCode' | 'mutation'>>): void {
    for (const child of this.value.jobs.filter(child => child.commitId === job.id)) Object.assign(child, patch, { mutation: null, updatedAt: now() })
    this.update(job, patch)
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
  publicJobs(): MemoryJob[] { return [...this.value.jobs].reverse().map(({ configurationKey: _configurationKey, global: _global, requests: _requests, mutation: _mutation, ...job }) => structuredClone(job)) }
}
