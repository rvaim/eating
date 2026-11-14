import { DEFAULT_IMAGE_LIMITS } from '@eating/plugin-sdk'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { AudioAssetLease, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { wav } from '../../../capabilities/text-to-speech/src/backend/audio'
import { HostStore } from '../../../../apps/host/src/store'
import { startOneBotFixture } from '../../../../tests/fixtures/onebot'
import qqEntry from './server'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
const segment = { type: 'record', data: { file: 'eating-audio://text-to-speech/' + 'a'.repeat(64) } }
async function fixture(unknown = false) {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-audio-send-')))
  stops.push(async () => { if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-audio-send-')) throw new Error('Unsafe audio cleanup'); await rm(root, { recursive: true }) })
  const remote = await startOneBotFixture({ onRequest: (request, peer) => { if (unknown && request.action === 'send_private_msg') { peer.terminate(); return true } } }); stops.push(() => remote.close())
  const bytes = wav(Buffer.alloc(48000 * 30)), abort = new AbortController()
  let revoked = false, corrupt = false
  const active = () => { if (revoked || abort.signal.aborted) throw new PlatformError('ASSET_ACCESS_DENIED', 'Revoked fixture lease', 403, 'not-sent') }
  const lease: AudioAssetLease = { mimeType: 'audio/wav', byteLength: bytes.length, durationMs: 30000, sha256: createHash('sha256').update(bytes).digest('hex'), readBytes: async () => corrupt ? wav(Buffer.alloc(48)) : bytes, assertCurrent: active, assertActive: async () => { active() } }
  const store = new HostStore(join(root, 'ledger.sqlite')); stops.push(() => store.close())
  const executeIdempotent = vi.fn<HostPluginContext['executeIdempotent']>((...args) => store.executeIdempotent(...args))
  const getAudioAsset = vi.fn(async () => lease)
  const context: HostPluginContext = { imageLimits: () => DEFAULT_IMAGE_LIMITS, dataDirectory: root, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: false, eventId: 'fixture' }), listMessages: () => [], executeIdempotent,
    resources: { readReceivedAudio: async () => { throw new Error('No incoming audio in this fixture') }, getAudioAsset, getAsset: async () => { throw new Error('No images') }, readAsset: async () => { throw new Error('No images') }, readReceivedImage: async () => { throw new Error('No images') } } }
  const plugin = qqEntry.create(context); stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ endpoint: remote.endpoint, autoConnect: false, timeoutMs: 1000 }); await plugin.connect()
  const accountId = '123456789'
  const scope = { agentId: 'voice-child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: String(plugin.getPublicConfiguration().instanceId), accountId: String(accountId), kind: 'private' as const, targetId: '987654321', conversationId: `qq:${accountId}:private:987654321`, messageIds: [], resourceIds: [], signal: abort.signal }
  const send = (message: JsonValue = segment) => plugin.invokeScoped!('qq_send_private_message', { user_id: scope.targetId, message, request_id: 'qq-audio-request-001' }, 'qq-audio-request-001', scope)
  const sendAudio = () => plugin.invokeScoped!('qq_send_private_message', { user_id: scope.targetId, audio_ref: segment.data.file, request_id: 'qq-audio-request-001' }, 'qq-audio-request-001', scope)
  return { send, sendAudio, remote, plugin, bytes, abort, executeIdempotent, getAudioAsset, revoke: () => { revoked = true }, corrupt: () => { corrupt = true } }
}
describe('QQ trusted audio transport and idempotency', () => {
  it('sends a 30 second WAV over the ordinary size limit exactly once using backend-resolved bytes', async () => {
    const f = await fixture(); expect(f.bytes.length).toBeGreaterThan(1024 * 1024)
    await expect(f.send()).resolves.toEqual({ message_id: 1001 }); await f.send()
    const sends = f.remote.requests.filter(x => x.action === 'send_private_msg'); expect(sends).toHaveLength(1)
    const file = String((sends[0]!.params.message as JsonObject).data && ((sends[0]!.params.message as JsonObject).data as JsonObject).file)
    expect(Buffer.from(file.slice(9), 'base64').equals(f.bytes)).toBe(true)
  })
  it.each(['revoked', 'aborted', 'corrupt', 'mixed', 'wrong-kind'] as const)('rejects %s before any OneBot send', async mode => {
    const f = await fixture()
    if (mode === 'revoked') f.revoke(); if (mode === 'aborted') f.abort.abort(); if (mode === 'corrupt') f.corrupt()
    const message = mode === 'mixed' ? [segment, { type: 'text', data: { text: 'mixed is not supported' } }] : mode === 'wrong-kind' ? { type: 'image', data: segment.data } : segment
    await expect(f.send(message)).rejects.toMatchObject({ outcome: 'not-sent' })
    expect(f.remote.requests.filter(x => x.action.startsWith('send_'))).toHaveLength(0)
  })
  it('rejects serialized text/audio and internal CQ before the ledger, then corrects the same request exactly once', async () => {
    const f = await fixture()
    for (const message of [
      JSON.stringify([{ type: 'text', data: { text: 'fixture' } }]),
      JSON.stringify(segment), JSON.stringify([segment]),
      `[CQ:record,file=${segment.data.file}]`,
      { type: 'text', data: { text: segment.data.file } },
      [segment, { type: 'text', data: { text: 'do not mix' } }],
    ]) await expect(f.send(message)).rejects.toMatchObject({ code: 'QQ_MESSAGE_FORMAT_INVALID', statusCode: 400, outcome: 'not-sent' })
    expect(f.executeIdempotent).not.toHaveBeenCalled()
    expect(f.getAudioAsset).not.toHaveBeenCalled()
    expect(f.remote.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0)
    await expect(f.sendAudio()).resolves.toEqual({ message_id: 1001 })
    await expect(f.send([segment])).resolves.toEqual({ message_id: 1001 })
    expect(f.getAudioAsset).toHaveBeenCalledTimes(1)
    expect(f.executeIdempotent.mock.calls[0]?.[2]).not.toHaveProperty('audio_ref')
    const sends = f.remote.requests.filter(request => request.action.startsWith('send_'))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.params.message).toEqual([{ type: 'record', data: { file: 'base64://' + f.bytes.toString('base64') } }])
  })
  it('retains unknown sending outcome and does not replay it with the original request ID', async () => {
    const f = await fixture(true)
    await expect(f.sendAudio()).rejects.toMatchObject({ outcome: 'unknown' })
    await vi.waitFor(() => expect(f.plugin.getStatus().state).toBe('connected'), { timeout: 5000 })
    await expect(f.sendAudio()).rejects.toMatchObject({ outcome: 'unknown' })
    expect(f.remote.requests.filter(x => x.action === 'send_private_msg')).toHaveLength(1)
  })
})
