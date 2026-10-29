import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostPluginContext } from '@eating/plugin-sdk'
import { DshPlugin } from './adapter'
import { DshRuntimeInstallation } from './runtime'
import { DshSessionFile, readRestrictedJson } from './config'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
interface Event { seq: number; time: number; type: string; data: unknown }
interface NativeSession { header: object; append(type: string, data: unknown, opts?: unknown): Event; snapshotEvents(): Event[] }

async function fixture() {
  const parent = realpathSync(tmpdir()), home = realpathSync(mkdtempSync(join(parent, 'eating-official-native-web-')))
  stops.push(() => { if (realpathSync(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-official-native-web-')) throw new Error('Unsafe native Web cleanup'); rmSync(home, { recursive: true }) })
  const installation = new DshRuntimeInstallation(resolve(runtimeDirectory!)); stops.push(() => installation.dispose())
  const request = createRequire(installation.resolve().dshBin)
  const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(request.resolve(`@deepseek-ai/${name}`)).href)
  const [cordis, jsonl, native, llm, projections] = await Promise.all([load('cordis'), load('dsh-session-persistence-jsonl'), load('dsh-session'), load('dsh-llm'), load('dsh-session-format-catalog/message-projections')])
  const rootId = randomUUID(), otherId = randomUUID(), workspace = join(home, 'workspace'); mkdirSync(workspace, { recursive: true })
  const sessionRoot = join(home, 'dsh-home', 'sessions'); mkdirSync(sessionRoot, { recursive: true })
  const ctx = new cordis.Context(); await ctx.plugin(jsonl, { root: sessionRoot, compression: 'none' })
  const contextRef = 'a'.repeat(64), context = { contextRef, agentTypeId: 'qq.group', platform: 'qq', accountId: '10001', instanceId: 'fixture-instance', conversationId: 'qq:10001:group:30003', kind: 'group', reason: 'quiet-window', ownerRevision: 0 }
  const events = [{ protocolVersion: 1, eventId: 'native-event', pluginId: 'qq', platform: 'qq', instanceId: 'fixture-instance', accountId: '10001', conversationId: context.conversationId, senderId: '20002', targetId: '30003', receivedAt: '2026-10-29T12:00:00Z', text: 'NATIVE-PLATFORM-MESSAGE', content: 'NATIVE-PLATFORM-MESSAGE', resourceIds: [], source: { trust: 'external', kind: 'group', senderRole: 'user' } }]
  const envelope = { eating: { magic: 'eating-harness-delivery', protocolVersion: 1, nonce: 'fixture-native-nonce', sessionId: rootId, batchId: contextRef, digest: createHash('sha256').update(JSON.stringify({ context, events })).digest('hex') }, context, events }
  for (const id of [rootId, otherId]) {
    const session: NativeSession = native.Session.create(id, undefined, { id, version: native.SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: workspace, isSeeded: false }, 0, projections.currentSessionMessageProjections)
    session.append('session/title', { title: id === rootId ? 'Native original root' : 'Other native session', messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('NATIVE-SYSTEM-CONTEXT') }, { surfaceOp: 'append' })
    session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: id === rootId ? JSON.stringify(envelope) : 'OTHER-NATIVE-TEXT' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const block = { type: 'text', text: 'NATIVE-MODEL-OUTPUT' }
    session.append('assistant/message', { turn: 1, step: 1, message: llm.createAssistantMessage({ content: [block], source: { provider: 'fixture', model: 'fixture-model' } }), stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'block-start', index: 0, blockType: 'text' } }, { type: 'chunk', time: Date.now(), chunk: { type: 'block-end', index: 0, block } }] }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const handle = await ctx.sessionPersistence.create(session.header); try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
  }
  await ctx.fiber.dispose()
  new DshSessionFile(home).write({ sessionId: rootId, created: true })
  let sdk: DeepSeekHarness | undefined
  const contextHost: HostPluginContext = { dataDirectory: home, getSetting: () => null, setSetting: vi.fn(), recordEvent: vi.fn(), listMessages: () => [], executeIdempotent: vi.fn(),
    harness: { registerSink: () => () => {}, wake: vi.fn(), readOwnerConfiguration: () => ({ revision: 0, prompts: (['common', 'main', 'subagent'] as const).map(scope => ({ id: scope, scope, source: 'owner' as const, title: scope, body: 'NATIVE-OWNER-SYSTEM', revision: 0, updatedAt: null })), pluginInstructions: [], agentTypes: [], activePersona: null, bindings: { 主人: '', 管理员: '' } }), readAgentActions: () => [], revokeAgentAccess: vi.fn(), getMcpConnection: () => { throw new Error('No fixture action may grant MCP') } } }
  const plugin = new DshPlugin(contextHost, { runtime: installation, createHarness: options => (sdk = new DeepSeekHarness(options)) })
  stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ endpoint: 'http://127.0.0.1:1/v1', model: 'fixture-model', timeoutMs: 10000 })
  try { await plugin.connect() } catch (error) { throw new Error(String(error) + '\n' + JSON.stringify({ stderr: sdk ? Reflect.get(sdk.client, 'stderrTail') : plugin.getStatus(), bridge: readRestrictedJson(join(home, 'bridge', 'error.json')) })) }
  const entry = await plugin.manage('open-native-web', {}) as { url: string; rootSessionId: string }
  const origin = new URL(entry.url).origin
  const auth = await fetch(entry.url, { redirect: 'manual' }); expect(auth.status).toBe(303)
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
  const rpc = async (endpoint: string, args: object) => {
    const response = await fetch(origin + '/api/' + endpoint, { method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }) })
    return { status: response.status, body: await response.text() }
  }
  return { plugin, sdk: sdk!, rootId, otherId, home, workspace, entry, origin, rpc }
}

// This test exercises the current official browser application. It never sends a model prompt.
describe.runIf(Boolean(runtimeDirectory))('official native Web in the SDK process', () => {
  it('keeps the official UI, owner commands, standard composer and native system light/dark themes', async () => {
    const f = await fixture()
    expect(Object.keys(f.entry).sort()).toEqual(['rootSessionId', 'url'])
    expect(f.entry.rootSessionId).toBe(f.rootId)
    expect(JSON.stringify(f.plugin.getPublicConfiguration())).not.toContain(new URL(f.entry.url).searchParams.get('token'))
    const listing = await f.rpc('session/list', { _request: {} }); expect(listing.status).toBe(200); expect(listing.body).toContain(f.rootId); expect(listing.body).toContain(f.otherId)
    const createdId = randomUUID()
    const created = await f.rpc('session/create', { request: { sessionId: createdId, cwd: f.workspace } })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({ result: { ok: true, value: { sessionId: createdId } } })
    const browser = await chromium.launch({ headless: true }); stops.push(() => browser.close())
    const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 1000 } })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(f.entry.url)
    await vi.waitFor(async () => expect(await page.locator('body').innerText()).toContain('Native original root'), { timeout: 20000 })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await vi.waitFor(async () => {
      const result = JSON.parse((await f.rpc('settings/describe', {})).body).result
      const general = result.value?.namespaces.find((row: { ns: string }) => row.ns === 'ui-settings-general')
      expect(general?.user.welcomeNoticeVersion, JSON.stringify(general)).toBe('2026-09-28.1')
    }, { timeout: 5000 })
    await vi.waitFor(async () => expect(await page.getByRole('button', { name: 'Continue', exact: true }).isVisible()).toBe(false), { timeout: 5000 })
    await page.getByText('Native original root', { exact: true }).first().click({ timeout: 2000 })
    await vi.waitFor(async () => expect(await page.locator('body').innerText()).toContain('NATIVE-MODEL-OUTPUT'), { timeout: 10000 })
    expect(await page.locator('[contenteditable="true"], textarea').count()).toBeGreaterThan(0)
    expect(await page.locator('[class*="eating-native-"]').count()).toBe(0)
    expect(await page.evaluate(() => ({ eating: '__EATING_NATIVE_WEB__' in globalThis, forcedLocale: '__DSH_LOCALE__' in globalThis, customStyles: [...document.querySelectorAll('style')].some(style => style.textContent?.includes('.eating-native-')) }))).toEqual({ eating: false, forcedLocale: false, customStyles: false })
    const theme = () => page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color, theme: document.body.dataset.theme }))
    const light = await theme()
    mkdirSync('.review', { recursive: true }); await page.screenshot({ path: '.review/official-native-web-light.png', fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await vi.waitFor(async () => expect((await theme()).background).not.toBe(light.background))
    const dark = await theme(); expect(dark.color).not.toBe(light.color)
    await page.screenshot({ path: '.review/official-native-web-dark.png', fullPage: true })
    const currentSettings = JSON.parse((await f.rpc('settings/describe', {})).body).result.value.namespaces
    const themeSettings = currentSettings.find((row: { ns: string }) => row.ns === 'ui-theme')
    const savedTheme = await f.rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark' }, expectedRevision: themeSettings.revision })
    expect(JSON.parse(savedTheme.body)).toMatchObject({ result: { ok: true, value: { user: { preference: 'dark' } } } })
    await page.emulateMedia({ colorScheme: 'light' })
    await vi.waitFor(async () => expect((await theme()).background).toBe(dark.background))
    expect(errors).toEqual([])
    await browser.close()
    expect(await f.sdk.session(f.rootId).getWorkingDirectory()).toBe(f.workspace)
    expect(f.plugin.getPublicConfiguration().runtimeStatus).toMatchObject({ sessionId: f.rootId, nativeWeb: { ready: true } })
    await f.plugin.disconnect()
    await expect(fetch(f.origin)).rejects.toThrow()
    await expect(f.plugin.manage('open-native-web', {})).rejects.toMatchObject({ code: 'NATIVE_WEB_NOT_READY' })
    await f.plugin.connect()
    const resumedEntry = await f.plugin.manage('open-native-web', {}) as { url: string; rootSessionId: string }
    expect(resumedEntry.rootSessionId).toBe(f.rootId)
    const resumedAuth = await fetch(resumedEntry.url, { redirect: 'manual' })
    const resumedResponse = await fetch(new URL('/api/settings/describe', resumedEntry.url), { method: 'POST', headers: { Cookie: resumedAuth.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'settings/describe', payload: { args: {} } }) })
    const persisted = (await resumedResponse.json() as { result: { value: { namespaces: { ns: string; user: object }[] } } }).result.value.namespaces
    expect(persisted.find(row => row.ns === 'ui-theme')?.user).toMatchObject({ preference: 'dark' })
    expect(persisted.find(row => row.ns === 'ui-settings-general')?.user).toMatchObject({ welcomeNoticeVersion: '2026-09-28.1' })
  }, 90000)
})
