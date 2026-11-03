import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeAgentPrompt, isJsonObject } from '@eating/plugin-sdk'
import type { AgentInvocationScope, BackendPluginEntry, ConnectionStatus, HarnessHostServices, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { CHILD_COORDINATION_POLICY, MAIN_COORDINATION_POLICY } from '../../../plugins/harness/dsh/src/backend/conversation-policy'
import { defaultNativeCapabilities } from '../../../plugins/harness/dsh/src/native-capabilities'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot'
import { fixtureText } from '../../../tests/fixtures/stickers-model'
import type { FixtureModelAction, FixtureToolTurn } from '../../../tests/fixtures/stickers-model'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { EatingHost } from './app'

const enabled = Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN)
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of stops.splice(0).reverse()) try { await stop() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Verification handoff fixture cleanup failed')
})
const selfId = 100000901, ownerId = 100000902, groupId = 123456
const common = 'VERIFY-CUSTOM-COMMON：保留主人当前通用正文。'
const main = 'VERIFY-CUSTOM-MAIN：保留主人当前主层正文。'
const child = 'VERIFY-CUSTOM-CHILD：保留主人当前子层正文。'
const persona = 'VERIFY-CUSTOM-PERSONA：我是小禾，清楚自然地说话。'
const privateQuestion = '请先核实现在可以确认的现场事实，再告诉我。'
const crossQuestion = '你刚刚在群里聊了什么？先核实再回答我。'
const groupSeed = '周六去植物园吧，你带相机，好不好？'
const groupFact = '已核实：本群刚才讨论周六去植物园，也提到带相机；这是当前绑定群历史中的事实。'
const localFact = '本地只读夹具实际返回：当前核实窗口正常。'
const reopenText = '回到原群会话，仅检查可用权限，不发消息。'
const readOnlyTask = '只核实当前绑定群已有历史并向 main 回报事实与未知范围；不要向群发言，不读取其他目标，不继承私聊消息或资源。'
const rootDone = 'VERIFY-MAIN-DONE', seedDone = 'VERIFY-SEED-DONE', reopenedDone = 'VERIFY-REOPENED-DONE'
const childDone = 'VERIFY-PRIVATE-REPLY-DONE'
const readName = 'mcp__plugin_verification__fact_read', writerName = 'mcp__plugin_verification__writer'
const imageName = 'mcp__plugin_verification__image_generate'

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected actual verification handoff protocol object')
  return value
}
function names(request: ModelFixtureRequest): string[] { return (request.tools ?? []).map(tool => tool.function?.name ?? '').sort() }
function envelope(request: ModelFixtureRequest) {
  for (const [messageIndex, message] of [...(request.messages ?? []).entries()].reverse()) {
    if (message.role !== 'user') continue
    const text = fixtureText(message.content), wrapped = /^Agent ([a-f0-9-]{36}) sent a message: ([\s\S]+)$/i.exec(text)
    let value: unknown
    try { value = JSON.parse(wrapped?.[2] ?? text) } catch { continue }
    if (!isJsonObject(value) || !isJsonObject(value.eating) || value.eating.protocolVersion !== 1 || !isJsonObject(value.context) || !Array.isArray(value.events)) continue
    const kind = value.eating.magic === 'eating-harness-delivery' ? 'root' : 'child'
    const context = kind === 'root' ? object((value.context.conversations as unknown[])[0]) : value.context
    return { kind, context, contextRef: String(kind === 'root' ? context.contextRef : value.eating.contextRef), payload: value, messageIndex }
  }
  throw new Error('Missing actual current Eating envelope')
}
function turns(request: ModelFixtureRequest): FixtureToolTurn[] {
  const current = envelope(request), calls = new Map<string, { name: string; arguments: JsonObject }>(), results: FixtureToolTurn[] = []
  for (const message of request.messages?.slice(current.messageIndex + 1) ?? []) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const raw of message.tool_calls) {
      const call = object(raw), definition = object(call.function)
      calls.set(String(call.id), { name: String(definition.name), arguments: object(JSON.parse(String(definition.arguments))) })
    }
    if (message.role === 'tool') {
      const call = calls.get(String(Reflect.get(message, 'tool_call_id')))
      if (!call) throw new Error('Actual tool receipt has no preceding call in current task')
      results.push({ ...call, content: message.content, text: fixtureText(message.content) })
    }
  }
  return results
}
function result(turn: FixtureToolTurn): JsonObject { return object(JSON.parse(turn.text.split('\n')[0]!)) }
function system(request: ModelFixtureRequest): string {
  const systems = request.messages?.filter(message => message.role === 'system') ?? []
  expect(systems).toHaveLength(1)
  return fixtureText(systems[0]!.content)
}
async function temporaryHome() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'Eating_verification_handoff_')))
  stops.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('Eating_verification_handoff_')) throw new Error('Unsafe verification handoff fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}
async function scriptedModel(choose: (request: ModelFixtureRequest) => FixtureModelAction) {
  const requests: ModelFixtureRequest[] = [], actions: FixtureModelAction[] = [], errors: string[] = []
  const apiKey = 'verification-loopback-not-a-real-credential'
  const server = createServer((incoming, response) => {
    void (async () => {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
      if (incoming.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401); response.end(); return }
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk); length += bytes.length
        if (length > 4 * 1024 * 1024) throw new Error('Verification model request exceeds fixture bound')
        chunks.push(bytes)
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelFixtureRequest
      requests.push(request)
      const action = choose(request); actions.push(action)
      const id = `verification-fixture-${requests.length}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: JsonObject, finish: string | null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
      if (typeof action === 'string') { chunk({ role: 'assistant', content: action }, null); chunk({}, 'stop') }
      else {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_verification_${requests.length}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] }, null)
        chunk({}, 'tool_calls')
      }
      response.end('data: [DONE]\n\n')
    })().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Verification model did not bind loopback')
  stops.push(async () => { const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed })
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, apiKey, requests, actions, errors }
}
function functionalFixture(calls: { name: string; scope: JsonObject }[]): BackendPluginEntry {
  return { id: 'verification', kind: 'capability', storageDirectory: 'verification', create() {
    let state: ConnectionStatus['state'] = 'disconnected'
    return { id: 'verification', name: 'Verification functional loopback', kind: 'capability', version: '1.0.0', capabilities: [],
      tools: ['fact_read', 'writer', 'image_generate'].map(name => ({ name, title: name, description: `Verification fixture ${name}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: name === 'fact_read', destructive: name !== 'fact_read', resultFormat: 'json' as const })),
      getStatus: () => ({ state, accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({ autoConnect: false }), updateConfiguration: async () => ({}),
      connect: async () => { state = 'connected' }, disconnect: async () => { state = 'disconnected' }, dispose: async () => { state = 'disconnected' }, invoke: async () => null,
      invokeCapability: async (name, _input, _requestId, scope) => {
        calls.push({ name, scope: { agentId: scope.agentId, agentTypeId: scope.agentTypeId, readOnly: scope.readOnly === true, ...(scope.source ? { source: { ...scope.source, signal: undefined } as unknown as JsonObject } : {}) } })
        if (name !== 'fact_read') throw new Error('Writer reached fixture implementation during verification')
        return { fact: localFact, targetId: scope.source?.targetId ?? null }
      },
    }
  } }
}
function expectVerifyTools(request: ModelFixtureRequest, group: boolean) {
  expect(names(request)).toEqual([readName, ...(group ? ['mcp__qq__qq_get_group_info'] : [])].sort())
  for (const forbidden of ['mcp__qq__qq_send_private_message', 'mcp__qq__qq_send_group_message', writerName, imageName, 'read', 'read_image', 'bash', 'web_fetch']) expect(names(request)).not.toContain(forbidden)
}
function expectReplyTools(request: ModelFixtureRequest, group: boolean) {
  expect(names(request)).toContain(group ? 'mcp__qq__qq_send_group_message' : 'mcp__qq__qq_send_private_message')
  expect(names(request)).toContain(writerName)
  expect(names(request)).toContain(imageName)
  expect(names(request)).toContain('read')
}
function notesFrom(summary: unknown) { return JSON.stringify({ facts: String(summary), source: 'actual bound child report', disclosure: 'only the original owner private conversation', unknown: 'no other conversation or resource has been read' }) }

async function createFixture(kind: 'current' | 'cross') {
  const home = await temporaryHome(), capabilityCalls: { name: string; scope: JsonObject }[] = []
  const scopes: AgentInvocationScope[] = [], connections: { scope: AgentInvocationScope; toolNames: readonly string[] }[] = []
  const onebot = await startOneBotFixture({ login: { user_id: selfId, nickname: 'Verification loopback' }, onRequest(request, peer) {
    if (request.action === 'get_friend_list') { replyOneBot(peer, request, [{ user_id: ownerId, nickname: 'Loopback owner', remark: '' }]); return true }
  } })
  stops.push(() => onebot.close())
  const sends = () => onebot.requests.filter(request => request.action.startsWith('send_'))
  const model = await scriptedModel((request): FixtureModelAction => {
    const current = envelope(request), completed = turns(request), events = current.payload.events as JsonObject[]
    if (current.kind === 'root') {
      if (events[0]!.text === groupSeed || events[0]!.text === reopenText) {
        if (!completed.length) return { name: 'eating_handle_conversation', arguments: { context_ref: current.contextRef, mode: 'reply' } }
        expect(result(completed[0]!)).toMatchObject({ status: 'completed', summary: groupFact, actions: [] })
        return events[0]!.text === groupSeed ? seedDone : reopenedDone
      }
      if (kind === 'current') {
        if (!completed.length) return { name: 'eating_handle_conversation', arguments: { context_ref: current.contextRef, mode: 'verify' } }
        if (completed.length === 1) {
          const actual = result(completed[0]!)
          expect(actual).toMatchObject({ status: 'completed', actions: [] })
          expect(String(actual.summary)).toContain(localFact)
          expect(String(actual.summary)).toContain('missing')
          expect(sends()).toEqual([])
          return { name: 'eating_handle_conversation', arguments: { context_ref: current.contextRef, mode: 'reply', context_notes: notesFrom(actual.summary) } }
        }
        expect(completed).toHaveLength(2)
        expect(result(completed[1]!)).toMatchObject({ childId: result(completed[0]!).childId, status: 'completed', summary: childDone, actions: [{ outcome: 'succeeded', result: { message_id: 1001 } }] })
        return rootDone
      }
      expect(events[0]!.text).toBe(crossQuestion)
      if (!completed.length) return { name: 'eating_list_contact_targets', arguments: {} }
      if (completed.length === 1) {
        const target = (result(completed[0]!).targets as JsonObject[]).find(target => target.agentTypeId === 'qq.group' && target.targetId === String(groupId))
        if (!target) throw new Error('Real approved group target missing')
        return { name: 'eating_contact_target', arguments: { target_id: target.id!, task: readOnlyTask, mode: 'verify' } }
      }
      if (completed.length === 2) {
        const actual = result(completed[1]!)
        expect(actual).toMatchObject({ status: 'completed', summary: groupFact, actions: [] })
        expect(sends()).toEqual([])
        return { name: 'eating_handle_conversation', arguments: { context_ref: current.contextRef, mode: 'reply', context_notes: notesFrom(actual.summary) } }
      }
      expect(completed).toHaveLength(3)
      expect(result(completed[2]!)).toMatchObject({ status: 'completed', summary: childDone, actions: [{ outcome: 'succeeded', result: { message_id: 1001 } }] })
      return rootDone
    }
    const coordination = object(current.payload.coordination)
    if (coordination.mode === 'verify') {
      const group = current.context.source === 'eating-contact'
      expectVerifyTools(request, group)
      expect(sends()).toEqual([])
      if (group) {
        expect(kind).toBe('cross')
        expect(events).toEqual([])
        expect(current.context.target).toMatchObject({ accountId: String(selfId), targetId: String(groupId), kind: 'group' })
        expect(current.payload.task).toBe(readOnlyTask)
        const prior = request.messages?.slice(0, current.messageIndex).map(message => fixtureText(message.content)).join('\n') ?? ''
        expect(prior).toContain(groupSeed)
        expect(prior).toContain(groupFact)
        expect(prior).not.toContain(crossQuestion)
      } else {
        expect(events[0]!.text).toBe(privateQuestion)
        expect(current.context).toMatchObject({ agentTypeId: 'qq.private', targetId: String(ownerId) })
      }
      if (!completed.length) return { name: group ? 'mcp__qq__qq_send_group_message' : 'mcp__qq__qq_send_private_message', arguments: { [group ? 'group_id' : 'user_id']: String(group ? groupId : ownerId), message: 'FORCED-WRITER-MUST-NOT-SEND', request_id: 'verification-forced-send-001' } }
      expect(completed[0]!.text).toBe('Error: The tool is no longer available.')
      if (completed.length === 1) return { name: writerName, arguments: {} }
      expect(completed[1]!.text).toBe('Error: The tool is no longer available.')
      if (completed.length === 2) return { name: readName, arguments: {} }
      expect(completed).toHaveLength(3)
      expect(result(completed[2]!)).toMatchObject({ fact: localFact, targetId: String(group ? groupId : ownerId) })
      return group ? groupFact : JSON.stringify({ actualFacts: result(completed[2]!).fact, missing: 'No other conversation history was available or read; report the limitation to main before replying.' })
    }
    expect(coordination.mode).toBe('reply')
    const group = current.context.agentTypeId === 'qq.group'
    expectReplyTools(request, group)
    if (group) {
      expect([groupSeed, reopenText]).toContain(events[0]!.text)
      return groupFact
    }
    expect(current.context).toMatchObject({ agentTypeId: 'qq.private', targetId: String(ownerId) })
    expect(events[0]!.text).toBe(kind === 'current' ? privateQuestion : crossQuestion)
    const notes = String(coordination.context_notes), facts = object(JSON.parse(notes))
    expect(facts.source).toBe('actual bound child report')
    expect(facts.facts).toContain(kind === 'current' ? localFact : groupFact)
    expect(current.context).not.toHaveProperty('coordination')
    expect(current.context).not.toHaveProperty('context_notes')
    if (kind === 'cross') expect(events).not.toContainEqual(expect.objectContaining({ text: groupSeed }))
    if (!completed.length) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(ownerId), message: kind === 'current' ? `核实到了：${localFact}；其他会话记录仍未确认。` : '刚才我们在群里聊周六去植物园，也提到了带相机。', request_id: `verification-${kind}-private-001` } }
    expect(completed).toHaveLength(1)
    expect(result(completed[0]!)).toEqual({ message_id: 1001 })
    return childDone
  })
  let plugin!: DshPlugin, services!: HarnessHostServices
  const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) {
    services = context.harness!
    plugin = new DshPlugin({ ...context, harness: { ...services, getMcpConnection(pluginId, scope, policy) {
      const connection = services.getMcpConnection(pluginId, scope, policy)
      const captured = { ...scope, signal: undefined }
      scopes.push(structuredClone(captured))
      connections.push({ scope: structuredClone(captured), toolNames: [...connection.toolNames] })
      return connection
    } } }, { locateSystemDsh: testSystemDsh })
    return plugin
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, functionalFixture(capabilityCalls), entry], port: 0, allowedUiOrigins: [] })
  stops.push(() => host.close())
  for (const [id, body] of [['common', common], ['main', main], ['subagent', child]] as const) {
    const prompt = host.authoring.getSnapshot().prompts.find(prompt => prompt.id === id)!
    host.authoring.updatePrompt(id, body, prompt.revision)
  }
  const created = host.authoring.createPersona('小禾', persona)
  host.authoring.setPersonaEnabled(created.persona.id, true, created.snapshot.revision)
  const ownerSystem = composeAgentPrompt(host.authoring.readOwnerConfiguration(), null, {}).systemPrompt
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap')
  const boot = object(await bootstrap.json()), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const api = async (path: string, input: JsonObject): Promise<JsonObject> => {
    const response = await fetch(url + '/api' + path, { method: 'POST', signal: AbortSignal.timeout(60000), headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(input) })
    const value = object(await response.json())
    if (!response.ok) throw new Error(`Verification handoff fixture ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 5000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
  await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision!, owners: [String(ownerId)], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message'], 'qq.group': ['qq_get_group_info', 'qq_send_group_message'] } } })
  await api('/plugins/qq/connect', {})
  await api('/plugins/verification/connect', {})
  await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'verification-handoff-loopback', apiKey: model.apiKey, maxTokens: 1024, timeoutMs: 30000, autoConnect: false })
  const native = defaultNativeCapabilities(['qq.private', 'qq.group'])
  await plugin.manage('native-save', { expectedRevision: native.revision, features: native.features.map(feature => ({ ...feature, ...(feature.id === 'files' ? { enabled: true, agentTypeIds: ['main', 'qq.private', 'qq.group'] } : {}) })) as unknown as JsonObject[], toolGrants: [] })
  await api('/plugins/dsh/connect', {})
  if (kind === 'cross') {
    const initial = plugin.autonomy.snapshot()
    await api('/autonomy', { harnessId: 'dsh', operation: 'configure-contact-policy', input: { expectedRevision: object(initial.contactPolicy).revision!, expectedConfigurationRevision: initial.revision!, expectedActivityRevision: object(initial.state).revision!, mode: 'allowlist', entries: [{ pluginId: 'qq', instanceId: qq.instanceId!, accountId: String(selfId), agentTypeId: 'qq.group', targetId: String(groupId), label: 'Verification loopback group' }] } })
  }
  const runtime = () => object(plugin.getPublicConfiguration().runtimeStatus)
  return { host, plugin, model, scopes, connections, capabilityCalls, sends, qq, ownerSystem, runtime,
    actions: (agentId: string) => services.readAgentActions(agentId),
    emit(text: string, messageId: number, group = false) {
      onebot.emitEvent({ post_type: 'message', message_type: group ? 'group' : 'private', self_id: selfId, user_id: ownerId, ...(group ? { group_id: groupId } : {}), message_id: messageId, message: text, raw_message: text, sender: { user_id: ownerId, nickname: 'Loopback owner', ...(group ? { role: 'member' } : {}) } })
    },
    diagnostic() { return { errors: model.errors, queue: host.harness.getStatus(), runtime: runtime(), requests: model.requests.map(request => ({ kind: envelope(request).kind, context: envelope(request).context, tools: names(request), last: request.messages?.at(-1) })) } },
  }
}
async function completed(fixture: Awaited<ReturnType<typeof createFixture>>, summary = rootDone, accepted = 1) {
  try {
    await vi.waitUntil(() => {
      if (fixture.model.errors.length) throw new Error(fixture.model.errors.join('\n'))
      const status = fixture.host.harness.getStatus()
      return fixture.model.actions.at(-1) === summary && fixture.runtime().busy === false && status.accepted === accepted && status.queueMessages === 0
    }, { timeout: 45000, interval: 50 })
  } catch (error) { throw new Error(JSON.stringify(fixture.diagnostic()), { cause: error }) }
}
function expectSystems(fixture: Awaited<ReturnType<typeof createFixture>>) {
  for (const request of fixture.model.requests) {
    const prompt = system(request)
    expect(prompt).toContain(common)
    expect(prompt).toContain(persona)
    if (envelope(request).kind === 'root') {
      expect(prompt.startsWith(fixture.ownerSystem + '\n\n')).toBe(true)
      expect(prompt).toContain(main)
      expect(prompt).toContain(MAIN_COORDINATION_POLICY)
      expect(prompt).toContain('每次交接前，主 Agent 都先理解用户在问什么、当前事实是否足够、子会话是否掌握这些事实，再选择工具与模式')
      expect(prompt).toContain('事实不够时先选择 mode=verify')
      expect(prompt).toContain('事实充分才选 reply')
      expect(prompt).toContain('mode')
      expect(prompt).toContain('verify')
      expect(prompt).toContain('reply')
      expect(prompt).not.toContain(CHILD_COORDINATION_POLICY)
      const schema = object(request.tools!.find(tool => tool.function?.name === 'eating_handle_conversation')!.function!.parameters)
      expect(schema.required).toEqual(['context_ref', 'mode'])
      expect(object(object(schema.properties).mode).enum).toEqual(['reply', 'verify'])
      expect(object(object(schema.properties).context_notes)).toMatchObject({ type: 'string', maxLength: 8000 })
      expect(schema.additionalProperties).toBe(false)
      const contact = object(request.tools!.find(tool => tool.function?.name === 'eating_contact_target')!.function!.parameters)
      expect(contact.required).toEqual(['target_id', 'task', 'mode'])
      expect(contact.additionalProperties).toBe(false)
    } else {
      expect(prompt).toContain(child)
      expect(prompt).toContain(CHILD_COORDINATION_POLICY)
      expect(prompt).not.toContain(main)
    }
  }
  expect(fixture.host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'main')!.body).toBe(main)
  expect(fixture.model.errors).toEqual([])
}
function sourceScope(scope: AgentInvocationScope) {
  const { readOnly: _readOnly, signal: _signal, ...source } = scope
  return source
}

describe.runIf(enabled)('scripted system DSH explicit verification handoff, not a guarantee of real LLM routing', () => {
  it('starts the batch in verify mode, rejects forced sends, then passes actual facts into reply on the same private UUID and original scope', async () => {
    const fixture = await createFixture('current')
    fixture.emit(privateQuestion, 99001)
    await completed(fixture)
    expectSystems(fixture)
    const roots = fixture.model.requests.filter(request => envelope(request).kind === 'root'), calls = turns(roots.at(-1)!)
    expect(calls.map(turn => turn.name)).toEqual(['eating_handle_conversation', 'eating_handle_conversation'])
    expect(calls[0]!.arguments).toEqual({ context_ref: envelope(roots[0]!).contextRef, mode: 'verify' })
    expect(calls[1]!.arguments).toEqual({ context_ref: calls[0]!.arguments.context_ref, mode: 'reply', context_notes: notesFrom(result(calls[0]!).summary) })
    expect(calls.every(turn => !Object.hasOwn(turn.arguments, 'task'))).toBe(true)
    const verify = fixture.model.requests.find(request => envelope(request).kind === 'child' && object(envelope(request).payload.coordination).mode === 'verify')!
    const reply = fixture.model.requests.find(request => envelope(request).kind === 'child' && object(envelope(request).payload.coordination).mode === 'reply')!
    expect(envelope(reply).payload.events).toEqual(envelope(verify).payload.events)
    expect(envelope(reply).payload.context).toEqual(envelope(verify).payload.context)
    expect(envelope(reply).payload.task).toBe(envelope(verify).payload.task)
    expect(fixture.scopes).toHaveLength(2)
    expect(fixture.scopes[0]).toMatchObject({ readOnly: true, agentTypeId: 'qq.private', accountId: String(selfId), targetId: String(ownerId), messageIds: ['99001'], resourceIds: [] })
    expect(fixture.scopes[1]!.readOnly).not.toBe(true)
    expect(sourceScope(fixture.scopes[1]!)).toEqual(sourceScope(fixture.scopes[0]!))
    expect(fixture.connections.map(connection => connection.toolNames)).toEqual([[], ['qq_send_private_message']])
    expect(fixture.capabilityCalls.map(call => call.name)).toEqual(['fact_read'])
    expect(fixture.capabilityCalls[0]!.scope).toMatchObject({ readOnly: true, source: { targetId: String(ownerId), readOnly: true, messageIds: ['99001'], resourceIds: [] } })
    expect(fixture.sends()).toMatchObject([{ action: 'send_private_msg', params: { user_id: ownerId } }])
    expect(fixture.sends()).toHaveLength(1)
    const receipt = result(calls[1]!)
    expect(fixture.actions(String(receipt.childId))).toEqual(receipt.actions)
  }, 120000)

  it('reads the existing canonical group history without sending, gives checked notes only to the original private child, and restores group reply permissions', async () => {
    const fixture = await createFixture('cross')
    fixture.emit(groupSeed, 99002, true)
    await completed(fixture, seedDone)
    const seed = fixture.scopes[0]!
    expect(fixture.sends()).toEqual([])
    const start = fixture.model.requests.length
    fixture.emit(crossQuestion, 99003)
    await completed(fixture, rootDone, 2)
    const requests = fixture.model.requests.slice(start), roots = requests.filter(request => envelope(request).kind === 'root'), calls = turns(roots.at(-1)!)
    expect(calls.map(turn => turn.name)).toEqual(['eating_list_contact_targets', 'eating_contact_target', 'eating_handle_conversation'])
    expect(calls[1]!.arguments).toMatchObject({ mode: 'verify', task: readOnlyTask })
    expect(calls[2]!.arguments).toEqual({ context_ref: envelope(roots[0]!).contextRef, mode: 'reply', context_notes: notesFrom(result(calls[1]!).summary) })
    expect(result(calls[1]!)).toMatchObject({ childId: seed.agentId, summary: groupFact, actions: [] })
    const contact = requests.find(request => envelope(request).context.source === 'eating-contact')!
    expect(envelope(contact).payload.events).toEqual([])
    expect(fixture.scopes[1]).toMatchObject({ agentId: seed.agentId, readOnly: true, agentTypeId: 'qq.group', targetId: String(groupId), messageIds: [], resourceIds: [] })
    expect(fixture.scopes[2]).toMatchObject({ agentTypeId: 'qq.private', accountId: String(selfId), targetId: String(ownerId), messageIds: ['99003'], resourceIds: [] })
    expect(fixture.scopes[2]!.agentId).not.toBe(seed.agentId)
    expect(fixture.connections.map(connection => connection.toolNames)).toEqual([['qq_send_group_message', 'qq_get_group_info'], ['qq_get_group_info'], ['qq_send_private_message']])
    expect(fixture.sends()).toMatchObject([{ action: 'send_private_msg', params: { user_id: ownerId, message: '刚才我们在群里聊周六去植物园，也提到了带相机。' } }])
    expect(fixture.sends()).toHaveLength(1)
    expect(fixture.capabilityCalls.map(call => call.name)).toEqual(['fact_read'])
    expect(fixture.capabilityCalls[0]!.scope).toMatchObject({ readOnly: true, source: { agentId: seed.agentId, targetId: String(groupId), messageIds: [], resourceIds: [] } })
    fixture.emit(reopenText, 99004, true)
    await completed(fixture, reopenedDone, 3)
    expectSystems(fixture)
    expect(fixture.scopes[3]).toMatchObject({ agentId: seed.agentId, agentTypeId: 'qq.group', targetId: String(groupId) })
    expect(fixture.scopes[3]!.readOnly).not.toBe(true)
    expect(fixture.connections[3]!.toolNames).toEqual(['qq_send_group_message', 'qq_get_group_info'])
    expect(fixture.sends()).toHaveLength(1)
    expect(fixture.plugin.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'completed' }])
  }, 120000)
})
