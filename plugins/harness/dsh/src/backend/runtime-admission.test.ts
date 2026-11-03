import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDeliveryAdmissionSource } from './runtime-admission'

type Snapshot = { agentId: string; sequence: number; phase: 'idle' | 'busy' }
type Listener = (...args: any[]) => void

async function fixture(controlImplementation?: (operation: string, input: Snapshot) => Promise<void>) {
  vi.useFakeTimers()
  const listeners = new Map<string, Set<Listener>>()
  const releases: (() => void)[] = []
  const initialization = new AbortController()
  const root = { id: 'root', status: 'idle', inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] }, session: { id: 'root' } }
  let current: typeof root | undefined = root
  const ctx = {
    agents: { get: () => current },
    on: (name: string, listener: Listener) => {
      const bucket = listeners.get(name) ?? new Set<Listener>()
      bucket.add(listener)
      listeners.set(name, bucket)
      return () => { bucket.delete(listener) }
    },
  }
  const control = vi.fn(controlImplementation ?? (async () => {}))
  const create = new Function('ctx', 'sessionId', 'releases', 'initialization', 'control', `let disposed = false; let failed = false; ${getDeliveryAdmissionSource()}; return mountDeliveryAdmission;`)
  const mount = create(ctx, root.id, releases, initialization, control) as (agent: typeof root) => Promise<void>
  await mount(root)
  const emit = (name: string, ...args: unknown[]) => { for (const listener of [...listeners.get(name) ?? []]) listener(...args) }
  const settle = () => vi.advanceTimersByTimeAsync(0)
  const stop = () => { initialization.abort(); for (const release of releases.splice(0).reverse()) release() }
  return { root, ctx, control, mount, emit, settle, stop, setCurrent: (agent: typeof root | undefined) => { current = agent } }
}

afterEach(() => { vi.useRealTimers() })

describe('native main delivery admission', () => {
  it('requires native idle and empty inboxes, rather than inferring idle from turn end', async () => {
    const f = await fixture()
    try {
      expect(f.control.mock.lastCall?.[1]).toMatchObject({ phase: 'idle', sequence: 1 })
      f.root.status = 'running'
      f.emit('session/event', f.root.session, { type: 'turn/end' })
      await f.settle()
      expect(f.control.mock.lastCall?.[1].phase).toBe('busy')
      f.root.status = 'idle'
      f.root.inbox.nextTurn.push({})
      f.emit('agent/status', { agent: f.root, status: 'idle' })
      await f.settle()
      expect(f.control.mock.lastCall?.[1].phase).toBe('busy')
      f.root.inbox.nextTurn.length = 0
      f.root.inbox.nextStep.push({})
      await vi.advanceTimersByTimeAsync(500)
      expect(f.control.mock.lastCall?.[1].phase).toBe('busy')
      f.root.inbox.nextStep.length = 0
      f.emit('agent/status', { agent: f.root, status: 'idle' })
      await f.settle()
      expect(f.control.mock.lastCall?.[1].phase).toBe('idle')
    } finally { f.stop() }
  })

  it('samples after the synchronous inbox projection and coalesces event storms', async () => {
    const f = await fixture()
    try {
      const before = f.control.mock.calls.length
      for (let index = 0; index < 100; index++) f.emit('session/event', f.root.session, { type: 'agent/inbox/spliced' })
      f.root.inbox.nextTurn.push({})
      await f.settle()
      expect(f.control).toHaveBeenCalledTimes(before + 1)
      expect(f.control.mock.lastCall?.[1].phase).toBe('busy')
      f.emit('agent/status', { agent: { ...f.root }, status: 'idle' })
      f.emit('session/event', { id: f.root.id }, { type: 'turn/end' })
      await f.settle()
      expect(f.control).toHaveBeenCalledTimes(before + 1)
    } finally { f.stop() }
  })

  it('retries state after transport loss and keeps one request in flight', async () => {
    let releaseGate!: () => void
    const gate = { promise: new Promise<void>(resolve => { releaseGate = resolve }), resolve: () => releaseGate() }
    let calls = 0
    const f = await fixture(async () => { if (++calls === 1) throw new Error('lost'); if (calls === 2) await gate.promise })
    try {
      expect(f.control).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(100)
      expect(f.control).toHaveBeenCalledTimes(2)
      f.root.status = 'running'
      for (let index = 0; index < 10; index++) f.emit('agent/status', { agent: f.root })
      await f.settle()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.control).toHaveBeenCalledTimes(2)
      gate.resolve()
      await f.settle()
      await vi.advanceTimersByTimeAsync(100)
      expect(f.control.mock.lastCall?.[1]).toMatchObject({ phase: 'busy', sequence: 3 })
      f.root.status = 'idle'
      await vi.advanceTimersByTimeAsync(500)
      expect(f.control.mock.lastCall?.[1].phase).toBe('idle')
    } finally { gate.resolve(); f.stop() }
  })

  it('keeps sequence monotonic when the root is replaced and stops old observers', async () => {
    const f = await fixture()
    try {
      const replacement = { ...f.root, session: { id: f.root.id } }
      f.setCurrent(replacement)
      await vi.advanceTimersByTimeAsync(500)
      expect(f.control.mock.lastCall?.[1].phase).toBe('busy')
      await f.mount(replacement)
      expect(f.control.mock.lastCall?.[1]).toMatchObject({ phase: 'idle', sequence: 3 })
      const count = f.control.mock.calls.length
      f.emit('agent/status', { agent: f.root })
      await f.settle()
      expect(f.control).toHaveBeenCalledTimes(count)
      f.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.control).toHaveBeenCalledTimes(count)
    } finally { f.stop() }
  })
})
