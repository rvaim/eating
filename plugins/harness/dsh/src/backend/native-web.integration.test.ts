import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostPluginContext } from '@eating/plugin-sdk'
import { DshPlugin } from './adapter'
import { DshRuntimeInstallation } from './runtime'
import { DshSessionFile, writeRestrictedJson } from './config'
import { createImageFixturePng } from '../../../../../tests/fixtures/image'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
interface Event { seq: number; time: number; type: string; data: unknown }
interface NativeSession { header: object; append(type: string, data: unknown, opts?: unknown): Event; snapshotEvents(): Event[] }
function fingerprint(directory: string): string {
  return createHash('sha256').update(readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => readFileSync(join(entry.parentPath, entry.name))).join('\n')).digest('hex')
}
async function fixture() {
  const parent = realpathSync(tmpdir()), home = realpathSync(mkdtempSync(join(parent, 'eating-native-web-')))
  stops.push(() => { if (realpathSync(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-native-web-')) throw new Error('Unsafe native Web cleanup'); rmSync(home, { recursive: true }) })
  const installation = new DshRuntimeInstallation(resolve(runtimeDirectory!)); stops.push(() => installation.dispose())
  const request = createRequire(installation.resolve().dshBin)
  const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(request.resolve(`@deepseek-ai/${name}`)).href)
  const [cordis, jsonl, native, llm, projections, attachments] = await Promise.all([load('cordis'), load('dsh-session-persistence-jsonl'), load('dsh-session'), load('dsh-llm'), load('dsh-session-format-catalog/message-projections'), load('dsh-attachment-local')])
  const rootId = randomUUID(), childId = randomUUID(), outsideId = randomUUID()
  const workspace = join(home, 'workspace'); mkdirSync(workspace, { recursive: true })
  const sessionRoot = join(home, 'dsh-home', 'sessions'); mkdirSync(sessionRoot, { recursive: true })
  const ctx = new cordis.Context(); await ctx.plugin(jsonl, { root: sessionRoot, compression: 'none' }); await ctx.plugin(attachments.default, { dshHome: join(home, 'dsh-home') })
  const image = await ctx.attachments.saveImage({ mediaType: 'image/png', data: createImageFixturePng() })
  const create = (id: string, parentSession?: string): NativeSession => native.Session.create(id, undefined, { id, version: native.SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: workspace, isSeeded: false, ...(parentSession ? { parentSession, origin: 'subagent', delegationDepth: 1 } : {}) }, 0, projections.currentSessionMessageProjections)
  const contextRef = 'a'.repeat(64), context = { contextRef, agentTypeId: 'qq.group', platform: 'qq', accountId: '10001', instanceId: 'fixture-instance', conversationId: 'qq:10001:group:30003', kind: 'group', reason: 'quiet-window', ownerRevision: 0 }
  const events = [{ protocolVersion: 1, eventId: 'native-event', pluginId: 'qq', platform: 'qq', instanceId: 'fixture-instance', accountId: '10001', conversationId: context.conversationId, senderId: '20002', targetId: '30003', receivedAt: '2026-10-29T12:00:00Z', text: 'NATIVE-PLATFORM-MESSAGE', content: 'NATIVE-PLATFORM-MESSAGE', resourceIds: [], source: { trust: 'external', kind: 'group', senderRole: 'user' } }]
  const envelope = { eating: { magic: 'eating-harness-delivery', protocolVersion: 1, nonce: 'fixture-native-nonce', sessionId: rootId, batchId: contextRef, digest: createHash('sha256').update(JSON.stringify({ context, events })).digest('hex') }, context, events }
  const root = create(rootId), child = create(childId, rootId), outside = create(outsideId)
  const user = (session: NativeSession, text: string, source: object = { kind: 'user' }) => session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
  for (const session of [root, child, outside]) {
    if (session === child) session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'qq-group-30003' })
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('NATIVE-SYSTEM-CONTEXT') }, { surfaceOp: 'append' })
    user(session, session === root ? JSON.stringify(envelope) : session === child ? 'NATIVE-COLD-CHILD-MESSAGE' : 'OUTSIDE-TREE-PRIVATE-TEXT')
    if (session === root) user(session, 'NATIVE-TIME-CONTEXT Asia/Shanghai', { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: 'NATIVE-TIME-CONTEXT Asia/Shanghai' }] })
    const blocks: Record<string, unknown>[] = [{ type: 'reasoning', text: 'HIDDEN-NATIVE-REASONING' }, { type: 'text', text: session === outside ? 'OUTSIDE-TREE-REPLY' : 'NATIVE-MODEL-OUTPUT' }]
    if (session === root) blocks.push({ type: 'image', attachment: image })
    const stream = blocks.flatMap((block, index) => [{ type: 'chunk', time: Date.now(), chunk: { type: 'block-start', index, blockType: block.type } }, { type: 'chunk', time: Date.now(), chunk: { type: 'block-end', index, block } }])
    session.append('assistant/message', { turn: 1, step: 1, message: llm.createAssistantMessage({ content: blocks, source: { provider: 'fixture', model: 'fixture-model' } }), stream }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const handle = await ctx.sessionPersistence.create(session.header); try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
  }
  await ctx.fiber.dispose()
  new DshSessionFile(home).write({ sessionId: rootId, created: true })
  writeRestrictedJson(join(home, 'agent-bindings.json'), { schemaVersion: 2, bindings: [{ key: 'a'.repeat(64), parentId: rootId, configurationRevision: 0, taskRefs: [], scope: { agentId: childId, agentTypeId: 'qq.group', pluginId: 'qq', instanceId: 'fixture-instance', accountId: '10001', conversationId: context.conversationId, kind: 'group', targetId: '30003', messageIds: [], resourceIds: [] } }] })
  let sdk: DeepSeekHarness | undefined
  const contextHost: HostPluginContext = { dataDirectory: home, getSetting: () => null, setSetting: vi.fn(), recordEvent: vi.fn(), listMessages: () => [], executeIdempotent: vi.fn(),
    harness: { registerSink: () => () => {}, wake: vi.fn(), readOwnerConfiguration: () => ({ revision: 0, prompts: (['common', 'main', 'subagent'] as const).map(scope => ({ id: scope, scope, source: 'owner' as const, title: scope, body: 'NATIVE-OWNER-SYSTEM', revision: 0, updatedAt: null })), pluginInstructions: [], agentTypes: [{ id: 'qq.group', title: 'QQ群聊', description: 'fixture', pluginId: 'qq', pluginName: 'QQ', enabled: false, identity: { owners: [], administrators: [] }, conversationKind: 'group', defaultPrompt: '', availableTools: [], defaultTools: [], enabledTools: [] }], activePersona: null, bindings: { 主人: '', 管理员: '' } }), readAgentActions: () => [], revokeAgentAccess: vi.fn(), getMcpConnection: () => { throw new Error('No native browser action may grant MCP') } } }
  const plugin = new DshPlugin(contextHost, { runtime: installation, createHarness: options => (sdk = new DeepSeekHarness(options)), resolveNativeClient: () => resolve('plugins/harness/dsh/dist/native-client/host.mjs') })
  stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ endpoint: 'http://127.0.0.1:1/v1', model: 'fixture-model', timeoutMs: 10000 })
  try { await plugin.connect() } catch (error) { throw new Error(String(error) + '\n' + JSON.stringify(sdk ? Reflect.get(sdk.client, 'stderrTail') : { status: plugin.getStatus() })) }
  const entry = await plugin.manage('open-native-web', {}) as { url: string; rootSessionId: string; readOnly: true }
  const origin = new URL(entry.url).origin
  const auth = await fetch(entry.url, { redirect: 'manual' }); expect(auth.status).toBe(303)
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
  const rpc = async (endpoint: string, args: object) => {
    const response = await fetch(origin + '/api/' + endpoint, { method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }) })
    return { status: response.status, body: await response.text() }
  }
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { Cookie: cookie } })
  stops.push(() => socket.close())
  const frames: Record<string, unknown>[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  await new Promise<void>((accept, reject) => { socket.once('open', accept); socket.once('error', reject) })
  const open = async (endpoint: string, args: object = {}) => {
    const streamId = randomUUID(); socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    await vi.waitFor(() => expect(frames.some(frame => frame.streamId === streamId)).toBe(true), { timeout: 10000 })
    return { streamId, frame: frames.find(frame => frame.streamId === streamId)! }
  }
  return { image, plugin, sdk: sdk!, rootId, childId, outsideId, home, sessionRoot, entry, cookie, origin, rpc, socket, frames, open }
}

describe.runIf(Boolean(runtimeDirectory))('actual same-process native Web read-only boundary', () => {
  it('serves the official frontend and custom renderer, blocks HTTP/WS writes and foreign sessions, and does not activate a cold child', async () => {
    const f = await fixture()
    expect(f.entry).toMatchObject({ rootSessionId: f.rootId, readOnly: true })
    expect(JSON.stringify(f.plugin.getPublicConfiguration())).not.toContain(new URL(f.entry.url).searchParams.get('token'))
    const attachment = await f.rpc('session/attachment', { request: { sessionId: f.rootId, attachmentId: f.image.attachmentId } }); expect(attachment.status).toBe(200); expect(attachment.body).toContain('image/png')
    const listing = await f.rpc('session/list', { _request: {} }); expect(listing.status).toBe(200); expect(listing.body).toContain(f.rootId); expect(listing.body).toContain(f.childId); expect(listing.body).not.toContain(f.outsideId)
    const control = await f.open('session/control'); expect(JSON.stringify(control.frame)).toContain(f.rootId); expect(JSON.stringify(control.frame)).not.toContain(f.outsideId)
    for (const endpoint of ['session/create', 'session/prompt', 'session/rename', 'session/cancel', 'settings/update', 'pluginManager/install', 'session/uploadFileBinary']) expect((await f.rpc(endpoint, { request: { sessionId: f.rootId }, ns: 'fixture' })).status).toBe(403)
    for (const [endpoint, args] of [
      ['session/create', { request: {} }],
      ['session/prompt', { request: { sessionId: f.rootId, requestId: randomUUID(), content: [{ type: 'text', text: 'FORGED-WEB-PROMPT' }], mode: 'queue' } }],
      ['settings/update', { ns: 'fixture', patch: { enabled: true }, expectedRevision: 0 }],
    ] as const) expect((await f.open(endpoint, args)).frame).toMatchObject({ type: 'error', error: { code: 'remote-access/denied' } })
    expect((await f.rpc('session/projections', { request: { sessionId: f.outsideId } })).body).toContain('remote-access/denied')
    expect((await f.rpc('session/attachment', { request: { sessionId: f.outsideId, attachmentId: 'sha256:' + 'a'.repeat(64) } })).body).toContain('remote-access/denied')
    const wrongChild = await f.open('session/follow', { request: { address: { kind: 'subagent', parentSessionId: f.outsideId, childSessionId: f.childId, mode: 'unknown' } } }); expect(wrongChild.frame).toMatchObject({ type: 'error' })
    const before = fingerprint(f.sessionRoot)
    const cold = await f.open('session/follow', { request: { address: { kind: 'subagent', parentSessionId: f.rootId, childSessionId: f.childId, mode: 'unknown' } } })
    expect(cold.frame).toMatchObject({ type: 'item', value: { type: 'snapshot' } }); expect(JSON.stringify(cold.frame)).toContain('NATIVE-COLD-CHILD-MESSAGE')
    f.socket.send(JSON.stringify({ type: 'cancel', streamId: cold.streamId }))
    const after = await f.rpc('session/list', { _request: {} }); expect(JSON.parse(after.body).result.value.items.find((row: { sessionId: string }) => row.sessionId === f.childId).agentAvailable).toBe(false)
    expect(fingerprint(f.sessionRoot)).toBe(before)
    const browser = await chromium.launch({ headless: true }); stops.push(() => browser.close())
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(f.entry.url)
    await vi.waitFor(async () => expect(await page.locator('body').innerText()).toContain('NATIVE-PLATFORM-MESSAGE'), { timeout: 20000 })
    const body = await page.locator('body').innerText()
    expect(body).toContain('QQ-10001-群聊-30003'); expect(body).not.toContain('qq-group-30003'); expect(body).toContain('20002'); expect(body).toContain('10001'); expect(body).toContain('30003'); expect(body).toContain('模型输出'); expect(body).not.toContain('HIDDEN-NATIVE-REASONING'); expect(body).not.toContain('OUTSIDE-TREE')
    expect(await page.locator('textarea, [contenteditable="true"]').count()).toBe(0)
    await vi.waitFor(async () => expect(await page.locator('.eating-native-image').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true))
    mkdirSync('.review', { recursive: true }); await page.screenshot({ path: '.review/native-readonly-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '打开会话列表', exact: true }).click(); await vi.waitFor(async () => expect(await page.getByRole('button', { name: /QQ-10001-群聊-30003/ }).isVisible()).toBe(true)); await page.screenshot({ path: '.review/native-readonly-mobile.png', fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.getByRole('button', { name: /QQ-10001-群聊-30003/ }).click(); await vi.waitFor(async () => expect(await page.locator('.eating-native-header-label').innerText()).toBe('QQ-10001-群聊-30003')); expect(await page.getByRole('button', { name: '关闭会话列表', exact: true }).count()).toBe(0)
    expect(errors.filter(error => !error.includes('settings') && !error.includes('403'))).toEqual([])
    await browser.close()
    expect(await f.sdk.session(f.rootId).getWorkingDirectory()).toBe(join(f.home, 'workspace'))
    await f.plugin.disconnect()
    await expect(fetch(f.origin)).rejects.toThrow()
    await expect(f.plugin.manage('open-native-web', {})).rejects.toMatchObject({ code: 'NATIVE_WEB_NOT_READY' })
  }, 90000)
})
