import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentInvocationScope, BackendPluginEntry, HarnessHostServices, JsonObject, ScopedAccessPolicy } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { EatingHost } from './app'
import { DshProactivePolicy } from '../../../plugins/harness/dsh/src/backend/proactive-policy'
import { AUTONOMY_DEFAULTS, DshAutonomy } from '../../../plugins/harness/dsh/src/backend/autonomy'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const parent = await realpath(tmpdir())
  const home = await realpath(await mkdtemp(join(parent, 'Eating_agent_access_')))
  cleanups.push(async () => {
    const actual = await realpath(home)
    if (actual !== home || dirname(actual) !== parent || !basename(actual).startsWith('Eating_agent_access_')) throw new Error('Unsafe agent scope test cleanup')
    await rm(actual, { recursive: true })
  })
  const onebot = await startOneBotFixture(); cleanups.push(() => onebot.close())
  let services!: HarnessHostServices
  const harness: BackendPluginEntry = { id: 'test-harness', kind: 'harness', storageDirectory: 'test-harness', create: context => {
    services = context.harness!
    return { id: 'test-harness', kind: 'harness', name: 'Scope protocol fixture', version: '1.0.0', tools: [], capabilities: [],
      getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null, dispose: async () => {} }
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, harness], port: 0, allowedUiOrigins: [] })
  cleanups.push(() => host.close())
  const url = await host.listen()
  const bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await bootstrap.json() as { csrfToken: string }
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': csrfToken, 'Content-Type': 'application/json', Origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json() as JsonObject
    if (!response.ok) throw new Error(`Test owner request failed ${path}: ${JSON.stringify(value)}`)
    return value
  }
  await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000 })
  await api('/plugins/qq/connect', {})
  const configuration = await api('/plugins/qq/configuration')
  const instanceId = String(configuration.instanceId)
  const scope = (agentId = randomUUID(), kind: 'private' | 'group' = 'private'): AgentInvocationScope => ({ agentId, agentTypeId: `qq.${kind}`, pluginId: 'qq', instanceId, accountId: '123456789', conversationId: `qq:123456789:${kind}:${kind === 'private' ? '987654321' : '123456'}`, kind, targetId: kind === 'private' ? '987654321' : '123456', messageIds: ['42'], resourceIds: ['known-image.jpg'] })
  const client = async (binding: AgentInvocationScope, policy?: ScopedAccessPolicy, taskId?: string) => {
    const connection = services.getMcpConnection('qq', binding, policy, taskId)
    const mcp = new Client({ name: 'Eating-scoped-agent-fixture', version: '1.0.0' })
    cleanups.push(() => mcp.close())
    await mcp.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers, Origin: url } } }))
    return { mcp, connection }
  }
  return { host, home, onebot, get services() { return services }, harness, api, scope, client, url, configuration }
}

describe('Host scoped agent MCP and plugin prompt registry', () => {
  it('retains receipts for two tasks sharing a child across Host restart without repeating either send', async () => {
    const f = await setup(), scope = f.scope(), firstId = 'a'.repeat(64), secondId = 'b'.repeat(64)
    const first = await f.client(scope, undefined, firstId)
    expect(await first.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: scope.targetId, message: 'FIRST-TASK-FIXTURE', request_id: 'task-receipt-first-001' } })).toMatchObject({ isError: false })
    expect(f.services.finishTaskActions(scope.agentId, firstId)).toMatchObject({ available: true, closed: true, actions: [{ outcome: 'succeeded', result: { message_id: 1001 } }] })
    f.services.revokeAgentAccess(scope.agentId)
    const second = await f.client(scope, undefined, secondId)
    expect(await second.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: scope.targetId, message: 'SECOND-TASK-FIXTURE', request_id: 'task-receipt-second-001' } })).toMatchObject({ isError: false })
    f.services.finishTaskActions(scope.agentId, secondId)
    await f.host.close()
    const restored = new EatingHost({ dataDirectory: f.home, entries: [qqEntry, f.harness], port: 0, allowedUiOrigins: [] })
    cleanups.push(() => restored.close()); await restored.listen()
    expect(f.services.readTaskActions(scope.agentId, firstId)).toMatchObject({ actions: [{ requestId: 'task-receipt-first-001', result: { message_id: 1001 } }] })
    expect(f.services.readTaskActions(scope.agentId, secondId)).toMatchObject({ actions: [{ requestId: 'task-receipt-second-001', result: { message_id: 1002 } }] })
    expect(f.onebot.requests.filter(r => r.action === 'send_private_msg')).toHaveLength(2)
    expect(f.services.readTaskActions('other-child', firstId).available).toBe(false)
  })

  it.each([false, true])('adds references to a live MCP without rotating its token or changing verify=%s', async readOnly => {
    const f = await setup(), source = { ...f.scope(), ...(readOnly ? { readOnly: true } : {}) }
    const lease = await f.client(source)
    const token = lease.connection.headers.Authorization
    expect(await lease.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '43' } })).toMatchObject({ isError: true })
    f.services.extendAgentScope({ ...source, messageIds: [...source.messageIds, '43'], resourceIds: [...source.resourceIds, 'new-image'] })
    expect(lease.connection.headers.Authorization).toBe(token)
    expect(await lease.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '43' } })).toMatchObject({ isError: false })
    expect(await lease.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '42' } })).toMatchObject({ isError: false })
    for (const patch of [{ targetId: 'other' }, { resourceIds: [] }, ...(readOnly ? [{ readOnly: false }] : [])]) expect(() => f.services.extendAgentScope({ ...source, ...patch })).toThrow()
    if (readOnly) expect((await lease.mcp.listTools()).tools.some(tool => tool.name === 'qq_send_private_message')).toBe(false)
    f.services.revokeAgentAccess(source.agentId)
    await expect(lease.mcp.listTools()).rejects.toThrow()
    expect(f.onebot.requests.filter(request => request.action.startsWith('send_'))).toEqual([])
  })

  it.each(['scope', 'policy'] as const)('enforces %s verify reads on real MCP calls and restores writes only with a fresh reply lease', async mode => {
    const f = await setup(), binding = f.scope()
    const original = await f.client(binding)
    const policy = { toolNames: ['qq_get_message', 'qq_send_private_message'], active: () => true, ...(mode === 'policy' ? { readOnly: true } : {}) }
    const verify = await f.client({ ...binding, ...(mode === 'scope' ? { readOnly: true } : {}) }, policy)
    expect(verify.connection.toolNames).toEqual(['qq_get_message'])
    expect((await verify.mcp.listTools()).tools.map(tool => tool.name)).toEqual(verify.connection.toolNames)
    await expect(original.mcp.listTools()).rejects.toThrow()
    expect(await verify.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '42' } })).toMatchObject({ isError: false })
    const before = f.onebot.requests.length
    const registry = Reflect.get(f.host, 'agentAccess'), lease = [...Reflect.get(registry, 'leases').values()].find(candidate => candidate.actor.scope.agentId === binding.agentId)
    await expect(Reflect.get(registry, 'invoke').call(registry, lease, 'qq_send_private_message', { user_id: binding.targetId, message: 'Direct guard denied', request_id: 'verify-direct-denied' }, 'verify-direct-denied')).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', statusCode: 403, outcome: 'not-sent' })
    expect(await verify.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'Denied verify send', request_id: 'verify-denied-send' } })).toMatchObject({ isError: true, structuredContent: { outcome: 'not-sent' } })
    expect(f.onebot.requests).toHaveLength(before)
    expect(() => f.services.getMcpConnection('qq', binding, { ...policy, toolNames: ['qq_send_group_message'] })).toThrow()
    expect(await verify.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '42' } })).toMatchObject({ isError: false })
    const reply = await f.client(binding)
    await expect(verify.mcp.listTools()).rejects.toThrow()
    expect(reply.connection.toolNames).toContain('qq_send_private_message')
    expect(await reply.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'Restored reply fixture', request_id: 'verify-restored-reply' } })).toMatchObject({ isError: false })
    expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
  })

  it('connects an empty verify MCP when the authorized type selection contains no reads', async () => {
    const f = await setup(), binding = f.scope()
    const first = await f.client(binding)
    const verify = await f.client(binding, { toolNames: ['qq_send_private_message'], readOnly: true, active: () => true })
    expect(verify.connection.toolNames).toEqual([])
    expect((await verify.mcp.listTools()).tools).toEqual([])
    await expect(first.mcp.listTools()).rejects.toThrow()
    const before = f.onebot.requests.length
    const registry = Reflect.get(f.host, 'agentAccess'), lease = [...Reflect.get(registry, 'leases').values()].find(candidate => candidate.actor.scope.agentId === binding.agentId)
    await expect(Reflect.get(registry, 'invoke').call(registry, lease, 'qq_send_private_message', { user_id: binding.targetId, message: 'Direct guard denied', request_id: 'verify-direct-denied' }, 'verify-direct-denied')).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', statusCode: 403, outcome: 'not-sent' })
    expect(await verify.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'Never sent', request_id: 'verify-empty-read' } })).toMatchObject({ isError: true, structuredContent: { outcome: 'not-sent' } })
    expect(f.onebot.requests).toHaveLength(before)
  })

  it('discovers real joined groups and applies object deny lists to an actual scoped MCP task and in-flight revocation', async () => {
    const f = await setup(), channel = f.services.readProactiveChannels!().find(channel => channel.kind === 'group')!
    const joined = await f.services.readProactiveContacts!('qq', { instanceId: channel.instanceId, accountId: channel.accountId, agentTypeId: channel.agentTypeId })
    expect(joined).toEqual([{ id: '123456', name: '夹具测试群' }])
    expect(await f.services.readProactiveContacts!('qq', { instanceId: channel.instanceId, accountId: channel.accountId, agentTypeId: 'qq.private' })).toEqual([{ id: f.scope().targetId, name: '夹具联系人' }])
    const policies = new DshProactivePolicy(join(f.home, 'contact-policy'), f.services)
    policies.commit(policies.prepare({ expectedRevision: 0, mode: 'all', entries: [] }))
    const agentId = randomUUID(), activity = new DshAutonomy(join(f.home, 'group-rules'), () => true, () => {}, () => f.services.revokeAgentAccess(agentId))
    activity.setTargetDirectory(() => policies.targets())
    await activity.configure({ expectedRevision: 0, configuration: { ...AUTONOMY_DEFAULTS, enabled: true } }); activity.startRuntime('group-nonce')
    let state = activity.snapshot(); await activity.control('resume', { expectedRevision: state.revision, expectedActivityRevision: (state.state as JsonObject).revision })
    const admitted = activity.claim('group-nonce') as JsonObject, cycleId = String((admitted.cycle as JsonObject).id), target = (await activity.listTargets()).find(target => target.agentTypeId === 'qq.group')!
    const scope = f.services.prepareProactiveScope!('qq', { ...target, agentId }); expect(scope.messageIds).toEqual([]); expect(scope.resourceIds).toEqual([])
    const issued = await f.client(scope, { toolNames: target.toolNames, active: () => activity.validCycle('group-nonce', cycleId) && activity.contactTargetStillAllowed(target) })
    const wrong = await issued.mcp.callTool({ name: 'qq_send_group_message', arguments: { group_id: '999999', message: 'wrong group fixture', request_id: 'group-wrong-1' } }); expect(wrong.isError).toBe(true)
    expect((await issued.mcp.callTool({ name: 'qq_send_group_message', arguments: { group_id: '123456', message: 'loopback-only group fixture', request_id: 'group-before-1' } })).isError).toBe(false)
    const next = policies.prepare({ expectedRevision: 1, mode: 'denylist', entries: [{ pluginId: target.pluginId, instanceId: target.instanceId, accountId: target.accountId, agentTypeId: target.agentTypeId, targetId: target.targetId, label: target.label }] })
    state = activity.snapshot(); await activity.control('pause', { expectedRevision: state.revision, expectedActivityRevision: (state.state as JsonObject).revision }); activity.invalidateTargets(); policies.commit(next)
    expect((await activity.listTargets()).every(target => target.agentTypeId === 'qq.private')).toBe(true)
    const after = await issued.mcp.callTool({ name: 'qq_send_group_message', arguments: { group_id: '123456', message: 'must never reach fixture', request_id: 'group-after-1' } }).catch(() => ({ isError: true })); expect(after.isError).toBe(true)
    expect(f.onebot.requests.filter(request => request.action === 'send_group_msg')).toHaveLength(1)
  })

  it('derives a proactive scope from the real account, limits its tools and rejects expired authority before a write', async () => {
    const f = await setup()
    const channels = f.services.readProactiveChannels!()
    const channel = channels.find(channel => channel.agentTypeId === 'qq.private')!
    const request = { instanceId: channel.instanceId, accountId: channel.accountId, agentTypeId: channel.agentTypeId, targetId: '987654321', agentId: randomUUID() }
    const binding = f.services.prepareProactiveScope!('qq', request)
    expect(binding).toMatchObject({ accountId: '123456789', targetId: '987654321', messageIds: [], resourceIds: [] })
    expect(() => f.services.prepareProactiveScope!('qq', { ...request, accountId: 'different-account' })).toThrow()
    let active = true
    const { mcp } = await f.client(binding, { toolNames: ['qq_send_private_message'], active: () => active })
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(['qq_send_private_message'])
    const before = f.onebot.requests.length
    expect(await mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: '111111111', message: 'DENIED-PROACTIVE-TARGET', request_id: 'proactive-wrong-target' } })).toMatchObject({ isError: true })
    expect(f.onebot.requests).toHaveLength(before)
    active = false
    await expect(mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'DENIED-EXPIRED-AUTHORITY', request_id: 'proactive-expired' } })).rejects.toThrow()
    expect(f.onebot.requests).toHaveLength(before)
  })

  it('does not inherit message or media references when rotating an actor into a proactive task', async () => {
    const f = await setup(), binding = f.scope()
    const first = await f.client(binding)
    expect(await first.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '42' } })).toMatchObject({ isError: false })
    f.services.revokeAgentAccess(binding.agentId)
    const next = await f.client({ ...binding, messageIds: [], resourceIds: [] }, { toolNames: ['qq_send_private_message', 'qq_get_message'], active: () => true })
    const before = f.onebot.requests.length
    expect(await next.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '42' } })).toMatchObject({ isError: true })
    expect(f.onebot.requests).toHaveLength(before)
  })

  it('publishes dynamic role and instruction prompts with real owner identity bindings and saved preview', async () => {
    const { api, configuration, services } = await setup()
    const saved = await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: configuration.policyRevision, owners: ['987654321', '1234567890'], administrators: ['111111111'], agentTools: configuration.agentTools } })
    expect(saved.owners).toEqual(['987654321', '1234567890'])
    const snapshot = await api('/authoring')
    expect((snapshot.prompts as JsonObject[]).map(prompt => prompt.id)).toEqual(expect.arrayContaining(['common', 'subagent', 'main', 'agent:qq.private', 'agent:qq.group', 'plugin:qq.instructions']))
    const preview = await api('/authoring/preview', { agentTypeId: 'qq.private' })
    expect((preview.layers as JsonObject[]).map(layer => layer.id)).toEqual(['common', 'subagent', 'agent:qq.private', 'persona'])
    expect(preview.systemPrompt).toContain('987654321')
    const owner = services.readOwnerConfiguration()
    expect(owner.agentTypes?.map(type => type.id)).toEqual(['qq.private', 'qq.group'])
    expect(owner.bindings?.主人).toBe('["1234567890","987654321"]')
    expect(owner.bindings?.管理员).toBe('["111111111"]')
  })

  it('lists only role tools and denies cross-type, target and unrelated source reads before OneBot', async () => {
    const { client, scope, onebot } = await setup()
    const { mcp } = await client(scope())
    const tools = await mcp.listTools()
    expect(tools.tools.map(tool => tool.name)).toContain('qq_send_private_message')
    for (const denied of ['qq_send_group_message', 'qq_get_credentials', 'qq_set_restart', 'qq_get_friend_list']) expect(tools.tools.map(tool => tool.name)).not.toContain(denied)
    const before = onebot.requests.length
    expect(await mcp.callTool({ name: 'qq_send_group_message', arguments: { group_id: '123456', message: 'deny', request_id: 'scope-denied-group' } })).toMatchObject({ isError: true, structuredContent: { outcome: 'not-sent' } })
    expect(await mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: '777777777', message: 'deny', request_id: 'scope-denied-target' } })).toMatchObject({ isError: true, structuredContent: { code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' } })
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '43' } })).toMatchObject({ isError: true, structuredContent: { code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' } })
    expect(onebot.requests).toHaveLength(before)
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '42' } })).toMatchObject({ isError: false })
    expect(onebot.requests.at(-1)?.action).toBe('get_msg')
  })

  it('namespaces stable write IDs per agent, records actual receipts and grants its own sent message reference', async () => {
    const { client, scope, onebot, services, home } = await setup()
    const first = scope(), second = scope()
    const a = await client(first), b = await client(second)
    const args = { user_id: '987654321', message: 'Loopback scope message', request_id: 'same-caller-request' }
    const result = await a.mcp.callTool({ name: 'qq_send_private_message', arguments: args })
    expect(result.isError).toBe(false)
    await a.mcp.callTool({ name: 'qq_send_private_message', arguments: args })
    await b.mcp.callTool({ name: 'qq_send_private_message', arguments: args })
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(2)
    const receipts = services.readAgentActions!(first.agentId)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ requestId: args.request_id, tool: 'qq_send_private_message', outcome: 'succeeded' })
    const messageId = String((receipts[0]!.result as JsonObject).message_id)
    expect(await a.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: messageId } })).toMatchObject({ isError: false })
    expect(await b.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: messageId } })).toMatchObject({ isError: true })
    const database = new DatabaseSync(join(home, 'host', 'Eating.sqlite'), { readOnly: true })
    try { expect(database.prepare('SELECT request_id FROM actions').all()).toHaveLength(2) } finally { database.close() }
  })

  it.each([201, 301, 1000])('keeps all %i task message and resource references through lease rotation and a returned action', async count => {
    const f = await setup(), initial = f.scope()
    await f.client(initial)
    const binding = { ...initial, messageIds: Array.from({ length: count }, (_, index) => String(10000 + index)), resourceIds: Array.from({ length: count }, (_, index) => `batch-image-${index}.jpg`) }
    const { mcp } = await f.client(binding)
    for (const index of [0, Math.floor(count / 2), count - 1]) {
      expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[index] } })).toMatchObject({ isError: false })
      expect(await mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds[index] } })).toMatchObject({ isError: false })
    }
    const sent = await mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'Large scoped batch fixture', request_id: 'large-batch-action' } })
    expect(sent.isError).toBe(false)
    const messageId = String((f.services.readAgentActions!(binding.agentId)[0]!.result as JsonObject).message_id)
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).toMatchObject({ isError: false })
    expect(await mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds[0] } })).toMatchObject({ isError: false })
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: messageId } })).toMatchObject({ isError: false })
    const before = f.onebot.requests.length
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: '99999999' } })).toMatchObject({ isError: true })
    expect(await mcp.callTool({ name: 'qq_get_image', arguments: { file: 'https://untrusted.invalid/ungranted.jpg' } })).toMatchObject({ isError: true })
    expect(f.onebot.requests).toHaveLength(before)
    f.services.revokeAgentAccess(binding.agentId)
    await expect(mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).rejects.toThrow()
    expect(f.onebot.requests).toHaveLength(before)
  })

  it('accepts 100000 references per class and bounds inherited history independently of the current task', async () => {
    const f = await setup(), initial = f.scope()
    const binding = { ...initial, messageIds: Array.from({ length: 100000 }, (_, index) => String(10000 + index)), resourceIds: Array.from({ length: 100000 }, (_, index) => `capacity-image-${index}.jpg`) }
    await f.client(initial)
    const first = await f.client(binding)
    expect(await first.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).toMatchObject({ isError: false })
    expect(await first.mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds[0] } })).toMatchObject({ isError: false })
    const next = await f.client(initial)
    expect(await next.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).toMatchObject({ isError: true })
    expect(await next.mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds[0] } })).toMatchObject({ isError: true })
    expect(await next.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds.at(-256) } })).toMatchObject({ isError: false })
    expect(await next.mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds.at(-256) } })).toMatchObject({ isError: false })
    expect(await next.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds.at(-257) } })).toMatchObject({ isError: true })
    expect(await next.mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds.at(-257) } })).toMatchObject({ isError: true })
    expect(await next.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: initial.messageIds[0] } })).toMatchObject({ isError: false })
  })

  it('bounds returned action references without evicting any current task input', async () => {
    const f = await setup(), initial = f.scope()
    const binding = { ...initial, messageIds: Array.from({ length: 1000 }, (_, index) => String(10000 + index)), resourceIds: Array.from({ length: 1000 }, (_, index) => `action-image-${index}.jpg`) }
    const { mcp } = await f.client(binding)
    const sentIds: string[] = []
    for (let index = 0; index < 257; index++) {
      const requestId = `bounded-action-${index}`
      expect(await mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'Bounded action history fixture', request_id: requestId } })).toMatchObject({ isError: false })
      sentIds.push(String((f.services.readAgentActions!(binding.agentId).find(receipt => receipt.requestId === requestId)!.result as JsonObject).message_id))
    }
    expect(f.services.readAgentActions!(binding.agentId)).toHaveLength(100)
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: sentIds[0] } })).toMatchObject({ isError: true })
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: sentIds[1] } })).toMatchObject({ isError: false })
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: sentIds.at(-1) } })).toMatchObject({ isError: false })
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).toMatchObject({ isError: false })
    expect(await mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds[0] } })).toMatchObject({ isError: false })
  })

  it('rejects reference count, combined UTF8 byte and policy overflow without replacing the live actor or lease', async () => {
    const f = await setup(), binding = f.scope(), { mcp } = await f.client(binding)
    expect(await mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: binding.targetId, message: 'Preserve live lease fixture', request_id: 'preserve-live-lease' } })).toMatchObject({ isError: false })
    const receipts = f.services.readAgentActions!(binding.agentId)
    const wideReference = '图'.repeat(2048)
    const rejected = [
      { ...binding, messageIds: Array.from({ length: 100001 }, (_, index) => String(index)) },
      { ...binding, resourceIds: Array.from({ length: 100001 }, (_, index) => `resource-${index}`) },
      { ...binding, messageIds: Array(9000).fill(wideReference) as string[], resourceIds: Array(9000).fill(wideReference) as string[] },
      { ...binding, messageIds: ['x'.repeat(2049)] },
      { ...binding, resourceIds: ['invalid\nreference'] },
    ]
    for (const invalid of rejected) expect(() => f.services.getMcpConnection('qq', invalid)).toThrow(expect.objectContaining({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' }))
    expect(() => f.services.getMcpConnection('qq', binding, { toolNames: ['qq_send_group_message'], active: () => true })).toThrow()
    expect(f.services.readAgentActions!(binding.agentId)).toEqual(receipts)
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).toMatchObject({ isError: false })
    expect(await mcp.callTool({ name: 'qq_get_image', arguments: { file: binding.resourceIds[0] } })).toMatchObject({ isError: false })
    const sentId = String((receipts[0]!.result as JsonObject).message_id)
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: sentId } })).toMatchObject({ isError: false })
  })

  it('rejects exact scope changes including conversation aliases while preserving the original lease', async () => {
    const f = await setup(), binding = f.scope(), { mcp } = await f.client(binding)
    const changes: ReadonlyArray<Partial<AgentInvocationScope>> = [
      { pluginId: 'other-plugin' }, { instanceId: 'other-instance' }, { accountId: 'other-account' },
      { conversationId: 'same-target-alias' }, { agentTypeId: 'qq.group' }, { kind: 'group' }, { targetId: '123456' },
    ]
    for (const change of changes) expect(() => f.services.getMcpConnection('qq', { ...binding, ...change })).toThrow()
    expect(await mcp.callTool({ name: 'qq_get_message', arguments: { message_id: binding.messageIds[0] } })).toMatchObject({ isError: false })
  })

  it('starts a fresh receipt set for the next task while retaining authorized conversation references', async () => {
    const { client, scope, services } = await setup()
    const binding = scope()
    const first = await client(binding)
    await first.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: 'First scoped task', request_id: 'first-task-request' } })
    const messageId = String((services.readAgentActions!(binding.agentId)[0]!.result as JsonObject).message_id)
    services.revokeAgentAccess!(binding.agentId)
    const next = await client(binding)
    expect(services.readAgentActions!(binding.agentId)).toEqual([])
    expect(await next.mcp.callTool({ name: 'qq_get_message', arguments: { message_id: messageId } })).toMatchObject({ isError: false })
    await next.mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: 'Second scoped task', request_id: 'second-task-request' } })
    expect(services.readAgentActions!(binding.agentId).map(receipt => receipt.requestId)).toEqual(['second-task-request'])
  })

  it('applies policy revocation on every call and retires credentials at rotation, finish and Harness disable', async () => {
    const { client, scope, services, api, configuration, url, onebot } = await setup()
    const binding = scope(), { mcp, connection } = await client(binding)
    const tools = structuredClone(configuration.agentTools) as JsonObject
    tools['qq.private'] = (tools['qq.private'] as string[]).filter(name => name !== 'qq_send_private_message')
    await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: configuration.policyRevision, owners: [], administrators: [], agentTools: tools } })
    expect((await mcp.listTools()).tools.map(tool => tool.name)).not.toContain('qq_send_private_message')
    const before = onebot.requests.length
    expect(await mcp.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: 'deny', request_id: 'revoked-operation' } })).toMatchObject({ isError: true })
    expect(onebot.requests).toHaveLength(before)
    services.getMcpConnection('qq', binding)
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    const raw = async (authorization: string) => fetch(url + '/mcp/qq', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Origin: url }, body: JSON.stringify(body) })
    expect((await raw(connection.headers.Authorization!)).status).toBe(401)
    const fresh = services.getMcpConnection('qq', binding)
    services.revokeAgentAccess!(binding.agentId)
    expect((await raw(fresh.headers.Authorization!)).status).toBe(401)
    const last = services.getMcpConnection('qq', binding)
    await api('/plugins/test-harness/disable', {})
    expect((await raw(last.headers.Authorization!)).status).toBe(401)
  })
})
