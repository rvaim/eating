import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) { super(); FakeEventSource.instances.push(this) }
  open() { this.onopen?.(new Event('open')) }
  fail() { this.onerror?.(new Event('error')) }
  emit(data: string) { this.dispatchEvent(new MessageEvent('log', { data })) }
}
const entry = { id: 'log-1', timestamp: '2026-10-27T13:00:00.000Z', level: 'info', event: 'message.received', message: '测试消息', metadata: { senderId: '123' } }

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ csrfToken: 'test-csrf' }), { status: 200 })))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('公开UI SDK临时日志订阅', () => {
  it('取消初始化中的管理动作时不会迟到发送POST', async () => {
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(finish => { resolve = finish }))
    vi.stubGlobal('fetch', fetchMock)
    const { hostRequest } = await import('./api')
    const controller = new AbortController()
    const pending = hostRequest('/settings', { method: 'POST', body: { values: {} }, signal: controller.signal })
    const result = expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', outcome: 'not-sent' })
    controller.abort()
    resolve(new Response(JSON.stringify({ csrfToken: 'test' }), { status: 200 }))
    await result
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/bootstrap')
  })

  it('退订后迟到的初始化不会创建连接', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(finish => { resolve = finish })))
    const { subscribePluginLogs } = await import('./api')
    const stop = subscribePluginLogs('qq', { onEntry: vi.fn() })
    stop()
    resolve(new Response(JSON.stringify({ csrfToken: 'test' }), { status: 200 }))
    await microtasks()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('连接打开后按事件推送，不轮询或读取历史，退订后屏蔽迟到消息', async () => {
    const { subscribePluginLogs } = await import('./api')
    const onEntry = vi.fn(), onState = vi.fn()
    const stop = subscribePluginLogs('qq', { onEntry, onState })
    await microtasks()
    const source = FakeEventSource.instances[0]!
    expect(source.url).toBe('/api/plugins/qq/logs/stream')
    source.open(); source.emit(JSON.stringify(entry))
    expect(onState).toHaveBeenLastCalledWith('connected')
    expect(onEntry).toHaveBeenCalledExactlyOnceWith(entry)
    expect(fetch).toHaveBeenCalledTimes(1)
    stop(); stop(); source.emit(JSON.stringify({ ...entry, id: 'late' }))
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(onEntry).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('连接中断会重新鉴权，取消订阅也取消未发生的重试', async () => {
    const { subscribePluginLogs } = await import('./api')
    const state = vi.fn()
    const stop = subscribePluginLogs('qq', { onEntry: vi.fn(), onState: state })
    await microtasks()
    FakeEventSource.instances[0]!.fail()
    expect(state).toHaveBeenLastCalledWith('reconnecting')
    await vi.advanceTimersByTimeAsync(2000)
    await microtasks()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    FakeEventSource.instances[1]!.fail(); stop()
    await vi.advanceTimersByTimeAsync(20000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('格式不兼容的消息关闭订阅，错误不回显原始内容', async () => {
    const { subscribePluginLogs } = await import('./api')
    const onEntry = vi.fn(), onError = vi.fn()
    const stop = subscribePluginLogs('qq', { onEntry, onError })
    await microtasks()
    const source = FakeEventSource.instances[0]!
    source.emit('secret-not-valid-json')
    expect(source.close).toHaveBeenCalledOnce()
    expect(onEntry).not.toHaveBeenCalled()
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'INVALID_LOG_ENTRY' })
    expect(onError.mock.calls[0]?.[0].message).not.toContain('secret-not-valid-json')
    stop()
  })
})
