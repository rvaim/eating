import type { HarnessMessageSink, JsonObject } from '../../../packages/platform-contract/src/index'
import { HostStore } from './store'

/** A delivery boundary, never an AI loop. No sink means messages stay pending. */
export class HarnessGateway {
  private sink: HarnessMessageSink | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private flushing: Promise<void> | null = null
  private current: AbortController | null = null
  private wakeRequested = false
  private lastError: string | null = null

  constructor(private readonly store: HostStore) {}

  register(sink: HarnessMessageSink): () => void {
    if (this.closed) throw new Error('Harness 消息网关已停止。')
    if (this.sink) throw new Error('同一工作区仅允许一个主要 Harness 接收者。')
    this.sink = sink
    this.notify()
    return () => {
      if (this.sink !== sink) return
      this.sink = null
      this.current?.abort()
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
    }
  }

  getStatus(): JsonObject {
    return { protocolVersion: 1, state: this.sink ? 'attached' : 'not-attached', sinkId: this.sink?.id ?? null, lastError: this.lastError,
      ...this.store.harnessSummary(), note: 'accepted 仅表示 Harness 接受，不表示模型已读或动作完成。' }
  }

  notify(): void {
    if (!this.sink || this.closed) return
    if (this.flushing) { this.wakeRequested = true; return }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.wakeRequested = false
      this.flushing = this.flush().then(() => { this.lastError = null }).catch(() => {
        this.lastError = 'Harness 持久投递发生存储错误，请检查磁盘与运行状态。'
        this.wakeRequested = false
      }).finally(() => {
        this.flushing = null
        if (this.wakeRequested) { this.wakeRequested = false; this.notify() }
      })
    }, 0)
  }

  private async flush(): Promise<void> {
    const sink = this.sink
    if (!sink || this.closed) return
    const pending = this.store.pendingHarnessEvents(20)
    let retry = false
    for (const item of pending) {
      if (this.closed || this.sink !== sink) break
      const controller = new AbortController()
      this.current = controller
      this.store.markHarnessDelivery(item.event.eventId, 'delivering')
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const receipt = await Promise.race([
          sink.deliver(item.event, controller.signal),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, 15000)
          }),
        ])
        if (receipt.accepted) this.store.markHarnessDelivery(item.event.eventId, 'accepted', null, receipt.receiptId ?? null)
        else { this.store.markHarnessDelivery(item.event.eventId, 'pending', 'Harness 明确未接受，等待有限重试。'); retry = true }
      } catch {
        this.store.markHarnessDelivery(item.event.eventId, 'uncertain', '投递结果未知，等待适配器核对，不自动补投。')
      } finally { if (timeout) clearTimeout(timeout); this.current = null }
    }
    if ((retry || pending.length === 20) && this.sink === sink && !this.closed) {
      this.timer = setTimeout(() => { this.timer = null; this.notify() }, 10000)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.current?.abort()
    await this.flushing
    this.sink = null
  }
}
