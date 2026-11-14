import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentActionReceipt, AgentTaskActions, JsonValue } from '@eating/plugin-sdk'

export const TASK_ACTIONS_KEY = 'host:agent-task-actions'
const maximumTasks = 256
const maximumActions = 100
const maximumBytes = 8 * 1024 * 1024
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export interface LedgerReference { pluginId: string; scopeKey: string; requestId: string }
export interface TaskActionEntry { sourceId: string; ledger: LedgerReference; receipt: AgentActionReceipt }
export interface TaskActionRecord { harnessId: string; agentId: string; taskId: string; closed: boolean; reviewed: boolean; actions: TaskActionEntry[] }
interface TaskActionDocument { schemaVersion: 1; tasks: TaskActionRecord[] }
interface LedgerResult { state: string; result?: JsonValue; code?: string }
export interface TaskActionStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  readActionReceipt(pluginId: string, scopeKey: string, requestId: string): LedgerResult | null
}
function fail(code = 'TASK_ACTIONS_INVALID', message = '任务动作回执无效，未覆盖原数据。'): never { throw new PlatformError(code, message, 500, 'not-sent') }
const keys = (v: object, names: string[]) => Object.keys(v).sort().join(',') === names.sort().join(',')

/** Only bounded identifiers from action results may enter this journal. */
export function actionMetadata(result: JsonValue | undefined): JsonValue | undefined {
  if (result === null) return null
  if (!isJsonObject(result)) return undefined
  for (const key of ['message_id', 'jobId']) {
    const value = result[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) || text(value, 160)) return { [key]: value! }
  }
  return undefined
}
function validReceipt(value: unknown): value is AgentActionReceipt {
  if (!isJsonObject(value) || Object.keys(value).some(k => !['requestId', 'tool', 'outcome', 'result', 'code'].includes(k))
    || !text(value.requestId, 128) || !text(value.tool, 256) || !['succeeded', 'failed', 'unknown', 'not-sent'].includes(String(value.outcome))
    || value.code !== undefined && !text(value.code, 100)) return false
  return value.result === undefined || JSON.stringify(actionMetadata(value.result)) === JSON.stringify(value.result)
}
export function validateTaskActions(value: unknown): TaskActionDocument {
  if (!isJsonObject(value) || !keys(value, ['schemaVersion', 'tasks']) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)
    || value.tasks.length > maximumTasks || Buffer.byteLength(JSON.stringify(value)) > maximumBytes) return fail()
  const tasks = new Set<string>()
  for (const task of value.tasks) {
    if (!isJsonObject(task) || !keys(task, ['harnessId', 'agentId', 'taskId', 'closed', 'reviewed', 'actions']) || !text(task.harnessId, 64) || !text(task.agentId, 160)
      || !digest(task.taskId) || typeof task.closed !== 'boolean' || typeof task.reviewed !== 'boolean' || task.reviewed && !task.closed || !Array.isArray(task.actions) || task.actions.length > maximumActions) return fail()
    const key = [task.harnessId, task.agentId, task.taskId].join(':')
    if (tasks.has(key)) return fail(); tasks.add(key)
    const actions = new Set<string>()
    for (const action of task.actions) {
      if (!isJsonObject(action) || !keys(action, ['sourceId', 'ledger', 'receipt']) || !text(action.sourceId, 256) || !isJsonObject(action.ledger)
        || !keys(action.ledger, ['pluginId', 'scopeKey', 'requestId']) || !text(action.ledger.pluginId, 256) || typeof action.ledger.scopeKey !== 'string'
        || action.ledger.scopeKey.length > 400 || !text(action.ledger.requestId, 128) || !validReceipt(action.receipt)) return fail()
      const id = action.sourceId + ':' + action.receipt.requestId
      if (actions.has(id)) return fail(); actions.add(id)
    }
  }
  return structuredClone(value) as unknown as TaskActionDocument
}

/** Durable task-to-ledger association. Contains no prompts, parameters, credentials or media. */
export class TaskActionJournal {
  private document: TaskActionDocument
  constructor(private readonly store: TaskActionStore) {
    const saved = store.getSetting(TASK_ACTIONS_KEY)
    let value: unknown = { schemaVersion: 1, tasks: [] }
    if (saved !== null) { try { value = JSON.parse(saved) } catch { fail() } }
    this.document = validateTaskActions(value)
  }
  private save(next: TaskActionDocument): void {
    validateTaskActions(next)
    this.store.setSetting(TASK_ACTIONS_KEY, JSON.stringify(next))
    this.document = next
  }
  open(harnessId: string, agentId: string, taskId: string): void {
    if (!text(harnessId, 64) || !text(agentId, 160) || !digest(taskId)) return fail()
    const existing = this.document.tasks.find(t => t.harnessId === harnessId && t.agentId === agentId && t.taskId === taskId)
    if (existing) {
      if (existing.closed && existing.actions.length) fail('AGENT_TASK_ALREADY_RECORDED', '原任务已有动作记录，不能重新执行。')
      // Preparation can fail before any connection is handed to an Agent.
      // The controller owns accepted task IDs; an empty preparation has no side effect.
      if (existing.closed) this.save({ schemaVersion: 1, tasks: this.document.tasks.map(task => task === existing ? { ...task, closed: false } : task) })
      return
    }
    const next = structuredClone(this.document)
    if (next.tasks.length >= maximumTasks) {
      const index = next.tasks.findIndex(t => t.closed && (t.reviewed || t.actions.every(a => a.receipt.outcome !== 'unknown')))
      if (index < 0) fail('TASK_ACTIONS_CAPACITY', '待核对任务达到容量上限，未开始新任务。')
      next.tasks.splice(index, 1)
    }
    next.tasks.push({ harnessId, agentId, taskId, closed: false, reviewed: false, actions: [] }); this.save(next)
  }
  begin(harnessId: string, agentId: string, taskId: string, sourceId: string, ledger: LedgerReference, receipt: AgentActionReceipt): void {
    const next = structuredClone(this.document), task = next.tasks.find(t => t.harnessId === harnessId && t.agentId === agentId && t.taskId === taskId)
    if (!task || task.closed) return fail('AGENT_TASK_CLOSED', '任务已结束，未执行动作。')
    const previous = task.actions.find(a => a.sourceId === sourceId && a.receipt.requestId === receipt.requestId)
    if (previous) {
      if (previous.receipt.tool !== receipt.tool || JSON.stringify(previous.ledger) !== JSON.stringify(ledger)) fail('IDEMPOTENCY_CONFLICT', '同一请求编号已绑定其他动作。')
      return
    }
    if (task.actions.length >= maximumActions) fail('TASK_ACTIONS_CAPACITY', '本任务动作回执达到容量上限，未执行新动作。')
    task.actions.push({ sourceId, ledger: { ...ledger }, receipt: { requestId: receipt.requestId, tool: receipt.tool, outcome: 'unknown', code: 'ACTION_IN_PROGRESS' } })
    this.save(next)
  }
  finish(harnessId: string, agentId: string, taskId: string, sourceId: string, receipt: AgentActionReceipt): void {
    const next = structuredClone(this.document), task = next.tasks.find(t => t.harnessId === harnessId && t.agentId === agentId && t.taskId === taskId)
    const action = task?.actions.find(a => a.sourceId === sourceId && a.receipt.requestId === receipt.requestId)
    if (!action || action.receipt.tool !== receipt.tool) return fail()
    // A rejected attempt to reuse a request ID cannot overwrite its original outcome.
    if (receipt.code === 'IDEMPOTENCY_CONFLICT') return
    const metadata = actionMetadata(receipt.result)
    action.receipt = { ...receipt, ...(metadata !== undefined ? { result: metadata } : {}) }
    if (metadata === undefined) delete (action.receipt as { result?: JsonValue }).result
    const stored = this.store.readActionReceipt(action.ledger.pluginId, action.ledger.scopeKey, action.ledger.requestId)
    if (stored && ['succeeded', 'failed'].includes(stored.state)) {
      const result = actionMetadata(stored.result)
      action.receipt = { requestId: receipt.requestId, tool: receipt.tool, outcome: stored.state as 'succeeded' | 'failed', ...(stored.code ? { code: stored.code } : {}), ...(result !== undefined ? { result } : {}) }
    }
    this.save(next)
  }
  read(harnessId: string, agentId: string, taskId: string, close = false, reviewed = false): AgentTaskActions {
    const original = this.document.tasks.find(t => t.harnessId === harnessId && t.agentId === agentId && t.taskId === taskId)
    if (!original) return { available: false, closed: false, actions: [] }
    const task = structuredClone(original)
    if (close) task.closed = true
    if (reviewed && task.closed) task.reviewed = true
    for (const action of task.actions) {
      if (action.receipt.outcome !== 'unknown') continue
      const stored = this.store.readActionReceipt(action.ledger.pluginId, action.ledger.scopeKey, action.ledger.requestId)
      if (!stored) continue
      if (stored.state === 'unknown' && stored.code) action.receipt = { ...action.receipt, code: stored.code }
      if (!['succeeded', 'failed'].includes(stored.state)) continue
      const result = actionMetadata(stored.result)
      action.receipt = { requestId: action.receipt.requestId, tool: action.receipt.tool, outcome: stored.state as 'succeeded' | 'failed', ...(stored.code ? { code: stored.code } : {}), ...(result !== undefined ? { result } : {}) }
    }
    if (JSON.stringify(task) !== JSON.stringify(original)) this.save({ schemaVersion: 1, tasks: this.document.tasks.map(row => row === original ? task : row) })
    return { available: true, closed: task.closed, actions: structuredClone(task.actions.map(a => a.receipt)) }
  }
}
