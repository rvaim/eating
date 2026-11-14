import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { composeAgentPrompt, groupHarnessEvents, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, HarnessDeliveryBatch, HarnessEvent, HarnessHostServices, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'
import type { DshAutonomy } from './autonomy'
import type { ProactiveTarget } from '@eating/plugin-sdk'
import { agentInstanceLabel } from './agent-label'
import { AGENT_TASK_LIFETIME_MS, settledTaskState } from './task-lifecycle'
import type { TaskEndState } from './task-lifecycle'

interface ProactiveTask { taskId: string; cycleId: string; contextRef: string; nonce: string; state: 'pending' | TaskEndState | 'reviewed' }
interface ProactiveBinding { key: string; parentId: string; agentId: string; target: ProactiveTarget; task: ProactiveTask; taskRefs: ProactiveTask[] }

interface AgentTaskReference {
  readonly contextRef: string
  readonly taskId: string
  readonly nonce: string
  readonly state: 'pending' | TaskEndState
}

export interface AgentBinding {
  readonly key: string
  readonly scope: AgentInvocationScope
  readonly parentId: string
  readonly configurationRevision: number
  readonly task?: AgentTaskReference
  readonly taskRefs: readonly AgentTaskReference[]
}
export interface DeliveryScope {
  readonly pluginId: string
  readonly platform: string
  readonly instanceId: string
  readonly accountId: string
  readonly conversationId: string
  readonly kind: 'private' | 'group'
  readonly targetId: string
  readonly agentTypeId: string | null
}
export interface RoutingError { readonly code: string; readonly message: string }
export type DeliveryBinding = { readonly contextRef: string; readonly scope: DeliveryScope } & (
  { readonly binding: AgentBinding; readonly error?: never } | { readonly binding: null; readonly error: RoutingError }
)
const MAX_TASK_REFERENCES = 32
const MAX_BINDINGS = 100
const UUID = /^[a-f0-9-]{36}$/i
const DIGEST = /^[a-f0-9]{64}$/
const opaque = (value: unknown, maximum = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
function fail(code: string, message: string): never { throw new PlatformError(code, message, 409, 'not-sent') }
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => !['__proto__', 'constructor', 'prototype'].includes(key) && (required.includes(key) || optional.includes(key)))
}
function validRestoreEvent(value: unknown): value is HarnessEvent {
  return isJsonObject(value) && exactRecord(value, ['protocolVersion', 'eventId', 'pluginId', 'instanceId', 'platform', 'accountId', 'conversationId', 'senderId', 'targetId', 'receivedAt', 'source', 'content', 'text'], ['messageId', 'resourceIds'])
    && value.protocolVersion === 1 && ['eventId', 'pluginId', 'instanceId', 'platform', 'accountId', 'conversationId', 'senderId'].every(key => opaque(value[key]))
    && opaque(value.targetId, 200) && (value.messageId === undefined || opaque(value.messageId, 200)) && typeof value.text === 'string'
    && typeof value.receivedAt === 'string' && Number.isFinite(Date.parse(value.receivedAt))
    && exactRecord(value.source, ['trust', 'kind'], ['senderRole']) && value.source.trust === 'external' && typeof value.source.kind === 'string' && ['private', 'group'].includes(value.source.kind)
    && (value.source.senderRole === undefined || typeof value.source.senderRole === 'string' && ['owner', 'administrator', 'user'].includes(value.source.senderRole))
    && (value.resourceIds === undefined || Array.isArray(value.resourceIds) && value.resourceIds.length <= 256 && value.resourceIds.every(resource => opaque(resource, 2048)))
}

type ConversationIdentity = Pick<AgentInvocationScope, 'pluginId' | 'instanceId' | 'accountId' | 'agentTypeId' | 'kind' | 'targetId'>
function conversationIdentity(parentId: string, scope: ConversationIdentity): string {
  return JSON.stringify([parentId, scope.pluginId, scope.instanceId, scope.accountId, scope.agentTypeId, scope.kind, scope.targetId])
}
export function conversationContextRef(batchId: string, firstEvent: HarnessEvent, singleGroup: boolean): string {
  return singleGroup ? batchId : createHash('sha256').update(JSON.stringify([batchId, firstEvent.pluginId, firstEvent.instanceId, firstEvent.accountId, firstEvent.conversationId, firstEvent.source.kind, firstEvent.targetId])).digest('hex')
}

/** Body-free trusted bindings and a runtime-only, loopback management capability. */
export class DshAgentControl {
  private readonly file: string
  private readonly proactiveFile: string
  private proactiveBindings: ProactiveBinding[] = []
  private proactivePersistenceFailed = false
  private activity: DshAutonomy | null = null
  private rootId: () => string | null = () => null
  private runtimeReady: () => boolean = () => false
  private contactPolicySummary: (() => JsonObject) | null = null
  private contactTurn: { id: string; turn: number; autonomyCycleId: string | null } | null = null
  private lastContactTurn = 0
  private deliveryState: { sequence: number; phase: 'idle' | 'busy'; observedAt: number } | null = null
  private recoveryTimer: ReturnType<typeof setInterval> | undefined
  private recoveryError: string | null = null
  private contactTimeoutMs: () => number = () => AGENT_TASK_LIFETIME_MS
  private readonly contactTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private bindings: AgentBinding[] = []
  private server: Server | null = null
  private secret = ''
  private nonce = ''
  private readonly activeContext = new Map<string, string>()
  private readonly contextScopes = new Map<string, AgentInvocationScope>()
  private readonly batches = new Map<string, HarnessDeliveryBatch>()
  private readonly taskScopes = new Map<string, AgentInvocationScope>()
  private readonly taskModes = new Map<string, 'reply' | 'verify'>()
  private readonly autonomousTasks = new Set<string>()
  private retireDeliveries: (batchIds: readonly string[]) => void = () => {}
  private memoryBatch: HarnessDeliveryBatch | null = null
  private readonly memoryTurns = new Map<string, string>()
  private readonly memoryTurnBatches = new Map<string, string>()
  private stopping = false
  private readonly active = new Set<AbortController>()
  private readonly capabilityAgents = new Set<string>()
  url = ''

  constructor(directory: string, private readonly host: HarnessHostServices) {
    if (typeof host.getCapabilityMcpConnections !== 'function' || typeof host.getMcpConnection !== 'function' || typeof host.readTaskActions !== 'function' || typeof host.finishTaskActions !== 'function' || typeof host.revokeAgentAccess !== 'function' || typeof host.extendAgentScope !== 'function' || typeof host.readDeliverySettings !== 'function') fail('HARNESS_SERVICES_INVALID', 'Host 未提供当前必需的子代理权限与持久任务回执接口。')
    this.file = join(directory, 'agent-bindings.json')
    this.proactiveFile = join(directory, 'proactive-bindings.json')
    try { if (statSync(this.proactiveFile).size > 256 * 1024) fail('PROACTIVE_BINDINGS_INVALID', '主动联系绑定文件过大。') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const proactive = readRestrictedJson(this.proactiveFile)
    if (proactive) {
      if (proactive.schemaVersion !== 1 || Object.keys(proactive).length !== 2 || !Array.isArray(proactive.bindings) || proactive.bindings.length > 100 || Buffer.byteLength(JSON.stringify(proactive)) > 256 * 1024) fail('PROACTIVE_BINDINGS_INVALID', '主动联系绑定文件无效，未覆盖。')
      const seen = new Set<string>()
      for (const row of proactive.bindings) {
        if (!isJsonObject(row) || Object.keys(row).length !== 6 || typeof row.key !== 'string' || !DIGEST.test(row.key) || !opaque(row.agentId) || !UUID.test(row.agentId) || !opaque(row.parentId) || !UUID.test(row.parentId) || !isJsonObject(row.target) || !isJsonObject(row.task) || seen.has(row.agentId)) fail('PROACTIVE_BINDINGS_INVALID', '主动联系绑定无效。')
        const task = row.task
        if (!['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId'].every(key => opaque((row.target as JsonObject)[key])) || !Array.isArray(row.target.toolNames) || row.target.toolNames.some(name => !opaque(name)) || typeof task.taskId !== 'string' || !DIGEST.test(task.taskId) || typeof task.contextRef !== 'string' || !DIGEST.test(task.contextRef) || !opaque(task.cycleId) || !opaque(task.nonce) || !['pending', 'completed', 'failed', 'interrupted', 'unknown', 'reviewed'].includes(String(task.state))) fail('PROACTIVE_BINDINGS_INVALID', '主动联系任务无效。')
        if (!Array.isArray(row.taskRefs) || row.taskRefs.length > MAX_TASK_REFERENCES || row.taskRefs.some(ref => !isJsonObject(ref) || Object.keys(ref).length !== 5 || typeof ref.taskId !== 'string' || !DIGEST.test(ref.taskId) || typeof ref.contextRef !== 'string' || !DIGEST.test(ref.contextRef) || !opaque(ref.cycleId) || !opaque(ref.nonce) || !['pending', 'completed', 'failed', 'interrupted', 'unknown', 'reviewed'].includes(String(ref.state))) || !row.taskRefs.some(ref => isJsonObject(ref) && ref.taskId === task.taskId && ref.state === task.state)) fail('PROACTIVE_BINDINGS_INVALID', '主动联系调用索引无效。')
        seen.add(row.agentId)
      }
      this.proactiveBindings = structuredClone(proactive.bindings) as unknown as ProactiveBinding[]
    }
    try { if (statSync(this.file).size > 1024 * 1024) fail('AGENT_BINDINGS_INVALID', '子代理绑定文件过大。') }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const stored = readRestrictedJson(this.file)
    if (stored) {
      if (stored.schemaVersion !== 2 || !Array.isArray(stored.bindings) || stored.bindings.length > MAX_BINDINGS) fail('AGENT_BINDINGS_INVALID', '子代理绑定文件无效。')
      const seen = new Set<string>()
      this.bindings = stored.bindings.map(entry => {
        if (!isJsonObject(entry) || !opaque(entry.key) || !opaque(entry.parentId) || !UUID.test(entry.parentId) || !Number.isSafeInteger(entry.configurationRevision) || !isJsonObject(entry.scope)) fail('AGENT_BINDINGS_INVALID', '子代理绑定文件无效。')
        const scope = entry.scope
        for (const name of ['agentId', 'agentTypeId', 'pluginId', 'instanceId', 'accountId', 'conversationId', 'targetId']) if (!opaque(scope[name])) fail('AGENT_BINDINGS_INVALID', '子代理绑定范围无效。')
        if (!UUID.test(String(scope.agentId)) || !['private', 'group'].includes(String(scope.kind)) || seen.has(String(scope.agentId)) || !Array.isArray(scope.messageIds) || !Array.isArray(scope.resourceIds) || scope.messageIds.length > 256 || scope.resourceIds.length > 256 || scope.messageIds.some(value => !opaque(value)) || scope.resourceIds.some(value => typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u001f]/.test(value))) fail('AGENT_BINDINGS_INVALID', '子代理绑定范围无效。')
        seen.add(String(scope.agentId))
        const validTask = (task: unknown): boolean => isJsonObject(task) && DIGEST.test(String(task.contextRef)) && opaque(task.nonce) && ['pending', 'completed', 'failed', 'interrupted', 'unknown'].includes(String(task.state)) && typeof task.taskId === 'string' && DIGEST.test(task.taskId)
        if (entry.task !== undefined && !validTask(entry.task) || !Array.isArray(entry.taskRefs) || entry.taskRefs.length > MAX_TASK_REFERENCES || entry.taskRefs.some(task => !validTask(task))) fail('AGENT_BINDINGS_INVALID', '子代理任务状态无效。')
        return structuredClone(entry) as unknown as AgentBinding
      })
    }
  }

  setAutonomy(activity: DshAutonomy, rootId: () => string | null, runtimeReady: () => boolean, contactPolicySummary?: () => JsonObject, contactTimeoutMs?: () => number): void {
    this.activity = activity; this.rootId = rootId; this.runtimeReady = runtimeReady; this.contactPolicySummary = contactPolicySummary ?? null; this.contactTimeoutMs = contactTimeoutMs ?? (() => AGENT_TASK_LIFETIME_MS)
  }
  proactiveStatus(): JsonObject[] {
    this.reconcileProactive()
    return this.proactiveBindings.map(binding => {
      const tasks = binding.taskRefs.map(task => ({ task, receipts: this.host.readTaskActions(binding.agentId, task.taskId) }))
      const { task, receipts } = tasks.find(row => row.task.state === 'unknown' && row.receipts.actions.some(action => action.outcome === 'unknown')) ?? tasks.find(row => row.task.taskId === binding.task.taskId)!
      return { agentId: binding.agentId, targetId: binding.target.id, label: binding.target.label, taskId: task.taskId, state: task.state,
        receiptsAvailable: receipts.available, knownActions: receipts.actions.filter(action => action.outcome !== 'unknown').length,
        unknownActions: receipts.actions.filter(action => action.outcome === 'unknown').length,
        reviewRequired: task.state === 'unknown' && receipts.actions.some(action => action.outcome === 'unknown') }
    })
  }
  private reconcileProactive(): void {
    let changed = false
    for (const binding of this.proactiveBindings) {
      for (const task of binding.taskRefs) {
        if (task.state !== 'unknown') continue
        const receipts = this.host.readTaskActions(binding.agentId, task.taskId)
        if (settledTaskState('interrupted', receipts) !== 'interrupted') continue
        task.state = 'interrupted'; if (binding.task.taskId === task.taskId) binding.task.state = 'interrupted'; changed = true
      }
    }
    if (changed) this.saveProactive()
  }
  private reconcileOrdinary(): void {
    let changed = false
    const bindings = this.bindings.map(binding => {
      const refs = binding.taskRefs.map(task => {
        if (!['pending', 'unknown'].includes(task.state)) return task
        const receipts = this.host.readTaskActions(binding.scope.agentId, task.taskId)
        if (settledTaskState('interrupted', receipts) !== 'interrupted') return task
        changed = true; return { ...task, state: 'interrupted' as const }
      })
      return { ...binding, taskRefs: refs, ...(binding.task ? { task: refs.find(task => task.taskId === binding.task!.taskId) ?? binding.task } : {}) }
    })
    if (changed) this.save(bindings)
  }
  private saveProactive(): void {
    const value = { schemaVersion: 1, bindings: this.proactiveBindings as unknown as JsonValue[] }
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail('PROACTIVE_BINDINGS_CAPACITY', '主动联系索引达到容量上限。')
    try { writeRestrictedJson(this.proactiveFile, value) }
    catch (error) { this.proactivePersistenceFailed = true; for (const binding of this.proactiveBindings) this.revokeContact(binding); throw error }
  }
  private setProactiveState(binding: ProactiveBinding, state: ProactiveTask['state']): void { binding.task.state = state; binding.taskRefs = binding.taskRefs.map(ref => ref.taskId === binding.task.taskId ? { ...ref, state } : ref) }
  private revokeContact(binding: ProactiveBinding): boolean {
    if (binding.task.state !== 'pending') return false
    this.host.revokeAgentAccess(binding.agentId)
    this.taskScopes.delete(binding.task.taskId); this.taskModes.delete(binding.task.taskId); this.autonomousTasks.delete(binding.task.taskId)
    const timer = this.contactTimers.get(binding.agentId)
    if (timer) clearTimeout(timer)
    this.contactTimers.delete(binding.agentId)
    const receipts = this.host.finishTaskActions(binding.agentId, binding.task.taskId)
    this.setProactiveState(binding, settledTaskState('interrupted', receipts)); return true
  }
  revokeProactive(cycleId?: string): void {
    let changed = false
    for (const binding of this.proactiveBindings) if (!cycleId || binding.task.cycleId === cycleId) changed = this.revokeContact(binding) || changed
    if (changed) this.saveProactive()
  }
  revokeAutonomousContacts(): void {
    let changed = false
    for (const binding of this.proactiveBindings) if (this.autonomousTasks.has(binding.task.taskId)) changed = this.revokeContact(binding) || changed
    if (changed) this.saveProactive()
  }
  private beginContactTurn(body: JsonObject): JsonObject {
    if (!this.runtimeReady() || body.agentId !== this.rootId() || Object.keys(body).length !== 3 || !Number.isSafeInteger(body.turn) || Number(body.turn) < 1 || body.autonomyCycleId !== null && !opaque(body.autonomyCycleId)) fail('CONTACT_TURN_INVALID', '联系任务缺少真实主 Agent 当前轮次。')
    if (body.autonomyCycleId !== null && !this.activity?.validCycle(this.nonce, String(body.autonomyCycleId))) fail('AUTONOMY_CYCLE_REVOKED', '当前活动机会已撤销。')
    const existing = this.contactTurn
    if (existing && existing.turn === body.turn) {
      if (existing.autonomyCycleId !== body.autonomyCycleId) fail('CONTACT_TURN_INVALID', '主 Agent 当前轮次来源已变化。')
      return { id: existing.id }
    }
    if (Number(body.turn) <= this.lastContactTurn) fail('CONTACT_TURN_EXPIRED', '主 Agent 旧轮次不能重新取得联系许可。')
    this.contactTurn = { id: randomUUID(), turn: Number(body.turn), autonomyCycleId: body.autonomyCycleId as string | null }
    this.lastContactTurn = Number(body.turn)
    return { id: this.contactTurn.id }
  }
  private validContactTurn(turn: NonNullable<DshAgentControl['contactTurn']>): boolean {
    return !this.stopping && this.runtimeReady() && this.contactTurn === turn && (!turn.autonomyCycleId || this.activity?.validCycle(this.nonce, turn.autonomyCycleId) === true)
  }
  acknowledgeProactive(agentId: string, taskId: string): void {
    const binding = this.proactiveBindings.find(binding => binding.agentId === agentId && binding.taskRefs.some(task => task.taskId === taskId))
    const task = binding?.taskRefs.find(task => task.taskId === taskId)
    if (!binding || !task || !['pending', 'unknown'].includes(task.state) || this.contactTurn?.id === task.cycleId) fail('PROACTIVE_TASK_CONFLICT', '请在对应轮次结束后核对该任务。')
    if (task.state === 'pending') this.revokeContact(binding)
    this.host.finishTaskActions(agentId, taskId, true)
    task.state = 'reviewed'; if (binding.task.taskId === taskId) binding.task.state = 'reviewed'; this.saveProactive()
  }
  private async prepareProactive(body: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const activity = this.activity, rootId = this.rootId()
    if (this.proactivePersistenceFailed) fail('PROACTIVE_PERSISTENCE_FAILED', '主动联系状态保存失败，已停止新任务。')
    if (!activity || !exactRecord(body, ['agentId', 'targetId', 'cycleId', 'taskId', 'mode']) || body.agentId !== rootId || typeof body.targetId !== 'string' || typeof body.cycleId !== 'string' || typeof body.taskId !== 'string' || !DIGEST.test(body.taskId) || body.mode !== 'reply' && body.mode !== 'verify' || !this.host.prepareProactiveScope) fail('CONTACT_TURN_INVALID', '联系任务缺少真实主 Agent 轮次、目标绑定或有效模式。')
    const turn = this.contactTurn
    if (!turn || turn.id !== body.cycleId || !this.validContactTurn(turn)) fail('CONTACT_TURN_EXPIRED', '主 Agent 当前轮次已结束或撤销。')
    const policyRevision = this.contactPolicySummary?.().revision
    const target = await activity.prepareContactTarget(body.targetId)
    signal.throwIfAborted()
    if (!this.validContactTurn(turn) || this.contactPolicySummary?.().revision !== policyRevision) fail('CONTACT_TURN_EXPIRED', '读取联系人时轮次或授权已变化。')
    activity.assertContactAvailable()
    const key = createHash('sha256').update(JSON.stringify([rootId, target.pluginId, target.instanceId, target.accountId, target.agentTypeId, target.targetId])).digest('hex')
    const owner = this.host.readOwnerConfiguration(), type = owner.agentTypes.find(type => type.id === target.agentTypeId && type.pluginId === target.pluginId && type.enabled)
    if (!type || target.toolNames.some(name => !type.enabledTools.includes(name))) fail('AUTONOMY_TARGET_DENIED', '当前类型或工具已撤权。')
    const identity = { ...target, kind: type.conversationKind }
    const related = this.proactiveBindings.filter(binding => binding.key === key)
    if (related.some(binding => binding.taskRefs.some(ref => ref.taskId === body.taskId) || binding.task.state === 'pending')) fail('PROACTIVE_TASK_UNKNOWN', '原调用已提交或已有任务运行，不重放旧任务；新的独立任务可在原任务结束后开始。')
    if (related.flatMap(binding => binding.taskRefs).filter(ref => ref.cycleId === body.cycleId).length >= MAX_TASK_REFERENCES) fail('PROACTIVE_TASK_CAPACITY', '本轮对此目标的委派次数达到上限。')
    const agentId = this.canonicalAgentId(rootId!, identity)
    this.assertAgentIdle(agentId)
    const previous = related.find(binding => binding.agentId === agentId)
    if (!previous && this.proactiveBindings.length >= 100) fail('PROACTIVE_BINDINGS_CAPACITY', '主动会话绑定数量达到上限。')
    const scope = this.host.prepareProactiveScope(target.pluginId, { ...target, agentId })
    if (scope.agentId !== agentId || conversationIdentity(rootId!, scope) !== conversationIdentity(rootId!, identity)) fail('AGENT_SCOPE_INVALID', '主动联系范围与真实账号、类型或目标不匹配。')
    const readOnly = body.mode === 'verify'
    const invocationScope: AgentInvocationScope = readOnly ? { ...scope, readOnly: true } : scope
    const contextRef = createHash('sha256').update('eating-contact\0' + body.cycleId).digest('hex')
    const deadline = Date.now() + Math.max(1000, Math.min(AGENT_TASK_LIFETIME_MS, this.contactTimeoutMs()))
    const task: ProactiveTask = { taskId: body.taskId, cycleId: body.cycleId, contextRef, nonce: this.nonce, state: 'pending' }
    let mcp, capabilities
    try {
      mcp = this.host.getMcpConnection(target.pluginId, invocationScope, { toolNames: target.toolNames, ...(readOnly ? { readOnly: true } : {}), active: () => task.state === 'pending' && task.nonce === this.nonce && !this.stopping && this.runtimeReady() && (!turn.autonomyCycleId || activity.validCycle(this.nonce, turn.autonomyCycleId)) && Date.now() < deadline && this.contactPolicySummary?.().revision === policyRevision && activity.contactTargetStillAllowed(target) }, task.taskId)
      capabilities = this.host.getCapabilityMcpConnections({ agentId, agentTypeId: type.id, source: invocationScope, ...(readOnly ? { readOnly: true } : {}) }, task.taskId)
      signal.throwIfAborted()
      const retained = [...(previous?.taskRefs ?? [])]
      if (retained.length >= MAX_TASK_REFERENCES) {
        const removable = retained.findIndex(ref => ['completed', 'failed', 'interrupted', 'reviewed'].includes(ref.state))
        if (removable < 0) fail('PROACTIVE_TASK_CAPACITY', '旧未知任务引用达到容量上限，未删除记录或开始新任务。')
        retained.splice(removable, 1)
      }
      const binding: ProactiveBinding = { key, parentId: rootId!, agentId, target, task, taskRefs: [...retained, task] }
      activity.countContact()
      this.proactiveBindings = previous ? this.proactiveBindings.map(row => row === previous ? binding : row) : [...this.proactiveBindings, binding]
      this.saveProactive()
      this.taskScopes.set(task.taskId, invocationScope)
      this.taskModes.set(task.taskId, body.mode as 'reply' | 'verify')
      if (turn.autonomyCycleId) this.autonomousTasks.add(task.taskId)
      const timer = setTimeout(() => {
        this.contactTimers.delete(agentId)
        try {
          if (binding.task.state === 'pending' && this.revokeContact(binding)) this.saveProactive()
        } catch {
          this.proactivePersistenceFailed = true
          if (binding.task.state === 'pending') this.setProactiveState(binding, 'unknown')
          console.error('联系任务回执保存失败，已撤销许可并停止接受新任务。')
        }
      }, Math.max(1, deadline - Date.now()))
      timer.unref(); this.contactTimers.set(agentId, timer)
    } catch (error) { this.host.revokeAgentAccess(agentId); this.host.finishTaskActions(agentId, task.taskId); throw error }
    const preview = composeAgentPrompt(owner, type.id, { 当前时间: new Date().toISOString(), 人格名称: owner.activePersona?.name ?? '', 平台: scope.pluginId, 机器人账号: scope.accountId, 会话编号: scope.conversationId, 会话类型: scope.kind, 目标编号: scope.targetId })
    return { agentId, agentTypeId: type.id, mode: body.mode, autonomyCycleId: turn.autonomyCycleId, systemPrompt: preview.systemPrompt, revision: preview.revision, contextRef, label: target.label, scope: { pluginId: scope.pluginId, accountId: scope.accountId, targetId: scope.targetId, conversationId: scope.conversationId, kind: scope.kind }, tools: [...mcp.toolNames], mcp: { url: mcp.url, headers: { ...mcp.headers } }, capabilities: capabilities.map(connection => ({ ...connection, tools: [...connection.tools], headers: { ...connection.headers } })) }
  }

  list(): readonly AgentBinding[] { return this.bindings }
  setDeliveryRetirement(retire: (batchIds: readonly string[]) => void): void { this.retireDeliveries = retire }
  hasPendingTasks(): boolean { return this.bindings.some(binding => binding.task?.state === 'pending') || this.proactiveBindings.some(binding => binding.task.state === 'pending') }
  deliveryReady(): boolean { return !this.stopping && this.deliveryState?.phase === 'idle' && Date.now() - this.deliveryState.observedAt < 3000 }
  get token(): string { return this.secret }
  private save(bindings: AgentBinding[]): void {
    const persisted = bindings.map(binding => ({ ...binding, scope: { ...binding.scope, messageIds: binding.scope.messageIds.slice(-256), resourceIds: binding.scope.resourceIds.slice(-256) } }))
    const document = { schemaVersion: 2, bindings: persisted as unknown as JsonValue[] }
    if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) fail('AGENT_BINDINGS_CAPACITY', '子代理绑定索引达到容量上限，未登记新任务。')
    writeRestrictedJson(this.file, document)
    this.bindings = persisted
  }
  private replace(binding: AgentBinding): void { this.save(this.bindings.map(entry => entry.scope.agentId === binding.scope.agentId ? binding : entry)) }

  private canonicalAgentId(parentId: string, scope: ConversationIdentity, bindings: readonly AgentBinding[] = this.bindings): string {
    const identity = conversationIdentity(parentId, scope)
    const ordinary = bindings.find(binding => conversationIdentity(binding.parentId, binding.scope) === identity)
    if (ordinary) return ordinary.scope.agentId
    const types = this.host.readOwnerConfiguration().agentTypes
    return this.proactiveBindings.find(binding => {
      const type = types.find(type => type.id === binding.target.agentTypeId && type.pluginId === binding.target.pluginId)
      const ordinary = bindings.find(entry => entry.scope.agentId === binding.agentId)
      return type?.conversationKind === scope.kind && (!ordinary || ordinary.scope.kind === scope.kind) && conversationIdentity(binding.parentId, { ...binding.target, kind: type.conversationKind }) === identity
    })?.agentId ?? randomUUID()
  }
  private assertAgentIdle(agentId: string): void {
    if (this.bindings.some(binding => binding.scope.agentId === agentId && binding.task?.state === 'pending') || this.proactiveBindings.some(binding => binding.agentId === agentId && binding.task.state === 'pending')) fail('AGENT_TASK_PENDING', '已有子代理任务仍在执行，请等待原任务结束，未登记新任务。')
  }

  bind(batch: HarnessDeliveryBatch, parentId: string): AgentBinding {
    if (!opaque(batch.conversationId) || groupHarnessEvents(batch.events).length !== 1 || batch.events[0]!.conversationId !== batch.conversationId) fail('AGENT_SCOPE_INVALID', '单会话绑定必须提供一个完整且匹配的消息分组。')
    return this.bindBatch(batch, parentId)[0]!.binding
  }

  bindBatch(batch: HarnessDeliveryBatch, parentId: string): readonly { contextRef: string; binding: AgentBinding }[] {
    return this.bindGroups(batch, parentId, false).map(result => {
      if (!result.binding) fail(result.error.code, result.error.message)
      return { contextRef: result.contextRef, binding: result.binding }
    })
  }

  bindDeliveryBatch(batch: HarnessDeliveryBatch, parentId: string): readonly DeliveryBinding[] {
    return this.bindGroups(batch, parentId, true)
  }

  private bindGroups(batch: HarnessDeliveryBatch, parentId: string, partial: boolean): readonly DeliveryBinding[] {
    const groups = groupHarnessEvents(batch.events)
    if (!groups.length || groups.length === 1 && batch.conversationId !== groups[0]![0]!.conversationId || groups.length > 1 && batch.conversationId !== null) fail('AGENT_SCOPE_INVALID', '入站批次会话标识与完整消息分组不匹配。')
    const bindings = [...this.bindings], scopes = new Map<string, AgentInvocationScope>()
    const results = groups.map((events): DeliveryBinding => {
      const first = events[0]!
      const owner = this.host.readOwnerConfiguration()
      const type = owner.agentTypes.find(entry => entry.enabled && entry.pluginId === first.pluginId && entry.conversationKind === first.source.kind)
      const contextRef = conversationContextRef(batch.batchId, first, groups.length === 1)
      const deliveryScope: DeliveryScope = { pluginId: first.pluginId, platform: first.platform, instanceId: first.instanceId, accountId: first.accountId, conversationId: first.conversationId, kind: first.source.kind, targetId: first.targetId!, agentTypeId: type?.id ?? null }
      try {
      if (!type) fail('AGENT_TYPE_UNAVAILABLE', '此消息来源尚未启用对应的子代理类型。')
      const targetId = first.targetId
      if (!opaque(targetId)) fail('AGENT_SCOPE_INVALID', '消息目标标识不可用。')
      const identity = { ...first, agentTypeId: type.id, kind: first.source.kind, targetId }
      const agentId = this.canonicalAgentId(parentId, identity, bindings)
      const previous = bindings.find(binding => binding.scope.agentId === agentId)
      if (!previous && bindings.length >= MAX_BINDINGS) fail('AGENT_CAPACITY_REACHED', '子代理会话数量已达上限，请先核对已有会话。')
      const history = previous?.scope.conversationId === first.conversationId ? previous.scope : undefined
      const scope: AgentInvocationScope = { agentId, agentTypeId: type.id, pluginId: first.pluginId, instanceId: first.instanceId,
        accountId: first.accountId, conversationId: first.conversationId, kind: first.source.kind, targetId,
        messageIds: [...new Set([...(history?.messageIds ?? []), ...events.flatMap(event => event.messageId ? [event.messageId] : [])])],
        resourceIds: [...new Set([...(history?.resourceIds ?? []), ...events.flatMap(event => event.resourceIds ?? [])])] }
      const key = previous?.key ?? createHash('sha256').update(conversationIdentity(parentId, scope)).digest('hex')
      const binding: AgentBinding = { ...previous, key, scope, parentId, taskRefs: previous?.taskRefs ?? [], configurationRevision: owner.revision }
      if (previous) bindings[bindings.indexOf(previous)] = previous.task?.state === 'pending' ? { ...binding, scope: previous.scope } : binding
      else bindings.push(binding)
      scopes.set(contextRef, scope)
      return { contextRef, binding, scope: deliveryScope }
      } catch (error) {
        if (!partial || !(error instanceof PlatformError) || !['AGENT_TYPE_UNAVAILABLE', 'AGENT_SCOPE_INVALID', 'AGENT_CAPACITY_REACHED'].includes(error.code)) throw error
        return { contextRef, binding: null, scope: deliveryScope, error: { code: error.code, message: error.message } }
      }
    })
    this.save(bindings)
    for (const [contextRef, scope] of scopes) { this.activeContext.set(contextRef, scope.agentId); this.contextScopes.set(contextRef, scope) }
    this.memoryBatch = structuredClone(batch)
    this.batches.set(batch.batchId, structuredClone(batch))
    return results
  }

  private restoreDelivery(body: unknown): JsonObject {
    if (!exactRecord(body, ['agentId', 'payload']) || body.agentId !== this.rootId() || !opaque(body.agentId) || !exactRecord(body.payload, ['eating', 'context', 'events'])) fail('RESTORE_DELIVERY_INVALID', '恢复批次必须来自当前主 Agent 并提供完整原始信封。')
    const { eating, context, events } = body.payload
    if (!isJsonObject(eating) || !exactRecord(eating, ['magic', 'protocolVersion', 'nonce', 'sessionId', 'batchId', 'digest']) || eating.magic !== 'eating-harness-delivery' || eating.protocolVersion !== 1 || !opaque(eating.nonce) || eating.sessionId !== body.agentId || typeof eating.batchId !== 'string' || !DIGEST.test(eating.batchId) || typeof eating.digest !== 'string' || !DIGEST.test(eating.digest)) fail('RESTORE_DELIVERY_INVALID', '恢复批次运输标识无效。')
    let expected: JsonObject | null
    try {
      const expectedFile = join(this.file, '..', 'bridge', `expected-${eating.batchId}.json`)
      if (statSync(expectedFile).size > 1024 * 1024) fail('RESTORE_DELIVERY_INVALID', '恢复批次元数据过大。')
      expected = readRestrictedJson(expectedFile)
    } catch { fail('RESTORE_DELIVERY_INVALID', '恢复批次缺少有效的当前持久交接记录。') }
    if (!exactRecord(expected, ['schemaVersion', 'nonce', 'sessionId', 'batchId', 'digest', 'ownerRevision', 'bindings']) || expected.schemaVersion !== 1 || expected.nonce !== this.nonce || expected.sessionId !== body.agentId || expected.batchId !== eating.batchId || expected.digest !== eating.digest) fail('RESTORE_DELIVERY_INVALID', '恢复批次与当前持久交接记录不匹配。')
    if (!exactRecord(context, ['contextRef', 'createdAt', 'reason', 'ownerRevision', 'conversations']) || context.contextRef !== eating.batchId || typeof context.createdAt !== 'string' || !Number.isFinite(Date.parse(context.createdAt)) || context.reason !== 'aggregation-window' || !Number.isSafeInteger(context.ownerRevision) || Number(context.ownerRevision) < 0 || !Array.isArray(context.conversations) || !Array.isArray(events) || !events.length || !events.every(validRestoreEvent)) fail('RESTORE_DELIVERY_INVALID', '恢复批次上下文或消息来源形状无效。')
    const digest = createHash('sha256').update(JSON.stringify({ context, events })).digest('hex')
    if (digest !== expected.digest) fail('RESTORE_DELIVERY_INVALID', '恢复批次正文摘要与原始交接不匹配。')
    const groups = groupHarnessEvents(events), owner = this.host.readOwnerConfiguration(), conversations = context.conversations
    if (conversations.length !== groups.length) fail('RESTORE_DELIVERY_INVALID', '恢复批次上下文与消息分组不匹配。')
    const bindings = groups.map((group, index) => {
      const first = group[0]!, conversation = conversations[index]
      const contextRef = conversationContextRef(eating.batchId as string, first, groups.length === 1)
      const type = owner.agentTypes.find(entry => entry.enabled && entry.pluginId === first.pluginId && entry.conversationKind === first.source.kind)
      if (!type && !(isJsonObject(conversation) && conversation.routingError !== undefined)) fail('AGENT_TYPE_UNAVAILABLE', '恢复批次的消息来源尚未启用对应的子代理类型。')
      if (!isJsonObject(conversation) || !exactRecord(conversation, ['contextRef', 'agentTypeId', 'pluginId', 'platform', 'accountId', 'instanceId', 'conversationId', 'kind', 'targetId', 'createdAt', 'reason', 'ownerRevision'], ['routingError']) || conversation.contextRef !== contextRef || conversation.agentTypeId !== (type?.id ?? null) || conversation.pluginId !== first.pluginId || conversation.instanceId !== first.instanceId || conversation.accountId !== first.accountId || conversation.conversationId !== first.conversationId || conversation.kind !== first.source.kind || conversation.targetId !== first.targetId || group.some(event => event.platform !== conversation.platform) || conversation.createdAt !== context.createdAt || conversation.reason !== context.reason || conversation.ownerRevision !== context.ownerRevision) fail('RESTORE_DELIVERY_INVALID', '恢复批次的分组来源或上下文不匹配。')
      if (conversation.routingError !== undefined) {
        const error = conversation.routingError
        if (!exactRecord(error, ['code', 'message']) || typeof error.message !== 'string' || !error.message || error.message.length > 4000 || error.code !== 'AGENT_TYPE_UNAVAILABLE' && error.code !== 'AGENT_CAPACITY_REACHED' || error.code === 'AGENT_TYPE_UNAVAILABLE' && type || error.code === 'AGENT_CAPACITY_REACHED' && (!type || this.bindings.length < MAX_BINDINGS)) fail('RESTORE_DELIVERY_INVALID', '恢复批次的路由失败原因与当前来源不匹配。')
        return { contextRef, binding: null, routingError: { code: error.code as string, message: error.message } }
      }
      const identity = conversationIdentity(body.agentId as string, { ...first, agentTypeId: type!.id, kind: first.source.kind, targetId: first.targetId! })
      const binding = this.bindings.find(entry => conversationIdentity(entry.parentId, entry.scope) === identity)
      if (!binding) fail('RESTORE_BINDING_UNAVAILABLE', '恢复批次缺少已登记的当前主 Agent 会话绑定，未创建新身份。')
      return { contextRef, binding }
    })
    if (!this.batches.has(String(eating.batchId))) {
      const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: eating.batchId, conversationId: groups.length === 1 ? groups[0]![0]!.conversationId : null, createdAt: context.createdAt, reason: context.reason as HarnessDeliveryBatch['reason'], events }
      if (bindings.every(entry => entry.binding)) this.bindBatch(batch, body.agentId)
      else {
        for (const [index, entry] of bindings.entries()) {
          if (!entry.binding) continue
          const group = groups[index]!, first = group[0]!, previous = entry.binding.scope
          const history = previous.conversationId === first.conversationId ? previous : undefined
          const scope: AgentInvocationScope = { ...previous, conversationId: first.conversationId,
            messageIds: [...new Set([...(history?.messageIds ?? []), ...group.flatMap(event => event.messageId ? [event.messageId] : [])])],
            resourceIds: [...new Set([...(history?.resourceIds ?? []), ...group.flatMap(event => event.resourceIds ?? [])])] }
          this.activeContext.set(entry.contextRef, scope.agentId); this.contextScopes.set(entry.contextRef, scope)
        }
        this.memoryBatch = structuredClone(batch)
        this.batches.set(batch.batchId, structuredClone(batch))
      }
    }
    return { bindings: bindings.map(({ contextRef, binding, routingError }): JsonObject => binding ? { contextRef, agentId: binding.scope.agentId, agentTypeId: binding.scope.agentTypeId, label: agentInstanceLabel(binding.scope, owner.agentTypes.find(type => type.id === binding.scope.agentTypeId)?.pluginName) } : { contextRef, routingError: { ...routingError } }) }
  }

  private async memoryRequest(operation: string, body: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const agentId = String(body.agentId), turnId = body.turnId
    if ((agentId !== this.rootId() && !this.capabilityAgents.has(agentId)) || !opaque(turnId) || !turnId.startsWith(this.nonce + ':' + agentId + ':')) fail('MEMORY_CONTEXT_INVALID', '记忆请求不属于当前主会话。')
    const empty = { text: '', items: [] }
    if (!this.host.memory) return operation === 'start' ? empty : { accepted: false }
    if (operation === 'flush') {
      if (agentId !== this.rootId() || Object.keys(body).length !== 3 || !['compaction', 'session-end'].includes(String(body.reason))) fail('MEMORY_CONTEXT_INVALID', '记忆提取触发不属于当前主会话生命周期。')
      await this.host.memory.flush({ agentId, reason: body.reason as 'compaction' | 'session-end' })
      return { accepted: true }
    }
    if (operation === 'start') {
      if (Object.keys(body).some(key => !['agentId', 'turnId', 'contextRef', 'messages', 'autonomous', 'query'].includes(key))) fail('MEMORY_CONTEXT_INVALID', '记忆请求字段无效。')
      const batch = body.contextRef === undefined ? undefined : this.batches.get(String(body.contextRef))
      if (body.contextRef !== undefined && (agentId !== this.rootId() || !batch || body.contextRef !== batch.batchId || body.messages !== undefined || body.query !== undefined || body.autonomous !== undefined)) fail('MEMORY_CONTEXT_INVALID', '记忆上下文与真实入站批次不匹配。')
      if (!batch && (!Array.isArray(body.messages) || body.messages.length > 100 || body.messages.some(message => !isJsonObject(message) || message.role !== 'user' || typeof message.text !== 'string' || message.text.length > 32768 || typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp))) || body.autonomous !== undefined && typeof body.autonomous !== 'boolean' || body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 4000))) fail('MEMORY_CONTEXT_INVALID', '原生记忆消息无效。')
      this.memoryTurns.set(agentId, turnId)
      if (batch) this.memoryTurnBatches.set(agentId, batch.batchId)
      else this.memoryTurnBatches.delete(agentId)
      const recalled = await this.host.memory.begin({ agentId, agentTypeId: 'main', turnId, ...(batch ? { batch } : { messages: body.messages as unknown as import('@eating/plugin-sdk').MemoryMessage[], autonomous: body.autonomous === true, ...(typeof body.query === 'string' ? { query: body.query } : {}) }) }, signal)
      return { text: recalled.text, items: recalled.items as unknown as JsonValue[], ...(recalled.errors?.length ? { errors: [...recalled.errors] } : {}) }
    }
    if (this.memoryTurns.get(agentId) !== turnId) return { accepted: false }
    if (operation === 'append') {
      const batch = body.contextRef === undefined ? undefined : this.batches.get(String(body.contextRef))
      if (Object.keys(body).length !== 3 || (body.contextRef !== undefined
        ? agentId !== this.rootId() || !batch || body.messages !== undefined
        : !Array.isArray(body.messages) || body.messages.length > 100 || body.messages.some(message => !isJsonObject(message) || message.role !== 'user' || typeof message.text !== 'string' || message.text.length > 32768 || typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp))))) fail('MEMORY_CONTEXT_INVALID', '追加的记忆来源或原生消息无效。')
      const recalled = await this.host.memory.append({ agentId, turnId, ...(batch ? { batch } : { messages: body.messages as unknown as import('@eating/plugin-sdk').MemoryMessage[] }) }, signal)
      return { text: recalled.text, items: recalled.items as unknown as JsonValue[], ...(recalled.errors?.length ? { errors: [...recalled.errors] } : {}) }
    }
    if (operation === 'finish') {
      if (Object.keys(body).length !== 5 || typeof body.assistantText !== 'string' || body.assistantText.length > 32768 || !Array.isArray(body.actions) || body.actions.length > 128 || body.actions.some(action => !isJsonObject(action) || !opaque(action.tool) || !['returned', 'succeeded', 'failed', 'unknown'].includes(String(action.outcome))) || !['completed', 'failed', 'cancelled'].includes(String(body.outcome))) fail('MEMORY_CONTEXT_INVALID', '记忆结果形状无效。')
      this.memoryTurns.delete(agentId)
      if (agentId === this.rootId() && this.memoryBatch?.batchId === this.memoryTurnBatches.get(agentId)) this.memoryBatch = null
      this.memoryTurnBatches.delete(agentId)
      await this.host.memory.finish({ agentId, turnId, assistantText: body.assistantText, actions: body.actions as unknown as import('@eating/plugin-sdk').MemoryAction[], outcome: body.outcome as 'completed' })
      return { accepted: true }
    }
    if (operation === 'end' && Object.keys(body).length === 2) {
      this.memoryTurns.delete(agentId); this.host.memory.end(agentId, turnId)
      if (agentId === this.rootId() && this.memoryBatch?.batchId === this.memoryTurnBatches.get(agentId)) this.memoryBatch = null
      this.memoryTurnBatches.delete(agentId)
      return { accepted: true }
    }
    fail('MEMORY_OPERATION_INVALID', '记忆生命周期操作不存在。')
  }

  async start(nonce: string): Promise<void> {
    if (this.server) return
    this.stopping = false; this.nonce = nonce; this.secret = randomBytes(32).toString('hex'); this.contactTurn = null; this.lastContactTurn = 0; this.deliveryState = null
    this.revokeProactive()
    this.reconcileProactive()
    // A restarted runtime cannot finish an interrupted child from its predecessor.
    // Preserve its identity and replay guards without keeping a permanent pending lock.
    if (this.bindings.some(binding => binding.task?.state === 'pending' || binding.taskRefs.some(task => task.state === 'pending'))) {
      const interrupted = (task: AgentTaskReference, agentId: string): AgentTaskReference => task.state === 'pending' ? { ...task, state: settledTaskState('interrupted', this.host.finishTaskActions(agentId, task.taskId)) } : task
      for (const binding of this.bindings) if (binding.task?.state === 'pending') this.host.revokeAgentAccess(binding.scope.agentId)
      this.save(this.bindings.map(binding => ({ ...binding, ...(binding.task ? { task: interrupted(binding.task, binding.scope.agentId) } : {}), taskRefs: binding.taskRefs.map(task => interrupted(task, binding.scope.agentId)) })))
    }
    this.reconcileOrdinary()
    const server = createServer((request, response) => {
      const controller = new AbortController(); this.active.add(controller)
      const stopRequest = () => { request.destroy(); response.destroy() }
      controller.signal.addEventListener('abort', stopRequest, { once: true })
      const timer = setTimeout(() => controller.abort(), 5000); timer.unref()
      void (async () => {
        const authorization = request.headers.authorization
        const expected = `Bearer ${this.secret}`
        if (this.stopping || request.method !== 'POST' || typeof authorization !== 'string' || authorization.length !== expected.length || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected)) || request.headers['x-eating-runtime'] !== this.nonce) { response.writeHead(403); response.end(); return }
        const chunks: Buffer[] = []; let length = 0
        for await (const chunk of request) { controller.signal.throwIfAborted(); length += chunk.length; if (length > (request.url === '/restore-delivery' ? 101 * 1024 * 1024 : request.url?.startsWith('/memory-') ? 256 * 1024 : 8192)) fail('CONTROL_REQUEST_INVALID', '运行时请求过大。'); chunks.push(Buffer.from(chunk)) }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (request.url === '/restore-delivery') {
          const result = this.restoreDelivery(body)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (!isJsonObject(body) || !opaque(body.agentId)) fail('CONTROL_REQUEST_INVALID', '运行时请求无效。')
        if (request.url === '/tasks') {
          if (body.agentId !== this.rootId() || !exactRecord(body, ['agentId'], ['taskId']) || body.taskId !== undefined && (typeof body.taskId !== 'string' || !DIGEST.test(body.taskId))) fail('AGENT_SCOPE_INVALID', '任务状态只供当前主 Agent 查询。')
          this.reconcileProactive()
          this.reconcileOrdinary()
          const snapshot = (agentId: string, task: AgentTaskReference | ProactiveTask): JsonObject => {
            const receipts = this.host.readTaskActions(agentId, task.taskId)
            const status = task.state === 'pending' ? 'running' : task.state
            return { taskId: task.taskId, childId: agentId, contextRef: task.contextRef, status,
              summary: status === 'interrupted' ? '旧任务已中断，已有动作已核对；不重放原任务，新的独立任务可继续。' : status === 'unknown' ? '仅保留原任务及未确认动作；不要换号重发，新的独立任务可继续。' : '',
              actions: body.taskId !== undefined ? receipts.actions as unknown as JsonValue[] : [] }
          }
          const tasks = [
            ...this.bindings.filter(binding => binding.parentId === body.agentId).flatMap(binding => binding.taskRefs.map(task => snapshot(binding.scope.agentId, task))),
            ...this.proactiveBindings.filter(binding => binding.parentId === body.agentId).flatMap(binding => binding.taskRefs.map(task => snapshot(binding.agentId, task))),
          ].filter(task => body.taskId === undefined || task.taskId === body.taskId)
          if (body.taskId !== undefined && !tasks.length) fail('AGENT_TASK_UNAVAILABLE', '任务不属于当前主 Agent。')
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ tasks: body.taskId !== undefined ? tasks : [...tasks.filter(task => task.status === 'running'), ...tasks.filter(task => task.status !== 'running').slice(-Math.max(0, 256 - tasks.filter(task => task.status === 'running').length))] })); return
        }
        if (request.url === '/append-task') {
          if (body.agentId !== this.rootId() || !exactRecord(body, ['agentId', 'taskId', 'contextRef']) || typeof body.taskId !== 'string' || !DIGEST.test(body.taskId) || typeof body.contextRef !== 'string' || !DIGEST.test(body.contextRef)) fail('AGENT_SCOPE_INVALID', '追加消息必须来自当前主 Agent。')
          const binding = this.bindings.find(entry => entry.parentId === body.agentId && entry.task?.taskId === body.taskId)
          const proactive = this.proactiveBindings.find(entry => entry.parentId === body.agentId && entry.task.taskId === body.taskId)
          const addition = this.contextScopes.get(body.contextRef), task = binding?.task ?? proactive?.task
          const source = this.taskScopes.get(body.taskId), mode = this.taskModes.get(body.taskId)
          if (!task || task.state !== 'pending' || task.nonce !== this.nonce || !source || !mode || !addition || this.activeContext.get(body.contextRef) !== source.agentId || conversationIdentity(String(body.agentId), addition) !== conversationIdentity(String(body.agentId), source) || addition.conversationId !== source.conversationId) fail('AGENT_TASK_CONTEXT_MISMATCH', '只能给运行中的任务追加同一真实账号、会话、目标和类型的消息。')
          const scope: AgentInvocationScope = { ...source, messageIds: [...new Set([...source.messageIds, ...addition.messageIds])], resourceIds: [...new Set([...source.resourceIds, ...addition.resourceIds])] }
          if (scope.messageIds.length > 100000 || scope.resourceIds.length > 100000) fail('AGENT_SCOPE_CAPACITY', '任务引用达到容量，未扩展权限。')
          this.host.extendAgentScope(scope)
          if (binding) this.replace({ ...binding, scope })
          this.taskScopes.set(task.taskId, scope)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ accepted: true })); return
        }
        if (request.url === '/retire-deliveries') {
          if (body.agentId !== this.rootId() || !exactRecord(body, ['agentId', 'batchIds']) || !Array.isArray(body.batchIds) || body.batchIds.length > 32 || body.batchIds.some(id => typeof id !== 'string' || !DIGEST.test(id))) fail('AGENT_SCOPE_INVALID', '批次清理请求无效。')
          const ids = body.batchIds as string[]
          const refs = [...this.contextScopes.keys()].filter(ref => ids.some(id => { const batch = this.batches.get(id); return batch && groupHarnessEvents(batch.events).some((events, _, groups) => conversationContextRef(id, events[0]!, groups.length === 1) === ref) }))
          if (this.bindings.some(binding => binding.task?.state === 'pending' && refs.includes(binding.task.contextRef))) fail('AGENT_TASK_PENDING', '批次仍有运行中的任务，未清理。')
          this.retireDeliveries(ids)
          for (const ref of refs) { this.activeContext.delete(ref); this.contextScopes.delete(ref) }
          for (const id of ids) this.batches.delete(id)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ retired: ids })); return
        }
        if (request.url?.startsWith('/memory-')) {
          const result = await this.memoryRequest(request.url.slice('/memory-'.length), body, controller.signal)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (request.url === '/delivery-state') {
          if (body.agentId !== this.rootId() || Object.keys(body).length !== 3 || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1 || Number(body.sequence) <= (this.deliveryState?.sequence ?? 0) || typeof body.phase !== 'string' || !['idle', 'busy'].includes(body.phase)) fail('DELIVERY_STATE_INVALID', '投递状态必须来自当前主 Agent 的递增真实状态。')
          this.deliveryState = { sequence: Number(body.sequence), phase: body.phase as 'idle' | 'busy', observedAt: Date.now() }
          if (this.deliveryState.phase === 'idle') this.host.wake()
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ accepted: true })); return
        }
        if (request.url === '/contact-turn-start') {
          const result = this.beginContactTurn(body)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (request.url === '/contact-targets') {
          const turn = this.contactTurn
          if (body.agentId !== this.rootId() || Object.keys(body).length !== 2 || !turn || body.cycleId !== turn.id || !this.validContactTurn(turn) || !this.activity) fail('CONTACT_TURN_EXPIRED', '联系人查询不属于当前主 Agent 轮次。')
          const targets = await this.activity.listTargets()
          if (!this.validContactTurn(turn)) fail('CONTACT_TURN_EXPIRED', '查询联系人时主 Agent 轮次已结束。')
          const result = { targets: targets.map(target => ({ id: target.id, label: target.label, agentTypeId: target.agentTypeId, pluginId: target.pluginId, targetId: target.targetId, tools: [...target.toolNames] })) }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (request.url === '/contact-turn-end') {
          if (body.agentId !== this.rootId() || Object.keys(body).length !== 3 || !Number.isSafeInteger(body.turn) || Number(body.turn) < 1 || body.cycleId !== null && !opaque(body.cycleId)) fail('CONTACT_TURN_INVALID', '联系轮次结束参数无效。')
          const current = this.contactTurn
          if (current && current.turn <= Number(body.turn)) {
            if (current.turn === body.turn && body.cycleId !== null && current.id !== body.cycleId) fail('CONTACT_TURN_INVALID', '联系轮次结束引用无效。')
            this.contactTurn = null
          }
          // Also close an uncertain start whose response was lost. The native turn
          // tombstone rejects a delayed start without touching any newer turn.
          this.lastContactTurn = Math.max(this.lastContactTurn, Number(body.turn))
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ ended: true })); return
        }
        if (request.url?.startsWith('/autonomy-')) {
          if (!this.activity || body.agentId !== this.rootId()) fail('AUTONOMY_SCOPE_INVALID', '只有当前主Agent可操作自主安排。')
          const operation = request.url.slice('/autonomy-'.length)
          let result: JsonObject
          if (operation === 'snapshot' && Object.keys(body).length === 1) result = { ...this.activity.snapshot(), externalPending: this.host.hasPendingMessages?.() ?? false, ready: this.runtimeReady() }
          else if (operation === 'observe' && Object.keys(body).length === 2 && typeof body.phase === 'string') { this.activity.observe(body.phase); result = { observed: true } }
          else if (operation === 'fault' && Object.keys(body).length === 1) result = this.activity.runtimeFault(this.nonce)
          else if (operation === 'claim' && Object.keys(body).length === 1) { result = this.host.hasPendingMessages?.() ? { admitted: false } : this.activity.claim(this.nonce) }
          else if (operation === 'valid' && Object.keys(body).length === 2 && typeof body.cycleId === 'string') result = { valid: this.activity.validCycle(this.nonce, body.cycleId) }
          else if (operation === 'decide' && Object.keys(body).length === 2) result = this.activity.decide(this.nonce, body.decision)
          else if (operation === 'schedule-task' && Object.keys(body).length === 2 && isJsonObject(body.task)) result = this.activity.scheduleTask(this.nonce, body.task)
          else if (operation === 'cancel-scheduled-task' && Object.keys(body).length === 2 && isJsonObject(body.task)) result = this.activity.cancelTask(this.nonce, body.task)
          else if (operation === 'finish' && Object.keys(body).length === 4 && typeof body.cycleId === 'string' && ['completed', 'failed', 'unknown', 'cancelled'].includes(String(body.outcome))) { result = this.activity.finish(this.nonce, body.cycleId, body.outcome as 'completed', typeof body.code === 'string' ? body.code : null); this.host.wake() }
          else fail('CONTROL_REQUEST_INVALID', '自主运行请求形状无效。')
          if (this.contactPolicySummary) result = { ...result, contactPolicy: this.contactPolicySummary() }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (request.url === '/prepare-proactive') {
          const result = await this.prepareProactive(body, controller.signal)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        const proactive = this.proactiveBindings.find(binding => binding.agentId === body.agentId && binding.taskRefs.some(task => task.contextRef === body.contextRef && task.taskId === body.taskId))
        if (proactive && (request.url === '/actions' || request.url === '/finish-task')) {
          const task = proactive.task
          let result: JsonObject
          if (request.url === '/actions') {
            if (!exactRecord(body, ['agentId', 'contextRef', 'taskId']) || body.taskId !== task.taskId || body.contextRef !== task.contextRef || task.nonce !== this.nonce || task.state !== 'pending') fail('PROACTIVE_TASK_CONFLICT', '动作查询与当前任务不匹配；历史结果通过任务状态查询。')
            result = this.host.readTaskActions(proactive.agentId, String(body.taskId)) as unknown as JsonObject
          } else {
            if (body.contextRef !== task.contextRef || body.taskId !== task.taskId || task.nonce !== this.nonce || !['pending', 'unknown', 'interrupted'].includes(task.state)
              || task.state !== 'pending' && !['interrupted', 'unknown'].includes(String(body.status))
              || !exactRecord(body, ['agentId', 'contextRef', 'taskId', 'status']) || !['completed', 'failed', 'interrupted', 'unknown'].includes(String(body.status))) fail('PROACTIVE_TASK_CONFLICT', '结束登记与当前任务不匹配。')
            const requested = task.state === 'pending' ? body.status as TaskEndState : 'interrupted'
            const timer = this.contactTimers.get(proactive.agentId); if (timer) clearTimeout(timer); this.contactTimers.delete(proactive.agentId)
            this.host.revokeAgentAccess(proactive.agentId)
            this.taskScopes.delete(task.taskId); this.taskModes.delete(task.taskId); this.autonomousTasks.delete(task.taskId)
            const receipts = this.host.finishTaskActions(proactive.agentId, task.taskId)
            const status = settledTaskState(requested, receipts)
            this.setProactiveState(proactive, status); this.saveProactive(); result = { ok: true, status, actions: receipts.actions as unknown as JsonValue[] }
          }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (request.url === '/capabilities') {
          if (body.agentTypeId !== 'main' || Object.keys(body).some(key => !['agentId', 'agentTypeId'].includes(key))) fail('CONTROL_REQUEST_INVALID', '通用能力请求无效。')
          const connections = this.host.getCapabilityMcpConnections({ agentId: body.agentId, agentTypeId: 'main' })
          this.capabilityAgents.add(body.agentId)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ capabilities: connections.map(connection => ({ ...connection, headers: { ...connection.headers }, tools: [...connection.tools] })) }))
          return
        }
        if (request.url === '/prepare-task') this.reconcileOrdinary()
        const currentBinding = this.bindings.find(entry => entry.scope.agentId === body.agentId)
        // A new batch can be bound while the previous child is still draining.
        // Only its exact pending task may finish; it cannot read the new context.
        if (!currentBinding || request.url !== '/finish-task' && (typeof body.contextRef !== 'string' || this.activeContext.get(body.contextRef) !== currentBinding.scope.agentId)) fail('AGENT_CONTEXT_UNAVAILABLE', '本次消息上下文已失效。')
        let binding: AgentBinding = currentBinding
        let result: JsonObject
        if (request.url === '/prepare-task') {
          if (!exactRecord(body, ['agentId', 'agentTypeId', 'contextRef', 'taskId', 'mode']) || body.agentTypeId !== binding.scope.agentTypeId || typeof body.taskId !== 'string' || !DIGEST.test(body.taskId) || body.mode !== 'reply' && body.mode !== 'verify') fail('AGENT_SCOPE_INVALID', '子代理类型、调用标识或模式与消息来源不匹配。')
          const references = binding.taskRefs
          this.assertAgentIdle(binding.scope.agentId)
          const scope = this.contextScopes.get(String(body.contextRef))!
          const history = binding.scope.conversationId === scope.conversationId ? binding.scope : undefined
          binding = { ...binding, scope: { ...scope, messageIds: [...new Set([...scope.messageIds, ...(history?.messageIds ?? [])])], resourceIds: [...new Set([...scope.resourceIds, ...(history?.resourceIds ?? [])])] } }
          const unknown = (task: AgentTaskReference) => task.state === 'unknown' && (task.contextRef === body.contextRef || task.taskId === body.taskId)
          if (binding.task && unknown(binding.task) || references.some(unknown)) fail('AGENT_TASK_UNKNOWN', '此批消息或工具调用已有结果未知的子代理任务，未重复执行；新的入站批次可独立处理。')
          const sameContext = binding.task?.contextRef === body.contextRef
          if (references.some(task => task.taskId === body.taskId) || sameContext && binding.task?.taskId === body.taskId) fail('AGENT_TASK_ALREADY_SUBMITTED', '此工具调用已委派，未重复执行。')
          if (references.filter(task => task.contextRef === body.contextRef).length >= MAX_TASK_REFERENCES) fail('AGENT_TASK_CAPACITY', '本批消息的委派次数已达上限，未登记新任务。')
          // Never evict unresolved tasks or calls from this batch to make room.
          const retained = [...references]
          if (retained.length >= MAX_TASK_REFERENCES) {
            const expired = retained.findIndex(task => !this.activeContext.has(task.contextRef) && ['completed', 'failed', 'interrupted'].includes(task.state))
            if (expired < 0) fail('AGENT_TASK_CAPACITY', '子代理调用索引已达上限，未知任务与本批防重记录均已保留，未登记新任务。')
            retained.splice(expired, 1)
          }
          const owner = this.host.readOwnerConfiguration()
          const type = owner.agentTypes.find(entry => entry.id === binding.scope.agentTypeId && entry.enabled && entry.pluginId === binding.scope.pluginId)
          if (!type) fail('AGENT_TYPE_UNAVAILABLE', '子代理类型当前不可用。')
          const preview = composeAgentPrompt(owner, type.id, { 当前时间: new Date().toISOString(), 人格名称: owner.activePersona?.name ?? '', 平台: binding.scope.pluginId, 机器人账号: binding.scope.accountId, 会话编号: binding.scope.conversationId, 会话类型: binding.scope.kind, 目标编号: binding.scope.targetId })
          const task: AgentTaskReference = { contextRef: String(body.contextRef), nonce: this.nonce, state: 'pending', taskId: body.taskId }
          const readOnly = body.mode === 'verify'
          const invocationScope: AgentInvocationScope = readOnly ? { ...binding.scope, readOnly: true } : binding.scope
          let mcp
          let capabilities
          try {
            mcp = this.host.getMcpConnection(binding.scope.pluginId, invocationScope, undefined, task.taskId)
            capabilities = this.host.getCapabilityMcpConnections({ agentId: binding.scope.agentId, agentTypeId: type.id, source: invocationScope, ...(readOnly ? { readOnly: true } : {}) }, task.taskId)
            this.replace({ ...binding, configurationRevision: preview.revision, task, taskRefs: [...retained, task] })
            this.taskScopes.set(task.taskId, invocationScope)
            this.taskModes.set(task.taskId, body.mode as 'reply' | 'verify')
          } catch (error) { this.host.revokeAgentAccess(binding.scope.agentId); this.host.finishTaskActions(binding.scope.agentId, task.taskId); throw error }
          result = { agentId: binding.scope.agentId, agentTypeId: type.id, mode: body.mode, systemPrompt: preview.systemPrompt, revision: preview.revision, mcp: { url: mcp.url, headers: { ...mcp.headers } }, tools: [...mcp.toolNames], capabilities: capabilities.map(connection => ({ ...connection, headers: { ...connection.headers }, tools: [...connection.tools] })) }
        } else if (request.url === '/actions') {
          if (!exactRecord(body, ['agentId', 'contextRef', 'taskId']) || binding.task?.nonce !== this.nonce || binding.task.contextRef !== body.contextRef || binding.task.taskId !== body.taskId || binding.task.state !== 'pending') fail('CONTROL_REQUEST_INVALID', '当前任务回执引用无效。')
          const receipts = this.host.readTaskActions(binding.scope.agentId, String(body.taskId))
          const sentMessageIds = receipts.actions.flatMap(action => isJsonObject(action.result) && (typeof action.result.message_id === 'string' || typeof action.result.message_id === 'number') ? [String(action.result.message_id)] : [])
          if (binding.task?.taskId === body.taskId && sentMessageIds.length) this.replace({ ...binding, scope: { ...binding.scope, messageIds: [...new Set([...binding.scope.messageIds, ...sentMessageIds])].slice(-256) } })
          result = receipts as unknown as JsonObject
        } else if (request.url === '/finish-task') {
          if (!exactRecord(body, ['agentId', 'contextRef', 'taskId', 'status']) || !DIGEST.test(String(body.taskId)) || !['completed', 'failed', 'interrupted', 'unknown'].includes(String(body.status)) || binding.task?.nonce !== this.nonce || binding.task.contextRef !== body.contextRef || binding.task.taskId !== body.taskId || !['pending', 'unknown', 'interrupted'].includes(binding.task.state)
            || binding.task.state !== 'pending' && !['interrupted', 'unknown'].includes(String(body.status))) fail('CONTROL_REQUEST_INVALID', '运行时任务状态无效。')
          this.host.revokeAgentAccess(binding.scope.agentId)
          this.taskScopes.delete(binding.task.taskId); this.taskModes.delete(binding.task.taskId)
          const receipts = this.host.finishTaskActions(binding.scope.agentId, binding.task.taskId)
          const state = settledTaskState(binding.task.state === 'pending' ? body.status as TaskEndState : 'interrupted', receipts)
          const task: AgentTaskReference = { ...binding.task, state }
          this.replace({ ...binding, task, taskRefs: binding.taskRefs.map(reference => reference.contextRef === task.contextRef && reference.taskId === task.taskId ? task : reference) })
          result = { ok: true, status: state, actions: receipts.actions as unknown as JsonValue[] }
        } else { response.writeHead(404); response.end(); return }
        if (controller.signal.aborted || this.stopping) return
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result))
      })().catch(error => {
        if (response.writableEnded || response.destroyed) return
        const publicError = error instanceof PlatformError ? { code: error.code, message: error.message, outcome: error.outcome, ...('details' in error && isJsonObject(error.details) ? { details: error.details } : {}) } : { code: 'CONTROL_REQUEST_FAILED', message: '运行时受控请求失败。', outcome: 'unknown' }
        response.writeHead(error instanceof PlatformError ? error.statusCode : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(publicError))
      }).finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', stopRequest); this.active.delete(controller) })
    })
    server.requestTimeout = 5000; server.headersTimeout = 5000
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Control endpoint unavailable')
    this.server = server; this.url = `http://127.0.0.1:${address.port}`
    this.recoveryTimer = setInterval(() => {
      if (this.stopping || !this.runtimeReady()) return
      try { this.reconcileProactive(); this.reconcileOrdinary(); this.recoveryError = null }
      catch (error) {
        const code = error instanceof PlatformError ? error.code : 'TASK_RECEIPT_RECOVERY_FAILED'
        if (this.recoveryError !== code) console.error('任务回执自动核对失败：' + code)
        this.recoveryError = code
      }
    }, 5000)
    this.recoveryTimer.unref()
  }

  async close(): Promise<void> {
    this.stopping = true; this.contactTurn = null; this.deliveryState = null
    if (this.recoveryTimer) clearInterval(this.recoveryTimer); this.recoveryTimer = undefined
    let persistenceError: unknown
    try { this.revokeProactive() } catch (error) { persistenceError = error }
    for (const timer of this.contactTimers.values()) clearTimeout(timer)
    this.contactTimers.clear()
    for (const [agentId, turnId] of this.memoryTurns) this.host.memory?.end(agentId, turnId)
    this.memoryTurns.clear(); this.memoryTurnBatches.clear(); this.memoryBatch = null
    for (const agentId of this.capabilityAgents) this.host.revokeAgentAccess(agentId)
    this.capabilityAgents.clear()
    for (const controller of this.active) controller.abort()
    for (const binding of this.bindings) this.host.revokeAgentAccess(binding.scope.agentId)
    const server = this.server; this.server = null; this.activeContext.clear(); this.contextScopes.clear(); this.batches.clear(); this.taskScopes.clear(); this.taskModes.clear(); this.autonomousTasks.clear(); this.url = ''; this.secret = ''
    if (server) { const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed }
    if (persistenceError) throw persistenceError
  }
}
