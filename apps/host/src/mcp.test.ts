import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { BackendPlugin, JsonValue, PluginToolDefinition } from '@eating/plugin-sdk'
import { createPluginMcpHandler } from './mcp'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

// Test-only backend: no platform account, websocket, Harness, credentials or storage.
function fakePlugin(implementation?: BackendPlugin['invoke']) {
  const tools: PluginToolDefinition[] = [
    { name: 'inspect', title: 'Inspect a value', description: 'Read a test value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, readOnly: true, destructive: false },
    { name: 'remove', title: 'Remove a value', description: 'Remove a test value.', inputSchema: { type: 'object', properties: { value: { type: 'string' }, request_id: { type: 'string', minLength: 8 } }, required: ['value', 'request_id'], additionalProperties: false }, readOnly: false, destructive: true },
  ]
  const invoke = vi.fn<BackendPlugin['invoke']>(implementation ?? (async (name, input, requestId) => {
    if (!isJsonObject(input) || typeof input.value !== 'string') throw new PlatformError('INVALID_INPUT', 'value must be a string.', 400, 'not-sent')
    if (name === 'remove' && (typeof input.request_id !== 'string' || input.request_id.length < 8)) throw new PlatformError('INVALID_INPUT', 'request_id must contain at least eight characters.', 400, 'not-sent')
    if (name === 'inspect' && input.request_id !== undefined) throw new PlatformError('INVALID_INPUT', 'inspect does not accept request_id.', 400, 'not-sent')
    return { value: input.value, correlation: requestId }
  }))
  const plugin: BackendPlugin = {
    id: 'test-platform', name: 'Test Platform', version: '1.2.3', tools, capabilities: [], invoke,
    getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
    getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}),
    connect: async () => {}, disconnect: async () => {}, dispose: async () => {},
  }
  return { plugin, tools, invoke }
}

async function endpoint(plugin: BackendPlugin) {
  const handler = createPluginMcpHandler(plugin)
  const active = new Set<Promise<void>>()
  const bodies: unknown[] = []
  const failures: unknown[] = []
  const server = createHttpServer((req, res) => {
    const task = (async () => {
      let body: unknown
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        bodies.push(body)
      }
      await handler.handle(req, res, body)
    })()
    active.add(task)
    void task.then(() => active.delete(task), error => { failures.push(error); active.delete(task); res.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a temporary TCP server.')
  cleanups.push(async () => {
    await handler.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
  })
  return { handler, url: new URL(`http://127.0.0.1:${address.port}/mcp/${plugin.id}`), bodies, failures, activeCount: () => active.size }
}

async function connect(url: URL) {
  const client = new Client({ name: 'official-sdk-test-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url)
  cleanups.push(() => client.close())
  await client.connect(transport)
  return { client, transport }
}

function rpcCalls(bodies: unknown[]) {
  return bodies.filter(isJsonObject).filter(body => body.method === 'tools/call')
}

describe('per-plugin official MCP Streamable HTTP', () => {
  it('performs official initialize/initialized without issuing a session ID', async () => {
    const { plugin } = fakePlugin()
    const host = await endpoint(plugin)
    const { client, transport } = await connect(host.url)
    expect(client.getServerVersion()).toEqual({ name: plugin.id, title: plugin.name, version: plugin.version })
    expect(client.getServerCapabilities()).toEqual({ tools: {} })
    expect(transport.sessionId).toBeUndefined()
    expect(host.bodies.filter(isJsonObject).map(body => body.method)).toContain('notifications/initialized')
    expect(host.failures).toEqual([])
  })

  it('lists current plugin schemas, titles and actual read-only/destructive hints', async () => {
    const { plugin, tools } = fakePlugin()
    const host = await endpoint(plugin)
    const { client } = await connect(host.url)
    const first = await client.listTools()
    expect(first.tools).toEqual(tools.map(tool => ({ name: tool.name, title: tool.title, description: tool.description,
      inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive } })))
    tools.pop()
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['inspect'])
  })

  it('calls a tool and passes a fresh UUID without adding undeclared arguments', async () => {
    const { plugin, invoke } = fakePlugin()
    const host = await endpoint(plugin)
    const { client } = await connect(host.url)
    const input = { value: 'hello' }
    const result = await client.callTool({ name: 'inspect', arguments: input })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({ result: { value: 'hello', correlation: expect.stringMatching(uuid) }, request_id: expect.stringMatching(uuid) })
    expect(invoke).toHaveBeenCalledWith('inspect', input, expect.stringMatching(uuid))
    expect(input).toEqual({ value: 'hello' })
    if (!isJsonObject(result.structuredContent)) throw new Error('Expected structured JSON tool output.')
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent.result) }])
    await vi.waitFor(() => expect(host.activeCount()).toBe(0))
  })

  it('returns primitive JSON tool data as valid structured MCP content', async () => {
    const { plugin } = fakePlugin(async () => 42)
    const { client } = await connect((await endpoint(plugin)).url)
    expect(await client.callTool({ name: 'inspect', arguments: { value: 'number' } })).toMatchObject({
      isError: false, structuredContent: { result: 42 }, content: [{ type: 'text', text: '42' }],
    })
  })

  it('preserves the caller persistent action key across different official clients', async () => {
    const { plugin, invoke } = fakePlugin()
    const host = await endpoint(plugin)
    const first = await connect(host.url)
    const second = await connect(host.url)
    const args = { value: 'item', request_id: 'persistent-action-key' }
    await first.client.callTool({ name: 'remove', arguments: args })
    await second.client.callTool({ name: 'remove', arguments: args })
    expect(invoke.mock.calls.map(call => call[2])).toEqual(['persistent-action-key', 'persistent-action-key'])
    expect(invoke.mock.calls.map(call => call[1])).toEqual([args, args])
  })

  it.each([
    ['missing', undefined], ['non-string', 123], ['empty', ''], ['too short', 'short'],
    ['too long', 'a'.repeat(129)], ['invalid characters', 'not a stable key'],
  ])('rejects a side-effect tool with a %s request_id without invoking the plugin', async (_name, requestId) => {
    const { plugin, invoke } = fakePlugin()
    const host = await endpoint(plugin)
    const { client } = await connect(host.url)
    const args = { value: 'item', ...(requestId === undefined ? {} : { request_id: requestId }) }
    const result = await client.callTool({ name: 'remove', arguments: args })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_ID_REQUIRED', outcome: 'not-sent' } })
    expect(invoke).not.toHaveBeenCalled()
    expect(result.structuredContent).not.toHaveProperty('request_id')
    expect(args).toEqual({ value: 'item', ...(requestId === undefined ? {} : { request_id: requestId }) })
  })

  it('rejects a non-read-only tool that does not declare request_id even when a caller supplies one', async () => {
    const { plugin, tools, invoke } = fakePlugin()
    tools.push({ name: 'send', title: 'Send a value', description: 'Send a test value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, readOnly: false, destructive: false })
    const { client } = await connect((await endpoint(plugin)).url)
    const result = await client.callTool({ name: 'send', arguments: { value: 'item', request_id: 'persistent-send-key' } })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_ID_REQUIRED', outcome: 'not-sent' } })
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['key12345', 'a'.repeat(128)])('preserves a valid side-effect key at the length boundary: %s', async requestId => {
    const { plugin, invoke } = fakePlugin()
    const { client } = await connect((await endpoint(plugin)).url)
    const args = { value: 'item', request_id: requestId }
    expect(await client.callTool({ name: 'remove', arguments: args })).toMatchObject({ isError: false, structuredContent: { request_id: requestId } })
    expect(invoke).toHaveBeenCalledWith('remove', args, requestId)
  })

  it('retains the same caller key for concurrent side-effect requests from separate clients', async () => {
    const result = deferred<JsonValue>()
    const bothStarted = deferred<void>()
    let started = 0
    const { plugin, invoke } = fakePlugin(async () => { if (++started === 2) bothStarted.resolve(); return result.promise })
    const host = await endpoint(plugin)
    const first = await connect(host.url)
    const second = await connect(host.url)
    const args = { value: 'item', request_id: 'concurrent-persistent-key' }
    const firstCall = first.client.callTool({ name: 'remove', arguments: args })
    const secondCall = second.client.callTool({ name: 'remove', arguments: args })
    await bothStarted.promise
    expect(invoke.mock.calls.map(call => call[2])).toEqual([args.request_id, args.request_id])
    expect(invoke.mock.calls.map(call => call[1])).toEqual([args, args])
    const ids = rpcCalls(host.bodies).map(body => body.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toEqual(ids[1])
    result.resolve({ done: true })
    for (const response of await Promise.all([firstCall, secondCall])) {
      expect(response).toMatchObject({ isError: false, structuredContent: { result: { done: true }, request_id: args.request_id } })
    }
  })

  it('returns unknown tools as isError without invoking a backend', async () => {
    const { plugin, invoke } = fakePlugin()
    const { client } = await connect((await endpoint(plugin)).url)
    const result = await client.callTool({ name: 'missing', arguments: {} })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_NOT_FOUND', outcome: 'not-sent' } })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('lets the plugin reject invalid tool arguments and keeps the endpoint usable', async () => {
    const { plugin, invoke } = fakePlugin()
    const { client } = await connect((await endpoint(plugin)).url)
    const result = await client.callTool({ name: 'inspect', arguments: { value: 123 } })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_INPUT', outcome: 'not-sent', message: 'value must be a string.' } })
    expect(invoke).toHaveBeenCalledOnce()
    expect((await client.listTools()).tools).toHaveLength(2)
    const invalidPayload = await client.callTool({ name: 'remove', arguments: { value: 123, request_id: 'valid-stable-key' } })
    expect(invalidPayload).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_INPUT' } })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'unknown'] as const)('preserves a platform %s outcome rather than reporting success', async outcome => {
    const { plugin } = fakePlugin(async () => { throw new PlatformError('PLATFORM_ACTION', 'The platform action did not complete.', 502, outcome) })
    const { client } = await connect((await endpoint(plugin)).url)
    const result = await client.callTool({ name: 'remove', arguments: { value: 'item', request_id: 'stable-failure-key' } })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'PLATFORM_ACTION', outcome, message: 'The platform action did not complete.', request_id: 'stable-failure-key' } })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }])
  })

  it('does not expose unexpected exception details, credentials or a false success', async () => {
    const { plugin } = fakePlugin(async () => { throw new Error('Authorization: Bearer test-only-sensitive-value') })
    const { client } = await connect((await endpoint(plugin)).url)
    const result = await client.callTool({ name: 'inspect', arguments: { value: 'error' } })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'INTERNAL_ERROR', outcome: 'unknown', message: '插件工具执行失败。' } })
    expect(JSON.stringify(result)).not.toContain('test-only-sensitive-value')
    expect(JSON.stringify(result)).not.toContain('Authorization')
  })

  it('isolates concurrent requests even when separate clients reuse the same JSON-RPC ID', async () => {
    const left = deferred<JsonValue>()
    const right = deferred<JsonValue>()
    const leftStarted = deferred<void>()
    const rightStarted = deferred<void>()
    const { plugin, invoke } = fakePlugin(async (_name, input) => {
      if (isJsonObject(input) && input.value === 'left') { leftStarted.resolve(); return left.promise }
      rightStarted.resolve()
      return right.promise
    })
    const host = await endpoint(plugin)
    const first = await connect(host.url)
    const second = await connect(host.url)
    let leftFinished = false
    const firstCall = first.client.callTool({ name: 'inspect', arguments: { value: 'left' } }).then(result => { leftFinished = true; return result })
    const secondCall = second.client.callTool({ name: 'inspect', arguments: { value: 'right' } })
    await Promise.all([leftStarted.promise, rightStarted.promise])
    const ids = rpcCalls(host.bodies).map(body => body.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toEqual(ids[1])
    const actionIds = invoke.mock.calls.map(call => call[2])
    expect(new Set(actionIds).size).toBe(2)
    expect(actionIds).toEqual([expect.stringMatching(uuid), expect.stringMatching(uuid)])
    right.resolve({ reply: 'right' })
    expect(await secondCall).toMatchObject({ structuredContent: { result: { reply: 'right' } } })
    expect(leftFinished).toBe(false)
    left.resolve({ reply: 'left' })
    expect(await firstCall).toMatchObject({ structuredContent: { result: { reply: 'left' } } })
    await vi.waitFor(() => expect(host.activeCount()).toBe(0))
    expect(host.failures).toEqual([])
  })

  it.each(['GET', 'DELETE', 'PUT'])('rejects unsupported %s with 405 and Allow: POST', async method => {
    const { plugin, invoke } = fakePlugin()
    const host = await endpoint(plugin)
    const response = await fetch(host.url, { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    await response.text()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported content type', { ...headers, 'Content-Type': 'text/plain' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 415, -32000],
    ['missing SSE accept', { ...headers, Accept: 'application/json' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 406, -32000],
    ['unsupported protocol version', { ...headers, 'MCP-Protocol-Version': 'invalid-version' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 400, -32000],
    ['invalid JSON-RPC body', headers, null, 400, -32700],
  ])('delegates %s handling to the official SDK', async (_name, requestHeaders, body, status, code) => {
    const { plugin, invoke } = fakePlugin()
    const host = await endpoint(plugin)
    const response = await fetch(host.url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code } })
    expect(invoke).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(host.activeCount()).toBe(0))
  })

  it('cleans a disconnected request while allowing another client to continue', async () => {
    const blocked = deferred<JsonValue>()
    const started = deferred<void>()
    const { plugin } = fakePlugin(async (_name, input) => {
      if (isJsonObject(input) && input.value === 'blocked') { started.resolve(); return blocked.promise }
      return { alive: true }
    })
    const host = await endpoint(plugin)
    const first = await connect(host.url)
    const pending = first.client.callTool({ name: 'inspect', arguments: { value: 'blocked' } }).then(() => undefined, error => error as Error)
    await started.promise
    await first.client.close()
    expect(await pending).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(host.activeCount()).toBe(0))
    const second = await connect(host.url)
    expect(await second.client.callTool({ name: 'inspect', arguments: { value: 'alive' } })).toMatchObject({ isError: false, structuredContent: { result: { alive: true } } })
    blocked.resolve({ late: true })
    expect(host.failures).toEqual([])
  })

  it('closes active connections immediately, is idempotent and rejects subsequent requests', async () => {
    const blocked = deferred<JsonValue>()
    const started = deferred<void>()
    const { plugin, invoke } = fakePlugin(async () => { started.resolve(); return blocked.promise })
    const host = await endpoint(plugin)
    const { client } = await connect(host.url)
    const pending = client.callTool({ name: 'inspect', arguments: { value: 'blocked' } }).then(() => undefined, error => error as Error)
    await started.promise
    const closing = host.handler.close()
    expect(host.handler.close()).toBe(closing)
    await closing
    expect(await pending).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(host.activeCount()).toBe(0))
    const response = await fetch(host.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) })
    expect(response.status).toBe(503)
    await response.text()
    await expect(connect(host.url)).rejects.toMatchObject({ code: 503 })
    expect(invoke).toHaveBeenCalledOnce()
    blocked.resolve({ late: true })
    expect(host.failures).toEqual([])
  })
})
