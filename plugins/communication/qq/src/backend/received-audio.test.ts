import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, JsonObject } from '@eating/plugin-sdk'
import { PlatformError } from '@eating/plugin-sdk'
import { inputWav } from '../../../../../tests/fixtures/input-audio'
import { readQQAudio } from './received-audio'
import { QQAudioInputConfig } from './audio-input-config'
const scope: AgentInvocationScope = { agentId: 'child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: 'instance', accountId: '100', conversationId: 'qq:100:private:200', kind: 'private', targetId: '200', messageIds: ['300'], resourceIds: ['clip.silk'] }
const reference = { messageId: '300', audioId: 'clip.silk' }
function fixture() {
  const message: JsonObject = { message_id: 300, message_type: 'private', self_id: 100, sender: { user_id: 200 }, message: [{ type: 'record', data: { file: 'clip.silk' } }] }, bytes = inputWav(), download = vi.fn(async () => bytes), call = vi.fn(async (action: string) => action === 'get_msg' ? message : { file: '/onebot/audio/clip.wav', url: 'https://audio.fixture.invalid/clip.wav' })
  return { message, bytes, download, call, assertActive: () => {} }
}
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).reverse().forEach(f => f()))
describe('scoped received QQ audio', () => {
  it('verifies the actual message, requests WAV conversion and releases bounded bytes', async () => {
    const f = fixture(), asset = await readQQAudio(reference, scope, f)
    expect(f.call.mock.calls).toEqual([['get_msg', { message_id: 300 }], ['get_record', { file: 'clip.silk', out_format: 'wav' }]])
    expect(asset).toMatchObject({ mimeType: 'audio/wav', durationMs: 100, byteLength: 4844 }); expect(Buffer.from(await asset.readBytes()).equals(f.bytes)).toBe(true)
  })
  it.each(['other-message', 'other-reference', 'other-sender', 'other-account', 'other-kind'])('rejects %s before converting or downloading', async mode => {
    const f = fixture(), ref = { ...reference }
    if (mode === 'other-message') ref.messageId = '301'
    if (mode === 'other-reference') ref.audioId = 'other'
    if (mode === 'other-sender') f.message.sender = { user_id: 201 }
    if (mode === 'other-account') f.message.self_id = 101
    if (mode === 'other-kind') f.message.message_type = 'group'
    await expect(readQQAudio(ref, scope, f)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' }); expect(f.download).not.toHaveBeenCalled(); expect(f.call.mock.calls.some(c => c[0] === 'get_record')).toBe(false)
  })
  it('does not treat a remote path as local, and rechecks grants after conversion and after download', async () => {
    const f = fixture(); f.call.mockImplementation(async action => action === 'get_msg' ? f.message : { file: '/remote/clip.wav' })
    await expect(readQQAudio(reference, scope, f)).rejects.toMatchObject({ code: 'RECEIVED_AUDIO_UNAVAILABLE' })
    const next = fixture(); let revoked = false
    next.download.mockImplementation(async () => { revoked = true; return next.bytes })
    const assertActive = () => { if (revoked) throw new PlatformError('ASSET_ACCESS_DENIED', 'Fixture revoked', 403, 'not-sent') }
    await expect(readQQAudio(reference, scope, { ...next, assertActive })).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
  })
  it('reads only a confirmed matching cache mapping, rejecting traversal, symlinks and changed connection/revision', () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-audio-map-'))); stops.push(() => rmSync(root, { recursive: true }))
    const cache = join(root, 'cache'); mkdirSync(cache); writeFileSync(join(cache, 'clip.wav'), inputWav()); writeFileSync(join(root, 'outside.wav'), inputWav()); symlinkSync(join(root, 'outside.wav'), join(cache, 'escape.wav'))
    const config = new QQAudioInputConfig(root), connection = { endpoint: 'ws://127.0.0.1:12345', accountId: '100' }
    expect(config.snapshot(connection)).toMatchObject({ revision: 0, mapping: null })
    config.save({ expectedRevision: 0, mapping: { onebotRoot: '/onebot/audio', hostRoot: cache, ownerConfirmed: true } }, connection)
    expect(config.readMapped('/onebot/audio/clip.wav', connection, 1).byteLength).toBe(4844)
    for (const file of ['/onebot/audio/../outside.wav', '/other/clip.wav', '/onebot/audio/escape.wav']) expect(() => config.readMapped(file, connection, 1)).toThrow()
    expect(() => config.readMapped('/onebot/audio/clip.wav', { ...connection, accountId: '101' }, 1)).toThrow(); expect(() => config.readMapped('/onebot/audio/clip.wav', connection, 0)).toThrow()
    expect(() => config.save({ expectedRevision: 0, mapping: null }, connection)).toThrow(expect.objectContaining({ code: 'QQ_AUDIO_INPUT_CONFLICT' }))
  })
})
