import type { AgentInvocationScope } from './agents.js'
import type { JsonObject } from './index.js'

export interface ProactiveChannel {
  readonly pluginId: string
  readonly pluginName: string
  readonly instanceId: string
  readonly accountId: string
  readonly agentTypeId: string
  readonly kind: 'private' | 'group'
  readonly title: string
  readonly tools: readonly { readonly name: string; readonly title: string }[]
}
export interface ProactiveTarget {
  readonly id: string
  readonly label: string
  readonly pluginId: string
  readonly instanceId: string
  readonly accountId: string
  readonly agentTypeId: string
  readonly targetId: string
  readonly toolNames: readonly string[]
}
export interface ProactiveScopeRequest {
  readonly agentId: string
  readonly instanceId: string
  readonly accountId: string
  readonly agentTypeId: string
  readonly targetId: string
}
export interface ScopedAccessPolicy {
  readonly readOnly?: boolean
  readonly toolNames: readonly string[]
  /** Host-process closure, never serialized or model supplied. */
  readonly active: () => boolean
}
export interface AutonomyConfiguration {
  readonly enabled: boolean
  readonly autoResume: boolean
  readonly minIntervalSeconds: number
  /** Maximum AI-requested rest or event wait before another eligible opportunity. */
  readonly maxRestMinutes: number
  readonly maxCyclesPerHour: number
  readonly maxRunMinutes: number
  readonly cycleTimeoutSeconds: number
  readonly maxConsecutiveFailures: number
  readonly maxContactsPerHour: number
  readonly targets: readonly ProactiveTarget[]
}
export interface HarnessAutonomy {
  snapshot(): JsonObject
  configure(input: unknown): Promise<JsonObject>
  control(operation: string, input: unknown): Promise<JsonObject>
  contacts?(input: unknown): Promise<JsonObject>
}
export interface ProactiveContactChannel { readonly instanceId: string; readonly accountId: string; readonly agentTypeId: string }
export interface ProactiveContact { readonly id: string; readonly name: string }
export interface ProactiveContactEntry {
  readonly pluginId: string
  readonly instanceId: string
  readonly accountId: string
  readonly agentTypeId: string
  readonly targetId: string
  readonly label: string
}
export interface ProactiveContactPolicy {
  readonly schemaVersion: 1
  readonly revision: number
  readonly mode: 'all' | 'allowlist' | 'denylist'
  readonly entries: readonly ProactiveContactEntry[]
}
export interface CommunicationProactive {
  channels(): readonly ProactiveChannel[]
  contacts?(request: ProactiveContactChannel): Promise<readonly ProactiveContact[]>
  scope(request: ProactiveScopeRequest): AgentInvocationScope
}
