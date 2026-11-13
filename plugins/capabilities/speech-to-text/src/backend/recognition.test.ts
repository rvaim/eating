import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE_LIMITS, PlatformError } from '@eating/plugin-sdk'
import type { CapabilityInvocationScope, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { RecognitionPlugin } from '../server'
import { hash } from './config'
import { inputWav } from '../../../../../tests/fixtures/input-audio'
import { startDeepSeekSpeechFixture } from '../../../../../tests/fixtures/deepseek-speech'
import type { DeepSeekSpeechMode } from '../../../../../tests/fixtures/deepseek-speech'
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function fixture(mode: DeepSeekSpeechMode = 'success', failReceipt = false) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-asr-test-'))); stops.push(() => rmSync(root, { recursive: true }))
  const provider = await startDeepSeekSpeechFixture(mode); stops.push(provider.close)
  const bytes = inputWav(), records = new Map<string, JsonValue>(); let reads = 0
  const context: HostPluginContext = { dataDirectory: root, imageLimits: () => DEFAULT_IMAGE_LIMITS, getSetting: () => null, setSetting: () => {}, listMessages: () => [], recordEvent: () => ({ inserted: false, eventId: 'fixture' }), executeIdempotent: async (_p, _a, _v, id, execute) => { if (records.has(id)) return records.get(id)!; const result = await execute(); if (failReceipt) throw new PlatformError('STORE_ERROR', 'Fixture failure', 500, 'unknown'); records.set(id, result); return result },
    resources: { readReceivedAudio: async () => { reads++; return { mimeType: 'audio/wav', byteLength: bytes.length, durationMs: 100, sha256: hash(bytes), readBytes: async () => bytes, assertCurrent: () => {} } }, readReceivedImage: async () => { throw new Error('No image') }, readAsset: async () => { throw new Error('No image') }, getAsset: async () => { throw new Error('No image') }, getAudioAsset: async () => { throw new Error('No output') } } }
  const plugin = new RecognitionPlugin(context); stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ expectedRevision: 0, endpoint: provider.asrEndpoint, apiKey: 'fixture-deepseek-key' })
  const scope: CapabilityInvocationScope = { agentId: 'child', agentTypeId: 'qq.private', source: { agentId: 'child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: 'fixture-instance', accountId: '100', conversationId: 'qq:100:private:200', kind: 'private', targetId: '200', messageIds: ['300'], resourceIds: ['audio-a'] } }
  const input = { messageId: '300', audioId: 'audio-a', request_id: 'asr-test-request-001' }
  const submit = () => plugin.invokeCapability('asr_transcribe', input, input.request_id, scope) as Promise<JsonObject>
  const done = async (jobId: unknown) => { await vi.waitFor(async () => expect(['succeeded', 'failed', 'unknown']).toContain((await plugin.manage('job', { jobId }) as JsonObject).status)); return plugin.manage('job', { jobId }) as Promise<JsonObject> }
  return { root, provider, plugin, context, scope, input, submit, done, bytes, reads: () => reads }
}
describe('DeepSeek speech recognition', () => {
  it('uploads only file, deduplicates locally and returns the actual transcript within the original scope', async () => {
    const f = await fixture(), job = await f.done((await f.submit()).jobId)
    expect(job).toMatchObject({ status: 'succeeded', text: '上海今天天气怎么样？', providerRequestId: 'fixture-deepseek-receipt', durationMs: 100 })
    expect(f.provider.recognition).toHaveLength(1); expect(f.provider.recognition[0]!.fields).toEqual(['file']); expect(Buffer.from(f.provider.recognition[0]!.bytes).equals(f.bytes)).toBe(true)
    expect(await f.submit()).toEqual(job); expect(f.reads()).toBe(1)
    expect(await f.plugin.invokeCapability('asr_job_get', { jobId: job.jobId }, 'read', f.scope)).toEqual(job)
    const other = { ...f.scope, source: { ...f.scope.source!, targetId: '201', conversationId: 'qq:100:private:201' } }
    await expect(f.plugin.invokeCapability('asr_job_get', { jobId: job.jobId }, 'read', other)).rejects.toMatchObject({ code: 'ASR_ACCESS_DENIED' })
    expect(await f.plugin.invokeCapability('asr_jobs', {}, 'list', other)).toMatchObject({ total: 0 })
    expect(readFileSync(join(f.root, 'index.json'), 'utf8')).not.toContain(f.bytes.toString('base64'))
    await f.plugin.manage('delete', { jobId: job.jobId, confirmed: true }); await expect(f.submit()).rejects.toMatchObject({ code: 'ASR_NOT_FOUND' }); expect(f.provider.recognition).toHaveLength(1)
  })
  it('does not upload on a failed durable receipt, revoked scope, mismatched reference or missing owner confirmation', async () => {
    const f = await fixture('success', true); await expect(f.submit()).rejects.toMatchObject({ outcome: 'unknown' }); expect(f.provider.recognition).toHaveLength(0)
    const next = await fixture(), aborted = new AbortController(); aborted.abort()
    await expect(next.plugin.invokeCapability('asr_transcribe', next.input, next.input.request_id, { ...next.scope, signal: aborted.signal })).rejects.toMatchObject({ code: 'ASR_CANCELLED' })
    await expect(next.plugin.invokeCapability('asr_transcribe', { ...next.input, audioId: 'other' }, next.input.request_id, next.scope)).rejects.toMatchObject({ code: 'ASR_ACCESS_DENIED' })
    await expect(next.plugin.manage('transcribe', { data: next.bytes.toString('base64'), request_id: 'owner-upload-001', confirmed: false })).rejects.toMatchObject({ code: 'ASR_CONFIRMATION_REQUIRED' }); expect(next.provider.recognition).toHaveLength(0)
  })
  it.each([['close', 'unknown'], ['reject', 'failed'], ['malformed', 'unknown']] as const)('keeps %s result without replay or invented text', async (mode, status) => {
    const f = await fixture(mode), job = await f.done((await f.submit()).jobId); expect(job).toMatchObject({ status, text: null }); expect(await f.submit()).toEqual(job); expect(f.provider.recognition).toHaveLength(1)
  })
  it('supports explicit owner uploads and keeps owner transcripts out of conversation tool results', async () => {
    const f = await fixture(), queued = await f.plugin.manage('transcribe', { data: f.bytes.toString('base64'), request_id: 'owner-upload-001', confirmed: true }) as JsonObject, job = await f.done(queued.jobId)
    expect(job).toMatchObject({ status: 'succeeded', owner: null, source: { kind: 'upload' } }); expect(await f.plugin.invokeCapability('asr_jobs', {}, 'list', f.scope)).toMatchObject({ total: 0 })
  })
  it('preserves interrupted tasks as unknown across restart and does not resume upload', async () => {
    const f = await fixture('hold'), accepted = await f.submit(); await vi.waitFor(() => expect(f.provider.recognition).toHaveLength(1)); await f.plugin.disconnect()
    const reopened = new RecognitionPlugin(f.context); stops.push(() => reopened.dispose()); expect(await reopened.invokeCapability('asr_transcribe', f.input, f.input.request_id, f.scope)).toMatchObject({ jobId: accepted.jobId, status: 'unknown' }); expect(f.provider.recognition).toHaveLength(1)
  })
  it('bounds list previews while retaining the complete transcript for explicit reads', async () => {
    const f = await fixture('long'), job = await f.done((await f.submit()).jobId), list = await f.plugin.manage('jobs', {}) as { items: Array<{ textPreview: string; textTruncated: boolean; text?: string }> }
    expect(job.text).toHaveLength(32000); expect(list.items[0]).toMatchObject({ textPreview: '长'.repeat(160), textTruncated: true }); expect(list.items[0]).not.toHaveProperty('text')
  })

})
