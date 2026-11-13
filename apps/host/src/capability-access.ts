import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_IMAGE_LIMITS, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentActionReceipt, BackendPlugin, CapabilityInvocationScope, HarnessCapabilityConnection, JsonObject, JsonValue, McpAccessPolicy, McpDirectorySnapshot, McpGrant, McpServiceSummary, PluginToolDefinition } from '@eating/plugin-sdk'
import { DirectMcpConnections } from './mcp-connections'
import type { HostStore } from './store'
import { secret, sameSecret } from './security'
import { toolResult } from './tool-results'

interface Options {
  readonly imageLimits?: () => import('@eating/plugin-sdk').ImageLimits
  readonly store: Pick<HostStore, 'getSetting' | 'setSetting'>
  readonly direct: DirectMcpConnections
  readonly plugins: () => Iterable<BackendPlugin>
  readonly enabled: (id: string) => boolean
  readonly memoryContext?: (harnessId: string, agentId: string) => import('@eating/plugin-sdk').MemoryContext | null | undefined
  readonly executeIdempotent: (pluginId: string, action: string, params: JsonObject, requestId: string, execute: () => Promise<JsonValue>) => Promise<JsonValue>
}
interface Lease {
  readonly harnessId: string
  readonly sourceId: string
  scope: CapabilityInvocationScope
  readonly token: string
  readonly abort: AbortController
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value)
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value)
const deny = (): never => { throw new PlatformError('CAPABILITY_ACCESS_DENIED', '此 MCP 服务、工具或代理连接当前不可用。', 403, 'not-sent') }
const POLICY_KEY = 'host:mcp-access-policies'
const MAX_POLICY_BYTES = 1024 * 1024
interface PolicyState { readonly schemaVersion: 1; readonly revision: number; readonly policies: Readonly<Record<string, McpAccessPolicy>> }
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key))
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const sourceId = (value: unknown): value is string => typeof value === 'string' && /^(?:plugin\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*|direct\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value) && value.length <= 80
function invalidPolicy(): never { throw new PlatformError('MCP_ACCESS_POLICY_INVALID', 'MCP 权限策略无效，请明确选择全部开放或提供精确的代理类型和工具名单。', 400, 'not-sent') }
function policyStorageError(): never { throw new PlatformError('MCP_ACCESS_POLICY_STORAGE_INVALID', 'MCP 权限策略存储损坏或格式不匹配，原数据未被覆盖。', 500, 'not-sent') }
function policyList(value: unknown, max: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !pattern.test(item)) || new Set(value).size !== value.length) return invalidPolicy()
  return [...value] as string[]
}
function parsePolicy(value: unknown): McpAccessPolicy {
  if (!isJsonObject(value)) return invalidPolicy()
  if (value.mode === 'all' && exactKeys(value, ['mode'])) return { mode: 'all' }
  if (value.mode !== 'custom' || !exactKeys(value, ['mode', 'agentTypeIds', 'toolNames'])) return invalidPolicy()
  return { mode: 'custom', agentTypeIds: policyList(value.agentTypeIds, 1024, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), toolNames: policyList(value.toolNames, 1000, /^[A-Za-z0-9_.-]{1,128}$/) }
}
function effectiveGrant(policy: McpAccessPolicy, agentTypeIds: readonly string[], tools: readonly PluginToolDefinition[]): McpGrant {
  return { agentTypeIds: [...new Set(agentTypeIds)].filter(id => policy.mode === 'all' || policy.agentTypeIds.includes(id)), toolNames: tools.map(tool => tool.name).filter(name => policy.mode === 'all' || policy.toolNames.includes(name)) }
}
function failure(error: unknown): CallToolResult {
  const value = error instanceof PlatformError ? { code: error.code, message: error.message, outcome: error.outcome }
    : { code: 'CAPABILITY_TOOL_FAILED', message: 'MCP 工具调用未完成，请核对结果后再继续。', outcome: 'unknown' }
  return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
}
function proxyTool(tool: PluginToolDefinition, direct: boolean): Tool {
  // External side effects use a separate envelope, so an upstream tool's own
  // request_id or additionalProperties policy is never silently changed.
  const inputSchema = direct && !tool.readOnly ? {
    type: 'object' as const,
    properties: { arguments: tool.inputSchema, request_id: { type: 'string', minLength: 8, maxLength: 128, description: 'Stable Eating action ID. Reuse it when checking the same action; never retry unknown actions with a new ID.' } },
    required: ['arguments', 'request_id'], additionalProperties: false,
  } : tool.inputSchema as Tool['inputSchema']
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema, annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive } }
}

/** One authorization directory for direct services and plugin-owned capabilities. */
export class CapabilityAccess {
  private readonly leases = new Map<string, Lease>()
  private readonly active = new Map<Lease, Set<() => Promise<void>>>()
  private readonly receipts = new Map<string, Map<string, AgentActionReceipt>>()
  private closed = false

  constructor(private readonly options: Options) { this.revision }
  private readPolicies(): PolicyState {
    const saved = this.options.store.getSetting(POLICY_KEY)
    if (saved === null) return { schemaVersion: 1, revision: 0, policies: {} }
    if (Buffer.byteLength(saved, 'utf8') > MAX_POLICY_BYTES) return policyStorageError()
    try {
      const value: unknown = JSON.parse(saved)
      if (!isJsonObject(value) || !exactKeys(value, ['schemaVersion', 'revision', 'policies']) || value.schemaVersion !== 1 || !validRevision(value.revision) || !isJsonObject(value.policies) || Object.keys(value.policies).length > 1000) return policyStorageError()
      const policies: Record<string, McpAccessPolicy> = {}
      for (const [id, policy] of Object.entries(value.policies)) {
        if (!sourceId(id)) return policyStorageError()
        policies[id] = parsePolicy(policy)
      }
      return { schemaVersion: 1, revision: value.revision, policies }
    } catch { return policyStorageError() }
  }
  private savePolicies(state: PolicyState, policies: Readonly<Record<string, McpAccessPolicy>>): void {
    if (this.revision === Number.MAX_SAFE_INTEGER) throw new PlatformError('MCP_REVISION_EXHAUSTED', 'MCP 配置版本已达到上限。', 500, 'not-sent')
    const saved = JSON.stringify({ schemaVersion: 1, revision: state.revision + 1, policies } satisfies PolicyState)
    if (Object.keys(policies).length > 1000 || Buffer.byteLength(saved, 'utf8') > MAX_POLICY_BYTES) throw new PlatformError('MCP_ACCESS_POLICY_CAPACITY', 'MCP 权限策略超出保存容量。', 400, 'not-sent')
    this.options.store.setSetting(POLICY_KEY, saved)
  }
  get revision(): number {
    const value = this.options.direct.revision + this.readPolicies().revision
    if (!validRevision(value)) throw new PlatformError('MCP_REVISION_EXHAUSTED', 'MCP 配置版本已达到上限。', 500, 'not-sent')
    return value
  }
  private plugin(id: string): BackendPlugin | undefined { return [...this.options.plugins()].find(plugin => plugin.id === id) }
  private sources(agentTypeIds = ['main', ...[...this.options.plugins()].flatMap(plugin => (plugin.agentTypes ?? []).map(type => type.id))]): McpServiceSummary[] {
    const { policies } = this.readPolicies()
    const plugins = [...this.options.plugins()].filter(plugin => plugin.tools.length > 0).map(plugin => {
      const id = 'plugin.' + plugin.id, enabled = this.options.enabled(plugin.id), status = plugin.getStatus()
      const permissionsManagedByPlugin = plugin.kind !== 'capability'
      const registered = permissionsManagedByPlugin ? enabled : enabled && status.state === 'connected' && Boolean(plugin.invokeCapability)
      const accessPolicy = permissionsManagedByPlugin ? null : policies[id] ?? { mode: 'all' as const }
      return {
        id, name: plugin.name, source: { kind: 'plugin' as const, pluginId: plugin.id, pluginName: plugin.name }, transport: 'plugin' as const,
        enabled, autoConnect: plugin.getPublicConfiguration().autoConnect === true,
        state: registered ? 'connected' as const : status.state === 'error' ? 'error' as const : 'disconnected' as const,
        lastError: status.lastError, tools: plugin.tools, accessPolicy,
        grant: accessPolicy === null ? { agentTypeIds: (plugin.agentTypes ?? []).map(type => type.id), toolNames: [...new Set((plugin.agentTypes ?? []).flatMap(type => [...type.enabledTools]))] } : effectiveGrant(accessPolicy, agentTypeIds, plugin.tools),
        configuration: { pluginKind: plugin.kind, permissionsManagedByPlugin },
      }
    })
    return [...plugins, ...this.options.direct.list(agentTypeIds).map(source => {
      const accessPolicy = policies[source.id] ?? { mode: 'all' as const }
      return { ...source, accessPolicy, grant: effectiveGrant(accessPolicy, agentTypeIds, source.tools) }
    })]
  }
  validatePolicyChange(input: unknown): { id: string; expectedRevision: number; policy: McpAccessPolicy } {
    if (!isJsonObject(input) || !sourceId(input.id) || !validRevision(input.expectedRevision) || !['all', 'custom'].includes(String(input.mode)) || !exactKeys(input, input.mode === 'all' ? ['id', 'expectedRevision', 'mode'] : ['id', 'expectedRevision', 'mode', 'agentTypeIds', 'toolNames'])) return invalidPolicy()
    const policy = parsePolicy(input.mode === 'all' ? { mode: input.mode } : { mode: input.mode, agentTypeIds: input.agentTypeIds!, toolNames: input.toolNames! })
    this.requireRevision(input.expectedRevision)
    if (this.source(input.id).accessPolicy === null) throw new PlatformError('MCP_MANAGED_BY_PLUGIN', '此 MCP 的权限由来源插件管理。', 409, 'not-sent')
    return { id: input.id, expectedRevision: input.expectedRevision, policy }
  }
  savePolicy(input: unknown): void {
    const { id, policy } = this.validatePolicyChange(input)
    const state = this.readPolicies()
    this.savePolicies(state, { ...state.policies, [id]: policy })
    this.revokeSource(id)
  }
  hasPolicy(id: string): boolean { return Object.hasOwn(this.readPolicies().policies, id) }
  removePolicy(id: string): void {
    const state = this.readPolicies()
    if (!Object.hasOwn(state.policies, id)) return
    const policies = { ...state.policies }
    delete policies[id]
    this.savePolicies(state, policies)
    this.revokeSource(id)
  }
  snapshot(agentTypes: readonly { id: string; title: string }[]): McpDirectorySnapshot {
    const types = [{ id: 'main', title: '主 Agent / Harness 会话' }, ...agentTypes.filter(type => type.id !== 'main').map(type => ({ id: type.id, title: type.title }))]
    return { protocolVersion: 1, revision: this.revision, services: this.sources(types.map(type => type.id)), agentTypes: types, harnessRemounts: [] }
  }
  source(id: string): McpServiceSummary {
    const source = this.sources().find(source => source.id === id)
    if (!source) throw new PlatformError('MCP_SERVICE_NOT_FOUND', 'MCP 服务不存在。', 404, 'not-sent')
    return source
  }
  requireRevision(expected: unknown, changes = 1): void {
    const current = this.revision
    if (!Number.isSafeInteger(expected) || expected !== current) throw new PlatformError('MCP_CONFIGURATION_CONFLICT', 'MCP 配置已变更，请保留草稿并刷新后重试。', 409, 'not-sent')
    if (!validRevision(current + changes)) throw new PlatformError('MCP_REVISION_EXHAUSTED', 'MCP 配置版本已达到上限。', 500, 'not-sent')
  }
  allowed(scope: CapabilityInvocationScope, sourceId: string, toolName: string): boolean {
    if (this.closed || scope.signal?.aborted || scope.source?.signal?.aborted || !identifier(scope.agentId) || !identifier(scope.agentTypeId)
      || scope.readOnly !== undefined && typeof scope.readOnly !== 'boolean' || scope.source?.readOnly !== undefined && typeof scope.source.readOnly !== 'boolean') return false
    let source: McpServiceSummary
    try { source = this.source(sourceId) } catch { return false }
    return source.enabled && source.state === 'connected' && source.accessPolicy !== null && source.configuration.permissionsManagedByPlugin !== true && source.tools.some(tool => tool.name === toolName && (!(scope.readOnly === true || scope.source?.readOnly === true) || tool.readOnly === true))
      && (source.accessPolicy.mode === 'all' || source.accessPolicy.agentTypeIds.includes(scope.agentTypeId) && source.accessPolicy.toolNames.includes(toolName))
  }
  activeService(scope: CapabilityInvocationScope, sourceId: string): boolean {
    return this.source(sourceId).tools.some(tool => this.activePermission(scope, sourceId, tool.name))
  }
  /** Pin the actual caller lease so a later grant to the same Agent cannot revive an old resource. */
  pinService(scope: CapabilityInvocationScope, sourceId: string): () => boolean {
    const identity = (value: CapabilityInvocationScope) => {
      const s = value.source
      return JSON.stringify([value.agentId, value.agentTypeId, value.readOnly === true, s ? [s.pluginId, s.instanceId, s.accountId, s.conversationId, s.kind, s.targetId, s.readOnly === true] : null])
    }
    const expected = identity(scope)
    const lease = [...this.leases.values()].find(lease => {
      if (lease.sourceId !== sourceId || lease.abort.signal.aborted || identity(lease.scope) !== expected || scope.signal && scope.signal !== lease.abort.signal) return false
      if (!scope.source || !lease.scope.source) return !scope.source && !lease.scope.source
      const messages = new Set(lease.scope.source.messageIds), resources = new Set(lease.scope.source.resourceIds)
      return scope.source.messageIds.every(id => messages.has(id)) && scope.source.resourceIds.every(id => resources.has(id))
    })
    return () => Boolean(lease && this.leases.get(lease.token) === lease && !lease.abort.signal.aborted && !scope.signal?.aborted && this.options.enabled(lease.harnessId)
      && this.source(sourceId).tools.some(tool => this.allowed(lease.scope, sourceId, tool.name)))
  }
  activePermission(scope: CapabilityInvocationScope, sourceId: string, toolName: string): boolean {
    return this.allowed(scope, sourceId, toolName) && [...this.leases.values()].some(lease => !lease.abort.signal.aborted && lease.scope.agentId === scope.agentId && lease.scope.agentTypeId === scope.agentTypeId && lease.sourceId === sourceId && this.options.enabled(lease.harnessId) && this.allowed(lease.scope, sourceId, toolName))
  }
  connections(harnessId: string, scope: CapabilityInvocationScope, baseUrl: string): readonly HarnessCapabilityConnection[] {
    if (this.closed || !this.options.enabled(harnessId) || !identifier(scope.agentId) || !identifier(scope.agentTypeId)
      || scope.readOnly !== undefined && typeof scope.readOnly !== 'boolean' || scope.source?.readOnly !== undefined && typeof scope.source.readOnly !== 'boolean') return deny()
    if (scope.source && (scope.source.agentId !== scope.agentId || scope.source.agentTypeId !== scope.agentTypeId)) return deny()
    const sources = this.sources()
    const result: HarnessCapabilityConnection[] = []
    for (const lease of this.leases.values()) if (lease.harnessId === harnessId && lease.scope.agentId === scope.agentId) this.retire(lease)
    for (const source of sources) {
      // Disconnected optional services never block a task's communication MCP.
      // The current policy selects exact tools; all also covers future types/tools.
      const tools = source.tools.filter(tool => this.allowed(scope, source.id, tool.name)).map(tool => tool.name)
      if (!tools.length) continue
      if (this.leases.size >= 1024) throw new PlatformError('MCP_LEASE_CAPACITY', '当前 MCP 代理连接已达到上限，请停止未使用的 Harness。', 429, 'not-sent')
      const lease: Lease = { harnessId, sourceId: source.id, scope: structuredClone(scope), token: secret(), abort: new AbortController() }
      this.leases.set(lease.token, lease)
      result.push({ id: source.id, serverName: source.id.length <= 24 ? source.id.replace(/[^a-zA-Z0-9_]/g, '_') : 'service_' + createHash('sha256').update(source.id).digest('hex').slice(0, 16), url: `${baseUrl}/mcp-services/${encodeURIComponent(source.id)}`, headers: { Authorization: 'Bearer ' + lease.token }, tools })
    }
    return result
  }
  private requireLease(token: string, id: string): Lease {
    const lease = this.leases.get(token)
    if (!lease || !sameSecret(lease.token, token) || lease.sourceId !== id || this.closed || lease.abort.signal.aborted || !this.options.enabled(lease.harnessId)) return deny()
    return lease
  }
  private async invoke(lease: Lease, name: string, input: JsonObject): Promise<CallToolResult> {
    this.requireLease(lease.token, lease.sourceId)
    if (!this.allowed(lease.scope, lease.sourceId, name)) return deny()
    const source = this.source(lease.sourceId), tool = source.tools.find(tool => tool.name === name)!
    if (source.source.kind === 'plugin') {
      const plugin = this.plugin(source.source.pluginId)
      if (!plugin?.invokeCapability) return deny()
      if (!tool.readOnly && !requestId(input.request_id)) throw new PlatformError('REQUEST_ID_REQUIRED', '写入工具需要稳定 request_id。', 400, 'not-sent')
      const key = tool.readOnly ? randomUUID() : 'agent-' + createHash('sha256').update(lease.harnessId + '\0' + lease.scope.agentId + '\0' + String(input.request_id)).digest('hex')
      const args = { ...input, ...(!tool.readOnly ? { request_id: key } : {}) }
      const memory = plugin.memory ? this.options.memoryContext?.(lease.harnessId, lease.scope.agentId) : undefined
      if (memory === null) throw new PlatformError('MEMORY_CONTEXT_AMBIGUOUS', '当前轮次包含多个会话来源，请由对应会话子代理在其真实范围内查询记忆。', 409, 'not-sent')
      const result = await plugin.invokeCapability(name, args, key, { ...structuredClone(lease.scope), memory, signal: lease.abort.signal })
      if (!this.allowed(lease.scope, lease.sourceId, name)) return deny()
      return toolResult(tool, result, key, this.options.imageLimits?.() ?? DEFAULT_IMAGE_LIMITS)
    }
    if (tool.readOnly) return this.options.direct.call(lease.sourceId, name, input, lease.abort.signal)
    if (!requestId(input.request_id) || !isJsonObject(input.arguments) || Object.keys(input).some(key => !['request_id', 'arguments'].includes(key))) throw new PlatformError('INVALID_MCP_ARGUMENTS', '外部写入工具需要 arguments 对象和稳定 request_id。', 400, 'not-sent')
    const key = 'agent-' + createHash('sha256').update(lease.harnessId + '\0' + lease.scope.agentId + '\0' + String(input.request_id)).digest('hex')
    const args = input.arguments
    let raw: CallToolResult | undefined
    try {
      await this.options.executeIdempotent('mcp.' + lease.sourceId, name, { argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex') }, key, async () => {
        raw = await this.options.direct.call(lease.sourceId, name, args, lease.abort.signal)
        if (raw.isError) throw new PlatformError('MCP_REMOTE_TOOL_ERROR', '外部 MCP 工具报告失败，请核对动作结果。', 502, 'unknown')
        // Images, credentials and arbitrary tool output remain transient, rather
        // than becoming a second Host media/history store.
        return { completed: true }
      })
    } catch (error) { if (!raw) throw error }
    if (!raw) throw new PlatformError('MCP_ACTION_ALREADY_RECORDED', '此动作已有记录，未再次执行；原始 MCP 输出未在 Host 中保存，请核对实际结果。', 409, 'not-sent')
    return raw
  }
  async handle(id: string, token: string, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const lease = this.requireLease(token, id)
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return }
    const source = this.source(id)
    const server = new Server({ name: id, version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.source(id).tools.filter(tool => this.allowed(lease.scope, id, tool.name)).map(tool => proxyTool(tool, source.source.kind === 'direct')) }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        this.requireLease(token, id)
        const args = params.arguments ?? {}
        if (!isJsonObject(args)) throw new PlatformError('INVALID_MCP_ARGUMENTS', '工具参数必须是对象。')
        const result = await this.invoke(lease, params.name, args)
        this.requireLease(token, id)
        if (!this.allowed(lease.scope, id, params.name)) return deny()
        const tool = this.source(id).tools.find(tool => tool.name === params.name)
        if (tool && !tool.readOnly && requestId(args.request_id)) this.remember(lease, { requestId: args.request_id, tool: 'mcp__' + id.replace(/[^a-zA-Z0-9_]/g, '_') + '__' + params.name, outcome: result.isError ? 'unknown' : 'succeeded' })
        if (Buffer.byteLength(JSON.stringify(result)) > 12 * 1024 * 1024) throw new PlatformError('MCP_RESULT_TOO_LARGE', 'MCP 返回内容过大。', 502, 'unknown')
        return result
      } catch (error) {
        const args = params.arguments
        if (isJsonObject(args) && requestId(args.request_id) && this.leases.has(lease.token) && this.source(id).tools.find(tool => tool.name === params.name)?.readOnly === false
          && !(error instanceof PlatformError && error.code === 'MCP_ACTION_ALREADY_RECORDED')) {
          this.remember(lease, { requestId: args.request_id, tool: params.name, outcome: error instanceof PlatformError ? error.outcome : 'unknown', ...(error instanceof PlatformError ? { code: error.code } : {}) })
        }
        return failure(error)
      }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const active = this.active.get(lease) ?? new Set<() => Promise<void>>(); this.active.set(lease, active)
    let signalStopped!: () => void
    const stopped = new Promise<void>(resolve => { signalStopped = resolve })
    let cleanupTask: Promise<void> | undefined
    const cleanup = () => {
      if (!response.writableEnded && !response.destroyed) response.destroy()
      signalStopped()
      cleanupTask ??= (async () => { request.off('aborted', cancel); response.off('close', cancel); await server.close(); await transport.close(); active.delete(cleanup); if (!active.size) this.active.delete(lease) })()
      return cleanupTask
    }
    const cancel = () => { void cleanup().catch(() => {}) }
    active.add(cleanup)
    request.once('aborted', cancel); response.once('close', cancel)
    try { await server.connect(transport); await Promise.race([transport.handleRequest(request, response, body), stopped]) }
    finally { await cleanup() }
  }
  private remember(lease: Lease, receipt: AgentActionReceipt): void {
    if (!this.leases.has(lease.token)) return
    const key = lease.harnessId + '\0' + lease.scope.agentId
    const receipts = this.receipts.get(key) ?? new Map<string, AgentActionReceipt>()
    receipts.delete(receipt.requestId); receipts.set(receipt.requestId, receipt)
    if (receipts.size > 100) receipts.delete(receipts.keys().next().value!)
    this.receipts.set(key, receipts)
  }
  actions(harnessId: string, agentId: string): readonly AgentActionReceipt[] { return [...(this.receipts.get(harnessId + '\0' + agentId)?.values() ?? [])] }
  extendScope(harnessId: string, scope: import('@eating/plugin-sdk').AgentInvocationScope, validateOnly = false): void {
    for (const lease of this.leases.values()) {
      if (lease.harnessId !== harnessId || lease.scope.agentId !== scope.agentId || !lease.scope.source) continue
      const previous = lease.scope.source
      if (['agentTypeId', 'pluginId', 'instanceId', 'accountId', 'conversationId', 'kind', 'targetId', 'readOnly'].some(key => previous[key as keyof typeof previous] !== scope[key as keyof typeof scope])
        || previous.messageIds.some(id => !scope.messageIds.includes(id)) || previous.resourceIds.some(id => !scope.resourceIds.includes(id))) deny()
    }
    if (validateOnly) return
    for (const lease of this.leases.values()) if (lease.harnessId === harnessId && lease.scope.agentId === scope.agentId && lease.scope.source) lease.scope = { ...lease.scope, source: structuredClone(scope) }
  }

  private retire(lease: Lease): void {
    if (this.leases.get(lease.token) !== lease) return
    this.leases.delete(lease.token); lease.abort.abort()
    for (const stop of this.active.get(lease) ?? []) void stop().catch(() => {})
  }
  revokeAgent(harnessId: string, agentId: string): void { this.receipts.delete(harnessId + '\0' + agentId); for (const lease of this.leases.values()) if (lease.harnessId === harnessId && lease.scope.agentId === agentId) this.retire(lease) }
  revokeHarness(harnessId: string): void { for (const key of this.receipts.keys()) if (key.startsWith(harnessId + '\0')) this.receipts.delete(key); for (const lease of this.leases.values()) if (lease.harnessId === harnessId) this.retire(lease) }
  revokeSource(sourceId: string): void { for (const lease of this.leases.values()) if (lease.sourceId === sourceId) this.retire(lease) }
  async close(): Promise<void> {
    this.closed = true
    this.receipts.clear()
    for (const lease of this.leases.values()) this.retire(lease)
    await Promise.allSettled([...this.active.values()].flatMap(stops => [...stops].map(stop => stop())))
  }
}
