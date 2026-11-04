import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, HarnessEvent, HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { startStickersModel } from '../../../tests/fixtures/stickers-model'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { EatingHost } from './app'

const cleanups: Array<() => unknown | Promise<unknown>> = []
const fixturePrefix = 'Eating_session_history_integration_'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const managePath = '/api/plugins/dsh/manage'

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Session history integration cleanup failed')
})

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a session history protocol object')
  return value
}

async function temporaryHome() {
  const parent = await realpath(tmpdir())
  const home = await realpath(await mkdtemp(join(parent, fixturePrefix)))
  cleanups.push(async () => {
    const target = await realpath(home)
    if (!isAbsolute(target) || target !== home || dirname(target) !== parent || !basename(target).startsWith(fixturePrefix)) throw new Error('Unsafe session history fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}

async function put(path: string, value: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { mode: 0o600 })
}

async function snapshot(directory: string): Promise<Record<string, { sha256: string; mode: number; modified: number }>> {
  const files: Record<string, { sha256: string; mode: number; modified: number }> = {}
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('Unexpected symbolic link in session history fixture')
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else {
      if (!stat.isFile()) throw new Error('Unexpected special file in session history fixture')
      files[relative(directory, path)] = { sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mode: stat.mode, modified: stat.mtimeMs }
    }
  }
  await visit(directory)
  return files
}

async function ownerApi(host: EatingHost, ownerToken: string) {
  const url = await host.listen()
  const entry = await fetch(url + '/?token=' + ownerToken, { redirect: 'manual' })
  expect(entry.status).toBe(303)
  const accessCookie = entry.headers.get('set-cookie')?.split(';')[0]
  if (!accessCookie) throw new Error('Missing owner access cookie')
  const bootstrap = await fetch(url + '/api/bootstrap', { headers: { Cookie: accessCookie } })
  expect(bootstrap.status).toBe(200)
  const boot = object(await bootstrap.json())
  const sessionCookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
  if (!sessionCookie || typeof boot.csrfToken !== 'string') throw new Error('Missing owner session credentials')
  const cookie = accessCookie + '; ' + sessionCookie
  const headers = { Cookie: cookie, Origin: url, 'X-Eating-Csrf': boot.csrfToken, 'Content-Type': 'application/json' }
  async function request(path: string, input?: unknown, authentication: Record<string, string> = headers) {
    const response = await fetch(url + path, { method: input === undefined ? 'GET' : 'POST', headers: authentication, signal: AbortSignal.timeout(60000),
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    return { status: response.status, value: object(await response.json()) }
  }
  async function post(path: string, input: unknown) {
    const response = await request(path, input)
    expect(response.status, JSON.stringify(response.value)).toBe(200)
    return response.value
  }
  return { url, cookie, headers, request, post, manage: (operation: string, input: unknown) => post(managePath, { operation, input }) }
}

async function fixture(systemRuntime: boolean) {
  const home = await temporaryHome()
  const model = await startStickersModel(() => { throw new Error('Session history operations must never request a model turn') })
  cleanups.push(() => model.close())
  let plugin!: DshPlugin
  let inbound!: HostPluginContext
  const communication: BackendPluginEntry = { id: 'history-chat', kind: 'communication', storageDirectory: 'history-chat-bot', create(context) {
    inbound = context
    return { id: 'history-chat', kind: 'communication', name: 'History fixture source', version: '1.0.0', tools: [], capabilities: [],
      getStatus: () => ({ state: 'connected', accountId: '100', accountName: 'History fixture source', lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({ autoConnect: false }), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, dispose: async () => {}, invoke: async () => null }
  } }
  const harness: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) {
    plugin = new DshPlugin(context, { locateSystemDsh: systemRuntime ? testSystemDsh : () => null })
    return plugin
  } }
  const ownerToken = randomBytes(32).toString('base64url')
  const host = new EatingHost({ dataDirectory: home, entries: [communication, harness], port: 0, allowedUiOrigins: [], ownerToken, autoConnectOnStartup: false })
  cleanups.push(() => host.close())
  const api = await ownerApi(host, ownerToken)
  await api.post('/api/plugins/dsh/configuration', { endpoint: model.endpoint, apiKey: model.apiKey, model: 'session-history-loopback-fixture', maxTokens: 64, timeoutMs: 15000, autoConnect: false })
  const directory = join(home, 'harness', 'dsh')
  return { home, directory, host, plugin, inbound, api, model, runtime: () => object(plugin.getPublicConfiguration().runtimeStatus) }
}

async function nativeLogs(directory: string) {
  const sessions = join(directory, 'dsh-home', 'sessions')
  const logs: string[] = []
  for (const project of await readdir(sessions, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDirectory = join(sessions, project.name)
    for (const session of await readdir(projectDirectory, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDirectory = join(projectDirectory, session.name)
      if ((await readdir(sessionDirectory)).includes('session.v4.jsonl')) logs.push(join(sessionDirectory, 'session.v4.jsonl'))
    }
  }
  return logs.sort()
}

async function header(path: string) {
  return object(JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!))
}

async function seedHistory(directory: string, rootId: string) {
  const path = join(directory, 'dsh-home', 'sessions', 'offline-fixture-project', rootId, 'session.v4.jsonl')
  await put(path, JSON.stringify({ type: 'session', version: 4, id: rootId, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 }) + '\n')
  await put(join(directory, 'session.json'), JSON.stringify({ schemaVersion: 1, sessionId: rootId, created: true }) + '\n')
  return path
}

function expectError(response: { status: number; value: JsonObject }, status: number, code: string) {
  expect(response).toMatchObject({ status, value: { ok: false, error: { code } } })
}

describe('session history owner management through actual Host HTTP', () => {
  it.skipIf(!process.env.EATING_DSH_TEST_SYSTEM_BIN)('clears actual stopped SDK history and reconnects with a new UUID while preserving owner data and idempotent receipts', async () => {
    const current = await fixture(true)
    const created = current.host.authoring.createPersona('History fixture persona', 'SESSION-HISTORY-PERSONA-PRESERVED')
    current.host.authoring.setPersonaEnabled(created.persona.id, true, created.snapshot.revision)
    current.host.store.setSetting('session-history:protected-setting', 'SESSION-HISTORY-SETTING-PRESERVED')
    const action = vi.fn(async () => ({ receipt: 'SESSION-HISTORY-ACTION-PRESERVED' }))
    const actionInput = { target: 'local-business-fixture' }
    const actionResult = await current.host.store.executeIdempotent('history-chat', 'fixture-operation', actionInput, 'session-history-preserved-action', action)
    const protectedFiles = [join(current.home, 'capabilities', 'stickers', 'blobs', 'business-image.png'), join(current.home, 'capabilities', 'openviking-memory', 'state.json')]
    await put(protectedFiles[0]!, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await put(protectedFiles[1]!, JSON.stringify({ fixture: 'OPENVIKING-STATE-PRESERVED' }))
    await current.api.post('/api/plugins/dsh/connect', {})
    expect(current.runtime()).toMatchObject({ ready: true, sessionId: expect.stringMatching(uuid), nativeWeb: { ready: true } })
    const rootId = String(current.runtime().sessionId)
    const logs = await nativeLogs(current.directory)
    expect(logs).toHaveLength(1)
    const rootLog = logs[0]!
    expect(await header(rootLog)).toMatchObject({ type: 'session', version: 4, id: rootId, isSeeded: false, delegationDepth: 0 })
    const activeFiles = await Promise.all([readFile(rootLog), readFile(join(current.directory, 'session.json'))])
    expectError(await current.api.request(managePath, { operation: 'clear-session-history', input: { previewId: randomUUID(), requestId: randomUUID(), confirmed: true } }), 409, 'SESSION_HISTORY_RUNTIME_ACTIVE')
    expect(await Promise.all([readFile(rootLog), readFile(join(current.directory, 'session.json'))])).toEqual(activeFiles)
    await current.api.post('/api/plugins/dsh/disconnect', {})
    expect(current.runtime().ready).toBe(false)
    expect(current.host.harness.getStatus()).toMatchObject({ state: 'not-attached', queueMessages: 0 })

    const nativeLock = join(dirname(rootLog), 'session.lock')
    const nativeLockStat = await lstat(nativeLock)
    expect(nativeLockStat.size).toBe(0)
    const stoppedLock = await readFile(nativeLock)
    const childId = randomUUID()
    const childLog = join(dirname(dirname(rootLog)), childId, 'session.v4.jsonl')
    await put(childLog, JSON.stringify({ type: 'session', version: 4, id: childId, createdAt: Date.now(), isSeeded: false, delegationDepth: 1, parentSession: rootId, origin: 'subagent' }) + '\n')
    const bindings = join(current.directory, 'agent-bindings.json')
    await put(bindings, JSON.stringify({ schemaVersion: 2, bindings: [{ key: 'history-integration-binding', parentId: rootId, configurationRevision: current.host.authoring.getSnapshot().revision,
      scope: { agentId: childId, agentTypeId: 'history-chat.private', pluginId: 'history-chat', instanceId: 'history-chat', accountId: '100', conversationId: 'history-chat:100:private:200', kind: 'private', targetId: '200', messageIds: [], resourceIds: [] }, taskRefs: [] }] }))
    await put(join(current.directory, 'proactive-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: [] }))
    const attachment = join(current.directory, 'dsh-home', 'attachments', 'v1', 'objects', 'fixture-content')
    const cache = join(current.directory, 'dsh-home', 'storages', 'session_projcache', 'sessions', rootId + '.json')
    await put(attachment, 'SESSION-HISTORY-ATTACHMENT')
    await put(cache, JSON.stringify({ version: 7, record: { identity: { createdAt: Date.now(), isSeeded: false }, rows: { fixture: { ver: 1, seq: -1, val: { fixture: 'SESSION-HISTORY-CACHE' } } } } }))
    const workspace = join(current.directory, 'dsh-home', 'storages', 'workspace.json')
    const workspaceId = 'history-fixture-workspace'
    const workspaceRow = { path: join(current.directory, 'workspace'), title: 'Workspace title must survive', sessionIds: [rootId, childId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const workspaceData = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [workspaceId], defaultWorkspaceId: workspaceId, archivedSessionIds: [rootId], pinnedSessionIds: [childId] }, tables: { workspaces: { [workspaceId]: workspaceRow } } }
    await put(workspace, JSON.stringify(workspaceData))
    const preserved = await Promise.all(protectedFiles.map(path => readFile(path)))
    const configuration = await readFile(join(current.directory, 'config.json'))
    const profiles = await snapshot(join(current.directory, 'dsh-home', 'profiles'))
    const authoring = current.host.authoring.getSnapshot()
    const settings = current.host.store.getDeliverySettingsSnapshot()
    const beforePreview = await snapshot(current.directory)
    const preview = await current.api.manage('preview-session-history', {})
    expect(preview).toEqual({ previewId: expect.stringMatching(uuid), expiresAt: expect.any(String), sessionCount: 2, rootCount: 1, childCount: 1 })
    expect(Date.parse(String(preview.expiresAt))).toBeGreaterThan(Date.now())
    expect(await snapshot(current.directory)).toEqual(beforePreview)
    const input = { previewId: preview.previewId, requestId: randomUUID(), confirmed: true }
    const result = await current.api.manage('clear-session-history', input)
    expect(result).toEqual({ requestId: input.requestId, status: 'completed', deletedCount: 2 })
    for (const path of [rootLog, childLog, attachment, cache, bindings, join(current.directory, 'session.json'), join(current.directory, 'proactive-bindings.json'), join(current.directory, 'bridge', 'session-ready.json'), join(current.directory, 'bridge', 'owner-policy.json')]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await nativeLogs(current.directory)).toEqual([])
    expect(await readFile(nativeLock)).toEqual(stoppedLock)
    expect((await lstat(nativeLock)).ino).toBe(nativeLockStat.ino)
    expect(object(JSON.parse(await readFile(workspace, 'utf8')))).toEqual({ ...workspaceData, global: { ...workspaceData.global, archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { [workspaceId]: { ...workspaceRow, sessionIds: [] } } } })
    expect(current.runtime()).toMatchObject({ ready: false, sessionId: null })
    expect(await readFile(join(current.directory, 'config.json'))).toEqual(configuration)
    expect(await snapshot(join(current.directory, 'dsh-home', 'profiles'))).toEqual(profiles)
    expect(await Promise.all(protectedFiles.map(path => readFile(path)))).toEqual(preserved)
    expect(current.host.authoring.getSnapshot()).toEqual(authoring)
    expect(current.host.store.getDeliverySettingsSnapshot()).toEqual(settings)
    expect(current.host.store.getSetting('session-history:protected-setting')).toBe('SESSION-HISTORY-SETTING-PRESERVED')
    expect(await current.host.store.executeIdempotent('history-chat', 'fixture-operation', actionInput, 'session-history-preserved-action', action)).toEqual(actionResult)
    expect(action).toHaveBeenCalledOnce()

    await current.api.post('/api/plugins/dsh/connect', {})
    expect(current.runtime()).toMatchObject({ ready: true, sessionId: expect.stringMatching(uuid), nativeWeb: { ready: true } })
    const newId = String(current.runtime().sessionId)
    expect(newId).not.toBe(rootId)
    const newLogs = await nativeLogs(current.directory)
    expect(newLogs).toHaveLength(1)
    expect(await header(newLogs[0]!)).toMatchObject({ type: 'session', version: 4, id: newId })
    await current.api.post('/api/plugins/dsh/disconnect', {})
    const beforeRepeat = await snapshot(current.directory)
    expect(await current.api.manage('clear-session-history', input)).toEqual(result)
    expect(await snapshot(current.directory)).toEqual(beforeRepeat)
    expect(await nativeLogs(current.directory)).toEqual(newLogs)
    expect(current.runtime().sessionId).toBe(newId)
    await expect(lstat(bindings)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(current.model.requests).toEqual([])
    expect(current.model.errors).toEqual([])
  }, 60000)

  it('rejects anonymous, non-owner, CSRF, arbitrary inputs and pending inbound work without changing history files or invoking a model', async () => {
    const current = await fixture(false)
    const rootId = randomUUID()
    const rootLog = await seedHistory(current.directory, rootId)
    const mcp = await current.api.post('/api/plugins/dsh/mcp-registration', {})
    const connectionHeaders = object(mcp.headers)
    if (typeof connectionHeaders.Authorization !== 'string' || typeof mcp.url !== 'string') throw new Error('Missing actual Host MCP connection')
    const client = new Client({ name: 'session-history-owner-boundary', version: '1.0.0' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: connectionHeaders.Authorization } } }))
    expect((await client.listTools()).tools).toEqual([])
    expect((await client.callTool({ name: 'clear-session-history', arguments: { previewId: randomUUID(), requestId: randomUUID(), confirmed: true } })).isError).toBe(true)
    const before = await snapshot(current.directory)
    const preview = await current.api.manage('preview-session-history', {})
    expect(preview).toMatchObject({ sessionCount: 1, rootCount: 1, childCount: 0 })
    const clearInput = { previewId: preview.previewId, requestId: randomUUID(), confirmed: true }
    const previewBody = { operation: 'preview-session-history', input: {} }
    const clearBody = { operation: 'clear-session-history', input: clearInput }
    const publicHeaders = { Origin: current.api.url, 'Content-Type': 'application/json' }
    expectError(await current.api.request(managePath, previewBody, publicHeaders), 401, 'OWNER_AUTHENTICATION_REQUIRED')
    expectError(await current.api.request(managePath, clearBody, publicHeaders), 401, 'OWNER_AUTHENTICATION_REQUIRED')
    expectError(await current.api.request(managePath, clearBody, { ...publicHeaders, Authorization: connectionHeaders.Authorization }), 401, 'OWNER_AUTHENTICATION_REQUIRED')
    expectError(await current.api.request(managePath, clearBody, { ...publicHeaders, Cookie: current.api.cookie }), 403, 'INVALID_CSRF_TOKEN')
    expectError(await current.api.request(managePath, clearBody, { ...current.api.headers, 'X-Eating-Csrf': 'invalid-fixture-csrf' }), 403, 'INVALID_CSRF_TOKEN')
    expectError(await current.api.request(managePath, { operation: 'clear-session-history', input: { previewId: preview.previewId, requestId: randomUUID() } }), 400, 'SESSION_HISTORY_INVALID_INPUT')
    expectError(await current.api.request(managePath, { operation: 'clear-session-history', input: { ...clearInput, path: current.home } }), 400, 'SESSION_HISTORY_INVALID_INPUT')
    expectError(await current.api.request(managePath, { operation: 'preview-session-history', input: { path: current.home } }), 400, 'SESSION_HISTORY_INPUT_INVALID')
    expect(await snapshot(current.directory)).toEqual(before)

    const now = new Date().toISOString()
    const event: HarnessEvent = { protocolVersion: 1, eventId: randomUUID(), pluginId: 'history-chat', platform: 'history-chat', instanceId: 'history-chat', accountId: '100',
      conversationId: 'history-chat:100:private:200', senderId: '200', targetId: '200', messageId: 'pending-history-fixture-message', receivedAt: now,
      source: { trust: 'external', kind: 'private', senderRole: 'user' }, content: 'PENDING-HISTORY-FIXTURE-INPUT', text: 'PENDING-HISTORY-FIXTURE-INPUT', resourceIds: [] }
    const queued = current.inbound.recordEvent('history-chat', 'pending-history-fixture-event', { fixture: true }, event)
    expect(queued).toMatchObject({ inserted: true, queued: true, admission: 'queued' })
    expect(current.host.harness.getStatus()).toMatchObject({ state: 'not-attached', queueMessages: 1, pending: 1, accepted: 0 })
    const pending = current.host.store.getQueuedHarnessEvents()
    expect(pending).toEqual([expect.objectContaining({ status: 'pending', attempts: 0, event: expect.objectContaining({ text: event.text }) })])
    await current.api.post('/api/plugins/dsh/disconnect', {})
    expect(current.host.store.getQueuedHarnessEvents()).toEqual(pending)
    expectError(await current.api.request(managePath, { operation: 'clear-session-history', input: clearInput }), 409, 'SESSION_HISTORY_QUEUE_PENDING')
    expectError(await current.api.request(managePath, previewBody), 409, 'SESSION_HISTORY_QUEUE_PENDING')
    expect(await snapshot(current.directory)).toEqual(before)
    expect(current.host.store.getQueuedHarnessEvents()).toEqual(pending)
    expect(await header(rootLog)).toMatchObject({ id: rootId, version: 4 })
    expect(current.model.requests).toEqual([])
    expect(current.model.errors).toEqual([])
  }, 20000)
})
