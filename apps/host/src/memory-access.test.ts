import { describe, expect, it, vi } from 'vitest'
import type { BackendPlugin, HarnessDeliveryBatch, MemoryProvider } from '@eating/plugin-sdk'
import { MemoryAccess } from './memory-access'

function fixture() {
  const enabled = new Set(['harness', 'qq', 'memory'])
  const provider: MemoryProvider = { recall: vi.fn(async () => ({ text: 'Historical context only', items: [{ uri: 'viking://~/memories/example.md', text: 'Preference', score: 0.8 }] })), capture: vi.fn(async () => {}) }
  const qq = { id: 'qq', kind: 'communication', getAgentIdentity: () => ({ owners: ['200'], administrators: [] }) } as unknown as BackendPlugin
  const plugin = { id: 'memory', kind: 'capability', memory: provider, getStatus: () => ({ state: 'connected' }) } as unknown as BackendPlugin
  const access = new MemoryAccess({ plugins: () => [qq, plugin], enabled: id => enabled.has(id) })
  const memory = access.services('harness')
  const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId: 'qq:100:private:200', reason: 'quiet-window', createdAt: '2026-11-01T00:00:00Z', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', platform: 'qq', instanceId: 'instance', accountId: '100', conversationId: 'qq:100:private:200', senderId: '200', targetId: '200', receivedAt: '2026-11-01T00:00:00Z', source: { trust: 'external', kind: 'private', senderRole: 'owner' }, content: 'User statement', text: 'User statement' }] }
  const begin = (turnId = 'turn1', value = batch) => memory.begin({ agentId: 'root', agentTypeId: 'main', turnId, batch: value })
  const finish = (turnId = 'turn1') => memory.finish({ agentId: 'root', turnId, assistantText: 'Visible reply', actions: [{ tool: 'send', outcome: 'returned' }], outcome: 'completed' })
  return { access, memory, provider, enabled, batch, begin, finish }
}

describe('trusted current-turn memory coordination', () => {
  it('unboxes a verified external batch and supplies the current owner scope without capturing recalled text', async () => {
    const f = fixture()
    expect(await f.begin()).toMatchObject({ text: 'Historical context only' })
    expect(f.access.context('harness', 'root')?.scope).toEqual({ kind: 'private', platform: 'qq', accountId: '100', targetId: '200', owner: true })
    await f.finish()
    expect(f.provider.capture).toHaveBeenCalledOnce()
    expect(f.provider.capture).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: 'user', text: 'User statement', timestamp: '2026-11-01T00:00:00Z', senderId: '200', senderRole: 'owner' }, { role: 'assistant', text: 'Visible reply', timestamp: expect.any(String) }], actions: [{ tool: 'send', outcome: 'returned' }] }))
    expect(JSON.stringify(vi.mocked(f.provider.capture).mock.calls)).not.toContain('Historical context only')
    expect(f.access.context('harness', 'root')).toBeUndefined()
    await f.finish(); expect(f.provider.capture).toHaveBeenCalledOnce()
  })
  it('does not grant owner access from a forged source role or an owner speaking in a group', async () => {
    const f = fixture(), first = f.batch.events[0]!
    await f.begin('spoof', { ...f.batch, events: [{ ...first, senderId: '999', targetId: '999' }] })
    expect(f.access.context('harness', 'root')?.scope.owner).toBe(false)
    await f.begin('group', { ...f.batch, events: [{ ...first, source: { ...first.source, kind: 'group' } }] })
    expect(f.access.context('harness', 'root')?.scope.owner).toBe(false)
  })
  it('keeps independent main sessions and rejects late settlement for a replaced turn', async () => {
    const f = fixture()
    await f.begin('old'); await f.begin('current')
    await f.finish('old')
    expect(f.provider.capture).not.toHaveBeenCalled()
    expect(f.access.context('harness', 'root')?.turnId).toBe('current')
    await f.memory.begin({ agentId: 'web', agentTypeId: 'main', turnId: 'web-turn', messages: [{ role: 'user', text: 'Owner native input', timestamp: new Date().toISOString() }] })
    expect(f.access.context('harness', 'web')?.scope).toMatchObject({ kind: 'self', owner: true })
    await f.finish('current')
    expect(f.access.context('harness', 'web')?.turnId).toBe('web-turn')
  })
  it('recalls self interests for autonomy without saving a mechanical wake prompt', async () => {
    const f = fixture()
    await f.memory.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'autonomous', autonomous: true, messages: [], query: 'Unfinished work and interests' })
    expect(f.provider.recall).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ kind: 'self', owner: false }) }), 'Unfinished work and interests', expect.any(AbortSignal))
    await f.finish('autonomous')
    expect(f.provider.capture).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: 'assistant', text: 'Visible reply', timestamp: expect.any(String) }] }))
  })
  it('records native steering in the same self turn exactly once', async () => {
    const f = fixture(), first = { role: 'user' as const, text: 'First input', timestamp: new Date().toISOString(), messageId: 'first' }, steering = { ...first, text: 'Additional owner steering', messageId: 'steer' }
    await f.memory.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'native', messages: [first] })
    await f.memory.append({ agentId: 'root', turnId: 'native', messages: [steering] })
    await f.memory.append({ agentId: 'root', turnId: 'native', messages: [steering] })
    await f.finish('native')
    const captured = vi.mocked(f.provider.capture).mock.calls[0]![0]
    expect(captured.messages.map(message => message.text)).toEqual(['First input', 'Additional owner steering', 'Visible reply'])
    expect(f.provider.recall).toHaveBeenCalledTimes(2)
  })
  it('separates native owner steering from the current external peer and routes current MCP scope to self', async () => {
    const f = fixture()
    await f.begin('mixed')
    const steering = { role: 'user' as const, text: 'Private native owner instruction', timestamp: new Date().toISOString(), messageId: 'native' }
    await f.memory.append({ agentId: 'root', turnId: 'mixed', messages: [steering] })
    expect(f.access.context('harness', 'root')?.scope).toMatchObject({ kind: 'self', owner: true })
    await f.finish('mixed')
    expect(f.provider.capture).toHaveBeenCalledTimes(2)
    const primary = vi.mocked(f.provider.capture).mock.calls[0]![0], secondary = vi.mocked(f.provider.capture).mock.calls[1]![0]
    expect(primary.messages.map(message => message.text)).toEqual(['User statement'])
    expect(primary.actions).toEqual([])
    expect(secondary.context.scope).toMatchObject({ kind: 'self', owner: true })
    expect(secondary.messages.map(message => message.text)).toEqual(['Private native owner instruction', 'Visible reply'])
    expect(secondary.actions).toEqual([{ tool: 'send', outcome: 'returned' }])
  })

  it('bounds long incoming text to a valid provider query while retaining capture content', async () => {
    const f = fixture(), text = 'x'.repeat(6000)
    await f.begin('long', { ...f.batch, events: [{ ...f.batch.events[0]!, text, content: text }] })
    expect(vi.mocked(f.provider.recall).mock.calls[0]![1]).toHaveLength(4000)
    await f.finish('long')
    expect(vi.mocked(f.provider.capture).mock.calls[0]![0].messages[0]!.text).toHaveLength(6000)
  })

  it('reports retrieval failure without blocking the chat or losing capture', async () => {
    const f = fixture()
    vi.mocked(f.provider.recall).mockRejectedValueOnce(new Error('Service unavailable'))
    expect(await f.begin()).toEqual({ text: '', items: [], errors: ['MEMORY_RECALL_FAILED'] })
    await f.finish(); expect(f.provider.capture).toHaveBeenCalledOnce()
  })
  it('revokes an in-flight recall and ignores late content', async () => {
    const f = fixture()
    let release!: (value: { text: string; items: [] }) => void
    vi.mocked(f.provider.recall).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const begin = f.begin()
    f.access.revokeHarness('harness')
    release({ text: 'Late data', items: [] })
    expect(await begin).toEqual({ text: '', items: [] })
    await f.finish(); expect(f.provider.capture).not.toHaveBeenCalled()
  })
  it('rejects mixed source identities and stale/disabled sources', async () => {
    const f = fixture()
    await expect(f.begin('mixed', { ...f.batch, events: [...f.batch.events, { ...f.batch.events[0]!, accountId: 'other' }] })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    f.enabled.delete('qq')
    await expect(f.begin()).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    await expect(f.memory.begin({ agentId: 'child', agentTypeId: 'qq.private', turnId: 'bad' })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
  })
})
