import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { HostStore } from '../../../../apps/host/src/store'
import { PlatformError } from '@eating/plugin-sdk'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, HostPluginContext, ImageAssetLease, ImageResource, JsonObject } from '@eating/plugin-sdk'
import { createLargeImageFixturePng } from '../../../../tests/fixtures/image'
import { replyOneBot, startOneBotFixture } from '../../../../tests/fixtures/onebot'
import entry from './server'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
const reference = { type: 'image', data: { file: 'eating-asset://image-generation/fixture-image' } }
const maxImage = createLargeImageFixturePng(5 * 1024 * 1024)

async function fixture(options: { bytes?: Buffer; fail?: boolean; unknown?: boolean; readSentFile?: boolean } = {}) {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-qq-assets-')))
  stops.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('eating-qq-assets-')) throw new Error('Unsafe QQ asset cleanup')
    await rm(target, { recursive: true })
  })
  const receivedFileBytes: Buffer[] = []
  const remote = await startOneBotFixture({ login: { user_id: 123456, nickname: 'Asset loopback' }, onRequest(request, peer) {
    if (request.action === 'send_private_msg' && options.readSentFile) {
      const message = request.params.message as JsonObject, data = message.data as JsonObject
      const target = fileURLToPath(String(data.file))
      if (dirname(target) !== join(home, 'mapped')) throw new Error('Unexpected fixture media path')
      receivedFileBytes.push(readFileSync(target))
    }
    if (request.action === 'send_private_msg' && options.fail) { replyOneBot(peer, request, null, 'failed', 100); return true }
    if (request.action === 'send_private_msg' && options.unknown) { peer.terminate(); return true }
  } })
  stops.push(() => remote.close())
  const bytes = options.bytes ?? maxImage, image: ImageResource = { mimeType: 'image/png', data: bytes.toString('base64') }
  const sourceRoot = join(home, 'source'), hostMappingRoot = join(home, 'mapped')
  await mkdir(sourceRoot); await mkdir(hostMappingRoot)
  const sourceFile = join(sourceRoot, 'image.png'), mappedFile = join(hostMappingRoot, 'image.png')
  await writeFile(sourceFile, bytes); await writeFile(mappedFile, bytes)
  const assertActive = vi.fn(async () => {}), assertCurrent = vi.fn(() => {})
  const asset: ImageAssetLease = { mimeType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    readBytes: async () => bytes, localFile: async () => sourceFile, assertActive, assertCurrent }
  const getAsset = vi.fn<NonNullable<HostPluginContext['resources']>['getAsset']>(async () => asset)
  const readAsset = vi.fn<NonNullable<HostPluginContext['resources']>['readAsset']>(async () => { throw new Error('Sending must not read Base64 previews') })
  const store = new HostStore(join(home, 'ledger.sqlite')); stops.push(() => store.close())
  const executeIdempotent = vi.fn<HostPluginContext['executeIdempotent']>((...args) => store.executeIdempotent(...args))
  const context: HostPluginContext = { dataDirectory: home, getSetting: () => null, setSetting: () => {}, listMessages: () => [],
    recordEvent: () => ({ inserted: true, eventId: 'fixture-event' }), executeIdempotent,
    resources: { getAsset, readAsset, readReceivedImage: async () => { throw new Error('Unexpected received image read') } } }
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
  const mapping = { sourceRoot, hostMappingRoot, onebotRoot: hostMappingRoot, ownerConfirmed: true }
  const saveMapping = async (override: JsonObject = {}) => plugin.manage!('save-media-transport', { expectedRevision: 0, mode: 'shared-directory', mapping: { ...mapping, ...override } })
  return { plugin, remote, image, getAsset, asset, assertActive, assertCurrent, readAsset, executeIdempotent, controller, scope, send, sends, home, sourceFile, mappedFile, mapping, saveMapping, receivedFileBytes }
}

describe('QQ authorized image assets with real OneBot transport', () => {
  it('sends the full 5 MiB PNG plus text and base64 JSON overhead exactly once, keeping raw bytes out of Host actions', async () => {
    const f = await fixture(), message = [{ type: 'text', data: { text: '生成完成。' } }, reference]
    await expect(f.send(message)).resolves.toEqual({ message_id: 1001 })
    expect(f.getAsset).toHaveBeenCalledExactlyOnceWith({ pluginId: 'image-generation', assetId: 'fixture-image' }, { agentId: f.scope.agentId, agentTypeId: 'qq.private', source: f.scope })
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
    expect(f.getAsset).not.toHaveBeenCalled()
    expect(f.readAsset).not.toHaveBeenCalled()
    expect(f.sends()).toEqual([])
  })

  it('rechecks the signal and current policy after asset reads and sends nothing when revoked', async () => {
    const f = await fixture()
    f.getAsset.mockImplementationOnce(async () => { f.controller.abort(); return f.asset })
    await expect(f.send(reference)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
    expect(f.sends()).toEqual([])
    const next = await fixture()
    next.getAsset.mockImplementationOnce(async () => {
      await next.plugin.manage!('save-agent-policy', { expectedRevision: next.plugin.getPublicConfiguration().policyRevision, owners: [], administrators: [], agentTools: { 'qq.private': [], 'qq.group': [] } })
      return next.asset
    })
    await expect(next.send(reference)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
    expect(next.sends()).toEqual([])
  })

  it('uses verified mapped file URIs with real files and keeps all paths out of logical actions', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng(), readSentFile: true })
    expect(await f.saveMapping()).toMatchObject({ schemaVersion: 1, revision: 1, fileEligible: true })
    await expect(f.send(reference)).resolves.toEqual({ message_id: 1001 })
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: pathToFileURL(f.mappedFile).href } })
    expect(f.readAsset).not.toHaveBeenCalled()
    expect(f.assertActive).toHaveBeenCalledTimes(1)
    expect(f.receivedFileBytes).toEqual([Buffer.from(f.image.data, 'base64')])
    const logical = JSON.stringify(f.executeIdempotent.mock.calls[0]![2])
    expect(logical).toContain('eating-asset://image-generation/fixture-image')
    for (const value of [f.home, 'base64://', 'file://']) expect(logical).not.toContain(value)
    expect(JSON.stringify(f.plugin.getPublicConfiguration())).not.toContain('media-transport')
    await f.plugin.dispose()
    const persisted = await readFile(join(f.home, 'ledger.sqlite'))
    expect(persisted.includes(Buffer.from(f.home))).toBe(false)
  })

  it('maps a Host-visible mount to a different OneBot container root only with owner confirmation', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    await f.saveMapping({ onebotRoot: '/container/media' })
    await f.send(reference)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: 'file:///container/media/image.png' } })
    expect(f.remote.requests.some(request => request.action === 'get_image')).toBe(false)
  })

  it.each([
    ['/container/shared %20/#images', 'file:///container/shared%20%2520/%23images/image.png'],
    ['C:\\shared %20\\images', 'file:///C:/shared%20%2520/images/image.png'],
  ])('encodes the exact mapped path without changing percent or special characters: %s', async (onebotRoot, expected) => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    await f.saveMapping({ onebotRoot })
    await f.send(reference)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: expected } })
  })

  it('keeps loopback and an unconfirmed owner mapping on Base64', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    expect(await f.saveMapping({ ownerConfirmed: false })).toMatchObject({ fileEligible: false })
    await f.send(reference)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: 'base64://' + f.image.data } })
    expect(f.readAsset).not.toHaveBeenCalled()
  })

  it.each(['size', 'mismatch', 'symlink', 'missing', 'outside'] as const)('falls back before sending when the mapped target is %s', async kind => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    await f.saveMapping()
    if (kind === 'size') await writeFile(f.mappedFile, createLargeImageFixturePng(2 * 1024 * 1024))
    if (kind === 'mismatch') { const changed = Buffer.from(f.image.data, 'base64'); changed[changed.length - 1] = 0; await writeFile(f.mappedFile, changed) }
    if (kind === 'missing' || kind === 'symlink') {
      const target = await realpath(f.mappedFile)
      if (target !== f.mappedFile || dirname(target) !== f.mapping.hostMappingRoot) throw new Error('Unsafe mapped fixture removal')
      await rm(target)
      if (kind === 'symlink') await symlink(f.sourceFile, f.mappedFile)
    }
    if (kind === 'outside') f.getAsset.mockResolvedValueOnce({ ...f.asset, localFile: async () => join(f.home, 'outside.png') })
    await f.send(reference)
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: 'base64://' + f.image.data } })
  })

  it('uses verified bytes when the optional local-file preflight is unavailable before sending', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    await f.saveMapping()
    f.getAsset.mockResolvedValueOnce({ ...f.asset, localFile: async () => { throw new Error('Optional local file unavailable') } })
    await f.send(reference)
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: 'base64://' + f.image.data } })
  })

  it('checks revocation immediately before selecting the final wire and does not send', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    await f.saveMapping()
    f.assertActive.mockImplementationOnce(async () => { f.controller.abort() })
    await expect(f.send(reference)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
    expect(f.sends()).toHaveLength(0)
  })

  it('rechecks every source synchronously after all asynchronous image checks complete', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    let sourceAllowed = true
    f.assertCurrent.mockImplementation(() => { if (!sourceAllowed) throw new PlatformError('ASSET_ACCESS_DENIED', 'Source revoked', 403, 'not-sent') })
    f.getAsset.mockResolvedValueOnce(f.asset).mockResolvedValueOnce({ ...f.asset, assertActive: async () => { sourceAllowed = false } })
    await expect(f.send([reference, reference])).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED', outcome: 'not-sent' })
    expect(f.sends()).toHaveLength(0)
  })

  it('keeps a lost mapped-file send unknown and never changes mode or resends the same logical request', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng(), unknown: true })
    await f.saveMapping()
    await expect(f.send(reference)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0]!.params.message).toEqual({ type: 'image', data: { file: pathToFileURL(f.mappedFile).href } })
    await expect(f.send(reference)).rejects.toMatchObject({ outcome: 'not-sent' })
    expect(f.sends()).toHaveLength(1)
    expect(f.getAsset).toHaveBeenCalledTimes(1)
  })

  it('preserves formal OneBot file, URL and Base64 parameters exactly', async () => {
    const f = await fixture({ bytes: createLargeImageFixturePng() })
    const message = ['file:///onebot-owned/image.png', 'https://image.fixture.invalid/media.png', 'base64://YWJj'].map(file => ({ type: 'image', data: { file } }))
    await f.send(message)
    expect(f.sends()[0]!.params.message).toEqual(message)
    expect(f.getAsset).not.toHaveBeenCalled()
  })

  it('keeps a real retcode 100 as failed with one send and a private error', async () => {
    const f = await fixture({ fail: true })
    await expect(f.send(reference)).rejects.toMatchObject({ code: 'onebot_retcode_100', outcome: 'failed' })
    expect(f.sends()).toHaveLength(1)
    expect(f.plugin.getStatus().lastError).toBe('OneBot API 执行失败（retcode 100）')
  })
})
