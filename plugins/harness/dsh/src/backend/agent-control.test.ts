import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDeliveryBatch, HarnessHostServices, HarnessOwnerConfiguration } from '@eating/plugin-sdk'
import { DshAgentControl } from './agent-control'

const stops: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
const parentId = '00000000-0000-4000-8000-000000000001'
function fixture() {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(parent, 'eating-agent-control-')))
  stops.push(() => { if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-agent-control-')) throw new Error('Unsafe fixture cleanup'); rmSync(directory, { recursive: true }) })
  const owner: HarnessOwnerConfiguration = { revision: 3, activePersona: null, prompts: [
    { id: 'common', title: 'common', body: 'COMMON', revision: 1, updatedAt: null }, { id: 'subagent', title: 'subagent', body: 'SUBAGENT', revision: 1, updatedAt: null },
    { id: 'main', title: 'main', body: 'MAIN', revision: 1, updatedAt: null }, { id: 'agent:qq.private', title: 'private', body: 'PRIVATE {{目标编号}}', revision: 1, updatedAt: null, pluginId: 'qq' },
  ], agentTypes: [{ id: 'qq.private', title: 'Private', description: 'Private target', conversationKind: 'private', defaultPrompt: 'PRIVATE', availableTools: ['send'], defaultTools: ['send'], enabledTools: ['send'], pluginId: 'qq', pluginName: 'QQ', enabled: true, identity: { owners: [], administrators: [] } }] }
  const host: HarnessHostServices = { registerSink: () => () => {}, wake: () => {}, readOwnerConfiguration: () => owner,
    getMcpConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer fixture-scoped-only-token' } })),
    readAgentActions: vi.fn(() => [{ requestId: 'request-1', tool: 'send', outcome: 'succeeded' as const }]), revokeAgentAccess: vi.fn() }
  const control = new DshAgentControl(directory, host); stops.push(() => control.close())
  const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId: 'qq:100:private:200', createdAt: '2026-10-28T00:00:00Z', reason: 'quiet-window', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', instanceId: 'instance', platform: 'qq', accountId: '100', conversationId: 'qq:100:private:200', senderId: '200', targetId: '200', messageId: '300', resourceIds: ['https://fixture.invalid/file'], receivedAt: '2026-10-28T00:00:00Z', source: { trust: 'external', kind: 'private' }, content: 'EXTERNAL-MESSAGE-BODY', text: 'EXTERNAL-MESSAGE-BODY' }] }
  const post = async (path: string, value: object, headers: Record<string, string> = {}) => fetch(control.url + path, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'X-Eating-Runtime': 'fixture-runtime-nonce', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
  return { directory, control, host, owner, batch, post }
}

describe('trusted native Agent control boundary', () => {
  it('reserves one UUID for the verified tuple and persists identifiers without message bodies or bearer tokens', () => {
    const f = fixture(), first = f.control.bind(f.batch, parentId), second = f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect(first.scope.agentId).toBe(second.scope.agentId)
    expect(first.scope).toMatchObject({ targetId: '200', messageIds: ['300'], resourceIds: ['https://fixture.invalid/file'] })
    const stored = readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')
    expect(stored).not.toContain('EXTERNAL-MESSAGE-BODY')
    expect(stored).not.toContain('fixture-scoped-only-token')
    expect(new DshAgentControl(f.directory, f.host).list()[0]?.scope.agentId).toBe(first.scope.agentId)
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
    const binding = f.control.bind(f.batch, parentId), input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId }
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
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef })).status).toBe(200)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, status: 'completed' })).status).toBe(200)
    expect(f.host.revokeAgentAccess).toHaveBeenCalledWith(input.agentId)
    expect((await f.post('/prepare-task', input)).status).toBe(409)
    const next = f.control.bind({ ...f.batch, batchId: 'b'.repeat(64) }, parentId)
    expect(next.scope.agentId).toBe(input.agentId)
    expect((await f.post('/prepare-task', { ...input, contextRef: 'b'.repeat(64) })).status).toBe(200)
  })

  it('allows distinct completed or failed native calls in one context and refuses replayed or stale call identities', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId }
    const first = '1'.repeat(64), second = '2'.repeat(64), third = '3'.repeat(64)
    const finish = (taskId: string, status: string) => f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, taskId, status })
    expect((await f.post('/prepare-task', { ...input, taskId: first })).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: second })).status).toBe(409)
    expect((await finish(first, 'completed')).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: first })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, taskId: second })).status).toBe(200)
    expect((await f.post('/actions', { agentId: input.agentId, contextRef: input.contextRef, taskId: first })).status).toBe(409)
    const revocations = vi.mocked(f.host.revokeAgentAccess!).mock.calls.length
    expect((await finish(first, 'unknown')).status).toBe(409)
    expect(vi.mocked(f.host.revokeAgentAccess!).mock.calls).toHaveLength(revocations)
    expect((await finish(second, 'failed')).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: first })).status).toBe(409)
    expect((await f.post('/prepare-task', { ...input, taskId: third })).status).toBe(200)
    expect((await finish(third, 'unknown')).status).toBe(200)
    expect((await f.post('/prepare-task', { ...input, taskId: '4'.repeat(64) })).status).toBe(409)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    expect(reopened.list()[0]?.taskRefs?.map(task => [task.taskId, task.state])).toEqual([[first, 'completed'], [second, 'failed'], [third, 'unknown']])
    expect(readFileSync(join(f.directory, 'agent-bindings.json'), 'utf8')).not.toContain('EXTERNAL-MESSAGE-BODY')
  })

  it('keeps at most 32 call references and refuses a 33rd call in the active context instead of forgetting replay protection', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId }
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

  it('retains whole-context replay prevention for legacy requests and persisted tasks without native call IDs', async () => {
    const f = fixture(); await f.control.start('fixture-runtime-nonce')
    const binding = f.control.bind(f.batch, parentId)
    const input = { agentId: binding.scope.agentId, agentTypeId: 'qq.private', contextRef: f.batch.batchId }
    expect((await f.post('/prepare-task', input)).status).toBe(200)
    expect((await f.post('/finish-task', { agentId: input.agentId, contextRef: input.contextRef, status: 'completed' })).status).toBe(200)
    const reopened = new DshAgentControl(f.directory, f.host); stops.push(() => reopened.close())
    await reopened.start('fixture-runtime-nonce'); reopened.bind(f.batch, parentId)
    const response = await fetch(reopened.url + '/prepare-task', { method: 'POST', headers: { Authorization: `Bearer ${reopened.token}`, 'X-Eating-Runtime': 'fixture-runtime-nonce', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, taskId: '1'.repeat(64) }) })
    expect(response.status).toBe(409)
    expect(f.host.getMcpConnection).toHaveBeenCalledTimes(1)
  })
})
