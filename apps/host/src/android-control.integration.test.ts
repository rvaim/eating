import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import androidEntry from '../../../plugins/capabilities/android-control/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { EatingHost } from './app'
import { createInstalledHost } from './installed-host'
import { installPluginPackage } from './plugin-installation'
import { writeAdbFixture } from '../../../tests/fixtures/adb'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { startStickersModel, fixtureText } from '../../../tests/fixtures/stickers-model'
import type { FixtureModelAction } from '../../../tests/fixtures/stickers-model'
import { readModelFixtureBatch } from '../../../tests/fixtures/openai'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); vi.unstubAllEnvs() })
function object(v: unknown): JsonObject { if (!isJsonObject(v)) throw Error('Invalid actual integration value'); return v }
describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('完整ADB与独立原生手机子代理', () => {
  it.each(['source-usb', 'installed-network'])('passes actual image input, handles main input while the child is busy and resumes the same role (%s)', async variant => {
    const installed = variant === 'installed-network'
    const system = testSystemDsh(); vi.stubEnv('EATING_DSH_BIN', system.bin)
    const parent = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(parent, 'eating-android-native-')))
    stops.push(async () => { if (await realpath(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-android-native-')) throw Error('Unsafe integration cleanup'); await rm(directory, { recursive: true }) })
    const adb = await writeAdbFixture(directory), onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    let release!: () => void, imageReceived = false, mainHandled = false, completed = 0
    const gate = new Promise<void>(resolve => { release = resolve }); stops.push(() => release())
    const handled = new Set<string>(), marker = 'EDITABLE-ANDROID-INSTRUCTIONS'
    const model = await startStickersModel(async (request): Promise<FixtureModelAction> => {
      const names = request.tools?.map(tool => tool.function?.name) ?? []
      const systemText = JSON.stringify(request.messages?.filter(message => message.role === 'system'))
      expect(systemText).toContain(marker)
      if (names.includes('eating_start_execution')) {
        const batch = readModelFixtureBatch(request)
        if (!batch) return 'MAIN-EXECUTION-NOTICE-RECEIVED'
        const text = JSON.stringify(batch.payload.events)
        if (text.includes('MAIN-SECOND-MESSAGE')) { mainHandled = true; return 'MAIN-HANDLED-WHILE-PHONE-RUNS' }
        if (!handled.has(batch.contextRef)) { handled.add(batch.contextRef); return { name: 'eating_start_execution', arguments: { type_id: 'android-control.phone', task: '自主使用完整ADB检查执行端，读取真实手机截图并回报。' } } }
        return 'MAIN-CONTINUES-INDEPENDENTLY'
      }
      expect(names).toContain('mcp__plugin_android_control__android_adb_exec')
      expect(names.some(name => name?.startsWith('mcp__qq__'))).toBe(false)
      let at = -1
      for (const [index, message] of (request.messages ?? []).entries()) {
        const raw = fixtureText(message.content).replace(/^Agent [a-f0-9-]{36} sent a message: /i, '')
        try { if (isJsonObject(JSON.parse(raw).eating_execution)) at = index } catch { /* Other native user message. */ }
      }
      expect(at).toBeGreaterThan(-1)
      const task = object(JSON.parse(fixtureText(request.messages![at]!.content).replace(/^Agent [a-f0-9-]{36} sent a message: /i, '')))
      expect(task).not.toHaveProperty('events')
      const results = request.messages!.slice(at + 1).filter(message => message.role === 'tool')
      if (!results.length) return { name: 'mcp__plugin_android_control__android_adb_exec', arguments: { args: ['unlisted-adb-command', 'literal 参数'], wait_ms: 5000, request_id: 'android-native-command-' + String(object(task.eating_execution).taskId).slice(0, 16) } }
      if (results.length === 1) {
        const value = object(JSON.parse(fixtureText(results[0]!.content)))
        expect(JSON.parse(String(value.text))).toEqual(['unlisted-adb-command', 'literal 参数'])
        return { name: 'mcp__plugin_android_control__android_screenshot', arguments: {} }
      }
      const images = request.messages!.flatMap(message => Array.isArray(message.content) ? message.content.filter(isJsonObject).filter(block => block.type === 'image_url') : [])
      expect(images.length).toBeGreaterThan(0); imageReceived = true
      await gate; completed++; return 'PHONE-HAS-REAL-SCREEN-AND-COMMAND-RECEIPTS'
    }, { allowPending: true }); stops.push(() => model.close())
    const entries: BackendPluginEntry[] = [qqEntry, androidEntry, { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create: context => new DshPlugin(context, { locateSystemDsh: () => system }) }]
    if (installed) for (const p of ['communication/qq', 'harness/dsh', 'capabilities/android-control']) await installPluginPackage(directory, fileURLToPath(new URL('../../../plugins/' + p + '/dist/', import.meta.url)))
    const host = installed ? await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [] }) : new EatingHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], entries })
    stops.push(() => host.close())
    host.store.updateDeliverySettings({ ...host.store.getDeliverySettings(), aggregationWindowMs: 0 }, host.store.getDeliverySettingsSnapshot().revision)
    const url = await host.listen(), response = await fetch(url + '/api/bootstrap'), boot = object(await response.json()), cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const api = async (path: string, body: object) => { const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = object(await response.json()); expect(response.ok, JSON.stringify(value)).toBe(true); return value }
    await api('/plugins/android-control/configuration', { expectedRevision: 0, connectionMode: installed ? 'network' : 'usb', networkAddress: installed ? '192.168.1.50:5555' : '', defaultDevice: '', adbPath: adb, workspace: '' })
    if (installed) await api('/plugins/android-control/manage', { operation: 'connect-device', input: { address: '192.168.1.50:5555' } })
    await api('/plugins/android-control/connect', {})
    const prompt = host.authoring.getSnapshot().prompts.find(p => p.id === 'plugin:android-control.instructions')!
    host.authoring.updatePrompt(prompt.id, marker + '\n' + prompt.body, prompt.revision)
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, forwardToHarness: true, receiveGroups: true, autoConnect: false }); await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'isolated-phone-model', apiKey: model.apiKey, timeoutMs: 30000, autoConnect: false }); await api('/plugins/dsh/manage', { operation: 'save-model-capabilities', input: { expectedRevision: 0, imageInput: true } }); await api('/plugins/dsh/connect', {})
    const emit = (id: number, text: string) => onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: id, message: text })
    const diagnostics = () => JSON.stringify({ errors: model.errors, requests: model.requests.length, completed, imageReceived })
    emit(98001, 'START-PHONE')
    await expect.poll(() => imageReceived, { timeout: 30000, message: diagnostics() }).toBe(true)
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'harness/dsh/bridge/deliveries.json'), 'utf8')).deliveries, { timeout: 5000 }).toEqual([])
    emit(98002, 'MAIN-SECOND-MESSAGE')
    await expect.poll(() => mainHandled, { timeout: 15000, message: diagnostics() }).toBe(true)
    expect(completed).toBe(0)
    release()
    await expect.poll(() => completed, { timeout: 15000, message: diagnostics() }).toBe(1)
    const stateFile = join(directory, 'harness/dsh/execution-bindings.json')
    await expect.poll(async () => JSON.parse(await readFile(stateFile, 'utf8')).bindings[0]?.tasks[0]?.state, { timeout: 15000 }).toBe('completed')
    const before = JSON.parse(await readFile(stateFile, 'utf8'))
    await api('/plugins/dsh/disconnect', {}); await api('/plugins/dsh/connect', {})
    emit(98003, 'START-PHONE-AGAIN')
    await expect.poll(() => completed, { timeout: 30000, message: diagnostics() }).toBe(2)
    await expect.poll(async () => JSON.parse(await readFile(stateFile, 'utf8')).bindings[0]?.tasks.at(-1)?.state, { timeout: 15000 }).toBe('completed')
    const after = JSON.parse(await readFile(stateFile, 'utf8')); expect(after.bindings[0].agentId).toBe(before.bindings[0].agentId); expect(after.bindings[0].tasks).toHaveLength(2)
    expect(model.errors).toEqual([]); expect(onebot.requests.some(r => r.action.startsWith('send_'))).toBe(false)
  }, 90000)
})
