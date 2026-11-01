import { describe, expect, it, vi } from 'vitest'
import { getAutonomyRuntimeSource } from './autonomy-runtime'

describe('native autonomous driver publication lifecycle', () => {
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
