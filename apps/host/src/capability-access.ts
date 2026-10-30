import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentActionReceipt, BackendPlugin, CapabilityInvocationScope, HarnessCapabilityConnection, JsonObject, JsonValue, McpDirectorySnapshot, McpGrant, McpServiceSummary, PluginToolDefinition } from '@eating/plugin-sdk'
import { DirectMcpConnections } from './mcp-connections'
import { secret, sameSecret } from './security'
import { toolResult } from './tool-results'

interface Options {
  readonly direct: DirectMcpConnections
  readonly plugins: () => Iterable<BackendPlugin>
  readonly enabled: (id: string) => boolean
  readonly getSetting: (key: string) => string | null
  readonly setSetting: (key: string, value: string) => void
  readonly executeIdempotent: (pluginId: string, action: string, params: JsonObject, requestId: string, execute: () => Promise<JsonValue>) => Promise<JsonValue>
}
interface Lease {
  readonly harnessId: string
  readonly sourceId: string
  readonly scope: CapabilityInvocationScope
  readonly token: string
  readonly abort: AbortController
}
const settingKey = 'host:capability-grants'
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value)
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value)
const deny = (): never => { throw new PlatformError('CAPABILITY_ACCESS_DENIED', '此代理未获准使用该 MCP 服务或工具。', 403, 'not-sent') }
function grant(value: unknown): McpGrant {
  if (!isJsonObject(value) || Object.keys(value).some(key => !['agentTypeIds', 'toolNames'].includes(key))
    || !Array.isArray(value.agentTypeIds) || !Array.isArray(value.toolNames) || value.agentTypeIds.length > 256 || value.toolNames.length > 256
    || !value.agentTypeIds.every(identifier) || !value.toolNames.every(identifier)
    || new Set(value.agentTypeIds).size !== value.agentTypeIds.length || new Set(value.toolNames).size !== value.toolNames.length) {
    throw new PlatformError('INVALID_MCP_GRANT', '请提供不重复的代理类型和工具授权。', 400, 'not-sent')
  }
  return { agentTypeIds: [...value.agentTypeIds], toolNames: [...value.toolNames] }
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
  private revisionValue = 0
  private readonly grants = new Map<string, McpGrant>()
  private readonly leases = new Map<string, Lease>()
  private readonly active = new Map<Lease, Set<() => Promise<void>>>()
  private readonly receipts = new Map<string, Map<string, AgentActionReceipt>>()
  private closed = false

  constructor(private readonly options: Options) {
    const stored = options.getSetting(settingKey)
    if (stored !== null) {
      let value: unknown
      try { value = JSON.parse(stored) } catch { throw new PlatformError('INVALID_MCP_GRANTS', 'MCP 授权配置损坏，未覆盖原配置。', 500) }
      if (!isJsonObject(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !isJsonObject(value.grants)
        || Object.keys(value).some(key => !['schemaVersion', 'revision', 'grants'].includes(key))) throw new PlatformError('INVALID_MCP_GRANTS', 'MCP 授权配置格式无效，未覆盖原配置。', 500)
      this.revisionValue = Number(value.revision)
      for (const [id, permissions] of Object.entries(value.grants)) {
        if (!/^plugin\.[a-z][a-z0-9-]{0,63}$/.test(id)) throw new PlatformError('INVALID_MCP_GRANTS', 'MCP 授权来源无效。', 500)
        this.grants.set(id, grant(permissions))
      }
    }
  }
  get revision(): number { return this.revisionValue + this.options.direct.revision }
  private plugin(id: string): BackendPlugin | undefined { return [...this.options.plugins()].find(plugin => plugin.id === id) }
  private sources(): McpServiceSummary[] {
    const plugins = [...this.options.plugins()].filter(plugin => plugin.tools.length > 0).map(plugin => {
      const id = 'plugin.' + plugin.id, enabled = this.options.enabled(plugin.id), status = plugin.getStatus()
      const permissionsManagedByPlugin = plugin.kind !== 'capability'
      const registered = permissionsManagedByPlugin ? enabled : enabled && status.state === 'connected' && Boolean(plugin.invokeCapability)
      const ownGrant = this.grants.get(id) ?? { agentTypeIds: [], toolNames: [] }
      return {
        id, name: plugin.name, source: { kind: 'plugin' as const, pluginId: plugin.id, pluginName: plugin.name }, transport: 'plugin' as const,
        enabled, autoConnect: plugin.getPublicConfiguration().autoConnect === true,
        state: registered ? 'connected' as const : status.state === 'error' ? 'error' as const : 'disconnected' as const,
        lastError: status.lastError, tools: plugin.tools,
        grant: permissionsManagedByPlugin ? { agentTypeIds: (plugin.agentTypes ?? []).map(type => type.id), toolNames: [...new Set((plugin.agentTypes ?? []).flatMap(type => [...type.enabledTools]))] } : ownGrant,
        configuration: { pluginKind: plugin.kind, permissionsManagedByPlugin },
      }
    })
    return [...plugins, ...this.options.direct.list()]
  }
  snapshot(agentTypes: readonly { id: string; title: string }[]): McpDirectorySnapshot {
    return { protocolVersion: 1, revision: this.revision, services: this.sources(), agentTypes: [{ id: 'main', title: '主 Agent / Harness 会话' }, ...agentTypes] }
  }
  source(id: string): McpServiceSummary {
    const source = this.sources().find(source => source.id === id)
    if (!source) throw new PlatformError('MCP_SERVICE_NOT_FOUND', 'MCP 服务不存在。', 404, 'not-sent')
    return source
  }
  requireRevision(expected: unknown): void {
    if (!Number.isSafeInteger(expected) || expected !== this.revision) throw new PlatformError('MCP_CONFIGURATION_CONFLICT', 'MCP 配置已变更，请保留草稿并刷新后重试。', 409, 'not-sent')
  }
  savePluginGrant(input: unknown, knownAgentTypes: readonly string[]): void {
    if (!isJsonObject(input) || typeof input.id !== 'string' || Object.keys(input).some(key => !['id', 'expectedRevision', 'agentTypeIds', 'toolNames'].includes(key))) throw new PlatformError('INVALID_MCP_GRANT', 'MCP 授权参数无效。')
    this.requireRevision(input.expectedRevision)
    const source = this.source(input.id)
    if (source.source.kind !== 'plugin' || source.configuration.permissionsManagedByPlugin === true) throw new PlatformError('MCP_GRANT_MANAGED_BY_PLUGIN', '此服务的权限由来源插件管理，请打开该插件面板。', 409, 'not-sent')
    const next = grant({ agentTypeIds: input.agentTypeIds ?? [], toolNames: input.toolNames ?? [] })
    if (next.agentTypeIds.some(id => !['main', ...knownAgentTypes].includes(id)) || next.toolNames.some(name => !source.tools.some(tool => tool.name === name))) throw new PlatformError('INVALID_MCP_GRANT', '授权中包含不存在的代理类型或工具。')
    const grants = new Map(this.grants); grants.set(input.id, next)
    const revision = this.revisionValue + 1
    this.options.setSetting(settingKey, JSON.stringify({ schemaVersion: 1, revision, grants: Object.fromEntries(grants) }))
    this.grants.clear(); for (const [id, value] of grants) this.grants.set(id, value)
    this.revisionValue = revision
    this.revokeSource(input.id)
  }
  allowed(scope: CapabilityInvocationScope, sourceId: string, toolName: string): boolean {
    if (this.closed) return false
    let source: McpServiceSummary
    try { source = this.source(sourceId) } catch { return false }
    return source.enabled && source.state === 'connected' && source.configuration.permissionsManagedByPlugin !== true
      && source.grant.agentTypeIds.includes(scope.agentTypeId) && source.grant.toolNames.includes(toolName) && source.tools.some(tool => tool.name === toolName)
  }
  activeService(scope: CapabilityInvocationScope, sourceId: string): boolean {
    return this.source(sourceId).tools.some(tool => this.activePermission(scope, sourceId, tool.name))
  }
  activePermission(scope: CapabilityInvocationScope, sourceId: string, toolName: string): boolean {
    return this.allowed(scope, sourceId, toolName) && [...this.leases.values()].some(lease => !lease.abort.signal.aborted && lease.scope.agentId === scope.agentId && lease.scope.agentTypeId === scope.agentTypeId && lease.sourceId === sourceId && this.options.enabled(lease.harnessId))
  }
  connections(harnessId: string, scope: CapabilityInvocationScope, baseUrl: string): readonly HarnessCapabilityConnection[] {
    if (this.closed || !this.options.enabled(harnessId) || !identifier(scope.agentId) || !identifier(scope.agentTypeId)) return deny()
    if (scope.source && (scope.source.agentId !== scope.agentId || scope.source.agentTypeId !== scope.agentTypeId)) return deny()
    const result: HarnessCapabilityConnection[] = []
    for (const source of this.sources()) {
      const selected = source.enabled && source.configuration.permissionsManagedByPlugin !== true && source.grant.agentTypeIds.includes(scope.agentTypeId) && source.grant.toolNames.length > 0
      if (selected && source.state !== 'connected') throw new PlatformError('MCP_SERVICE_NOT_READY', `已授权的 MCP 服务“${source.name}”尚未连接，请先在 MCP 页面连接。`, 409, 'not-sent')
      if (selected && source.grant.toolNames.some(name => !source.tools.some(tool => tool.name === name))) throw new PlatformError('MCP_GRANTED_TOOL_MISSING', `MCP 服务“${source.name}”的工具目录已变化，请重新核对授权。`, 409, 'not-sent')
      const tools = source.tools.filter(tool => this.allowed(scope, source.id, tool.name)).map(tool => tool.name)
      if (!tools.length) continue
      for (const lease of this.leases.values()) if (lease.harnessId === harnessId && lease.scope.agentId === scope.agentId && lease.sourceId === source.id) this.retire(lease)
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
    if (!this.allowed(lease.scope, lease.sourceId, name)) return deny()
    const source = this.source(lease.sourceId), tool = source.tools.find(tool => tool.name === name)!
    if (source.source.kind === 'plugin') {
      const plugin = this.plugin(source.source.pluginId)
      if (!plugin?.invokeCapability) return deny()
      if (!tool.readOnly && !requestId(input.request_id)) throw new PlatformError('REQUEST_ID_REQUIRED', '写入工具需要稳定 request_id。', 400, 'not-sent')
      const key = tool.readOnly ? randomUUID() : 'agent-' + createHash('sha256').update(lease.harnessId + '\0' + lease.scope.agentId + '\0' + String(input.request_id)).digest('hex')
      const args = { ...input, ...(!tool.readOnly ? { request_id: key } : {}) }
      const result = await plugin.invokeCapability(name, args, key, { ...structuredClone(lease.scope), signal: lease.abort.signal })
      if (!this.allowed(lease.scope, lease.sourceId, name)) return deny()
      return toolResult(tool, result, key)
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
