import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getContactRuntimeSource } from './contact-runtime'

type Value = Record<string, any>
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture(start?: Promise<{ id: string }>, autonomous = false) {
  const listeners = new Map<string, ((...args: any[]) => any)[]>(), tools = new Map<string, Value>(), releases: (() => void)[] = []
  const signal = new AbortController(), initialization = new AbortController()
  const agent: Value = { id: 'root', session: { id: 'root' }, ctx: { tools: { register: (tool: Value) => tools.set(tool.name, tool) }, systemPrompt: { section: vi.fn() } } }
  const ctx = { agents: { get: () => agent }, logger: { warn: vi.fn() }, on: (name: string, fn: (...args: any[]) => any, options?: { prepend?: boolean }) => {
    const entries = listeners.get(name) ?? []; options?.prepend ? entries.unshift(fn) : entries.push(fn); listeners.set(name, entries); return () => {}
  } }
  const control = vi.fn(async (operation: string, body: Value, transportSignal: AbortSignal) => {
    transportSignal.throwIfAborted()
    if (operation === 'contact-turn-start') {
      if (!start) return { id: 'turn-' + body.turn }
      return new Promise<{ id: string }>((resolve, reject) => {
        const abort = () => reject(transportSignal.reason)
        transportSignal.addEventListener('abort', abort, { once: true })
        start.then(value => { transportSignal.removeEventListener('abort', abort); resolve(value) }, error => { transportSignal.removeEventListener('abort', abort); reject(error) })
      })
    }
    if (operation === 'contact-targets') return { targets: [{ id: 'approved', targetId: '200' }] }
    if (operation === 'prepare-proactive') return { agentId: 'child', agentTypeId: 'qq.private', label: 'Approved child', contextRef: 'context', scope: { targetId: '200' }, mode: body.mode }
    return { ended: true }
  })
  const runDelegation = vi.fn(async () => ({ childId: 'child', status: 'completed', actions: [] }))
  const context = { sessionId: 'root', ctx, releases, initialization, disposed: false, failed: false, control, runDelegation, createHash,
    autonomyDriver: autonomous ? { agent, flight: { entered: true, turn: 1, cycle: { id: 'autonomous-cycle' } } } : undefined,
    record: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value), opaque: (value: unknown) => typeof value === 'string' && value.length > 0 }
  const mount = new Function(...Object.keys(context), getContactRuntimeSource() + '\nreturn mountContacts;')(...Object.values(context)) as (agent: Value) => Promise<string[]>
  await mount(agent)
  const admit = (turn = 1, kind = 'eating-external', rejected = false, empty = false) => listeners.get('agent/pre-step')![0]!({ agent, turn, signal: signal.signal }, async () => rejected ? { kind: 'reject' } : { kind: 'enter', messages: empty ? [] : [{ id: 'message', source: { kind } }] })
  const execute = (name: string, args: Value = {}) => tools.get(name)!.execute(args, { agent, signal: signal.signal, callId: 'native-call-id' })
  const event = (turn: number, reason = 'completed', session = agent.session) => { for (const fn of listeners.get('session/event') ?? []) fn(session, { type: 'turn/end', data: { turn, reason: { kind: reason } } }) }
  return { agent, signal, initialization, control, runDelegation, admit, execute, event, listeners, close: () => { for (const release of releases) release(); initialization.abort() } }
}

describe('main Agent contact turn authority', () => {
  it.each(['eating-external', 'user', 'native-goal', 'eating-autonomy'])('allows contact from %s and reuses one authority across the native turn', async source => {
    const f = await fixture(undefined, source === 'eating-autonomy')
    try {
      await f.admit(1, source)
      await f.execute('eating_list_contact_targets')
      await f.admit(1, source, false, true)
      await f.execute('eating_contact_target', { mode: 'reply', target_id: 'approved', task: 'Contact this approved private target.' })
      expect(f.control.mock.calls.filter(call => call[0] === 'contact-turn-start')).toHaveLength(1)
      expect(f.control).toHaveBeenCalledWith('contact-turn-start', { agentId: 'root', turn: 1, autonomyCycleId: source === 'eating-autonomy' ? 'autonomous-cycle' : null }, expect.any(AbortSignal))
      expect(f.control).toHaveBeenCalledWith('prepare-proactive', expect.objectContaining({ cycleId: 'turn-1', targetId: 'approved', mode: 'reply' }), expect.any(AbortSignal))
      expect(f.runDelegation).toHaveBeenCalledOnce()
    } finally { f.close(); await settle() }
  })
  it('does not register authority for rejected or empty initial admissions', async () => {
    const f = await fixture()
    try { await f.admit(1, 'user', true); await f.admit(1, 'user', false, true); expect(f.control).not.toHaveBeenCalled(); await expect(f.execute('eating_list_contact_targets')).rejects.toThrow('current main Agent turn') }
    finally { f.close(); await settle() }
  })
  it.each(['completed', 'aborted', 'error', 'blocked'])('revokes on %s turn end even when the turn signal remains live', async reason => {
    const f = await fixture()
    try {
      await f.admit(1)
      f.event(1, reason)
      expect(f.signal.signal.aborted).toBe(false)
      await expect(f.execute('eating_list_contact_targets')).rejects.toThrow('current main Agent turn')
      await settle()
      expect(f.control).toHaveBeenCalledWith('contact-turn-end', { agentId: 'root', turn: 1, cycleId: 'turn-1' }, expect.any(AbortSignal))
      await f.admit(2)
      f.event(1)
      await f.execute('eating_list_contact_targets')
      expect(f.control).toHaveBeenCalledWith('contact-targets', { agentId: 'root', cycleId: 'turn-2' }, expect.any(AbortSignal))
    } finally { f.close(); await settle() }
  })
  it('closes an accepted start whose response arrives after cancellation instead of publishing it', async () => {
    const pending = deferred<{ id: string }>(), f = await fixture(pending.promise)
    const admission = f.admit(1)
    await settle()
    f.signal.abort()
    pending.resolve({ id: 'late-turn' })
    await expect(admission).rejects.toThrow('ended during admission')
    await settle()
    expect(f.control).toHaveBeenCalledWith('contact-turn-end', { agentId: 'root', turn: 1, cycleId: 'late-turn' }, expect.any(AbortSignal))
    await expect(f.execute('eating_list_contact_targets')).rejects.toThrow('current main Agent turn')
    f.close(); await settle()
  })
  it('cleans an uncertain accepted start after bridge failure with a cleanup signal independent of initialization', async () => {
    const pending = deferred<{ id: string }>(), f = await fixture(pending.promise)
    const admission = f.admit(1)
    await settle()
    f.initialization.abort(new Error('bridge failed'))
    await expect(admission).rejects.toThrow('bridge failed')
    await settle()
    expect(f.control).toHaveBeenCalledWith('contact-turn-end', { agentId: 'root', turn: 1, cycleId: null }, expect.any(AbortSignal))
    const end = f.control.mock.calls.find(call => call[0] === 'contact-turn-end')!
    expect(end[2].aborted).toBe(false)
    await expect(f.execute('eating_list_contact_targets')).rejects.toThrow('current main Agent turn')
    f.close(); await settle()
  })
  it('ignores another same-id session object and revokes the exact root instance on dispose', async () => {
    const f = await fixture()
    try {
      await f.admit(1)
      f.event(1, 'completed', { id: 'root' })
      await f.execute('eating_list_contact_targets')
      for (const fn of f.listeners.get('agent/disposed') ?? []) fn({ agent: f.agent })
      await expect(f.execute('eating_list_contact_targets')).rejects.toThrow('current main Agent turn')
    } finally { f.close(); await settle() }
  })
})
