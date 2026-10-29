import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, BackendPlugin, BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { assertQQAgentInvocation, parseQQAgentPolicy } from '../../../plugins/communication/qq/src/backend/agent-policy'
import { downloadQQImage, qqViewReceivedImageTool, readQQReceivedImage } from '../../../plugins/communication/qq/src/backend/media'
import { validateToolInput } from '../../../plugins/communication/qq/src/backend/operations'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { startImageFixture } from '../../../tests/fixtures/image'
import { readModelFixtureBatch } from '../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot'
import { EatingHost } from './app'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const imageId = 'fixture-native-pixel.png'
const messageId = '99501'
const modelKey = 'independent-image-model-fixture'

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a current structured fixture value')
  return value
}
function toolNames(request: ModelFixtureRequest): string[] {
  return (request.tools ?? []).map(tool => tool.function?.name ?? '').sort()
}
function imagesIn(request: ModelFixtureRequest): JsonObject[] {
  return (request.messages ?? []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(isJsonObject).filter(block => block.type === 'image_url') : [])
}
async function isolatedHome() {
  const parent = await realpath(tmpdir())
  const home = await realpath(await mkdtemp(join(parent, 'Eating_dsh_image_')))
  cleanups.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('Eating_dsh_image_')) throw new Error('Unsafe image integration fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}

/** One opt-in SDK run; all model requests terminate at this independent HTTP peer. */
async function imageModelFixture() {
  const requests: ModelFixtureRequest[] = []
  const errors: string[] = []
  const roots = new Set<string>(), children = new Set<string>()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
      if (request.headers.authorization !== `Bearer ${modelKey}`) { response.writeHead(401); response.end(); return }
      const parts: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        length += chunk.length
        if (length > 2 * 1024 * 1024) throw new Error('Image model fixture request too large')
        parts.push(Buffer.from(chunk))
      }
      const payload = JSON.parse(Buffer.concat(parts).toString('utf8')) as ModelFixtureRequest
      requests.push(payload)
      const batch = readModelFixtureBatch(payload)
      if (!batch) throw new Error('Image fixture needs a real current Eating batch envelope')
      const names = toolNames(payload)
      let call: { name: string; arguments: JsonObject } | undefined
      let text: string
      if (names.includes('eating_delegate_task')) {
        if (batch.kind !== 'root' || names.join(',') !== 'eating_delegate_task,eating_list_agent_types') throw new Error('Main Agent tool scope was widened')
        if (!roots.has(batch.contextRef)) {
          roots.add(batch.contextRef)
          call = { name: 'eating_delegate_task', arguments: { type_id: 'qq.private', context_ref: batch.contextRef, task: '仅使用获准图片工具读取本批消息的图片，回报实际图像是否可用；不要发送QQ消息。' } }
        }
        text = `MAIN-IMAGE-SUMMARY:${batch.contextRef}`
      } else {
        if (batch.kind !== 'child' || names.join(',') !== 'mcp__qq__qq_view_received_image') throw new Error('Image child does not have its exact approved MCP scope')
        if (!children.has(batch.contextRef)) {
          children.add(batch.contextRef)
          call = { name: 'mcp__qq__qq_view_received_image', arguments: { message_id: messageId, image_id: imageId } }
        }
        text = `CHILD-IMAGE-SUMMARY:${batch.contextRef}`
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: JsonObject, finish: string | null) => response.write(`data: ${JSON.stringify({ id: `image-fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: payload.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
      if (call) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `image_call_${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, null)
        chunk({}, 'tool_calls')
      } else { chunk({ role: 'assistant', content: text }, null); chunk({}, 'stop') }
      response.end('data: [DONE]\n\n')
    })().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  cleanups.push(async () => {
    const closed = new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    server.closeAllConnections()
    await closed
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image model fixture did not bind')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests, errors }
}

/** Preserve the real QQ entry and Host grants; inject a fixture transport only for this extension. */
function imageQQEntry(image: Awaited<ReturnType<typeof startImageFixture>>, scopes: AgentInvocationScope[]): BackendPluginEntry {
  return { ...qqEntry, create(context) {
    const plugin = qqEntry.create(context)
    return new Proxy(plugin, { get(target, property) {
      if (property === 'invokeScoped') return async (name: string, input: unknown, requestId: string, scope: AgentInvocationScope) => {
        if (name !== qqViewReceivedImageTool.name) return target.invokeScoped!(name, input, requestId, scope)
        const params = validateToolInput(qqViewReceivedImageTool, input)
        const accountId = target.getStatus().accountId
        if (!accountId) throw new PlatformError('AGENT_SCOPE_VIOLATION', 'Fixture account is unavailable', 403, 'not-sent')
        const assertActive = () => {
          const configuration = target.getPublicConfiguration()
          const policy = parseQQAgentPolicy({ owners: configuration.owners!, administrators: configuration.administrators!, agentTools: configuration.agentTools!, policyRevision: configuration.policyRevision! })
          assertQQAgentInvocation(name, params, scope, policy, { instanceId: String(configuration.instanceId), accountId: target.getStatus().accountId })
          if (target.getStatus().state !== 'connected') throw new PlatformError('AGENT_SCOPE_VIOLATION', 'Fixture account is no longer connected', 403, 'not-sent')
        }
        assertActive()
        scopes.push(structuredClone(scope))
        return readQQReceivedImage(params, { accountId, scope }, {
          getMessage: id => target.invoke('qq_get_message', { message_id: id }, requestId),
          download: source => downloadQQImage(source, {}, image.network), assertActive,
        })
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as BackendPlugin
  } }
}

async function runImageScenario(imageInput: boolean) {
  const home = await isolatedHome()
  const systemDsh = () => testSystemDsh(resolve(runtimeDirectory!))
  const image = await startImageFixture()
  cleanups.push(() => image.close())
  // Prove this fixture contains an actual compressed RGBA scanline before SDK admission.
  const idatLength = image.bytes.readUInt32BE(33)
  expect(inflateSync(image.bytes.subarray(41, 41 + idatLength))).toEqual(Buffer.from([0, 38, 165, 94, 255]))
  const onebot = await startOneBotFixture({ onRequest(request, peer) {
    if (request.action !== 'get_msg') return false
    replyOneBot(peer, request, { message_id: Number(messageId), message_type: 'private', self_id: 123456789,
      sender: { user_id: 987654321 }, message: [{ type: 'image', data: { file: imageId, url: image.source } }] })
    return true
  } })
  cleanups.push(() => onebot.close())
  const model = await imageModelFixture()
  const scopes: AgentInvocationScope[] = []
  let plugin!: DshPlugin
  const dshEntry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) {
    plugin = new DshPlugin(context, { locateSystemDsh: systemDsh, startupTimeoutMs: 15000 })
    return plugin
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [imageQQEntry(image, scopes), dshEntry], port: 0, allowedUiOrigins: [] })
  cleanups.push(() => host.close())
  const url = await host.listen()
  const bootstrap = await fetch(url + '/api/bootstrap')
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const boot = object(await bootstrap.json())
  const api = async (path: string, body: JsonObject) => {
    const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const value = object(await response.json())
    if (!response.ok) throw new Error(`Image fixture API ${path}: ${JSON.stringify(value)}`)
    return value
  }
  const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
  await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision!, owners: [], administrators: [], agentTools: { 'qq.private': [qqViewReceivedImageTool.name], 'qq.group': [] } } })
  await api('/plugins/qq/connect', {})
  await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-image-model', apiKey: modelKey, timeoutMs: 10000, maxTokens: 1024, autoConnect: false })
  expect(await plugin.manage('get-model-capabilities', {})).toEqual({ schemaVersion: 1, revision: 0, imageInput: false })
  if (imageInput) await api('/plugins/dsh/manage', { operation: 'save-model-capabilities', input: { expectedRevision: 0, imageInput: true } })
  await api('/plugins/dsh/connect', {})
  const runtime = () => object(plugin.getPublicConfiguration().runtimeStatus)
  const patch = await readFile(join(home, 'harness/dsh/bridge/runtime.patch.yaml'), 'utf8')
  expect(patch).toContain(imageInput ? '"input":["text","image"]' : '"input":["text"]')
  onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: Number(messageId),
    message: [{ type: 'text', data: { text: '外部收到的图片，只通过绑定子代理读取。' } }, { type: 'image', data: { file: imageId } }] })
  const deadline = Date.now() + 30000
  const complete = () => host.harness.getStatus().accepted === 1 && host.store.getDeliverySettingsSnapshot().queue.queuedMessages === 0 && runtime().busy === false && model.requests.length >= 4
  while (!complete() && Date.now() < deadline && model.errors.length === 0) await new Promise<void>(accept => setTimeout(accept, 25))
  const diagnostics = JSON.stringify({ status: plugin.getStatus(), runtime: runtime(), delivery: host.harness.getStatus(), requests: model.requests.length, fixtureErrors: model.errors })
  expect(complete(), diagnostics).toBe(true)
  expect(model.errors).toEqual([])
  expect(model.requests).toHaveLength(4)
  const system = (request: ModelFixtureRequest) => request.messages?.filter(message => message.role === 'system')
  expect(system(model.requests[0]!)).toEqual(system(model.requests[3]!))
  expect(system(model.requests[1]!)).toEqual(system(model.requests[2]!))
  const rootId = String(runtime().sessionId)
  for (const id of [rootId, scopes[0]!.agentId]) {
    const viewed = object(await plugin.manage('read-session', { sessionId: id, offset: 0, limit: 50 }))
    if (!Array.isArray(viewed.records)) throw new Error('Expected native view records')
    expect(viewed.records.map(object).filter(record => record.classification === 'time-context')).toHaveLength(1)
  }
  expect(model.requests.map(request => readModelFixtureBatch(request)?.kind)).toEqual(['root', 'child', 'child', 'root'])
  expect(toolNames(model.requests[0]!)).toEqual(['eating_delegate_task', 'eating_list_agent_types'])
  expect(toolNames(model.requests[3]!)).toEqual(['eating_delegate_task', 'eating_list_agent_types'])
  for (const request of model.requests.slice(1, 3)) expect(toolNames(request)).toEqual(['mcp__qq__qq_view_received_image'])
  expect(scopes).toHaveLength(1)
  expect(scopes[0]).toMatchObject({ pluginId: 'qq', agentTypeId: 'qq.private', instanceId: qq.instanceId, accountId: '123456789', targetId: '987654321',
    conversationId: 'qq:123456789:private:987654321', kind: 'private', messageIds: [messageId], resourceIds: [imageId] })
  expect(onebot.requests.filter(request => request.action === 'get_msg')).toEqual([expect.objectContaining({ params: { message_id: Number(messageId) } })])
  expect(onebot.requests.some(request => request.action.startsWith('send_'))).toBe(false)
  expect(image.requests).toHaveLength(1)
  expect(image.requests[0]?.headers.authorization).toBeUndefined()
  expect(image.requests[0]?.headers.cookie).toBeUndefined()
  const batch = readModelFixtureBatch(model.requests[3]!)!
  const parentTool = model.requests[3]!.messages?.slice(batch.messageIndex + 1).find(message => message.role === 'tool')
  const result = object(JSON.parse(String(parentTool?.content)))
  expect(result).toMatchObject({ childId: scopes[0]!.agentId, status: 'completed', summary: expect.stringContaining('CHILD-IMAGE-SUMMARY:'), actions: [] })
  expect(JSON.stringify(model.requests)).not.toContain(image.source)
  expect(imagesIn(model.requests[0]!)).toEqual([])
  expect(imagesIn(model.requests[1]!)).toEqual([])
  expect(imagesIn(model.requests[3]!)).toEqual([])
  expect(await plugin.manage('get-model-capabilities', {})).toMatchObject({ imageInput, revision: imageInput ? 1 : 0 })
  const bindings = object(JSON.parse(await readFile(join(home, 'harness/dsh/agent-bindings.json'), 'utf8')))
  expect(bindings).toMatchObject({ schemaVersion: 2, bindings: [expect.objectContaining({ scope: expect.objectContaining({ agentId: scopes[0]!.agentId }), taskRefs: [expect.objectContaining({ state: 'completed' })] })] })
  return { continuation: model.requests[2]!, bytes: image.bytes, model, plugin }
}

// Opt-in real native SDK/Host/DSH attachment path; all account, image and model peers are local fixtures.
describe.runIf(Boolean(runtimeDirectory))('真实 Host MCP 图片 → DSH 附件 → 模型请求', () => {
  it('sends a decoded image_url block only after the owner explicitly enables image input', async () => {
    const { continuation, bytes } = await runImageScenario(true)
    const blocks = imagesIn(continuation)
    expect(blocks).toHaveLength(1)
    const imageUrl = object(blocks[0]!.image_url)
    const expected = `data:image/png;base64,${bytes.toString('base64')}`
    expect(imageUrl.url).toBe(expected)
    expect(Buffer.from(String(imageUrl.url).slice('data:image/png;base64,'.length), 'base64')).toEqual(bytes)
    expect(JSON.stringify(continuation.messages)).not.toContain('image unavailable')
  }, 60000)

  it('keeps the default text model unchanged and projects an explicit image-unavailable diagnostic', async () => {
    const { continuation, bytes } = await runImageScenario(false)
    expect(imagesIn(continuation)).toEqual([])
    const diagnostic = JSON.stringify(continuation.messages)
    expect(diagnostic).toContain('image unavailable: image/png')
    expect(diagnostic).toContain('does not declare image input')
    expect(diagnostic).not.toContain(bytes.toString('base64'))
    expect(diagnostic).not.toContain('data:image/')
  }, 60000)
})
