import { describe, expect, it, vi } from 'vitest'
import { getMemoryRuntimeSource } from './memory-runtime'

type Json = Record<string, unknown>
type Listener = (...input: unknown[]) => unknown
type Decision = { kind: 'reject' } | { kind: 'enter'; messages: Json[]; startsRequestSeries?: true }
async function fixture() {
  const listeners = new Map<string, Listener[]>(), agent = { id: 'root' }
  const ctx = { logger: { warn: vi.fn() }, on(name: string, fn: Listener, options?: { prepend?: boolean }) { const list = listeners.get(name) ?? []; options?.prepend ? list.unshift(fn) : list.push(fn); listeners.set(name, list); return () => { const n = list.indexOf(fn); if (n >= 0) list.splice(n, 1) } } }
  const control = vi.fn(async (_name: string, _body: Json, _signal?: AbortSignal) => ({ text: 'Recalled historical text' }))
  const source = `export function factory(ctx, control) { const releases=[], initialization=new AbortController(), nonce='nonce',sessionId='root',disposed=false,failed=false; const readExpected=()=>undefined,identifyCurrentDelivery=()=>false; const lastText=blocks=>Array.isArray(blocks)?blocks.filter(b=>b.type==='text').map(b=>b.text).join(''):''; const loadModule=async()=>({createUserMessage:value=>({...value,id:'memory-injection',role:'user'})}); ${getMemoryRuntimeSource()} return mountMemory; }`
  const loaded = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')) as { factory: (ctx: unknown, control: unknown) => (agent: unknown) => Promise<void> }
  const mount = loaded.factory(ctx, control)
  async function dispatch(decision: Decision): Promise<Decision> {
    const hooks = listeners.get('agent/pre-step') ?? []
    const call = async (index: number): Promise<Decision> => index === hooks.length ? decision : await hooks[index]!({ agent, turn: 1, signal: new AbortController().signal }, () => call(index + 1)) as Decision
    return call(0)
  }
  function event(type: string, data: Json) { for (const listener of listeners.get('session/event') ?? []) listener({ id: 'root' }, { type, data }) }
  return { ctx, control, agent, mount, dispatch, event }
}
const human = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Actual native input' }] }

describe('native memory admission and capture boundaries', () => {
  it('waits for a downstream rejection and never wakes a rejected autonomous opportunity with recalled content', async () => {
    const f = await fixture()
    f.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    await f.mount(f.agent)
    expect(await f.dispatch({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'eating-autonomy' }, content: [] }] })).toEqual({ kind: 'reject' })
    expect(f.control).not.toHaveBeenCalled()
  })
  it('preserves request-series decisions and excludes injected context/inner reasoning from capture', async () => {
    const f = await fixture(); await f.mount(f.agent)
    const decision = await f.dispatch({ kind: 'enter', messages: [human], startsRequestSeries: true })
    expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true, messages: [human, { source: { kind: 'plugin:eating-memory' } }] })
    f.event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'PRIVATE-INNER-REASONING' }, { type: 'text', text: 'Visible final text' }] } })
    f.event('tool/call', { callId: 'c1', name: 'fixture_tool', arguments: '{"secret":"PRIVATE-TOOL-ARGS"}' })
    f.event('tool/result', { message: { source: { callId: 'c1' }, isError: true, content: [{ type: 'text', text: 'PRIVATE-RAW-RESULT' }] } })
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledTimes(2))
    const last = f.control.mock.calls[1]!
    expect(last[0]).toBe('memory-finish')
    expect(last[1]).toMatchObject({ assistantText: 'Visible final text', actions: [{ tool: 'fixture_tool', outcome: 'failed' }] })
    expect(JSON.stringify(last[1])).not.toMatch(/PRIVATE-|Recalled historical text/)
  })
  it('appends later admitted native steering while retaining original turn capture state', async () => {
    const f = await fixture(); await f.mount(f.agent)
    await f.dispatch({ kind: 'enter', messages: [{ ...human, id: 'first-user' }] })
    const steering = { ...human, id: 'second-user', content: [{ type: 'text', text: 'Additional steering during tool run' }] }
    await f.dispatch({ kind: 'enter', messages: [steering] })
    await f.dispatch({ kind: 'enter', messages: [steering] })
    expect(f.control.mock.calls.map(call => call[0])).toEqual(['memory-start', 'memory-append'])
    expect(f.control.mock.calls[1]![1]).toMatchObject({ messages: [{ messageId: 'second-user', text: 'Additional steering during tool run' }] })
    f.event('assistant/message', { message: { content: [{ type: 'text', text: 'Visible completion after steering' }] } })
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledTimes(3))
    expect(f.control.mock.calls[2]![1]).toMatchObject({ assistantText: 'Visible completion after steering' })
  })

  it('records real delegated Host receipt outcomes while excluding result payloads and prose claims', async () => {
    const f = await fixture(); await f.mount(f.agent); await f.dispatch({ kind: 'enter', messages: [human] })
    f.event('tool/call', { callId: 'c2', name: 'eating_delegate_task', arguments: '{}' })
    f.event('tool/result', { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: JSON.stringify({ actions: [{ tool: 'qq_send_private_message', outcome: 'succeeded', result: { private: 'PRIVATE-PAYLOAD' } }], summary: 'PRIVATE-SUMMARY' }) }] } })
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledTimes(2))
    const result = f.control.mock.calls[1]![1]
    expect(result).toMatchObject({ actions: [{ tool: 'eating_delegate_task', outcome: 'returned' }, { tool: 'qq_send_private_message', outcome: 'succeeded' }] })
    expect(JSON.stringify(result)).not.toContain('PRIVATE-')
  })

  it('does not trigger a search for a purely synthetic step', async () => {
    const f = await fixture(); await f.mount(f.agent)
    const input: Decision = { kind: 'enter', messages: [{ source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Clock' }] }] }
    expect(await f.dispatch(input)).toBe(input)
    expect(f.control).not.toHaveBeenCalled()
  })
})
