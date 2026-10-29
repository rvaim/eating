import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect as connectSocket } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { isJsonObject } from '@eating/plugin-sdk'
import type { AgentInvocationScope, BackendPlugin, BackendPluginEntry, HarnessMessageSink, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server.ts'
import { startOneBotFixture } from '../../../tests/fixtures/onebot.ts'
import { EatingHost } from './app.ts'

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly body: JsonObject
}
interface HttpOptions {
  readonly method?: string
  readonly body?: JsonValue
  readonly headers?: Record<string, string>
}
const cleanups: Array<() => Promise<void>> = []
const temporaryRoots: Array<{ path: string; parent: string }> = []

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object in the integration response')
  return value
}

function http(base: string, path: string, options: HttpOptions = {}): Promise<HttpResult> {
  const method = options.method ?? 'GET'
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, base), {
      method,
      headers: { Host: new URL(base).host, Origin: base, Connection: 'close',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }),
        ...options.headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: JsonObject = {}
        try { body = object(JSON.parse(text)) } catch { /* Some valid MCP error responses are plain text. */ }
        resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, text, body })
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Integration HTTP deadline exceeded')))
    req.end(payload)
  })
}

async function temporaryHome(): Promise<string> {
  const parent = await realpath(tmpdir())
  const path = await realpath(await mkdtemp(join(parent, 'eating_test_')))
  temporaryRoots.push({ path, parent })
  return path
}

async function createHost(home = '', entries: readonly BackendPluginEntry[] = [qqEntry]) {
  const dataDirectory = home || await temporaryHome()
  const host = new EatingHost({ dataDirectory, entries, port: 0, allowedUiOrigins: [] })
  cleanups.push(() => host.close())
  const url = await host.listen()
  const bootstrap = await http(url, '/api/bootstrap')
  expect(bootstrap.status).toBe(200)
  const cookie = bootstrap.headers['set-cookie']?.[0]?.split(';')[0]
  const csrf = bootstrap.body.csrfToken
  if (!cookie || typeof csrf !== 'string') throw new Error('Host bootstrap did not return owner credentials')
  const api = (path: string, options: HttpOptions = {}) => http(url, path, {
    ...options, headers: { Cookie: cookie, 'X-Eating-CSRF': csrf, ...options.headers },
  })
  return { host, url, api, home: dataDirectory, cookie, csrf }
}

function pluginFrom(workspace: JsonObject, id = 'qq'): JsonObject {
  if (!Array.isArray(workspace.plugins)) throw new Error('Expected registered platform list')
  const plugin = workspace.plugins.find(entry => isJsonObject(entry) && entry.id === id)
  return object(plugin)
}

async function configuredHost(options: Parameters<typeof startOneBotFixture>[0] = {}) {
  const token = randomUUID()
  const fixture = await startOneBotFixture({ ...options, accessToken: token })
  cleanups.push(() => fixture.close())
  const context = await createHost()
  const configuration = {
    displayName: '集成测试 QQ', endpoint: fixture.endpoint, accessToken: token,
    autoConnect: false, forwardToHarness: true, receiveGroups: true, timeoutMs: 1000,
  }
  const saved = await context.api('/api/plugins/qq/configuration', { method: 'POST', body: configuration })
  expect(saved.status).toBe(200)
  return { ...context, fixture, configuration, token, saved }
}

async function connectHost(context: Awaited<ReturnType<typeof configuredHost>>) {
  const connected = await context.api('/api/plugins/qq/connect', { method: 'POST', body: {} })
  expect(connected.status).toBe(200)
  expect(connected.body.state).toBe('connected')
  return connected
}

async function mcpClient(context: Awaited<ReturnType<typeof createHost>>, id = 'qq') {
  const registration = await context.api(`/api/plugins/${id}/mcp-registration`, { method: 'POST', body: {} })
  expect(registration.status).toBe(200)
  const endpoint = registration.body.url
  const authorization = object(registration.body.headers).Authorization
  if (typeof endpoint !== 'string' || typeof authorization !== 'string') throw new Error('Missing real MCP registration parameters')
  const client = new Client({ name: 'Eating-real-host-integration-test', version: '1.0.0' })
  cleanups.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: authorization, Origin: context.url, Connection: 'close' } },
  }))
  return { client, endpoint, authorization }
}

function testEntry(id: string, kind: BackendPluginEntry['kind'], inspect: (context: HostPluginContext) => void, overrides: Partial<BackendPlugin> = {}): BackendPluginEntry {
  return { id, kind, storageDirectory: kind === 'harness' ? id : `${id}-bot`, create: context => {
    inspect(context)
    return { id, kind, name: 'Host 边界测试插件', version: '1.0.0', tools: [], capabilities: [],
      getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, connectedAt: null, lastEventAt: null, lastError: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {},
      disconnect: async () => {}, invoke: async () => null, dispose: async () => {}, ...overrides,
    }
  } }
}

function installedEntry(entry: BackendPluginEntry, home: string): BackendPluginEntry {
  return { ...entry, installed: { directory: join(home, 'package'), manifest: {
    schemaVersion: 1, id: entry.id, name: 'Installed fixture', description: 'test', version: '1.0.0', kind: entry.kind, apiVersion: 3, assets: [],
    storageDirectory: entry.storageDirectory, backend: 'server.mjs', integrity: {},
    frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 0, brandColor: '#123456', icon: 'brain' },
  } } }
}

function testSink(id: string): HarnessMessageSink {
  return { id, isReady: () => false, deliverBatch: async () => ({ accepted: true, durable: true, receiptId: 'test-receipt' }) }
}

function invokeBody(name: string, args: JsonObject, requestId = randomUUID(), confirmed?: boolean): JsonObject {
  return { name, arguments: args, requestId, ...(confirmed === undefined ? {} : { confirmed }) }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  for (const root of temporaryRoots.splice(0).reverse()) {
    // Resolve and compare the exact mkdtemp root before recursive deletion.
    const target = await realpath(root.path)
    if (target !== root.path || dirname(target) !== root.parent || !basename(target).startsWith('eating_test_')
      || resolve(target) !== target || (await lstat(target)).isSymbolicLink()) throw new Error('Refusing cleanup outside the verified test root')
    await rm(target, { recursive: true })
  }
  if (failures.length) throw new AggregateError(failures, 'Integration resources did not close cleanly')
})

describe('generic Host Harness services and management boundary', () => {
  it.each([false, true])('respects transient startup auto-connect=%s without changing saved preferences', async autoConnectOnStartup => {
    const home = await temporaryHome(), connect = vi.fn(async () => {})
    const entry = testEntry('dsh', 'harness', () => {}, { connect, getPublicConfiguration: () => ({ autoConnect: true }) })
    const host = new EatingHost({ dataDirectory: home, entries: [entry], port: 0, autoConnectOnStartup })
    cleanups.push(() => host.close())
    await host.listen()
    expect(connect).toHaveBeenCalledTimes(autoConnectOnStartup ? 1 : 0)
    const workspace = host.getWorkspace(), plugins = workspace.plugins
    if (!Array.isArray(plugins) || !isJsonObject(plugins[0])) throw new Error('Missing plugin')
    expect(plugins[0].configuration).toEqual({ autoConnect: true })
  })

  it('isolates Harness and communication roots using explicit matching entry, manifest and plugin kinds', async () => {
    const home = await temporaryHome()
    const captured = new Map<string, HostPluginContext>()
    const capture = (id: string) => (context: HostPluginContext) => { captured.set(id, context) }
    const communication = testEntry('comm', 'communication', capture('comm'))
    const source = testEntry('dsh', 'harness', capture('dsh'))
    const installed = installedEntry(testEntry('installed', 'harness', capture('installed')), home)
    const context = await createHost(home, [communication, source, installed])
    expect(captured.get('comm')?.dataDirectory).toBe(join(home, 'bot', 'comm-bot'))
    expect(captured.get('comm')).not.toHaveProperty('harness')
    expect(captured.get('dsh')?.dataDirectory).toBe(join(home, 'harness', 'dsh'))
    expect(captured.get('installed')?.dataDirectory).toBe(join(home, 'harness', 'installed'))
    expect(captured.get('installed')?.harness).toBeDefined()
    for (const [id, pluginContext] of captured) {
      await mkdir(pluginContext.dataDirectory, { recursive: true })
      await writeFile(join(pluginContext.dataDirectory, 'probe.txt'), id)
    }
    expect(await readFile(join(home, 'harness', 'dsh', 'probe.txt'), 'utf8')).toBe('dsh')
    await expect(stat(join(home, 'bot', 'dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
    const workspace = (await context.api('/api/workspace')).body
    expect(pluginFrom(workspace, 'comm').kind).toBe('communication')
    expect(pluginFrom(workspace, 'dsh').kind).toBe('harness')
    expect(pluginFrom(workspace, 'installed').kind).toBe('harness')
  })

  it('rejects a source entry without kind before executing its factory and releases its workspace lock', async () => {
    const home = await temporaryHome()
    const inspect = vi.fn()
    const entry = testEntry('comm', 'communication', inspect)
    await expect(createHost(home, [{ ...entry, kind: undefined } as unknown as BackendPluginEntry])).rejects.toThrow('插件标识、类型或数据目录声明非法')
    expect(inspect).not.toHaveBeenCalled()
    expect(pluginFrom((await (await createHost(home, [entry])).api('/api/workspace')).body, 'comm').kind).toBe('communication')
  })

  it.each([undefined, 'harness'] as const)('rejects a plugin whose runtime kind %s does not match its communication entry', async kind => {
    const entry = testEntry('comm', 'communication', () => {}, { kind })
    await expect(createHost('', [entry])).rejects.toThrow('插件后台身份或类型不匹配')
  })

  it('rejects conflicting installed kinds and an old manifest API before executing package code', async () => {
    const home = await temporaryHome()
    const inspect = vi.fn()
    const entry = installedEntry(testEntry('dsh', 'harness', inspect), home)
    const wrongKind = { ...entry, kind: 'communication' as const, storageDirectory: 'dsh-bot' }
    await expect(createHost(home, [wrongKind])).rejects.toThrow('插件后台入口与安装清单的类型不匹配')
    const oldApi = { ...entry, installed: { ...entry.installed!, manifest: { ...entry.installed!.manifest, apiVersion: 1 } } } as unknown as BackendPluginEntry
    await expect(createHost(home, [oldApi])).rejects.toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_PLUGIN_API' }))
    expect(inspect).not.toHaveBeenCalled()
  })

  it('returns a deeply immutable owner configuration copy without any write service', async () => {
    let pluginContext!: HostPluginContext
    const context = await createHost('', [testEntry('dsh', 'harness', value => { pluginContext = value })])
    const services = pluginContext.harness!
    const initial = services.readOwnerConfiguration()
    expect(initial).toMatchObject({ revision: 0, activePersona: null })
    expect(context.host.store.getSetting('host:authoring')).toBeNull()
    const persona = context.host.authoring.createPersona('主人设定', '固定人格{{人格名称}}').persona
    const snapshot = context.host.authoring.getSnapshot()
    context.host.authoring.setPersonaEnabled(persona.id, true, snapshot.revision)
    const configuration = services.readOwnerConfiguration()
    expect(configuration.activePersona).toMatchObject({ id: persona.id, body: persona.body })
    expect(Object.isFrozen(configuration)).toBe(true)
    expect(Object.isFrozen(configuration.prompts)).toBe(true)
    expect(configuration.prompts.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(configuration.activePersona)).toBe(true)
    expect(Reflect.set(configuration.prompts[0]!, 'body', 'override')).toBe(false)
    expect(Reflect.set(configuration.activePersona!, 'body', 'override')).toBe(false)
    expect(Object.keys(services).sort()).toEqual(['getMcpConnection', 'readAgentActions', 'readOwnerConfiguration', 'registerSink', 'revokeAgentAccess', 'wake'])
    const updated = context.host.authoring.updatePersona(persona.id, persona.name, '主人新设定', persona.revision)
    expect(configuration.activePersona?.body).toBe(persona.body)
    expect(services.readOwnerConfiguration().activePersona?.body).toBe(updated.persona.body)
  })

  it('gives Harness plugins only scoped communication MCP credentials and requires a complete scope', async () => {
    const home = await temporaryHome()
    let harnessContext!: HostPluginContext
    let communicationContext!: HostPluginContext
    const scopedEntry = (id: string, inspect: (context: HostPluginContext) => void) => testEntry(id, 'communication', inspect, {
      agentTypes: [{ id: `${id}.private`, title: '测试私聊代理', description: '测试范围', conversationKind: 'private', defaultPrompt: '测试代理', availableTools: [], defaultTools: [], enabledTools: [] }],
      invokeScoped: async () => null,
    })
    const scope = (pluginId: string): AgentInvocationScope => ({ agentId: `agent-${pluginId}`, agentTypeId: `${pluginId}.private`, pluginId,
      instanceId: 'instance-one', accountId: 'account-one', conversationId: `${pluginId}:private:target`, kind: 'private', targetId: 'target', messageIds: [], resourceIds: [] })
    const entries = [scopedEntry('comm', value => { communicationContext = value }), scopedEntry('other', () => {}),
      testEntry('dsh', 'harness', value => { harnessContext = value })]
    const unstarted = new EatingHost({ dataDirectory: home, entries, port: 0, allowedUiOrigins: [] })
    cleanups.push(() => unstarted.close())
    expect(communicationContext.harness).toBeUndefined()
    expect(() => harnessContext.harness!.getMcpConnection('comm', scope('comm'))).toThrow(expect.objectContaining({ code: 'HOST_NOT_LISTENING' }))
    expect(unstarted.store.getSetting('comm:mcp-token')).toBeNull()
    await unstarted.close()
    const context = await createHost(home, entries)
    const services = harnessContext.harness!
    const first = services.getMcpConnection('comm', scope('comm')), second = services.getMcpConnection('other', scope('other'))
    expect(first.url).toBe(`${context.url}/mcp/comm`)
    expect(first.headers.Authorization?.startsWith('Bearer ')).toBe(true)
    expect(first.headers.Authorization === second.headers.Authorization).toBe(false)
    expect(context.host.store.getSetting('comm:mcp-token')).toBeNull()
    expect(context.host.store.getSetting('other:mcp-token')).toBeNull()
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.headers)).toBe(true)
    for (const missingScope of [undefined, null, {}]) {
      expect(() => services.getMcpConnection('comm', missingScope as unknown as AgentInvocationScope)).toThrow(expect.objectContaining({ code: 'AGENT_SCOPE_VIOLATION' }))
    }
    expect(() => services.getMcpConnection('dsh', scope('dsh'))).toThrow(expect.objectContaining({ code: 'PLUGIN_SCOPE_VIOLATION' }))
    expect(() => services.getMcpConnection('missing', scope('missing'))).toThrow(expect.objectContaining({ code: 'PLUGIN_NOT_FOUND' }))
    const wrongScope = await http(context.url, '/mcp/other', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { Authorization: first.headers.Authorization! } })
    expect(wrongScope.status).toBe(401)
    const fresh = services.getMcpConnection('comm', scope('comm'))
    expect(fresh.headers.Authorization).not.toBe(first.headers.Authorization)
    expect(services.readAgentActions('agent-comm')).toEqual([])
    services.revokeAgentAccess('agent-comm')
    const revoked = await http(context.url, '/mcp/comm', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { Authorization: fresh.headers.Authorization! } })
    expect(revoked.status).toBe(401)
    const ownerRegistration = await context.api('/api/plugins/comm/mcp-registration', { method: 'POST', body: {} })
    expect(ownerRegistration.status).toBe(200)
    expect(object(ownerRegistration.body.headers).Authorization).not.toBe(first.headers.Authorization)
    const workspace = await context.api('/api/workspace')
    expect(workspace.text.includes(second.headers.Authorization!)).toBe(false)
    expect((await context.api('/api/plugins/comm/disable', { method: 'POST', body: {} })).status).toBe(200)
    expect(() => services.getMcpConnection('comm', scope('comm'))).toThrow(expect.objectContaining({ code: 'PLUGIN_DISABLED' }))
    expect((await context.api('/api/plugins/dsh/disable', { method: 'POST', body: {} })).status).toBe(200)
    expect(() => services.getMcpConnection('other', scope('other'))).toThrow(expect.objectContaining({ code: 'PLUGIN_DISABLED' }))
  })

  it('allows the enabled plugin to register inside connect and preserves a single primary sink', async () => {
    let first!: HostPluginContext, second!: HostPluginContext
    const entry = testEntry('dsh', 'harness', value => { first = value }, { connect: async () => { first.harness!.registerSink(testSink('dsh')) } })
    const other = testEntry('alternate', 'harness', value => { second = value })
    const context = await createHost('', [entry, other])
    expect(() => first.harness!.registerSink({ id: 'dsh', deliver: async () => ({ accepted: false }) } as unknown as HarnessMessageSink)).toThrow('必须提供 deliverBatch 函数')
    expect(() => first.harness!.registerSink(testSink('alternate'))).toThrow(expect.objectContaining({ code: 'PLUGIN_SCOPE_VIOLATION' }))
    expect((await context.api('/api/plugins/dsh/connect', { method: 'POST', body: {} })).status).toBe(200)
    expect(context.host.harness.getStatus()).toMatchObject({ state: 'attached', sinkId: 'dsh' })
    expect(() => second.harness!.registerSink(testSink('alternate'))).toThrow('同一工作区仅允许一个主要 Harness 接收者。')
    const wake = vi.spyOn(context.host.harness, 'notify')
    second.harness!.wake()
    expect(wake).not.toHaveBeenCalled()
    first.harness!.wake()
    expect(wake).toHaveBeenCalledOnce()
    expect((await context.api('/api/plugins/dsh/disconnect', { method: 'POST', body: {} })).status).toBe(200)
    expect(context.host.harness.getStatus().state).toBe('not-attached')
    second.harness!.registerSink(testSink('alternate'))
    const closeGateway = vi.spyOn(context.host.harness, 'close')
    await context.host.close()
    expect(closeGateway).toHaveBeenCalledOnce()
    expect(() => second.harness!.registerSink(testSink('alternate'))).toThrow(expect.objectContaining({ code: 'HOST_STOPPED' }))
    wake.mockClear()
    second.harness!.wake()
    expect(wake).not.toHaveBeenCalled()
  })

  it('revokes a sink and persists disabled state even when disconnect fails or attempts to re-register', async () => {
    let pluginContext!: HostPluginContext
    let attempted = false
    const entry = testEntry('dsh', 'harness', value => { pluginContext = value }, { disconnect: async () => {
      attempted = true
      expect(() => pluginContext.harness!.registerSink(testSink('dsh'))).toThrow(expect.objectContaining({ code: 'PLUGIN_DISABLED' }))
      throw new Error('fixture disconnect failure')
    } })
    const context = await createHost('', [entry])
    pluginContext.harness!.registerSink(testSink('dsh'))
    const response = await context.api('/api/plugins/dsh/disable', { method: 'POST', body: {} })
    expect(response.status).toBe(500)
    expect(attempted).toBe(true)
    expect(context.host.harness.getStatus().state).toBe('not-attached')
    expect(pluginFrom((await context.api('/api/workspace')).body, 'dsh').enabled).toBe(false)
    expect(() => pluginContext.harness!.registerSink(testSink('dsh'))).toThrow(expect.objectContaining({ code: 'PLUGIN_DISABLED' }))
    await context.host.close()
    const restarted = await createHost(context.home, [entry])
    expect(pluginFrom((await restarted.api('/api/workspace')).body, 'dsh').enabled).toBe(false)
  })

  it('clears registrations before disposal even on failure', async () => {
    let pluginContext!: HostPluginContext
    let unregister!: () => void
    let stateAtDispose: JsonValue | undefined
    const dispose = vi.fn(async () => {
      stateAtDispose = context.host.harness.getStatus().state
      unregister()
      throw new Error('fixture dispose failure')
    })
    const entry = testEntry('dsh', 'harness', value => { pluginContext = value }, { dispose })
    const context = await createHost('', [entry])
    unregister = pluginContext.harness!.registerSink(testSink('dsh'))
    await context.host.close()
    expect(dispose).toHaveBeenCalledOnce()
    expect(stateAtDispose).toBe('not-attached')
  })

  it('keeps manage owner-only, validates input, and excludes management from MCP tools', async () => {
    const manage = vi.fn(async (operation: string, input: unknown) => ({ operation, supplied: input !== undefined }))
    const invoke = vi.fn(async () => null)
    const context = await createHost('', [testEntry('dsh', 'harness', () => {}, { manage, invoke }), testEntry('comm', 'communication', () => {})])
    const path = '/api/plugins/dsh/manage', body = { operation: 'install', input: { source: 'approved' } }
    expect((await http(context.url, path, { method: 'POST', body })).status).toBe(401)
    expect((await http(context.url, path, { method: 'POST', body, headers: { Cookie: context.cookie } })).status).toBe(403)
    expect((await context.api(path, { method: 'POST', body, headers: { Origin: 'https://outside.invalid' } })).status).toBe(403)
    expect((await context.api(path)).status).toBe(405)
    expect((await context.api(path, { method: 'POST', body: { operation: 2 } })).status).toBe(400)
    expect((await context.api(path, { method: 'POST', body })).body).toEqual({ operation: 'install', supplied: true })
    expect(manage).toHaveBeenCalledExactlyOnceWith('install', { source: 'approved' })
    expect((await context.api(path, { method: 'POST', body: { operation: 'status' } })).body).toEqual({ operation: 'status', supplied: false })
    expect((await context.api('/api/plugins/comm/manage', { method: 'POST', body })).status).toBe(404)
    const { client } = await mcpClient(context, 'dsh')
    expect((await client.listTools()).tools).toEqual([])
    expect(await client.callTool({ name: 'install', arguments: {} })).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_NOT_FOUND' } })
    expect(manage).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('serializes manage with connection and configuration changes and rejects registrations inside management', async () => {
    let pluginContext!: HostPluginContext, finish!: (value: JsonValue) => void
    const manage = vi.fn(async () => {
      expect(() => pluginContext.harness!.registerSink(testSink('dsh'))).toThrow(expect.objectContaining({ code: 'PLUGIN_BUSY' }))
      return new Promise<JsonValue>(resolveValue => { finish = resolveValue })
    })
    const context = await createHost('', [testEntry('dsh', 'harness', value => { pluginContext = value }, { manage })])
    const pending = context.api('/api/plugins/dsh/manage', { method: 'POST', body: { operation: 'start' } })
    await vi.waitFor(() => expect(manage).toHaveBeenCalledOnce())
    for (const operation of ['manage', 'connect', 'configuration', 'disable']) {
      const result = await context.api(`/api/plugins/dsh/${operation}`, { method: 'POST', body: { operation: 'start' } })
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ error: { code: 'PLUGIN_BUSY' } })
    }
    finish({ state: 'started' })
    expect((await pending).body).toEqual({ state: 'started' })
    expect((await context.api('/api/plugins/dsh/connect', { method: 'POST', body: {} })).status).toBe(200)
  })
})

describe('real Eating Host → QQ OneBot → SQLite → authenticated MCP', () => {
  it('closes keep-alive polling requests arriving while an earlier request drains during shutdown', async () => {
    const context = await createHost()
    const socket = connectSocket({ host: '127.0.0.1', port: Number(new URL(context.url).port) })
    cleanups.push(async () => { socket.destroy() })
    const connected = new Promise<void>((resolveConnected, reject) => { socket.once('connect', resolveConnected); socket.once('error', reject) })
    let receivedContinue!: () => void
    const requestAccepted = new Promise<void>(resolveAccepted => { receivedContinue = resolveAccepted })
    const drained = new Promise<string>((resolveDrained, reject) => {
      let content = ''
      socket.on('data', chunk => { content += chunk.toString('utf8'); if (content.includes('100 Continue')) receivedContinue() })
      socket.once('end', () => resolveDrained(content)); socket.once('error', reject)
    })
    await connected
    await new Promise<void>(resolveWritten => socket.write(`POST /api/plugins/qq/invoke HTTP/1.1\r\nHost: ${new URL(context.url).host}\r\nCookie: ${context.cookie}\r\nX-Eating-CSRF: ${context.csrf}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\nConnection: keep-alive\r\n\r\n{`, () => resolveWritten()))
    await requestAccepted
    const stopping = context.host.close()
    socket.write(`}GET /api/workspace HTTP/1.1\r\nHost: ${new URL(context.url).host}\r\nCookie: ${context.cookie}\r\nConnection: keep-alive\r\n\r\n`)
    const responses = await drained
    expect(responses).toContain('503 Service Unavailable')
    expect(responses).toMatch(/Connection: close/i)
    await stopping
  })

  it('persists owner prompts and rejects invalid variables, stale updates and unauthenticated mutations', async () => {
    const context = await createHost()
    expect((await http(context.url, '/api/authoring')).status).toBe(401)
    const initial = (await context.api('/api/authoring')).body
    expect(initial).toMatchObject({ protocolVersion: 1, revision: 0, activePersonaId: null, personas: [] })
    const body = '主人编辑的主策略 {{当前时间}}'
    expect((await http(context.url, '/api/prompts/main', { method: 'POST', headers: { Cookie: context.cookie }, body: { expectedRevision: 0, body } })).status).toBe(403)
    expect((await context.api('/api/prompts/main', { method: 'POST', body: { expectedRevision: 0, body: '{{不存在}}' } })).status).toBe(400)
    const saved = await context.api('/api/prompts/main', { method: 'POST', body: { expectedRevision: 0, body } })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ revision: 1, prompts: expect.arrayContaining([expect.objectContaining({ id: 'main', body, revision: 1 })]) })
    expect((await context.api('/api/prompts/main', { method: 'POST', body: { expectedRevision: 0, body: '过期覆盖' } })).status).toBe(409)
    expect((await context.api('/api/prompts/main', { method: 'POST', body: { expectedRevision: 1, body: '{{消息内容}}' } })).status).toBe(400)
    await context.host.close()
    const restarted = await createHost(context.home)
    const persisted = (await restarted.api('/api/authoring')).body
    expect(persisted).toMatchObject({ revision: 1, prompts: expect.arrayContaining([expect.objectContaining({ id: 'main', body, revision: 1 })]) })
  })

  it('creates multiple personas without activation and atomically enables only one', async () => {
    const context = await createHost()
    const make = async (name: string) => {
      const response = await context.api('/api/personas', { method: 'POST', body: { name, body: `我是{{人格名称}}，当前时间{{当前时间}}。` } })
      expect(response.status).toBe(201)
      return object(response.body.persona)
    }
    const first = await make('第一人格'), second = await make('第二人格')
    expect(first.id).not.toBe(second.id)
    const initial = (await context.api('/api/authoring')).body
    expect(initial.activePersonaId).toBeNull()
    const activeA = await context.api(`/api/personas/${String(first.id)}/activate`, { method: 'POST', body: { expectedRevision: initial.revision!, enabled: true } })
    expect(activeA.body.activePersonaId).toBe(first.id)
    const activeB = await context.api(`/api/personas/${String(second.id)}/activate`, { method: 'POST', body: { expectedRevision: activeA.body.revision!, enabled: true } })
    expect(activeB.body.activePersonaId).toBe(second.id)
    expect((await context.api(`/api/personas/${String(second.id)}/delete`, { method: 'POST', body: { expectedRevision: second.revision!, confirmed: true } })).status).toBe(409)
    expect((await context.api(`/api/personas/${String(first.id)}/delete`, { method: 'POST', body: { expectedRevision: first.revision! } })).status).toBe(409)
    expect((await context.api(`/api/personas/${String(first.id)}/activate`, { method: 'POST', body: { expectedRevision: activeA.body.revision!, enabled: true } })).status).toBe(409)
    expect((await context.api(`/api/personas/${String(first.id)}/delete`, { method: 'POST', body: { expectedRevision: first.revision!, confirmed: true } })).status).toBe(200)
    expect((await context.api(`/api/personas/${String(second.id)}`)).body).toMatchObject({ name: '第二人格', body: '我是{{人格名称}}，当前时间{{当前时间}}。' })
  })

  it('applies authenticated settings atomically and rejects stale revisions or invalid values', async () => {
    const context = await createHost()
    expect((await http(context.url, '/api/settings')).status).toBe(401)
    const initial = await context.api('/api/settings')
    expect(initial.status).toBe(200)
    expect(initial.body).toMatchObject({ protocolVersion: 1, revision: 0, values: { storageMode: 'persistent', quietWindowMs: 500, maxWaitMs: 2000 }, queue: { queuedMessages: 0 } })
    const values = { ...object(initial.body.values), quietWindowMs: 800, maxWaitMs: 2500 }
    expect((await http(context.url, '/api/settings', { method: 'POST', headers: { Cookie: context.cookie }, body: { expectedRevision: 0, values } })).status).toBe(403)
    const saved = await context.api('/api/settings', { method: 'POST', body: { expectedRevision: 0, values } })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ revision: 1, values: { quietWindowMs: 800, maxWaitMs: 2500 } })
    const stale = await context.api('/api/settings', { method: 'POST', body: { expectedRevision: 0, values } })
    expect(stale.status).toBe(409)
    expect(object(stale.body.error).code).toBe('DELIVERY_SETTINGS_CONFLICT')
    const invalid = await context.api('/api/settings', { method: 'POST', body: { expectedRevision: 1, values: { ...values, maxWaitMs: 1 } } })
    expect(invalid.status).toBe(400)
    expect((await context.api('/api/settings')).body).toMatchObject({ revision: 1, values: { quietWindowMs: 800, maxWaitMs: 2500 } })
    await context.host.close()
    const reopened = await createHost(context.home)
    expect((await reopened.api('/api/settings')).body).toMatchObject({ revision: 1, values: { quietWindowMs: 800, maxWaitMs: 2500 } })
  })

  it('keeps memory-mode bodies out of SQLite and loses only outstanding RAM deliveries on restart', async () => {
    const context = await configuredHost()
    const initial = (await context.api('/api/settings')).body
    expect((await context.api('/api/settings', { method: 'POST', body: { expectedRevision: initial.revision!, values: { ...object(initial.values), storageMode: 'memory' } } })).status).toBe(200)
    await connectHost(context)
    context.fixture.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: 61001, message: 'only-in-ram', raw_message: 'only-in-ram' })
    await vi.waitFor(() => expect(context.host.store.getDeliverySettingsSnapshot().queue.queuedMessages).toBe(1))
    const inspection = new DatabaseSync(context.host.store.databasePath, { readOnly: true })
    try { expect(inspection.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get()?.count).toBe(0) }
    finally { inspection.close() }
    await context.host.close()
    const reopened = await createHost(context.home)
    expect((await reopened.api('/api/settings')).body).toMatchObject({ values: { storageMode: 'memory' }, queue: { queuedMessages: 0, queuedBytes: 0 } })
  })

  it('reports capacity rejection without storing the rejected body or disabling active QQ reception', async () => {
    const context = await configuredHost()
    const initial = (await context.api('/api/settings')).body
    expect((await context.api('/api/settings', { method: 'POST', body: { expectedRevision: initial.revision!, values: { ...object(initial.values), maxQueuedMessages: 1, maxBatchMessages: 1 } } })).status).toBe(200)
    await connectHost(context)
    for (const [message_id, message] of [[62001, 'accepted-to-queue'], [62002, 'rejected-from-queue']] as const) context.fixture.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id, message })
    await vi.waitFor(() => expect(context.host.store.getDeliverySettingsSnapshot().queue.rejected).toBe(1))
    expect(context.host.store.getQueuedHarnessEvents().map(item => item.event.text)).toEqual(['accepted-to-queue'])
    const workspace = (await context.api('/api/workspace')).body
    expect(object(pluginFrom(workspace).status).state).toBe('connected')
    expect(object(workspace.harness)).toMatchObject({ pending: 1, rejected: 1 })
    expect((await context.api('/api/settings')).body).toMatchObject({ queue: { queuedMessages: 1, rejected: 1 } })
  })

  it('requires explicit queue clearing and refuses to clear a delivery already in flight', async () => {
    const context = await configuredHost()
    const initial = (await context.api('/api/settings')).body
    expect((await context.api('/api/settings', { method: 'POST', body: { expectedRevision: initial.revision!, values: { ...object(initial.values), quietWindowMs: 0 } } })).status).toBe(200)
    await connectHost(context)
    const send = (message_id: number) => context.fixture.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id, message: 'pending-clear-test' })
    send(63001)
    await vi.waitFor(() => expect(context.host.store.getDeliverySettingsSnapshot().queue.queuedMessages).toBe(1))
    expect((await context.api('/api/settings/queue/clear', { method: 'POST', body: { expectedRevision: 1 } })).status).toBe(409)
    const clear = await context.api('/api/settings/queue/clear', { method: 'POST', body: { expectedRevision: 1, confirmed: true } })
    expect(clear.status).toBe(200)
    expect(clear.body).toMatchObject({ queue: { queuedMessages: 0, discarded: 1 } })
    send(63002)
    await vi.waitFor(() => expect(context.host.store.getDeliverySettingsSnapshot().queue.queuedMessages).toBe(1))
    const detach = context.host.harness.register({ id: 'clear-test', deliverBatch: async () => new Promise(() => {}) })
    await vi.waitFor(() => expect(context.host.store.getDeliverySettingsSnapshot().queue.delivering).toBe(1))
    expect((await context.api('/api/settings/queue/clear', { method: 'POST', body: { expectedRevision: 1, confirmed: true } })).status).toBe(409)
    expect(context.host.store.getDeliverySettingsSnapshot().queue.delivering).toBe(1)
    detach()
  })

  it('bootstraps the owner, saves per-instance credentials privately, connects health and exposes actual MCP tools', async () => {
    const context = await configuredHost()
    const workspace = await context.api('/api/workspace')
    expect(workspace.status).toBe(200)
    expect(workspace.text).not.toContain(context.token)
    expect(workspace.text).not.toContain('accessToken')
    const configuration = object(pluginFrom(workspace.body).configuration)
    const instanceId = configuration.instanceId
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/u)
    const accountRoot = join(context.home, 'bot', 'qq-bot')
    const expectedPath = join(accountRoot, 'accounts', String(instanceId), 'config.json')
    expect(configuration.configurationPath).toBe(expectedPath)
    expect(configuration.tokenConfigured).toBe(true)
    const disk = object(JSON.parse(await readFile(expectedPath, 'utf8')))
    expect(object(disk.configuration)).toEqual({ ...context.configuration, owners: [], administrators: [], policyRevision: 0,
      agentTools: { 'qq.private': expect.arrayContaining(['qq_send_private_message', 'qq_get_message']), 'qq.group': expect.arrayContaining(['qq_send_group_message', 'qq_get_message']) } })
    const accounts = object(JSON.parse(await readFile(join(accountRoot, 'accounts.json'), 'utf8')))
    expect(accounts.defaultInstanceId).toBe(instanceId)
    expect(accounts.instances).toHaveLength(1)
    expect(context.host.store.databasePath).toBe(join(context.home, 'host', 'Eating.sqlite'))
    if (process.platform !== 'win32') {
      for (const directory of [join(context.home, 'host'), accountRoot, join(accountRoot, 'accounts'), dirname(expectedPath)]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
      }
      for (const path of [expectedPath, join(accountRoot, 'accounts.json'), context.host.store.databasePath]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    }
    const connected = await connectHost(context)
    expect(connected.body).toMatchObject({ accountId: '123456789', accountName: '本地协议测试账号' })
    expect(context.fixture.handshakes[0]?.headers.authorization).toBe(`Bearer ${context.token}`)
    expect(context.fixture.handshakes[0]?.url).toBe('/')
    expect(context.fixture.requests.map(entry => entry.action)).toEqual(['get_login_info', 'get_status'])
    const { client, endpoint, authorization } = await mcpClient(context)
    expect(endpoint).toBe(`${context.url}/mcp/qq`)
    expect(authorization).not.toContain(context.token)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name)).toContain('qq_send_private_message')
    const result = await client.callTool({ name: 'qq_get_friend_list', arguments: {} })
    expect(result).toMatchObject({ isError: false, structuredContent: { result: [{ user_id: 987654321 }] } })
    expect(context.fixture.requests.at(-1)?.action).toBe('get_friend_list')
    const missingActionKey = await client.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: '缺少稳定键不得发送' } })
    expect(missingActionKey).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_ID_REQUIRED', outcome: 'not-sent' } })
    expect(context.fixture.requests.filter(entry => entry.action === 'send_private_msg')).toHaveLength(0)
  })

  it('deduplicates outstanding deliveries without exposing a local chat history tool', async () => {
    const context = await configuredHost()
    await connectHost(context)
    const event = { post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321,
      message_id: 17, time: 1700000000, message: [{ type: 'text', data: { text: '集成链路消息' } }], raw_message: '集成链路消息' }
    context.fixture.emitEvent(event)
    context.fixture.emitEvent(event)
    await vi.waitFor(() => expect(context.host.store.listMessages('qq')).toHaveLength(1))
    expect(context.host.store.listMessages('qq')[0]).toMatchObject({
      conversationId: 'qq:123456789:private:987654321', text: '集成链路消息', harnessStatus: 'pending', raw: {},
    })
    expect(context.host.harness.getStatus()).toMatchObject({ state: 'not-attached', pending: 1, accepted: 0, uncertain: 0 })
    const read = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_list_received_messages', {
      conversation_id: 'qq:123456789:private:987654321', limit: 10,
    }) })
    expect(read.status).toBe(404)
    expect(object(read.body.error).code).toBe('TOOL_NOT_FOUND')
    expect(context.fixture.requests).toHaveLength(2)
    const { client } = await mcpClient(context)
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('qq_list_received_messages')
    const oldInstance = object(pluginFrom((await context.api('/api/workspace')).body).configuration).instanceId
    await context.host.close()
    const restarted = await createHost(context.home)
    const afterRestart = await restarted.api('/api/workspace')
    expect(object(pluginFrom(afterRestart.body).configuration).instanceId).toBe(oldInstance)
    expect(restarted.host.store.listMessages('qq')).toHaveLength(1)
    expect(restarted.host.harness.getStatus()).toMatchObject({ state: 'not-attached', pending: 1, accepted: 0 })
  })

  it('requires explicit HTTP confirmation and persists successful request IDs without sending twice', async () => {
    const context = await configuredHost()
    await connectHost(context)
    const requestId = randomUUID()
    const args = { user_id: '987654321', message: '仅本地夹具发送验证' }
    const unconfirmed = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId) })
    expect(unconfirmed.status).toBe(409)
    expect(object(unconfirmed.body.error).code).toBe('ACTION_CONFIRMATION_REQUIRED')
    expect(context.fixture.requests.filter(entry => entry.action === 'send_private_msg')).toHaveLength(0)
    const first = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId, true) })
    const repeated = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId, true) })
    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    expect(repeated.body.result).toEqual(first.body.result)
    const actions = context.fixture.requests.filter(entry => entry.action === 'send_private_msg')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.params).toEqual({ user_id: 987654321, message: args.message, auto_escape: true })
    const conflict = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', { ...args, message: '参数变化' }, requestId, true) })
    expect(conflict.status).toBe(409)
    expect(object(conflict.body.error).code).toBe('IDEMPOTENCY_CONFLICT')
    await context.host.close()
    const restarted = await createHost(context.home)
    expect((await restarted.api('/api/plugins/qq/connect', { method: 'POST', body: {} })).status).toBe(200)
    const afterRestart = await restarted.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId, true) })
    expect(afterRestart.status).toBe(200)
    expect(afterRestart.body.result).toEqual(first.body.result)
    expect(context.fixture.requests.filter(entry => entry.action === 'send_private_msg')).toHaveLength(1)
  })

  it('retains timeout unknown outcomes across HTTP, MCP and Host restart without resending the action', async () => {
    const context = await configuredHost({ onRequest: entry => entry.action === 'send_private_msg' })
    await connectHost(context)
    const requestId = randomUUID()
    const args = { user_id: '987654321', message: '夹具刻意不回应' }
    const initial = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId, true) })
    expect(initial.status).toBe(504)
    expect(initial.body).toMatchObject({ ok: false, error: { code: 'onebot_request_timeout', outcome: 'unknown' } })
    const repeated = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId, true) })
    expect(repeated.status).toBe(409)
    expect(repeated.body).toMatchObject({ error: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    const { client } = await mcpClient(context)
    expect(await client.callTool({ name: 'qq_send_private_message', arguments: { ...args, request_id: requestId } })).toMatchObject({
      isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown', request_id: requestId },
    })
    await context.host.close()
    const restarted = await createHost(context.home)
    expect((await restarted.api('/api/plugins/qq/connect', { method: 'POST', body: {} })).status).toBe(200)
    const afterRestart = await restarted.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_send_private_message', args, requestId, true) })
    expect(afterRestart.status).toBe(409)
    expect(afterRestart.body).toMatchObject({ error: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    expect(context.fixture.requests.filter(entry => entry.action === 'send_private_msg')).toHaveLength(1)
  })

  it('rejects unauthorized MCP, owner sessions, CSRF, Origin, Host and cross-site requests at the real HTTP boundary', async () => {
    const context = await configuredHost()
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const anonymous = await http(context.url, '/mcp/qq', { method: 'POST', body: rpc })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toMatchObject({ error: { code: 'MCP_UNAUTHENTICATED' } })
    expect((await http(context.url, '/api/workspace')).status).toBe(401)
    const invalidCsrf = await context.api('/api/plugins/qq/connect', { method: 'POST', body: {}, headers: { 'X-Eating-CSRF': 'invalid' } })
    expect(invalidCsrf.status).toBe(403)
    expect(invalidCsrf.body).toMatchObject({ error: { code: 'INVALID_CSRF_TOKEN' } })
    const registration = await context.api('/api/plugins/qq/mcp-registration', { method: 'POST', body: {} })
    const authorization = String(object(registration.body.headers).Authorization)
    const headers = { Authorization: authorization, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION }
    for (const path of ['/api/bootstrap', '/api/workspace', '/mcp/qq']) {
      const method = path === '/mcp/qq' ? 'POST' : 'GET'
      const body = method === 'POST' ? rpc : undefined
      const origin = await context.api(path, { method, body, headers: { ...headers, Origin: 'https://outside.invalid' } })
      expect(origin.status).toBe(403)
      expect(origin.body).toMatchObject({ error: { code: 'INVALID_ORIGIN' } })
      const host = await context.api(path, { method, body, headers: { ...headers, Host: 'outside.invalid' } })
      expect(host.status).toBe(403)
      expect(host.body).toMatchObject({ error: { code: 'INVALID_HOST' } })
      const crossSite = await context.api(path, { method, body, headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })
      expect(crossSite.status).toBe(403)
      expect(crossSite.body).toMatchObject({ error: { code: 'CROSS_SITE_REQUEST' } })
    }
    expect(context.fixture.connections).toHaveLength(0)
    const workspace = await context.api('/api/workspace')
    expect(workspace.text).not.toContain(context.token)
    expect(workspace.text).not.toContain(authorization.slice('Bearer '.length))
  })

  it('disconnects and withdraws MCP on disable, then re-enables the same saved account instance', async () => {
    const context = await configuredHost()
    await connectHost(context)
    const { client, authorization } = await mcpClient(context)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    const original = object(pluginFrom((await context.api('/api/workspace')).body).configuration)
    const configPath = String(original.configurationPath)
    const originalFile = await readFile(configPath, 'utf8')
    const disabled = await context.api('/api/plugins/qq/disable', { method: 'POST', body: {} })
    expect(disabled.status).toBe(200)
    await vi.waitFor(() => expect(context.fixture.connections[0]?.readyState).toBe(WebSocket.CLOSED))
    const workspace = await context.api('/api/workspace')
    expect(workspace.body.registeredIds).toEqual([])
    expect(pluginFrom(workspace.body)).toMatchObject({ enabled: false, status: { state: 'disconnected' } })
    const mcp = await http(context.url, '/mcp/qq', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { Authorization: authorization } })
    expect(mcp.status).toBe(409)
    expect(mcp.body).toMatchObject({ error: { code: 'PLUGIN_DISABLED' } })
    const invoke = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: invokeBody('qq_get_status', {}) })
    expect(invoke.status).toBe(409)
    expect((await context.api('/api/plugins/qq/enable', { method: 'POST', body: {} })).status).toBe(200)
    const enabled = pluginFrom((await context.api('/api/workspace')).body)
    expect(enabled.enabled).toBe(true)
    expect(object(enabled.configuration).instanceId).toBe(original.instanceId)
    expect(object(enabled.configuration).tokenConfigured).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(originalFile)
    await connectHost(context)
    expect(context.fixture.connections).toHaveLength(2)
    const reattached = await mcpClient(context)
    expect((await reattached.client.callTool({ name: 'qq_get_status', arguments: {} })).isError).toBe(false)
  })

  it('enforces one Host per data root and releases a constructor-only Host on close', async () => {
    const home = await temporaryHome()
    const unstarted = new EatingHost({ dataDirectory: home, entries: [qqEntry], port: 0 })
    cleanups.push(() => unstarted.close())
    expect(() => new EatingHost({ dataDirectory: home, entries: [qqEntry], port: 0 })).toThrow(expect.objectContaining({ code: 'WORKSPACE_LOCKED' }))
    await unstarted.close()
    await expect(stat(join(home, 'host', 'host.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = await createHost(home)
    expect((await restarted.api('/api/workspace')).status).toBe(200)
    expect(() => new EatingHost({ dataDirectory: home, entries: [qqEntry], port: 0 })).toThrow(expect.objectContaining({ code: 'WORKSPACE_LOCKED' }))
  })

  it('isolates corrupted QQ configuration while the Host, Harness and another test module remain available', async () => {
    const context = await configuredHost()
    const configuration = object(pluginFrom((await context.api('/api/workspace')).body).configuration)
    const path = String(configuration.configurationPath)
    await readFile(path, 'utf8')
    await context.host.close()
    const corruptBytes = '{not valid QQ JSON'
    await writeFile(path, corruptBytes, { mode: 0o600 })
    // Test-only probe verifies Host fault isolation; it is never a product platform.
    const probe: BackendPluginEntry = { id: 'isolation-probe', kind: 'communication', storageDirectory: 'isolation-probe-bot', create: () => ({
      id: 'isolation-probe', kind: 'communication', name: '测试隔离探针', version: '1.0.0', tools: [], capabilities: [],
      getStatus: () => ({ state: 'disconnected', accountId: null, accountName: null, connectedAt: null, lastEventAt: null, lastError: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {},
      disconnect: async () => {}, invoke: async () => null, dispose: async () => {},
    }) }
    const restarted = await createHost(context.home, [qqEntry, probe])
    const workspace = await restarted.api('/api/workspace')
    expect(workspace.status).toBe(200)
    expect(pluginFrom(workspace.body)).toMatchObject({ status: { state: 'error', accountId: null } })
    expect(object(pluginFrom(workspace.body).configuration).initializationError).toContain('QQ 配置')
    expect(pluginFrom(workspace.body, 'isolation-probe')).toMatchObject({ status: { state: 'disconnected', lastError: null } })
    expect(object(workspace.body.harness).state).toBe('not-attached')
    expect(await readFile(path, 'utf8')).toBe(corruptBytes)
    const attempt = await restarted.api('/api/plugins/qq/connect', { method: 'POST', body: {} })
    expect(attempt.status).toBe(500)
    expect(attempt.body).toMatchObject({ error: { code: 'CONFIGURATION_CORRUPTED' } })
  })
})
