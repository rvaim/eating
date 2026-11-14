import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import { EatingHost } from './app'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { startOneBotFixture, replyOneBot } from '../../../tests/fixtures/onebot'
import { fixtureText, startStickersModel } from '../../../tests/fixtures/stickers-model'
import { fixturePendingTask } from '../../../tests/fixtures/async-tasks'
import type { FixtureModelAction } from '../../../tests/fixtures/stickers-model'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected task fixture result'); return value }
describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('task lifetime over the actual system DSH and Host', () => {
  it('completes a contact with several successful requests whose total exceeds the configured request timeout', async () => {
    const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-task-lifetime-')))
    stops.push(async () => { if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-task-lifetime-')) throw new Error('Unsafe task fixture cleanup'); await rm(home, { recursive: true }) })
    let statusCalls = 0, childStarted = 0, sentAt = 0
    const remote = await startOneBotFixture({ onRequest: (request, peer) => {
      if (request.action === 'get_status') {
        if (++statusCalls === 2) childStarted = Date.now()
        setTimeout(() => replyOneBot(peer, request, { online: true, good: true }), 350); return true
      }
      if (request.action === 'send_private_msg') sentAt = Date.now()
    } }); stops.push(remote.close)
    let finished = false
    const model = await startStickersModel((request): FixtureModelAction => {
      const names = request.tools?.map(t => t.function?.name) ?? []
      const calls = new Map<string, { name: string; arguments: JsonObject }>()
      const turns: Array<{ name: string; text: string; taskResult?: JsonObject }> = []
      for (const message of request.messages ?? []) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const raw of message.tool_calls) {
          const value = object(raw), fn = object(value.function); calls.set(String(value.id), { name: String(fn.name), arguments: object(JSON.parse(String(fn.arguments))) })
        }
        if (message.role === 'tool') { const call = calls.get(String(Reflect.get(message, 'tool_call_id'))); if (call) turns.push({ name: call.name, text: fixtureText(message.content) }) }
      }
      const notices = new Map<string, JsonObject>()
      for (const message of request.messages ?? []) if (message.role === 'user') {
        try { const body = object(JSON.parse(fixtureText(message.content))); if (isJsonObject(body.eating_task_result)) notices.set(String(body.eating_task_result.taskId), body.eating_task_result) } catch { /* Actual conversation input. */ }
      }
      for (const turn of turns) { try { const value = JSON.parse(turn.text); if (notices.has(value.taskId)) turn.taskResult = notices.get(value.taskId) } catch { /* Real error text. */ } }

      if (names.includes('eating_contact_target')) {
        if (fixturePendingTask(request)) return 'WAITING-FOR-TASK'
        if (!turns.length) return { name: 'eating_list_contact_targets', arguments: {} }
        if (turns.at(-1)!.name === 'eating_list_contact_targets') {
          const targets = (turns.at(-1)!.taskResult ?? object(JSON.parse(turns.at(-1)!.text))).targets as JsonObject[]
          const target = targets.find(t => t.agentTypeId === 'qq.private')!
          return { name: 'eating_contact_target', arguments: { target_id: target.id!, mode: 'reply', task: 'Complete the isolated multi-step contact fixture.' } }
        }
        const result = turns.at(-1)!.taskResult!
        expect(result.status).toBe('completed'); expect(JSON.stringify(result.actions)).toContain('message_id')
        finished = true; return 'TASK-SETTLED'
      }
      expect(names).toContain('mcp__qq__qq_get_status')
      if (turns.filter(t => t.name === 'mcp__qq__qq_get_status').length < 7) return { name: 'mcp__qq__qq_get_status', arguments: {} }
      if (!turns.some(t => t.name === 'mcp__qq__qq_send_private_message')) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: 987654321, message: 'ISOLATED-LONG-CONTACT', request_id: 'long-contact-fixture-001' } }
      return 'CHILD-FINISHED'
    }); stops.push(model.close)
    let dsh!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { dsh = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return dsh } }
    const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    host.store.updateDeliverySettings({ ...host.store.getDeliverySettings(), aggregationWindowMs: 0 }, host.store.getDeliverySettingsSnapshot().revision)
    const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), boot = await bootstrap.json(), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const api = async (path: string, body: object) => {
      const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': boot.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value
    }
    await api('/plugins/qq/configuration', { endpoint: remote.endpoint, forwardToHarness: true, autoConnect: false }); await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-task-lifetime', apiKey: model.apiKey, timeoutMs: 2000, autoConnect: false }); await api('/plugins/dsh/connect', {})
    const snapshot = dsh.autonomy.snapshot(), channel = object((await (await fetch(url + '/api/autonomy', { headers: { Cookie: cookie } })).json()).channels.find((row: JsonObject) => row.agentTypeId === 'qq.private'))
    await api('/autonomy', { harnessId: 'dsh', operation: 'configure-contact-policy', input: { expectedRevision: object(snapshot.contactPolicy).revision, expectedConfigurationRevision: snapshot.revision, expectedActivityRevision: object(snapshot.state).revision,
      mode: 'allowlist', entries: [{ pluginId: 'qq', instanceId: channel.instanceId, accountId: channel.accountId, agentTypeId: 'qq.private', targetId: '987654321', label: 'Isolated lifetime contact' }] } })
    remote.emitEvent({ post_type: 'message', message_type: 'group', self_id: 123456789, group_id: 123456, user_id: 987654321, message_id: 99001, message: 'CONTACT-LIFETIME-FIXTURE' })
    await vi.waitFor(() => { expect(model.errors, model.errors.join('\n')).toEqual([]); expect(finished).toBe(true) }, { timeout: 30000, interval: 50 })
    expect(sentAt - childStarted).toBeGreaterThan(2000)
    expect(remote.requests.filter(r => r.action === 'send_private_msg')).toHaveLength(1)
    expect(dsh.autonomy.snapshot().contactTasks).toMatchObject([{ state: 'completed', receiptsAvailable: true, reviewRequired: false, knownActions: 1, unknownActions: 0 }])
    expect(host.store.getSetting('host:agent-task-actions')).not.toContain('ISOLATED-LONG-CONTACT')
  }, 60000)
})
