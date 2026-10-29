import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeliverySettings, HarnessDeliveryReceipt, HarnessEvent, HarnessMessageSink } from '@eating/plugin-sdk'
import { HarnessGateway } from './harness'
import { HostStore } from './store'

const cleanups: Array<() => Promise<void>> = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'))
})
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.useRealTimers() }
})

function fixture(settings: Partial<DeliverySettings> = {}) {
  const temporaryParent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryParent, 'eating-harness-test-')))
  const store = new HostStore(join(directory, 'database', 'host.sqlite'))
  const configure = (values: Partial<DeliverySettings>) => {
    const snapshot = store.getDeliverySettingsSnapshot()
    return store.updateDeliverySettings({ ...snapshot.values, ...values }, snapshot.revision)
  }
  if (Object.keys(settings).length) configure(settings)
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
  const record = (text = 'hello', conversationId = 'test:private:one', kind: 'private' | 'group' = 'private') => {
    const event: HarnessEvent = {
      protocolVersion: 1, eventId: 'replaced-by-store', pluginId: 'test-platform', instanceId: 'test-instance-one',
      platform: 'test', accountId: 'account-one', conversationId, senderId: 'sender-one', receivedAt: '2026-10-26T12:00:00.000Z',
      source: { trust: 'external', kind }, content: { text }, text,
    }
    const { eventId } = store.recordEvent('test-platform', `incoming-${++sequence}`, { raw_message: text }, event)
    return { ...event, eventId }
  }
  return { gateway, store, record, configure }
}

function deferred<T>() {
  let resolveValue!: (value: T) => void
  const promise = new Promise<T>(complete => { resolveValue = complete })
  return { promise, resolve: resolveValue }
}

function reliableReceipt(receiptId = 'test-durable-receipt'): HarnessDeliveryReceipt {
  return { accepted: true, durable: true, receiptId }
}

function batchSink(id = 'test-harness', implementation?: NonNullable<HarnessMessageSink['deliverBatch']>) {
  const deliverBatch = vi.fn<NonNullable<HarnessMessageSink['deliverBatch']>>(implementation ?? (async () => reliableReceipt()))
  return { id, deliverBatch }
}

function orderedBatchId(eventIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(eventIds)).digest('hex')
}

const byteSize = (event: HarnessEvent) => Buffer.byteLength(JSON.stringify(event), 'utf8')

function executeSql(store: HostStore, sql: string): void {
  const database = new DatabaseSync(store.databasePath)
  try { database.exec(sql) }
  finally { database.close() }
}

const failAck = "CREATE TRIGGER fail_ack BEFORE UPDATE ON event_dedup WHEN NEW.disposition='accepted' BEGIN SELECT RAISE(ABORT,'injected acknowledgement failure'); END"
const failState = "CREATE TRIGGER fail_state BEFORE UPDATE ON settings WHEN NEW.key='host:delivery-queue-state' BEGIN SELECT RAISE(ABORT,'injected state failure'); END"

describe('HarnessGateway bounded aggregation and delivery', () => {
  it('keeps an unready receiver at zero attempts and zero timers until explicitly woken', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1 })
    record()
    let ready = false
    const harness = { ...batchSink(), isReady: () => ready }
    const select = vi.spyOn(store, 'getQueuedHarnessEvents')
    gateway.register(harness)
    gateway.notify()
    expect(select).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ status: 'pending', attempts: 0 })
    ready = true
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.harnessSummary()).toMatchObject({ accepted: 1, pending: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks readiness when a scheduled batch becomes due', async () => {
    const { gateway, store, record } = fixture()
    record()
    let ready = true
    const harness = { ...batchSink(), isReady: () => ready }
    gateway.register(harness)
    expect(vi.getTimerCount()).toBe(1)
    ready = false
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(vi.getTimerCount()).toBe(0)
    ready = true
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
  })

  it('retains new arrivals without retry while the batch receiver is busy', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1, retryIntervalMs: 100 })
    record('first')
    let ready = true
    const implementation = async () => { ready = false; return reliableReceipt() }
    const harness = { ...batchSink('busy', implementation), isReady: () => ready }
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const second = record('arrived during model processing')
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(store.getQueuedHarnessEvents()).toMatchObject([{ event: second, status: 'pending', attempts: 0 }])
    expect(store.harnessSummary()).toMatchObject({ accepted: 1, pending: 1, uncertain: 0 })
    expect(vi.getTimerCount()).toBe(0)
    ready = true
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.harnessSummary()).toMatchObject({ accepted: 2, pending: 0, uncertain: 0 })
  })

  it('acknowledges the complete active batch before pausing later batches when readiness changes', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 2 })
    const handedOff = [record('first'), record('second')]
    const waiting = record('next batch')
    let ready = true
    const harness = { ...batchSink('busy-after-batch', async () => { ready = false; return reliableReceipt() }), isReady: () => ready }
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(harness.deliverBatch.mock.calls[0]?.[0].events).toEqual(handedOff)
    expect(store.getQueuedHarnessEvents()).toMatchObject([{ event: waiting, status: 'pending', attempts: 0 }])
    expect(store.harnessSummary()).toMatchObject({ accepted: 2, pending: 1 })
    expect(vi.getTimerCount()).toBe(0)
    ready = true
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch.mock.calls[1]?.[0].events).toEqual([waiting])
    expect(store.harnessSummary()).toMatchObject({ accepted: 3, pending: 0 })
  })

  it('records a fixed readiness error without polling or exposing plugin errors and can recover on wake', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1 })
    record()
    let failing = true
    const isReady = vi.fn(() => { if (failing) throw new Error('private readiness diagnostic'); return true })
    const harness = { ...batchSink(), isReady }
    gateway.register(harness)
    expect(gateway.getStatus().lastError).toBe('Harness 接收者就绪检查失败，保留正文并等待接收者唤醒。')
    await vi.advanceTimersByTimeAsync(60000)
    expect(isReady).toHaveBeenCalledOnce()
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()[0]?.attempts).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    failing = false
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(gateway.getStatus().lastError).toBeNull()
  })

  it.each(['persistent', 'memory'] as const)('commits a pending %s local acknowledgement while receiver readiness stays false', async storageMode => {
    const { gateway, store, record } = fixture({ storageMode, maxBatchMessages: 1, retryIntervalMs: 100 })
    record('reliably handed off')
    let ready = true
    const harness = { ...batchSink('local-only', async () => {
      ready = false
      executeSql(store, failAck)
      return reliableReceipt()
    }), isReady: () => ready }
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const second = record('waiting for model readiness')
    gateway.notify()
    expect(gateway.getStatus()).toMatchObject({ waitingForLocalCommit: true, delivering: 1, pending: 1 })
    expect(vi.getTimerCount()).toBe(1)
    executeSql(store, 'DROP TRIGGER fail_ack')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.getQueuedHarnessEvents()).toMatchObject([{ event: second, status: 'pending', attempts: 0 }])
    expect(gateway.getStatus()).toMatchObject({ waitingForLocalCommit: false, accepted: 1, delivering: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps bodies pending without a sink and leaves no idle timer', async () => {
    const { gateway, store, record } = fixture()
    record()
    gateway.notify()
    gateway.reconfigure()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', sinkId: null, busy: false, pending: 1, accepted: 0, uncertain: 0 })
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ attempts: 0, status: 'pending' })
  })

  it('validates sink methods, enforces one registration and ignores an obsolete disposer even for the same sink object', async () => {
    const { gateway, record } = fixture()
    expect(() => gateway.register({ id: 'empty' } as unknown as HarnessMessageSink)).toThrow('必须提供 deliverBatch 函数')
    expect(() => gateway.register({ id: 'wrong-type', deliverBatch: true } as unknown as HarnessMessageSink)).toThrow('必须提供 deliverBatch 函数')
    const harness = batchSink()
    const unregister = gateway.register(harness)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => gateway.register(batchSink('other'))).toThrow('同一工作区仅允许一个主要 Harness 接收者。')
    record()
    gateway.notify()
    expect(vi.getTimerCount()).toBe(1)
    unregister()
    expect(vi.getTimerCount()).toBe(0)
    gateway.register(harness)
    unregister()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(gateway.getStatus()).toMatchObject({ state: 'attached', sinkId: harness.id, accepted: 1, busy: false, deliveryMode: 'batch' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the quiet deadline for an incomplete batch, preserves provenance, and deletes bodies only after a reliable receipt', async () => {
    const { gateway, store, record } = fixture()
    const event = record()
    const receipt = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('durable-harness', async () => receipt.promise)
    const acknowledge = vi.spyOn(store, 'acknowledgeHarnessBatch')
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(499)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.deliverBatch).toHaveBeenCalledWith({
      protocolVersion: 1, batchId: orderedBatchId([event.eventId]), conversationId: event.conversationId,
      createdAt: new Date().toISOString(), reason: 'quiet-window', events: [event],
    }, expect.any(AbortSignal))
    expect(gateway.getStatus()).toMatchObject({ busy: true, delivering: 1, accepted: 0 })
    expect(store.getQueuedHarnessEvents()[0]?.event).toEqual(event)
    receipt.resolve(reliableReceipt('owner-receipt'))
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith([event.eventId], 'owner-receipt')
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(store.listMessages('test-platform')).toEqual([])
    expect(gateway.getStatus()).toMatchObject({ accepted: 1, pending: 0, delivering: 0, uncertain: 0, busy: false })
    expect(gateway.getStatus().note).toContain('不表示模型已读或动作完成')
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restarts quiet waiting on each arrival without extending the first message max-wait deadline', async () => {
    const { gateway, record } = fixture({ quietWindowMs: 500, maxWaitMs: 1000, maxBatchMessages: 100 })
    const events = [record('first')]
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(400)
    events.push(record('second'))
    gateway.notify()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    events.push(record('third'))
    gateway.notify()
    await vi.advanceTimersByTimeAsync(199)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(harness.deliverBatch.mock.calls[0]?.[0]).toMatchObject({ reason: 'max-wait', events })
  })

  it('delivers immediately at the message threshold and drains consecutive full batches without a fixed pause', async () => {
    const { gateway, record, store } = fixture({ maxBatchMessages: 2 })
    const events = Array.from({ length: 5 }, (_, index) => record(`event-${index}`))
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(2)
    expect(harness.deliverBatch.mock.calls.map(([batch]) => batch.events)).toEqual([events.slice(0, 2), events.slice(2, 4)])
    expect(harness.deliverBatch.mock.calls.every(([batch]) => batch.reason === 'max-messages')).toBe(true)
    expect(store.harnessSummary()).toMatchObject({ accepted: 4, pending: 1 })
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(3)
    expect(harness.deliverBatch.mock.calls[2]?.[0]).toMatchObject({ reason: 'quiet-window', events: events.slice(4) })
  })

  it('uses UTF-8 serialized event bytes to trigger an immediate batch at its soft target', async () => {
    const { gateway, record, configure } = fixture()
    const events = [record('中文'.repeat(60)), record('another')]
    const target = byteSize(events[0]!) + byteSize(events[1]!) - 1
    expect(byteSize(events[0]!)).toBeLessThan(target)
    configure({ batchTargetBytes: target })
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(harness.deliverBatch.mock.calls[0]?.[0]).toMatchObject({ reason: 'target-bytes', events })
  })

  it('keeps an oversized event whole and in its own batch', async () => {
    const { gateway, record } = fixture({ batchTargetBytes: 1024 })
    const small = record('small')
    const oversized = record('large'.repeat(500))
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch.mock.calls.map(([batch]) => batch.events)).toEqual([[small], [oversized]])
    expect(harness.deliverBatch.mock.calls[1]?.[0].reason).toBe('target-bytes')
  })

  it('does not deliver a message rejected by the hard queue capacity even if the batch target is soft', async () => {
    const { gateway, record, store } = fixture({ maxQueuedBytes: 1024, batchTargetBytes: 1024 })
    record('x'.repeat(4096))
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(store.harnessSummary()).toMatchObject({ rejected: 1, accepted: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates conversation buckets, preserves event order, and chooses the oldest ready conversation first', async () => {
    const { gateway, record } = fixture()
    const first = record('group first', 'test:group:one', 'group')
    await vi.advanceTimersByTimeAsync(100)
    const privateEvent = record('private', 'test:private:two')
    const groupSecond = record('group second', first.conversationId, 'group')
    await vi.advanceTimersByTimeAsync(1000)
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(2)
    const batches = harness.deliverBatch.mock.calls.map(([batch]) => batch)
    expect(batches[0]).toMatchObject({ conversationId: first.conversationId, events: [first, groupSecond], batchId: orderedBatchId([first.eventId, groupSecond.eventId]) })
    expect(batches[1]).toMatchObject({ conversationId: privateEvent.conversationId, events: [privateEvent], batchId: orderedBatchId([privateEvent.eventId]) })
    expect(batches[0]?.batchId).not.toBe(orderedBatchId([groupSecond.eventId, first.eventId]))
  })

  it('rejects single-event-only registrations without calling them or consuming queued attempts', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 2 })
    record('first')
    record('second')
    const deliver = vi.fn(async () => reliableReceipt())
    expect(() => gateway.register({ id: 'unsupported-single-event', deliver } as unknown as HarnessMessageSink)).toThrow('必须提供 deliverBatch 函数')
    await vi.advanceTimersByTimeAsync(60000)
    expect(deliver).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents().map(item => [item.status, item.attempts])).toEqual([['pending', 0], ['pending', 0]])
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', deliveryMode: null, accepted: 0 })
    expect(vi.getTimerCount()).toBe(0)
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.harnessSummary()).toMatchObject({ accepted: 2, pending: 0 })
  })

  it.each([true, false])('does not overlap flushes and finds messages arriving in flight (notified: %s)', async notify => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 2 })
    const firstEvents = [record('first'), record('second')]
    const firstReceipt = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('deferred', async batch => batch.events[0]?.eventId === firstEvents[0]!.eventId ? firstReceipt.promise : reliableReceipt('next'))
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const nextEvents = [record('third'), record('fourth')]
    if (notify) { gateway.notify(); gateway.notify() }
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(gateway.getStatus()).toMatchObject({ busy: true, delivering: 2, pending: 2 })
    firstReceipt.resolve(reliableReceipt('first'))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(2)
    expect(harness.deliverBatch.mock.calls[1]?.[0].events).toEqual(nextEvents)
    expect(store.harnessSummary()).toMatchObject({ accepted: 4, pending: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('persists explicit rejection cooldown, retains the stable batch id, and ends retries visibly at the configured bound', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 2 })
    const events = [record('first'), record('second')]
    const harness = batchSink('declining', async () => ({ accepted: false }))
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getQueuedHarnessEvents().map(item => ({ status: item.status, attempts: item.attempts, nextAttemptAt: item.nextAttemptAt })))
      .toEqual(events.map(() => ({ status: 'pending', attempts: 1, nextAttemptAt: Date.now() + 10000 })))
    for (let attempt = 2; attempt <= 5; attempt++) {
      await vi.advanceTimersByTimeAsync(9999)
      gateway.notify()
      gateway.reconfigure()
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.deliverBatch).toHaveBeenCalledTimes(attempt - 1)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.deliverBatch).toHaveBeenCalledTimes(attempt)
    }
    expect(new Set(harness.deliverBatch.mock.calls.map(([batch]) => batch.batchId))).toEqual(new Set([orderedBatchId(events.map(event => event.eventId))]))
    expect(store.getQueuedHarnessEvents().map(item => ({ status: item.status, attempts: item.attempts }))).toEqual(events.map(() => ({ status: 'uncertain', attempts: 5 })))
    expect(gateway.getStatus()).toMatchObject({ accepted: 0, pending: 0, uncertain: 2 })
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a rejected head ahead of new messages while other conversations can proceed', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1 })
    const first = record('declined head')
    const harness = batchSink('declining-head', async batch => batch.events[0]?.eventId === first.eventId ? { accepted: false } : reliableReceipt())
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const later = record('same conversation')
    const other = record('other conversation', 'test:private:other')
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch.mock.calls.map(([batch]) => batch.events[0]?.eventId)).toEqual([first.eventId, other.eventId])
    expect(store.getQueuedHarnessEvents().find(item => item.event.eventId === later.eventId)).toMatchObject({ status: 'pending', attempts: 0 })
    await vi.advanceTimersByTimeAsync(9999)
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(2)
  })

  it.each([
    { accepted: true },
    { accepted: true, receiptId: 'memory-only' },
    { accepted: true, durable: false, receiptId: 'memory-only' },
    { accepted: true, durable: true },
    { accepted: true, durable: true, receiptId: '' },
    { accepted: true, durable: true, receiptId: '   ' },
  ] satisfies HarnessDeliveryReceipt[])('retains uncertain bodies when acceptance lacks durable evidence: %j', async receipt => {
    const { gateway, store, record } = fixture()
    const event = record()
    const harness = batchSink('insufficient', async () => receipt)
    const acknowledge = vi.spyOn(store, 'acknowledgeHarnessBatch')
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain', attempts: 1 })
    expect(acknowledge).not.toHaveBeenCalled()
    expect(gateway.getStatus()).toMatchObject({ accepted: 0, uncertain: 1 })
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records a synchronous receiver exception as uncertain without replay or body deletion', async () => {
    const { gateway, store, record } = fixture()
    const event = record()
    const harness = batchSink('throwing', () => { throw new Error('failure') })
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain', attempts: 1 })
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a timeout, retains uncertainty and ignores a late durable receipt', async () => {
    const { gateway, store, record } = fixture({ deliveryTimeoutMs: 100 })
    const event = record()
    const late = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('hanging', async () => late.promise)
    const acknowledge = vi.spyOn(store, 'acknowledgeHarnessBatch')
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    const signal = harness.deliverBatch.mock.calls[0]![1]
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(99)
    expect(gateway.getStatus()).toMatchObject({ busy: true, delivering: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain' })
    late.resolve(reliableReceipt('too-late'))
    gateway.notify()
    await vi.advanceTimersByTimeAsync(60000)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close finishes while the receiver ignores AbortSignal, retains the active body and rejects future registrations', async () => {
    const { gateway, store, record } = fixture()
    const event = record()
    const late = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('ignores-abort', async () => late.promise)
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    const signal = harness.deliverBatch.mock.calls[0]![1]
    await gateway.close()
    expect(signal.aborted).toBe(true)
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain' })
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', sinkId: null, busy: false })
    expect(() => gateway.register(batchSink('too-late'))).toThrow('Harness 消息网关已停止。')
    late.resolve(reliableReceipt())
    await gateway.close()
    gateway.notify()
    gateway.reconfigure()
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.harnessSummary()).toMatchObject({ accepted: 0, uncertain: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('immediately replaces an in-flight registration without losing the wake or accepting the old late receipt', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1 })
    const first = record('old in flight')
    const second = record('next for replacement')
    const late = deferred<HarnessDeliveryReceipt>()
    const old = batchSink('old', async () => late.promise)
    const acknowledge = vi.spyOn(store, 'acknowledgeHarnessBatch')
    const unregister = gateway.register(old)
    await vi.advanceTimersByTimeAsync(0)
    unregister()
    const replacement = batchSink('replacement')
    gateway.register(replacement)
    unregister()
    await vi.advanceTimersByTimeAsync(1)
    expect(old.deliverBatch.mock.calls[0]?.[1].aborted).toBe(true)
    expect(replacement.deliverBatch).toHaveBeenCalledOnce()
    expect(replacement.deliverBatch.mock.calls[0]?.[0].events).toEqual([second])
    late.resolve(reliableReceipt('old-late'))
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith([second.eventId], 'test-durable-receipt')
    expect(store.getQueuedHarnessEvents()).toMatchObject([{ event: first, status: 'uncertain', attempts: 1 }])
    expect(gateway.getStatus()).toMatchObject({ sinkId: 'replacement', accepted: 1, uncertain: 1, pending: 0, busy: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a rejected batch together and keeps later messages behind its cooldown', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 2 })
    const events = [record('declined first'), record('declined second'), record('next batch')]
    const harness = batchSink('batch-cooldown', async () => ({ accepted: false }))
    const acknowledge = vi.spyOn(store, 'acknowledgeHarnessBatch')
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(harness.deliverBatch.mock.calls[0]?.[0].events).toEqual(events.slice(0, 2))
    expect(acknowledge).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()).toMatchObject([
      { event: events[0], status: 'pending', attempts: 1 }, { event: events[1], status: 'pending', attempts: 1 },
      { event: events[2], status: 'pending', attempts: 0 },
    ])
    harness.deliverBatch.mockImplementation(async () => reliableReceipt('accepted-retry'))
    await vi.advanceTimersByTimeAsync(9500)
    expect(harness.deliverBatch.mock.calls.map(([batch]) => batch.events)).toEqual([events.slice(0, 2), events.slice(0, 2), events.slice(2)])
    expect(acknowledge.mock.calls).toEqual([[events.slice(0, 2).map(event => event.eventId), 'accepted-retry'], [[events[2]!.eventId], 'accepted-retry']])
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(store.harnessSummary()).toMatchObject({ accepted: 3 })
  })

  it('protects the entire in-flight batch while overflow discards only pending messages from later batches', async () => {
    const { gateway, store, record } = fixture({ maxQueuedMessages: 4, maxBatchMessages: 2, overflowPolicy: 'drop-oldest' })
    const events = [record('active first'), record('active second'), record('discarded third'), record('discarded fourth')]
    const receipt = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('in-flight-capacity', async batch => batch.events[0]?.eventId === events[0]!.eventId ? receipt.promise : reliableReceipt())
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const next = [record('fifth'), record('sixth')]
    gateway.notify()
    expect(store.getQueuedHarnessEvents().map(item => [item.event.eventId, item.status, item.attempts])).toEqual([
      [events[0]!.eventId, 'delivering', 1], [events[1]!.eventId, 'delivering', 1], [next[0]!.eventId, 'pending', 0], [next[1]!.eventId, 'pending', 0],
    ])
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    receipt.resolve(reliableReceipt())
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch.mock.calls.map(([batch]) => batch.events)).toEqual([events.slice(0, 2), next])
    expect(store.harnessSummary()).toMatchObject({ accepted: 4, discarded: 2, pending: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unregister makes the full in-flight batch uncertain and leaves the next batch unattempted', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 2 })
    const events = [record('active first'), record('active second'), record('not sent')]
    const receipt = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('detached-batch', async () => receipt.promise)
    const unregister = gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    unregister()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(harness.deliverBatch.mock.calls[0]?.[1].aborted).toBe(true)
    expect(store.getQueuedHarnessEvents()).toMatchObject([
      { event: events[0], status: 'uncertain', attempts: 1 }, { event: events[1], status: 'uncertain', attempts: 1 },
      { event: events[2], status: 'pending', attempts: 0 },
    ])
    receipt.resolve(reliableReceipt('late-full-batch'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(store.harnessSummary()).toMatchObject({ accepted: 0, uncertain: 2, pending: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recomputes a waiting quiet deadline when settings extend it', async () => {
    const { gateway, record, configure } = fixture()
    record()
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(200)
    configure({ quietWindowMs: 1000 })
    gateway.reconfigure()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(799)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
  })

  it('recomputes a waiting quiet deadline when settings make it ready now', async () => {
    const { gateway, record, configure } = fixture()
    record()
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(200)
    configure({ quietWindowMs: 100 })
    gateway.reconfigure()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reconfigure preserves an in-flight call while arranging the next batch using current settings', async () => {
    const { gateway, record, configure } = fixture({ maxBatchMessages: 1 })
    const first = record('active')
    const receipt = deferred<HarnessDeliveryReceipt>()
    const harness = batchSink('busy-settings', async batch => batch.events[0]?.eventId === first.eventId ? receipt.promise : reliableReceipt())
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const second = record('next')
    configure({ maxBatchMessages: 10, quietWindowMs: 100, deliveryTimeoutMs: 100 })
    gateway.reconfigure()
    await vi.advanceTimersByTimeAsync(200)
    expect(harness.deliverBatch.mock.calls[0]?.[1].aborted).toBe(false)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    receipt.resolve(reliableReceipt())
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledTimes(2)
    expect(harness.deliverBatch.mock.calls[1]?.[0].events).toEqual([second])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('converts previously exhausted pending items to visible uncertainty after the attempt limit is reduced', async () => {
    const { gateway, record, store, configure } = fixture({ maxBatchMessages: 1 })
    record()
    const harness = batchSink('declined', async () => ({ accepted: false }))
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    configure({ maxDeliveryAttempts: 1 })
    gateway.reconfigure()
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ status: 'uncertain', attempts: 1 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
  })

  it.each(['persistent', 'memory'] as const)('retries a failed %s local acknowledgement with one timer and never invokes the sink again', async storageMode => {
    const { gateway, store, record } = fixture({ storageMode, maxBatchMessages: 1, retryIntervalMs: 100 })
    const event = record()
    const acknowledge = vi.spyOn(store, 'acknowledgeHarnessBatch')
    const harness = batchSink('durable-before-local-failure', async () => {
      executeSql(store, `${failAck}; ${failState}`)
      return reliableReceipt('remote-owner-receipt')
    })
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'delivering', attempts: 1 })
    expect(gateway.getStatus()).toMatchObject({ busy: true, waitingForLocalCommit: true, delivering: 1, accepted: 0, storageRetryAt: Date.now() + 100 })
    expect(gateway.getStatus().lastError).toContain('仅重试本地确认')
    for (let index = 0; index < 5; index++) { gateway.notify(); gateway.reconfigure() }
    await vi.advanceTimersByTimeAsync(99)
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(acknowledge).toHaveBeenCalledTimes(2)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    executeSql(store, 'DROP TRIGGER fail_ack; DROP TRIGGER fail_state')
    await vi.advanceTimersByTimeAsync(100)
    expect(acknowledge).toHaveBeenCalledTimes(3)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(gateway.getStatus()).toMatchObject({ busy: false, waitingForLocalCommit: false, accepted: 1, delivering: 0, storageRetryAt: null, lastError: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['persistent', 'memory'] as const)('backs off a failed %s delivering-state write without calling the sink or spending an attempt', async storageMode => {
    const { gateway, store, record } = fixture({ storageMode, maxBatchMessages: 1, retryIntervalMs: 100 })
    const event = record()
    executeSql(store, failState)
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'pending', attempts: 0 })
    expect(gateway.getStatus()).toMatchObject({ busy: false, waitingForLocalCommit: false, storageRetryAt: Date.now() + 100 })
    for (let index = 0; index < 5; index++) { gateway.notify(); gateway.reconfigure() }
    await vi.advanceTimersByTimeAsync(99)
    expect(harness.deliverBatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    executeSql(store, 'DROP TRIGGER fail_state')
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(gateway.getStatus()).toMatchObject({ accepted: 1, storageRetryAt: null, lastError: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['persistent', 'declined'], ['memory', 'declined'], ['persistent', 'unknown'], ['memory', 'unknown'],
  ] as const)('recovers a failed %s %s outcome write locally before allowing more external delivery', async (storageMode, outcome) => {
    const { gateway, store, record } = fixture({ storageMode, maxBatchMessages: 1, retryIntervalMs: 100 })
    const event = record()
    let calls = 0
    const harness = batchSink('failed-outcome', async () => {
      if (calls++ > 0) return reliableReceipt()
      executeSql(store, failState)
      if (outcome === 'unknown') throw new Error('synthetic receiver failure')
      return { accepted: false }
    })
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'delivering', attempts: 1 })
    expect(gateway.getStatus()).toMatchObject({ busy: true, waitingForLocalCommit: true })
    gateway.notify()
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    executeSql(store, 'DROP TRIGGER fail_state')
    await vi.advanceTimersByTimeAsync(100)
    expect(gateway.getStatus()).toMatchObject({ busy: false, waitingForLocalCommit: false })
    if (outcome === 'declined') {
      expect(harness.deliverBatch).toHaveBeenCalledTimes(2)
      expect(store.getQueuedHarnessEvents()).toEqual([])
      expect(gateway.getStatus()).toMatchObject({ accepted: 1, uncertain: 0 })
    } else {
      expect(harness.deliverBatch).toHaveBeenCalledOnce()
      expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain', attempts: 1 })
      expect(gateway.getStatus()).toMatchObject({ accepted: 0, uncertain: 1 })
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['persistent', 'memory'] as const)('parks the %s receipt when ack and uncertainty writes both fail on detach, then commits it on reattach', async storageMode => {
    const { gateway, store, record } = fixture({ storageMode, maxBatchMessages: 1, retryIntervalMs: 100 })
    const first = record('accepted remotely')
    const harness = batchSink('detached-local-failure', async () => {
      executeSql(store, `${failAck}; ${failState}`)
      return reliableReceipt('parked-durable-receipt')
    })
    const unregister = gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    unregister()
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', busy: true, waitingForLocalCommit: true, delivering: 1 })
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event: first, status: 'delivering', attempts: 1 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    executeSql(store, 'DROP TRIGGER fail_ack; DROP TRIGGER fail_state')
    const replacement = batchSink('replacement')
    gateway.register(replacement)
    await vi.advanceTimersByTimeAsync(0)
    expect(replacement.deliverBatch).not.toHaveBeenCalled()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(gateway.getStatus()).toMatchObject({ accepted: 1, busy: false, waitingForLocalCommit: false })
    const next = record('new message for replacement')
    gateway.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(replacement.deliverBatch).toHaveBeenCalledOnce()
    expect(replacement.deliverBatch.mock.calls[0]?.[0].events).toEqual([next])
    expect(gateway.getStatus()).toMatchObject({ accepted: 2, uncertain: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['notify', 'reconfigure'] as const)('can finish a parked local receipt on explicit %s without attaching a sink or starting a timer', async operation => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1, retryIntervalMs: 100 })
    record()
    const harness = batchSink('parked', async () => {
      executeSql(store, `${failAck}; ${failState}`)
      return reliableReceipt()
    })
    const unregister = gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    unregister()
    executeSql(store, 'DROP TRIGGER fail_ack; DROP TRIGGER fail_state')
    gateway[operation]()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', accepted: 1, busy: false, waitingForLocalCommit: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a detached local acknowledgement failure uncertain when saving uncertainty succeeds', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1, retryIntervalMs: 100 })
    const event = record()
    executeSql(store, failAck)
    const harness = batchSink()
    const unregister = gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    unregister()
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain', attempts: 1 })
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', busy: false, waitingForLocalCommit: false, accepted: 0, uncertain: 1 })
    expect(vi.getTimerCount()).toBe(0)
    executeSql(store, 'DROP TRIGGER fail_ack')
  })

  it.each(['persistent', 'memory'] as const)('commits a parked acknowledgement against the current queue after a %s mode switch', async storageMode => {
    const { gateway, store, record, configure } = fixture({ storageMode, maxBatchMessages: 1, retryIntervalMs: 100 })
    record()
    executeSql(store, failAck)
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    const before = store.getQueuedHarnessEvents()
    configure({ storageMode: storageMode === 'persistent' ? 'memory' : 'persistent' })
    gateway.reconfigure()
    expect(store.getQueuedHarnessEvents()).toEqual(before)
    expect(gateway.getStatus()).toMatchObject({ busy: true, waitingForLocalCommit: true, accepted: 0 })
    executeSql(store, 'DROP TRIGGER fail_ack')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(gateway.getStatus()).toMatchObject({ accepted: 1, busy: false, waitingForLocalCommit: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close finishes despite both local writes failing and the next Store startup retains an uncertain body', async () => {
    const { gateway, store, record } = fixture({ maxBatchMessages: 1, retryIntervalMs: 100 })
    const event = record()
    const harness = batchSink('closing-local-failure', async () => {
      executeSql(store, `${failAck}; ${failState}`)
      return reliableReceipt()
    })
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(0)
    await gateway.close()
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(gateway.getStatus()).toMatchObject({ state: 'not-attached', busy: false, waitingForLocalCommit: false, accepted: 0 })
    expect(store.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'delivering', attempts: 1 })
    expect(vi.getTimerCount()).toBe(0)
    executeSql(store, 'DROP TRIGGER fail_ack; DROP TRIGGER fail_state')
    const reopened = new HostStore(store.databasePath)
    try {
      expect(reopened.getQueuedHarnessEvents()[0]).toMatchObject({ event, status: 'uncertain', attempts: 1 })
      expect(reopened.harnessSummary()).toMatchObject({ accepted: 0, uncertain: 1, delivering: 0 })
    } finally { reopened.close() }
  })

  it.each(['persistent', 'memory'] as const)('does not use an unrelated store mode as a delivery gate (%s storage)', async storageMode => {
    const { gateway, store, record } = fixture({ storageMode })
    store.setSetting('mode', 'rest')
    record()
    const harness = batchSink()
    gateway.register(harness)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.deliverBatch).toHaveBeenCalledOnce()
    expect(store.getQueuedHarnessEvents()).toEqual([])
    expect(gateway.getStatus()).toMatchObject({ accepted: 1, pending: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
