import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { connectNativeWeb } from '../../../tests/fixtures/native-web'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot'
import { EatingHost } from './app'

const systemBin = process.env.EATING_DSH_TEST_SYSTEM_BIN
const stops: Array<() => Promise<unknown>> = []
afterEach(async () => { const failures: unknown[] = []; for (const stop of stops.splice(0).reverse()) { try { await stop() } catch (error) { failures.push(error) } }; if (failures.length) throw new AggregateError(failures, 'Autonomy fixture cleanup failed') })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected autonomy fixture object'); return value }

async function fixture({ withholdSend = false, autonomyEnabled = true } = {}) {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'Eating_native_autonomy_')))
  stops.push(async () => { const actual = await realpath(home); if (actual !== home || dirname(actual) !== parent || !basename(actual).startsWith('Eating_native_autonomy_')) throw new Error('Unsafe autonomy fixture cleanup'); await rm(actual, { recursive: true }) })
  const targetId = '100000202', accountId = '100000101'
  const onebot = await startOneBotFixture({ login: { user_id: Number(accountId), nickname: 'Autonomy fixture' }, onRequest: (request, peer) => {
    if (request.action === 'get_friend_list') { replyOneBot(peer, request, [{ user_id: Number(targetId), nickname: 'Approved target', remark: '' }]); return true }
    return withholdSend && request.action === 'send_private_msg'
  } })
  stops.push(() => onebot.close())
  const requests: { main: boolean; tools: string[]; messages: JsonObject[] }[] = [], modelErrors: string[] = []
  let mainCalls = 0, childCalls = 0
  const model = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const tools = (body.tools as JsonObject[]).map(tool => String(object(tool.function).name)), main = tools.includes('eating_contact_target')
    const messages = body.messages as JsonObject[]
    requests.push({ main, tools, messages })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'autonomy-fixture-' + requests.length, object: 'chat.completion.chunk', model: body.model, created: 1700000000, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const tool = (name: string, args: object) => { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls') }
    if (main) {
      const stage = mainCalls++ % (autonomyEnabled ? 5 : 3)
      if (stage === 0) tool('eating_list_contact_targets', {})
      else if (stage === 1) {
        const last = [...messages].reverse().find(message => message.role === 'tool')!
        const listed = object(JSON.parse(String(last.content))), target = (listed.targets as JsonObject[]).find(row => row.targetId === targetId && row.agentTypeId === 'qq.private')
        if (!target) throw new Error('Current contact policy did not return the approved private target')
        tool('eating_contact_target', { target_id: target.id, task: 'Send the isolated loopback contact message to the approved target and report the real receipt.' })
      }
      else if (autonomyEnabled && stage === 2) tool('eating_activity_state', {})
      else if (autonomyEnabled && stage === 3) {
        const last = [...messages].reverse().find(message => message.role === 'tool')!
        const snapshot = object(JSON.parse(String(last.content)))
        tool('eating_plan_activity', { expected_revision: object(snapshot.state).revision, mode: 'waiting', wake_at: null, note: 'Fixture contact has been attempted; wait for an external event.' })
      } else { chunk({ role: 'assistant', content: 'AUTONOMY-FIXTURE-ROOT-DONE' }); chunk({}, 'stop') }
    } else {
      if (childCalls++ % 2 === 0) tool('mcp__qq__qq_send_private_message', { user_id: targetId, message: 'ISOLATED-AUTONOMOUS-CONTACT', request_id: 'autonomy-native-contact-write' })
      else { chunk({ role: 'assistant', content: 'AUTONOMY-FIXTURE-CHILD-DONE' }); chunk({}, 'stop') }
    }
    response.end('data: [DONE]\n\n')
  })().catch(error => { modelErrors.push(error instanceof Error ? error.message : 'Fixture model failure'); if (!response.headersSent) response.writeHead(500); response.end() }) })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  stops.push(() => new Promise<void>((resolve, reject) => { model.close(error => error ? reject(error) : resolve()); model.closeAllConnections() }))
  const address = model.address(); if (!address || typeof address === 'string') throw new Error('Missing model fixture address')
  const version = spawnSync(systemBin!, ['--version'], { encoding: 'utf8', timeout: 10000 }); if (version.status !== 0) throw new Error('System DSH version probe failed')
  let plugin!: DshPlugin
  const entry: BackendPluginEntry = { kind: 'harness', id: 'dsh', storageDirectory: 'dsh', create: context => {
    plugin = new DshPlugin(context, { locateSystemDsh: () => ({ bin: systemBin!, version: version.stdout.trim(), source: 'override' }) }); return plugin
  } }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await bootstrap.json() as { csrfToken: string }
  const api = async (path: string, input?: unknown) => {
    const response = await fetch(url + '/api' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': csrfToken, 'Content-Type': 'application/json', Origin: url }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(60000) })
    const value = object(await response.json()); if (!response.ok) throw new Error(`Autonomy owner fixture ${path}: ${response.status} ${JSON.stringify(value)}`); return value
  }
  const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 10000, autoConnect: false, forwardToHarness: true, receiveGroups: true })
  await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision, owners: [], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message'], 'qq.group': [] } } })
  await api('/plugins/qq/connect', {})
  await api('/plugins/dsh/configuration', { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'isolated-native-autonomy', apiKey: 'synthetic-autonomy-only', timeoutMs: 30000, maxTokens: 128, autoConnect: false }); await api('/plugins/dsh/connect', {})
  const directory = await api('/autonomy'), channel = (directory.channels as JsonObject[]).find(row => row.agentTypeId === 'qq.private')!
  expect(channel.accountId).toBe(accountId)
  const initial = plugin.autonomy.snapshot()
  await api('/autonomy', { harnessId: 'dsh', operation: 'configure', input: { expectedRevision: initial.revision, configuration: { ...object(initial.configuration), enabled: autonomyEnabled, minIntervalSeconds: 1, maxCyclesPerHour: 10, cycleTimeoutSeconds: 30 } } })
  const configured = plugin.autonomy.snapshot()
  await api('/autonomy', { harnessId: 'dsh', operation: 'configure-contact-policy', input: { expectedRevision: object(configured.contactPolicy).revision, expectedConfigurationRevision: configured.revision, expectedActivityRevision: object(configured.state).revision, mode: 'allowlist', entries: [{ pluginId: channel.pluginId, instanceId: channel.instanceId, accountId, agentTypeId: channel.agentTypeId, targetId, label: 'Isolated fixture contact' }] } })
  const state = () => object(plugin.autonomy.snapshot().state)
  const control = (operation: string) => api('/autonomy', { harnessId: 'dsh', operation, input: { expectedRevision: plugin.autonomy.snapshot().revision, expectedActivityRevision: state().revision } })
  return { home, host, onebot, plugin, requests, modelErrors, state, control, api, diagnostic: () => ({ state: state(), requests: requests.map(({ main, tools, messages }) => ({ main, tools, last: messages.at(-1) })), modelErrors, runtime: plugin.getPublicConfiguration().runtimeStatus, queue: host.harness.getStatus() }) }
}

async function expectOrdinaryContact(f: Awaited<ReturnType<typeof fixture>>) {
  try {
    await vi.waitFor(() => {
      expect(f.requests.filter(request => request.main)).toHaveLength(3)
      expect(f.plugin.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'completed' }])
      expect(object(f.plugin.getPublicConfiguration().runtimeStatus).busy).toBe(false)
    }, { timeout: 20000, interval: 100 })
  } catch (error) { throw new Error(JSON.stringify(f.diagnostic()), { cause: error }) }
  const writes = f.onebot.requests.filter(request => request.action.startsWith('send_'))
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ action: 'send_private_msg', params: { user_id: 100000202, message: 'ISOLATED-AUTONOMOUS-CONTACT' } })
  const main = f.requests.filter(request => request.main), children = f.requests.filter(request => !request.main)
  expect(children).toHaveLength(2)
  for (const child of children) expect(child.tools).toEqual(['mcp__qq__qq_send_private_message'])
  const childReceipt = [...children[1]!.messages].reverse().find(message => message.role === 'tool')!
  expect(JSON.parse(String(childReceipt.content))).toEqual({ message_id: 1001 })
  const receipt = [...main[2]!.messages].reverse().find(message => message.role === 'tool')!
  expect(JSON.parse(String(receipt.content))).toMatchObject({ status: 'completed', actions: [{ tool: 'qq_send_private_message', outcome: 'succeeded' }] })
  const calls = main[2]!.messages.filter(message => message.role === 'assistant').flatMap(message => Array.isArray(message.tool_calls) ? message.tool_calls : []).map(object)
  expect(calls.map(call => object(call.function).name)).toEqual(['eating_list_contact_targets', 'eating_contact_target'])
  expect(JSON.parse(String(object(calls[0]!.function).arguments))).toEqual({})
  expect(Object.keys(object(JSON.parse(String(object(calls[1]!.function).arguments)))).sort()).toEqual(['target_id', 'task'])
  expect(f.plugin.autonomy.snapshot()).toMatchObject({ configuration: { enabled: false }, state: { ownerPaused: true, active: null, cycles: 0, lastOutcome: null, history: [] } })
  expect(f.modelErrors).toEqual([])
  const childInput = children[0]!.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('eating-contact'))!
  const payload = object(JSON.parse(String(childInput.content)))
  expect(payload).toMatchObject({ eating: { agentTypeId: 'qq.private' }, context: { source: 'eating-contact', target: { accountId: '100000101', targetId: '100000202', kind: 'private' } }, events: [] })
  return payload
}

describe.runIf(Boolean(systemBin))('native main contact with real scoped Host and loopback OneBot', () => {
  it('privately contacts an approved target requested from a group while timed autonomy is disabled and owner-paused', async () => {
    const f = await fixture({ autonomyEnabled: false })
    expect(f.requests).toHaveLength(0)
    expect(f.plugin.autonomy.snapshot()).toMatchObject({ configuration: { enabled: false }, state: { ownerPaused: true } })
    const text = 'GROUP-PRIVATE-CONTACT-REQUEST: Please privately contact approved target 100000202.'
    f.onebot.emitEvent({ post_type: 'message', message_type: 'group', self_id: 100000101, group_id: 123456, user_id: 100000303, message_id: 2101, message: text, raw_message: text, sender: { user_id: 100000303, nickname: 'Loopback group member', role: 'member' } })
    const child = await expectOrdinaryContact(f)
    expect(f.host.harness.getStatus()).toMatchObject({ accepted: 1, queueMessages: 0 })
    const rootInput = f.requests.find(request => request.main)!.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(text))!
    const incoming = object(JSON.parse(String(rootInput.content)))
    expect(incoming).toMatchObject({ context: { agentTypeId: 'qq.group' }, events: [{ targetId: '123456', messageId: '2101', source: { kind: 'group' } }] })
    expect(object(child.eating).contextRef).not.toBe(object(incoming.eating).batchId)
    expect(JSON.stringify(child)).not.toContain(text)
  }, 60000)

  it('contacts an approved target from the official native main input without QQ ingress or a timed autonomy opportunity', async () => {
    const f = await fixture({ autonomyEnabled: false })
    expect(f.requests).toHaveLength(0)
    const entry = object(await f.plugin.manage('open-native-web', {}))
    const web = await connectNativeWeb(entry, String(entry.rootSessionId))
    const text = 'NATIVE-MAIN-CONTACT-REQUEST: Please privately contact approved target 100000202.'
    expect(await web.rpc('session/prompt', { request: { sessionId: web.rootSessionId, requestId: randomUUID(), mode: 'steer', content: [{ type: 'text', text }] } })).toMatchObject({ accepted: true })
    await expectOrdinaryContact(f)
    expect(f.host.harness.getStatus()).toMatchObject({ accepted: 0, queueMessages: 0 })
    expect(JSON.stringify(f.requests.find(request => request.main)!.messages)).toContain(text)
    await vi.waitFor(async () => expect(await web.events(web.rootSessionId)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn/end', data: expect.objectContaining({ reason: expect.objectContaining({ kind: 'completed' }) }) })])), { timeout: 10000, interval: 100 })
  }, 60000)

  it('uses a native child to contact only an approved target without any incoming message and records a real write receipt', async () => {
    const f = await fixture()
    expect(f.requests).toHaveLength(0)
    await f.control('resume')
    try { await vi.waitFor(() => expect(f.state()).toMatchObject({ mode: 'waiting', lastOutcome: 'completed', contacts: 1 }), { timeout: 20000, interval: 100 }) }
    catch (error) { throw new Error(JSON.stringify(f.diagnostic()), { cause: error }) }
    const writes = f.onebot.requests.filter(request => request.action === 'send_private_msg')
    expect(writes).toHaveLength(1); expect(writes[0]!.params.user_id).toBe(100000202)
    expect(f.requests.filter(request => !request.main).every(request => JSON.stringify(request.tools) === JSON.stringify(['mcp__qq__qq_send_private_message']))).toBe(true)
    expect(f.plugin.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'completed' }])
    expect(f.modelErrors).toEqual([])
  }, 60000)

  it('pauses a pending native contact, retains its unknown outcome and prevents replay through a later stale completion', async () => {
    const f = await fixture({ withholdSend: true })
    await f.control('resume')
    await vi.waitFor(() => expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1), { timeout: 20000, interval: 100 })
    await f.control('pause')
    await vi.waitFor(() => expect(f.state()).toMatchObject({ ownerPaused: true, active: null, lastOutcome: 'cancelled' }), { timeout: 10000, interval: 100 })
    expect(f.plugin.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'unknown' }])
    expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    expect(f.modelErrors).toEqual([])
  }, 60000)
})
