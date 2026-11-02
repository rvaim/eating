import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, HarnessDeliveryBatch, HarnessHostServices, JsonObject } from '@eating/plugin-sdk'
import { EatingHost } from './app'
import qqEntry from '../../../plugins/communication/qq/src/server'
import memoryEntry from '../../../plugins/capabilities/openviking-memory/src/server'
import { DEFAULT_SETTINGS } from '../../../plugins/capabilities/openviking-memory/src/types'
import { startOpenVikingFixture } from '../../../plugins/capabilities/openviking-memory/src/backend/testing/openviking-fixture'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { const failures: unknown[] = []; for (const stop of stops.splice(0).reverse()) try { await stop() } catch (cause) { failures.push(cause) }; if (failures.length) throw new AggregateError(failures) })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Fixture expected JSON'); return value }
async function until(test: () => boolean | Promise<boolean>, label: string) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 40)) }; throw new Error(label) }
async function home() { const parent = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(parent, 'Eating_openviking_'))); stops.push(async () => { if (await realpath(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('Eating_openviking_')) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true }) }); return directory }
async function ownerApi(host: EatingHost) {
  const url = await host.listen(), boot = await fetch(url + '/api/bootstrap'), csrf = object(await boot.json()).csrfToken, cookie = boot.headers.get('set-cookie')!.split(';')[0]!
  return async (path: string, body?: JsonObject) => { const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-CSRF': String(csrf), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = object(await response.json()); if (!response.ok) throw new Error(path + ' ' + JSON.stringify(value)); return value }
}
async function configureMemory(api: Awaited<ReturnType<typeof ownerApi>>, service: Awaited<ReturnType<typeof startOpenVikingFixture>>) {
  await api('/plugins/openviking-memory/configuration', { expectedRevision: 0, endpoint: service.endpoint, account: service.account, user: service.user, apiKey: service.apiKey, autoConnect: false, timeoutMs: 10000, settings: { ...DEFAULT_SETTINGS } as unknown as JsonObject })
  await api('/plugins/openviking-memory/connect', {})
}
function expectMainMemoryTools(request: JsonObject) {
  if (!Array.isArray(request.tools)) throw new Error('Expected current main tools')
  const names = request.tools.map(tool => String(object(object(tool).function).name)).sort()
  const eating = ['eating_activity_state', 'eating_cancel_scheduled_task', 'eating_contact_target', 'eating_delegate_task', 'eating_list_agent_types', 'eating_list_contact_targets', 'eating_plan_activity', 'eating_schedule_task']
  const memory = ['memory_search', 'memory_read', 'memory_save', 'memory_scopes'].map(name => 'mcp__plugin_openviking_memory__' + name)
  expect(names.filter(name => name.startsWith('eating_') || name.startsWith('mcp__'))).toEqual([...eating, ...memory].sort())
  expect(names).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'edit', 'web_search', 'schedule_create', 'schedule_update']))
  expect(names.some(name => name.startsWith('mcp__qq__'))).toBe(false)
}
function batch(kind: 'private' | 'group', senderId = '200'): HarnessDeliveryBatch { const conversationId = `qq:100:${kind}:200`, stamp = new Date().toISOString(); return { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId, createdAt: stamp, reason: 'quiet-window', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', instanceId: 'fixture', platform: 'qq', accountId: '100', conversationId, senderId, targetId: '200', receivedAt: stamp, source: { trust: 'external', kind, senderRole: 'owner' }, content: 'fixture', text: 'fixture' }] } }

describe('real Host default access and scoped OpenViking MCP', () => {
  it('opens current tools by default, binds them to the current main turn and isolates group reads', async () => {
    const directory = await home(), service = await startOpenVikingFixture(); stops.push(() => service.close())
    let harness!: HarnessHostServices
    const harnessEntry: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { harness = context.harness!; return { id: 'fixture', name: 'Fixture', kind: 'harness', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null, dispose: async () => {} } } }
    const host = new EatingHost({ dataDirectory: directory, entries: [qqEntry, memoryEntry, harnessEntry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host)
    const qq = await api('/plugins/qq/configuration')
    await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { owners: ['200'], administrators: [], agentTools: qq.agentTools!, expectedRevision: qq.policyRevision! } })
    await configureMemory(api, service)
    expect(harness.getCapabilityMcpConnections({ agentId: 'root', agentTypeId: 'main' })[0]!.tools).toEqual(['memory_search', 'memory_read', 'memory_save', 'memory_scopes'])
    const connection = harness.getCapabilityMcpConnections({ agentId: 'root', agentTypeId: 'main' })[0]!
    const client = new Client({ name: 'memory-main-fixture', version: '1' }); stops.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }))
    service.memories.set(`viking://user/${service.user}/peers/qq-100-private-200/memories/preferences/owner.md`, 'fixture owner memory')
    service.memories.set(`viking://user/${service.user}/peers/qq-100-group-200/memories/events/group.md`, 'fixture group memory')
    await harness.memory!.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'owner-turn', batch: batch('private') })
    const ownerRead = await client.callTool({ name: 'memory_search', arguments: { query: 'fixture', all: true } })
    expect(ownerRead.isError).toBe(false); expect(JSON.stringify(ownerRead)).toContain('fixture group memory')
    await harness.memory!.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'group-turn', batch: batch('group') })
    const groupRead = await client.callTool({ name: 'memory_search', arguments: { query: 'fixture', all: true } })
    expect(groupRead).toMatchObject({ isError: true, structuredContent: { code: 'MEMORY_SCOPE_DENIED' } })
    const current = await client.callTool({ name: 'memory_search', arguments: { query: 'fixture' } })
    expect(JSON.stringify(current)).toContain('fixture group memory'); expect(JSON.stringify(current)).not.toContain('fixture owner memory')
    await harness.memory!.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'owner-again', batch: batch('private') })
    const args = { text: 'Explicit stable preference', request_id: 'fixture-memory-save-0001' }
    const saved = await client.callTool({ name: 'memory_save', arguments: args })
    expect(saved.isError).toBe(false)
    await client.callTool({ name: 'memory_save', arguments: args })
    await until(async () => (object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} })).jobs as JsonObject[])[0]?.status === 'completed', 'Explicit extraction did not complete')
    expect(service.submissions).toHaveLength(1); expect(service.archives.size).toBe(0)
    expect(service.sessions.get(service.submissions[0]!.sessionId)!.messages).toMatchObject([{ role: 'user', content: 'Explicit stable preference' }])
    expect(service.requests.filter(request => /\/(?:messages(?:\/batch)?|commit)$/.test(request.path))).toEqual([])
    expect(service.requests.filter(request => request.method === 'DELETE')).toEqual([])
    harness.revokeAgentAccess('root')
    await expect(client.callTool({ name: 'memory_search', arguments: { query: 'fixture' } })).rejects.toThrow()
    expect(service.errors).toEqual([])
  })

  it('automatically records ordinary QQ turns and action receipts without invoking memory tools', async () => {
    const directory = await home(), service = await startOpenVikingFixture(); stops.push(service.close)
    let harness!: HarnessHostServices
    const harnessEntry: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { harness = context.harness!; return { id: 'fixture', name: 'Fixture', kind: 'harness', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null, dispose: async () => {} } } }
    const host = new EatingHost({ dataDirectory: directory, entries: [qqEntry, memoryEntry, harnessEntry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host); await configureMemory(api, service)
    expect(harness.getCapabilityMcpConnections({ agentId: 'root', agentTypeId: 'main' })[0]!.tools).toEqual(['memory_search', 'memory_read', 'memory_save', 'memory_scopes'])
    const root = `viking://user/${service.user}`
    service.memories.set(root + '/memories/preferences/global.md', 'fixture GLOBAL-RECALLED-VALUE')
    service.memories.set(root + '/peers/qq-100-private-200/memories/preferences/current.md', 'fixture LOCAL-RECALLED-VALUE')
    service.memories.set(root + '/peers/qq-100-private-999/memories/preferences/other.md', 'fixture OTHER-PRIVATE-MEMORY')
    for (let round = 0; round < 3; round++) {
      const turnId = `automatic-qq-${round}`, recall = await harness.memory!.begin({ agentId: 'root', agentTypeId: 'main', turnId, batch: batch('private') })
      expect(recall.text).toContain('GLOBAL-RECALLED-VALUE'); expect(recall.text).toContain('LOCAL-RECALLED-VALUE'); expect(recall.text).not.toContain('OTHER-PRIVATE-MEMORY')
      await harness.memory!.finish({ agentId: 'root', turnId, assistantText: `Visible ordinary QQ reply ${round}`, actions: [{ tool: 'qq_send_private_msg', outcome: 'succeeded' }, { tool: 'qq_get_message', outcome: 'returned' }], outcome: 'completed' })
      await until(async () => (object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} })).jobs as JsonObject[]).filter(job => job.status === 'completed').length === round + 1, 'Realtime QQ turn did not extract')
    }
    const remote = service.sessions.get('eating-live-qq-100-private-200')!
    expect(service.sessions.size).toBe(1); expect(remote.messages).toHaveLength(6); expect(remote.archiveUris).toEqual([]); expect(service.archives.size).toBe(0)
    expect(service.submissions.map(item => item.expectedSequence)).toEqual([0, 2, 4]); expect(service.extractions.map(item => item.messages.length)).toEqual([2, 2, 2])
    for (const [round, submission] of service.submissions.entries()) {
      expect(submission.messages).toMatchObject([{ role: 'user', content: expect.stringContaining('fixture') }, { role: 'assistant', content: expect.stringContaining(`Visible ordinary QQ reply ${round}`) }])
      expect(submission.messages[1]!.content).toContain('qq_send_private_msg: succeeded'); expect(submission.messages[1]!.content).toContain('qq_get_message: returned')
      for (const recalled of ['GLOBAL-RECALLED-VALUE', 'LOCAL-RECALLED-VALUE', 'OTHER-PRIVATE-MEMORY']) expect(JSON.stringify(submission.messages)).not.toContain(recalled)
    }
    const state = object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} }))
    expect((state.jobs as JsonObject[]).every(job => job.archiveUri === null)).toBe(true); expect(JSON.stringify(state)).not.toContain('Visible ordinary QQ reply')
    expect(service.requests.filter(request => /\/(?:messages(?:\/batch)?|commit)$/.test(request.path))).toEqual([]); expect(service.requests.filter(request => request.method === 'DELETE')).toEqual([]); expect(service.errors).toEqual([])
    await host.close(); expect((await readFile(join(directory, 'host/Eating.sqlite'))).includes(Buffer.from('Visible ordinary QQ reply'))).toBe(false)
  })
})

describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('system DSH automatic OpenViking memory end to end', () => {
  it('recalls only global and current peer, captures normal QQ replies without invoking memory tools, and keeps a live session without archives', async () => {
    const directory = await home(), service = await startOpenVikingFixture(); stops.push(() => service.close())
    const onebot = await startOneBotFixture({ login: { user_id: 100000101, nickname: 'Memory fixture account' } }); stops.push(() => onebot.close())
    const requests: JsonObject[] = [], reply = 'Automatic memory captured this visible reply'
    const model = createServer((request, response) => { void (async () => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(object(JSON.parse(Buffer.concat(chunks).toString('utf8')))); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const [delta, finish_reason] of [[{ role: 'assistant', content: reply }, null], [{}, 'stop']] as const) response.write(`data: ${JSON.stringify({ id: 'memory-model', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`); response.end('data: [DONE]\n\n') })().catch(() => { response.writeHead(500); response.end() }) })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve)); stops.push(async () => { const closed = new Promise<void>(resolve => model.close(() => resolve())); model.closeAllConnections(); await closed })
    const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === 'string') throw new Error('No fixture model port')
    let dsh!: DshPlugin
    const dshEntry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { dsh = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return dsh } }
    const host = new EatingHost({ dataDirectory: directory, entries: [qqEntry, memoryEntry, dshEntry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host)
    await configureMemory(api, service)
    service.memories.set(`viking://user/${service.user}/memories/preferences/global.md`, 'fixture GLOBAL-RECALLED-VALUE')
    service.memories.set(`viking://user/${service.user}/peers/qq-100000101-private-100000202/memories/preferences/contact.md`, 'fixture LOCAL-RECALLED-VALUE')
    service.memories.set(`viking://user/${service.user}/peers/qq-100000101-private-999999999/memories/preferences/other.md`, 'fixture OTHER-PRIVATE-MEMORY')
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false, forwardToHarness: true, receiveGroups: true })
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: `http://127.0.0.1:${modelAddress.port}/v1`, model: 'fixture-model', apiKey: 'loopback-only', timeoutMs: 30000, maxTokens: 256, autoConnect: false })
    await api('/plugins/dsh/connect', {})
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 100000101, user_id: 100000202, message_id: 2001, message: 'fixture', raw_message: 'fixture' })
    await until(async () => (object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} })).jobs as JsonObject[])[0]?.status === 'completed', 'Automatic memory extraction did not complete')
    expect(requests).toHaveLength(1)
    const wire = JSON.stringify(requests[0]!.messages)
    expect(wire).toContain('GLOBAL-RECALLED-VALUE'); expect(wire).toContain('LOCAL-RECALLED-VALUE'); expect(wire).not.toContain('OTHER-PRIVATE-MEMORY')
    expectMainMemoryTools(requests[0]!)
    const submitted = service.requests.find(request => request.method === 'POST' && request.path.endsWith('/incremental-memory'))!
    expect(JSON.stringify(submitted.body)).toContain(reply)
    for (const recalled of ['GLOBAL-RECALLED-VALUE', 'LOCAL-RECALLED-VALUE', 'OTHER-PRIVATE-MEMORY']) expect(JSON.stringify(submitted.body)).not.toContain(recalled)
    expect(submitted.body).toMatchObject({ expected_sequence: 0, archive_max_bytes: 8 * 1024 * 1024 })
    expect(submitted.headers['x-openviking-actor-peer']).toBe('qq-100000101-private-100000202')
    const sessionId = 'eating-live-qq-100000101-private-100000202', remote = service.sessions.get(sessionId)!
    expect(remote.policy).toMatchObject({ peer: { enabled: true }, self: { enabled: true } })
    expect(remote.messages).toEqual(submitted.body.messages)
    expect(remote.messages).toMatchObject([{ role: 'user', content: expect.stringContaining('fixture') }, { role: 'assistant', content: reply }])
    expect(remote.archiveUris).toEqual([]); expect(service.archives.size).toBe(0)
    expect(service.requests.filter(request => request.method === 'DELETE')).toEqual([])
    expect(service.requests.filter(request => /\/(?:messages(?:\/batch)?|commit)$/.test(request.path))).toEqual([])
    expect(service.requests.filter(request => request.path.includes('/tasks/'))).toEqual([])
    const state = object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} }))
    expect((state.jobs as JsonObject[])[0]).toMatchObject({ status: 'completed', sessionId, peerId: 'qq-100000101-private-100000202', archiveUri: null, changes: { added: 1, updated: 2, deleted: 0 } })
    for (const body of [reply, 'GLOBAL-RECALLED-VALUE', 'LOCAL-RECALLED-VALUE', 'OTHER-PRIVATE-MEMORY']) expect(JSON.stringify(state)).not.toContain(body)
    expect(service.errors).toEqual([])
    await dsh.disconnect(); await dsh.connect()
    expect(requests).toHaveLength(1); expect(service.submissions).toHaveLength(1)
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 100000101, user_id: 100000202, message_id: 2002, message: 'fixture second round', raw_message: 'fixture second round' })
    await until(async () => (object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} })).jobs as JsonObject[]).filter(job => job.status === 'completed').length === 2, 'Second live-session extraction did not complete')
    expect(requests).toHaveLength(2); expect(service.sessions.size).toBe(1); expect(service.submissions.map(item => item.expectedSequence)).toEqual([0, 2])
    expect(remote.messages).toHaveLength(4); expect(service.extractions.map(item => item.messages.length)).toEqual([2, 2]); expect(service.archives.size).toBe(0)
    expect(service.requests.filter(request => request.method === 'POST' && request.path.endsWith('/sessions'))).toHaveLength(1)
    for (const request of requests) expectMainMemoryTools(request)
    await host.close()
    const sqlite = await readFile(join(directory, 'host/Eating.sqlite'))
    expect(sqlite.includes(Buffer.from(reply))).toBe(false)
  }, 60000)
})
