import { createHash } from 'node:crypto'
import type { Message } from '@openviking/sdk'
import type { CapabilityInvocationScope, MemoryCaptureInput, MemoryContext, MemoryProvider, MemoryRecallResult, MemoryScope } from '@eating/plugin-sdk'
import { PlatformError } from '@eating/plugin-sdk'
import type { CommitTrigger, RuntimeSnapshot } from '../types'
import { MemoryClient } from './client'
import { configured, configurationKey, ConfigurationStore } from './config'
import type { PrivateConfiguration } from './config'
import { allowedLocation, crossSession, parsePeer, peerId, policy, scope, SELF_SCOPE } from './scopes'
import { localDay, StateStore } from './state'
import type { RequestKey, StoredJob } from './state'
import { bool, checkSignal, error, errorCode, identifier, LIMITS, object, text, timestamp } from './validation'

interface PendingBody { messages: Message[]; bytes: number }
interface Worker { controller: AbortController; done: Promise<void> }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const empty: MemoryRecallResult = { text: '', items: [] }
const terminal = (job: StoredJob): boolean => job.status === 'completed' || job.status === 'failed'

export class MemoryRuntime implements MemoryProvider {
  private connected = false
  private closed = false
  private closing = false
  private lifetime = new AbortController()
  private connectionAttempt: Promise<void> | null = null
  private readonly bodies = new Map<string, PendingBody>()
  private readonly workers = new Map<string, Worker>()
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly pausedJobs = new Set<string>()
  private readonly inspectedSessions = new Set<string>()
  private readonly commitRequests = new Map<string, CommitTrigger>()
  private lastConnectedAt: string | null = null
  constructor(readonly configuration: ConfigurationStore, readonly store: StateStore) {}
  get ready(): boolean { const config = this.configuration.snapshot(); return !this.closed && this.connected && config.settings.enabled && configured(config) && !this.lifetime.signal.aborted }
  get connectedAt(): string | null { return this.ready ? this.lastConnectedAt : null }
  get lastError(): string | null { return this.store.value.lastErrorCode }
  private report(cause: unknown): void { this.store.value.lastErrorCode = errorCode(cause); this.store.save() }
  assertReady(signal?: AbortSignal): void { checkSignal(signal); if (!this.ready) throw error('MEMORY_NOT_READY', 409) }
  private client(current: MemoryScope, signal?: AbortSignal, all = false): MemoryClient { this.assertReady(signal); return new MemoryClient(this.configuration.snapshot(), this.lifetime.signal, peerId(current), signal, !all) }
  async connect(): Promise<void> {
    if (this.closed || this.closing) throw error('MEMORY_NOT_READY', 409)
    if (this.connectionAttempt) return this.connectionAttempt
    const config = this.configuration.snapshot()
    if (!configured(config) || !config.settings.enabled) throw error('MEMORY_NOT_CONFIGURED', 409)
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController()
    const lifetime = this.lifetime
    const attempt = (async () => {
      try {
        await new MemoryClient(config, lifetime.signal).identity()
        checkSignal(lifetime.signal)
        if (this.lifetime !== lifetime) throw error('MEMORY_CANCELLED', 409)
        this.connected = true; this.pausedJobs.clear(); this.inspectedSessions.clear(); this.lastConnectedAt = new Date().toISOString(); this.store.value.lastErrorCode = null; this.store.save(); this.pump()
      } catch (cause) { if (this.lifetime === lifetime) { this.connected = false; this.report(cause) }; throw cause }
    })()
    this.connectionAttempt = attempt
    try { await attempt } finally { if (this.connectionAttempt === attempt) this.connectionAttempt = null }
  }
  async testConnection(): Promise<void> {
    if (this.closed || this.closing) throw error('MEMORY_NOT_READY', 409)
    const config = this.configuration.snapshot()
    if (!configured(config)) throw error('MEMORY_NOT_CONFIGURED', 409)
    try { await new MemoryClient(config, this.lifetime.signal).identity(); this.store.value.lastErrorCode = null; this.store.save() }
    catch (cause) { this.report(cause); throw cause }
  }
  private revoke(code: string): Promise<void> {
    this.connected = false; this.lastConnectedAt = null
    this.lifetime.abort()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined; this.pausedJobs.clear(); this.commitRequests.clear(); this.inspectedSessions.clear()
    this.bodies.clear()
    for (const worker of this.workers.values()) worker.controller.abort()
    for (const job of this.store.value.jobs) {
      if (job.status === 'queued' || job.status === 'syncing' || job.status === 'committing') {
        const status = job.mutation ? 'unknown' : 'failed', errorCode = job.mutation ? 'MEMORY_SUBMISSION_UNKNOWN' : code
        if (job.kind === 'commit') this.store.settle(job, { status, errorCode })
        else this.store.update(job, { status, errorCode })
      }
    }
    for (const item of this.store.value.scopes) item.bufferedMessages = 0
    this.store.save()
    return Promise.allSettled([...this.workers.values()].map(worker => worker.done)).then(() => {})
  }
  async disconnect(): Promise<void> { await this.revoke('MEMORY_CANCELLED'); if (!this.closed) this.lifetime = new AbortController() }
  async reconfigure(previous: PrivateConfiguration, next: PrivateConfiguration): Promise<void> {
    const connected = this.ready
    await this.revoke('MEMORY_CONFIGURATION_CHANGED')
    this.lifetime = new AbortController()
    const sameIdentity = configurationKey(previous) === configurationKey(next) && previous.apiKey === next.apiKey
    if (connected && sameIdentity && next.settings.enabled && configured(next)) { this.connected = true; this.lastConnectedAt = new Date().toISOString(); this.pump() }
  }
  snapshot(): RuntimeSnapshot {
    const settings = this.configuration.snapshot().settings
    const scopes = this.store.value.scopes.map(item => { const effective = policy(settings, item.scope); return { ...structuredClone(item), capture: effective.capture, recall: effective.recall } })
    const today = localDay()
    return { ready: this.ready, lastErrorCode: this.lastError, lastRecallAt: this.store.value.lastRecallAt, lastCaptureAt: this.store.value.lastCaptureAt, todayExtractions: this.store.value.extractionDay === today ? this.store.value.extractionCount : 0, pending: this.store.value.jobs.filter(job => job.status !== 'completed' && job.status !== 'failed').length, jobs: this.store.publicJobs(), scopes }
  }
  private touch(current: MemoryScope): void {
    const effective = policy(this.configuration.snapshot().settings, current), peer = peerId(current)
    const buffered = this.store.value.jobs.filter(job => job.peerId === peer && job.status === 'queued').reduce((sum, job) => sum + (this.bodies.get(job.id)?.messages.length ?? 0), 0)
    this.store.touch(current, effective.capture, effective.recall, buffered)
  }
  private context(input: MemoryContext): MemoryContext {
    const value = object(input, ['agentId', 'agentTypeId', 'turnId', 'scope'])
    return { agentId: identifier(value.agentId, 160), agentTypeId: identifier(value.agentTypeId, 160), turnId: identifier(value.turnId, 160), scope: scope(value.scope) }
  }
  async recall(input: MemoryContext, query: string, signal?: AbortSignal): Promise<MemoryRecallResult> {
    if (!this.ready || !this.configuration.snapshot().settings.autoRecall) return empty
    try {
      const current = this.context(input).scope, settings = this.configuration.snapshot().settings
      if (!policy(settings, current).recall) return empty
      const items = await this.client(current, signal).find(text(query, LIMITS.query), settings, current, false)
      this.assertReady(signal); this.touch(current); this.store.value.lastRecallAt = new Date().toISOString(); this.store.value.lastErrorCode = null; this.store.save()
      return { text: items.map(item => `${item.uri}\n${item.text}`).join('\n\n'), items }
    } catch (cause) { this.report(cause); throw cause }
  }
  private prepareCapture(input: MemoryCaptureInput): { current: MemoryContext; messages: Message[]; fingerprint: string } {
    const data = object(input, ['context', 'messages', 'actions', 'outcome', 'immediate'], ['context', 'messages', 'actions', 'outcome']), current = this.context(input.context)
    if (!Array.isArray(data.messages) || data.messages.length > LIMITS.messages || !Array.isArray(data.actions) || data.actions.length > 128 || !['completed', 'failed', 'cancelled'].includes(String(data.outcome))) throw error('MEMORY_INVALID_INPUT')
    if (data.immediate !== undefined) bool(data.immediate)
    const settings = this.configuration.snapshot().settings, effective = policy(settings, current.scope), peer = peerId(current.scope)
    let denied = false, allowedUsers = 0
    const parsed = input.messages.map(message => {
      const item = object(message, ['role', 'text', 'timestamp', 'senderId', 'senderRole', 'messageId'], ['role', 'text', 'timestamp'])
      if (item.role !== 'user' && item.role !== 'assistant' || item.senderRole !== undefined && !['owner', 'administrator', 'user'].includes(String(item.senderRole))) throw error('MEMORY_INVALID_INPUT')
      if (item.messageId !== undefined) text(item.messageId, 160)
      const body = text(item.text, LIMITS.jobBytes, true) ? String(item.text) : '', createdAt = timestamp(item.timestamp)
      const senderId = item.senderId === undefined ? null : identityMember(item.senderId)
      const provenance = { platform: current.scope.platform, account: current.scope.accountId, kind: current.scope.kind, target: current.scope.targetId, senderId, senderRole: item.senderRole ?? null, messageId: item.messageId ?? null, observedAt: createdAt }
      let allowed = true
      if (item.role === 'user' && current.scope.kind === 'group' && effective.memberMode !== 'all') {
        allowed = senderId !== null && (effective.memberMode === 'allowlist' ? effective.memberIds.includes(senderId) : !effective.memberIds.includes(senderId))
        if (!allowed) denied = true
      }
      if (item.role === 'user' && allowed && body) allowedUsers++
      return { role: item.role, content: item.role === 'user' && body ? `User message provenance (conversation data): ${JSON.stringify(provenance)}\n${body}` : body, createdAt, peerId: peer, allowed } as Message & { allowed: boolean }
    })
    const safeAssistant = !denied && (current.scope.kind === 'self' || allowedUsers > 0)
    const messages: Message[] = parsed.filter(item => item.content && (item.role === 'user' ? item.allowed : safeAssistant)).map(({ allowed: _allowed, ...item }) => item)
    const actions = input.actions.map(action => {
      const value = object(action, ['tool', 'outcome'])
      if (!['returned', 'succeeded', 'failed', 'unknown'].includes(String(value.outcome))) throw error('MEMORY_INVALID_INPUT')
      return { tool: identifier(value.tool, 160), outcome: value.outcome }
    })
    if (safeAssistant && actions.length) {
      const summary = 'Tool outcomes (returned is not a success receipt):\n' + actions.map(action => `${action.tool}: ${action.outcome}`).join('\n')
      const assistant = [...messages].reverse().find(message => message.role === 'assistant')
      if (assistant) assistant.content = assistant.content + '\n\n' + summary
      else messages.push({ role: 'assistant', peerId: peer, createdAt: new Date().toISOString(), content: summary })
    }
    return { current, messages, fingerprint: digest([input.messages.map(({ timestamp: _timestamp, ...item }) => item), actions, input.outcome, settings.globalMemory]) }
  }
  async capture(input: MemoryCaptureInput): Promise<void> {
    if (!this.ready || this.closing || !this.configuration.snapshot().settings.autoCapture) return
    try {
      const { current, messages, fingerprint } = this.prepareCapture(input), settings = this.configuration.snapshot().settings
      if (!policy(settings, current.scope).capture || !messages.length) return
      // Deduplication hashes identity + stable turn ID. Bodies never enter state or Host's action ledger.
      const key: RequestKey = { id: digest(['capture', current.agentId, current.turnId, peerId(current.scope)]), hash: fingerprint }
      if (this.store.existing(key, peerId(current.scope))) return
      this.append(current.scope, messages, key, settings.globalMemory)
      this.store.value.lastCaptureAt = new Date().toISOString(); this.store.value.lastErrorCode = null; this.store.save(); this.pump()
    } catch (cause) { this.report(cause); throw cause }
  }
  private append(current: MemoryScope, messages: Message[], key: RequestKey, global: boolean, signal?: AbortSignal): StoredJob {
    this.assertReady(signal)
    const peer = peerId(current), bytes = Buffer.byteLength(JSON.stringify(messages))
    if (bytes > LIMITS.jobBytes || [...this.bodies.values()].reduce((count, item) => count + item.bytes, 0) + bytes > LIMITS.bufferedBytes) throw error('MEMORY_CAPACITY', 409)
    const job = this.store.create(peer, configurationKey(this.configuration.snapshot()), global, key)
    this.bodies.set(job.id, { messages, bytes }); job.messages = messages.length
    this.touch(current); this.store.save(); return job
  }
  async flush(reason: 'manual' | 'compaction' | 'session-end' = 'manual'): Promise<void> { await this.flushScope(undefined, reason) }
  async flushScope(peer?: string, reason: 'manual' | 'compaction' | 'session-end' = 'manual'): Promise<void> {
    this.assertReady()
    if (peer !== undefined) parsePeer(peer)
    if (reason !== 'manual' && !this.configuration.snapshot().settings.autoCommit) return
    const key = configurationKey(this.configuration.snapshot()), trigger: CommitTrigger = reason === 'session-end' ? 'shutdown' : reason
    const sessions = new Set(this.store.value.jobs.filter(job => job.configurationKey === key && (peer === undefined || job.peerId === peer) && job.kind === 'append' && !job.commitId && ['queued', 'syncing', 'synced'].includes(job.status)).map(job => job.sessionId))
    for (const session of sessions) this.commitRequests.set(session, trigger)
    this.pump()
    while (this.ready) {
      const active = [...this.workers].filter(([id]) => { const job = this.store.value.jobs.find(job => job.id === id); return job && sessions.has(job.sessionId) && (job.kind === 'append' && job.status === 'syncing' || job.kind === 'commit' && ['queued', 'committing'].includes(job.status)) }).map(([, worker]) => worker.done)
      if (!active.length) break
      await Promise.allSettled(active); this.pump()
    }
  }
  private scheduleCommits(): void {
    const key = configurationKey(this.configuration.snapshot())
    for (const [session, trigger] of this.commitRequests) {
      const jobs = this.store.value.jobs.filter(job => job.configurationKey === key && job.sessionId === session)
      if (jobs.some(job => job.status === 'unknown')) { this.commitRequests.delete(session); continue }
      if (jobs.some(job => this.workers.has(job.id) || job.status === 'queued' || job.status === 'syncing' || job.status === 'committing')) continue
      const pending = jobs.filter(job => job.kind === 'append' && job.status === 'synced' && !job.commitId)
      this.commitRequests.delete(session)
      if (!pending.length) continue
      const first = pending[0]!, commit = this.store.create(first.peerId, key, first.global, undefined, trigger)
      commit.messages = pending.reduce((sum, job) => sum + job.syncedMessages, 0); commit.syncedMessages = commit.messages
      for (const job of pending) job.commitId = commit.id
      this.store.save()
    }
  }
  private pump(): void {
    if (!this.ready) return
    try { this.scheduleCommits() } catch (cause) { this.report(cause) }
    const key = configurationKey(this.configuration.snapshot()), autoCommit = this.configuration.snapshot().settings.autoCommit
    for (const job of this.store.value.jobs) {
      if (this.workers.size >= LIMITS.concurrent) break
      if (job.configurationKey !== key || this.workers.has(job.id) || this.pausedJobs.has(job.id) || terminal(job)) continue
      const polling = job.kind === 'commit' && job.taskId !== null && (job.status === 'processing' || job.status === 'unknown')
      const inspecting = autoCommit && job.kind === 'append' && job.status === 'synced' && !job.commitId && !this.inspectedSessions.has(job.sessionId)
      if (!polling && !inspecting && job.status !== 'queued') continue
      const sameSession = this.store.value.jobs.filter(other => other.configurationKey === key && other.sessionId === job.sessionId && other.id !== job.id)
      if (sameSession.some(other => this.workers.has(other.id)) || !polling && sameSession.some(other => other.status === 'unknown')) continue
      if (inspecting) this.inspectedSessions.add(job.sessionId)
      const controller = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, controller.signal])
      const worker: Worker = { controller, done: Promise.resolve() }
      this.workers.set(job.id, worker)
      worker.done = this.run(job, signal, inspecting).catch(cause => { if (!signal.aborted) this.report(cause) }).finally(() => { this.workers.delete(job.id); if (!inspecting) this.bodies.delete(job.id); this.touch(parsePeer(job.peerId)); this.pump() })
    }
  }
  private retry(job: StoredJob): void {
    this.pausedJobs.add(job.id)
    if (this.retryTimer || !this.ready) return
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pausedJobs.clear(); this.pump() }, 1000); this.retryTimer.unref()
  }
  private threshold(job: StoredJob, pendingTokens: number): void {
    this.inspectedSessions.add(job.sessionId)
    if (this.configuration.snapshot().settings.autoCommit && pendingTokens >= this.configuration.snapshot().settings.commitTokenThreshold && !this.commitRequests.has(job.sessionId)) this.commitRequests.set(job.sessionId, 'threshold')
  }
  private async run(job: StoredJob, signal: AbortSignal, inspecting: boolean): Promise<void> {
    try {
      const client = this.client(parsePeer(job.peerId), signal)
      if (inspecting) {
        const metadata = await client.session(job.sessionId, job.global)
        checkSignal(signal); this.store.update(job, { pendingTokens: metadata.pendingTokens, errorCode: null }); this.threshold(job, metadata.pendingTokens)
        return
      }
      if (job.kind === 'commit' && job.taskId) {
        const task = await client.task(job.taskId, job.sessionId)
        checkSignal(signal)
        const status = task === null ? 'unknown' : task.status === 'completed' ? 'completed' : task.status === 'failed' || task.status === 'cancelled' ? 'failed' : 'processing'
        this.store.settle(job, { status, errorCode: status === 'unknown' ? 'MEMORY_TASK_UNKNOWN' : status === 'failed' ? 'MEMORY_EXTRACTION_FAILED' : null })
        if (!terminal(job)) this.retry(job)
        else { this.store.value.lastErrorCode = job.errorCode; this.store.save() }
        return
      }
      if (job.kind === 'append') {
        const body = this.bodies.get(job.id)
        if (!body) throw error('MEMORY_BUFFER_LOST', 409)
        this.store.update(job, { status: 'syncing', errorCode: null })
        await client.ensure(job.sessionId, job.global, () => { checkSignal(signal); this.store.update(job, { mutation: 'create' }) })
        this.store.update(job, { mutation: null })
        for (let offset = job.syncedMessages; offset < body.messages.length; offset += 100) {
          checkSignal(signal)
          const messages = body.messages.slice(offset, offset + 100)
          this.store.update(job, { mutation: 'append' })
          const metadata = await client.append(job.sessionId, messages)
          checkSignal(signal); this.store.update(job, { syncedMessages: offset + messages.length, pendingTokens: metadata.pendingTokens, mutation: null })
        }
        this.store.update(job, { status: 'synced', errorCode: null }); this.threshold(job, job.pendingTokens!)
        return
      }
      this.store.settle(job, { status: 'committing', errorCode: null })
      const metadata = await client.session(job.sessionId, job.global)
      checkSignal(signal)
      if (metadata.messageCount === 0) throw error('MEMORY_SESSION_CHANGED', 409)
      this.store.update(job, { pendingTokens: metadata.pendingTokens, mutation: 'commit' })
      const receipt = await client.commit(job.sessionId)
      checkSignal(signal); this.store.settle(job, { taskId: receipt.taskId, archiveUri: receipt.archiveUri, status: 'processing', mutation: null, errorCode: null }); this.retry(job)
    } catch (cause) {
      if (inspecting) {
        this.inspectedSessions.delete(job.sessionId)
        this.store.update(job, { errorCode: errorCode(cause) }); if (!signal.aborted) this.retry(job)
      } else if (!terminal(job)) {
        const rejected = cause instanceof PlatformError && cause.statusCode >= 400 && cause.statusCode < 500 && cause.outcome === 'failed'
        const status = job.taskId ? 'processing' : job.mutation && !rejected ? 'unknown' : 'failed'
        const patch = { status, errorCode: status === 'unknown' ? 'MEMORY_SUBMISSION_UNKNOWN' : errorCode(cause) } as const
        if (job.kind === 'commit') this.store.settle(job, patch)
        else this.store.update(job, patch)
        if (job.taskId && !signal.aborted) this.retry(job)
      }
      if (!signal.aborted) this.report(cause)
    }
  }
  invocationContext(invocation?: CapabilityInvocationScope): MemoryContext {
    if (invocation?.memory) return this.context(invocation.memory)
    const source = invocation?.source
    return { agentId: invocation?.agentId ?? 'local', agentTypeId: invocation?.agentTypeId ?? 'main', turnId: 'tool', scope: source ? scope({ kind: source.kind, platform: source.pluginId, accountId: source.accountId, targetId: source.targetId, owner: false }) : { ...SELF_SCOPE } }
  }
  async search(query: unknown, current: MemoryScope, all: boolean, signal?: AbortSignal, manager = false) {
    this.assertReady(signal)
    const settings = this.configuration.snapshot().settings
    if (!manager && !policy(settings, current).recall) throw error('MEMORY_SCOPE_DENIED', 403)
    if (all && !manager && !crossSession(settings, current)) throw error('MEMORY_SCOPE_DENIED', 403)
    try { const items = await this.client(current, signal, all || manager).find(text(query, LIMITS.query), manager ? { ...settings, globalMemory: true } : settings, current, all); this.assertReady(signal); return { items } }
    catch (cause) { this.report(cause); throw cause }
  }
  async read(uri: unknown, current: MemoryScope, signal?: AbortSignal, manager = false): Promise<{ uri: string; text: string }> {
    const settings = this.configuration.snapshot().settings
    if (!manager && !policy(settings, current).recall) throw error('MEMORY_SCOPE_DENIED', 403)
    const all = manager || crossSession(settings, current), checked = allowedLocation(uri, this.configuration.snapshot().user, manager ? { ...settings, globalMemory: true } : settings, current, all)
    const body = await this.client(current, signal, all).read(checked); this.assertReady(signal); return { uri: checked, text: body }
  }
  async delete(uri: unknown): Promise<void> {
    const settings = this.configuration.snapshot().settings, current = { ...SELF_SCOPE, owner: true }, checked = allowedLocation(uri, this.configuration.snapshot().user, { ...settings, globalMemory: true }, current, true)
    await this.client(current, undefined, true).delete(checked)
  }
  scopes(current?: MemoryScope) { const snapshot = this.snapshot(); return current ? snapshot.scopes.filter(item => item.peerId === peerId(current)) : snapshot.scopes }
  async save(value: unknown, requestId: string, invocation?: CapabilityInvocationScope): Promise<{ jobId: string; status: StoredJob['status'] }> {
    const input = object(value, ['text', 'request_id', 'global'], ['text', 'request_id']), current = this.invocationContext(invocation), settings = this.configuration.snapshot().settings
    const signal = invocation?.source?.signal && invocation.signal ? AbortSignal.any([invocation.signal, invocation.source.signal]) : invocation?.signal ?? invocation?.source?.signal
    this.assertReady(signal)
    const stableId = identifier(input.request_id), body = text(input.text, LIMITS.save), global = input.global === undefined ? false : bool(input.global)
    if (requestId !== stableId) throw error('MEMORY_INVALID_INPUT')
    const effective = policy(settings, current.scope)
    if (!effective.capture || current.scope.kind === 'group' && effective.memberMode !== 'all' || global && (!settings.globalMemory || !(current.scope.kind === 'self' || current.scope.kind === 'private' && current.scope.owner))) throw error('MEMORY_SCOPE_DENIED', 403)
    const key: RequestKey = { id: digest(['save', peerId(current.scope), stableId]), hash: digest([body, global]) }, previous = this.store.existing(key, peerId(current.scope))
    if (previous) return { jobId: previous.id, status: previous.status }
    checkSignal(signal)
    const job = this.append(current.scope, [{ role: 'user', content: body, peerId: peerId(current.scope), createdAt: new Date().toISOString() }], key, global, signal)
    this.pump(); return { jobId: job.id, status: job.status }
  }
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closing = true
    if (this.ready) {
      const drain = async () => { await this.flush('session-end'); while (this.workers.size) await Promise.allSettled([...this.workers.values()].map(worker => worker.done)) }
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([drain(), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(this.configuration.snapshot().timeoutMs, 30000)) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    this.closed = true; await this.revoke('MEMORY_CANCELLED')
  }
}
function identityMember(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,96}$/.test(value)) throw error('MEMORY_INVALID_INPUT'); return value }
