import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { PlatformError, isJsonValue, isJsonObject } from '@eating/plugin-sdk'
import type { HarnessEvent, JsonObject, JsonValue, StoredMessage } from '@eating/plugin-sdk'

interface EventRow {
  sequence: number
  event_id: string
  plugin_id: string
  instance_id: string | null
  conversation_id: string | null
  received_at: string
  text: string
  raw_json: string
  harness_json: string | null
  harness_status: StoredMessage['harnessStatus']
}

export interface PendingHarnessEvent { readonly event: HarnessEvent; readonly attempts: number }

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`).join(',')}}`
  return JSON.stringify(value)
}

export class HostStore {
  private readonly db: DatabaseSync
  private readonly runningActions = new Set<string>()

  constructor(readonly databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(databasePath), 0o700)
    }
    this.db = new DatabaseSync(databasePath)
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incoming_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        plugin_id TEXT NOT NULL,
        deduplication_key TEXT NOT NULL,
        conversation_id TEXT,
        instance_id TEXT,
        received_at TEXT NOT NULL,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        harness_json TEXT,
        harness_status TEXT NOT NULL,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivery_error TEXT,
        receipt_id TEXT,
        UNIQUE(plugin_id, deduplication_key)
      );
      CREATE INDEX IF NOT EXISTS events_by_conversation ON incoming_events(plugin_id, conversation_id, sequence);
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
    // An interrupted outbound action is never automatically resent.
    this.db.prepare("UPDATE actions SET state = 'unknown', error_code = 'PROCESS_INTERRUPTED', error_message = '上次进程在动作结果确认前退出；请查询真实状态，不要直接重发。' WHERE state = 'running'").run()
    this.db.prepare("UPDATE incoming_events SET harness_status = 'uncertain', delivery_error = '上次投递被中断，接受结果待核对。' WHERE harness_status = 'delivering'").run()
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  recordEvent(pluginId: string, key: string, event: JsonObject, harness: HarnessEvent | null, metadata?: { conversationId: string; text: string; instanceId?: string }): { inserted: boolean; eventId: string } {
    const eventId = createHash('sha256').update(`${pluginId}:${key}`).digest('hex')
    const receivedAt = harness?.receivedAt ?? new Date().toISOString()
    const result = this.db.prepare(`INSERT OR IGNORE INTO incoming_events
      (event_id,plugin_id,deduplication_key,conversation_id,instance_id,received_at,text,raw_json,harness_json,harness_status)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(eventId, pluginId, key, metadata?.conversationId ?? harness?.conversationId ?? null, metadata?.instanceId ?? harness?.instanceId ?? null, receivedAt,
      metadata?.text ?? harness?.text ?? (typeof event.raw_message === 'string' ? event.raw_message : ''), JSON.stringify(event),
      harness ? JSON.stringify({ ...harness, eventId }) : null, harness ? 'pending' : 'not-forwarded')
    return { inserted: result.changes > 0, eventId }
  }

  listMessages(pluginId: string, options: { conversationId?: string; limit?: number; before?: number; instanceId?: string } = {}): readonly StoredMessage[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50))
    const rows = this.db.prepare(`SELECT * FROM incoming_events WHERE plugin_id = ?
      AND (? IS NULL OR conversation_id = ?) AND (? IS NULL OR instance_id = ?) AND sequence < ? ORDER BY sequence DESC LIMIT ?`).all(
      pluginId, options.conversationId ?? null, options.conversationId ?? null, options.instanceId ?? null, options.instanceId ?? null, options.before ?? Number.MAX_SAFE_INTEGER, limit,
    )
    return rows.map(row => {
      const item = row as unknown as EventRow
      const raw: unknown = JSON.parse(item.raw_json)
      if (!isJsonObject(raw)) throw new PlatformError('STORAGE_CORRUPTED', '消息记录损坏，无法读取。', 500)
      return { sequence: item.sequence, eventId: item.event_id, pluginId: item.plugin_id, instanceId: item.instance_id, conversationId: item.conversation_id,
        receivedAt: item.received_at, text: item.text, raw, harnessStatus: item.harness_status }
    })
  }

  pendingHarnessEvents(limit = 20): readonly PendingHarnessEvent[] {
    return this.db.prepare("SELECT harness_json, delivery_attempts FROM incoming_events WHERE harness_status = 'pending' AND delivery_attempts < 5 ORDER BY sequence LIMIT ?").all(limit).map(row => {
      const event = JSON.parse(String(row.harness_json)) as HarnessEvent
      return { event, attempts: Number(row.delivery_attempts) }
    })
  }

  markHarnessDelivery(eventId: string, status: 'delivering' | 'pending' | 'accepted' | 'uncertain', error: string | null = null, receiptId: string | null = null): void {
    this.db.prepare(`UPDATE incoming_events SET harness_status=?,delivery_error=?,receipt_id=?,
      delivery_attempts=delivery_attempts + ? WHERE event_id=?`).run(status, error, receiptId, status === 'delivering' ? 1 : 0, eventId)
  }

  harnessSummary(): JsonObject {
    const rows = this.db.prepare('SELECT harness_status,COUNT(*) AS count FROM incoming_events GROUP BY harness_status').all()
    const counts: JsonObject = { pending: 0, accepted: 0, uncertain: 0, 'not-forwarded': 0 }
    for (const row of rows) counts[String(row.harness_status)] = Number(row.count)
    return counts
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

  close(): void { this.db.close() }
}
