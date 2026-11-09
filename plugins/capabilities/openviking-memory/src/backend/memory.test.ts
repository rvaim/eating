import { DEFAULT_IMAGE_LIMITS } from '@eating/plugin-sdk'
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
function host(dataDirectory: string): HostPluginContext { return { imageLimits: () => DEFAULT_IMAGE_LIMITS, dataDirectory, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: true, eventId: 'unused' }), listMessages: () => [], executeIdempotent: async () => { throw new Error('Must not persist raw memory tool arguments in Host ledger') } } }
async function fixture(options: { root?: string; settings?: Partial<MemorySettings>; apiKey?: string; user?: string; account?: string } = {}) {
  const provider = await startOpenVikingFixture({ apiKey: options.apiKey, user: options.user, account: options.account }); stops.push(provider.close)
  const directory = options.root ?? await home(), plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect())
  await plugin.updateConfiguration({ expectedRevision: 0, endpoint: provider.endpoint, account: provider.account, user: provider.user, apiKey: provider.apiKey, autoConnect: false, timeoutMs: 1000, settings: { ...structuredClone(DEFAULT_SETTINGS), ...options.settings } })
  return { ...provider, plugin, directory }
}
const self: MemoryScope = { kind: 'self', platform: '', accountId: '', targetId: '', owner: true }
const privateScope: MemoryScope = { kind: 'private', platform: 'qq', accountId: '1001', targetId: '2001', owner: false }
const group: MemoryScope = { ...privateScope, kind: 'group', targetId: '3001' }
const sessionId = 'eating-standard-qq-1001-private-2001'
function context(current: MemoryScope = privateScope, turnId = 'turn-001'): MemoryContext { return { agentId: 'main-agent', agentTypeId: 'main', turnId, scope: current } }
function capture(current = privateScope, turnId = 'turn-001', overrides: Partial<MemoryCaptureInput> = {}): MemoryCaptureInput {
  return { context: context(current, turnId), messages: [{ role: 'user', text: 'PRIVATE-USER-CHAT likes tea', senderId: '2001', timestamp: '2026-11-01T13:00:00Z' }, { role: 'assistant', text: 'PRIVATE-ASSISTANT-CHAT noted', timestamp: '2026-11-01T13:00:01Z' }], actions: [], outcome: 'completed', ...overrides }
}
const snapshot = async (plugin: OpenVikingMemoryPlugin) => await plugin.manage('snapshot', {}) as unknown as RuntimeSnapshot
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000) { await vi.waitFor(async () => expect(await check()).toBe(true), { interval: 15, timeout }) }
const invocation = (current: MemoryScope, signal?: AbortSignal): CapabilityInvocationScope => ({ agentId: 'main-agent', agentTypeId: 'main', memory: context(current), signal })
const rule = (patch: Partial<ScopeRule> = {}): ScopeRule => ({ id: 'group-rule', label: 'Optional nickname', platform: 'qq', accountId: '1001', kind: 'group', targetId: '3001', capture: true, recall: true, memberMode: 'all', memberIds: [], ...patch })
const appends = (service: Service) => service.requests.filter(request => request.method === 'POST' && request.path.endsWith('/messages/batch'))
const taskReads = (service: Service) => service.requests.filter(request => request.method === 'GET' && request.path.includes('/tasks/'))
function expectStandardOnly(service: Service): void {
  expect(service.requests.filter(request => /eating-memory|incremental-memory/.test(request.path))).toEqual([])
  expect(service.requests.filter(request => request.method === 'DELETE' && request.path.includes('/sessions/'))).toEqual([])
  expect(service.errors).toEqual([])
}
async function synced(plugin: OpenVikingMemoryPlugin, count = 1) { await waitFor(async () => (await snapshot(plugin)).jobs.filter(job => job.kind === 'append' && job.status === 'synced').length === count) }
async function completed(plugin: OpenVikingMemoryPlugin, count = 1) { await waitFor(async () => (await snapshot(plugin)).jobs.filter(job => job.kind === 'commit' && job.status === 'completed').length === count) }

describe('standard OpenViking backend contract', () => {
  it('starts inert with schema3, checks authenticated identity without extensions or sessions and keeps secret CAS', async () => {
    const directory = await home(), plugin = new OpenVikingMemoryPlugin(host(directory)); stops.push(() => plugin.disconnect())
    expect(plugin.getPublicConfiguration()).toMatchObject({ schemaVersion: 3, revision: 0, endpoint: '', ready: false, settings: DEFAULT_SETTINGS })
    expect(DEFAULT_SETTINGS).toMatchObject({ autoCommit: true, commitTokenThreshold: 20000 })
    await plugin.memory.capture(capture()); expect((await snapshot(plugin)).jobs).toHaveLength(0)
    const service = await startOpenVikingFixture(); stops.push(service.close)
    const update = { expectedRevision: 0, endpoint: service.endpoint, account: service.account, user: service.user, apiKey: service.apiKey, autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS }
    await plugin.updateConfiguration(update); expect(service.requests).toHaveLength(0)
    expect(await plugin.manage('test-connection', {})).toEqual({ ok: true }); expect(service.sessions.size).toBe(0)
    expect(service.requests.map(request => request.path.slice(new URL(service.endpoint).pathname.length))).toEqual(['/api/v1/system/status'])
    expect(plugin.getPublicConfiguration().ready).toBe(false)
    await plugin.connect(); expect(plugin.getStatus().state).toBe('connected')
    await plugin.updateConfiguration({ ...update, expectedRevision: 1, apiKey: '' }); expect(plugin.getPublicConfiguration()).toMatchObject({ revision: 2, apiKeyConfigured: true, ready: true })
    await expect(plugin.updateConfiguration({ ...update, expectedRevision: 1 })).rejects.toMatchObject({ code: 'MEMORY_CONFIGURATION_CONFLICT' })
    expect(JSON.stringify(plugin.getPublicConfiguration())).not.toContain(service.apiKey)
    expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).apiKey).toBe(service.apiKey)
    if (process.platform !== 'win32') expect((await lstat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600)
    await plugin.updateConfiguration({ ...update, expectedRevision: 2, apiKey: '', clearApiKey: true }); expect(plugin.getPublicConfiguration()).toMatchObject({ apiKeyConfigured: false, ready: false })
    expectStandardOnly(service)
  })

  it('rejects auth mismatch, a fake health response, provider secrets and redirects with fixed codes', async () => {
    const service = await fixture(); service.controls.rejectAuth = true
    await expect(service.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_AUTH_FAILED', message: 'MEMORY_AUTH_FAILED' })
    expect(JSON.stringify(await snapshot(service.plugin))).not.toContain(service.apiKey)
    service.controls.rejectAuth = false; service.controls.identityUser = 'wrong_user'
    await expect(service.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_IDENTITY_MISMATCH' })
    service.controls.identityUser = null; service.controls.initialized = false
    await expect(service.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_SERVER_NOT_READY' })
    service.controls.intercept = (_request, response) => { response.end(JSON.stringify({ healthy: true, result: { user: service.user } })); return true }
    await expect(service.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_UNSUPPORTED_SERVER' })
    service.controls.intercept = (_request, response) => { response.writeHead(302, { Location: '/private?key=' + service.apiKey }); response.end(); return true }
    await expect(service.plugin.connect()).rejects.toMatchObject({ code: 'MEMORY_REDIRECT_DENIED' })
    expect(service.sessions.size).toBe(0); expectStandardOnly(service)
  })

  it.each([1, 2])('rejects old schema%i configuration and state without modifying their bytes', async schemaVersion => {
    const directory = await home(), path = join(directory, 'config.json'), old = JSON.stringify({ schemaVersion, revision: 2, endpoint: 'http://127.0.0.1:1', account: 'old', user: 'old', apiKey: 'PRIVATE', autoConnect: false, timeoutMs: 1000, settings: DEFAULT_SETTINGS })
    await writeFile(path, old); expect(() => new OpenVikingMemoryPlugin(host(directory))).toThrow('MEMORY_CONFIGURATION_CORRUPTED'); expect(await readFile(path, 'utf8')).toBe(old)
    const stateHome = await home(), statePath = join(stateHome, 'state.json'), previous = JSON.stringify({ schemaVersion, jobs: [], scopes: [], lastRecallAt: null, lastCaptureAt: null, lastErrorCode: null, extractionDay: localDay(), extractionCount: 0 })
    await writeFile(statePath, previous); expect(() => new OpenVikingMemoryPlugin(host(stateHome))).toThrow('MEMORY_STATE_CORRUPTED'); expect(await readFile(statePath, 'utf8')).toBe(previous)
  })

  it('validates exact settings, threshold bounds, collisions and external file CAS', async () => {
    const service = await fixture(), patch = { expectedRevision: 1, endpoint: service.endpoint, account: service.account, user: service.user, autoConnect: false, timeoutMs: 1000, settings: structuredClone(DEFAULT_SETTINGS) }
    const config = JSON.parse(await readFile(join(service.directory, 'config.json'), 'utf8'))
    for (const settings of [{ ...DEFAULT_SETTINGS, archiveMaxMiB: 8 }, { ...DEFAULT_SETTINGS, autoCommit: 'true' }, ...[0, 1000001, 2.5].map(commitTokenThreshold => ({ ...DEFAULT_SETTINGS, commitTokenThreshold })), { ...DEFAULT_SETTINGS, rules: [rule(), rule({ id: 'other' })] }]) await expect(service.plugin.updateConfiguration({ ...patch, settings })).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONFIGURATION' })
    for (const extra of [{ schemaVersion: 3 }, { user: '../escape' }, { endpoint: service.endpoint + '?key=private' }]) await expect(service.plugin.updateConfiguration({ ...patch, ...extra })).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONFIGURATION' })
    await writeFile(join(service.directory, 'config.json'), JSON.stringify({ ...config, revision: 2 }))
    await expect(service.plugin.updateConfiguration(patch)).rejects.toMatchObject({ code: 'MEMORY_CONFIGURATION_CONFLICT' })
  })

  it('syncs every round to one fixed session without commit, preserves provenance and never persists raw bodies', async () => {
    const service = await fixture(); await service.plugin.connect()
    for (let round = 0; round < 3; round++) {
      await service.plugin.memory.capture(capture(privateScope, `ordinary-${round}`, { actions: [{ tool: 'qq_send_private_msg', outcome: 'succeeded' }, { tool: 'qq_get_message', outcome: 'returned' }] }))
      await synced(service.plugin, round + 1)
    }
    expect(service.sessions.size).toBe(1); expect(service.sessions.get(sessionId)!.messages).toHaveLength(6)
    expect(service.sessions.get(sessionId)!.policy).toEqual({ peer: { enabled: true }, self: { enabled: true }, memory_types: ['preferences', 'entities', 'events'] })
    expect(service.requests.find(request => request.method === 'POST' && request.path.endsWith('/sessions'))!.body.auto_commit_policy).toBeNull()
    expect(service.commits).toHaveLength(0); expect(taskReads(service)).toHaveLength(0)
    expect(service.appendBatches[0]!.messages).toMatchObject([{ role: 'user', peer_id: 'qq-1001-private-2001', content: expect.stringContaining('PRIVATE-USER-CHAT') }, { role: 'assistant', content: expect.stringContaining('qq_get_message: returned') }])
    expect(service.appendBatches[0]!.messages[0]!.content).toContain('"senderId":"2001"')
    const metadata = await readFile(join(service.directory, 'state.json'), 'utf8')
    for (const secret of ['PRIVATE-USER-CHAT', 'PRIVATE-ASSISTANT-CHAT', 'qq_send_private_msg: succeeded', service.apiKey]) expect(metadata).not.toContain(secret)
    await service.plugin.memory.capture(capture(privateScope, 'ordinary-0', { actions: [{ tool: 'qq_send_private_msg', outcome: 'succeeded' }, { tool: 'qq_get_message', outcome: 'returned' }] })); expect(service.appendBatches).toHaveLength(3)
    await expect(service.plugin.memory.capture(capture(privateScope, 'ordinary-0'))).rejects.toMatchObject({ code: 'MEMORY_IDEMPOTENCY_CONFLICT' })
    expect((await snapshot(service.plugin)).jobs.every(job => !Object.hasOwn(job, 'changes') && job.taskId === null)).toBe(true)
    expectStandardOnly(service)
  })

  it.each([1, 20000, 1000000])('commits at the actual pending-token threshold %i and polls only the returned task', async commitTokenThreshold => {
    const service = await fixture({ settings: { commitTokenThreshold } }); service.controls.pendingTokens = commitTokenThreshold; await service.plugin.connect()
    await service.plugin.memory.capture(capture()); await completed(service.plugin)
    expect(service.commits).toHaveLength(1); expect(service.archives.size).toBe(1)
    expect(service.commits[0]!.messages).toHaveLength(2); expect(service.sessions.get(sessionId)!.messages).toHaveLength(0)
    const jobs = (await snapshot(service.plugin)).jobs
    expect(jobs).toHaveLength(2); expect(jobs.every(job => job.status === 'completed' && job.taskId === service.commits[0]!.taskId && job.archiveUri === service.commits[0]!.archiveUri)).toBe(true)
    expect(jobs.find(job => job.kind === 'commit')).toMatchObject({ trigger: 'threshold', pendingTokens: commitTokenThreshold })
    expect((await snapshot(service.plugin)).todayExtractions).toBe(1)
    expect(taskReads(service).every(request => request.path.endsWith('/' + service.commits[0]!.taskId))).toBe(true)
    expect(service.requests.find(request => request.path.endsWith('/commit'))!.body).toEqual({ keep_recent_count: 0 }); expectStandardOnly(service)
  })

  it('uses server tokens rather than message, tool, immediate or byte counts and flush commits all synced turns once', async () => {
    const service = await fixture(); service.controls.pendingTokens = 19999; await service.plugin.connect()
    for (let round = 0; round < 2; round++) { await service.plugin.memory.capture(capture(privateScope, `round-${round}`, { immediate: true, actions: [{ tool: 'image_generate', outcome: 'returned' }] })); await synced(service.plugin, round + 1) }
    expect(service.commits).toHaveLength(0)
    await Promise.all([service.plugin.manage('flush', {}), service.plugin.manage('flush', {})]); await completed(service.plugin)
    expect(service.commits).toHaveLength(1); expect(service.commits[0]!.messages).toHaveLength(4)
    expect((await snapshot(service.plugin)).jobs.filter(job => job.kind === 'append').every(job => job.status === 'completed')).toBe(true)
    await service.plugin.manage('flush', {}); expect(service.commits).toHaveLength(1)
  })

  it.each(['compaction', 'session-end'] as const)('commits a synced session at %s when automatic commit is enabled', async reason => {
    const service = await fixture(); await service.plugin.connect(); await service.plugin.memory.capture(capture()); await synced(service.plugin)
    await service.plugin.memory.flush!(reason); await completed(service.plugin)
    expect(service.commits).toHaveLength(1); expect((await snapshot(service.plugin)).jobs.find(job => job.kind === 'commit')!.trigger).toBe(reason === 'session-end' ? 'shutdown' : reason)
  })

  it('honors explicit autoCommit off for threshold, compaction and shutdown while manual flush remains available', async () => {
    const service = await fixture({ settings: { autoCommit: false, commitTokenThreshold: 1 } }); service.controls.pendingTokens = 20000; await service.plugin.connect()
    await service.plugin.memory.capture(capture()); await synced(service.plugin)
    await service.plugin.memory.flush!('compaction'); await service.plugin.memory.flush!('session-end'); expect(service.commits).toHaveLength(0)
    await service.plugin.manage('flush', {}); await completed(service.plugin)
    await service.plugin.memory.capture(capture(privateScope, 'new-round')); await synced(service.plugin)
    await service.plugin.dispose(); expect(service.commits).toHaveLength(1)
  })

  it('commits on normal dispose without deleting the session and keeps known task recovery metadata', async () => {
    const service = await fixture(); await service.plugin.connect(); await service.plugin.memory.capture(capture()); await synced(service.plugin)
    await service.plugin.dispose(); expect(service.commits).toHaveLength(1); expect(service.archives.size).toBe(1); expect(service.sessions.has(sessionId)).toBe(true)
    expect((JSON.parse(await readFile(join(service.directory, 'state.json'), 'utf8')).jobs as Array<{ kind: string; taskId: string }>).find(job => job.kind === 'commit')!.taskId).toBe(service.commits[0]!.taskId)
    expectStandardOnly(service)
  })

  it('resumes synchronized pending records after restart without appending them again', async () => {
    const service = await fixture(); await service.plugin.connect(); await service.plugin.memory.capture(capture()); await synced(service.plugin); await service.plugin.disconnect()
    const resumed = new OpenVikingMemoryPlugin(host(service.directory)); stops.push(() => resumed.disconnect()); await resumed.connect(); await resumed.memory.capture(capture())
    await resumed.manage('flush', {}); await completed(resumed); expect(service.appendBatches).toHaveLength(1); expect(service.commits).toHaveLength(1)
    await resumed.memory.capture(capture(privateScope, 'second-round')); await synced(resumed)
    expect(service.sessions.size).toBe(1); expect(service.requests.filter(request => request.method === 'POST' && request.path.endsWith('/sessions'))).toHaveLength(1)
  })

  it('keeps global-on and global-off roots distinct and never attaches to a preexisting incremental live session', async () => {
    const service = await fixture(); await service.plugin.connect(); await service.plugin.memory.capture(capture()); await synced(service.plugin)
    await service.plugin.updateConfiguration({ expectedRevision: 1, endpoint: service.endpoint, account: service.account, user: service.user, autoConnect: false, timeoutMs: 1000, settings: { ...DEFAULT_SETTINGS, globalMemory: false } })
    await service.plugin.memory.capture(capture(privateScope, 'local-round')); await synced(service.plugin, 2)
    expect([...service.sessions.keys()].sort()).toEqual([sessionId, sessionId + '-local'])
    expect(service.sessions.get(sessionId + '-local')!.policy).toMatchObject({ self: { enabled: false } })
    expect(service.requests.some(request => request.path.includes('eating-live-'))).toBe(false)
  })

  it('serializes same-session writes, permits new appends while extraction is processing and lets other sessions proceed', async () => {
    const service = await fixture({ settings: { commitTokenThreshold: 1 } }); service.controls.taskStatus = 'running'; await service.plugin.connect()
    await service.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(service.plugin)).jobs.some(job => job.kind === 'commit' && job.status === 'processing'))
    await service.plugin.memory.capture(capture(privateScope, 'second')); await waitFor(() => service.appendBatches.length === 2)
    await service.plugin.memory.capture(capture({ ...privateScope, targetId: '2002' }, 'other')); await waitFor(() => service.appendBatches.length === 3)
    expect(service.sessions.size).toBe(2); expect(service.commits.length).toBeGreaterThanOrEqual(1)
    service.controls.taskStatus = 'completed'; await completed(service.plugin, 3)
    expect(service.appendBatches.filter(batch => batch.sessionId === sessionId)).toHaveLength(2); expectStandardOnly(service)
  })

  it.each(['create', 'append', 'commit'] as const)('never resends an unknown %s after restart and blocks only that session', async phase => {
    const service = await fixture({ settings: { commitTokenThreshold: phase === 'commit' ? 1 : 20000 } }); service.controls[`${phase}Disconnect`] = true; await service.plugin.connect()
    await service.plugin.memory.capture(capture()); await waitFor(async () => (await snapshot(service.plugin)).jobs.some(job => job.status === 'unknown'))
    await service.plugin.disconnect(); service.controls[`${phase}Disconnect`] = false
    const postsBefore = service.requests.filter(request => request.method === 'POST' && !request.path.endsWith('/search/find')).length
    const resumed = new OpenVikingMemoryPlugin(host(service.directory)); stops.push(() => resumed.disconnect()); await resumed.connect(); await resumed.memory.capture(capture()); await resumed.manage('flush', {})
    expect(service.requests.filter(request => request.method === 'POST' && !request.path.endsWith('/search/find'))).toHaveLength(postsBefore)
    await resumed.memory.capture(capture(privateScope, 'blocked-next')); await resumed.memory.capture(capture({ ...privateScope, targetId: '2002' }, 'other-peer'))
    await waitFor(() => service.appendBatches.some(batch => batch.sessionId.endsWith('2002')))
    expect(appends(service).filter(request => request.path.includes(sessionId + '/'))).toHaveLength(phase === 'create' ? 0 : 1)
    expect((await snapshot(resumed)).jobs.some(job => job.peerId === 'qq-1001-private-2001' && job.status === 'queued')).toBe(true)
    expect(taskReads(service).filter(request => phase !== 'commit' || request.path.endsWith('/' + service.commits[0]!.taskId))).toHaveLength(0)
    expectStandardOnly(service)
  })

  it('recovers a known task using GET alone across restart and treats expired tasks as unknown without replay', async () => {
    const service = await fixture({ settings: { commitTokenThreshold: 1 } }); service.controls.taskStatus = 'running'; await service.plugin.connect(); await service.plugin.memory.capture(capture())
    await waitFor(() => taskReads(service).length > 0); await service.plugin.disconnect(); const taskId = service.commits[0]!.taskId
    service.controls.taskUnavailable = true
    const resumed = new OpenVikingMemoryPlugin(host(service.directory)); stops.push(() => resumed.disconnect()); await resumed.connect()
    await waitFor(async () => (await snapshot(resumed)).jobs.some(job => job.kind === 'commit' && job.status === 'unknown'))
    await resumed.memory.capture(capture(privateScope, 'blocked-on-task')); await resumed.manage('flush', {})
    expect(service.commits).toHaveLength(1); expect(service.appendBatches).toHaveLength(1)
    service.controls.taskUnavailable = false; service.controls.taskStatus = 'completed'
    await waitFor(async () => (await snapshot(resumed)).jobs.some(job => job.kind === 'append' && job.status === 'completed'))
    await waitFor(() => service.appendBatches.length === 2)
    expect(taskReads(service).filter(request => request.path.endsWith('/' + taskId)).length).toBeGreaterThan(1)
    expectStandardOnly(service)
  })

  it('retains official extraction failures without fake diff counts or POST retry', async () => {
    const service = await fixture({ settings: { commitTokenThreshold: 1 } }); service.controls.taskStatus = 'failed'; await service.plugin.connect(); await service.plugin.memory.capture(capture())
    await waitFor(async () => (await snapshot(service.plugin)).jobs.some(job => job.kind === 'commit' && job.status === 'failed'))
    const failed = (await snapshot(service.plugin)).jobs.find(job => job.kind === 'commit')!
    expect(failed).toMatchObject({ archiveUri: service.commits[0]!.archiveUri, taskId: service.commits[0]!.taskId, errorCode: 'MEMORY_EXTRACTION_FAILED' }); expect(failed).not.toHaveProperty('changes')
    await expect(service.plugin.manage('retry', { jobId: failed.id })).rejects.toMatchObject({ code: 'MEMORY_OPERATION_NOT_FOUND' })
    expect(service.commits).toHaveLength(1); expect(service.archives.size).toBe(1); expectStandardOnly(service)
  })

  it('persists queued bodies only in RAM, marks interrupted writes unknown and never evicts unresolved jobs', async () => {
    const service = await fixture(); await service.plugin.connect()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); stops.push(() => release())
    service.controls.intercept = async request => { if (request.path.endsWith('/messages/batch')) await gate; return false }
    for (let round = 0; round < 4; round++) await service.plugin.memory.capture(capture({ ...privateScope, targetId: String(2001 + round) }, 'round-' + round))
    await waitFor(() => appends(service).length === 2); expect((await snapshot(service.plugin)).jobs.filter(job => job.status === 'queued')).toHaveLength(2)
    await expect(service.plugin.memory.capture(capture(privateScope, 'oversized', { messages: [{ role: 'user', text: 'x'.repeat(512 * 1024), timestamp: new Date().toISOString() }] }))).rejects.toMatchObject({ code: 'MEMORY_CAPACITY' })
    await service.plugin.disconnect(); release()
    const states = new StateStore(service.directory).value.jobs.map(job => job.status)
    expect(states.filter(status => status === 'unknown')).toHaveLength(2); expect(states.filter(status => status === 'failed')).toHaveLength(2)
    const store = new StateStore(await home())
    for (let round = 0; round < 100; round++) { const job = store.create('self', 'a'.repeat(64), true, { id: String(round).padStart(64, '0'), hash: 'b'.repeat(64) }); job.messages = 1; store.update(job, { status: 'unknown', mutation: 'append' }) }
    expect(() => store.create('self', 'a'.repeat(64), true, { id: 'c'.repeat(64), hash: 'b'.repeat(64) })).toThrow('MEMORY_CAPACITY')
  })

  it('reserves commit metadata capacity when all 100 append records are synced and waiting for extraction', async () => {
    const service = await fixture({ settings: { autoCommit: false } }); await service.plugin.connect()
    for (let round = 0; round < 100; round++) { await service.plugin.memory.capture(capture(privateScope, 'capacity-' + round)); await synced(service.plugin, round + 1) }
    await expect(service.plugin.memory.capture(capture(privateScope, 'capacity-overflow'))).rejects.toMatchObject({ code: 'MEMORY_CAPACITY' })
    await service.plugin.manage('flush', {}); await completed(service.plugin)
    expect(service.commits).toHaveLength(1); expect(service.commits[0]!.messages).toHaveLength(200)
    expect((await snapshot(service.plugin)).jobs.filter(job => job.kind === 'append' && job.status === 'completed')).toHaveLength(100)
    await service.plugin.memory.capture(capture(privateScope, 'after-capacity-commit')); await synced(service.plugin)
    expect(new StateStore(service.directory).value.jobs.length).toBeLessThanOrEqual(200)
  }, 20000)

  it('splits accepted captures into proven official batches of at most 100 without committing between chunks', async () => {
    const service = await fixture(); await service.plugin.connect()
    await service.plugin.memory.capture(capture(privateScope, 'many-messages', { messages: Array.from({ length: 201 }, (_, index) => ({ role: 'user', text: `fact ${index}`, timestamp: new Date().toISOString() })) }))
    await synced(service.plugin); expect(service.appendBatches.map(batch => batch.messages.length)).toEqual([100, 100, 1]); expect(service.commits).toHaveLength(0)
  })

  it.each(['allowlist', 'denylist'] as const)('filters real group speaker IDs for %s and omits mixed assistant and action summaries', async mode => {
    const service = await fixture({ settings: { rules: [rule({ memberMode: mode, memberIds: [mode === 'allowlist' ? 'allowed' : 'denied'] })] } }); await service.plugin.connect()
    const input = capture(group, 'mixed', { messages: [{ role: 'user', text: 'allowed user fact', senderId: 'allowed', timestamp: new Date().toISOString() }, { role: 'user', text: 'BLOCKED-PRIVATE-SPEAKER', senderId: 'denied', timestamp: new Date().toISOString() }, { role: 'assistant', text: 'LEAKY-ASSISTANT-ANSWER', timestamp: new Date().toISOString() }], actions: [{ tool: 'tool_name', outcome: 'returned' }] })
    await service.plugin.memory.capture(input); await synced(service.plugin)
    const messages = service.appendBatches[0]!.messages; expect(messages).toHaveLength(1); expect(messages[0]!.content).toContain('"senderId":"allowed"'); expect(messages[0]!.content).toContain('"target":"3001"')
    for (const denied of ['BLOCKED-PRIVATE-SPEAKER', 'LEAKY-ASSISTANT-ANSWER', 'tool_name']) expect(JSON.stringify(messages)).not.toContain(denied)
    await service.plugin.memory.capture(capture(group, 'blocked', { messages: input.messages.filter(message => message.senderId !== 'allowed'), actions: input.actions })); expect((await snapshot(service.plugin)).jobs).toHaveLength(1)
    await expect(service.plugin.invokeCapability('memory_save', { text: 'manual group summary', request_id: 'bypass' }, 'bypass', invocation(group))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
  })

  it('keeps group capture off by default and self activity independent of private and global switches', async () => {
    const service = await fixture({ settings: { privateCapture: false, privateRecall: false, globalMemory: false, ownerCrossSession: false } }); await service.plugin.connect()
    await service.plugin.memory.capture(capture(group)); await service.plugin.memory.capture(capture()); expect((await snapshot(service.plugin)).jobs).toHaveLength(0)
    await service.plugin.memory.capture(capture({ ...self, owner: false }, 'autonomy', { messages: [{ role: 'assistant', text: 'autonomous task done', timestamp: new Date().toISOString() }], actions: [{ tool: 'native_task', outcome: 'returned' }] })); await synced(service.plugin)
    expect(service.sessions.get('eating-standard-self-local')!.policy).toMatchObject({ self: { enabled: false } }); expect(JSON.stringify(service.appendBatches)).toContain('native_task: returned')
  })

  it.each([{ user: 'eating-bot', account: 'team-1' }, { user: 'eating.bot@team', account: 'team.1@org' }])('preserves SDK scoped recall, identities and exact file management: %j', async identity => {
    const service = await fixture(identity); await service.plugin.connect()
    const root = `viking://user/${identity.user}`, current = root + '/peers/qq-1001-private-2001/memories/preferences/tea.md', global = root + '/memories/preferences/global.md', other = root + '/peers/qq-1001-private-9999/memories/preferences/other.md'
    expect(globalRoot(identity.user)).toBe(root + '/memories'); expect(peerRoot(identity.user, 'qq-1001-private-2001')).toBe(root + '/peers/qq-1001-private-2001/memories')
    service.memories.set(current, 'tea local'); service.memories.set(global, 'tea global'); service.memories.set(other, 'tea other')
    expect((await service.plugin.memory.recall(context(), 'tea')).items.map(hit => hit.uri).sort()).toEqual([current, global].sort())
    const request = service.requests.find(request => request.path.endsWith('/search/find'))!
    expect(request.headers).toMatchObject({ 'x-openviking-user': identity.user, 'x-openviking-account': identity.account, 'x-openviking-actor-peer': 'qq-1001-private-2001' })
    expect(request.body).toMatchObject({ target_uri: [root + '/memories', root + '/peers/qq-1001-private-2001/memories'], context_type: 'memory', level: [2], score_threshold: 0.35 })
    await expect(service.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'read', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    await expect(service.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'read', invocation({ ...group, owner: true }))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    expect(JSON.stringify(await service.plugin.invokeCapability('memory_search', { query: 'tea', all: true }, 'read', invocation({ ...privateScope, owner: true })))).toContain('tea other')
    expect(await service.plugin.invokeCapability('memory_read', { uri: current }, 'read', invocation(privateScope))).toEqual({ uri: current, text: 'tea local' })
    await expect(service.plugin.invokeCapability('memory_read', { uri: other }, 'read', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    await expect(service.plugin.manage('delete', { uri: current, confirmed: false })).rejects.toMatchObject({ code: 'MEMORY_CONFIRMATION_REQUIRED' })
    expect(await service.plugin.manage('delete', { uri: current, confirmed: true })).toEqual({ deleted: true }); expect(service.memories.has(current)).toBe(false)
    expectStandardOnly(service)
  })

  it('filters cross-peer results, bounds recall, denies unsafe URIs and cancels in-flight reads', async () => {
    const service = await fixture({ settings: { recallMaxChars: 256 } }); await service.plugin.connect()
    const root = `viking://user/${service.user}`, allowed = root + '/peers/qq-1001-private-2001/memories/entities/book.md', denied = root + '/peers/qq-1001-private-9999/memories/entities/book.md'
    service.memories.set(allowed, 'x'.repeat(1000)); service.memories.set(denied, 'denied')
    service.controls.intercept = (request, response) => { if (!request.path.endsWith('/search/find')) return false; response.end(JSON.stringify({ status: 'ok', result: { memories: [{ uri: denied, score: 0.99 }, { uri: allowed, score: 0.9 }] } })); return true }
    expect((await service.plugin.memory.recall(context(), 'book')).items).toEqual([{ uri: allowed, text: 'x'.repeat(256), score: 0.9 }])
    for (const uri of [root + '/memories', root + '/memories/preferences/../bad.md', root + '/memories/preferences/%2e%2e/file.md', root + '/memories/preferences/.abstract.md', 'file:///etc/passwd', 'viking://session/x/messages.jsonl']) await expect(service.plugin.manage('delete', { uri, confirmed: true })).rejects.toThrow()
    const controller = new AbortController(); service.controls.intercept = request => request.path.endsWith('/content/read')
    const pending = service.plugin.memory.recall(context(), 'x', controller.signal); await waitFor(() => service.requests.filter(request => request.path.endsWith('/content/read')).length === 2)
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
  })

  it('derives MCP scope, keeps stable explicit save IDs and honors revocation before acceptance', async () => {
    const service = await fixture(); await service.plugin.connect()
    const controller = new AbortController(), input = { text: 'explicit fact', request_id: 'save-001' }
    const saved = await service.plugin.invokeCapability('memory_save', input, 'save-001', invocation(privateScope, controller.signal)) as { jobId: string }; controller.abort()
    await synced(service.plugin); expect(await service.plugin.invokeCapability('memory_save', input, 'save-001', invocation(privateScope))).toMatchObject({ jobId: saved.jobId })
    await expect(service.plugin.invokeCapability('memory_save', { ...input, text: 'different' }, 'save-001', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_IDEMPOTENCY_CONFLICT' })
    await expect(service.plugin.invokeCapability('memory_save', { ...input, request_id: 'new', peer_id: 'other' }, 'new', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_INVALID_INPUT' })
    await expect(service.plugin.invokeCapability('memory_save', { ...input, request_id: 'global', global: true }, 'global', invocation(privateScope))).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    await expect(service.plugin.invokeCapability('memory_save', { ...input, request_id: 'cancelled' }, 'cancelled', invocation(privateScope, controller.signal))).rejects.toMatchObject({ code: 'MEMORY_CANCELLED' })
    expect(service.appendBatches).toHaveLength(1); expect(service.commits).toHaveLength(0)
  })

  it('bounds response streams, times out stalled reads and accepts trusted services without API keys', async () => {
    const service = await fixture({ apiKey: '' }); await service.plugin.connect(); expect(service.plugin.getPublicConfiguration().apiKeyConfigured).toBe(false)
    service.controls.intercept = (_request, response) => { response.writeHead(200, { 'Content-Length': String(3 * 1024 * 1024) }); response.end('private'); return true }
    await expect(service.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_RESPONSE_TOO_LARGE' })
    service.controls.intercept = () => true; await expect(service.plugin.manage('test-connection', {})).rejects.toMatchObject({ code: 'MEMORY_TIMEOUT' })
  })

  it('validates archive owners and service identities without loosening peer tuple IDs', () => {
    for (const value of ['eating-bot', 'team.1', 'bot@team', '_user']) expect(serviceIdentity(value)).toBe(value)
    for (const value of ['', '.', '..', 'a@@b', 'a/b', 'a%2fb', 'a?b', 'has space', 'a\nb']) expect(() => serviceIdentity(value)).toThrow()
    const user = 'eating.bot@team', uri = `viking://user/${user}/sessions/${sessionId}/history/archive_001`
    expect(archive(uri, sessionId, user)).toBe(uri)
    for (const denied of [uri.replace(user, 'eatingXbot@team'), uri + '/messages.jsonl', uri.replace('archive_001', '../messages')]) expect(() => archive(denied, sessionId, user)).toThrow()
    expect(memoryLocation(`viking://user/${user}/memories/preferences/饮茶.md`, user).peer).toBeNull()
    expect(() => peerRoot(user, 'qq-team-1-private-2001')).toThrow()
  })
})
