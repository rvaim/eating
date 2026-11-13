import { describe, expect, it, vi } from 'vitest'
import type { BackendPlugin, HarnessDeliveryBatch, MemoryProvider } from '@eating/plugin-sdk'
import { MemoryAccess } from './memory-access'

function fixture() {
  const enabled = new Set(['harness', 'qq', 'memory'])
  const provider: MemoryProvider = { recall: vi.fn(async () => ({ text: 'Historical context only', items: [{ uri: 'viking://~/memories/example.md', text: 'Preference', score: 0.8 }] })), capture: vi.fn(async () => {}), flush: vi.fn(async () => {}) }
  const qq = { id: 'qq', kind: 'communication', getAgentIdentity: () => ({ owners: ['200'], administrators: [] }) } as unknown as BackendPlugin
  const plugin = { id: 'memory', kind: 'capability', memory: provider, getStatus: () => ({ state: 'connected' }) } as unknown as BackendPlugin
  const plugins = [qq, plugin]
  const access = new MemoryAccess({ plugins: () => plugins, enabled: id => enabled.has(id) })
  const memory = access.services('harness')
  const batch: HarnessDeliveryBatch = { protocolVersion: 1, batchId: 'a'.repeat(64), conversationId: 'qq:100:private:200', reason: 'aggregation-window', createdAt: '2026-11-01T00:00:00Z', events: [{ protocolVersion: 1, eventId: 'event', pluginId: 'qq', platform: 'qq', instanceId: 'instance', accountId: '100', conversationId: 'qq:100:private:200', senderId: '200', targetId: '200', receivedAt: '2026-11-01T00:00:00Z', source: { trust: 'external', kind: 'private', senderRole: 'owner' }, content: 'User statement', text: 'User statement' }] }
  const begin = (turnId = 'turn1', value = batch) => memory.begin({ agentId: 'root', agentTypeId: 'main', turnId, batch: value })
  const finish = (turnId = 'turn1') => memory.finish({ agentId: 'root', turnId, assistantText: 'Visible reply', actions: [{ tool: 'send', outcome: 'returned' }], outcome: 'completed' })
  return { access, memory, provider, enabled, plugins, batch, begin, finish }
}

describe('trusted current-turn memory coordination', () => {
  it('attributes appended external batches to their actual peers and captures each once without self or cross-peer leakage', async () => {
    const f = fixture(), first = f.batch.events[0]!
    await f.begin()
    const same = { ...f.batch, batchId: 'b'.repeat(64), events: [{ ...first, eventId: 'second', text: 'Second peer statement', messageId: 'second' }] }
    const other = { ...f.batch, batchId: 'c'.repeat(64), conversationId: 'other', events: [{ ...first, eventId: 'other', senderId: '999', targetId: '999', conversationId: 'other', text: 'Other peer statement', messageId: 'other' }] }
    await f.memory.append({ agentId: 'root', turnId: 'turn1', batch: same })
    await f.memory.append({ agentId: 'root', turnId: 'turn1', batch: same })
    await f.memory.append({ agentId: 'root', turnId: 'turn1', batch: other })
    expect(f.access.context('harness', 'root')).toBeNull()
    await f.finish()
    const captures = vi.mocked(f.provider.capture).mock.calls.map(call => call[0])
    expect(captures).toHaveLength(2)
    expect(captures[0]!.messages.map(message => message.text)).toEqual(['User statement', 'Second peer statement'])
    expect(captures[0]!.context.scope).toMatchObject({ kind: 'private', targetId: '200', owner: true })
    expect(captures[1]!.context.scope).toMatchObject({ kind: 'private', targetId: '999', owner: false })
    expect(captures[1]!.messages.map(message => message.text)).toEqual(['Other peer statement'])
    expect(captures.every(capture => capture.actions.length === 0)).toBe(true)
  })

  it('forwards native lifecycle commit boundaries only to connected enabled providers', async () => {
    const f = fixture()
    await f.memory.flush({ agentId: 'root', reason: 'compaction' })
    expect(f.provider.flush).toHaveBeenCalledExactlyOnceWith('compaction')
    f.enabled.delete('memory')
    await f.memory.flush({ agentId: 'root', reason: 'session-end' })
    expect(f.provider.flush).toHaveBeenCalledOnce()
    f.enabled.delete('harness')
    await expect(f.memory.flush({ agentId: 'root', reason: 'compaction' })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
  })
  it('unboxes a verified external batch and supplies the current owner scope without capturing recalled text', async () => {
    const f = fixture()
    expect(await f.begin()).toMatchObject({ text: expect.stringContaining('Historical context only') })
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
  it('separates native owner steering from the current external peer and marks MCP scope ambiguous', async () => {
    const f = fixture()
    await f.begin('mixed')
    const steering = { role: 'user' as const, text: 'Private native owner instruction', timestamp: new Date().toISOString(), messageId: 'native' }
    await f.memory.append({ agentId: 'root', turnId: 'mixed', messages: [steering] })
    expect(f.access.context('harness', 'root')).toBeNull()
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
  it('rejects malformed batch identities, untrusted kinds and stale/disabled sources before recall', async () => {
    const f = fixture(), first = f.batch.events[0]!
    for (const change of [{ accountId: '' }, { instanceId: '' }, { pluginId: 'unknown' }, { source: { ...first.source, trust: 'owner' } }, { source: { ...first.source, kind: 'self' } }, { source: { ...first.source, senderRole: 'root' } }]) {
      await expect(f.begin('invalid', { ...f.batch, events: [{ ...first, ...change }] } as HarnessDeliveryBatch)).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    }
    await expect(f.begin('mixed', { ...f.batch, events: [...f.batch.events, { ...first, accountId: 'other' }] })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    await expect(f.begin('wrong-platform', { ...f.batch, events: [...f.batch.events, { ...first, platform: 'other' }] })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    f.enabled.delete('qq')
    await expect(f.begin()).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    await expect(f.memory.begin({ agentId: 'child', agentTypeId: 'qq.private', turnId: 'bad' })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    expect(f.provider.recall).not.toHaveBeenCalled()
    expect(f.access.context('harness', 'root')).toBeUndefined()
  })

  it('recalls and captures interleaved private and group events only in their complete source groups', async () => {
    const f = fixture(), first = f.batch.events[0]!
    const group = { ...first, conversationId: 'qq:100:group:300', targetId: '300', source: { ...first.source, kind: 'group' as const }, text: 'GROUP-ONLY' }
    const other = { ...first, accountId: '101', conversationId: 'qq:101:private:200', text: 'OTHER-ACCOUNT-ONLY' }
    await f.memory.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'cross', query: 'FORGED-MIXED-QUERY', batch: { ...f.batch, conversationId: null, events: [{ ...first, text: 'PRIVATE-FIRST' }, group, other, { ...first, text: 'PRIVATE-LAST' }] } })
    expect(vi.mocked(f.provider.recall).mock.calls.map(([context, query]) => [context.scope, query])).toEqual([
      [{ kind: 'private', platform: 'qq', accountId: '100', targetId: '200', owner: true }, 'PRIVATE-FIRST\nPRIVATE-LAST'],
      [{ kind: 'group', platform: 'qq', accountId: '100', targetId: '300', owner: false }, 'GROUP-ONLY'],
      [{ kind: 'private', platform: 'qq', accountId: '101', targetId: '200', owner: true }, 'OTHER-ACCOUNT-ONLY'],
    ])
    expect(f.access.context('harness', 'root')).toBeNull()
    await f.finish('cross')
    expect(vi.mocked(f.provider.capture).mock.calls.map(([capture]) => [capture.context.scope.accountId, capture.context.scope.targetId, capture.messages.map(message => message.text), capture.actions])).toEqual([
      ['100', '200', ['PRIVATE-FIRST', 'PRIVATE-LAST'], []], ['100', '300', ['GROUP-ONLY'], []], ['101', '200', ['OTHER-ACCOUNT-ONLY'], []],
    ])
    expect(f.access.context('harness', 'root')).toBeUndefined()
  })

  it('keeps plugin, instance and conversation distinctions even when provider Peer coordinates coincide', async () => {
    const f = fixture(), first = f.batch.events[0]!
    f.enabled.add('other-plugin')
    f.plugins.push({ ...f.plugins[0]!, id: 'other-plugin', getAgentIdentity: () => ({ owners: [], administrators: [] }) })
    const events = [first, { ...first, instanceId: 'other-instance', text: 'INSTANCE-ONLY' }, { ...first, pluginId: 'other-plugin', text: 'PLUGIN-ONLY' }, { ...first, conversationId: 'other-conversation', text: 'CONVERSATION-ONLY' }]
    const recalled = await f.begin('complete-identity', { ...f.batch, conversationId: null, events })
    expect(f.provider.recall).toHaveBeenCalledTimes(4)
    expect(vi.mocked(f.provider.recall).mock.calls.map(([context]) => context.scope.owner)).toEqual([true, true, false, true])
    for (const marker of ['instance', 'other-instance', 'other-plugin', 'other-conversation']) expect(recalled.text).toContain(marker)
    expect(recalled.items.every(item => item.text.startsWith('Memory recall scope (trusted routing): '))).toBe(true)
    await f.finish('complete-identity')
    const captures = vi.mocked(f.provider.capture).mock.calls.map(([capture]) => capture)
    expect(captures.map(capture => capture.messages.map(message => message.text))).toEqual(events.map(event => [event.text]))
    expect(new Set(captures.map(capture => capture.context.turnId)).size).toBe(4)
    expect(captures.every(capture => capture.actions.length === 0)).toBe(true)
  })

  it('labels each recalled text and hit with its actual scope instead of the batch source', async () => {
    const f = fixture(), first = f.batch.events[0]!
    const recalled = await f.begin('labels', { ...f.batch, conversationId: null, events: [first, { ...first, conversationId: 'group', targetId: '300', source: { ...first.source, kind: 'group' } }] })
    expect(recalled.text).toContain('"conversationId":"qq:100:private:200"')
    expect(recalled.text).toContain('"conversationId":"group"')
    expect(recalled.items[0]!.text).toContain('"targetId":"200"')
    expect(recalled.items[1]!.text).toContain('"targetId":"300"')
  })

  it('keeps native input separate from every external scope even when their message IDs coincide', async () => {
    const f = fixture(), first = { ...f.batch.events[0]!, messageId: 'same-id' }
    await f.begin('native-mixed', { ...f.batch, conversationId: null, events: [first, { ...first, accountId: 'other', text: 'OTHER-PEER' }] })
    const steering = { role: 'user' as const, text: 'NATIVE-ONLY', timestamp: first.receivedAt, messageId: 'same-id' }
    await f.memory.append({ agentId: 'root', turnId: 'native-mixed', messages: [steering, steering] })
    expect(f.access.context('harness', 'root')).toBeNull()
    expect(vi.mocked(f.provider.recall).mock.calls[2]).toEqual([expect.objectContaining({ scope: { kind: 'self', platform: '', accountId: '', targetId: '', owner: true } }), 'NATIVE-ONLY', expect.any(AbortSignal)])
    await f.finish('native-mixed')
    const captures = vi.mocked(f.provider.capture).mock.calls.map(([capture]) => capture)
    expect(captures.map(capture => capture.messages.map(message => message.text))).toEqual([['User statement'], ['OTHER-PEER'], ['NATIVE-ONLY', 'Visible reply']])
    expect(captures.map(capture => capture.actions)).toEqual([[], [], [{ tool: 'send', outcome: 'returned' }]])
    expect(captures[2]!.context.scope.kind).toBe('self')
  })

  it('segments more than 200 external messages losslessly with distinct provider turn IDs', async () => {
    const f = fixture(), first = f.batch.events[0]!
    const events = Array.from({ length: 401 }, (_, index) => ({ ...first, eventId: `event-${index}`, messageId: `message-${index}`, text: `BODY-${index}` }))
    await f.begin('large', { ...f.batch, events })
    await f.finish('large')
    const captures = vi.mocked(f.provider.capture).mock.calls.map(([capture]) => capture)
    expect(captures.map(capture => capture.messages.length)).toEqual([200, 200, 1])
    expect(captures.flatMap(capture => capture.messages.map(message => message.text))).toEqual(events.map(event => event.text))
    expect(captures.flatMap(capture => capture.messages.map(message => message.messageId))).toEqual(events.map(event => event.messageId))
    expect(new Set(captures.map(capture => capture.context.turnId)).size).toBe(3)
    expect(captures.every(capture => capture.context.turnId.length <= 160 && capture.actions.length === 0)).toBe(true)
  })

  it('segments UTF-8 bytes within each scope and excludes main summaries spanning member filters', async () => {
    const f = fixture(), first = f.batch.events[0]!
    const events = Array.from({ length: 5 }, (_, index) => ({ ...first, senderId: index === 0 ? 'denied' : 'allowed', source: { ...first.source, kind: 'group' as const }, text: String(index) + '茶'.repeat(32000) }))
    await f.begin('bytes', { ...f.batch, events })
    await f.finish('bytes')
    const captures = vi.mocked(f.provider.capture).mock.calls.map(([capture]) => capture)
    expect(captures.map(capture => capture.messages.length)).toEqual([2, 2, 1])
    expect(captures.every(capture => Buffer.byteLength(JSON.stringify(capture.messages)) < 256 * 1024)).toBe(true)
    expect(captures.flatMap(capture => capture.messages.map(message => message.text))).toEqual(events.map(event => event.text))
    expect(captures.every(capture => capture.messages.every(message => message.role === 'user') && capture.actions.length === 0)).toBe(true)
  })

  it.each([
    ['backslashes', '\\'.repeat(32768)],
    ['double quotes', '"'.repeat(32768)],
    ['control whitespace', '\n\t\r'.repeat(10922)],
    ['Unicode', '茶😀'.repeat(10922)],
  ])('bounds serialized capture size while preserving %s exactly', async (_name, text) => {
    const f = fixture(), first = f.batch.events[0]!
    const events = Array.from({ length: 8 }, (_, index) => ({ ...first, eventId: `escaped-${index}`, messageId: `escaped-${index}`, text }))
    await f.begin('serialized', { ...f.batch, events })
    await f.finish('serialized')
    const captures = vi.mocked(f.provider.capture).mock.calls.map(([capture]) => capture)
    expect(captures.length).toBeGreaterThan(1)
    expect(captures.every(capture => capture.messages.length <= 200 && Buffer.byteLength(JSON.stringify(capture.messages)) <= 256 * 1024 - 1024)).toBe(true)
    const captured = captures.flatMap(capture => capture.messages)
    expect(captured.map(message => message.messageId)).toEqual(events.map(event => event.messageId))
    expect(captured.map(message => Buffer.from(message.text))).toEqual(events.map(event => Buffer.from(event.text)))
    expect(captures.every(capture => capture.actions.length === 0 && capture.messages.every(message => message.role === 'user'))).toBe(true)
  })

  it('segments accumulated native inputs and captures assistant text and actions only once', async () => {
    const f = fixture(), timestamp = f.batch.createdAt
    const initial = Array.from({ length: 200 }, (_, index) => ({ role: 'user' as const, text: `INITIAL-${index}`, timestamp, messageId: `initial-${index}` }))
    const additions = Array.from({ length: 201 }, (_, index) => ({ role: 'user' as const, text: `ADDED-${index}`, timestamp, messageId: `added-${index}` }))
    await f.memory.begin({ agentId: 'root', agentTypeId: 'main', turnId: 'native-large', messages: initial })
    await f.memory.append({ agentId: 'root', turnId: 'native-large', messages: additions })
    expect(f.access.context('harness', 'root')?.scope).toMatchObject({ kind: 'self', owner: true })
    await f.finish('native-large')
    const captures = vi.mocked(f.provider.capture).mock.calls.map(([capture]) => capture)
    expect(captures.map(capture => capture.messages.length)).toEqual([200, 200, 2])
    expect(captures.flatMap(capture => capture.messages.map(message => message.text))).toEqual([...initial, ...additions].map(message => message.text).concat('Visible reply'))
    expect(captures.map(capture => capture.actions)).toEqual([[], [], [{ tool: 'send', outcome: 'returned' }]])
  })

  it('rejects invalid individual messages instead of truncating or silently dropping their content', async () => {
    const f = fixture()
    await expect(f.begin('oversized', { ...f.batch, events: [{ ...f.batch.events[0]!, text: 'x'.repeat(32769) }] })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    expect(f.provider.recall).not.toHaveBeenCalled()
    await f.begin('valid')
    await expect(f.memory.append({ agentId: 'root', turnId: 'valid', messages: [{ role: 'user', text: 'invalid timestamp', timestamp: 'invalid' }] })).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_INVALID' })
    await f.finish('valid')
    expect(f.provider.capture).toHaveBeenCalledOnce()
  })

  it('reports a failed capture segment while still processing independent scopes', async () => {
    const f = fixture(), first = f.batch.events[0]!
    vi.mocked(f.provider.capture).mockRejectedValueOnce(new Error('provider rejected segment'))
    await f.begin('capture-failure', { ...f.batch, conversationId: null, events: [first, { ...first, accountId: 'other', text: 'INDEPENDENT-PEER' }] })
    await expect(f.finish('capture-failure')).rejects.toThrow('Memory capture failed')
    expect(f.provider.capture).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.provider.capture).mock.calls[1]![0].messages[0]!.text).toBe('INDEPENDENT-PEER')
    expect(f.access.context('harness', 'root')).toBeUndefined()
  })

  it('discards every recalled group when a later scope is revoked during retrieval', async () => {
    const f = fixture(), first = f.batch.events[0]!
    let release!: (value: { text: string; items: [] }) => void
    vi.mocked(f.provider.recall).mockImplementationOnce(async () => ({ text: 'earlier scope', items: [] })).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const started = f.begin('revoke-multi', { ...f.batch, conversationId: null, events: [first, { ...first, accountId: 'other' }] })
    await vi.waitFor(() => expect(f.provider.recall).toHaveBeenCalledTimes(2))
    f.access.revokeAgent('harness', 'root')
    release({ text: 'late scope', items: [] })
    expect(await started).toEqual({ text: '', items: [] })
    await f.finish('revoke-multi')
    expect(f.provider.capture).not.toHaveBeenCalled()
  })
})
