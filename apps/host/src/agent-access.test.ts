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
  const client = async (binding: AgentInvocationScope, policy?: ScopedAccessPolicy) => {
    const connection = services.getMcpConnection('qq', binding, policy)
    const mcp = new Client({ name: 'Eating-scoped-agent-fixture', version: '1.0.0' })
    cleanups.push(() => mcp.close())
    await mcp.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers, Origin: url } } }))
    return { mcp, connection }
  }
  return { host, home, onebot, services, api, scope, client, url, configuration }
}

describe('Host scoped agent MCP and plugin prompt registry', () => {
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
