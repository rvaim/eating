import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { composeAgentPrompt, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { HarnessHostServices, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'
import { settledTaskState } from './task-lifecycle'
import type { TaskEndState } from './task-lifecycle'

interface Task { taskId: string; contextRef: string; nonce: string; state: 'pending' | TaskEndState }
interface Binding { agentId: string; parentId: string; agentTypeId: string; tasks: Task[] }
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v)
function invalid(message = '独立执行代理的任务引用或配置无效。'): never { throw new PlatformError('EXECUTION_TASK_INVALID', message, 409, 'not-sent') }
/** Capability roles have native identities, not invented communication contexts. */
export class ExecutionControl {
  private readonly file: string
  private bindings: Binding[] = []
  constructor(directory: string, private readonly host: HarnessHostServices) {
    this.file = join(directory, 'execution-bindings.json')
    const value = readRestrictedJson(this.file)
    if (value === null) return
    if (value.schemaVersion !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.bindings) || value.bindings.length > 100) invalid()
    const ids = new Set<string>()
    for (const row of value.bindings) {
      if (!isJsonObject(row) || Object.keys(row).length !== 4 || !uuid(row.agentId) || !uuid(row.parentId) || typeof row.agentTypeId !== 'string' || !row.agentTypeId || !Array.isArray(row.tasks) || row.tasks.length > 32 || ids.has(row.agentId)) invalid()
      for (const task of row.tasks) if (!isJsonObject(task) || Object.keys(task).length !== 4 || !digest(task.taskId) || task.contextRef !== task.taskId || typeof task.nonce !== 'string' || !task.nonce || !['pending', 'completed', 'failed', 'interrupted', 'unknown'].includes(String(task.state))) invalid()
      ids.add(row.agentId)
    }
    this.bindings = value.bindings as unknown as Binding[]
  }
  private save(): void { writeRestrictedJson(this.file, { schemaVersion: 1, bindings: this.bindings as unknown as JsonValue[] }) }
  private reconcile(nonce: string): void {
    let changed = false
    for (const binding of this.bindings) for (const task of binding.tasks) if (task.state === 'pending' && task.nonce !== nonce) {
      this.host.revokeAgentAccess(binding.agentId)
      task.state = settledTaskState('interrupted', this.host.finishTaskActions(binding.agentId, task.taskId)); changed = true
    }
    if (changed) this.save()
  }
  prepare(body: JsonObject, rootId: string | null, nonce: string): JsonObject {
    if (!rootId || body.agentId !== rootId || Object.keys(body).length !== 3 || typeof body.agentTypeId !== 'string' || !digest(body.taskId)) invalid()
    this.reconcile(nonce)
    const owner = this.host.readOwnerConfiguration(), type = owner.agentTypes.find(t => t.id === body.agentTypeId && t.enabled && t.conversationKind === null)
    if (!type) invalid('该独立执行角色未注册或已停用。')
    let binding = this.bindings.find(b => b.parentId === rootId && b.agentTypeId === type.id)
    if (!binding) { if (this.bindings.length >= 100) invalid('执行角色身份索引已满。'); binding = { agentId: randomUUID(), parentId: rootId, agentTypeId: type.id, tasks: [] }; this.bindings.push(binding) }
    if (binding.tasks.some(task => task.state === 'pending')) throw new PlatformError('AGENT_TASK_PENDING', '该执行代理已有任务运行，请查询、追加事项或中断。', 409, 'not-sent')
    if (binding.tasks.some(task => task.taskId === body.taskId)) throw new PlatformError('AGENT_TASK_ALREADY_SUBMITTED', '同一调用已登记，不重复执行。', 409, 'not-sent')
    if (binding.tasks.length >= 32) { const at = binding.tasks.findIndex(task => task.state !== 'unknown'); if (at < 0) invalid('执行任务索引已满，未知结果已保留。'); binding.tasks.splice(at, 1) }
    const task: Task = { taskId: body.taskId, contextRef: body.taskId, nonce, state: 'pending' }
    const preview = composeAgentPrompt(owner, type.id, { 当前时间: new Date().toISOString(), 人格名称: owner.activePersona?.name ?? '', 平台: type.pluginId, 会话类型: 'execution', 会话编号: binding.agentId, 机器人账号: '', 目标编号: '' })
    try {
      const capabilities = this.host.getCapabilityMcpConnections({ agentId: binding.agentId, agentTypeId: type.id }, task.taskId, { continuous: true })
      if (!capabilities.some(connection => connection.id === 'plugin.' + type.pluginId && connection.tools.length)) throw new PlatformError('EXECUTION_CAPABILITY_NOT_READY', '执行角色的能力来源尚未连接或未获当前MCP授权。', 409, 'not-sent')
      binding.tasks.push(task); this.save()
      return { kind: 'execution', agentId: binding.agentId, agentTypeId: type.id, mode: 'reply', label: type.title, systemPrompt: preview.systemPrompt, revision: preview.revision, tools: [], capabilities: capabilities.map(c => ({ ...c, headers: { ...c.headers }, tools: [...c.tools] })) }
    } catch (error) { this.host.revokeAgentAccess(binding.agentId); this.host.finishTaskActions(binding.agentId, task.taskId); throw error }
  }
  owns(body: JsonObject): boolean { return this.bindings.some(b => b.agentId === body.agentId && b.tasks.some(t => t.taskId === body.taskId)) }
  handle(operation: 'actions' | 'finish-task', body: JsonObject, nonce: string): JsonObject {
    const binding = this.bindings.find(b => b.agentId === body.agentId), task = binding?.tasks.at(-1)
    if (!binding || !task || task.taskId !== body.taskId || task.contextRef !== body.contextRef || task.nonce !== nonce || task.state !== 'pending' || Object.keys(body).length !== (operation === 'actions' ? 3 : 4)) invalid()
    if (operation === 'actions') return this.host.readTaskActions(binding.agentId, task.taskId) as unknown as JsonObject
    if (!['completed', 'failed', 'interrupted', 'unknown'].includes(String(body.status))) invalid()
    this.host.revokeAgentAccess(binding.agentId)
    const receipt = this.host.finishTaskActions(binding.agentId, task.taskId)
    task.state = settledTaskState(body.status as TaskEndState, receipt); this.save()
    return { ok: true, status: task.state, actions: receipt.actions as unknown as JsonValue[] }
  }
  list(rootId: string, nonce: string, taskId?: string): JsonObject[] {
    this.reconcile(nonce)
    return this.bindings.filter(b => b.parentId === rootId).flatMap(b => b.tasks.filter(t => taskId === undefined || t.taskId === taskId).map(t => ({ taskId: t.taskId, contextRef: t.contextRef, childId: b.agentId, status: t.state === 'pending' ? 'running' : t.state, summary: '', actions: taskId === undefined ? [] : this.host.readTaskActions(b.agentId, t.taskId).actions as unknown as JsonValue[], kind: 'execution' })))
  }
  pending(): boolean { return this.bindings.some(b => b.tasks.some(t => t.state === 'pending')) }
  close(): void {
    let changed = false
    for (const binding of this.bindings) for (const task of binding.tasks) if (task.state === 'pending') { this.host.revokeAgentAccess(binding.agentId); task.state = settledTaskState('interrupted', this.host.finishTaskActions(binding.agentId, task.taskId)); changed = true }
    if (changed) this.save()
  }
}
