import { spawn } from 'node:child_process'
import { mkdtemp, open, realpath, rm, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { HostPluginContext, JsonObject, MemoryCaptureInput } from '@eating/plugin-sdk'
import { OpenVikingMemoryPlugin } from '../../../plugins/capabilities/openviking-memory/src/server'
import type { MemoryClient } from '../../../plugins/capabilities/openviking-memory/src/backend/client'
import { DEFAULT_SETTINGS } from '../../../plugins/capabilities/openviking-memory/src/types'
import type { RuntimeSnapshot } from '../../../plugins/capabilities/openviking-memory/src/types'

const selectedPython = process.env.EATING_OV_TEST_PYTHON
const memoryDependencies = createRequire(new URL('../../../plugins/capabilities/openviking-memory/package.json', import.meta.url))
const fixtureScript = fileURLToPath(new URL('../../../tests/fixtures/openviking-stock.py', import.meta.url))
const fixtureKey = 'stock-fixture-user-key'
const fixtureAccount = 'stock-account'
const fixtureUser = 'stock-user'
const sessionId = 'eating-standard-self'
const stops: Array<() => unknown | Promise<unknown>> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const stop of stops.splice(0).reverse()) try { await stop() } catch (cause) { failures.push(cause) }
  if (failures.length) throw new AggregateError(failures, 'Stock OpenViking fixture cleanup failed')
})

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected stock OpenViking JSON object')
  return value
}

interface ObservedRequest {
  method: string
  path: string
  probe: boolean
  status: number
  body: JsonObject | null
  response: JsonObject
}
interface StockObservation {
  requests: ObservedRequest[]
  sessions: Array<{ session_id: string; meta: JsonObject; messages: JsonObject[]; archives: JsonObject[] }>
  compressor_calls: Array<{ session_id: string; message_ids: string[] }>
  queue_errors: string[]
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { interval: 25, timeout: 15000 })
}

async function startStock() {
  if (!selectedPython) throw new Error('EATING_OV_TEST_PYTHON must explicitly select the isolated interpreter')
  const parent = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(parent, 'eating-openviking-stock-')))
  stops.push(async () => {
    if (await realpath(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-openviking-stock-')) throw new Error('Unsafe stock fixture cleanup')
    await rm(directory, { recursive: true })
  })
  const privateLog = await open(join(directory, 'openviking-stock.log'), 'wx', 0o600)
  stops.push(() => privateLog.close())
  const child = spawn(selectedPython, ['-I', '-S', fixtureScript], {
    cwd: directory,
    env: { HOME: directory, TMPDIR: directory, OPENVIKING_CONFIG_FILE: join(directory, 'unused-config.json'), PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', privateLog.fd],
  })
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
  stops.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  })
  const stdout = child.stdout
  if (!stdout) throw new Error('Stock OpenViking fixture stdout pipe is unavailable')
  const ready = await new Promise<JsonObject>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Stock OpenViking fixture did not start')), 20000)
    const fail = () => { clearTimeout(timer); reject(new Error('Stock OpenViking fixture exited; inspect its private temporary log')) }
    child.once('error', fail)
    child.once('exit', fail)
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 1024 * 1024) { clearTimeout(timer); reject(new Error('Unexpected stock fixture stdout')); return }
      const newline = output.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      child.removeListener('error', fail)
      child.removeListener('exit', fail)
      try { resolve(object(JSON.parse(output.slice(0, newline)))) } catch (cause) { reject(cause) }
    })
  })
  if (!Number.isSafeInteger(ready.port) || Number(ready.port) <= 0 || Number(ready.port) > 65535) throw new Error('Invalid stock fixture listener')
  const endpoint = `http://127.0.0.1:${ready.port}`
  const configuration = {
    schemaVersion: 3 as const, revision: 1, endpoint, account: fixtureAccount, user: fixtureUser,
    apiKey: fixtureKey, autoConnect: false, timeoutMs: 10000, settings: structuredClone(DEFAULT_SETTINGS),
  }
  const sdk: MemoryClient['sdk'] = new (memoryDependencies('@openviking/sdk').OpenVikingClient)({ baseUrl: endpoint, account: fixtureAccount, user: fixtureUser, apiKey: fixtureKey, actorPeerId: 'self', timeout: 10000 })
  const control = async (operation: string): Promise<JsonObject> => {
    const response = await fetch(endpoint + '/__openviking_stock__/' + operation, { headers: { 'X-API-Key': fixtureKey } })
    expect(response.status).toBe(200)
    return object(await response.json())
  }
  const observe = async () => await control('state') as unknown as StockObservation
  const probe = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(endpoint + path, { ...init, headers: { 'X-API-Key': fixtureKey, 'X-Stock-Probe': '1', ...init.headers } })
    return { status: response.status, body: object(await response.json()) }
  }
  return { directory, endpoint, configuration, sdk, proof: object(ready.proof), control, observe, probe }
}

type Stock = Awaited<ReturnType<typeof startStock>>

function context(dataDirectory: string): HostPluginContext {
  return {
    dataDirectory, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: true, eventId: 'unused' }), listMessages: () => [],
    executeIdempotent: async () => { throw new Error('Stock integration must not write chat bodies to Host action storage') },
  }
}

async function configuredPlugin(stock: Stock) {
  const directory = join(stock.directory, 'memory')
  const plugin = new OpenVikingMemoryPlugin(context(directory))
  stops.push(() => plugin.disconnect())
  await plugin.updateConfiguration({
    expectedRevision: 0, endpoint: stock.endpoint, account: fixtureAccount, user: fixtureUser, apiKey: fixtureKey,
    autoConnect: false, timeoutMs: 10000, settings: structuredClone(DEFAULT_SETTINGS),
  })
  await plugin.connect()
  return { plugin, directory }
}

const snapshot = async (plugin: OpenVikingMemoryPlugin) => await plugin.manage('snapshot', {}) as unknown as RuntimeSnapshot
const appends = (state: StockObservation) => state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/messages/batch'))
const commits = (state: StockObservation) => state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/commit'))
const taskReads = (state: StockObservation) => state.requests.filter(request => request.method === 'GET' && request.path.startsWith('/api/v1/tasks/'))

function capture(round: number): MemoryCaptureInput {
  return {
    context: { agentId: 'stock-main', agentTypeId: 'main', turnId: `stock-round-${round}`, scope: { kind: 'self', platform: '', accountId: '', targetId: '', owner: true } },
    messages: [
      { role: 'user', text: `STOCK-USER-ROUND-${round}: I prefer tea.`, timestamp: '2026-11-03T10:00:00Z' },
      { role: 'assistant', text: `STOCK-ASSISTANT-ROUND-${round}: Remembered in this conversation.`, timestamp: '2026-11-03T10:00:01Z' },
    ],
    actions: [], outcome: 'completed',
  }
}

function expectStockOnly(state: StockObservation) {
  expect(state.requests.filter(request => !request.probe && /eating-memory|incremental-memory/.test(request.path))).toEqual([])
  expect(state.requests.filter(request => request.method === 'DELETE')).toEqual([])
  expect(state.queue_errors).toEqual([])
}

describe.runIf(Boolean(selectedPython))('official OpenViking 0.5.2.1 without the incremental extension', () => {
  it('uses the official auth, routers and request models with the installed SDK', async () => {
    const stock = await startStock()
    expect(stock.proof).toMatchObject({ version: '0.5.2.1', extension_importable: false, extension_loaded: false, stock_lifespan: false })
    const routes = stock.proof.routes as JsonObject[]
    for (const path of ['/api/v1/sessions/{session_id}', '/api/v1/sessions/{session_id}/messages', '/api/v1/sessions/{session_id}/messages/batch', '/api/v1/sessions/{session_id}/commit']) {
      expect(routes).toContainEqual(expect.objectContaining({ path, module: 'openviking.server.routers.sessions' }))
    }
    expect(routes).toContainEqual(expect.objectContaining({ path: '/api/v1/tasks/{task_id}', module: 'openviking.server.routers.tasks' }))
    expect(routes.filter(route => /eating-memory|incremental-memory/.test(String(route.path)))).toEqual([])
    expect(stock.proof.official_components).toContain('openviking.session.session.Session')
    expect(stock.proof.official_components).toContain('openviking.session.archive_store.ArchiveStore')
    expect(stock.proof.official_components).toContain('openviking.service.task_tracker.TaskTracker')
    for (const path of ['/api/v1/eating-memory/capabilities', '/api/v1/sessions/stock-sdk/incremental-memory']) {
      expect((await stock.probe(path)).status).toBe(404)
    }
    expect((await stock.probe('/api/v1/system/status', { headers: { 'X-API-Key': '' } })).status).toBe(401)
    expect((await stock.probe('/api/v1/system/status', { headers: { 'X-API-Key': 'stock-fixture-invalid-key' } })).status).toBe(401)
    const spoof = await stock.probe('/api/v1/system/status', { headers: { 'X-OpenViking-Account': 'spoof-account', 'X-OpenViking-User': 'spoof-user' } })
    expect(spoof).toMatchObject({ status: 200, body: { result: { initialized: true, user: fixtureUser } } })
    await stock.sdk.createSession({ sessionId: 'stock-sdk', memoryPolicy: { self: { enabled: true }, peer: { enabled: true }, memory_types: ['preferences', 'entities', 'events'] } })
    expect(await stock.sdk.getSession('stock-sdk', false)).toMatchObject({ session_id: 'stock-sdk', message_count: 0, user: { account_id: fixtureAccount, user_id: fixtureUser } })
    expect(await stock.sdk.addMessage('stock-sdk', { role: 'user', content: 'SDK single message', peerId: 'self', createdAt: '2026-11-03T10:00:00Z' })).toMatchObject({ session_id: 'stock-sdk', message_count: 1, pending_tokens: expect.any(Number) })
    expect(await stock.sdk.batchAddMessages('stock-sdk', [{ role: 'assistant', content: 'SDK batch message', peerId: 'self' }])).toMatchObject({ session_id: 'stock-sdk', added: 1, message_count: 2, pending_tokens: expect.any(Number) })
    expect(() => stock.sdk.batchAddMessages('stock-sdk', [{ role: 'user' }])).toThrow('each message requires content or parts')
    const malformed = await stock.probe('/api/v1/sessions/stock-sdk/messages/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user' }] }) })
    expect(malformed).toMatchObject({ status: 400, body: { status: 'error', error: { code: 'INVALID_ARGUMENT' } } })
    expect(await stock.sdk.getSession('stock-sdk', false)).toMatchObject({ message_count: 2 })
    expect(await stock.sdk.getTask('missing-stock-task')).toBeNull()
    const state = await stock.observe()
    expect(state.requests.find(request => request.method === 'POST' && request.path.endsWith('/messages') && !request.probe)?.status).toBe(200)
    expect(state.requests.find(request => request.method === 'POST' && request.path.endsWith('/messages/batch') && request.status === 400)).toBeDefined()
    expect(state.sessions[0]?.archives).toEqual([])
    expectStockOnly(state)
  }, 60000)

  it('syncs two ordinary turns below the default threshold then manually commits through the official task API', async () => {
    const stock = await startStock()
    const { plugin, directory } = await configuredPlugin(stock)
    expect(plugin.getStatus().state).toBe('connected')
    expect(plugin.getPublicConfiguration()).toMatchObject({ schemaVersion: 3, ready: true, settings: { autoCommit: true, commitTokenThreshold: 20000 } })
    for (const round of [1, 2]) {
      await plugin.memory.capture(capture(round))
      expect((await snapshot(plugin)).jobs.find(job => job.status === 'queued' || job.status === 'syncing')).toBeDefined()
      await waitFor(async () => (await snapshot(plugin)).jobs.length === round && (await snapshot(plugin)).jobs.every(job => job.status === 'synced'))
    }
    const before = await stock.observe()
    expect(before.sessions).toHaveLength(1)
    expect(before.sessions[0]).toMatchObject({ session_id: sessionId, meta: { message_count: 4, auto_commit_policy: null, commit_count: 0 }, archives: [] })
    expect(before.sessions[0]!.messages).toHaveLength(4)
    expect(before.sessions[0]!.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(Number(before.sessions[0]!.meta.pending_tokens)).toBeGreaterThan(0)
    expect(Number(before.sessions[0]!.meta.pending_tokens)).toBeLessThan(DEFAULT_SETTINGS.commitTokenThreshold)
    expect(appends(before).map(request => request.body?.messages)).toHaveLength(2)
    expect(commits(before)).toEqual([])
    expect(before.compressor_calls).toEqual([])
    expect(taskReads(before)).toEqual([])
    const submitted = await plugin.manage('flush', {}) as unknown as RuntimeSnapshot
    const job = submitted.jobs.find(item => item.kind === 'commit')!
    expect(job).toMatchObject({ status: 'processing', sessionId, trigger: 'manual', taskId: expect.any(String), archiveUri: `viking://user/${fixtureUser}/sessions/${sessionId}/history/archive_001` })
    const pendingTask = await stock.sdk.getTask(job.taskId!)
    expect(pendingTask).toMatchObject({ task_id: job.taskId, task_type: 'session_commit', resource_id: sessionId, status: 'pending' })
    const during = await stock.observe()
    expect(commits(during)).toHaveLength(1)
    const nativeReceipt = object(commits(during)[0]!.response.result)
    expect(nativeReceipt).toMatchObject({ session_id: sessionId, status: 'accepted', archived: true, task_id: job.taskId, archive_uri: job.archiveUri, trace_id: expect.any(String) })
    expect(nativeReceipt).not.toHaveProperty('changes')
    expect(commits(during)[0]!.body).toMatchObject({ keep_recent_count: 0 })
    expect(during.sessions[0]).toMatchObject({ meta: { message_count: 0, commit_count: 1 }, archives: [{ archive_id: 'archive_001', state: 'pending' }] })
    await stock.control('release')
    await waitFor(async () => (await snapshot(plugin)).jobs.every(item => item.status === 'completed'))
    const completedTask = await stock.sdk.getTask(job.taskId!)
    expect(completedTask).toMatchObject({ task_id: job.taskId, task_type: 'session_commit', resource_id: sessionId, status: 'completed', result: { session_id: sessionId, memories_extracted: {} } })
    const archive = await stock.sdk.getSessionArchive(sessionId, 'archive_001')
    expect(JSON.stringify(archive)).toContain('STOCK-USER-ROUND-1')
    expect(JSON.stringify(archive)).toContain('STOCK-ASSISTANT-ROUND-2')
    const after = await stock.observe()
    expect(after.compressor_calls).toHaveLength(1)
    expect(after.compressor_calls[0]!.message_ids).toHaveLength(4)
    expect(after.sessions[0]!.archives[0]?.state).toBe('completed')
    expect(taskReads(after).some(request => object(request.response.result).status === 'completed')).toBe(true)
    expect(commits(after)).toHaveLength(1)
    expect(appends(after)).toHaveLength(2)
    const persisted = await readFile(join(directory, 'state.json'), 'utf8')
    expect(JSON.parse(persisted).schemaVersion).toBe(3)
    expect(persisted).not.toContain('STOCK-USER-ROUND-')
    expect(persisted).not.toContain('STOCK-ASSISTANT-ROUND-')
    expect(persisted).not.toContain(fixtureKey)
    expectStockOnly(after)
  }, 60000)

  it('retains unknown when the official task expires and never resubmits on flush or reconnect', async () => {
    const stock = await startStock()
    const { plugin, directory } = await configuredPlugin(stock)
    await plugin.memory.capture(capture(1))
    await waitFor(async () => (await snapshot(plugin)).jobs[0]?.status === 'synced')
    const submitted = await plugin.manage('flush', {}) as unknown as RuntimeSnapshot
    const original = submitted.jobs.find(job => job.kind === 'commit')!
    expect(original).toMatchObject({ status: 'processing', taskId: expect.any(String) })
    expect(await stock.control('finish-and-expire')).toMatchObject({ deleted: 1 })
    await waitFor(async () => (await snapshot(plugin)).jobs.find(job => job.id === original.id)?.status === 'unknown')
    expect((await snapshot(plugin)).jobs.find(job => job.id === original.id)).toMatchObject({ taskId: original.taskId, errorCode: 'MEMORY_TASK_UNKNOWN' })
    await plugin.memory.capture(capture(2))
    await plugin.manage('flush', {})
    const beforeReconnect = await stock.observe()
    expect(beforeReconnect.sessions[0]!.archives).toHaveLength(1)
    expect(beforeReconnect.sessions[0]!.archives[0]?.state).toBe('completed')
    expect(appends(beforeReconnect)).toHaveLength(1)
    expect(commits(beforeReconnect)).toHaveLength(1)
    expect(taskReads(beforeReconnect).filter(request => request.status === 404).length).toBeGreaterThanOrEqual(1)
    expect((await snapshot(plugin)).jobs.find(job => job.kind === 'append' && job.commitId === null)?.status).toBe('queued')
    await plugin.disconnect()
    const reopened = new OpenVikingMemoryPlugin(context(directory))
    stops.push(() => reopened.disconnect())
    await reopened.connect()
    await waitFor(async () => taskReads(await stock.observe()).filter(request => request.status === 404).length >= 2)
    await reopened.manage('flush', {})
    expect((await snapshot(reopened)).jobs.find(job => job.id === original.id)).toMatchObject({ status: 'unknown', taskId: original.taskId, archiveUri: original.archiveUri, errorCode: 'MEMORY_TASK_UNKNOWN' })
    const after = await stock.observe()
    expect(taskReads(after).every(request => request.path === '/api/v1/tasks/' + original.taskId)).toBe(true)
    expect(appends(after)).toHaveLength(1)
    expect(commits(after)).toHaveLength(1)
    expect(after.compressor_calls).toHaveLength(1)
    expectStockOnly(after)
  }, 60000)
})
