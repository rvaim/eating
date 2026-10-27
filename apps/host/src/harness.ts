import { createHash } from 'node:crypto'
import type { DeliverySettings, HarnessDeliveryBatch, HarnessDeliveryReceipt, HarnessMessageSink, JsonObject } from '@eating/plugin-sdk'
import { HostStore } from './store'
import type { QueuedHarnessEvent } from './store'

type Registration = { readonly sink: HarnessMessageSink }
type BatchSelection = {
  readonly items: readonly QueuedHarnessEvent[]
  readonly reason: HarnessDeliveryBatch['reason']
  readonly readyAt: number
}
type PendingFinalization = {
  readonly ids: readonly string[]
  readonly error: string | null
} & ({ readonly kind: 'ack'; readonly receiptId: string } | {
  readonly kind: 'mark'
  readonly updates: readonly {
    readonly ids: readonly string[]
    readonly status: 'pending' | 'uncertain'
    readonly error: string
    readonly retryAt: number
  }[]
})

/** A bounded delivery boundary, never an AI loop or a chat archive. */
export class HarnessGateway {
  private registration: Registration | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private flushing: Promise<void> | null = null
  private current: AbortController | null = null
  private wakeRequested = false
  private lastError: string | null = null
  private pendingFinalization: PendingFinalization | null = null
  private storageRetryAt = 0

  constructor(private readonly store: HostStore) {}

  register(sink: HarnessMessageSink): () => void {
    if (this.closed) throw new Error('Harness 消息网关已停止。')
    if (this.registration) throw new Error('同一工作区仅允许一个主要 Harness 接收者。')
    if (typeof sink.deliverBatch !== 'function' && typeof sink.deliver !== 'function') throw new Error('Harness 接收者必须提供 deliverBatch 或 deliver 函数。')
    const registration = { sink }
    this.registration = registration
    this.notify()
    return () => {
      if (this.registration !== registration) return
      this.registration = null
      this.clearTimer()
      this.current?.abort()
      this.settleDetachedFinalization()
    }
  }

  getStatus(): JsonObject {
    const sink = this.registration?.sink
    return {
      protocolVersion: 1, state: sink ? 'attached' : 'not-attached', sinkId: sink?.id ?? null,
      busy: this.current !== null || this.pendingFinalization !== null, waitingForLocalCommit: this.pendingFinalization !== null,
      storageRetryAt: this.storageRetryAt || null,
      deliveryMode: sink ? typeof sink.deliverBatch === 'function' ? 'batch' : 'per-event' : null,
      lastError: this.lastError, ...this.store.harnessSummary(),
      note: 'accepted 仅表示 Harness 已可靠接管正文，不表示模型已读或动作完成。旧 deliver 接口按批内事件逐条递交，不代表一次模型请求。',
    }
  }

  notify(): void {
    if (this.closed) return
    if (!this.registration) {
      if (!this.flushing) this.settleDetachedFinalization()
      return
    }
    if (this.flushing) { this.wakeRequested = true; return }
    this.schedule()
  }

  /** Settings affect the next selection; an in-flight handoff keeps its timeout. */
  reconfigure(): void {
    this.clearTimer()
    this.notify()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    this.clearTimer()
    if (!this.registration || this.closed || this.flushing) return
    let deadline = this.storageRetryAt
    if (!this.pendingFinalization) {
      try {
        const selections = this.selections(this.store.getDeliverySettings(), Date.now())
        if (!selections.length) { this.storageRetryAt = 0; return }
        deadline = Math.max(deadline, Math.min(...selections.map(selection => selection.readyAt)))
      } catch { this.recordStorageFailure(); deadline = this.storageRetryAt }
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.wakeRequested = false
      let succeeded = false
      // Assign flushing before invoking plugin code, which may itself call notify.
      this.flushing = Promise.resolve().then(() => this.flush()).then(() => { succeeded = true }).catch(() => {
        this.recordStorageFailure()
      }).finally(() => {
        this.flushing = null
        const wakeRequested = this.wakeRequested
        this.wakeRequested = false
        // Re-read the queue even when an arrival during delivery lost its notify.
        if (succeeded || wakeRequested || this.storageRetryAt > Date.now()) this.schedule()
      })
    }, Math.max(0, deadline - Date.now()))
  }

  private recordStorageFailure(): void {
    this.lastError = this.pendingFinalization?.kind === 'ack'
      ? 'Harness 已可靠接管，但本地确认保存失败；保留正文，仅重试本地确认，不重新投递。'
      : 'Harness 投递发生存储错误，保留正文并等待有限间隔重试本地保存。'
    if (this.storageRetryAt <= Date.now()) this.storageRetryAt = Date.now() + this.store.getDeliverySettings().retryIntervalMs
  }

  private completeFinalization(): boolean {
    const finalization = this.pendingFinalization
    if (!finalization) return true
    try {
      if (finalization.kind === 'ack') this.store.acknowledgeHarnessBatch(finalization.ids, finalization.receiptId)
      else for (const update of finalization.updates) {
        this.store.markHarnessDeliveryBatch(update.ids, update.status, update.error, null, update.retryAt)
      }
      this.pendingFinalization = null
      this.storageRetryAt = 0
      this.lastError = finalization.error
      return true
    } catch { this.recordStorageFailure(); return false }
  }

  private persistOutcome(finalization: PendingFinalization): boolean {
    this.pendingFinalization = finalization
    const committed = this.completeFinalization()
    if (!committed && (!this.registration || this.closed)) this.settleDetachedFinalization(false)
    return committed
  }

  /** No detached timer: keep one small outcome if both local writes are unavailable. */
  private settleDetachedFinalization(tryCommit = true): void {
    const finalization = this.pendingFinalization
    if (!finalization || (tryCommit && this.completeFinalization())) return
    const error = '本地投递结果保存失败，正文已保留等待核对，不自动补投。'
    try {
      this.store.markHarnessDeliveryBatch(finalization.ids, 'uncertain', error)
      this.pendingFinalization = null
      this.storageRetryAt = 0
      this.lastError = error
    } catch { this.recordStorageFailure() }
  }

  private selections(settings: DeliverySettings, now: number): readonly BatchSelection[] {
    const conversations = new Map<string, QueuedHarnessEvent[]>()
    const exhausted: string[] = []
    for (const item of this.store.getQueuedHarnessEvents()) {
      if (item.status !== 'pending') continue
      if (item.attempts >= settings.maxDeliveryAttempts) { exhausted.push(item.event.eventId); continue }
      const bucket = conversations.get(item.event.conversationId) ?? []
      bucket.push(item)
      conversations.set(item.event.conversationId, bucket)
    }
    if (exhausted.length) this.store.markHarnessDeliveryBatch(exhausted, 'uncertain', 'Harness 明确拒收且已达投递次数上限，保留正文等待主人核对。')
    const selections: BatchSelection[] = []
    for (const bucket of conversations.values()) {
      const first = bucket[0]!
      if (first.nextAttemptAt > now) {
        selections.push({ items: [], reason: 'max-wait', readyAt: first.nextAttemptAt })
        continue
      }
      const items: QueuedHarnessEvent[] = []
      let bytes = 0
      let threshold: { reason: HarnessDeliveryBatch['reason']; at: number } | null = null
      for (const item of bucket) {
        // A rejected head retains its order; newer arrivals cannot bypass its cooldown.
        if (item.nextAttemptAt > now) break
        const eventBytes = Buffer.byteLength(JSON.stringify(item.event), 'utf8')
        if (items.length && eventBytes >= settings.batchTargetBytes) {
          threshold = { reason: 'target-bytes', at: item.enqueuedAt }
          break
        }
        items.push(item)
        bytes += eventBytes
        if (items.length >= settings.maxBatchMessages) { threshold = { reason: 'max-messages', at: item.enqueuedAt }; break }
        if (bytes >= settings.batchTargetBytes) { threshold = { reason: 'target-bytes', at: item.enqueuedAt }; break }
      }
      const last = items[items.length - 1]!
      const quietAt = last.enqueuedAt + settings.quietWindowMs
      const maxWaitAt = first.enqueuedAt + settings.maxWaitMs
      let readyAt = Math.min(quietAt, maxWaitAt)
      let reason: HarnessDeliveryBatch['reason'] = maxWaitAt <= quietAt ? 'max-wait' : 'quiet-window'
      if (threshold && threshold.at <= readyAt) { readyAt = threshold.at; reason = threshold.reason }
      selections.push({ items, reason, readyAt })
    }
    return selections
  }

  private async flush(): Promise<void> {
    const registration = this.registration
    if (!registration || this.closed || this.storageRetryAt > Date.now()) return
    this.storageRetryAt = 0
    if (!this.completeFinalization()) return
    while (this.registration === registration && !this.closed && !this.pendingFinalization) {
      const settings = this.store.getDeliverySettings()
      const now = Date.now()
      const selection = this.selections(settings, now).filter(candidate => candidate.items.length && candidate.readyAt <= now)
        .sort((left, right) => left.items[0]!.sequence - right.items[0]!.sequence)[0]
      if (!selection) return
      const { sink } = registration
      if (typeof sink.deliverBatch === 'function') {
        const events = selection.items.map(item => item.event)
        const batch: HarnessDeliveryBatch = {
          protocolVersion: 1, batchId: createHash('sha256').update(JSON.stringify(events.map(event => event.eventId))).digest('hex'),
          conversationId: events[0]!.conversationId, createdAt: new Date().toISOString(), reason: selection.reason, events,
        }
        await this.deliver(selection.items, registration, settings, signal => sink.deliverBatch!(batch, signal))
      } else {
        for (const item of selection.items) {
          if (this.registration !== registration || this.closed) return
          // A settings/capacity change may remove a selected, still-unsent item.
          const queued = this.store.getQueuedHarnessEvents().find(current => current.event.eventId === item.event.eventId)
          if (!queued || queued.status !== 'pending') continue
          const currentSettings = this.store.getDeliverySettings()
          if (queued.nextAttemptAt > Date.now() || queued.attempts >= currentSettings.maxDeliveryAttempts) break
          const accepted = await this.deliver([queued], registration, currentSettings, signal => sink.deliver!(queued.event, signal))
          if (!accepted) break
        }
      }
    }
  }

  private async deliver(
    items: readonly QueuedHarnessEvent[], registration: Registration, settings: DeliverySettings,
    invoke: (signal: AbortSignal) => Promise<HarnessDeliveryReceipt>,
  ): Promise<boolean> {
    const ids = items.map(item => item.event.eventId)
    this.store.markHarnessDeliveryBatch(ids, 'delivering')
    const controller = new AbortController()
    this.current = controller
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    let receipt: HarnessDeliveryReceipt
    try {
      receipt = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('aborted')
          return invoke(controller.signal)
        }),
        new Promise<never>((_, reject) => {
          abortListener = () => reject(new Error('aborted'))
          controller.signal.addEventListener('abort', abortListener, { once: true })
          timeout = setTimeout(() => { controller.abort() }, settings.deliveryTimeoutMs)
        }),
      ])
    } catch {
      const error = '投递结果未知，等待适配器核对，不自动补投。'
      this.persistOutcome({ kind: 'mark', ids, error, updates: [{ ids, status: 'uncertain', error, retryAt: 0 }] })
      return false
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      if (this.current === controller) this.current = null
    }
    if (this.closed || this.registration !== registration || controller.signal.aborted) {
      const error = '投递被中断，结果未知，不自动补投。'
      this.persistOutcome({ kind: 'mark', ids, error, updates: [{ ids, status: 'uncertain', error, retryAt: 0 }] })
      return false
    }
    if (receipt?.accepted === true && receipt.durable === true && typeof receipt.receiptId === 'string' && receipt.receiptId.trim()) {
      return this.persistOutcome({ kind: 'ack', ids, receiptId: receipt.receiptId, error: null })
    }
    if (receipt?.accepted === false) {
      const currentSettings = this.store.getDeliverySettings()
      const exhausted = items.filter(item => item.attempts + 1 >= currentSettings.maxDeliveryAttempts).map(item => item.event.eventId)
      const retryable = ids.filter(id => !exhausted.includes(id))
      const exhaustedError = 'Harness 明确拒收且已达投递次数上限，保留正文等待主人核对。'
      const retryError = 'Harness 明确未接受，等待有限重试。'
      const updates: Extract<PendingFinalization, { kind: 'mark' }>['updates'][number][] = []
      if (retryable.length) updates.push({ ids: retryable, status: 'pending', error: retryError, retryAt: Date.now() + currentSettings.retryIntervalMs })
      if (exhausted.length) updates.push({ ids: exhausted, status: 'uncertain', error: exhaustedError, retryAt: 0 })
      this.persistOutcome({ kind: 'mark', ids, updates, error: exhausted.length && !retryable.length ? exhaustedError : retryError })
    } else {
      const error = 'Harness 未提供可靠持久交接凭据，保留正文等待核对，不自动补投。'
      this.persistOutcome({ kind: 'mark', ids, error, updates: [{ ids, status: 'uncertain', error, retryAt: 0 }] })
    }
    return false
  }

  async close(): Promise<void> {
    this.closed = true
    this.registration = null
    this.clearTimer()
    this.current?.abort()
    await this.flushing
    this.settleDetachedFinalization()
    this.pendingFinalization = null
    this.storageRetryAt = 0
  }
}
