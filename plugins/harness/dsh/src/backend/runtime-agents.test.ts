import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeAgentSource } from './runtime-agents'

function fixture(unavailable = false) {
  const sessionId = randomUUID(), childId = randomUUID(), batchId = 'a'.repeat(64)
  vi.stubEnv('EATING_DSH_CONTROL_URL', 'http://127.0.0.1:1')
  vi.stubEnv('EATING_DSH_CONTROL_TOKEN', 'fixture-control')
  vi.stubEnv('EATING_DSH_MCP_ENTRY', '/fixture/mcp.mjs')
  const routingError = { code: 'AGENT_CAPACITY_REACHED', message: '子代理会话数量已达上限，请先核对已有会话。' }
  const conversations = Array.from({ length: unavailable ? 101 : 1 }, (_, index) => {
    const scope = { pluginId: 'qq', platform: 'qq', instanceId: 'instance', accountId: '100', conversationId: `conversation-${index}`, kind: 'private', targetId: String(200 + index), agentTypeId: 'qq.private' }
    const contextRef = unavailable ? createHash('sha256').update(JSON.stringify([batchId, scope.pluginId, scope.instanceId, scope.accountId, scope.conversationId, scope.kind, scope.targetId])).digest('hex') : batchId
    return { ...scope, contextRef, ...(unavailable && index === 100 ? { routingError } : {}) }
  })
  const bindings = conversations.map((conversation, index) => unavailable && index === 100 ? { contextRef: conversation.contextRef, routingError } : { contextRef: conversation.contextRef, agentId: index === 0 ? childId : randomUUID(), agentTypeId: 'qq.private', label: `Child ${index}` })
  const policy = { contextRef: batchId, bindings, systemPrompt: 'OWNER', agentTypes: [{ id: 'qq.private', title: 'Private', enabled: true }] }
  const payload = { eating: { batchId, digest: 'b'.repeat(64) }, context: { contextRef: batchId, ownerRevision: 1, conversations }, events: conversations.map(conversation => ({ ...conversation, source: { trust: 'external', kind: 'private' }, text: `message ${conversation.targetId}` })) }
  const expected = { batchId, ownerRevision: 1, bindings, digest: payload.eating.digest }
  const resident = new Map<string, unknown>()
  const main = { id: sessionId, session: { id: sessionId } }
  resident.set(sessionId, main)
  let pending: string | null = null
  const configuration = { agentId: childId, agentTypeId: 'qq.private', systemPrompt: 'CHILD', mode: 'reply', mcp: { url: 'http://127.0.0.1:1/mcp', headers: {} }, capabilities: [], tools: [] }
  const requests: Array<{ operation: string; body: Record<string, string> }> = []
  const fetcher = vi.fn(async (url: unknown, input?: RequestInit) => {
    const operation = String(url).split('/').at(-1)!, body = JSON.parse(String(input?.body)) as Record<string, string>
    requests.push({ operation, body })
    if (operation === 'prepare-task') {
      if (pending) return new Response(JSON.stringify({ code: 'AGENT_TASK_PENDING', message: '已有子代理任务仍在执行', outcome: 'not-sent' }), { status: 409 })
      pending = body.taskId!
      return new Response(JSON.stringify(configuration))
    }
    if (operation === 'finish-task') { if (pending === body.taskId) pending = null; return new Response(JSON.stringify({ ok: true, status: body.status, actions: [] })) }
    if (operation === 'actions') return new Response(JSON.stringify({ available: true, closed: false, actions: [] }))
    throw new Error(`Unexpected ${operation}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const completed = { stopReason: 'completed', output: [{ type: 'text', text: 'completed independently' }] }
  let resolve!: (value: typeof completed) => void
  const deferred = { promise: new Promise<typeof completed>(accept => { resolve = accept }), resolve: (value: typeof completed) => resolve(value) }
  const activation = { result: deferred.promise, dispose: vi.fn(async () => {}) }
  const ctx = {
    on: vi.fn(() => () => {}),
    eatingNativeCapabilities: { mount: vi.fn(), restrict: vi.fn(), allowedGlobal: vi.fn() },
    agents: { get: vi.fn((id: string) => resident.get(id)) },
    agentPresets: { register: vi.fn(async () => () => {}) },
    sessionPersistence: { stat: vi.fn(async () => undefined) },
    sessions: { flush: vi.fn(async () => true) },
    subagents: {
      drainChildren: vi.fn(async (_parent: unknown, children: string[]) => { for (const child of children) resident.delete(child) }),
      startActivation: vi.fn(async (input: { childId: string }) => { resident.set(input.childId, { id: input.childId, session: { id: input.childId } }); return activation }),
    },
  }
  const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const opaque = (value: unknown) => typeof value === 'string' && value.length > 0
  const bridgeError = (code: string) => Object.assign(new Error(code), { code })
  const dependencies = { ctx, releases: [], sessionId, nonce: 'fixture-nonce', isAbsolute, opaque, record, bridgeError, createHash, initialization: new AbortController(), disposed: false, failed: false, HEX: /^[a-f0-9]{64}$/, readJson: () => undefined, atomicJson: vi.fn(), recoveredTaskNotices: new Set(), acknowledgedBatches: new Set(), restoredDeliveries: new Map(), fail: vi.fn(), failureCode: () => 'DURABILITY_FAILED', readExpected: () => expected, readValidatedOwnerPolicy: () => policy, identifyCurrentDelivery: () => true }
  const instantiate = new Function('dependencies', 'const {' + Object.keys(dependencies).join(',') + '} = dependencies;\n' + getRuntimeAgentSource() + '\nreturn { acceptContext, handleConversation, delegate, runDelegation, mainSystemPrompt };')
  const runtime = instantiate(dependencies) as {
    acceptContext(message: unknown, expected: unknown): void
    handleConversation(args: unknown, exec: unknown): Promise<unknown>
    delegate(args: unknown, exec: unknown): Promise<unknown>
    runDelegation(context: unknown, typeId: string, task: string, taskId: string, exec: unknown, configuration: unknown, coordination?: unknown): Promise<unknown>
    mainSystemPrompt(): string
  }
  runtime.acceptContext({ content: [{ text: JSON.stringify(payload) }] }, expected)
  const exec = (callId: string) => ({ agent: main, signal: new AbortController().signal, callId })
  return { runtime, ctx, conversations, bindings, policy, payload, expected, requests, activation, deferred, completed, configuration, exec, childId, resident }
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('runtime per-conversation routing and child serialization', () => {
  it('keeps all 101 conversations verified and clearly refuses the unavailable ref without starting a child', async () => {
    const f = fixture(true), unavailable = f.conversations[100]!
    expect(f.runtime.mainSystemPrompt()).toContain('必须向用户明确报告对应会话、错误 code 与 message')
    await expect(f.runtime.handleConversation({ context_ref: unavailable.contextRef, mode: 'reply' }, f.exec('unavailable'))).rejects.toMatchObject({ code: 'AGENT_CAPACITY_REACHED', outcome: 'not-sent', message: expect.stringContaining('子代理会话数量已达上限') })
    await expect(f.runtime.delegate({ type_id: 'qq.private', context_ref: unavailable.contextRef, task: 'reply' }, f.exec('unavailable-task'))).rejects.toMatchObject({ code: 'AGENT_CAPACITY_REACHED', outcome: 'not-sent' })
    expect(f.requests).toEqual([]); expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
    const result = f.runtime.handleConversation({ context_ref: f.conversations[0]!.contextRef, mode: 'reply' }, f.exec('valid'))
    await vi.waitFor(() => expect(f.ctx.subagents.startActivation).toHaveBeenCalledOnce())
    f.deferred.resolve(f.completed)
    await expect(result).resolves.toMatchObject({ status: 'running' })
    await vi.waitFor(() => expect(f.requests).toContainEqual(expect.objectContaining({ operation: 'finish-task', body: expect.objectContaining({ status: 'completed' }) })))
  })

  it.each(['source', 'missing-events', 'routing-error', 'error-binding'] as const)('rejects mismatched %s even for unavailable conversations', mode => {
    const f = fixture(true), last = f.payload.context.conversations[100]!
    if (mode === 'source') last.targetId = 'wrong-target'
    if (mode === 'missing-events') f.payload.events.pop()
    if (mode === 'routing-error') last.routingError = { code: 'AGENT_TYPE_UNAVAILABLE', message: 'forged' }
    if (mode === 'error-binding') Object.assign(f.policy.bindings[100]!, { agentId: f.childId })
    expect(() => f.runtime.acceptContext({ content: [{ text: JSON.stringify(f.payload) }] }, f.expected)).toThrow('OWNER_POLICY_INVALID')
  })

  it('asks Host for mutual exclusion before draining a resident child and leaves the first pending task running', async () => {
    const f = fixture(), args = { context_ref: f.conversations[0]!.contextRef, mode: 'reply' }
    const first = f.runtime.handleConversation(args, f.exec('first'))
    await vi.waitFor(() => expect(f.ctx.subagents.startActivation).toHaveBeenCalledOnce())
    await expect(f.runtime.handleConversation(args, f.exec('parallel'))).rejects.toMatchObject({ code: 'AGENT_TASK_PENDING', outcome: 'not-sent' })
    expect(f.requests.filter(request => request.operation === 'prepare-task')).toHaveLength(1)
    expect(f.requests.filter(request => request.operation === 'finish-task')).toHaveLength(0)
    expect(f.ctx.subagents.drainChildren).not.toHaveBeenCalled(); expect(f.activation.dispose).not.toHaveBeenCalled()
    f.deferred.resolve(f.completed)
    await expect(first).resolves.toMatchObject({ status: 'running' })
    await vi.waitFor(() => expect(f.requests).toContainEqual(expect.objectContaining({ operation: 'finish-task', body: expect.objectContaining({ status: 'completed' }) })))
    expect(f.requests.at(-1)).toMatchObject({ operation: 'finish-task', body: { status: 'completed' } })
  })

  it('guards an already prepared contact from replacing another flight for the same child', async () => {
    const f = fixture(), args = { context_ref: f.conversations[0]!.contextRef, mode: 'reply' }
    const first = f.runtime.handleConversation(args, f.exec('first'))
    await vi.waitFor(() => expect(f.ctx.subagents.startActivation).toHaveBeenCalledOnce())
    const context = { contextRef: 'c'.repeat(64), binding: { agentId: f.childId }, payload: { context: {}, events: [] } }
    await expect(f.runtime.runDelegation(context, 'qq.private', 'contact', 'd'.repeat(64), f.exec('contact'), f.configuration, { mode: 'reply', context_notes: '' })).rejects.toMatchObject({ code: 'AGENT_TASK_PENDING', outcome: 'not-sent' })
    expect(f.ctx.subagents.drainChildren).not.toHaveBeenCalled(); expect(f.activation.dispose).not.toHaveBeenCalled()
    f.deferred.resolve(f.completed)
    await expect(first).resolves.toMatchObject({ status: 'running' })
    await vi.waitFor(() => expect(f.requests).toContainEqual(expect.objectContaining({ operation: 'finish-task', body: expect.objectContaining({ status: 'completed' }) })))
  })
})
