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
  await api('/plugins/openviking-memory/configuration', { expectedRevision: 0, endpoint: service.endpoint, account: service.account, user: service.user, apiKey: service.apiKey, autoConnect: false, timeoutMs: 10000, settings: { ...DEFAULT_SETTINGS, submissionMode: 'turn' } as unknown as JsonObject })
  await api('/plugins/openviking-memory/connect', {})
}
function batch(kind: 'private' | 'group', senderId = '200'): HarnessDeliveryBatch { const conversationId = `qq:100:${kind}:200`, stamp = new Date().toISOString(); return { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId, createdAt: stamp, reason: 'quiet-window', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', instanceId: 'fixture', platform: 'qq', accountId: '100', conversationId, senderId, targetId: '200', receivedAt: stamp, source: { trust: 'external', kind, senderRole: 'owner' }, content: 'fixture', text: 'fixture' }] } }

describe('real Host grants and scoped OpenViking MCP', () => {
  it('binds manual tools to the current main turn, isolates group reads and keeps writes behind explicit grants', async () => {
    const directory = await home(), service = await startOpenVikingFixture(); stops.push(() => service.close())
    let harness!: HarnessHostServices
    const harnessEntry: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { harness = context.harness!; return { id: 'fixture', name: 'Fixture', kind: 'harness', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null, dispose: async () => {} } } }
    const host = new EatingHost({ dataDirectory: directory, entries: [qqEntry, memoryEntry, harnessEntry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host)
    const qq = await api('/plugins/qq/configuration')
    await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { owners: ['200'], administrators: [], agentTools: qq.agentTools!, expectedRevision: qq.policyRevision! } })
    await configureMemory(api, service)
    expect(harness.getCapabilityMcpConnections({ agentId: 'root', agentTypeId: 'main' })).toEqual([])
    const grant = await api('/mcp')
    await api('/mcp', { operation: 'save-grants', input: { id: 'plugin.openviking-memory', expectedRevision: grant.revision!, agentTypeIds: ['main'], toolNames: ['memory_search', 'memory_read', 'memory_save', 'memory_scopes'] } })
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
    expect(service.committedSessions).toHaveLength(1); expect(service.cleaned).toEqual([])
    expect(service.sessions.get(service.committedSessions[0]!.id)).toMatchObject({ deleted: false, messages: [expect.objectContaining({ role: 'user', content: 'Explicit stable preference' })] })
    harness.revokeAgentAccess('root')
    await expect(client.callTool({ name: 'memory_search', arguments: { query: 'fixture' } })).rejects.toThrow()
    expect(service.errors).toEqual([])
  })
})

describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('system DSH automatic OpenViking memory end to end', () => {
  it('recalls global plus current peer, extracts a normal QQ reply with no memory calls, and retains the remote transcript', async () => {
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
    expect(JSON.stringify(requests[0]!.tools)).not.toContain('memory_save')
    const submitted = service.requests.find(request => request.path.endsWith('/messages/batch'))!
    expect(JSON.stringify(submitted.body)).toContain(reply)
    expect(JSON.stringify(submitted.body)).not.toContain('GLOBAL-RECALLED-VALUE')
    expect(submitted.headers['x-openviking-actor-peer']).toBe('qq-100000101-private-100000202')
    expect(service.committedSessions[0]!.policy).toMatchObject({ peer: { enabled: true }, self: { enabled: true } })
    const sessionId = 'eating-qq-100000101-private-100000202', remote = service.sessions.get(sessionId)!
    expect(remote.deleted).toBe(false); expect(remote.messages).toEqual(submitted.body.messages)
    expect(remote.messages).toMatchObject([{ role: 'user', content: expect.stringContaining('fixture') }, { role: 'assistant', content: reply }])
    expect(service.archives.get(remote.archiveUri!)?.messages).toEqual(submitted.body.messages)
    expect(service.cleaned).toEqual([]); expect(service.requests.filter(request => request.method === 'DELETE')).toEqual([])
    const state = object(await api('/plugins/openviking-memory/manage', { operation: 'snapshot', input: {} }))
    expect((state.jobs as JsonObject[])[0]).toMatchObject({ status: 'completed', sessionId, peerId: 'qq-100000101-private-100000202', changes: { added: 1, updated: 2, deleted: 0 } })
    for (const body of [reply, 'GLOBAL-RECALLED-VALUE', 'LOCAL-RECALLED-VALUE', 'OTHER-PRIVATE-MEMORY']) expect(JSON.stringify(state)).not.toContain(body)
    expect(service.errors).toEqual([])
    await dsh.disconnect(); await dsh.connect()
    expect(requests).toHaveLength(1); expect(service.committedSessions).toHaveLength(1)
    await host.close()
    const sqlite = await readFile(join(directory, 'host/Eating.sqlite'))
    expect(sqlite.includes(Buffer.from(reply))).toBe(false)
  }, 60000)
})
