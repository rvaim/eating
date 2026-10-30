import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { BackendPluginEntry, HarnessHostServices, AgentInvocationScope, CapabilityInvocationScope, JsonObject } from '@eating/plugin-sdk'
import { EatingHost } from './app'
import stickersEntry from '../../../plugins/capabilities/stickers/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { createImageFixturePng } from '../../../tests/fixtures/image'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'eating-capabilities-')))
  stops.push(async () => { if (await realpath(home) !== home || dirname(home) !== await realpath(tmpdir()) || !basename(home).startsWith('eating-capabilities-')) throw new Error('Unsafe fixture path'); await rm(home, { recursive: true }) })
  let services!: HarnessHostServices, stoppedHarness = 0
  const harnessEntry: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) {
    services = context.harness!
    let state: 'connected' | 'disconnected' = 'connected'
    return { id: 'fixture', kind: 'harness', name: 'Fixture Harness', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => { state = 'connected' }, disconnect: async () => { state = 'disconnected'; stoppedHarness++ }, invoke: async () => null, dispose: async () => {} }
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, harnessEntry, stickersEntry], port: 0, allowedUiOrigins: [] })
  stops.push(() => host.close())
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), boot = await bootstrap.json(), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const api = async (path: string, body?: JsonObject) => {
    const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-CSRF': boot.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(value))
    return value
  }
  const client = async (scope: CapabilityInvocationScope) => {
    const connection = services.getCapabilityMcpConnections(scope)[0]
    if (!connection) throw new Error('No approved capability')
    const client = new Client({ name: 'scope-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }))
    stops.push(() => client.close())
    return client
  }
  const grant = async (types: string[], tools: string[]) => {
    const directory = await api('/mcp')
    return api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: directory.revision, agentTypeIds: types, toolNames: tools } })
  }
  return { host, home, api, services, client, grant, get stoppedHarness() { return stoppedHarness } }
}

describe('capability MCP and cross-plugin sticker resources', () => {
  it('lists metadata without image bytes, grants exact tools, previews and revokes a current lease', async () => {
    const f = await fixture()
    const image = createImageFixturePng().toString('base64')
    const added = await f.api('/plugins/stickers/manage', { operation: 'add', input: { data: image, mimeType: 'image/png', description: '开心挥手', tags: ['开心', '招呼'] } })
    const directory = await f.api('/mcp')
    expect(directory.services.map((service: JsonObject) => service.id)).toContain('plugin.stickers')
    expect(f.services.getCapabilityMcpConnections({ agentId: 'main-fixture', agentTypeId: 'main' })).toEqual([])
    await f.grant(['main'], ['sticker_list', 'sticker_get'])
    expect(f.stoppedHarness).toBe(1)
    const client = await f.client({ agentId: 'main-fixture', agentTypeId: 'main' })
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['sticker_get', 'sticker_list'])
    const listed = await client.callTool({ name: 'sticker_list', arguments: { tags: ['开心'], offset: 0, limit: 1 } })
    expect(listed.isError).toBe(false)
    expect(JSON.stringify(listed)).toContain('开心挥手')
    expect(JSON.stringify(listed)).not.toContain(image)
    const preview = await client.callTool({ name: 'sticker_get', arguments: { assetId: added.item.assetId } })
    expect(preview.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', data: image })]))
    expect(JSON.stringify(preview.structuredContent)).toContain('eating-asset://stickers/')
    await f.grant(['main'], ['sticker_list'])
    await expect(client.callTool({ name: 'sticker_get', arguments: { assetId: added.item.assetId } })).rejects.toThrow()
  })
  it('saves a direct stdio service without execution, discovers exact tools, proxies writes once and hides saved secrets', async () => {
    const f = await fixture()
    const directory = await f.api('/mcp')
    const saved = await f.api('/mcp', { operation: 'save', input: { expectedRevision: directory.revision, name: 'stdio fixture', transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('../../../tests/fixtures/direct-mcp-stdio.mjs', import.meta.url))], env: { EATING_DIRECT_MCP_FIXTURE_SECRET: 'private-direct-key' }, autoConnect: false, grant: { agentTypeIds: [], toolNames: [] } } })
    const service = saved.services.find((service: JsonObject) => service.transport === 'stdio')
    expect(service.state).toBe('disconnected')
    expect(JSON.stringify(saved)).not.toContain('private-direct-key')
    const connected = await f.api('/mcp', { operation: 'connect', input: { id: service.id } })
    await f.api('/mcp', { operation: 'save-grants', input: { id: service.id, expectedRevision: connected.revision, agentTypeIds: ['main'], toolNames: ['fixture_echo', 'fixture_image'] } })
    const client = await f.client({ agentId: 'direct-main-fixture', agentTypeId: 'main' })
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual(['fixture_echo', 'fixture_image'])
    expect(tools.find(tool => tool.name === 'fixture_image')!.inputSchema.required).toEqual(['arguments', 'request_id'])
    const read = await client.callTool({ name: 'fixture_echo', arguments: { value: 'exact' } })
    expect(read.isError).toBeFalsy()
    expect(JSON.stringify(read)).toContain('exact')
    const write = { arguments: {}, request_id: 'direct-write-stable-0001' }
    const first = await client.callTool({ name: 'fixture_image', arguments: write })
    expect(first.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]))
    const duplicate = await client.callTool({ name: 'fixture_image', arguments: write })
    expect(duplicate).toMatchObject({ isError: true, structuredContent: { code: 'MCP_ACTION_ALREADY_RECORDED' } })
    const updated = await f.api('/mcp')
    const deleted = await f.api('/mcp', { operation: 'delete', input: { id: service.id, expectedRevision: updated.revision } })
    expect(deleted.services.some((item: JsonObject) => item.id === service.id)).toBe(false)
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'late' } })).rejects.toThrow()
  })

  it('lets a scoped QQ Agent resolve a saved sticker and sends standard base64 to OneBot without storing it in the action ledger', async () => {
    const f = await fixture(), onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    const image = createImageFixturePng().toString('base64')
    const added = await f.api('/plugins/stickers/manage', { operation: 'add', input: { data: image, mimeType: 'image/png', description: '收到', tags: ['确认'] } })
    await f.api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false })
    await f.api('/plugins/qq/connect', {})
    await f.grant(['qq.private'], ['sticker_get', 'sticker_list'])
    const workspace = f.host.getWorkspace().plugins as JsonObject[]
    const qq = workspace.find(plugin => plugin.id === 'qq')!
    const configuration = qq.configuration as JsonObject
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
    const tooMany = await client.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: Array.from({ length: 5 }, () => message), request_id: 'sticker-send-over-limit-0001' } })
    expect(tooMany).toMatchObject({ isError: true, structuredContent: { code: 'MEDIA_ASSET_LIMIT', outcome: 'not-sent' } })
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    await f.grant(['qq.private'], ['sticker_list'])
    const denied = await client.callTool({ name: 'qq_send_private_message', arguments: { ...input, request_id: 'sticker-send-revoked-0002' } })
    expect(denied.isError).toBe(true)
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    await f.host.close()
    const db = await readFile(join(f.home, 'host/Eating.sqlite'))
    expect(db.includes(Buffer.from(image))).toBe(false)
  })
})
