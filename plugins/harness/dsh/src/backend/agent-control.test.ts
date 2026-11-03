import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { HarnessDeliveryBatch, HarnessHostServices, HarnessOwnerConfiguration } from '@eating/plugin-sdk'
import { conversationContextRef, DshAgentControl } from './agent-control'
import { createHash } from 'node:crypto'
import { agentInstanceLabel } from './agent-label'
import { AUTONOMY_DEFAULTS, DshAutonomy } from './autonomy'
import type { JsonObject, ProactiveTarget } from '@eating/plugin-sdk'

const stops: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
const parentId = '00000000-0000-4000-8000-000000000001'
function fixture() {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(parent, 'eating-agent-control-')))
  stops.push(() => { if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-agent-control-')) throw new Error('Unsafe fixture cleanup'); rmSync(directory, { recursive: true }) })
  const owner: HarnessOwnerConfiguration = { revision: 3, activePersona: null, pluginInstructions: [], bindings: { 主人: '', 管理员: '' }, prompts: [
    { id: 'common', scope: 'common', source: 'owner', title: 'common', body: 'COMMON', revision: 1, updatedAt: null }, { id: 'subagent', scope: 'subagent', source: 'owner', title: 'subagent', body: 'SUBAGENT', revision: 1, updatedAt: null },
    { id: 'main', scope: 'main', source: 'owner', title: 'main', body: 'MAIN', revision: 1, updatedAt: null }, { id: 'agent:qq.private', agentTypeId: 'qq.private', scope: 'agent', source: 'plugin', title: 'private', body: 'PRIVATE {{目标编号}}', revision: 1, updatedAt: null, pluginId: 'qq' },
  ], agentTypes: [{ id: 'qq.private', title: 'Private', description: 'Private target', conversationKind: 'private', defaultPrompt: 'PRIVATE', availableTools: ['send'], defaultTools: ['send'], enabledTools: ['send'], pluginId: 'qq', pluginName: 'QQ', enabled: true, identity: { owners: [], administrators: [] } }] }
  const host: HarnessHostServices = { registerSink: () => () => {}, wake: () => {}, readOwnerConfiguration: () => owner,
    getCapabilityMcpConnections: () => [], getMcpConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer fixture-scoped-only-token' }, toolNames: ['send'] })),
    readAgentActions: vi.fn(() => [{ requestId: 'request-1', tool: 'send', outcome: 'succeeded' as const }]), revokeAgentAccess: vi.fn() }
  const control = new DshAgentControl(directory, host); stops.push(() => control.close())
  const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId: 'qq:100:private:200', createdAt: '2026-10-28T00:00:00Z', reason: 'quiet-window', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', instanceId: 'instance', platform: 'qq', accountId: '100', conversationId: 'qq:100:private:200', senderId: '200', targetId: '200', messageId: '300', resourceIds: ['https://fixture.invalid/file'], receivedAt: '2026-10-28T00:00:00Z', source: { trust: 'external', kind: 'private', senderRole: 'user' }, content: 'EXTERNAL-MESSAGE-BODY', text: 'EXTERNAL-MESSAGE-BODY' }] }
  const post = async (path: string, value: object, headers: Record<string, string> = {}) => fetch(control.url + path, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'X-Eating-Runtime': 'fixture-runtime-nonce', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
  return { directory, control, host, owner, batch, post }
}

describe('trusted native Agent control boundary', () => {
  async function restorationFixture(options: { eventCount?: number; mixed?: boolean; pending?: boolean } = {}) {
    const f = fixture()
    const events = Array.from({ length: options.eventCount ?? 301 }, (_, index) => ({ ...f.batch.events[0]!, eventId: `event-${index}`, messageId: `message-${index}`, resourceIds: [`resource-${index}`] }))
    if (options.mixed) events.push({ ...events[0]!, eventId: 'other-target', conversationId: 'other-conversation', targetId: '201', senderId: '201', messageId: 'other-message', resourceIds: ['other-resource'] })
    const batch: HarnessDeliveryBatch = { ...f.batch, conversationId: options.mixed ? null : f.batch.conversationId, events }
    const bound = f.control.bindBatch(batch, parentId)
    const context = { contextRef: batch.batchId, createdAt: batch.createdAt, reason: batch.reason, ownerRevision: f.owner.revision,
      conversations: bound.map(({ contextRef, binding }) => ({ contextRef, agentTypeId: binding.scope.agentTypeId, pluginId: binding.scope.pluginId, platform: 'qq', accountId: binding.scope.accountId, instanceId: binding.scope.instanceId, conversationId: binding.scope.conversationId, kind: binding.scope.kind, targetId: binding.scope.targetId, createdAt: batch.createdAt, reason: batch.reason, ownerRevision: f.owner.revision })) }
    const digest = createHash('sha256').update(JSON.stringify({ context, events })).digest('hex')
    const payload = { eating: { magic: 'eating-harness-delivery', protocolVersion: 1, nonce: 'fixture-runtime-nonce', sessionId: parentId, batchId: batch.batchId, digest }, context, events }
    await f.control.start('fixture-runtime-nonce')
    const previousTask = { agentId: bound[0]!.binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[0]!.contextRef, taskId: '1'.repeat(64) }
    if (options.pending) expect((await f.post('/prepare-task', previousTask)).status).toBe(200)
    await f.control.close()
    const control = new DshAgentControl(f.directory, f.host); stops.push(() => control.close())
    const activity = new DshAutonomy(f.directory, () => true, () => {}, () => {})
    control.setAutonomy(activity, () => parentId, () => true)
    const memory = { begin: vi.fn(async () => ({ text: '', items: [] })), append: vi.fn(async () => ({ text: '', items: [] })), finish: vi.fn(async () => {}), end: vi.fn() }
    Object.assign(f.host, { memory, wake: vi.fn() })
    const capabilities = vi.spyOn(f.host, 'getCapabilityMcpConnections')
    await control.start('restored-runtime-nonce')
    mkdirSync(join(f.directory, 'bridge'), { recursive: true })
    const expectedFile = join(f.directory, 'bridge', 'expected.json')
    const expected = { schemaVersion: 1, nonce: 'restored-runtime-nonce', sessionId: parentId, batchId: batch.batchId, digest }
    writeFileSync(expectedFile, JSON.stringify(expected))
    const post = (path: string, value: object, headers: Record<string, string> = {}) => fetch(control.url + path, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'X-Eating-Runtime': 'restored-runtime-nonce', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
    const restore = (value: object = { agentId: parentId, payload }, headers: Record<string, string> = {}) => post('/restore-delivery', value, headers)
    const resign = (value: typeof payload) => {
      value.eating.digest = createHash('sha256').update(JSON.stringify({ context: value.context, events: value.events })).digest('hex')
      writeFileSync(expectedFile, JSON.stringify({ ...expected, digest: value.eating.digest }))
      return value
    }
    vi.mocked(f.host.getMcpConnection).mockClear(); vi.mocked(f.host.revokeAgentAccess).mockClear(); vi.mocked(f.host.readAgentActions).mockClear(); capabilities.mockClear()
    return { ...f, control, batch, bound, payload, expected, expectedFile, post, restore, memory, previousTask, resign, capabilities }
  }

  it('restores registered mixed batch scopes and root memory from the exact persisted envelope without replaying input', async () => {
    const f = await restorationFixture({ mixed: true })
    expect(f.control.list()[0]!.scope.messageIds).toHaveLength(256)
    const response = await f.restore()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ bindings: f.bound.map(({ contextRef, binding }) => ({ contextRef, agentId: binding.scope.agentId, agentTypeId: 'qq.private', label: agentInstanceLabel(binding.scope, 'QQ') })) })
    expect(f.host.getMcpConnection).not.toHaveBeenCalled(); expect(f.host.revokeAgentAccess).not.toHaveBeenCalled(); expect(f.capabilities).not.toHaveBeenCalled(); expect(f.host.wake).not.toHaveBeenCalled()
    const memoryInput = { agentId: parentId, turnId: `restored-runtime-nonce:${parentId}:1`, contextRef: f.batch.batchId }
    expect((await f.post('/memory-start', memoryInput)).status).toBe(200)
    expect(f.memory.begin).toHaveBeenCalledWith({ agentId: parentId, agentTypeId: 'main', turnId: memoryInput.turnId, batch: f.batch }, expect.any(AbortSignal))
    const task = { agentId: f.bound[0]!.binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.bound[0]!.contextRef, taskId: '2'.repeat(64) }
    expect((await f.post('/prepare-task', task)).status).toBe(200)
    const scope = vi.mocked(f.host.getMcpConnection).mock.calls[0]![1]
    expect(new Set(scope.messageIds)).toEqual(new Set(f.batch.events.slice(0, 301).map(event => event.messageId)))
    expect(new Set(scope.resourceIds)).toEqual(new Set(f.batch.events.slice(0, 301).flatMap(event => event.resourceIds ?? [])))
    expect(scope.messageIds).not.toContain('other-message'); expect(scope.resourceIds).not.toContain('other-resource')
  })

  it('restores event arrays above the generic JSON limit while keeping all message references', async () => {
    const f = await restorationFixture({ eventCount: 10001 })
    expect((await f.restore()).status).toBe(200)
    expect((await f.post('/prepare-task', { ...f.previousTask, taskId: '2'.repeat(64) })).status).toBe(200)
    const scope = vi.mocked(f.host.getMcpConnection).mock.calls[0]![1]
    expect(scope.messageIds).toHaveLength(10001); expect(scope.messageIds).toContain('message-0'); expect(scope.messageIds).toContain('message-10000')
    expect(scope.resourceIds).toHaveLength(10001)
  })

  it('keeps interrupted tasks unknown and makes duplicate restoration inert during a new task lease', async () => {
    const f = await restorationFixture({ eventCount: 2, pending: true, mixed: true })
    expect(f.control.list()[0]!.task).toMatchObject({ contextRef: f.previousTask.contextRef, taskId: f.previousTask.taskId, state: 'unknown', nonce: 'fixture-runtime-nonce' })
    const before = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')
    expect((await f.restore()).status).toBe(200)
    expect((await f.post('/prepare-task', { ...f.previousTask, taskId: '2'.repeat(64) })).status).toBe(409)
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).toBe(before)
    const task = { agentId: f.bound[1]!.binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.bound[1]!.contextRef, taskId: '3'.repeat(64) }
    expect((await f.post('/prepare-task', task)).status).toBe(200)
    const pending = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8'), scopes = vi.mocked(f.host.getMcpConnection).mock.calls.length
    expect((await f.restore()).status).toBe(200)
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).toBe(pending)
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(scopes); expect(f.host.revokeAgentAccess).not.toHaveBeenCalled()
    expect((await f.post('/actions', { agentId: task.agentId, contextRef: task.contextRef, taskId: task.taskId })).status).toBe(200)
  })

  it.each(['digest', 'old-root', 'old-auth', 'extra-body', 'extra-payload', 'prototype', 'source-trust', 'source-kind', 'source-role', 'source-role-array', 'event-field', 'context-field', 'context-tuple', 'missing-content', 'unregistered', 'expected-nonce', 'expected-root', 'expected-batch', 'expected-schema'] as const)('rejects %s restoration without changing persisted bindings, tasks, scopes or leases', async mode => {
    const f = await restorationFixture({ eventCount: 2, pending: true })
    const payload = structuredClone(f.payload)
    const body: Record<string, unknown> = { agentId: parentId, payload }
    let headers: Record<string, string> = {}
    if (mode === 'digest') payload.events[0]!.text = 'tampered'
    if (mode === 'old-root') payload.eating.sessionId = '00000000-0000-4000-8000-000000000099'
    if (mode === 'old-auth') headers = { 'X-Eating-Runtime': 'fixture-runtime-nonce' }
    if (mode === 'extra-body') body.batch = f.batch
    if (mode === 'extra-payload') Object.assign(payload, { extra: true })
    if (mode === 'prototype') Object.defineProperty(payload.events[0]!.content = {}, '__proto__', { value: { injected: true }, enumerable: true })
    if (mode === 'source-trust') Object.assign(payload.events[0]!.source, { trust: 'system' })
    if (mode === 'source-kind') Object.assign(payload.events[0]!.source, { kind: 'autonomous' })
    if (mode === 'source-role') Object.assign(payload.events[0]!.source, { senderRole: 'superuser' })
    if (mode === 'source-role-array') Object.assign(payload.events[0]!.source, { senderRole: ['user'] })
    if (mode === 'event-field') Object.assign(payload.events[0]!, { extra: 'unsupported' })
    if (mode === 'context-field') Object.assign(payload.context, { extra: 'unsupported' })
    if (mode === 'context-tuple') payload.context.conversations[0]!.accountId = '101'
    if (mode === 'missing-content') Reflect.deleteProperty(payload.events[0]!, 'content')
    if (mode === 'unregistered') {
      payload.context.conversations[0]!.accountId = '101'
      for (const event of payload.events) event.accountId = '101'
    }
    if (['prototype', 'source-trust', 'source-kind', 'source-role', 'source-role-array', 'event-field', 'context-field', 'context-tuple', 'missing-content', 'unregistered'].includes(mode)) f.resign(payload)
    if (mode.startsWith('expected-')) writeFileSync(f.expectedFile, JSON.stringify({ ...f.expected, ...(mode === 'expected-nonce' ? { nonce: 'fixture-runtime-nonce' } : mode === 'expected-root' ? { sessionId: '00000000-0000-4000-8000-000000000099' } : mode === 'expected-batch' ? { batchId: 'b'.repeat(64) } : { schemaVersion: 2 }) }))
    const original = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8'), bindings = structuredClone(f.control.list())
    const response = await f.restore(body, headers)
    expect(response.status).toBe(mode === 'old-auth' ? 403 : 409)
    if (mode === 'unregistered') expect(await response.json()).toMatchObject({ code: 'RESTORE_BINDING_UNAVAILABLE', outcome: 'not-sent' })
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).toBe(original); expect(f.control.list()).toEqual(bindings)
    expect(f.host.getMcpConnection).not.toHaveBeenCalled(); expect(f.host.revokeAgentAccess).not.toHaveBeenCalled(); expect(f.host.readAgentActions).not.toHaveBeenCalled(); expect(f.capabilities).not.toHaveBeenCalled(); expect(f.memory.begin).not.toHaveBeenCalled(); expect(f.host.wake).not.toHaveBeenCalled()
    expect((await f.post('/prepare-task', { ...f.previousTask, taskId: '2'.repeat(64) })).status).toBe(409)
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    expect((await f.post('/memory-start', { agentId: parentId, turnId: `restored-runtime-nonce:${parentId}:1`, contextRef: f.batch.batchId })).status).toBe(409)
    expect(f.memory.begin).not.toHaveBeenCalled()
  })

  async function autonomousFixture() {
    const f = fixture()
    const target: ProactiveTarget = { id: 'contact', label: 'Approved fixture', pluginId: 'qq', instanceId: 'instance', accountId: '100', agentTypeId: 'qq.private', targetId: '200', toolNames: ['send'] }
    f.host.prepareProactiveScope = (pluginId, request) => ({ agentId: request.agentId, agentTypeId: request.agentTypeId, pluginId, instanceId: request.instanceId, accountId: request.accountId, conversationId: `qq:${request.accountId}:private:${request.targetId}`, targetId: request.targetId, kind: 'private', messageIds: [], resourceIds: [] })
    const activity = new DshAutonomy(f.directory, () => true, () => {}, () => f.control.revokeAutonomousContacts())
    f.control.setAutonomy(activity, () => parentId, () => true)
    await activity.configure({ expectedRevision: 0, configuration: { ...AUTONOMY_DEFAULTS, enabled: true, targets: [target], maxContactsPerHour: 100 } })
    activity.startRuntime('fixture-runtime-nonce')
    await activity.control('resume', { expectedRevision: activity.snapshot().revision, expectedActivityRevision: (activity.snapshot().state as JsonObject).revision })
    const cycle = activity.claim('fixture-runtime-nonce').cycle as JsonObject
    await f.control.start('fixture-runtime-nonce')
    const begun = await f.post('/contact-turn-start', { agentId: parentId, turn: 1, autonomyCycleId: cycle.id })
    expect(begun.status).toBe(200)
    const turnRef = await begun.json() as JsonObject
    return { ...f, activity, autonomyCycle: cycle, cycle: { id: turnRef.id } }
  }

  it('exposes a contact policy summary beside activity state without a real contact directory', async () => {
    const f = await autonomousFixture()
    f.control.setAutonomy(f.activity, () => parentId, () => true, () => ({ schemaVersion: 1, revision: 4, mode: 'all', entryCount: 1 }))
    const response = await f.post('/autonomy-snapshot', { agentId: parentId })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ contactPolicy: { schemaVersion: 1, revision: 4, mode: 'all', entryCount: 1 }, state: { revision: expect.any(Number) } })
  })

  it('uses temporary read-only inbound scopes and Host-filtered tools before replying with the same UUID', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const readOwner = vi.spyOn(f.host, 'readOwnerConfiguration').mockReturnValue({ ...f.owner, agentTypes: f.owner.agentTypes.map(type => ({ ...type, enabledTools: ['send', 'read'] })) })
    vi.mocked(f.host.getMcpConnection).mockImplementation((_pluginId, scope) => ({ url: 'http://127.0.0.1:1/mcp', headers: {}, toolNames: scope.readOnly ? ['read'] : ['send', 'read'] }))
    const capabilities = vi.spyOn(f.host, 'getCapabilityMcpConnections').mockImplementation(scope => [{ id: 'plugin.fixture', serverName: 'plugin_fixture', url: 'http://127.0.0.1:1/capability', headers: {}, tools: scope.readOnly ? ['fixture_read'] : ['fixture_read', 'fixture_write'] }])
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId, taskId: '1'.repeat(64), mode: 'verify' }
    const prepared = await f.post('/prepare-task', input)
    expect(prepared.status).toBe(200)
    expect(await prepared.json()).toMatchObject({ agentId: input.agentId, mode: 'verify', tools: ['read'], capabilities: [{ tools: ['fixture_read'] }] })
    const scope = vi.mocked(f.host.getMcpConnection).mock.calls[0]![1]
    expect(scope).toEqual({ ...binding.scope, readOnly: true })
    expect(scope).not.toBe(binding.scope)
    expect(capabilities.mock.calls[0]![0]).toEqual({ agentId: input.agentId, agentTypeId: 'qq.private', source: scope, readOnly: true })
    expect(capabilities.mock.calls[0]![0].source).toBe(scope)
    expect(f.control.list()[0]!.scope).not.toHaveProperty('readOnly')
    const stored = JSON.parse(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8'))
    expect(stored.schemaVersion).toBe(2)
    expect(stored.bindings[0].scope).not.toHaveProperty('readOnly')
    expect(Object.keys(stored.bindings[0].taskRefs[0]).sort()).toEqual(['contextRef', 'nonce', 'state', 'taskId'])
    expect((await f.post('/prepare-task', { ...input, mode: 'reply', taskId: '2'.repeat(64) })).status).toBe(409)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId, status: 'completed' })).status).toBe(200)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledExactlyOnceWith(input.agentId)
    const reply = await f.post('/prepare-task', { ...input, mode: 'reply', taskId: '2'.repeat(64) })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({ agentId: input.agentId, mode: 'reply', tools: ['send', 'read'], capabilities: [{ tools: ['fixture_read', 'fixture_write'] }] })
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![1]).not.toHaveProperty('readOnly')
    expect(capabilities.mock.calls[1]![0]).not.toHaveProperty('readOnly')
    expect(capabilities.mock.calls[1]![0].source).not.toHaveProperty('readOnly')
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]!.scope).not.toHaveProperty('readOnly')
    readOwner.mockReturnValue({ ...f.owner, agentTypes: [] })
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: '2'.repeat(64), status: 'completed' })).status).toBe(200)
    const denied = await f.post('/prepare-task', { ...input, taskId: '3'.repeat(64) })
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({ code: 'AGENT_TYPE_UNAVAILABLE' })
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, null, '', 'readonly', 'VERIFY', true, ['verify']] as const)('strictly rejects unregistered mode %j before issuing inbound or contact scopes', async mode => {
    const f = await ordinaryFixture(), binding = f.control.bind(f.batch, parentId)
    const ordinaryFile = join(f.directory, 'agent-bindings.json'), before = readFileSync(ordinaryFile, 'utf8')
    const inbound = await f.post('/prepare-task', { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId, taskId: '1'.repeat(64), mode })
    const proactive = await f.post('/prepare-proactive', { agentId: parentId, targetId: f.target.id, cycleId: f.id, taskId: '1'.repeat(64), mode })
    expect(inbound.status).toBe(409); expect(await inbound.json()).toMatchObject({ code: 'AGENT_SCOPE_INVALID', outcome: 'not-sent' })
    expect(proactive.status).toBe(409); expect(await proactive.json()).toMatchObject({ code: 'CONTACT_TURN_INVALID', outcome: 'not-sent' })
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    expect(f.host.revokeAgentAccess).not.toHaveBeenCalled()
    expect(f.control.proactiveStatus()).toEqual([])
    expect(readFileSync(ordinaryFile, 'utf8')).toBe(before)
    expect(f.activity.snapshot()).toMatchObject({ state: { contactLimit: { used: 0 } } })
  })

  it('keeps verify contacts within the same turn, quota and UUID while using filtered read-only scopes', async () => {
    const f = await ordinaryFixture(), binding = f.control.bind(f.batch, parentId)
    vi.spyOn(f.host, 'readOwnerConfiguration').mockReturnValue({ ...f.owner, agentTypes: f.owner.agentTypes.map(type => ({ ...type, enabledTools: ['send', 'read'] })) })
    const target = { ...f.target, toolNames: ['send', 'read'] }
    f.activity.setTargetDirectory(async () => [target])
    const prepareScope = vi.spyOn(f.host, 'prepareProactiveScope')
    vi.mocked(f.host.getMcpConnection).mockImplementation((_pluginId, scope) => ({ url: 'http://127.0.0.1:1/mcp', headers: {}, toolNames: scope.readOnly ? ['read'] : ['send', 'read'] }))
    const capabilities = vi.spyOn(f.host, 'getCapabilityMcpConnections').mockImplementation(scope => [{ id: 'plugin.fixture', serverName: 'plugin_fixture', url: 'http://127.0.0.1:1/capability', headers: {}, tools: scope.readOnly ? ['fixture_read'] : ['fixture_read', 'fixture_write'] }])
    const prepared = await f.prepare(f.id, '1'.repeat(64), 'verify')
    expect(prepared.status).toBe(200)
    const result = await prepared.json()
    expect(result).toMatchObject({ agentId: binding.scope.agentId, mode: 'verify', tools: ['read'], capabilities: [{ tools: ['fixture_read'] }] })
    const call = vi.mocked(f.host.getMcpConnection).mock.calls[0]!
    expect(call[1]).toEqual({ ...prepareScope.mock.results[0]!.value, readOnly: true })
    expect(prepareScope.mock.results[0]!.value).not.toHaveProperty('readOnly')
    expect(call[2]).toMatchObject({ toolNames: ['send', 'read'], readOnly: true })
    expect(call[2]!.active()).toBe(true)
    expect(capabilities.mock.calls[0]![0]).toEqual({ agentId: result.agentId, agentTypeId: 'qq.private', source: call[1], readOnly: true })
    expect(capabilities.mock.calls[0]![0].source).toBe(call[1])
    expect(f.activity.snapshot()).toMatchObject({ state: { contactLimit: { used: 1 } } })
    const stored = JSON.parse(readFileSync(join(f.directory, 'proactive-bindings.json'), 'utf8'))
    expect(stored.schemaVersion).toBe(1)
    expect(JSON.stringify(stored)).not.toContain('readOnly')
    expect(Object.keys(stored.bindings[0].taskRefs[0]).sort()).toEqual(['contextRef', 'cycleId', 'nonce', 'state', 'taskId'])
    const receipt = { agentId: result.agentId, contextRef: result.contextRef, taskId: '1'.repeat(64), status: 'completed' }
    expect((await f.post('/finish-task', receipt)).status).toBe(200)
    expect(call[2]!.active()).toBe(false)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledExactlyOnceWith(result.agentId)
    const reply = await f.prepare(f.id, '2'.repeat(64), 'reply')
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({ agentId: result.agentId, mode: 'reply', tools: ['send', 'read'] })
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![1]).not.toHaveProperty('readOnly')
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![2]).not.toHaveProperty('readOnly')
    expect(capabilities.mock.calls[1]![0]).not.toHaveProperty('readOnly')
    expect(f.activity.snapshot()).toMatchObject({ state: { contactLimit: { used: 2 } } })
  })

  it('schedules and cancels one-shot AI tasks through the trusted runtime control', async () => {
    const f = await autonomousFixture()
    const dueAt = Date.now() + 60000
    const created = await f.post('/autonomy-schedule-task', { agentId: parentId, task: { expectedRevision: 0, dueAt, message: 'Review the fixture later' } })
    expect(created.status).toBe(200)
    const agenda = await created.json() as JsonObject
    const tasks = agenda.tasks as JsonObject[]
    expect(tasks).toHaveLength(1); expect(tasks[0]!.message).toBe('Review the fixture later')
    const cancelled = await f.post('/autonomy-cancel-scheduled-task', { agentId: parentId, task: { expectedRevision: agenda.revision, taskId: tasks[0]!.id } })
    expect(cancelled.status).toBe(200)
    expect((await cancelled.json() as JsonObject).tasks).toEqual([])
    expect((await f.post('/autonomy-schedule-task', { agentId: 'different-root', task: { expectedRevision: 0, dueAt, message: 'Nope' } })).status).toBe(409)
  })

  it('requires an admitted main round and exact saved contact while persisting native call replay protection', async () => {
    const f = await autonomousFixture()
    const input = { agentId: parentId, mode: 'reply', targetId: 'contact', cycleId: f.cycle.id, taskId: '1'.repeat(64) }
    for (const invalid of [{ ...input, agentId: 'different-root' }, { ...input, cycleId: 'different-cycle' }, { ...input, scope: { targetId: 'attacker' } }]) expect((await f.post('/prepare-proactive', invalid)).status).toBe(409)
    const denied = await f.post('/prepare-proactive', { ...input, targetId: 'not-approved' })
    expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: 'AUTONOMY_TARGET_DENIED', outcome: 'not-sent' })
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    const prepared = await f.post('/prepare-proactive', input); expect(prepared.status).toBe(200)
    const first = await prepared.json() as JsonObject
    expect(first).toMatchObject({ tools: ['send'], scope: { targetId: '200', accountId: '100' } })
    const call = vi.mocked(f.host.getMcpConnection).mock.calls[0]!
    expect(call[1]).toMatchObject({ targetId: '200', messageIds: [], resourceIds: [] })
    expect(call[2]!.toolNames).toEqual(['send']); expect(call[2]!.active()).toBe(true)
    const finish = (taskId: string) => f.post('/finish-task', { agentId: first.agentId, taskId, contextRef: first.contextRef, status: 'completed' })
    expect((await finish(input.taskId)).status).toBe(200)
    const nextId = '2'.repeat(64)
    const second = await f.post('/prepare-proactive', { ...input, taskId: nextId }); expect(second.status).toBe(200)
    expect((await second.json() as JsonObject).agentId).toBe(first.agentId)
    expect((await finish(nextId)).status).toBe(200)
    expect((await f.post('/prepare-proactive', input)).status).toBe(409)
    const stored = readFileSync(join(f.directory, 'proactive-bindings.json'), 'utf8')
    expect(stored).not.toContain('fixture-scoped-only-token'); expect(stored).not.toContain('EXTERNAL-MESSAGE-BODY')
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.proactiveStatus()).toMatchObject([{ agentId: first.agentId, state: 'completed' }])
  })

  it.each(['reply', 'verify'] as const)('keeps a revoked %s contact unknown and rejects its late completion before explicit owner review', async mode => {
    const f = await autonomousFixture()
    const prepared = await f.post('/prepare-proactive', { agentId: parentId, mode, targetId: 'contact', cycleId: f.cycle.id, taskId: '3'.repeat(64) })
    const task = await prepared.json() as JsonObject
    await f.activity.control('pause', { expectedRevision: f.activity.snapshot().revision, expectedActivityRevision: (f.activity.snapshot().state as JsonObject).revision })
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![2]!.active()).toBe(false)
    expect((await f.post('/finish-task', { agentId: task.agentId, contextRef: task.contextRef, taskId: '3'.repeat(64), status: 'completed' })).status).toBe(409)
    expect(f.control.proactiveStatus()).toMatchObject([{ state: 'unknown' }])
    expect(() => f.control.acknowledgeProactive(String(task.agentId), '3'.repeat(64))).toThrow()
    f.activity.finish('fixture-runtime-nonce', String(f.autonomyCycle.id), 'cancelled', null)
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.cycle.id })
    f.control.acknowledgeProactive(String(task.agentId), '3'.repeat(64))
    expect(f.control.proactiveStatus()).toMatchObject([{ state: 'reviewed' }])
  })

  async function ordinaryFixture() {
    const f = fixture()
    const target: ProactiveTarget = { id: 'contact', label: 'Approved private', pluginId: 'qq', instanceId: 'instance', accountId: '100', agentTypeId: 'qq.private', targetId: '200', toolNames: ['send'] }
    f.host.prepareProactiveScope = (pluginId, request) => ({ ...request, pluginId, kind: 'private', conversationId: 'qq:100:private:200', messageIds: [], resourceIds: [] })
    const activity = new DshAutonomy(f.directory, () => true, () => {}, () => f.control.revokeAutonomousContacts())
    activity.setTargetDirectory(async () => [target])
    let revision = 1
    f.control.setAutonomy(activity, () => parentId, () => true, () => ({ revision, mode: 'all' }))
    activity.startRuntime('fixture-runtime-nonce'); await f.control.start('fixture-runtime-nonce')
    const begin = async (turn: number) => { const response = await f.post('/contact-turn-start', { agentId: parentId, turn, autonomyCycleId: null }); expect(response.status).toBe(200); return String((await response.json()).id) }
    const id = await begin(1)
    const prepare = (cycleId = id, taskId = '1'.repeat(64), mode: 'reply' | 'verify' = 'reply') => f.post('/prepare-proactive', { agentId: parentId, mode, cycleId, targetId: target.id, taskId })
    return { ...f, activity, target, id, begin, prepare, changePolicy: () => { revision++ } }
  }

  it('shares an existing ordinary UUID with contacts and routes ordinary receipts after a completed contact', async () => {
    const f = await ordinaryFixture(), ordinary = f.control.bind(f.batch, parentId)
    const contact = await (await f.prepare()).json()
    expect(contact.agentId).toBe(ordinary.scope.agentId)
    expect((await f.post('/finish-task', { agentId: contact.agentId, contextRef: contact.contextRef, taskId: '1'.repeat(64), status: 'completed' })).status).toBe(200)
    const input = { agentId: ordinary.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '2'.repeat(64) }
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    const revocations = vi.mocked(f.host.revokeAgentAccess).mock.calls.length
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revocations)
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId })).status).toBe(200)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId, status: 'completed' })).status).toBe(200)
    expect(f.control.list()[0]!.task?.state).toBe('completed')
    expect(f.control.proactiveStatus()).toMatchObject([{ state: 'completed' }])
  })

  it('reuses a contact UUID for inbound messages even when its conversation ID has a dedicated format', async () => {
    const f = await ordinaryFixture()
    f.host.prepareProactiveScope = (pluginId, request) => ({ ...request, pluginId, kind: 'private', conversationId: 'trusted-contact:100:200', messageIds: [], resourceIds: [] })
    const contact = await (await f.prepare()).json()
    const ordinary = f.control.bind(f.batch, parentId)
    expect(ordinary.scope.agentId).toBe(contact.agentId)
    const input = { agentId: ordinary.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '2'.repeat(64) }
    expect((await f.post('/prepare-task', input)).status).toBe(409)
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(1)
    expect((await f.post('/finish-task', { agentId: contact.agentId, contextRef: contact.contextRef, taskId: '1'.repeat(64), status: 'completed' })).status).toBe(200)
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![1]).toMatchObject({ conversationId: f.batch.conversationId, messageIds: ['300'], resourceIds: ['https://fixture.invalid/file'] })
  })

  it('does not reuse a contact UUID whose recorded ordinary scope belongs to a different conversation kind', async () => {
    const f = await ordinaryFixture(), contact = await (await f.prepare()).json()
    const ordinary = f.control.bind(f.batch, parentId)
    expect(ordinary.scope.agentId).toBe(contact.agentId)
    expect((await f.post('/finish-task', { agentId: contact.agentId, contextRef: contact.contextRef, taskId: '1'.repeat(64), status: 'completed' })).status).toBe(200)
    vi.spyOn(f.host, 'readOwnerConfiguration').mockReturnValue({ ...f.owner, agentTypes: f.owner.agentTypes.map(type => ({ ...type, conversationKind: 'group' })) })
    const batch = { ...f.batch, events: f.batch.events.map(event => ({ ...event, source: { ...event.source, kind: 'group' as const } })) }
    expect(f.control.bind(batch, parentId).scope.agentId).not.toBe(contact.agentId)
    expect(f.control.list()[0]!.scope).toMatchObject({ agentId: contact.agentId, kind: 'private' })
  })

  it('blocks contacts while an ordinary task owns the shared child scope', async () => {
    const f = await ordinaryFixture(), ordinary = f.control.bind(f.batch, parentId)
    const input = { agentId: ordinary.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '2'.repeat(64) }
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    const rejected = await f.prepare()
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'AGENT_TASK_PENDING' })
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(1)
    expect(f.control.proactiveStatus()).toEqual([])
    expect(f.host.revokeAgentAccess).not.toHaveBeenCalled()
  })

  it('preserves an unknown contact while fresh inbound tasks use the shared UUID and owner review leaves their scope intact', async () => {
    const f = await ordinaryFixture(), contact = await (await f.prepare()).json()
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    const ordinary = f.control.bind(f.batch, parentId)
    expect(ordinary.scope.agentId).toBe(contact.agentId)
    const input = { agentId: ordinary.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '2'.repeat(64) }
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    const revocations = vi.mocked(f.host.revokeAgentAccess).mock.calls.length, reads = vi.mocked(f.host.readAgentActions).mock.calls.length
    for (const path of ['/actions', '/finish-task']) expect((await f.post(path, { agentId: contact.agentId, contextRef: contact.contextRef, taskId: '1'.repeat(64), ...(path === '/finish-task' ? { status: 'completed' } : {}) })).status).toBe(409)
    expect(f.host.readAgentActions).toHaveBeenCalledTimes(reads)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revocations)
    f.control.acknowledgeProactive(contact.agentId, '1'.repeat(64))
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revocations)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId, status: 'completed' })).status).toBe(200)
  })

  it.each(['completed', 'unknown'] as const)('selects the existing ordinary child without rewriting the distinct historical %s contact', async state => {
    const f = await ordinaryFixture(), ordinary = f.control.bind(f.batch, parentId)
    const oldAgentId = '00000000-0000-4000-8000-000000000099'
    const contextRef = 'f'.repeat(64), taskId = 'e'.repeat(64)
    const task = { contextRef, taskId, cycleId: 'historical-turn', nonce: 'historical-runtime', state }
    const row = { key: createHash('sha256').update(JSON.stringify([parentId, f.target.pluginId, f.target.instanceId, f.target.accountId, f.target.agentTypeId, f.target.targetId])).digest('hex'), parentId, agentId: oldAgentId, target: f.target, task, taskRefs: [task] }
    const file = join(f.directory, 'proactive-bindings.json'), original = JSON.stringify({ schemaVersion: 1, bindings: [row] })
    writeFileSync(file, original)
    await f.control.close()
    const control = new DshAgentControl(f.directory, f.host); stops.push(() => control.close())
    control.setAutonomy(f.activity, () => parentId, () => true)
    await control.start('fixture-runtime-nonce')
    const post = (path: string, body: object) => fetch(control.url + path, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'X-Eating-Runtime': 'fixture-runtime-nonce', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const cycle = await (await post('/contact-turn-start', { agentId: parentId, turn: 1, autonomyCycleId: null })).json()
    expect(readFileSync(file, 'utf8')).toBe(original)
    const response = await post('/prepare-proactive', { agentId: parentId, mode: 'reply', cycleId: cycle.id, targetId: f.target.id, taskId: '1'.repeat(64) })
    expect(response.status).toBe(state === 'unknown' ? 409 : 200)
    if (state === 'completed') {
      expect((await response.json()).agentId).toBe(ordinary.scope.agentId)
      expect(JSON.parse(readFileSync(file, 'utf8')).bindings).toMatchObject([row, { agentId: ordinary.scope.agentId, task: { state: 'pending' } }])
      const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
      expect(reopened.proactiveStatus()).toHaveLength(2)
    } else expect(readFileSync(file, 'utf8')).toBe(original)
    expect(control.list()[0]!.scope.agentId).toBe(ordinary.scope.agentId)
  })

  it('contacts an approved private target from a normal main turn while timed activity is disabled and paused', async () => {
    const f = await ordinaryFixture()
    expect(f.activity.snapshot()).toMatchObject({ configuration: { enabled: false }, state: { ownerPaused: true, active: null } })
    const prepared = await f.prepare(); expect(prepared.status).toBe(200)
    const task = await prepared.json()
    expect(task).toMatchObject({ tools: ['send'], scope: { kind: 'private', targetId: '200' } })
    const lease = vi.mocked(f.host.getMcpConnection).mock.calls[0]![2]!
    expect(lease.active()).toBe(true)
    const state = f.activity.snapshot()
    await f.activity.control('pause', { expectedRevision: state.revision, expectedActivityRevision: (state.state as JsonObject).revision })
    expect(lease.active()).toBe(true)
    f.changePolicy(); expect(lease.active()).toBe(false)
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    expect(f.control.proactiveStatus()).toMatchObject([{ state: 'unknown' }])
  })

  it('keeps same-turn begin idempotent and old begin/end calls cannot affect the newer turn', async () => {
    const f = await ordinaryFixture()
    expect(await f.begin(1)).toBe(f.id)
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    expect((await f.post('/contact-turn-start', { agentId: parentId, turn: 1, autonomyCycleId: null })).status).toBe(409)
    const next = await f.begin(2)
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    expect((await f.prepare(next)).status).toBe(200)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![2]!.active()).toBe(true)
    expect((await f.prepare(f.id, '2'.repeat(64))).status).toBe(409)
  })

  it('ends an uncertain newer start and tombstones any older turn without invalidating a later turn', async () => {
    const f = await ordinaryFixture()
    expect((await f.prepare()).status).toBe(200)
    const lease = vi.mocked(f.host.getMcpConnection).mock.calls[0]![2]!
    const end = await f.post('/contact-turn-end', { agentId: parentId, turn: 2, cycleId: null })
    expect(end.status).toBe(200); expect(lease.active()).toBe(false)
    expect((await f.post('/contact-turn-start', { agentId: parentId, turn: 2, autonomyCycleId: null })).status).toBe(409)
    expect((await f.post('/contact-turn-start', { agentId: parentId, turn: 1, autonomyCycleId: null })).status).toBe(409)
    const current = await f.begin(3)
    await f.post('/contact-turn-end', { agentId: parentId, turn: 2, cycleId: null })
    expect((await f.post('/contact-targets', { agentId: parentId, cycleId: current })).status).toBe(200)
  })

  it('rechecks the main turn after a slow contact directory and issues no lease after it ends', async () => {
    const f = await ordinaryFixture()
    let release!: (targets: readonly ProactiveTarget[]) => void
    const pending = new Promise<readonly ProactiveTarget[]>(resolve => { release = resolve })
    const entered = vi.fn(() => pending)
    f.activity.setTargetDirectory(entered)
    const preparation = f.prepare()
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    release([f.target])
    expect((await preparation).status).toBe(409)
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
  })

  it('enforces the saved hourly contact limit for ordinary main turns too', async () => {
    const f = await ordinaryFixture(), snapshot = f.activity.snapshot()
    await f.activity.configure({ expectedRevision: snapshot.revision, configuration: { ...(snapshot.configuration as JsonObject), maxContactsPerHour: 0 } })
    const response = await f.prepare()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent', details: { contactLimit: { limit: 0, used: 0, remaining: 0, exhausted: true } } })
    expect(f.control.proactiveStatus()).toEqual([])
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    expect(f.host.revokeAgentAccess).not.toHaveBeenCalled()
  })

  it.each(['reply', 'verify'] as const)('times out an unconfirmed %s task as unknown and late completion cannot revoke a reviewed replacement', async mode => {
    const f = await ordinaryFixture()
    f.control.setAutonomy(f.activity, () => parentId, () => true, () => ({ revision: 1 }), () => 1000)
    const first = await (await f.prepare(f.id, '1'.repeat(64), mode)).json()
    await vi.waitFor(() => expect(f.control.proactiveStatus()).toMatchObject([{ state: 'unknown' }]), { timeout: 2000 })
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![2]!.active()).toBe(false)
    await f.post('/contact-turn-end', { agentId: parentId, turn: 1, cycleId: f.id })
    f.control.acknowledgeProactive(first.agentId, '1'.repeat(64))
    const next = await f.begin(2)
    expect((await f.prepare(next, '2'.repeat(64))).status).toBe(200)
    expect((await f.post('/finish-task', { agentId: first.agentId, contextRef: first.contextRef, taskId: '1'.repeat(64), status: 'completed' })).status).toBe(409)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![2]!.active()).toBe(true)
  })

  it('preserves unknown contact tasks across a fresh runtime without restoring expired authority', async () => {
    const f = await ordinaryFixture()
    expect((await f.prepare()).status).toBe(200)
    await f.control.close()
    await f.control.start('fixture-runtime-nonce')
    expect(f.control.proactiveStatus()).toMatchObject([{ state: 'unknown' }])
    const next = await f.begin(2)
    expect((await f.prepare(next, '2'.repeat(64))).status).toBe(409)
  })

  it('binds every cross-session group and keeps each context active with isolated scope and receipts', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const first = f.batch.events[0]!, second = { ...first, eventId: 'second', conversationId: 'qq:100:private:201', targetId: '201', senderId: '201', messageId: '301', resourceIds: ['resource-201'] }
    const batch = { ...f.batch, conversationId: null, events: [first, second, { ...first, eventId: 'third', messageId: '302' }] }
    const bound = f.control.bindBatch(batch, parentId)
    expect(bound).toHaveLength(2)
    expect(bound.map(row => row.contextRef)).toEqual([first, second].map(event => createHash('sha256').update(JSON.stringify([batch.batchId, event.pluginId, event.instanceId, event.accountId, event.conversationId, event.source.kind, event.targetId])).digest('hex')))
    expect(bound[0]!.binding.scope).toMatchObject({ messageIds: ['300', '302'], resourceIds: ['https://fixture.invalid/file'] })
    expect(bound[1]!.binding.scope).toMatchObject({ messageIds: ['301'], resourceIds: ['resource-201'] })
    const firstInput = { agentId: bound[0]!.binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[0]!.contextRef, taskId: '1'.repeat(64) }
    const secondInput = { agentId: bound[1]!.binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[1]!.contextRef, taskId: '2'.repeat(64) }
    expect((await f.post('/prepare-task', { ...firstInput, contextRef: [firstInput.contextRef] })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...firstInput, contextRef: batch.batchId })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...firstInput, contextRef: secondInput.contextRef })).status).toBe(409)
    for (const input of [firstInput, secondInput]) {
      expect((await f.post('/prepare-task', input)).status).toBe(200)
      expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId })).status).toBe(200)
    }
    expect(vi.mocked(f.host.getMcpConnection).mock.calls.map(call => call[1].targetId)).toEqual(['200', '201'])
    f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect((await f.post('/actions', { agentId: secondInput.agentId, contextRef: secondInput.contextRef, taskId: secondInput.taskId })).status).toBe(409)
    for (const input of [secondInput, firstInput]) expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId, status: 'completed' })).status).toBe(200)
  })

  it('retains one root memory batch with all ordered events while delegation uses group context references', async () => {
    const f = fixture()
    const memory = { begin: vi.fn(async () => ({ text: '', items: [] })), append: vi.fn(async () => ({ text: '', items: [] })), finish: vi.fn(async () => {}), end: vi.fn() }
    Object.assign(f.host, { memory })
    f.control.setAutonomy(new DshAutonomy(f.directory, () => true, () => {}, () => {}), () => parentId, () => true)
    await f.control.start('fixture-runtime-nonce')
    const batch = { ...f.batch, conversationId: null, events: [f.batch.events[0]!, { ...f.batch.events[0]!, conversationId: 'other', targetId: '201', eventId: 'second' }] }
    const bound = f.control.bindBatch(batch, parentId)
    const input = { agentId: parentId, turnId: `fixture-runtime-nonce:${parentId}:1`, contextRef: batch.batchId }
    expect((await f.post('/memory-start', { ...input, contextRef: bound[0]!.contextRef })).status).toBe(409)
    expect((await f.post('/memory-start', input)).status).toBe(200)
    expect(memory.begin).toHaveBeenCalledExactlyOnceWith({ agentId: parentId, agentTypeId: 'main', turnId: input.turnId, batch }, expect.any(AbortSignal))
    expect((await f.post('/memory-end', { agentId: parentId, turnId: input.turnId })).status).toBe(200)
    expect((await f.post('/memory-start', input)).status).toBe(409)
  })

  it('retains exact per-group conversation scopes when multiple contexts share one canonical child', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const event = f.batch.events[0]!, alternate = { ...event, conversationId: 'alternate-current-conversation', messageId: '301', resourceIds: ['alternate-resource'] }
    const bound = f.control.bindBatch({ ...f.batch, conversationId: null, events: [event, alternate] }, parentId)
    expect(bound[0]!.binding.scope.agentId).toBe(bound[1]!.binding.scope.agentId)
    const input = (index: number) => ({ agentId: bound[index]!.binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[index]!.contextRef, taskId: String(index + 1).repeat(64) })
    expect((await f.post('/prepare-task', input(0))).status).toBe(200)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![1]).toMatchObject({ conversationId: event.conversationId, messageIds: ['300'], resourceIds: ['https://fixture.invalid/file'] })
    expect((await f.post('/prepare-task', input(1))).status).toBe(409)
    expect((await f.post('/finish-task', { agentId: input(0).agentId, contextRef: input(0).contextRef, taskId: input(0).taskId, status: 'completed' })).status).toBe(200)
    expect((await f.post('/prepare-task', input(1))).status).toBe(200)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![1]).toMatchObject({ conversationId: alternate.conversationId, messageIds: ['301'], resourceIds: ['alternate-resource'] })
  })

  it('never evicts another current group replay reference when canonical contexts share a child', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const event = f.batch.events[0]!, alternate = { ...event, conversationId: 'alternate-current-conversation' }
    const bound = f.control.bindBatch({ ...f.batch, conversationId: null, events: [event, alternate] }, parentId)
    const agentId = bound[0]!.binding.scope.agentId
    for (let index = 0; index < 32; index++) {
      const contextRef = bound[index % 2]!.contextRef, taskId = index.toString(16).padStart(64, '0')
      expect((await f.post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef, taskId })).status).toBe(200)
      expect((await f.post('/finish-task', { agentId, contextRef, taskId, status: 'completed' })).status).toBe(200)
    }
    const response = await f.post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[1]!.contextRef, taskId: 'f'.repeat(64) })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'AGENT_TASK_CAPACITY' })
    expect(f.control.list()[0]!.taskRefs).toHaveLength(32)
    expect(f.control.list()[0]!.taskRefs[0]!.taskId).toBe('0'.repeat(64))
  })

  it('preserves a pending scope when binding a newer inbound context', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const bound = f.control.bind(f.batch, parentId)
    const input = { agentId: bound.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    f.control.bind({ ...f.batch, batchId: 'b'.repeat(64), events: f.batch.events.map(event => ({ ...event, messageId: 'new-message', resourceIds: ['new-resource'] })) }, parentId)
    expect(f.control.list()[0]!.scope).toEqual(bound.scope)
    expect((await f.post('/prepare-task', { ...input, contextRef: 'b'.repeat(64), taskId: '2'.repeat(64) })).status).toBe(409)
  })

  it('rejects mixed single binds and inconsistent batch conversation identities without overwriting bindings', () => {
    const f = fixture(), event = f.batch.events[0]!
    const original = f.control.bind(f.batch, parentId), file = join(f.directory, 'agent-bindings.json'), bytes = readFileSync(file, 'utf8')
    for (const batch of [{ ...f.batch, events: [] }, { ...f.batch, conversationId: null }, { ...f.batch, conversationId: 'mismatch' }, { ...f.batch, events: [event, { ...event, accountId: '101' }] }]) expect(() => f.control.bind(batch, parentId)).toThrow(expect.objectContaining({ code: 'AGENT_SCOPE_INVALID' }))
    expect(() => f.control.bindBatch({ ...f.batch, conversationId: null, events: [event, { ...event, targetId: undefined }] }, parentId)).toThrow(expect.objectContaining({ code: 'AGENT_SCOPE_INVALID' }))
    expect(f.control.list()).toEqual([original])
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(conversationContextRef(f.batch.batchId, event, true)).toBe(f.batch.batchId)
  })

  it('keeps 100 existing targets routable when another target exceeds capacity without weakening strict binds', async () => {
    const f = fixture(), first = f.batch.events[0]!
    const events = Array.from({ length: 101 }, (_, index) => ({ ...first, eventId: `event-${index}`, targetId: String(200 + index), conversationId: `conversation-${index}`, messageId: `message-${index}`, resourceIds: [`resource-${index}`] }))
    f.control.bindBatch({ ...f.batch, conversationId: null, events: events.slice(0, 100) }, parentId)
    const file = join(f.directory, 'agent-bindings.json'), bytes = readFileSync(file, 'utf8')
    const batch = { ...f.batch, batchId: 'b'.repeat(64), conversationId: null, events: [events[100]!, ...events.slice(0, 100)] }
    expect(() => f.control.bindBatch(batch, parentId)).toThrow(expect.objectContaining({ code: 'AGENT_CAPACITY_REACHED' }))
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    const save = vi.spyOn(f.control as unknown as { save: (bindings: unknown[]) => void }, 'save')
    const bound = f.control.bindDeliveryBatch(batch, parentId)
    expect(save).toHaveBeenCalledOnce()
    expect(bound).toHaveLength(101); expect(bound.filter(entry => entry.binding)).toHaveLength(100)
    expect(bound[0]).toMatchObject({ binding: null, error: { code: 'AGENT_CAPACITY_REACHED' }, scope: { targetId: '300', conversationId: 'conversation-100', agentTypeId: 'qq.private' } })
    expect(f.control.list()).toHaveLength(100)
    await f.control.start('fixture-runtime-nonce')
    const valid = bound[1]!
    expect((await f.post('/prepare-task', { agentId: valid.binding!.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: valid.contextRef, taskId: '1'.repeat(64) })).status).toBe(200)
    const response = await f.post('/prepare-task', { agentId: valid.binding!.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[0]!.contextRef, taskId: '2'.repeat(64) })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ outcome: 'not-sent' })
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![1].messageIds).toEqual(['message-0'])
  })

  it.each(['capacity', 'source'] as const)('restores %s routing failures with the full memory batch and only usable existing scopes', async mode => {
    const f = fixture(), first = f.batch.events[0]!
    const events = Array.from({ length: mode === 'capacity' ? 100 : 1 }, (_, index) => ({ ...first, eventId: `event-${index}`, targetId: String(200 + index), conversationId: `conversation-${index}`, messageId: `message-${index}` }))
    f.control.bindBatch({ ...f.batch, conversationId: events.length === 1 ? events[0]!.conversationId : null, events }, parentId)
    const unavailable = { ...first, eventId: 'unavailable', targetId: '999', conversationId: 'unavailable-conversation', ...(mode === 'source' ? { pluginId: 'missing-source' } : {}) }
    const batch = { ...f.batch, conversationId: null, events: [unavailable, ...events] }
    const bound = f.control.bindDeliveryBatch(batch, parentId)
    const context = { contextRef: batch.batchId, createdAt: batch.createdAt, reason: batch.reason, ownerRevision: f.owner.revision,
      conversations: bound.map(entry => ({ contextRef: entry.contextRef, ...entry.scope, ...(entry.error ? { routingError: entry.error } : {}), createdAt: batch.createdAt, reason: batch.reason, ownerRevision: f.owner.revision })) }
    const digest = createHash('sha256').update(JSON.stringify({ context, events: batch.events })).digest('hex')
    const payload = { eating: { magic: 'eating-harness-delivery', protocolVersion: 1, nonce: 'previous-nonce', sessionId: parentId, batchId: batch.batchId, digest }, context, events: batch.events }
    await f.control.close()
    const control = new DshAgentControl(f.directory, f.host); stops.push(() => control.close())
    const memory = { begin: vi.fn(async () => ({ text: '', items: [] })), append: vi.fn(async () => ({ text: '', items: [] })), finish: vi.fn(async () => {}), end: vi.fn() }
    Object.assign(f.host, { memory })
    control.setAutonomy(new DshAutonomy(f.directory, () => true, () => {}, () => {}), () => parentId, () => true)
    await control.start('fixture-runtime-nonce')
    mkdirSync(join(f.directory, 'bridge'), { recursive: true })
    writeFileSync(join(f.directory, 'bridge', 'expected.json'), JSON.stringify({ schemaVersion: 1, nonce: 'fixture-runtime-nonce', sessionId: parentId, batchId: batch.batchId, digest }))
    const post = (path: string, value: object) => fetch(control.url + path, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'X-Eating-Runtime': 'fixture-runtime-nonce', 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    const before = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')
    const response = await post('/restore-delivery', { agentId: parentId, payload })
    expect(response.status).toBe(200)
    const restored = await response.json() as { bindings: JsonObject[] }
    expect(restored.bindings).toHaveLength(bound.length)
    expect(restored.bindings[0]).toEqual({ contextRef: bound[0]!.contextRef, routingError: bound[0]!.error })
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).toBe(before)
    expect((await post('/memory-start', { agentId: parentId, turnId: `fixture-runtime-nonce:${parentId}:1`, contextRef: batch.batchId })).status).toBe(200)
    expect(memory.begin).toHaveBeenCalledWith(expect.objectContaining({ batch }), expect.any(AbortSignal))
    const agentId = bound[1]!.binding!.scope.agentId
    expect((await post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[1]!.contextRef, taskId: '1'.repeat(64) })).status).toBe(200)
    expect((await post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: bound[0]!.contextRef, taskId: '2'.repeat(64) })).status).toBe(409)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![1].messageIds).toEqual(['message-0'])
  })

  it('returns the actual unavailable source type while keeping other groups bound', () => {
    const f = fixture(), event = f.batch.events[0]!
    const bound = f.control.bindDeliveryBatch({ ...f.batch, conversationId: null, events: [{ ...event, pluginId: 'unknown-plugin' }, event] }, parentId)
    expect(bound[0]).toMatchObject({ binding: null, error: { code: 'AGENT_TYPE_UNAVAILABLE' }, scope: { pluginId: 'unknown-plugin', agentTypeId: null, targetId: '200' } })
    expect(bound[1]!.binding?.scope.agentTypeId).toBe('qq.private')
    expect(f.control.list()).toHaveLength(1)
  })

  it('isolates canonical child identities by parent, plugin, instance, account, type, kind and target', () => {
    const f = fixture(), event = f.batch.events[0]!, first = f.control.bind(f.batch, parentId)
    const owner: HarnessOwnerConfiguration = { ...f.owner, agentTypes: [...f.owner.agentTypes, { ...f.owner.agentTypes[0]!, id: 'qq.group', conversationKind: 'group' }, { ...f.owner.agentTypes[0]!, id: 'other.private', pluginId: 'other' }] }
    const readOwner = vi.spyOn(f.host, 'readOwnerConfiguration').mockReturnValue(owner)
    const variants = [{ ...event, instanceId: 'other' }, { ...event, accountId: '101' }, { ...event, targetId: '201' }, { ...event, pluginId: 'other' }, { ...event, source: { ...event.source, kind: 'group' as const } }]
    const bound = f.control.bindBatch({ ...f.batch, conversationId: null, events: [event, ...variants] }, parentId)
    expect(new Set(bound.map(row => row.binding.scope.agentId)).size).toBe(6)
    expect(bound[0]!.binding.scope.agentId).toBe(first.scope.agentId)
    const otherParent = f.control.bind(f.batch, '00000000-0000-4000-8000-000000000002')
    expect(otherParent.scope.agentId).not.toBe(first.scope.agentId)
    readOwner.mockReturnValue({ ...owner, agentTypes: [...owner.agentTypes.map(type => type.id === 'qq.private' ? { ...type, enabled: false } : type), { ...f.owner.agentTypes[0]!, id: 'qq.private.new', enabled: true }] })
    expect(f.control.bind(f.batch, parentId).scope.agentId).not.toBe(first.scope.agentId)
  })

  it('accepts only fresh monotonic delivery state from the real root and expires readiness locally', async () => {
    const f = fixture(), clock = vi.spyOn(Date, 'now')
    stops.push(() => clock.mockRestore())
    clock.mockReturnValue(10000)
    f.host.wake = vi.fn()
    f.control.setAutonomy(new DshAutonomy(f.directory, () => true, () => {}, () => {}), () => parentId, () => false)
    await f.control.start('fixture-runtime-nonce')
    expect(f.control.deliveryReady()).toBe(false)
    const state = { agentId: parentId, sequence: 1, phase: 'idle' }
    for (const invalid of [{ ...state, agentId: 'other' }, { ...state, sequence: 0 }, { ...state, sequence: 1.5 }, { ...state, phase: 'unknown' }, { ...state, phase: ['idle'] }, { ...state, observedAt: 10000 }]) expect((await f.post('/delivery-state', invalid)).status).toBe(409)
    expect((await f.post('/delivery-state', state)).status).toBe(200)
    expect(f.control.deliveryReady()).toBe(true)
    expect(f.host.wake).toHaveBeenCalledOnce()
    expect((await f.post('/delivery-state', state)).status).toBe(409)
    clock.mockReturnValue(13000)
    expect(f.control.deliveryReady()).toBe(false)
    expect((await f.post('/delivery-state', { ...state, sequence: 2 })).status).toBe(200)
    expect(f.host.wake).toHaveBeenCalledTimes(2)
    expect((await f.post('/delivery-state', { ...state, sequence: 3, phase: 'busy' })).status).toBe(200)
    expect(f.control.deliveryReady()).toBe(false)
    expect((await f.post('/delivery-state', { ...state, sequence: 2 })).status).toBe(409)
    await f.control.close(); await f.control.start('fixture-runtime-nonce')
    expect(f.control.deliveryReady()).toBe(false)
    expect((await f.post('/delivery-state', state)).status).toBe(200)
    await f.control.close()
    expect(f.control.deliveryReady()).toBe(false)
  })

  it('labels verified account identities without changing binding keys or native UUIDs', () => {
    const f = fixture()
    const first = f.control.bind(f.batch, parentId)
    const again = f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    const switched = f.control.bind({ ...f.batch, batchId: 'c'.repeat(64), events: f.batch.events.map(event => ({ ...event, accountId: '101' })) }, parentId)
    expect(again.key).toBe(first.key)
    expect(again.scope.agentId).toBe(first.scope.agentId)
    expect(switched.key).not.toBe(first.key)
    expect(switched.scope.agentId).not.toBe(first.scope.agentId)
    expect(agentInstanceLabel(first.scope, f.owner.agentTypes[0]!.pluginName)).toBe('QQ-100-私聊-200')
    expect(agentInstanceLabel(switched.scope, f.owner.agentTypes[0]!.pluginName)).toBe('QQ-101-私聊-200')
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list().map(binding => binding.scope.accountId)).toEqual(['100', '101'])
    expect(reopened.list()[0]!.scope.agentId).toBe(first.scope.agentId)
  })

  it('uses supplied platform metadata verbatim and the canonical ID when metadata is absent', () => {
    const scope = { pluginId: 'example.chat', accountId: 'account-42', kind: 'group' as const, targetId: 'group-24' }
    expect(agentInstanceLabel(scope, 'Example Chat')).toBe('Example Chat-account-42-群聊-group-24')
    expect(agentInstanceLabel(scope)).toBe('example.chat-account-42-群聊-group-24')
    expect(agentInstanceLabel({ ...scope, pluginId: 'qq' })).toBe('qq-account-42-群聊-group-24')
  })
  it('reserves one UUID for the verified tuple and persists identifiers without message bodies or bearer tokens', () => {
    const f = fixture(), first = f.control.bind(f.batch, parentId), second = f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect(first.scope.agentId).toBe(second.scope.agentId)
    expect(first.scope).toMatchObject({ targetId: '200', messageIds: ['300'], resourceIds: ['https://fixture.invalid/file'] })
    const stored = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')
    expect(stored).not.toContain('EXTERNAL-MESSAGE-BODY')
    expect(stored).not.toContain('fixture-scoped-only-token')
    expect(new DshAgentControl(f.directory, f.host).list()[0]?.scope.agentId).toBe(first.scope.agentId)
  })

  it('requires the current verified target instead of inferring one from the sender or conversation ID', () => {
    const f = fixture()
    const missing = { ...f.batch, events: f.batch.events.map(event => ({ ...event, targetId: undefined })) }
    expect(() => f.control.bind(missing, parentId)).toThrow(expect.objectContaining({ code: 'AGENT_SCOPE_INVALID' }))
    expect(f.control.list()).toEqual([])
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
  })

  it('authorizes all current batch references while persisting only bounded conversation history', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const events = Array.from({ length: 301 }, (_, index) => ({ ...f.batch.events[0]!, eventId: `event-${index}`, messageId: `message-${index}`, resourceIds: [`resource-${index}`] }))
    const bound = f.control.bind({ ...f.batch, events }, parentId)
    expect(bound.scope.messageIds).toHaveLength(301)
    expect(f.control.list()[0]!.scope.messageIds).toHaveLength(256)
    expect(f.control.list()[0]!.scope.resourceIds).toHaveLength(256)
    const input = { agentId: bound.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    const authorized = vi.mocked(f.host.getMcpConnection).mock.calls[0]![1]
    expect(authorized.messageIds).toEqual(events.map(event => event.messageId))
    expect(authorized.resourceIds).toEqual(events.flatMap(event => event.resourceIds))
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId })).status).toBe(200)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId, status: 'completed' })).status).toBe(200)
    const persisted = JSON.parse(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).bindings[0].scope
    expect(persisted.messageIds).toEqual(events.slice(-256).map(event => event.messageId))
    expect(persisted.resourceIds).toEqual(events.slice(-256).flatMap(event => event.resourceIds))
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]!.scope.messageIds).toHaveLength(256)
    expect(reopened.list()[0]!.scope.resourceIds).toHaveLength(256)
  })

  it('restores all 256 message references and long media IDs written by the trusted binder', () => {
    const f = fixture()
    const events = Array.from({ length: 256 }, (_, index) => ({ ...f.batch.events[0]!, messageId: String(1000 + index), resourceIds: ['r'.repeat(2044) + String(index)] }))
    const binding = f.control.bind({ ...f.batch, events }, parentId)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]?.scope.messageIds).toEqual(binding.scope.messageIds)
    expect(reopened.list()[0]?.scope.messageIds).toHaveLength(256)
    expect(reopened.list()[0]?.scope.resourceIds).toEqual(binding.scope.resourceIds)
  })

  it('rejects an oversized index before changing durable or in-memory bindings', () => {
    const f = fixture()
    const events = Array.from({ length: 256 }, (_, index) => ({ ...f.batch.events[0]!, messageId: String(1000 + index), resourceIds: ['r'.repeat(2044) + String(index)] }))
    f.control.bind({ ...f.batch, events }, parentId)
    const file = join(f.directory, 'agent-bindings.json'), before = readFileSync(file, 'utf8')
    const next = { ...f.batch, conversationId: 'qq:100:private:201', events: events.map(event => ({ ...event, conversationId: 'qq:100:private:201', targetId: '201' })) }
    expect(() => f.control.bind(next, parentId)).toThrow(expect.objectContaining({ code: 'AGENT_BINDINGS_CAPACITY' }))
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(f.control.list()).toHaveLength(1)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()).toHaveLength(1)
  })

  it('rejects forged scope, old context, untrusted headers and repeated pending tasks before asking Host for MCP access', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId), input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    expect((await f.post('/prepare-task', input, { Authorization: 'Bearer forged-token' })).status).toBe(403)
    expect((await f.post('/prepare-task', { ...input, targetId: 'attacker' })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, contextRef: 'c'.repeat(64) })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, agentTypeId: 'qq.group' })).status).toBe(409)
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    const accepted = await f.post('/prepare-task', input)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ systemPrompt: 'COMMON\n\nSUBAGENT\n\nPRIVATE 200\n\n', revision: 3, tools: ['send'] })
    expect(f.host.getMcpConnection).toHaveBeenCalledWith('qq', binding.scope)
    expect((await f.post('/prepare-task', input)).status).toBe(409)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]?.task?.state).toBe('pending')
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId })).status).toBe(200)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId: input.taskId, status: 'completed' })).status).toBe(200)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledWith(input.agentId)
    expect((await f.post('/prepare-task', input)).status).toBe(409)
    const next = f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect(next.scope.agentId).toBe(input.agentId)
    expect((await f.post('/prepare-task', { ...input, contextRef: 'b'.repeat(64) })).status).toBe(200)
  })

  it.each(['MCP_SERVICE_NOT_READY', 'MCP_GRANTED_TOOL_MISSING'])('keeps a %s capability preparation failure retryable without persisting pending tasks or retaining issued QQ access', async code => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: binding.scope.agentTypeId, mode: 'reply', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    const capabilities = vi.spyOn(f.host, 'getCapabilityMcpConnections')
      .mockImplementationOnce(() => { throw new PlatformError(code, 'Fixture capability preparation was rejected before task acceptance.', 409, 'not-sent') })
      .mockReturnValue([{ id: 'plugin.fixture', serverName: 'plugin_fixture', url: 'http://127.0.0.1:1/mcp-services/plugin.fixture', headers: { Authorization: 'Bearer fixture-capability-only-token' }, tools: ['fixture_read'] }])
    const file = join(f.directory, 'agent-bindings.json'), before = readFileSync(file, 'utf8')
    const rejected = await f.post('/prepare-task', input)
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code })
    expect(f.host.getMcpConnection).toHaveBeenCalledWith('qq', binding.scope)
    expect(capabilities).toHaveBeenCalledWith({ agentId: binding.scope.agentId, agentTypeId: binding.scope.agentTypeId, source: binding.scope })
    expect(f.host.revokeAgentAccess).toHaveBeenCalledExactlyOnceWith(binding.scope.agentId)
    expect(f.host.readAgentActions).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(f.control.list()[0]?.task).toBeUndefined()
    expect(f.control.list()[0]?.taskRefs).toEqual([])
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]?.task).toBeUndefined()
    expect(reopened.list()[0]?.taskRefs).toEqual([])
    const accepted = await f.post('/prepare-task', input)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ agentId: binding.scope.agentId, capabilities: [{ id: 'plugin.fixture', tools: ['fixture_read'] }] })
    expect(f.control.list()[0]?.task).toMatchObject({ state: 'pending', taskId: input.taskId })
    expect(f.control.list()[0]?.taskRefs).toHaveLength(1)
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(2)
    expect(f.host.readAgentActions).toHaveBeenCalledTimes(1)
  })

  it('allows distinct completed or failed native calls in one context and refuses replayed or stale call identities', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    const first = '1'.repeat(64), second = '2'.repeat(64), third = '3'.repeat(64)
    const finish = (taskId: string, status: string) => f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId, status })
    expect((await f.post('/prepare-task', { ...input, taskId: first })).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: second })).status).toBe(409)
    expect((await finish(first, 'completed')).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: first })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, taskId: second })).status).toBe(200)
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef, taskId: first })).status).toBe(409)
    const revocations = vi.mocked(f.host.revokeAgentAccess).mock.calls.length
    expect((await finish(first, 'unknown')).status).toBe(409)
    expect(vi.mocked(f.host.revokeAgentAccess).mock.calls).toHaveLength(revocations)
    expect((await finish(second, 'failed')).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: first })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, taskId: third })).status).toBe(200)
    expect((await finish(third, 'unknown')).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: '4'.repeat(64) })).status).toBe(409)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]?.taskRefs.map(task => [task.taskId, task.state])).toEqual([[first, 'completed'], [second, 'failed'], [third, 'unknown']])
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).not.toContain('EXTERNAL-MESSAGE-BODY')
  })

  it.each(['reply', 'verify'] as const)('keeps a timed-out %s call unknown while a fresh batch reuses the child with independent permissions', async mode => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const old = { agentId: binding.scope.agentId, contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    const prepare = (contextRef: string, taskId: string) => f.post('/prepare-task', { agentId: old.agentId, agentTypeId: 'qq.private', mode, contextRef, taskId })
    expect((await prepare(old.contextRef, old.taskId)).status).toBe(200)
    // The runtime reports unknown after its deadline interrupts and drains the child.
    expect((await f.post('/finish-task', { ...old, status: 'unknown' })).status).toBe(200)
    const retry = await prepare(old.contextRef, '2'.repeat(64))
    expect(retry.status).toBe(409); expect(await retry.json()).toMatchObject({ code: 'AGENT_TASK_UNKNOWN', outcome: 'not-sent' })
    const revoked = vi.mocked(f.host.revokeAgentAccess).mock.calls.length
    expect((await f.post('/finish-task', { ...old, status: 'completed' })).status).toBe(409)
    expect((await f.post('/actions', old)).status).toBe(409)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revoked)

    const batch = { ...f.batch, batchId: 'b'.repeat(64), events: f.batch.events.map(event => ({ ...event, eventId: 'fresh-event', messageId: '301', resourceIds: ['fresh-resource'] })) }
    const next = f.control.bind(batch, parentId)
    expect(next.scope.agentId).toBe(old.agentId)
    expect(next.taskRefs).toMatchObject([{ contextRef: old.contextRef, taskId: old.taskId, state: 'unknown' }])
    const reusedCall = await prepare(batch.batchId, old.taskId)
    expect(reusedCall.status).toBe(409); expect(await reusedCall.json()).toMatchObject({ code: 'AGENT_TASK_UNKNOWN' })
    expect((await prepare(old.contextRef, '3'.repeat(64))).status).toBe(409)
    const fresh = { agentId: old.agentId, contextRef: batch.batchId, taskId: '2'.repeat(64) }
    expect((await prepare(fresh.contextRef, fresh.taskId)).status).toBe(200)
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[0]![1]).toMatchObject({ messageIds: ['300'], resourceIds: ['https://fixture.invalid/file'] })
    expect(vi.mocked(f.host.getMcpConnection).mock.calls[1]![1]).toMatchObject({ messageIds: ['300', '301'], resourceIds: ['https://fixture.invalid/file', 'fresh-resource'] })
    const actionsRead = vi.mocked(f.host.readAgentActions).mock.calls.length
    for (const request of [old, { ...old, contextRef: fresh.contextRef }]) {
      expect((await f.post('/actions', request)).status).toBe(409)
      expect((await f.post('/finish-task', { ...request, status: 'completed' })).status).toBe(409)
    }
    expect(f.host.readAgentActions).toHaveBeenCalledTimes(actionsRead)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revoked)
    expect(f.control.list()[0]!.task).toMatchObject({ contextRef: fresh.contextRef, taskId: fresh.taskId, state: 'pending' })
    expect((await f.post('/actions', fresh)).status).toBe(200)
    expect((await f.post('/finish-task', { ...fresh, status: 'completed' })).status).toBe(200)
    expect(f.control.list()[0]!.taskRefs.map(task => [task.contextRef, task.taskId, task.state])).toEqual([[old.contextRef, old.taskId, 'unknown'], [fresh.contextRef, fresh.taskId, 'completed']])
    f.control.bind(f.batch, parentId)
    expect((await prepare(old.contextRef, '3'.repeat(64))).status).toBe(409)
    expect((await prepare(old.contextRef, old.taskId)).status).toBe(409)
  })

  it.each(['completed', 'failed', 'unknown'])('blocks fresh batches while pending until the exact old task reports %s', async status => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const old = { agentId: binding.scope.agentId, contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    const prepare = (contextRef: string, taskId: string) => f.post('/prepare-task', { agentId: old.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef, taskId })
    expect((await prepare(old.contextRef, old.taskId)).status).toBe(200)
    const next = f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect(next.scope.agentId).toBe(old.agentId)
    for (const taskId of [old.taskId, '2'.repeat(64)]) {
      const blocked = await prepare('b'.repeat(64), taskId)
      expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ code: 'AGENT_TASK_PENDING', outcome: 'not-sent' })
    }
    expect((await f.post('/actions', old)).status).toBe(409)
    expect((await f.post('/finish-task', { ...old, taskId: '3'.repeat(64), status })).status).toBe(409)
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(1)
    expect(f.host.revokeAgentAccess).not.toHaveBeenCalled()
    expect((await f.post('/finish-task', { ...old, status })).status).toBe(200)
    expect((await prepare('b'.repeat(64), '2'.repeat(64))).status).toBe(200)
    const revocations = vi.mocked(f.host.revokeAgentAccess).mock.calls.length
    expect((await f.post('/finish-task', { ...old, status: 'unknown' })).status).toBe(409)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revocations)
    expect((await f.post('/finish-task', { agentId: old.agentId, contextRef: 'b'.repeat(64), taskId: '2'.repeat(64), status: 'completed' })).status).toBe(200)
  })

  it.each(['unknown', 'pending'])('preserves persisted %s identities across a new runtime while allowing a fresh batch', async state => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const old = { agentId: binding.scope.agentId, contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    expect((await f.post('/prepare-task', { ...old, mode: 'reply', agentTypeId: 'qq.private' })).status).toBe(200)
    if (state === 'unknown') expect((await f.post('/finish-task', { ...old, status: 'unknown' })).status).toBe(200)
    await f.control.close()
    const restarted = new DshAgentControl(f.directory, f.host); stops.push(() => restarted.close())
    expect(restarted.list()[0]!.task!.state).toBe(state)
    await restarted.start('restarted-runtime-nonce')
    const post = (path: string, body: object, nonce = 'restarted-runtime-nonce') => fetch(restarted.url + path, { method: 'POST', headers: { Authorization: `Bearer ${restarted.token}`, 'X-Eating-Runtime': nonce, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(restarted.list()[0]!.task).toMatchObject({ contextRef: old.contextRef, taskId: old.taskId, state: 'unknown', nonce: 'fixture-runtime-nonce' })
    expect(restarted.list()[0]!.taskRefs).toMatchObject([{ contextRef: old.contextRef, taskId: old.taskId, state: 'unknown' }])
    restarted.bind(f.batch, parentId)
    expect((await post('/prepare-task', { ...old, mode: 'reply', agentTypeId: 'qq.private', taskId: '2'.repeat(64) })).status).toBe(409)
    expect((await post('/finish-task', { ...old, status: 'completed' })).status).toBe(409)
    expect((await post('/finish-task', { ...old, status: 'completed' }, 'fixture-runtime-nonce')).status).toBe(403)
    const next = restarted.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect(next.scope.agentId).toBe(old.agentId)
    expect((await post('/prepare-task', { ...old, contextRef: 'b'.repeat(64), mode: 'reply', agentTypeId: 'qq.private' })).status).toBe(409)
    const fresh = { agentId: old.agentId, contextRef: 'b'.repeat(64), taskId: '2'.repeat(64) }
    expect((await post('/prepare-task', { ...fresh, mode: 'reply', agentTypeId: 'qq.private' })).status).toBe(200)
    const revocations = vi.mocked(f.host.revokeAgentAccess).mock.calls.length
    expect((await post('/actions', old)).status).toBe(409)
    expect((await post('/finish-task', { ...old, status: 'completed' })).status).toBe(409)
    expect((await post('/finish-task', { ...fresh, status: 'completed' }, 'fixture-runtime-nonce')).status).toBe(403)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledTimes(revocations)
    expect(restarted.list()[0]!.task).toMatchObject({ taskId: fresh.taskId, state: 'pending' })
    expect((await post('/finish-task', { ...fresh, status: 'completed' })).status).toBe(200)
    expect(restarted.list()[0]!.taskRefs[0]).toMatchObject({ taskId: old.taskId, state: 'unknown', nonce: 'fixture-runtime-nonce' })
  })

  it('retains old unknown references when rolling completed batches and refuses to evict unresolved tasks at capacity', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId), agentId = binding.scope.agentId
    for (let index = 0; index < 35; index++) {
      const contextRef = index.toString(16).padStart(64, '0'), taskId = (index + 100).toString(16).padStart(64, '0')
      f.control.bind({ ...f.batch, batchId: contextRef }, parentId)
      expect((await f.post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef, taskId })).status).toBe(200)
      expect((await f.post('/finish-task', { agentId, contextRef, taskId, status: index === 0 ? 'unknown' : 'completed' })).status).toBe(200)
    }
    expect(f.control.list()[0]!.taskRefs).toHaveLength(32)
    expect(f.control.list()[0]!.taskRefs[0]).toMatchObject({ contextRef: '0'.repeat(64), taskId: (100).toString(16).padStart(64, '0'), state: 'unknown' })
    f.control.bind({ ...f.batch, batchId: '0'.repeat(64) }, parentId)
    expect((await f.post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: '0'.repeat(64), taskId: 'f'.repeat(64) })).status).toBe(409)
    for (let index = 1; index < 32; index++) {
      const contextRef = (index + 1000).toString(16).padStart(64, '0'), taskId = (index + 2000).toString(16).padStart(64, '0')
      f.control.bind({ ...f.batch, batchId: contextRef }, parentId)
      expect((await f.post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef, taskId })).status).toBe(200)
      expect((await f.post('/finish-task', { agentId, contextRef, taskId, status: 'unknown' })).status).toBe(200)
    }
    expect(f.control.list()[0]!.taskRefs).toHaveLength(32)
    expect(f.control.list()[0]!.taskRefs.every(task => task.state === 'unknown')).toBe(true)
    const bytes = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')
    const blockedBatch = 'e'.repeat(64)
    f.control.bind({ ...f.batch, batchId: blockedBatch }, parentId)
    const requests = vi.mocked(f.host.getMcpConnection).mock.calls.length
    const blocked = await f.post('/prepare-task', { agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: blockedBatch, taskId: 'f'.repeat(64) })
    expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ code: 'AGENT_TASK_CAPACITY', outcome: 'not-sent' })
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(requests)
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).toBe(bytes)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]!.taskRefs).toEqual(f.control.list()[0]!.taskRefs)
  }, 15000)

  it('keeps at most 32 call references and refuses a 33rd call in the active context instead of forgetting replay protection', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
    for (let index = 0; index < 32; index++) {
      const taskId = index.toString(16).padStart(64, '0')
      expect((await f.post('/prepare-task', { ...input, taskId })).status).toBe(200)
      expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId, status: 'completed' })).status).toBe(200)
    }
    expect(f.control.list()[0]?.taskRefs).toHaveLength(32)
    expect((await f.post('/prepare-task', { ...input, taskId: 'f'.repeat(64) })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, taskId: '0'.repeat(64) })).status).toBe(409)
    f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect((await f.post('/prepare-task', { ...input, contextRef: 'b'.repeat(64), taskId: 'f'.repeat(64) })).status).toBe(200)
    expect(f.control.list()[0]?.taskRefs).toHaveLength(32)
  })

  it('rejects requests without native task IDs for prepare, actions and finish', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', mode: 'reply', contextRef: f.batch.batchId }
    expect((await f.post('/prepare-task', input)).status).toBe(409)
    expect(f.host.getMcpConnection).not.toHaveBeenCalled()
    const taskId = '1'.repeat(64)
    expect((await f.post('/prepare-task', { ...input, taskId })).status).toBe(200)
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef })).status).toBe(409)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, status: 'completed' })).status).toBe(409)
    expect(f.host.revokeAgentAccess).not.toHaveBeenCalled()
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId, status: 'completed' })).status).toBe(200)
  })

  it.each(['schema-1', 'missing-task-refs', 'missing-task-id', 'reference-without-task-id'] as const)('rejects %s persisted bindings without rewriting their bytes', mode => {
    const f = fixture(), binding = f.control.bind(f.batch, parentId)
    const task = { contextRef: f.batch.batchId, nonce: 'fixture-runtime-nonce', state: 'completed' }
    const stored = mode === 'missing-task-refs' ? { ...binding, taskRefs: undefined }
      : mode === 'missing-task-id' ? { ...binding, task }
      : mode === 'reference-without-task-id' ? { ...binding, taskRefs: [task] } : binding
    const file = join(f.directory, 'agent-bindings.json')
    const bytes = JSON.stringify({ schemaVersion: mode === 'schema-1' ? 1 : 2, bindings: [stored] })
    writeFileSync(file, bytes)
    expect(() => new DshAgentControl(f.directory, f.host)).toThrow(expect.objectContaining({ code: 'AGENT_BINDINGS_INVALID' }))
    expect(readFileSync(file, 'utf8')).toBe(bytes)
  })

  it.each(['getMcpConnection', 'readAgentActions', 'revokeAgentAccess'] as const)('rejects a Host missing required %s instead of treating it as an empty service', name => {
    const f = fixture()
    const incomplete: unknown = { ...f.host, [name]: undefined }
    expect(() => new DshAgentControl(f.directory, incomplete as HarnessHostServices)).toThrow(expect.objectContaining({ code: 'HARNESS_SERVICES_INVALID' }))
  })
})
