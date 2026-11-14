import { describe, expect, it } from 'vitest'
import { settledTaskState } from './task-lifecycle'
describe('task lifecycle and action uncertainty', () => {
  it('settles an interrupted task only from available closed receipts', () => {
    const known = [{ requestId: 'receipt-001', tool: 'send', outcome: 'succeeded' as const }]
    expect(settledTaskState('interrupted', { available: true, closed: true, actions: known })).toBe('interrupted')
    expect(settledTaskState('unknown', { available: true, closed: true, actions: known })).toBe('interrupted')
    expect(settledTaskState('completed', { available: true, closed: true, actions: known })).toBe('completed')
    expect(settledTaskState('interrupted', { available: false, closed: false, actions: [] })).toBe('unknown')
    expect(settledTaskState('interrupted', { available: true, closed: false, actions: known })).toBe('unknown')
    expect(settledTaskState('completed', { available: true, closed: true, actions: [{ ...known[0]!, outcome: 'unknown' }] })).toBe('unknown')
  })
})
