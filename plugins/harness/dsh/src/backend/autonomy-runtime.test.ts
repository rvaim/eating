import { describe, expect, it, vi } from 'vitest'
import { getAutonomyRuntimeSource } from './autonomy-runtime'

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
        control: async (operation: string, body?: { task?: unknown }) => operation === 'autonomy-snapshot' ? { ready: true, configuration: { enabled: true, targets: [{ id: 'legacy-target' }] }, state: { ownerPaused: false, errorCode: null, active: null }, contactPolicy: { mode: 'all', entryCount: 1 } }
          : operation === 'autonomy-claim' ? { admitted: true, cycle, activity, limits }
          : operation === 'autonomy-schedule-task' ? (scheduledTask = body?.task, { revision: 1, tasks: [] }) : {},
        record: (value: unknown) => value !== null && typeof value === 'object', opaque: () => true, runDelegation: () => {}, createHash: () => {},
      }
      const mount = new Function(...Object.keys(context), getAutonomyRuntimeSource() + '\nreturn mountAutonomy;')(...Object.values(context)) as (agent: unknown) => Promise<string[]>
      const names = await mount(agent)
      expect(names).toEqual(['eating_activity_state', 'eating_plan_activity', 'eating_schedule_task', 'eating_cancel_scheduled_task', 'eating_list_contact_targets', 'eating_contact_target'])
      expect(tools.map(tool => tool.name)).toEqual(names)
      for (const tool of tools) expect(tool.description).toMatch(/^\p{Script=Han}/u)
      expect(tools[1]!.parameters).toMatchObject({ properties: { mode: { enum: ['active', 'sleeping', 'waiting'] } }, required: ['expected_revision', 'mode', 'wake_at', 'note'], additionalProperties: false })
      expect(sections).toHaveLength(1)
      expect(sections[0]).toMatchObject({ name: 'eating:autonomy-policy', order: 20, interpolate: false })
      expect(sections[0]!.text()).toMatch(/^\p{Script=Han}/u)

      const stateTool = tools.find(tool => tool.name === 'eating_activity_state')!
      const modelState = await stateTool.execute!({}, { agent, callId: 'fixture-state', signal: new AbortController().signal })
      expect(modelState).toMatchObject({ configuration: { enabled: true }, contactPolicy: { mode: 'all', entryCount: 1 } })
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
      await expect(mount(second)).resolves.toHaveLength(6)
      current = second
      const before = reads.length
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads.length - before).toBe(1)
      expect(second.ctx.tools.register).toHaveBeenCalledTimes(6)
      for (const release of releases) release()
      initialization.abort()
      const stopped = reads.length
      await vi.advanceTimersByTimeAsync(3000)
      expect(reads).toHaveLength(stopped)
    } finally { vi.useRealTimers() }
  })
})
