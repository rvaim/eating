import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { HarnessDeliveryBatch, HarnessOwnerConfiguration, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { DshPlugin } from './adapter'
import { DshSessionFile, readRestrictedJson } from './config'

// This system installation is opt-in. It runs with a new temporary profile and
// loopback model, never the user's DSH profile, QQ account or model credentials.
const systemBin = process.env.EATING_DSH_TEST_SYSTEM_BIN
const enabled = Boolean(systemBin)
const runFile = promisify(execFile)
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const stop of stops.splice(0).reverse()) { try { await stop() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Native Web fixture cleanup failed')
})
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected native RPC object'); return value }
function valueOf(response: { status: number; body: JsonObject }): JsonValue {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const result = object(response.body.result)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  return result.value ?? null
}
async function descendants(): Promise<number[]> {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'pid=,ppid=,comm='])
  const rows = stdout.trim().split('\n').flatMap(line => { const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return row ? [{ pid: Number(row[1]), parent: Number(row[2]), command: row[3] }] : [] })
  const ids = new Set([process.pid]); let changed = true
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true } }
  return rows.filter(row => row.pid !== process.pid && ids.has(row.pid) && row.command !== '/bin/ps').map(row => row.pid)
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
async function fixture() {
  const parent = realpathSync(tmpdir()), home = realpathSync(mkdtempSync(join(parent, 'eating-system-native-web-')))
  stops.push(() => { if (realpathSync(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-system-native-web-')) throw new Error('Unsafe native Web fixture cleanup'); rmSync(home, { recursive: true }) })
  const probe = join(home, 'version-probe'); mkdirSync(probe)
  const version = spawnSync(systemBin!, ['--version'], { cwd: probe, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: probe, USERPROFILE: probe, DSH_HOME: join(probe, 'dsh'), DSH_AGENTS_HOME: join(probe, 'agents'), XDG_CONFIG_HOME: join(probe, 'config'), XDG_CACHE_HOME: join(probe, 'cache'), XDG_DATA_HOME: join(probe, 'data') }, timeout: 8000, encoding: 'utf8' })
  expect(version.status, version.stderr).toBe(0)
  expect(version.stdout.trim()).toMatch(/\d+\.\d+\.\d+/)
  const requests: JsonObject[] = [], modelErrors: string[] = []
  const fixtureKey = 'native-web-loopback-fixture-key'
  const reply = 'NATIVE-WEB-REAL-SDK-SSE-OUTPUT'
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.socket.remoteAddress !== '127.0.0.1' || request.headers.authorization !== `Bearer ${fixtureKey}`) throw new Error('Unexpected model route or credentials')
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 1024 * 1024) throw new Error('Fixture model body exceeded 1 MiB'); chunks.push(buffer) }
      const payload = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      expect(payload.model).toBe('native-web-loopback-fixture'); expect(payload.stream).toBe(true)
      requests.push(payload)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: object, finish: string | null) => response.write(`data: ${JSON.stringify({ id: `native-web-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
      chunk({ role: 'assistant', content: reply }, null); chunk({}, 'stop'); response.end('data: [DONE]\n\n')
    })().catch(error => { modelErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  stops.push(async () => { const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback model port')
  const owner: HarnessOwnerConfiguration = { revision: 1, activePersona: null, pluginInstructions: [], bindings: { 主人: '', 管理员: '' }, prompts: [
    { id: 'common', scope: 'common', source: 'owner', title: 'Fixture common', body: 'Isolated integration fixture. Return a short plain text response; do not use tools or delegate.', revision: 1, updatedAt: null },
    { id: 'main', scope: 'main', source: 'owner', title: 'Fixture main', body: 'Acknowledge the synthetic message without external actions.', revision: 1, updatedAt: null },
    { id: 'subagent', scope: 'subagent', source: 'owner', title: 'Fixture subagent', body: 'Unused fixture child.', revision: 1, updatedAt: null },
    { id: 'agent:qq.group', scope: 'agent', source: 'plugin', pluginId: 'qq', agentTypeId: 'qq.group', title: 'Fixture group', body: 'Unused synthetic group.', revision: 1, updatedAt: null },
  ], agentTypes: [{ id: 'qq.group', title: 'Fixture group', description: 'Synthetic source with no QQ connection.', conversationKind: 'group', pluginId: 'qq', pluginName: 'Fixture QQ', enabled: true, availableTools: [], defaultTools: [], enabledTools: [], defaultPrompt: 'Unused fixture role.', identity: { owners: [], administrators: [] } }] }
  const forbidden = (name: string) => vi.fn(() => { throw new Error(`Forbidden integration Host action: ${name}`) })
  const host: HostPluginContext = { dataDirectory: home, getSetting: () => null, setSetting: forbidden('setSetting'), recordEvent: forbidden('recordEvent'), listMessages: () => [], executeIdempotent: forbidden('executeIdempotent'), harness: { registerSink: () => () => {}, wake: vi.fn(), readOwnerConfiguration: () => structuredClone(owner), readAgentActions: () => [], revokeAgentAccess: vi.fn(), getMcpConnection: forbidden('getMcpConnection') } }
  const clients: DeepSeekHarness[] = [], launches: DeepSeekHarnessOptions[] = []
  let closeCalls = 0
  const plugin = new DshPlugin(host, { locateSystemDsh: () => ({ bin: systemBin!, version: version.stdout.trim(), source: 'override' }), createHarness: options => {
    launches.push(options)
    const sdk = new DeepSeekHarness(options); clients.push(sdk)
    return { start: () => sdk.start(), session: id => sdk.session(id), resumeSession: id => sdk.resumeSession(id), close: async () => { closeCalls++; await sdk.close() } }
  } })
  stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'native-web-loopback-fixture', apiKey: fixtureKey, timeoutMs: 30000, maxTokens: 128, autoConnect: false })
  const diagnostic = () => ({ status: plugin.getStatus(), public: plugin.getPublicConfiguration(), stderr: clients.map(sdk => Reflect.get(sdk.client, 'stderrTail')), bridge: readRestrictedJson(join(home, 'bridge', 'error.json')), modelErrors })
  const connect = async () => { try { await plugin.connect() } catch (error) { throw new Error(`${String(error)}\n${JSON.stringify(diagnostic())}`, { cause: error }) } }
  const batchText = 'NATIVE-WEB-REAL-SDK-INPUT'
  const now = new Date().toISOString()
  const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: createHash('sha256').update(randomUUID()).digest('hex'), conversationId: 'qq:100:group:200', createdAt: now, reason: 'quiet-window', events: [{ protocolVersion: 1, eventId: randomUUID(), pluginId: 'qq', platform: 'qq', instanceId: 'synthetic-native-web-instance', accountId: '100', conversationId: 'qq:100:group:200', senderId: '300', targetId: '200', messageId: 'synthetic-native-web-message', resourceIds: [], source: { trust: 'external', kind: 'group', senderRole: 'user' }, receivedAt: now, content: batchText, text: batchText }] }
  const entry = async () => object(await plugin.manage('open-native-web', {})) as JsonObject & { url: string; rootSessionId: string }
  const authenticated = async (url: string) => {
    const parsed = new URL(url); expect(parsed.hostname).toBe('127.0.0.1'); expect(parsed.protocol).toBe('http:'); expect(parsed.port).not.toBe('')
    const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) }); expect(auth.status).toBe(303)
    const cookie = auth.headers.get('set-cookie')?.split(';')[0]; if (!cookie) throw new Error('Official Web did not establish an owner cookie')
    return async (method: string, args: object = {}) => {
      const response = await fetch(new URL(`/api/${method}`, parsed), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(10000) })
      return { status: response.status, body: object(await response.json()) }
    }
  }
  return { home, plugin, host, requests, modelErrors, reply, batchText, batch, clients, launches, connect, diagnostic, entry, authenticated, get closeCalls() { return closeCalls } }
}

describe.runIf(enabled)('system DSH official native Web and SDK integration', () => {
  it('shares a real SDK conversation, preserves official owner operations/UI/themes, and stops its own processes', async () => {
    const f = await fixture()
    await f.connect()
    console.info('Native Web integration: system ' + systemBin + ' started with the SDK kernel and official Web')
    expect(f.requests).toHaveLength(0)
    const entry = await f.entry(), rootId = new DshSessionFile(f.home).read()!.sessionId
    expect(Object.keys(entry).sort()).toEqual(['rootSessionId', 'url']); expect(entry.rootSessionId).toBe(rootId)
    expect(f.plugin.getPublicConfiguration().runtimeStatus).toMatchObject({ sessionId: rootId, nativeWeb: { ready: true }, ready: true, busy: false })
    for (const launch of f.launches) {
      expect(launch.env?.EATING_DSH_SYSTEM_BIN).toBe(systemBin)
      expect(launch.dshHome).toBe(join(f.home, 'dsh-home'))
      for (const key of ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) expect(launch.env?.[key]?.startsWith(f.home + '/'), key).toBe(true)
      for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) expect(launch.env?.[key], key).toBeUndefined()
    }
    const webToken = new URL(entry.url).searchParams.get('token'); expect(webToken).toBeTruthy()
    const publicJson = JSON.stringify({ config: f.plugin.getPublicConfiguration(), status: f.plugin.getStatus() })
    expect(publicJson).not.toContain(entry.url); expect(publicJson).not.toContain(webToken!)
    expect(publicJson).not.toContain(f.launches[0]!.env!.EATING_DSH_BRIDGE_NONCE!)
    const receipt = await f.plugin.deliverBatch(f.batch, new AbortController().signal)
    expect(receipt).toMatchObject({ accepted: true, durable: true }); expect(receipt.receiptId).toBeTruthy()
    await vi.waitFor(() => { expect(f.plugin.isReady(), JSON.stringify(f.diagnostic())).toBe(true); expect(f.plugin.getPublicConfiguration().runtimeStatus).toMatchObject({ busy: false }); expect(f.requests).toHaveLength(1) }, { timeout: 30000, interval: 50 })
    expect(f.plugin.getStatus().lastError, JSON.stringify(f.diagnostic())).toBeNull()
    expect(JSON.stringify(f.requests[0])).toContain(f.batchText)
    console.info('Native Web integration: durable SDK delivery and one loopback SSE reply completed')
    const nativePids = await descendants(); expect(nativePids.length).toBeGreaterThan(0)
    const rpc = await f.authenticated(entry.url)
    const listing = valueOf(await rpc('session/list', { _request: {} }))
    expect(JSON.stringify(listing)).toContain(rootId)
    console.info('Native Web integration: official session/list returned the same SDK root')
    const createdId = randomUUID()
    expect(valueOf(await rpc('session/create', { request: { sessionId: createdId, cwd: join(f.home, 'workspace') } }))).toMatchObject({ sessionId: createdId })
    expect(JSON.stringify(valueOf(await rpc('session/list', { _request: {} })))).toContain(createdId)
    const browser = await chromium.launch({ headless: true }); stops.push(() => browser.close())
    const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 1000 } })
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message))
    const sessionReads: string[] = []
    page.on('response', response => { if (response.url().includes('/api/session/') && response.status() === 200) sessionReads.push(response.url()) })
    await page.goto(entry.url)
    const welcome = page.getByRole('button', { name: 'Continue', exact: true })
    await welcome.waitFor({ state: 'visible', timeout: 20000 }); await welcome.click(); await welcome.waitFor({ state: 'hidden', timeout: 5000 })
    const items = object(listing).items
    if (!Array.isArray(items)) throw new Error('Official session/list did not return items')
    const rootRow = items.map(object).find(row => row.sessionId === rootId)
    expect(rootRow).toBeDefined()
    const rootTitle = object(object(rootRow!.projections).values).title
    await page.getByText('Ungrouped', { exact: true }).click()
    if (typeof rootTitle !== 'string') throw new Error('Missing official root title projection')
    await page.getByText(rootTitle, { exact: true }).first().click({ timeout: 5000 })
    await vi.waitFor(async () => expect(await page.locator('body').innerText()).toContain(f.reply), { timeout: 20000, interval: 100 })
    const composer = page.locator('[contenteditable="true"], textarea').filter({ visible: true }).first()
    expect(await composer.isVisible()).toBe(true)
    expect(await composer.isEditable()).toBe(true)
    expect(await page.locator('[class*="eating-native-"]').count()).toBe(0)
    expect(await page.evaluate(() => ({ injected: '__EATING_NATIVE_WEB__' in globalThis, localeBridge: '__DSH_LOCALE__' in globalThis, customStyle: [...document.querySelectorAll('style')].some(style => style.textContent?.includes('.eating-native-')) }))).toEqual({ injected: false, localeBridge: false, customStyle: false })
    const theme = () => page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color }))
    const screenshotDirectory = join(process.cwd(), '.impeccable', 'review', 'system-web-native')
    mkdirSync(screenshotDirectory, { recursive: true })
    const light = await theme()
    await page.screenshot({ path: join(screenshotDirectory, 'official-light.png'), fullPage: true, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' }); await vi.waitFor(async () => expect((await theme()).background).not.toBe(light.background))
    const dark = await theme(); expect(dark.color).not.toBe(light.color)
    await page.screenshot({ path: join(screenshotDirectory, 'official-dark.png'), fullPage: true, animations: 'disabled' })
    const settings = object(valueOf(await rpc('settings/describe')))
    const namespaces = settings.namespaces; if (!Array.isArray(namespaces)) throw new Error('Missing official settings namespaces')
    const themeSettings = namespaces.map(object).find(row => row.ns === 'ui-theme'); expect(themeSettings).toBeDefined()
    expect(valueOf(await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark' }, expectedRevision: themeSettings!.revision }))).toMatchObject({ user: { preference: 'dark' } })
    await page.emulateMedia({ colorScheme: 'light' }); await vi.waitFor(async () => expect((await theme()).background).toBe(dark.background))
    expect(sessionReads.length).toBeGreaterThan(0); expect(pageErrors).toEqual([])
    await browser.close()
    expect(await f.clients[0]!.session(rootId).getWorkingDirectory()).toBe(join(f.home, 'workspace'))
    expect(f.host.harness!.getMcpConnection).not.toHaveBeenCalled(); expect(f.host.executeIdempotent).not.toHaveBeenCalled(); expect(f.host.recordEvent).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(1); expect(f.modelErrors).toEqual([])
    await f.plugin.disconnect()
    await expect(fetch(new URL(entry.url).origin, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    await vi.waitFor(() => expect(nativePids.filter(alive)).toEqual([]), { timeout: 5000, interval: 50 })
    expect(f.closeCalls).toBe(1)
    await expect(f.plugin.manage('open-native-web', {})).rejects.toMatchObject({ code: 'NATIVE_WEB_NOT_READY' })
    await f.connect()
    const resumed = await f.entry(); expect(resumed.rootSessionId).toBe(rootId)
    const resumedPids = await descendants(), resumedRpc = await f.authenticated(resumed.url)
    const persisted = object(valueOf(await resumedRpc('settings/describe'))).namespaces
    if (!Array.isArray(persisted)) throw new Error('Missing resumed official settings namespaces')
    expect(persisted.map(object).find(row => row.ns === 'ui-theme')?.user).toMatchObject({ preference: 'dark' })
    expect(JSON.stringify(valueOf(await resumedRpc('session/list', { _request: {} })))).toContain(rootId)
    expect(await f.clients[1]!.session(rootId).getWorkingDirectory()).toBe(join(f.home, 'workspace'))
    expect(f.requests).toHaveLength(1)
    await f.plugin.disconnect()
    await expect(fetch(new URL(resumed.url).origin, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    await vi.waitFor(() => expect(resumedPids.filter(alive)).toEqual([]), { timeout: 5000, interval: 50 })
    expect(f.closeCalls).toBe(2)
  }, 120000)
})
