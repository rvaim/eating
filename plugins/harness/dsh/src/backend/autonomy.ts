import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { AutonomyConfiguration, JsonObject, ProactiveTarget } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'

interface Cycle { id: string; nonce: string; startedAt: number; deadline: number; configurationRevision: number; activityRevision: number }
interface AutonomyState {
  revision: number
  ownerPaused: boolean
  mode: 'active' | 'sleeping' | 'waiting'
  wakeAt: number | null
  note: string
  startedAt: number | null
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
interface Document { schemaVersion: 1; revision: number; configuration: AutonomyConfiguration; state: AutonomyState }
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const exact = (value: JsonObject, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
function fail(code = 'INVALID_AUTONOMY_CONFIGURATION', status = 400): never { throw new PlatformError(code, '自主运行配置或状态无效，请重新读取并核对。', status, 'not-sent') }
export const AUTONOMY_DEFAULTS: AutonomyConfiguration = Object.freeze({ enabled: false, autoResume: false, minIntervalSeconds: 60, maxCyclesPerHour: 12, maxRunMinutes: 120, cycleTimeoutSeconds: 120, maxConsecutiveFailures: 3, maxContactsPerHour: 6, targets: [] })
export function parseAutonomyConfiguration(input: unknown): AutonomyConfiguration {
  if (!isJsonObject(input) || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024 || !exact(input, Object.keys(AUTONOMY_DEFAULTS)) || typeof input.enabled !== 'boolean' || typeof input.autoResume !== 'boolean') fail()
  const bounds = { minIntervalSeconds: [1, 86400], maxCyclesPerHour: [1, 3600], maxRunMinutes: [1, 10080], cycleTimeoutSeconds: [10, 3600], maxConsecutiveFailures: [1, 10], maxContactsPerHour: [0, 1000] }
  for (const [name, [min, max]] of Object.entries(bounds)) if (!integer(input[name], min, max)) fail()
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
  return { schemaVersion: 1, revision: 0, configuration: { ...AUTONOMY_DEFAULTS }, state: { revision: 0, ownerPaused: true, mode: 'active', wakeAt: null, note: '', startedAt: null, windowAt: 0, cycles: 0, contacts: 0, failures: 0, active: null, lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, errorCode: null, history: [] } }
}

/** Owns mechanical activity state only; the installed Harness decides and executes the activity. */
export class DshAutonomy {
  readonly filePath: string
  private document: Document
  private runtimeNonce: string | null = null
  private runtimeStartedAt = 0
  private observed: { phase: string; at: number } | null = null
  private targetDirectory: ((explicit: readonly ProactiveTarget[]) => Promise<readonly ProactiveTarget[]>) | null = null
  private resolvedTargets: readonly ProactiveTarget[] | null = null
  constructor(directory: string, private readonly runtimeReady: () => boolean, private readonly validateTargets: (targets: readonly ProactiveTarget[]) => void, private readonly onRevoke: () => void, private readonly clock: () => number = Date.now) {
    this.filePath = join(directory, 'autonomy.json')
    try { if (statSync(this.filePath).size > 256 * 1024) fail('AUTONOMY_STATE_CORRUPTED', 500) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const data = readRestrictedJson(this.filePath)
    if (data === null) this.document = fresh()
    else {
      try {
        if (!exact(data, ['schemaVersion', 'revision', 'configuration', 'state']) || data.schemaVersion !== 1 || !integer(data.revision) || !isJsonObject(data.state)) fail()
        parseAutonomyConfiguration(data.configuration)
        const s = data.state
        if (!exact(s, Object.keys(fresh().state)) || !integer(s.revision) || typeof s.ownerPaused !== 'boolean' || !['active', 'sleeping', 'waiting'].includes(String(s.mode)) || typeof s.note !== 'string' || s.note.length > 500 || ['wakeAt', 'startedAt', 'lastStartedAt', 'lastFinishedAt'].some(key => s[key] !== null && !integer(s[key])) || ['windowAt', 'cycles', 'contacts', 'failures'].some(key => !integer(s[key])) || ![null, 'completed', 'failed', 'unknown', 'cancelled'].includes(s.lastOutcome as null) || s.errorCode !== null && !text(s.errorCode, 100) || !Array.isArray(s.history) || s.history.length > 20) fail()
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
  async prepareTarget(nonce: string, cycleId: string, id: string): Promise<ProactiveTarget> { await this.listTargets(); return this.target(nonce, cycleId, id) }
  snapshot(): JsonObject {
    const { configuration, state } = this.document, now = this.clock()
    const reset = now - state.windowAt >= 3600000
    let reason = !configuration.enabled ? 'disabled' : state.active && state.ownerPaused ? 'pausing' : state.errorCode ? 'error' : state.ownerPaused ? 'owner-paused' : !this.runtimeReady() ? 'runtime-stopped' : state.active ? 'running' : state.mode === 'waiting' ? 'waiting-event' : (state.wakeAt ?? 0) > now ? state.mode === 'sleeping' ? 'sleeping' : 'interval' : !reset && state.cycles >= configuration.maxCyclesPerHour ? 'hourly-limit' : 'ready'
    if (['ready', 'waiting-event', 'sleeping', 'interval', 'hourly-limit'].includes(reason) && this.runtimeNonce && now - (this.observed?.at ?? this.runtimeStartedAt) > 15000) reason = 'status-unavailable'
    else if (reason === 'ready' && this.observed && now - this.observed.at < 5000 && this.observed.phase !== 'idle') reason = this.observed.phase
    const nextWakeAt = reason === 'hourly-limit' ? state.windowAt + 3600000 : state.ownerPaused || !configuration.enabled || state.mode === 'waiting' ? null : state.wakeAt
    return { protocolVersion: 1, revision: this.document.revision, configuration: structuredClone(configuration) as unknown as JsonObject, state: { ...structuredClone(state), cycles: reset ? 0 : state.cycles, contacts: reset ? 0 : state.contacts, reason, nextWakeAt, runtimeReady: this.runtimeReady(), observedAt: this.observed?.at ?? null } as unknown as JsonObject }
  }
  async configure(input: unknown): Promise<JsonObject> {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'configuration']) || input.expectedRevision !== this.document.revision) fail('AUTONOMY_CONFIGURATION_CONFLICT', 409)
    const configuration = parseAutonomyConfiguration(input.configuration)
    this.validateTargets(configuration.targets)
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) fail('AUTONOMY_REVISION_EXHAUSTED', 409)
    this.document.configuration = configuration; this.document.revision++; this.advance()
    this.document.state.ownerPaused = true
    this.onRevoke(); this.save()
    return this.snapshot()
  }
  async control(operation: string, input: unknown): Promise<JsonObject> {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'expectedActivityRevision']) || input.expectedRevision !== this.document.revision || input.expectedActivityRevision !== this.document.state.revision) fail('AUTONOMY_CONFIGURATION_CONFLICT', 409)
    if (!['pause', 'resume', 'wake'].includes(operation)) fail()
    const s = this.document.state
    if (operation !== 'pause' && !this.document.configuration.enabled) fail('AUTONOMY_DISABLED', 409)
    if (operation !== 'pause' && s.active) fail('AUTONOMY_CYCLE_RUNNING', 409)
    this.advance(); this.onRevoke()
    if (operation === 'pause') s.ownerPaused = true
    else { s.ownerPaused = false; s.errorCode = null; s.failures = 0; s.startedAt = this.clock(); if (operation === 'wake' || s.mode === 'active') { s.mode = 'active'; s.wakeAt = this.clock() } }
    this.save(); return this.snapshot()
  }
  startRuntime(nonce: string): void {
    const s = this.document.state
    if (s.active) { s.lastOutcome = 'unknown'; s.lastFinishedAt = this.clock(); s.errorCode = 'AUTONOMY_PREVIOUS_CYCLE_UNKNOWN'; s.active = null; s.ownerPaused = true; this.advance() }
    if (!this.document.configuration.autoResume) s.ownerPaused = true
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
  observe(phase: string): void { if (!['idle', 'busy', 'external-pending', 'native-goal'].includes(phase)) fail(); this.observed = { phase, at: this.clock() } }
  claim(nonce: string): JsonObject {
    this.requireRuntime(nonce)
    const s = this.document.state, c = this.document.configuration, now = this.clock()
    this.resetWindow()
    if (!c.enabled || s.ownerPaused || s.errorCode || !this.runtimeReady() || s.active || s.mode === 'waiting' || (s.wakeAt ?? 0) > now || s.cycles >= c.maxCyclesPerHour) return { admitted: false }
    if (s.startedAt !== null && now - s.startedAt >= c.maxRunMinutes * 60000) { s.ownerPaused = true; s.errorCode = 'AUTONOMY_RUN_LIMIT'; this.advance(); this.save(); return { admitted: false } }
    s.startedAt ??= now
    const cycle: Cycle = { id: randomUUID(), nonce, startedAt: now, deadline: Math.min(now + c.cycleTimeoutSeconds * 1000, s.startedAt + c.maxRunMinutes * 60000), configurationRevision: this.document.revision, activityRevision: s.revision }
    const activity = { mode: s.mode, note: s.note }
    s.active = cycle; s.cycles++; s.lastStartedAt = now; s.mode = 'active'; s.wakeAt = null; this.save()
    return { admitted: true, cycle: { ...cycle }, activity, limits: { minIntervalSeconds: c.minIntervalSeconds, maxCyclesPerHour: c.maxCyclesPerHour } }
  }
  validCycle(nonce: string, id: string): boolean { const { configuration: c, state: s } = this.document; return nonce === this.runtimeNonce && c.enabled && !s.ownerPaused && !s.errorCode && s.active?.id === id && s.active.nonce === nonce && s.active.configurationRevision === this.document.revision && this.clock() < s.active.deadline }
  activeCycle(): Cycle | null { return this.document.state.active ? { ...this.document.state.active } : null }
  decide(nonce: string, input: unknown): JsonObject {
    this.requireRuntime(nonce)
    if (!isJsonObject(input) || !exact(input, ['expectedActivityRevision', 'mode', 'wakeAt', 'note']) || input.expectedActivityRevision !== this.document.state.revision) fail('AUTONOMY_ACTIVITY_CONFLICT', 409)
    if (!this.document.configuration.enabled || this.document.state.ownerPaused) fail('AUTONOMY_PAUSED', 409)
    if (!['active', 'sleeping', 'waiting'].includes(String(input.mode)) || typeof input.note !== 'string' || input.note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.note)) fail()
    const now = this.clock()
    if (input.mode === 'sleeping' ? !integer(input.wakeAt, now + 1000, now + 365 * 86400000) : input.wakeAt !== null) fail()
    const s = this.document.state
    this.advance(); s.mode = input.mode as AutonomyState['mode']; s.note = input.note; s.wakeAt = input.mode === 'sleeping' ? input.wakeAt as number : input.mode === 'active' ? now + this.document.configuration.minIntervalSeconds * 1000 : null
    this.save(); return this.snapshot()
  }
  finish(nonce: string, cycleId: string, outcome: 'completed' | 'failed' | 'unknown' | 'cancelled', code: string | null): JsonObject {
    this.requireRuntime(nonce)
    const s = this.document.state, cycle = s.active
    if (!cycle || cycle.id !== cycleId || cycle.nonce !== nonce) return { accepted: false }
    if (code !== null && !/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) fail()
    s.active = null; s.lastOutcome = outcome; s.lastFinishedAt = this.clock()
    s.history.push({ cycleId, startedAt: cycle.startedAt, finishedAt: s.lastFinishedAt, outcome, code }); s.history = s.history.slice(-20)
    if (outcome === 'completed') s.failures = 0
    else if (outcome !== 'cancelled') { s.failures++; if (outcome === 'unknown' || s.failures >= this.document.configuration.maxConsecutiveFailures) { s.errorCode = code ?? 'AUTONOMY_CYCLE_FAILED'; s.ownerPaused = true; this.advance() } }
    if (s.mode === 'active') s.wakeAt = Math.max(s.wakeAt ?? 0, this.clock() + this.document.configuration.minIntervalSeconds * 1000 * Math.max(1, s.failures))
    this.onRevoke(); this.save(); return { accepted: true }
  }
  target(nonce: string, cycleId: string, id: string): ProactiveTarget {
    if (!this.validCycle(nonce, cycleId)) fail('AUTONOMY_CYCLE_REVOKED', 409)
    this.resetWindow()
    if (this.document.state.contacts >= this.document.configuration.maxContactsPerHour) fail('AUTONOMY_CONTACT_LIMIT', 409)
    const target = (this.targetDirectory ? this.resolvedTargets ?? [] : this.document.configuration.targets).find(target => target.id === id)
    if (!target) fail('AUTONOMY_TARGET_DENIED', 403)
    this.validateTargets([target]); return structuredClone(target)
  }
  countContact(): void { this.document.state.contacts++; this.save() }
  targetStillAllowed(nonce: string, cycleId: string, target: ProactiveTarget): boolean { return this.validCycle(nonce, cycleId) && JSON.stringify((this.targetDirectory ? this.resolvedTargets ?? [] : this.document.configuration.targets).find(candidate => candidate.id === target.id)) === JSON.stringify(target) }
  private requireRuntime(nonce: string): void { if (!this.runtimeNonce || nonce !== this.runtimeNonce) fail('AUTONOMY_RUNTIME_STALE', 409) }
}
