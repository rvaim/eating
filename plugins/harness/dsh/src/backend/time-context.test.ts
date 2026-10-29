import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testRuntimeBin } from '../../../../../tests/fixtures/system-dsh'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
interface ClockMessage { readonly source: { readonly kind: string; readonly form?: string }; readonly content: readonly { readonly type: string; readonly text?: string }[] }
interface ClockEvent { readonly time: number; readonly type: string; readonly data: unknown }
interface ClockSession { readonly id: string; readonly header: object; readonly inheritedEventCount: number; append(type: string, data: unknown, opts?: unknown): ClockEvent; snapshotEvents(): readonly ClockEvent[] }
type Decision = { readonly kind: 'continue'; readonly messages: readonly ClockMessage[] } | { readonly kind: 'reject' }
type Hook = (input: { agent: { session: ClockSession }; turn: number; step: number; signal: AbortSignal }, next: () => Promise<Decision>) => Promise<Decision>
async function fixture() {
  const request = createRequire(testRuntimeBin(resolve(runtimeDirectory!)))
  const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(request.resolve(`@deepseek-ai/${name}`)).href)
  const [cordis, projection, time, native, llm] = await Promise.all([load('cordis'), load('dsh-session-projection'), load('dsh-time-context'), load('dsh-session'), load('dsh-llm')])
  let now = Date.parse('2026-10-29T12:00:00Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const context = async () => {
    const ctx = new cordis.Context(); stops.push(() => ctx.fiber.dispose())
    await ctx.plugin(projection.default)
    let hook: Hook | undefined
    const on = (event: string, listener: Hook, options: object) => { expect(event).toBe('agent/pre-step'); expect(options).toEqual({ prepend: true }); hook = listener }
    // Public apply plus the real projection service. No Agent registry/loop is started.
    time.apply({ sessionProjections: ctx.sessionProjections, on }, { timeZone: 'Asia/Shanghai' })
    if (!hook) throw new Error('Official clock did not install its pre-step hook')
    const run = async (session: ClockSession, turn: number, step: number, decision: Decision = { kind: 'continue', messages: [] }, signal = new AbortController().signal) => hook!({ agent: { session }, turn, step, signal }, async () => decision)
    return { run, projections: ctx.sessionProjections }
  }
  const session = (): ClockSession => native.Session.create(randomUUID())
  const start = (session: ClockSession, turn: number) => {
    session.append('turn/start', { turn })
    session.append('user/message', llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'an existing scheduled step, not a background wakeup' }] }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
  }
  const commit = (session: ClockSession, decision: Decision) => { if (decision.kind === 'continue') for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' }) }
  return { time, native, llm, context, session, start, commit, setTime: (value: number) => { now = value }, getTime: () => now }
}

// Only official time-context and public projection/session APIs execute. No timers,
// Agent/model processes, user profiles, or provider requests are needed.
describe.runIf(Boolean(runtimeDirectory))('official scoped time-context contract', () => {
  it('requires the native services and appends a source-attributed user context after existing messages', async () => {
    const f = await fixture(), ctx = await f.context(), session = f.session()
    expect(f.time.inject).toEqual(['agents', 'sessionProjections'])
    f.start(session, 1)
    session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('STABLE-SYSTEM-PREFIX') }, { surfaceOp: 'append' })
    const original = session.snapshotEvents().filter(event => event.type === 'system/message')
    const result = await ctx.run(session, 1, 1)
    expect(result.kind).toBe('continue')
    if (result.kind !== 'continue') throw new Error('Unexpected clock rejection')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.source).toMatchObject({ kind: 'time-context', form: 'snapshot' })
    expect(JSON.stringify(result.messages[0]?.content)).toContain('2026-10-29T20:00:00+08:00[Asia/Shanghai]')
    f.commit(session, result)
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'user/message', data: { source: { kind: 'time-context' } } })
    expect(session.snapshotEvents().filter(event => event.type === 'system/message')).toEqual(original)
    expect(ctx.projections.stateOf(session, 'timeContext').lastInjectionTime).toBe(f.getTime())
  })

  it('uses the native 600000ms threshold across task boundaries and keeps child sessions independent', async () => {
    const f = await fixture(), rootContext = await f.context(), childContext = await f.context(), root = f.session(), child = f.session()
    f.start(root, 1)
    f.commit(root, await rootContext.run(root, 1, 1))
    const first = f.getTime()
    root.append('step/end', { turn: 1, step: 1 }); root.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.setTime(first + 599999); f.start(root, 2)
    expect(await rootContext.run(root, 2, 1)).toEqual({ kind: 'continue', messages: [] })
    f.start(child, 1)
    const childResult = await childContext.run(child, 1, 1)
    expect(childResult.kind === 'continue' && childResult.messages).toHaveLength(1)
    f.commit(child, childResult)
    f.setTime(first + 600000)
    const refreshed = await rootContext.run(root, 2, 2)
    expect(refreshed.kind === 'continue' && refreshed.messages).toHaveLength(1)
    f.commit(root, refreshed)
    expect(await rootContext.run(root, 2, 3)).toEqual({ kind: 'continue', messages: [] })
    expect(await childContext.run(child, 1, 2)).toEqual({ kind: 'continue', messages: [] })
    expect(root.snapshotEvents().filter(event => event.type === 'user/message' && (event.data as ClockMessage).source.kind === 'time-context')).toHaveLength(2)
  })

  it('reconstructs the latest injection from durable events after a cold restore instead of injecting again', async () => {
    const f = await fixture(), live = await f.context(), session = f.session()
    f.start(session, 1); f.commit(session, await live.run(session, 1, 1))
    const injectedAt = f.getTime()
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const cold = f.native.Session.create(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount) as ClockSession
    const restored = await f.context()
    f.setTime(injectedAt + 42); f.start(cold, 2)
    expect(restored.projections.stateOf(cold, 'timeContext')).toMatchObject({ lastInjectionTime: injectedAt, lastTurnInjectionTime: null })
    expect(await restored.run(cold, 2, 1)).toEqual({ kind: 'continue', messages: [] })
    expect(cold.snapshotEvents().filter(event => event.type === 'user/message' && (event.data as ClockMessage).source.kind === 'time-context')).toHaveLength(1)
  })

  it('leaves rejected and aborted steps untouched and does no background injection while idle', async () => {
    const f = await fixture(), ctx = await f.context(), session = f.session()
    f.start(session, 1)
    const before = session.snapshotEvents()
    f.setTime(f.getTime() + 600001)
    expect(session.snapshotEvents()).toEqual(before)
    expect(await ctx.run(session, 1, 1, { kind: 'reject' })).toEqual({ kind: 'reject' })
    const aborted = new AbortController(); aborted.abort()
    expect(await ctx.run(session, 1, 1, { kind: 'continue', messages: [] }, aborted.signal)).toEqual({ kind: 'continue', messages: [] })
    expect(session.snapshotEvents()).toEqual(before)
    expect(ctx.projections.stateOf(session, 'timeContext').lastInjectionTime).toBeNull()
  })
})
