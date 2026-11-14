import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { recoverDshTask } from '../scripts/server-dsh-task-recovery.mjs'
import { TaskActionJournal } from '../apps/host/src/task-actions.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
const parent = realpathSync(tmpdir()), home = realpathSync(mkdtempSync(join(parent, 'eating-task-recovery-audit-')))
try {
  const rootId = '00000000-0000-4000-8000-000000000001', agentId = '00000000-0000-4000-8000-000000000002'
  const taskId = hash(rootId + '\0call_fixture'), contextRef = 'b'.repeat(64), requestId = 'receipt-fixture-001'
  const task = { taskId, contextRef, cycleId: 'fixture-cycle', nonce: 'fixture-nonce', state: 'unknown' }
  const target = { id: 'fixture-contact', label: 'Fixture', pluginId: 'qq', instanceId: 'fixture-instance', accountId: '100', agentTypeId: 'qq.private', targetId: '200', toolNames: ['qq_send_private_message'] }
  const binding = { key: 'c'.repeat(64), agentId, parentId: rootId, target, task, taskRefs: [task] }
  const harness = join(home, 'harness/dsh'), parentDir = join(harness, 'agents', rootId), childDir = join(harness, 'agents', agentId)
  mkdirSync(parentDir, { recursive: true }); mkdirSync(childDir, { recursive: true }); mkdirSync(join(home, 'host'))
  const parentLog = join(parentDir, 'session.v4.jsonl'), childLog = join(childDir, 'session.v4.jsonl'), bindings = join(harness, 'proactive-bindings.json')
  const call = { type: 'tool-call', id: 'call_fixture', name: 'eating_contact_target', arguments: JSON.stringify({ target_id: target.id, mode: 'reply', task: 'UNPERSISTED TASK CONTENT' }) }
  const started = { taskId, childId: agentId, contextRef, status: 'running', actions: [] }
  const parents = [
    { type: 'assistant/message', time: 1000, data: { message: { role: 'assistant', content: [call] } } },
    { type: 'tool/result', time: 1030, data: { message: { role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, content: [{ type: 'text', text: JSON.stringify(started) }] } } },
  ]
  const children = [
    { type: 'turn/start', time: 1001, data: { turn: 1 } },
    { type: 'user/message', time: 1002, data: { role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: rootId }, content: [{ type: 'text', text: JSON.stringify({ eating: { protocolVersion: 1, contextRef, agentTypeId: target.agentTypeId }, task: 'UNPERSISTED TASK CONTENT' }) }] } },
    { type: 'assistant/message', time: 2000, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'child_call', name: 'mcp__qq__qq_send_private_message', arguments: JSON.stringify({ user_id: 200, message: 'UNPERSISTED MESSAGE', request_id: requestId }) }] } } },
    { type: 'turn/end', time: 4000, data: { turn: 1, reason: { kind: 'aborted' } } },
  ]
  const writeLog = (path, rows) => writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  writeLog(parentLog, parents); writeLog(childLog, children); writeFileSync(bindings, JSON.stringify({ schemaVersion: 1, bindings: [binding] }))
  const db = new DatabaseSync(join(home, 'host/Eating.sqlite'))
  db.exec('PRAGMA user_version=1; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE actions(plugin_id TEXT,scope_key TEXT,request_id TEXT,state TEXT,result_json TEXT,error_code TEXT);')
  db.prepare('INSERT INTO settings VALUES(?,?)').run('owner-kept', 'OWNER SETTING')
  const scoped = 'agent-' + hash(agentId + '\0' + requestId)
  db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?)').run('qq', 'fixture-instance:100', scoped, 'succeeded', JSON.stringify({ message_id: 123 }), null)
  db.close()
  const config = () => ({ dataDirectory: home, taskId, parentLog, childLog, bindingsSha256: hash(readFileSync(bindings)), parentLogSha256: hash(readFileSync(parentLog)), childLogSha256: hash(readFileSync(childLog)), confirmation: 'import-audited-contact-receipts' })
  assert.equal(recoverDshTask(config()).receiptAssociationImported, false)
  assert.equal(recoverDshTask(config(), true).knownActions, 1)
  assert.equal(recoverDshTask(config(), true).alreadyImported, true)
  const reopened = new DatabaseSync(join(home, 'host/Eating.sqlite'))
  const journal = new TaskActionJournal({ getSetting: key => reopened.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null, setSetting: () => { throw new Error('No write expected') }, readActionReceipt: () => null })
  assert.deepEqual(journal.read('dsh', agentId, taskId), { available: true, closed: true, actions: [{ requestId, tool: 'qq_send_private_message', outcome: 'succeeded', result: { message_id: 123 } }] })
  assert.equal(reopened.prepare('SELECT value FROM settings WHERE key=?').get('owner-kept').value, 'OWNER SETTING')
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM actions').get().n, 1)
  reopened.prepare("UPDATE actions SET state='unknown'").run()
  assert.throws(() => recoverDshTask(config(), true), /ACTION_NOT_CONFIRMED/)
  reopened.close()
  const changed = config(); writeFileSync(childLog, readFileSync(childLog).toString() + '\n')
  assert.throws(() => recoverDshTask(changed), /FILE_CHANGED/)
  writeFileSync(join(home, 'host/host.lock'), 'fixture-live-lock')
  assert.throws(() => recoverDshTask(config()), /HOST_MUST_BE_STOPPED/)
  console.log(JSON.stringify({ checks: 10, passed: true, externalCalls: 0, originalLedgerRetained: true, unknownRefused: true, changedLogsRefused: true, liveHostRefused: true }))
} finally {
  if (realpathSync(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-task-recovery-audit-')) throw new Error('Unsafe task audit cleanup')
  rmSync(home, { recursive: true })
}
