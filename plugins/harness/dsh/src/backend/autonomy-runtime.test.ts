import { describe, expect, it, vi } from 'vitest'
import { getAutonomyRuntimeSource } from './autonomy-runtime'
import { getRuntimeAgentSource } from './runtime-agents'

type ControlError = Error & { code: string; outcome: string; details: unknown; statusCode?: number }
function runtimeControl(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const source = getRuntimeAgentSource()
  const start = source.indexOf('  async function control('), end = source.indexOf('  function acceptContext(', start)
  if (start < 0 || end < 0) throw new Error('Actual runtime control function was not found')
  return new Function('fetch', 'controlUrl', 'controlToken', 'nonce', 'record', source.slice(start, end) + '\nreturn control;')(
    fetch, 'http://127.0.0.1:12345', 'fixture-control-secret', 'fixture-runtime-nonce', (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value),
  ) as (operation: string, body: unknown, signal?: AbortSignal) => Promise<unknown>
}

describe('runtime control errors visible to native tools', () => {
  it('preserves the quota code, not-sent outcome, safe details and reset instruction through message-only SDK errors', async () => {
    const contactLimit = { limit: 6, used: 6, remaining: 0, exhausted: true, windowStartedAt: 1700000000000, resetAt: 1700003600000 }
    const fetch = vi.fn(async () => Response.json({ code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent', message: '当前小时主动联系额度已用尽（6/6）；2023-11-14T23:13:20.000Z 重置，请等待。', details: { contactLimit } }, { status: 409 }))
    const control = runtimeControl(fetch)
    for (let i = 0; i < 3; i++) {
      const error = await control('prepare-proactive', { agentId: 'root' }).catch(error => error) as ControlError
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ name: 'RuntimeControlError', code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent', details: { contactLimit }, statusCode: 409 })
      expect(error.message).toContain('[AUTONOMY_CONTACT_LIMIT]')
      expect(error.message).toContain('额度已用尽（6/6）')
      expect(error.message).toContain('2023-11-14T23:13:20.000Z')
      expect(error.message).not.toContain('配置或状态无效')
    }
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each(['not-sent', 'failed', 'unknown'])('keeps the backend %s outcome for a 409 instead of guessing from HTTP status', async outcome => {
    const control = runtimeControl(async () => Response.json({ code: 'AGENT_TASK_UNKNOWN', outcome, message: '已有任务待核对，此次未重复提交。' }, { status: 409 }))
    await expect(control('prepare-task', {})).rejects.toMatchObject({ code: 'AGENT_TASK_UNKNOWN', outcome, message: expect.stringContaining('[AGENT_TASK_UNKNOWN]') })
  })
  it('preserves the current lowercase OneBot error code and not-sent result', async () => {
    const control = runtimeControl(async () => Response.json({ code: 'onebot_payload_too_large', outcome: 'not-sent', message: 'OneBot 请求超过大小上限' }, { status: 413 }))
    await expect(control('prepare-proactive', {})).rejects.toMatchObject({ code: 'onebot_payload_too_large', outcome: 'not-sent', statusCode: 413, message: expect.stringContaining('[onebot_payload_too_large]') })
  })
  it('returns successful activity state even while contact quota is exhausted', async () => {
    const snapshot = { revision: 1, configuration: { enabled: true }, state: { revision: 2, contacts: 6, contactLimit: { limit: 6, used: 6, remaining: 0, exhausted: true } } }
    const control = runtimeControl(async () => Response.json(snapshot))
    await expect(control('autonomy-snapshot', { agentId: 'root' })).resolves.toEqual(snapshot)
  })
  it('redacts credentials, nested headers and signed URLs without losing numeric quota details', async () => {
    const control = runtimeControl(async () => Response.json({ code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent',
      message: 'fixture-control-secret fixture-runtime-nonce detail-private-value Bearer provider-key token=inline-key https://example.test/asset?signature=signed-key',
      details: { contactLimit: { limit: 6, remaining: 0 }, token: 'detail-private-value', headers: { Authorization: 'Bearer nested-private-value' }, nested: { note: 'Bearer nested-private-value', url: 'https://example.test/?token=signed-key', api_key: 'hidden-api-key' } },
    }, { status: 409 }))
    const error = await control('prepare-proactive', {}).catch(error => error) as ControlError
    expect(error).toMatchObject({ code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent', details: { contactLimit: { limit: 6, remaining: 0 } } })
    const rendered = JSON.stringify({ message: error.message, details: error.details })
    for (const secret of ['fixture-control-secret', 'fixture-runtime-nonce', 'detail-private-value', 'provider-key', 'inline-key', 'signed-key', 'nested-private-value', 'hidden-api-key']) expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain('Authorization')
  })
  it('does not leak malformed response bodies or raw transport exceptions and never retries', async () => {
    const malformed = vi.fn(async () => new Response('fixture-control-secret invalid-json', { status: 403 }))
    const bad = await runtimeControl(malformed)('prepare-task', {}).catch(error => error) as ControlError
    expect(bad).toMatchObject({ code: 'CONTROL_RESPONSE_INVALID', outcome: 'unknown', statusCode: 403 })
    expect(bad.message).not.toContain('fixture-control-secret')
    expect(malformed).toHaveBeenCalledOnce()
    const disconnected = vi.fn(async () => { throw new Error('fixture-control-secret transport failed') })
    const error = await runtimeControl(disconnected)('prepare-task', {}).catch(error => error) as ControlError
    expect(error).toMatchObject({ code: 'CONTROL_TRANSPORT_FAILED', outcome: 'unknown' })
    expect(error.message).not.toContain('fixture-control-secret')
    expect(disconnected).toHaveBeenCalledOnce()
  })
})

describe('native autonomous driver publication lifecycle', () => {
  it('publishes Chinese tools and policy while preserving the admitted opportunity context and trusted source', async () => {
    vi.useFakeTimers()
    const releases: (() => void)[] = []
    const initialization = new AbortController()
    try {
      const cycle = { id: 'fixture-cycle', deadline: Date.now() + 60000 }
      const activity = { mode: 'active', note: '继续未完成的创作' }
      const limits = { minIntervalSeconds: 60, maxCyclesPerHour: 10, maxRunMinutes: 120, runRemainingMs: 7200000 }
      const tools: { name: string; description: string; parameters: unknown; execute?: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
      const sections: { name: string; order: number; interpolate: boolean; text: () => string }[] = []
      const agent = { id: 'root', status: 'idle', session: { id: 'root' }, followup: vi.fn(), cancel: () => {}, inbox: { nextTurn: [], nextStep: [], remove: () => false },
        ctx: { tools: { register: (tool: typeof tools[number]) => tools.push(tool) }, systemPrompt: { section: (section: typeof sections[number]) => sections.push(section) } } }
      const ctx = { agents: { get: () => agent }, sessions: { flush: vi.fn(async () => true) }, on: () => () => {}, get: () => undefined }
      const createUserMessage = vi.fn((message: { content: { type: string; text: string }[]; source: { kind: string; cycleId: string; nonce: string } }) => ({ id: 'fixture-message', ...message }))
      let scheduledTask: unknown
      const context = {
        process: { env: { EATING_DSH_AUTONOMY: 'true' } }, sessionId: 'root', ctx, releases, initialization, nonce: 'fixture-runtime',
        loadModule: async () => ({ createUserMessage }),
        control: async (operation: string, body?: { task?: unknown }) => operation === 'autonomy-snapshot' ? { ready: true, configuration: { enabled: true, targets: [{ id: 'legacy-target' }] }, state: { ownerPaused: false, errorCode: null, active: null, contactLimit: { limit: 6, used: 6, remaining: 0, exhausted: true, windowStartedAt: 1700000000000, resetAt: 1700003600000 } }, contactPolicy: { mode: 'all', entryCount: 1 } }
          : operation === 'autonomy-claim' ? { admitted: true, cycle, activity, limits }
          : operation === 'autonomy-schedule-task' ? (scheduledTask = body?.task, { revision: 1, tasks: [] }) : {},
        record: (value: unknown) => value !== null && typeof value === 'object', opaque: () => true, runDelegation: () => {}, createHash: () => {},
      }
      const mount = new Function(...Object.keys(context), getAutonomyRuntimeSource() + '\nreturn mountAutonomy;')(...Object.values(context)) as (agent: unknown) => Promise<string[]>
      const names = await mount(agent)
      expect(names).toEqual(['eating_activity_state', 'eating_plan_activity', 'eating_schedule_task', 'eating_cancel_scheduled_task'])
      expect(tools.map(tool => tool.name)).toEqual(names)
      for (const tool of tools) expect(tool.description).toMatch(/^\p{Script=Han}/u)
      expect(tools[1]!.parameters).toMatchObject({ properties: { mode: { enum: ['active', 'sleeping', 'waiting'] } }, required: ['expected_revision', 'mode', 'wake_at', 'note'], additionalProperties: false })
      expect(sections).toHaveLength(0)

      const stateTool = tools.find(tool => tool.name === 'eating_activity_state')!
      const modelState = await stateTool.execute!({}, { agent, callId: 'fixture-state', signal: new AbortController().signal })
      expect(modelState).toMatchObject({ configuration: { enabled: true }, state: { contactLimit: { limit: 6, used: 6, remaining: 0, exhausted: true, resetAt: 1700003600000 } }, contactPolicy: { mode: 'all', entryCount: 1 } })
      expect(JSON.stringify(modelState)).not.toContain('targets')
      const scheduleTool = tools.find(tool => tool.name === 'eating_schedule_task')!
      const dueAt = new Date(Date.now() + 60000).toISOString()
      await scheduleTool.execute!({ expected_agenda_revision: 0, due_at: dueAt, message: 'Later task' }, { agent, callId: 'fixture-schedule', signal: new AbortController().signal })
      expect(scheduledTask).toEqual({ expectedRevision: 0, dueAt: Date.parse(dueAt), message: 'Later task' })

      await vi.advanceTimersByTimeAsync(1000)
      expect(createUserMessage).toHaveBeenCalledOnce()
      const message = createUserMessage.mock.results[0]!.value
      expect(message.source).toEqual({ kind: 'eating-autonomy', cycleId: cycle.id, nonce: 'fixture-runtime' })
      expect(message.content).toHaveLength(1)
      expect(message.content[0]!.type).toBe('text')
      const envelope = JSON.parse(message.content[0]!.text)
      expect(Object.keys(envelope).sort()).toEqual(['eating_autonomous_opportunity', 'instruction'])
      expect(envelope.eating_autonomous_opportunity).toEqual({ cycleId: cycle.id, activity, scheduledTasks: [], limits })
      expect(envelope.instruction).toMatch(/^\p{Script=Han}/u)
      expect(agent.followup).toHaveBeenCalledExactlyOnceWith(message)
      expect(ctx.sessions.flush).toHaveBeenCalledExactlyOnceWith(agent.session)
    } finally {
      for (const release of releases) release()
      initialization.abort()
      vi.useRealTimers()
    }
  })

  it('keeps the wake check alive across delayed native publication and replaces a retired root driver on cold restoration', async () => {
    vi.useFakeTimers()
    try {
      const releases: (() => void)[] = [], reads: string[] = []
      let current: unknown
      const ctx = { agents: { get: () => current }, on: () => () => {}, get: () => undefined }
      const newAgent = () => ({ id: 'root', followup: () => {}, cancel: () => {}, inbox: { nextTurn: [], nextStep: [], remove: () => false }, ctx: { tools: { register: vi.fn() }, systemPrompt: { section: () => {} } } })
      const initialization = new AbortController()
      const context = {
        process: { env: { EATING_DSH_AUTONOMY: 'true' } }, sessionId: 'root', ctx, releases, initialization, nonce: 'fixture-runtime',
        loadModule: async () => ({ createUserMessage: () => ({ id: 'fixture-message' }) }),
        control: async (operation: string) => { reads.push(operation); return { ready: true, configuration: { enabled: false }, state: { ownerPaused: true, errorCode: null, active: null } } },
        record: (value: unknown) => value !== null && typeof value === 'object', opaque: () => true, runDelegation: () => {}, createHash: () => {},
      }
      const names = Object.keys(context), values = Object.values(context)
      // Evaluate the actual generated fragment with injected public-runtime boundaries.
      const mount = new Function(...names, getAutonomyRuntimeSource() + '\nreturn mountAutonomy;')(...values) as (agent: unknown) => Promise<string[]>
      const first = newAgent()
      await mount(first)
      await vi.advanceTimersByTimeAsync(2000)
      expect(reads).toEqual([])
      current = first
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads).toEqual(['autonomy-snapshot'])
      await expect(mount(first)).rejects.toThrow('already owns')
      current = undefined
      const second = newAgent()
      await expect(mount(second)).resolves.toHaveLength(4)
      current = second
      const before = reads.length
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads.length - before).toBe(1)
      expect(second.ctx.tools.register).toHaveBeenCalledTimes(4)
      for (const release of releases) release()
      initialization.abort()
      const stopped = reads.length
      await vi.advanceTimersByTimeAsync(3000)
      expect(reads).toHaveLength(stopped)
    } finally { vi.useRealTimers() }
  })
})
