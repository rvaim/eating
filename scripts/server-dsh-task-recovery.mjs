import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { actionMetadata, TASK_ACTIONS_KEY, validateTaskActions } from '../apps/host/src/task-actions.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = code => { throw new Error('TASK_RECOVERY_' + code) }
function checkedFile(root, name, hash) {
  if (typeof name !== 'string' || !isAbsolute(name) || !hex(hash)) fail('CONFIG_INVALID')
  const inside = relative(root, name)
  if (inside === '..' || inside.startsWith('..' + sep) || lstatSync(name).isSymbolicLink() || realpathSync(name) !== resolve(name)) fail('PATH_INVALID')
  const bytes = readFileSync(name)
  if (bytes.length > 64 * 1024 * 1024 || digest(bytes) !== hash) fail('FILE_CHANGED')
  return bytes
}
const message = event => event.type === 'user/message' ? event.data : event.data?.message
function jsonBodies(event) {
  return (message(event)?.content ?? []).filter(block => block.type === 'text').flatMap(block => {
    try { const value = JSON.parse(block.text); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [] } catch { return [] }
  })
}
export function recoverDshTask(configuration, apply = false) {
  const fields = ['dataDirectory', 'taskId', 'parentLog', 'childLog', 'bindingsSha256', 'parentLogSha256', 'childLogSha256', 'confirmation']
  if (!configuration || Object.keys(configuration).sort().join(',') !== fields.sort().join(',') || !hex(configuration.taskId)
    || configuration.confirmation !== 'import-audited-contact-receipts' || !isAbsolute(configuration.dataDirectory)) fail('CONFIG_INVALID')
  const home = realpathSync(configuration.dataDirectory)
  if (home !== resolve(configuration.dataDirectory) || lstatSync(home).isSymbolicLink() || existsSync(resolve(home, 'host/host.lock'))) fail('HOST_MUST_BE_STOPPED')
  const harness = resolve(home, 'harness/dsh'), bindingFile = resolve(harness, 'proactive-bindings.json')
  const bindingBytes = checkedFile(harness, bindingFile, configuration.bindingsSha256)
  const document = JSON.parse(bindingBytes)
  if (document.schemaVersion !== 1 || !Array.isArray(document.bindings)) fail('BINDINGS_INVALID')
  const matches = document.bindings.filter(binding => binding.task.taskId === configuration.taskId)
  if (matches.length !== 1) fail('TASK_NOT_UNIQUE')
  const binding = matches[0], task = binding.task
  if (task.state !== 'unknown' || !binding.taskRefs.some(ref => ref.taskId === task.taskId && ref.contextRef === task.contextRef && ref.nonce === task.nonce)) fail('TASK_CHANGED')
  if (!configuration.parentLog.split(sep).includes(binding.parentId) || !configuration.childLog.split(sep).includes(binding.agentId)) fail('SESSION_MISMATCH')
  const parentBytes = checkedFile(harness, configuration.parentLog, configuration.parentLogSha256)
  const childBytes = checkedFile(harness, configuration.childLog, configuration.childLogSha256)
  const parse = bytes => bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const parent = parse(parentBytes), child = parse(childBytes)
  const results = parent.filter(event => event.type === 'tool/result' && message(event)?.role === 'tool' && message(event)?.source?.kind === 'tool')
    .flatMap(event => jsonBodies(event).filter(value => value.taskId === task.taskId && value.childId === binding.agentId && value.contextRef === task.contextRef && value.status === 'running').map(value => ({ event, value })))
  if (results.length !== 1) fail('PARENT_RECEIPT_NOT_UNIQUE')
  const returned = results[0].event
  const calls = parent.filter(event => event.type === 'assistant/message').flatMap(event => (message(event)?.content ?? [])
    .filter(block => block.type === 'tool-call' && block.id === message(returned).toolCallId && block.name === 'eating_contact_target').map(block => ({ event, block })))
  if (calls.length !== 1) fail('PARENT_CALL_NOT_UNIQUE')
  if (digest(binding.parentId + '\0' + calls[0].block.id) !== task.taskId) fail('TASK_ID_MISMATCH')
  const args = JSON.parse(calls[0].block.arguments)
  if (args.target_id !== binding.target.id || !['reply', 'verify'].includes(args.mode)) fail('TARGET_MISMATCH')
  let turn, selected
  for (let index = 0; index < child.length; index++) {
    const event = child[index]
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type !== 'user/message' || event.time < calls[0].event.time || event.time > returned.time + 4000) continue
    const source = message(event)?.source
    if (source?.kind !== 'agent-message' || source.form !== 'relay' || source.senderSessionId !== binding.parentId) continue
    if (!jsonBodies(event).some(value => value.eating?.protocolVersion === 1 && value.eating.contextRef === task.contextRef && value.eating.agentTypeId === binding.target.agentTypeId)) continue
    if (selected) fail('CHILD_TURN_NOT_UNIQUE')
    selected = { index, turn }
  }
  if (!selected || !Number.isSafeInteger(selected.turn)) fail('CHILD_TURN_MISSING')
  const ending = child.findIndex((event, index) => index > selected.index && event.type === 'turn/end' && event.data.turn === selected.turn)
  if (ending < 0) fail('CHILD_TERMINAL_MISSING')
  const databasePath = resolve(home, 'host/Eating.sqlite')
  if (lstatSync(databasePath).isSymbolicLink() || realpathSync(databasePath) !== databasePath) fail('PATH_INVALID')
  const database = new DatabaseSync(databasePath, { readOnly: !apply })
  try {
    if (database.prepare('PRAGMA user_version').get().user_version !== 1) fail('DATABASE_SCHEMA_INVALID')
    const actionRowsBefore = digest(JSON.stringify(database.prepare('SELECT * FROM actions ORDER BY plugin_id,scope_key,request_id').all()))
    const settingsBefore = database.prepare('SELECT key,value FROM settings ORDER BY key').all()
    const entries = new Map()
    for (const event of child.slice(selected.index, ending + 1)) {
      if (event.type !== 'assistant/message' || event.data.turn !== selected.turn) continue
      for (const block of message(event)?.content ?? []) {
        if (block.type !== 'tool-call') continue
        const input = JSON.parse(block.arguments)
        if (typeof input.request_id !== 'string') continue
        const prefix = 'mcp__' + binding.target.pluginId + '__'
        if (!block.name.startsWith(prefix)) fail('UNSUPPORTED_WRITE_SOURCE')
        const tool = block.name.slice(prefix.length)
        if (!binding.target.toolNames.includes(tool) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.request_id)) fail('ACTION_SCOPE_INVALID')
        const ledger = { pluginId: binding.target.pluginId, scopeKey: binding.target.instanceId + ':' + binding.target.accountId,
          requestId: 'agent-' + digest(binding.agentId + '\0' + input.request_id) }
        const row = database.prepare('SELECT state,result_json,error_code FROM actions WHERE plugin_id=? AND scope_key=? AND request_id=?').get(ledger.pluginId, ledger.scopeKey, ledger.requestId)
        if (!row || !['succeeded', 'failed'].includes(row.state)) fail('ACTION_NOT_CONFIRMED')
        const metadata = row.result_json === null ? undefined : actionMetadata(JSON.parse(row.result_json))
        entries.set(input.request_id, { sourceId: binding.target.pluginId, ledger, receipt: { requestId: input.request_id, tool, outcome: row.state,
          ...(row.error_code ? { code: row.error_code } : {}), ...(metadata !== undefined ? { result: metadata } : {}) } })
      }
    }
    if (!entries.size) fail('NO_VERIFIED_ACTIONS')
    const record = { harnessId: 'dsh', agentId: binding.agentId, taskId: task.taskId, closed: true, reviewed: false, actions: [...entries.values()] }
    validateTaskActions({ schemaVersion: 1, tasks: [record] })
    const stored = database.prepare('SELECT value FROM settings WHERE key=?').get(TASK_ACTIONS_KEY)
    const current = stored ? validateTaskActions(JSON.parse(stored.value)) : { schemaVersion: 1, tasks: [] }
    const existing = current.tasks.find(row => row.harnessId === 'dsh' && row.agentId === binding.agentId && row.taskId === task.taskId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) fail('IMPORT_CONFLICT')
    const next = existing ? current : { schemaVersion: 1, tasks: [...current.tasks, record] }
    validateTaskActions(next)
    checkedFile(harness, bindingFile, configuration.bindingsSha256)
    checkedFile(harness, configuration.parentLog, configuration.parentLogSha256)
    checkedFile(harness, configuration.childLog, configuration.childLogSha256)
    if (apply && !existing) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const latest = database.prepare('SELECT value FROM settings WHERE key=?').get(TASK_ACTIONS_KEY)
        if ((latest?.value ?? null) !== (stored?.value ?? null)) fail('SETTINGS_CHANGED')
        database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(TASK_ACTIONS_KEY, JSON.stringify(next))
        const after = database.prepare('SELECT key,value FROM settings WHERE key<>? ORDER BY key').all(TASK_ACTIONS_KEY)
        if (JSON.stringify(after) !== JSON.stringify(settingsBefore.filter(row => row.key !== TASK_ACTIONS_KEY))
          || digest(JSON.stringify(database.prepare('SELECT * FROM actions ORDER BY plugin_id,scope_key,request_id').all())) !== actionRowsBefore) fail('RETENTION_CHECK_FAILED')
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
    }
    return { audited: true, receiptAssociationImported: apply, alreadyImported: Boolean(existing), actionCount: entries.size, knownActions: entries.size,
      unknownActions: 0, originalActionLedgerRetained: true, originalSettingsRetained: true, nativeLogsUnchanged: true, externalCalls: 0 }
  } finally { database.close() }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_TASK_RECOVERY_CONFIG
    if (!path || !isAbsolute(path) || lstatSync(path).isSymbolicLink() || process.argv.slice(2).some(arg => arg !== '--apply')) fail('CONFIG_INVALID')
    console.log(JSON.stringify(recoverDshTask(JSON.parse(readFileSync(path, 'utf8')), process.argv.includes('--apply'))))
  } catch (error) { console.error(error instanceof Error && /^TASK_RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : 'TASK_RECOVERY_FAILED'); process.exitCode = 1 }
}
