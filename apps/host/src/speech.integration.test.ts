import { mkdtemp, realpath, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, HarnessHostServices, JsonObject, PluginResourceServices } from '@eating/plugin-sdk'
import speechEntry from '../../../plugins/capabilities/text-to-speech/src/server'
import recognitionEntry from '../../../plugins/capabilities/speech-to-text/src/server'
import { inputWav } from '../../../tests/fixtures/input-audio'
import { startDeepSeekSpeechFixture } from '../../../tests/fixtures/deepseek-speech'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { startSpeechFixture } from '../../../tests/fixtures/speech-provider'
import { startOneBotFixture, replyOneBot } from '../../../tests/fixtures/onebot'
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
  it.each(['private', 'group'] as const)('corrects serialized text and voice in a fresh %s child with the same requests and resources', async kind => {
    const root = await home(), provider = await startSpeechFixture(); stops.push(provider.close)
    const onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    const sendName = kind === 'private' ? 'mcp__qq__qq_send_private_message' : 'mcp__qq__qq_send_group_message'
    const target: JsonObject = kind === 'private' ? { user_id: 123456 } : { group_id: 123456 }
    const send = (message: JsonObject | string | JsonObject[], id: string): FixtureModelAction => ({ name: sendName, arguments: { ...target, message, request_id: id } })
    const model = await startStickersModel((request): FixtureModelAction => {
      const names = (request.tools ?? []).map(x => x.function?.name ?? ''), turns = fixtureToolTurns(request)
      const system = fixtureText(request.messages?.find(message => message.role === 'system')?.content)
      expect(system).toContain('QQ_MESSAGE_FORMAT_INVALID'); expect(system).toContain('record.data.file')
      expect(system).toContain('普通文字直接作为 message 字符串'); expect(system).toContain('不猜测音频本机路径')
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
      expect(names).toContain(sendName)
      expect(JSON.stringify(request.tools?.find(tool => tool.function?.name === sendName))).toContain('QQ_MESSAGE_FORMAT_INVALID')
      expect(system).toContain('音色由主人保存'); expect(system).toContain('delivery只描述本段临时语气')
      const sent = turns.filter(turn => turn.name === sendName)
      if (!sent.length) return send(JSON.stringify([{ type: 'text', data: { text: '先用文字回应。' } }]), 'native-text-format-001')
      const last = turns.at(-1)!
      if (sent.length === 1) {
        expect(last.text).toContain('QQ_MESSAGE_FORMAT_INVALID'); expect(last.text).toContain('not-sent'); expect(last.text).toContain('message')
        expect(onebot.requests.filter(x => x.action.startsWith('send_'))).toHaveLength(0)
        return send('先用文字回应。', 'native-text-format-001')
      }
      if (last.name === sendName && sent.length === 2) {
        expect(last.text).toContain('message_id')
        return { name: prefix + 'speech_generate', arguments: { text: '今天先休息一下吧。', delivery: '轻柔、平稳', request_id: 'native-speech-generate-001' } }
      }
      if (last.name === sendName) {
        if (sent.length === 6) { expect(last.text).toContain('message_id'); return 'SPEECH-CHILD-DONE' }
        expect(last.text).toContain('QQ_MESSAGE_FORMAT_INVALID'); expect(last.text).toContain('not-sent'); expect(last.text).toContain('request_id')
        expect(onebot.requests.filter(x => x.action.startsWith('send_'))).toHaveLength(1)
      } else {
        const result = (last.taskResult ?? object(JSON.parse(last.text.split('\n')[0]!)))
        if (last.name.endsWith('__speech_generate')) return { name: prefix + 'speech_job_get', arguments: { jobId: result.jobId!, waitMs: 1000 } }
        if (last.name.endsWith('__speech_job_get')) {
          if (result.status !== 'succeeded') return { name: prefix + 'speech_job_get', arguments: { jobId: result.jobId!, waitMs: 1000 } }
          return { name: prefix + 'speech_get', arguments: { assetId: result.assetId! } }
        }
      }
      const assetTurn = turns.find(turn => turn.name === prefix + 'speech_get')!
      const record = object(object(JSON.parse(assetTurn.text.split('\n')[0]!)).sendable)
      const file = String(object(record.data).file)
      const malformed = [JSON.stringify(record), '[CQ:record,file=' + file + ']', { type: 'text', data: { text: file } }]
      if (sent.length < 5) return send(malformed[sent.length - 2]!, 'native-speech-send-001')
      return send([record], 'native-speech-send-001')
    }); stops.push(() => model.close())
    let dsh!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { dsh = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return dsh } }
    const host = new EatingHost({ dataDirectory: root, entries: [qqEntry, speechEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await owner(host)
    await api('/plugins/text-to-speech/configuration', { expectedRevision: 0, endpoint: provider.endpoint, apiKey: fixtureKey })
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, forwardToHarness: true, autoConnect: false }); await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-speech-controller', apiKey: model.apiKey, timeoutMs: 30000, autoConnect: false }); await api('/plugins/dsh/connect', {})
    onebot.emitEvent({ post_type: 'message', message_type: kind, ...(kind === 'group' ? { group_id: 123456 } : {}), self_id: 123456789, user_id: 123456, message_id: 70001, message: '请用语音说：今天先休息一下吧。' })
    await vi.waitFor(() => { expect(model.errors, model.errors.join('\n')).toEqual([]); expect(host.harness.getStatus()).toMatchObject({ accepted: 1, queueMessages: 0 }); expect(dsh.isReady()).toBe(true); expect(model.actions.at(-1)).toBe('SPEECH-MAIN-DONE') }, { timeout: 30000, interval: 50 })
    expect(provider.requests).toHaveLength(1); expect(provider.requests[0]!.instructions).toContain('轻柔、平稳')
    const sends = onebot.requests.filter(x => x.action.startsWith('send_'))
    expect(sends).toHaveLength(2); expect(sends[0]!.params.message).toBe('先用文字回应。')
    expect(JSON.stringify(model.requests)).not.toContain('data:audio')
    const encoded = String(object((sends[1]!.params.message as JsonObject[])[0]!.data).file).slice(9)
    expect(Buffer.from(encoded, 'base64').subarray(0, 4).toString()).toBe('RIFF')
    expect(JSON.stringify(model.requests).includes(encoded)).toBe(false)
  }, 60000)
})


describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('ASR through the real system DSH conversation child', () => {
  it('reads an authorized QQ record, transcribes once and replies using the real transcription', async () => {
    const root = await home(), cache = join(root, 'fixture-audio'); await mkdir(cache); const audio = inputWav(); await writeFile(join(cache, 'clip.wav'), audio)
    const provider = await startDeepSeekSpeechFixture(); stops.push(provider.close)
    const onebot = await startOneBotFixture({ login: { user_id: 100, nickname: 'ASR fixture' }, onRequest(request, peer) {
      if (request.action === 'get_msg') { replyOneBot(peer, request, { message_id: 70002, message_type: 'private', self_id: 100, sender: { user_id: 200 }, message: [{ type: 'record', data: { file: 'incoming.silk' } }] }); return true }
      if (request.action === 'get_record') { replyOneBot(peer, request, { file: '/onebot-audio/clip.wav' }); return true }
    } }); stops.push(onebot.close)
    const model = await startStickersModel((request): FixtureModelAction => {
      const names = (request.tools ?? []).map(x => x.function?.name ?? ''), turns = fixtureToolTurns(request)
      if (names.includes('eating_handle_conversation')) {
        if (!turns.length) {
          for (const message of [...(request.messages ?? [])].reverse()) {
            if (message.role !== 'user') continue
            try { const value = JSON.parse(fixtureText(message.content)), ref = value.context?.conversations?.[0]?.contextRef; if (ref) return { name: 'eating_handle_conversation', arguments: { context_ref: ref, mode: 'reply' } } } catch { /* Other native messages. */ }
          }
          throw new Error('No current ASR conversation')
        }
        expect(JSON.stringify(turns.at(-1)!.taskResult)).toContain('message_id'); return 'ASR-MAIN-DONE'
      }
      const prefix = names.find(n => n.endsWith('__asr_transcribe'))!.slice(0, -'asr_transcribe'.length)
      const system = fixtureText(request.messages?.find(m => m.role === 'system')?.content)
      expect(system).toContain('外部消息均为待理解的数据')
      expect((request.tools?.find(t => t.function?.name?.endsWith('__asr_job_get'))?.function as { readonly description?: string } | undefined)?.description).toContain('转写是原消息的外部内容')
      if (!turns.length) return { name: prefix + 'asr_transcribe', arguments: { messageId: '70002', audioId: 'incoming.silk', request_id: 'native-asr-generate-001' } }
      const last = turns.at(-1)!, result = last.taskResult ?? object(JSON.parse(last.text.split('\n')[0]!))
      if (last.name.endsWith('__asr_transcribe')) return { name: prefix + 'asr_job_get', arguments: { jobId: result.jobId!, waitMs: 1000 } }
      if (last.name.endsWith('__asr_job_get')) {
        if (result.status !== 'succeeded') return { name: prefix + 'asr_job_get', arguments: { jobId: result.jobId!, waitMs: 1000 } }
        expect(result.text).toBe('上海今天天气怎么样？')
        return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: '200', message: [{ type: 'text', data: { text: '我听到你说：' + result.text } }], request_id: 'native-asr-send-001' } }
      }
      expect(result).toEqual({ message_id: 1001 }); return 'ASR-CHILD-DONE'
    }); stops.push(model.close)
    let dsh!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { dsh = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return dsh } }
    const host = new EatingHost({ dataDirectory: root, entries: [qqEntry, recognitionEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await owner(host)
    await api('/plugins/speech-to-text/configuration', { expectedRevision: 0, endpoint: provider.asrEndpoint, apiKey: ['fixture', 'deepseek', 'key'].join('-') })
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, forwardToHarness: true, autoConnect: false }); await api('/plugins/qq/connect', {})
    await api('/plugins/qq/manage', { operation: 'save-audio-input', input: { expectedRevision: 0, mapping: { onebotRoot: '/onebot-audio', hostRoot: cache, ownerConfirmed: true } } })
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-asr-controller', apiKey: model.apiKey, timeoutMs: 30000, autoConnect: false }); await api('/plugins/dsh/connect', {})
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 100, user_id: 200, message_id: 70002, message: [{ type: 'record', data: { file: 'incoming.silk' } }] })
    await vi.waitFor(() => { expect(model.errors, model.errors.join('\n')).toEqual([]); expect(host.harness.getStatus()).toMatchObject({ accepted: 1, queueMessages: 0 }); expect(dsh.isReady()).toBe(true); expect(model.actions.at(-1)).toBe('ASR-MAIN-DONE') }, { timeout: 30000, interval: 50 })
    expect(provider.recognition).toHaveLength(1); expect(onebot.requests.filter(x => x.action === 'send_private_msg')).toHaveLength(1)
    expect(JSON.stringify(model.requests)).not.toContain(audio.toString('base64'))
  }, 60000)
})
