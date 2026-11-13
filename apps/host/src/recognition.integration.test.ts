import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentInvocationScope, BackendPluginEntry, HarnessHostServices, JsonObject, PluginResourceServices } from '@eating/plugin-sdk'
import recognitionEntry from '../../../plugins/capabilities/speech-to-text/src/server'
import speechEntry from '../../../plugins/capabilities/text-to-speech/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { startDeepSeekSpeechFixture } from '../../../tests/fixtures/deepseek-speech'
import { startOneBotFixture, replyOneBot } from '../../../tests/fixtures/onebot'
import { inputWav } from '../../../tests/fixtures/input-audio'
import { EatingHost } from './app'
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function setup() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'eating-asr-host-'))); stops.push(() => rm(root, { recursive: true }))
  const cache = join(root, 'audio-cache'); await mkdir(cache); await writeFile(join(cache, 'clip.wav'), inputWav())
  const provider = await startDeepSeekSpeechFixture(); stops.push(provider.close)
  const onebot = await startOneBotFixture({ login: { user_id: 100, nickname: 'Audio fixture' }, onRequest(request, peer) {
    if (request.action === 'get_msg') { replyOneBot(peer, request, { message_id: request.params.message_id!, message_type: 'private', self_id: 100, sender: { user_id: 200 }, message: [{ type: 'record', data: { file: 'clip.silk' } }] }); return true }
    if (request.action === 'get_record') { replyOneBot(peer, request, { file: '/onebot-audio/clip.wav' }); return true }
  } }); stops.push(onebot.close)
  let services!: HarnessHostServices, resources!: PluginResourceServices, stopped = 0, connected = 0, state: 'connected' | 'disconnected' = 'connected'
  const recognition: BackendPluginEntry = { ...recognitionEntry, create(context) { resources = context.resources!; return recognitionEntry.create(context) } }
  const harness: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { services = context.harness!; return { id: 'fixture', kind: 'harness', name: 'Fixture', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => { connected++; state = 'connected' }, disconnect: async () => { stopped++; state = 'disconnected' }, invoke: async () => null, dispose: async () => {} } } }
  const host = new EatingHost({ dataDirectory: root, entries: [qqEntry, recognition, speechEntry, harness], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
  const url = await host.listen(), bootResponse = await fetch(url + '/api/bootstrap'), boot = await bootResponse.json(), cookie = bootResponse.headers.get('set-cookie')!.split(';')[0]!
  const api = async (path: string, body?: object) => { const r = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-Csrf': boot.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await r.json(); if (!r.ok) throw new Error(JSON.stringify(value)); return value }
  const config = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false }); await api('/plugins/qq/connect', {})
  await api('/plugins/speech-to-text/configuration', { expectedRevision: 0, endpoint: provider.asrEndpoint, apiKey: 'fixture-deepseek-key' })
  await api('/plugins/qq/manage', { operation: 'save-audio-input', input: { expectedRevision: 0, mapping: { onebotRoot: '/onebot-audio', hostRoot: cache, ownerConfirmed: true } } })
  const source: AgentInvocationScope = { agentId: 'audio-child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: config.instanceId, accountId: '100', conversationId: 'qq:100:private:200', kind: 'private', targetId: '200', messageIds: ['300'], resourceIds: ['clip.silk'] }
  const client = async () => {
    services.getMcpConnection('qq', source)
    const connection = services.getCapabilityMcpConnections({ agentId: source.agentId, agentTypeId: source.agentTypeId, source }).find(c => c.id === 'plugin.speech-to-text')!
    const client = new Client({ name: 'audio-fixture', version: '1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } })); stops.push(() => client.close()); return client
  }
  return { host, root, api, provider, onebot, source, resources, services, client, mounts: () => ({ stopped, connected }) }
}
describe('ASR over Host resource leases, real MCP transport and OneBot', () => {
  it('reads a scoped converted cache file, transcribes once and revokes its incoming lease with the Agent', async () => {
    const f = await setup()
    await expect(f.resources.readReceivedAudio({ agentId: f.source.agentId, agentTypeId: f.source.agentTypeId, source: f.source }, { messageId: '300', audioId: 'clip.silk' })).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    const client = await f.client(), params = { messageId: '300', audioId: 'clip.silk', request_id: 'host-asr-request-001' }
    const accepted = await client.callTool({ name: 'asr_transcribe', arguments: params }), job = (accepted.structuredContent as { result: JsonObject }).result
    expect(accepted.isError).not.toBe(true); expect(job.jobId).toBeTypeOf('string')
    const result = await client.callTool({ name: 'asr_job_get', arguments: { jobId: job.jobId, waitMs: 2000 } })
    expect((result.structuredContent as { result: unknown }).result).toMatchObject({ status: 'succeeded', text: '上海今天天气怎么样？' }); await client.callTool({ name: 'asr_transcribe', arguments: params }); expect(f.provider.recognition).toHaveLength(1)
    const lease = await f.resources.readReceivedAudio({ agentId: f.source.agentId, agentTypeId: f.source.agentTypeId, source: f.source }, { messageId: '300', audioId: 'clip.silk' }); expect(lease.durationMs).toBe(100)
    f.services.extendAgentScope({ ...f.source, messageIds: ['300', '301'], resourceIds: ['clip.silk', 'new-clip.silk'] }); expect((await lease.readBytes()).byteLength).toBe(4844)
    const retained = await f.resources.readReceivedAudio({ agentId: f.source.agentId, agentTypeId: f.source.agentTypeId, source: f.source }, { messageId: '300', audioId: 'clip.silk' }); expect(retained.durationMs).toBe(100)
    f.services.getCapabilityMcpConnections({ agentId: f.source.agentId, agentTypeId: f.source.agentTypeId, source: { ...f.source, messageIds: ['301'], resourceIds: ['new-clip.silk'] } }); await expect(lease.readBytes()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    f.services.revokeAgentAccess(f.source.agentId); await expect(lease.readBytes()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    expect(f.onebot.requests.filter(r => r.action === 'get_record').every(r => r.params.out_format === 'wav')).toBe(true)
  })
  it('remounts tools on a synthesis protocol change and never keeps an unsupported delivery field', async () => {
    const f = await setup(), before = f.mounts()
    await f.api('/plugins/text-to-speech/configuration', { expectedRevision: 0, endpoint: f.provider.ttsEndpoint, provider: { protocol: 'deepseek-tts', voice: 'stella', filterMarkdown: true }, apiKey: 'fixture-deepseek-key' })
    expect(f.mounts()).toEqual({ stopped: before.stopped + 1, connected: before.connected + 1 })
    const connection = f.services.getCapabilityMcpConnections({ agentId: 'tts-child', agentTypeId: 'main' }).find(c => c.id === 'plugin.text-to-speech')!, client = new Client({ name: 'tts-catalog-fixture', version: '1.0.0' }); stops.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }))
    const catalog = await client.listTools(); expect(catalog.tools.find(t => t.name === 'speech_generate')!.inputSchema.properties).not.toHaveProperty('delivery'); expect(f.provider.synthesis).toHaveLength(0)
  })
  it('keeps audio uploads independent of a smaller image setting', async () => {
    const f = await setup(); await f.api('/image-limits', { expectedRevision: 0, maxImageMiB: 1 })
    const data = inputWav(30000).toString('base64'), result = await f.api('/plugins/speech-to-text/manage', { operation: 'transcribe', input: { data, request_id: 'large-owner-asr-001', confirmed: true } })
    expect(result.jobId).toBeTypeOf('string')
  })
})
