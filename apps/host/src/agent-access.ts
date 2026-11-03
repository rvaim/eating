import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentActionReceipt, AgentInvocationScope, AgentMcpConnection, BackendPlugin, JsonObject, JsonValue, RegisteredAgentInstructions, RegisteredAgentType } from '@eating/plugin-sdk'
import { createPluginMcpHandler } from './mcp'
import { secret } from './security'

const maximumAgents = 256
const maximumReferences = 100000
const maximumReferenceBytes = 100 * 1024 * 1024
const maximumHistoricalReferences = 256
const maximumReceipts = 100
const opaque = (value: unknown, maximum = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
function forbidden(): never { throw new PlatformError('AGENT_SCOPE_VIOLATION', '此代理未获准执行该操作或访问该会话。', 403, 'not-sent') }
const boundedReferences = (values: readonly string[]): readonly string[] => [...new Set(values)].slice(-maximumHistoricalReferences)
function validReferences(messageIds: readonly unknown[], resourceIds: readonly unknown[]): boolean {
  if (messageIds.length > maximumReferences || resourceIds.length > maximumReferences) return false
  let bytes = 0
  for (const references of [messageIds, resourceIds]) for (const reference of references) {
    if (!opaque(reference, 2048)) return false
    bytes += Buffer.byteLength(reference, 'utf8')
    if (bytes > maximumReferenceBytes) return false
  }
  return true
}

/** Contributions stay owned by the installed plugin; the Host adds identity and lifecycle. */
export function collectAgentContributions(plugins: Iterable<BackendPlugin>, enabled: ReadonlySet<string>) {
  const agentTypes: RegisteredAgentType[] = []
  const pluginInstructions: RegisteredAgentInstructions[] = []
  const ids = new Set<string>()
  const owners = new Set<string>(), administrators = new Set<string>()
  for (const plugin of plugins) {
    const active = enabled.has(plugin.id)
    const identity = plugin.getAgentIdentity?.() ?? { owners: [], administrators: [] }
    if (!Array.isArray(identity.owners) || !Array.isArray(identity.administrators) || [...identity.owners, ...identity.administrators].some(value => !opaque(value, 160))) throw new PlatformError('AGENT_REGISTRY_INVALID', '插件的代理身份配置无效。', 500)
    if (active) { for (const id of identity.owners) owners.add(id); for (const id of identity.administrators) administrators.add(id) }
    for (const type of plugin.agentTypes ?? []) {
      if (!opaque(type.id, 160) || !type.id.startsWith(plugin.id + '.') || ids.has(type.id) || !opaque(type.title, 160)
        || typeof type.description !== 'string' || typeof type.defaultPrompt !== 'string' || type.defaultPrompt.length > 50000
        || !['private', 'group'].includes(type.conversationKind) || !Array.isArray(type.availableTools) || !Array.isArray(type.defaultTools) || !Array.isArray(type.enabledTools)
        || type.availableTools.length > 256 || type.availableTools.some(name => !plugin.tools.some(tool => tool.name === name))
        || [...type.defaultTools, ...type.enabledTools].some(name => !type.availableTools.includes(name))) throw new PlatformError('AGENT_REGISTRY_INVALID', '插件的代理类型声明无效。', 500)
      ids.add(type.id)
      agentTypes.push({ ...type, availableTools: [...type.availableTools], defaultTools: [...type.defaultTools], enabledTools: [...type.enabledTools], pluginId: plugin.id, pluginName: plugin.name, enabled: active,
        identity: { owners: [...identity.owners], administrators: [...identity.administrators] } })
    }
    for (const instruction of plugin.agentInstructions ?? []) {
      if (!opaque(instruction.id, 160) || !instruction.id.startsWith(plugin.id + '.') || ids.has(instruction.id) || !opaque(instruction.title, 160)
        || typeof instruction.body !== 'string' || !instruction.body.trim() || instruction.body.length > 50000) throw new PlatformError('AGENT_REGISTRY_INVALID', '插件的代理使用说明无效。', 500)
      ids.add(instruction.id)
      pluginInstructions.push({ ...instruction, pluginId: plugin.id, pluginName: plugin.name, enabled: active })
    }
    if (agentTypes.length + pluginInstructions.length > 256) throw new PlatformError('AGENT_REGISTRY_INVALID', '已注册的代理配置数量超过上限。', 500)
  }
  return { agentTypes, pluginInstructions, bindings: { 主人: JSON.stringify([...owners].sort()), 管理员: JSON.stringify([...administrators].filter(id => !owners.has(id)).sort()) } }
}

interface Actor {
  readonly harnessId: string
  readonly baseScope: AgentInvocationScope
  scope: AgentInvocationScope
  returnedMessageIds: readonly string[]
  receipts: Map<string, AgentActionReceipt>
  tokenHash?: string
}
interface Lease {
  readonly abort: AbortController
  readonly actor: Actor
  readonly plugin: BackendPlugin
  readonly handler: ReturnType<typeof createPluginMcpHandler>
  readonly tokenHash: string
  readonly policy?: import('@eating/plugin-sdk').ScopedAccessPolicy
}

/** Agent credentials are short-lived, memory-only, and independent of owner MCP credentials. */
export class AgentAccessRegistry {
  private readonly actors = new Map<string, Actor>()
  private readonly leases = new Map<string, Lease>()
  private readonly closing = new Set<Promise<void>>()
  private closed = false
  constructor(private readonly plugin: (id: string) => BackendPlugin, private readonly enabled: (id: string) => boolean) {}

  private actorKey(harnessId: string, agentId: string) { return `${harnessId}\0${agentId}` }
  private requireLive(lease: Lease): Actor {
    if (this.closed || this.leases.get(lease.tokenHash) !== lease || !this.enabled(lease.actor.harnessId) || !this.enabled(lease.plugin.id) || lease.policy && !lease.policy.active()) forbidden()
    return lease.actor
  }
  private typeTools(actor: Actor, plugin: BackendPlugin) {
    const type = plugin.agentTypes?.find(candidate => candidate.id === actor.scope.agentTypeId && candidate.conversationKind === actor.scope.kind)
    if (!type || !plugin.invokeScoped) forbidden()
    return plugin.tools.filter(tool => type.availableTools.includes(tool.name) && type.enabledTools.includes(tool.name))
  }
  private remember(receipts: Map<string, AgentActionReceipt>, receipt: AgentActionReceipt) {
    receipts.delete(receipt.requestId)
    receipts.set(receipt.requestId, receipt)
    if (receipts.size > maximumReceipts) receipts.delete(receipts.keys().next().value!)
  }
  private responseMetadata(result: JsonValue): JsonValue | undefined {
    if (result === null) return null
    if (isJsonObject(result) && (typeof result.message_id === 'string' || typeof result.message_id === 'number')) return { message_id: result.message_id }
    return undefined
  }
  private async invoke(lease: Lease, name: string, input: unknown, requestId: string): Promise<JsonValue> {
    const actor = this.requireLive(lease)
    const receipts = actor.receipts
    const tool = this.typeTools(actor, lease.plugin).find(candidate => candidate.name === name && (!lease.policy || lease.policy.toolNames.includes(candidate.name)) && (!(actor.scope.readOnly === true || lease.policy?.readOnly === true) || candidate.readOnly === true))
    if (!tool || !isJsonObject(input)) forbidden()
    const args: JsonObject = { ...input }
    let scopedRequestId = requestId
    if (!tool.readOnly) {
      if (args.request_id !== requestId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(requestId)) forbidden()
      scopedRequestId = 'agent-' + createHash('sha256').update(actor.scope.agentId + '\0' + requestId).digest('hex')
      args.request_id = scopedRequestId
    }
    try {
      const result = await lease.plugin.invokeScoped!(name, args, scopedRequestId, { ...actor.scope, signal: lease.abort.signal })
      if (!tool.readOnly) {
        const metadata = this.responseMetadata(result)
        this.remember(receipts, { requestId, tool: name, outcome: 'succeeded', ...(metadata !== undefined ? { result: metadata } : {}) })
        if (isJsonObject(result) && (typeof result.message_id === 'string' || typeof result.message_id === 'number') && opaque(String(result.message_id), 2048)) {
          actor.returnedMessageIds = boundedReferences([...actor.returnedMessageIds, String(result.message_id)])
          actor.scope = { ...actor.baseScope, messageIds: [...new Set([...actor.baseScope.messageIds, ...actor.returnedMessageIds])] }
        }
      }
      return result
    } catch (cause) {
      if (!tool.readOnly) {
        const error = cause instanceof PlatformError ? cause : new PlatformError('ACTION_OUTCOME_UNKNOWN', '动作结果待核对。', 500, 'unknown')
        this.remember(receipts, { requestId, tool: name, outcome: error.outcome, code: error.code })
      }
      throw cause
    }
  }

  issue(harnessId: string, pluginId: string, scope: AgentInvocationScope, baseUrl: string, policy?: import('@eating/plugin-sdk').ScopedAccessPolicy): AgentMcpConnection {
    if (policy && (typeof policy.active !== 'function' || !policy.active() || policy.readOnly !== undefined && typeof policy.readOnly !== 'boolean' || !Array.isArray(policy.toolNames) || policy.toolNames.length === 0 && policy.readOnly !== true && scope.readOnly !== true || policy.toolNames.some(name => !opaque(name, 160)))) forbidden()
    if (this.closed || !this.enabled(harnessId) || !this.enabled(pluginId) || scope.readOnly !== undefined && typeof scope.readOnly !== 'boolean' || scope.pluginId !== pluginId || !opaque(scope.agentId, 160) || !opaque(scope.agentTypeId, 160)
      || !opaque(scope.instanceId, 160) || !opaque(scope.accountId, 160) || !opaque(scope.conversationId) || !opaque(scope.targetId, 160)
      || !['private', 'group'].includes(scope.kind) || !Array.isArray(scope.messageIds) || !Array.isArray(scope.resourceIds)
      || !validReferences(scope.messageIds, scope.resourceIds)) forbidden()
    const plugin = this.plugin(pluginId)
    const key = this.actorKey(harnessId, scope.agentId)
    const previous = this.actors.get(key)
    if (previous && ['pluginId', 'instanceId', 'accountId', 'conversationId', 'agentTypeId', 'kind', 'targetId'].some(field => previous.scope[field as keyof AgentInvocationScope] !== scope[field as keyof AgentInvocationScope])) forbidden()
    if (!previous && this.actors.size >= maximumAgents) throw new PlatformError('TOO_MANY_SCOPED_AGENTS', '当前代理数量达到上限，请先停止不再使用的代理。', 429, 'not-sent')
    const baseScope = { ...structuredClone(scope), ...(policy?.readOnly === true ? { readOnly: true } : {}),
      messageIds: [...new Set([...(previous && !policy ? boundedReferences(previous.scope.messageIds) : []), ...scope.messageIds])],
      resourceIds: [...new Set([...(previous && !policy ? boundedReferences(previous.scope.resourceIds) : []), ...scope.resourceIds])] }
    const actor: Actor = { harnessId, baseScope, scope: baseScope, returnedMessageIds: [], receipts: new Map() }
    const currentTools = this.typeTools(actor, plugin)
    if (policy && policy.toolNames.some(name => !currentTools.some(tool => tool.name === name))) forbidden()
    const scopedPolicy = policy ? { toolNames: [...policy.toolNames], active: policy.active, ...(policy.readOnly !== undefined ? { readOnly: policy.readOnly } : {}) } : undefined
    const selectedTools = () => this.typeTools(actor, plugin).filter(tool => (!scopedPolicy || scopedPolicy.toolNames.includes(tool.name)) && (actor.scope.readOnly !== true || tool.readOnly === true))
    const toolNames = Object.freeze(selectedTools().map(tool => tool.name))
    const token = secret(), tokenHash = createHash('sha256').update(token).digest('hex')
    let lease: Lease
    const registry = this
    const view: BackendPlugin = {
      id: plugin.id, kind: plugin.kind, name: plugin.name, version: plugin.version, capabilities: [],
      get tools() { registry.requireLive(lease); return selectedTools() },
      getStatus: () => plugin.getStatus(), getPublicConfiguration: () => ({}),
      updateConfiguration: async () => forbidden(), connect: async () => forbidden(), disconnect: async () => {}, dispose: async () => {},
      invoke: (name, input, requestId) => registry.invoke(lease, name, input, requestId),
    }
    lease = { actor, plugin, tokenHash, abort: new AbortController(), handler: createPluginMcpHandler(view), ...(scopedPolicy ? { policy: scopedPolicy } : {}) }
    if (previous?.tokenHash) this.retire(previous.tokenHash)
    actor.tokenHash = tokenHash
    this.actors.set(key, actor)
    this.leases.set(tokenHash, lease)
    return Object.freeze({ toolNames, url: `${baseUrl}/mcp/${pluginId}`, headers: Object.freeze({ Authorization: `Bearer ${token}` }) })
  }

  private retire(hash: string) {
    const lease = this.leases.get(hash)
    if (!lease) return
    this.leases.delete(hash)
    lease.abort.abort()
    if (lease.actor.tokenHash === hash) lease.actor.tokenHash = undefined
    const task = lease.handler.close().finally(() => this.closing.delete(task))
    this.closing.add(task)
    void task.catch(() => {})
  }
  recognizes(token: string | undefined, pluginId: string): boolean {
    if (!token || token.length > 256) return false
    const lease = this.leases.get(createHash('sha256').update(token).digest('hex'))
    return Boolean(lease && lease.plugin.id === pluginId)
  }
  async handle(token: string | undefined, pluginId: string, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<boolean> {
    if (!token || token.length > 256) return false
    const lease = this.leases.get(createHash('sha256').update(token).digest('hex'))
    if (!lease || lease.plugin.id !== pluginId) return false
    this.requireLive(lease)
    await lease.handler.handle(request, response, body)
    return true
  }
  actions(harnessId: string, agentId: string): readonly AgentActionReceipt[] {
    return structuredClone([...this.actors.get(this.actorKey(harnessId, agentId))?.receipts.values() ?? []])
  }
  revokeAgent(harnessId: string, agentId: string) {
    const actor = this.actors.get(this.actorKey(harnessId, agentId))
    if (actor?.tokenHash) this.retire(actor.tokenHash)
  }
  revokeHarness(harnessId: string) {
    for (const [key, actor] of this.actors) if (actor.harnessId === harnessId) { if (actor.tokenHash) this.retire(actor.tokenHash); this.actors.delete(key) }
  }
  revokePlugin(pluginId: string) {
    for (const [key, actor] of this.actors) if (actor.scope.pluginId === pluginId) { if (actor.tokenHash) this.retire(actor.tokenHash); this.actors.delete(key) }
  }
  async close() {
    this.closed = true
    for (const hash of [...this.leases.keys()]) this.retire(hash)
    this.actors.clear()
    await Promise.allSettled([...this.closing])
  }
}
