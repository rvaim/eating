import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_DELIVERY_SETTINGS, PlatformError, isJsonValue, isJsonObject, validateDeliverySettings } from '@eating/plugin-sdk'
import type { DeliveryQueueStats, DeliverySettings, DeliverySettingsSnapshot, HarnessEvent, JsonObject, JsonValue, StoredMessage } from '@eating/plugin-sdk'

type QueueStatus = 'pending' | 'delivering' | 'uncertain'
interface QueueRow {
  sequence: number
  event_id: string
  harness_json: string
  payload_bytes: number
  status: QueueStatus
  delivery_attempts: number
  next_attempt_at: number
  enqueued_at: number
}
interface QueueState {
  nextSequence: number
  accepted: number
  rejected: number
  discarded: number
  notForwarded: number
  lastQueueError: string | null
}

export interface QueuedHarnessEvent {
  readonly event: HarnessEvent
  readonly sequence: number
  readonly attempts: number
  readonly status: QueueStatus
  readonly nextAttemptAt: number
  readonly enqueuedAt: number
}
export interface PendingHarnessEvent { readonly event: HarnessEvent; readonly attempts: number }

const settingsKey = 'host:delivery-settings'
const stateKey = 'host:delivery-queue-state'
const compactionKey = 'host:delivery-compaction-needed'
const dedupLifetimeMs = 24 * 60 * 60 * 1000
const maxDedupIdentifiers = 10000

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`).join(',')}}`
  return JSON.stringify(value)
}

function readEnvelope(json: string): HarnessEvent {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new PlatformError('STORAGE_CORRUPTED', '待投递信封损坏，原数据未被丢弃。', 500) }
  const strings = ['eventId', 'pluginId', 'instanceId', 'platform', 'accountId', 'conversationId', 'senderId', 'receivedAt', 'text']
  if (!isJsonObject(value) || value.protocolVersion !== 1 || strings.some(key => typeof value[key] !== 'string') ||
    !isJsonObject(value.source) || value.source.trust !== 'external' || !['private', 'group'].includes(String(value.source.kind)) || !isJsonValue(value.content)) {
    throw new PlatformError('STORAGE_CORRUPTED', '待投递信封损坏，原数据未被丢弃。', 500)
  }
  return value as unknown as HarnessEvent
}

function serializeEnvelope(event: HarnessEvent, eventId: string): string {
  // Retain only the public normalized envelope, never the original protocol event or a second text column.
  const json = JSON.stringify({ protocolVersion: event.protocolVersion, eventId, pluginId: event.pluginId, instanceId: event.instanceId,
    platform: event.platform, accountId: event.accountId, conversationId: event.conversationId, senderId: event.senderId,
    receivedAt: event.receivedAt, source: { trust: event.source.trust, kind: event.source.kind }, content: event.content, text: event.text })
  readEnvelope(json)
  return json
}

export class HostStore {
  private readonly db: DatabaseSync
  private readonly runningActions = new Set<string>()
  private memoryQueue = new Map<string, QueueRow>()
  // A failed SQLite write still yields an observable rejection and bounded, content-free local deduplication.
  private readonly failedWriteDedup = new Map<string, number>()
  private deliverySettings: DeliverySettings = { ...DEFAULT_DELIVERY_SETTINGS }
  private deliveryRevision = 0
  private queueState: QueueState = { nextSequence: 1, accepted: 0, rejected: 0, discarded: 0, notForwarded: 0, lastQueueError: null }

  constructor(readonly databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(databasePath), 0o700)
    }
    this.db = new DatabaseSync(databasePath)
    try {
      if (databasePath !== ':memory:') chmodSync(databasePath, 0o600)
      this.db.exec(`
        PRAGMA auto_vacuum = INCREMENTAL;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        PRAGMA secure_delete = ON;
        PRAGMA journal_size_limit = 0;
      `)
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS delivery_queue (
            sequence INTEGER PRIMARY KEY,
            event_id TEXT NOT NULL UNIQUE,
            harness_json TEXT NOT NULL,
            payload_bytes INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','delivering','uncertain')),
            delivery_attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            enqueued_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS event_dedup (
            event_id TEXT PRIMARY KEY,
            observed_at INTEGER NOT NULL,
            disposition TEXT NOT NULL,
            receipt_hash TEXT
          );
          CREATE INDEX IF NOT EXISTS dedup_by_age ON event_dedup(observed_at);
          CREATE TABLE IF NOT EXISTS actions (
            plugin_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            scope_key TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            params_hash TEXT NOT NULL,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            result_json TEXT,
            error_code TEXT,
            error_message TEXT,
            PRIMARY KEY(plugin_id,scope_key,request_id)
          );
        `)
        this.loadDeliveryConfiguration()
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='incoming_events'").get()) this.migrateLegacyEvents()
        this.db.prepare("UPDATE delivery_queue SET status = 'uncertain' WHERE status = 'delivering'").run()
        if (this.deliverySettings.storageMode === 'memory') {
          this.memoryQueue = new Map(this.queueRows().map(row => [row.event_id, row]))
          this.db.exec('DELETE FROM delivery_queue')
        }
        this.pruneDedup()
        this.persistSettings(this.deliverySettings, this.deliveryRevision)
        this.persistState(this.queueState)
        this.db.exec('PRAGMA user_version = 2')
        // An interrupted outbound action is never automatically resent.
        this.db.prepare("UPDATE actions SET state = 'unknown', error_code = 'PROCESS_INTERRUPTED', error_message = '上次进程在动作结果确认前退出；请查询真实状态，不要直接重发。' WHERE state = 'running'").run()
      })
      if (this.getSetting(compactionKey) === '1') {
        // Rebuild the same database once; do not create a second archive of the removed chat history.
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)')
        this.db.prepare('DELETE FROM settings WHERE key=?').run(compactionKey)
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      }
    } catch (error) { this.db.close(); throw error }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      // A rolled-back RAM-to-disk switch must not leave tentative payload frames in the WAL.
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* Preserve the transaction's original failure. */ }
      throw error
    }
  }

  private loadDeliveryConfiguration(): void {
    try {
      const saved = this.getSetting(settingsKey)
      if (saved !== null) {
        const parsed: unknown = JSON.parse(saved)
        if (!isJsonObject(parsed) || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 0) throw new Error('Invalid revision')
        this.deliverySettings = validateDeliverySettings(parsed.values)
        this.deliveryRevision = Number(parsed.revision)
      }
      const state = this.getSetting(stateKey)
      if (state !== null) {
        const parsed: unknown = JSON.parse(state)
        if (!isJsonObject(parsed) || ['nextSequence', 'accepted', 'rejected', 'discarded', 'notForwarded'].some(key => !Number.isSafeInteger(parsed[key]) || Number(parsed[key]) < (key === 'nextSequence' ? 1 : 0)) ||
          !(parsed.lastQueueError === null || typeof parsed.lastQueueError === 'string')) throw new Error('Invalid queue counters')
        this.queueState = parsed as unknown as QueueState
      }
    } catch { throw new PlatformError('STORAGE_CORRUPTED', '消息投递设置或队列元数据损坏，未覆盖原数据。', 500) }
  }

  private persistSettings(values: DeliverySettings, revision: number): void { this.setSetting(settingsKey, JSON.stringify({ revision, values })) }
  private persistState(state: QueueState): void { this.setSetting(stateKey, JSON.stringify(state)) }

  private migrateLegacyEvents(): void {
    const now = Date.now()
    const terminalCounts = this.db.prepare('SELECT harness_status,COUNT(*) AS count FROM incoming_events GROUP BY harness_status').all()
    for (const row of terminalCounts) {
      if (row.harness_status === 'accepted') this.queueState.accepted += Number(row.count)
      if (row.harness_status === 'not-forwarded') this.queueState.notForwarded += Number(row.count)
    }
    const highest = this.db.prepare('SELECT MAX(sequence) AS sequence FROM incoming_events').get()
    this.queueState.nextSequence = Math.max(this.queueState.nextSequence, Number(highest?.sequence ?? 0) + 1)
    // Terminal rows never load raw_json, text or harness_json into the migration process.
    const outstanding = this.db.prepare("SELECT sequence,event_id,harness_json,harness_status,delivery_attempts,received_at FROM incoming_events WHERE harness_status IN ('pending','delivering','uncertain') ORDER BY sequence").all()
    for (const row of outstanding) {
      const eventId = String(row.event_id)
      if (!/^[a-f0-9]{64}$/.test(eventId) || typeof row.harness_json !== 'string') throw new PlatformError('STORAGE_CORRUPTED', '旧待投递记录损坏，迁移已取消并保留原库。', 500)
      const json = serializeEnvelope(readEnvelope(row.harness_json), eventId)
      this.insertQueueRow({ sequence: Number(row.sequence), event_id: eventId, harness_json: json, payload_bytes: Buffer.byteLength(json, 'utf8'),
        status: row.harness_status === 'pending' ? 'pending' : 'uncertain', delivery_attempts: Number(row.delivery_attempts),
        next_attempt_at: 0, enqueued_at: Number.isFinite(Date.parse(String(row.received_at))) ? Math.min(now, Date.parse(String(row.received_at))) : now })
    }
    const recent = this.db.prepare(`SELECT event_id,received_at,harness_status,receipt_id FROM incoming_events
      WHERE julianday(received_at) >= julianday(?) ORDER BY sequence DESC LIMIT ?`).all(new Date(now - dedupLifetimeMs).toISOString(), maxDedupIdentifiers)
    for (const row of recent) {
      if (!/^[a-f0-9]{64}$/.test(String(row.event_id))) continue
      this.saveDedup(String(row.event_id), String(row.harness_status), Math.min(now, Date.parse(String(row.received_at))), typeof row.receipt_id === 'string' ? row.receipt_id : null)
    }
    this.db.exec('DROP TABLE incoming_events')
    this.setSetting(compactionKey, '1')
  }

  private queueRows(): QueueRow[] {
    return this.db.prepare('SELECT * FROM delivery_queue ORDER BY sequence').all() as unknown as QueueRow[]
  }

  private currentRows(): QueueRow[] {
    return this.deliverySettings.storageMode === 'memory' ? [...this.memoryQueue.values()].sort((a, b) => a.sequence - b.sequence) : this.queueRows()
  }

  private insertQueueRow(row: QueueRow): void {
    this.db.prepare(`INSERT INTO delivery_queue(sequence,event_id,harness_json,payload_bytes,status,delivery_attempts,next_attempt_at,enqueued_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET status=excluded.status,delivery_attempts=excluded.delivery_attempts,next_attempt_at=excluded.next_attempt_at`).run(
      row.sequence, row.event_id, row.harness_json, row.payload_bytes, row.status, row.delivery_attempts, row.next_attempt_at, row.enqueued_at,
    )
  }

  private deleteQueueRows(ids: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM delivery_queue WHERE event_id=?')
    for (const id of ids) remove.run(id)
  }

  private saveDedup(eventId: string, disposition: string, observedAt = Date.now(), receiptId: string | null = null): void {
    const receiptHash = receiptId === null ? null : createHash('sha256').update(receiptId).digest('hex')
    this.db.prepare(`INSERT INTO event_dedup(event_id,observed_at,disposition,receipt_hash) VALUES(?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET observed_at=excluded.observed_at,disposition=excluded.disposition,receipt_hash=excluded.receipt_hash`).run(eventId, observedAt, disposition, receiptHash)
  }

  private pruneFailedWriteDedup(now = Date.now()): void {
    for (const [id, at] of this.failedWriteDedup) if (at <= now - dedupLifetimeMs) this.failedWriteDedup.delete(id)
    while (this.failedWriteDedup.size > maxDedupIdentifiers) this.failedWriteDedup.delete(this.failedWriteDedup.keys().next().value!)
  }

  private pruneDedup(now = Date.now()): void {
    this.pruneFailedWriteDedup(now)
    this.db.prepare('DELETE FROM event_dedup WHERE observed_at <= ?').run(now - dedupLifetimeMs)
    const limit = maxDedupIdentifiers - this.failedWriteDedup.size
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM event_dedup').get()?.count ?? 0)
    if (count > limit) this.db.prepare('DELETE FROM event_dedup WHERE rowid IN (SELECT rowid FROM event_dedup ORDER BY observed_at DESC,rowid DESC LIMIT -1 OFFSET ?)').run(limit)
  }

  private reclaimPayloadSpace(): void {
    try { this.db.exec('PRAGMA incremental_vacuum(64); PRAGMA wal_checkpoint(TRUNCATE)') }
    catch {
      this.queueState = { ...this.queueState, lastQueueError: '临时队列正文已删除，数据库空间回收待重试。' }
      try { this.persistState(this.queueState) } catch { /* The visible in-memory error survives a storage failure. */ }
    }
  }

  private removalsForCapacity(rows: readonly QueueRow[], values: DeliverySettings, addedMessages = 0, addedBytes = 0): string[] | null {
    let count = rows.length + addedMessages
    let bytes = rows.reduce((total, row) => total + row.payload_bytes, addedBytes)
    if (count <= values.maxQueuedMessages && bytes <= values.maxQueuedBytes) return []
    if (values.overflowPolicy === 'reject-new' || addedBytes > values.maxQueuedBytes) return null
    const removed: string[] = []
    for (const row of rows) {
      if (row.status !== 'pending') continue
      removed.push(row.event_id)
      count -= 1
      bytes -= row.payload_bytes
      if (count <= values.maxQueuedMessages && bytes <= values.maxQueuedBytes) return removed
    }
    return null
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  recordEvent(pluginId: string, key: string, _event: JsonObject, harness: HarnessEvent | null, _metadata?: { conversationId: string; text: string; instanceId?: string }): { inserted: boolean; eventId: string; queued?: boolean; admission?: 'queued' | 'not-forwarded' | 'rejected' } {
    const eventId = createHash('sha256').update(`${pluginId}:${key}`).digest('hex')
    const now = Date.now()
    this.pruneFailedWriteDedup(now)
    let admission: 'queued' | 'not-forwarded' | 'rejected' = harness ? 'queued' : 'not-forwarded'
    let row: QueueRow | undefined
    let removals: string[] = []
    let error: string | null = null
    try {
      if (this.failedWriteDedup.has(eventId) || this.db.prepare('SELECT 1 FROM event_dedup WHERE event_id=? AND observed_at>?').get(eventId, now - dedupLifetimeMs) ||
        (this.deliverySettings.storageMode === 'memory' ? this.memoryQueue.has(eventId) : this.db.prepare('SELECT 1 FROM delivery_queue WHERE event_id=?').get(eventId))) return { inserted: false, eventId }
      if (harness) {
        const json = serializeEnvelope(harness, eventId)
        row = { sequence: this.queueState.nextSequence, event_id: eventId, harness_json: json, payload_bytes: Buffer.byteLength(json, 'utf8'),
          status: 'pending', delivery_attempts: 0, next_attempt_at: 0, enqueued_at: now }
        const planned = this.removalsForCapacity(this.currentRows(), this.deliverySettings, 1, row.payload_bytes)
        if (planned === null) { admission = 'rejected'; error = '临时消息队列已达到容量上限，新消息未加入队列。' }
        else removals = planned
      }
      const state = { ...this.queueState, nextSequence: this.queueState.nextSequence + (admission === 'queued' ? 1 : 0),
        rejected: this.queueState.rejected + (admission === 'rejected' ? 1 : 0), discarded: this.queueState.discarded + removals.length,
        notForwarded: this.queueState.notForwarded + (admission === 'not-forwarded' ? 1 : 0), lastQueueError: error }
      const nextMemory = new Map(this.memoryQueue)
      if (this.deliverySettings.storageMode === 'memory' && admission === 'queued' && row) {
        for (const id of removals) nextMemory.delete(id)
        nextMemory.set(eventId, row)
      }
      this.transaction(() => {
        if (this.deliverySettings.storageMode === 'persistent' && admission === 'queued' && row) { this.deleteQueueRows(removals); this.insertQueueRow(row) }
        for (const id of removals) this.saveDedup(id, 'discarded', now)
        this.saveDedup(eventId, admission, now)
        this.pruneDedup(now)
        this.persistState(state)
      })
      this.queueState = state
      this.memoryQueue = nextMemory
      if (removals.length) this.reclaimPayloadSpace()
      return { inserted: true, eventId, queued: admission === 'queued', admission }
    } catch {
      // Never interrupt the platform's live receive log or pretend that an insertion reached the queue.
      const state = { ...this.queueState, rejected: this.queueState.rejected + 1, lastQueueError: '临时队列写入失败，新消息未加入队列。' }
      try {
        this.transaction(() => { this.saveDedup(eventId, 'rejected', now); this.pruneDedup(now); this.persistState(state) })
      } catch { this.failedWriteDedup.set(eventId, now); this.pruneFailedWriteDedup(now) }
      this.queueState = state
      return { inserted: true, eventId, queued: false, admission: 'rejected' }
    }
  }

  getQueuedHarnessEvents(): readonly QueuedHarnessEvent[] {
    return this.currentRows().map(row => ({ event: readEnvelope(row.harness_json), sequence: row.sequence, attempts: row.delivery_attempts,
      status: row.status, nextAttemptAt: row.next_attempt_at, enqueuedAt: row.enqueued_at }))
  }

  listMessages(pluginId: string, options: { conversationId?: string; limit?: number; before?: number; instanceId?: string } = {}): readonly StoredMessage[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50))
    return this.getQueuedHarnessEvents().filter(item => item.event.pluginId === pluginId && (options.conversationId === undefined || item.event.conversationId === options.conversationId) &&
      (options.instanceId === undefined || item.event.instanceId === options.instanceId) && item.sequence < (options.before ?? Number.MAX_SAFE_INTEGER)).reverse().slice(0, limit).map(item => ({
      sequence: item.sequence, eventId: item.event.eventId, pluginId: item.event.pluginId, instanceId: item.event.instanceId,
      conversationId: item.event.conversationId, receivedAt: item.event.receivedAt, text: item.event.text, raw: {}, harnessStatus: item.status,
    }))
  }

  pendingHarnessEvents(limit = 20): readonly PendingHarnessEvent[] {
    return this.getQueuedHarnessEvents().filter(item => item.status === 'pending' && item.attempts < this.deliverySettings.maxDeliveryAttempts && item.nextAttemptAt <= Date.now())
      .slice(0, Math.max(0, limit)).map(({ event, attempts }) => ({ event, attempts }))
  }

  getDeliverySettings(): DeliverySettings { return { ...this.deliverySettings } }

  getDeliverySettingsSnapshot(): DeliverySettingsSnapshot {
    try { this.pruneDedup() }
    catch { this.queueState = { ...this.queueState, lastQueueError: this.queueState.lastQueueError ?? '临时队列元数据清理失败，待存储恢复后重试。' } }
    const counts = { pending: 0, delivering: 0, uncertain: 0, queuedMessages: 0, queuedBytes: 0 }
    if (this.deliverySettings.storageMode === 'persistent') {
      const groups = this.db.prepare('SELECT status,COUNT(*) AS message_count,SUM(payload_bytes) AS payload_bytes FROM delivery_queue GROUP BY status').all()
      for (const group of groups) {
        const count = Number(group.message_count)
        counts[String(group.status) as QueueStatus] += count
        counts.queuedMessages += count
        counts.queuedBytes += Number(group.payload_bytes)
      }
    } else {
      for (const row of this.memoryQueue.values()) {
        counts[row.status] += 1
        counts.queuedMessages += 1
        counts.queuedBytes += row.payload_bytes
      }
    }
    const dedupCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM event_dedup').get()?.count ?? 0)
    const queue: DeliveryQueueStats = { storageMode: this.deliverySettings.storageMode, ...counts,
      accepted: this.queueState.accepted, rejected: this.queueState.rejected, discarded: this.queueState.discarded,
      dedupIdentifiers: dedupCount + this.failedWriteDedup.size,
      overCapacity: counts.queuedMessages > this.deliverySettings.maxQueuedMessages || counts.queuedBytes > this.deliverySettings.maxQueuedBytes,
      lastQueueError: this.queueState.lastQueueError }
    return { protocolVersion: 1, revision: this.deliveryRevision, values: this.getDeliverySettings(), queue }
  }

  updateDeliverySettings(values: DeliverySettings, expectedRevision: number): DeliverySettingsSnapshot {
    const validated = validateDeliverySettings(values)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.deliveryRevision) throw new PlatformError('DELIVERY_SETTINGS_CONFLICT', '投递设置已被修改，请刷新后重试。', 409)
    const rows = this.currentRows()
    const removals = this.removalsForCapacity(rows, validated)
    if (removals === null) throw new PlatformError('DELIVERY_QUEUE_CAPACITY_CONFLICT', '现有待投递消息超过新容量，设置未保存；投递中和结果未知消息不能被自动移除。', 409)
    const removed = new Set(removals)
    const survivors = rows.filter(row => !removed.has(row.event_id))
    // Prepare RAM before committing any persistent deletion. A failure leaves both mode and payload unchanged.
    const nextMemory = validated.storageMode === 'memory' ? new Map(survivors.map(row => [row.event_id, { ...row }])) : new Map<string, QueueRow>()
    const state = { ...this.queueState, discarded: this.queueState.discarded + removals.length, lastQueueError: null }
    const revision = this.deliveryRevision + 1
    this.transaction(() => {
      if (validated.storageMode !== this.deliverySettings.storageMode) {
        this.db.exec('DELETE FROM delivery_queue')
        if (validated.storageMode === 'persistent') for (const row of survivors) this.insertQueueRow(row)
      } else if (validated.storageMode === 'persistent') this.deleteQueueRows(removals)
      for (const id of removals) this.saveDedup(id, 'discarded')
      this.pruneDedup()
      this.persistSettings(validated, revision)
      this.persistState(state)
    })
    const removedDiskPayload = this.deliverySettings.storageMode === 'persistent' && (validated.storageMode === 'memory' || removals.length > 0)
    this.deliverySettings = validated
    this.deliveryRevision = revision
    this.queueState = state
    this.memoryQueue = nextMemory
    if (removedDiskPayload) this.reclaimPayloadSpace()
    return this.getDeliverySettingsSnapshot()
  }

  markHarnessDeliveryBatch(ids: readonly string[], status: 'delivering' | 'pending' | 'uncertain', error: string | null = null, _receiptId: string | null = null, retryAt = 0): void {
    if (!Number.isSafeInteger(retryAt) || retryAt < 0 || !['delivering', 'pending', 'uncertain'].includes(status)) throw new PlatformError('INVALID_DELIVERY_STATE', '投递状态或重试时间无效。')
    const selected = new Set(ids)
    const rows = this.currentRows().filter(row => selected.has(row.event_id)).map(row => ({ ...row, status,
      delivery_attempts: row.delivery_attempts + (status === 'delivering' ? 1 : 0), next_attempt_at: status === 'pending' ? retryAt : row.next_attempt_at }))
    if (!rows.length) return
    const state = { ...this.queueState, lastQueueError: error ? (status === 'uncertain' ? '投递接受结果未知，消息已保留等待核对。' : 'Harness 未接受消息，待重试。') : null }
    const nextMemory = new Map(this.memoryQueue)
    for (const row of rows) nextMemory.set(row.event_id, row)
    this.transaction(() => {
      if (this.deliverySettings.storageMode === 'persistent') for (const row of rows) this.insertQueueRow(row)
      this.persistState(state)
    })
    this.queueState = state
    if (this.deliverySettings.storageMode === 'memory') this.memoryQueue = nextMemory
  }

  acknowledgeHarnessBatch(ids: readonly string[], receiptId: string): void {
    if (typeof receiptId !== 'string' || !receiptId.trim()) throw new PlatformError('INVALID_DELIVERY_RECEIPT', '持久接收回执不能为空。')
    const selected = new Set(ids)
    const rows = this.currentRows().filter(row => selected.has(row.event_id))
    if (!rows.length) return
    const state = { ...this.queueState, accepted: this.queueState.accepted + rows.length, lastQueueError: null }
    const nextMemory = new Map(this.memoryQueue)
    for (const row of rows) nextMemory.delete(row.event_id)
    this.transaction(() => {
      if (this.deliverySettings.storageMode === 'persistent') this.deleteQueueRows(rows.map(row => row.event_id))
      for (const row of rows) this.saveDedup(row.event_id, 'accepted', Date.now(), receiptId)
      this.pruneDedup()
      this.persistState(state)
    })
    this.queueState = state
    this.memoryQueue = nextMemory
    if (this.deliverySettings.storageMode === 'persistent') this.reclaimPayloadSpace()
  }

  clearDeliveryQueue(): DeliverySettingsSnapshot {
    const rows = this.currentRows()
    if (rows.some(row => row.status === 'delivering')) throw new PlatformError('DELIVERY_IN_PROGRESS', '当前有消息正在投递，请等待结果确认后清空。', 409)
    const state = { ...this.queueState, discarded: this.queueState.discarded + rows.length, lastQueueError: null }
    this.transaction(() => {
      if (this.deliverySettings.storageMode === 'persistent') this.db.exec('DELETE FROM delivery_queue')
      for (const row of rows) this.saveDedup(row.event_id, 'discarded')
      this.pruneDedup()
      this.persistState(state)
    })
    this.queueState = state
    this.memoryQueue.clear()
    if (this.deliverySettings.storageMode === 'persistent' && rows.length) this.reclaimPayloadSpace()
    return this.getDeliverySettingsSnapshot()
  }

  harnessSummary(): JsonObject {
    const { queue } = this.getDeliverySettingsSnapshot()
    return { pending: queue.pending, delivering: queue.delivering, accepted: queue.accepted, uncertain: queue.uncertain, 'not-forwarded': this.queueState.notForwarded,
      rejected: queue.rejected, discarded: queue.discarded, queueMessages: queue.queuedMessages, queueBytes: queue.queuedBytes,
      storageMode: queue.storageMode, overCapacity: queue.overCapacity, lastQueueError: queue.lastQueueError }
  }

  async executeIdempotent(pluginId: string, action: string, params: JsonObject, requestId: string, execute: () => Promise<JsonValue>, scope?: { instanceId: string; accountId: string }): Promise<JsonValue> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestId)) throw new PlatformError('INVALID_REQUEST_ID', 'request_id 需为8至128位稳定标识。')
    const scopeKey = scope ? `${scope.instanceId}:${scope.accountId}` : ''
    const key = `${pluginId}:${scopeKey}:${requestId}`
    const hash = createHash('sha256').update(stableJson(params)).digest('hex')
    const existing = this.db.prepare('SELECT * FROM actions WHERE plugin_id=? AND scope_key=? AND request_id=?').get(pluginId, scopeKey, requestId)
    if (existing) {
      if (existing.action !== action || existing.params_hash !== hash) throw new PlatformError('IDEMPOTENCY_CONFLICT', '同一 request_id 已用于不同参数，不能复用。', 409)
      if (existing.state === 'succeeded') {
        const result: unknown = JSON.parse(String(existing.result_json))
        if (!isJsonValue(result)) throw new PlatformError('STORAGE_CORRUPTED', '动作结果记录损坏。', 500)
        return result
      }
      if (existing.state === 'unknown' || existing.state === 'running') throw new PlatformError('ACTION_OUTCOME_UNKNOWN', '该请求正在执行或结果未知，未重复发送。请先查询消息或外部真实状态。', 409, 'unknown')
      throw new PlatformError(String(existing.error_code), String(existing.error_message), 409)
    }
    if (this.runningActions.has(key)) throw new PlatformError('ACTION_IN_PROGRESS', '相同动作正在执行。', 409, 'unknown')
    this.db.prepare("INSERT INTO actions(plugin_id,scope_key,request_id,action,params_hash,state,created_at) VALUES(?,?,?,?,?,'running',?)").run(pluginId, scopeKey, requestId, action, hash, new Date().toISOString())
    this.runningActions.add(key)
    try {
      const result = await execute()
      this.db.prepare("UPDATE actions SET state='succeeded',result_json=? WHERE plugin_id=? AND scope_key=? AND request_id=?").run(JSON.stringify(result), pluginId, scopeKey, requestId)
      return result
    } catch (error) {
      const known = error instanceof PlatformError ? error : new PlatformError('ACTION_OUTCOME_UNKNOWN', '动作执行失败，结果需要查询。', 500, 'unknown')
      this.db.prepare('UPDATE actions SET state=?,error_code=?,error_message=? WHERE plugin_id=? AND scope_key=? AND request_id=?').run(
        known.outcome === 'unknown' ? 'unknown' : 'failed', known.code, known.message, pluginId, scopeKey, requestId,
      )
      throw known
    } finally { this.runningActions.delete(key) }
  }

  close(): void { this.db.close(); this.memoryQueue.clear(); this.failedWriteDedup.clear() }
}
