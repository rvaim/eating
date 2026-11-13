import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const outside = (root, path) => { const difference = relative(root, path); return difference === '..' || difference.startsWith('..' + sep) }
const previousKeys = ['storageMode', 'maxQueuedMessages', 'maxQueuedBytes', 'overflowPolicy', 'quietWindowMs', 'maxWaitMs', 'maxBatchMessages', 'batchTargetBytes', 'deliveryTimeoutMs', 'retryIntervalMs', 'maxDeliveryAttempts']

/** Explicit offline conversion only. Current production readers accept one format. */
export function planDeliveryTransition(saved, session, receiptAccepted) {
  let settings = null
  if (saved !== null) {
    if (!exact(saved, ['revision', 'values']) || !integer(saved.revision, 0, Number.MAX_SAFE_INTEGER - 1) || !exact(saved.values, previousKeys)) throw new Error('Unexpected previous delivery settings')
    const value = saved.values
    const bounds = { maxQueuedMessages: [1, 100000], maxQueuedBytes: [1024, 104857600], quietWindowMs: [0, 60000], maxWaitMs: [1, 300000], maxBatchMessages: [1, 200], batchTargetBytes: [256, 4194304], deliveryTimeoutMs: [100, 120000], retryIntervalMs: [100, 300000], maxDeliveryAttempts: [1, 20] }
    if (!['persistent', 'memory'].includes(value.storageMode) || !['reject-new', 'drop-oldest'].includes(value.overflowPolicy) || Object.entries(bounds).some(([key, range]) => !integer(value[key], ...range)) || value.maxWaitMs < value.quietWindowMs || value.maxBatchMessages > value.maxQueuedMessages || value.batchTargetBytes > value.maxQueuedBytes) throw new Error('Unexpected previous delivery settings')
    const { quietWindowMs: _quiet, maxWaitMs: _max, maxBatchMessages: _count, batchTargetBytes: _bytes, ...retained } = value
    settings = { revision: saved.revision + 1, values: { ...retained, aggregationWindowMs: 10000, appendWhileBusy: true } }
  }
  if (!object(session) || session.schemaVersion !== 1 || typeof session.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(session.sessionId) || typeof session.created !== 'boolean' || Object.keys(session).some(key => !['schemaVersion', 'sessionId', 'created', 'activeBatchId', 'digest', 'nonce', 'receiptId', 'lastOutcome'].includes(key))) throw new Error('Unexpected previous session metadata')
  if (session.activeBatchId !== undefined && (!hash(session.activeBatchId) || !hash(session.digest) || typeof session.receiptId !== 'string' || !session.receiptId.startsWith('dsh:' + session.sessionId + ':' + session.activeBatchId + ':') || !['durable', 'recovered'].includes(session.lastOutcome) || receiptAccepted !== true)) throw new Error('Previous delivery is not durably accepted; preserve it for review')
  return { settings, session: { schemaVersion: 1, sessionId: session.sessionId, created: session.created } }
}

function privatePath(path, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || !outside(repository, resolve(path)) || realpathSync(path) !== resolve(path) || lstatSync(path).isSymbolicLink() || (directory ? !lstatSync(path).isDirectory() : !lstatSync(path).isFile())) throw new Error('Transition paths must be regular private paths outside the checkout')
  return path
}
export function applyDeliveryTransition(input) {
  if (!exact(input, ['dataDirectory', 'backupDirectory', 'expectedSettingsSha256', 'expectedSessionSha256', 'confirmation']) || input.confirmation !== 'fixed-window-async-tasks' || !hash(input.expectedSettingsSha256) || !hash(input.expectedSessionSha256)) throw new Error('Explicit delivery transition confirmation and hashes are required')
  const data = privatePath(input.dataDirectory, true), lock = resolve(data, 'host/host.lock')
  if (existsSync(lock)) throw new Error('Stop Eating before the delivery transition')
  const sessionPath = privatePath(resolve(data, 'harness/dsh/session.json')), originalSession = readFileSync(sessionPath)
  if (digest(originalSession) !== input.expectedSessionSha256) throw new Error('Session metadata changed after inspection')
  const session = JSON.parse(originalSession)
  const databasePath = privatePath(resolve(data, 'host/Eating.sqlite'))
  const inspect = new DatabaseSync(databasePath, { readOnly: true })
  let raw, next
  try {
    if (inspect.prepare('PRAGMA user_version').get().user_version !== 1 || inspect.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get().count !== 0) throw new Error('Delivery queue is not empty or its schema is unsupported')
    raw = inspect.prepare("SELECT value FROM settings WHERE key='host:delivery-settings'").get()?.value ?? null
    if (digest(raw ?? 'null') !== input.expectedSettingsSha256) throw new Error('Delivery settings changed after inspection')
    const accepted = typeof session.receiptId === 'string' && Boolean(inspect.prepare("SELECT 1 FROM event_dedup WHERE disposition='accepted' AND receipt_hash=? LIMIT 1").get(digest(session.receiptId)))
    next = planDeliveryTransition(raw === null ? null : JSON.parse(raw), session, accepted)
  } finally { inspect.close() }
  for (const name of ['agent-bindings.json', 'proactive-bindings.json']) {
    const path = resolve(data, 'harness/dsh', name)
    if (existsSync(path)) {
      const document = JSON.parse(readFileSync(privatePath(path)))
      if (!Array.isArray(document.bindings) || document.bindings.some(binding => binding.task?.state === 'pending')) throw new Error('Child tasks are still pending')
    }
  }
  if (existsSync(resolve(data, 'harness/dsh/bridge/deliveries.json'))) throw new Error('Current delivery registry already exists; do not run the previous-format transition again')
  if (typeof input.backupDirectory !== 'string' || !isAbsolute(input.backupDirectory) || existsSync(input.backupDirectory) || !outside(data, resolve(input.backupDirectory))) throw new Error('Use a new private backup directory outside application data')
  privatePath(dirname(input.backupDirectory), true)
  mkdirSync(input.backupDirectory, { mode: 0o700 })
  writeFileSync(resolve(input.backupDirectory, 'session.before.json'), originalSession, { mode: 0o600, flag: 'wx' })
  writeFileSync(resolve(input.backupDirectory, 'delivery-settings.before.json'), JSON.stringify(raw), { mode: 0o600, flag: 'wx' })
  const temporary = resolve(dirname(sessionPath), '.delivery-transition-' + randomUUID() + '.tmp')
  const db = new DatabaseSync(databasePath)
  let replaced = false
  try {
    db.exec('BEGIN IMMEDIATE')
    if (existsSync(lock) || digest(readFileSync(sessionPath)) !== input.expectedSessionSha256 || (db.prepare("SELECT value FROM settings WHERE key='host:delivery-settings'").get()?.value ?? null) !== raw || db.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get().count !== 0) throw new Error('Private data changed during backup')
    writeFileSync(temporary, JSON.stringify(next.session, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    if (next.settings) db.prepare("UPDATE settings SET value=? WHERE key='host:delivery-settings'").run(JSON.stringify(next.settings))
    renameSync(temporary, sessionPath); replaced = true
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* Preserve the original conversion failure. */ }
    if (replaced) { writeFileSync(temporary, originalSession, { mode: 0o600, flag: 'wx' }); renameSync(temporary, sessionPath) }
    throw error
  } finally { db.close(); if (existsSync(temporary)) unlinkSync(temporary) }
  return { aggregationWindowMs: 10000, appendWhileBusy: true, settingsWritten: next.settings !== null, rootSessionRetained: true, nativeLogsModified: false }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_DELIVERY_TRANSITION_CONFIG
    if (!path) throw new Error('Set EATING_DELIVERY_TRANSITION_CONFIG to a private confirmation file')
    console.log(JSON.stringify(applyDeliveryTransition(JSON.parse(readFileSync(privatePath(path))))))
  } catch { console.error('Delivery transition failed; inspect private data and backups, no connection details are displayed'); process.exitCode = 1 }
}
