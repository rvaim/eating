import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { AgentActionReceipt } from '@eating/plugin-sdk'
import { HostStore } from './store'
import { TaskActionJournal, TASK_ACTIONS_KEY } from './task-actions'

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop() })
function fixture() {
  const parent = realpathSync(tmpdir()), home = realpathSync(mkdtempSync(join(parent, 'eating-task-receipts-'))), database = join(home, 'ledger.sqlite')
  stops.push(() => { if (realpathSync(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-task-receipts-')) throw new Error('Unsafe receipt fixture cleanup'); rmSync(home, { recursive: true }) })
  let store = new HostStore(database)
  stops.push(() => store.close())
  const taskId = 'a'.repeat(64), agentId = 'child', harnessId = 'dsh'
  const request = 'original-request-001', scoped = 'agent-ledger-request-001'
  const receipt: AgentActionReceipt = { requestId: request, tool: 'qq_send_private_message', outcome: 'unknown' }
  const reference = { pluginId: 'qq', scopeKey: 'instance:100', requestId: scoped }
  const journal = new TaskActionJournal(store); journal.open(harnessId, agentId, taskId)
  const begin = (id = taskId) => journal.begin(harnessId, agentId, id, 'qq', reference, receipt)
  const read = (id = taskId, close = false) => journal.read(harnessId, agentId, id, close)
  const execute = (call: () => Promise<import('@eating/plugin-sdk').JsonValue>) => store.executeIdempotent('qq', 'send_private_msg', { message: 'DO-NOT-COPY-PROMPT-INTO-RECEIPTS' }, scoped, call, { instanceId: 'instance', accountId: '100' })
  return { get store() { return store }, journal, taskId, agentId, harnessId, request, receipt, reference, begin, read, execute,
    restart: () => { store.close(); store = new HostStore(database); return new TaskActionJournal(store) } }
}
describe('durable task action receipts', () => {
  it('recovers the actual receipt after a crash between ledger commit and task reporting without sending again', async () => {
    const f = fixture(); let calls = 0
    f.begin()
    expect(f.read()).toMatchObject({ available: true, closed: false, actions: [{ outcome: 'unknown', code: 'ACTION_IN_PROGRESS' }] })
    await f.execute(async () => { calls++; return { message_id: 101, providerExtra: 'DO-NOT-COPY-OUTPUT' } })
    const restarted = f.restart()
    expect(restarted.read(f.harnessId, f.agentId, f.taskId, true)).toEqual({ available: true, closed: true, actions: [{ requestId: f.request, tool: f.receipt.tool, outcome: 'succeeded', result: { message_id: 101 } }] })
    await f.execute(async () => { calls++; return null })
    expect(calls).toBe(1)
    expect(JSON.stringify(f.store.getSetting(TASK_ACTIONS_KEY))).not.toMatch(/DO-NOT-COPY|providerExtra|base64/)
    expect(() => restarted.open(f.harnessId, f.agentId, f.taskId)).toThrowError('原任务已有动作记录')
  })
  it('keeps an action unknown while it is in flight and reconciles its later committed outcome', async () => {
    const f = fixture(); f.begin()
    let release!: () => void
    const pending = f.execute(async () => { await new Promise<void>(resolve => { release = resolve }); return { message_id: 102 } })
    expect(f.read(f.taskId, true).actions[0]!.outcome).toBe('unknown')
    release(); await pending
    expect(f.read().actions[0]).toMatchObject({ outcome: 'succeeded', result: { message_id: 102 } })
  })
  it.each(['failed', 'unknown'] as const)('restores a durable %s outcome and retains stable request replay protection', async outcome => {
    const f = fixture(); f.begin(); let calls = 0
    await expect(f.execute(async () => { calls++; throw new PlatformError('FIXTURE_ACTION_RESULT', 'Fixture action result', 502, outcome) })).rejects.toMatchObject({ outcome })
    const journal = f.restart()
    expect(journal.read(f.harnessId, f.agentId, f.taskId, true).actions[0]).toMatchObject({ outcome, code: 'FIXTURE_ACTION_RESULT' })
    await expect(f.execute(async () => { calls++; return null })).rejects.toBeDefined()
    expect(calls).toBe(1)
    journal.read(f.harnessId, f.agentId, f.taskId, true, true)
    expect(journal.read(f.harnessId, f.agentId, f.taskId).actions[0]!.outcome).toBe(outcome)
  })
  it('keeps old task callbacks separate from a newer task for the same child and from other Harnesses', () => {
    const f = fixture(); f.begin(); f.read(f.taskId, true)
    const next = 'b'.repeat(64); f.journal.open(f.harnessId, f.agentId, next); f.begin(next)
    f.journal.finish(f.harnessId, f.agentId, f.taskId, 'qq', { ...f.receipt, outcome: 'succeeded', result: { message_id: 103 } })
    expect(f.read().actions[0]!.outcome).toBe('succeeded')
    expect(f.read(next).actions[0]!.outcome).toBe('unknown')
    expect(f.journal.read('different-harness', f.agentId, f.taskId)).toEqual({ available: false, closed: false, actions: [] })
    expect(f.journal.read(f.harnessId, 'different-child', f.taskId).available).toBe(false)
  })
  it('rejects a malformed journal without rewriting saved data', () => {
    const f = fixture(), invalid = { schemaVersion: 0, tasks: [] }
    f.store.setSetting(TASK_ACTIONS_KEY, JSON.stringify(invalid))
    expect(() => new TaskActionJournal(f.store)).toThrowError('未覆盖原数据')
    expect(f.store.getSetting(TASK_ACTIONS_KEY)).toBe(JSON.stringify(invalid))
  })
  it('refuses a new action when its receipt cannot be persisted, before executing its side effect', async () => {
    const f = fixture(); let invoked = false
    const journal = new TaskActionJournal({ getSetting: key => f.store.getSetting(key), readActionReceipt: (...args) => f.store.readActionReceipt(...args), setSetting: () => { throw new Error('Storage unavailable') } })
    await expect((async () => { journal.open('dsh', 'new-child', 'c'.repeat(64)); invoked = true })()).rejects.toThrowError('Storage unavailable')
    expect(invoked).toBe(false)
  })
})
