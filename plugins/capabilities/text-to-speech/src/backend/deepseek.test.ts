import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE_LIMITS } from '@eating/plugin-sdk'
import type { HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import { SpeechPlugin } from '../server'
import { SpeechConfig } from './config'
import { startDeepSeekSpeechFixture } from '../../../../../tests/fixtures/deepseek-speech'
import type { DeepSeekSpeechMode } from '../../../../../tests/fixtures/deepseek-speech'
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function fixture(mode: DeepSeekSpeechMode = 'success') {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-deepseek-tts-'))); stops.push(() => rmSync(root, { recursive: true }))
  const provider = await startDeepSeekSpeechFixture(mode); stops.push(provider.close)
  const records = new Map<string, unknown>()
  const context: HostPluginContext = { dataDirectory: root, imageLimits: () => DEFAULT_IMAGE_LIMITS, getSetting: () => null, setSetting: () => {}, listMessages: () => [], recordEvent: () => ({ inserted: false, eventId: 'fixture' }), executeIdempotent: async (_p, _a, _v, id, execute) => { if (records.has(id)) return records.get(id) as JsonObject; const result = await execute(); records.set(id, result); return result } }
  const plugin = new SpeechPlugin(context); stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ expectedRevision: 0, endpoint: provider.ttsEndpoint, provider: { protocol: 'deepseek-tts', voice: 'tide', filterMarkdown: false }, apiKey: 'fixture-deepseek-key' })
  const input = { text: '你好。', request_id: 'deepseek-tts-test-001' }
  const submit = () => plugin.invokeCapability('speech_generate', input, input.request_id, { agentId: 'child', agentTypeId: 'qq.private' }) as Promise<JsonObject>
  const done = async (jobId: unknown) => { await vi.waitFor(async () => expect(['succeeded', 'failed', 'unknown']).toContain((await plugin.manage('job', { jobId }) as JsonObject).status)); return plugin.manage('job', { jobId }) as Promise<JsonObject> }
  return { root, provider, plugin, context, input, submit, done }
}
describe('DeepSeek TTS protocol adapter', () => {
  it('uses exact protocol fields, requires successful finish and records completion evidence without inventing a transcript', async () => {
    const f = await fixture(); expect(f.provider.synthesis).toHaveLength(0)
    const tool = f.plugin.tools.find(t => t.name === 'speech_generate')!
    expect(tool.inputSchema.properties).not.toHaveProperty('delivery')
    const job = await f.done((await f.submit()).jobId)
    expect(job).toMatchObject({ status: 'succeeded', protocol: 'deepseek-tts', model: null, voice: 'tide', durationMs: 100, verification: 'provider-completion' })
    expect(f.provider.synthesis).toEqual([{ text: '你好。', parameters: { voice_id: 'tide', format: 'pcm', filter_markdown: 'false' } }])
    expect(await f.submit()).toEqual(job); expect(f.provider.synthesis).toHaveLength(1)
    const reopened = new SpeechPlugin(f.context); stops.push(() => reopened.dispose()); expect(await reopened.invoke('speech_generate', f.input, f.input.request_id)).toEqual(job)
    const preview = await f.plugin.manage('preview', { assetId: job.assetId }) as JsonObject; expect(Buffer.from(String(preview.data), 'base64').subarray(0, 4).toString()).toBe('RIFF')
  })
  it.each(['柔和', ''])('rejects unsupported delivery before creating or billing a task (%s)', async delivery => {
    const f = await fixture(); await expect(f.plugin.invoke('speech_generate', { ...f.input, delivery }, f.input.request_id)).rejects.toMatchObject({ code: 'SPEECH_UNSUPPORTED_OPTION', outcome: 'not-sent' })
    expect(f.provider.synthesis).toHaveLength(0); expect(await f.plugin.manage('jobs', {})).toMatchObject({ total: 0 })
  })
  it.each([['close', 'unknown'], ['reject', 'failed'], ['oversize', 'failed'], ['malformed', 'unknown']] as const)('does not expose partial audio or retry after %s', async (mode, status) => {
    const f = await fixture(mode), job = await f.done((await f.submit()).jobId)
    expect(job).toMatchObject({ status, assetId: null, verification: null }); await f.submit(); expect(f.provider.synthesis).toHaveLength(1)
  })
  it('clears credentials across service changes and rejects old config and task formats without rewriting data', async () => {
    const f = await fixture(), config = new SpeechConfig(f.root)
    config.update({ expectedRevision: 1, endpoint: 'wss://api.openai.com/v1/realtime', provider: { protocol: 'openai-realtime', model: 'model', voice: 'marin' } })
    expect(config.public(true)).toMatchObject({ apiKeyConfigured: false, ready: false })
    const path = join(f.root, 'config.json'), bytes = '{"schemaVersion":1}'
    writeFileSync(path, bytes); expect(() => new SpeechConfig(f.root)).toThrow(); expect(readFileSync(path, 'utf8')).toBe(bytes)
  })
})
