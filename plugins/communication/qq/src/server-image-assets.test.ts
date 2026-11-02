import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, HostPluginContext, ImageResource, JsonObject } from '@eating/plugin-sdk'
import { createLargeImageFixturePng } from '../../../../tests/fixtures/image'
import { replyOneBot, startOneBotFixture } from '../../../../tests/fixtures/onebot'
import entry from './server'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
const reference = { type: 'image', data: { file: 'eating-asset://image-generation/fixture-image' } }
const maxImage = createLargeImageFixturePng(5 * 1024 * 1024)

async function fixture(options: { bytes?: Buffer; fail?: boolean } = {}) {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-qq-assets-')))
  stops.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('eating-qq-assets-')) throw new Error('Unsafe QQ asset cleanup')
    await rm(target, { recursive: true })
  })
  const remote = await startOneBotFixture({ login: { user_id: 123456, nickname: 'Asset loopback' }, onRequest(request, peer) {
    if (request.action === 'send_private_msg' && options.fail) { replyOneBot(peer, request, null, 'failed', 100); return true }
  } })
  stops.push(() => remote.close())
  const image: ImageResource = { mimeType: 'image/png', data: (options.bytes ?? maxImage).toString('base64') }
  const readAsset = vi.fn<NonNullable<HostPluginContext['resources']>['readAsset']>(async () => image)
  const executeIdempotent = vi.fn<HostPluginContext['executeIdempotent']>(async (_id, _action, _params, _requestId, execute) => execute())
  const context: HostPluginContext = { dataDirectory: home, getSetting: () => null, setSetting: () => {}, listMessages: () => [],
    recordEvent: () => ({ inserted: true, eventId: 'fixture-event' }), executeIdempotent,
    resources: { readAsset, readReceivedImage: async () => { throw new Error('Unexpected received image read') } } }
  const plugin = entry.create(context)
  stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ endpoint: remote.endpoint, timeoutMs: 5000, autoConnect: false })
  await plugin.connect()
  const controller = new AbortController()
  const scope: AgentInvocationScope = { agentId: 'isolated-image-child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: String(plugin.getPublicConfiguration().instanceId),
    accountId: '123456', conversationId: 'qq:123456:private:234567', kind: 'private', targetId: '234567', messageIds: ['12'], resourceIds: [], signal: controller.signal }
  const send = (message: JsonObject | JsonObject[] | string, extra: JsonObject = {}) => plugin.invokeScoped!('qq_send_private_message',
    { user_id: '234567', message, request_id: 'qq-asset-send-0001', ...extra }, 'qq-asset-send-0001', scope)
  const sends = () => remote.requests.filter(request => request.action.startsWith('send_'))
  return { plugin, remote, image, readAsset, executeIdempotent, controller, scope, send, sends }
}

describe('QQ authorized image assets with real OneBot transport', () => {
  it('sends the full 5 MiB PNG plus text and base64 JSON overhead exactly once, keeping raw bytes out of Host actions', async () => {
    const f = await fixture(), message = [{ type: 'text', data: { text: '生成完成。' } }, reference]
    await expect(f.send(message)).resolves.toEqual({ message_id: 1001 })
    expect(f.readAsset).toHaveBeenCalledExactlyOnceWith({ pluginId: 'image-generation', assetId: 'fixture-image' }, { agentId: f.scope.agentId, agentTypeId: 'qq.private', source: f.scope })
    expect(f.sends()).toHaveLength(1)
    const sent = f.sends()[0]!, segments = sent.params.message as JsonObject[]
    expect(segments[0]).toEqual(message[0])
    expect(segments[1]).toEqual({ type: 'image', data: { file: 'base64://' + f.image.data } })
    expect(Buffer.from(String((segments[1]!.data as JsonObject).file).slice(9), 'base64').equals(maxImage)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(sent.params))).toBeGreaterThan(5 * 1024 * 1024)
    expect(f.executeIdempotent).toHaveBeenCalledTimes(1)
    expect(f.executeIdempotent.mock.calls[0]![2]).toEqual({ user_id: 234567, message, auto_escape: true })
    expect(JSON.stringify(f.executeIdempotent.mock.calls[0]![2])).not.toContain(f.image.data)
    expect(f.remote.connections).toHaveLength(1)
  })

  it('allows two 5 MiB assets at the existing 10 MiB aggregate boundary including base64 padding and JSON', async () => {
    const f = await fixture()
    await expect(f.send([reference, reference])).resolves.toEqual({ message_id: 1001 })
    expect(f.sends()).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(f.sends()[0]!.params))).toBeGreaterThan(13 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(f.sends()[0]!.params))).toBeLessThan(15 * 1024 * 1024)
  })

  it('rejects a single image above 5 MiB before any send', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng(5 * 1024 * 1024 + 1) })
    await expect(f.send(reference)).rejects.toMatchObject({ code: 'INVALID_IMAGE_RESOURCE', outcome: 'not-sent' })
    expect(f.sends()).toEqual([])
  })

  it('rejects images above the existing aggregate bound before any send', async () => {
    const f = await fixture()
    await expect(f.send([reference, reference, reference])).rejects.toMatchObject({ code: 'MEDIA_ASSET_LIMIT', outcome: 'not-sent' })
    expect(f.sends()).toEqual([])
  })

  it('rejects more than four assets before any send', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    await expect(f.send(Array.from({ length: 5 }, () => reference))).rejects.toMatchObject({ code: 'MEDIA_ASSET_LIMIT', outcome: 'not-sent' })
    expect(f.sends()).toEqual([])
  })

  it('keeps the original text, total model-input and schema bounds even alongside an authorized image', async () => {
    const f = await fixture()
    for (const message of ['x'.repeat(262145), [{ type: 'text', data: { text: 'x'.repeat(262145) } }, reference],
      [...Array.from({ length: 4 }, () => ({ type: 'text', data: { text: 'x'.repeat(262144) } })), reference]]) {
      await expect(f.send(message)).rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'not-sent' })
    }
    await expect(f.send(reference, { resolvedImageBase64Bytes: f.image.data.length })).rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'not-sent' })
    expect(f.readAsset).not.toHaveBeenCalled()
    expect(f.sends()).toEqual([])
  })

  it('rechecks the signal and current policy after asset reads and sends nothing when revoked', async () => {
    const f = await fixture()
    f.readAsset.mockImplementationOnce(async () => { f.controller.abort(); return f.image })
    await expect(f.send(reference)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
    expect(f.sends()).toEqual([])
    const next = await fixture()
    next.readAsset.mockImplementationOnce(async () => {
      await next.plugin.manage!('save-agent-policy', { expectedRevision: next.plugin.getPublicConfiguration().policyRevision, owners: [], administrators: [], agentTools: { 'qq.private': [], 'qq.group': [] } })
      return next.image
    })
    await expect(next.send(reference)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
    expect(next.sends()).toEqual([])
  })

  it('keeps a real retcode 100 as failed with one send and a private error', async () => {
    const f = await fixture({ fail: true })
    await expect(f.send(reference)).rejects.toMatchObject({ code: 'onebot_retcode_100', outcome: 'failed' })
    expect(f.sends()).toHaveLength(1)
    expect(f.plugin.getStatus().lastError).toBe('OneBot API 执行失败（retcode 100）')
  })
})
