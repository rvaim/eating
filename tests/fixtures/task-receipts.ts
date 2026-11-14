import { vi } from 'vitest'
import type { AgentActionReceipt, HarnessHostServices } from '@eating/plugin-sdk'

/** Public Host contract double for runtime tests which do not instantiate EatingHost. */
export function withTaskReceipts(services: Omit<HarnessHostServices, 'readTaskActions' | 'finishTaskActions'>): HarnessHostServices {
  const records = new Map<string, { closed: boolean; baseline: Map<string, string>; actions: AgentActionReceipt[] }>()
  const open = (agentId: string, taskId: string | undefined) => {
    if (!taskId) return
    const key = agentId + ':' + taskId
    const existing = records.get(key)
    if (existing && !existing.closed) return
    records.set(key, { closed: false, baseline: new Map(services.readAgentActions(agentId).map(action => [action.requestId, JSON.stringify(action)])), actions: [] })
  }
  const read: HarnessHostServices['readTaskActions'] = (agentId, taskId) => {
    const record = records.get(agentId + ':' + taskId)
    if (!record) return { available: false, closed: false, actions: [] }
    if (!record.closed) record.actions = structuredClone(services.readAgentActions(agentId).filter(action => record.baseline.get(action.requestId) !== JSON.stringify(action)))
    return { available: true, closed: record.closed, actions: structuredClone(record.actions) }
  }
  const mcp = services.getMcpConnection, capabilities = services.getCapabilityMcpConnections
  return { ...services,
    getMcpConnection: vi.fn((pluginId, scope, policy, taskId) => { const value = mcp(pluginId, scope, policy, taskId); open(scope.agentId, taskId); return value }),
    getCapabilityMcpConnections: vi.fn((scope, taskId) => { const value = capabilities(scope, taskId); open(scope.agentId, taskId); return value }),
    readTaskActions: vi.fn(read),
    finishTaskActions: vi.fn((agentId, taskId) => { read(agentId, taskId); const row = records.get(agentId + ':' + taskId); if (row) row.closed = true; return read(agentId, taskId) }),
  }
}
