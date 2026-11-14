import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessHostServices, HarnessOwnerConfiguration, JsonObject } from '@eating/plugin-sdk'
import { ExecutionControl } from './execution-control'
const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop() })
const root = '00000000-0000-4000-8000-000000000001'
function fixture() {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(parent, 'eating-execution-control-')))
  stops.push(() => { if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-execution-control-')) throw Error('Unsafe execution control cleanup'); rmSync(directory, { recursive: true }) })
  const owner: HarnessOwnerConfiguration = { revision: 0, activePersona: null, bindings: {}, pluginInstructions: [{ id: 'android-control.instructions', title: 'Android', pluginId: 'android-control', pluginName: 'Android', body: 'EDITABLE-PLUGIN-GUIDE', enabled: true }], agentTypes: [{ id: 'android-control.phone', title: 'Phone', pluginId: 'android-control', pluginName: 'Android', enabled: true, identity: { owners: [], administrators: [] }, description: 'Phone role', conversationKind: null, defaultPrompt: 'PHONE', availableTools: [], defaultTools: [], enabledTools: [] }], prompts: [
    ...(['common', 'subagent', 'main'] as const).map(id => ({ id, scope: id, source: 'owner' as const, title: id, body: id, revision: 0, updatedAt: null })),
    { id: 'agent:android-control.phone', agentTypeId: 'android-control.phone', scope: 'agent', source: 'plugin', pluginId: 'android-control', title: 'Phone', body: 'PHONE-ROLE', revision: 0, updatedAt: null },
    { id: 'plugin:android-control.instructions', scope: 'plugin', source: 'plugin', pluginId: 'android-control', title: 'Guide', body: 'EDITABLE-PLUGIN-GUIDE', revision: 0, updatedAt: null },
  ] }
  const revoke = vi.fn(), finish = vi.fn(() => ({ available: true, closed: true, actions: [] })), connections = vi.fn(() => [{ id: 'plugin.android-control', serverName: 'plugin_android_control', url: 'http://127.0.0.1:1/mcp', headers: {}, tools: ['android_adb_exec'] }])
  const host = { readOwnerConfiguration: () => owner, getCapabilityMcpConnections: connections, readTaskActions: () => ({ available: true, closed: false, actions: [] }), finishTaskActions: finish, revokeAgentAccess: revoke } as unknown as HarnessHostServices
  return { directory, host, owner, connections, revoke, control: new ExecutionControl(directory, host) }
}
describe('independent capability execution identities', () => {
  it('uses the editable plugin guide and continuous receipts without inventing communication scope', () => {
    const f = fixture(), taskId = 'a'.repeat(64), prepared = f.control.prepare({ agentId: root, agentTypeId: 'android-control.phone', taskId }, root, 'nonce-one')
    expect(prepared.systemPrompt).toContain('EDITABLE-PLUGIN-GUIDE')
    expect(f.connections).toHaveBeenCalledWith({ agentId: prepared.agentId, agentTypeId: 'android-control.phone' }, taskId, { continuous: true })
    expect(prepared).not.toHaveProperty('mcp'); expect(f.control.pending()).toBe(true)
    expect(() => f.control.prepare({ agentId: root, agentTypeId: 'android-control.phone', taskId: 'b'.repeat(64) }, root, 'nonce-one')).toThrow('已有任务运行')
    f.control.handle('finish-task', { agentId: prepared.agentId!, taskId, contextRef: taskId, status: 'completed' }, 'nonce-one')
    expect(f.control.pending()).toBe(false)
    const restored = new ExecutionControl(f.directory, f.host), secondId = 'b'.repeat(64), second = restored.prepare({ agentId: root, agentTypeId: 'android-control.phone', taskId: secondId }, root, 'nonce-two')
    expect(second.agentId).toBe(prepared.agentId)
    expect(() => restored.handle('finish-task', { agentId: prepared.agentId!, taskId, contextRef: taskId, status: 'completed' }, 'nonce-one')).toThrow('任务引用或配置无效')
    expect(restored.pending()).toBe(true); restored.close()
  })
  it('rejects another parent, missing capability and model-provided scope fields', () => {
    const f = fixture(), input: JsonObject = { agentId: root, agentTypeId: 'android-control.phone', taskId: 'a'.repeat(64) }
    expect(() => f.control.prepare({ ...input, agentId: 'other' }, root, 'nonce')).toThrow()
    expect(() => f.control.prepare({ ...input, scope: {} }, root, 'nonce')).toThrow()
    f.connections.mockReturnValue([])
    expect(() => f.control.prepare(input, root, 'nonce')).toThrow('尚未连接')
    expect(f.revoke).toHaveBeenCalledOnce(); expect(f.control.pending()).toBe(false)
  })
})
