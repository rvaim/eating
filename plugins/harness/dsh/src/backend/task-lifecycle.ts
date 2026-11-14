import type { AgentTaskActions } from '@eating/plugin-sdk'

/** A whole multi-step task has its own bound, independent of one model/MCP request. */
export const AGENT_TASK_LIFETIME_MS = 15 * 60 * 1000
export type TaskEndState = 'completed' | 'failed' | 'interrupted' | 'unknown'

export function settledTaskState(requested: TaskEndState, receipts: AgentTaskActions): TaskEndState {
  if (!receipts.available || !receipts.closed || receipts.actions.some(action => action.outcome === 'unknown')) return 'unknown'
  return requested === 'unknown' ? 'interrupted' : requested
}
