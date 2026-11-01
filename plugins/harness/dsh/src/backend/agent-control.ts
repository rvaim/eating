import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { composeAgentPrompt, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, HarnessDeliveryBatch, HarnessHostServices, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'
import type { DshAutonomy } from './autonomy'
import type { ProactiveTarget } from '@eating/plugin-sdk'

interface ProactiveTask { taskId: string; cycleId: string; contextRef: string; nonce: string; state: 'pending' | 'completed' | 'failed' | 'unknown' | 'reviewed' }
interface ProactiveBinding { key: string; parentId: string; agentId: string; target: ProactiveTarget; task: ProactiveTask; taskRefs: ProactiveTask[] }

interface AgentTaskReference {
  readonly contextRef: string
  readonly taskId: string
  readonly nonce: string
  readonly state: 'pending' | 'completed' | 'failed' | 'unknown'
}

export interface AgentBinding {
  readonly key: string
  readonly scope: AgentInvocationScope
  readonly parentId: string
  readonly configurationRevision: number
  readonly task?: AgentTaskReference
  readonly taskRefs: readonly AgentTaskReference[]
}
const MAX_TASK_REFERENCES = 32
const MAX_BINDINGS = 100
const UUID = /^[a-f0-9-]{36}$/i
const DIGEST = /^[a-f0-9]{64}$/
const opaque = (value: unknown, maximum = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
function fail(code: string, message: string): never { throw new PlatformError(code, message, 409, 'not-sent') }

/** Body-free trusted bindings and a runtime-only, loopback management capability. */
export class DshAgentControl {
  private readonly file: string
  private readonly proactiveFile: string
  private proactiveBindings: ProactiveBinding[] = []
  private proactivePersistenceFailed = false
  private activity: DshAutonomy | null = null
  private rootId: () => string | null = () => null
  private runtimeReady: () => boolean = () => false
  private bindings: AgentBinding[] = []
  private server: Server | null = null
  private secret = ''
  private nonce = ''
  private activeContext: { contextRef: string; agentId: string } | null = null
  private stopping = false
  private readonly active = new Set<AbortController>()
  private readonly capabilityAgents = new Set<string>()
  private readonly actionBaselines = new Map<string, ReadonlyMap<string, string>>()
  url = ''

  constructor(directory: string, private readonly host: HarnessHostServices) {
    if (typeof host.getCapabilityMcpConnections !== 'function' || typeof host.getMcpConnection !== 'function' || typeof host.readAgentActions !== 'function' || typeof host.revokeAgentAccess !== 'function') fail('HARNESS_SERVICES_INVALID', 'Host 未提供当前必需的子代理权限与动作回执接口。')
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
        if (!['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId'].every(key => opaque((row.target as JsonObject)[key])) || !Array.isArray(row.target.toolNames) || row.target.toolNames.some(name => !opaque(name)) || typeof task.taskId !== 'string' || !DIGEST.test(task.taskId) || typeof task.contextRef !== 'string' || !DIGEST.test(task.contextRef) || !opaque(task.cycleId) || !opaque(task.nonce) || !['pending', 'completed', 'failed', 'unknown', 'reviewed'].includes(String(task.state))) fail('PROACTIVE_BINDINGS_INVALID', '主动联系任务无效。')
        if (!Array.isArray(row.taskRefs) || row.taskRefs.length > MAX_TASK_REFERENCES || row.taskRefs.some(ref => !isJsonObject(ref) || Object.keys(ref).length !== 5 || typeof ref.taskId !== 'string' || !DIGEST.test(ref.taskId) || typeof ref.contextRef !== 'string' || !DIGEST.test(ref.contextRef) || !opaque(ref.cycleId) || !opaque(ref.nonce) || !['pending', 'completed', 'failed', 'unknown', 'reviewed'].includes(String(ref.state))) || !row.taskRefs.some(ref => isJsonObject(ref) && ref.taskId === task.taskId && ref.state === task.state)) fail('PROACTIVE_BINDINGS_INVALID', '主动联系调用索引无效。')
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
        const validTask = (task: unknown): boolean => isJsonObject(task) && DIGEST.test(String(task.contextRef)) && opaque(task.nonce) && ['pending', 'completed', 'failed', 'unknown'].includes(String(task.state)) && typeof task.taskId === 'string' && DIGEST.test(task.taskId)
        if (entry.task !== undefined && !validTask(entry.task) || !Array.isArray(entry.taskRefs) || entry.taskRefs.length > MAX_TASK_REFERENCES || entry.taskRefs.some(task => !validTask(task))) fail('AGENT_BINDINGS_INVALID', '子代理任务状态无效。')
        return structuredClone(entry) as unknown as AgentBinding
      })
    }
  }

  setAutonomy(activity: DshAutonomy, rootId: () => string | null, runtimeReady: () => boolean): void { this.activity = activity; this.rootId = rootId; this.runtimeReady = runtimeReady }
  proactiveStatus(): JsonObject[] { return this.proactiveBindings.map(binding => ({ agentId: binding.agentId, targetId: binding.target.id, label: binding.target.label, taskId: binding.task.taskId, state: binding.task.state })) }
  private saveProactive(): void {
    const value = { schemaVersion: 1, bindings: this.proactiveBindings as unknown as JsonValue[] }
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail('PROACTIVE_BINDINGS_CAPACITY', '主动联系索引达到容量上限。')
    try { writeRestrictedJson(this.proactiveFile, value) }
    catch (error) { this.proactivePersistenceFailed = true; for (const binding of this.proactiveBindings) this.host.revokeAgentAccess(binding.agentId); throw error }
  }
  private setProactiveState(binding: ProactiveBinding, state: ProactiveTask['state']): void { binding.task.state = state; binding.taskRefs = binding.taskRefs.map(ref => ref.taskId === binding.task.taskId ? { ...ref, state } : ref) }
  revokeProactive(): void {
    let changed = false
    for (const binding of this.proactiveBindings) {
      this.host.revokeAgentAccess(binding.agentId)
      if (binding.task.state === 'pending') { this.setProactiveState(binding, 'unknown'); changed = true }
    }
    if (changed) this.saveProactive()
  }
  acknowledgeProactive(agentId: string, taskId: string): void {
    const binding = this.proactiveBindings.find(binding => binding.agentId === agentId && binding.task.taskId === taskId)
    if (!binding || !['pending', 'unknown'].includes(binding.task.state) || this.activity?.activeCycle()) fail('PROACTIVE_TASK_CONFLICT', '请在自主轮次结束后核对对应未知任务。')
    this.host.revokeAgentAccess(agentId); this.setProactiveState(binding, 'reviewed'); this.saveProactive()
  }
  private async prepareProactive(body: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const activity = this.activity, rootId = this.rootId()
    if (this.proactivePersistenceFailed) fail('PROACTIVE_PERSISTENCE_FAILED', '主动联系状态保存失败，已停止新任务。')
    if (!activity || body.agentId !== rootId || typeof body.targetId !== 'string' || typeof body.cycleId !== 'string' || typeof body.taskId !== 'string' || !DIGEST.test(body.taskId) || Object.keys(body).length !== 4 || !this.host.prepareProactiveScope) fail('AUTONOMY_SCOPE_INVALID', '主动任务缺少真实自主轮次和目标绑定。')
    const target = await activity.prepareTarget(this.nonce, body.cycleId, body.targetId)
    signal.throwIfAborted()
    const key = createHash('sha256').update(JSON.stringify([rootId, target.pluginId, target.instanceId, target.accountId, target.agentTypeId, target.targetId])).digest('hex')
    const previous = this.proactiveBindings.find(binding => binding.key === key)
    if (previous && (previous.taskRefs.some(ref => ref.taskId === body.taskId) || ['pending', 'unknown'].includes(previous.task.state))) fail('PROACTIVE_TASK_UNKNOWN', '已有联系任务待核对或此调用已提交，未重复执行。')
    if (previous && previous.taskRefs.filter(ref => ref.cycleId === body.cycleId).length >= MAX_TASK_REFERENCES) fail('PROACTIVE_TASK_CAPACITY', '本自主轮次对此目标的委派次数达到上限。')
    if (!previous && this.proactiveBindings.length >= 100) fail('PROACTIVE_BINDINGS_CAPACITY', '主动会话绑定数量达到上限。')
    const agentId = previous?.agentId ?? randomUUID()
    const scope = this.host.prepareProactiveScope(target.pluginId, { ...target, agentId })
    const owner = this.host.readOwnerConfiguration(), type = owner.agentTypes.find(type => type.id === target.agentTypeId && type.pluginId === target.pluginId && type.enabled)
    if (!type || target.toolNames.some(name => !type.enabledTools.includes(name))) fail('AUTONOMY_TARGET_DENIED', '当前类型或工具已撤权。')
    const contextRef = createHash('sha256').update('eating-autonomy\0' + body.cycleId).digest('hex')
    let mcp, capabilities
    try {
      mcp = this.host.getMcpConnection(target.pluginId, scope, { toolNames: target.toolNames, active: () => activity.targetStillAllowed(this.nonce, String(body.cycleId), target) && this.runtimeReady() })
      capabilities = this.host.getCapabilityMcpConnections({ agentId, agentTypeId: type.id, source: scope })
      signal.throwIfAborted()
      const task: ProactiveTask = { taskId: body.taskId, cycleId: body.cycleId, contextRef, nonce: this.nonce, state: 'pending' }
      const binding: ProactiveBinding = { key, parentId: rootId!, agentId, target, task, taskRefs: [...(previous?.taskRefs ?? []), task].slice(-MAX_TASK_REFERENCES) }
      activity.countContact()
      this.proactiveBindings = previous ? this.proactiveBindings.map(row => row === previous ? binding : row) : [...this.proactiveBindings, binding]
      this.saveProactive()
    } catch (error) { this.host.revokeAgentAccess(agentId); throw error }
    const preview = composeAgentPrompt(owner, type.id, { 当前时间: new Date().toISOString(), 人格名称: owner.activePersona?.name ?? '', 平台: scope.pluginId, 机器人账号: scope.accountId, 会话编号: scope.conversationId, 会话类型: scope.kind, 目标编号: scope.targetId })
    this.actionBaselines.set(agentId, new Map(this.host.readAgentActions(agentId).map(action => [action.requestId, JSON.stringify(action)])))
    return { agentId, agentTypeId: type.id, systemPrompt: preview.systemPrompt, revision: preview.revision, contextRef, label: target.label, scope: { pluginId: scope.pluginId, accountId: scope.accountId, targetId: scope.targetId, conversationId: scope.conversationId, kind: scope.kind }, tools: [...target.toolNames], mcp: { url: mcp.url, headers: { ...mcp.headers } }, capabilities: capabilities.map(connection => ({ ...connection, tools: [...connection.tools], headers: { ...connection.headers } })) }
  }

  list(): readonly AgentBinding[] { return this.bindings }
  get token(): string { return this.secret }
  private save(bindings: AgentBinding[]): void {
    const document = { schemaVersion: 2, bindings: bindings as unknown as JsonValue[] }
    if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) fail('AGENT_BINDINGS_CAPACITY', '子代理绑定索引达到容量上限，未登记新任务。')
    writeRestrictedJson(this.file, document)
    this.bindings = bindings
  }
  private replace(binding: AgentBinding): void { this.save(this.bindings.map(entry => entry.scope.agentId === binding.scope.agentId ? binding : entry)) }

  bind(batch: HarnessDeliveryBatch, parentId: string): AgentBinding {
    const first = batch.events[0]!
    const type = this.host.readOwnerConfiguration().agentTypes.find(entry => entry.enabled && entry.pluginId === first.pluginId && entry.conversationKind === first.source.kind)
    if (!type) fail('AGENT_TYPE_UNAVAILABLE', '此消息来源尚未启用对应的子代理类型。')
    const targetId = first.targetId
    if (!opaque(targetId)) fail('AGENT_SCOPE_INVALID', '消息目标标识不可用。')
    const key = createHash('sha256').update(JSON.stringify([first.pluginId, first.instanceId, first.accountId, batch.conversationId, type.id])).digest('hex')
    let binding = this.bindings.find(entry => entry.key === key && entry.parentId === parentId)
    if (!binding && this.bindings.length >= MAX_BINDINGS) fail('AGENT_CAPACITY_REACHED', '子代理会话数量已达上限，请先核对已有会话。')
    const resourceIds = [...new Set([...(binding?.scope.resourceIds ?? []), ...batch.events.flatMap(event => event.resourceIds ?? [])])].slice(-256)
    const scope: AgentInvocationScope = { agentId: binding?.scope.agentId ?? randomUUID(), agentTypeId: type.id, pluginId: first.pluginId, instanceId: first.instanceId,
      accountId: first.accountId, conversationId: batch.conversationId, kind: first.source.kind, targetId,
      messageIds: [...new Set([...(binding?.scope.messageIds ?? []), ...batch.events.flatMap(event => event.messageId ? [event.messageId] : [])])].slice(-256), resourceIds: [...resourceIds] }
    binding = { ...binding, key, scope, parentId, taskRefs: binding ? binding.taskRefs : [], configurationRevision: this.host.readOwnerConfiguration().revision }
    const previous = this.bindings.find(entry => entry.key === key && entry.parentId === parentId)
    if (previous) this.replace(binding)
    else this.save([...this.bindings, binding])
    this.activeContext = { contextRef: batch.batchId, agentId: scope.agentId }
    return binding
  }

  async start(nonce: string): Promise<void> {
    if (this.server) return
    this.stopping = false; this.nonce = nonce; this.secret = randomBytes(32).toString('hex')
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
        for await (const chunk of request) { controller.signal.throwIfAborted(); length += chunk.length; if (length > 8192) fail('CONTROL_REQUEST_INVALID', '运行时请求过大。'); chunks.push(Buffer.from(chunk)) }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!isJsonObject(body) || !opaque(body.agentId)) fail('CONTROL_REQUEST_INVALID', '运行时请求无效。')
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
          else if (operation === 'finish' && Object.keys(body).length === 4 && typeof body.cycleId === 'string' && ['completed', 'failed', 'unknown', 'cancelled'].includes(String(body.outcome))) { result = this.activity.finish(this.nonce, body.cycleId, body.outcome as 'completed', typeof body.code === 'string' ? body.code : null); this.host.wake() }
          else if (operation === 'targets' && Object.keys(body).length === 1) result = { targets: (await this.activity.listTargets()).map(target => ({ id: target.id, label: target.label, agentTypeId: target.agentTypeId, pluginId: target.pluginId, targetId: target.targetId, tools: [...target.toolNames] })) }
          else fail('CONTROL_REQUEST_INVALID', '自主运行请求形状无效。')
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        if (request.url === '/prepare-proactive') {
          const result = await this.prepareProactive(body, controller.signal)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return
        }
        const proactive = this.proactiveBindings.find(binding => binding.agentId === body.agentId)
        if (proactive && (request.url === '/actions' || request.url === '/finish-task')) {
          const task = proactive.task
          if (body.contextRef !== task.contextRef || body.taskId !== task.taskId || task.nonce !== this.nonce || (request.url === '/actions' ? Object.keys(body).length !== 3 : Object.keys(body).length !== 4 || !['completed', 'failed', 'unknown'].includes(String(body.status)))) fail('PROACTIVE_TASK_CONFLICT', '主动任务回执与当前任务不匹配。')
          let result: JsonObject
          if (request.url === '/actions') {
            const baseline = this.actionBaselines.get(proactive.agentId)
            result = { actions: this.host.readAgentActions(proactive.agentId).filter(action => baseline?.get(action.requestId) !== JSON.stringify(action)) as unknown as JsonValue[] }
          } else {
            if (task.state !== 'pending') fail('PROACTIVE_TASK_UNKNOWN', '主动任务已撤销或待核对，迟到回执不能覆盖。')
            this.host.revokeAgentAccess(proactive.agentId); this.actionBaselines.delete(proactive.agentId)
            this.setProactiveState(proactive, body.status as 'completed'); this.saveProactive(); result = { ok: true }
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
        const binding = this.bindings.find(entry => entry.scope.agentId === body.agentId)
        if (!binding || !this.activeContext || this.activeContext.agentId !== binding.scope.agentId || body.contextRef !== this.activeContext.contextRef) fail('AGENT_CONTEXT_UNAVAILABLE', '本次消息上下文已失效。')
        let result: JsonObject
        if (request.url === '/prepare-task') {
          if (Object.keys(body).some(key => !['agentId', 'contextRef', 'agentTypeId', 'taskId'].includes(key)) || body.agentTypeId !== binding.scope.agentTypeId || (typeof body.taskId !== 'string' || !DIGEST.test(body.taskId))) fail('AGENT_SCOPE_INVALID', '子代理类型或调用标识与消息来源不匹配。')
          if (binding.task?.state === 'pending' || binding.task?.state === 'unknown') fail('AGENT_TASK_UNKNOWN', '已有子代理任务结果待核对，未重复执行。')
          const references = binding.taskRefs
          const sameContext = binding.task?.contextRef === body.contextRef
          if (references.some(task => task.contextRef === body.contextRef && task.taskId === body.taskId) || sameContext && binding.task?.taskId === body.taskId) fail('AGENT_TASK_ALREADY_SUBMITTED', '此工具调用已委派，未重复执行。')
          if (references.filter(task => task.contextRef === body.contextRef).length >= MAX_TASK_REFERENCES) fail('AGENT_TASK_CAPACITY', '本批消息的委派次数已达上限，未登记新任务。')
          const owner = this.host.readOwnerConfiguration()
          const type = owner.agentTypes.find(entry => entry.id === binding.scope.agentTypeId && entry.enabled && entry.pluginId === binding.scope.pluginId)
          if (!type) fail('AGENT_TYPE_UNAVAILABLE', '子代理类型当前不可用。')
          const preview = composeAgentPrompt(owner, type.id, { 当前时间: new Date().toISOString(), 人格名称: owner.activePersona?.name ?? '', 平台: binding.scope.pluginId, 机器人账号: binding.scope.accountId, 会话编号: binding.scope.conversationId, 会话类型: binding.scope.kind, 目标编号: binding.scope.targetId })
          const task: AgentTaskReference = { contextRef: String(body.contextRef), nonce: this.nonce, state: 'pending', taskId: body.taskId }
          let mcp
          let capabilities
          try {
            mcp = this.host.getMcpConnection(binding.scope.pluginId, binding.scope)
            capabilities = this.host.getCapabilityMcpConnections({ agentId: binding.scope.agentId, agentTypeId: type.id, source: binding.scope })
            this.replace({ ...binding, configurationRevision: preview.revision, task, taskRefs: [...references, task].slice(-MAX_TASK_REFERENCES) })
          } catch (error) { this.host.revokeAgentAccess(binding.scope.agentId); throw error }
          const beforeActions = this.host.readAgentActions(binding.scope.agentId)
          this.actionBaselines.set(binding.scope.agentId, new Map(beforeActions.map(action => [action.requestId, JSON.stringify(action)])))
          result = { agentId: binding.scope.agentId, agentTypeId: type.id, systemPrompt: preview.systemPrompt, revision: preview.revision, mcp: { url: mcp.url, headers: { ...mcp.headers } }, tools: [...type.enabledTools], capabilities: capabilities.map(connection => ({ ...connection, headers: { ...connection.headers }, tools: [...connection.tools] })) }
        } else if (request.url === '/actions') {
          if (Object.keys(body).some(key => !['agentId', 'contextRef', 'taskId'].includes(key)) || typeof body.taskId !== 'string' || !DIGEST.test(body.taskId) || binding.task?.nonce !== this.nonce || binding.task.contextRef !== body.contextRef || binding.task.taskId !== body.taskId) fail('CONTROL_REQUEST_INVALID', '运行时请求无效。')
          const actions = this.host.readAgentActions(binding.scope.agentId)
          const sentMessageIds = actions.flatMap(action => isJsonObject(action.result) && (typeof action.result.message_id === 'string' || typeof action.result.message_id === 'number') ? [String(action.result.message_id)] : [])
          if (sentMessageIds.length) this.replace({ ...binding, scope: { ...binding.scope, messageIds: [...new Set([...binding.scope.messageIds, ...sentMessageIds])].slice(-256) } })
          const baseline = this.actionBaselines.get(binding.scope.agentId)
          result = { actions: actions.filter(action => baseline?.get(action.requestId) !== JSON.stringify(action)) as unknown as JsonValue[] }
        } else if (request.url === '/finish-task') {
          if (Object.keys(body).some(key => !['agentId', 'contextRef', 'status', 'taskId'].includes(key)) || typeof body.taskId !== 'string' || !DIGEST.test(body.taskId) || !['completed', 'failed', 'unknown'].includes(String(body.status)) || binding.task?.nonce !== this.nonce || binding.task.contextRef !== body.contextRef || binding.task.taskId !== body.taskId || !['pending', 'unknown'].includes(binding.task.state)) fail('CONTROL_REQUEST_INVALID', '运行时任务状态无效。')
          this.host.revokeAgentAccess(binding.scope.agentId)
          this.actionBaselines.delete(binding.scope.agentId)
          const task: AgentTaskReference = { ...binding.task, state: body.status as 'completed' | 'failed' | 'unknown' }
          this.replace({ ...binding, task, taskRefs: binding.taskRefs.map(reference => reference.contextRef === task.contextRef && reference.taskId === task.taskId ? task : reference) })
          result = { ok: true }
        } else { response.writeHead(404); response.end(); return }
        if (controller.signal.aborted || this.stopping) return
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result))
      })().catch(error => {
        if (response.writableEnded || response.destroyed) return
        const publicError = error instanceof PlatformError ? { code: error.code, message: error.message } : { code: 'CONTROL_REQUEST_FAILED', message: '运行时受控请求失败。' }
        response.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(publicError))
      }).finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', stopRequest); this.active.delete(controller) })
    })
    server.requestTimeout = 5000; server.headersTimeout = 5000
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Control endpoint unavailable')
    this.server = server; this.url = `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    this.stopping = true
    let persistenceError: unknown
    try { this.revokeProactive() } catch (error) { persistenceError = error }
    this.actionBaselines.clear()
    for (const agentId of this.capabilityAgents) this.host.revokeAgentAccess(agentId)
    this.capabilityAgents.clear()
    for (const controller of this.active) controller.abort()
    for (const binding of this.bindings) this.host.revokeAgentAccess(binding.scope.agentId)
    const server = this.server; this.server = null; this.activeContext = null; this.url = ''; this.secret = ''
    if (server) { const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed }
    if (persistenceError) throw persistenceError
  }
}
