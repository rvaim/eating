import { fixturePendingTask } from '../../../tests/fixtures/async-tasks'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { AgentInvocationScope, BackendPluginEntry, HarnessHostServices, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { readTestAgentBindings } from '../../../tests/fixtures/native-web'
import { readModelFixtureBatch } from '../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { fixtureToolTurns } from '../../../tests/fixtures/stickers-model'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { EatingHost } from './app'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of stops.splice(0).reverse()) try { await stop() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Delegation recovery fixture cleanup failed')
})
function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected an actual delegation recovery protocol object')
  return value
}
function batch(request: ModelFixtureRequest) {
  const value = readModelFixtureBatch(request)
  if (!value || !Array.isArray(value.payload.events) || value.payload.events.length !== 1) throw new Error('Expected one real current Eating event')
  return { ...value, event: object(value.payload.events[0]) }
}
const selfId = 100000301, userId = selfId + 1
const mainTools = ['eating_handle_conversation', 'eating_delegate_task', 'eating_list_agent_types', 'eating_activity_state', 'eating_plan_activity', 'eating_schedule_task', 'eating_cancel_scheduled_task', 'eating_list_contact_targets', 'eating_contact_target', 'eating_task_control'].sort()
const requestId = (id: string) => `delegation-recovery-send-${id}`

/** Scripted loopback responses exercise native execution and receipts, not real LLM decision quality. */
async function startRecoveryModel() {
  const requests: ModelFixtureRequest[] = [], errors: string[] = [], completed: string[] = []
  const apiKey = 'synthetic-recovery-only'
  let releaseHeld!: () => void
  const held = { promise: new Promise<void>(resolve => { releaseHeld = resolve }), resolve: () => releaseHeld() }
  let hanging = false
  const server = createServer((request, response) => { void (async () => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    if (request.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401).end(); return }
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); size += bytes.length
      if (size > 4 * 1024 * 1024) throw new Error('Recovery fixture request too large')
      chunks.push(bytes)
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelFixtureRequest
    requests.push(payload)
    const current = batch(payload), id = String(current.event.messageId), turns = fixtureToolTurns(payload)
    expect(['99301', '99302']).toContain(id)
    const tools = (payload.tools ?? []).map(tool => tool.function?.name ?? '').sort()
    const system = payload.messages?.filter(message => message.role === 'system') ?? []
    expect(system).toHaveLength(1)
    expect(JSON.stringify(system)).toContain('主 Agent 负责整体安排')
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    const chunk = (delta: JsonObject, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: `recovery-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const tool = (name: string, args: JsonObject) => {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_recovery_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      chunk({}, 'tool_calls')
    }
    if (current.kind === 'root') {
      expect(tools).toEqual(mainTools)
      if (fixturePendingTask(payload)) {
        if (id === '99301') {
          const deadline = Date.now() + 10000
          while (!hanging && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
          if (!hanging) throw new Error('Child did not reach its post-send fixture wait')
          const running = object(JSON.parse(turns[0]!.text))
          tool('eating_task_control', { action: 'interrupt', task_id: running.taskId! }); response.end('data: [DONE]\n\n'); return
        }
        chunk({ role: 'assistant', content: 'Waiting for native child result.' }); chunk({}, 'stop'); response.end('data: [DONE]\n\n'); return }
      if (!turns.length) tool('eating_handle_conversation', { context_ref: current.contextRef, mode: 'reply' })
      else {
        expect(turns.length).toBe(id === '99301' ? 2 : 1)
        expect(turns[0]!.name).toBe('eating_handle_conversation')
        if (id === '99301') expect(JSON.stringify(turns[0]!.taskResult ?? turns[0]!.text)).toMatch(/unknown|interrupted|未知|中断/i)
        else expect((turns[0]!.taskResult ?? object(JSON.parse(turns[0]!.text)))).toMatchObject({ status: 'completed', actions: [{ requestId: requestId(id), outcome: 'succeeded', result: { message_id: 1002 } }] })
        completed.push(id)
        chunk({ role: 'assistant', content: `RECOVERY-MAIN-DONE:${id}` }); chunk({}, 'stop')
      }
    } else {
      expect(tools).toEqual(['mcp__qq__qq_send_private_message'])
      expect(current.agentTypeId).toBe('qq.private')
      if (!turns.length) tool('mcp__qq__qq_send_private_message', { user_id: String(userId), message: `RECOVERY-REPLY:${id}`, request_id: requestId(id) })
      else {
        expect(turns).toHaveLength(1)
        expect((turns[0]!.taskResult ?? object(JSON.parse(turns[0]!.text)))).toEqual({ message_id: id === '99301' ? 1001 : 1002 })
        if (id === '99301') {
          // Hang only after the real OneBot success. Cleanup owns and releases this
          // deferred even when the runtime has already cancelled the HTTP stream.
          hanging = true
          chunk({ role: 'assistant' }); response.flushHeaders()
          await held.promise
          if (response.destroyed || response.writableEnded) return
        }
        chunk({ role: 'assistant', content: `RECOVERY-CHILD-DONE:${id}` }); chunk({}, 'stop')
      }
    }
    response.end('data: [DONE]\n\n')
  })().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end() }) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing recovery model loopback address')
  return { apiKey, requests, errors, completed, hanging: () => hanging, release: () => held.resolve(), endpoint: `http://127.0.0.1:${address.port}/v1`, async close() {
    held.resolve()
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections(); await closed
  } }
}

describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('ordinary delegation unknown recovery through system DSH', () => {
  it('settles the first interrupted task and successful action while a fresh inbound context reuses the same child without replay', async () => {
    const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'Eating_delegation_recovery_')))
    stops.push(async () => {
      const target = await realpath(home)
      if (target !== home || dirname(target) !== parent || !basename(target).startsWith('Eating_delegation_recovery_')) throw new Error('Unsafe recovery fixture cleanup')
      await rm(target, { recursive: true })
    })
    const model = await startRecoveryModel(); stops.push(() => model.close())
    const onebot = await startOneBotFixture({ login: { user_id: selfId, nickname: 'Recovery loopback account' } }); stops.push(() => onebot.close())
    const scopes: AgentInvocationScope[] = []
    let plugin!: DshPlugin, services!: HarnessHostServices
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) {
      services = context.harness!
      plugin = new DshPlugin({ ...context, harness: { ...services, getMcpConnection(pluginId, scope, policy, taskId) {
        const connection = services.getMcpConnection(pluginId, scope, policy, taskId)
        scopes.push(structuredClone(scope)); return connection
      } } }, { locateSystemDsh: testSystemDsh })
      return plugin
    } }
    const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    // Release our fixture before Host disposal, including assertion failure paths.
    stops.push(() => model.release())
    host.store.updateDeliverySettings({ ...host.store.getDeliverySettings(), aggregationWindowMs: 0 }, host.store.getDeliverySettingsSnapshot().revision)
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap')
    const boot = object(await bootstrap.json()), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const api = async (path: string, input: JsonObject) => {
      const response = await fetch(url + '/api' + path, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(input) })
      const value = object(await response.json())
      if (!response.ok) throw new Error(`Recovery API ${path}: ${response.status} ${JSON.stringify(value)}`)
      return value
    }
    const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: false, autoConnect: false })
    await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision!, owners: [], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message'], 'qq.group': [] } } })
    await api('/plugins/qq/connect', {})
    // Public configuration range is 1000..120000; timeoutMs remains
    // the individual request timeout. Main explicitly interrupts the held child.
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'recovery-scripted-model', apiKey: model.apiKey, maxTokens: 256, timeoutMs: 2000, autoConnect: false })
    await api('/plugins/dsh/connect', {})
    const runtime = () => object(plugin.getPublicConfiguration().runtimeStatus)
    const rootId = runtime().sessionId
    const sends = () => onebot.requests.filter(request => request.action.startsWith('send_'))
    const ledger = () => {
      // readAgentActions is intentionally per-task; inspect only this fresh
      // test home's persistent ledger to verify earlier receipts are retained.
      const database = new DatabaseSync(host.store.databasePath, { readOnly: true })
      try { return database.prepare('SELECT * FROM actions ORDER BY request_id').all() }
      finally { database.close() }
    }
    const diagnostic = () => ({ runtime: runtime(), queue: host.harness.getStatus(), errors: model.errors, requests: model.requests.map(request => ({ kind: batch(request).kind, id: batch(request).event.messageId, turns: fixtureToolTurns(request) })), sends: sends().map(({ action, params }) => ({ action, params })) })
    const waitDone = async (id: string, accepted: number) => {
      try {
        await vi.waitFor(() => {
          expect(model.errors).toEqual([])
          expect(model.completed).toContain(id)
          expect(runtime().busy).toBe(false)
          expect(host.harness.getStatus()).toMatchObject({ accepted, queueMessages: 0 })
        }, { timeout: 20000, interval: 50 })
      } catch (error) { throw new Error(JSON.stringify(diagnostic()), { cause: error }) }
    }
    const emit = (id: number) => onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: selfId, user_id: userId, message_id: id, message: [{ type: 'text', data: { text: `RECOVERY-INBOUND:${id}` } }], sender: { user_id: userId, nickname: 'Local recovery user' } })
    emit(99301)
    await waitDone('99301', 1)
    expect(model.hanging()).toBe(true)
    expect(sends()).toHaveLength(1)
    const firstBindings = await readTestAgentBindings(home)
    expect(firstBindings).toHaveLength(1)
    const first = firstBindings[0]!, childId = object(first.scope).agentId, unknown = object(first.task)
    expect(unknown).toMatchObject({ state: 'interrupted', taskId: expect.any(String), contextRef: expect.any(String) })
    expect(first.taskRefs).toEqual([unknown])
    const firstActions = structuredClone(services.readAgentActions(String(childId)))
    expect(firstActions).toMatchObject([{ requestId: requestId('99301'), outcome: 'succeeded', result: { message_id: 1001 } }])
    const firstLedger = ledger()
    expect(firstLedger).toHaveLength(1)
    expect(firstLedger[0]).toMatchObject({ plugin_id: 'qq', state: 'succeeded', result_json: JSON.stringify({ message_id: 1001 }) })
    model.release()
    emit(99302)
    await waitDone('99302', 2)
    expect(runtime().sessionId).toBe(rootId)
    const nextBindings = await readTestAgentBindings(home)
    expect(nextBindings).toHaveLength(1)
    const next = nextBindings[0]!, completed = object(next.task)
    expect(next.parentId).toBe(rootId)
    expect(object(next.scope).agentId).toBe(childId)
    expect(completed).toMatchObject({ state: 'completed', nonce: unknown.nonce })
    expect(completed.contextRef).not.toBe(unknown.contextRef)
    expect(completed.taskId).not.toBe(unknown.taskId)
    expect(next.taskRefs).toEqual([unknown, completed])
    expect(services.readAgentActions(String(childId))).toEqual([expect.objectContaining({ requestId: requestId('99302'), outcome: 'succeeded', result: { message_id: 1002 } })])
    const nextLedger = ledger()
    expect(nextLedger).toHaveLength(2)
    expect(nextLedger).toContainEqual(firstLedger[0])
    expect(nextLedger).toContainEqual(expect.objectContaining({ plugin_id: 'qq', state: 'succeeded', result_json: JSON.stringify({ message_id: 1002 }) }))
    expect(sends()).toHaveLength(2)
    expect(sends().map(send => send.params)).toEqual(['99301', '99302'].map(id => ({ user_id: userId, message: `RECOVERY-REPLY:${id}`, auto_escape: true })))
    expect(model.requests.filter(request => !fixturePendingTask(request)).map(request => `${batch(request).event.messageId}:${batch(request).kind}`)).toEqual(['99301:root', '99301:child', '99301:child', '99301:root', '99302:root', '99302:child', '99302:child', '99302:root'])
    expect(batch(model.requests.filter(request => !fixturePendingTask(request))[5]!).nativeParentId).toBe(rootId)
    expect(scopes).toHaveLength(2)
    for (const scope of scopes) expect(scope).toMatchObject({ agentId: childId, agentTypeId: 'qq.private', accountId: String(selfId), targetId: String(userId), kind: 'private' })
    expect(model.errors).toEqual([])
  }, 60000)
})
