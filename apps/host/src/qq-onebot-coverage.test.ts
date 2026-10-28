import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import qqEntry from '../../../plugins/communication/qq/src/server.ts'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot.ts'
import { ONEBOT_V11_CASES, ONEBOT_V11_SEGMENT_CASES } from '../../../tests/fixtures/onebot-v11-cases.ts'
import { ONEBOT_V11_HIDDEN_ACTIONS, ONEBOT_V11_PUBLIC_ACTIONS, ONEBOT_V11_REVISION, ONEBOT_V11_SEND_SEGMENTS } from '../../../tests/fixtures/onebot-v11-contract.ts'
import { EatingHost } from './app.ts'

interface HttpOptions { method?: string; body?: JsonValue; headers?: Record<string, string> }
interface HttpResult { status: number; headers: IncomingHttpHeaders; body: JsonObject; text: string }
const cleanups: Array<() => Promise<void>> = []
const roots: Array<{ path: string; parent: string }> = []
const sensitiveActions = new Set(['get_cookies', 'get_csrf_token', 'get_credentials'])
const destructiveActions = new Set(['delete_msg', 'set_group_kick', 'set_group_ban', 'set_group_anonymous_ban',
  'set_group_whole_ban', 'set_group_leave', 'set_restart', 'clean_cache', '.handle_quick_operation'])

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object from the real integration boundary')
  return value
}
async function deadline<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Integration deadline: ${label}`)), 5000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
function track(label: string, close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined
  const stop = () => closing ??= deadline(Promise.resolve().then(close), label)
  cleanups.push(stop)
  return stop
}
function http(base: string, path: string, options: HttpOptions = {}): Promise<HttpResult> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, base), { method: options.method ?? 'GET', headers: {
      Host: new URL(base).host, Origin: base, Connection: 'close',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }),
      ...options.headers,
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: JsonObject = {}
        try { body = object(JSON.parse(text)) } catch { /* A valid transport error may be plain text. */ }
        resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body, text })
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Coverage HTTP deadline exceeded')))
    req.end(payload)
  })
}
async function createHost(home?: string) {
  if (!home) {
    const parent = await realpath(tmpdir())
    home = await realpath(await mkdtemp(join(parent, 'eating_onebot_coverage_')))
    roots.push({ path: home, parent })
  }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry], port: 0, allowedUiOrigins: [] })
  const close = track('Host.close', () => host.close())
  const url = await host.listen()
  const bootstrap = await http(url, '/api/bootstrap')
  expect(bootstrap.status).toBe(200)
  const cookie = bootstrap.headers['set-cookie']?.[0]?.split(';')[0]
  const csrf = bootstrap.body.csrfToken
  if (!cookie || typeof csrf !== 'string') throw new Error('Missing real owner session or CSRF token')
  const api = (path: string, options: HttpOptions = {}) => http(url, path, {
    ...options, headers: { Cookie: cookie, 'X-Eating-CSRF': csrf, ...options.headers },
  })
  return { host, home, url, api, cookie, csrf, close }
}
function qq(workspace: JsonObject): JsonObject {
  if (!Array.isArray(workspace.plugins)) throw new Error('Missing workspace plugin catalog')
  return object(workspace.plugins.find(value => isJsonObject(value) && value.id === 'qq'))
}
async function connectHost(context: Awaited<ReturnType<typeof createHost>>) {
  expect(await context.api('/api/plugins/qq/connect', { method: 'POST', body: {} })).toMatchObject({
    status: 200, body: { state: 'connected', accountId: '123456789' },
  })
}
async function configuredHost(options: Parameters<typeof startOneBotFixture>[0] = {}) {
  const accessToken = randomUUID()
  const fixture = await startOneBotFixture({ ...options, accessToken })
  track('OneBot fixture.close', () => fixture.close())
  const context = await createHost()
  const saved = await context.api('/api/plugins/qq/configuration', { method: 'POST', body: {
    displayName: 'OneBot 标准覆盖测试', endpoint: fixture.endpoint, accessToken, autoConnect: false,
    forwardToHarness: false, receiveGroups: true, timeoutMs: 1000,
  } })
  expect(saved.status).toBe(200)
  const instanceId = saved.body.instanceId
  if (typeof instanceId !== 'string') throw new Error('Missing stable account instance ID')
  await connectHost(context)
  expect(fixture.requests.map(value => value.action)).toEqual(['get_login_info', 'get_status'])
  expect(fixture.handshakes[0]?.headers.authorization).toBe(`Bearer ${accessToken}`)
  return { ...context, fixture, instanceId, accessToken }
}
async function mcpClient(context: Awaited<ReturnType<typeof createHost>>) {
  const registration = await context.api('/api/plugins/qq/mcp-registration', { method: 'POST', body: {} })
  expect(registration.status).toBe(200)
  const endpoint = registration.body.url, authorization = object(registration.body.headers).Authorization
  if (typeof endpoint !== 'string' || typeof authorization !== 'string') throw new Error('Missing actual MCP credentials')
  expect(endpoint).toBe(`${context.url}/mcp/qq`)
  const client = new Client({ name: 'Eating-OneBot-v11-coverage', version: '1.0.0' })
  const close = track('MCP Client.close', () => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: authorization, Origin: context.url, Connection: 'close' } },
  }))
  const call = (name: string, args: JsonObject) => client.callTool({ name, arguments: args }, undefined, { timeout: 4000 })
  return { client, call, close, authorization }
}
function ledger(context: { host: EatingHost }) {
  const db = new DatabaseSync(context.host.store.databasePath, { readOnly: true })
  try { return db.prepare('SELECT plugin_id,scope_key,request_id,action,state,result_json,error_code FROM actions ORDER BY rowid').all() }
  finally { db.close() }
}
async function openLogs(context: Awaited<ReturnType<typeof createHost>>) {
  let text = ''
  await new Promise<void>((resolveOpened, reject) => {
    const req = request(new URL('/api/plugins/qq/logs/stream', context.url), { headers: {
      Host: new URL(context.url).host, Origin: context.url, Cookie: context.cookie,
    } }, response => {
      expect(response.statusCode).toBe(200)
      response.on('data', chunk => { text += chunk.toString('utf8') })
      response.on('error', () => {})
      resolveOpened()
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Log stream deadline exceeded')))
    track('log stream.close', async () => { req.destroy() })
    req.end()
  })
  return () => text
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  for (const root of roots.splice(0).reverse()) {
    const target = await realpath(root.path)
    if (target !== root.path || dirname(target) !== root.parent || !basename(target).startsWith('eating_onebot_coverage_')
      || resolve(target) !== target || (await lstat(target)).isSymbolicLink()) throw new Error('Refusing cleanup outside the exact temporary test root')
    await rm(target, { recursive: true })
  }
  if (failures.length) throw new AggregateError(failures, 'Coverage resources did not close within their deadlines')
})

describe(`pinned OneBot v11 ${ONEBOT_V11_REVISION}: real Host and official MCP`, () => {
  it('keeps explicit fixture responses, known async suffixes, overrides and unknown-action failures', async () => {
    const fixture = await startOneBotFixture({ accessToken: 'fixture-only-token', login: { user_id: 42, nickname: 'override' },
      health: { online: true, good: false }, onRequest: (entry, peer) => {
        if (entry.action !== 'get_image_async') return false
        replyOneBot(peer, entry, null, 'failed', 1777)
        return true
      } })
    track('fixture contract.close', () => fixture.close())
    const peer = new WebSocket(fixture.endpoint, { headers: { Authorization: 'Bearer fixture-only-token' } })
    track('fixture peer.close', async () => { peer.terminate() })
    await deadline(once(peer, 'open'), 'fixture open')
    const call = async (action: string, params: JsonObject = {}) => {
      const pending = deadline(once(peer, 'message'), 'fixture reply')
      const echo = randomUUID()
      peer.send(JSON.stringify({ action, params, echo }))
      const [raw] = await pending
      const response = object(JSON.parse(String(raw)))
      expect(response.echo).toBe(echo)
      return response
    }
    expect((await call('get_login_info')).data).toEqual({ user_id: 42, nickname: 'override' })
    expect((await call('get_status')).data).toEqual({ online: true, good: false })
    for (const row of ONEBOT_V11_CASES) {
      const response = await call(row.action, row.wire)
      expect(response, row.action).toMatchObject(row.action === 'set_restart' ? { status: 'async', retcode: 1, data: null } : { status: 'ok', retcode: 0 })
      if (!row.readOnly && !['send_private_msg', 'send_group_msg', 'send_msg'].includes(row.action)) expect(response.data).toBeNull()
      for (const mode of ['async', 'rate_limited']) {
        const action = `${row.action}_${mode}`
        expect(await call(action, row.wire), action).toMatchObject(action === 'get_image_async'
          ? { status: 'failed', retcode: 1777 } : { status: 'async', retcode: 1, data: null })
      }
    }
    for (const action of ['unknown', 'unknown_async', 'unknown_rate_limited', 'send_msg_async_async']) {
      expect(await call(action)).toMatchObject({ status: 'failed', retcode: 1404, data: null })
    }
    expect(fixture.handshakes[0]?.url).toBe('/')
  })

  it('publishes exactly 38 public tools plus the hidden action, complete schemas and truthful metadata', async () => {
    const context = await configuredHost()
    const { client } = await mcpClient(context)
    const tools = (await client.listTools()).tools
    const workspace = qq((await context.api('/api/workspace')).body)
    const published = workspace.tools
    if (!Array.isArray(published)) throw new Error('Missing workspace tools')
    const expectedActions = [...ONEBOT_V11_PUBLIC_ACTIONS, ...ONEBOT_V11_HIDDEN_ACTIONS]
    expect(ONEBOT_V11_CASES.map(row => row.action)).toEqual(expectedActions)
    expect(new Set(ONEBOT_V11_CASES.map(row => row.name)).size).toBe(39)
    expect(tools.map(tool => tool.name).sort()).toEqual(ONEBOT_V11_CASES.map(row => row.name).sort())
    expect(published.map(value => object(value).protocolAction).sort()).toEqual([...expectedActions].sort())
    expect(ONEBOT_V11_CASES.filter(row => !row.readOnly)).toHaveLength(20)
    for (const row of ONEBOT_V11_CASES) {
      const tool = tools.find(value => value.name === row.name)!
      const metadata = object(published.find(value => object(value).name === row.name))
      expect(metadata.protocolAction, row.name).toBe(row.action)
      expect(metadata.readOnly, row.name).toBe(row.readOnly)
      if (destructiveActions.has(row.action)) expect(metadata.destructive, row.name).toBe(true)
      if (row.readOnly || row.action.startsWith('send_')) expect(metadata.destructive, row.name).toBe(false)
      expect(tool.annotations, row.name).toMatchObject({ readOnlyHint: row.readOnly, destructiveHint: metadata.destructive })
      expect(tool.inputSchema, row.name).toEqual(metadata.inputSchema)
      const properties = object(tool.inputSchema.properties)
      expect(Object.keys(properties).sort(), row.name).toEqual([...row.fields, 'instance_id', 'onebot_call_mode', ...(!row.readOnly ? ['request_id'] : [])].sort())
      expect(object(properties.onebot_call_mode).enum).toEqual(['sync', 'async', 'rate_limited'])
      if (!row.readOnly) {
        expect(tool.inputSchema.required, row.name).toContain('request_id')
        expect(properties.request_id).toMatchObject({ type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' })
      }
      if (sensitiveActions.has(row.action)) expect(metadata).toMatchObject({ readOnly: true, destructive: false, sensitiveResult: true })
    }
    const capabilities = workspace.capabilities
    if (!Array.isArray(capabilities)) throw new Error('Missing capabilities')
    for (const capability of capabilities.map(object)) {
      if (capability.support !== 'unsupported') expect(String(capability.id)).not.toMatch(/qzone\.(publish|comment)|reverse/i)
    }
    expect(JSON.stringify(workspace)).not.toContain(context.accessToken)
    expect(context.fixture.requests).toHaveLength(2)
  })

  it('sends independent valid cases for every action through actual MCP, with scoped write deduplication', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    for (const [index, row] of ONEBOT_V11_CASES.entries()) {
      const beforeWire = context.fixture.requests.length, beforeLedger = ledger(context).length
      const requestId = `coverage-standard-${index}`
      const args = { ...row.input, instance_id: context.instanceId, onebot_call_mode: 'sync', ...(!row.readOnly ? { request_id: requestId } : {}) }
      const response = await call(row.name, args)
      expect(context.fixture.requests, row.action).toHaveLength(beforeWire + 1)
      expect(context.fixture.requests.at(-1), row.action).toMatchObject({ action: row.action, params: row.wire })
      expect(context.fixture.requests.at(-1)?.params, row.action).toEqual(row.wire)
      expect(response.isError, row.action).toBe(row.action === 'set_restart')
      if (row.action === 'set_restart') expect(response).toMatchObject({ structuredContent: { code: 'onebot_async_pending', outcome: 'unknown' } })
      if (row.action === 'get_forward_msg') expect(response).toMatchObject({ structuredContent: { result: { message: [{ type: 'node', data: {
        user_id: '987654321', nickname: '夹具转发节点', content: [
          { type: 'image', data: { file: 'fixture-received-image.jpg', url: 'https://fixture.invalid/received-image.jpg', type: 'flash' } },
          { type: 'text', data: { text: '原始 [CQ:face,id=14] & 保留' } },
        ],
      } }] } } })
      expect(ledger(context), row.action).toHaveLength(beforeLedger + (row.readOnly ? 0 : 1))
      if (!row.readOnly) {
        expect(ledger(context).at(-1)).toMatchObject({ plugin_id: 'qq', scope_key: `${context.instanceId}:123456789`,
          request_id: requestId, action: row.action, state: row.action === 'set_restart' ? 'unknown' : 'succeeded' })
        const repeated = await call(row.name, args)
        if (row.action === 'set_restart') expect(repeated).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
        else expect(object(repeated.structuredContent).result).toEqual(object(response.structuredContent).result)
        expect(context.fixture.requests).toHaveLength(beforeWire + 1)
      }
    }
    expect(ledger(context)).toHaveLength(20)
  })

  it('preserves aliases and false/zero/empty values, all honor and record enums, and safe numeric ID bounds', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    const cases: Array<{ name: string; action: string; input: JsonObject; wire: JsonObject }> = [
      { name: 'qq_set_group_anonymous_ban', action: 'set_group_anonymous_ban', input: { group_id: '123456', flag: 'event-flag', duration: 1 }, wire: { group_id: 123456, anonymous_flag: 'event-flag', duration: 1 } },
      { name: 'qq_set_group_anonymous_ban', action: 'set_group_anonymous_ban', input: { group_id: 123456, anonymous: { id: 7, name: '匿名', flag: 'event-anonymous' }, anonymous_flag: 'ignored-by-OneBot', duration: 60 }, wire: { group_id: 123456, anonymous: { id: 7, name: '匿名', flag: 'event-anonymous' }, duration: 60 } },
      { name: 'qq_set_group_add_request', action: 'set_group_add_request', input: { flag: 'event-request', type: 'add', approve: false, reason: '' }, wire: { flag: 'event-request', sub_type: 'add', approve: false, reason: '' } },
      { name: 'qq_send_message', action: 'send_msg', input: { group_id: '123456', message: 'infer group' }, wire: { group_id: 123456, message: 'infer group', auto_escape: true } },
      { name: 'qq_send_message', action: 'send_msg', input: { message_type: 'group', group_id: 123456, message: 'explicit group', auto_escape: false }, wire: { message_type: 'group', group_id: 123456, message: 'explicit group', auto_escape: false } },
      { name: 'qq_get_stranger_info', action: 'get_stranger_info', input: { user_id: '9007199254740991', no_cache: true }, wire: { user_id: 9007199254740991, no_cache: true } },
      { name: 'qq_get_group_info', action: 'get_group_info', input: { group_id: 9007199254740991 }, wire: { group_id: 9007199254740991 } },
      ...['talkative', 'performer', 'legend', 'strong_newbie', 'emotion', 'all'].map(type => ({ name: 'qq_get_group_honor_info', action: 'get_group_honor_info', input: { group_id: 123456, type }, wire: { group_id: 123456, type } })),
      ...['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac'].map(out_format => ({ name: 'qq_get_record', action: 'get_record', input: { file: 'fixture.silk', out_format }, wire: { file: 'fixture.silk', out_format } })),
    ]
    for (const [index, row] of cases.entries()) {
      const readOnly = row.action.startsWith('get_')
      const response = await call(row.name, { ...row.input, ...(!readOnly ? { request_id: `coverage-values-${index}` } : {}) })
      expect(response.isError, `${row.action}/${index}`).toBe(false)
      expect(context.fixture.requests.at(-1)?.action).toBe(row.action)
      expect(context.fixture.requests.at(-1)?.params).toEqual(row.wire)
    }
  })

  it('preserves all 19 sendable segments, three message forms, recursive node data and media references', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    expect(ONEBOT_V11_SEGMENT_CASES.map(segment => segment.type)).toEqual([...ONEBOT_V11_SEND_SEGMENTS])
    const messages: JsonValue[] = [...ONEBOT_V11_SEGMENT_CASES.map((segment, index) => index % 2 ? [segment] : segment),
      '[CQ:face,id=14] CQ string',
      { type: 'music', data: { type: 'custom', url: 'https://fixture.invalid/music', audio: 'https://fixture.invalid/music.ogg', title: '', content: '', image: '' } },
      { type: 'contact', data: { type: 'group', id: '123456' } },
      { type: 'node', data: { id: '-1' } },
      { type: 'node', data: { user_id: '987654321', nickname: 'CQ node', content: '[CQ:face,id=14] raw' } },
      { type: 'anonymous', data: null }, { type: 'dice', data: null }, { type: 'rps', data: {} }, { type: 'shake', data: {} },
    ]
    for (const [index, message] of messages.entries()) {
      const before = context.fixture.requests.length
      const response = await call('qq_send_group_message', { group_id: '123456', message, auto_escape: false, request_id: `coverage-segment-${index}` })
      expect(response.isError, String(index)).toBe(false)
      expect(context.fixture.requests).toHaveLength(before + 1)
      expect(context.fixture.requests.at(-1)?.params).toEqual({ group_id: 123456, message, auto_escape: false })
    }
    expect(await readdir(context.home)).not.toContain('onebot-fixture-only')
  })

  it('rejects invalid fields, enums, messages, IDs, request keys and modes before any wire or action ledger', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    const invalidMessages: JsonValue[] = [
      [], { type: 'imaginary', data: {} }, { type: 'forward', data: { id: 'opaque' } },
      { type: 'image', data: { file: 'fixture', surprise: true } }, { type: 'music', data: { type: 'custom', title: 'missing URLs' } },
      { type: 'node', data: { user_id: '987654321', nickname: 'bad nested', content: [{ type: 'unknown', data: {} }] } },
      { type: 'text', data: { text: 3 } }, { type: 'at', data: { qq: 9007199254740992 } },
    ]
    const inputs: Array<{ name: string; args: JsonObject }> = [
      { name: 'qq_set_group_kick', args: { group_id: 123456 } },
      { name: 'qq_get_status', args: { extra: true } },
      { name: 'qq_get_group_honor_info', args: { group_id: 123456, type: 'invented' } },
      { name: 'qq_get_record', args: { file: 'fixture', out_format: 'aac' } },
      { name: 'qq_set_group_add_request', args: { flag: 'fixture', type: 'reject' } },
      { name: 'qq_set_group_anonymous_ban', args: { group_id: 123456 } },
      { name: 'qq_set_group_admin', args: { group_id: 123456, user_id: 987654321, enable: 'false' } },
      { name: 'qq_send_message', args: { message_type: 'channel', group_id: 123456, message: 'x' } },
      { name: 'qq_send_message', args: { message_type: 'group', user_id: 987654321, message: 'x' } },
      { name: 'qq_send_message', args: { message: 'missing target' } },
      { name: 'qq_get_stranger_info', args: { user_id: 9007199254740992 } },
      { name: 'qq_get_stranger_info', args: { user_id: '9007199254740992' } },
      { name: 'qq_get_stranger_info', args: { user_id: 1.5 } },
      { name: 'qq_get_message', args: { message_id: 2147483648 } },
      { name: 'qq_delete_message', args: { message_id: '-2147483649' } },
      ...invalidMessages.map(message => ({ name: 'qq_send_private_message', args: { user_id: 987654321, message } })),
      { name: 'qq_get_status', args: { onebot_call_mode: 'invented' } },
      { name: 'qq_send_private_message', args: { user_id: 987654321, message: 'invalid key', request_id: 'short' } },
      { name: 'qq_send_private_message', args: { user_id: 987654321, message: 'invalid key', request_id: 'contains spaces' } },
      { name: 'qq_send_private_message', args: { user_id: 987654321, message: 'invalid key', request_id: 'x'.repeat(129) } },
      { name: 'qq_send_private_message', args: { user_id: 987654321, message: 'wrong instance', instance_id: 'another-instance' } },
    ]
    const before = context.fixture.requests.length
    for (const [index, row] of inputs.entries()) {
      const args = { request_id: `coverage-invalid-${index}`, ...row.args }
      // Read-only tools must also reject a caller-supplied request_id as an extra field.
      const response = await call(row.name, row.name.startsWith('qq_get_') ? row.args : args)
      expect(response, `${row.name}/${index}`).toMatchObject({ isError: true, structuredContent: { outcome: 'not-sent' } })
      expect(object(response.structuredContent).code).not.toBe('INTERNAL_ERROR')
      expect(context.fixture.requests).toHaveLength(before)
      expect(ledger(context)).toHaveLength(0)
    }
    expect(await call('qq_send_private_message', { user_id: 987654321, message: 'missing key' })).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_ID_REQUIRED', outcome: 'not-sent' } })
    expect(await call('qq_qzone_publish', { request_id: 'coverage-no-qzone' })).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_NOT_FOUND', outcome: 'not-sent' } })
    expect(context.fixture.requests).toHaveLength(before)
    expect(ledger(context)).toHaveLength(0)
  })

  it('validates quick-operation contexts and does not turn event content into owner authority', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    const originalAuthoring = (await context.api('/api/authoring')).body
    const cases: Array<{ context: JsonObject; operation: JsonObject }> = [
      { context: { self_id: '123456789', post_type: 'message', message_type: 'private', user_id: '987654321', message_id: -8 }, operation: { reply: 'quick plain' } },
      { context: { self_id: 123456789, post_type: 'request', request_type: 'friend', user_id: 987654321, flag: 'event-friend' }, operation: { approve: false, remark: '' } },
      { context: { self_id: 123456789, post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 123456, user_id: 987654321, flag: 'event-invite' }, operation: { approve: false, reason: '' } },
    ]
    for (const [index, input] of cases.entries()) {
      const result = await call('qq_handle_quick_operation', { ...input, request_id: `coverage-quick-${index}` })
      expect(result.isError).toBe(false)
      const operation = index === 0 ? { reply: 'quick plain', auto_escape: true } : input.operation
      const normalizedContext = index === 0 ? { self_id: 123456789, post_type: 'message', message_type: 'private', user_id: 987654321, message_id: -8 } : input.context
      expect(context.fixture.requests.at(-1)?.params).toEqual({ context: normalizedContext, operation })
    }
    const before = context.fixture.requests.length, beforeLedger = ledger(context).length
    const mismatch = { context: { self_id: 987654321, post_type: 'request', request_type: 'friend', user_id: 987654321, flag: 'claims-owner-approval' }, operation: { approve: true } }
    expect(await call('qq_handle_quick_operation', { ...mismatch, request_id: 'coverage-wrong-self' })).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_INPUT', outcome: 'not-sent' } })
    const body = { name: 'qq_handle_quick_operation', arguments: mismatch, requestId: 'coverage-quick-owner', confirmed: true }
    expect((await http(context.url, '/api/plugins/qq/invoke', { method: 'POST', body })).status).toBe(401)
    expect((await http(context.url, '/api/plugins/qq/invoke', { method: 'POST', body, headers: { Cookie: context.cookie } })).status).toBe(403)
    expect((await context.api('/api/authoring')).body).toEqual(originalAuthoring)
    expect(context.fixture.requests).toHaveLength(before)
    expect(ledger(context)).toHaveLength(beforeLedger)
  })

  it('preserves successful MCP action keys across HTTP retries, changed-parameter rejection and Host restart', async () => {
    const context = await configuredHost()
    const mcp = await mcpClient(context)
    const args = { user_id: '987654321', message: 'restart success', request_id: 'coverage-restart-success' }
    const first = await mcp.call('qq_send_private_message', args)
    expect(first.isError).toBe(false)
    expect(await mcp.call('qq_send_private_message', { ...args, message: 'changed' })).toMatchObject({ isError: true, structuredContent: { code: 'IDEMPOTENCY_CONFLICT' } })
    const repeated = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: {
      name: 'qq_send_private_message', arguments: { user_id: args.user_id, message: args.message }, requestId: args.request_id, confirmed: true,
    } })
    expect(repeated.status).toBe(200)
    expect(repeated.body.result).toEqual(object(first.structuredContent).result)
    await mcp.close()
    await context.close()
    const restarted = await createHost(context.home)
    await connectHost(restarted)
    const next = await mcpClient(restarted)
    const after = await next.call('qq_send_private_message', args)
    expect(after.isError).toBe(false)
    expect(object(after.structuredContent).result).toEqual(object(first.structuredContent).result)
    expect(context.fixture.requests.filter(value => value.action === 'send_private_msg')).toHaveLength(1)
    expect(ledger(restarted)).toHaveLength(1)
  })

  it('treats both suffix modes for all actions as unknown and never repeats accepted side effects', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    for (const mode of ['async', 'rate_limited']) {
      for (const [index, row] of ONEBOT_V11_CASES.entries()) {
        const before = context.fixture.requests.length
        const args = { ...row.input, onebot_call_mode: mode, instance_id: context.instanceId,
          ...(!row.readOnly ? { request_id: `coverage-${mode}-${index}` } : {}) }
        expect(await call(row.name, args), `${row.action}/${mode}`).toMatchObject({ isError: true, structuredContent: { code: 'onebot_async_pending', outcome: 'unknown' } })
        expect(context.fixture.requests).toHaveLength(before + 1)
        expect(context.fixture.requests.at(-1)).toMatchObject({ action: `${row.action}_${mode}`, params: row.wire })
        expect(context.fixture.requests.at(-1)?.params).toEqual(row.wire)
        if (!row.readOnly) {
          expect(await call(row.name, args)).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
          expect(context.fixture.requests).toHaveLength(before + 1)
        }
      }
    }
    expect(ledger(context)).toHaveLength(40)
    expect(ledger(context).every(row => row.state === 'unknown' && row.result_json === null)).toBe(true)
  }, 15000)

  it('persists a lost OneBot reply as unknown across MCP, HTTP and same-home restart without a second send', async () => {
    const context = await configuredHost({ onRequest: entry => entry.action === 'send_private_msg' })
    const mcp = await mcpClient(context)
    const args = { user_id: 987654321, message: 'fixture deliberately withholds response', request_id: 'coverage-lost-reply' }
    expect(await mcp.call('qq_send_private_message', args)).toMatchObject({ isError: true, structuredContent: { code: 'onebot_request_timeout', outcome: 'unknown' } })
    expect(await mcp.call('qq_send_private_message', args)).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    expect(ledger(context)[0]).toMatchObject({ request_id: args.request_id, state: 'unknown', result_json: null })
    await mcp.close()
    await context.close()
    const restarted = await createHost(context.home)
    await connectHost(restarted)
    const next = await mcpClient(restarted)
    expect(await next.call('qq_send_private_message', args)).toMatchObject({ isError: true, structuredContent: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } })
    const retry = await restarted.api('/api/plugins/qq/invoke', { method: 'POST', body: { name: 'qq_send_private_message', arguments: args, requestId: args.request_id, confirmed: true } })
    expect(retry).toMatchObject({ status: 409, body: { error: { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' } } })
    expect(context.fixture.requests.filter(value => value.action === 'send_private_msg')).toHaveLength(1)
  })

  it('returns all three fake credentials over MCP while excluding them from actions, configuration, logs and storage', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    const configuration = qq((await context.api('/api/workspace')).body).configuration
    const configPath = String(object(configuration).configurationPath)
    const originalConfiguration = await readFile(configPath, 'utf8')
    const logText = await openLogs(context)
    for (const [name, expected] of [
      ['qq_get_cookies', { cookies: 'eating_test_only_cookie=ONEBOT_FIXTURE_NOT_A_REAL_SECRET' }],
      ['qq_get_csrf_token', { token: 19088743 }],
      ['qq_get_credentials', { cookies: 'eating_test_only_cookie=ONEBOT_FIXTURE_NOT_A_REAL_SECRET', csrf_token: 19088743 }],
    ] as const) {
      const response = await call(name, {})
      expect(response).toMatchObject({ isError: false, structuredContent: { result: expected } })
    }
    context.fixture.emitEvent({ self_id: 123456789, post_type: 'message', message_type: 'private', user_id: 987654321,
      message_id: 991, message: 'credential-log-marker' })
    await vi.waitFor(() => expect(logText()).toContain('credential-log-marker'))
    expect(ledger(context)).toHaveLength(0)
    expect(context.host.store.listMessages('qq')).toHaveLength(0)
    expect(await readFile(configPath, 'utf8')).toBe(originalConfiguration)
    const leaks = ['ONEBOT_FIXTURE_NOT_A_REAL_SECRET', 'eating_test_only_cookie', '19088743']
    for (const value of leaks) {
      expect(logText()).not.toContain(value)
      expect(JSON.stringify((await context.api('/api/workspace')).body)).not.toContain(value)
    }
    for (const entry of await readdir(context.home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const bytes = await readFile(join(entry.parentPath, entry.name))
      for (const value of leaks) expect(bytes.includes(Buffer.from(value)), entry.name).toBe(false)
    }
  })

  it('passes a structured media payload above 256 KiB through real MCP and HTTP within the 1 MiB tool limit', async () => {
    const context = await configuredHost()
    const { call } = await mcpClient(context)
    const message = { type: 'image', data: { file: `base64://${'QUJD'.repeat(80 * 1024)}` } }
    const args = { user_id: 987654321, message, auto_escape: false }
    expect(Buffer.byteLength(JSON.stringify(args))).toBeGreaterThan(256 * 1024)
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(1024 * 1024)
    expect((await call('qq_send_private_message', { ...args, request_id: 'coverage-large-mcp' })).isError).toBe(false)
    const manual = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: {
      name: 'qq_send_private_message', arguments: args, requestId: 'coverage-large-http', confirmed: true,
    } })
    expect(manual.status).toBe(200)
    for (const entry of context.fixture.requests.slice(-2)) expect(entry.params).toEqual(args)
    expect(ledger(context)).toHaveLength(2)
    const configuration = await context.api('/api/plugins/qq/configuration', { method: 'POST', body: { displayName: 'x'.repeat(300 * 1024) } })
    expect(configuration).toMatchObject({ status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE' } } })
    expect(qq((await context.api('/api/workspace')).body).status).toMatchObject({ state: 'connected' })
  })

  it('bounds deep JSON at the real HTTP and MCP routes with explicit not-sent errors and stays usable', async () => {
    const context = await configuredHost()
    const mcp = await mcpClient(context)
    const nested = (depth: number): JsonValue => {
      let value: JsonValue = 'leaf'
      for (let index = 0; index < depth; index++) value = { value }
      return value
    }
    const before = context.fixture.requests.length
    for (const [depth, expectedCode] of [[64, 'INVALID_INPUT'], [65, 'INVALID_JSON']] as const) {
      const manual = await context.api('/api/plugins/qq/invoke', { method: 'POST', body: {
        name: 'qq_send_private_message', requestId: `coverage-deep-http-${depth}`, confirmed: true,
        arguments: { user_id: 987654321, message: 'invalid nested extra', unexpected: nested(depth - 2) },
      } })
      expect(manual).toMatchObject({ status: 400, body: { error: { code: expectedCode, outcome: 'not-sent' } } })
      const rpc = await http(context.url, '/mcp/qq', { method: 'POST', headers: {
        Authorization: mcp.authorization, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
      }, body: { jsonrpc: '2.0', id: depth, method: 'tools/call', params: { name: 'qq_send_private_message', arguments: {
        user_id: 987654321, message: 'invalid nested extra', request_id: `coverage-deep-mcp-${depth}`, unexpected: nested(depth - 3),
      } } } })
      if (depth === 64) expect(rpc.body).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_INPUT', outcome: 'not-sent' } } })
      else expect(rpc).toMatchObject({ status: 400, body: { error: { code: 'INVALID_JSON', outcome: 'not-sent' } } })
    }
    expect(context.fixture.requests).toHaveLength(before)
    expect(ledger(context)).toHaveLength(0)
    expect((await mcp.call('qq_get_status', {})).isError).toBe(false)
  })

  it('retains session, CSRF, Host and MCP-token checks for unknown methods and enlarged tool bodies', async () => {
    const context = await configuredHost()
    const { call, authorization } = await mcpClient(context)
    const body = { name: 'qq_send_private_message', arguments: { user_id: 987654321, message: 'guarded' }, requestId: 'coverage-guarded', confirmed: true }
    expect((await http(context.url, '/api/plugins/qq/invoke', { method: 'POST', body })).status).toBe(401)
    expect((await context.api('/api/plugins/qq/invoke', { method: 'POST', body, headers: { 'X-Eating-CSRF': 'wrong' } })).status).toBe(403)
    expect((await context.api('/api/plugins/qq/invoke', { method: 'POST', body, headers: { Host: 'outside.invalid' } })).status).toBe(403)
    expect((await context.api('/api/plugins/qq/invoke')).status).toBe(405)
    expect((await context.api('/api/plugins/qq/nonexistent', { method: 'POST', body: {} })).status).toBe(404)
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await http(context.url, '/mcp/qq', { method: 'POST', body: rpc })).status).toBe(401)
    expect((await http(context.url, '/mcp/qq', { method: 'POST', body: rpc, headers: { Authorization: `${authorization}-wrong` } })).status).toBe(401)
    expect(await call('qq_send_private_msg_async', { request_id: 'coverage-arbitrary-action' })).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_NOT_FOUND', outcome: 'not-sent' } })
    expect(context.fixture.requests).toHaveLength(2)
    expect(ledger(context)).toHaveLength(0)
  })
})
