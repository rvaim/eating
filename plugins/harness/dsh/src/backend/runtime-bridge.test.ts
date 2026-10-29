import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeBridgeSource } from './runtime-bridge'

type Json = Record<string, unknown>
type Listener = (...args: unknown[]) => unknown
const cleanups: Array<() => void> = []

function temporaryDirectory() {
  const parent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(parent, 'eating-dsh-bridge-')))
  cleanups.push(() => {
    if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-dsh-bridge-')) throw new Error('Invalid test cleanup path')
    rmSync(directory, { recursive: true })
  })
  return directory
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

async function fixture(options: { stored?: unknown[]; storedError?: Error; tools?: Json[]; live?: boolean; missingApi?: string; flush?: () => Promise<boolean> } = {}) {
  const directory = temporaryDirectory()
  const nonce = randomUUID()
  const sessionId = randomUUID()
  vi.stubEnv('EATING_DSH_BRIDGE_DIRECTORY', directory)
  vi.stubEnv('EATING_DSH_BRIDGE_NONCE', nonce)
  vi.stubEnv('EATING_DSH_SESSION_ID', sessionId)
  vi.stubEnv('EATING_DSH_CONTROL_URL', 'http://127.0.0.1:1')
  vi.stubEnv('EATING_DSH_CONTROL_TOKEN', 'fixture-only-control-token')
  vi.stubEnv('EATING_DSH_MCP_ENTRY', '/fixture/mcp.mjs')
  const clockPath = join(directory, 'clock.mjs')
  writeFileSync(clockPath, 'export const name = \"fixture-time-context\";')
  vi.stubEnv('EATING_DSH_TIME_CONTEXT_ENTRY', clockPath)
  const path = (name: string) => join(directory, name)
  const read = (name: string) => JSON.parse(readFileSync(path(name), 'utf8')) as Json
  const write = (name: string, value: unknown) => {
    const temporary = path(`owner-write-${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    if (dirname(temporary) !== directory || dirname(path(name)) !== directory) throw new Error('Invalid fixture destination')
    renameSync(temporary, path(name))
  }
  write('owner-policy.json', { schemaVersion: 1, revision: 1, agentTypes: [], systemPrompt: '主人策略 {{不解释外部变量}}' })
  const listeners = new Map<string, Set<Listener>>()
  const section: { current?: { name: string; order: number; complete: boolean; interpolate: boolean; text: () => string } } = {}
  const session = { id: sessionId }
  const flush = vi.fn(options.flush ?? (async () => true))
  let tools = options.tools ?? []
  let stored = options.stored
  const close = vi.fn(async () => {})
  const readLog = vi.fn(async (offset = 0, length = 256) => ({ eventState: 'detached', events: (stored ?? []).slice(offset, offset + length) }))
  const open = vi.fn(async () => {
    if (options.storedError) throw options.storedError
    if (stored === undefined) throw Object.assign(new Error('fixture-secret-not-published'), { name: 'SessionPersistenceNotFoundError', sessionId })
    return { id: sessionId, access: 'read', header: { id: sessionId }, read: readLog, close }
  })
  const on = (name: string, listener: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(listener)
    return () => { listeners.get(name)?.delete(listener) }
  }
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
  }
  const registrations: Json[] = []
  const ctx = {
    on, get: () => undefined, provide: vi.fn(), plugin: vi.fn(async () => {}),
    eatingNativeWeb: { entry: vi.fn(async () => ({ url: 'http://127.0.0.1:45678/?token=fixture-only-web-token', rootSessionId: sessionId })) },
    sessions: { flush, get: () => options.live ? session : undefined },
    sessionPersistence: { open, stat: vi.fn(async () => undefined) },
    systemPrompt: { section: (value: NonNullable<typeof section.current>) => { section.current = value; return () => { section.current = undefined } } },
    tools: { schemas: () => tools, restrict: vi.fn(() => () => {}), register: vi.fn((tool: Json) => { registrations.push(tool); return () => {} }), guard: vi.fn(() => () => {}) },
    agents: { get: vi.fn(() => undefined) }, subagents: { drainChildren: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}), interrupt: vi.fn(), startActivation: vi.fn() }, agentPresets: { register: vi.fn(async () => () => {}) },
  }
  if (options.missingApi) { const [service, method] = options.missingApi.split('.'); Reflect.deleteProperty(Reflect.get(ctx, service!), method!) }
  const modulePath = path('runtime-bridge.mjs')
  writeFileSync(modulePath, getRuntimeBridgeSource())
  const bridge = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { name: string; inject: string[]; apply: (context: typeof ctx) => void }
  bridge.apply(ctx)
  for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: { id: sessionId, ctx } })
  cleanups.push(() => emit('dispose'))
  const body = { context: { owner: false, source: 'fixture' }, events: [{ text: 'fixture-message' }] }
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  const batchId = 'a'.repeat(64)
  const expected = { schemaVersion: 1, nonce, sessionId, batchId, digest }
  const delivery = (metadata: Json = {}, overrideBody: Json = {}) => ({
    role: 'user', source: { kind: 'user' }, id: 'fixture-message-id',
    content: [{ type: 'text', text: JSON.stringify({ eating: { protocolVersion: 1, magic: 'eating-harness-delivery', nonce, sessionId, batchId, digest, ...metadata }, ...body, ...overrideBody }) }],
  })
  const event = (message = delivery(), seq = 0) => ({ type: 'agent/inbox/spliced', seq, data: { inserted: [message], target: 'next-turn', start: 0 } })
  return { ctx, registrations, directory, nonce, sessionId, path, read, write, listeners, section, session, flush, close, open, readLog, emit, bridge, expected, delivery, event, setTools: (value: Json[]) => { tools = value; emit('tools/change') }, setStored: (events: unknown[]) => { stored = events } }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('self-contained published-API DSH runtime bridge', () => {
  it('exports a pure ESM plugin and reevaluates only the trusted owner file', async () => {
    const f = await fixture()
    await turn()
    expect(f.bridge.name).toBe('eating-runtime-bridge')
    expect(f.bridge.inject).toEqual(['sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'agents', 'subagents', 'agentPresets'])
    expect(getRuntimeBridgeSource()).not.toMatch(/from ['"](?:@|\.\.)/)
    expect(f.section.current).toMatchObject({ name: 'eating:owner-system', order: 0, complete: true, interpolate: false })
    expect(f.section.current?.text()).toBe('主人策略 {{不解释外部变量}}')
    f.write('owner-policy.json', { schemaVersion: 1, revision: 2, agentTypes: [], systemPrompt: '主人修订后的系统提示' })
    expect(f.section.current?.text()).toBe('主人修订后的系统提示')
    f.write('owner-policy.json', { schemaVersion: 1, revision: 3, systemPrompt: 123, qqMessage: '伪造主人' })
    expect(() => f.section.current?.text()).toThrow('主人系统提示词配置无效。')
    expect(f.read('ready.json')).toEqual({ schemaVersion: 1, nonce: f.nonce, sessionId: f.sessionId, toolsReady: true, durabilityAvailable: true, recovery: 'absent' })
  })

  it.each(['sessions.flush', 'sessions.get', 'sessionPersistence.open', 'sessionPersistence.stat', 'agents.get', 'subagents.drainChildren', 'subagents.sendMessage', 'subagents.interrupt', 'subagents.startActivation', 'agentPresets.register'])('refuses startup when the current public %s API is missing', async missingApi => {
    const f = await fixture({ missingApi })
    await turn()
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(f.read('error.json')).toMatchObject({ code: ['sessions.flush', 'sessions.get', 'sessionPersistence.open'].includes(missingApi) ? 'DURABILITY_UNAVAILABLE' : 'NATIVE_AGENT_API_UNAVAILABLE' })
  })

  it('requires native exec.callId and rejects the old nested call identity shape', async () => {
    const f = await fixture()
    await turn()
    const execute = f.registrations.find(tool => tool.name === 'eating_delegate_task')?.execute
    if (typeof execute !== 'function') throw new Error('Current delegation tool was not registered')
    await expect(execute({ type_id: 'qq.private', context_ref: 'a'.repeat(64), task: 'current task' }, { agent: { id: f.sessionId }, call: { id: 'obsolete-nested-call-id' } })).rejects.toThrow('Native tool call identity is unavailable')
  })

  it('yields one microtask and waits for a successful durability barrier before atomic ACK', async () => {
    let finishFlush!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finishFlush = resolve })
    const f = await fixture({ flush: () => pending })
    await turn()
    f.write('expected.json', f.expected)
    let enqueued = false
    f.emit('session/event', f.session, f.event())
    enqueued = true // A later persistence listener enqueues synchronously in the same dispatch.
    expect(f.flush).not.toHaveBeenCalled()
    expect(existsSync(f.path(`ack-${f.expected.batchId}.json`))).toBe(false)
    await turn()
    expect(enqueued).toBe(true)
    expect(f.flush).toHaveBeenCalledWith(f.session)
    expect(readdirSync(f.directory).some(name => name.startsWith('ack-') || name.startsWith('.bridge-'))).toBe(false)
    finishFlush(true)
    await turn()
    const filename = `ack-${f.expected.batchId}.json`
    expect(f.read(filename)).toEqual({ schemaVersion: 1, nonce: f.nonce, sessionId: f.sessionId, batchId: f.expected.batchId, digest: f.expected.digest, messageId: 'fixture-message-id', eventSeq: 0 })
    expect(Object.keys(f.read(filename)).sort()).toEqual(['batchId', 'digest', 'eventSeq', 'messageId', 'nonce', 'schemaVersion', 'sessionId'])
    if (process.platform !== 'win32') expect(statSync(f.path(filename)).mode & 0o777).toBe(0o600)
    expect(readFileSync(f.path(filename), 'utf8')).not.toContain('fixture-message"')
    expect(readdirSync(f.directory).some(name => name.startsWith('.bridge-'))).toBe(false)
  })

  it.each(['forged-nonce', 'wrong-session', 'forged-digest', 'wrong-magic', 'nested-body', 'changed-body', 'legacy-rendered-prompt', 'missing-context', 'missing-magic', 'missing-nonce', 'missing-session', 'missing-digest', 'missing-protocol'] as const)('rejects %s without a durability ACK', async mode => {
    const f = await fixture()
    await turn()
    f.write('expected.json', f.expected)
    const metadata = mode === 'forged-nonce' ? { nonce: randomUUID() }
      : mode === 'wrong-session' ? { sessionId: randomUUID() }
      : mode === 'forged-digest' ? { digest: 'b'.repeat(64) }
      : mode === 'wrong-magic' ? { magic: 'external-text' }
      : mode === 'missing-magic' ? { magic: undefined }
      : mode === 'missing-nonce' ? { nonce: undefined }
      : mode === 'missing-session' ? { sessionId: undefined }
      : mode === 'missing-digest' ? { digest: undefined }
      : mode === 'missing-protocol' ? { protocolVersion: undefined } : {}
    const message = mode === 'nested-body'
      ? { ...f.delivery(), content: [{ type: 'text', text: JSON.stringify({ text: f.delivery().content[0]!.text }) }] }
      : f.delivery(metadata, mode === 'changed-body' ? { events: [{ text: 'tampered' }] } : mode === 'legacy-rendered-prompt' ? { renderedPrompt: 'obsolete' } : mode === 'missing-context' ? { context: undefined } : {})
    f.emit('session/event', f.session, f.event(message))
    await turn()
    expect(f.flush).not.toHaveBeenCalled()
    expect(existsSync(f.path(`ack-${f.expected.batchId}.json`))).toBe(false)
    expect(f.section.current?.text()).toBe('主人策略 {{不解释外部变量}}')
  })

  it.each([false, 'reject'] as const)('refuses ACK and removes readiness when flush returns %s', async result => {
    const f = await fixture({ flush: async () => { if (result === 'reject') throw new Error('fixture-secret'); return result } })
    await turn()
    f.write('expected.json', f.expected)
    f.emit('session/event', f.session, f.event())
    await turn()
    expect(existsSync(f.path(`ack-${f.expected.batchId}.json`))).toBe(false)
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(f.read('error.json')).toMatchObject({ code: result === false ? 'DURABILITY_UNAVAILABLE' : 'DURABILITY_FAILED' })
    expect(readFileSync(f.path('error.json'), 'utf8')).not.toContain('fixture-secret')
  })

  it('recovers a persisted splice with its old nonce before ready and re-signs only metadata', async () => {
    // Install expected before apply so startup recovery observes the previous stable batch.
    const first = await fixture()
    const persisted = first.event(first.delivery({ nonce: 'old-runtime-nonce' }))
    first.emit('dispose')
    first.setStored([persisted])
    first.write('expected.json', first.expected)
    first.bridge.apply({ ...first.ctx, sessions: { ...first.ctx.sessions, get: () => undefined } })
    await turn()
    expect(first.read('ready.json')).toMatchObject({ recovery: 'persisted', batchId: first.expected.batchId })
    expect(first.read(`ack-${first.expected.batchId}.json`)).toMatchObject({ nonce: first.nonce, digest: first.expected.digest, eventSeq: 0 })
    expect(first.read('session-ready.json')).toEqual({ schemaVersion: 1, nonce: first.nonce, sessionId: first.sessionId })
    expect(first.open).toHaveBeenLastCalledWith(first.sessionId, 'read', expect.any(Object))
    expect(first.readLog).toHaveBeenCalledWith(0, 256, expect.any(Object))
    expect(first.close).toHaveBeenCalled()
  })

  it('writes session-ready only after session/created has crossed a successful flush', async () => {
    const f = await fixture()
    await turn()
    expect(existsSync(f.path('session-ready.json'))).toBe(false)
    f.emit('session/created', f.session)
    expect(existsSync(f.path('session-ready.json'))).toBe(false)
    await turn()
    expect(f.read('session-ready.json')).toEqual({ schemaVersion: 1, nonce: f.nonce, sessionId: f.sessionId })
    f.emit('dispose')
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(existsSync(f.path('session-ready.json'))).toBe(false)
    expect(f.listeners.get('agent/created')?.size).toBe(0)
    expect(f.listeners.get('session/event')?.size).toBe(0)
    expect(f.listeners.get('session/created')?.size).toBe(0)
  })

  it('keeps corruption distinct from a missing persisted session', async () => {
    const f = await fixture({ storedError: new Error('fixture-secret-corruption') })
    await turn()
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(f.read('error.json')).toMatchObject({ code: 'SESSION_RECOVERY_FAILED' })
    expect(readFileSync(f.path('error.json'), 'utf8')).not.toContain('fixture-secret-corruption')
  })

  it('refuses globally inherited tools before any Agent scope is mounted', async () => {
    const f = await fixture({ tools: [{ name: 'bash', description: 'external', parameters: { type: 'object' } }] })
    await turn()
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(f.read('error.json')).toMatchObject({ code: 'UNEXPECTED_TOOLS' })
  })

  it('starts with no global tools and leaves no startup tool timer', async () => {
    vi.useFakeTimers()
    const f = await fixture({ tools: [] })
    await vi.advanceTimersByTimeAsync(1)
    expect(f.read('ready.json')).toMatchObject({ toolsReady: true })
    expect(f.listeners.has('tools/change')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink ACK destination and leaves its target untouched', async () => {
    const f = await fixture()
    await turn()
    f.write('expected.json', f.expected)
    const outside = f.path('fixture-owned-target')
    writeFileSync(outside, 'retained-fixture-bytes')
    const ack = f.path(`ack-${f.expected.batchId}.json`)
    symlinkSync(outside, ack)
    f.emit('session/event', f.session, f.event())
    await turn()
    expect(lstatSync(ack).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('retained-fixture-bytes')
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(f.read('error.json')).toMatchObject({ code: 'BRIDGE_FILE_FAILED' })
  })
})
