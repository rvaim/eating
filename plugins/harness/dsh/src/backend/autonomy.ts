import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AutonomyConfiguration, JsonObject, ProactiveTarget } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'
import { DshAutonomyAgenda } from './autonomy-agenda'

interface Cycle { id: string; nonce: string; startedAt: number; deadline: number; configurationRevision: number; activityRevision: number }
interface AutonomyState {
  revision: number
  ownerPaused: boolean
  mode: 'active' | 'sleeping' | 'waiting'
  wakeAt: number | null
  note: string
  runUsedMs: number
  windowAt: number
  cycles: number
  contacts: number
  failures: number
  active: Cycle | null
  lastStartedAt: number | null
  lastFinishedAt: number | null
  lastOutcome: 'completed' | 'failed' | 'unknown' | 'cancelled' | null
  errorCode: string | null
  history: { cycleId: string; startedAt: number; finishedAt: number; outcome: string; code: string | null }[]
}
interface Document { schemaVersion: 3; revision: number; configuration: AutonomyConfiguration; state: AutonomyState }
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const exact = (value: JsonObject, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const errorMessages: Readonly<Record<string, string>> = {
  INVALID_AUTONOMY_CONFIGURATION: '自主运行配置参数无效，请核对字段和允许范围后提交。',
  INVALID_AUTONOMY_INPUT: '自主运行请求参数无效，请核对操作、字段和允许范围后提交。',
  AUTONOMY_STATE_CORRUPTED: '自主运行状态文件格式无效，原文件已保留；请由主人检查文件，不能通过重复活动安排修复。',
  AUTONOMY_REVISION_EXHAUSTED: '自主运行版本号已达到上限，请由主人检查状态；未保存此次操作。',
  AUTONOMY_CONFIGURATION_CONFLICT: '自主运行配置版本已变化，请读取最新 revision 后重新判断并提交操作。',
  AUTONOMY_ACTIVITY_CONFLICT: '活动安排版本已变化，请读取最新 state.revision 后重新判断并提交安排。',
  AUTONOMY_DISABLED: '主人尚未开启自主运行，无法开始定时活动；需要主人明确开启。',
  AUTONOMY_PAUSED: '自主定时活动已暂停，无法修改安排或定时任务；需要主人检查暂停原因并明确恢复。',
  AUTONOMY_CYCLE_RUNNING: '当前自主活动周期仍在运行，请等待该周期结束后再执行此操作。',
  AUTONOMY_RUNTIME_STALE: '此请求来自已失效的运行时，未执行；请使用当前运行时，勿重复提交旧请求。',
  AUTONOMY_TARGET_DENIED: '此联系对象当前未获授权，请选择当前联系人目录内允许的对象。',
  AUTONOMY_CONTACT_LIMIT: '当前小时的主动联系任务额度已用尽，请等待小时窗口重置；读取配置或安排 active 不会恢复额度。',
}
function fail(code = 'INVALID_AUTONOMY_CONFIGURATION', status = 400, details?: JsonObject, message = errorMessages[code] ?? '自主运行操作被拒绝，请根据错误码核对具体原因。'): never {
  throw Object.assign(new PlatformError(code, message, status, 'not-sent'), details ? { details } : {})
}
export const AUTONOMY_DEFAULTS: AutonomyConfiguration = Object.freeze({ enabled: false, autoResume: false, minIntervalSeconds: 60, maxRestMinutes: 15, maxCyclesPerHour: 12, maxRunMinutes: 120, cycleTimeoutSeconds: 120, maxConsecutiveFailures: 3, maxContactsPerHour: 6, targets: [] })
export function parseAutonomyConfiguration(input: unknown): AutonomyConfiguration {
  if (!isJsonObject(input) || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024 || !exact(input, Object.keys(AUTONOMY_DEFAULTS)) || typeof input.enabled !== 'boolean' || typeof input.autoResume !== 'boolean') fail()
  const bounds = { minIntervalSeconds: [1, 86400], maxRestMinutes: [1, 1440], maxCyclesPerHour: [1, 3600], maxRunMinutes: [1, 10080], cycleTimeoutSeconds: [10, 3600], maxConsecutiveFailures: [1, 10], maxContactsPerHour: [0, 1000] }
  for (const [name, [min, max]] of Object.entries(bounds)) if (!integer(input[name], min, max)) fail()
  if (Number(input.minIntervalSeconds) > Number(input.maxRestMinutes) * 60) fail('INVALID_AUTONOMY_CONFIGURATION', 400, undefined, '最短续行间隔不能超过最长休息或等待时间，请调整后再保存。')
  if (!Array.isArray(input.targets) || input.targets.length > 50) fail()
  const ids = new Set<string>(), identities = new Set<string>()
  for (const value of input.targets) {
    if (!isJsonObject(value) || !exact(value, ['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId', 'toolNames']) || !['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId'].every(key => text(value[key], key === 'label' ? 80 : 160)) || !Array.isArray(value.toolNames) || value.toolNames.length === 0 || value.toolNames.length > 256 || value.toolNames.some(name => !text(name, 160)) || new Set(value.toolNames).size !== value.toolNames.length || ids.has(String(value.id))) fail()
    const identity = JSON.stringify([value.pluginId, value.instanceId, value.accountId, value.agentTypeId, value.targetId])
    if (identities.has(identity)) fail()
    ids.add(String(value.id)); identities.add(identity)
  }
  return structuredClone(input) as unknown as AutonomyConfiguration
}
function fresh(): Document {
  return { schemaVersion: 3, revision: 0, configuration: { ...AUTONOMY_DEFAULTS }, state: { revision: 0, ownerPaused: true, mode: 'active', wakeAt: null, note: '', runUsedMs: 0, windowAt: 0, cycles: 0, contacts: 0, failures: 0, active: null, lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, errorCode: null, history: [] } }
}

/** Owns mechanical activity state only; the installed Harness decides and executes the activity. */
export class DshAutonomy {
  readonly filePath: string
  readonly agenda: DshAutonomyAgenda
  private document: Document
  private runtimeNonce: string | null = null
  private runtimeStartedAt = 0
  private observed: { phase: string; at: number } | null = null
  private targetDirectory: ((explicit: readonly ProactiveTarget[]) => Promise<readonly ProactiveTarget[]>) | null = null
  private resolvedTargets: readonly ProactiveTarget[] | null = null
  constructor(directory: string, private readonly runtimeReady: () => boolean, private readonly validateTargets: (targets: readonly ProactiveTarget[]) => void, private readonly onRevoke: () => void, private readonly clock: () => number = Date.now) {
    this.filePath = join(directory, 'autonomy.json')
    this.agenda = new DshAutonomyAgenda(directory, clock)
    try { if (statSync(this.filePath).size > 256 * 1024) fail('AUTONOMY_STATE_CORRUPTED', 500) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const data = readRestrictedJson(this.filePath)
    if (data === null) this.document = fresh()
    else {
      try {
        if (!exact(data, ['schemaVersion', 'revision', 'configuration', 'state']) || data.schemaVersion !== 3 || !integer(data.revision) || !isJsonObject(data.state)) fail()
        parseAutonomyConfiguration(data.configuration)
        const s = data.state
        if (!exact(s, Object.keys(fresh().state)) || !integer(s.revision) || typeof s.ownerPaused !== 'boolean' || !['active', 'sleeping', 'waiting'].includes(String(s.mode)) || typeof s.note !== 'string' || s.note.length > 500 || ['wakeAt', 'lastStartedAt', 'lastFinishedAt'].some(key => s[key] !== null && !integer(s[key])) || ['runUsedMs', 'windowAt', 'cycles', 'contacts', 'failures'].some(key => !integer(s[key])) || ![null, 'completed', 'failed', 'unknown', 'cancelled'].includes(s.lastOutcome as null) || s.errorCode !== null && !text(s.errorCode, 100) || !Array.isArray(s.history) || s.history.length > 20) fail()
        if (s.mode !== 'active' && s.wakeAt === null) fail()
        if (s.active !== null && (!isJsonObject(s.active) || !exact(s.active, ['id', 'nonce', 'startedAt', 'deadline', 'configurationRevision', 'activityRevision']) || !text(s.active.id) || !text(s.active.nonce) || ['startedAt', 'deadline', 'configurationRevision', 'activityRevision'].some(key => !integer((s.active as JsonObject)[key])))) fail()
        if (s.history.some(row => !isJsonObject(row) || !exact(row, ['cycleId', 'startedAt', 'finishedAt', 'outcome', 'code']) || !text(row.cycleId) || !integer(row.startedAt) || !integer(row.finishedAt) || !['completed', 'failed', 'unknown', 'cancelled'].includes(String(row.outcome)) || row.code !== null && !text(row.code, 100))) fail()
        this.document = structuredClone(data) as unknown as Document
      } catch { fail('AUTONOMY_STATE_CORRUPTED', 500) }
    }
  }
  private save(): void {
    try { writeRestrictedJson(this.filePath, this.document as unknown as JsonObject) }
    catch (error) { this.document.state.ownerPaused = true; this.document.state.errorCode = 'AUTONOMY_PERSISTENCE_FAILED'; this.onRevoke(); throw error }
  }
  private advance(): void { if (this.document.state.revision >= Number.MAX_SAFE_INTEGER) fail('AUTONOMY_REVISION_EXHAUSTED', 409); this.document.state.revision++ }
  private resetWindow(): void { const s = this.document.state, now = this.clock(); if (now - s.windowAt >= 3600000 || s.windowAt === 0) { s.windowAt = now; s.cycles = 0; s.contacts = 0 } }
  private elapsed(cycle: Cycle): number { return Math.max(0, Math.min(this.clock(), cycle.deadline) - cycle.startedAt) }
  configuration(): AutonomyConfiguration { return structuredClone(this.document.configuration) }
  setTargetDirectory(directory: (explicit: readonly ProactiveTarget[]) => Promise<readonly ProactiveTarget[]>): void { this.targetDirectory = directory; this.resolvedTargets = null }
  invalidateTargets(): void { this.resolvedTargets = null }
  async listTargets(): Promise<readonly ProactiveTarget[]> {
    const revision = this.document.revision
    const explicit = this.configuration().targets
    const targets = this.targetDirectory ? await this.targetDirectory(explicit) : explicit
    if (revision !== this.document.revision) fail('AUTONOMY_CONFIGURATION_CONFLICT', 409)
    this.resolvedTargets = structuredClone([...targets]); return structuredClone([...targets])
  }
  async prepareContactTarget(id: string): Promise<ProactiveTarget> { await this.listTargets(); return this.contactTarget(id) }
  private contactLimit(): JsonObject {
    const { configuration, state } = this.document, now = this.clock()
    const reset = state.windowAt === 0 || now - state.windowAt >= 3600000
    const used = reset ? 0 : state.contacts, limit = configuration.maxContactsPerHour
    const windowStartedAt = reset ? now : state.windowAt
    return { limit, used, remaining: Math.max(0, limit - used), exhausted: used >= limit, windowStartedAt, resetAt: windowStartedAt + 3600000 }
  }
  snapshot(): JsonObject {
    const { configuration, state } = this.document, now = this.clock()
    const reset = state.windowAt === 0 || now - state.windowAt >= 3600000
    const arrangedAt = Math.min(state.wakeAt ?? now, this.agenda.nextDueAt() ?? Infinity)
    const quotaAt = !reset && state.cycles >= configuration.maxCyclesPerHour ? state.windowAt + 3600000 : now
    let reason = !configuration.enabled ? 'disabled' : state.active && state.ownerPaused ? 'pausing' : state.errorCode === 'AUTONOMY_RUN_LIMIT' ? 'run-limit' : state.errorCode ? 'error' : state.ownerPaused ? 'owner-paused' : !this.runtimeReady() ? 'runtime-stopped' : state.active ? 'running' : quotaAt > now ? 'hourly-limit' : arrangedAt > now ? state.mode === 'waiting' ? 'waiting-event' : state.mode === 'sleeping' ? 'sleeping' : 'interval' : 'ready'
    if (['ready', 'waiting-event', 'sleeping', 'interval', 'hourly-limit'].includes(reason) && this.runtimeNonce && now - (this.observed?.at ?? this.runtimeStartedAt) > 15000) reason = 'status-unavailable'
    else if (reason === 'ready' && this.observed && now - this.observed.at < 5000 && this.observed.phase !== 'idle') reason = this.observed.phase
    const nextWakeAt = state.ownerPaused || !configuration.enabled || state.errorCode || !this.runtimeReady() ? null : Math.max(arrangedAt, quotaAt)
    const runUsedMs = state.runUsedMs + (state.active ? this.elapsed(state.active) : 0)
    const runRemainingMs = Math.max(0, configuration.maxRunMinutes * 60000 - runUsedMs)
    return { protocolVersion: 1, revision: this.document.revision, configuration: structuredClone(configuration) as unknown as JsonObject, agenda: this.agenda.snapshot(), state: { ...structuredClone(state), runUsedMs, cycles: reset ? 0 : state.cycles, contacts: reset ? 0 : state.contacts, contactLimit: this.contactLimit(), reason, nextWakeAt, runtimeReady: this.runtimeReady(), observedAt: this.observed?.at ?? null, runRemainingMs } as unknown as JsonObject }
  }
  async configure(input: unknown): Promise<JsonObject> {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'configuration']) || !integer(input.expectedRevision)) fail('INVALID_AUTONOMY_INPUT')
    if (input.expectedRevision !== this.document.revision) fail('AUTONOMY_CONFIGURATION_CONFLICT', 409)
    const configuration = parseAutonomyConfiguration(input.configuration)
    this.validateTargets(configuration.targets)
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) fail('AUTONOMY_REVISION_EXHAUSTED', 409)
    this.document.configuration = configuration; this.document.revision++; this.advance()
    if (this.document.state.mode !== 'active') this.document.state.wakeAt = Math.min(this.document.state.wakeAt!, this.clock() + configuration.maxRestMinutes * 60000)
    this.document.state.ownerPaused = true
    this.onRevoke(); this.save()
    return this.snapshot()
  }
  async control(operation: string, input: unknown): Promise<JsonObject> {
    if (!['pause', 'resume', 'wake'].includes(operation) || !isJsonObject(input) || !exact(input, ['expectedRevision', 'expectedActivityRevision']) || !integer(input.expectedRevision) || !integer(input.expectedActivityRevision)) fail('INVALID_AUTONOMY_INPUT')
    if (input.expectedRevision !== this.document.revision) fail('AUTONOMY_CONFIGURATION_CONFLICT', 409)
    if (input.expectedActivityRevision !== this.document.state.revision) fail('AUTONOMY_ACTIVITY_CONFLICT', 409)
    const s = this.document.state
    if (operation !== 'pause' && !this.document.configuration.enabled) fail('AUTONOMY_DISABLED', 409)
    if (operation !== 'pause' && s.active) fail('AUTONOMY_CYCLE_RUNNING', 409)
    this.advance(); this.onRevoke()
    if (operation === 'pause') s.ownerPaused = true
    else { s.ownerPaused = false; s.errorCode = null; s.failures = 0; s.runUsedMs = 0; if (operation === 'wake' || s.mode === 'active') { s.mode = 'active'; s.wakeAt = this.clock() } }
    this.save(); return this.snapshot()
  }
  private agendaAvailable(): void {
    const s = this.document.state
    if (!this.document.configuration.enabled) fail('AUTONOMY_DISABLED', 409)
    if (s.ownerPaused || s.errorCode) fail('AUTONOMY_PAUSED', 409)
  }
  scheduleTask(nonce: string, input: unknown): JsonObject { this.requireRuntime(nonce); this.agendaAvailable(); return this.agenda.schedule(input) }
  cancelTask(nonce: string, input: unknown): JsonObject { this.requireRuntime(nonce); this.agendaAvailable(); return this.agenda.cancel(input) }
  ownerCancelTask(input: unknown): JsonObject { return this.agenda.cancel(input) }
  startRuntime(nonce: string): void {
    const s = this.document.state
    if (s.active) { s.lastOutcome = 'unknown'; s.lastFinishedAt = this.clock(); s.errorCode = 'AUTONOMY_PREVIOUS_CYCLE_UNKNOWN'; s.active = null; s.ownerPaused = true; this.advance() }
    if (!this.document.configuration.autoResume) s.ownerPaused = true
    // Settled execution time survives a restart; downtime adds no execution time.
    this.runtimeNonce = nonce; this.runtimeStartedAt = this.clock(); this.observed = null
    if (this.document.configuration.enabled || s.errorCode) this.save()
  }
  stopRuntime(): void {
    try { if (this.runtimeNonce && this.document.state.active) this.finish(this.runtimeNonce, this.document.state.active.id, 'unknown', 'AUTONOMY_RUNTIME_STOPPED') }
    finally { this.runtimeNonce = null; this.observed = null; this.onRevoke() }
  }
  runtimeFault(nonce: string): JsonObject {
    this.requireRuntime(nonce)
    const s = this.document.state
    if (!this.document.configuration.enabled || s.ownerPaused) return { paused: false }
    s.ownerPaused = true; s.errorCode = 'AUTONOMY_CONTROL_FAILED'; this.advance(); this.onRevoke(); this.save()
    return { paused: true }
  }
  observe(phase: string): void { if (!['idle', 'busy', 'external-pending', 'native-goal'].includes(phase)) fail('INVALID_AUTONOMY_INPUT'); this.observed = { phase, at: this.clock() } }
  claim(nonce: string): JsonObject {
    this.requireRuntime(nonce)
    const s = this.document.state, c = this.document.configuration, now = this.clock()
    this.resetWindow()
    const scheduled = this.agenda.due(now)
    if (!c.enabled || s.ownerPaused || s.errorCode || !this.runtimeReady() || s.active || (!scheduled.length && (s.wakeAt ?? 0) > now) || s.cycles >= c.maxCyclesPerHour) return { admitted: false }
    const runRemainingMs = Math.max(0, c.maxRunMinutes * 60000 - s.runUsedMs)
    if (!runRemainingMs) { s.ownerPaused = true; s.errorCode = 'AUTONOMY_RUN_LIMIT'; this.advance(); this.save(); return { admitted: false } }
    const cycle: Cycle = { id: randomUUID(), nonce, startedAt: now, deadline: now + Math.min(c.cycleTimeoutSeconds * 1000, runRemainingMs), configurationRevision: this.document.revision, activityRevision: s.revision }
    const activity = { mode: s.mode, note: s.note }
    s.active = cycle; s.cycles++; s.lastStartedAt = now; s.mode = 'active'; s.wakeAt = null; this.save()
    // The cycle is durable before its one-shot task messages leave the agenda. A failed
    // agenda write leaves the task pending and the runtime exposes a fault instead of
    // silently dropping it.
    if (scheduled.length) this.agenda.consume(scheduled.map(task => task.id))
    return { admitted: true, cycle: { ...cycle, budgetLimited: runRemainingMs <= c.cycleTimeoutSeconds * 1000 }, activity, scheduledTasks: scheduled.map(task => ({ id: task.id, message: task.message, dueAt: task.dueAt })), limits: { minIntervalSeconds: c.minIntervalSeconds, maxRestMinutes: c.maxRestMinutes, maxCyclesPerHour: c.maxCyclesPerHour, maxRunMinutes: c.maxRunMinutes, runRemainingMs } }
  }
  validCycle(nonce: string, id: string): boolean { const { configuration: c, state: s } = this.document; return nonce === this.runtimeNonce && c.enabled && !s.ownerPaused && !s.errorCode && s.active?.id === id && s.active.nonce === nonce && s.active.configurationRevision === this.document.revision && this.clock() < s.active.deadline }
  activeCycle(): Cycle | null { return this.document.state.active ? { ...this.document.state.active } : null }
  decide(nonce: string, input: unknown): JsonObject {
    this.requireRuntime(nonce)
    if (!isJsonObject(input) || !exact(input, ['expectedActivityRevision', 'mode', 'wakeAt', 'note']) || !integer(input.expectedActivityRevision)) fail('INVALID_AUTONOMY_INPUT')
    if (input.expectedActivityRevision !== this.document.state.revision) fail('AUTONOMY_ACTIVITY_CONFLICT', 409)
    if (!this.document.configuration.enabled) fail('AUTONOMY_DISABLED', 409)
    if (this.document.state.ownerPaused) fail('AUTONOMY_PAUSED', 409)
    if (!['active', 'sleeping', 'waiting'].includes(String(input.mode)) || typeof input.note !== 'string' || input.note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.note)) fail('INVALID_AUTONOMY_INPUT')
    const now = this.clock()
    if (input.mode === 'sleeping' ? !integer(input.wakeAt, now + 1000, now + 365 * 86400000) : input.wakeAt !== null) fail('INVALID_AUTONOMY_INPUT')
    const s = this.document.state
    const restDeadline = now + this.document.configuration.maxRestMinutes * 60000
    this.advance(); s.mode = input.mode as AutonomyState['mode']; s.note = input.note; s.wakeAt = input.mode === 'sleeping' ? Math.min(input.wakeAt as number, restDeadline) : input.mode === 'active' ? now + this.document.configuration.minIntervalSeconds * 1000 : restDeadline
    // The current cycle settles first; a rest boundary starts a new budget after it.
    if (input.mode !== 'active' && !s.active) s.runUsedMs = 0
    this.save(); return this.snapshot()
  }
  finish(nonce: string, cycleId: string, outcome: 'completed' | 'failed' | 'unknown' | 'cancelled', code: string | null): JsonObject {
    this.requireRuntime(nonce)
    const s = this.document.state, cycle = s.active
    if (!cycle || cycle.id !== cycleId || cycle.nonce !== nonce) return { accepted: false }
    if (code !== null && !/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) fail('INVALID_AUTONOMY_INPUT')
    // Revocation can finish a child before the native driver's next heartbeat.
    // Settle from current authority so a late normal turn/end cannot undo pause.
    if (outcome === 'completed' && (s.ownerPaused || !this.document.configuration.enabled || cycle.configurationRevision !== this.document.revision)) {
      outcome = 'cancelled'; code = s.ownerPaused ? 'AUTONOMY_OWNER_PAUSED' : 'AUTONOMY_CYCLE_REVOKED'
    }
    s.runUsedMs += this.elapsed(cycle)
    s.active = null; s.lastOutcome = outcome; s.lastFinishedAt = this.clock()
    s.history.push({ cycleId, startedAt: cycle.startedAt, finishedAt: s.lastFinishedAt, outcome, code }); s.history = s.history.slice(-20)
    if (outcome === 'completed') s.failures = 0
    else if (outcome !== 'cancelled' && code !== 'AUTONOMY_RUN_LIMIT') { s.failures++; if (outcome === 'unknown' || s.failures >= this.document.configuration.maxConsecutiveFailures) { s.errorCode = code ?? 'AUTONOMY_CYCLE_FAILED'; s.ownerPaused = true; this.advance() } }
    if (code === 'AUTONOMY_RUN_LIMIT' || outcome === 'completed' && s.mode === 'active' && s.runUsedMs >= this.document.configuration.maxRunMinutes * 60000) { s.ownerPaused = true; s.errorCode = 'AUTONOMY_RUN_LIMIT'; this.advance() }
    if (s.mode !== 'active') s.runUsedMs = 0
    if (s.mode === 'active') s.wakeAt = Math.max(s.wakeAt ?? 0, this.clock() + this.document.configuration.minIntervalSeconds * 1000 * Math.max(1, s.failures))
    this.onRevoke(); this.save(); return { accepted: true }
  }
  contactTarget(id: string): ProactiveTarget {
    const target = (this.targetDirectory ? this.resolvedTargets ?? [] : this.document.configuration.targets).find(target => target.id === id)
    if (!target) fail('AUTONOMY_TARGET_DENIED', 403)
    this.validateTargets([target]); return structuredClone(target)
  }
  assertContactAvailable(): void {
    const contactLimit = this.contactLimit()
    if (contactLimit.exhausted) {
      const reset = contactLimit.limit === 0 ? '主人当前将小时上限设为 0，窗口重置后也无可用额度。' : `此窗口将于 ${new Date(Number(contactLimit.resetAt)).toISOString()} 重置，请等待重置后再判断是否联系。`
      fail('AUTONOMY_CONTACT_LIMIT', 409, { contactLimit }, `当前小时的主动联系任务额度已用尽（已用 ${contactLimit.used}/${contactLimit.limit}，剩余 0）。${reset}本次未发送；读取配置或安排 active 不会恢复额度。`)
    }
  }
  countContact(): void {
    this.assertContactAvailable()
    this.resetWindow()
    this.document.state.contacts++; this.save()
  }
  contactTargetStillAllowed(target: ProactiveTarget): boolean { return JSON.stringify((this.targetDirectory ? this.resolvedTargets ?? [] : this.document.configuration.targets).find(candidate => candidate.id === target.id)) === JSON.stringify(target) }
  private requireRuntime(nonce: string): void { if (!this.runtimeNonce || nonce !== this.runtimeNonce) fail('AUTONOMY_RUNTIME_STALE', 409) }
}
