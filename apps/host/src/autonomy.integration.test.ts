import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { replyOneBot, startOneBotFixture } from '../../../tests/fixtures/onebot'
import { EatingHost } from './app'

const systemBin = process.env.EATING_DSH_TEST_SYSTEM_BIN
const stops: Array<() => Promise<unknown>> = []
afterEach(async () => { const failures: unknown[] = []; for (const stop of stops.splice(0).reverse()) { try { await stop() } catch (error) { failures.push(error) } }; if (failures.length) throw new AggregateError(failures, 'Autonomy fixture cleanup failed') })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected autonomy fixture object'); return value }

async function fixture(withholdSend = false, scheduledOnly = false) {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'Eating_native_autonomy_')))
  stops.push(async () => { const actual = await realpath(home); if (actual !== home || dirname(actual) !== parent || !basename(actual).startsWith('Eating_native_autonomy_')) throw new Error('Unsafe autonomy fixture cleanup'); await rm(actual, { recursive: true }) })
  const targetId = '100000202', accountId = '100000101'
  const onebot = await startOneBotFixture({ login: { user_id: Number(accountId), nickname: 'Autonomy fixture' }, onRequest: (request, peer) => {
    if (request.action === 'get_friend_list') { replyOneBot(peer, request, [{ user_id: Number(targetId), nickname: 'Approved target', remark: '' }]); return true }
    return withholdSend && request.action === 'send_private_msg'
  } })
  stops.push(() => onebot.close())
  const requests: { main: boolean; tools: string[] }[] = [], modelErrors: string[] = [], scheduledSeen: string[] = []
  let mainCalls = 0, childCalls = 0
  const model = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const tools = (body.tools as JsonObject[]).map(tool => String(object(tool.function).name)), main = tools.includes('eating_contact_target')
    requests.push({ main, tools })
    const messages = body.messages as JsonObject[]
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'autonomy-fixture-' + requests.length, object: 'chat.completion.chunk', model: body.model, created: 1700000000, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const tool = (name: string, args: object) => { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls') }
    if (main) {
      if (scheduledOnly) {
        let scheduled = false
        for (const message of messages.filter(candidate => candidate.role === 'user')) {
          const content = message.content
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => isJsonObject(block) && typeof block.text === 'string' ? block.text : '').join('') : ''
          try { const envelope = JSON.parse(text); const tasks = envelope?.eating_autonomous_opportunity?.scheduledTasks; if (Array.isArray(tasks) && tasks.length) { scheduledSeen.push(...tasks.map(task => String(task.message))); scheduled = true } } catch { /* Not a structured envelope. */ }
        }
        if (scheduled) { chunk({ role: 'assistant', content: 'SCHEDULED-TASK-SEEN' }); chunk({}, 'stop'); return }
      }
      const stage = mainCalls++ % 5
      if (stage === 0) tool('eating_list_contact_targets', {})
      else if (stage === 1) {
        const last = [...messages].reverse().find(message => message.role === 'tool')!
        const listed = object(JSON.parse(String(last.content))), target = (listed.targets as JsonObject[]).find(row => row.targetId === targetId && row.agentTypeId === 'qq.private')
        if (!target) throw new Error('Current contact policy did not return the approved private target')
        tool('eating_contact_target', { target_id: target.id, task: 'Send the isolated loopback contact message to the approved target and report the real receipt.' })
      }
      else if (stage === 2) tool('eating_activity_state', {})
      else if (stage === 3) {
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
  if (scheduledOnly) {
    const directory = join(home, 'harness', 'dsh'), now = Date.now()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'autonomy-agenda.json'), JSON.stringify({ schemaVersion: 1, revision: 0, tasks: [{ id: randomUUID(), message: 'SELF-SCHEDULED-TASK', dueAt: now - 1000, createdAt: now - 5000 }] }))
  }
  const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await bootstrap.json() as { csrfToken: string }
  const api = async (path: string, input?: unknown) => {
    const response = await fetch(url + '/api' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': csrfToken, 'Content-Type': 'application/json', Origin: url }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(60000) })
    const value = object(await response.json()); if (!response.ok) throw new Error(`Autonomy owner fixture ${path}: ${response.status} ${JSON.stringify(value)}`); return value
  }
  const qq = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 10000 })
  await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qq.policyRevision, owners: [], administrators: [], agentTools: { 'qq.private': ['qq_send_private_message'], 'qq.group': [] } } })
  await api('/plugins/qq/connect', {})
  await api('/plugins/dsh/configuration', { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'isolated-native-autonomy', apiKey: 'synthetic-autonomy-only', timeoutMs: 30000, maxTokens: 128, autoConnect: false }); await api('/plugins/dsh/connect', {})
  const directory = await api('/autonomy'), channel = (directory.channels as JsonObject[]).find(row => row.agentTypeId === 'qq.private')!
  expect(channel.accountId).toBe(accountId)
  const initial = plugin.autonomy.snapshot()
  await api('/autonomy', { harnessId: 'dsh', operation: 'configure', input: { expectedRevision: initial.revision, configuration: { ...object(initial.configuration), enabled: true, minIntervalSeconds: 1, maxCyclesPerHour: 10, cycleTimeoutSeconds: 30 } } })
  const configured = plugin.autonomy.snapshot()
  await api('/autonomy', { harnessId: 'dsh', operation: 'configure-contact-policy', input: { expectedRevision: object(configured.contactPolicy).revision, expectedConfigurationRevision: configured.revision, expectedActivityRevision: object(configured.state).revision, mode: 'allowlist', entries: [{ pluginId: channel.pluginId, instanceId: channel.instanceId, accountId, agentTypeId: channel.agentTypeId, targetId, label: 'Isolated fixture contact' }] } })
  const state = () => object(plugin.autonomy.snapshot().state)
  const control = (operation: string) => api('/autonomy', { harnessId: 'dsh', operation, input: { expectedRevision: plugin.autonomy.snapshot().revision, expectedActivityRevision: state().revision } })
  return { home, onebot, plugin, requests, modelErrors, scheduledSeen, state, control, api, diagnostic: () => ({ state: state(), requests, modelErrors, scheduledSeen }) }
}

describe.runIf(Boolean(systemBin))('native autonomous activity with real scoped Host and loopback OneBot', () => {
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
    const f = await fixture(true)
    await f.control('resume')
    await vi.waitFor(() => expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1), { timeout: 20000, interval: 100 })
    await f.control('pause')
    await vi.waitFor(() => expect(f.state()).toMatchObject({ ownerPaused: true, active: null, lastOutcome: 'cancelled' }), { timeout: 10000, interval: 100 })
    expect(f.plugin.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'unknown' }])
    expect(f.onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    expect(f.modelErrors).toEqual([])
  }, 60000)
  it('delivers a seeded AI-authored task as the next native autonomous opportunity', async () => {
    const f = await fixture(false, true)
    await f.control('resume')
    try { await vi.waitFor(() => expect(f.scheduledSeen).toContain('SELF-SCHEDULED-TASK'), { timeout: 20000, interval: 100 }) }
    catch (error) { throw new Error(JSON.stringify(f.diagnostic()), { cause: error }) }
    expect(f.modelErrors).toEqual([])
    expect(f.plugin.autonomy.snapshot().agenda).toMatchObject({ revision: expect.any(Number), tasks: [] })
  }, 60000)
})
