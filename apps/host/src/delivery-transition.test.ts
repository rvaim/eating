import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { validateDeliverySettings } from '@eating/plugin-sdk'
import { HostStore } from './store'
const { planDeliveryTransition, applyDeliveryTransition } = await import(new URL('../../../scripts/server-delivery-transition.mjs', import.meta.url).href)
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) { if (realpathSync(path) !== path || dirname(path) !== realpathSync(tmpdir()) || !basename(path).startsWith('eating-delivery-transition-')) throw new Error('Unsafe fixture cleanup'); rmSync(path, { recursive: true }) } })
const previous = { revision: 4, values: { storageMode: 'persistent', maxQueuedMessages: 777, maxQueuedBytes: 10485760, overflowPolicy: 'reject-new', quietWindowMs: 500, maxWaitMs: 2000, maxBatchMessages: 10, batchTargetBytes: 32768, deliveryTimeoutMs: 15000, retryIntervalMs: 12000, maxDeliveryAttempts: 3 } }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-delivery-transition-'))); directories.push(directory)
  const data = join(directory, 'data'), dsh = join(data, 'harness/dsh'); mkdirSync(dsh, { recursive: true })
  const dbPath = join(data, 'host/Eating.sqlite'), store = new HostStore(dbPath)
  store.setSetting('host:delivery-settings', JSON.stringify(previous)); store.setSetting('untouched', 'kept'); store.close()
  const sessionId = randomUUID(), batchId = 'a'.repeat(64), receiptId = `dsh:${sessionId}:${batchId}:4`
  const session = { schemaVersion: 1, sessionId, created: true, activeBatchId: batchId, digest: 'd'.repeat(64), nonce: randomUUID(), receiptId, lastOutcome: 'durable' }
  const raw = JSON.stringify(session), file = join(dsh, 'session.json'); writeFileSync(file, raw); writeFileSync(join(dsh, 'native.log'), 'preserved history\n')
  const db = new DatabaseSync(dbPath); db.prepare("INSERT INTO event_dedup VALUES(?,?,'accepted',?)").run('event', Date.now(), digest(receiptId)); db.close()
  const input = { dataDirectory: data, backupDirectory: join(directory, 'backup'), expectedSettingsSha256: digest(JSON.stringify(previous)), expectedSessionSha256: digest(raw), confirmation: 'fixed-window-async-tasks' }
  return { data, dsh, dbPath, session, file, raw, input }
}
describe('explicit fixed-window delivery transition', () => {
  it('preserves capacities and retries, rejects old settings in the current reader, and does not materialize unsaved defaults', () => {
    const session = { schemaVersion: 1, sessionId: randomUUID(), created: true }
    expect(() => validateDeliverySettings(previous.values)).toThrow()
    const next = planDeliveryTransition(previous, session, false)
    expect(next.settings).toMatchObject({ revision: 5, values: { maxQueuedMessages: 777, retryIntervalMs: 12000, maxDeliveryAttempts: 3, aggregationWindowMs: 10000, appendWhileBusy: true } })
    expect(validateDeliverySettings(next.settings.values)).toEqual(next.settings.values)
    expect(planDeliveryTransition(null, session, false).settings).toBeNull()
    expect(previous.revision).toBe(4)
  })
  it('updates only the intended setting and transient pointer with an exact backup, preserving all other data', () => {
    const f = fixture()
    expect(applyDeliveryTransition(f.input)).toMatchObject({ rootSessionRetained: true, nativeLogsModified: false, aggregationWindowMs: 10000 })
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ schemaVersion: 1, sessionId: f.session.sessionId, created: true })
    expect(readFileSync(join(f.input.backupDirectory, 'session.before.json'), 'utf8')).toBe(f.raw)
    const store = new HostStore(f.dbPath)
    try { expect(store.getDeliverySettingsSnapshot()).toMatchObject({ revision: 5, values: { aggregationWindowMs: 10000, appendWhileBusy: true } }); expect(store.getSetting('untouched')).toBe('kept'); expect(store.deliveryReceiptAccepted(f.session.receiptId)).toBe(true) } finally { store.close() }
    expect(readFileSync(join(f.dsh, 'native.log'), 'utf8')).toBe('preserved history\n')
    expect(() => applyDeliveryTransition(f.input)).toThrow()
  })
  it('refuses an active host, changed hash, or unconfirmed old handoff before creating any backup', () => {
    const f = fixture()
    writeFileSync(join(f.data, 'host/host.lock'), 'running')
    expect(() => applyDeliveryTransition(f.input)).toThrow()
    rmSync(join(f.data, 'host/host.lock'))
    expect(() => applyDeliveryTransition({ ...f.input, expectedSettingsSha256: 'f'.repeat(64) })).toThrow()
    expect(() => planDeliveryTransition(previous, f.session, false)).toThrow()
    expect(existsSync(f.input.backupDirectory)).toBe(false); expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })
})
