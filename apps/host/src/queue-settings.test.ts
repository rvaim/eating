import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DELIVERY_SETTINGS } from '@eating/plugin-sdk'
import type { DeliverySettings, HarnessEvent, JsonObject } from '@eating/plugin-sdk'
import { HostStore } from './store'

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const parent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(parent, 'eating-queue-settings-')))
  const databasePath = join(directory, 'host.sqlite')
  const stores = new Set<HostStore>()
  const open = () => { const store = new HostStore(databasePath); stores.add(store); return store }
  const close = (store: HostStore) => { store.close(); stores.delete(store) }
  const inspect = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(databasePath)
    try { return run(db) } finally { db.close() }
  }
  cleanups.push(() => {
    for (const store of stores) store.close()
    const target = realpathSync(directory)
    if (target !== directory || dirname(target) !== parent || !basename(target).startsWith('eating-queue-settings-') || lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to delete outside the verified test directory.')
    rmSync(target, { recursive: true })
  })
  return { directory, databasePath, open, close, inspect }
}

function envelope(text = 'message', conversationId = 'test:private:queue'): HarnessEvent {
  return { protocolVersion: 1, eventId: 'replaced', pluginId: 'queue-test', instanceId: 'instance-one', platform: 'test', accountId: 'account',
    conversationId, senderId: 'sender', receivedAt: new Date().toISOString(), source: { trust: 'external', kind: 'private' }, content: { type: 'text', text }, text }
}
function hash(key: string): string { return createHash('sha256').update(`queue-test:${key}`).digest('hex') }
function record(store: HostStore, key: string, text = key) { return store.recordEvent('queue-test', key, { raw_message: `raw-only:${text}` }, envelope(text)) }
function configure(store: HostStore, patch: Partial<DeliverySettings>) {
  const snapshot = store.getDeliverySettingsSnapshot()
  const values = { ...snapshot.values, ...patch }
  values.maxBatchMessages = Math.min(values.maxBatchMessages, values.maxQueuedMessages)
  values.batchTargetBytes = Math.min(values.batchTargetBytes, values.maxQueuedBytes)
  return store.updateDeliverySettings(values, snapshot.revision)
}
function payloads(test: ReturnType<typeof fixture>): Buffer {
  return Buffer.concat(['host.sqlite', 'host.sqlite-wal', 'host.sqlite-shm'].map(name => join(test.directory, name)).filter(existsSync).map(path => readFileSync(path)))
}

interface LegacyEvent { key: string; status: 'pending' | 'delivering' | 'uncertain' | 'accepted' | 'not-forwarded'; text?: string; json?: string | null; at?: string; attempts?: number }
function seedLegacy(test: ReturnType<typeof fixture>, rows: readonly LegacyEvent[]) {
  test.inspect(db => {
    db.exec(`CREATE TABLE incoming_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, plugin_id TEXT NOT NULL,
      deduplication_key TEXT NOT NULL, conversation_id TEXT, instance_id TEXT, received_at TEXT NOT NULL,
      text TEXT NOT NULL, raw_json TEXT NOT NULL, harness_json TEXT, harness_status TEXT NOT NULL,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, delivery_error TEXT, receipt_id TEXT,
      UNIQUE(plugin_id,deduplication_key));
      CREATE INDEX events_by_conversation ON incoming_events(plugin_id,conversation_id,sequence);
      BEGIN IMMEDIATE;`)
    const insert = db.prepare(`INSERT INTO incoming_events(event_id,plugin_id,deduplication_key,conversation_id,instance_id,received_at,text,raw_json,harness_json,harness_status,delivery_attempts,receipt_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const row of rows) {
      const text = row.text ?? row.key
      insert.run(hash(row.key), 'queue-test', row.key, 'test:private:queue', 'instance-one', row.at ?? new Date().toISOString(), text,
        JSON.stringify({ raw_message: `raw-only:${text}` }), row.json === undefined ? JSON.stringify({ ...envelope(text), eventId: hash(row.key) }) : row.json,
        row.status, row.attempts ?? 0, row.status === 'accepted' ? 'legacy-receipt' : null)
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
  })
}

describe('HostStore queue settings and content retention', () => {
  it('exposes defaults, validates again, checks revisions and returns independent settings', () => {
    const store = fixture().open()
    expect(store.getDeliverySettingsSnapshot()).toMatchObject({ protocolVersion: 1, revision: 0, values: DEFAULT_DELIVERY_SETTINGS,
      queue: { storageMode: 'persistent', queuedMessages: 0, queuedBytes: 0, accepted: 0, rejected: 0, discarded: 0, overCapacity: false } })
    const values = store.getDeliverySettings() as { -readonly [K in keyof DeliverySettings]: DeliverySettings[K] }
    values.maxWaitMs = 9999
    expect(store.getDeliverySettings().maxWaitMs).toBe(DEFAULT_DELIVERY_SETTINGS.maxWaitMs)
    expect(() => store.updateDeliverySettings({ ...DEFAULT_DELIVERY_SETTINGS, maxWaitMs: 1 }, 0)).toThrow(expect.objectContaining({ code: 'INVALID_DELIVERY_SETTINGS' }))
    expect(() => store.updateDeliverySettings(DEFAULT_DELIVERY_SETTINGS, 1)).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(store.getDeliverySettingsSnapshot().revision).toBe(0)
    expect(configure(store, { quietWindowMs: 0, maxWaitMs: 1 }).revision).toBe(1)
    expect(() => store.updateDeliverySettings(DEFAULT_DELIVERY_SETTINGS, 0)).toThrow(expect.objectContaining({ code: 'DELIVERY_SETTINGS_CONFLICT', statusCode: 409 }))
  })

  it('never persists local-only content or raw protocol copies and removes acknowledged bodies exactly once', () => {
    const test = fixture()
    const store = test.open()
    const local = store.recordEvent('queue-test', 'local-only', { raw_message: 'local-only-unique-secret' }, null,
      { conversationId: 'local', text: 'local-only-unique-secret', instanceId: 'instance-one' })
    expect(local).toMatchObject({ inserted: true, queued: false, admission: 'not-forwarded' })
    const accepted = record(store, 'accepted', 'accepted-body-unique-secret')
    expect(store.listMessages('queue-test')[0]).toMatchObject({ text: 'accepted-body-unique-secret', raw: {} })
    expect(payloads(test).includes(Buffer.from('raw-only:'))).toBe(false)
    expect(payloads(test).includes(Buffer.from('local-only-unique-secret'))).toBe(false)
    store.markHarnessDeliveryBatch([accepted.eventId], 'delivering')
    store.acknowledgeHarnessBatch([accepted.eventId, accepted.eventId], 'receipt-body-unique-secret')
    store.acknowledgeHarnessBatch([accepted.eventId], 'another-receipt')
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(store.listMessages('queue-test')).toEqual([])
    expect(store.harnessSummary()).toMatchObject({ accepted: 1, pending: 0, 'not-forwarded': 1, queueMessages: 0, queueBytes: 0 })
    expect(payloads(test).includes(Buffer.from('accepted-body-unique-secret'))).toBe(false)
    expect(payloads(test).includes(Buffer.from('receipt-body-unique-secret'))).toBe(false)
    expect(test.inspect(db => db.prepare('SELECT * FROM event_dedup WHERE event_id=?').get(accepted.eventId))).toMatchObject({ disposition: 'accepted', receipt_hash: createHash('sha256').update('receipt-body-unique-secret').digest('hex') })
    expect(store.recordEvent('queue-test', 'accepted', {}, envelope())).toEqual({ inserted: false, eventId: accepted.eventId })
    expect(() => store.acknowledgeHarnessBatch([], ' ')).toThrow(expect.objectContaining({ code: 'INVALID_DELIVERY_RECEIPT' }))
  })

  it('keeps memory payloads out of SQLite and forgets them across an ordinary restart while settings and hashes survive', () => {
    const test = fixture()
    const store = test.open()
    configure(store, { storageMode: 'memory' })
    const first = record(store, 'memory-message', 'memory-mode-unique-secret')
    expect(store.getQueuedHarnessEvents()).toHaveLength(1)
    expect(test.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get()?.count)).toBe(0)
    expect(payloads(test).includes(Buffer.from('memory-mode-unique-secret'))).toBe(false)
    test.close(store)
    const reopened = test.open()
    expect(reopened.getDeliverySettingsSnapshot()).toMatchObject({ revision: 1, values: { storageMode: 'memory' }, queue: { queuedMessages: 0, queuedBytes: 0 } })
    expect(record(reopened, 'memory-message')).toEqual({ inserted: false, eventId: first.eventId })
  })

  it('moves every outstanding state between disk and RAM without changing sequence, attempts or retry time', () => {
    const test = fixture()
    const store = test.open()
    const pending = record(store, 'pending', 'switch-mode-pending-secret')
    const delivering = record(store, 'delivering', 'switch-mode-delivering-secret')
    const uncertain = record(store, 'uncertain', 'switch-mode-uncertain-secret')
    store.markHarnessDeliveryBatch([pending.eventId], 'pending', null, null, Date.now() + 10000)
    store.markHarnessDeliveryBatch([delivering.eventId], 'delivering')
    store.markHarnessDeliveryBatch([uncertain.eventId], 'delivering')
    store.markHarnessDeliveryBatch([uncertain.eventId], 'uncertain', 'test-only-secret-error')
    const original = store.getQueuedHarnessEvents()
    expect(configure(store, { storageMode: 'memory' }).queue).toMatchObject({ pending: 1, delivering: 1, uncertain: 1, queuedMessages: 3 })
    expect(store.getQueuedHarnessEvents()).toEqual(original)
    expect(test.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get()?.count)).toBe(0)
    expect(payloads(test).includes(Buffer.from('switch-mode-'))).toBe(false)
    expect(payloads(test).includes(Buffer.from('test-only-secret-error'))).toBe(false)
    configure(store, { storageMode: 'persistent' })
    expect(store.getQueuedHarnessEvents()).toEqual(original)
    test.close(store)
    const reopened = test.open()
    expect(reopened.getQueuedHarnessEvents().map(item => [item.event.eventId, item.status, item.attempts])).toEqual([
      [pending.eventId, 'pending', 0], [delivering.eventId, 'uncertain', 1], [uncertain.eventId, 'uncertain', 1],
    ])
    expect(reopened.pendingHarnessEvents()).toEqual([])
  })

  it.each(['persistent', 'memory'] as const)('isolates nested sink mutations from the %s queue', storageMode => {
    const store = fixture().open()
    configure(store, { storageMode })
    record(store, 'immutable', 'original')
    const snapshot = store.getQueuedHarnessEvents()[0]!
    ;(snapshot.event.content as JsonObject).text = 'mutated'
    ;(snapshot.event as unknown as { text: string }).text = 'mutated'
    ;(snapshot as unknown as { attempts: number }).attempts = 99
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event: { text: 'original', content: { text: 'original' } }, attempts: 0 })
  })

  it.each(['persistent', 'memory'] as const)('rolls back a failed %s mode switch with all settings and payloads intact', storageMode => {
    const test = fixture()
    const store = test.open()
    configure(store, { storageMode })
    record(store, 'protected-switch', 'mode-switch-rollback-secret')
    const before = store.getDeliverySettingsSnapshot()
    const events = store.getQueuedHarnessEvents()
    test.inspect(db => db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON settings WHEN NEW.key='host:delivery-settings' BEGIN SELECT RAISE(ABORT,'injected setting failure'); END"))
    expect(() => configure(store, { storageMode: storageMode === 'memory' ? 'persistent' : 'memory' })).toThrow('injected setting failure')
    expect(store.getDeliverySettingsSnapshot()).toEqual(before)
    expect(store.getQueuedHarnessEvents()).toEqual(events)
    expect(test.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get()?.count)).toBe(storageMode === 'persistent' ? 1 : 0)
    test.inspect(db => db.exec('DROP TRIGGER fail_settings'))
    configure(store, { storageMode: storageMode === 'memory' ? 'persistent' : 'memory' })
    expect(store.getQueuedHarnessEvents()).toEqual(events)
  })

  it('rolls back RAM-to-disk inserts and batch state changes if a later row fails', () => {
    const test = fixture()
    const store = test.open()
    configure(store, { storageMode: 'memory' })
    const first = record(store, 'batch-one')
    const second = record(store, 'batch-two')
    const original = store.getQueuedHarnessEvents()
    test.inspect(db => db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON delivery_queue WHEN NEW.event_id='${second.eventId}' BEGIN SELECT RAISE(ABORT,'injected payload failure'); END`))
    expect(() => configure(store, { storageMode: 'persistent' })).toThrow('injected payload failure')
    expect(store.getDeliverySettings().storageMode).toBe('memory')
    expect(store.getQueuedHarnessEvents()).toEqual(original)
    expect(test.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get()?.count)).toBe(0)
    test.inspect(db => db.exec('DROP TRIGGER fail_second'))
    configure(store, { storageMode: 'persistent' })
    test.inspect(db => db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON delivery_queue WHEN NEW.event_id='${second.eventId}' BEGIN SELECT RAISE(ABORT,'injected batch failure'); END`))
    expect(() => store.markHarnessDeliveryBatch([first.eventId, second.eventId], 'delivering')).toThrow('injected batch failure')
    expect(store.getQueuedHarnessEvents()).toEqual(original)
  })

  it('returns visible rejected admission on payload insertion failure without losing the old queue or duplicate logging', () => {
    const test = fixture()
    const store = test.open()
    configure(store, { maxQueuedMessages: 1, overflowPolicy: 'drop-oldest' })
    const old = record(store, 'old-body')
    test.inspect(db => db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON delivery_queue BEGIN SELECT RAISE(ABORT,'test-only-sensitive-storage-error'); END"))
    const result = record(store, 'failed-body', 'failed-body-unique-secret')
    expect(result).toMatchObject({ inserted: true, queued: false, admission: 'rejected' })
    expect(store.getQueuedHarnessEvents().map(item => item.event.eventId)).toEqual([old.eventId])
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ rejected: 1, discarded: 0, queuedMessages: 1, lastQueueError: expect.any(String) })
    expect(record(store, 'failed-body')).toEqual({ inserted: false, eventId: result.eventId })
    expect(payloads(test).includes(Buffer.from('failed-body-unique-secret'))).toBe(false)
    expect(test.inspect(db => db.prepare("SELECT value FROM settings WHERE value LIKE '%test-only-sensitive-storage-error%'").all())).toEqual([])
  })

  it('still returns a rejected receive result and deduplicates in RAM when all metadata writes fail', () => {
    const test = fixture()
    const store = test.open()
    test.inspect(db => db.exec("CREATE TRIGGER fail_metadata BEFORE INSERT ON event_dedup BEGIN SELECT RAISE(ABORT,'metadata write failure'); END"))
    const failed = record(store, 'metadata-failed', 'metadata-failed-body-secret')
    expect(failed).toMatchObject({ inserted: true, queued: false, admission: 'rejected' })
    expect(record(store, 'metadata-failed')).toEqual({ inserted: false, eventId: failed.eventId })
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ queuedMessages: 0, rejected: 1, dedupIdentifiers: 1, lastQueueError: expect.any(String) })
    expect(payloads(test).includes(Buffer.from('metadata-failed-body-secret'))).toBe(false)
    test.inspect(db => db.exec('DROP TRIGGER fail_metadata'))
    expect(record(store, 'metadata-recovered').queued).toBe(true)
    expect(store.getDeliverySettingsSnapshot().queue.rejected).toBe(1)
  })

  it('keeps rejection counters and errors observable if expired identifier cleanup also fails', () => {
    const test = fixture()
    const store = test.open()
    test.inspect(db => {
      db.prepare("INSERT INTO event_dedup(event_id,observed_at,disposition) VALUES(?,?,'not-forwarded')").run(hash('expired'), Date.now() - 25 * 60 * 60 * 1000)
      db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON event_dedup BEGIN SELECT RAISE(ABORT,'metadata cleanup failure'); END")
    })
    expect(record(store, 'cleanup-rejected')).toMatchObject({ inserted: true, queued: false, admission: 'rejected' })
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ queuedMessages: 0, rejected: 1, lastQueueError: expect.any(String) })
    expect(store.harnessSummary()).toMatchObject({ rejected: 1, queueMessages: 0, lastQueueError: expect.any(String) })
  })

  it('counts UTF-8 JSON bytes for all outstanding states and rejects new content without storing it', () => {
    const test = fixture()
    const store = test.open()
    configure(store, { maxQueuedMessages: 3, maxQueuedBytes: 4096 })
    const ids = [record(store, 'utf-one', '汉字😀'), record(store, 'utf-two', '第二条'), record(store, 'utf-three', '第三条')].map(item => item.eventId)
    store.markHarnessDeliveryBatch([ids[1]!], 'delivering')
    store.markHarnessDeliveryBatch([ids[2]!], 'uncertain')
    const bytes = test.inspect(db => db.prepare('SELECT harness_json,payload_bytes FROM delivery_queue ORDER BY sequence').all())
    const expectedBytes = bytes.reduce((sum, row) => sum + Buffer.byteLength(String(row.harness_json), 'utf8'), 0)
    expect(bytes.every(row => row.payload_bytes === Buffer.byteLength(String(row.harness_json), 'utf8'))).toBe(true)
    expect(expectedBytes).toBeGreaterThan(bytes.reduce((sum, row) => sum + String(row.harness_json).length, 0))
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ queuedMessages: 3, queuedBytes: expectedBytes, pending: 1, delivering: 1, uncertain: 1 })
    const rejected = record(store, 'too-many', 'rejected-body-unique-secret')
    expect(rejected).toMatchObject({ inserted: true, queued: false, admission: 'rejected' })
    expect(record(store, 'too-many')).toEqual({ inserted: false, eventId: rejected.eventId })
    expect(store.harnessSummary()).toMatchObject({ queueMessages: 3, queueBytes: expectedBytes, rejected: 1, lastQueueError: expect.any(String) })
    expect(payloads(test).includes(Buffer.from('rejected-body-unique-secret'))).toBe(false)
  })

  it('does not evict any existing message for a single oversized envelope', () => {
    const store = fixture().open()
    configure(store, { maxQueuedBytes: 2048, overflowPolicy: 'drop-oldest' })
    record(store, 'small', 'kept')
    const before = store.getQueuedHarnessEvents()
    expect(record(store, 'oversized', '汉'.repeat(1000))).toMatchObject({ inserted: true, queued: false, admission: 'rejected' })
    expect(store.getQueuedHarnessEvents()).toEqual(before)
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ discarded: 0, rejected: 1 })
  })

  it('drops only the oldest pending payload, leaving delivering and uncertain entries protected', () => {
    const store = fixture().open()
    configure(store, { maxQueuedMessages: 3, overflowPolicy: 'drop-oldest' })
    const first = record(store, 'old-delivering')
    const pending = record(store, 'middle-pending')
    const uncertain = record(store, 'last-uncertain')
    store.markHarnessDeliveryBatch([first.eventId], 'delivering')
    store.markHarnessDeliveryBatch([uncertain.eventId], 'uncertain')
    const added = record(store, 'new-pending')
    expect(added.admission).toBe('queued')
    expect(store.getQueuedHarnessEvents().map(item => item.event.eventId)).toEqual([first.eventId, uncertain.eventId, added.eventId])
    expect(record(store, 'middle-pending')).toEqual({ inserted: false, eventId: pending.eventId })
    store.markHarnessDeliveryBatch([added.eventId], 'uncertain')
    expect(record(store, 'new-rejected').admission).toBe('rejected')
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ discarded: 1, rejected: 1, delivering: 1, uncertain: 2 })
  })

  it('rejects incompatible shrink settings atomically and permits explicit pending-only cropping', () => {
    const store = fixture().open()
    const first = record(store, 'shrink-first')
    const second = record(store, 'shrink-second')
    const third = record(store, 'shrink-third')
    store.markHarnessDeliveryBatch([first.eventId], 'delivering')
    store.markHarnessDeliveryBatch([third.eventId], 'uncertain')
    const before = store.getDeliverySettingsSnapshot()
    const entries = store.getQueuedHarnessEvents()
    expect(() => configure(store, { maxQueuedMessages: 2 })).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(() => configure(store, { maxQueuedMessages: 1, overflowPolicy: 'drop-oldest', storageMode: 'memory' })).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(store.getDeliverySettingsSnapshot()).toEqual(before)
    expect(store.getQueuedHarnessEvents()).toEqual(entries)
    const after = configure(store, { maxQueuedMessages: 2, overflowPolicy: 'drop-oldest' })
    expect(after.revision).toBe(before.revision + 1)
    expect(after.queue).toMatchObject({ discarded: 1, queuedMessages: 2 })
    expect(store.getQueuedHarnessEvents().map(item => item.event.eventId)).toEqual([first.eventId, third.eventId])
    expect(record(store, 'shrink-second')).toEqual({ inserted: false, eventId: second.eventId })
  })

  it('refuses clear during delivery, clears other payloads explicitly, and preserves dedup and the send ledger', async () => {
    const test = fixture()
    const store = test.open()
    const send = vi.fn(async () => ({ sent: 'preserved-result' }))
    await store.executeIdempotent('queue-test', 'send', { text: 'outbound' }, 'preserved-action', send)
    const first = record(store, 'clear-pending')
    const second = record(store, 'clear-uncertain')
    store.markHarnessDeliveryBatch([second.eventId], 'delivering')
    const before = store.getDeliverySettingsSnapshot()
    expect(() => store.clearDeliveryQueue()).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(store.getDeliverySettingsSnapshot()).toEqual(before)
    store.markHarnessDeliveryBatch([second.eventId], 'uncertain')
    expect(store.clearDeliveryQueue().queue).toMatchObject({ queuedMessages: 0, queuedBytes: 0, discarded: 2 })
    expect(store.clearDeliveryQueue().queue.discarded).toBe(2)
    expect(record(store, 'clear-pending')).toEqual({ inserted: false, eventId: first.eventId })
    expect(record(store, 'clear-uncertain')).toEqual({ inserted: false, eventId: second.eventId })
    test.close(store)
    const reopened = test.open()
    expect(await reopened.executeIdempotent('queue-test', 'send', { text: 'outbound' }, 'preserved-action', send)).toEqual({ sent: 'preserved-result' })
    expect(send).toHaveBeenCalledOnce()
    expect(reopened.getQueuedHarnessEvents()).toEqual([])
  })

  it('keeps receipt deletion and accepted counters atomic when a batch acknowledgement fails', () => {
    const test = fixture()
    const store = test.open()
    const first = record(store, 'ack-one')
    const second = record(store, 'ack-two')
    test.inspect(db => db.exec(`CREATE TRIGGER fail_second BEFORE DELETE ON delivery_queue WHEN OLD.event_id='${second.eventId}' BEGIN SELECT RAISE(ABORT,'injected ack failure'); END`))
    expect(() => store.acknowledgeHarnessBatch([first.eventId, second.eventId], 'receipt')).toThrow('injected ack failure')
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ queuedMessages: 2, accepted: 0 })
    expect(test.inspect(db => db.prepare("SELECT COUNT(*) AS count FROM event_dedup WHERE disposition='accepted'").get()?.count)).toBe(0)
  })

  it('uses the configured attempt limit and retry time for pending eligibility while exposing every outstanding entry', () => {
    const store = fixture().open()
    configure(store, { maxDeliveryAttempts: 1 })
    const attempted = record(store, 'attempted')
    const delayed = record(store, 'delayed')
    const ready = record(store, 'ready')
    store.markHarnessDeliveryBatch([attempted.eventId, attempted.eventId], 'delivering')
    store.markHarnessDeliveryBatch([attempted.eventId], 'pending')
    store.markHarnessDeliveryBatch([delayed.eventId], 'pending', null, null, Date.now() + 10000)
    expect(store.getQueuedHarnessEvents().map(item => item.attempts)).toEqual([1, 0, 0])
    expect(store.pendingHarnessEvents().map(item => item.event.eventId)).toEqual([ready.eventId])
    expect(store.pendingHarnessEvents(0)).toEqual([])
    expect(store.getQueuedHarnessEvents()).toHaveLength(3)
  })
})

describe('HostStore legacy history removal and bounded deduplication', () => {
  it('keeps all legacy outstanding messages, removes terminal bodies, shrinks the same file once and preserves outbound results', async () => {
    const test = fixture()
    const initial = test.open()
    const send = vi.fn(async () => ({ id: 'sent-before-migration' }))
    await initial.executeIdempotent('queue-test', 'send', {}, 'migration-action', send)
    test.close(initial)
    const terminalSecret = `terminal-history-secret-${'old-body'.repeat(50000)}`
    seedLegacy(test, [
      { key: 'legacy-pending', status: 'pending', text: 'kept-pending' },
      { key: 'legacy-delivering', status: 'delivering', text: 'kept-delivering', attempts: 2 },
      { key: 'legacy-uncertain', status: 'uncertain', text: 'kept-uncertain', attempts: 1 },
      { key: 'legacy-accepted', status: 'accepted', text: terminalSecret },
      { key: 'legacy-local', status: 'not-forwarded', text: 'terminal-local-secret', json: null },
    ])
    const beforeBytes = statSync(test.databasePath).size
    const store = test.open()
    expect(store.getQueuedHarnessEvents().map(item => [item.event.text, item.status, item.attempts])).toEqual([
      ['kept-pending', 'pending', 0], ['kept-delivering', 'uncertain', 2], ['kept-uncertain', 'uncertain', 1],
    ])
    expect(store.harnessSummary()).toMatchObject({ pending: 1, uncertain: 2, accepted: 1, 'not-forwarded': 1, discarded: 0, rejected: 0 })
    expect(store.listMessages('queue-test').map(item => item.text)).toEqual(['kept-uncertain', 'kept-delivering', 'kept-pending'])
    expect(test.inspect(db => db.prepare("SELECT name FROM sqlite_master WHERE name='incoming_events'").get())).toBeUndefined()
    expect(test.inspect(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(2)
    expect(test.inspect(db => db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum)).toBe(2)
    expect(statSync(test.databasePath).size).toBeLessThan(beforeBytes / 4)
    expect(payloads(test).includes(Buffer.from('terminal-history-secret'))).toBe(false)
    expect(payloads(test).includes(Buffer.from('terminal-local-secret'))).toBe(false)
    expect(payloads(test).includes(Buffer.from('raw-only:'))).toBe(false)
    expect(readdirSync(test.directory).every(name => ['host.sqlite', 'host.sqlite-wal', 'host.sqlite-shm'].includes(name))).toBe(true)
    expect(record(store, 'legacy-accepted')).toEqual({ inserted: false, eventId: hash('legacy-accepted') })
    expect(await store.executeIdempotent('queue-test', 'send', {}, 'migration-action', send)).toEqual({ id: 'sent-before-migration' })
    expect(send).toHaveBeenCalledOnce()
    test.close(store)
    const reopened = test.open()
    expect(reopened.harnessSummary()).toMatchObject({ accepted: 1, uncertain: 2, queueMessages: 3 })
  })

  it('retains an old backlog above the new defaults and rejects new admissions without trimming it', () => {
    const test = fixture()
    seedLegacy(test, Array.from({ length: 1001 }, (_, index) => ({ key: `backlog-${index}`, status: 'pending' as const })))
    const store = test.open()
    expect(store.getDeliverySettingsSnapshot().queue).toMatchObject({ queuedMessages: 1001, overCapacity: true, discarded: 0 })
    expect(record(store, 'new-backlog').admission).toBe('rejected')
    expect(store.getQueuedHarnessEvents()).toHaveLength(1001)
    expect(store.getQueuedHarnessEvents()[0]!.event.eventId).toBe(hash('backlog-0'))
    expect(store.getQueuedHarnessEvents()[1000]!.event.eventId).toBe(hash('backlog-1000'))
  })

  it('rolls back the full migration if an outstanding legacy envelope is invalid', () => {
    const test = fixture()
    seedLegacy(test, [{ key: 'valid-before-bad', status: 'pending' }, { key: 'bad', status: 'uncertain', json: '{}' }])
    expect(() => test.open()).toThrow(expect.objectContaining({ code: 'STORAGE_CORRUPTED' }))
    expect(test.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM incoming_events').get()?.count)).toBe(2)
    expect(test.inspect(db => db.prepare("SELECT name FROM sqlite_master WHERE name='delivery_queue'").get())).toBeUndefined()
  })

  it('caps content-free identifiers at 10000 and expires them at 24 hours without losing outstanding deduplication', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T10:00:00.000Z'))
    const test = fixture()
    const store = test.open()
    test.inspect(db => {
      db.exec('BEGIN IMMEDIATE')
      const add = db.prepare("INSERT INTO event_dedup(event_id,observed_at,disposition) VALUES(?,?,'not-forwarded')")
      for (let index = 0; index < 10000; index += 1) add.run(hash(`bounded-${index}`), Date.now() - 10000 + index)
      db.exec('COMMIT')
    })
    const pending = record(store, 'long-pending')
    expect(store.getDeliverySettingsSnapshot().queue.dedupIdentifiers).toBe(10000)
    expect(store.recordEvent('queue-test', 'bounded-0', {}, null).inserted).toBe(true)
    expect(store.recordEvent('queue-test', 'bounded-9999', {}, null).inserted).toBe(false)
    expect(store.getDeliverySettingsSnapshot().queue.dedupIdentifiers).toBe(10000)
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)
    expect(store.getDeliverySettingsSnapshot().queue.dedupIdentifiers).toBe(0)
    expect(record(store, 'long-pending')).toEqual({ inserted: false, eventId: pending.eventId })
    expect(store.getQueuedHarnessEvents()).toHaveLength(1)
    expect(store.recordEvent('queue-test', 'bounded-9999', {}, null).inserted).toBe(true)
    expect(test.inspect(db => db.prepare('PRAGMA table_info(event_dedup)').all().map(row => row.name))).toEqual(['event_id', 'observed_at', 'disposition', 'receipt_hash'])
  })
})
