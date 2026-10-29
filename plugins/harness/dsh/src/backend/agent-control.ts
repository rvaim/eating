import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { composeAgentPrompt, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, HarnessDeliveryBatch, HarnessHostServices, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'

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
  private bindings: AgentBinding[] = []
  private server: Server | null = null
  private secret = ''
  private nonce = ''
  private activeContext: { contextRef: string; agentId: string } | null = null
  private stopping = false
  private readonly active = new Set<AbortController>()
  private readonly actionBaselines = new Map<string, ReadonlyMap<string, string>>()
  url = ''

  constructor(directory: string, private readonly host: HarnessHostServices) {
    if (typeof host.getMcpConnection !== 'function' || typeof host.readAgentActions !== 'function' || typeof host.revokeAgentAccess !== 'function') fail('HARNESS_SERVICES_INVALID', 'Host 未提供当前必需的子代理权限与动作回执接口。')
    this.file = join(directory, 'agent-bindings.json')
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
          this.replace({ ...binding, configurationRevision: preview.revision, task, taskRefs: [...references, task].slice(-MAX_TASK_REFERENCES) })
          let mcp
          try { mcp = this.host.getMcpConnection(binding.scope.pluginId, binding.scope) }
          catch (error) { this.host.revokeAgentAccess(binding.scope.agentId); throw error }
          const beforeActions = this.host.readAgentActions(binding.scope.agentId)
          this.actionBaselines.set(binding.scope.agentId, new Map(beforeActions.map(action => [action.requestId, JSON.stringify(action)])))
          result = { agentId: binding.scope.agentId, agentTypeId: type.id, systemPrompt: preview.systemPrompt, revision: preview.revision, mcp: { url: mcp.url, headers: { ...mcp.headers } }, tools: [...type.enabledTools] }
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
    this.actionBaselines.clear()
    for (const controller of this.active) controller.abort()
    for (const binding of this.bindings) this.host.revokeAgentAccess(binding.scope.agentId)
    const server = this.server; this.server = null; this.activeContext = null; this.url = ''; this.secret = ''
    if (server) { const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed }
  }
}
