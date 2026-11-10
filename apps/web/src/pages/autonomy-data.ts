import { isJsonObject } from '@eating/plugin-sdk'
import type { AutonomyConfiguration, ProactiveTarget, ProactiveChannel, ProactiveContactPolicy } from '@eating/plugin-sdk'
import { HostApiError } from '@eating/ui-sdk'

export interface ActivityState {
  revision: number; ownerPaused: boolean; mode: 'active' | 'sleeping' | 'waiting'; note: string; reason: string; nextWakeAt: number | null; runtimeReady: boolean
  active: { id: string; startedAt: number; deadline: number } | null; cycles: number; contacts: number; failures: number; lastStartedAt: number | null; lastFinishedAt: number | null; lastOutcome: string | null; errorCode: string | null; runUsedMs: number; runRemainingMs: number
  history: { cycleId: string; startedAt: number; finishedAt: number; outcome: string; code: string | null }[]
}
export interface ScheduledTask { id: string; message: string; dueAt: number; createdAt: number }
export interface Snapshot { contactPolicy?: ProactiveContactPolicy; agenda?: { revision: number; tasks: ScheduledTask[] }; protocolVersion: 1; revision: number; configuration: AutonomyConfiguration; state: ActivityState; contactTasks: { agentId: string; targetId: string; label: string; taskId: string; state: string }[] }
export interface Harness { id: string; name: string; enabled: boolean; status: string; supported: boolean; snapshot: Snapshot | null }
export interface Directory { protocolVersion: 1; harnesses: Harness[]; channels: ProactiveChannel[] }
export type NumericKey = Exclude<keyof AutonomyConfiguration, 'enabled' | 'autoResume' | 'targets'>
export type Draft = { enabled: boolean; autoResume: boolean; targets: ProactiveTarget[] } & Record<NumericKey, string>
export const fields: { name: NumericKey; min: number; max: number }[] = [{ name: 'minIntervalSeconds', min: 1, max: 86400 }, { name: 'maxRestMinutes', min: 1, max: 1440 }, { name: 'maxCyclesPerHour', min: 1, max: 3600 }, { name: 'maxRunMinutes', min: 1, max: 10080 }, { name: 'cycleTimeoutSeconds', min: 10, max: 3600 }, { name: 'maxConsecutiveFailures', min: 1, max: 10 }, { name: 'maxContactsPerHour', min: 0, max: 1000 }]
export function readDirectory(value: unknown): Directory {
  const invalid = (): never => { throw new HostApiError('AUTONOMY_RESPONSE_INVALID', '', 'failed') }
  if (!isJsonObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.harnesses) || value.harnesses.length > 100 || !Array.isArray(value.channels) || value.channels.length > 500) return invalid()
  for (const row of value.harnesses) {
    if (!isJsonObject(row) || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.enabled !== 'boolean' || typeof row.supported !== 'boolean') return invalid()
    if (row.supported !== (row.snapshot !== null)) return invalid()
    if (row.snapshot !== null) {
      const snapshot = row.snapshot
      if (!isJsonObject(snapshot) || snapshot.protocolVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || !isJsonObject(snapshot.configuration) || !isJsonObject(snapshot.state) || !Array.isArray(snapshot.contactTasks)) return invalid()
      if (snapshot.contactPolicy !== undefined) {
        const policy = snapshot.contactPolicy
        if (!isJsonObject(policy) || policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.revision) || Number(policy.revision) < 0 || !['all', 'allowlist', 'denylist'].includes(String(policy.mode)) || !Array.isArray(policy.entries) || policy.entries.length > 1000 || policy.entries.some(entry => !isJsonObject(entry) || ['pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId', 'label'].some(key => typeof entry[key] !== 'string' || String(entry[key]).length > 160))) return invalid()
      }
      const c = snapshot.configuration, s = snapshot.state
      if (typeof c.enabled !== 'boolean' || typeof c.autoResume !== 'boolean' || fields.some(field => !Number.isSafeInteger(c[field.name]) || Number(c[field.name]) < field.min || Number(c[field.name]) > field.max) || !Array.isArray(c.targets) || c.targets.length > 50 || typeof s.ownerPaused !== 'boolean' || !['active', 'sleeping', 'waiting'].includes(String(s.mode)) || typeof s.note !== 'string' || typeof s.reason !== 'string' || !Number.isSafeInteger(s.revision) || !Array.isArray(s.history) || s.history.length > 20) invalid()
      if (Number(c.minIntervalSeconds) > Number(c.maxRestMinutes) * 60) invalid()
      const safeText = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max
      if (snapshot.agenda !== undefined) {
        const agenda = snapshot.agenda
        if (!isJsonObject(agenda) || !Number.isSafeInteger(agenda.revision) || Number(agenda.revision) < 0 || !Array.isArray(agenda.tasks) || agenda.tasks.length > 50 || agenda.tasks.some(task => !isJsonObject(task) || Object.keys(task).length !== 4 || !safeText(task.id) || !safeText(task.message, 2000) || !Number.isSafeInteger(task.dueAt) || !Number.isSafeInteger(task.createdAt))) return invalid()
      }
      if ((c.targets as unknown[]).some(target => !isJsonObject(target) || ['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId'].some(key => !safeText(target[key])) || !Array.isArray(target.toolNames) || target.toolNames.length > 256 || target.toolNames.some(name => !safeText(name, 160)))) return invalid()
      if (['runUsedMs', 'runRemainingMs', 'cycles', 'contacts', 'failures'].some(key => !Number.isSafeInteger(s[key]) || Number(s[key]) < 0) || ['nextWakeAt', 'lastStartedAt', 'lastFinishedAt'].some(key => s[key] !== null && (!Number.isSafeInteger(s[key]) || Number(s[key]) < 0)) || typeof s.runtimeReady !== 'boolean' || ![null, 'completed', 'failed', 'unknown', 'cancelled'].includes(s.lastOutcome as null) || s.errorCode !== null && !safeText(s.errorCode, 100)) return invalid()
      if (s.active !== null && (!isJsonObject(s.active) || !safeText(s.active.id) || !Number.isSafeInteger(s.active.startedAt) || !Number.isSafeInteger(s.active.deadline))) return invalid()
      if ((s.history as unknown[]).some(row => !isJsonObject(row) || !safeText(row.cycleId) || !Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.finishedAt) || !['completed', 'failed', 'unknown', 'cancelled'].includes(String(row.outcome)) || row.code !== null && !safeText(row.code, 100)) || snapshot.contactTasks.length > 100 || snapshot.contactTasks.some(row => !isJsonObject(row) || ['agentId', 'targetId', 'label', 'taskId'].some(key => !safeText(row[key])) || !['pending', 'completed', 'failed', 'unknown', 'reviewed'].includes(String(row.state)))) return invalid()
    }
  }
  for (const row of value.channels) if (!isJsonObject(row) || ['pluginId', 'pluginName', 'instanceId', 'accountId', 'agentTypeId', 'title'].some(key => typeof row[key] !== 'string') || !['private', 'group'].includes(String(row.kind)) || !Array.isArray(row.tools) || row.tools.length > 256 || row.tools.some(tool => !isJsonObject(tool) || typeof tool.name !== 'string' || typeof tool.title !== 'string')) invalid()
  return value as unknown as Directory
}
export function makeDraft(c: AutonomyConfiguration): Draft { return { ...Object.fromEntries(fields.map(field => [field.name, String(c[field.name])])), enabled: c.enabled, autoResume: c.autoResume, targets: structuredClone([...c.targets]) } as Draft }
export const channelKey = (target: Pick<ProactiveTarget, 'pluginId' | 'instanceId' | 'accountId' | 'agentTypeId'>) => JSON.stringify([target.pluginId, target.instanceId, target.accountId, target.agentTypeId])

