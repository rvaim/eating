import { mkdtemp, realpath, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { PlatformError } from '@eating/plugin-sdk'
import type { BackendPluginEntry, BackendPlugin, HarnessHostServices, HarnessCapabilityConnection, AgentInvocationScope, CapabilityInvocationScope, JsonObject, PluginToolDefinition, ConnectionStatus } from '@eating/plugin-sdk'
import { CapabilityAccess } from './capability-access'
import { DirectMcpConnections } from './mcp-connections'
import { EatingHost } from './app'
import { HostStore } from './store'
import stickersEntry from '../../../plugins/capabilities/stickers/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { createImageFixturePng } from '../../../tests/fixtures/image'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function temporaryHome(prefix = 'eating-capabilities-') {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, prefix)))
  stops.push(async () => { if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith(prefix)) throw new Error('Unsafe fixture path'); await rm(home, { recursive: true }) })
  return home
}
async function fixture(options: { home?: string; storedGrants?: string; storedPolicies?: string; extraEntries?: BackendPluginEntry[]; harnessState?: ConnectionStatus['state']; harnessConnect?: () => Promise<void>; harnessDisconnect?: () => Promise<void> } = {}) {
  const home = options.home ?? await temporaryHome()
  if (options.storedGrants !== undefined || options.storedPolicies !== undefined) {
    const store = new HostStore(join(home, 'host/Eating.sqlite'))
    if (options.storedGrants !== undefined) store.setSetting('host:capability-grants', options.storedGrants)
    if (options.storedPolicies !== undefined) store.setSetting('host:mcp-access-policies', options.storedPolicies)
    store.close()
  }
  let services!: HarnessHostServices, stoppedHarness = 0, connectedHarness = 0
  const harnessMounts: Array<readonly HarnessCapabilityConnection[]> = []
  const harnessEntry: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) {
    services = context.harness!
    let state: ConnectionStatus['state'] = options.harnessState ?? 'connected'
    return { id: 'fixture', kind: 'harness', name: 'Fixture Harness', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state, accountId: null, accountName: null, lastError: state === 'error' ? 'Fixture runtime failure' : null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}),
      connect: async () => {
        connectedHarness++; state = 'connecting'
        try { await options.harnessConnect?.(); harnessMounts.push(services.getCapabilityMcpConnections({ agentId: 'fixture-root', agentTypeId: 'main' })); state = 'connected' }
        catch (error) { state = 'error'; throw error }
      },
      disconnect: async () => { stoppedHarness++; await options.harnessDisconnect?.(); state = 'disconnected' }, invoke: async () => null, dispose: async () => {} }
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, harnessEntry, stickersEntry, ...options.extraEntries ?? []], port: 0, allowedUiOrigins: [] })
  stops.push(() => host.close())
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), boot = await bootstrap.json(), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const api = async (path: string, body?: JsonObject) => {
    const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-CSRF': boot.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(value))
    return value
  }
  const client = async (scope: CapabilityInvocationScope, sourceId = 'plugin.stickers') => {
    const connection = services.getCapabilityMcpConnections(scope).find(item => item.id === sourceId)
    if (!connection) throw new Error('No connected capability: ' + sourceId)
    const client = new Client({ name: 'scope-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }))
    stops.push(() => client.close())
    return client
  }
  return { host, home, api, services, client, harnessMounts, get stoppedHarness() { return stoppedHarness }, get connectedHarness() { return connectedHarness } }
}

function gate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), ready = new Promise<void>(resolve => { release = resolve })
  return { entered, enter, ready, release }
}
function extraCapability(connect?: () => Promise<void>): BackendPluginEntry {
  return { id: 'new-source', kind: 'capability', storageDirectory: 'new-source', create() {
    let state: ConnectionStatus['state'] = 'disconnected'
    return { id: 'new-source', name: 'New source', version: '1.0.0', kind: 'capability', capabilities: [],
      tools: [{ name: 'new_source_read', title: 'New source read', description: 'Read trusted fixture identity', inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'json' }],
      getStatus: () => ({ state, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({ autoConnect: false }), updateConfiguration: async () => ({}),
      connect: async () => { await connect?.(); state = 'connected' }, disconnect: async () => { state = 'disconnected' }, invoke: async () => null,
      invokeCapability: async (_name, _args, _id, scope) => ({ agentTypeId: scope.agentTypeId }), dispose: async () => {},
    }
  } }
}

async function installableFixture(home: string, id = 'installed-source', kind: 'capability' | 'harness' = 'capability') {
  const directory = join(home, 'source-' + randomUUID())
  await mkdir(join(directory, 'ui'), { recursive: true })
  const files = {
    'server.mjs': `export default {id:${JSON.stringify(id)},kind:${JSON.stringify(kind)},storageDirectory:${JSON.stringify(id)},create(){let state='disconnected';return {id:${JSON.stringify(id)},kind:${JSON.stringify(kind)},name:'Installed fixture',version:'1.0.0',capabilities:[],tools:${kind === 'capability' ? JSON.stringify([{ name: 'installed_read', title: 'Installed read', description: 'Fixture', inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'json' }]) : '[]'},getStatus:()=>({state,accountId:null,accountName:null,lastError:null,connectedAt:null,lastEventAt:null,reconnectAttempt:0}),getPublicConfiguration:()=>({autoConnect:true}),updateConfiguration:async()=>({}),connect:async()=>{state='connected'},disconnect:async()=>{state='disconnected'},invoke:async()=>null,invokeCapability:async()=>({installed:true}),dispose:async()=>{state='disconnected'}}}}`,
    'ui/index.js': 'export default {}', 'ui/style.css': '/* Test fixture */',
  }
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(directory, path), bytes)
  await writeFile(join(directory, 'eating-plugin.json'), JSON.stringify({ schemaVersion: 1, id, name: 'Installed fixture', description: 'One-shot topology test', version: '1.0.0', kind, apiVersion: 4, assets: [], storageDirectory: id, backend: 'server.mjs', frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 0, brandColor: '#000000', icon: 'box' }, integrity: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')])) }))
  return directory
}

async function changingDirectFixture() {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()
  const closed = new WeakSet<Server>()
  let tools = [{ name: 'write', inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: false } }]
  const calls: string[] = []
  let entered!: () => void, release!: () => void
  const called = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const http = createServer((request, response) => { void (async () => {
    let body: unknown
    if (request.method === 'POST') { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    const sessionId = request.headers['mcp-session-id']
    let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (!session && request.method === 'POST' && isInitializeRequest(body)) {
      const server = new Server({ name: 'changing-direct-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } })
      server.onclose = () => { closed.add(server) }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: id => { sessions.set(id, { server, transport }) } })
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        calls.push(params.name)
        if (params.name === 'write') { entered(); await held }
        return { content: [{ type: 'text', text: params.name }], isError: false }
      })
      await server.connect(transport); session = { server, transport }
    }
    if (!session) { response.writeHead(404); response.end(); return }
    await session.transport.handleRequest(request, response, body)
  })().catch(() => response.destroy()) })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind')
  stops.push(async () => { release(); await Promise.all([...sessions.values()].map(async item => { await item.server.close(); await item.transport.close() })); http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) })
  return { url: `http://127.0.0.1:${address.port}/mcp`, called, calls, release, creations: () => sessions.size,
    async addTool(name = 'added_read') { tools = [...tools, { name, inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: true } }]; await Promise.all([...sessions.values()].filter(item => !closed.has(item.server)).map(item => item.server.sendToolListChanged())) },
  }
}

const scope = { agentId: 'main-fixture', agentTypeId: 'main' }
const stdioArgs = [fileURLToPath(new URL('../../../tests/fixtures/direct-mcp-stdio.mjs', import.meta.url))]

describe('capability MCP and cross-plugin sticker resources', () => {
  it('extends an existing capability source without reconnecting or upgrading verify tools', async () => {
    const entry = extraCapability()
    const original = entry.create
    const seen: CapabilityInvocationScope[] = []
    const custom: BackendPluginEntry = { ...entry, create(context) { const plugin = original(context); return { ...plugin, getStatus: () => ({ state: 'connected' as const, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), invokeCapability: async (_name, _args, _id, scope) => { seen.push(scope); return { refs: [...scope.source?.resourceIds ?? []] } } } } }
    const f = await fixture({ extraEntries: [custom] })
    const source: AgentInvocationScope = { agentId: 'async-child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: 'fixture', accountId: 'fixture', conversationId: 'fixture', kind: 'private', targetId: 'fixture', messageIds: ['old'], resourceIds: ['old-image'], readOnly: true }
    const client = await f.client({ agentId: source.agentId, agentTypeId: source.agentTypeId, source, readOnly: true }, 'plugin.new-source')
    const access = Reflect.get(f.host, 'capabilityAccess') as CapabilityAccess
    const leases = Reflect.get(access, 'leases') as Map<string, unknown>, tokens = [...leases.keys()]
    access.extendScope('fixture', { ...source, messageIds: ['old', 'new'], resourceIds: ['old-image', 'new-image'] })
    expect([...leases.keys()]).toEqual(tokens)
    expect(await client.callTool({ name: 'new_source_read', arguments: {} })).toMatchObject({ isError: false, structuredContent: { result: { refs: ['old-image', 'new-image'] } } })
    expect(seen[0]!.readOnly).toBe(true); expect(seen[0]!.source?.readOnly).toBe(true)
    expect(() => access.extendScope('fixture', { ...source, readOnly: false })).toThrow()
    expect(() => access.extendScope('fixture', { ...source, targetId: 'other' })).toThrow()
    access.revokeAgent('fixture', source.agentId)
    await expect(client.listTools()).rejects.toThrow()
  })

  it.each(['scope', 'source'] as const)('limits %s verify capabilities to read tools under default all and restores reply writes', async mode => {
    const calls: string[] = []
    const entry: BackendPluginEntry = { id: 'verify-source', kind: 'capability', storageDirectory: 'verify-source', create: () => ({
      id: 'verify-source', kind: 'capability', name: 'Verify fixture', version: '1', capabilities: [],
      tools: ['memory_read', 'memory_write', 'image_generate'].map(name => ({ name, title: name, description: name, readOnly: name === 'memory_read', destructive: false, resultFormat: 'json' as const, inputSchema: { type: 'object', properties: { request_id: { type: 'string' } } } })),
      getStatus: () => ({ state: 'connected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, dispose: async () => {}, invoke: async () => null,
      invokeCapability: async (name, _input, _request, scope) => { calls.push(name); return { readOnly: scope.readOnly === true || scope.source?.readOnly === true } },
    }) }
    const f = await fixture({ extraEntries: [entry] }), base = { agentId: 'verify-agent', agentTypeId: 'future.type' }
    const reply = await f.client(base, 'plugin.verify-source')
    const source: AgentInvocationScope = { ...base, pluginId: 'qq', instanceId: 'fixture', accountId: 'fixture', conversationId: 'fixture', kind: 'private', targetId: 'fixture', messageIds: [], resourceIds: [], readOnly: true }
    const verification = { ...base, ...(mode === 'scope' ? { readOnly: true } : { source }) }
    const verify = await f.client(verification, 'plugin.verify-source')
    await expect(reply.listTools()).rejects.toThrow()
    expect((await verify.listTools()).tools.map(tool => tool.name)).toEqual(['memory_read'])
    expect(await verify.callTool({ name: 'memory_read', arguments: {} })).toMatchObject({ isError: false, structuredContent: { result: { readOnly: true } } })
    for (const name of ['memory_write', 'image_generate']) expect(await verify.callTool({ name, arguments: { request_id: 'verify-capability-denied' } })).toMatchObject({ isError: true, structuredContent: { code: 'CAPABILITY_ACCESS_DENIED', outcome: 'not-sent' } })
    const access = Reflect.get(f.host, 'capabilityAccess'), leases = [...Reflect.get(access, 'leases').values()], lease = leases.find(candidate => candidate.scope.agentId === base.agentId && candidate.sourceId === 'plugin.verify-source')
    await expect(Reflect.get(access, 'invoke').call(access, lease, 'memory_write', { request_id: 'verify-direct-denied' })).rejects.toMatchObject({ statusCode: 403, outcome: 'not-sent' })
    expect(access.activePermission(base, 'plugin.verify-source', 'memory_write')).toBe(false)
    expect(calls).toEqual(['memory_read'])
    const restored = await f.client(base, 'plugin.verify-source')
    await expect(verify.listTools()).rejects.toThrow()
    await expect(Reflect.get(access, 'invoke').call(access, lease, 'memory_read', {})).rejects.toMatchObject({ statusCode: 403 })
    expect(await restored.callTool({ name: 'memory_write', arguments: { request_id: 'reply-capability-write' } })).toMatchObject({ isError: false })
    expect(calls).toEqual(['memory_read', 'memory_write'])
    expect(f.host.store.getSetting('host:mcp-access-policies')).toBeNull()
  })

  it('filters direct unknown read metadata during verify and restores the reply write envelope', async () => {
    const f = await fixture(), directory = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: directory.revision, name: 'Verify direct fixture', transport: 'stdio', command: process.execPath, args: stdioArgs, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.transport === 'stdio').id
    await f.api('/mcp', { operation: 'connect', input: { id } })
    const base = { agentId: 'direct-verify', agentTypeId: 'future.type' }
    const original = await f.client(base, id), verify = await f.client({ ...base, readOnly: true }, id)
    await expect(original.listTools()).rejects.toThrow()
    expect((await verify.listTools()).tools.map(tool => tool.name)).toEqual(['fixture_echo'])
    expect(await verify.callTool({ name: 'fixture_echo', arguments: { value: 'verify read' } })).toMatchObject({ structuredContent: { args: { value: 'verify read' } } })
    for (const name of ['fixture_image', 'fixture_hang', 'fixture_error']) expect(await verify.callTool({ name, arguments: { arguments: {}, request_id: 'direct-verify-denied' } })).toMatchObject({ isError: true, structuredContent: { code: 'CAPABILITY_ACCESS_DENIED', outcome: 'not-sent' } })
    const restored = await f.client(base, id)
    await expect(verify.listTools()).rejects.toThrow()
    expect((await restored.callTool({ name: 'fixture_image', arguments: { arguments: {}, request_id: 'direct-reply-restored' } })).isError).toBeFalsy()
  })

  it('retires old capability leases even when a verify stage has no readable tools from their source', async () => {
    const f = await fixture(), upstream = await changingDirectFixture(), directory = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: directory.revision, name: 'Write only verify fixture', transport: 'streamable-http', url: upstream.url, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.transport === 'streamable-http').id
    await f.api('/mcp', { operation: 'connect', input: { id } })
    const base = { agentId: 'write-only-verify', agentTypeId: 'main' }, original = await f.client(base, id)
    const access = Reflect.get(f.host, 'capabilityAccess'), lease = [...Reflect.get(access, 'leases').values()].find(candidate => candidate.scope.agentId === base.agentId && candidate.sourceId === id)
    expect(f.services.getCapabilityMcpConnections({ ...base, readOnly: true }).some(connection => connection.id === id)).toBe(false)
    await expect(original.listTools()).rejects.toThrow()
    await expect(Reflect.get(access, 'invoke').call(access, lease, 'write', { arguments: {}, request_id: 'old-lease-write' })).rejects.toMatchObject({ statusCode: 403, outcome: 'not-sent' })
    expect(upstream.calls).toEqual([])
    await f.host.close()
  })

  it.each([undefined, JSON.stringify({ schemaVersion: 1, revision: 91, grants: { 'plugin.stickers': { agentTypeIds: [], toolNames: [] } } }), '{preserved-unused-configuration'])('opens every current plugin tool by default without reading or changing saved grant rows: %s', async storedGrants => {
    const f = await fixture({ storedGrants })
    const image = createImageFixturePng().toString('base64')
    const added = await f.api('/plugins/stickers/manage', { operation: 'add', input: { data: image, mimeType: 'image/png', description: '开心挥手', tags: ['开心', '招呼'] } })
    const directory = await f.api('/mcp')
    const sticker = directory.services.find((service: JsonObject) => service.id === 'plugin.stickers')
    expect(directory.agentTypes).toHaveLength(3)
    for (const type of directory.agentTypes) expect(Object.keys(type).sort()).toEqual(['id', 'title'])
    expect(sticker.accessPolicy).toEqual({ mode: 'all' })
    expect(f.host.store.getSetting('host:mcp-access-policies')).toBeNull()
    expect(sticker.grant).toEqual({ agentTypeIds: directory.agentTypes.map((type: { id: string }) => type.id), toolNames: sticker.tools.map((tool: { name: string }) => tool.name) })
    const client = await f.client(scope)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(sticker.grant.toolNames)
    const listed = await client.callTool({ name: 'sticker_list', arguments: { tags: ['开心'], offset: 0, limit: 1 } })
    expect(listed.isError).toBe(false)
    expect(JSON.stringify(listed)).toContain('开心挥手')
    expect(JSON.stringify(listed)).not.toContain(image)
    const preview = await client.callTool({ name: 'sticker_get', arguments: { assetId: added.item.assetId } })
    expect(preview.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', data: image })]))
    expect(JSON.stringify(preview.structuredContent)).toContain('eating-asset://stickers/')
    const stopped = await f.api('/mcp', { operation: 'disconnect', input: { id: 'plugin.stickers' } })
    expect(stopped.harnessStopped).toBe(true)
    await expect(client.callTool({ name: 'sticker_get', arguments: { assetId: added.item.assetId } })).rejects.toThrow()
    expect(f.services.getCapabilityMcpConnections(scope)).toEqual([])
    await f.host.close()
    const store = new HostStore(join(f.home, 'host/Eating.sqlite'))
    try { expect(store.getSetting('host:capability-grants')).toBe(storedGrants ?? null) } finally { store.close() }
  })

  it('rejects malformed policy mutations and direct save grant fields before changing leases or configuration', async () => {
    const f = await fixture(), before = await f.api('/mcp'), client = await f.client(scope)
    const base = { id: 'plugin.stickers', expectedRevision: before.revision }
    const invalid: JsonObject[] = [
      { agentTypeIds: [], toolNames: [] }, { mode: 'unknown' }, { mode: 'all', toolNames: [] },
      { mode: 'custom', agentTypeIds: [] }, { mode: 'custom', agentTypeIds: ['main', 'main'], toolNames: [] },
      { mode: 'custom', agentTypeIds: ['main'], toolNames: ['sticker_list', 'sticker_list'] },
      { mode: 'custom', agentTypeIds: ['*'], toolNames: [] }, { mode: 'custom', agentTypeIds: ['main'], toolNames: ['*'] },
      { mode: 'custom', agentTypeIds: 'main', toolNames: [] }, { mode: 'all', extra: true },
    ]
    for (const fields of invalid) await expect(f.api('/mcp', { operation: 'save-grants', input: { ...base, ...fields } })).rejects.toThrow('MCP_ACCESS_POLICY_INVALID')
    await expect(f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Rejected grant', transport: 'stdio', command: process.execPath, args: stdioArgs, autoConnect: false, grant: { agentTypeIds: [], toolNames: [] } } })).rejects.toThrow('MCP_CONFIGURATION_INVALID')
    expect(await f.api('/mcp')).toEqual(before)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    expect(f.connectedHarness).toBe(0)
    expect(f.stoppedHarness).toBe(0)
    expect(f.host.store.getSetting('host:mcp-access-policies')).toBeNull()
  })

  it('saves custom type/tool choices, revokes old leases, excludes main when selected, and preserves policy on restart', async () => {
    const f = await fixture({ storedGrants: 'legacy grant bytes remain untouched' }), before = await f.api('/mcp')
    const old = await f.client(scope)
    const first = await f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: before.revision, mode: 'custom', agentTypeIds: ['main', 'qq.private'], toolNames: ['sticker_list', 'future_tool'] } })
    const source = first.services.find((item: JsonObject) => item.id === 'plugin.stickers')
    expect(source.accessPolicy).toEqual({ mode: 'custom', agentTypeIds: ['main', 'qq.private'], toolNames: ['sticker_list', 'future_tool'] })
    expect(source.grant).toEqual({ agentTypeIds: ['main', 'qq.private'], toolNames: ['sticker_list'] })
    expect(first).toMatchObject({ revision: before.revision + 1, harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'reconnected' }] })
    expect(f.connectedHarness).toBe(1); expect(f.stoppedHarness).toBe(1)
    await expect(old.listTools()).rejects.toThrow()
    const main = await f.client({ agentId: 'custom-main', agentTypeId: 'main' }), privateAgent = await f.client({ agentId: 'custom-private', agentTypeId: 'qq.private' })
    for (const client of [main, privateAgent]) {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['sticker_list'])
      expect(await client.callTool({ name: 'sticker_get', arguments: { assetId: 'absent' } })).toMatchObject({ isError: true, structuredContent: { code: 'CAPABILITY_ACCESS_DENIED' } })
    }
    expect(f.services.getCapabilityMcpConnections({ agentId: 'custom-group', agentTypeId: 'qq.group' })).toEqual([])
    const policy = { mode: 'custom', agentTypeIds: ['qq.group'], toolNames: ['sticker_list'] }
    const next = await f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: first.revision, ...policy } })
    expect(f.services.getCapabilityMcpConnections({ agentId: 'main-denied', agentTypeId: 'main' })).toEqual([])
    expect((await (await f.client({ agentId: 'group-allowed', agentTypeId: 'qq.group' })).listTools()).tools.map(tool => tool.name)).toEqual(['sticker_list'])
    const bytes = f.host.store.getSetting('host:mcp-access-policies')!
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 1, revision: 2, policies: { 'plugin.stickers': policy } })
    await f.host.close()
    const reopened = await fixture({ home: f.home, harnessState: 'disconnected' })
    const snapshot = await reopened.api('/mcp')
    expect(snapshot.revision).toBe(next.revision)
    expect(snapshot.services.find((item: JsonObject) => item.id === 'plugin.stickers').accessPolicy).toEqual(policy)
    expect(reopened.host.store.getSetting('host:mcp-access-policies')).toBe(bytes)
    expect(reopened.host.store.getSetting('host:capability-grants')).toBe('legacy grant bytes remain untouched')
    expect(reopened.services.getCapabilityMcpConnections({ agentId: 'restarted-main', agentTypeId: 'main' })).toEqual([])
    expect((await (await reopened.client({ agentId: 'restarted-group', agentTypeId: 'qq.group' })).listTools()).tools.map(tool => tool.name)).toEqual(['sticker_list'])
  })

  it('keeps an offline source policy writable without executing or granting unavailable tools', async () => {
    let connections = 0
    const f = await fixture({ harnessState: 'disconnected', extraEntries: [extraCapability(async () => { connections++ })] }), before = await f.api('/mcp')
    const policy = { mode: 'custom', agentTypeIds: ['qq.group', 'future.agent-type'], toolNames: ['new_source_read', 'future_source_tool'] }
    const saved = await f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.new-source', expectedRevision: before.revision, ...policy } })
    expect(saved.services.find((item: JsonObject) => item.id === 'plugin.new-source')).toMatchObject({ state: 'disconnected', accessPolicy: policy, grant: { agentTypeIds: ['qq.group'], toolNames: ['new_source_read'] } })
    expect(connections).toBe(0)
    expect(saved.harnessRemounts).toEqual([])
    expect(f.services.getCapabilityMcpConnections({ agentId: 'offline', agentTypeId: 'qq.group' }).some(item => item.id === 'plugin.new-source')).toBe(false)
    await f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } })
    expect(connections).toBe(1)
    expect(f.services.getCapabilityMcpConnections(scope).some(item => item.id === 'plugin.new-source')).toBe(false)
    const client = await f.client({ agentId: 'offline-then-connected', agentTypeId: 'future.agent-type' }, 'plugin.new-source')
    expect(await client.callTool({ name: 'new_source_read', arguments: {} })).toMatchObject({ isError: false, structuredContent: { result: { agentTypeId: 'future.agent-type' } } })
    expect(await client.callTool({ name: 'future_source_tool', arguments: {} })).toMatchObject({ isError: true, structuredContent: { code: 'CAPABILITY_ACCESS_DENIED' } })
  })

  it('uses combined policy/direct CAS, keeps connection secrets separate, and removes only the deleted source policy', async () => {
    const f = await fixture({ storedGrants: 'legacy untouched' }), before = await f.api('/mcp')
    const secret = 'private-direct-policy-fixture'
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Private direct source', transport: 'streamable-http', url: 'https://fixture.invalid/mcp?token=' + secret, headers: { Authorization: 'Bearer ' + secret }, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.transport === 'streamable-http').id
    const connectionsBefore = await readFile(join(f.home, 'host/mcp/connections.json'), 'utf8')
    const policy = { mode: 'custom', agentTypeIds: ['qq.private'], toolNames: ['fixture_echo'] }
    const changed = await f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: saved.revision, ...policy } })
    const snapshot = JSON.stringify(changed)
    expect(snapshot).not.toContain(secret)
    expect(changed.revision).toBe(saved.revision + 1)
    expect(await readFile(join(f.home, 'host/mcp/connections.json'), 'utf8')).toBe(connectionsBefore)
    const stopped = f.stoppedHarness, connected = f.connectedHarness
    await expect(f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: saved.revision, mode: 'all' } })).rejects.toThrow('MCP_CONFIGURATION_CONFLICT')
    await expect(f.api('/mcp', { operation: 'save', input: { id, expectedRevision: saved.revision, name: 'Stale overwrite', transport: 'streamable-http', autoConnect: false } })).rejects.toThrow('MCP_CONFIGURATION_CONFLICT')
    await expect(f.api('/mcp', { operation: 'delete', input: { id, expectedRevision: saved.revision } })).rejects.toThrow('MCP_CONFIGURATION_CONFLICT')
    expect(f.stoppedHarness).toBe(stopped); expect(f.connectedHarness).toBe(connected)
    const renamed = await f.api('/mcp', { operation: 'save', input: { id, expectedRevision: changed.revision, name: 'Connection only', transport: 'streamable-http', autoConnect: false } })
    const connection = JSON.parse(await readFile(join(f.home, 'host/mcp/connections.json'), 'utf8'))
    expect(connection).toMatchObject({ schemaVersion: 2, revision: 2, connections: [{ id, url: 'https://fixture.invalid/mcp?token=' + secret, headers: { authorization: 'Bearer ' + secret } }] })
    expect(connection.connections[0].grant).toBeUndefined()
    expect(connection.connections[0].accessPolicy).toBeUndefined()
    expect(renamed.revision).toBe(changed.revision + 1)
    expect(renamed.services.find((item: JsonObject) => item.id === id).accessPolicy).toEqual(policy)
    await expect(f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: changed.revision, mode: 'all' } })).rejects.toThrow('MCP_CONFIGURATION_CONFLICT')
    const preserved = await f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: renamed.revision, mode: 'custom', agentTypeIds: [], toolNames: [] } })
    await f.host.close()
    const reopened = await fixture({ home: f.home, harnessState: 'disconnected' }), restarted = await reopened.api('/mcp')
    expect(restarted.services.find((item: JsonObject) => item.id === id).accessPolicy).toEqual(policy)
    expect(restarted.revision).toBe(preserved.revision)
    const removed = await reopened.api('/mcp', { operation: 'delete', input: { id, expectedRevision: restarted.revision } })
    expect(removed.services.some((item: JsonObject) => item.id === id)).toBe(false)
    const stored = JSON.parse(reopened.host.store.getSetting('host:mcp-access-policies')!)
    expect(stored.policies).toEqual({ 'plugin.stickers': { mode: 'custom', agentTypeIds: [], toolNames: [] } })
    expect(JSON.stringify(removed) + JSON.stringify(stored)).not.toContain(secret)
    expect(await readFile(join(f.home, 'host/mcp/connections.json'), 'utf8')).not.toContain(secret)
    expect(reopened.host.store.getSetting('host:capability-grants')).toBe('legacy untouched')
    const created = await reopened.api('/mcp', { operation: 'save', input: { expectedRevision: removed.revision, name: 'New default', transport: 'stdio', command: process.execPath, args: stdioArgs, autoConnect: false } })
    expect(created.services.find((item: JsonObject) => item.transport === 'stdio').accessPolicy).toEqual({ mode: 'all' })
  })

  it('rejects exhausted combined revisions before saving connection bytes, policy, or lease changes', async () => {
    const storedPolicies = JSON.stringify({ schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER, policies: {} })
    const f = await fixture({ storedPolicies }), before = await f.api('/mcp')
    await expect(f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Exhausted direct revision', transport: 'stdio', command: process.execPath, args: stdioArgs, autoConnect: false } })).rejects.toThrow('MCP_REVISION_EXHAUSTED')
    await expect(f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: before.revision, mode: 'custom', agentTypeIds: [], toolNames: [] } })).rejects.toThrow('MCP_REVISION_EXHAUSTED')
    expect(f.host.store.getSetting('host:mcp-access-policies')).toBe(storedPolicies)
    await expect(readFile(join(f.home, 'host/mcp/connections.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.stoppedHarness).toBe(0); expect(f.connectedHarness).toBe(0)
    expect(await f.api('/mcp')).toEqual(before)
  })

  it.each([
    '{broken', JSON.stringify({ schemaVersion: 0, revision: 0, policies: {} }),
    JSON.stringify({ schemaVersion: 1, policies: {} }),
    JSON.stringify({ schemaVersion: 1, revision: 0, policies: {}, extra: true }),
    JSON.stringify({ schemaVersion: 1, revision: 0, policies: { 'plugin.stickers': { mode: 'all', toolNames: [] } } }),
    JSON.stringify({ schemaVersion: 1, revision: 0, policies: { 'plugin.stickers': { mode: 'custom', agentTypeIds: ['main'], toolNames: ['*'] } } }),
    JSON.stringify({ schemaVersion: 1, revision: 0, policies: { 'plugin.stickers': { mode: 'custom', agentTypeIds: [], toolNames: ['duplicate', 'duplicate'] } } }),
  ])('rejects invalid current policy storage without overwriting it or falling back to all: %s', async storedPolicies => {
    const home = await temporaryHome(), store = new HostStore(join(home, 'host/Eating.sqlite'))
    store.setSetting('host:mcp-access-policies', storedPolicies); store.close()
    expect(() => new EatingHost({ dataDirectory: home, entries: [], port: 0, autoConnectOnStartup: false })).toThrowError(expect.objectContaining({ code: 'MCP_ACCESS_POLICY_STORAGE_INVALID' }))
    const checked = new HostStore(join(home, 'host/Eating.sqlite'))
    try { expect(checked.getSetting('host:mcp-access-policies')).toBe(storedPolicies) } finally { checked.close() }
  })

  it('saves without execution or grants, exposes every direct tool to main and future types, and records success/unknown without replay', async () => {
    const f = await fixture(), directory = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: directory.revision, name: 'stdio fixture', transport: 'stdio', command: process.execPath,
      args: stdioArgs, env: { EATING_DIRECT_MCP_FIXTURE_SECRET: 'private-direct-key' }, autoConnect: false } })
    const service = saved.services.find((service: JsonObject) => service.transport === 'stdio')
    expect(service.state).toBe('disconnected')
    expect(JSON.stringify(saved)).not.toContain('private-direct-key')
    const connected = await f.api('/mcp', { operation: 'connect', input: { id: service.id } })
    expect(connected.services.find((item: JsonObject) => item.id === service.id).grant.toolNames).toEqual(['fixture_echo', 'fixture_image', 'fixture_hang', 'fixture_error'])
    const main = await f.client({ agentId: 'direct-main', agentTypeId: 'main' }, service.id)
    const client = await f.client({ agentId: 'direct-new', agentTypeId: 'future.agent-type' }, service.id)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual((await main.listTools()).tools.map(tool => tool.name))
    const tools = (await client.listTools()).tools
    expect(tools.find(tool => tool.name === 'fixture_image')!.inputSchema.required).toEqual(['arguments', 'request_id'])
    expect((await client.callTool({ name: 'fixture_echo', arguments: { value: 'exact' } })).isError).toBeFalsy()
    const write = { arguments: {}, request_id: 'direct-write-stable-0001' }
    const first = await client.callTool({ name: 'fixture_image', arguments: write })
    expect(first.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]))
    expect(f.services.readAgentActions('direct-new')).toEqual([expect.objectContaining({ requestId: write.request_id, outcome: 'succeeded' })])
    const duplicate = await client.callTool({ name: 'fixture_image', arguments: write })
    expect(duplicate).toMatchObject({ isError: true, structuredContent: { code: 'MCP_ACTION_ALREADY_RECORDED' } })
    expect(f.services.readAgentActions('direct-new')[0]?.outcome).toBe('succeeded')
    const unknownInput = { arguments: {}, request_id: 'direct-unknown-stable-0001' }
    expect(await client.callTool({ name: 'fixture_error', arguments: unknownInput })).toMatchObject({ isError: true })
    expect(f.services.readAgentActions('direct-new')).toContainEqual(expect.objectContaining({ requestId: unknownInput.request_id, outcome: 'unknown' }))
    expect(await client.callTool({ name: 'fixture_error', arguments: unknownInput })).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    const updated = await f.api('/mcp')
    const deleted = await f.api('/mcp', { operation: 'delete', input: { id: service.id, expectedRevision: updated.revision } })
    expect(deleted.services.some((item: JsonObject) => item.id === service.id)).toBe(false)
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'late' } })).rejects.toThrow()
    await expect(main.listTools()).rejects.toThrow()
  })

  it('remounts every newly connected capability on an already connected root without another enable step', async () => {
    const f = await fixture({ extraEntries: [extraCapability()] })
    const result = await f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } })
    expect(result).toMatchObject({ harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'reconnected' }] })
    expect(f.connectedHarness).toBe(1)
    const connection = f.harnessMounts.at(-1)!.find(item => item.id === 'plugin.new-source')!
    expect(connection.tools).toEqual(['new_source_read'])
    const root = new Client({ name: 'remounted-root', version: '1' }); stops.push(() => root.close())
    await root.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }))
    expect(await root.callTool({ name: 'new_source_read', arguments: {} })).toMatchObject({ isError: false, structuredContent: { result: { agentTypeId: 'main' } } })
  })

  it.each(['disconnected', 'error', 'connecting'] as const)('does not start a previously %s Harness while connecting a source', async harnessState => {
    const f = await fixture({ harnessState, extraEntries: [extraCapability()] })
    expect(await f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } })).toMatchObject({ harnessStopped: false, harnessRemounts: [] })
    expect(f.connectedHarness).toBe(0)
    expect(f.stoppedHarness).toBe(0)
    expect((f.host.getWorkspace().plugins as JsonObject[]).find(plugin => plugin.id === 'fixture')!.status).toMatchObject({ state: harnessState })
  })

  it.each(['disconnect', 'disable'] as const)('honors an owner Harness %s while source connection is awaiting its result', async operation => {
    const pendingSource = gate()
    const f = await fixture({ extraEntries: [extraCapability(async () => { pendingSource.enter(); await pendingSource.ready })] })
    const pending = f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } })
    await pendingSource.entered
    await f.api('/plugins/fixture/' + operation, {})
    pendingSource.release()
    expect(await pending).toMatchObject({ harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'cancelled' }] })
    expect(f.connectedHarness).toBe(0)
    const state = (f.host.getWorkspace().plugins as JsonObject[]).find(plugin => plugin.id === 'fixture')!
    expect(state.status).toMatchObject({ state: 'disconnected' })
    expect(state.enabled).toBe(operation !== 'disable')
  })

  it('tears down a late automatic connect when an owner stop arrives during runtime startup', async () => {
    const startup = gate()
    const f = await fixture({ harnessConnect: async () => { startup.enter(); await startup.ready }, extraEntries: [extraCapability()] })
    const pending = f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } })
    await startup.entered
    const sentinel = await f.client({ agentId: 'stop-sentinel', agentTypeId: 'main' })
    const stopped = f.api('/plugins/fixture/disconnect', {})
    await expect.poll(async () => sentinel.listTools().then(() => false, () => true)).toBe(true)
    startup.release()
    expect(await pending).toMatchObject({ harnessRemounts: [{ id: 'fixture', status: 'cancelled' }] })
    expect(await stopped).toMatchObject({ state: 'disconnected' })
    expect(f.connectedHarness).toBe(1)
    expect((f.host.getWorkspace().plugins as JsonObject[]).find(plugin => plugin.id === 'fixture')!.status).toMatchObject({ state: 'disconnected' })
  })

  it.each(['disconnect', 'disable'] as const)('honors owner %s during a policy remount without restoring revoked leases', async operation => {
    const startup = gate()
    const f = await fixture({ harnessConnect: async () => { startup.enter(); await startup.ready } }), before = await f.api('/mcp')
    const old = await f.client(scope)
    const pending = f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: before.revision, mode: 'custom', agentTypeIds: ['qq.private'], toolNames: ['sticker_list'] } })
    await startup.entered
    const sentinel = await f.client({ agentId: 'policy-stop-sentinel', agentTypeId: 'qq.private' })
    const stopped = f.api('/plugins/fixture/' + operation, {})
    await expect.poll(async () => sentinel.listTools().then(() => false, () => true)).toBe(true)
    startup.release()
    expect(await pending).toMatchObject({ harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'cancelled', code: 'HARNESS_REMOUNT_CANCELLED' }] })
    await stopped
    await expect(old.listTools()).rejects.toThrow()
    expect(f.connectedHarness).toBe(1)
    const plugin = (f.host.getWorkspace().plugins as JsonObject[]).find(item => item.id === 'fixture')!
    expect(plugin.status).toMatchObject({ state: 'disconnected' })
    expect(plugin.enabled).toBe(operation !== 'disable')
    expect((await f.api('/mcp')).services.find((item: JsonObject) => item.id === 'plugin.stickers').accessPolicy).toEqual({ mode: 'custom', agentTypeIds: ['qq.private'], toolNames: ['sticker_list'] })
  })

  it('rechecks policy CAS after asynchronous Harness teardown and preserves a newer saved selection', async () => {
    const stopping = gate()
    const f = await fixture({ harnessDisconnect: async () => { stopping.enter(); await stopping.ready } }), before = await f.api('/mcp')
    const pending = f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: before.revision, mode: 'custom', agentTypeIds: [], toolNames: [] } }).catch(error => JSON.parse(error.message))
    await stopping.entered
    const newer = JSON.stringify({ schemaVersion: 1, revision: 1, policies: { 'plugin.stickers': { mode: 'custom', agentTypeIds: ['qq.private'], toolNames: ['sticker_list'] } } })
    f.host.store.setSetting('host:mcp-access-policies', newer)
    stopping.release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'MCP_CONFIGURATION_CONFLICT', outcome: 'not-sent' }, harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'reconnected' }] })
    expect(f.host.store.getSetting('host:mcp-access-policies')).toBe(newer)
    expect(f.connectedHarness).toBe(1)
    expect(f.services.getCapabilityMcpConnections(scope)).toEqual([])
    expect((await (await f.client({ agentId: 'newer-selection', agentTypeId: 'qq.private' })).listTools()).tools.map(tool => tool.name)).toEqual(['sticker_list'])
  })

  it('reports a failed Harness remount once while preserving the successfully connected source', async () => {
    const f = await fixture({ harnessConnect: async () => { throw new PlatformError('FIXTURE_HARNESS_FAILED', 'Synthetic runtime failure', 502, 'failed') }, extraEntries: [extraCapability()] })
    const result = await f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } })
    expect(result).toMatchObject({ harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'failed', code: 'FIXTURE_HARNESS_FAILED' }] })
    expect(result.services.find((item: JsonObject) => item.id === 'plugin.new-source').state).toBe('connected')
    expect((await f.api('/mcp')).harnessRemounts).toEqual(result.harnessRemounts)
    expect(f.connectedHarness).toBe(1)
    expect((f.host.getWorkspace().plugins as JsonObject[]).find(plugin => plugin.id === 'fixture')!.status).toMatchObject({ state: 'error' })
  })

  it('preserves the source error and reports restoration of the old connected Harness without retrying the source', async () => {
    let calls = 0
    const f = await fixture({ extraEntries: [extraCapability(async () => { calls++; throw new PlatformError('FIXTURE_SOURCE_FAILED', 'Synthetic source failure', 502, 'failed') })] })
    const error = await f.api('/mcp', { operation: 'connect', input: { id: 'plugin.new-source' } }).catch(error => JSON.parse(error.message))
    expect(error).toMatchObject({ ok: false, error: { code: 'FIXTURE_SOURCE_FAILED', outcome: 'failed' }, harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'reconnected' }] })
    expect(calls).toBe(1)
    expect(f.connectedHarness).toBe(1)
  })

  it('rebuilds a changed direct topology, restores the mounted Harness and never replays its interrupted write', async () => {
    const f = await fixture(), upstream = await changingDirectFixture(), before = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Changing direct source', transport: 'streamable-http', url: upstream.url, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.source && (item.source as JsonObject).kind === 'direct').id
    await f.api('/mcp', { operation: 'connect', input: { id } })
    await f.api('/plugins/fixture/connect', {})
    const stoppedBefore = f.stoppedHarness, connectedBefore = f.connectedHarness
    const client = await f.client(scope, id)
    const input = { arguments: {}, request_id: 'topology-interrupted-write-0001' }
    const pending = client.callTool({ name: 'write', arguments: input }).catch(error => error)
    await upstream.called
    await upstream.addTool()
    await expect.poll(async () => (await f.api('/mcp')).services.find((item: JsonObject) => item.id === id).tools.map((tool: { name: string }) => tool.name)).toEqual(['write', 'added_read'])
    expect(f.stoppedHarness).toBe(stoppedBefore + 1)
    await expect.poll(() => f.connectedHarness).toBe(connectedBefore + 1)
    expect(f.harnessMounts.at(-1)!.find(item => item.id === id)!.tools).toEqual(['write', 'added_read'])
    expect((await f.api('/mcp')).harnessRemounts).toEqual([{ id: 'fixture', status: 'reconnected' }])
    await pending
    await expect(client.listTools()).rejects.toThrow()
    const next = await f.client(scope, id)
    expect((await next.listTools()).tools.map(tool => tool.name)).toEqual(['write', 'added_read'])
    expect(await next.callTool({ name: 'write', arguments: input })).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    expect(upstream.calls).toEqual(['write'])
    upstream.release()
    const future = await f.client({ agentId: 'new-topology-agent', agentTypeId: 'future.agent-type' }, id)
    expect(await future.callTool({ name: 'added_read', arguments: {} })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'added_read' }] })
    expect(upstream.calls).toEqual(['write', 'added_read'])
    await f.host.close()
  })

  it('keeps custom exact tools across a direct directory refresh and includes future tools again after restoring all', async () => {
    const f = await fixture(), upstream = await changingDirectFixture(), before = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Policy topology fixture', transport: 'streamable-http', url: upstream.url, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.transport === 'streamable-http').id
    await f.api('/mcp', { operation: 'connect', input: { id } })
    const custom = await f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: saved.revision, mode: 'custom', agentTypeIds: ['main', 'qq.private'], toolNames: ['write'] } })
    const customBytes = f.host.store.getSetting('host:mcp-access-policies'), connectionsBytes = await readFile(join(f.home, 'host/mcp/connections.json'), 'utf8')
    const stopped = f.stoppedHarness, connected = f.connectedHarness
    await upstream.addTool()
    await expect.poll(async () => (await f.api('/mcp')).harnessRemounts).toEqual([{ id: 'fixture', status: 'reconnected' }])
    await expect.poll(() => f.connectedHarness).toBe(connected + 1)
    expect(f.stoppedHarness).toBe(stopped + 1)
    const directory = await f.api('/mcp'), source = directory.services.find((item: JsonObject) => item.id === id)
    expect(directory.revision).toBe(custom.revision)
    expect(source.grant).toEqual({ agentTypeIds: ['main', 'qq.private'], toolNames: ['write'] })
    expect(source.tools.map((tool: { name: string }) => tool.name)).toEqual(['write', 'added_read'])
    expect(f.host.store.getSetting('host:mcp-access-policies')).toBe(customBytes)
    expect(await readFile(join(f.home, 'host/mcp/connections.json'), 'utf8')).toBe(connectionsBytes)
    expect(f.services.getCapabilityMcpConnections({ agentId: 'not-selected', agentTypeId: 'qq.group' }).some(item => item.id === id)).toBe(false)
    const restricted = await f.client({ agentId: 'restricted-direct', agentTypeId: 'qq.private' }, id)
    expect((await restricted.listTools()).tools.map(tool => tool.name)).toEqual(['write'])
    expect(await restricted.callTool({ name: 'added_read', arguments: {} })).toMatchObject({ isError: true, structuredContent: { code: 'CAPABILITY_ACCESS_DENIED' } })
    expect(upstream.calls).toEqual([])
    const restored = await f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: custom.revision, mode: 'all' } })
    expect(restored.services.find((item: JsonObject) => item.id === id).accessPolicy).toEqual({ mode: 'all' })
    const connectsBeforeNewTool = f.connectedHarness
    await upstream.addTool('after_all_read')
    await expect.poll(() => f.connectedHarness).toBe(connectsBeforeNewTool + 1)
    expect(f.harnessMounts.at(-1)!.find(item => item.id === id)!.tools).toEqual(['write', 'added_read', 'after_all_read'])
    const future = await f.client({ agentId: 'restored-all-future', agentTypeId: 'future.agent-type' }, id)
    expect(await future.callTool({ name: 'after_all_read', arguments: {} })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'after_all_read' }] })
    expect(upstream.calls).toEqual(['after_all_read'])
    await f.host.close()
  })

  it('rejects an in-flight direct write and new leases after a policy disable, preserves other sources, and never replays unknown after reallowing', async () => {
    const f = await fixture(), upstream = await changingDirectFixture(), before = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Revoked write fixture', transport: 'streamable-http', url: upstream.url, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.transport === 'streamable-http').id
    await f.api('/mcp', { operation: 'connect', input: { id } })
    const client = await f.client(scope, id), write = { arguments: {}, request_id: 'policy-interrupted-write-0001' }
    const pending = client.callTool({ name: 'write', arguments: write }).catch(error => error)
    await upstream.called
    const stopped = f.stoppedHarness, connected = f.connectedHarness
    const disabled = await f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: saved.revision, mode: 'custom', agentTypeIds: [], toolNames: [] } })
    await pending
    expect(disabled).toMatchObject({ harnessStopped: true, harnessRemounts: [{ id: 'fixture', status: 'reconnected' }] })
    expect(f.stoppedHarness).toBe(stopped + 1); expect(f.connectedHarness).toBe(connected + 1)
    await expect(client.listTools()).rejects.toThrow()
    expect(f.services.getCapabilityMcpConnections({ agentId: 'denied-main', agentTypeId: 'main' }).some(item => item.id === id)).toBe(false)
    const other = await f.client({ agentId: 'other-source', agentTypeId: 'qq.group' })
    expect(await other.callTool({ name: 'sticker_list', arguments: {} })).toMatchObject({ isError: false })
    expect((await f.api('/mcp')).services.find((item: JsonObject) => item.id === 'plugin.stickers').accessPolicy).toEqual({ mode: 'all' })
    await f.api('/mcp', { operation: 'connect', input: { id } })
    expect(f.services.getCapabilityMcpConnections({ agentId: 'denied-connected', agentTypeId: 'main' }).some(item => item.id === id)).toBe(false)
    await f.api('/mcp', { operation: 'save-grants', input: { id, expectedRevision: disabled.revision, mode: 'all' } })
    const next = await f.client(scope, id)
    expect(await next.callTool({ name: 'write', arguments: write })).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    expect(upstream.calls).toEqual(['write'])
    upstream.release()
    await f.host.close()
  })

  it('keeps a source deleted during notification teardown absent and does not reconnect its old transport', async () => {
    const stopping = gate(); let hold = false
    const f = await fixture({ harnessDisconnect: async () => { if (hold) { stopping.enter(); await stopping.ready } } })
    const upstream = await changingDirectFixture(), before = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: before.revision, name: 'Removed during refresh', transport: 'streamable-http', url: upstream.url, autoConnect: false } })
    const id = saved.services.find((item: JsonObject) => item.transport === 'streamable-http').id
    await f.api('/mcp', { operation: 'connect', input: { id } })
    hold = true
    await upstream.addTool()
    await stopping.entered
    const removing = f.api('/mcp', { operation: 'delete', input: { id, expectedRevision: saved.revision } })
    await expect.poll(async () => f.api('/mcp', { operation: 'connect', input: { id: 'probe-unused-id' } }).then(() => false, error => error.message.includes('MCP_BUSY'))).toBe(true)
    stopping.release()
    expect((await removing).services.some((item: JsonObject) => item.id === id)).toBe(false)
    expect(upstream.creations()).toBe(1)
    expect(f.harnessMounts.at(-1)!.some(connection => connection.id === id)).toBe(false)
    expect((f.host.getWorkspace().plugins as JsonObject[]).find(plugin => plugin.id === 'fixture')!.status).toMatchObject({ state: 'connected' })
    await f.host.close()
  })

  it('remounts capability installation, enable and removal and never restores a replaced Harness object', async () => {
    const f = await fixture(), sourceDirectory = await installableFixture(f.home)
    const plan = await f.api('/plugin-packages', { operation: 'preview', input: { sourceDirectory } })
    const installed = await f.api('/plugin-packages', { operation: 'install', input: { planId: plan.planId, confirmed: true } })
    expect(installed.harnessRemounts).toEqual([{ id: 'fixture', status: 'reconnected' }])
    expect(f.harnessMounts.at(-1)!.find(item => item.id === 'plugin.installed-source')!.tools).toEqual(['installed_read'])
    const directory = await f.api('/mcp')
    await f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.installed-source', expectedRevision: directory.revision, mode: 'custom', agentTypeIds: ['main'], toolNames: ['installed_read'] } })
    const disabled = await f.api('/plugins/installed-source/disable', {})
    expect(disabled.harnessRemounts).toEqual([{ id: 'fixture', status: 'reconnected' }])
    expect(f.harnessMounts.at(-1)!.some(item => item.id === 'plugin.installed-source')).toBe(false)
    const enabled = await f.api('/plugins/installed-source/enable', {})
    expect(enabled.harnessRemounts).toEqual([{ id: 'fixture', status: 'reconnected' }])
    expect(f.harnessMounts.at(-1)!.find(item => item.id === 'plugin.installed-source')!.tools).toEqual(['installed_read'])
    expect((await f.api('/mcp')).services.find((item: JsonObject) => item.id === 'plugin.installed-source').accessPolicy).toEqual({ mode: 'custom', agentTypeIds: ['main'], toolNames: ['installed_read'] })
    const removed = await f.api('/plugin-packages', { operation: 'uninstall', input: { id: 'installed-source', confirmed: true } })
    expect(removed.harnessRemounts).toEqual([{ id: 'fixture', status: 'reconnected' }])
    expect(f.harnessMounts.at(-1)!.some(item => item.id === 'plugin.installed-source')).toBe(false)
    expect(JSON.parse(f.host.store.getSetting('host:mcp-access-policies')!).policies).not.toHaveProperty('plugin.installed-source')
    const originalConnects = f.connectedHarness
    const replacement = await installableFixture(f.home, 'fixture', 'harness')
    const nextPlan = await f.api('/plugin-packages', { operation: 'preview', input: { sourceDirectory: replacement } })
    const replaced = await f.api('/plugin-packages', { operation: 'install', input: { planId: nextPlan.planId, confirmed: true } })
    expect(replaced.harnessRemounts).toEqual([{ id: 'fixture', status: 'cancelled', code: 'HARNESS_REMOUNT_CANCELLED' }])
    expect(f.connectedHarness).toBe(originalConnects)
    expect((f.host.getWorkspace().plugins as JsonObject[]).find(plugin => plugin.id === 'fixture')!.name).toBe('Installed fixture')
  })

  it('keeps communication and received-image scope isolated while a future type gets every functional plugin tool', async () => {
    const f = await fixture()
    const client = await f.client({ agentId: 'future-fixture', agentTypeId: 'future.agent-type' })
    const directory = await f.api('/mcp')
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(directory.services.find((service: JsonObject) => service.id === 'plugin.stickers').tools.map((tool: { name: string }) => tool.name))
    expect(f.services.getCapabilityMcpConnections({ agentId: 'future-again', agentTypeId: 'future.agent-type' }).some(connection => connection.id === 'plugin.qq')).toBe(false)
    const noSource = await client.callTool({ name: 'sticker_add', arguments: { source: { messageId: '900', imageId: 'untrusted-image' }, description: 'Must not read another conversation', tags: [], request_id: 'missing-source-image-0001' } })
    expect(noSource).toMatchObject({ isError: true, structuredContent: { code: 'STICKER_SOURCE_REQUIRED', outcome: 'not-sent' } })
    await expect(f.api('/mcp', { operation: 'connect', input: { id: 'plugin.qq' } })).rejects.toThrow('MCP_MANAGED_BY_PLUGIN')
    const communication = directory.services.find((service: JsonObject) => service.id === 'plugin.qq')
    expect(communication.configuration.permissionsManagedByPlugin).toBe(true)
    expect(communication.accessPolicy).toBeNull()
    await expect(f.api('/mcp', { operation: 'save-grants', input: { id: 'plugin.qq', expectedRevision: directory.revision, mode: 'all' } })).rejects.toThrow('MCP_MANAGED_BY_PLUGIN')
    expect(communication.grant.agentTypeIds).not.toContain('main')
  })

  it('lets a scoped QQ Agent resolve a saved sticker and sends standard base64 without storing it in the action ledger', async () => {
    const f = await fixture(), onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    const image = createImageFixturePng().toString('base64')
    const added = await f.api('/plugins/stickers/manage', { operation: 'add', input: { data: image, mimeType: 'image/png', description: '收到', tags: ['确认'] } })
    await f.api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false })
    await f.api('/plugins/qq/connect', {})
    const workspace = f.host.getWorkspace().plugins as JsonObject[]
    const qq = workspace.find(plugin => plugin.id === 'qq')!, configuration = qq.configuration as JsonObject
    const scope: AgentInvocationScope = { agentId: 'qq-child-fixture', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: String(configuration.instanceId), accountId: '123456789', conversationId: 'qq:123456789:private:987654321', kind: 'private', targetId: '987654321', messageIds: [], resourceIds: [] }
    f.services.getCapabilityMcpConnections({ agentId: scope.agentId, agentTypeId: scope.agentTypeId, source: scope })
    const connection = f.services.getMcpConnection('qq', scope)
    const client = new Client({ name: 'qq-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } })); stops.push(() => client.close())
    const message = { type: 'image', data: { file: `eating-asset://stickers/${added.item.assetId}` } }
    const input = { user_id: '987654321', message, request_id: 'sticker-send-stable-0001' }
    const sent = await client.callTool({ name: 'qq_send_private_message', arguments: input })
    expect(sent.isError).toBe(false)
    const sends = onebot.requests.filter(request => request.action === 'send_private_msg')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.params.message).toEqual({ type: 'image', data: { file: 'base64://' + image } })
    await client.callTool({ name: 'qq_send_private_message', arguments: input })
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    const wrongTarget = await client.callTool({ name: 'qq_send_private_message', arguments: { ...input, user_id: 'another-recipient', request_id: 'sticker-wrong-target-0001' } })
    expect(wrongTarget.isError).toBe(true)
    const tooMany = await client.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: Array.from({ length: 5 }, () => message), request_id: 'sticker-send-over-limit-0001' } })
    expect(tooMany).toMatchObject({ isError: true, structuredContent: { code: 'MEDIA_ASSET_LIMIT', outcome: 'not-sent' } })
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    await f.api('/mcp', { operation: 'disconnect', input: { id: 'plugin.stickers' } })
    await expect(client.callTool({ name: 'qq_send_private_message', arguments: { ...input, request_id: 'sticker-send-revoked-0002' } })).rejects.toThrow()
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    await f.host.close()
    const db = await readFile(join(f.home, 'host/Eating.sqlite'))
    expect(db.includes(Buffer.from(image))).toBe(false)
  })

  it('rejects ambiguous main memory context before invoking a provider with self fallback', async () => {
    const home = await temporaryHome(), direct = new DirectMcpConnections(home)
    stops.push(() => direct.close())
    let invoked = 0
    const plugin: BackendPlugin = { id: 'memory', kind: 'capability', name: 'Memory fixture', version: '1.0.0', capabilities: [],
      tools: [{ name: 'memory_search', title: 'Memory', description: 'Memory', inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'json' }],
      memory: { recall: async () => ({ text: '', items: [] }), capture: async () => {} },
      getStatus: () => ({ state: 'connected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null,
      invokeCapability: async () => { invoked++; return null }, dispose: async () => {}, }
    const store = new HostStore(join(home, 'fixture.sqlite'))
    stops.push(() => store.close())
    let context: null | undefined = null
    const access = new CapabilityAccess({ store, direct, plugins: () => [plugin], enabled: () => true, memoryContext: () => context,
      executeIdempotent: async () => { throw new Error('Unused action') } })
    stops.push(() => access.close())
    access.connections('fixture-harness', { agentId: 'main', agentTypeId: 'main' }, 'http://127.0.0.1:1')
    const lease = Reflect.get(access, 'leases').values().next().value
    await expect(Reflect.get(access, 'invoke').call(access, lease, 'memory_search', {})).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_AMBIGUOUS', outcome: 'not-sent' })
    expect(invoked).toBe(0)
    context = undefined
    await Reflect.get(access, 'invoke').call(access, lease, 'memory_search', {})
    expect(invoked).toBe(1)
  })

  it('includes new plugin sources and tools on remount and omits unavailable sources for every Agent type', async () => {
    const home = await temporaryHome(), direct = new DirectMcpConnections(home); stops.push(() => direct.close())
    const tool = (name: string): PluginToolDefinition => ({ name, title: name, description: name, inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'json' })
    let state: 'connected' | 'disconnected' = 'connected', enabled = true
    const plugin: BackendPlugin = { id: 'memory', kind: 'capability', name: 'Memory fixture', version: '1.0.0', capabilities: [], tools: [tool('memory_search')],
      getStatus: () => ({ state, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({ autoConnect: false }), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null,
      invokeCapability: async () => null, dispose: async () => {}, }
    const plugins = [plugin]
    const store = new HostStore(join(home, 'fixture.sqlite')); stops.push(() => store.close())
    const access = new CapabilityAccess({ store, direct, plugins: () => plugins, enabled: id => id === 'fixture-harness' || enabled, executeIdempotent: async () => { throw new Error('unused fixture action') } }); stops.push(() => access.close())
    const future = { agentId: 'fixture-agent', agentTypeId: 'future.agent-type' }
    expect(access.connections('fixture-harness', future, 'http://127.0.0.1:1').map(item => item.tools)).toEqual([['memory_search']])
    ;(plugin.tools as PluginToolDefinition[]).push(tool('memory_new_tool'))
    plugins.push({ ...plugin, id: 'new-source', tools: [tool('new_source_tool')] })
    const connections = access.connections('fixture-harness', future, 'http://127.0.0.1:1')
    expect(connections.map(item => item.tools)).toEqual([['memory_search', 'memory_new_tool'], ['new_source_tool']])
    expect(access.snapshot([{ id: future.agentTypeId, title: 'Future type' }]).services[0]!.grant).toEqual({ agentTypeIds: ['main', 'future.agent-type'], toolNames: ['memory_search', 'memory_new_tool'] })
    expect(access.activePermission(future, 'plugin.memory', 'memory_new_tool')).toBe(true)
    access.savePolicy({ id: 'plugin.memory', expectedRevision: access.revision, mode: 'custom', agentTypeIds: [future.agentTypeId], toolNames: ['memory_search'] })
    expect(access.activePermission(future, 'plugin.memory', 'memory_search')).toBe(false)
    expect(access.connections('fixture-harness', future, 'http://127.0.0.1:1').map(item => item.tools)).toEqual([['memory_search'], ['new_source_tool']])
    ;(plugin.tools as PluginToolDefinition[]).push(tool('memory_later_tool'))
    expect(access.allowed(future, 'plugin.memory', 'memory_later_tool')).toBe(false)
    expect(access.allowed({ agentId: 'new-type', agentTypeId: 'unselected.type' }, 'plugin.memory', 'memory_search')).toBe(false)
    access.savePolicy({ id: 'plugin.memory', expectedRevision: access.revision, mode: 'all' })
    ;(plugin.tools as PluginToolDefinition[]).push(tool('memory_after_all'))
    expect(access.allowed({ agentId: 'new-type', agentTypeId: 'unselected.type' }, 'plugin.memory', 'memory_after_all')).toBe(true)
    expect(access.connections('fixture-harness', future, 'http://127.0.0.1:1').map(item => item.tools)).toEqual([['memory_search', 'memory_new_tool', 'memory_later_tool', 'memory_after_all'], ['new_source_tool']])
    state = 'disconnected'
    expect(access.allowed(future, 'plugin.memory', 'memory_search')).toBe(false)
    expect(access.connections('fixture-harness', future, 'http://127.0.0.1:1')).toEqual([])
    state = 'connected'; enabled = false
    expect(access.allowed(future, 'plugin.memory', 'memory_search')).toBe(false)
    expect(access.connections('fixture-harness', future, 'http://127.0.0.1:1')).toEqual([])
    enabled = true
    plugins.push({ ...plugin, id: 'managed-harness', kind: 'harness', tools: [tool('managed_tool')] })
    expect(access.source('plugin.managed-harness').accessPolicy).toBeNull()
    expect(access.allowed(future, 'plugin.managed-harness', 'managed_tool')).toBe(false)
    expect(() => access.savePolicy({ id: 'plugin.managed-harness', expectedRevision: access.revision, mode: 'all' })).toThrowError(expect.objectContaining({ code: 'MCP_MANAGED_BY_PLUGIN' }))
    plugins.splice(0)
    expect(access.allowed(future, 'plugin.memory', 'memory_search')).toBe(false)
    expect(access.connections('fixture-harness', future, 'http://127.0.0.1:1')).toEqual([])
  })
})
