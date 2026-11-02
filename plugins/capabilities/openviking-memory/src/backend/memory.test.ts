import { mkdtemp, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityInvocationScope, HostPluginContext, MemoryCaptureInput, MemoryContext, MemoryScope } from '@eating/plugin-sdk'
import { OpenVikingMemoryPlugin } from '../server'
import { DEFAULT_SETTINGS } from '../types'
import type { MemorySettings, RuntimeSnapshot, ScopeRule } from '../types'
import { startOpenVikingFixture } from './testing/openviking-fixture'
import { archive, localDay, StateStore } from './state'
import { globalRoot, memoryLocation, peerRoot } from './scopes'
import { serviceIdentity } from './validation'

type Service = Awaited<ReturnType<typeof startOpenVikingFixture>>
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.useRealTimers() })
async function home() {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-ov-memory-')))
  stops.push(async () => { if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-ov-memory-')) throw new Error('Unsafe fixture cleanup'); await rm(root, { recursive: true }) })
  return root
}
function host(dataDirectory: string): HostPluginContext { return { dataDirectory, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: true, eventId: 'unused' }), listMessages: () => [], executeIdempotent: async () => { throw new Error('Must not persist raw memory tool arguments in Host ledger') } } }
async function fixture(options: { root?: string; settings?: Partial<MemorySettings>; apiKey?: string; user?: string; account?: string } = {}) {
  const provider = await startOpenVikingFixture({ apiKey: options.apiKey, user: options.user, account: options.account }); stops.push(provider.close)
  const directory = options.root ?? await home(), plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect())
  await plugin.updateConfiguration({ expectedRevision: 0, endpoint: provider.endpoint, account: provider.account, user: provider.user, apiKey: provider.apiKey, autoConnect: false, timeoutMs: 1000, settings: { ...structuredClone(DEFAULT_SETTINGS), ...options.settings } })
  return { ...provider, plugin, directory }
}
const self: MemoryScope = { kind: 'self', platform: '', accountId: '', targetId: '', owner: true }
const privateScope: MemoryScope = { kind: 'private', platform: 'qq', accountId: '1001', targetId: '2001', owner: false }
const group: MemoryScope = { ...privateScope, kind: 'group', targetId: '3001' }
const sessionId = 'eating-live-qq-1001-private-2001'
function context(current: MemoryScope = privateScope, turnId = 'turn-001'): MemoryContext { return { agentId: 'main-agent', agentTypeId: 'main', turnId, scope: current } }
function capture(current = privateScope, turnId = 'turn-001', overrides: Partial<MemoryCaptureInput> = {}): MemoryCaptureInput {
  return { context: context(current, turnId), messages: [{ role: 'user', text: 'PRIVATE-USER-CHAT likes tea', senderId: '2001', timestamp: '2026-11-01T13:00:00Z' }, { role: 'assistant', text: 'PRIVATE-ASSISTANT-CHAT noted', timestamp: '2026-11-01T13:00:01Z' }], actions: [], outcome: 'completed', ...overrides }
}
const snapshot = async (plugin: OpenVikingMemoryPlugin) => await plugin.manage('snapshot', {}) as unknown as RuntimeSnapshot
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 4000) { await vi.waitFor(async () => expect(await check()).toBe(true), { interval: 15, timeout }) }
const invocation = (current: MemoryScope, signal?: AbortSignal): CapabilityInvocationScope => ({ agentId: 'main-agent', agentTypeId: 'main', memory: context(current), signal })
const rule = (patch: Partial<ScopeRule> = {}): ScopeRule => ({ id: 'group-rule', label: 'Optional nickname', platform: 'qq', accountId: '1001', kind: 'group', targetId: '3001', capture: true, recall: true, memberMode: 'all', memberIds: [], ...patch })
const appends = (f: Service) => f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/incremental-memory'))
const receiptReads = (f: Service) => f.requests.filter(request => request.method === 'GET' && request.path.includes('/incremental-memory/requests/'))
function expectIncrementalOnly(f: Service): void {
  expect(f.requests.filter(request => /\/(?:messages(?:\/batch)?|commit)$/.test(request.path))).toEqual([])
  expect(f.requests.filter(request => request.method === 'DELETE' && request.path.includes('/sessions/'))).toEqual([])
  expect(f.requests.filter(request => request.path.includes('/tasks/'))).toEqual([])
  expect(f.errors).toEqual([])
}
async function direct(f: Service, path: string, body?: Record<string, unknown>) {
  const response = await fetch(f.endpoint + '/api/v1' + path, { method: body ? 'POST' : 'GET', headers: { 'X-API-Key': f.apiKey, 'X-OpenViking-User': f.user, 'X-OpenViking-Account': f.account, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, value: await response.json() as { status: string; result: Record<string, unknown> } }
}
async function nativeSession(f: Service) {
  expect((await direct(f, '/sessions', { session_id: sessionId, memory_policy: { peer: { enabled: true }, self: { enabled: true }, memory_types: ['preferences', 'entities', 'events'] }, auto_commit_policy: null })).status).toBe(200)
}

// No paid models or live installations: real SDK requests use independent loopback services.
describe('loopback incremental protocol', () => {
  it('advertises the extension and atomically dedupes requests before checking the advanced sequence', async () => {
    const f = await startOpenVikingFixture(); stops.push(f.close)
    expect(await direct(f, '/eating-memory/capabilities')).toEqual({ status: 200, value: { status: 'ok', result: { protocol_version: 1, server_version: '0.5.2.1', incremental_extraction: true, history_segmentation: true } } })
    await nativeSession(f)
    const path = `/sessions/${sessionId}/incremental-memory`, input = { request_id: 'request-one', expected_sequence: 0, archive_max_bytes: 8 * 1024 * 1024, messages: [{ role: 'user', content: 'first fact', peer_id: 'qq-1001-private-2001', created_at: '2026-11-01T13:00:00Z' }] }
    expect((await direct(f, path)).value.result).toEqual({ protocol_version: 1, session_id: sessionId, next_sequence: 0, extracted_sequence: 0, pending_messages: 0 })
    const accepted = await direct(f, path, input)
    expect(accepted.value.result).toMatchObject({ protocol_version: 1, session_id: sessionId, request_id: 'request-one', status: 'accepted', task_id: expect.any(String), from_sequence: 0, to_sequence: 1, changes: null, error_code: null, archive_uris: [] })
    expect(await direct(f, path, input)).toEqual(accepted)
    expect((await direct(f, path)).value.result).toMatchObject({ next_sequence: 1, extracted_sequence: 0, pending_messages: 1 })
    expect((await direct(f, path, { ...input, messages: [{ ...input.messages[0], content: 'conflicting fact' }] })).status).toBe(409)
    expect((await direct(f, path, { ...input, request_id: 'stale-sequence' })).status).toBe(409)
    expect(f.sessions.get(sessionId)!.messages).toHaveLength(1); expect(f.submissions).toHaveLength(1); expect(f.receipts.size).toBe(1); expect(f.tasks.size).toBe(1)
    const completed = await direct(f, path + '/requests/request-one')
    expect(completed.value.result).toMatchObject({ status: 'completed', changes: { added: 1, updated: 2, deleted: 0 }, archive_uris: [] })
    f.tasks.clear(); expect(await direct(f, path + '/requests/request-one')).toEqual(completed)
    expect(await direct(f, path, input)).toEqual(completed); expect(f.extractions).toHaveLength(1); expect(f.archives.size).toBe(0)
    expect((await direct(f, path)).value.result).toMatchObject({ next_sequence: 1, extracted_sequence: 1, pending_messages: 0 })
    expectIncrementalOnly(f)
  })

  it('segments only at volume and extracts each new sequence once across the segmented history', async () => {
    const f = await startOpenVikingFixture(); stops.push(f.close); await nativeSession(f)
    const path = `/sessions/${sessionId}/incremental-memory`
    for (let n = 0; n < 3; n++) {
      if (n === 1) f.controls.simulatedHistoryBytes = 8 * 1024 * 1024
      const result = await direct(f, path, { request_id: `round-${n}`, expected_sequence: n, archive_max_bytes: 8 * 1024 * 1024, messages: [{ role: 'user', content: `new fact ${n}`, peer_id: 'qq-1001-private-2001', created_at: '2026-11-01T13:00:00Z' }] })
      expect(result.value.result.archive_uris).toEqual(n === 1 ? [`viking://user/${f.user}/sessions/${sessionId}/history/archive_001`] : [])
      await direct(f, path + `/requests/round-${n}`)
    }
    expect(f.extractions.map(extraction => extraction.messages.map(message => message.content))).toEqual([['new fact 0'], ['new fact 1'], ['new fact 2']])
    expect([...f.archives.values()][0]!.messages.map(message => message.content)).toEqual(['new fact 0', 'new fact 1'])
    expect(f.sessions.get(sessionId)).toMatchObject({ nextSequence: 3, extractedSequence: 3, archivedSequence: 2 })
    expectIncrementalOnly(f)
  })
})

describe('OpenViking current backend contract', () => {
  it('starts inert with schema2 defaults, tests saved identity and extension without sessions, and protects secrets with CAS', async () => {
    const directory = await home(), plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect())
    expect(plugin.getPublicConfiguration()).toMatchObject({ schemaVersion: 2, revision: 0, endpoint: '', user: '', ready: false, autoConnect: false, settings: DEFAULT_SETTINGS })
    expect(DEFAULT_SETTINGS.archiveMaxMiB).toBe(8)
    await plugin.memory.capture(capture()); expect((await snapshot(plugin)).jobs).toHaveLength(0)
    const f = await startOpenVikingFixture(); stops.push(f.close)
    const update = { expectedRevision: 0, endpoint: f.endpoint, account: f.account, user: f.user, apiKey: f.apiKey, autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS }
    await plugin.updateConfiguration(update); expect(f.requests).toHaveLength(0)
    expect(await plugin.manage('test-connection', {})).toEqual({ ok: true }); expect(f.sessions.size).toBe(0)
    expect(f.requests.map(request => request.path.slice(new URL(f.endpoint).pathname.length))).toEqual(['/api/v1/system/status', '/api/v1/eating-memory/capabilities'])
    expect(plugin.getPublicConfiguration().ready).toBe(false)
    await plugin.connect(); expect(plugin.getStatus().state).toBe('connected')
    await plugin.updateConfiguration({ ...update, expectedRevision: 1, apiKey: '' }); expect(plugin.getPublicConfiguration()).toMatchObject({ revision: 2, apiKeyConfigured: true, ready: true })
    await expect(plugin.updateConfiguration({ ...update, expectedRevision: 1 })).rejects.toMatchObject({ code: 'MEMORY_CONFIGURATION_CONFLICT' })
    expect(JSON.stringify(plugin.getPublicConfiguration())).not.toContain(f.apiKey)
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')); expect(config.apiKey).toBe(f.apiKey)
    if (process.platform !== 'win32') expect((await lstat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600)
    await plugin.updateConfiguration({ ...update, expectedRevision: 2, apiKey: '', clearApiKey: true }); expect(plugin.getPublicConfiguration()).toMatchObject({ apiKeyConfigured: false, ready: false })
  })

  it.each([{ user: 'eating-bot', account: 'team-1' }, { user: 'eating.bot@team', account: 'team.1@org' }])('uses official service identities through SDK recall, incremental restart, read and memory-file deletion: %j', async service => {
    const f = await fixture(service); await f.plugin.connect()
    const root = `viking://user/${service.user}`, global = root + '/memories/preferences/global.md', local = root + '/peers/qq-1001-private-2001/memories/preferences/local.md'
    expect(globalRoot(service.user)).toBe(root + '/memories'); expect(peerRoot(service.user, 'qq-1001-private-2001')).toBe(root + '/peers/qq-1001-private-2001/memories')
    f.memories.set(global, 'tea global'); f.memories.set(local, 'tea local')
    expect((await f.plugin.memory.recall(context(), 'tea')).items.map(item => item.uri)).toEqual([global, local])
    f.controls.incrementalStatus = 'processing'
    await f.plugin.memory.capture(capture()); await waitFor(() => receiptReads(f).length > 0)
    const processing = (await snapshot(f.plugin)).jobs[0]!
    expect(processing).toMatchObject({ status: 'processing', archiveUri: null })
    expect(appends(f)[0]!.headers).toMatchObject({ 'x-openviking-user': service.user, 'x-openviking-account': service.account })
    await f.plugin.disconnect()
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); f.controls.incrementalStatus = 'completed'; f.tasks.clear(); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'completed')
    expect(f.submissions).toHaveLength(1); expect(f.sessions.get(processing.sessionId)!.messages).toMatchObject([{ role: 'user' }, { role: 'assistant' }]); expect((await snapshot(resumed)).jobs[0]?.changes).toEqual({ added: 1, updated: 2, deleted: 0 })
    expect(await resumed.manage('read', { uri: global })).toEqual({ uri: global, text: 'tea global' })
    expect(await resumed.manage('delete', { uri: local, confirmed: true })).toEqual({ deleted: true }); expect(f.memories.has(local)).toBe(false)
    expectIncrementalOnly(f)
  })

  it('validates service identities separately from peer tuples and compares archive owners exactly', () => {
    for (const value of ['eating-bot', 'team.1', 'bot@team', '_user', 'u'.repeat(96)]) expect(serviceIdentity(value)).toBe(value)
    expect(serviceIdentity('', true)).toBe(''); expect(serviceIdentity('team-1', false, true)).toBe('team-1')
    for (const value of ['', '.', '..', 'a@@b', 'a/b', 'a\\b', 'a%2fb', 'a?b', 'a#b', 'has space', 'a\nb', 'u'.repeat(97)]) expect(() => serviceIdentity(value)).toThrow('MEMORY_INVALID_INPUT')
    expect(() => serviceIdentity('_account', false, true)).toThrow('MEMORY_INVALID_INPUT')
    const id = 'eating-00000000-0000-4000-8000-000000000000', user = 'eating.bot@team', uri = `viking://user/${user}/sessions/${id}/history/archive_001`
    expect(archive(uri, id, user)).toBe(uri); expect(archive(uri, id)).toBe(uri)
    for (const denied of [uri.replace('eating.bot@team', 'eatingXbot@team'), uri.replace('/sessions/', '/memories/'), uri.replace('archive_001', '../messages'), uri.replace('eating.bot@team', '..'), uri + '/messages.jsonl', uri.replace('archive_001', 'archive_001?key=private')]) expect(() => archive(denied, id, user)).toThrow('MEMORY_UNSUPPORTED_SERVER')
    expect(memoryLocation(`viking://user/${user}/memories/preferences/tea.md`, user).peer).toBeNull()
    expect(() => memoryLocation('viking://user/eatingXbot@team/memories/preferences/tea.md', user)).toThrow('MEMORY_URI_DENIED')
    expect(() => peerRoot(user, 'qq-team-1-private-2001')).toThrow('MEMORY_INVALID_INPUT')
  })

  it('rejects auth mismatch, non-current envelopes, provider secrets and redirects with fixed codes', async () => {
    const f = await fixture(); f.controls.rejectAuth = true
    await expect(f.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_AUTH_FAILED', message: 'MEMORY_AUTH_FAILED' })
    expect(JSON.stringify(await snapshot(f.plugin))).not.toContain(f.apiKey)
    f.controls.rejectAuth = false; f.controls.identityUser = 'wrong_user'
    await expect(f.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_IDENTITY_MISMATCH' })
    f.controls.identityUser = null
    f.controls.intercept = (_request, response) => { response.end(JSON.stringify({ healthy: true, result: { user: f.user } })); return true }
    await expect(f.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_UNSUPPORTED_SERVER' })
    f.controls.intercept = (_request, response) => { response.writeHead(302, { Location: '/private?key=' + f.apiKey }); response.end(); return true }
    await expect(f.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_REDIRECT_DENIED' })
    expect(f.requests).toHaveLength(4)
  })

  it('fails connect and connection tests when the known extension is missing, without creating sessions', async () => {
    const f = await fixture(); f.controls.extensionAvailable = false
    await expect(f.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_INCREMENTAL_UNSUPPORTED' })
    await expect(f.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_INCREMENTAL_UNSUPPORTED' })
    expect(f.sessions.size).toBe(0); expect(f.plugin.getPublicConfiguration().ready).toBe(false)
    expect((await snapshot(f.plugin)).lastErrorCode).toBe('MEMORY_INCREMENTAL_UNSUPPORTED')
  })

  it('rejects old schema1 configuration and state without migration or overwriting their bytes', async () => {
    const directory = await home(), path = join(directory, 'config.json'), old = JSON.stringify({ schemaVersion: 1, revision: 2, endpoint: 'http://127.0.0.1:1', account: 'old', user: 'old', apiKey: 'PRIVATE', autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS })
    await writeFile(path, old)
    expect(() => new OpenVikingMemoryPlugin(host(directory))).toThrow('MEMORY_CONFIGURATION_CORRUPTED'); expect(await readFile(path, 'utf8')).toBe(old)
    const stateHome = await home(), statePath = join(stateHome, 'state.json'), previous = JSON.stringify({ schemaVersion: 1, jobs: [], scopes: [], lastRecallAt: null, lastCaptureAt: null, lastErrorCode: null, extractionDay: localDay(), extractionCount: 0 })
    await writeFile(statePath, previous)
    expect(() => new OpenVikingMemoryPlugin(host(stateHome))).toThrow('MEMORY_STATE_CORRUPTED'); expect(await readFile(statePath, 'utf8')).toBe(previous)
  })

  it('rejects removed gates, out-of-range archive sizes, scope collisions, unknown fields and file CAS conflicts', async () => {
    const f = await fixture(), input = { ...f.plugin.getPublicConfiguration(), expectedRevision: 1 }
    const config = JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8'))
    const patch = { expectedRevision: 1, endpoint: f.endpoint, account: f.account, user: f.user, autoConnect: false, timeoutMs: 1000, settings: structuredClone(DEFAULT_SETTINGS) }
    const removed = [{ submissionMode: 'turn' }, { batchMessages: 4 }, { batchChars: 1000 }, { idleSeconds: 5 }, { tokenThreshold: 128 }]
    for (const invalid of [{ ...patch, user: '../escape' }, { ...patch, endpoint: f.endpoint + '?key=private' }, { ...patch, account: '_reserved' }, ...[0, 65, 1.5].map(archiveMaxMiB => ({ ...patch, settings: { ...DEFAULT_SETTINGS, archiveMaxMiB } })), ...removed.map(value => ({ ...patch, settings: { ...DEFAULT_SETTINGS, ...value } })), { ...patch, settings: { ...DEFAULT_SETTINGS, rules: [rule(), rule({ id: 'other' })] } }, input]) await expect(f.plugin.updateConfiguration(invalid)).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONFIGURATION' })
    expect(f.plugin.getPublicConfiguration().revision).toBe(1)
    await writeFile(join(f.directory, 'config.json'), JSON.stringify({ ...config, revision: 2 }))
    await expect(f.plugin.updateConfiguration(patch)).rejects.toMatchObject({ code: 'MEMORY_CONFIGURATION_CONFLICT' })
    expect(JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8')).revision).toBe(2)
  })

  it.each([1, 64])('passes the accepted %i MiB archive limit as bytes on every realtime append', async archiveMaxMiB => {
    const f = await fixture({ settings: { archiveMaxMiB } }); await f.plugin.connect(); await f.plugin.memory.capture(capture())
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect(appends(f)[0]!.body.archive_max_bytes).toBe(archiveMaxMiB * 1024 * 1024); expect(f.archives.size).toBe(0)
  })

  it('recalls current peer and global, restricts all-peer search to private owners and respects global off', async () => {
    const f = await fixture(); await f.plugin.connect()
    const root = `viking://user/${f.user}`, current = root + '/peers/qq-1001-private-2001/memories/preferences/tea.md', global = root + '/memories/preferences/global.md', other = root + '/peers/qq-1001-private-9999/memories/preferences/other.md'
    f.memories.set(current, 'tea local'); f.memories.set(global, 'tea global'); f.memories.set(other, 'tea other')
    const local = await f.plugin.memory.recall(context(), 'tea')
    expect(local.items.map(hit => hit.uri)).toEqual([current, global]); expect(local.text).toContain('tea local')
    const request = f.requests.find(item => item.path.endsWith('/search/find'))!
    expect(request.body).toMatchObject({ target_uri: [root + '/memories', root + '/peers/qq-1001-private-2001/memories'], context_type: 'memory', level: [2], score_threshold: 0.35 }); expect(request.headers['x-openviking-actor-peer']).toBe('qq-1001-private-2001')
    await expect(f.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'read-id', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    expect((await f.plugin.memory.recall(context({ ...privateScope, owner: true }), 'tea')).items).toHaveLength(2)
    expect(await f.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'owner-read', invocation({ ...privateScope, owner: true }))).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ uri: other })]) })
    await expect(f.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'group-read', invocation({ ...group, owner: true }))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    await f.plugin.updateConfiguration({ expectedRevision: 1, endpoint: f.endpoint, account: f.account, user: f.user, autoConnect: false, timeoutMs: 1000, settings: { ...DEFAULT_SETTINGS, globalMemory: false } })
    expect((await f.plugin.memory.recall(context(), 'tea')).items.map(hit => hit.uri)).toEqual([current])
  })

  it('filters cross-peer search results, bounds recall text and cancels an in-flight SDK read', async () => {
    const f = await fixture({ settings: { recallMaxChars: 256 } }); await f.plugin.connect()
    const root = `viking://user/${f.user}`, allowed = root + '/peers/qq-1001-private-2001/memories/entities/book.md', denied = root + '/peers/qq-1001-private-9999/memories/entities/book.md'
    f.memories.set(allowed, 'x'.repeat(1000)); f.memories.set(denied, 'denied')
    f.controls.intercept = (request, response) => { if (!request.path.endsWith('/search/find')) return false; response.end(JSON.stringify({ status: 'ok', result: { memories: [{ uri: denied, score: 0.99 }, { uri: allowed, score: 0.9 }] } })); return true }
    expect((await f.plugin.memory.recall(context(), 'book')).items).toEqual([{ uri: allowed, text: 'x'.repeat(256), score: 0.9 }])
    const controller = new AbortController(); f.controls.intercept = (request, _response) => request.path.endsWith('/content/read')
    const pending = f.plugin.memory.recall(context(), 'x', controller.signal)
    await waitFor(() => f.requests.filter(item => item.path.endsWith('/content/read')).length === 2)
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
  })

  it('captures an ordinary QQ reply and action receipts immediately, without an archive or local chat bodies', async () => {
    const f = await fixture(); await f.plugin.connect(); f.controls.receiptPollsBeforeComplete = 1
    const input = capture(privateScope, 'ordinary-reply', { actions: [{ tool: 'qq_send_private_msg', outcome: 'succeeded' }, { tool: 'qq_get_message', outcome: 'returned' }] })
    await f.plugin.memory.capture(input)
    await waitFor(() => f.submissions.length === 1)
    const submitted = f.submissions[0]!
    expect(f.sessions.get(sessionId)!.policy).toEqual({ peer: { enabled: true }, self: { enabled: true }, memory_types: ['preferences', 'entities', 'events'] })
    expect(f.requests.find(request => request.method === 'POST' && request.path.endsWith('/sessions'))!.body.auto_commit_policy).toBeNull()
    expect(submitted.messages).toMatchObject([{ role: 'user', peer_id: 'qq-1001-private-2001', content: expect.stringContaining('PRIVATE-USER-CHAT likes tea') }, { role: 'assistant', content: expect.stringContaining('PRIVATE-ASSISTANT-CHAT noted') }])
    expect(submitted.messages).toHaveLength(2); expect(submitted.messages[1]!.content).toContain('qq_send_private_msg: succeeded'); expect(submitted.messages[1]!.content).toContain('qq_get_message: returned'); expect(submitted.messages.every(message => Number.isFinite(Date.parse(message.created_at)))).toBe(true)
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ sessionId, changes: { added: 1, updated: 2, deleted: 0 }, archiveUri: null, errorCode: null, messages: 2 })
    expect(f.archives.size).toBe(0); expect(f.sessions.get(sessionId)!.messages).toEqual(submitted.messages)
    expect(f.requests.filter(request => request.path.endsWith('/content/read'))).toEqual([])
    const metadata = await readFile(join(f.directory, 'state.json'), 'utf8')
    for (const secret of ['PRIVATE-USER-CHAT', 'PRIVATE-ASSISTANT-CHAT', 'qq_send_private_msg: succeeded', f.apiKey]) expect(metadata).not.toContain(secret)
    await f.plugin.memory.capture(input); expect((await snapshot(f.plugin)).jobs).toHaveLength(1); expect(f.submissions).toHaveLength(1)
    await expect(f.plugin.memory.capture(capture(privateScope, 'ordinary-reply', { messages: [{ role: 'user', text: 'changed', timestamp: new Date().toISOString() }] }))).rejects.toMatchObject({ code: 'MEMORY_IDEMPOTENCY_CONFLICT' })
    expectIncrementalOnly(f)
  })

  it('keeps several rounds in one nonempty live session, with extraction changes independent of archive creation', async () => {
    const f = await fixture(); await f.plugin.connect()
    const expectedChanges = [{ added: 0, updated: 0, deleted: 0 }, { added: 2, updated: 0, deleted: 1 }, { added: 0, updated: 3, deleted: 0 }]
    for (let n = 0; n < 2; n++) { f.controls.diff = expectedChanges[n]!; await f.plugin.memory.capture(capture(privateScope, `stable-round-${n}`)); await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === n + 1) }
    expect(f.sessions.get(sessionId)).toMatchObject({ nextSequence: 4, extractedSequence: 4, archivedSequence: 0 }); expect(f.archives.size).toBe(0)
    await f.plugin.disconnect()
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); await resumed.connect(); f.controls.diff = expectedChanges[2]!
    await resumed.memory.capture(capture(privateScope, 'stable-round-2')); await waitFor(async () => (await snapshot(resumed)).jobs.filter(job => job.status === 'completed').length === 3)
    const jobs = (await snapshot(resumed)).jobs.reverse()
    expect(jobs.map(job => job.sessionId)).toEqual([sessionId, sessionId, sessionId]); expect(jobs.map(job => job.archiveUri)).toEqual([null, null, null]); expect(jobs.map(job => job.changes)).toEqual(expectedChanges)
    expect(f.sessions.size).toBe(1); expect(f.sessions.get(sessionId)!.messages).toHaveLength(6); expect(f.submissions.map(item => item.expectedSequence)).toEqual([0, 2, 4]); expect(f.extractions.map(item => item.messages.length)).toEqual([2, 2, 2])
    expect(f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/sessions'))).toHaveLength(1)
    expectIncrementalOnly(f)
  })

  it('creates a segmented archive only for simulated volume and never re-extracts earlier messages', async () => {
    const f = await fixture(); await f.plugin.connect()
    for (let n = 0; n < 4; n++) {
      if (n === 2) f.controls.simulatedHistoryBytes = 8 * 1024 * 1024
      await f.plugin.memory.capture(capture(privateScope, `volume-${n}`, { messages: [{ role: 'user', text: `unique round ${n}`, timestamp: '2026-11-01T13:00:00Z' }, { role: 'assistant', text: `reply ${n}`, timestamp: '2026-11-01T13:00:01Z' }] }))
      await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === n + 1)
      expect(f.archives.size).toBe(n >= 2 ? 1 : 0)
    }
    const uri = `viking://user/${f.user}/sessions/${sessionId}/history/archive_001`, jobs = (await snapshot(f.plugin)).jobs.reverse()
    expect(jobs.map(job => job.archiveUri)).toEqual([null, null, uri, null])
    expect(f.archives.get(uri)!.messages).toHaveLength(6); expect(f.sessions.get(sessionId)!.messages).toHaveLength(8)
    expect(f.extractions.map(item => [item.fromSequence, item.toSequence])).toEqual([[0, 2], [2, 4], [4, 6], [6, 8]])
    for (let n = 0; n < 4; n++) expect(f.extractions[n]!.messages.map(message => message.content)).toEqual([expect.stringContaining(`unique round ${n}`), `reply ${n}`])
    expectIncrementalOnly(f)
  })

  it('keeps distinct peers in separate sessions and never adds the other private conversation', async () => {
    const f = await fixture(); await f.plugin.connect()
    await Promise.all([f.plugin.memory.capture(capture(privateScope, 'peer-one')), f.plugin.memory.capture(capture({ ...privateScope, targetId: '2002' }, 'peer-two', { messages: [{ role: 'user', text: 'SECOND-PEER-PRIVATE', senderId: '2002', timestamp: '2026-11-01T13:00:00Z' }] }))])
    await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === 2)
    expect([...f.sessions.keys()].sort()).toEqual([sessionId, 'eating-live-qq-1001-private-2002'])
    expect(JSON.stringify(f.sessions.get(sessionId)!.messages)).not.toContain('SECOND-PEER-PRIVATE'); expect(JSON.stringify(f.sessions.get('eating-live-qq-1001-private-2002')!.messages)).not.toContain('PRIVATE-USER-CHAT')
    for (const session of f.sessions.values()) expect(session.messages.every(message => message.peer_id === session.id.slice('eating-live-'.length))).toBe(true)
    expect(f.archives.size).toBe(0); expectIncrementalOnly(f)
  })

  it('serializes same-session transport and uploads new turns while the previous extraction is still processing', async () => {
    const f = await fixture(); f.controls.incrementalStatus = 'processing'; await f.plugin.connect()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); stops.push(() => release())
    f.controls.intercept = async request => { if (request.method === 'POST' && request.path.endsWith('/incremental-memory') && request.body.expected_sequence === 0) await gate; return false }
    await f.plugin.memory.capture(capture(privateScope, 'serialized-first')); await waitFor(() => appends(f).length === 1)
    await f.plugin.memory.capture(capture(privateScope, 'serialized-second'))
    await Promise.all([f.plugin.manage('flush', { peerId: 'qq-1001-private-2001' }), f.plugin.manage('flush', { peerId: 'qq-1001-private-2001' })])
    expect((await snapshot(f.plugin)).jobs[0]?.status).toBe('queued'); expect(appends(f)).toHaveLength(1)
    release(); await waitFor(() => f.submissions.length === 2)
    await waitFor(async () => (await snapshot(f.plugin)).jobs.every(job => job.status === 'processing'))
    expect(f.extractions).toHaveLength(0); expect(f.sessions.get(sessionId)).toMatchObject({ nextSequence: 4, extractedSequence: 0 })
    await f.plugin.manage('flush', { peerId: 'qq-1001-private-2001' }); expect(appends(f)).toHaveLength(2)
    f.controls.incrementalStatus = 'completed'
    await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === 2)
    expect(f.submissions.map(item => item.expectedSequence)).toEqual([0, 2]); expect(f.sessions.get(sessionId)!.messages).toHaveLength(4); expectIncrementalOnly(f)
  })

  it('blocks a subsequent same-peer capture on an unknown receipt while another peer completes', async () => {
    const f = await fixture(); f.controls.incrementalStatusBySession.set(sessionId, 'unknown'); await f.plugin.connect()
    await f.plugin.memory.capture(capture(privateScope, 'unknown-first')); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'unknown')
    await f.plugin.memory.capture(capture(privateScope, 'blocked-same-peer'))
    await f.plugin.memory.capture(capture({ ...privateScope, targetId: '2002' }, 'unblocked-other-peer'))
    await waitFor(async () => (await snapshot(f.plugin)).jobs.find(job => job.peerId === 'qq-1001-private-2002')?.status === 'completed')
    expect((await snapshot(f.plugin)).jobs.map(job => job.status)).toEqual(['completed', 'queued', 'unknown'])
    expect(f.submissions.filter(item => item.sessionId === sessionId)).toHaveLength(1); expect(f.sessions.get(sessionId)!.messages).toHaveLength(2)
    expect(f.submissions.map(item => item.sessionId)).toEqual([sessionId, 'eating-live-qq-1001-private-2002']); expectIncrementalOnly(f)
  })

  it('recovers a lost acknowledgement only by persistent receipt lookup, without POST replay', async () => {
    const f = await fixture(); f.controls.submitDisconnect = true; await f.plugin.connect(); await f.plugin.memory.capture(capture())
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'unknown')
    await f.plugin.manage('flush', { peerId: 'qq-1001-private-2001' })
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect(f.submissions).toHaveLength(1); expect(appends(f)).toHaveLength(1); expect(receiptReads(f).length).toBeGreaterThan(0)
    const receipt = [...f.receipts.values()][0]!
    expect(receiptReads(f).every(request => request.path.endsWith('/' + receipt.request_id))).toBe(true)
    expect(f.sessions.get(sessionId)!.messages).toHaveLength(2); expect(f.extractions).toHaveLength(1); expectIncrementalOnly(f)
  })

  it('recovers an unknown acknowledgement after restart using receipts even when native tasks expire', async () => {
    const f = await fixture(); f.controls.submitDisconnect = true; f.controls.receiptUnavailable = true; await f.plugin.connect()
    await f.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'unknown')
    await f.plugin.disconnect(); const before = receiptReads(f).length
    const state = await readFile(join(f.directory, 'state.json'), 'utf8')
    for (const body of ['PRIVATE-USER-CHAT', 'PRIVATE-ASSISTANT-CHAT', f.apiKey]) expect(state).not.toContain(body)
    f.controls.receiptUnavailable = false; f.controls.submitDisconnect = false; f.controls.taskExpired = true; f.tasks.clear()
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'completed')
    expect(receiptReads(f).length).toBeGreaterThan(before); expect(f.submissions).toHaveLength(1); expect(appends(f)).toHaveLength(1)
    await resumed.memory.capture(capture()); expect(appends(f)).toHaveLength(1); expectIncrementalOnly(f)
  })

  it.each(['accepted', 'processing'] as const)('preserves %s extraction through disconnect and resumes polling without a local raw body', async status => {
    const f = await fixture(); f.controls.incrementalStatus = status; await f.plugin.connect(); await f.plugin.memory.capture(capture())
    await waitFor(() => receiptReads(f).length > 0); expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ status: 'processing', changes: null, archiveUri: null })
    await f.plugin.disconnect(); const count = f.requests.length
    await f.plugin.memory.capture(capture(privateScope, 'ignored')); expect(f.requests).toHaveLength(count)
    f.controls.incrementalStatus = 'completed'; f.tasks.clear(); const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'completed')
    expect(f.submissions).toHaveLength(1); expect(f.sessions.get(sessionId)!.messages).toHaveLength(2)
    const state = await readFile(join(f.directory, 'state.json'), 'utf8'); expect(state).not.toContain('PRIVATE-USER-CHAT'); expect(state).not.toContain('PRIVATE-ASSISTANT-CHAT')
    expectIncrementalOnly(f)
  })

  it('retains failed extraction with unknown change counts and never deletes its transcript', async () => {
    const f = await fixture(); f.controls.incrementalStatus = 'failed'; await f.plugin.connect(); await f.plugin.memory.capture(capture())
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'failed')
    expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ changes: null, archiveUri: null, errorCode: 'MEMORY_EXTRACTION_FAILED' })
    expect(f.extractions).toHaveLength(0); expect(f.sessions.get(sessionId)!.messages).toHaveLength(2); expectIncrementalOnly(f)
  })

  it('owner retries a proven pre-apply failure with the same receipt and no append, and refuses unknown retries', async () => {
    const f = await fixture(); f.controls.incrementalStatus = 'failed'; await f.plugin.connect(); await f.plugin.memory.capture(capture())
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'failed')
    const failed = (await snapshot(f.plugin)).jobs[0]!, original = structuredClone([...f.receipts.values()][0]!), messages = structuredClone(f.sessions.get(sessionId)!.messages)
    expect(f.extractions).toHaveLength(0); expect(f.sessions.get(sessionId)).toMatchObject({ nextSequence: 2, extractedSequence: 0 })
    await f.plugin.memory.capture(capture(privateScope, 'after-failed-extraction', { messages: [{ role: 'user', text: 'FOLLOWUP-PRIVATE-USER', timestamp: '2026-11-01T13:01:00Z' }, { role: 'assistant', text: 'FOLLOWUP-PRIVATE-REPLY', timestamp: '2026-11-01T13:01:01Z' }] }))
    await f.plugin.manage('flush', { peerId: 'qq-1001-private-2001' })
    expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ status: 'queued', taskId: null })
    expect(appends(f)).toHaveLength(1); expect(f.submissions).toHaveLength(1); expect(f.sessions.get(sessionId)!.messages).toEqual(messages)
    f.controls.incrementalStatus = 'completed'
    await f.plugin.manage('retry', { jobId: failed.id })
    const retries = f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/retry'))
    expect(retries).toHaveLength(1); expect(retries[0]!.path).toContain(`/sessions/${sessionId}/incremental-memory/requests/${original.request_id}/retry`); expect(retries[0]!.body).toEqual({})
    await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === 2)
    const completed = f.receipts.get(`${sessionId}/${original.request_id}`)!
    expect(completed).toMatchObject({ request_id: original.request_id, session_id: original.session_id, task_id: original.task_id, from_sequence: 0, to_sequence: 2, status: 'completed', changes: { added: 1, updated: 2, deleted: 0 } })
    expect(f.receipts.size).toBe(2); expect(f.submissions.map(submission => submission.expectedSequence)).toEqual([0, 2]); expect(appends(f)).toHaveLength(2)
    expect(appends(f).filter(request => request.body.request_id === original.request_id)).toHaveLength(1)
    expect(f.extractions).toHaveLength(2); expect(f.extractions[0]!.messages).toEqual(messages); expect(f.extractions[1]!.messages).toMatchObject([{ role: 'user', content: expect.stringContaining('FOLLOWUP-PRIVATE-USER') }, { role: 'assistant', content: 'FOLLOWUP-PRIVATE-REPLY' }])
    expect(f.sessions.get(sessionId)).toMatchObject({ nextSequence: 4, extractedSequence: 4 }); expect(f.sessions.get(sessionId)!.messages.slice(0, 2)).toEqual(messages); expect(f.sessions.get(sessionId)!.messages).toHaveLength(4); expect(f.archives.size).toBe(0)
    const other = await fixture(); other.controls.incrementalStatus = 'unknown'; await other.plugin.connect(); await other.plugin.memory.capture(capture())
    await waitFor(async () => (await snapshot(other.plugin)).jobs[0]?.status === 'unknown')
    const unknown = (await snapshot(other.plugin)).jobs[0]!
    await expect(other.plugin.manage('retry', { jobId: unknown.id })).rejects.toThrow()
    expect(other.requests.filter(request => request.method === 'POST' && request.path.endsWith('/retry'))).toHaveLength(0); expect(other.submissions).toHaveLength(1); expect(other.sessions.get(sessionId)!.messages).toHaveLength(2)
    expectIncrementalOnly(f); expectIncrementalOnly(other)
  })

  it.each(['allowlist', 'denylist'] as const)('filters real group speaker IDs for %s and omits assistant/actions from mixed turns', async mode => {
    const f = await fixture({ settings: { rules: [rule({ memberMode: mode, memberIds: [mode === 'allowlist' ? 'allowed' : 'denied'] })] } }); await f.plugin.connect()
    const input = capture(group, 'mixed', { messages: [{ role: 'user', text: 'allowed user fact', senderId: 'allowed', timestamp: new Date().toISOString() }, { role: 'user', text: 'BLOCKED-PRIVATE-SPEAKER', senderId: 'denied', timestamp: new Date().toISOString() }, { role: 'assistant', text: 'LEAKY-ASSISTANT-ANSWER', timestamp: new Date().toISOString() }], actions: [{ tool: 'tool_name', outcome: 'returned' }] })
    await f.plugin.memory.capture(input); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    const sent = appends(f); expect(sent).toHaveLength(1)
    const messages = sent[0]!.body.messages as Array<{ content: string }>; expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('allowed user fact'); expect(messages[0]!.content).toContain('"senderId":"allowed"'); expect(messages[0]!.content).toContain('"platform":"qq"'); expect(messages[0]!.content).toContain('"target":"3001"')
    for (const denied of ['BLOCKED-PRIVATE-SPEAKER', 'LEAKY-ASSISTANT-ANSWER', 'tool_name']) expect(JSON.stringify(sent[0]!.body)).not.toContain(denied)
    await f.plugin.memory.capture(capture(group, 'fully-blocked', { messages: input.messages.filter(message => message.senderId !== 'allowed'), actions: input.actions })); expect((await snapshot(f.plugin)).jobs).toHaveLength(1)
    expectIncrementalOnly(f)
  })

  it('keeps default group capture off and captures autonomous self activity immediately', async () => {
    const f = await fixture(); await f.plugin.connect(); await f.plugin.memory.capture(capture(group)); expect((await snapshot(f.plugin)).jobs).toHaveLength(0)
    await f.plugin.memory.capture(capture({ ...self, owner: false }, 'autonomy', { messages: [{ role: 'assistant', text: 'autonomous task done', timestamp: new Date().toISOString() }], actions: [{ tool: 'native_task', outcome: 'returned' }] }))
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect(JSON.stringify(appends(f)[0]!.body)).toContain('autonomous task done'); expect(JSON.stringify(appends(f)[0]!.body)).toContain('native_task: returned')
  })

  it('derives MCP scope, dedupes explicit saves without a Host body ledger and denies arbitrary peer/path writes', async () => {
    const f = await fixture(); await f.plugin.connect()
    const submitted = await f.plugin.invokeCapability('memory_save', { text: 'explicit fact', request_id: 'save-001' }, 'save-001', invocation(privateScope)) as { jobId: string; status: string }
    expect(['queued', 'submitting']).toContain(submitted.status)
    expect(await f.plugin.invokeCapability('memory_save', { text: 'explicit fact', request_id: 'save-001' }, 'save-001', invocation(privateScope))).toMatchObject({ jobId: submitted.jobId })
    await expect(f.plugin.invokeCapability('memory_save', { text: 'different fact', request_id: 'save-001' }, 'save-001', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_IDEMPOTENCY_CONFLICT' })
    await expect(f.plugin.invokeCapability('memory_save', { text: 'fact', request_id: 'save-002', global: true }, 'save-002', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    await expect(f.plugin.invokeCapability('memory_save', { text: 'fact', request_id: 'save-003', peer_id: 'other' }, 'save-003', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_INVALID_INPUT' })
    expect(await f.plugin.invokeCapability('memory_save', { text: 'owner global fact', request_id: 'save-004', global: true }, 'save-004', invocation({ ...privateScope, owner: true }))).toHaveProperty('jobId')
    expect(await f.plugin.invoke('memory_scopes', {}, 'read')).toMatchObject({ peerId: 'self', peerUri: `viking://user/${f.user}/peers/self/memories`, globalUri: `viking://user/${f.user}/memories` })
    const controller = new AbortController(); controller.abort()
    await expect(f.plugin.invokeCapability('memory_save', { text: 'never send', request_id: 'save-005' }, 'save-005', invocation(privateScope, controller.signal))).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
  })

  it('reads and deletes exact existing memory files through the SDK with owner confirmation', async () => {
    const f = await fixture(); await f.plugin.connect()
    const root = `viking://user/${f.user}`, uri = root + '/peers/qq-1001-private-2001/memories/preferences/safe.md', other = root + '/peers/qq-1001-private-9999/memories/preferences/secret.md'
    f.memories.set(uri, 'tea'); f.memories.set(other, 'other secret')
    expect(await f.plugin.invokeCapability('memory_read', { uri }, 'read', invocation(privateScope))).toEqual({ uri, text: 'tea' })
    await expect(f.plugin.invokeCapability('memory_read', { uri: other }, 'read', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    for (const denied of [root + '/memories', root + '/memories/preferences', root + '/memories/preferences/../bad.md', root + '/memories/preferences/%2e%2e/file.md', root + '/memories/preferences/.abstract.md', 'file:///etc/passwd', 'viking://session/x/messages.jsonl']) await expect(f.plugin.manage('delete', { uri: denied, confirmed: true })).rejects.toThrow()
    await expect(f.plugin.manage('delete', { uri, confirmed: false })).rejects.toMatchObject({ code: 'MEMORY_CONFIRMATION_REQUIRED' })
    expect(await f.plugin.manage('delete', { uri, confirmed: true })).toEqual({ deleted: true }); expect(f.memories.has(uri)).toBe(false); expect(f.memories.get(other)).toBe('other secret')
    expect(f.requests.find(request => request.method === 'DELETE' && request.path.endsWith('/fs'))!.query.get('recursive')).toBe('false')
    await expect(f.plugin.manage('delete', { uri, confirmed: true })).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' }); expectIncrementalOnly(f)
  })

  it('bounds responses, cancels stalled reads and accepts trusted services without an API key', async () => {
    const f = await fixture({ apiKey: '' }); await f.plugin.connect(); expect(f.plugin.getPublicConfiguration().apiKeyConfigured).toBe(false)
    f.controls.intercept = (_request, response) => { response.writeHead(200, { 'Content-Length': String(3 * 1024 * 1024) }); response.end('private'); return true }
    await expect(f.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_RESPONSE_TOO_LARGE' })
    f.controls.intercept = (_request, _response) => true
    await expect(f.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_TIMEOUT' }); expect((await snapshot(f.plugin)).lastErrorCode).toBe('MEMORY_TIMEOUT')
  })

  it('bounds concurrent transport workers and RAM while every accepted small capture is realtime', async () => {
    const f = await fixture(); await f.plugin.connect()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); stops.push(() => release())
    f.controls.intercept = async request => { if (request.method === 'POST' && request.path.endsWith('/incremental-memory')) await gate; return false }
    for (let n = 0; n < 4; n++) await f.plugin.memory.capture(capture({ ...privateScope, targetId: String(2001 + n) }, 'concurrency-' + n))
    await waitFor(() => appends(f).length === 2); expect((await snapshot(f.plugin)).jobs.filter(job => job.status === 'queued')).toHaveLength(2); expect(f.submissions).toHaveLength(0)
    await expect(f.plugin.memory.capture(capture(privateScope, 'oversized', { messages: [{ role: 'user', text: 'x'.repeat(512 * 1024), timestamp: new Date().toISOString() }] }))).rejects.toMatchObject({ code: 'MEMORY_CAPACITY' })
    release(); await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === 4)
    expect(f.submissions).toHaveLength(4); expectIncrementalOnly(f)
  })

  it('revokes a pending submission on endpoint change and never sends old jobs to the new service', async () => {
    const f = await fixture(); await f.plugin.connect(); f.controls.intercept = (request, _response) => request.method === 'POST' && request.path.endsWith('/sessions')
    await f.plugin.memory.capture(capture()); await waitFor(() => f.requests.some(request => request.method === 'POST' && request.path.endsWith('/sessions')))
    const other = await startOpenVikingFixture(); stops.push(other.close)
    await f.plugin.updateConfiguration({ expectedRevision: 1, endpoint: other.endpoint, account: other.account, user: other.user, apiKey: other.apiKey, autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS })
    expect(other.requests).toHaveLength(0); await f.plugin.connect()
    expect(other.requests.filter(request => request.path.endsWith('/system/status'))).toHaveLength(1); expect(other.requests.filter(request => request.path.endsWith('/eating-memory/capabilities'))).toHaveLength(1)
    expect(other.submissions).toHaveLength(0); expect(appends(f)).toHaveLength(0)
  })

  it('keeps an accepted manual save after caller lifetime ends and rejects revoked-before-acceptance calls', async () => {
    const f = await fixture(); await f.plugin.connect(); f.controls.receiptPollsBeforeComplete = 1
    const controller = new AbortController()
    await f.plugin.invokeCapability('memory_save', { text: 'accepted fact', request_id: 'caller-lifetime' }, 'caller-lifetime', invocation(privateScope, controller.signal)); controller.abort()
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    const count = f.requests.length
    await expect(f.plugin.invokeCapability('memory_save', { text: 'not accepted', request_id: 'already-revoked' }, 'already-revoked', invocation(privateScope, controller.signal))).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
    expect(f.requests).toHaveLength(count); expectIncrementalOnly(f)
  })

  it('keeps self memory independent of private switches and lets the owner inspect disabled global and Unicode files', async () => {
    const f = await fixture({ settings: { privateCapture: false, privateRecall: false, globalMemory: false, ownerCrossSession: false } }); await f.plugin.connect()
    const root = `viking://user/${f.user}`, localUri = root + '/peers/self/memories/preferences/饮茶偏好.md', globalUri = root + '/memories/entities/某个项目.md', otherUri = root + '/peers/qq-1001-group-3001/memories/events/项目上线.md'
    f.memories.set(localUri, 'tea self'); f.memories.set(globalUri, 'tea global'); f.memories.set(otherUri, 'tea other')
    expect((await f.plugin.memory.recall(context(self), 'tea')).items.map(item => item.uri)).toEqual([localUri])
    await f.plugin.memory.capture(capture({ ...self, owner: false }, 'self-only', { messages: [{ role: 'assistant', text: 'autonomy persists with private capture off', timestamp: new Date().toISOString() }] }))
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect(await f.plugin.manage('read', { uri: globalUri })).toEqual({ uri: globalUri, text: 'tea global' })
    expect(await f.plugin.manage('search', { query: 'tea', all: true })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ uri: globalUri }), expect.objectContaining({ uri: otherUri })]) })
    expect(await f.plugin.manage('delete', { uri: localUri, confirmed: true })).toEqual({ deleted: true })
    expect(f.sessions.get('eating-live-self-local')!.policy).toMatchObject({ self: { enabled: false } })
  })

  it('counts successful extractions beyond 100 retained jobs and bounds scope metadata without a daily cap', async () => {
    const directory = await home(), store = new StateStore(directory), configKey = 'a'.repeat(64)
    for (let n = 0; n < 105; n++) { const job = store.create('self', configKey, true); store.update(job, { taskId: 'task-' + n, sequence: n, submissionAttempted: true, status: 'completed', changes: { added: 1, updated: 0, deleted: 0 } }) }
    for (let n = 0; n < 505; n++) store.touch({ ...privateScope, targetId: String(n) }, true, true, 0)
    store.save(); expect(store.value.jobs).toHaveLength(100); expect(store.value.scopes).toHaveLength(500); expect(store.value.extractionDay).toBe(localDay()); expect(store.value.extractionCount).toBe(105)
    expect(new StateStore(directory).value.extractionCount).toBe(105)
    const plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect()); expect((await snapshot(plugin)).todayExtractions).toBe(105)
  })
})
