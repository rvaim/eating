import { createHash } from 'node:crypto'
import type { Message } from '@openviking/sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import type { CapabilityInvocationScope, MemoryCaptureInput, MemoryContext, MemoryProvider, MemoryRecallResult, MemoryScope } from '@eating/plugin-sdk'
import type { RuntimeSnapshot } from '../types'
import { MemoryClient } from './client'
import { configured, configurationKey, ConfigurationStore } from './config'
import type { PrivateConfiguration } from './config'
import { allowedLocation, crossSession, parsePeer, peerId, policy, scope, SELF_SCOPE } from './scopes'
import { archive, localDay, StateStore } from './state'
import type { RequestKey, StoredJob } from './state'
import { bool, checkSignal, error, errorCode, identifier, integer, LIMITS, object, schema, text, timestamp } from './validation'

interface PendingBody { messages: Message[]; bytes: number; chars: number; submit: boolean; timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal }
interface Worker { controller: AbortController; done: Promise<void> }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const empty: MemoryRecallResult = { text: '', items: [] }
const terminal = (job: StoredJob): boolean => job.status === 'completed' || job.status === 'failed' || job.status === 'unknown'

export class MemoryRuntime implements MemoryProvider {
  private connected = false
  private closed = false
  private closing = false
  private lifetime = new AbortController()
  private connectionAttempt: Promise<void> | null = null
  private readonly bodies = new Map<string, PendingBody>()
  private readonly buffers = new Map<string, string>()
  private readonly workers = new Map<string, Worker>()
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly pausedJobs = new Set<string>()
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
        this.connected = true; this.pausedJobs.clear(); this.lastConnectedAt = new Date().toISOString(); this.store.value.lastErrorCode = null; this.store.save(); this.pump()
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
    this.retryTimer = undefined; this.pausedJobs.clear()
    for (const body of this.bodies.values()) if (body.timer) clearTimeout(body.timer)
    this.bodies.clear(); this.buffers.clear()
    for (const worker of this.workers.values()) worker.controller.abort()
    for (const job of this.store.value.jobs) {
      if (job.status === 'queued') { job.status = 'failed'; job.errorCode = code }
      else if (job.status === 'submitting') { job.status = job.staged && !job.commitAttempted ? 'cleaning' : 'unknown'; job.errorCode = job.status === 'cleaning' ? code : 'MEMORY_SUBMISSION_UNKNOWN' }
      else if (job.status === 'processing' || job.status === 'cleaning') job.errorCode = code
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
    const effective = policy(this.configuration.snapshot().settings, current), id = this.buffers.get(peerId(current)), body = id ? this.bodies.get(id) : undefined
    this.store.touch(current, effective.capture, effective.recall, body && !body.submit ? body.messages.length : 0)
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
  private prepareCapture(input: MemoryCaptureInput): { current: MemoryContext; messages: Message[]; actions: boolean; fingerprint: string } {
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
    if (safeAssistant && actions.length) messages.push({ role: 'assistant', peerId: peer, createdAt: new Date().toISOString(), content: 'Tool outcomes (returned is not a success receipt):\n' + actions.map(action => `${action.tool}: ${action.outcome}`).join('\n') })
    return { current, messages, actions: input.actions.length > 0, fingerprint: digest([input.messages.map(({ timestamp: _timestamp, ...item }) => item), actions, input.outcome, settings.globalMemory]) }
  }
  async capture(input: MemoryCaptureInput): Promise<void> {
    if (!this.ready || this.closing || !this.configuration.snapshot().settings.autoCapture) return
    try {
      const { current, messages, actions, fingerprint } = this.prepareCapture(input), settings = this.configuration.snapshot().settings
      if (!policy(settings, current.scope).capture || !messages.length) return
      // Deduplication hashes identity + stable turn ID. Bodies never enter state or Host's action ledger.
      const key: RequestKey = { id: digest(['capture', current.agentId, current.turnId, peerId(current.scope)]), hash: fingerprint }
      if (this.store.existing(key, peerId(current.scope))) return
      const job = this.append(current.scope, messages, key, settings.globalMemory, false)
      const body = this.bodies.get(job.id)!
      if (input.immediate || actions || settings.submissionMode === 'turn' || settings.submissionMode === 'tokens' && Math.ceil(body.chars / 4) >= settings.tokenThreshold || settings.submissionMode === 'batch' && (body.messages.length >= settings.batchMessages || body.chars >= settings.batchChars)) this.accept(job)
      else this.armIdle(job, body)
      this.store.value.lastCaptureAt = new Date().toISOString(); this.store.value.lastErrorCode = null; this.store.save(); this.pump()
    } catch (cause) { this.report(cause); throw cause }
  }
  private append(current: MemoryScope, messages: Message[], key: RequestKey, global: boolean, separate: boolean, signal?: AbortSignal): StoredJob {
    this.assertReady(signal)
    const peer = peerId(current), bytes = Buffer.byteLength(JSON.stringify(messages)), chars = messages.reduce((count, item) => count + (item.content?.length ?? 0), 0)
    if (bytes > LIMITS.jobBytes || [...this.bodies.values()].reduce((count, item) => count + item.bytes, 0) + bytes > LIMITS.bufferedBytes) throw error('MEMORY_CAPACITY', 409)
    this.store.capacity(false)
    let job = separate ? undefined : this.store.value.jobs.find(job => job.id === this.buffers.get(peer)), body = job ? this.bodies.get(job.id) : undefined
    if (job && body && (job.global !== global || body.bytes + bytes > LIMITS.jobBytes || body.messages.length + messages.length > LIMITS.messages || job.requests.length >= LIMITS.messages)) { this.accept(job); job = undefined; body = undefined }
    if (!job) {
      job = this.store.create(peer, configurationKey(this.configuration.snapshot()), global)
      body = { messages: [], bytes: 0, chars: 0, submit: false, signal }; this.bodies.set(job.id, body)
      if (!separate) this.buffers.set(peer, job.id)
    }
    body!.messages.push(...messages); body!.bytes += bytes; body!.chars += chars; job.messages = body!.messages.length; job.requests.push(key); job.updatedAt = new Date().toISOString(); this.touch(current)
    this.store.save(); return job
  }
  private armIdle(job: StoredJob, body: PendingBody): void {
    if (body.timer) clearTimeout(body.timer)
    body.timer = setTimeout(() => { body.timer = undefined; if (this.ready && this.bodies.get(job.id) === body) { this.accept(job); this.pump() } }, this.configuration.snapshot().settings.idleSeconds * 1000)
    body.timer.unref()
  }
  private accept(job: StoredJob): void {
    const body = this.bodies.get(job.id)
    if (!body || body.submit) return
    if (body.timer) clearTimeout(body.timer)
    body.timer = undefined; body.submit = true
    if (this.buffers.get(job.peerId) === job.id) this.buffers.delete(job.peerId)
    this.touch(parsePeer(job.peerId)); this.store.save()
  }
  async flush(peer?: string): Promise<void> {
    this.assertReady()
    if (peer !== undefined) parsePeer(peer)
    for (const job of this.store.value.jobs) if (job.status === 'queued' && (peer === undefined || job.peerId === peer)) this.accept(job)
    this.pump()
  }
  private pump(): void {
    if (!this.ready) return
    const key = configurationKey(this.configuration.snapshot())
    for (const job of this.store.value.jobs) {
      if (this.workers.size >= LIMITS.concurrent) break
      if (job.configurationKey !== key || this.workers.has(job.id) || this.pausedJobs.has(job.id) || terminal(job) || job.status === 'submitting' || job.status === 'queued' && !this.bodies.get(job.id)?.submit) continue
      const controller = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, controller.signal, ...(this.bodies.get(job.id)?.signal ? [this.bodies.get(job.id)!.signal!] : [])])
      const worker: Worker = { controller, done: Promise.resolve() }
      this.workers.set(job.id, worker)
      worker.done = this.run(job, signal).catch(cause => { this.report(cause) }).finally(() => { this.workers.delete(job.id); this.bodies.delete(job.id); this.pump() })
    }
  }
  private retry(job: StoredJob): void {
    this.pausedJobs.add(job.id)
    if (this.retryTimer || !this.ready) return
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pausedJobs.clear(); this.pump() }, 5000); this.retryTimer.unref()
  }
  private async run(job: StoredJob, signal: AbortSignal): Promise<void> {
    const client = this.client(parsePeer(job.peerId), signal)
    let extractionTerminal = false
    try {
      if (job.status === 'queued') {
        const body = this.bodies.get(job.id)
        if (!body) throw error('MEMORY_BUFFER_LOST', 409)
        checkSignal(signal); this.store.update(job, { status: 'submitting', errorCode: null })
        await client.create(job.sessionId, job.global)
        checkSignal(signal); this.store.update(job, { staged: true })
        await client.add(job.sessionId, body.messages)
        checkSignal(signal); this.store.update(job, { commitAttempted: true })
        const receipt = await client.run(() => client.sdk.commitSession(job.sessionId, 0))
        schema(isJsonObject(receipt) && receipt.session_id === job.sessionId && receipt.status === 'accepted' && typeof receipt.task_id === 'string')
        const taskId = identifier(receipt.task_id, 160), archiveUri = archive(receipt.archive_uri, job.sessionId, this.configuration.snapshot().user)
        this.store.update(job, { taskId, archiveUri, status: 'processing', errorCode: null })
        this.bodies.delete(job.id)
      }
      if (job.status === 'cleaning' && !job.taskId && job.staged && !job.commitAttempted) { await this.cleanUncommitted(job, client, signal); return }
      if (!job.taskId || !job.archiveUri) throw error('MEMORY_SUBMISSION_UNKNOWN', 502, 'unknown')
      if (job.terminalStatus) { await this.cleanTerminal(job, client, signal); return }
      const started = Date.now()
      for (;;) {
        checkSignal(signal)
        const task = await client.task(job.taskId!)
        if (task === null) { this.store.update(job, { status: 'unknown', errorCode: 'MEMORY_TASK_UNKNOWN' }); return }
        schema(isJsonObject(task) && task.task_id === job.taskId && task.resource_id === job.sessionId && ['pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled'].includes(String(task.status)))
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
          extractionTerminal = true
          const completed = task.status === 'completed'
          let extractionErrorCode: string | null = completed ? null : 'MEMORY_EXTRACTION_FAILED'
          if (completed) {
            try { schema(isJsonObject(task.result) && task.result.session_id === job.sessionId && task.result.archive_uri === job.archiveUri); if (task.result.user_config_error) throw error('MEMORY_EXTRACTION_FAILED', 502, 'failed') }
            catch (cause) { extractionErrorCode = errorCode(cause) }
          }
          // Persist terminal proof before any cleanup. Server task records can
          // expire independently; their absence cannot revoke an observed result.
          this.store.update(job, { status: 'cleaning', terminalStatus: completed ? 'completed' : 'failed', extractionErrorCode, errorCode: extractionErrorCode })
          await this.cleanTerminal(job, client, signal); return
        }
        if (Date.now() - started > 10 * 60 * 1000) { this.store.update(job, { errorCode: 'MEMORY_TASK_PENDING' }); this.retry(job); return }
        await delay(1000, signal)
      }
    } catch (cause) {
      const code = errorCode(cause)
      if (job.taskId) {
        // A known remote extraction may still run. Never delete its session on an uncertain result.
        if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'unknown') this.store.update(job, { status: extractionTerminal || job.status === 'cleaning' ? 'cleaning' : 'processing', errorCode: code })
        if (!signal.aborted) this.retry(job)
      } else if (job.staged && !job.commitAttempted) {
        // Verified auto_commit_policy:null and no durable commit attempt means
        // only staging can have happened. Keep cleanup recoverable until DELETE/404.
        this.store.update(job, { status: 'cleaning', errorCode: signal.aborted ? job.errorCode ?? code : code })
        if (!signal.aborted) await this.cleanUncommitted(job, client, signal)
      } else if (job.status !== 'unknown' && job.status !== 'failed') {
        this.store.update(job, { status: job.commitAttempted || signal.aborted ? 'unknown' : 'failed', errorCode: job.commitAttempted || signal.aborted ? 'MEMORY_SUBMISSION_UNKNOWN' : code })
      }
      if (!signal.aborted) this.report(cause)
    }
  }
  private async cleanTerminal(job: StoredJob, client: MemoryClient, signal: AbortSignal): Promise<void> {
    let failure = job.extractionErrorCode
    if (job.terminalStatus === 'completed' && job.changes === null && failure === null) {
      try {
        const raw = await client.run(() => client.sdk.read(job.archiveUri! + '/memory_diff.json'))
        schema(typeof raw === 'string')
        let diff: unknown
        try { diff = JSON.parse(raw) } catch { throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'failed') }
        schema(isJsonObject(diff) && isJsonObject(diff.summary))
        this.store.update(job, { changes: { added: integer(diff.summary.total_adds, 0, Number.MAX_SAFE_INTEGER), updated: integer(diff.summary.total_updates, 0, Number.MAX_SAFE_INTEGER), deleted: integer(diff.summary.total_deletes, 0, Number.MAX_SAFE_INTEGER) } })
      } catch (cause) { if (signal.aborted) throw cause; failure = errorCode(cause); this.store.update(job, { extractionErrorCode: failure, errorCode: failure }) }
    }
    checkSignal(signal)
    try { await client.run(() => client.sdk.deleteSession(job.sessionId)) }
    catch (cause) { if (errorCode(cause) !== 'MEMORY_NOT_FOUND') throw cause }
    checkSignal(signal); this.store.update(job, { status: failure ? 'failed' : 'completed', errorCode: failure })
    this.store.value.lastErrorCode = failure; this.store.save()
  }
  private async cleanUncommitted(job: StoredJob, client: MemoryClient, signal: AbortSignal): Promise<void> {
    const failure = job.errorCode ?? 'MEMORY_BUFFER_LOST'
    try {
      checkSignal(signal)
      try { await client.run(() => client.sdk.deleteSession(job.sessionId)) }
      catch (cause) { if (errorCode(cause) !== 'MEMORY_NOT_FOUND') throw cause }
      checkSignal(signal); this.store.update(job, { status: 'failed', errorCode: failure })
    } catch (cause) {
      this.store.update(job, { status: 'cleaning', errorCode: signal.aborted ? job.errorCode ?? 'MEMORY_CANCELLED' : errorCode(cause) })
      if (!signal.aborted) { this.report(cause); this.retry(job) }
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
    const job = this.append(current.scope, [{ role: 'user', content: body, peerId: peerId(current.scope), createdAt: new Date().toISOString() }], key, global, true)
    this.accept(job); this.pump(); return { jobId: job.id, status: job.status }
  }
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closing = true
    if (this.ready) {
      await this.flush()
      const drain = async () => { while (this.workers.size) await Promise.allSettled([...this.workers.values()].map(worker => worker.done)) }
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([drain(), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(this.configuration.snapshot().timeoutMs, 30000)) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    this.closed = true; await this.revoke('MEMORY_CANCELLED')
  }
}
function identityMember(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,96}$/.test(value)) throw error('MEMORY_INVALID_INPUT'); return value }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error('MEMORY_CANCELLED', 409)) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
}
