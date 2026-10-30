import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { HarnessDeliveryBatch, HarnessHostServices, HarnessOwnerConfiguration } from '@eating/plugin-sdk'
import { DshAgentControl } from './agent-control'
import { agentInstanceLabel } from './agent-label'

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
    getCapabilityMcpConnections: () => [], getMcpConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer fixture-scoped-only-token' } })),
    readAgentActions: vi.fn(() => [{ requestId: 'request-1', tool: 'send', outcome: 'succeeded' as const }]), revokeAgentAccess: vi.fn() }
  const control = new DshAgentControl(directory, host); stops.push(() => control.close())
  const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId: 'qq:100:private:200', createdAt: '2026-10-28T00:00:00Z', reason: 'quiet-window', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', instanceId: 'instance', platform: 'qq', accountId: '100', conversationId: 'qq:100:private:200', senderId: '200', targetId: '200', messageId: '300', resourceIds: ['https://fixture.invalid/file'], receivedAt: '2026-10-28T00:00:00Z', source: { trust: 'external', kind: 'private', senderRole: 'user' }, content: 'EXTERNAL-MESSAGE-BODY', text: 'EXTERNAL-MESSAGE-BODY' }] }
  const post = async (path: string, value: object, headers: Record<string, string> = {}) => fetch(control.url + path, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'X-Eating-Runtime': 'fixture-runtime-nonce', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
  return { directory, control, host, owner, batch, post }
}

describe('trusted native Agent control boundary', () => {
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
    const binding = f.control.bind(f.batch, parentId), input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
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
    const input = { agentId: binding.scope.agentId, agentTypeId: binding.scope.agentTypeId, contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
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
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
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

  it('keeps at most 32 call references and refuses a 33rd call in the active context instead of forgetting replay protection', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId, taskId: '1'.repeat(64) }
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
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId }
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
