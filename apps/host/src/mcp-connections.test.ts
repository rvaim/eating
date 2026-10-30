import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@eating/plugin-sdk'
import { DirectMcpConnections } from './mcp-connections'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) }
})

const cleanups: Array<() => void | Promise<void>> = []
const fixtureScript = fileURLToPath(new URL('../../../tests/fixtures/direct-mcp-stdio.mjs', import.meta.url))
const fixtureSecret = 'direct-fixture-private-value'
const tools: Tool[] = [
  { name: 'fixture_echo', title: '原名 Echo', description: 'Exact arguments', inputSchema: { type: 'object', properties: { value: {} } }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'fixture_write', inputSchema: { type: 'object' } },
  { name: 'fixture_image', inputSchema: { type: 'object' } },
  { name: 'fixture_hang', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
]
const emptyGrant = { agentTypeIds: [], toolNames: [] }
function deferred<T = void>() { let complete!: (value: T) => void; const promise = new Promise<T>(resolvePromise => { complete = resolvePromise }); return { promise, resolve: complete } }

function directory() {
  const parent = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(parent, 'eating-direct-mcp-')))
  cleanups.push(() => {
    if (realpathSync(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-direct-mcp-')) throw new Error('Invalid fixture cleanup path')
    rmSync(root, { recursive: true })
  })
  return root
}
function manager(root = directory()) {
  const service = new DirectMcpConnections(root)
  cleanups.push(() => service.close())
  return { service, root, file: join(root, 'connections.json') }
}
function saveHttp(service: DirectMcpConnections, url: string, extra: JsonObject = {}) {
  return service.save({ expectedRevision: service.revision, name: 'Remote fixture', transport: 'streamable-http', url, headers: { Authorization: `Bearer ${fixtureSecret}` }, autoConnect: false, grant: emptyGrant, ...extra })
}
function saveStdio(service: DirectMcpConnections, marker: string, extra: JsonObject = {}) {
  return service.save({ expectedRevision: service.revision, name: 'Stdio fixture', transport: 'stdio', command: process.execPath, args: [fixtureScript, marker], env: { EATING_DIRECT_MCP_FIXTURE_SECRET: fixtureSecret }, autoConnect: false, grant: emptyGrant, ...extra })
}
async function failed(promise: Promise<unknown>, code: string, outcome?: string) {
  const error = await promise.then(() => { throw new Error('Unexpected fixture success') }, (reason: unknown) => reason)
  expect(error).toMatchObject({ code, ...(outcome ? { outcome } : {}) })
  expect(String(error)).not.toContain(fixtureSecret)
  expect(JSON.stringify(error)).not.toContain(fixtureSecret)
  return error
}

async function endpoint(options: { tools?: Tool[]; pages?: boolean; loopCursor?: boolean; stall?: boolean; status?: number; redirect?: string; call?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> } = {}) {
  const servers = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()
  const received: { method: string; authorization: string | undefined; url: string; body: unknown }[] = []
  const initialized = deferred()
  const called = deferred()
  let creations = 0
  const http = createServer((request, response) => {
    void (async () => {
      let body: unknown
      if (request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      }
      received.push({ method: request.method ?? '', authorization: request.headers.authorization, url: request.url ?? '', body })
      if (options.redirect) { response.writeHead(307, { Location: options.redirect }); response.end(fixtureSecret); return }
      if (options.status) { response.writeHead(options.status); response.end(fixtureSecret); return }
      const sessionId = request.headers['mcp-session-id']
      let entry = typeof sessionId === 'string' ? servers.get(sessionId) : undefined
      if (!entry && request.method === 'POST' && isInitializeRequest(body)) {
        initialized.resolve()
        if (options.stall) return
        const server = new Server({ name: 'direct-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => `fixture-session-${++creations}`, enableJsonResponse: true, onsessioninitialized: id => { servers.set(id, { server, transport }) } })
        server.setRequestHandler(ListToolsRequestSchema, async input => {
          const selected = options.tools ?? tools
          if (options.loopCursor) return { tools: [], nextCursor: 'same' }
          if (options.pages && !input.params?.cursor) return { tools: selected.slice(0, 2), nextCursor: 'page-2' }
          return { tools: options.pages ? selected.slice(2) : selected }
        })
        server.setRequestHandler(CallToolRequestSchema, async input => {
          called.resolve()
          if (options.call) return options.call(input.params.name, input.params.arguments ?? {})
          if (input.params.name === 'fixture_image') return { content: [{ type: 'text', text: 'test image' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { original: true }, isError: false }
          return { content: [{ type: 'text', text: JSON.stringify(input.params.arguments) }], structuredContent: { exact: input.params.arguments ?? {} }, isError: false }
        })
        await server.connect(transport)
        entry = { server, transport }
      }
      if (!entry) { response.writeHead(404); response.end(); return }
      await entry.transport.handleRequest(request, response, body)
    })().catch(() => response.destroy())
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Invalid loopback HTTP address')
  cleanups.push(async () => {
    await Promise.all([...servers.values()].map(async entry => { await entry.server.close(); await entry.transport.close() }))
    http.closeAllConnections()
    await new Promise<void>((accept, reject) => http.close(error => error ? reject(error) : accept()))
  })
  return { url: `http://127.0.0.1:${address.port}/custom/mcp?api_key=${fixtureSecret}&mode=fixture`, received, initialized: initialized.promise, called: called.promise, creations: () => creations }
}

function rpcCalls(received: { body: unknown }[], method: string) { return received.filter(item => item.body !== null && typeof item.body === 'object' && 'method' in item.body && item.body.method === method) }

afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('direct MCP configuration and CAS persistence', () => {
  it('saves current schema privately without executing stdio or auto-connecting', async () => {
    const { service, root, file } = manager()
    const marker = join(root, 'not-started.pid')
    const item = saveStdio(service, marker, { autoConnect: true, grant: { agentTypeIds: ['qq.private'], toolNames: ['fixture_echo'] } })
    expect(item).toMatchObject({ id: expect.stringMatching(/^direct\.[0-9a-f-]{36}$/), source: { kind: 'direct' }, state: 'disconnected', enabled: true, autoConnect: true, tools: [], grant: { agentTypeIds: ['qq.private'], toolNames: ['fixture_echo'] } })
    expect(item.configuration).toEqual({ command: process.execPath, args: [fixtureScript, marker], envKeys: ['EATING_DIRECT_MCP_FIXTURE_SECRET'] })
    expect(JSON.stringify(item)).not.toContain(fixtureSecret)
    expect(existsSync(marker)).toBe(false)
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    expect(disk).toMatchObject({ schemaVersion: 1, revision: 1, connections: [{ id: item.id, env: { EATING_DIRECT_MCP_FIXTURE_SECRET: fixtureSecret } }] })
    if (process.platform !== 'win32') { expect(statSync(root).mode & 0o777).toBe(0o700); expect(statSync(file).mode & 0o777).toBe(0o600) }
    const reopened = new DirectMcpConnections(root); cleanups.push(() => reopened.close())
    expect(reopened.revision).toBe(1); expect(reopened.list()).toEqual(service.list())
    expect(existsSync(marker)).toBe(false)
    const snapshot = service.list() as unknown as { name: string; configuration: JsonObject }[]
    snapshot[0]!.name = 'mutated'; snapshot[0]!.configuration.command = 'mutated'
    expect(service.get(item.id).name).toBe('Stdio fixture')
  })

  it('keeps omitted secrets and the full private query URL, and only explicit clear keys delete values', async () => {
    const upstream = await endpoint()
    const { service, file } = manager()
    const item = saveHttp(service, upstream.url, { headers: { Authorization: `Bearer ${fixtureSecret}`, 'X-Other': 'saved-other' } })
    expect(item.configuration).toEqual({ url: upstream.url.split('?')[0], urlHasQuery: true, queryKeys: ['api_key', 'mode'], headerKeys: ['authorization', 'x-other'] })
    const update = { id: item.id, expectedRevision: service.revision, name: 'Renamed', transport: 'streamable-http', autoConnect: false, grant: emptyGrant }
    service.save(update)
    await service.connect(item.id)
    expect(upstream.received[0]).toMatchObject({ authorization: `Bearer ${fixtureSecret}`, url: '/custom/mcp?api_key=direct-fixture-private-value&mode=fixture' })
    await service.disconnect(item.id)
    service.save({ ...update, expectedRevision: service.revision, clearHeaderKeys: ['AUTHORIZATION'], headers: { 'X-New': '' } })
    const saved = JSON.parse(readFileSync(file, 'utf8')).connections[0]
    expect(saved.url).toBe(upstream.url)
    expect(saved.headers).toEqual({ 'x-other': 'saved-other', 'x-new': '' })
    expect(JSON.stringify(service.get(item.id))).not.toContain(fixtureSecret)
  })

  it('patches env values without clearing omitted keys and rejects wildcard grants or mixed transports', () => {
    const { service, root, file } = manager()
    const saved = saveStdio(service, join(root, 'fixture.pid'), { env: { KEY_ONE: fixtureSecret, KEY_TWO: 'retained' } })
    const update = { id: saved.id, expectedRevision: service.revision, name: 'Env fixture', transport: 'stdio', command: process.execPath, args: [fixtureScript, '', 'duplicate', 'duplicate'], autoConnect: false, grant: emptyGrant }
    service.save({ ...update, env: { KEY_THREE: 'new' }, clearEnvKeys: ['KEY_ONE'] })
    expect(JSON.parse(readFileSync(file, 'utf8')).connections[0].env).toEqual({ KEY_TWO: 'retained', KEY_THREE: 'new' })
    for (const bad of [{ ...update, expectedRevision: service.revision, grant: { agentTypeIds: [], toolNames: ['*'] } }, { ...update, expectedRevision: service.revision, headers: {} }, { ...update, expectedRevision: service.revision, url: 'http://127.0.0.1/' }, { ...update, expectedRevision: service.revision, env: { 'INVALID=ENV': 'bad' } }]) expect(() => service.save(bad)).toThrowError(expect.objectContaining({ code: 'MCP_CONFIGURATION_INVALID' }))
  })

  it('rejects stale revisions, externally changed files, and failed atomic replacements without losing old bytes', () => {
    const { service, file, root } = manager()
    saveHttp(service, 'https://fixture.invalid/mcp')
    const previous = readFileSync(file, 'utf8')
    expect(() => saveHttp(service, 'https://fixture.invalid/other', { expectedRevision: 0 })).toThrowError(expect.objectContaining({ code: 'MCP_REVISION_CONFLICT' }))
    const second = new DirectMcpConnections(root); cleanups.push(() => second.close())
    saveHttp(second, 'https://fixture.invalid/second')
    expect(() => saveHttp(service, 'https://fixture.invalid/stale')).toThrowError(expect.objectContaining({ code: 'MCP_REVISION_CONFLICT' }))
    expect(service.revision).toBe(1)
    expect(readFileSync(file, 'utf8')).not.toBe(previous)
    const bytes = readFileSync(file, 'utf8')
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error(fixtureSecret) })
    expect(() => saveHttp(second, 'https://fixture.invalid/failure')).toThrowError(expect.objectContaining({ code: 'MCP_SAVE_FAILED' }))
    expect(second.revision).toBe(2); expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(readdirSync(root)).toEqual(['connections.json'])
  })

  it.skipIf(process.platform === 'win32')('keeps memory consistent with the replaced file when directory fsync cannot confirm durability', () => {
    const { service, file } = manager()
    saveHttp(service, 'https://fixture.invalid/mcp')
    vi.mocked(fsyncSync).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error(fixtureSecret) })
    expect(() => saveHttp(service, 'https://fixture.invalid/updated', { name: 'Written but uncertain' })).toThrowError(expect.objectContaining({ code: 'MCP_SAVE_UNCERTAIN', outcome: 'unknown' }))
    expect(service.revision).toBe(2)
    expect(service.list()).toHaveLength(2)
    expect(service.list()[1]?.name).toBe('Written but uncertain')
    expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(2)
  })

  it('rechecks CAS after asynchronous disconnect before removing a saved connection', async () => {
    const { service } = manager()
    const first = saveHttp(service, 'https://fixture.invalid/first')
    saveHttp(service, 'https://fixture.invalid/second')
    const removal = failed(service.remove(first.id, 2), 'MCP_REVISION_CONFLICT')
    saveHttp(service, 'https://fixture.invalid/concurrent')
    await removal
    expect(service.revision).toBe(3)
    expect(service.list()).toHaveLength(3)
    expect(service.get(first.id).state).toBe('disconnected')
  })

  it.each(['{"schemaVersion":0,"revision":0,"connections":[]}', '{"schemaVersion":1,"connections":[]}', '{"schemaVersion":1,"revision":0,"connections":[],"legacy":true}', '{broken'])('rejects unsupported/damaged storage without replacing it: %s', bytes => {
    const root = directory(); const file = join(root, 'connections.json'); writeFileSync(file, bytes)
    expect(() => new DirectMcpConnections(root)).toThrowError(expect.objectContaining({ code: 'MCP_STORAGE_INVALID' }))
    expect(readFileSync(file, 'utf8')).toBe(bytes)
  })

  it.skipIf(process.platform === 'win32')('rejects symlink files and directories without reading their target', () => {
    const root = directory(); const target = join(root, 'target'); writeFileSync(target, 'preserved-target')
    symlinkSync(target, join(root, 'connections.json'))
    expect(() => new DirectMcpConnections(root)).toThrowError(expect.objectContaining({ code: 'MCP_STORAGE_INVALID' }))
    expect(readFileSync(target, 'utf8')).toBe('preserved-target')
    const other = directory(); const link = join(other, 'link'); symlinkSync(root, link)
    expect(() => new DirectMcpConnections(link)).toThrow()
  })

  it('rejects URL credentials/fragments and missing create URLs without returning their content', () => {
    const { service } = manager()
    for (const url of ['https://user:fixture@fixture.invalid/mcp', 'https://fixture.invalid/mcp#secret', 'file:///tmp/fixture']) expect(() => saveHttp(service, url)).toThrowError(expect.objectContaining({ code: 'MCP_CONFIGURATION_INVALID' }))
    expect(() => service.save({ name: 'Missing', transport: 'streamable-http', expectedRevision: 0, autoConnect: false, grant: emptyGrant })).toThrow()
  })
})

describe('direct MCP real Streamable HTTP lifecycle', () => {
  it('initializes, discovers paginated raw tools and preserves standard content results without adding action arguments', async () => {
    const upstream = await endpoint({ pages: true })
    const { service } = manager(); const saved = saveHttp(service, upstream.url)
    await service.connect(saved.id)
    expect(service.revision).toBe(1)
    const summary = service.get(saved.id)
    expect(summary.state).toBe('connected'); expect(summary.tools.map(tool => tool.name)).toEqual(tools.map(tool => tool.name))
    expect(summary.tools[0]).toMatchObject({ title: '原名 Echo', readOnly: true, destructive: false, resultFormat: 'content', inputSchema: tools[0]!.inputSchema })
    expect(summary.tools[1]).toMatchObject({ title: 'fixture_write', description: '', readOnly: false, destructive: true })
    const args = { value: '原文', nested: { array: [1, true, null] } }
    expect(await service.call(saved.id, 'fixture_echo', args)).toEqual({ content: [{ type: 'text', text: JSON.stringify(args) }], structuredContent: { exact: args }, isError: false })
    const result = await service.call(saved.id, 'fixture_image', {})
    expect(result).toEqual({ content: [{ type: 'text', text: 'test image' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { original: true }, isError: false })
    expect(rpcCalls(upstream.received, 'tools/call').map(item => (item.body as { params: unknown }).params)).toEqual([{ name: 'fixture_echo', arguments: args }, { name: 'fixture_image', arguments: {} }])
    await service.disconnect(saved.id)
    expect(service.get(saved.id)).toMatchObject({ state: 'disconnected', tools: [] })
    expect(upstream.received.filter(item => item.method === 'DELETE')).toHaveLength(1)
    await failed(service.call(saved.id, 'fixture_echo', {}), 'MCP_NOT_CONNECTED', 'not-sent')
  })

  it('coalesces concurrent connections, rejects save while active, and reconnects only when explicitly called', async () => {
    const upstream = await endpoint(); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    const first = service.connect(saved.id); const second = service.connect(saved.id)
    expect(second).toBe(first)
    expect(() => service.save({ expectedRevision: 1, id: saved.id, name: 'Busy', transport: 'streamable-http', autoConnect: false, grant: emptyGrant })).toThrowError(expect.objectContaining({ code: 'MCP_CONNECTION_BUSY' }))
    await Promise.all([first, second]); expect(upstream.creations()).toBe(1)
    await service.connect(saved.id); expect(upstream.creations()).toBe(1)
    await Promise.all([service.disconnect(saved.id), service.disconnect(saved.id)])
    await service.connect(saved.id); expect(upstream.creations()).toBe(2)
  })

  it('updates grants under CAS while connected without restarting the MCP client or changing secrets', async () => {
    const upstream = await endpoint(); const { service, file } = manager(); const saved = saveHttp(service, upstream.url)
    await service.connect(saved.id)
    const updated = service.setGrant(saved.id, { agentTypeIds: ['qq.private'], toolNames: ['fixture_echo'] }, 1)
    expect(updated).toMatchObject({ state: 'connected', grant: { agentTypeIds: ['qq.private'], toolNames: ['fixture_echo'] } })
    expect(updated.tools).toHaveLength(4); expect(service.revision).toBe(2)
    expect(upstream.creations()).toBe(1)
    expect(() => service.setGrant(saved.id, emptyGrant, 1)).toThrowError(expect.objectContaining({ code: 'MCP_REVISION_CONFLICT' }))
    expect(() => service.setGrant(saved.id, { agentTypeIds: [], toolNames: ['*'] }, 2)).toThrowError(expect.objectContaining({ code: 'MCP_CONFIGURATION_INVALID' }))
    const disk = JSON.parse(readFileSync(file, 'utf8')).connections[0]
    expect(disk.url).toBe(upstream.url); expect(disk.headers).toEqual({ authorization: `Bearer ${fixtureSecret}` })
    expect(disk.grant).toEqual(updated.grant)
    await service.call(saved.id, 'fixture_echo', { value: 'still connected' })
    expect(upstream.creations()).toBe(1)
    expect(upstream.received.filter(item => item.method === 'DELETE')).toHaveLength(0)
  })

  it('keeps server isError results raw and does not treat annotations as authorization', async () => {
    const upstream = await endpoint({ call: async () => ({ content: [{ type: 'text', text: 'tool rejected' }], isError: true, structuredContent: { reason: 'fixture' } }) })
    const { service } = manager(); const saved = saveHttp(service, upstream.url)
    await service.connect(saved.id)
    expect(await service.call(saved.id, 'fixture_write', {})).toEqual({ content: [{ type: 'text', text: 'tool rejected' }], isError: true, structuredContent: { reason: 'fixture' } })
    expect(service.get(saved.id).grant).toEqual(emptyGrant)
    await failed(service.call(saved.id, 'missing', {}), 'MCP_TOOL_NOT_FOUND', 'not-sent')
    expect(rpcCalls(upstream.received, 'tools/call')).toHaveLength(1)
  })

  it('never follows redirects or forwards private headers/query to another endpoint', async () => {
    const target = await endpoint(); const upstream = await endpoint({ redirect: target.url })
    const { service } = manager(); const saved = saveHttp(service, upstream.url)
    const error = await service.connect(saved.id).catch((reason: unknown) => reason)
    expect(String(error)).not.toContain(fixtureSecret)
    expect(service.get(saved.id).state).toBe('error')
    expect(target.received).toHaveLength(0)
    expect(upstream.received).toHaveLength(1)
    expect(JSON.stringify(service.list())).not.toContain(fixtureSecret)
  })

  it.each([401, 403, 500])('does not expose an HTTP %s body or automatically retry', async status => {
    const upstream = await endpoint({ status }); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    await expect(service.connect(saved.id)).rejects.toThrow()
    expect(upstream.received).toHaveLength(1)
    expect(JSON.stringify(service.list())).not.toContain(fixtureSecret)
  })

  it('rejects duplicate names and non-advancing tool cursors', async () => {
    for (const options of [{ tools: [tools[0]!, tools[0]!] }, { loopCursor: true }]) {
      const upstream = await endpoint(options); const { service } = manager(); const saved = saveHttp(service, upstream.url)
      await failed(service.connect(saved.id), 'MCP_TOOLS_INVALID')
      expect(service.get(saved.id).tools).toEqual([])
    }
  })

  it('cancels connection initialization and rejects its late result after disconnect', async () => {
    const upstream = await endpoint({ stall: true }); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    const pending = failed(service.connect(saved.id), 'MCP_CONNECT_INTERRUPTED')
    await upstream.initialized
    await service.disconnect(saved.id); await pending
    expect(service.get(saved.id)).toMatchObject({ state: 'disconnected', tools: [] })
  })

  it('bounds the entire initialize and discovery operation to 15 seconds', async () => {
    const upstream = await endpoint({ stall: true }); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = failed(service.connect(saved.id), 'MCP_CONNECT_TIMEOUT')
    await upstream.initialized
    await vi.advanceTimersByTimeAsync(15_000); await pending
    expect(service.get(saved.id).state).toBe('error')
    await service.disconnect(saved.id); vi.useRealTimers()
    expect(rpcCalls(upstream.received, 'initialize')).toHaveLength(1)
    expect(service.get(saved.id).state).toBe('disconnected')
  })

  it('cancels an in-flight tool once and marks its result unknown without reconnecting', async () => {
    const held = deferred<CallToolResult>()
    const upstream = await endpoint({ call: async () => held.promise }); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    await service.connect(saved.id)
    const cancel = new AbortController()
    const pending = failed(service.call(saved.id, 'fixture_write', {}, cancel.signal), 'MCP_REQUEST_ABORTED', 'unknown')
    await upstream.called; cancel.abort(new Error(fixtureSecret)); await pending
    held.resolve({ content: [{ type: 'text', text: 'late success' }] })
    await service.disconnect(saved.id)
    expect(service.get(saved.id).tools).toEqual([])
    expect(rpcCalls(upstream.received, 'tools/call')).toHaveLength(1)
    expect(upstream.creations()).toBe(1)
  })

  it('bounds tools/call to 60 seconds and never retries an uncertain external action', async () => {
    const held = deferred<CallToolResult>()
    const upstream = await endpoint({ call: async () => held.promise }); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    await service.connect(saved.id)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = failed(service.call(saved.id, 'fixture_write', {}), 'MCP_CALL_TIMEOUT', 'unknown')
    await upstream.called; await vi.advanceTimersByTimeAsync(60_000); await pending
    held.resolve({ content: [] }); await service.disconnect(saved.id); vi.useRealTimers()
    expect(rpcCalls(upstream.received, 'tools/call')).toHaveLength(1)
  })

  it('pre-cancelled or invalid arguments are not sent, and closing rejects subsequent work', async () => {
    const upstream = await endpoint(); const { service } = manager(); const saved = saveHttp(service, upstream.url)
    await service.connect(saved.id)
    await failed(service.call(saved.id, 'fixture_echo', {}, AbortSignal.abort()), 'MCP_REQUEST_ABORTED', 'not-sent')
    await failed(service.call(saved.id, 'fixture_echo', { large: 'x'.repeat(1024 * 1024) }), 'MCP_ARGUMENTS_INVALID', 'not-sent')
    expect(rpcCalls(upstream.received, 'tools/call')).toHaveLength(0)
    await Promise.all([service.close(), service.close()])
    await failed(service.connect(saved.id), 'MCP_MANAGER_CLOSED')
    await failed(service.call(saved.id, 'fixture_echo', {}), 'MCP_MANAGER_CLOSED')
    expect(() => saveHttp(service, upstream.url)).toThrowError(expect.objectContaining({ code: 'MCP_MANAGER_CLOSED' }))
  })

  it('removes only the selected connection under CAS and preserves other saved settings', async () => {
    const upstream = await endpoint(); const { service, root } = manager()
    const first = saveHttp(service, upstream.url); const second = saveHttp(service, upstream.url, { name: 'Keep' })
    await service.connect(first.id)
    await failed(service.remove(first.id, 1), 'MCP_REVISION_CONFLICT')
    await service.remove(first.id, 2)
    expect(service.revision).toBe(3); expect(service.list().map(item => item.id)).toEqual([second.id])
    const reopened = new DirectMcpConnections(root); cleanups.push(() => reopened.close())
    expect(reopened.list().map(item => item.id)).toEqual([second.id])
    expect(upstream.received.filter(item => item.method === 'DELETE')).toHaveLength(1)
  })
})

describe('direct MCP real stdio processes', () => {
  it('executes the exact command/args with no shell, supplies only saved secret env, and kills the child on disconnect', async () => {
    const { service, root } = manager(); const marker = join(root, 'stdio.pid'); const shellMarker = join(root, 'must-not-be-created')
    const literal = `$(touch ${shellMarker}) ; echo should-not-run`
    vi.stubEnv('EATING_DIRECT_MCP_AMBIENT_SECRET', fixtureSecret)
    const saved = saveStdio(service, marker, { args: [fixtureScript, marker, literal, 'same', 'same'] })
    expect(existsSync(marker)).toBe(false)
    await service.connect(saved.id)
    const pid = Number(readFileSync(marker, 'utf8'))
    const result = await service.call(saved.id, 'fixture_echo', { value: 'quoted 原文' })
    const block = result.content[0]
    if (!block || block.type !== 'text') throw new Error('Expected fixture text')
    expect(JSON.parse(block.text)).toMatchObject({ pid, args: { value: 'quoted 原文' }, argv: [literal, 'same', 'same'], secret: fixtureSecret, ambient: null })
    expect(existsSync(shellMarker)).toBe(false)
    expect(JSON.stringify(service.get(saved.id))).not.toContain(fixtureSecret)
    expect(service.get(saved.id).tools.find(tool => tool.name === 'fixture_image')).toMatchObject({ readOnly: false, resultFormat: 'content' })
    await service.disconnect(saved.id)
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
    expect(service.get(saved.id).tools).toEqual([])
  })

  it('returns standard image/isError content from a subprocess and closes it on manager shutdown', async () => {
    const { service, root } = manager(); const marker = join(root, 'stdio.pid'); const saved = saveStdio(service, marker)
    await service.connect(saved.id)
    const pid = Number(readFileSync(marker, 'utf8'))
    expect(await service.call(saved.id, 'fixture_image', {})).toEqual({ content: [{ type: 'text', text: 'fixture image' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], structuredContent: { fixture: true } })
    expect(await service.call(saved.id, 'fixture_error', {})).toEqual({ content: [{ type: 'text', text: 'fixture tool rejected' }], isError: true })
    await service.close()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
  })

  it('sanitizes spawn errors and rejects shutdown during startup without leaving a child', async () => {
    const { service, root } = manager(); const missing = saveStdio(service, '', { command: join(root, 'does-not-exist') })
    await expect(service.connect(missing.id)).rejects.toThrow()
    await service.disconnect(missing.id)
    expect(service.get(missing.id).state).not.toBe('connected')
    const marker = join(root, 'startup.pid'); const saved = saveStdio(service, marker, { env: { EATING_DIRECT_MCP_FIXTURE_MODE: 'stall' } })
    const pending = failed(service.connect(saved.id), 'MCP_CONNECT_INTERRUPTED')
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true))
    const pid = Number(readFileSync(marker, 'utf8'))
    await service.close(); await pending
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
    expect(service.get(saved.id).state).toBe('disconnected')
  })

  it('treats a child exiting during an action as unknown and does not spawn a replacement', async () => {
    const { service, root } = manager(); const marker = join(root, 'stdio.pid'); const saved = saveStdio(service, marker)
    await service.connect(saved.id)
    const pid = Number(readFileSync(marker, 'utf8'))
    const pending = failed(service.call(saved.id, 'fixture_hang', {}), 'MCP_CALL_INTERRUPTED', 'unknown')
    process.kill(pid, 'SIGKILL'); await pending
    expect(service.get(saved.id)).toMatchObject({ state: 'error', tools: [] })
    await service.disconnect(saved.id)
    expect(service.get(saved.id).state).toBe('disconnected')
    expect(Number(readFileSync(marker, 'utf8'))).toBe(pid)
  })
})
