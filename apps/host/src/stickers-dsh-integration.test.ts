import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import stickersEntry from '../../../plugins/capabilities/stickers/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import type { DshHarnessClient } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { connectNativeWeb, readTestAgentBindings } from '../../../tests/fixtures/native-web'
import { createImageFixturePng } from '../../../tests/fixtures/image'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot'
import { readModelFixtureBatch } from '../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { fixtureToolTurns, startStickersModel } from '../../../tests/fixtures/stickers-model'
import type { FixtureToolTurn } from '../../../tests/fixtures/stickers-model'
import { EatingHost } from './app'

const enabled = Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN)
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of stops.splice(0).reverse()) try { await stop() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Sticker SDK fixture cleanup failed')
})
const selfId = 123456789, userId = 987654321
const stickerPrefix = 'mcp__plugin_stickers__'
const granted = ['sticker_add', 'sticker_get', 'sticker_list', 'sticker_list_tags']
const rootTools = ['eating_delegate_task', 'eating_list_agent_types']
const childTools = [...granted.map(name => stickerPrefix + name), 'mcp__qq__qq_send_private_message', 'mcp__qq__qq_view_received_image'].sort()
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected actual structured integration result'); return value }
function names(request: ModelFixtureRequest) { return (request.tools ?? []).map(tool => tool.function?.name ?? '').sort() }
function batch(request: ModelFixtureRequest) {
  const value = readModelFixtureBatch(request)
  if (!value || !Array.isArray(value.payload.events) || value.payload.events.length !== 1) throw new Error('Expected exactly one actual Eating event')
  return { ...value, event: object(value.payload.events[0]) }
}
function result(turn: FixtureToolTurn): JsonObject { return object(JSON.parse(turn.text)) }
function noImageData(value: unknown, images: readonly Buffer[]) {
  const text = JSON.stringify(value)
  for (const bytes of images) expect(text).not.toContain(bytes.toString('base64'))
  expect(text).not.toContain('base64://')
  expect(text).not.toContain('data:image/')
}
function sdkStderr(plugin: DshPlugin) {
  const sdk: unknown = Reflect.get(plugin, 'client')
  const client: unknown = sdk && typeof sdk === 'object' ? Reflect.get(sdk, 'client') : null
  return client && typeof client === 'object' ? Reflect.get(client, 'stderrTail') : undefined
}
async function temporaryHome() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-stickers-dsh-')))
  stops.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('eating-stickers-dsh-')) throw new Error('Unsafe sticker SDK cleanup')
    await rm(target, { recursive: true })
  })
  return home
}
async function until(test: () => boolean, diagnostics: () => unknown, errors: readonly string[] = []) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && errors.length === 0) {
    if (test()) return
    await new Promise<void>(accept => setTimeout(accept, 25))
  }
  throw new Error(`Actual sticker SDK chain did not finish: ${JSON.stringify(diagnostics())}`)
}

/** Distinct valid PNG bytes while retaining the real fixture's decodable pixel. */
function pngWithComment(comment: string): Buffer {
  const image = createImageFixturePng(), data = Buffer.from('Fixture\0' + comment)
  const block = Buffer.alloc(data.length + 12)
  block.writeUInt32BE(data.length); block.write('tEXt', 4, 'ascii'); data.copy(block, 8)
  let crc = 0xffffffff
  for (const byte of block.subarray(4, block.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
  }
  block.writeUInt32BE((crc ^ 0xffffffff) >>> 0, block.length - 4)
  return Buffer.concat([image.subarray(0, -12), block, image.subarray(-12)])
}

async function receivedImageServer(bytes: Buffer) {
  const requests: { path: string | undefined; headers: IncomingHttpHeaders }[] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers })
    if (request.url !== '/received.png') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); response.end(bytes)
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  stops.push(async () => { const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Image server did not bind')
  return { source: `http://127.0.0.1:${address.port}/received.png`, requests }
}

function sendableFromActualTool(turn: FixtureToolTurn): JsonObject {
  // DSH's official MCP bridge projects content text to the model. It must receive
  // the real sendable metadata there, rather than this fixture constructing a URI.
  for (const text of [turn.text, ...turn.text.split('\n')]) {
    try {
      const value: unknown = JSON.parse(text)
      if (isJsonObject(value) && isJsonObject(value.sendable)) return value.sendable
    } catch { /* Human text or another MCP content line. */ }
  }
  throw new Error(`sticker_get did not expose its actual sendable metadata to the model: ${turn.text}`)
}

async function ownerApi(host: EatingHost) {
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap')
  const token = object(await bootstrap.json()).csrfToken, cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  return async (path: string, body?: JsonObject): Promise<JsonObject> => {
    const response = await fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': String(token), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = object(await response.json())
    if (!response.ok) throw new Error(`Owner fixture API ${path}: ${JSON.stringify(value)}`)
    return value
  }
}

describe.runIf(enabled)('系统DSH → 能力MCP → 表情库与QQ真实链', () => {
  it('paginates metadata, sends the actual sticker resource once, collects a received image and retains it across a complete Host restart', async () => {
    const home = await temporaryHome(), pngA = createImageFixturePng(), pngB = pngWithComment('owner-second'), received = pngWithComment('received-from-QQ')
    const images = [pngA, pngB, received], imageServer = await receivedImageServer(received), imageId = 'received-sticker.png'
    const onebot = await startOneBotFixture({ onRequest(request, peer) {
      if (request.action !== 'get_msg') return false
      if (request.params.message_id !== 99602) throw new Error('Unapproved get_msg fixture source')
      replyOneBot(peer, request, { message_id: 99602, message_type: 'private', self_id: selfId, sender: { user_id: userId }, message: [{ type: 'image', data: { file: imageId, url: imageServer.source } }] })
      return true
    } }); stops.push(() => onebot.close())
    const model = await startStickersModel(request => {
      const current = batch(request), turns = fixtureToolTurns(request)
      if (current.kind === 'root') {
        expect(names(request)).toEqual(rootTools)
        if (turns.length === 0) return { name: 'eating_delegate_task', arguments: { type_id: current.agentTypeId, context_ref: current.contextRef, task: current.event.messageId === '99601' ? '先分页查询招呼表情，读取真实sendable后在本私聊发送，重用请求ID核对幂等；不要复述普通输出冒充发送。' : '收藏当前消息的授权图片，附描述和标签；重复原请求ID核对收藏结果，不发送QQ消息。' } }
        expect(turns).toHaveLength(1)
        const delegated = result(turns[0]!)
        expect(delegated).toMatchObject({ status: 'completed', summary: `CHILD-STICKERS-SUMMARY:${current.contextRef}`, actions: [expect.objectContaining({ outcome: 'succeeded' })] })
        return `MAIN-STICKERS-SUMMARY:${current.contextRef}`
      }
      expect(names(request)).toEqual(childTools)
      const call = (name: string, args: JsonObject) => ({ name: stickerPrefix + name, arguments: args })
      if (current.event.messageId === '99601') {
        if (turns.length === 0) return call('sticker_list_tags', {})
        if (turns.length === 1) {
          const tags = result(turns[0]!)
          expect(tags).toMatchObject({ revision: 2, tags: expect.arrayContaining([expect.objectContaining({ tag: '确认', count: 2 }), expect.objectContaining({ tag: '招呼', count: 2 })]) })
          noImageData(tags, images)
          return call('sticker_list', { query: '挥手', tags: ['确认', '招呼'], offset: 0, limit: 1, expectedRevision: tags.revision! })
        }
        const first = result(turns[1]!)
        expect(first).toMatchObject({ revision: 2, offset: 0, limit: 1, total: 2, hasMore: true, nextOffset: 1 })
        expect(first.items).toHaveLength(1); noImageData(first, images)
        if (turns.length === 2) return call('sticker_list', { query: '挥手', tags: ['确认', '招呼'], offset: first.nextOffset!, limit: 1, expectedRevision: first.revision! })
        const second = result(turns[2]!)
        expect(second).toMatchObject({ revision: 2, offset: 1, limit: 1, total: 2, hasMore: false, nextOffset: null })
        if (!Array.isArray(first.items) || !Array.isArray(second.items) || second.items.length !== 1) throw new Error('Actual metadata pagination shape differs')
        const selected = object(second.items[0])
        expect(selected.assetId).not.toBe(object(first.items[0]).assetId); noImageData(second, images)
        if (turns.length === 3) return call('sticker_get', { assetId: selected.assetId!, expectedRevision: second.revision! })
        const sendable = sendableFromActualTool(turns[3]!)
        expect(sendable).toEqual({ type: 'image', data: { file: `eating-asset://stickers/${String(selected.assetId)}` } })
        if (turns.length === 4) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(current.event.targetId), message: sendable, request_id: 'stickers-ai-send-99601' } }
        expect(result(turns[4]!)).toEqual({ message_id: 1001 })
        if (turns.length === 5) return { name: turns[4]!.name, arguments: turns[4]!.arguments }
        expect(turns).toHaveLength(6)
        expect(turns[5]!.arguments).toEqual(turns[4]!.arguments)
        expect(result(turns[5]!)).toEqual({ message_id: 1001 })
        return `CHILD-STICKERS-SUMMARY:${current.contextRef}`
      }
      if (current.event.messageId !== '99602') throw new Error('Unexpected real external event')
      if (turns.length === 0) {
        expect(current.event.resourceIds).toEqual([imageId])
        return call('sticker_add', { source: { messageId: String(current.event.messageId), imageId }, description: 'AI收藏原图', tags: ['收藏', '回环'], request_id: 'stickers-ai-add-99602' })
      }
      const added = result(turns[0]!)
      expect(added).toMatchObject({ revision: 3, duplicate: false, item: { description: 'AI收藏原图', tags: ['收藏', '回环'], mimeType: 'image/png', bytes: received.length, assetId: createHash('sha256').update(received).digest('hex') } })
      noImageData(added, images)
      if (turns.length === 1) return { name: turns[0]!.name, arguments: turns[0]!.arguments }
      expect(result(turns[1]!)).toEqual(added)
      if (turns.length === 2) return call('sticker_list', { query: 'AI收藏', tags: ['收藏', '回环'], offset: 0, limit: 1, expectedRevision: added.revision! })
      expect(turns).toHaveLength(3)
      const listed = result(turns[2]!)
      expect(listed).toMatchObject({ revision: 3, total: 1, offset: 0, limit: 1, hasMore: false, nextOffset: null, items: [added.item] })
      noImageData(listed, images)
      return `CHILD-STICKERS-SUMMARY:${current.contextRef}`
    }); stops.push(() => model.close())
    let plugin!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { plugin = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return plugin } }
    let host = new EatingHost({ dataDirectory: home, entries: [qqEntry, stickersEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    let api = await ownerApi(host)
    const addedA = await api('/plugins/stickers/manage', { operation: 'add', input: { data: pngA.toString('base64'), mimeType: 'image/png', description: '挥手确认甲', tags: ['确认', '招呼'] } })
    const addedB = await api('/plugins/stickers/manage', { operation: 'add', input: { data: pngB.toString('base64'), mimeType: 'image/png', description: '挥手确认乙', tags: ['确认', '招呼'] } })
    expect(addedA).toMatchObject({ revision: 1, duplicate: false }); expect(addedB).toMatchObject({ revision: 2, duplicate: false })
    const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
    await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision!, owners: [], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message', 'qq_view_received_image'], 'qq.group': [] } } })
    const directory = await api('/mcp')
    const saved = await api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: directory.revision!, agentTypeIds: ['qq.private'], toolNames: granted } })
    expect(saved.services).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'plugin.stickers', grant: { agentTypeIds: ['qq.private'], toolNames: granted } })]))
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-stickers-model', apiKey: model.apiKey, timeoutMs: 15000, maxTokens: 1024, autoConnect: false })
    await api('/plugins/dsh/manage', { operation: 'save-model-capabilities', input: { expectedRevision: 0, imageInput: true } })
    await api('/plugins/dsh/connect', {})
    const runtime = () => object(plugin.getPublicConfiguration().runtimeStatus), rootId = String(runtime().sessionId)
    const diagnostics = () => ({ runtime: runtime(), status: plugin.getStatus(), delivery: host.harness.getStatus(), errors: model.errors, requests: model.requests.map(request => ({ kind: readModelFixtureBatch(request)?.kind, tools: names(request), last: request.messages?.at(-1) })), stderr: sdkStderr(plugin) })
    const sends = () => onebot.requests.filter(request => request.action.startsWith('send_'))
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: selfId, user_id: userId, message_id: 99601, message: 'UNTRUSTED-STICKER-REQUEST。请发一个招呼表情。' })
    await until(() => host.harness.getStatus().accepted === 1 && plugin.isReady(), diagnostics, model.errors)
    expect(model.requests).toHaveLength(9)
    expect(model.requests.map(request => batch(request).kind)).toEqual(['root', 'child', 'child', 'child', 'child', 'child', 'child', 'child', 'root'])
    expect(model.actions.filter(action => typeof action !== 'string').map(action => action.name)).toEqual(['eating_delegate_task', stickerPrefix + 'sticker_list_tags', stickerPrefix + 'sticker_list', stickerPrefix + 'sticker_list', stickerPrefix + 'sticker_get', 'mcp__qq__qq_send_private_message', 'mcp__qq__qq_send_private_message'])
    expect(sends()).toHaveLength(1)
    const selectedGet = model.actions.find(action => typeof action !== 'string' && action.name === stickerPrefix + 'sticker_get')
    if (!selectedGet || typeof selectedGet === 'string') throw new Error('No actual fixture sticker_get action')
    const selectedAsset = String(selectedGet.arguments.assetId), expectedBytes = object(addedA.item).assetId === selectedAsset ? pngA : pngB
    expect(sends()[0]).toMatchObject({ action: 'send_private_msg', params: { user_id: userId, message: { type: 'image', data: { file: 'base64://' + expectedBytes.toString('base64') } } } })
    const imageBlocks = model.requests[5]!.messages?.flatMap(message => Array.isArray(message.content) ? message.content.filter(isJsonObject).filter(block => block.type === 'image_url') : [])
    expect(imageBlocks).toEqual([expect.objectContaining({ image_url: { url: 'data:image/png;base64,' + expectedBytes.toString('base64') } })])
    const firstBindings = await readTestAgentBindings(home), childId = String(object(firstBindings[0]!.scope).agentId)
    expect(firstBindings).toHaveLength(1)
    expect(object(firstBindings[0]!.scope)).toMatchObject({ agentTypeId: 'qq.private', accountId: String(selfId), targetId: String(userId) })

    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: selfId, user_id: userId, message_id: 99602,
      message: [{ type: 'text', data: { text: '收藏这张图片，附上描述和标签。' } }, { type: 'image', data: { file: imageId } }] })
    await until(() => host.harness.getStatus().accepted === 2 && plugin.isReady(), diagnostics, model.errors)
    expect(model.requests).toHaveLength(15)
    expect(model.requests.slice(9).map(request => batch(request).kind)).toEqual(['root', 'child', 'child', 'child', 'child', 'root'])
    expect(sends()).toHaveLength(1)
    expect(onebot.requests.filter(request => request.action === 'get_msg')).toEqual([expect.objectContaining({ params: { message_id: 99602 } })])
    expect(imageServer.requests).toHaveLength(1)
    expect(imageServer.requests[0]!.headers.authorization).toBeUndefined(); expect(imageServer.requests[0]!.headers.cookie).toBeUndefined()
    expect(object((await readTestAgentBindings(home))[0]!.scope).agentId).toBe(childId)
    for (const request of model.requests) {
      const current = batch(request)
      expect(names(request)).toEqual(current.kind === 'root' ? rootTools : childTools)
      expect(JSON.stringify(request.messages?.filter(message => message.role === 'system'))).not.toContain('UNTRUSTED-STICKER-REQUEST')
      if (current.kind === 'root') noImageData(request, images)
    }
    const library = await api('/plugins/stickers/manage', { operation: 'list', input: {} })
    expect(library).toMatchObject({ revision: 3, total: 3, hasMore: false })
    noImageData(library, images)
    const receivedId = createHash('sha256').update(received).digest('hex')
    const libraryBytes = await readFile(join(home, 'capabilities/stickers/library.json'))
    await host.close()
    const database = await readFile(join(home, 'host/Eating.sqlite'))
    for (const bytes of images) expect(database.includes(Buffer.from(bytes.toString('base64')))).toBe(false)
    host = new EatingHost({ dataDirectory: home, entries: [qqEntry, stickersEntry, entry], port: 0, allowedUiOrigins: [] })
    api = await ownerApi(host)
    expect(await api('/plugins/stickers/manage', { operation: 'list', input: {} })).toEqual(library)
    expect(await readFile(join(home, 'capabilities/stickers/library.json'))).toEqual(libraryBytes)
    expect(await api('/plugins/stickers/manage', { operation: 'get', input: { assetId: receivedId } })).toMatchObject({ revision: 3, item: { description: 'AI收藏原图', tags: ['收藏', '回环'] }, image: { mimeType: 'image/png', data: received.toString('base64') } })
    const reopenedDirectory = await api('/mcp')
    expect(reopenedDirectory.services).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'plugin.stickers', grant: { agentTypeIds: ['qq.private'], toolNames: granted } })]))
    await api('/plugins/qq/connect', {}); await api('/plugins/dsh/connect', {})
    expect(runtime().sessionId).toBe(rootId)
    const web = await connectNativeWeb(await plugin.manage('open-native-web', {}), rootId)
    expect(await web.listSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: rootId }), expect.objectContaining({ sessionId: childId, parentSessionId: rootId })]))
    expect(JSON.stringify(await web.events(childId, rootId))).toContain('stickers-ai-add-99602')
    expect(JSON.stringify(await web.events(rootId))).toContain('MAIN-STICKERS-SUMMARY:')
    expect(model.requests).toHaveLength(15)
    expect(model.errors).toEqual([])
    expect(sends()).toHaveLength(1)
    await host.close()
  }, 120000)

  it('mounts a directly configured read-only MCP tool on the real main Agent and executes it through the model protocol', async () => {
    const home = await temporaryHome(), directCalls: JsonObject[] = []
    const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()
    const upstream = createServer((request, response) => {
      void (async () => {
        if (request.url !== '/mcp') { response.writeHead(404); response.end(); return }
        let body: unknown
        if (request.method === 'POST') {
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        }
        const sessionId = request.headers['mcp-session-id']
        let connection = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
        if (!connection && request.method === 'POST' && isInitializeRequest(body)) {
          const server = new Server({ name: 'direct-main-echo', version: '1.0.0' }, { capabilities: { tools: {} } })
          server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
            { name: 'echo', description: 'Echo exact fixture value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true } },
            { name: 'ungranted_write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
          ] }))
          server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
            if (params.name !== 'echo') throw new Error('Unapproved direct tool reached upstream')
            const args = object(params.arguments); directCalls.push(args)
            return { isError: false, content: [{ type: 'text', text: JSON.stringify({ echo: args.value! }) }] }
          })
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: id => { sessions.set(id, { server, transport }) } })
          await server.connect(transport)
          connection = { server, transport }
        }
        if (!connection) { response.writeHead(404); response.end(); return }
        await connection.transport.handleRequest(request, response, body)
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
    })
    await new Promise<void>((accept, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', accept) })
    stops.push(async () => { for (const connection of sessions.values()) { await connection.server.close(); await connection.transport.close() }; const closed = new Promise<void>((accept, reject) => upstream.close(error => error ? reject(error) : accept())); upstream.closeAllConnections(); await closed })
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('Direct fixture did not bind')
    const onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    let directName = ''
    const model = await startStickersModel(request => {
      expect(batch(request).kind).toBe('root')
      expect(names(request)).toEqual([...rootTools, directName].sort())
      const turns = fixtureToolTurns(request)
      if (turns.length === 0) return { name: directName, arguments: { value: 'ACTUAL-DIRECT-MAIN-ECHO' } }
      expect(turns).toHaveLength(1)
      expect(result(turns[0]!)).toEqual({ echo: 'ACTUAL-DIRECT-MAIN-ECHO' })
      return 'DIRECT-MAIN-SUMMARY，内部结果不自动发送。'
    }); stops.push(() => model.close())
    const requireSdk = createRequire(new URL('../../../plugins/harness/dsh/package.json', import.meta.url))
    const sdkModule = await import(/* @vite-ignore */ pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-sdk-client')).href) as { DeepSeekHarness: new (options: object) => DshHarnessClient & { client: object } }
    let capturedSdk: (DshHarnessClient & { client: object }) | undefined
    const startupErrors: unknown[] = []
    const capture = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      try { return await run() }
      catch (error) { startupErrors.push({ phase, error: String(error).replace(/Bearer\s+[A-Za-z0-9_-]+/g, 'Bearer [REDACTED]') }); throw error }
    }
    const sessionWithDiagnostics = (session: ReturnType<DshHarnessClient['session']>) => ({ id: session.id, run: session.run.bind(session), getWorkingDirectory: () => capture('getWorkingDirectory', () => session.getWorkingDirectory()) })
    let plugin!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { plugin = new DshPlugin(context, { locateSystemDsh: testSystemDsh, createHarness: options => {
      const sdk = capturedSdk = new sdkModule.DeepSeekHarness(options)
      return { start: () => capture('start', () => sdk.start()), close: () => sdk.close(), session: id => sessionWithDiagnostics(sdk.session(id)), resumeSession: async id => sessionWithDiagnostics(await capture('resumeSession', () => sdk.resumeSession(id))) }
    } }); return plugin } }
    const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host)
    const directory = await api('/mcp')
    const saved = await api('/mcp', { operation: 'save', input: { expectedRevision: directory.revision!, name: 'Direct main Echo', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, autoConnect: false, grant: { agentTypeIds: ['main'], toolNames: ['echo'] } } })
    if (!Array.isArray(saved.services)) throw new Error('No saved direct directory')
    const service = saved.services.map(object).find(item => isJsonObject(item.source) && item.source.kind === 'direct')
    if (!service || typeof service.id !== 'string') throw new Error('No direct service id')
    const normalized = service.id.replace(/[^a-zA-Z0-9_]/g, '_')
    const serverName = normalized.length <= 32 ? normalized : 'service_' + createHash('sha256').update(service.id).digest('hex').slice(0, 16)
    directName = 'mcp__' + serverName + '__echo'
    await api('/mcp', { operation: 'connect', input: { id: service.id } })
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, autoConnect: false })
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-direct-model', apiKey: model.apiKey, timeoutMs: 15000, maxTokens: 1024, autoConnect: false })
    try { await api('/plugins/dsh/connect', {}) }
    catch (error) { throw new Error(JSON.stringify({ error: String(error), status: plugin.getStatus(), startupErrors, stderr: capturedSdk ? Reflect.get(capturedSdk.client, 'stderrTail') : null })) }
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: selfId, user_id: userId, message_id: 99701, message: '只通过已授权的通用echo查询，不委派、不发送。' })
    await until(() => host.harness.getStatus().accepted === 1 && plugin.isReady(), () => ({ status: plugin.getStatus(), requests: model.requests, errors: model.errors, stderr: sdkStderr(plugin) }), model.errors)
    expect(model.requests).toHaveLength(2)
    expect(directCalls).toEqual([{ value: 'ACTUAL-DIRECT-MAIN-ECHO' }])
    expect(model.errors).toEqual([])
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toEqual([])
    const current = await api('/mcp')
    expect(current.services).toEqual(expect.arrayContaining([expect.objectContaining({ id: service.id, state: 'connected', grant: { agentTypeIds: ['main'], toolNames: ['echo'] } })]))
    await host.close()
  }, 60000)
})
