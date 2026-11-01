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
function context(current: MemoryScope = privateScope, turnId = 'turn-001'): MemoryContext { return { agentId: 'main-agent', agentTypeId: 'main', turnId, scope: current } }
function capture(current = privateScope, turnId = 'turn-001', overrides: Partial<MemoryCaptureInput> = {}): MemoryCaptureInput {
  return { context: context(current, turnId), messages: [{ role: 'user', text: 'PRIVATE-USER-CHAT likes tea', senderId: '2001', timestamp: '2026-11-01T13:00:00Z' }, { role: 'assistant', text: 'PRIVATE-ASSISTANT-CHAT noted', timestamp: '2026-11-01T13:00:01Z' }], actions: [], outcome: 'completed', ...overrides }
}
const snapshot = async (plugin: OpenVikingMemoryPlugin) => await plugin.manage('snapshot', {}) as unknown as RuntimeSnapshot
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 4000) { await vi.waitFor(async () => expect(await check()).toBe(true), { interval: 15, timeout }) }
const invocation = (current: MemoryScope, signal?: AbortSignal): CapabilityInvocationScope => ({ agentId: 'main-agent', agentTypeId: 'main', memory: context(current), signal })
const rule = (patch: Partial<ScopeRule> = {}): ScopeRule => ({ id: 'group-rule', label: 'Optional nickname', platform: 'qq', accountId: '1001', kind: 'group', targetId: '3001', capture: true, recall: true, memberMode: 'all', memberIds: [], ...patch })

// Real @openviking/sdk 0.1.0 requests against independent loopback servers; never a model service.
describe('OpenViking current backend contract', () => {
  it('starts inert with current defaults, checks saved auth identity without sessions, secrets are keep/clear and CAS protected', async () => {
    const directory = await home(), plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect())
    expect(plugin.getPublicConfiguration()).toMatchObject({ schemaVersion: 1, revision: 0, endpoint: '', user: '', ready: false, autoConnect: false, settings: DEFAULT_SETTINGS })
    await plugin.memory.capture(capture()); expect((await snapshot(plugin)).jobs).toHaveLength(0)
    const f = await startOpenVikingFixture(); stops.push(f.close)
    const update = { expectedRevision: 0, endpoint: f.endpoint, account: f.account, user: f.user, apiKey: f.apiKey, autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS }
    await plugin.updateConfiguration(update)
    expect(f.requests).toHaveLength(0); expect(plugin.getPublicConfiguration().ready).toBe(false)
    expect(await plugin.manage('test-connection', {})).toEqual({ ok: true }); expect(f.sessions.size).toBe(0)
    expect(plugin.getPublicConfiguration().ready).toBe(false)
    await plugin.connect(); expect(plugin.getStatus().state).toBe('connected')
    await plugin.updateConfiguration({ ...update, expectedRevision: 1, apiKey: '' }); expect(plugin.getPublicConfiguration()).toMatchObject({ revision: 2, apiKeyConfigured: true, ready: true })
    await expect(plugin.updateConfiguration({ ...update, expectedRevision: 1 })).rejects.toMatchObject({ code: 'MEMORY_CONFIGURATION_CONFLICT' })
    expect(JSON.stringify(plugin.getPublicConfiguration())).not.toContain(f.apiKey)
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')); expect(config.apiKey).toBe(f.apiKey)
    if (process.platform !== 'win32') expect((await lstat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600)
    await plugin.updateConfiguration({ ...update, expectedRevision: 2, apiKey: '', clearApiKey: true }); expect(plugin.getPublicConfiguration()).toMatchObject({ apiKeyConfigured: false, ready: false })
  })

  it.each([{ user: 'eating-bot', account: 'team-1' }, { user: 'eating.bot@team', account: 'team.1@org' }])('accepts official service identities through SDK recall/capture/restart/cleanup/read/delete: %j', async service => {
    const f = await fixture({ ...service, settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    const root = `viking://user/${service.user}`, global = root + '/memories/preferences/global.md', local = root + '/peers/qq-1001-private-2001/memories/preferences/local.md'
    expect(globalRoot(service.user)).toBe(root + '/memories'); expect(peerRoot(service.user, 'qq-1001-private-2001')).toBe(root + '/peers/qq-1001-private-2001/memories')
    f.memories.set(global, 'tea global'); f.memories.set(local, 'tea local')
    expect((await f.plugin.memory.recall(context(), 'tea')).items.map(item => item.uri)).toEqual([global, local])
    f.controls.taskStatus = 'running'
    await f.plugin.memory.capture(capture()); await waitFor(() => f.tasks.size === 1 && f.requests.some(request => request.path.includes('/tasks/')))
    const processing = (await snapshot(f.plugin)).jobs[0]!
    expect(processing.status).toBe('processing'); expect(processing.archiveUri).toBe(`${root}/sessions/${processing.sessionId}/history/archive_001`)
    expect(f.requests.find(request => request.path.endsWith('/messages/batch'))!.headers).toMatchObject({ 'x-openviking-user': service.user, 'x-openviking-account': service.account })
    await f.plugin.disconnect()
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); f.controls.taskStatus = 'completed'; await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'completed')
    expect(f.committedSessions).toHaveLength(1); expect(f.cleaned).toEqual([processing.sessionId]); expect((await snapshot(resumed)).jobs[0]?.changes).toEqual({ added: 1, updated: 2, deleted: 0 })
    expect(await resumed.manage('read', { uri: global })).toEqual({ uri: global, text: 'tea global' })
    expect(await resumed.manage('delete', { uri: local, confirmed: true })).toEqual({ deleted: true }); expect(f.memories.has(local)).toBe(false); expect(f.errors).toEqual([])
  })

  it('validates service identity characters separately from peer tuples and compares archive owners exactly', () => {
    for (const value of ['eating-bot', 'team.1', 'bot@team', '_user', 'u'.repeat(96)]) expect(serviceIdentity(value)).toBe(value)
    expect(serviceIdentity('', true)).toBe(''); expect(serviceIdentity('team-1', false, true)).toBe('team-1')
    for (const value of ['', '.', '..', 'a@@b', 'a/b', 'a\\b', 'a%2fb', 'a?b', 'a#b', 'has space', 'a\nb', 'u'.repeat(97)]) expect(() => serviceIdentity(value)).toThrow('MEMORY_INVALID_INPUT')
    expect(() => serviceIdentity('_account', false, true)).toThrow('MEMORY_INVALID_INPUT')
    const sessionId = 'eating-00000000-0000-4000-8000-000000000000', user = 'eating.bot@team', uri = `viking://user/${user}/sessions/${sessionId}/history/archive_001`
    expect(archive(uri, sessionId, user)).toBe(uri); expect(archive(uri, sessionId)).toBe(uri)
    for (const denied of [uri.replace('eating.bot@team', 'eatingXbot@team'), uri.replace('/sessions/', '/memories/'), uri.replace('archive_001', '../messages'), uri.replace('eating.bot@team', '..'), uri + '/messages.jsonl', uri.replace('archive_001', 'archive_001?key=private')]) expect(() => archive(denied, sessionId, user)).toThrow('MEMORY_UNSUPPORTED_SERVER')
    expect(memoryLocation(`viking://user/${user}/memories/preferences/tea.md`, user).peer).toBeNull()
    expect(() => memoryLocation(`viking://user/eatingXbot@team/memories/preferences/tea.md`, user)).toThrow('MEMORY_URI_DENIED')
    expect(() => peerRoot(user, 'qq-team-1-private-2001')).toThrow('MEMORY_INVALID_INPUT')
    expect(archive(`viking://user/${'u'.repeat(96)}/sessions/${sessionId}/history/archive_001`, sessionId, 'u'.repeat(96))).toContain('u'.repeat(96))
  })

  it('rejects auth mismatch, non-current envelopes, provider secrets and redirect bodies with fixed codes', async () => {
    const f = await fixture()
    f.controls.rejectAuth = true
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

  it('uses strict schema1 without migrating or overwriting rejected config/state', async () => {
    const directory = await home(), path = join(directory, 'config.json'), old = JSON.stringify({ schemaVersion: 0, apiKey: 'PRIVATE' })
    await writeFile(path, old)
    expect(() => new OpenVikingMemoryPlugin(host(directory))).toThrow('MEMORY_CONFIGURATION_CORRUPTED')
    expect(await readFile(path, 'utf8')).toBe(old)
    const stateHome = await home(), statePath = join(stateHome, 'state.json'), previous = JSON.stringify({ schemaVersion: 1, jobs: [], scopes: [] })
    await writeFile(statePath, previous)
    expect(() => new OpenVikingMemoryPlugin(host(stateHome))).toThrow('MEMORY_STATE_CORRUPTED')
    expect(await readFile(statePath, 'utf8')).toBe(previous)
  })

  it('rejects invalid configuration, scope collisions, unknown fields and cross-instance file CAS', async () => {
    const f = await fixture(), input = { ...f.plugin.getPublicConfiguration(), expectedRevision: 1 }
    const config = JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8'))
    const patch = { expectedRevision: 1, endpoint: f.endpoint, account: f.account, user: f.user, autoConnect: false, timeoutMs: 1000, settings: structuredClone(DEFAULT_SETTINGS) }
    for (const invalid of [{ ...patch, user: '../escape' }, { ...patch, endpoint: f.endpoint + '?key=private' }, { ...patch, account: '_reserved' }, { ...patch, settings: { ...DEFAULT_SETTINGS, batchMessages: 0 } }, { ...patch, settings: { ...DEFAULT_SETTINGS, rules: [rule(), rule({ id: 'other' })] } }, input]) await expect(f.plugin.updateConfiguration(invalid)).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONFIGURATION' })
    expect(f.plugin.getPublicConfiguration().revision).toBe(1)
    await writeFile(join(f.directory, 'config.json'), JSON.stringify({ ...config, revision: 2 }))
    await expect(f.plugin.updateConfiguration(patch)).rejects.toMatchObject({ code: 'MEMORY_CONFIGURATION_CONFLICT' })
    expect(JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8')).revision).toBe(2)
  })

  it('recalls current peer and global, only private owner can search all peers, global off never returns global', async () => {
    const f = await fixture(); await f.plugin.connect()
    const root = `viking://user/${f.user}`, current = root + '/peers/qq-1001-private-2001/memories/preferences/tea.md', global = root + '/memories/preferences/global.md', other = root + '/peers/qq-1001-private-9999/memories/preferences/other.md'
    f.memories.set(current, 'tea local'); f.memories.set(global, 'tea global'); f.memories.set(other, 'tea other')
    const local = await f.plugin.memory.recall(context(), 'tea')
    expect(local.items.map(hit => hit.uri)).toEqual([current, global]); expect(local.text).toContain('tea local')
    const request = f.requests.find(item => item.path.endsWith('/search/find'))!
    expect(request.body).toMatchObject({ target_uri: [root + '/memories', root + '/peers/qq-1001-private-2001/memories'], context_type: 'memory', level: [2], score_threshold: 0.35 })
    expect(request.headers['x-openviking-actor-peer']).toBe('qq-1001-private-2001')
    await expect(f.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'read-id', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    expect((await f.plugin.memory.recall(context({ ...privateScope, owner: true }), 'tea')).items).toHaveLength(2)
    expect(await f.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'owner-read', invocation({ ...privateScope, owner: true }))).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ uri: other })]) })
    expect((await f.plugin.memory.recall(context({ ...group, owner: true }), 'tea')).items.map(hit => hit.uri)).toEqual([global])
    const settings = { ...DEFAULT_SETTINGS, globalMemory: false }
    await f.plugin.updateConfiguration({ expectedRevision: 1, endpoint: f.endpoint, account: f.account, user: f.user, autoConnect: false, timeoutMs: 1000, settings })
    expect((await f.plugin.memory.recall(context(), 'tea')).items.map(hit => hit.uri)).toEqual([current])
    expect(f.requests.at(-2)!.headers['x-openviking-actor-peer']).toBe('qq-1001-private-2001')
  })

  it('filters malicious cross-peer search returns, bounds final recall chars and cancels an in-flight SDK read', async () => {
    const f = await fixture({ settings: { recallMaxChars: 256 } }); await f.plugin.connect()
    const root = `viking://user/${f.user}`, allowed = root + '/peers/qq-1001-private-2001/memories/entities/book.md', denied = root + '/peers/qq-1001-private-9999/memories/entities/book.md'
    f.memories.set(allowed, 'x'.repeat(1000)); f.memories.set(denied, 'denied')
    f.controls.intercept = (request, response) => {
      if (!request.path.endsWith('/search/find')) return false
      response.end(JSON.stringify({ status: 'ok', result: { memories: [{ uri: denied, score: 0.99 }, { uri: allowed, score: 0.9 }] } })); return true
    }
    const result = await f.plugin.memory.recall(context(), 'book'); expect(result.items).toEqual([{ uri: allowed, text: 'x'.repeat(256), score: 0.9 }])
    const controller = new AbortController()
    f.controls.intercept = (request, _response) => request.path.endsWith('/content/read')
    const pending = f.plugin.memory.recall(context(), 'x', controller.signal)
    await waitFor(() => f.requests.some(item => item.path.endsWith('/content/read') && item.query.get('uri') === allowed) && f.requests.filter(item => item.path.endsWith('/content/read')).length === 2)
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
  })

  it('turn capture uses native policy, actual diff counts and terminal cleanup, never stores bodies locally', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    f.controls.taskPollsBeforeComplete = 1
    await f.plugin.memory.capture(capture())
    await waitFor(() => f.committedSessions.length === 1)
    expect(f.cleaned).toHaveLength(0)
    const stored = f.committedSessions[0]!
    expect(stored.policy).toEqual({ peer: { enabled: true }, self: { enabled: true }, memory_types: ['preferences', 'entities', 'events'] })
    expect(f.requests.find(request => request.method === 'POST' && request.path.endsWith('/sessions'))!.body.auto_commit_policy).toBeNull()
    expect(stored.messages).toMatchObject([{ role: 'user', peer_id: 'qq-1001-private-2001', content: expect.stringContaining('PRIVATE-USER-CHAT likes tea') }, { role: 'assistant', content: 'PRIVATE-ASSISTANT-CHAT noted' }])
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ changes: { added: 1, updated: 2, deleted: 0 }, errorCode: null, messages: 2 })
    expect(stored.messages).toHaveLength(0); expect(f.cleaned).toEqual([stored.id]); expect(f.errors).toEqual([])
    const routes = f.requests.map(item => item.method + ' ' + item.path)
    expect(routes.findIndex(item => item.includes('/content/read'))).toBeLessThan(routes.findIndex(item => item.startsWith('DELETE')))
    const metadata = await readFile(join(f.directory, 'state.json'), 'utf8')
    for (const secret of ['PRIVATE-USER-CHAT', 'PRIVATE-ASSISTANT-CHAT', 'PRIVATE-DIFF-MEMORY-BODY', f.apiKey]) expect(metadata).not.toContain(secret)
    await f.plugin.memory.capture(capture()); expect((await snapshot(f.plugin)).jobs).toHaveLength(1)
    await expect(f.plugin.memory.capture(capture(privateScope, 'turn-001', { messages: [{ role: 'user', text: 'changed', timestamp: new Date().toISOString() }] }))).rejects.toMatchObject({ code: 'MEMORY_IDEMPOTENCY_CONFLICT' })
  })

  it('batch buffers per peer, explicit flush is immediate acceptance, tool turn flushes one turn, token threshold works', async () => {
    const f = await fixture({ settings: { batchMessages: 4 } }); await f.plugin.connect()
    await f.plugin.memory.capture(capture()); expect(f.committedSessions).toHaveLength(0)
    expect((await snapshot(f.plugin)).scopes[0]?.bufferedMessages).toBe(2)
    await f.plugin.memory.capture(capture({ ...privateScope, targetId: '2002' }, 'turn-002')); expect((await snapshot(f.plugin)).jobs).toHaveLength(2)
    await f.plugin.memory.capture(capture(privateScope, 'turn-003'))
    await waitFor(() => f.committedSessions.length === 1)
    const accepted = await f.plugin.manage('flush', { peerId: 'qq-1001-private-2002' }) as unknown as RuntimeSnapshot
    expect(accepted.pending).toBeGreaterThan(0)
    await waitFor(async () => (await snapshot(f.plugin)).jobs.every(job => job.status === 'completed'))
    await f.plugin.memory.capture(capture(privateScope, 'turn-tools', { actions: [{ tool: 'qq_send_private_msg', outcome: 'unknown' }] }))
    await waitFor(() => f.committedSessions.length === 3)
    const body = f.requests.filter(request => request.path.endsWith('/messages/batch')).at(-1)!.body
    expect(JSON.stringify(body)).toContain('qq_send_private_msg: unknown'); expect(JSON.stringify(body)).not.toContain('tool_output')
    const tokenFixture = await fixture({ settings: { submissionMode: 'tokens', tokenThreshold: 128 } }); await tokenFixture.plugin.connect()
    await tokenFixture.plugin.memory.capture(capture(privateScope, 'tokens-turn', { messages: [{ role: 'user', text: 'x'.repeat(600), timestamp: new Date().toISOString() }] }))
    await waitFor(async () => (await snapshot(tokenFixture.plugin)).jobs[0]?.status === 'completed')
  })

  it('idle submits buffered regular chat and graceful dispose flushes enabled connected buffers', async () => {
    const f = await fixture({ settings: { idleSeconds: 5 } }); await f.plugin.connect()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await f.plugin.memory.capture(capture())
    await vi.advanceTimersByTimeAsync(5001); vi.useRealTimers()
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    await f.plugin.memory.capture(capture(privateScope, 'shutdown-turn'))
    expect(f.committedSessions).toHaveLength(1)
    await f.plugin.dispose(); expect(f.committedSessions).toHaveLength(2); expect(f.cleaned).toHaveLength(2)
  })

  it.each(['allowlist', 'denylist'] as const)('group %s filters real speaker IDs and omits assistant/actions from mixed turns', async mode => {
    const f = await fixture({ settings: { submissionMode: 'turn', rules: [rule({ memberMode: mode, memberIds: [mode === 'allowlist' ? 'allowed' : 'denied'] })] } }); await f.plugin.connect()
    const input = capture(group, 'mixed', { messages: [{ role: 'user', text: 'allowed user fact', senderId: 'allowed', timestamp: new Date().toISOString() }, { role: 'user', text: 'BLOCKED-PRIVATE-SPEAKER', senderId: 'denied', timestamp: new Date().toISOString() }, { role: 'assistant', text: 'LEAKY-ASSISTANT-ANSWER', timestamp: new Date().toISOString() }], actions: [{ tool: 'tool_name', outcome: 'returned' }] })
    await f.plugin.memory.capture(input)
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    const sent = f.requests.filter(request => request.path.endsWith('/messages') || request.path.endsWith('/messages/batch'))
    expect(sent).toHaveLength(1); expect(JSON.stringify(sent[0]!.body)).toContain('allowed user fact')
    expect(sent[0]!.body.content).toContain('"senderId":"allowed"'); expect(sent[0]!.body.content).toContain('"platform":"qq"'); expect(sent[0]!.body.content).toContain('"target":"3001"')
    expect(JSON.stringify(sent[0]!.body)).not.toContain('BLOCKED-PRIVATE-SPEAKER'); expect(JSON.stringify(sent[0]!.body)).not.toContain('LEAKY-ASSISTANT-ANSWER'); expect(JSON.stringify(sent[0]!.body)).not.toContain('tool_name')
    await f.plugin.memory.capture(capture(group, 'fully-blocked', { messages: input.messages.filter(message => message.senderId !== 'allowed'), actions: input.actions }))
    expect((await snapshot(f.plugin)).jobs).toHaveLength(1)
  })

  it('default group capture is off; explicit all rule permits turns and autonomy self action-only captures', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    await f.plugin.memory.capture(capture(group)); expect((await snapshot(f.plugin)).jobs).toHaveLength(0)
    await f.plugin.memory.capture(capture({ ...self, owner: false }, 'autonomy', { messages: [{ role: 'assistant', text: 'autonomous task done', timestamp: new Date().toISOString() }], actions: [{ tool: 'native_task', outcome: 'returned' }] }))
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect(f.requests.some(request => JSON.stringify(request.body).includes('autonomous task done'))).toBe(true)
    expect(f.requests.some(request => JSON.stringify(request.body).includes('native_task: returned'))).toBe(true)
  })

  it('disable discards RAM buffers and aborts polling without deleting active extraction, reconnect recovers known task', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect(); f.controls.taskStatus = 'running'
    await f.plugin.memory.capture(capture()); await waitFor(() => f.tasks.size === 1 && f.requests.some(request => request.path.includes('/tasks/')))
    await f.plugin.disconnect(); const count = f.requests.length
    expect(f.cleaned).toHaveLength(0); expect((await snapshot(f.plugin)).jobs[0]?.status).toBe('processing')
    await f.plugin.memory.capture(capture(privateScope, 'ignored')); expect(f.requests).toHaveLength(count)
    f.controls.taskStatus = 'completed'; await f.plugin.connect()
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed'); expect(f.committedSessions).toHaveLength(1); expect(f.cleaned).toHaveLength(1)
    await f.plugin.updateConfiguration({ expectedRevision: 1, endpoint: f.endpoint, account: f.account, user: f.user, autoConnect: false, timeoutMs: 1000, settings: { ...DEFAULT_SETTINGS, enabled: false } })
    expect(f.plugin.getPublicConfiguration().ready).toBe(false)
  })

  it('commit transport loss becomes unknown and is never replayed across restart; known task restarts resume only polling', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect(); f.controls.commitDisconnect = true
    await f.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'unknown')
    expect(f.cleaned).toHaveLength(0); await f.plugin.disconnect()
    const reopened = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => reopened.disconnect()); f.controls.commitDisconnect = false; await reopened.connect()
    await reopened.memory.capture(capture()); expect(f.committedSessions).toHaveLength(1); expect((await snapshot(reopened)).jobs[0]?.status).toBe('unknown')
    const known = await fixture({ settings: { submissionMode: 'turn' } }); await known.plugin.connect(); known.controls.taskStatus = 'running'
    await known.plugin.memory.capture(capture()); await waitFor(() => known.tasks.size === 1); await known.plugin.disconnect()
    const resumed = new OpenVikingMemoryPlugin(host(known.directory)); stops.push(() => resumed.disconnect()); known.controls.taskStatus = 'completed'; await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'completed'); expect(known.committedSessions).toHaveLength(1); expect(known.errors).toEqual([])
  })

  it('cleans failed terminal tasks and missing diff truthfully fails without fabricated zero counts', async () => {
    const failed = await fixture({ settings: { submissionMode: 'turn' } }); await failed.plugin.connect(); failed.controls.taskStatus = 'failed'
    await failed.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(failed.plugin)).jobs[0]?.status === 'failed')
    expect((await snapshot(failed.plugin)).jobs[0]).toMatchObject({ errorCode: 'MEMORY_EXTRACTION_FAILED', changes: null }); expect(failed.cleaned).toHaveLength(1)
    const missing = await fixture({ settings: { submissionMode: 'turn' } }); await missing.plugin.connect(); missing.controls.omitDiff = true
    await missing.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(missing.plugin)).jobs[0]?.status === 'failed')
    expect((await snapshot(missing.plugin)).jobs[0]?.changes).toBeNull(); expect(missing.cleaned).toHaveLength(1)
  })

  it('MCP derives real scope, request ID dedupes without Host body ledger, saves do not permit arbitrary peer/path', async () => {
    const f = await fixture(); await f.plugin.connect()
    const submitted = await f.plugin.invokeCapability('memory_save', { text: 'explicit fact', request_id: 'save-001' }, 'save-001', invocation(privateScope)) as { jobId: string; status: string }
    expect(['queued', 'submitting']).toContain(submitted.status)
    const same = await f.plugin.invokeCapability('memory_save', { text: 'explicit fact', request_id: 'save-001' }, 'save-001', invocation(privateScope))
    expect(same).toMatchObject({ jobId: submitted.jobId })
    await expect(f.plugin.invokeCapability('memory_save', { text: 'explicit fact', request_id: 'save-002', global: true }, 'save-002', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    await expect(f.plugin.invokeCapability('memory_save', { text: 'fact', request_id: 'save-003', peer_id: 'other' }, 'save-003', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_INVALID_INPUT' })
    const ownerSaved = await f.plugin.invokeCapability('memory_save', { text: 'owner global fact', request_id: 'save-004', global: true }, 'save-004', invocation({ ...privateScope, owner: true }))
    expect(ownerSaved).toHaveProperty('jobId')
    expect(await f.plugin.invoke('memory_scopes', {}, 'read')).toMatchObject({ peerId: 'self', peerUri: `viking://user/${f.user}/peers/self/memories`, globalUri: `viking://user/${f.user}/memories` })
    const scoped = await f.plugin.invokeCapability('memory_scopes', {}, 'read', invocation(privateScope))
    expect(JSON.stringify(scoped)).not.toContain('9999')
    const controller = new AbortController(); controller.abort()
    await expect(f.plugin.invokeCapability('memory_save', { text: 'never send', request_id: 'save-005' }, 'save-005', invocation(privateScope, controller.signal))).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
  })

  it('read/delete require exact existing memory files, never recursive or cross-scope model access', async () => {
    const f = await fixture(); await f.plugin.connect()
    const root = `viking://user/${f.user}`, uri = root + '/peers/qq-1001-private-2001/memories/preferences/safe.md', other = root + '/peers/qq-1001-private-9999/memories/preferences/secret.md'
    f.memories.set(uri, 'tea'); f.memories.set(other, 'other secret')
    expect(await f.plugin.invokeCapability('memory_read', { uri }, 'read', invocation(privateScope))).toEqual({ uri, text: 'tea' })
    await expect(f.plugin.invokeCapability('memory_read', { uri: other }, 'read', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    for (const denied of [root + '/memories', root + '/memories/preferences', root + '/memories/preferences/../bad.md', root + '/memories/preferences/%2e%2e/file.md', root + '/memories/preferences/.abstract.md', 'file:///etc/passwd', 'viking://session/x/messages.jsonl']) await expect(f.plugin.manage('delete', { uri: denied, confirmed: true })).rejects.toThrow()
    await expect(f.plugin.manage('delete', { uri, confirmed: false })).rejects.toMatchObject({ code: 'MEMORY_CONFIRMATION_REQUIRED' })
    expect(await f.plugin.manage('delete', { uri, confirmed: true })).toEqual({ deleted: true }); expect(f.memories.has(uri)).toBe(false)
    const deletion = f.requests.find(request => request.method === 'DELETE' && request.path.endsWith('/fs'))!; expect(deletion.query.get('recursive')).toBe('false')
    await expect(f.plugin.manage('delete', { uri, confirmed: true })).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
  })
  it('bounds network response bodies, cancels stalled responses, accepts trusted server without API key', async () => {
    const f = await fixture({ apiKey: '' }); await f.plugin.connect()
    expect(f.plugin.getPublicConfiguration().apiKeyConfigured).toBe(false)
    f.controls.intercept = (_request, response) => { response.writeHead(200, { 'Content-Length': String(3 * 1024 * 1024) }); response.end('private'); return true }
    await expect(f.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_RESPONSE_TOO_LARGE' })
    f.controls.intercept = (_request, _response) => true
    await expect(f.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_TIMEOUT' })
    expect((await snapshot(f.plugin)).lastErrorCode).toBe('MEMORY_TIMEOUT')
  })

  it('caps concurrent extraction tasks at two and bounds buffer RAM before submitting oversized chat', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect(); f.controls.taskStatus = 'running'
    for (let n = 0; n < 4; n++) await f.plugin.memory.capture(capture({ ...privateScope, targetId: String(2001 + n) }, 'concurrency-' + n))
    await waitFor(() => f.committedSessions.length === 2)
    expect((await snapshot(f.plugin)).jobs.filter(job => job.status === 'queued')).toHaveLength(2)
    await expect(f.plugin.memory.capture(capture(privateScope, 'oversized', { messages: [{ role: 'user', text: 'x'.repeat(512 * 1024), timestamp: new Date().toISOString() }] }))).rejects.toMatchObject({ code: 'MEMORY_CAPACITY' })
    f.controls.taskStatus = 'completed'
    await waitFor(async () => (await snapshot(f.plugin)).jobs.filter(job => job.status === 'completed').length === 4)
    expect(f.errors).toEqual([])
  })

  it('cleans only after completed extraction and can resume a cleaning task after transient deletion failure', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    f.controls.intercept = (request, response) => {
      if (request.method !== 'DELETE') return false
      response.writeHead(503); response.end('PROVIDER-PRIVATE-DELETE-ERROR'); return true
    }
    await f.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.errorCode === 'MEMORY_SERVER_ERROR')
    expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ errorCode: 'MEMORY_SERVER_ERROR', changes: { added: 1, updated: 2, deleted: 0 } })
    expect(f.cleaned).toHaveLength(0); await f.plugin.disconnect()
    f.controls.intercept = undefined
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'completed'); expect(f.committedSessions).toHaveLength(1); expect(f.cleaned).toHaveLength(1)
  })

  it('retries definitely uncommitted staging cleanup after add writes but fails and first DELETE fails', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    let deletes = 0
    f.controls.intercept = (request, response) => {
      if (request.path.endsWith('/messages/batch')) {
        const sessionId = request.path.split('/').at(-3)!, session = f.sessions.get(sessionId)!
        session.messages.push(...request.body.messages as Array<Record<string, unknown>>)
        response.writeHead(503); response.end('private add failure'); return true
      }
      if (request.method === 'DELETE' && deletes++ === 0) { response.writeHead(503); response.end('private cleanup failure'); return true }
      return false
    }
    await f.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'cleaning' && deletes === 1)
    const job = (await snapshot(f.plugin)).jobs[0]!, staged = f.sessions.get(job.sessionId)!
    expect(staged.messages).toHaveLength(2); expect(job).toMatchObject({ taskId: null, archiveUri: null, errorCode: 'MEMORY_SERVER_ERROR' }); expect(f.committedSessions).toHaveLength(0)
    const saved = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).jobs[0]
    expect(saved).toMatchObject({ staged: true, commitAttempted: false, status: 'cleaning' })
    await f.plugin.disconnect()
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === 'failed')
    expect(staged.messages).toHaveLength(0); expect(staged.deleted).toBe(true); expect(deletes).toBe(2); expect(f.committedSessions).toHaveLength(0)
    await resumed.memory.capture(capture()); expect(f.sessions.size).toBe(1)
  })

  it('disconnect while staging retains cleanup proof and reconnect only deletes the uncommitted session', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    f.controls.intercept = (request, _response) => {
      if (!request.path.endsWith('/messages/batch')) return false
      const session = f.sessions.get(request.path.split('/').at(-3)!)!
      session.messages.push(...request.body.messages as Array<Record<string, unknown>>); return true
    }
    await f.plugin.memory.capture(capture()); await waitFor(() => [...f.sessions.values()][0]?.messages.length === 2)
    await f.plugin.disconnect(); expect((await snapshot(f.plugin)).jobs[0]).toMatchObject({ status: 'cleaning', taskId: null })
    expect(f.committedSessions).toHaveLength(0); expect(f.cleaned).toHaveLength(0)
    f.controls.intercept = undefined; await f.plugin.connect()
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'failed')
    expect([...f.sessions.values()][0]?.messages).toHaveLength(0); expect(f.cleaned).toHaveLength(1); expect(f.committedSessions).toHaveLength(0)
  })

  it.each(['completed', 'failed'] as const)('terminal %s cleanup survives task TTL expiration after DELETE failure', async taskStatus => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect(); f.controls.taskStatus = taskStatus
    f.controls.intercept = (request, response) => { if (request.method !== 'DELETE') return false; response.writeHead(503); response.end('private deletion error'); return true }
    await f.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.errorCode === 'MEMORY_SERVER_ERROR')
    const saved = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).jobs[0]
    expect(saved.terminalStatus).toBe(taskStatus); expect(saved.commitAttempted).toBe(true)
    await f.plugin.disconnect(); const polls = f.requests.filter(request => request.path.includes('/tasks/')).length
    f.tasks.clear(); f.controls.intercept = undefined
    const resumed = new OpenVikingMemoryPlugin(host(f.directory)); stops.push(() => resumed.disconnect()); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs[0]?.status === (taskStatus === 'completed' ? 'completed' : 'failed'))
    expect(f.requests.filter(request => request.path.includes('/tasks/'))).toHaveLength(polls)
    expect(f.cleaned).toHaveLength(1); expect(f.committedSessions).toHaveLength(1)
    expect((await snapshot(resumed)).jobs[0]?.changes).toEqual(taskStatus === 'completed' ? { added: 1, updated: 2, deleted: 0 } : null)
  })

  it('restart discards queued RAM bodies, submitting becomes unknown, missing known task becomes unknown without cleanup', async () => {
    const queued = await fixture(); await queued.plugin.connect(); await queued.plugin.memory.capture(capture())
    const restarted = new OpenVikingMemoryPlugin(host(queued.directory)); stops.push(() => restarted.disconnect()); await restarted.connect()
    expect((await snapshot(restarted)).jobs[0]).toMatchObject({ status: 'failed', errorCode: 'MEMORY_BUFFER_LOST' }); expect(queued.committedSessions).toHaveLength(0)
    const stateFile = join(queued.directory, 'state.json'), data = JSON.parse(await readFile(stateFile, 'utf8')); data.jobs[0].status = 'submitting'; await writeFile(stateFile, JSON.stringify(data))
    const submitting = new OpenVikingMemoryPlugin(host(queued.directory)); stops.push(() => submitting.disconnect()); await submitting.connect()
    expect((await snapshot(submitting)).jobs[0]).toMatchObject({ status: 'unknown', errorCode: 'MEMORY_SUBMISSION_UNKNOWN' }); expect(queued.committedSessions).toHaveLength(0)
    const missing = await fixture({ settings: { submissionMode: 'turn' } }); await missing.plugin.connect(); missing.controls.taskStatus = 'running'
    await missing.plugin.memory.capture(capture()); await waitFor(() => missing.tasks.size === 1); await missing.plugin.disconnect(); missing.tasks.clear()
    await missing.plugin.connect(); await waitFor(async () => (await snapshot(missing.plugin)).jobs[0]?.status === 'unknown')
    expect((await snapshot(missing.plugin)).jobs[0]?.errorCode).toBe('MEMORY_TASK_UNKNOWN'); expect(missing.cleaned).toHaveLength(0)
  })

  it('changing endpoint revokes pending submissions, discards buffers and never sends old jobs to new service', async () => {
    const f = await fixture({ settings: { submissionMode: 'turn' } }); await f.plugin.connect()
    f.controls.intercept = (request, _response) => request.method === 'POST' && request.path.endsWith('/sessions')
    await f.plugin.memory.capture(capture()); await waitFor(() => f.requests.some(request => request.method === 'POST' && request.path.endsWith('/sessions')))
    const other = await startOpenVikingFixture(); stops.push(other.close)
    await f.plugin.updateConfiguration({ expectedRevision: 1, endpoint: other.endpoint, account: other.account, user: other.user, apiKey: other.apiKey, autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS })
    expect((await snapshot(f.plugin)).jobs[0]?.status).toBe('unknown'); expect(other.requests).toHaveLength(0)
    await f.plugin.connect(); expect(other.requests).toHaveLength(1)
    expect(f.requests.filter(request => request.path.includes('/messages') || request.path.endsWith('/commit'))).toHaveLength(0)
    expect(other.committedSessions).toHaveLength(0)
  })

  it('accepted manual save survives normal caller lifetime end, while revoked-before-acceptance sends nothing', async () => {
    const f = await fixture(); await f.plugin.connect(); f.controls.taskPollsBeforeComplete = 1
    const controller = new AbortController()
    await f.plugin.invokeCapability('memory_save', { text: 'accepted fact', request_id: 'caller-lifetime' }, 'caller-lifetime', invocation(privateScope, controller.signal)); controller.abort()
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed'); expect(f.cleaned).toHaveLength(1)
    const count = f.requests.length
    await expect(f.plugin.invokeCapability('memory_save', { text: 'not accepted', request_id: 'already-revoked' }, 'already-revoked', invocation(privateScope, controller.signal))).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
    expect(f.requests).toHaveLength(count)
  })

  it('self memory ignores private switches; local manager can inspect disabled global and Unicode memory files', async () => {
    const f = await fixture({ settings: { privateCapture: false, privateRecall: false, globalMemory: false, ownerCrossSession: false, submissionMode: 'turn' } }); await f.plugin.connect()
    const root = `viking://user/${f.user}`, localUri = root + '/peers/self/memories/preferences/饮茶偏好.md', globalUri = root + '/memories/entities/某个项目.md', otherUri = root + '/peers/qq-1001-group-3001/memories/events/项目上线.md'
    f.memories.set(localUri, 'tea self'); f.memories.set(globalUri, 'tea global'); f.memories.set(otherUri, 'tea other')
    expect((await f.plugin.memory.recall(context(self), 'tea')).items.map(item => item.uri)).toEqual([localUri])
    await f.plugin.memory.capture(capture({ ...self, owner: false }, 'self-only', { messages: [{ role: 'assistant', text: 'autonomy persists with private capture off', timestamp: new Date().toISOString() }] }))
    await waitFor(async () => (await snapshot(f.plugin)).jobs[0]?.status === 'completed')
    expect(await f.plugin.manage('read', { uri: globalUri })).toEqual({ uri: globalUri, text: 'tea global' })
    expect(await f.plugin.manage('search', { query: 'tea', all: true })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ uri: globalUri }), expect.objectContaining({ uri: otherUri })]) })
    expect(await f.plugin.manage('delete', { uri: localUri, confirmed: true })).toEqual({ deleted: true })
  })

  it('counts successful extractions beyond retained 100 jobs and bounds scopes at 500 without a daily cost cap', async () => {
    const directory = await home(), store = new StateStore(directory), configKey = 'a'.repeat(64)
    for (let n = 0; n < 105; n++) {
      const job = store.create('self', configKey, true)
      store.update(job, { taskId: 'task-' + n, archiveUri: `viking://user/fixture_user/sessions/${job.sessionId}/history/archive_001`, status: 'completed', changes: { added: 1, updated: 0, deleted: 0 }, staged: true, commitAttempted: true })
    }
    for (let n = 0; n < 505; n++) store.touch({ ...privateScope, targetId: String(n) }, true, true, 0)
    store.save(); expect(store.value.jobs).toHaveLength(100); expect(store.value.scopes).toHaveLength(500); expect(store.value.extractionDay).toBe(localDay()); expect(store.value.extractionCount).toBe(105)
    const reloaded = new StateStore(directory); expect(reloaded.value.extractionCount).toBe(105)
    const plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect()); expect((await snapshot(plugin)).todayExtractions).toBe(105)
  })
})
