import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentInvocationScope, BackendPlugin, BackendPluginEntry, HarnessHostServices } from '@eating/plugin-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { EatingHost } from './app'
import type { HostOptions } from './app'
import { OWNER_ACCESS_COOKIE } from './server-access'
import { createInstalledHost } from './installed-host'

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly body: Record<string, unknown>
}
interface HttpOptions {
  readonly method?: string
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const publicOrigin = 'http://example.test:5181'

async function temporaryHome() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-access-http-')))
  cleanups.push(async () => {
    if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-access-http-')) throw new Error('Unsafe test cleanup')
    await rm(home, { recursive: true })
  })
  return home
}

function http(base: string, path: string, options: HttpOptions = {}): Promise<HttpResult> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise((resolveResponse, reject) => {
    const outgoing = request({ hostname: new URL(base).hostname, port: new URL(base).port, path, method: options.method ?? 'GET', headers: {
      Host: new URL(publicOrigin).host, Origin: publicOrigin, Connection: 'close',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }), ...options.headers,
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(text) as Record<string, unknown> } catch {}
        resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, text, body })
      })
    })
    outgoing.on('error', reject)
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Fixture HTTP deadline exceeded')))
    outgoing.end(payload)
  })
}

function entry(id: string, kind: BackendPluginEntry['kind'], overrides: Partial<BackendPlugin> = {}, inspect?: (services: HarnessHostServices) => void): BackendPluginEntry {
  return { id, kind, storageDirectory: kind === 'communication' ? `${id}-bot` : id, create: context => {
    if (context.harness) inspect?.(context.harness)
    return { id, kind, name: 'Isolated access fixture', version: '1.0.0', capabilities: [], tools: [],
      getStatus: () => ({ state: 'connected', accountId: null, accountName: null, connectedAt: null, lastEventAt: null, lastError: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, invoke: async () => null, dispose: async () => {}, ...overrides }
  } }
}

async function fixture(options: Partial<HostOptions> = {}) {
  const home = await temporaryHome(), ownerToken = randomBytes(32).toString('base64url')
  const staticDirectory = join(home, 'web'), pluginDirectory = join(home, 'plugin')
  await mkdir(staticDirectory)
  await mkdir(join(pluginDirectory, 'ui'), { recursive: true })
  const script = 'export default {}', style = 'body {}'
  await writeFile(join(staticDirectory, 'index.html'), '<!doctype html><title>Access fixture</title>')
  await writeFile(join(staticDirectory, 'app.js'), script)
  await writeFile(join(pluginDirectory, 'ui/index.js'), script)
  await writeFile(join(pluginDirectory, 'ui/style.css'), style)
  let services!: HarnessHostServices
  const tool = { name: 'ping', title: 'Ping', description: 'Read fixture', inputSchema: { type: 'object' as const }, readOnly: true, destructive: false, resultFormat: 'json' as const }
  const communication: BackendPluginEntry = { ...entry('comm', 'communication', { tools: [tool], invokeScoped: async () => ({ scoped: true }),
    agentTypes: [{ id: 'comm.private', title: 'Fixture private', description: 'Fixture', conversationKind: 'private', defaultPrompt: 'Fixture', availableTools: ['ping'], defaultTools: ['ping'], enabledTools: ['ping'] }],
  }), installed: { directory: pluginDirectory, manifest: { schemaVersion: 1, apiVersion: 4, id: 'comm', kind: 'communication', name: 'Fixture', description: 'Fixture', version: '1.0.0', storageDirectory: 'comm-bot', backend: 'server.mjs', assets: [],
    frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 0, brandColor: '#123456', icon: 'box' }, integrity: { 'ui/index.js': createHash('sha256').update(script).digest('hex'), 'ui/style.css': createHash('sha256').update(style).digest('hex') } } } }
  const host = new EatingHost({ dataDirectory: home, port: 0, listenHost: '0.0.0.0', publicOrigin, ownerToken, allowedUiOrigins: [], staticDirectory,
    entries: [communication, entry('fixture', 'harness', {}, value => { services = value }), entry('feature', 'capability', { tools: [tool], invokeCapability: async () => ({ capability: true }) })], autoConnectOnStartup: false, ...options })
  cleanups.push(() => host.close())
  const url = await host.listen()
  const enter = () => http(url, '/?token=' + ownerToken)
  const session = async () => {
    const entered = await enter()
    expect(entered.status).toBe(303)
    const accessCookie = entered.headers['set-cookie']![0]!.split(';')[0]!
    const bootstrap = await http(url, '/api/bootstrap', { headers: { Cookie: accessCookie } })
    expect(bootstrap.status).toBe(200)
    const cookie = accessCookie + '; ' + bootstrap.headers['set-cookie']![0]!.split(';')[0]!
    const api = (path: string, settings: HttpOptions = {}) => http(url, path, { ...settings, headers: { Cookie: cookie, 'X-Eating-CSRF': String(bootstrap.body.csrfToken), ...settings.headers } })
    return { accessCookie, cookie, csrf: String(bootstrap.body.csrfToken), api }
  }
  return { home, host, url, ownerToken, enter, session, services }
}

function denied(result: HttpResult, token: string) {
  expect(result.status).toBe(401)
  expect(result.headers['set-cookie']).toBeUndefined()
  expect(result.headers['www-authenticate']).toBeUndefined()
  expect(result.body.csrfToken).toBeUndefined()
  expect(result.text).not.toContain(token)
}

describe('real Host URL token owner boundary', () => {
  it('keeps the default loopback bootstrap and UI without an entry token', async () => {
    const context = await fixture({ listenHost: undefined, publicOrigin: undefined, ownerToken: undefined })
    const headers = { Host: new URL(context.url).host, Origin: context.url }
    const bootstrap = await http(context.url, '/api/bootstrap', { headers })
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.body.csrfToken).toEqual(expect.any(String))
    expect(bootstrap.headers['set-cookie']![0]).toContain('Path=/api')
    expect(bootstrap.headers['set-cookie']![0]).not.toContain(OWNER_ACCESS_COOKIE)
    expect((await http(context.url, '/', { headers })).status).toBe(200)
  })

  it('rejects incomplete public constructor configuration before taking a workspace lock', async () => {
    const home = await temporaryHome()
    for (const configuration of [{}, { publicOrigin }, { ownerToken: randomBytes(32).toString('base64url') }, { publicOrigin, ownerToken: 'short-private-fixture' }]) {
      expect(() => new EatingHost({ dataDirectory: home, entries: [], listenHost: '0.0.0.0', ...configuration })).toThrow(/EATING_/u)
      await expect(createInstalledHost({ dataDirectory: home, listenHost: '0.0.0.0', ...configuration })).rejects.toThrow(/EATING_/u)
    }
    expect(await readdir(home)).toEqual([])
  })

  it('requires the entry cookie for bootstrap, APIs, all static and plugin assets', async () => {
    const context = await fixture()
    for (const path of ['/', '/app.js', '/api/bootstrap', '/api/workspace', '/plugins/comm/1.0.0/ui/index.js', '/plugins/comm/1.0.0/ui/style.css']) denied(await http(context.url, path), context.ownerToken)
    const session = await context.session()
    denied(await http(context.url, '/api/workspace', { headers: { Cookie: session.cookie.split('; ')[1]! } }), context.ownerToken)
    for (const path of ['/', '/app.js', '/plugins/comm/1.0.0/ui/index.js', '/plugins/comm/1.0.0/ui/style.css']) expect((await session.api(path)).status).toBe(200)
    expect((await http(context.url, '/api/workspace', { headers: { Cookie: session.accessCookie } })).status).toBe(401)
    expect((await session.api('/api/workspace')).status).toBe(200)
  })

  it('exchanges exactly one valid root token for an opaque cookie and a clean redirect', async () => {
    const context = await fixture()
    const response = await http(context.url, '/?view=overview&token=' + context.ownerToken + '&lang=en')
    expect(response.status).toBe(303)
    expect(response.headers.location).toBe('/?view=overview&lang=en')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['cache-control']).toBe('no-store')
    const cookie = response.headers['set-cookie']![0]!
    expect(cookie).toContain(`${OWNER_ACCESS_COOKIE}=`)
    expect(cookie).toContain('HttpOnly; SameSite=Strict; Path=/')
    expect(cookie).not.toContain('Secure')
    expect(cookie).not.toContain(context.ownerToken)
    expect(response.text).toBe('')
    expect(response.body.csrfToken).toBeUndefined()
  })

  it('rejects wrong, repeated, misplaced tokens and alternate authentication forms without secrets', async () => {
    const context = await fixture(), validQuery = encodeURIComponent(context.ownerToken)
    for (const path of ['/?token=', '/?token=' + validQuery + 'x', '/?token=' + validQuery + '&token=' + validQuery, '/api/bootstrap?token=' + validQuery, '/api/workspace?token=' + validQuery, '/app.js?token=' + validQuery]) denied(await http(context.url, path), context.ownerToken)
    denied(await http(context.url, '/?token=' + validQuery, { method: 'POST' }), context.ownerToken)
    denied(await http(context.url, '/api/bootstrap', { headers: { Authorization: 'Bearer ' + context.ownerToken } }), context.ownerToken)
    denied(await http(context.url, '/api/bootstrap', { headers: { Authorization: 'Basic ' + Buffer.from('fixture-owner:fixture-value').toString('base64') } }), context.ownerToken)
    const session = await context.session()
    denied(await session.api('/api/workspace?token=' + validQuery), context.ownerToken)
    denied(await http(context.url, '/api/bootstrap', { headers: { Cookie: `${OWNER_ACCESS_COOKIE}=${context.ownerToken}` } }), context.ownerToken)
    denied(await http(context.url, '/api/bootstrap', { headers: { Cookie: session.accessCookie + '; ' + session.accessCookie } }), context.ownerToken)
  })

  it('keeps encoded parameters and hostile redirect hints on a fixed local root', async () => {
    const context = await fixture()
    const encoded = [...context.ownerToken].map(character => '%' + character.charCodeAt(0).toString(16)).join('')
    const response = await http(context.url, '/?%74oken=' + encoded + '&next=https%3A%2F%2Fevil.example.test%2F&redirect=%2F%2Fevil.example.test')
    expect(response.status).toBe(303)
    expect(response.headers.location?.startsWith('/?')).toBe(true)
    expect(new URL(response.headers.location!, publicOrigin).origin).toBe(publicOrigin)
    expect(new URL(response.headers.location!, publicOrigin).searchParams.has('token')).toBe(false)
    expect(response.headers.location).not.toContain(context.ownerToken)
    denied(await http(context.url, '/?token=' + context.ownerToken + '&%74oken=' + encoded), context.ownerToken)
    denied(await http(context.url, '/./?token=' + context.ownerToken), context.ownerToken)
    for (const path of ['//evil.example.test/?token=', '/\\evil.example.test/?token=', 'http://evil.example.test/?token=']) {
      const rejected = await http(context.url, path + context.ownerToken)
      expect(rejected.status).toBe(403)
      expect(rejected.headers.location).toBeUndefined()
      expect(rejected.headers['set-cookie']).toBeUndefined()
      expect(rejected.text).not.toContain(context.ownerToken)
    }
  })

  it('retains exact Host, Origin, cross-site and API CSRF enforcement after entry', async () => {
    const context = await fixture(), session = await context.session()
    const invalidHeaders: Record<string, string>[] = [{ Host: 'wrong.example.test:5181' }, { Host: 'example.test' }, { Origin: 'http://wrong.example.test:5181' }, { Origin: 'https://example.test:5181' }, { 'Sec-Fetch-Site': 'cross-site' }]
    for (const headers of invalidHeaders) {
      const result = await session.api('/api/bootstrap', { headers })
      expect(result.status).toBe(403)
      expect(result.headers['set-cookie']).toBeUndefined()
      expect(result.body.csrfToken).toBeUndefined()
    }
    expect((await session.api('/api/plugins/comm/connect', { method: 'POST', body: {}, headers: { 'X-Eating-CSRF': '' } })).status).toBe(403)
    expect((await session.api('/api/plugins/comm/connect', { method: 'POST', body: {}, headers: { 'X-Eating-CSRF': 'wrong-fixture' } })).status).toBe(403)
    expect((await session.api('/api/plugins/comm/connect', { method: 'POST', body: {} })).status).toBe(200)
    expect((await session.api('/api/workspace')).headers['referrer-policy']).toBe('no-referrer')
  })

  it('supports optional loopback token protection and Secure cookies for an HTTPS origin', async () => {
    const context = await fixture({ listenHost: '127.0.0.1', publicOrigin: 'https://example.test' })
    const headers = { Host: 'example.test', Origin: 'https://example.test' }
    denied(await http(context.url, '/api/bootstrap', { headers }), context.ownerToken)
    const entered = await http(context.url, '/?token=' + context.ownerToken, { headers })
    expect(entered.status).toBe(303)
    expect(entered.headers.location).toBe('/')
    expect(entered.headers['set-cookie']![0]).toContain('; Secure')
    const bootstrap = await http(context.url, '/api/bootstrap', { headers: { ...headers, Cookie: entered.headers['set-cookie']![0]!.split(';')[0]! } })
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers['set-cookie']![0]).toContain('; Secure')
  })

  it('keeps both MCP Bearer channels independent of the owner token and cookies', async () => {
    const context = await fixture(), session = await context.session()
    const scope: AgentInvocationScope = { agentId: 'fixture-child', agentTypeId: 'comm.private', pluginId: 'comm', instanceId: 'fixture-instance', accountId: 'fixture-account', conversationId: 'fixture-private', kind: 'private', targetId: 'fixture-target', messageIds: [], resourceIds: [] }
    const scoped = context.services.getMcpConnection('comm', scope)
    const capability = context.services.getCapabilityMcpConnections({ agentId: 'fixture-main', agentTypeId: 'main' }).find(connection => connection.id === 'plugin.feature')!
    expect(scoped.url).toBe(context.url + '/mcp/comm')
    expect(capability.url).toBe(context.url + '/mcp-services/plugin.feature')
    const registration = await session.api('/api/plugins/comm/mcp-registration', { method: 'POST', body: {} })
    expect(registration.status).toBe(200)
    const owner = registration.body as { url: string; headers: Record<string, string> }
    for (const connection of [scoped, capability, owner]) {
      const client = new Client({ name: 'isolated-owner-access-fixture', version: '1.0.0' })
      cleanups.push(() => client.close())
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers, Connection: 'close' } } }))
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ping'])
      const authorization = connection.headers.Authorization!
      denied(await http(context.url, '/api/bootstrap', { headers: { Authorization: authorization } }), context.ownerToken)
      denied(await http(context.url, '/api/workspace', { headers: { Authorization: authorization, Cookie: session.cookie.split('; ')[1]! } }), context.ownerToken)
      const path = new URL(connection.url).pathname
      const queryOnly = await http(context.url, path + '?token=' + context.ownerToken, { headers: { Cookie: session.cookie } })
      expect(queryOnly.status).toBeGreaterThanOrEqual(400)
      expect(queryOnly.headers['set-cookie']).toBeUndefined()
      const ownerTokenBearer = await http(context.url, path, { headers: { Authorization: 'Bearer ' + context.ownerToken } })
      expect(ownerTokenBearer.status).toBeGreaterThanOrEqual(400)
    }
  })

  it('keeps the owner token out of workspace, errors, persisted files and subsequent runtimes', async () => {
    const context = await fixture(), session = await context.session()
    const workspace = await session.api('/api/workspace')
    expect(workspace.text).not.toContain(context.ownerToken)
    expect(JSON.stringify(context.host.getWorkspace())).not.toContain(context.ownerToken)
    const failure = await http(context.url, '/?token=' + context.ownerToken + 'x')
    expect(failure.text).not.toContain(context.ownerToken)
    await context.host.close()
    for (const name of await readdir(context.home, { recursive: true })) {
      try {
        const content = await readFile(join(context.home, name))
        expect(content.includes(Buffer.from(context.ownerToken))).toBe(false)
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EISDIR')) throw error }
    }
    const restarted = new EatingHost({ dataDirectory: context.home, entries: [], port: 0, listenHost: '127.0.0.1', publicOrigin, ownerToken: context.ownerToken })
    cleanups.push(() => restarted.close())
    const restartedUrl = await restarted.listen()
    denied(await http(restartedUrl, '/api/bootstrap', { headers: { Cookie: session.cookie } }), context.ownerToken)
    expect((await http(restartedUrl, '/?token=' + context.ownerToken)).status).toBe(303)
  })
})
