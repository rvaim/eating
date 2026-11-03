import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeBridgeSource } from './runtime-bridge'

type Json = Record<string, unknown>
type Listener = (...args: unknown[]) => unknown
type Admission = { kind: 'reject' } | { kind: 'enter'; messages: Json[]; startsRequestSeries?: true }
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
const rootBatchId = 'a'.repeat(64)
const createdAt = '2026-11-03T00:00:00.000Z'
type ConversationScope = { pluginId: string; platform: string; instanceId: string; accountId: string; conversationId: string; kind: 'private' | 'group'; targetId: string }
const conversationScope = (kind: 'private' | 'group' = 'private'): ConversationScope => ({ pluginId: 'qq', platform: 'qq', instanceId: 'fixture-instance', accountId: '100', conversationId: `qq:100:${kind}:200`, kind, targetId: '200' })
function conversationContexts(scopes: ConversationScope[]) {
  return scopes.map(scope => ({ ...scope, contextRef: scopes.length === 1 ? rootBatchId : createHash('sha256').update(JSON.stringify([rootBatchId, scope.pluginId, scope.instanceId, scope.accountId, scope.conversationId, scope.kind, scope.targetId])).digest('hex'), agentTypeId: `qq.${scope.kind}`, createdAt, reason: 'quiet-window', ownerRevision: 1 }))
}
function batchBody(conversations: ReturnType<typeof conversationContexts>, events: Json[]) {
  return { context: { contextRef: rootBatchId, createdAt, reason: 'quiet-window', ownerRevision: 1, conversations }, events }
}

async function fixture(options: { stored?: unknown[]; storedError?: Error; tools?: Json[]; live?: boolean; missingApi?: string; flush?: () => Promise<boolean>; body?: { context: Json; events: Json[] } } = {}) {
  const directory = temporaryDirectory()
  const nonce = randomUUID()
  const sessionId = randomUUID()
  vi.stubEnv('EATING_DSH_BRIDGE_DIRECTORY', directory)
  vi.stubEnv('EATING_DSH_BRIDGE_NONCE', nonce)
  vi.stubEnv('EATING_DSH_SESSION_ID', sessionId)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ capabilities: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  vi.stubEnv('EATING_DSH_CONTROL_URL', 'http://127.0.0.1:1')
  vi.stubEnv('EATING_DSH_CONTROL_TOKEN', 'fixture-only-control-token')
  const mcpPath = join(directory, 'mcp.mjs')
  writeFileSync(mcpPath, 'export const name = "fixture-mcp";')
  vi.stubEnv('EATING_DSH_MCP_ENTRY', mcpPath)
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
  const defaultConversation = conversationContexts([conversationScope()])
  const body = options.body ?? batchBody(defaultConversation, [{ ...conversationScope(), source: { trust: 'external', kind: 'private' }, text: 'fixture-message' }])
  const conversations = body.context.conversations as ReturnType<typeof conversationContexts>
  write('owner-policy.json', { schemaVersion: 1, revision: 1, agentTypes: [], systemPrompt: '主人策略 {{不解释外部变量}}', contextRef: rootBatchId,
    bindings: conversations.map(conversation => ({ contextRef: conversation.contextRef, agentId: randomUUID(), agentTypeId: conversation.agentTypeId, label: 'Fixture child' })) })
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
    eatingNativeCapabilities: { ready: vi.fn(async () => {}), allowedGlobal: vi.fn(() => []), restrict: vi.fn(), mount: vi.fn(async () => []), reportTools: vi.fn(), authorize: vi.fn() },
    sessions: { flush, get: () => options.live ? session : undefined },
    sessionPersistence: { open, stat: vi.fn(async (): Promise<{ header: { parentSession: string } } | undefined> => undefined) },
    systemPrompt: { section: (value: NonNullable<typeof section.current>) => { if (value.name === 'eating:owner-system') section.current = value; return () => { if (section.current === value) section.current = undefined } } },
    tools: { schemas: () => tools, restrict: vi.fn(() => () => {}), register: vi.fn((tool: Json) => { registrations.push(tool); return () => {} }), guard: vi.fn(() => () => {}) },
    agents: { get: vi.fn((_id: string): unknown => undefined) }, subagents: { drainChildren: vi.fn(async () => {}), sendMessage: vi.fn(async (..._args: unknown[]) => {}), interrupt: vi.fn(), startActivation: vi.fn() }, agentPresets: { register: vi.fn(async () => () => {}) },
  }
  const agent = { id: sessionId, session, ctx, status: 'idle', inbox: { nextTurn: [] as Json[], nextStep: [] as Json[] } }
  ctx.agents.get.mockImplementation(id => id === sessionId ? agent : undefined)
  if (options.missingApi) { const [service, method] = options.missingApi.split('.'); Reflect.deleteProperty(Reflect.get(ctx, service!), method!) }
  const modulePath = path('runtime-bridge.mjs')
  writeFileSync(modulePath, getRuntimeBridgeSource())
  const bridge = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { name: string; inject: string[]; apply: (context: typeof ctx) => void }
  bridge.apply(ctx)
  for (const listener of listeners.get('agent/created') ?? []) await listener({ agent })
  cleanups.push(() => emit('dispose'))
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  const batchId = rootBatchId
  const expected = { schemaVersion: 1, nonce, sessionId, batchId, digest }
  const delivery = (metadata: Json = {}, overrideBody: Json = {}) => ({
    role: 'user', source: { kind: 'user' }, id: 'fixture-message-id',
    content: [{ type: 'text', text: JSON.stringify({ eating: { protocolVersion: 1, magic: 'eating-harness-delivery', nonce, sessionId, batchId, digest, ...metadata }, ...body, ...overrideBody }) }],
  })
  const event = (message = delivery(), seq = 0) => ({ type: 'agent/inbox/spliced', seq, data: { inserted: [message], target: 'next-turn', start: 0 } })
  const admit = async (messages: Json[], agentId: string = sessionId, terminal: Admission = { kind: 'enter', messages }): Promise<Admission> => {
    const hooks = [...(listeners.get('agent/pre-step') ?? [])]
    const dispatch = async (index: number): Promise<Admission> => index === hooks.length ? terminal : await hooks[index]!({ agent: { id: agentId }, messages }, () => dispatch(index + 1)) as Admission
    return dispatch(0)
  }
  return { ctx, agent, body, registrations, directory, nonce, sessionId, path, read, write, listeners, section, session, flush, close, open, readLog, emit, bridge, expected, delivery, event, admit, setTools: (value: Json[]) => { tools = value; emit('tools/change') }, setStored: (events: unknown[]) => { stored = events } }
}

async function conversationFixture(kind: 'private' | 'group' = 'private', scopes = [conversationScope(kind)]) {
  const conversations = conversationContexts(scopes)
  const events = [
    { messageId: 'message-one', senderId: '200', senderRole: 'user', text: '你记得我喜欢的颜色吗？', resourceIds: [] },
    { messageId: 'message-two', senderId: '200', senderRole: 'user', text: '照刚才聊的画一只小猫', resourceIds: ['received-image'], content: [{ type: 'image', data: { file: 'received-image' } }], extra: { original: '原始字段保持' } },
  ].flatMap(event => scopes.map((scope, index) => ({ ...scope, ...event, messageId: `${event.messageId}-${index}`, source: { trust: 'external', kind: scope.kind, senderRole: 'user' } })))
  const body = batchBody(conversations, events)
  const f = await fixture({ body })
  await turn()
  const bindings = conversations.map(conversation => ({ contextRef: conversation.contextRef, agentId: randomUUID(), agentTypeId: conversation.agentTypeId, label: `QQ ${conversation.kind} ${conversation.accountId} ${conversation.targetId} child` }))
  const binding = bindings[0]!
  f.write('owner-policy.json', { ...f.read('owner-policy.json'), systemPrompt: 'OWNER-MAIN-OVERRIDE\nOWNER-PERSONA', contextRef: f.expected.batchId, bindings,
    agentTypes: [...new Map(bindings.map(entry => [entry.agentTypeId, { id: entry.agentTypeId, title: entry.label, description: 'Bound conversation', enabled: true }])).values()] })
  f.write('expected.json', f.expected)
  f.emit('session/event', f.session, f.event())
  await turn()
  await f.admit([f.delivery()])
  const requests: Array<{ operation: string; body: Json }> = []
  const actions = [{ tool: kind === 'private' ? 'qq_send_private_message' : 'qq_send_group_message', targetId: '200', outcome: 'succeeded', requestId: 'real-host-receipt' }]
  vi.mocked(fetch).mockImplementation(async (url, input) => {
    const operation = String(url).split('/').at(-1)!
    if (operation === 'delivery-state') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    const requestBody = JSON.parse(String(input?.body)) as Json
    requests.push({ operation, body: requestBody })
    const selected = bindings.find(entry => entry.agentId === requestBody.agentId)
    const configuration = selected && { agentId: selected.agentId, agentTypeId: selected.agentTypeId, systemPrompt: 'OWNER-CHILD-OVERRIDE\nOWNER-PERSONA', mode: 'reply', mcp: { url: 'http://127.0.0.1:1/mcp', headers: {} }, tools: [], capabilities: [] }
    const value = operation === 'prepare-task' ? configuration : operation === 'actions' ? { actions } : operation === 'finish-task' ? { ok: true } : undefined
    if (!value) throw new Error(`Unexpected fixture control operation: ${operation}`)
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const availableChildren = new Set<string>()
  const childSections = bindings.map(() => ({} as { current?: { name: string; complete: boolean; text: () => string } }))
  const children = bindings.map((entry, index) => ({ id: entry.agentId, session: { id: entry.agentId }, ctx: {
    systemPrompt: { section: (value: NonNullable<typeof childSections[number]['current']>) => { childSections[index]!.current = value } },
    plugin: vi.fn(async () => {}), tools: { schemas: () => [], guard: vi.fn() },
  } }))
  const child = children[0]!, childSection = childSections[0]!
  f.ctx.agents.get.mockImplementation(id => id === f.sessionId ? f.agent : availableChildren.has(id) ? children.find(entry => entry.id === id) : undefined)
  const mount = async (childId: string) => {
    const selected = children.find(entry => entry.id === childId)
    if (!selected) throw new Error('Unknown fixture child')
    availableChildren.add(childId)
    for (const listener of f.listeners.get('agent/created') ?? []) await listener({ agent: selected })
  }
  const terminal = { stopReason: 'completed', output: [{ type: 'text', text: 'CHILD-INDEPENDENT-REPLY：已根据会话和工具结果处理。' }] }
  const activation = { result: Promise.resolve(terminal), dispose: vi.fn(async () => {}) }
  f.ctx.subagents.startActivation.mockImplementation(async (...args: unknown[]) => { await mount((args[0] as { childId: string }).childId); return activation })
  f.ctx.subagents.sendMessage.mockImplementation(async (...args: unknown[]) => { const childId = String(args[1]); await mount(childId); f.emit('subagent/end', { id: childId, local: true, stopReason: terminal.stopReason, lastAssistantMessage: terminal.output }) })
  const execute = (name: string, args: unknown, callId = 'native-conversation-call', overrides: Json = {}) => {
    const tool = f.registrations.find(tool => tool.name === name)
    if (typeof tool?.execute !== 'function') throw new Error(`Missing fixture tool: ${name}`)
    return tool.execute(args, { agent: f.agent, signal: new AbortController().signal, callId, ...overrides }) as Promise<Json>
  }
  return { ...f, body, conversations, bindings, binding, child, childSection, terminal, activation, actions, requests, execute }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('self-contained published-API DSH runtime bridge', () => {
  it('exports a pure ESM plugin and reevaluates only the trusted owner file', async () => {
    const f = await fixture()
    await turn()
    expect(f.bridge.name).toBe('eating-runtime-bridge')
    expect(f.bridge.inject).toEqual(['sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'agents', 'subagents', 'agentPresets', 'eatingNativeWeb', 'eatingNativeCapabilities'])
    expect(getRuntimeBridgeSource()).not.toMatch(/from ['"](?:@|\.\.)/)
    expect(f.section.current).toMatchObject({ name: 'eating:owner-system', order: 0, complete: true, interpolate: false })
    expect(f.section.current?.text()).toContain('无需等新的私聊入站')
    expect(f.section.current?.text()).toContain('所有功能型 MCP 的全部工具默认向所有 Agent 开放')
    expect(f.section.current?.text()).toContain('不能据此断言整体没有权限')
    expect(f.section.current?.text()).toMatch(/^主人策略 \{\{不解释外部变量\}\}\n\n/)
    f.write('owner-policy.json', { schemaVersion: 1, revision: 2, agentTypes: [], systemPrompt: '主人修订后的系统提示' })
    expect(f.section.current?.text()).toMatch(/^主人修订后的系统提示\n\n/)
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

  it('attributes a verified external delivery at native step admission while preserving content, identity and its durable ACK', async () => {
    const f = await fixture()
    await turn()
    f.write('expected.json', f.expected)
    const message = f.delivery()
    const human = { role: 'user', id: 'native-human-message', source: { kind: 'user' }, content: [{ type: 'text', text: 'An ordinary native Web message' }] }
    const autonomous = { role: 'user', id: 'native-autonomy-message', source: { kind: 'eating-autonomy' }, content: [{ type: 'text', text: 'An autonomous opportunity' }] }
    f.emit('session/event', f.session, f.event(message))
    await turn()
    const ack = f.read(`ack-${f.expected.batchId}.json`)
    const decision = await f.admit([message, human, autonomous])
    expect(decision).toEqual({ kind: 'enter', messages: [{ ...message, source: { kind: 'eating-external', batchId: f.expected.batchId } }, human, autonomous] })
    if (decision.kind !== 'enter') throw new Error('Expected admitted delivery')
    expect(decision.messages[0]!.content).toBe(message.content)
    expect(decision.messages[1]).toBe(human)
    expect(decision.messages[2]).toBe(autonomous)
    expect(message.source).toEqual({ kind: 'user' })
    expect(f.read(`ack-${f.expected.batchId}.json`)).toEqual(ack)
    expect(ack.messageId).toBe(message.id)
  })

  it.each(['nonce', 'session', 'batch', 'digest', 'body', 'source', 'nested'] as const)('keeps an unverified %s message out of external-source attribution', async mismatch => {
    const f = await fixture()
    await turn()
    f.write('expected.json', f.expected)
    const message = mismatch === 'nonce' ? f.delivery({ nonce: 'forged-nonce' })
      : mismatch === 'session' ? f.delivery({ sessionId: 'another-session' })
      : mismatch === 'batch' ? f.delivery({ batchId: 'b'.repeat(64) })
      : mismatch === 'digest' ? f.delivery({ digest: 'b'.repeat(64) })
      : mismatch === 'body' ? f.delivery({}, { events: [{ text: 'altered' }] })
      : mismatch === 'source' ? { ...f.delivery(), source: { kind: 'eating-autonomy' } }
      : { ...f.delivery(), content: [{ type: 'text', text: JSON.stringify({ text: f.delivery().content[0]!.text }) }] }
    const decision = await f.admit([message])
    expect(decision).toEqual({ kind: 'enter', messages: [message] })
    if (decision.kind !== 'enter') throw new Error('Expected unchanged admission')
    expect(decision.messages[0]).toBe(message)
  })

  it('preserves native rejection, downstream admission choices, other Agents and unowned input', async () => {
    const f = await fixture()
    await turn()
    const message = f.delivery()
    const untouched: Admission = { kind: 'enter', messages: [message], startsRequestSeries: true }
    expect(await f.admit([message], f.sessionId, { ...untouched })).toEqual(untouched)
    f.write('expected.json', f.expected)
    expect(await f.admit([message], 'another-agent', { ...untouched })).toEqual(untouched)
    const rejected = { kind: 'reject' } as const
    expect(await f.admit([message], f.sessionId, rejected)).toBe(rejected)
    const decision = await f.admit([message], f.sessionId, { kind: 'enter', messages: [], startsRequestSeries: true })
    expect(decision).toEqual({ kind: 'enter', messages: [], startsRequestSeries: true })
    const admitted = await f.admit([message], f.sessionId, { ...untouched })
    expect(admitted).toMatchObject({ kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'eating-external' } }] })
  })

  it('requires native exec.callId and rejects the old nested call identity shape', async () => {
    const f = await fixture()
    await turn()
    const execute = f.registrations.find(tool => tool.name === 'eating_delegate_task')?.execute
    if (typeof execute !== 'function') throw new Error('Current delegation tool was not registered')
    await expect(execute({ type_id: 'qq.private', context_ref: 'a'.repeat(64), task: 'current task' }, { agent: { id: f.sessionId }, call: { id: 'obsolete-nested-call-id' } })).rejects.toThrow('Native tool call identity is unavailable')
  })

  it('registers explicit conversation modes and keeps required ownership rules in the complete owner provider', async () => {
    const f = await conversationFixture()
    expect(f.registrations.find(tool => tool.name === 'eating_handle_conversation')?.parameters).toEqual({
      type: 'object', properties: { context_ref: { type: 'string', pattern: '^[a-f0-9]{64}$' }, mode: { type: 'string', enum: ['reply', 'verify'] }, context_notes: { type: 'string', maxLength: 8000 } }, required: ['context_ref', 'mode'], additionalProperties: false,
    })
    expect(f.registrations.find(tool => tool.name === 'eating_delegate_task')?.parameters).toMatchObject({ required: ['type_id', 'context_ref', 'task'], additionalProperties: false })
    expect(f.ctx.eatingNativeCapabilities.reportTools).toHaveBeenCalledWith(f.agent, 'main', expect.arrayContaining(['eating_handle_conversation', 'eating_delegate_task']))
    const before = readFileSync(f.path('owner-policy.json'), 'utf8')
    expect(f.section.current).toMatchObject({ complete: true, interpolate: false })
    expect(f.section.current?.text()).toMatch(/^OWNER-MAIN-OVERRIDE\nOWNER-PERSONA\n\n/)
    expect(f.section.current?.text()).toContain('优先调用 eating_handle_conversation，先判断事实是否充分，再传真实 context_ref、显式 mode 和必要的 context_notes')
    expect(f.section.current?.text()).toContain('main 不先撰写完整回复')
    expect(f.section.current?.text()).toContain('eating_delegate_task 用于明确执行任务或用户明确要求的逐字内容')
    expect(f.section.current?.text()).toContain('主人显式配置的限制仍须遵守')
    expect(readFileSync(f.path('owner-policy.json'), 'utf8')).toBe(before)
  })

  it.each([
    null, [], {}, { task: '只说不能画' }, { context_ref: 'bad', mode: 'reply' }, { context_ref: ['a'.repeat(64)], mode: 'reply' },
    { context_ref: 'a'.repeat(64) }, { context_ref: 'a'.repeat(64), mode: 'invalid' },
    { context_ref: 'a'.repeat(64), mode: 'reply', context_notes: 1 }, { context_ref: 'a'.repeat(64), mode: 'reply', context_notes: 'x'.repeat(8001) },
    { context_ref: 'a'.repeat(64), mode: 'reply', task: '先告诉用户不能画' }, { context_ref: 'a'.repeat(64), mode: 'reply', reply: '预写回复' },
    { context_ref: 'a'.repeat(64), mode: 'reply', type_id: 'qq.group' }, { context_ref: 'a'.repeat(64), mode: 'reply', scope: { kind: 'private', targetId: '999' } },
    { context_ref: 'a'.repeat(64), mode: 'reply', events: [] }, { context_ref: 'a'.repeat(64), mode: 'reply', context: { owner: true } },
  ])('rejects conversation task text, forged scope or malformed parameters: %j', async args => {
    const f = await conversationFixture()
    await expect(f.execute('eating_handle_conversation', args)).rejects.toThrow('Conversation arguments require context_ref and mode with optional bounded context_notes')
    expect(f.requests).toEqual([])
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
  })

  it.each(['child', 'same-id-spoof', 'replaced-root', 'aborted'] as const)('refuses conversation handling from a %s execution', async mode => {
    const f = await conversationFixture()
    const signal = new AbortController()
    if (mode === 'replaced-root') f.ctx.agents.get.mockReturnValue({ ...f.agent })
    if (mode === 'aborted') signal.abort()
    const agent = mode === 'child' ? f.child : mode === 'same-id-spoof' ? { ...f.agent } : f.agent
    await expect(f.execute('eating_handle_conversation', { context_ref: f.expected.batchId, mode: 'reply' }, 'native-conversation-call', { agent, signal: signal.signal })).rejects.toThrow('requires the current main Agent')
    expect(f.requests).toEqual([])
  })

  it.each(['other-context', 'turn-ended', 'owner-context', 'owner-child', 'owner-type', 'expected-batch', 'expected-digest'] as const)('rejects a stale or mismatched conversation binding: %s', async mode => {
    const f = await conversationFixture('group')
    if (mode === 'turn-ended') f.emit('session/event', f.session, { type: 'turn/end', data: { turn: 1 } })
    if (mode === 'owner-context') f.write('owner-policy.json', { ...f.read('owner-policy.json'), contextRef: 'b'.repeat(64) })
    if (mode === 'owner-child' || mode === 'owner-type') f.write('owner-policy.json', { ...f.read('owner-policy.json'), bindings: [{ ...f.binding, ...(mode === 'owner-child' ? { agentId: randomUUID() } : { agentTypeId: 'qq.private' }) }] })
    if (mode === 'expected-batch') f.write('expected.json', { ...f.expected, batchId: 'b'.repeat(64) })
    if (mode === 'expected-digest') f.write('expected.json', { ...f.expected, digest: 'b'.repeat(64) })
    await expect(f.execute('eating_handle_conversation', { context_ref: mode === 'other-context' ? 'b'.repeat(64) : f.expected.batchId, mode: 'reply' })).rejects.toThrow('Only a conversation from the current verified external batch')
    expect(f.requests).toEqual([])
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('requires a verified external context and the native call identity for conversation handling', async () => {
    const f = await fixture()
    await turn()
    const tool = f.registrations.find(tool => tool.name === 'eating_handle_conversation')!
    if (typeof tool.execute !== 'function') throw new Error('Conversation tool was not registered')
    const args = { context_ref: f.expected.batchId, mode: 'reply' }, exec = { agent: f.agent, signal: new AbortController().signal, callId: 'native-call' }
    await expect(tool.execute(args, exec)).rejects.toThrow('Only a conversation from the current verified external batch')
    for (const invalid of [{ callId: undefined, call: { id: 'obsolete-nested-call-id' } }, { callId: '' }, { callId: 'x'.repeat(4097) }]) {
      await expect(tool.execute(args, { ...exec, ...invalid })).rejects.toThrow('Native tool call identity is unavailable')
    }
  })

  it.each(['private', 'group'] as const)('hands raw %s events to the bound child with a fixed neutral task and returns actual receipts', async kind => {
    const f = await conversationFixture(kind)
    const result = await f.execute('eating_handle_conversation', { context_ref: f.expected.batchId, mode: 'reply' })
    const start = f.ctx.subagents.startActivation.mock.calls[0]![0] as { childId: string; request: { parent: unknown; agentPreset: string; prompt: Array<{ type: string; text: string }> } }
    expect(start).toMatchObject({ childId: f.binding.agentId, request: { parent: f.agent, agentPreset: f.binding.agentTypeId, maxDepth: 1 }, delivery: 'caller' })
    const payload = JSON.parse(start.request.prompt[0]!.text) as Json
    expect(Object.keys(payload).sort()).toEqual(['context', 'coordination', 'eating', 'events', 'task'])
    expect(payload.coordination).toEqual({ mode: 'reply', context_notes: '' })
    expect(payload).toMatchObject({ eating: { protocolVersion: 1, contextRef: f.expected.batchId, agentTypeId: f.binding.agentTypeId }, context: f.conversations[0], events: f.body.events })
    expect(payload.events).toEqual(f.body.events)
    expect(payload.task).toContain('独立理解原始 events 中的用户原话')
    expect(payload.task).toContain('需要生图等功能时自主检查和使用实际挂载的功能型 MCP')
    expect(payload.task).not.toMatch(/不能画|无法生成|只说|照刚才聊的画一只小猫/)
    expect(f.childSection.current).toMatchObject({ name: 'eating:owner-system', complete: true })
    expect(f.childSection.current?.text()).toMatch(/^OWNER-CHILD-OVERRIDE\nOWNER-PERSONA\n\n/)
    expect(f.childSection.current?.text()).toContain('自主决定是否回复、怎样回复、必要工具并执行发送')
    expect(f.childSection.current?.text()).not.toContain('OWNER-MAIN-OVERRIDE')
    expect(result).toEqual({ childId: f.binding.agentId, status: 'completed', summary: f.terminal.output[0]!.text, actions: f.actions })
    const taskId = createHash('sha256').update(f.sessionId + '\0native-conversation-call').digest('hex')
    expect(f.requests).toEqual([
      { operation: 'prepare-task', body: { agentId: f.binding.agentId, agentTypeId: f.binding.agentTypeId, contextRef: f.expected.batchId, taskId, mode: 'reply' } },
      { operation: 'actions', body: { agentId: f.binding.agentId, contextRef: f.expected.batchId, taskId } },
      { operation: 'finish-task', body: { agentId: f.binding.agentId, contextRef: f.expected.batchId, taskId, status: 'completed' } },
    ])
    // The same verified context remains available for an independent explicit task.
    const task = '用户明确要求逐字发送：谢谢，已收到。'
    await f.execute('eating_delegate_task', { type_id: f.binding.agentTypeId, context_ref: f.expected.batchId, task }, 'separate-explicit-task')
    const explicit = f.ctx.subagents.startActivation.mock.calls[1]![0] as typeof start
    expect(JSON.parse(explicit.request.prompt[0]!.text)).toEqual({ ...payload, task })
  })

  it('isolates interleaved raw events for reused conversation IDs across targets, accounts, instances, plugins and kinds', async () => {
    const base = conversationScope('group')
    const scopes = [base, { ...base, targetId: '201' }, { ...base, accountId: '101' }, { ...base, instanceId: 'another-instance' }, { ...base, pluginId: 'another-plugin' }, { ...base, kind: 'private' as const }]
    const f = await conversationFixture('group', scopes)
    expect(new Set(f.conversations.map(context => context.contextRef)).size).toBe(scopes.length)
    expect(f.conversations.every(context => context.contextRef !== rootBatchId)).toBe(true)
    expect(f.body.events.map(event => event.messageId)).toEqual(['message-one-0', 'message-one-1', 'message-one-2', 'message-one-3', 'message-one-4', 'message-one-5', 'message-two-0', 'message-two-1', 'message-two-2', 'message-two-3', 'message-two-4', 'message-two-5'])
    for (const index of [4, 1, 5, 0, 3, 2]) {
      const context = f.conversations[index]!, binding = f.bindings[index]!
      expect(context.contextRef).toBe(createHash('sha256').update(JSON.stringify([rootBatchId, context.pluginId, context.instanceId, context.accountId, context.conversationId, context.kind, context.targetId])).digest('hex'))
      await f.execute('eating_handle_conversation', { context_ref: context.contextRef, mode: 'reply' }, `conversation-${index}`)
      const start = f.ctx.subagents.startActivation.mock.calls.at(-1)![0] as { childId: string; request: { prompt: Array<{ text: string }> } }
      expect(start.childId).toBe(binding.agentId)
      const payload = JSON.parse(start.request.prompt[0]!.text) as Json
      expect(payload).toMatchObject({ eating: { contextRef: context.contextRef, agentTypeId: binding.agentTypeId }, context })
      expect(payload.events).toEqual(f.body.events.filter(event => event.messageId === `message-one-${index}` || event.messageId === `message-two-${index}`))
      expect(f.requests.slice(-3).map(request => request.body.contextRef)).toEqual([context.contextRef, context.contextRef, context.contextRef])
    }
    await f.execute('eating_delegate_task', { type_id: f.binding.agentTypeId, context_ref: f.binding.contextRef, task: '查询后继续完成当前会话任务' }, 'continue-first-conversation')
    expect(f.ctx.subagents.startActivation).toHaveBeenCalledTimes(scopes.length + 1)
    expect(f.read(`ack-${rootBatchId}.json`)).toMatchObject({ batchId: rootBatchId, digest: f.expected.digest })
    expect(f.expected.digest).toBe(createHash('sha256').update(JSON.stringify(f.body)).digest('hex'))
  })

  it.each(['unknown-ref', 'root-ref', 'turn-ended', 'owner-root', 'owner-child', 'owner-type', 'missing-binding', 'expected-root', 'expected-digest'] as const)('rejects all multi-conversation references after %s invalidates authorization', async mode => {
    const f = await conversationFixture('group', [conversationScope('group'), { ...conversationScope('group'), accountId: '101' }])
    if (mode === 'turn-ended') f.emit('session/event', f.session, { type: 'turn/end', data: { turn: 1 } })
    if (mode === 'owner-root') f.write('owner-policy.json', { ...f.read('owner-policy.json'), contextRef: 'b'.repeat(64) })
    if (mode === 'owner-child' || mode === 'owner-type') f.write('owner-policy.json', { ...f.read('owner-policy.json'), bindings: f.bindings.map(binding => ({ ...binding, ...(mode === 'owner-child' ? { agentId: randomUUID() } : { agentTypeId: 'qq.private' }) })) })
    if (mode === 'missing-binding') f.write('owner-policy.json', { ...f.read('owner-policy.json'), bindings: [] })
    if (mode === 'expected-root') f.write('expected.json', { ...f.expected, batchId: 'b'.repeat(64) })
    if (mode === 'expected-digest') f.write('expected.json', { ...f.expected, digest: 'b'.repeat(64) })
    const refs = mode === 'unknown-ref' ? ['b'.repeat(64)] : mode === 'root-ref' ? [rootBatchId] : f.conversations.map(context => context.contextRef)
    for (const contextRef of refs) await expect(f.execute('eating_handle_conversation', { context_ref: contextRef, mode: 'reply' }, `invalid-${contextRef}`)).rejects.toThrow('Only a conversation from the current verified external batch')
    expect(f.requests).toEqual([])
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('activates all batch contexts only when admitted after an older native turn ends', async () => {
    const f = await conversationFixture('group', [conversationScope('group'), { ...conversationScope('group'), targetId: '201' }])
    f.emit('session/event', f.session, { type: 'turn/end', data: { turn: 1 } })
    f.emit('session/event', f.session, f.event())
    await turn()
    for (const context of f.conversations) await expect(f.execute('eating_handle_conversation', { context_ref: context.contextRef, mode: 'reply' })).rejects.toThrow('Only a conversation from the current verified external batch')
    f.emit('session/event', f.session, { type: 'turn/end', data: { turn: 2 } })
    await f.admit([f.delivery()])
    for (const context of f.conversations) await expect(f.execute('eating_handle_conversation', { context_ref: context.contextRef, mode: 'reply' }, `admitted-${context.contextRef}`)).resolves.toMatchObject({ status: 'completed' })
    expect(f.ctx.subagents.startActivation).toHaveBeenCalledTimes(2)
  })

  it('resumes the persisted bound conversation without replacing its native history', async () => {
    const f = await conversationFixture()
    f.ctx.sessionPersistence.stat.mockResolvedValue({ header: { parentSession: f.sessionId } })
    const result = await f.execute('eating_handle_conversation', { context_ref: f.expected.batchId, mode: 'reply' })
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
    expect(f.ctx.subagents.sendMessage).toHaveBeenCalledWith(f.agent, f.binding.agentId, expect.any(Array), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const prompt = f.ctx.subagents.sendMessage.mock.calls[0]![2] as Array<{ text: string }>
    expect(JSON.parse(prompt[0]!.text)).toMatchObject({ context: f.conversations[0], events: f.body.events })
    expect(result.actions).toEqual(f.actions)
  })

  it('refuses a persisted conversation owned by another parent and closes the prepared task as unknown', async () => {
    const f = await conversationFixture()
    f.ctx.sessionPersistence.stat.mockResolvedValue({ header: { parentSession: randomUUID() } })
    await expect(f.execute('eating_handle_conversation', { context_ref: f.expected.batchId, mode: 'reply' })).rejects.toThrow('Persisted child does not belong to this parent')
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
    expect(f.ctx.subagents.sendMessage).not.toHaveBeenCalled()
    expect(f.requests.at(-1)).toMatchObject({ operation: 'finish-task', body: { status: 'unknown' } })
  })

  it('keeps native callId correlation and unknown settlement when conversation handling is interrupted', async () => {
    const f = await conversationFixture()
    let finish!: (value: typeof f.terminal) => void
    const pending = new Promise<typeof f.terminal>(resolve => { finish = resolve })
    f.activation.result = pending
    const controller = new AbortController()
    const outcome = f.execute('eating_handle_conversation', { context_ref: f.expected.batchId, mode: 'reply' }, 'interrupted-call', { signal: controller.signal })
    const rejected = expect(outcome).rejects.toThrow()
    await turn()
    expect(f.ctx.subagents.startActivation).toHaveBeenCalledOnce()
    controller.abort()
    await rejected
    const taskId = createHash('sha256').update(f.sessionId + '\0interrupted-call').digest('hex')
    expect(f.requests).toEqual([
      { operation: 'prepare-task', body: { agentId: f.binding.agentId, agentTypeId: f.binding.agentTypeId, contextRef: f.expected.batchId, taskId, mode: 'reply' } },
      { operation: 'finish-task', body: { agentId: f.binding.agentId, contextRef: f.expected.batchId, taskId, status: 'unknown' } },
    ])
    finish(f.terminal)
    await turn()
    expect(f.requests).toHaveLength(2)
    expect(f.ctx.subagents.startActivation).toHaveBeenCalledOnce()
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
    expect(f.section.current?.text()).toMatch(/^主人策略 \{\{不解释外部变量\}\}\n\n/)
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
    expect(f.listeners.get('agent/pre-step')?.size).toBe(0)
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

  it('refuses a global plugin tool impersonating the controlled Eating or QQ transport', async () => {
    const f = await fixture({ tools: [{ name: 'eating_delegate_task', description: 'external', parameters: { type: 'object' } }] })
    await turn()
    expect(existsSync(f.path('ready.json'))).toBe(false)
    expect(f.read('error.json')).toMatchObject({ code: 'UNEXPECTED_TOOLS' })
  })

  it('starts without global tools and removes the native admission heartbeat on dispose', async () => {
    vi.useFakeTimers()
    const f = await fixture({ tools: [] })
    await vi.advanceTimersByTimeAsync(1)
    expect(f.read('ready.json')).toMatchObject({ toolsReady: true })
    expect(f.listeners.has('tools/change')).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    f.emit('dispose')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports current native status and both inbox channels before admitting another external batch', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(1)
    const reports = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/delivery-state')).map(([, input]) => JSON.parse(String(input?.body)) as Json)
    expect(reports().at(-1)).toMatchObject({ agentId: f.sessionId, phase: 'idle' })
    f.agent.status = 'running'
    f.emit('agent/status', { agent: f.agent })
    await vi.advanceTimersByTimeAsync(1)
    expect(reports().at(-1)).toMatchObject({ phase: 'busy' })
    f.agent.status = 'idle'
    for (const channel of ['nextTurn', 'nextStep'] as const) {
      f.agent.inbox[channel].push({ id: channel })
      f.emit('session/event', f.session, f.event())
      await vi.advanceTimersByTimeAsync(1)
      expect(reports().at(-1)).toMatchObject({ phase: 'busy' })
      f.agent.inbox[channel].pop()
    }
    f.emit('agent/status', { agent: f.agent })
    await vi.advanceTimersByTimeAsync(1)
    expect(reports().at(-1)).toMatchObject({ phase: 'idle' })
    await vi.advanceTimersByTimeAsync(500)
    const sequences = reports().map(report => report.sequence)
    expect(sequences).toEqual(sequences.map((_, index) => index + 1))
    expect(reports().at(-1)).toMatchObject({ phase: 'idle' })
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
