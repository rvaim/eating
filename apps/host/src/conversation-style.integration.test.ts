import { fixturePendingTask, fixtureResolveTaskTurns } from '../../../tests/fixtures/async-tasks'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeAgentPrompt, isJsonObject } from '@eating/plugin-sdk'
import type { AgentActionReceipt, AgentInvocationScope, BackendPluginEntry, HarnessHostServices, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { CHILD_COORDINATION_POLICY, MAIN_COORDINATION_POLICY, SHARED_CONVERSATION_POLICY } from '../../../plugins/harness/dsh/src/backend/conversation-policy'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot'
import { fixtureText, startStickersModel } from '../../../tests/fixtures/stickers-model'
import type { FixtureModelAction, FixtureToolTurn } from '../../../tests/fixtures/stickers-model'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { EatingHost } from './app'

const enabled = Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN)
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of stops.splice(0).reverse()) try { await stop() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Conversation style fixture cleanup failed')
})
const selfId = 100000801, ownerId = 100000802, groupId = 123456
const common = 'STYLE-CUSTOM-COMMON：主人保留的通用正文。'
const main = 'STYLE-CUSTOM-MAIN：主人保留的主层正文。'
const child = 'STYLE-CUSTOM-CHILD：主人保留的子层正文。'
const privateType = 'STYLE-CUSTOM-PRIVATE：{{机器人账号}}/{{会话类型}}/{{目标编号}}。'
const groupType = 'STYLE-CUSTOM-GROUP：{{机器人账号}}/{{会话类型}}/{{目标编号}}。'
const persona = 'STYLE-CUSTOM-PERSONA：我是小禾，喜欢清楚温暖地说话。'
const quietText = '我先忙一会儿，不用回复。'
const chatText = '今天累坏了，陪我说两句吧。'
const bubbles = ['那就先歇会儿吧，别硬撑了。我陪你。', '今天的事想说就说，不想说我们就聊点别的。']
const requestIds = ['style-private-bubble-001', 'style-private-bubble-002']
const groupFact = '群里刚才商量了周六去植物园，主人问我能不能带相机。'
const groupSeed = '周六去植物园吧，你带相机，好不好？'
const privateQuestion = '你刚刚在群里聊了什么？'
const missingFacts = '当前私聊上下文没有群内事实，不能据此判断自己没有参与。请主 Agent 核对绑定群会话的已有记录；我尚未对外发送。'
const readOnlyTask = '主人在私聊询问刚才群内讨论的事。只核实你当前绑定群会话已有历史，向 main 返回可确认的事实；不要向该群发消息，不要联系群成员，不继承私聊消息或资源引用。'
const verifiedReply = '刚才我们在群里聊周六去植物园，还说到了带相机的事。'
const rootDone = 'STYLE-MAIN-INTERNAL-DONE'
const seedDone = 'STYLE-SEED-INTERNAL-DONE'
const childDone = 'STYLE-CHILD-INTERNAL-DONE'

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected actual conversation style protocol object')
  return value
}
function names(request: ModelFixtureRequest): string[] { return (request.tools ?? []).map(tool => tool.function?.name ?? '').sort() }
function envelope(request: ModelFixtureRequest) {
  for (const [messageIndex, message] of [...(request.messages ?? []).entries()].reverse()) {
    if (message.role !== 'user') continue
    const text = fixtureText(message.content)
    const wrapped = /^Agent ([a-f0-9-]{36}) sent a message: ([\s\S]+)$/i.exec(text)
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
  const current = envelope(request)
  const calls = new Map<string, { name: string; arguments: JsonObject }>()
  const results: FixtureToolTurn[] = []
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
  return fixtureResolveTaskTurns(request, results)
}
function result(turn: FixtureToolTurn): JsonObject { return turn.taskResult ?? object(JSON.parse(turn.text.split('\n')[0]!)) }
function system(request: ModelFixtureRequest): string {
  const systems = request.messages?.filter(message => message.role === 'system') ?? []
  expect(systems).toHaveLength(1)
  return fixtureText(systems[0]!.content)
}
async function temporaryHome() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'Eating_conversation_style_')))
  stops.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('Eating_conversation_style_')) throw new Error('Unsafe conversation style fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}

async function fixture(kind: 'quiet' | 'bubbles' | 'verify') {
  const home = await temporaryHome()
  const onebot = await startOneBotFixture({ login: { user_id: selfId, nickname: 'Conversation style loopback' }, onRequest(request, peer) {
    if (request.action === 'get_friend_list') { replyOneBot(peer, request, [{ user_id: ownerId, nickname: 'Loopback owner', remark: '' }]); return true }
  } })
  stops.push(() => onebot.close())
  const sends = () => onebot.requests.filter(request => request.action.startsWith('send_'))
  const model = await startStickersModel((request): FixtureModelAction => {
    const current = envelope(request), completed = turns(request)
    const events = current.payload.events as JsonObject[]
    if (current.kind === 'root') {
      if (!completed.length) return { name: 'eating_handle_conversation', arguments: { context_ref: current.contextRef, mode: 'reply' } }
      if (kind !== 'verify') {
        expect(completed).toHaveLength(1)
        expect(result(completed[0]!)).toMatchObject({ status: 'completed', summary: childDone })
        return rootDone
      }
      if (events[0]!.text === groupSeed) {
        expect(result(completed[0]!)).toMatchObject({ status: 'completed', summary: groupFact, actions: [] })
        return seedDone
      }
      expect(events[0]!.text).toBe(privateQuestion)
      if (completed.length === 1) {
        expect(result(completed[0]!)).toMatchObject({ status: 'completed', summary: missingFacts, actions: [] })
        expect(sends()).toEqual([])
        return { name: 'eating_list_contact_targets', arguments: {} }
      }
      if (completed.length === 2) {
        const listed = result(completed[1]!)
        const target = (listed.targets as JsonObject[]).find(row => row.agentTypeId === 'qq.group' && row.targetId === String(groupId))
        if (!target) throw new Error('Approved real group target missing from contact directory')
        expect(target.tools).toEqual(['qq_send_group_message', 'qq_get_group_info'])
        return { name: 'eating_contact_target', arguments: { mode: 'verify', target_id: target.id!, task: readOnlyTask } }
      }
      if (completed.length === 3) {
        expect(result(completed[2]!)).toMatchObject({ status: 'completed', summary: groupFact, actions: [] })
        expect(sends()).toEqual([])
        return { name: 'eating_delegate_task', arguments: { type_id: 'qq.private', context_ref: current.contextRef, task: `已向实际绑定群会话核实：${groupFact} 请结合当前私聊原话和人格，用简短自然的话回答主人；只向当前私聊发送，并报告真实回执。` } }
      }
      expect(completed).toHaveLength(4)
      expect(result(completed[3]!)).toMatchObject({ status: 'completed', summary: childDone, actions: [{ outcome: 'succeeded', result: { message_id: 1001 } }] })
      return rootDone
    }
    if (current.context.source === 'eating-contact') {
      expect(kind).toBe('verify')
      expect(events).toEqual([])
      expect(current.context.target).toMatchObject({ accountId: String(selfId), targetId: String(groupId), kind: 'group' })
      expect(current.payload.task).toBe(readOnlyTask)
      expect(current.payload.coordination).toEqual({ mode: 'verify', context_notes: '' })
      expect(names(request)).toEqual(['mcp__qq__qq_get_group_info'])
      const prior = request.messages?.slice(0, current.messageIndex).map(message => fixtureText(message.content)).join('\n') ?? ''
      expect(prior).toContain(groupSeed)
      expect(prior).toContain(groupFact)
      expect(prior).not.toContain(privateQuestion)
      expect(sends()).toEqual([])
      return groupFact
    }
    if (kind === 'verify' && current.context.agentTypeId === 'qq.group') {
      expect(events[0]!.text).toBe(groupSeed)
      expect(sends()).toEqual([])
      return groupFact
    }
    expect(current.context.agentTypeId).toBe('qq.private')
    expect(names(request)).toEqual(['mcp__qq__qq_send_private_message'])
    if (kind === 'quiet') {
      expect(events[0]!.text).toBe(quietText)
      expect(sends()).toEqual([])
      return childDone
    }
    if (kind === 'verify') {
      if (!String(current.payload.task).includes('已向实际绑定群会话核实')) {
        expect(events[0]!.text).toBe(privateQuestion)
        expect(JSON.stringify(request.messages)).not.toContain(groupSeed)
        expect(JSON.stringify(request.messages)).not.toContain(groupFact)
        expect(sends()).toEqual([])
        return missingFacts
      }
      expect(current.payload.task).toContain(groupFact)
      if (!completed.length) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(ownerId), message: verifiedReply, request_id: 'style-verified-private-001' } }
      expect(completed).toHaveLength(1)
      expect(result(completed[0]!)).toEqual({ message_id: 1001 })
      return childDone
    }
    expect(events[0]!.text).toBe(chatText)
    if (completed.length < bubbles.length) {
      expect(sends()).toHaveLength(completed.length)
      for (const [index, turn] of completed.entries()) expect(result(turn)).toEqual({ message_id: 1001 + index })
      return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(ownerId), message: bubbles[completed.length]!, request_id: requestIds[completed.length]! } }
    }
    expect(completed).toHaveLength(2)
    expect(completed.map(turn => result(turn))).toEqual([{ message_id: 1001 }, { message_id: 1002 }])
    return childDone
  })
  stops.push(() => model.close())
  const scopes: AgentInvocationScope[] = [], actionReads: { agentId: string; actions: readonly AgentActionReceipt[] }[] = []
  let plugin!: DshPlugin, services!: HarnessHostServices
  const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) {
    services = context.harness!
    plugin = new DshPlugin({ ...context, harness: { ...services,
      getMcpConnection(pluginId, scope, policy, taskId) {
        const connection = services.getMcpConnection(pluginId, scope, policy, taskId)
        scopes.push(structuredClone(scope))
        return connection
      },
      readTaskActions(agentId, taskId) {
        const snapshot = services.readTaskActions(agentId, taskId)
        const actions = snapshot.actions
        actionReads.push({ agentId, actions: structuredClone(actions) })
        return snapshot
      },
    } }, { locateSystemDsh: testSystemDsh })
    return plugin
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] })
  stops.push(() => host.close())
  for (const [id, body] of [['common', common], ['main', main], ['subagent', child], ['agent:qq.private', privateType], ['agent:qq.group', groupType]] as const) {
    const prompt = host.authoring.getSnapshot().prompts.find(prompt => prompt.id === id)!
    host.authoring.updatePrompt(id, body, prompt.revision)
  }
  const created = host.authoring.createPersona('小禾', persona)
  host.authoring.setPersonaEnabled(created.persona.id, true, created.snapshot.revision)
  const ownerSystem = composeAgentPrompt(host.authoring.readOwnerConfiguration(), null, {}).systemPrompt
  host.store.updateDeliverySettings({ ...host.store.getDeliverySettings(), aggregationWindowMs: 0 }, host.store.getDeliverySettingsSnapshot().revision)
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap')
  const boot = object(await bootstrap.json()), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const api = async (path: string, input?: JsonObject): Promise<JsonObject> => {
    const response = await fetch(url + '/api' + path, { method: input === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(60000),
      headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json', Origin: url },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const value = object(await response.json())
    if (!response.ok) throw new Error(`Conversation style fixture ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 5000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
  await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision!, owners: [String(ownerId)], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message'], 'qq.group': ['qq_get_group_info', 'qq_send_group_message'] } } })
  await api('/plugins/qq/connect', {})
  await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'conversation-style-loopback', apiKey: model.apiKey, maxTokens: 1024, timeoutMs: 30000, autoConnect: false })
  await api('/plugins/dsh/connect', {})
  if (kind === 'verify') {
    const initial = plugin.autonomy.snapshot()
    await api('/autonomy', { harnessId: 'dsh', operation: 'configure-contact-policy', input: {
      expectedRevision: object(initial.contactPolicy).revision!, expectedConfigurationRevision: initial.revision!, expectedActivityRevision: object(initial.state).revision!, mode: 'allowlist',
      entries: [{ pluginId: 'qq', instanceId: qq.instanceId!, accountId: String(selfId), agentTypeId: 'qq.group', targetId: String(groupId), label: 'Read-only verification loopback group' }],
    } })
  }
  const runtime = () => object(plugin.getPublicConfiguration().runtimeStatus)
  return { host, plugin, model, onebot, sends, scopes, actionReads, qq, ownerSystem, runtime, actions: (agentId: string) => services.readAgentActions(agentId),
    emit(text: string, messageId: number, group = false) {
      onebot.emitEvent({ post_type: 'message', message_type: group ? 'group' : 'private', self_id: selfId, user_id: ownerId,
        ...(group ? { group_id: groupId } : {}), message_id: messageId, message: text, raw_message: text, sender: { user_id: ownerId, nickname: 'Loopback owner', ...(group ? { role: 'member' } : {}) } })
    },
    diagnostic() { return { errors: model.errors, queue: host.harness.getStatus(), runtime: runtime(), requests: model.requests.map(request => ({ kind: envelope(request).kind, context: envelope(request).context, tools: names(request), last: request.messages?.at(-1) })) } },
  }
}

async function completed(f: Awaited<ReturnType<typeof fixture>>, summary = rootDone, accepted = 1) {
  try {
    await vi.waitUntil(() => {
      if (f.model.errors.length) throw new Error(f.model.errors.join('\n'))
      const status = f.host.harness.getStatus()
      return f.model.actions.at(-1) === summary && f.runtime().busy === false && status.accepted === accepted && status.queueMessages === 0
    }, { timeout: 30000, interval: 50 })
  } catch (error) { throw new Error(JSON.stringify(f.diagnostic()), { cause: error }) }
}
function expectSystemPolicies(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.model.requests.some(request => envelope(request).kind === 'root')).toBe(true)
  expect(f.model.requests.some(request => envelope(request).kind === 'child')).toBe(true)
  for (const request of f.model.requests) {
    const current = envelope(request), prompt = system(request)
    for (const text of [common, persona, SHARED_CONVERSATION_POLICY, '不能据此否认自己参与过', '不假装自动共享全部历史', '完整原文、代码、链接', '用户明确需要的详细说明保持完整', '不按固定字数、每个句号或每句话机械拆分', '分别调用实际发送工具', '每条独立发送使用不同且稳定的 request_id']) expect(prompt).toContain(text)
    expect(prompt).toContain('一条消息可以包含几句话，一次回复也可以连续发送多条消息')
    expect(prompt).toContain('普通短聊的两句话之间不要插大空行')
    expect(prompt).toContain('不必每条末尾都加')
    expect(prompt).not.toContain('一条讲清一个意思')
    for (const text of ['结合真实 @、引用对象、说话人和上下文判断', '先读本批实际提供的消息和主的协作事实', '选择不回应不等于没读或可以丢掉其他任务', '有相关内容可以自然加入，不必等点名', '只会复述附和时可以安静', '记忆只在当下自然相关且当前允许披露时提起', '旧消息不能自动当成刚发生', '不为显得像人而故意答错']) expect(prompt).toContain(text)
    expect(prompt).not.toContain('默认 1~10 字')
    expect(prompt).not.toContain('普通对话默认 1 条，最多 2 条')
    expect(prompt.split(SHARED_CONVERSATION_POLICY)).toHaveLength(2)
    if (current.kind === 'root') {
      expect(prompt.startsWith(f.ownerSystem + '\n\n')).toBe(true)
      expect(prompt).toContain(main)
      expect(prompt).toContain(MAIN_COORDINATION_POLICY)
      for (const text of [child, 'STYLE-CUSTOM-PRIVATE', 'STYLE-CUSTOM-GROUP', CHILD_COORDINATION_POLICY]) expect(prompt).not.toContain(text)
    } else {
      expect(prompt).toContain(child)
      expect(prompt).toContain(CHILD_COORDINATION_POLICY)
      const target = current.context.source === 'eating-contact' ? object(current.context.target) : current.context
      expect(prompt).toContain(`STYLE-CUSTOM-${target.kind === 'group' ? 'GROUP' : 'PRIVATE'}：${selfId}/${String(target.kind)}/${String(target.targetId)}。`)
      for (const text of [main, MAIN_COORDINATION_POLICY]) expect(prompt).not.toContain(text)
    }
  }
}

describe.runIf(enabled)('scripted system DSH conversation policy delivery and real loopback receipts, not real LLM preferences', () => {
  it('delivers shared identity and short-chat policies plus the correct role through both complete systems while preserving custom owner and persona bodies', async () => {
    const f = await fixture('quiet')
    f.emit(quietText, 88001)
    await completed(f)
    expectSystemPolicies(f)
    expect(f.model.requests.filter(request => !fixturePendingTask(request)).map(request => envelope(request).kind)).toEqual(['root', 'child', 'root'])
    expect(f.sends()).toEqual([])
    const final = f.model.requests.at(-1)!
    expect(result(turns(final)[0]!)).toMatchObject({ status: 'completed', summary: childDone, actions: [] })
    expect(f.host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'common')!.body).toBe(common)
    expect(f.host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'main')!.body).toBe(main)
    expect(f.host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'subagent')!.body).toBe(child)
  }, 60000)

  it('keeps multiple sentences together and sends a follow-on bubble separately with ordered independent receipts', async () => {
    const f = await fixture('bubbles')
    f.emit(chatText, 88002)
    await completed(f)
    expectSystemPolicies(f)
    expect(f.model.requests.filter(request => !fixturePendingTask(request)).map(request => envelope(request).kind)).toEqual(['root', 'child', 'child', 'child', 'root'])
    const children = f.model.requests.filter(request => envelope(request).kind === 'child')
    const actualCalls = turns(children.at(-1)!)
    expect(actualCalls.map(turn => ({ name: turn.name, arguments: turn.arguments }))).toEqual(bubbles.map((message, index) => ({ name: 'mcp__qq__qq_send_private_message', arguments: { user_id: String(ownerId), message, request_id: requestIds[index] } })))
    expect(f.sends().map(send => ({ action: send.action, userId: send.params.user_id, message: send.params.message }))).toEqual(bubbles.map(message => ({ action: 'send_private_msg', userId: ownerId, message })))
    expect(f.sends().every(send => typeof send.params.message === 'string' && !/\n\s*\n/.test(String(send.params.message)))).toBe(true)
    expect(String(f.sends()[0]!.params.message).match(/[。！？]/g)!.length).toBeGreaterThan(1)
    const receipt = result(turns(f.model.requests.at(-1)!)[0]!)
    expect(receipt).toMatchObject({ childId: f.scopes[0]!.agentId, status: 'completed', summary: childDone })
    expect(receipt.actions).toEqual(requestIds.map((requestId, index) => ({ requestId, tool: 'qq_send_private_message', outcome: 'succeeded', result: { message_id: 1001 + index } })))
    expect(f.actions(String(receipt.childId))).toEqual(receipt.actions)
    expect(f.actionReads).toContainEqual({ agentId: receipt.childId, actions: receipt.actions })
    expect(f.scopes).toHaveLength(1)
    expect(f.scopes[0]).toMatchObject({ agentTypeId: 'qq.private', pluginId: 'qq', instanceId: f.qq.instanceId, accountId: String(selfId), conversationId: `qq:${selfId}:private:${ownerId}`, kind: 'private', targetId: String(ownerId), messageIds: ['88002'], resourceIds: [] })
    for (const internal of [rootDone, childDone]) expect(JSON.stringify(f.sends().map(send => send.params))).not.toContain(internal)
  }, 60000)

  it('verifies genuine bound group history through main without a group send, then resumes the original private child with checked facts', async () => {
    const f = await fixture('verify')
    f.emit(groupSeed, 88003, true)
    await completed(f, seedDone)
    expect(f.sends()).toEqual([])
    const seedRoot = f.model.requests.find(request => envelope(request).kind === 'root')!
    const seedReceipt = result(turns(f.model.requests.at(-1)!)[0]!)
    const seedScope = f.scopes[0]!
    expect(seedScope).toMatchObject({ agentTypeId: 'qq.group', targetId: String(groupId), messageIds: ['88003'], resourceIds: [] })
    expect(seedReceipt.childId).toBe(seedScope.agentId)
    const start = f.model.requests.length
    f.emit(privateQuestion, 88004)
    await completed(f, rootDone, 2)
    expectSystemPolicies(f)
    const requests = f.model.requests.slice(start)
    const roots = requests.filter(request => envelope(request).kind === 'root')
    const rootCalls = turns(roots.at(-1)!)
    expect(rootCalls.map(turn => turn.name)).toEqual(['eating_handle_conversation', 'eating_list_contact_targets', 'eating_contact_target', 'eating_delegate_task'])
    const initial = result(rootCalls[0]!), verified = result(rootCalls[2]!), final = result(rootCalls[3]!)
    expect(initial).toMatchObject({ summary: missingFacts, actions: [] })
    expect(verified).toMatchObject({ childId: seedScope.agentId, summary: groupFact, actions: [] })
    expect(final.childId).toBe(initial.childId)
    expect(final.actions).toEqual([{ requestId: 'style-verified-private-001', tool: 'qq_send_private_message', outcome: 'succeeded', result: { message_id: 1001 } }])
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0]).toMatchObject({ action: 'send_private_msg', params: { user_id: ownerId, message: verifiedReply } })
    const scopes = f.scopes.slice(1)
    expect(scopes).toHaveLength(3)
    expect(scopes[0]).toMatchObject({ agentId: initial.childId, agentTypeId: 'qq.private', targetId: String(ownerId), messageIds: ['88004'], resourceIds: [] })
    expect(scopes[1]).toMatchObject({ agentId: seedScope.agentId, agentTypeId: 'qq.group', accountId: String(selfId), targetId: String(groupId), messageIds: [], resourceIds: [] })
    expect(scopes[2]).toMatchObject({ agentId: initial.childId, agentTypeId: 'qq.private', targetId: String(ownerId), messageIds: ['88004'], resourceIds: [] })
    expect(envelope(seedRoot).contextRef).not.toBe(envelope(roots[0]!).contextRef)
    const contact = requests.find(request => envelope(request).context.source === 'eating-contact')!
    expect(envelope(contact).payload.events).toEqual([])
    expect(envelope(contact).payload.task).toBe(readOnlyTask)
    expect(f.plugin.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'completed' }])
    expect(f.actions(String(final.childId))).toEqual(final.actions)
    expect(f.model.errors).toEqual([])
  }, 60000)
})
