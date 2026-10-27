import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HostPluginContext, JsonObject, PluginLogEntry } from '@eating/plugin-sdk'
import { startOneBotFixture } from '../../../../../tests/fixtures/onebot'
import qqEntry from '../server'
import { LiveLogChannel } from './live-logs'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks()
  if (errors.length > 0) throw new AggregateError(errors, 'QQ live log test cleanup failed')
})

function entry(id = 'event-1'): PluginLogEntry {
  return { id, timestamp: '2026-10-27T12:00:00.000Z', level: 'info', event: 'message.received', message: '测试消息' }
}

describe('LiveLogChannel viewer lifecycle', () => {
  it('never constructs unseen entries and does not replay on subscription or resubscription', () => {
    const channel = new LiveLogChannel()
    const factory = vi.fn(() => entry())
    channel.publish(factory)
    expect(factory).not.toHaveBeenCalled()
    const first = vi.fn()
    const unsubscribe = channel.subscribe(first)
    expect(first).not.toHaveBeenCalled()
    channel.publish(factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    unsubscribe()
    unsubscribe()
    channel.publish(factory)
    expect(factory).toHaveBeenCalledTimes(1)
    const next = vi.fn()
    channel.subscribe(next)
    expect(next).not.toHaveBeenCalled()
    channel.publish(() => entry('event-2'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledExactlyOnceWith(entry('event-2'))
  })

  it('constructs one shared snapshot and delivers once per subscription for each publication', () => {
    const channel = new LiveLogChannel()
    const first = vi.fn()
    const second = vi.fn()
    channel.subscribe(first)
    channel.subscribe(second)
    const original = entry()
    const factory = vi.fn(() => original)
    channel.publish(factory)
    channel.publish(() => entry('event-2'))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    expect(first.mock.calls[0]?.[0]).toBe(second.mock.calls[0]?.[0])
    expect(first.mock.calls[0]?.[0]).not.toBe(original)
  })

  it('keeps repeated function subscriptions independent from old unsubscribe functions', () => {
    const channel = new LiveLogChannel()
    const listener = vi.fn()
    const oldUnsubscribe = channel.subscribe(listener)
    oldUnsubscribe()
    const unsubscribe = channel.subscribe(listener)
    oldUnsubscribe()
    channel.publish(() => entry())
    expect(listener).toHaveBeenCalledTimes(1)
    const extraUnsubscribe = channel.subscribe(listener)
    channel.publish(() => entry('event-2'))
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    channel.publish(() => entry('event-3'))
    expect(listener).toHaveBeenCalledTimes(4)
    extraUnsubscribe()
    const factory = vi.fn(() => entry('unseen'))
    channel.publish(factory)
    expect(factory).not.toHaveBeenCalled()
  })

  it('removes a throwing subscriber while continuing delivery to healthy viewers', () => {
    const channel = new LiveLogChannel()
    const broken = vi.fn(() => { throw new Error('test-only failed viewer') })
    const healthy = vi.fn()
    channel.subscribe(broken)
    const unsubscribe = channel.subscribe(healthy)
    expect(() => channel.publish(() => entry())).not.toThrow()
    channel.publish(() => entry('event-2'))
    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(2)
    unsubscribe()
    const factory = vi.fn(() => entry('unseen'))
    channel.publish(factory)
    expect(factory).not.toHaveBeenCalled()
  })

  it('deeply freezes copied metadata so neither a viewer nor the factory can change another view', () => {
    const channel = new LiveLogChannel()
    const metadata = { nested: { value: 'safe' }, values: [{ label: 'safe' }] }
    const original = { ...entry(), metadata }
    const observed: PluginLogEntry[] = []
    channel.subscribe(log => {
      const copy = log.metadata as typeof metadata
      expect(Reflect.set(log, 'message', 'tampered')).toBe(false)
      expect(Reflect.set(copy.nested, 'value', 'tampered')).toBe(false)
      expect(Reflect.set(copy.values, '0', { label: 'tampered' })).toBe(false)
      expect(Reflect.set(copy.values[0]!, 'label', 'tampered')).toBe(false)
    })
    channel.subscribe(log => { observed.push(log) })
    channel.publish(() => original)
    const log = observed[0]!
    expect(Object.isFrozen(log)).toBe(true)
    expect(Object.isFrozen(log.metadata)).toBe(true)
    expect(log.metadata).toEqual({ nested: { value: 'safe' }, values: [{ label: 'safe' }] })
    expect(log.metadata).not.toBe(metadata)
    original.message = 'changed after delivery'
    metadata.nested.value = 'changed after delivery'
    metadata.values[0]!.label = 'changed after delivery'
    expect(log.message).toBe('测试消息')
    expect(log.metadata).toEqual({ nested: { value: 'safe' }, values: [{ label: 'safe' }] })
    expect(Object.isFrozen(metadata)).toBe(false)
  })

  it('does not deliver the current event to a subscription added during publication', () => {
    const channel = new LiveLogChannel()
    const late = vi.fn()
    channel.subscribe(() => { channel.subscribe(late) })
    channel.publish(() => entry())
    expect(late).not.toHaveBeenCalled()
    channel.publish(() => entry('event-2'))
    expect(late).toHaveBeenCalledExactlyOnceWith(entry('event-2'))
  })

  it('honors unsubscribe and dispose while a publication is being delivered', () => {
    const channel = new LiveLogChannel()
    const skipped = vi.fn()
    let unsubscribe = () => {}
    channel.subscribe(() => { unsubscribe(); channel.dispose() })
    unsubscribe = channel.subscribe(skipped)
    channel.publish(() => entry())
    expect(skipped).not.toHaveBeenCalled()
    expect(() => { channel.dispose(); unsubscribe(); channel.subscribe(skipped)() }).not.toThrow()
    const factory = vi.fn(() => entry('after-dispose'))
    channel.publish(factory)
    expect(factory).not.toHaveBeenCalled()
  })
})

function temporaryDirectory(): string {
  const parent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(parent, 'eating-qq-live-logs-')))
  cleanups.push(() => {
    const target = realpathSync(directory)
    if (target !== directory || dirname(target) !== parent || !basename(target).startsWith('eating-qq-live-logs-')) {
      throw new Error('Refusing to remove a directory outside the isolated QQ log test fixture')
    }
    rmSync(target, { recursive: true })
  })
  return directory
}

async function pluginFixture(configuration: JsonObject = {}, accessToken = 'test.only-token+$') {
  const directory = temporaryDirectory()
  const remote = await startOneBotFixture(accessToken ? { accessToken } : {})
  cleanups.push(() => remote.close())
  const keys = new Set<string>()
  const records: Array<{
    readonly event: JsonObject
    readonly harnessEvent: HarnessEvent | null
    readonly inserted: boolean
  }> = []
  const recordEvent = vi.fn<HostPluginContext['recordEvent']>((_pluginId, key, event, harnessEvent) => {
    const inserted = !keys.has(key)
    keys.add(key)
    records.push({ event, harnessEvent, inserted })
    return { inserted, eventId: key }
  })
  const context: HostPluginContext = {
    dataDirectory: join(directory, 'qq-bot'),
    getSetting: () => null,
    setSetting: () => {},
    recordEvent,
    listMessages: () => [],
    executeIdempotent: (_pluginId, _action, _params, _requestId, execute) => execute(),
  }
  const plugin = qqEntry.create(context)
  cleanups.push(() => plugin.dispose())
  const logs = plugin.logs
  if (!logs) throw new Error('QQ plugin did not expose a live log source')
  await plugin.updateConfiguration({ endpoint: remote.endpoint, accessToken, ...configuration })
  await plugin.connect()
  return { plugin, logs, recordEvent, records, remote, accessToken }
}

function message(messageId: number, patch: JsonObject = {}): JsonObject {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1,
    self_id: 123456789, user_id: 987654321, message_id: messageId,
    message: [{ type: 'text', data: { text: '测试消息' } }], ...patch }
}

describe('QQ receive-event live logs through the real plugin entry and loopback OneBot', () => {
  it('stores first, deduplicates logs, and emits only a bounded, redacted text preview and validated IDs', async () => {
    const { plugin, logs, recordEvent, records, remote, accessToken } = await pluginFixture()
    const observed: PluginLogEntry[] = []
    logs.subscribe(log => {
      expect(recordEvent.mock.results.at(-1)?.type).toBe('return')
      observed.push(log)
    })
    const text = `第一行 <img src=x onerror=alert(1)>\n${accessToken} ${accessToken}\n${'长'.repeat(550)}`
    const event = message(42, { message: text, url: 'https://event-only.invalid/secret',
      accessToken: 'untrusted-event-token', mcpToken: 'untrusted-mcp-token', sender: { nickname: 'untrusted name' } })
    remote.emitEvent(event)
    remote.emitEvent(event)
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2), { timeout: 1500, interval: 5 })
    expect(records.map(record => record.inserted)).toEqual([true, false])
    expect(observed).toHaveLength(1)
    const log = observed[0]!
    const forwarded = records[0]!.harnessEvent!
    expect(log).toEqual({
      id: forwarded.eventId,
      timestamp: forwarded.receivedAt,
      level: 'info', event: 'message.received',
      message: text.split(accessToken).join('[已隐藏令牌]').slice(0, 500),
      metadata: { kind: 'private', accountId: '123456789',
        instanceId: plugin.getPublicConfiguration().instanceId,
        conversationId: 'qq:123456789:private:987654321', senderId: '987654321', messageId: '42', queueAdmission: 'queued' },
    })
    expect(log.message).toHaveLength(500)
    expect(log.message).toContain('\n')
    expect(Date.parse(log.timestamp)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
    const serialized = JSON.stringify(log)
    for (const hidden of [accessToken, remote.endpoint, 'event-only.invalid', 'untrusted-event-token', 'untrusted-mcp-token', 'untrusted name']) {
      expect(serialized).not.toContain(hidden)
    }
    expect(records[0]?.event.message).toBe(text)
  })

  it('continues storing with no viewers and never replays messages received before or between views', async () => {
    const { logs, recordEvent, records, remote } = await pluginFixture()
    const clone = vi.spyOn(globalThis, 'structuredClone')
    remote.emitEvent(message(1))
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1), { timeout: 1500, interval: 5 })
    expect(clone).not.toHaveBeenCalled()
    const observed = vi.fn()
    const unsubscribe = logs.subscribe(observed)
    expect(observed).not.toHaveBeenCalled()
    remote.emitEvent(message(2))
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2), { timeout: 1500, interval: 5 })
    expect(observed).toHaveBeenCalledTimes(1)
    unsubscribe()
    clone.mockClear()
    remote.emitEvent(message(3))
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(3), { timeout: 1500, interval: 5 })
    expect(clone).not.toHaveBeenCalled()
    logs.subscribe(observed)
    expect(observed).toHaveBeenCalledTimes(1)
    remote.emitEvent(message(3))
    remote.emitEvent(message(4))
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(5), { timeout: 1500, interval: 5 })
    expect(records.map(record => record.inserted)).toEqual([true, true, true, false, true])
    expect(observed).toHaveBeenCalledTimes(2)
    expect(observed.mock.calls.map(call => (call[0] as PluginLogEntry).metadata?.messageId)).toEqual(['2', '4'])
  })

  it.each([
    { forwardToHarness: false, receiveGroups: true },
    { forwardToHarness: true, receiveGroups: false },
  ])('logs stored group events independently of Harness forwarding %j', async configuration => {
    const { plugin, logs, recordEvent, records, remote } = await pluginFixture(configuration, '')
    const broken = vi.fn(() => { throw new Error('test-only broken live viewer') })
    const observed: PluginLogEntry[] = []
    logs.subscribe(broken)
    logs.subscribe(log => { observed.push(log) })
    const groupMessage = { message_type: 'group', group_id: 123456,
      message: [{ type: 'image', data: { url: 'https://attachment-only.invalid/private-image' } }] }
    remote.emitEvent(message(10, groupMessage))
    remote.emitEvent(message(11, groupMessage))
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2), { timeout: 1500, interval: 5 })
    expect(broken).toHaveBeenCalledTimes(1)
    expect(records.map(record => record.harnessEvent)).toEqual([null, null])
    expect(observed).toHaveLength(2)
    expect(observed[0]?.message).toBe('[image]')
    expect(observed[0]?.metadata).toEqual({ kind: 'group', accountId: '123456789',
      instanceId: plugin.getPublicConfiguration().instanceId,
      conversationId: 'qq:123456789:group:123456', senderId: '987654321', messageId: '10', groupId: '123456', queueAdmission: 'not-forwarded' })
    expect(JSON.stringify(observed)).not.toContain('attachment-only.invalid')
    expect(plugin.getStatus().lastError).toBeNull()
    await plugin.dispose()
    const afterDispose = vi.fn()
    logs.subscribe(afterDispose)
    expect(afterDispose).not.toHaveBeenCalled()
  })
})
