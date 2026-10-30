import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { AgentInvocationScope, BackendPlugin, BackendPluginEntry, HarnessCapabilityConnection, HarnessHostServices, ImageResource, JsonObject } from '@eating/plugin-sdk'
import { EatingHost } from './app'
import qqEntry from '../../../plugins/communication/qq/src/server'
import stickersEntry from '../../../plugins/capabilities/stickers/src/server'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { createImageFixturePng } from '../../../tests/fixtures/image'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected fixture object'); return value }
function gate() { return { entered: deferred<void>(), release: deferred<void>() } }
async function fixture() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-capability-revocation-')))
  stops.push(async () => { if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-capability-revocation-')) throw new Error('Unsafe revocation fixture cleanup'); await rm(home, { recursive: true }) })
  const onebot = await startOneBotFixture({ login: { user_id: 10001, nickname: 'Synthetic revocation fixture' } }); stops.push(() => onebot.close())
  const image: ImageResource = { mimeType: 'image/png', data: createImageFixturePng().toString('base64') }
  let services!: HarnessHostServices, qqPlugin!: BackendPlugin, stickerPlugin!: BackendPlugin
  let assetGate: ReturnType<typeof gate> | undefined, receivedGate: ReturnType<typeof gate> | undefined
  let observedSignal: AbortSignal | undefined
  const qqSettled = deferred<unknown>(), stickerSettled = deferred<unknown>()
  const wrappedQq: BackendPluginEntry = { ...qqEntry, create(context) {
    qqPlugin = qqEntry.create(context)
    return new Proxy(qqPlugin, { get(target, property) {
      if (property === 'invokeScoped') return async (...args: Parameters<NonNullable<BackendPlugin['invokeScoped']>>) => {
        observedSignal = args[3].signal
        try { const result = await target.invokeScoped!(...args); qqSettled.resolve(result); return result }
        catch (error) { qqSettled.resolve(error); throw error }
      }
      if (property === 'readReceivedImage') return async (_reference: unknown, scope: AgentInvocationScope) => {
        if (!receivedGate) throw new Error('Unexpected received-image fixture call')
        observedSignal = scope.signal
        receivedGate.entered.resolve(); await receivedGate.release.promise
        return image
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  const wrappedStickers: BackendPluginEntry = { ...stickersEntry, create(context) {
    stickerPlugin = stickersEntry.create(context)
    return new Proxy(stickerPlugin, { get(target, property) {
      if (property === 'media') return { ...target.media!, readAsset: async (id: string) => {
        if (assetGate) { assetGate.entered.resolve(); await assetGate.release.promise }
        return target.media!.readAsset(id)
      } }
      if (property === 'invokeCapability') return async (...args: Parameters<NonNullable<BackendPlugin['invokeCapability']>>) => {
        try { const result = await target.invokeCapability!(...args); stickerSettled.resolve(result); return result }
        catch (error) { stickerSettled.resolve(error); throw error }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  const harness: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) {
    services = context.harness!
    let state: 'connected' | 'disconnected' = 'connected'
    return { id: 'fixture', kind: 'harness', name: 'Fixture', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => { state = 'connected' }, disconnect: async () => { state = 'disconnected' }, invoke: async () => null, dispose: async () => {} }
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [wrappedQq, wrappedStickers, harness], port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
  stops.push(() => host.close())
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), boot = object(await bootstrap.json()), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const api = async (path: string, body?: JsonObject) => {
    const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-CSRF': String(boot.csrfToken), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = object(await response.json()); if (!response.ok) throw new Error(`Revocation fixture API ${path}: ${JSON.stringify(value)}`)
    return value
  }
  await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false }); await api('/plugins/qq/connect', {})
  const configuration = qqPlugin.getPublicConfiguration()
  const scope: AgentInvocationScope = { agentId: 'revocation-child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: String(configuration.instanceId), accountId: '10001', conversationId: 'qq:10001:private:20002', kind: 'private', targetId: '20002', messageIds: ['900'], resourceIds: ['fixture-received-image'] }
  const grant = async (tools: string[]) => {
    const directory = await api('/mcp'), revision = directory.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Expected a valid MCP directory revision')
    await api('/mcp', { operation: 'save-grants', input: { id: 'plugin.stickers', expectedRevision: revision, agentTypeIds: ['qq.private'], toolNames: tools } })
  }
  const client = async (connection: Pick<HarnessCapabilityConnection, 'url' | 'headers'>) => {
    const client = new Client({ name: 'revocation-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } })); stops.push(() => client.close())
    return client
  }
  const addOwnerSticker = async () => object(await stickerPlugin.manage!('add', { ...image, description: 'Fixture sticker', tags: ['fixture'] })).item
  return { api, onebot, services, scope, image, qqSettled, stickerSettled, grant, client, addOwnerSticker, stickerPlugin,
    get observedSignal() { return observedSignal },
    deferAsset() { const value = assetGate = gate(); stops.push(() => value.release.resolve()); return value },
    deferReceived() { const value = receivedGate = gate(); stops.push(() => value.release.resolve()); return value },
  }
}

// Real Host, MCP and QQ send path, with only the byte-provider await deferred.
// OneBot is loopback; no model, real account, or external image service is used.
describe('capability resource lifetime revocation', () => {
  it('does not send a QQ asset after its Agent lease is revoked while the resource is awaited', async () => {
    const f = await fixture(), item = object(await f.addOwnerSticker())
    await f.grant(['sticker_get'])
    f.services.getCapabilityMcpConnections({ agentId: f.scope.agentId, agentTypeId: f.scope.agentTypeId, source: f.scope })
    const client = await f.client(f.services.getMcpConnection('qq', f.scope)), pendingAsset = f.deferAsset()
    const pending = client.callTool({ name: 'qq_send_private_message', arguments: { user_id: f.scope.targetId, message: { type: 'image', data: { file: `eating-asset://stickers/${String(item.assetId)}` } }, request_id: 'revoke-asset-send-001' } }).catch(error => error)
    await pendingAsset.entered.promise
    expect(f.observedSignal?.aborted).toBe(false)
    f.services.revokeAgentAccess(f.scope.agentId)
    expect(f.observedSignal?.aborted).toBe(true)
    pendingAsset.release.resolve()
    await expect(f.qqSettled.promise).resolves.toMatchObject({ outcome: 'not-sent' })
    await pending
    expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(0)
  })

  it('does not save a received sticker after its capability lease is revoked during image retrieval', async () => {
    const f = await fixture()
    await f.grant(['sticker_add'])
    const connection = f.services.getCapabilityMcpConnections({ agentId: f.scope.agentId, agentTypeId: f.scope.agentTypeId, source: f.scope })[0]!
    const client = await f.client(connection), pendingImage = f.deferReceived()
    const before = object(await f.stickerPlugin.manage!('list', {}))
    const pending = client.callTool({ name: 'sticker_add', arguments: { source: { messageId: '900', imageId: 'fixture-received-image' }, description: 'Must never be committed', tags: ['revoked'], request_id: 'revoke-sticker-add-001' } }).catch(error => error)
    await Promise.race([pendingImage.entered.promise, pending.then(result => { throw new Error(`Sticker call ended before the deferred resource: ${JSON.stringify(result)} ${String(result)}`) })])
    expect(f.observedSignal?.aborted).toBe(false)
    f.services.revokeAgentAccess(f.scope.agentId)
    expect(f.observedSignal?.aborted).toBe(true)
    pendingImage.release.resolve()
    await expect(f.stickerSettled.promise).resolves.toMatchObject({ outcome: 'not-sent' })
    await pending
    expect(object(await f.stickerPlugin.manage!('list', {}))).toEqual(before)
    expect(f.onebot.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0)
  })

  it('checks the trusted lifetime again when a sticker metadata write reaches its serialized commit', async () => {
    const f = await fixture(), item = object(await f.addOwnerSticker())
    const before = object(await f.stickerPlugin.manage!('list', {})), signal = new AbortController()
    const input = { assetId: item.assetId, description: 'Revoked queued metadata', tags: ['revoked'], expectedRevision: before.revision, request_id: 'revoke-sticker-queued-001' }
    const pending = f.stickerPlugin.invokeCapability!('sticker_update', input, input.request_id, { agentId: f.scope.agentId, agentTypeId: f.scope.agentTypeId, signal: signal.signal })
    signal.abort()
    await expect(pending).rejects.toMatchObject({ code: 'STICKER_ACCESS_REVOKED', outcome: 'not-sent' })
    expect(object(await f.stickerPlugin.manage!('list', {}))).toEqual(before)
  })

  it('keeps an owner invocation without Agent scope usable while an unrelated Agent is revoked', async () => {
    const f = await fixture(), item = object(await f.addOwnerSticker()), pendingAsset = f.deferAsset()
    const pending = f.api('/plugins/qq/invoke', { name: 'qq_send_private_message', arguments: { user_id: f.scope.targetId, message: { type: 'image', data: { file: `eating-asset://stickers/${String(item.assetId)}` } } }, requestId: 'owner-asset-send-001', confirmed: true })
    await pendingAsset.entered.promise
    f.services.revokeAgentAccess(f.scope.agentId)
    pendingAsset.release.resolve()
    expect(await pending).toMatchObject({ ok: true, result: { message_id: 1001 } })
    expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    expect(f.onebot.requests.find(request => request.action === 'send_private_msg')?.params.message).toEqual({ type: 'image', data: { file: 'base64://' + f.image.data } })
  })
})
