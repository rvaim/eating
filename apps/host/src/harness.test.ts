import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessMessageSink } from '@eating/plugin-sdk'
import { HarnessGateway } from './harness'
import { HostStore } from './store'

const cleanups: Array<() => Promise<void>> = []

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.useRealTimers() }
})

function fixture() {
  const temporaryParent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryParent, 'eating-harness-test-')))
  const store = new HostStore(join(directory, 'database', 'host.sqlite'))
  const gateway = new HarnessGateway(store)
  cleanups.push(async () => {
    await gateway.close()
    store.close()
    const target = realpathSync(directory)
    if (target !== directory || dirname(target) !== temporaryParent || !basename(target).startsWith('eating-harness-test-')) {
      throw new Error('Refusing to remove a path outside the test mkdtemp directory.')
    }
    rmSync(target, { recursive: true })
  })
  let sequence = 0
  const record = (text = 'hello') => {
    const event: HarnessEvent = { protocolVersion: 1, eventId: 'replaced-by-store', pluginId: 'test-platform', instanceId: 'test-instance-one',
      platform: 'test', accountId: 'account-one', conversationId: 'test:private:one', senderId: 'sender-one', receivedAt: '2026-10-26T12:00:00.000Z',
      source: { trust: 'external', kind: 'private' }, content: { text }, text }
    const { eventId } = store.recordEvent('test-platform', `incoming-${++sequence}`, { raw_message: text }, event)
    return { ...event, eventId }
  }
  return { gateway, store, record }
}

function deferred<T>() {
  let resolveValue!: (value: T) => void
  const promise = new Promise<T>(complete => { resolveValue = complete })
  return { promise, resolve: resolveValue }
}

function sink(id = 'test-harness', implementation?: HarnessMessageSink['deliver']) {
  const deliver = vi.fn<HarnessMessageSink['deliver']>(implementation ?? (async () => ({ accepted: true, receiptId: 'test-receipt' })))
  return { id, deliver }
}

describe('HarnessGateway delivery boundary', () => {
  it('does not deliver or mark messages accepted before a Harness is attached', async () => {
    const { gateway, store, record } = fixture()
    record()
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(gateway.getStatus()).toMatchObject({ protocolVersion: 1, state: 'not-attached', sinkId: null, pending: 1, accepted: 0, uncertain: 0 })
    expect(store.pendingHarnessEvents()[0]?.attempts).toBe(0)
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('pending')
  })

  it('allows a single active sink and an old unregister cannot remove a different replacement', async () => {
    const { gateway, record } = fixture()
    record()
    const first = sink('first-harness')
    const replacement = sink('second-harness')
    const unregister = gateway.register(first)
    expect(() => gateway.register(replacement)).toThrow('同一工作区仅允许一个主要 Harness 接收者。')
    expect(gateway.getStatus()).toMatchObject({ state: 'attached', sinkId: 'first-harness' })
    unregister()
    gateway.register(replacement)
    unregister()
    await vi.advanceTimersByTimeAsync(0)
    expect(gateway.getStatus()).toMatchObject({ state: 'attached', sinkId: 'second-harness', accepted: 1 })
    expect(first.deliver).not.toHaveBeenCalled()
    expect(replacement.deliver).toHaveBeenCalledOnce()
  })

  it('marks accepted only as Harness acceptance and preserves source provenance and instance identity', async () => {
    const { gateway, store, record } = fixture()
    const event = record()
    const harness = sink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliver).toHaveBeenCalledWith(event, expect.any(AbortSignal))
    expect(store.listMessages('test-platform')[0]).toMatchObject({ eventId: event.eventId, harnessStatus: 'accepted' })
    expect(gateway.getStatus()).toMatchObject({ accepted: 1, pending: 0, uncertain: 0 })
    expect(gateway.getStatus().note).toContain('不表示模型已读或动作完成')
    expect(store.pendingHarnessEvents()).toEqual([])
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliver).toHaveBeenCalledOnce()
  })

  it('retries explicit non-acceptance only within the persisted five-attempt bound', async () => {
    const { gateway, store, record } = fixture()
    record()
    const harness = sink('declining-harness', async () => ({ accepted: false }))
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliver).toHaveBeenCalledOnce()
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('pending')
    for (let attempt = 2; attempt <= 5; attempt++) {
      await vi.advanceTimersByTimeAsync(10001)
      expect(harness.deliver).toHaveBeenCalledTimes(attempt)
    }
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliver).toHaveBeenCalledTimes(5)
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('pending')
    expect(store.pendingHarnessEvents()).toEqual([])
  })

  it('drains more than one batch without redelivering accepted events', async () => {
    const { gateway, store, record } = fixture()
    const events = Array.from({ length: 25 }, (_, index) => record(`event ${index}`))
    const harness = sink('batch-harness')
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliver).toHaveBeenCalledTimes(20)
    expect(store.harnessSummary()).toMatchObject({ accepted: 20, pending: 5 })
    await vi.advanceTimersByTimeAsync(10001)
    expect(harness.deliver).toHaveBeenCalledTimes(25)
    expect(harness.deliver.mock.calls.map(([current]) => current.eventId)).toEqual(events.map(current => current.eventId))
    expect(store.harnessSummary()).toMatchObject({ accepted: 25, pending: 0 })
  })

  it('records a delivery exception as uncertain and never retries it automatically', async () => {
    const { gateway, store, record } = fixture()
    record()
    const harness = sink('failing-harness', async () => { throw new Error('test delivery failed') })
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('uncertain')
    expect(store.pendingHarnessEvents()).toEqual([])
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliver).toHaveBeenCalledOnce()
    expect(gateway.getStatus()).toMatchObject({ accepted: 0, pending: 0, uncertain: 1 })
  })

  it('aborts a timed-out sink and records uncertainty without automatic redelivery', async () => {
    const { gateway, store, record } = fixture()
    record()
    const harness = sink('hanging-harness', async () => new Promise(() => {}))
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('delivering')
    const signal = harness.deliver.mock.calls[0]![1]
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(15000)
    expect(signal.aborted).toBe(true)
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('uncertain')
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliver).toHaveBeenCalledOnce()
  })

  it('close aborts and finishes even if the sink ignores AbortSignal', async () => {
    const { gateway, store, record } = fixture()
    record()
    const harness = sink('ignores-abort', async () => new Promise(() => {}))
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const signal = harness.deliver.mock.calls[0]![1]
    await gateway.close()
    expect(signal.aborted).toBe(true)
    expect(store.listMessages('test-platform')[0]?.harnessStatus).toBe('uncertain')
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', sinkId: null })
    expect(() => gateway.register(sink('too-late'))).toThrow('Harness 消息网关已停止。')
    await gateway.close()
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliver).toHaveBeenCalledOnce()
  })

  it('unregister aborts without waiting for the sink and retains later events as pending', async () => {
    const { gateway, store, record } = fixture()
    const first = record('first')
    const later = record('later')
    const harness = sink('ignores-abort', async () => new Promise(() => {}))
    const unregister = gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const signal = harness.deliver.mock.calls[0]![1]
    unregister()
    await vi.advanceTimersByTimeAsync(0)
    expect(signal.aborted).toBe(true)
    expect(store.listMessages('test-platform').find(message => message.eventId === first.eventId)?.harnessStatus).toBe('uncertain')
    expect(store.listMessages('test-platform').find(message => message.eventId === later.eventId)?.harnessStatus).toBe('pending')
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', sinkId: null, pending: 1, uncertain: 1 })
    await gateway.close()
    expect(harness.deliver).toHaveBeenCalledOnce()
  })

  it('drains a notification received while another delivery is in flight', async () => {
    const { gateway, store, record } = fixture()
    const firstEvent = record('first')
    const firstReceipt = deferred<{ accepted: boolean }>()
    const harness = sink('deferred-first', async current => current.eventId === firstEvent.eventId ? firstReceipt.promise : { accepted: true })
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const secondEvent = record('arrived during delivery')
    gateway.notify()
    firstReceipt.resolve({ accepted: true })
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.deliver).toHaveBeenCalledTimes(2)
    expect(harness.deliver.mock.calls[1]?.[0].eventId).toBe(secondEvent.eventId)
    expect(store.listMessages('test-platform').every(message => message.harnessStatus === 'accepted')).toBe(true)
  })

  it('starts a replacement Harness after unregistering a sink with an in-flight delivery', async () => {
    const { gateway, store, record } = fixture()
    const firstEvent = record('first')
    const secondEvent = record('second')
    const oldHarness = sink('old-harness', async () => new Promise(() => {}))
    const unregister = gateway.register(oldHarness)
    await vi.advanceTimersByTimeAsync(0)
    const replacement = sink('new-harness')
    unregister()
    gateway.register(replacement)
    await vi.advanceTimersByTimeAsync(1)
    expect(oldHarness.deliver.mock.calls[0]?.[1].aborted).toBe(true)
    expect(replacement.deliver).toHaveBeenCalledOnce()
    expect(replacement.deliver.mock.calls[0]?.[0].eventId).toBe(secondEvent.eventId)
    expect(store.listMessages('test-platform').find(message => message.eventId === firstEvent.eventId)?.harnessStatus).toBe('uncertain')
    expect(store.listMessages('test-platform').find(message => message.eventId === secondEvent.eventId)?.harnessStatus).toBe('accepted')
  })
})
