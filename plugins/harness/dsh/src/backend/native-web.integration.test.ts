import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
async function fixture(modelTool?: { name: string; args: JsonObject }, autonomous = false) {
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
      if (request.method === 'GET' && request.url === '/v1/models' && request.headers.authorization === `Bearer ${fixtureKey}`) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'native-web-loopback-fixture', modalities: { input: ['text', 'image'] }, context_window: 1000000, max_output_tokens: 128000 }] })); return }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.socket.remoteAddress !== '127.0.0.1' || request.headers.authorization !== `Bearer ${fixtureKey}`) throw new Error('Unexpected model route or credentials')
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 1024 * 1024) throw new Error('Fixture model body exceeded 1 MiB'); chunks.push(buffer) }
      const payload = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      expect(payload.model).toBe('native-web-loopback-fixture'); expect(payload.stream).toBe(true)
      requests.push(payload)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: object, finish: string | null) => response.write(`data: ${JSON.stringify({ id: `native-web-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
      if (autonomous) {
        const messages = payload.messages as JsonObject[]
        const lastTool = [...messages].reverse().find(message => message.role === 'tool')
        const lastUser = messages.map(message => message.role).lastIndexOf('user')
        const toolsThisTurn = messages.slice(lastUser + 1).filter(message => message.role === 'tool')
        if (toolsThisTurn.length === 0) { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'autonomy-state-' + requests.length, type: 'function', function: { name: 'eating_activity_state', arguments: '{}' } }] }, null); chunk({}, 'tool_calls') }
        else if (toolsThisTurn.length === 1 && lastTool) {
          const stateResponse = JSON.parse(String(lastTool.content)) as JsonObject
          const state = object(stateResponse.state), history = state.history as JsonObject[]
          const mode = history.length === 0 ? 'sleeping' : 'waiting'
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'autonomy-plan-' + requests.length, type: 'function', function: { name: 'eating_plan_activity', arguments: JSON.stringify({ expected_revision: state.revision, mode, wake_at: mode === 'sleeping' ? new Date(Date.now() + 3000).toISOString() : null, note: 'Isolated native autonomous arrangement' }) } }] }, null); chunk({}, 'tool_calls')
        } else { chunk({ role: 'assistant', content: 'AUTONOMOUS-ROUND-COMPLETE' }, null); chunk({}, 'stop') }
      } else if (modelTool && requests.length === 1) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'native-fixture-tool-call', type: 'function', function: { name: modelTool.name, arguments: JSON.stringify(modelTool.args) } }] }, null); chunk({}, 'tool_calls')
      } else { chunk({ role: 'assistant', content: reply }, null); chunk({}, 'stop') }
      response.end('data: [DONE]\n\n')
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
  const host: HostPluginContext = { dataDirectory: home, getSetting: () => null, setSetting: forbidden('setSetting'), recordEvent: forbidden('recordEvent'), listMessages: () => [], executeIdempotent: forbidden('executeIdempotent'), harness: { registerSink: () => () => {}, wake: vi.fn(), readOwnerConfiguration: () => structuredClone(owner), readAgentActions: () => [], revokeAgentAccess: vi.fn(), getCapabilityMcpConnections: () => [], getMcpConnection: forbidden('getMcpConnection'), hasPendingMessages: () => false, readProactiveChannels: () => [], prepareProactiveScope: forbidden('prepareProactiveScope') } }
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
  it('wakes the same native main Agent without an external message, persists chosen sleep, wakes again and waits without a model polling loop', async () => {
    const f = await fixture(undefined, true)
    await f.connect()
    const snapshot = f.plugin.autonomy.snapshot()
    const configuration = object(snapshot.configuration)
    await f.plugin.autonomy.configure({ expectedRevision: snapshot.revision!, configuration: { ...configuration, enabled: true, minIntervalSeconds: 1, maxCyclesPerHour: 5, cycleTimeoutSeconds: 30 } })
    const configured = f.plugin.autonomy.snapshot()
    await f.plugin.autonomy.control('resume', { expectedRevision: configured.revision!, expectedActivityRevision: object(configured.state).revision! })
    await vi.waitFor(() => expect(object(f.plugin.autonomy.snapshot().state)).toMatchObject({ mode: 'sleeping', lastOutcome: 'completed' }), { timeout: 15000, interval: 100 })
    expect(f.requests).toHaveLength(3)
    const firstId = object(f.plugin.getPublicConfiguration().runtimeStatus).sessionId
    await vi.waitFor(() => expect(object(f.plugin.autonomy.snapshot().state)).toMatchObject({ mode: 'waiting', lastOutcome: 'completed', cycles: 2 }), { timeout: 15000, interval: 100 })
    expect(f.requests).toHaveLength(6)
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect(f.requests).toHaveLength(6)
    expect(object(f.plugin.getPublicConfiguration().runtimeStatus).sessionId).toBe(firstId)
    expect(f.modelErrors).toEqual([])
    await f.plugin.disconnect()
    expect(object(f.plugin.autonomy.snapshot().state).active).toBeNull()
  }, 60000)

  it('waits for admitted external work before an empty autonomous opportunity and preserves owner pause after restart', async () => {
    const f = await fixture(undefined, true)
    let externalPending = true
    f.host.harness!.hasPendingMessages = () => externalPending
    await f.connect()
    const snapshot = f.plugin.autonomy.snapshot()
    await f.plugin.autonomy.configure({ expectedRevision: snapshot.revision!, configuration: { ...object(snapshot.configuration), enabled: true, minIntervalSeconds: 1, cycleTimeoutSeconds: 30 } })
    const configured = f.plugin.autonomy.snapshot()
    await f.plugin.autonomy.control('resume', { expectedRevision: configured.revision!, expectedActivityRevision: object(configured.state).revision! })
    await vi.waitFor(() => expect(object(f.plugin.autonomy.snapshot().state).reason).toBe('external-pending'), { timeout: 5000, interval: 100 })
    expect(f.requests).toHaveLength(0)
    externalPending = false
    await vi.waitFor(() => expect(object(f.plugin.autonomy.snapshot().state).lastOutcome).toBe('completed'), { timeout: 10000, interval: 100 })
    const beforePause = f.plugin.autonomy.snapshot()
    await f.plugin.autonomy.control('pause', { expectedRevision: beforePause.revision!, expectedActivityRevision: object(beforePause.state).revision! })
    await f.plugin.disconnect(); await f.connect()
    expect(object(f.plugin.autonomy.snapshot().state)).toMatchObject({ ownerPaused: true, mode: 'sleeping' })
    expect(f.requests).toHaveLength(3)
  }, 60000)

  it('automatically applies service-declared image support and limits to the real native model without a paid probe', async () => {
    const f = await fixture()
    const manual = await f.plugin.manage('get-model-capabilities', {})
    const information = object(await f.plugin.manage('read-model-information', {}))
    expect(information).toMatchObject({ imageInput: true, capabilities: { imageInput: true, contextWindow: 1000000, maxOutputTokens: 128000 } })
    expect(await f.plugin.manage('get-model-capabilities', {})).toEqual(manual)
    await f.connect()
    expect(f.requests).toHaveLength(0)
    expect(object(await f.plugin.manage('get-model-information', {})).appliedImageInput).toBe(true)
    const patch = readFileSync(f.launches[0]!.patches![0]!, 'utf8')
    expect(patch).toContain('"input":["text","image"]')
    expect(patch).toContain('"contextWindow":1000000')
    expect(patch).toContain('"maxTokens":128000')
    expect(f.launches[0]!.maxTokens).toBe(128)
  }, 120000)

  it('reads the stopped native catalog without a model turn, validates scoped features and observes real mounts', async () => {
    const f = await fixture()
    const first = object(await f.plugin.manage('native-list', {}))
    const catalog = object(first.catalog), configuration = object(first.configuration)
    expect(catalog.schemaVersion).toBe(1)
    expect(object(catalog.runtime).running).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(new DshSessionFile(f.home).read()).toBeNull()
    const features = (configuration.features as JsonObject[]).map(feature => ['files', 'todo', 'web'].includes(String(feature.id)) ? { ...feature, enabled: true, agentTypeIds: ['main'] } : feature)
    await f.plugin.manage('native-save', { expectedRevision: configuration.revision!, features, toolGrants: [] })
    expect(f.requests).toHaveLength(0)
    await f.connect()
    const live = object(await f.plugin.manage('native-list', {})), liveCatalog = object(live.catalog), runtime = object(liveCatalog.runtime)
    expect(runtime.running).toBe(true)
    expect(runtime.appliedRevision).toBe(1)
    expect(runtime.mounted).toEqual(expect.arrayContaining([expect.objectContaining({ agentTypeId: 'main', featureId: 'files', state: 'mounted' }), expect.objectContaining({ featureId: 'time' })]))
    await expect(f.plugin.manage('native-save', { expectedRevision: 1, features, toolGrants: [] })).rejects.toMatchObject({ code: 'NATIVE_STOP_FIRST' })
    await f.plugin.deliverBatch(f.batch, new AbortController().signal)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 10000 })
    const tools = f.requests[0]!.tools as JsonObject[]
    const names = tools.map(tool => object(tool.function).name)
    expect(names).toEqual(expect.arrayContaining(['read', 'read_image', 'todo_write', 'web_fetch', 'eating_delegate_task']))
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
    await f.plugin.disconnect()
  }, 120000)

  it('validates every available native feature through the installed runtime', async () => {
    const f = await fixture()
    const snapshot = object(await f.plugin.manage('native-list', {})), catalog = object(snapshot.catalog)
    let configuration = object(snapshot.configuration)
    for (const status of catalog.features as JsonObject[]) {
      if (!status.available) continue
      const features = (configuration.features as JsonObject[]).map(feature => ({ ...feature, enabled: feature.id === status.id, agentTypeIds: feature.id === status.id ? ['main'] : [] }))
      try { configuration = object(object(await f.plugin.manage('native-save', { expectedRevision: configuration.revision!, features, toolGrants: [] })).configuration) }
      catch (error) { throw new Error('Native feature validation failed: ' + String(status.id) + '\n' + JSON.stringify(f.diagnostic()), { cause: error }) }
    }
    expect(f.requests).toHaveLength(0)
    expect(new DshSessionFile(f.home).read()).toBeNull()
  }, 120000)

  it('installs an owner-confirmed local bundle disabled, grants its exact tool, protects secrets, and removes code while retaining data', async () => {
    const f = await fixture({ name: 'fixture_native_echo', args: { value: 'native-tool-execution-verified' } }), packageDirectory = join(f.home, 'fixture-package')
    mkdirSync(packageDirectory)
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@fixture/eating-native', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(packageDirectory, 'cordis.patch.yml'), '- insert:\n    - id: fixture-native\n      name: "@fixture/eating-native"\n')
    writeFileSync(join(packageDirectory, 'index.mjs'), `export const name = 'fixture-native'; export const inject = ['tools']; export function apply(ctx) { ctx.tools.register({name:'fixture_native_echo', description:'Pure isolated fixture echo', parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}, output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(args){return args.value;}}); }`)
    expect(object(await f.plugin.manage('native-inspect', { spec: packageDirectory })).status).toBe('accepted')
    const installed = object(await f.plugin.manage('native-install', { requestId: randomUUID(), spec: packageDirectory, confirmed: true }))
    expect(installed.application, JSON.stringify(installed)).not.toBe('failed')
    let snapshot = object(await f.plugin.manage('native-list', {})), catalog = object(snapshot.catalog)
    let bundle = (catalog.bundles as JsonObject[]).find(row => row.name === '@fixture/eating-native')!
    expect(bundle).toMatchObject({ enabled: false, installed: true, removable: true })
    expect((catalog.tools as JsonObject[]).some(tool => tool.name === 'fixture_native_echo')).toBe(false)
    await f.plugin.manage('native-bundle', { requestId: randomUUID(), name: bundle.name!, enabled: true, expectedFingerprint: bundle.fingerprint! })
    snapshot = object(await f.plugin.manage('native-list', {})); catalog = object(snapshot.catalog)
    const row = (catalog.plugins as JsonObject[]).find(row => row.moduleName === '@fixture/eating-native')!
    await f.plugin.manage('native-configure', { requestId: randomUUID(), entryId: row.entryId!, expectedFingerprint: row.fingerprint!, config: { apiKey: 'fixture-native-secret-must-not-appear' } })
    snapshot = object(await f.plugin.manage('native-list', {})); catalog = object(snapshot.catalog)
    expect(JSON.stringify(snapshot)).not.toContain('fixture-native-secret-must-not-appear')
    const tool = (catalog.tools as JsonObject[]).find(row => row.name === 'fixture_native_echo')!, configuration = object(snapshot.configuration)
    await f.plugin.manage('native-save', { expectedRevision: configuration.revision!, features: configuration.features!, toolGrants: [{ name: tool.name!, fingerprint: tool.fingerprint!, agentTypeIds: ['main'] }] })
    await f.connect()
    await f.plugin.deliverBatch(f.batch, new AbortController().signal)
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 10000 })
    expect(JSON.stringify(f.requests[1]!.messages)).toContain('native-tool-execution-verified')
    expect((f.requests[0]!.tools as JsonObject[]).map(tool => object(tool.function).name)).toContain('fixture_native_echo')
    await vi.waitFor(() => expect(f.plugin.isReady()).toBe(true), { timeout: 10000 })
    await f.plugin.disconnect()
    const modulePath = join(packageDirectory, 'index.mjs')
    writeFileSync(modulePath, readFileSync(modulePath, 'utf8').replace('Pure isolated fixture echo', 'Changed native tool schema description'))
    await f.connect()
    await f.plugin.deliverBatch({ ...f.batch, batchId: createHash('sha256').update('changed-native-schema-batch').digest('hex') }, new AbortController().signal)
    await vi.waitFor(() => expect(f.requests).toHaveLength(3), { timeout: 10000 })
    expect((f.requests[2]!.tools as JsonObject[]).map(tool => object(tool.function).name)).not.toContain('fixture_native_echo')
    await vi.waitFor(() => expect(f.plugin.isReady()).toBe(true), { timeout: 10000 })
    await f.plugin.disconnect()
    const data = join(f.home, 'dsh-home', 'fixture-native-data.txt'); writeFileSync(data, 'retained')
    snapshot = object(await f.plugin.manage('native-list', {})); catalog = object(snapshot.catalog)
    bundle = (catalog.bundles as JsonObject[]).find(row => row.name === '@fixture/eating-native')!
    await f.plugin.manage('native-bundle', { requestId: randomUUID(), name: bundle.name!, enabled: false, expectedFingerprint: bundle.fingerprint! })
    snapshot = object(await f.plugin.manage('native-list', {})); catalog = object(snapshot.catalog)
    bundle = (catalog.bundles as JsonObject[]).find(row => row.name === '@fixture/eating-native')!
    const removed = object(await f.plugin.manage('native-remove', { requestId: randomUUID(), name: bundle.name!, confirmed: true, expectedFingerprint: bundle.fingerprint! }))
    expect(removed.application, JSON.stringify(removed)).not.toBe('failed')
    expect(existsSync(data)).toBe(true); expect(readFileSync(data, 'utf8')).toBe('retained')
    expect(JSON.stringify(object(await f.plugin.manage('native-list', {})))).not.toContain('fixture-native-secret-must-not-appear')
  }, 180000)

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
    const externalInput = (f.requests[0]!.messages as JsonObject[]).find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(f.batchText))
    expect(externalInput).toBeDefined()
    expect(JSON.parse(String(externalInput!.content))).toMatchObject({ eating: { batchId: f.batch.batchId }, events: f.batch.events })
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
    await page.getByText('Ungrouped', { exact: true }).click()
    await page.locator(`[data-row-key="session:${rootId}"]`).click({ timeout: 5000 })
    await vi.waitFor(async () => expect(await page.locator('body').innerText()).toContain(f.reply), { timeout: 20000, interval: 100 })
    const composer = page.locator('[contenteditable="true"], textarea').filter({ visible: true }).first()
    expect(await composer.isVisible()).toBe(true)
    expect(await composer.isEditable()).toBe(true)
    expect(await page.locator('[class*="eating-native-"]').count()).toBe(0)
    expect(await page.evaluate(() => ({ injected: '__EATING_NATIVE_WEB__' in globalThis, localeBridge: '__DSH_LOCALE__' in globalThis, customStyle: [...document.querySelectorAll('style')].some(style => style.textContent?.includes('.eating-native-')) }))).toEqual({ injected: false, localeBridge: false, customStyle: false })
    const theme = () => page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color }))
    const screenshotDirectory = join(process.cwd(), '.impeccable', 'review', 'external-delivery-native')
    mkdirSync(screenshotDirectory, { recursive: true })
    const trigger = page.locator('[data-turn-trigger]')
    expect(await trigger.count()).toBe(1)
    const disclosure = trigger.getByRole('button', { name: /Execution requested|收到执行请求/ })
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await page.locator('body').innerText()).not.toContain(f.batchText)
    const light = await theme()
    await page.screenshot({ path: join(screenshotDirectory, 'official-light.png'), fullPage: true, animations: 'disabled' })
    await disclosure.click()
    expect(await disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(await trigger.innerText()).toContain(f.batchText)
    await page.screenshot({ path: join(screenshotDirectory, 'external-expanded.png'), fullPage: true, animations: 'disabled' })
    await disclosure.click()
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    await page.emulateMedia({ colorScheme: 'dark' }); await vi.waitFor(async () => expect((await theme()).background).not.toBe(light.background))
    const dark = await theme(); expect(dark.color).not.toBe(light.color)
    await page.screenshot({ path: join(screenshotDirectory, 'official-dark.png'), fullPage: true, animations: 'disabled' })
    const settings = object(valueOf(await rpc('settings/describe')))
    const namespaces = settings.namespaces; if (!Array.isArray(namespaces)) throw new Error('Missing official settings namespaces')
    const themeSettings = namespaces.map(object).find(row => row.ns === 'ui-theme'); expect(themeSettings).toBeDefined()
    expect(valueOf(await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark' }, expectedRevision: themeSettings!.revision }))).toMatchObject({ user: { preference: 'dark' } })
    await page.emulateMedia({ colorScheme: 'light' }); await vi.waitFor(async () => expect((await theme()).background).toBe(dark.background))
    expect(sessionReads.length).toBeGreaterThan(0); expect(pageErrors).toEqual([])
    await page.close()
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
    const resumedPage = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
    resumedPage.on('pageerror', error => pageErrors.push(error.message))
    await resumedPage.goto(resumed.url)
    await resumedPage.getByText('Ungrouped', { exact: true }).click()
    await resumedPage.locator(`[data-row-key="session:${rootId}"]`).click()
    await vi.waitFor(async () => expect(await resumedPage.locator('[data-turn-trigger]').count()).toBe(1), { timeout: 20000, interval: 100 })
    const restoredTrigger = resumedPage.locator('[data-turn-trigger]')
    expect(await restoredTrigger.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(await resumedPage.locator('body').innerText()).not.toContain(f.batchText)
    await restoredTrigger.getByRole('button').click()
    expect(await restoredTrigger.innerText()).toContain(f.batchText)
    await restoredTrigger.getByRole('button').click()
    await resumedPage.screenshot({ path: join(screenshotDirectory, 'external-restored-dark.png'), fullPage: true, animations: 'disabled' })
    expect(f.requests).toHaveLength(1)
    const humanText = 'NATIVE-WEB-HUMAN-INPUT-STAYS-A-CONVERSATION'
    const resumedComposer = resumedPage.locator('[contenteditable="true"], textarea').filter({ visible: true }).first()
    await resumedComposer.fill(humanText)
    await resumedComposer.press('Enter')
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 10000 })
    expect(await resumedPage.locator('body').innerText()).toContain(humanText)
    expect(await resumedPage.locator('[data-turn-trigger]').count()).toBe(1)
    expect(pageErrors).toEqual([])
    await browser.close()
    await f.plugin.disconnect()
    await expect(fetch(new URL(resumed.url).origin, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    await vi.waitFor(() => expect(resumedPids.filter(alive)).toEqual([]), { timeout: 5000, interval: 50 })
    expect(f.closeCalls).toBe(2)
  }, 120000)
})
