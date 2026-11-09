import { DEFAULT_IMAGE_LIMITS } from '@eating/plugin-sdk'
import { mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedAudioBytes, PlatformError } from '@eating/plugin-sdk'
import type { HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { startSpeechFixture } from '../../../../../tests/fixtures/speech-provider'
import type { SpeechFixtureMode } from '../../../../../tests/fixtures/speech-provider'
import { SpeechPlugin } from '../server'
import { hash, SpeechConfig } from './config'
import { normalizeSpeechText, wav } from './provider'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(mode: SpeechFixtureMode = 'success', failReceipt = false) {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(parent, 'eating-speech-test-')))
  cleanups.push(() => { if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-speech-test-')) throw new Error('Unsafe speech cleanup'); rmSync(directory, { recursive: true }) })
  const provider = await startSpeechFixture(mode); cleanups.push(provider.close)
  const records = new Map<string, { fingerprint: string; result: JsonValue }>()
  const context: HostPluginContext = { imageLimits: () => DEFAULT_IMAGE_LIMITS, dataDirectory: directory, getSetting: () => null, setSetting: () => {}, listMessages: () => [], recordEvent: () => ({ inserted: false, eventId: 'fixture' }), executeIdempotent: async (_plugin, _action, params, id, execute) => {
    const fingerprint = JSON.stringify(params), existing = records.get(id)
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('Request conflict'); return existing.result }
    const result = await execute(); if (failReceipt) throw new PlatformError('STORE_FAILURE', 'Fixture receipt failed', 500, 'unknown')
    records.set(id, { fingerprint, result }); return result
  } }
  const plugin = new SpeechPlugin(context); cleanups.push(() => plugin.dispose())
  await plugin.updateConfiguration({ expectedRevision: 0, endpoint: provider.endpoint, apiKey: 'fixture-speech-key', voice: 'marin' })
  const input = { text: '今天先休息一下吧。', delivery: '轻柔一点，正常语速', request_id: 'speech-test-request-001' }
  const submit = () => plugin.invokeCapability('speech_generate', input, input.request_id, { agentId: 'child', agentTypeId: 'qq.private' }) as Promise<JsonObject>
  const final = async (id: JsonValue) => {
    await vi.waitFor(async () => expect(['succeeded', 'failed', 'unknown']).toContain((await plugin.manage('job', { jobId: id }) as JsonObject).status), { timeout: 10000, interval: 20 })
    return await plugin.manage('job', { jobId: id }) as JsonObject
  }
  return { directory, provider, plugin, context, input, submit, final }
}
describe('OpenAI cloud speech plugin', () => {
  it('synthesizes once with owner voice and per-call delivery, exposes only a sendable reference to the Agent', async () => {
    const f = await fixture(), accepted = await f.submit(), job = await f.final(accepted.jobId!)
    expect(job).toMatchObject({ status: 'succeeded', voice: 'marin', durationMs: 100 })
    expect(f.provider.requests).toHaveLength(1)
    const response = f.provider.requests[0]!
    expect(response).toMatchObject({ conversation: 'none', tools: [], tool_choice: 'none', output_modalities: ['audio'] })
    expect(response.instructions).toContain(f.input.delivery)
    expect(f.provider.sessions[0]).toMatchObject({ audio: { output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } } } })
    const result = await f.plugin.invoke('speech_get', { assetId: job.assetId }, 'read') as JsonObject
    expect(result.sendable).toEqual({ type: 'record', data: { file: `eating-audio://text-to-speech/${job.assetId}` } })
    expect(JSON.stringify(result)).not.toContain('base64')
    const preview = await f.plugin.manage('preview', { assetId: job.assetId }) as JsonObject
    expect(checkedAudioBytes(Buffer.from(String(preview.data), 'base64'), preview.mimeType).byteLength).toBe(4844)
    expect(await f.submit()).toEqual(job); expect(f.provider.requests).toHaveLength(1)
    await vi.waitFor(() => expect(f.provider.active()).toBe(0))
    expect(f.plugin.getPublicConfiguration()).not.toHaveProperty('apiKey')
    await expect(f.plugin.invoke('speech_generate', { ...f.input, delivery: '不同语气' }, f.input.request_id)).rejects.toMatchObject({ code: 'SPEECH_REQUEST_CONFLICT' })
  })
  it.each([['mismatch', 'SPEECH_TEXT_MISMATCH', 'failed'], ['close', 'SPEECH_CONNECTION_CLOSED', 'unknown'], ['oversize', 'SPEECH_AUDIO_TOO_LONG', 'failed'], ['auth', 'SPEECH_AUTH_FAILED', 'failed'], ['bad-voice', 'SPEECH_PROTOCOL_INVALID', 'failed']] as const)('does not retry %s or release an audio asset', async (mode, errorCode, status) => {
    const f = await fixture(mode), job = await f.final((await f.submit()).jobId!)
    expect(job).toMatchObject({ status, errorCode, assetId: null })
    expect(await f.submit()).toEqual(job); expect(f.provider.connections()).toBe(1)
    expect(JSON.stringify(job)).not.toContain('fixture-speech-key')
  })
  it('cancels on disconnect, preserves unknown status, and never resumes an interrupted generation', async () => {
    const f = await fixture('hold'), queued = await f.submit()
    await vi.waitFor(() => expect(f.provider.requests).toHaveLength(1))
    await f.plugin.disconnect()
    expect(await f.plugin.manage('job', { jobId: queued.jobId })).toMatchObject({ status: 'unknown', errorCode: 'SPEECH_CANCELLED' })
    const reopened = new SpeechPlugin(f.context); cleanups.push(() => reopened.dispose())
    expect(await reopened.invoke('speech_generate', f.input, f.input.request_id)).toMatchObject({ status: 'unknown' })
    expect(f.provider.requests).toHaveLength(1)
  })
  it('does not call OpenAI before a durable Host receipt or when scope was already revoked', async () => {
    const f = await fixture('success', true)
    await expect(f.submit()).rejects.toMatchObject({ outcome: 'unknown' })
    expect(f.provider.connections()).toBe(0)
    const next = await fixture(), abort = new AbortController(); abort.abort()
    await expect(next.plugin.invokeCapability('speech_generate', next.input, next.input.request_id, { agentId: 'child', agentTypeId: 'qq.private', signal: abort.signal })).rejects.toMatchObject({ code: 'SPEECH_CANCELLED' })
    expect(next.provider.connections()).toBe(0)
  })
  it('detects audio tampering and supports explicit owner deletion without a paid resubmission', async () => {
    const f = await fixture(), job = await f.final((await f.submit()).jobId!), path = join(f.directory, 'audio', String(job.assetId))
    const bytes = readFileSync(path); bytes[44] = bytes[44]! ^ 1; writeFileSync(path, bytes)
    await expect(f.plugin.audio.getAsset(String(job.assetId))).rejects.toMatchObject({ code: 'SPEECH_STORAGE_FAILED' })
    await f.plugin.manage('delete', { jobId: job.jobId, confirmed: true })
    await expect(f.submit()).rejects.toMatchObject({ code: 'SPEECH_NOT_FOUND' })
    expect(f.provider.requests).toHaveLength(1)
  })
  it('keeps key on blank saves, uses CAS, rejects unsupported stored schema and preserves its original bytes', async () => {
    const f = await fixture(), config = new SpeechConfig(f.directory)
    config.update({ expectedRevision: 1, apiKey: '', voice: 'coral' }); expect(config.snapshot().apiKey).toBe('fixture-speech-key')
    expect(() => config.update({ expectedRevision: 1, voice: 'alloy' })).toThrow(expect.objectContaining({ code: 'SPEECH_CONFIGURATION_CONFLICT' }))
    expect(() => config.update({ expectedRevision: 2, delivery: 'global tone is not configurable' })).toThrow()
    const path = join(f.directory, 'config.json'), original = '{"schemaVersion":0}'; writeFileSync(path, original)
    expect(() => new SpeechConfig(f.directory)).toThrow(expect.objectContaining({ code: 'SPEECH_CONFIGURATION_CORRUPTED' }))
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
  it('validates actual canonical WAV format and only normalizes punctuation and whitespace for transcript checks', () => {
    const bytes = wav(Buffer.alloc(4800)); expect(hash(bytes)).toMatch(/^[a-f0-9]{64}$/)
    expect(normalizeSpeechText('你好，世界！')).toBe(normalizeSpeechText('你好世界'))
    expect(normalizeSpeechText('12')).not.toBe(normalizeSpeechText('一二'))
    expect(normalizeSpeechText('1-2')).not.toBe(normalizeSpeechText('12'))
    expect(normalizeSpeechText('1.2')).not.toBe(normalizeSpeechText('12'))
    bytes.writeUInt16LE(2, 22); expect(() => checkedAudioBytes(bytes, 'audio/wav')).toThrow()
  })
  it('counts orphaned audio against disk capacity and refuses it before any paid request', async () => {
    const f = await fixture(), path = join(f.directory, 'audio', 'retained-orphan')
    writeFileSync(path, 'fixture'); truncateSync(path, 128 * 1024 * 1024)
    await expect(f.submit()).rejects.toMatchObject({ code: 'SPEECH_CAPACITY', outcome: 'not-sent' })
    expect(f.provider.connections()).toBe(0)
  })
})
