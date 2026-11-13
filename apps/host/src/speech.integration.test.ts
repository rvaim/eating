import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, HarnessHostServices, JsonObject, PluginResourceServices } from '@eating/plugin-sdk'
import speechEntry from '../../../plugins/capabilities/text-to-speech/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { startSpeechFixture } from '../../../tests/fixtures/speech-provider'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { fixtureToolTurns, fixtureText, startStickersModel } from '../../../tests/fixtures/stickers-model'
import type { FixtureModelAction } from '../../../tests/fixtures/stickers-model'
import { EatingHost } from './app'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
function object(v: unknown): JsonObject { if (!isJsonObject(v)) throw new Error('Expected speech object'); return v }
async function home() {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-speech-integration-')))
  stops.push(async () => { if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-speech-integration-')) throw new Error('Unsafe speech integration cleanup'); await rm(root, { recursive: true }) })
  return root
}
async function owner(host: EatingHost) {
  host.store.updateDeliverySettings({ ...host.store.getDeliverySettings(), aggregationWindowMs: 0 }, host.store.getDeliverySettingsSnapshot().revision)
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), boot = await bootstrap.json(), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  return async (path: string, body?: object) => {
    const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-Csrf': boot.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return object(value)
  }
}
const fixtureKey = ['fixture', 'speech', 'key'].join('-')
describe('speech resources over actual Host and OneBot', () => {
  it('enforces current source permissions and revokes a read lease before a stale send, keeping bytes out of the ledger', async () => {
    const root = await home(), provider = await startSpeechFixture(); stops.push(provider.close)
    const onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    let services!: HarnessHostServices, resources!: PluginResourceServices
    const caller: BackendPluginEntry = { ...qqEntry, create(context) { resources = context.resources!; return qqEntry.create(context) } }
    const harness: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { services = context.harness!; return { id: 'fixture', kind: 'harness', name: 'Fixture', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state: 'connected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, dispose: async () => {}, invoke: async () => null } } }
    const host = new EatingHost({ dataDirectory: root, entries: [speechEntry, caller, harness], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await owner(host)
    await api('/plugins/text-to-speech/configuration', { expectedRevision: 0, endpoint: provider.endpoint, apiKey: fixtureKey })
    const submitted = await api('/plugins/text-to-speech/manage', { operation: 'generate', input: { text: '回环语音测试', request_id: 'speech-host-generated-001', confirmed: true } })
    let done: JsonObject = submitted
    await vi.waitFor(async () => { done = await api('/plugins/text-to-speech/manage', { operation: 'job', input: { jobId: submitted.jobId } }); expect(done.status).toBe('succeeded') }, { timeout: 10000 })
    const scope = { agentId: 'speech-child', agentTypeId: 'main' }, reference = { pluginId: 'text-to-speech', assetId: String(done.assetId) }
    await expect(resources.getAudioAsset(reference, scope)).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    services.getCapabilityMcpConnections(scope)
    const lease = await resources.getAudioAsset(reference, scope)
    expect(lease.durationMs).toBe(100)
    services.revokeAgentAccess(scope.agentId)
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false }); await api('/plugins/qq/connect', {})
    const segment = { type: 'record', data: { file: `eating-audio://text-to-speech/${done.assetId}` } }
    const input = { name: 'qq_send_private_message', requestId: 'speech-host-send-0001', confirmed: true, arguments: { user_id: '987654321', message: [segment] } }
    await api('/plugins/qq/invoke', input); await api('/plugins/qq/invoke', input)
    const sent = onebot.requests.filter(x => x.action === 'send_private_msg')
    expect(sent).toHaveLength(1)
    const encoded = String(object((sent[0]!.params.message as JsonObject[])[0]!.data).file)
    expect(encoded.startsWith('base64://')).toBe(true)
    expect(Buffer.from(encoded.slice(9), 'base64').subarray(0, 4).toString()).toBe('RIFF')
    await host.close()
    expect((await readFile(join(root, 'host/Eating.sqlite'))).includes(Buffer.from(encoded))).toBe(false)
    expect(provider.requests).toHaveLength(1)
  })
})

describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('speech through the real system DSH conversation child', () => {
  it('synthesizes per-call delivery and sends exactly one record with the original scope and a real receipt', async () => {
    const root = await home(), provider = await startSpeechFixture(); stops.push(provider.close)
    const onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    const model = await startStickersModel((request): FixtureModelAction => {
      const names = (request.tools ?? []).map(x => x.function?.name ?? ''), turns = fixtureToolTurns(request)
      if (names.includes('eating_handle_conversation')) {
        if (!turns.length) {
          for (const message of [...(request.messages ?? [])].reverse()) {
            if (message.role !== 'user') continue
            try { const value = JSON.parse(fixtureText(message.content)); const ref = value.context?.conversations?.[0]?.contextRef; if (ref) return { name: 'eating_handle_conversation', arguments: { context_ref: ref, mode: 'reply' } } } catch { /* Other native messages. */ }
          }
          throw new Error('No current conversation')
        }
        expect(JSON.stringify(turns.at(-1)!.taskResult)).toContain('message_id'); return 'SPEECH-MAIN-DONE'
      }
      const prefix = names.find(name => name.endsWith('__speech_generate'))!.slice(0, -'speech_generate'.length)
      expect(names).toContain('mcp__qq__qq_send_private_message')
      const system = fixtureText(request.messages?.find(message => message.role === 'system')?.content)
      expect(system).toContain('音色由主人保存'); expect(system).toContain('delivery只描述本段临时语气')
      if (!turns.length) return { name: prefix + 'speech_generate', arguments: { text: '今天先休息一下吧。', delivery: '轻柔、平稳', request_id: 'native-speech-generate-001' } }
      const last = turns.at(-1)!, result = (last.taskResult ?? object(JSON.parse(last.text.split('\n')[0]!)))
      if (last.name.endsWith('__speech_generate')) return { name: prefix + 'speech_job_get', arguments: { jobId: result.jobId!, waitMs: 1000 } }
      if (last.name.endsWith('__speech_job_get')) {
        if (result.status !== 'succeeded') return { name: prefix + 'speech_job_get', arguments: { jobId: result.jobId!, waitMs: 1000 } }
        return { name: prefix + 'speech_get', arguments: { assetId: result.assetId! } }
      }
      if (last.name.endsWith('__speech_get')) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: '987654321', message: [result.sendable!], request_id: 'native-speech-send-001' } }
      expect(result).toEqual({ message_id: 1001 }); return 'SPEECH-CHILD-DONE'
    }); stops.push(() => model.close())
    let dsh!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { dsh = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return dsh } }
    const host = new EatingHost({ dataDirectory: root, entries: [qqEntry, speechEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await owner(host)
    await api('/plugins/text-to-speech/configuration', { expectedRevision: 0, endpoint: provider.endpoint, apiKey: fixtureKey })
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, forwardToHarness: true, autoConnect: false }); await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-speech-controller', apiKey: model.apiKey, timeoutMs: 30000, autoConnect: false }); await api('/plugins/dsh/connect', {})
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: 70001, message: '请用语音说：今天先休息一下吧。' })
    await vi.waitFor(() => { expect(model.errors).toEqual([]); expect(host.harness.getStatus()).toMatchObject({ accepted: 1, queueMessages: 0 }); expect(dsh.isReady()).toBe(true); expect(model.actions.at(-1)).toBe('SPEECH-MAIN-DONE') }, { timeout: 30000, interval: 50 })
    expect(provider.requests).toHaveLength(1); expect(provider.requests[0]!.instructions).toContain('轻柔、平稳')
    expect(onebot.requests.filter(x => x.action === 'send_private_msg')).toHaveLength(1)
    expect(JSON.stringify(model.requests)).not.toContain('data:audio')
    const sent = onebot.requests.find(x => x.action === 'send_private_msg')!
    const encoded = String(object((sent.params.message as JsonObject[])[0]!.data).file).slice(9)
    expect(JSON.stringify(model.requests).includes(encoded)).toBe(false)
  }, 60000)
})
