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
const fixturePrefix = 'Eating_dsh_reset_integration_'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const managePath = '/api/plugins/dsh/manage'
const pngOnePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'DSH reset integration cleanup failed')
})

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object')
  return value
}

async function temporaryHome() {
  const parent = await realpath(tmpdir())
  const home = await realpath(await mkdtemp(join(parent, fixturePrefix)))
  cleanups.push(async () => {
    const target = await realpath(home)
    if (!isAbsolute(target) || target !== home || dirname(target) !== parent || !basename(target).startsWith(fixturePrefix)) throw new Error('Unsafe fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}

async function put(path: string, value: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { mode: 0o600 })
}

async function snapshot(directory: string): Promise<Record<string, { sha256: string; mode: number }>> {
  const files: Record<string, { sha256: string; mode: number }> = {}
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('Unexpected symbolic link in fixture')
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else {
      if (!stat.isFile()) throw new Error('Unexpected special file in fixture')
      files[relative(directory, path)] = { sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mode: stat.mode }
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
    const response = await fetch(url + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: authentication,
      signal: AbortSignal.timeout(60000),
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    return { status: response.status, value: object(await response.json()) }
  }
  async function post(path: string, input: unknown) {
    const response = await request(path, input)
    expect(response.status, JSON.stringify(response.value)).toBeLessThan(300)
    return response.value
  }
  return { url, cookie, headers, request, post, manage: (operation: string, input: unknown) => post(managePath, { operation, input }) }
}

async function fixture(systemRuntime: boolean) {
  const home = await temporaryHome()
  const model = await startStickersModel(() => { throw new Error('DSH reset and persona sync must never invoke a model turn') })
  cleanups.push(() => model.close())
  let plugin!: DshPlugin
  let inbound!: HostPluginContext
  const communication: BackendPluginEntry = {
    id: 'history-chat',
    kind: 'communication',
    storageDirectory: 'history-chat-bot',
    create(context) {
      inbound = context
      return {
        id: 'history-chat',
        kind: 'communication',
        name: 'History fixture source',
        version: '1.0.0',
        tools: [],
        capabilities: [],
        getStatus: () => ({ state: 'connected', accountId: '100', accountName: 'History fixture source', lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
        getPublicConfiguration: () => ({ autoConnect: false }),
        updateConfiguration: async () => ({}),
        connect: async () => {},
        disconnect: async () => {},
        dispose: async () => {},
        invoke: async () => null,
      }
    },
  }
  const harness: BackendPluginEntry = {
    id: 'dsh',
    kind: 'harness',
    storageDirectory: 'dsh',
    create(context) {
      plugin = new DshPlugin(context, { locateSystemDsh: systemRuntime ? testSystemDsh : () => null })
      return plugin
    },
  }
  const ownerToken = randomBytes(32).toString('base64url')
  const host = new EatingHost({ dataDirectory: home, entries: [communication, harness], port: 0, allowedUiOrigins: [], ownerToken, autoConnectOnStartup: false })
  cleanups.push(() => host.close())
  const api = await ownerApi(host, ownerToken)
  await api.post('/api/plugins/dsh/configuration', { endpoint: model.endpoint, apiKey: model.apiKey, model: 'dsh-reset-loopback-fixture', maxTokens: 64, timeoutMs: 15000, autoConnect: false })
  const directory = join(home, 'harness', 'dsh')
  return { home, directory, host, plugin, inbound, api, model, runtime: () => object(plugin.getPublicConfiguration().runtimeStatus) }
}

async function nativeLogs(directory: string) {
  const sessions = join(directory, 'dsh-home', 'sessions')
  let projects
  try { projects = await readdir(sessions, { withFileTypes: true }) } catch { return [] }
  const logs: string[] = []
  for (const project of projects) {
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

async function seedHistory(directory: string, rootId: string) {
  const path = join(directory, 'dsh-home', 'sessions', 'offline-fixture-project', rootId, 'session.v4.jsonl')
  await put(path, JSON.stringify({ type: 'session', version: 4, id: rootId, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 }) + '\n')
  await put(join(directory, 'session.json'), JSON.stringify({ schemaVersion: 1, sessionId: rootId, created: true }) + '\n')
  await put(join(directory, 'workspace', 'draft.txt'), 'WORKSPACE-ITEM')
  await put(join(directory, 'dsh-home', 'profiles', 'sdk-minimal', 'user-plugin.json'), JSON.stringify({ kept: true }))
  return path
}

function expectError(response: { status: number; value: JsonObject }, status: number, code: string) {
  expect(response).toMatchObject({ status, value: { ok: false, error: { code } } })
}

describe('DSH reset & live persona sync through actual Host HTTP', () => {
  it.skipIf(!process.env.EATING_DSH_TEST_SYSTEM_BIN)('syncs persona/prompt live to running DSH, remounts on dual-appearance persona switch, and resets running/stopped DSH without PLUGIN_BUSY while preserving configs & profiles', async () => {
    const current = await fixture(true)
    const personaA = object((await current.api.post('/api/personas', { name: '人格甲', body: 'PERSONA-ALPHA-BODY' })).persona)
    const afterA = object(await current.api.request('/api/authoring').then(r => r.value))
    await current.api.post(`/api/personas/${personaA.id}/activate`, { enabled: true, expectedRevision: afterA.revision })
    const personaB = object((await current.api.post('/api/personas', { name: '人格乙', body: 'PERSONA-BETA-BODY' })).persona)

    current.host.store.setSetting('dsh-reset:protected-setting', 'PROTECTED-SETTING')
    const action = vi.fn(async () => ({ receipt: 'PROTECTED-ACTION' }))
    const actionInput = { target: 'local-business-fixture' }
    const actionResult = await current.host.store.executeIdempotent('history-chat', 'fixture-operation', actionInput, 'dsh-reset-preserved-action', action)
    const protectedExternal = [join(current.home, 'capabilities', 'stickers', 'blobs', 'business-image.png'), join(current.home, 'capabilities', 'openviking-memory', 'state.json')]
    await put(protectedExternal[0]!, pngOnePixel)
    await put(protectedExternal[1]!, JSON.stringify({ fixture: 'OPENVIKING-STATE-PRESERVED' }))

    await current.api.post('/api/plugins/dsh/connect', {})
    expect(current.runtime()).toMatchObject({ ready: true, sessionId: expect.stringMatching(uuid), nativeWeb: { ready: true } })
    const initialRootId = String(current.runtime().sessionId)

    // Verify initial owner-policy.json has Persona A.
    const policyPath = join(current.directory, 'bridge', 'owner-policy.json')
    expect(JSON.parse(await readFile(policyPath, 'utf8')).systemPrompt).toContain('PERSONA-ALPHA-BODY')

    // Switch persona while DSH is running (NO restart, NO QQ inbound!) -> owner-policy.json updates immediately!
    const snapBeforeSwitch = object((await current.api.request('/api/authoring')).value)
    await current.api.post(`/api/personas/${personaB.id}/activate`, { enabled: true, expectedRevision: snapBeforeSwitch.revision })
    const policyAfterSwitch = JSON.parse(await readFile(policyPath, 'utf8')).systemPrompt as string
    expect(policyAfterSwitch).toContain('PERSONA-BETA-BODY')
    expect(policyAfterSwitch).not.toContain('PERSONA-ALPHA-BODY')
    expect(current.runtime().sessionId).toBe(initialRootId)

    // Edit active persona body -> owner-policy.json updates immediately!
    await current.api.post(`/api/personas/${personaB.id}`, { name: '人格乙', body: 'PERSONA-BETA-EDITED', expectedRevision: personaB.revision })
    expect(JSON.parse(await readFile(policyPath, 'utf8')).systemPrompt).toContain('PERSONA-BETA-EDITED')

    // Add appearance images to BOTH personas and switch back to A -> cleanly remounts DSH without breaking MCP!
    await current.api.post(`/api/personas/${personaA.id}/appearances`, { label: '甲外貌图', mimeType: 'image/png', data: pngOnePixel.toString('base64') })
    await current.api.post(`/api/personas/${personaB.id}/appearances`, { label: '乙外貌图', mimeType: 'image/png', data: pngOnePixel.toString('base64') })
    expect(current.runtime().ready).toBe(true)
    expect(JSON.parse(await readFile(policyPath, 'utf8')).systemPrompt).toContain('乙外貌图')
    const snapDual = object((await current.api.request('/api/authoring')).value)
    await current.api.post(`/api/personas/${personaA.id}/activate`, { enabled: true, expectedRevision: snapDual.revision })
    expect(current.runtime().ready).toBe(true)
    expect(current.host.harness.getStatus().state).toBe('attached')
    const policyAfterDual = JSON.parse(await readFile(policyPath, 'utf8')).systemPrompt as string
    expect(policyAfterDual).toContain('PERSONA-ALPHA-BODY')
    expect(policyAfterDual).toContain('甲外貌图')
    expect(policyAfterDual).not.toContain('乙外貌图')

    // Seed workspace files, attachments, schedules, and custom DSH profile plugin file while running.
    const workspaceFile = join(current.directory, 'workspace', 'agent-work.txt')
    const attachment = join(current.directory, 'dsh-home', 'attachments', 'v1', 'objects', 'fixture-content')
    const schedule = join(current.directory, 'dsh-home', 'storages', 'schedule.json')
    const customProfilePlugin = join(current.directory, 'dsh-home', 'profiles', 'sdk-minimal', 'custom-native-plugin.json')
    await put(workspaceFile, 'SHOULD-BE-CLEARED')
    await put(attachment, 'SHOULD-BE-CLEARED')
    await put(schedule, JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { t1: { sessionId: initialRootId, record: { prompt: 'x' }, status: 'active' } } } }))
    await put(customProfilePlugin, JSON.stringify({ plugin: 'kept-native-plugin' }))

    const preservedConfig = await readFile(join(current.directory, 'config.json'))
    const preservedProfiles = await snapshot(join(current.directory, 'dsh-home', 'profiles'))
    const preservedExternal = await Promise.all(protectedExternal.map(path => readFile(path)))
    const authoring = current.host.authoring.getSnapshot()

    // Reset DSH WHILE RUNNING on the VERY FIRST attempt -> no PLUGIN_BUSY, auto-restarts with new sessionId!
    const preview = await current.api.manage('preview-dsh-reset', {})
    expect(preview).toMatchObject({
      previewId: expect.stringMatching(uuid),
      runtimeRunning: true,
      sessionCount: 1,
      rootCount: 1,
      childCount: 0,
      scheduledCount: 1,
      workspaceEntryCount: 1,
      hasResettableData: true,
      hasPendingQueue: false,
      pendingQueueCount: 0,
      uncertainQueueCount: 0,
    })
    const resetInput = { previewId: preview.previewId, requestId: randomUUID(), confirmed: true }
    const result = await current.api.manage('reset-dsh', resetInput)
    expect(result).toEqual({
      requestId: resetInput.requestId,
      status: 'completed',
      deletedSessions: 1,
      clearedWorkspaceEntries: 1,
      clearedScheduledCount: 1,
      clearedQueueCount: 0,
      queueAction: 'none',
      wasRunning: true,
      restarted: true,
    })

    expect(current.runtime()).toMatchObject({ ready: true, sessionId: expect.stringMatching(uuid), nativeWeb: { ready: true } })
    expect(current.host.harness.getStatus()).toMatchObject({ state: 'attached', sinkId: 'dsh' })
    const newRootId = String(current.runtime().sessionId)
    expect(newRootId).not.toBe(initialRootId)
    await expect(lstat(workspaceFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(attachment)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(schedule)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(current.directory, 'workspace'))).toEqual([])
    const newLogs = await nativeLogs(current.directory)
    expect(newLogs).toHaveLength(1)
    expect(newLogs[0]).toContain(newRootId)
    expect(JSON.parse(await readFile(policyPath, 'utf8')).systemPrompt).toContain('PERSONA-ALPHA-BODY')

    // Configs, dsh-home/profiles, authoring, settings, action receipts, external capabilities all preserved!
    expect(await readFile(join(current.directory, 'config.json'))).toEqual(preservedConfig)
    expect(await snapshot(join(current.directory, 'dsh-home', 'profiles'))).toEqual(preservedProfiles)
    expect(await Promise.all(protectedExternal.map(path => readFile(path)))).toEqual(preservedExternal)
    expect(current.host.authoring.getSnapshot()).toEqual(authoring)
    expect(current.host.store.getSetting('dsh-reset:protected-setting')).toBe('PROTECTED-SETTING')
    expect(await current.host.store.executeIdempotent('history-chat', 'fixture-operation', actionInput, 'dsh-reset-preserved-action', action)).toEqual(actionResult)

    // Idempotent replay of the same requestId returns exact result WITHOUT restarting DSH again!
    expect(await current.api.manage('reset-dsh', resetInput)).toEqual(result)
    expect(current.runtime().sessionId).toBe(newRootId)

    // Reset while STOPPED stays stopped (does not auto-start).
    await current.api.post('/api/plugins/dsh/disconnect', {})
    expect(current.runtime().ready).toBe(false)
    const stoppedPreview = await current.api.manage('preview-dsh-reset', {})
    expect(stoppedPreview).toMatchObject({ runtimeRunning: false, sessionCount: 1, hasResettableData: true })
    const stoppedResult = await current.api.manage('reset-dsh', { previewId: stoppedPreview.previewId, requestId: randomUUID(), confirmed: true })
    expect(stoppedResult).toMatchObject({ status: 'completed', deletedSessions: 1, wasRunning: false, restarted: false })
    expect(current.runtime()).toMatchObject({ ready: false, sessionId: null })
    expect(await nativeLogs(current.directory)).toEqual([])
    expect(current.model.requests).toEqual([])
    expect(current.model.errors).toEqual([])
  }, 90000)

  it('enforces auth, CSRF, MCP boundary, and message queue decision gate (reject without choice, keep queue, or clear queue)', async () => {
    const current = await fixture(false)
    const rootId = randomUUID()
    await seedHistory(current.directory, rootId)

    const mcp = await current.api.post('/api/plugins/dsh/mcp-registration', {})
    const connectionHeaders = object(mcp.headers)
    if (typeof connectionHeaders.Authorization !== 'string' || typeof mcp.url !== 'string') throw new Error('Missing actual Host MCP connection')
    const client = new Client({ name: 'dsh-reset-owner-boundary', version: '1.0.0' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: connectionHeaders.Authorization } } }))
    expect((await client.listTools()).tools).toEqual([])
    expect((await client.callTool({ name: 'reset-dsh', arguments: { previewId: randomUUID(), requestId: randomUUID(), confirmed: true } })).isError).toBe(true)

    const before = await snapshot(current.directory)
    const preview = await current.api.manage('preview-dsh-reset', {})
    expect(preview).toMatchObject({ sessionCount: 1, rootCount: 1, childCount: 0, workspaceEntryCount: 1, hasResettableData: true, hasPendingQueue: false })

    const resetInput = { previewId: preview.previewId, requestId: randomUUID(), confirmed: true }
    const previewBody = { operation: 'preview-dsh-reset', input: {} }
    const resetBody = { operation: 'reset-dsh', input: resetInput }
    const publicHeaders = { Origin: current.api.url, 'Content-Type': 'application/json' }
    expectError(await current.api.request(managePath, previewBody, publicHeaders), 401, 'OWNER_AUTHENTICATION_REQUIRED')
    expectError(await current.api.request(managePath, resetBody, publicHeaders), 401, 'OWNER_AUTHENTICATION_REQUIRED')
    expectError(await current.api.request(managePath, resetBody, { ...publicHeaders, Authorization: connectionHeaders.Authorization }), 401, 'OWNER_AUTHENTICATION_REQUIRED')
    expectError(await current.api.request(managePath, resetBody, { ...publicHeaders, Cookie: current.api.cookie }), 403, 'INVALID_CSRF_TOKEN')
    expectError(await current.api.request(managePath, resetBody, { ...current.api.headers, 'X-Eating-Csrf': 'invalid-fixture-csrf' }), 403, 'INVALID_CSRF_TOKEN')
    expectError(await current.api.request(managePath, { operation: 'reset-dsh', input: { previewId: preview.previewId, requestId: randomUUID() } }), 400, 'DSH_RESET_INVALID_INPUT')
    expectError(await current.api.request(managePath, { operation: 'reset-dsh', input: { ...resetInput, path: current.home } }), 400, 'DSH_RESET_INVALID_INPUT')
    expectError(await current.api.request(managePath, { operation: 'preview-dsh-reset', input: { path: current.home } }), 400, 'DSH_RESET_INVALID_INPUT')
    expect(await snapshot(current.directory)).toEqual(before)

    // Enqueue a real inbound message -> queue gate prompts/requires explicit user choice.
    const now = new Date().toISOString()
    const event: HarnessEvent = {
      protocolVersion: 1,
      eventId: randomUUID(),
      pluginId: 'history-chat',
      platform: 'history-chat',
      instanceId: 'history-chat',
      accountId: '100',
      conversationId: 'history-chat:100:private:200',
      senderId: '200',
      targetId: '200',
      messageId: 'pending-reset-fixture-message',
      receivedAt: now,
      source: { trust: 'external', kind: 'private', senderRole: 'user' },
      content: 'PENDING-RESET-FIXTURE-INPUT',
      text: 'PENDING-RESET-FIXTURE-INPUT',
      resourceIds: [],
    }
    const queued = current.inbound.recordEvent('history-chat', 'pending-reset-fixture-event', { fixture: true }, event)
    expect(queued).toMatchObject({ inserted: true, queued: true, admission: 'queued' })

    const queuePreview = await current.api.manage('preview-dsh-reset', {})
    expect(queuePreview).toMatchObject({ hasPendingQueue: true, pendingQueueCount: 1, uncertainQueueCount: 0 })

    // Without queueAction -> rejected with DSH_RESET_QUEUE_DECISION_REQUIRED, files & queue untouched!
    expectError(await current.api.request(managePath, { operation: 'reset-dsh', input: { previewId: queuePreview.previewId, requestId: randomUUID(), confirmed: true } }), 409, 'DSH_RESET_QUEUE_DECISION_REQUIRED')
    expect(await snapshot(current.directory)).toEqual(before)
    expect(current.host.store.getQueuedHarnessEvents()).toHaveLength(1)

    // With queueAction='keep' -> resets DSH files, preserves profiles & keeps queued message!
    const keepResult = await current.api.manage('reset-dsh', { previewId: queuePreview.previewId, requestId: randomUUID(), confirmed: true, queueAction: 'keep' })
    expect(keepResult).toMatchObject({ status: 'completed', deletedSessions: 1, clearedWorkspaceEntries: 1, clearedQueueCount: 0, queueAction: 'keep', wasRunning: false, restarted: false })
    expect(current.host.store.getQueuedHarnessEvents()).toHaveLength(1)
    expect(JSON.parse(await readFile(join(current.directory, 'dsh-home', 'profiles', 'sdk-minimal', 'user-plugin.json'), 'utf8'))).toEqual({ kept: true })

    // Re-seed DSH data and reset with queueAction='clear' -> resets DSH AND clears queued message!
    await seedHistory(current.directory, randomUUID())
    const clearPreview = await current.api.manage('preview-dsh-reset', {})
    expect(clearPreview).toMatchObject({ hasPendingQueue: true, pendingQueueCount: 1 })
    const clearResult = await current.api.manage('reset-dsh', { previewId: clearPreview.previewId, requestId: randomUUID(), confirmed: true, queueAction: 'clear' })
    expect(clearResult).toMatchObject({ status: 'completed', deletedSessions: 1, clearedWorkspaceEntries: 1, clearedQueueCount: 1, queueAction: 'clear', wasRunning: false, restarted: false })
    expect(current.host.store.getQueuedHarnessEvents()).toEqual([])
    expect(JSON.parse(await readFile(join(current.directory, 'dsh-home', 'profiles', 'sdk-minimal', 'user-plugin.json'), 'utf8'))).toEqual({ kept: true })
    expect(current.model.requests).toEqual([])
  }, 30000)

  it.skipIf(!process.env.EATING_DSH_TEST_SYSTEM_BIN)('delivers live-switched persona to real DSH model turns immediately and clears prior turns after reset', async () => {
    const home = await temporaryHome()
    const observedSystemPrompts: string[] = []
    const observedUserTexts: string[] = []
    const model = await startStickersModel(request => {
      const sys = (request.messages ?? []).filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
      const usr = (request.messages ?? []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
      observedSystemPrompts.push(sys)
      observedUserTexts.push(usr)
      return 'OK'
    })
    cleanups.push(() => model.close())
    let plugin!: DshPlugin
    let inbound!: HostPluginContext
    const communication: BackendPluginEntry = {
      id: 'history-chat',
      kind: 'communication',
      storageDirectory: 'history-chat-bot',
      create(context) {
        inbound = context
        return {
          id: 'history-chat',
          kind: 'communication',
          name: 'Loopback source',
          version: '1.0.0',
          tools: [],
          capabilities: [],
          getStatus: () => ({ state: 'connected', accountId: '100', accountName: 'Loopback source', lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
          getPublicConfiguration: () => ({ autoConnect: false }),
          updateConfiguration: async () => ({}),
          connect: async () => {},
          disconnect: async () => {},
          dispose: async () => {},
          invoke: async () => null,
        }
      },
    }
    const harness: BackendPluginEntry = {
      id: 'dsh',
      kind: 'harness',
      storageDirectory: 'dsh',
      create(context) {
        plugin = new DshPlugin(context, { locateSystemDsh: testSystemDsh })
        return plugin
      },
    }
    const ownerToken = randomBytes(32).toString('base64url')
    const host = new EatingHost({ dataDirectory: home, entries: [communication, harness], port: 0, allowedUiOrigins: [], ownerToken, autoConnectOnStartup: false })
    cleanups.push(() => host.close())
    const api = await ownerApi(host, ownerToken)
    await api.post('/api/plugins/dsh/configuration', { endpoint: model.endpoint, apiKey: model.apiKey, model: 'persona-live-loopback', maxTokens: 64, timeoutMs: 15000, autoConnect: false })

    const pA = object((await api.post('/api/personas', { name: '人格一', body: 'PERSONA-LOOPBACK-ALPHA' })).persona)
    const pB = object((await api.post('/api/personas', { name: '人格二', body: 'PERSONA-LOOPBACK-BETA' })).persona)
    const snap1 = object((await api.request('/api/authoring')).value)
    await api.post(`/api/personas/${pA.id}/activate`, { enabled: true, expectedRevision: snap1.revision })
    await api.post('/api/plugins/dsh/connect', {})

    const sendEvent = (tag: string) => {
      const event: HarnessEvent = {
        protocolVersion: 1, eventId: randomUUID(), pluginId: 'history-chat', platform: 'history-chat', instanceId: 'history-chat', accountId: '100',
        conversationId: 'history-chat:100:private:200', senderId: '200', targetId: '200', messageId: tag, receivedAt: new Date().toISOString(),
        source: { trust: 'external', kind: 'private', senderRole: 'user' }, content: tag, text: tag, resourceIds: [],
      }
      inbound.recordEvent('history-chat', tag, { tag }, event)
    }

    sendEvent('TURN-ONE-ALPHA')
    await vi.waitFor(() => expect(observedSystemPrompts.length).toBe(1), { timeout: 20000 })
    expect(observedSystemPrompts[0]).toContain('PERSONA-LOOPBACK-ALPHA')
    expect(observedSystemPrompts[0]).not.toContain('PERSONA-LOOPBACK-BETA')
    await vi.waitFor(() => expect(object(plugin.getPublicConfiguration().runtimeStatus).busy).toBe(false), { timeout: 10000 })

    // Switch persona live WITHOUT restarting DSH -> next model turn gets PERSONA-LOOPBACK-BETA!
    const snap2 = object((await api.request('/api/authoring')).value)
    await api.post(`/api/personas/${pB.id}/activate`, { enabled: true, expectedRevision: snap2.revision })
    sendEvent('TURN-TWO-BETA')
    await vi.waitFor(() => expect(observedSystemPrompts.length).toBe(2), { timeout: 20000 })
    expect(observedSystemPrompts[1]).toContain('PERSONA-LOOPBACK-BETA')
    expect(observedSystemPrompts[1]).not.toContain('PERSONA-LOOPBACK-ALPHA')
    await vi.waitFor(() => expect(object(plugin.getPublicConfiguration().runtimeStatus).busy).toBe(false), { timeout: 10000 })

    // Reset running DSH -> auto-restarts with clean session, Turn 3 has PERSONA-LOOPBACK-BETA and NO Turn 1/2 history!
    const preview = await api.manage('preview-dsh-reset', {})
    const resetResult = await api.manage('reset-dsh', { previewId: preview.previewId, requestId: randomUUID(), confirmed: true })
    expect(resetResult).toMatchObject({ status: 'completed', wasRunning: true, restarted: true })

    sendEvent('TURN-THREE-FRESH')
    await vi.waitFor(() => expect(observedSystemPrompts.length).toBe(3), { timeout: 20000 })
    expect(observedSystemPrompts[2]).toContain('PERSONA-LOOPBACK-BETA')
    expect(observedSystemPrompts[2]).not.toContain('PERSONA-LOOPBACK-ALPHA')
    expect(observedUserTexts[2]).toContain('TURN-THREE-FRESH')
    expect(observedUserTexts[2]).not.toContain('TURN-ONE-ALPHA')
    expect(observedUserTexts[2]).not.toContain('TURN-TWO-BETA')
    expect(model.errors).toEqual([])
  }, 90000)
})
