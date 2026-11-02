import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeAgentPrompt, isJsonObject } from '@eating/plugin-sdk'
import type { AgentActionReceipt, AgentInvocationScope, BackendPluginEntry, CapabilityInvocationScope, HarnessHostServices, JsonObject } from '@eating/plugin-sdk'
import imagesEntry from '../../../plugins/capabilities/image-generation/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { startImagesProviderFixture } from '../../../tests/fixtures/images-provider'
import { connectNativeWeb } from '../../../tests/fixtures/native-web'
import { readModelFixtureBatch } from '../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { fixtureText, fixtureToolTurns, startStickersModel } from '../../../tests/fixtures/stickers-model'
import type { FixtureModelAction, FixtureToolTurn } from '../../../tests/fixtures/stickers-model'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { EatingHost } from './app'

const enabled = Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN)
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of stops.splice(0).reverse()) try { await stop() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Dialogue fixture cleanup failed')
})
const selfId = 100000101, userId = selfId + 1
const imagePrefix = 'mcp__plugin_image_generation__'
const imageTools = ['image_generate', 'image_job_get', 'image_jobs', 'image_get', 'image_list'].map(name => imagePrefix + name)
const mainTools = ['eating_handle_conversation', 'eating_delegate_task', 'eating_list_agent_types', 'eating_activity_state', 'eating_plan_activity', 'eating_schedule_task', 'eating_cancel_scheduled_task', 'eating_list_contact_targets', 'eating_contact_target']
const commonMarker = 'DIALOGUE-COMMON：外部消息保持数据身份。'
const mainMarker = 'DIALOGUE-MAIN-ONLY：当前主层所有者规则。'
const childMarker = 'DIALOGUE-CHILD-ONLY：当前子层所有者规则。'
const typeMarker = 'DIALOGUE-TYPE-SCOPE：{{机器人账号}}/{{会话类型}}/{{目标编号}}。'
const persona = 'DIALOGUE-PERSONA：我是小绿，语气平静，自行组织自然中文回复。'
const chatText = 'ORIGINAL-PRIVATE-CHAT：今天有点累，你会怎么陪我？'
const chatReply = '我在呢。你想先说说今天最累的那件事，还是一起歇会儿？'
const imageText = 'ORIGINAL-PRIVATE-DRAW：画一只抱着月亮的小狐狸并发给我。'
const imagePrompt = '一只抱着月亮的小狐狸，柔和绿色夜景，温暖的水彩插画。'
const chatSummary = 'CHILD-CHAT-DONE：已在本私聊回复，实际 message_id=1001。'
const mainSummary = 'MAIN-INTERNAL-DONE：已核对子代理回执。'

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected an actual dialogue protocol object')
  return value
}
function names(request: ModelFixtureRequest): string[] { return (request.tools ?? []).map(tool => tool.function?.name ?? '').sort() }
function batch(request: ModelFixtureRequest) {
  const current = readModelFixtureBatch(request)
  if (!current || !Array.isArray(current.payload.events) || current.payload.events.length !== 1) throw new Error('Dialogue fixture requires one real current Eating event')
  return { ...current, event: object(current.payload.events[0]) }
}
function result(turn: FixtureToolTurn): JsonObject { return object(JSON.parse(turn.text.split('\n')[0]!)) }
function system(request: ModelFixtureRequest): string {
  const messages = request.messages?.filter(message => message.role === 'system') ?? []
  expect(messages).toHaveLength(1)
  return fixtureText(messages[0]!.content)
}
async function temporaryHome() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'Eating_dialogue_integration_')))
  stops.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('Eating_dialogue_integration_')) throw new Error('Unsafe dialogue fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}
async function ownerApi(host: EatingHost) {
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap')
  const boot = object(await bootstrap.json()), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  return async (path: string, input?: JsonObject): Promise<JsonObject> => {
    const response = await fetch(url + '/api' + path, { method: input === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(60000),
      headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json', Origin: url },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const value = object(await response.json())
    if (!response.ok) throw new Error(`Dialogue fixture API ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
}

/** Scripted local models verify the executable handoff and receipts, not which path a real LLM will choose. */
async function fixture(kind: 'chat' | 'image') {
  const home = await temporaryHome()
  const provider = kind === 'image' ? await startImagesProviderFixture('base64', { defer: true }) : undefined
  if (provider) stops.push(() => provider.close())
  const onebot = await startOneBotFixture({ login: { user_id: selfId, nickname: 'Dialogue loopback account' } })
  stops.push(() => onebot.close())
  const sends = () => onebot.requests.filter(request => request.action.startsWith('send_'))
  const model = await startStickersModel((request): FixtureModelAction => {
    const current = batch(request), turns = fixtureToolTurns(request)
    if (current.kind === 'root') {
      expect(names(request)).toEqual(expect.arrayContaining(mainTools))
      expect(names(request).some(name => name.startsWith('mcp__qq__'))).toBe(false)
      if (turns.length === 0) return { name: 'eating_handle_conversation', arguments: { context_ref: current.contextRef } }
      expect(turns).toHaveLength(1)
      expect(turns[0]!.name).toBe('eating_handle_conversation')
      expect(result(turns[0]!)).toMatchObject({ status: 'completed', actions: [expect.objectContaining({ outcome: 'succeeded' }), ...(kind === 'image' ? [expect.objectContaining({ outcome: 'succeeded' })] : [])] })
      return mainSummary
    }
    expect(current.agentTypeId).toBe('qq.private')
    expect(names(request).filter(name => name.startsWith('mcp__qq__'))).toEqual(['mcp__qq__qq_send_private_message'])
    expect(names(request).some(name => name.startsWith('eating_'))).toBe(false)
    if (kind === 'chat') {
      if (!turns.length) {
        expect(current.event.text).toBe(chatText)
        return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(current.event.targetId), message: chatReply, request_id: 'dialogue-private-chat-send-001' } }
      }
      expect(turns).toHaveLength(1)
      expect(result(turns[0]!)).toEqual({ message_id: 1001 })
      return chatSummary
    }
    expect(names(request)).toEqual(expect.arrayContaining(imageTools))
    if (!provider) throw new Error('Missing local dialogue image provider')
    if (!turns.length) {
      expect(current.event.text).toBe(imageText)
      expect(sends()).toEqual([])
      return { name: imagePrefix + 'image_generate', arguments: { prompt: imagePrompt, request_id: 'dialogue-private-image-generate-001' } }
    }
    const submitted = result(turns[0]!)
    expect(submitted).toMatchObject({ jobId: expect.any(String), status: 'queued', assetIds: [] })
    const last = turns.at(-1)!, value = result(last)
    if (last.name === imagePrefix + 'image_generate') {
      expect(sends()).toEqual([])
      provider.release()
      return { name: imagePrefix + 'image_job_get', arguments: { jobId: submitted.jobId!, waitMs: 1000 } }
    }
    if (last.name === imagePrefix + 'image_job_get') {
      expect(value.jobId).toBe(submitted.jobId)
      expect(sends()).toEqual([])
      if (value.status !== 'succeeded') {
        expect(['queued', 'running']).toContain(value.status)
        expect(turns.length).toBeLessThan(12)
        return { name: imagePrefix + 'image_job_get', arguments: { jobId: submitted.jobId!, waitMs: 1000 } }
      }
      expect(value.assetIds).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)])
      return { name: imagePrefix + 'image_get', arguments: { assetId: (value.assetIds as string[])[0]! } }
    }
    const polled = result(turns.filter(turn => turn.name === imagePrefix + 'image_job_get').at(-1)!)
    expect(polled).toMatchObject({ status: 'succeeded' })
    const assetId = (polled.assetIds as string[])[0]!
    if (last.name === imagePrefix + 'image_get') {
      expect(value).toMatchObject({ item: { assetId }, sendable: { type: 'image', data: { file: 'eating-asset://image-generation/' + assetId } } })
      const imageBlocks = request.messages?.flatMap(message => Array.isArray(message.content) ? message.content.filter(isJsonObject).filter(block => block.type === 'image_url') : [])
      expect(imageBlocks).toEqual([expect.objectContaining({ image_url: { url: 'data:image/png;base64,' + provider.image.toString('base64') } })])
      return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(current.event.targetId), message: object(value.sendable), request_id: 'dialogue-private-image-send-001' } }
    }
    expect(last.name).toBe('mcp__qq__qq_send_private_message')
    expect(value).toEqual({ message_id: 1001 })
    return `CHILD-IMAGE-DONE：job=${String(polled.jobId)}，asset=${assetId}，生成 succeeded，实际 private message_id=1001。`
  })
  stops.push(() => model.close())
  const qqScopes: AgentInvocationScope[] = [], capabilityScopes: CapabilityInvocationScope[] = []
  const actionReads: { agentId: string; actions: readonly AgentActionReceipt[] }[] = []
  let plugin!: DshPlugin
  const harnessEntry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) {
    const services: HarnessHostServices = context.harness!
    plugin = new DshPlugin({ ...context, harness: { ...services,
      getMcpConnection(pluginId, scope, policy) {
        const connection = services.getMcpConnection(pluginId, scope, policy)
        qqScopes.push(structuredClone(scope)); return connection
      },
      getCapabilityMcpConnections(scope) {
        const connections = services.getCapabilityMcpConnections(scope)
        capabilityScopes.push(structuredClone(scope)); return connections
      },
      readAgentActions(agentId) {
        const actions = services.readAgentActions(agentId)
        actionReads.push({ agentId, actions: structuredClone(actions) }); return actions
      },
    } }, { locateSystemDsh: testSystemDsh })
    return plugin
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, ...(provider ? [imagesEntry] : []), harnessEntry], port: 0, allowedUiOrigins: [] })
  stops.push(() => host.close())
  const snapshot = host.authoring.getSnapshot()
  for (const [id, marker] of [['common', commonMarker], ['main', mainMarker], ['subagent', childMarker], ['agent:qq.private', typeMarker]] as const) {
    const prompt = snapshot.prompts.find(prompt => prompt.id === id)!
    host.authoring.updatePrompt(id, marker + '\n' + prompt.body, prompt.revision)
  }
  const created = host.authoring.createPersona('小绿', persona)
  host.authoring.setPersonaEnabled(created.persona.id, true, created.snapshot.revision)
  const api = await ownerApi(host)
  const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 5000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
  await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision!, owners: [], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message'], 'qq.group': [] } } })
  await api('/plugins/qq/connect', {})
  if (provider) {
    const configuration = await api('/plugins/image-generation/configuration')
    await api('/plugins/image-generation/configuration', { expectedRevision: configuration.revision!, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: 'dialogue-fixture-images', timeoutMs: 5000 })
    await api('/plugins/image-generation/connect', {})
    expect(provider.requests).toEqual([])
    const directory = await api('/mcp')
    expect(directory.services).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'plugin.image-generation', grant: expect.objectContaining({ agentTypeIds: expect.arrayContaining(['main', 'qq.private']), toolNames: expect.arrayContaining(imageTools.map(name => name.slice(imagePrefix.length))) }) })]))
  }
  const ownerSystem = composeAgentPrompt(host.authoring.readOwnerConfiguration(), null, {}).systemPrompt
  await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'dialogue-fixture-model', apiKey: model.apiKey, maxTokens: 1024, timeoutMs: 30000, autoConnect: false })
  if (provider) await api('/plugins/dsh/manage', { operation: 'save-model-capabilities', input: { expectedRevision: 0, imageInput: true } })
  await api('/plugins/dsh/connect', {})
  const originalText = kind === 'chat' ? chatText : imageText, messageId = kind === 'chat' ? 99101 : 99102
  const originalMessage = [{ type: 'text', data: { text: originalText } }]
  const runtime = () => object(plugin.getPublicConfiguration().runtimeStatus)
  return { home, host, plugin, api, provider, model, onebot, sends, qq, ownerSystem, qqScopes, capabilityScopes, actionReads, originalText, originalMessage, messageId, runtime,
    emit() { onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: selfId, user_id: userId, message_id: messageId, message: originalMessage, raw_message: originalText, sender: { user_id: userId, nickname: 'Local fixture user' } }) },
    diagnostic() { return { runtime: runtime(), status: plugin.getStatus(), queue: host.harness.getStatus(), errors: model.errors, requests: model.requests.map(request => ({ kind: readModelFixtureBatch(request)?.kind, tools: names(request), last: request.messages?.at(-1) })) } },
  }
}

async function expectCompletedHandoff(f: Awaited<ReturnType<typeof fixture>>) {
  try {
    await vi.waitFor(() => {
      expect(f.model.errors).toEqual([])
      expect(f.model.actions.at(-1)).toBe(mainSummary)
      expect(f.host.harness.getStatus()).toMatchObject({ accepted: 1, queueMessages: 0 })
      expect(f.runtime().busy).toBe(false)
    }, { timeout: 30000, interval: 50 })
  } catch (error) { throw new Error(JSON.stringify(f.diagnostic()), { cause: error }) }
  const roots = f.model.requests.filter(request => batch(request).kind === 'root')
  const children = f.model.requests.filter(request => batch(request).kind === 'child')
  expect(roots).toHaveLength(2)
  const incoming = batch(roots[0]!), current = batch(children[0]!)
  expect(incoming.agentTypeId).toBe('qq.private')
  expect(current.contextRef).toBe(incoming.contextRef)
  expect(current.payload.context).toEqual(incoming.payload.context)
  expect(current.payload.events).toEqual(incoming.payload.events)
  expect(current.event).toMatchObject({ pluginId: 'qq', instanceId: f.qq.instanceId, accountId: String(selfId), conversationId: `qq:${selfId}:private:${userId}`, senderId: String(userId), targetId: String(userId), messageId: String(f.messageId), source: { trust: 'external', kind: 'private', senderRole: 'user' }, content: f.originalMessage, text: f.originalText, resourceIds: [] })
  const task = String(current.payload.task)
  expect(task).toContain('独立理解原始 events 中的用户原话')
  expect(task).toContain('实际工具')
  expect(task).toContain('真实回执')
  for (const text of [chatReply, imagePrompt, f.originalText, '不能画', '没有生图', '无法生图']) expect(task).not.toContain(text)
  expect(JSON.stringify(children[0]!.messages)).not.toContain(chatReply)
  expect(JSON.stringify(children[0]!.messages)).not.toContain(imagePrompt)
  for (const request of roots) {
    expect(names(request)).toEqual(expect.arrayContaining(mainTools))
    expect(names(request).some(name => name.startsWith('mcp__qq__'))).toBe(false)
    const handler = request.tools!.find(tool => tool.function?.name === 'eating_handle_conversation')!.function!
    const schema = object(handler.parameters)
    expect(schema).toMatchObject({ type: 'object', required: ['context_ref'], additionalProperties: false })
    expect(Object.keys(object(schema.properties))).toEqual(['context_ref'])
    const prompt = system(request)
    expect(prompt.startsWith(f.ownerSystem + '\n\n')).toBe(true)
    for (const text of [commonMarker, mainMarker, persona, '轻量分流', 'eating_handle_conversation', 'eating_delegate_task', 'eating_contact_target', '不先撰写完整回复']) expect(prompt).toContain(text)
    for (const text of [childMarker, 'DIALOGUE-TYPE-SCOPE', f.originalText]) expect(prompt).not.toContain(text)
  }
  for (const request of children) {
    expect(names(request).filter(name => name.startsWith('mcp__qq__'))).toEqual(['mcp__qq__qq_send_private_message'])
    const prompt = system(request)
    for (const text of [commonMarker, childMarker, persona, `DIALOGUE-TYPE-SCOPE：${selfId}/private/${userId}。`, '我自己理解用户原话']) expect(prompt).toContain(text)
    expect(prompt).not.toContain(mainMarker)
    expect(prompt).not.toContain(f.originalText)
    expect(batch(request).payload.events).toEqual(incoming.payload.events)
  }
  const turns = fixtureToolTurns(roots[1]!)
  expect(turns.map(turn => turn.name)).toEqual(['eating_handle_conversation'])
  expect(turns[0]!.arguments).toEqual({ context_ref: incoming.contextRef })
  const receipt = result(turns[0]!)
  expect(receipt).toMatchObject({ childId: f.qqScopes[0]!.agentId, status: 'completed' })
  expect(f.actionReads).toContainEqual({ agentId: receipt.childId, actions: receipt.actions })
  expect(f.qqScopes).toHaveLength(1)
  expect(f.qqScopes[0]).toMatchObject({ agentTypeId: 'qq.private', pluginId: 'qq', instanceId: f.qq.instanceId, accountId: String(selfId), targetId: String(userId), kind: 'private', conversationId: `qq:${selfId}:private:${userId}`, messageIds: [String(f.messageId)], resourceIds: [] })
  const scopedCapabilities = f.capabilityScopes.filter(scope => scope.agentTypeId === 'qq.private')
  expect(scopedCapabilities).toEqual([{ agentId: receipt.childId, agentTypeId: 'qq.private', source: f.qqScopes[0] }])
  expect(f.sends()).toHaveLength(1)
  expect(f.model.errors).toEqual([])
  const rootId = String(f.runtime().sessionId), web = await connectNativeWeb(await f.plugin.manage('open-native-web', {}), rootId)
  const events = await web.events(rootId)
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn/end', data: expect.objectContaining({ reason: expect.objectContaining({ kind: 'completed' }) }) })]))
  return { roots, children, receipt }
}

describe.runIf(enabled)('system DSH conversation ownership with real Host and isolated loopback peers', () => {
  it('hands an ordinary private conversation to the child without prewriting a reply and ends after the real send receipt', async () => {
    const f = await fixture('chat')
    expect(f.model.requests).toEqual([])
    f.emit()
    const { children, receipt } = await expectCompletedHandoff(f)
    expect(f.model.requests.map(request => batch(request).kind)).toEqual(['root', 'child', 'child', 'root'])
    expect(children).toHaveLength(2)
    expect(f.model.actions.filter(action => typeof action !== 'string').map(action => action.name)).toEqual(['eating_handle_conversation', 'mcp__qq__qq_send_private_message'])
    expect(f.sends()[0]).toMatchObject({ action: 'send_private_msg', params: { user_id: userId, message: chatReply } })
    expect(fixtureToolTurns(children[1]!).map(turn => result(turn))).toEqual([{ message_id: 1001 }])
    expect(receipt).toMatchObject({ summary: chatSummary, actions: [{ tool: 'qq_send_private_message', outcome: 'succeeded', result: { message_id: 1001 } }] })
    expect(JSON.stringify(f.sends().map(send => send.params))).not.toContain(mainSummary)
  }, 60000)

  it('lets the child generate once, poll and read the actual asset, send it to the private target, and return both real receipts', async () => {
    const f = await fixture('image'), provider = f.provider!
    f.emit()
    const { roots, children, receipt } = await expectCompletedHandoff(f)
    const turns = fixtureToolTurns(children.at(-1)!)
    expect(turns.map(turn => turn.name)).toEqual([imagePrefix + 'image_generate', ...turns.filter(turn => turn.name === imagePrefix + 'image_job_get').map(turn => turn.name), imagePrefix + 'image_get', 'mcp__qq__qq_send_private_message'])
    expect(turns.filter(turn => turn.name === imagePrefix + 'image_generate')).toHaveLength(1)
    expect(turns.filter(turn => turn.name === imagePrefix + 'image_job_get').length).toBeGreaterThan(0)
    const completed = result(turns.filter(turn => turn.name === imagePrefix + 'image_job_get').at(-1)!)
    expect(completed).toMatchObject({ status: 'succeeded', assetIds: [expect.any(String)] })
    const assetId = (completed.assetIds as string[])[0]!, actualGet = turns.find(turn => turn.name === imagePrefix + 'image_get')!
    const sendable = object(result(actualGet).sendable)
    expect(turns.at(-1)!.arguments.message).toEqual(sendable)
    expect(sendable).toEqual({ type: 'image', data: { file: 'eating-asset://image-generation/' + assetId } })
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]).toMatchObject({ path: '/custom/v1/images/generations', body: { prompt: imagePrompt, model: 'dialogue-fixture-images', n: 1 } })
    expect(provider.edits).toEqual([])
    expect(f.sends()[0]).toMatchObject({ action: 'send_private_msg', params: { user_id: userId, message: { type: 'image', data: { file: 'base64://' + provider.image.toString('base64') } } } })
    expect(await f.api('/plugins/image-generation/manage', { operation: 'get', input: { assetId } })).toMatchObject({ image: { mimeType: 'image/png', data: provider.image.toString('base64') }, sendable })
    expect(receipt.summary).toBe(`CHILD-IMAGE-DONE：job=${String(completed.jobId)}，asset=${assetId}，生成 succeeded，实际 private message_id=1001。`)
    expect(receipt.actions).toHaveLength(2)
    expect(receipt.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'qq_send_private_message', outcome: 'succeeded', result: { message_id: 1001 } }),
      expect.objectContaining({ tool: imagePrefix + 'image_generate', requestId: 'dialogue-private-image-generate-001', outcome: 'succeeded' }),
    ]))
    for (const root of roots) {
      expect(names(root)).toEqual(expect.arrayContaining(imageTools))
      expect(fixtureToolTurns(root).every(turn => turn.name === 'eating_handle_conversation')).toBe(true)
      expect(JSON.stringify(root)).not.toContain(provider.image.toString('base64'))
    }
    expect(JSON.stringify(receipt)).not.toContain(provider.image.toString('base64'))
    expect(JSON.stringify(f.sends().map(send => send.params))).not.toContain(mainSummary)
  }, 60000)
})
