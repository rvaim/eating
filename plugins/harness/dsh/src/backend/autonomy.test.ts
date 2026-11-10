import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject, ProactiveTarget } from '@eating/plugin-sdk'
import { AUTONOMY_DEFAULTS, DshAutonomy } from './autonomy'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) { if (realpathSync(directory) !== directory || dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('eating-autonomy-')) throw new Error('Unsafe autonomy fixture cleanup'); rmSync(directory, { recursive: true }) } })
function fixture() {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-autonomy-'))); directories.push(directory)
  let now = 1700000000000, ready = true
  const revoke = vi.fn(), targets = vi.fn()
  const activity = new DshAutonomy(directory, () => ready, targets, revoke, () => now)
  const control = (operation: string) => { const snapshot = activity.snapshot(); return activity.control(operation, { expectedRevision: snapshot.revision!, expectedActivityRevision: (snapshot.state as JsonObject).revision! }) }
  const configure = (values = {}) => activity.configure({ expectedRevision: activity.snapshot().revision, configuration: { ...AUTONOMY_DEFAULTS, enabled: true, minIntervalSeconds: 1, ...values } })
  const advance = (ms: number) => { now += ms }
  return { directory, activity, control, configure, advance, revoke, targets, setReady: (value: boolean) => { ready = value }, now: () => now }
}
const state = (activity: DshAutonomy) => activity.snapshot().state as JsonObject
const target: ProactiveTarget = { id: 'owner-approved-target', label: 'Fixture owner', pluginId: 'qq', instanceId: 'fixture', accountId: '100', agentTypeId: 'qq.private', targetId: '200', toolNames: ['qq_send_private_message'] }

describe('owner controlled autonomous activity state', () => {
  it('excludes interval and hourly-quota waits from the persisted execution budget', async () => {
    const f = fixture(); await f.configure({ minIntervalSeconds: 60, maxRunMinutes: 120, maxCyclesPerHour: 12 }); f.activity.startRuntime('runtime'); await f.control('resume')
    for (let hour = 0; hour < 2; hour++) {
      const window = f.now()
      for (let i = 0; i < 12; i++) {
        const cycle = f.activity.claim('runtime').cycle as JsonObject
        f.advance(3000); f.activity.finish('runtime', String(cycle.id), 'completed', null); f.advance(60000)
      }
      expect(f.activity.claim('runtime').admitted).toBe(false)
      f.advance(3600000 - (f.now() - window))
    }
    expect(state(f.activity)).toMatchObject({ ownerPaused: false, errorCode: null, failures: 0, runUsedMs: 72000, runRemainingMs: 120 * 60000 - 72000 })
    const stored = readFileSync(f.activity.filePath, 'utf8'), revision = state(f.activity).revision
    f.advance(3600000)
    expect(state(f.activity).runUsedMs).toBe(72000)
    expect(state(f.activity).revision).toBe(revision); expect(readFileSync(f.activity.filePath, 'utf8')).toBe(stored)
    expect(f.activity.claim('runtime').admitted).toBe(true)
  })
  it('preserves measured time across restart, shows live usage without saving and stops at the remaining budget', async () => {
    const f = fixture(); await f.configure({ maxRunMinutes: 1, cycleTimeoutSeconds: 120, autoResume: true }); f.activity.startRuntime('first'); await f.control('resume')
    const first = f.activity.claim('first').cycle as JsonObject
    const before = readFileSync(f.activity.filePath, 'utf8')
    f.advance(59000); expect(state(f.activity)).toMatchObject({ runUsedMs: 59000, runRemainingMs: 1000 })
    expect(readFileSync(f.activity.filePath, 'utf8')).toBe(before)
    f.activity.finish('first', String(first.id), 'completed', null)
    f.activity.stopRuntime(); f.advance(8 * 3600000)
    const reopened = new DshAutonomy(f.directory, () => true, () => {}, () => {}, f.now)
    reopened.startRuntime('second')
    expect(state(reopened)).toMatchObject({ runUsedMs: 59000, runRemainingMs: 1000, ownerPaused: false })
    const next = reopened.claim('second').cycle as JsonObject
    expect(next).toMatchObject({ deadline: f.now() + 1000, budgetLimited: true })
    f.advance(1000); expect(reopened.validCycle('second', String(next.id))).toBe(false)
    reopened.finish('second', String(next.id), 'unknown', 'AUTONOMY_RUN_LIMIT')
    expect(state(reopened)).toMatchObject({ reason: 'run-limit', ownerPaused: true, errorCode: 'AUTONOMY_RUN_LIMIT', failures: 0, runUsedMs: 60000, runRemainingMs: 0, lastOutcome: 'unknown' })
    expect(reopened.claim('second').admitted).toBe(false)
  })
  it('reports an execution-limit pause after a completed cycle without inventing a failed result', async () => {
    const f = fixture(); await f.configure({ maxRunMinutes: 1, cycleTimeoutSeconds: 120 }); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.advance(60000); f.activity.finish('runtime', String(cycle.id), 'completed', null)
    expect(state(f.activity)).toMatchObject({ reason: 'run-limit', ownerPaused: true, errorCode: 'AUTONOMY_RUN_LIMIT', failures: 0, lastOutcome: 'completed', runUsedMs: 60000 })
    expect(state(f.activity).history).toEqual([expect.objectContaining({ outcome: 'completed', code: null })])
    await f.control('resume')
    expect(state(f.activity)).toMatchObject({ ownerPaused: false, errorCode: null, runUsedMs: 0, runRemainingMs: 60000 })
  })
  it.each(['sleeping', 'waiting'] as const)('settles the current cycle before resetting the budget for %s', async mode => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.advance(3000)
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode, wakeAt: mode === 'sleeping' ? f.now() + 60000 : null, note: 'A real rest boundary' })
    f.advance(1000); f.activity.finish('runtime', String(cycle.id), 'completed', null)
    expect(state(f.activity)).toMatchObject({ mode, runUsedMs: 0, runRemainingMs: 120 * 60000 })
  })
  it('exposes a stale driver heartbeat and records control failure instead of pretending the AI chose to rest', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    f.advance(16000); expect(state(f.activity).reason).toBe('status-unavailable')
    f.activity.observe('idle'); expect(state(f.activity).reason).toBe('ready')
    expect(() => f.activity.runtimeFault('stale-runtime')).toThrow()
    expect(f.activity.runtimeFault('runtime')).toEqual({ paused: true })
    expect(state(f.activity)).toMatchObject({ reason: 'error', ownerPaused: true, errorCode: 'AUTONOMY_CONTROL_FAILED', mode: 'active' })
    expect(f.activity.claim('runtime').admitted).toBe(false)
  })

  it('defaults off and requires a separate explicit resume after configuration', async () => {
    const f = fixture(); f.activity.startRuntime('runtime')
    expect(f.activity.claim('runtime')).toEqual({ admitted: false })
    await f.configure(); expect(state(f.activity).ownerPaused).toBe(true)
    expect(f.activity.claim('runtime').admitted).toBe(false)
    await f.control('resume'); expect(f.activity.claim('runtime').admitted).toBe(true)
  })
  it('admits only one durable round and never replays a duplicate completion', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    const first = f.activity.claim('runtime'), cycle = first.cycle as JsonObject
    expect(f.activity.claim('runtime')).toEqual({ admitted: false })
    expect(f.activity.finish('runtime', String(cycle.id), 'completed', null)).toEqual({ accepted: true })
    expect(f.activity.finish('runtime', String(cycle.id), 'completed', null)).toEqual({ accepted: false })
    expect(f.activity.claim('runtime').admitted).toBe(false)
    f.advance(1000); expect(f.activity.claim('runtime').admitted).toBe(true)
    expect(state(f.activity).cycles).toBe(2)
  })
  it('supersedes rest with a structured revision and allows the owner to wake early', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    const revision = state(f.activity).revision
    f.activity.decide('runtime', { expectedActivityRevision: revision, mode: 'sleeping', wakeAt: f.now() + 10000, note: 'Resume the chosen activity' })
    expect(() => f.activity.decide('runtime', { expectedActivityRevision: revision, mode: 'active', wakeAt: null, note: '' })).toThrow()
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'sleeping', wakeAt: f.now() + 20000, note: 'Updated wake' })
    f.advance(11000); expect(f.activity.claim('runtime').admitted).toBe(false)
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'waiting', wakeAt: null, note: 'Wait for a real event' })
    f.advance(30000); expect(f.activity.claim('runtime').admitted).toBe(false)
    await f.control('wake'); expect(f.activity.claim('runtime').admitted).toBe(true)
  })
  it('retains an AI sleep decision made inside a round after the round completes', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'sleeping', wakeAt: f.now() + 10000, note: 'Take a rest' })
    f.activity.finish('runtime', String(cycle.id), 'completed', null)
    f.advance(9000); expect(f.activity.claim('runtime').admitted).toBe(false)
    f.advance(1000); expect(f.activity.claim('runtime').admitted).toBe(true)
  })
  it.each(['sleeping', 'waiting'] as const)('bounds %s and reconsiders without new input after the recorded deadline', async mode => {
    const f = fixture(); await f.configure({ maxRestMinutes: 2, autoResume: true }); f.activity.startRuntime('first'); await f.control('resume')
    f.activity.decide('first', { expectedActivityRevision: state(f.activity).revision, mode, wakeAt: mode === 'sleeping' ? f.now() + 12 * 3600000 : null, note: 'Quiet without giving up future thought' })
    const deadline = f.now() + 120000
    expect(state(f.activity)).toMatchObject({ mode, wakeAt: deadline, nextWakeAt: deadline })
    f.activity.stopRuntime()
    const reopened = new DshAutonomy(f.directory, () => true, () => {}, () => {}, f.now); reopened.startRuntime('second')
    f.advance(119999); expect(reopened.claim('second').admitted).toBe(false)
    f.advance(1); const next = reopened.claim('second')
    expect(next.admitted).toBe(true)
    expect(next.limits).toMatchObject({ maxRestMinutes: 2 })
    expect((next.activity as JsonObject).mode).toBe(mode)
  })
  it('keeps shorter rests and shows an earlier scheduled task as the next eligible opportunity', async () => {
    const f = fixture(); await f.configure({ maxRestMinutes: 15 }); f.activity.startRuntime('runtime'); await f.control('resume')
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'sleeping', wakeAt: f.now() + 120000, note: 'Short rest' })
    expect(state(f.activity).nextWakeAt).toBe(f.now() + 120000)
    f.activity.scheduleTask('runtime', { expectedRevision: 0, dueAt: f.now() + 30000, message: 'Earlier real task' })
    expect(state(f.activity).nextWakeAt).toBe(f.now() + 30000)
    f.advance(30000)
    const next = f.activity.claim('runtime')
    expect(next.admitted).toBe(true)
    expect((next.scheduledTasks as JsonObject[]).map(task => task.message)).toEqual(['Earlier real task'])
  })
  it('does not let a rest deadline bypass pause, runtime readiness or hourly quota', async () => {
    const f = fixture(); await f.configure({ maxRestMinutes: 1, maxCyclesPerHour: 1 }); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'waiting', wakeAt: null, note: 'Await input' })
    f.activity.finish('runtime', String(cycle.id), 'completed', null)
    expect(state(f.activity)).toMatchObject({ reason: 'hourly-limit', nextWakeAt: f.now() + 3600000 })
    f.advance(60000); expect(f.activity.claim('runtime').admitted).toBe(false)
    await f.control('pause'); f.advance(3600000)
    expect(f.activity.claim('runtime').admitted).toBe(false); expect(state(f.activity).nextWakeAt).toBeNull()
    await f.control('resume'); f.setReady(false)
    expect(f.activity.claim('runtime').admitted).toBe(false); expect(state(f.activity).nextWakeAt).toBeNull()
    f.setReady(true); expect(f.activity.claim('runtime').admitted).toBe(true)
  })
  it('shortens an existing rest on owner configuration changes without silently resuming it', async () => {
    const f = fixture(); await f.configure({ maxRestMinutes: 60 }); f.activity.startRuntime('runtime'); await f.control('resume')
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'sleeping', wakeAt: f.now() + 3600000, note: 'Original rest' })
    await f.configure({ maxRestMinutes: 5 })
    expect(state(f.activity)).toMatchObject({ ownerPaused: true, mode: 'sleeping', wakeAt: f.now() + 300000, note: 'Original rest', nextWakeAt: null })
    await f.control('resume'); expect(state(f.activity).nextWakeAt).toBe(f.now() + 300000)
  })
  it('rejects missing or conflicting rest limits and old schema without overwriting the saved document', async () => {
    const f = fixture(); await f.configure()
    const bytes = readFileSync(f.activity.filePath, 'utf8')
    for (const values of [{ maxRestMinutes: 0 }, { maxRestMinutes: 1441 }, { maxRestMinutes: 1.5 }, { minIntervalSeconds: 61, maxRestMinutes: 1 }]) await expect(f.configure(values)).rejects.toMatchObject({ code: 'INVALID_AUTONOMY_CONFIGURATION' })
    const missing = { ...AUTONOMY_DEFAULTS }; Reflect.deleteProperty(missing, 'maxRestMinutes')
    await expect(f.activity.configure({ expectedRevision: f.activity.snapshot().revision, configuration: missing })).rejects.toMatchObject({ code: 'INVALID_AUTONOMY_CONFIGURATION' })
    expect(readFileSync(f.activity.filePath, 'utf8')).toBe(bytes)
    const incomplete = JSON.parse(bytes); delete incomplete.configuration.maxRestMinutes
    const incompleteBytes = JSON.stringify(incomplete); writeFileSync(f.activity.filePath, incompleteBytes)
    expect(() => new DshAutonomy(f.directory, () => true, () => {}, () => {})).toThrow(expect.objectContaining({ code: 'AUTONOMY_STATE_CORRUPTED' }))
    expect(readFileSync(f.activity.filePath, 'utf8')).toBe(incompleteBytes)
    const previous = JSON.parse(bytes); previous.schemaVersion = 1; delete previous.configuration.maxRestMinutes
    const oldBytes = JSON.stringify(previous); writeFileSync(f.activity.filePath, oldBytes)
    expect(() => new DshAutonomy(f.directory, () => true, () => {}, () => {})).toThrow(expect.objectContaining({ code: 'AUTONOMY_STATE_CORRUPTED' }))
    expect(readFileSync(f.activity.filePath, 'utf8')).toBe(oldBytes)
  })
  it('does not charge a sleeping interval to the continuous run limit', async () => {
    const f = fixture(); await f.configure({ maxRunMinutes: 120 }); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'sleeping', wakeAt: f.now() + 8 * 3600000, note: 'Sleep through the night' })
    f.activity.finish('runtime', String(cycle.id), 'completed', null)
    f.advance(8 * 3600000)
    expect(state(f.activity)).toMatchObject({ ownerPaused: false, errorCode: null, mode: 'sleeping' })
    const next = f.activity.claim('runtime')
    expect(next.admitted).toBe(true)
    expect(next.limits).toMatchObject({ maxRunMinutes: 120, runRemainingMs: 120 * 60000 })
  })
  it('starts a new active segment when the runtime restarts after downtime', async () => {
    const f = fixture(); await f.configure({ maxRunMinutes: 120, autoResume: true }); f.activity.startRuntime('first'); await f.control('resume')
    const cycle = f.activity.claim('first').cycle as JsonObject
    f.activity.finish('first', String(cycle.id), 'completed', null)
    f.advance(121 * 60000)
    f.activity.startRuntime('second')
    expect(state(f.activity)).toMatchObject({ ownerPaused: false, errorCode: null, mode: 'active' })
    expect(f.activity.claim('second').admitted).toBe(true)
  })
  it('revokes in-flight authority on pause and refuses the AI to resume owner-paused activity', async () => {
    const f = fixture(); await f.configure({ targets: [target] }); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    expect(f.activity.contactTarget(target.id)).toEqual(target)
    await f.control('pause')
    expect(f.activity.validCycle('runtime', String(cycle.id))).toBe(false)
    expect(f.activity.validCycle('runtime', String(cycle.id))).toBe(false); expect(f.activity.contactTargetStillAllowed(target)).toBe(true)
    expect(() => f.activity.decide('runtime', { expectedActivityRevision: state(f.activity).revision, mode: 'active', wakeAt: null, note: 'Resume' })).toThrow()
    expect(f.revoke).toHaveBeenCalled()
  })
  it('enforces hourly round and contact limits without invoking a model to poll', async () => {
    const f = fixture(); await f.configure({ maxCyclesPerHour: 1, maxContactsPerHour: 1, targets: [target] }); f.activity.startRuntime('runtime'); await f.control('resume')
    const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.activity.contactTarget(target.id); f.activity.countContact()
    expect(() => f.activity.countContact()).toThrow()
    f.activity.finish('runtime', String(cycle.id), 'completed', null); f.advance(1000)
    expect(f.activity.claim('runtime').admitted).toBe(false); expect(state(f.activity).reason).toBe('hourly-limit')
    f.advance(3600000); expect(f.activity.claim('runtime').admitted).toBe(true)
  })
  it('reports the real six-contact quota without writes or revision changes on reads and rejected repeats', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    for (let i = 0; i < 6; i++) f.activity.countContact()
    const snapshot = f.activity.snapshot(), revision = state(f.activity).revision
    const limit = { limit: 6, used: 6, remaining: 0, exhausted: true, windowStartedAt: f.now(), resetAt: f.now() + 3600000 }
    const bytes = readFileSync(f.activity.filePath, 'utf8')
    expect(state(f.activity).contactLimit).toEqual(limit)
    for (let i = 0; i < 3; i++) {
      expect(() => f.activity.assertContactAvailable()).toThrow(expect.objectContaining({ code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent', details: { contactLimit: limit } }))
      expect(() => f.activity.countContact()).toThrow(/已用 6\/6.*剩余 0/)
      expect(() => f.activity.countContact()).toThrow(new RegExp(new Date(Number(limit.resetAt)).toISOString()))
      expect(f.activity.snapshot()).toEqual(snapshot)
      expect(readFileSync(f.activity.filePath, 'utf8')).toBe(bytes)
    }
    f.activity.decide('runtime', { expectedActivityRevision: revision, mode: 'active', wakeAt: null, note: '继续活动' })
    expect(state(f.activity).contactLimit).toEqual(limit)
    expect(() => f.activity.countContact()).toThrow(/读取配置或安排 active 不会恢复额度/)
    expect(state(f.activity)).toMatchObject({ ownerPaused: false, mode: 'active', errorCode: null, contacts: 6 })
  })
  it('derives an expired window on reads and fixes the new window once at the next accepted contact', async () => {
    const f = fixture(); await f.configure()
    for (let i = 0; i < 6; i++) f.activity.countContact()
    const initial = f.activity.snapshot(), bytes = readFileSync(f.activity.filePath, 'utf8')
    f.advance(3600000)
    expect(state(f.activity)).toMatchObject({ contacts: 0, contactLimit: { limit: 6, used: 0, remaining: 6, exhausted: false, windowStartedAt: f.now(), resetAt: f.now() + 3600000 } })
    expect(f.activity.snapshot().revision).toBe(initial.revision)
    expect(state(f.activity).revision).toBe((initial.state as JsonObject).revision)
    f.activity.assertContactAvailable()
    expect(readFileSync(f.activity.filePath, 'utf8')).toBe(bytes)
    f.activity.countContact()
    const started = f.now()
    f.advance(1000); f.activity.countContact()
    expect(state(f.activity)).toMatchObject({ contacts: 2, contactLimit: { used: 2, remaining: 4, windowStartedAt: started, resetAt: started + 3600000 } })
    const reopened = new DshAutonomy(f.directory, () => true, () => {}, () => {}, f.now)
    expect(state(reopened).contactLimit).toEqual(state(f.activity).contactLimit)
  })
  it('keeps a zero contact limit explicit and cannot imply waiting creates allowance', async () => {
    const f = fixture(); await f.configure({ maxContactsPerHour: 0 })
    expect(state(f.activity).contactLimit).toMatchObject({ limit: 0, remaining: 0, exhausted: true })
    expect(() => f.activity.countContact()).toThrow(/窗口重置后也无可用额度/)
    f.advance(3600000)
    expect(() => f.activity.countContact()).toThrow(expect.objectContaining({ code: 'AUTONOMY_CONTACT_LIMIT', outcome: 'not-sent' }))
    expect(state(f.activity).contacts).toBe(0)
  })
  it('distinguishes invalid inputs, stale runtime, disabled, paused, conflicts and a running cycle', async () => {
    const f = fixture(); f.activity.startRuntime('runtime')
    const decision = () => ({ expectedActivityRevision: state(f.activity).revision, mode: 'active', wakeAt: null, note: '' })
    expect(() => f.activity.decide('stale-runtime', decision())).toThrow(expect.objectContaining({ code: 'AUTONOMY_RUNTIME_STALE', message: expect.stringContaining('失效的运行时') }))
    expect(() => f.activity.decide('runtime', decision())).toThrow(expect.objectContaining({ code: 'AUTONOMY_DISABLED' }))
    await f.configure()
    expect(() => f.activity.decide('runtime', decision())).toThrow(expect.objectContaining({ code: 'AUTONOMY_PAUSED', message: expect.stringContaining('已暂停') }))
    await expect(f.activity.control('resume', {})).rejects.toMatchObject({ code: 'INVALID_AUTONOMY_INPUT', statusCode: 400 })
    await expect(f.activity.configure({})).rejects.toMatchObject({ code: 'INVALID_AUTONOMY_INPUT' })
    expect(() => f.activity.decide('runtime', { ...decision(), expectedActivityRevision: -1 })).toThrow(expect.objectContaining({ code: 'INVALID_AUTONOMY_INPUT' }))
    await f.control('resume')
    expect(() => f.activity.decide('runtime', { ...decision(), mode: 'invalid' })).toThrow(expect.objectContaining({ code: 'INVALID_AUTONOMY_INPUT' }))
    expect(() => f.activity.decide('runtime', { ...decision(), expectedActivityRevision: 0 })).toThrow(expect.objectContaining({ code: 'AUTONOMY_ACTIVITY_CONFLICT' }))
    await expect(f.activity.control('resume', { expectedRevision: 0, expectedActivityRevision: state(f.activity).revision })).rejects.toMatchObject({ code: 'AUTONOMY_CONFIGURATION_CONFLICT' })
    await expect(f.activity.control('resume', { expectedRevision: f.activity.snapshot().revision, expectedActivityRevision: 0 })).rejects.toMatchObject({ code: 'AUTONOMY_ACTIVITY_CONFLICT' })
    f.activity.claim('runtime')
    await expect(f.control('resume')).rejects.toMatchObject({ code: 'AUTONOMY_CYCLE_RUNNING', message: expect.stringContaining('周期仍在运行') })
  })
  it('distinguishes failure thresholds and unknown outcomes from chosen rest', async () => {
    const f = fixture(); await f.configure({ maxConsecutiveFailures: 2 }); f.activity.startRuntime('runtime'); await f.control('resume')
    for (let i = 0; i < 2; i++) { const cycle = f.activity.claim('runtime').cycle as JsonObject; f.activity.finish('runtime', String(cycle.id), 'failed', 'AUTONOMY_MODEL_FAILED'); f.advance(5000) }
    expect(state(f.activity)).toMatchObject({ ownerPaused: true, errorCode: 'AUTONOMY_MODEL_FAILED', failures: 2, mode: 'active' })
    await f.control('resume'); const cycle = f.activity.claim('runtime').cycle as JsonObject
    f.activity.finish('runtime', String(cycle.id), 'unknown', 'AUTONOMY_CYCLE_TIMEOUT')
    expect(state(f.activity)).toMatchObject({ ownerPaused: true, lastOutcome: 'unknown', errorCode: 'AUTONOMY_CYCLE_TIMEOUT' })
  })
  it('recovers an interrupted round as unknown and never silently auto-replays it', async () => {
    const f = fixture(); await f.configure({ autoResume: true }); f.activity.startRuntime('old'); await f.control('resume'); f.activity.claim('old')
    const reopened = new DshAutonomy(f.directory, () => true, () => {}, () => {}, f.now)
    reopened.startRuntime('new')
    expect(state(reopened)).toMatchObject({ active: null, ownerPaused: true, lastOutcome: 'unknown', errorCode: 'AUTONOMY_PREVIOUS_CYCLE_UNKNOWN' })
    expect(reopened.claim('new').admitted).toBe(false)
    expect(() => reopened.claim('old')).toThrow()
  })
  it('keeps future sleep across restart when automatic restore is selected', async () => {
    const f = fixture(); await f.configure({ autoResume: true }); f.activity.startRuntime('old'); await f.control('resume')
    f.activity.decide('old', { expectedActivityRevision: state(f.activity).revision, mode: 'sleeping', wakeAt: f.now() + 20000, note: 'Persisted rest' })
    f.activity.stopRuntime()
    const next = new DshAutonomy(f.directory, () => true, () => {}, () => {}, f.now); next.startRuntime('new')
    expect(next.claim('new').admitted).toBe(false); expect(state(next).note).toBe('Persisted rest')
    f.advance(20000); expect(next.claim('new').admitted).toBe(true)
  })
  it('rejects stale saves and unsupported files without changing their bytes', async () => {
    const f = fixture(); await f.configure()
    await expect(f.activity.configure({ expectedRevision: 0, configuration: AUTONOMY_DEFAULTS })).rejects.toMatchObject({ code: 'AUTONOMY_CONFIGURATION_CONFLICT' })
    const bytes = '{"schemaVersion":0}'; writeFileSync(f.activity.filePath, bytes)
    expect(() => new DshAutonomy(f.directory, () => true, () => {}, () => {})).toThrow()
    expect(readFileSync(f.activity.filePath, 'utf8')).toBe(bytes)
  })
  it('delivers due AI scheduled tasks as one opportunity and removes them exactly once', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime'); await f.control('resume')
    f.activity.scheduleTask('runtime', { expectedRevision: 0, dueAt: f.now() + 5000, message: 'Task A' })
    f.activity.scheduleTask('runtime', { expectedRevision: 1, dueAt: f.now() + 5000, message: 'Task B' })
    const agenda = f.activity.snapshot().agenda as JsonObject
    expect((agenda.tasks as JsonObject[]).map(task => task.message)).toEqual(['Task A', 'Task B'])
    f.advance(5000)
    const first = f.activity.claim('runtime') as JsonObject
    expect((first.scheduledTasks as JsonObject[]).map(task => task.message)).toEqual(['Task A', 'Task B'])
    expect((f.activity.snapshot().agenda as JsonObject).tasks).toEqual([])
    const cycle = first.cycle as JsonObject
    expect(f.activity.finish('runtime', String(cycle.id), 'completed', null)).toEqual({ accepted: true })
    f.advance(1000)
    expect((f.activity.claim('runtime') as JsonObject).scheduledTasks).toEqual([])
  })
  it('requires an active unpaused runtime and a current agenda revision to schedule or cancel tasks', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('runtime')
    expect(() => f.activity.scheduleTask('runtime', { expectedRevision: 0, dueAt: f.now() + 5000, message: 'Blocked by pause' })).toThrow(expect.objectContaining({ code: 'AUTONOMY_PAUSED' }))
    await f.control('resume')
    const scheduled = f.activity.scheduleTask('runtime', { expectedRevision: 0, dueAt: f.now() + 5000, message: 'Task to cancel' }) as JsonObject
    const taskId = String((scheduled.tasks as JsonObject[])[0]!.id)
    expect(() => f.activity.scheduleTask('runtime', { expectedRevision: 0, dueAt: f.now() + 6000, message: 'Stale revision' })).toThrow(expect.objectContaining({ code: 'AUTONOMY_AGENDA_CONFLICT' }))
    f.activity.cancelTask('runtime', { expectedRevision: 1, taskId })
    expect((f.activity.snapshot().agenda as JsonObject).tasks).toEqual([])
    expect(() => f.activity.cancelTask('runtime', { expectedRevision: 2, taskId })).toThrow(expect.objectContaining({ code: 'AUTONOMY_TASK_NOT_FOUND' }))
  })
  it('keeps AI tasks across restart and lets the owner cancel them while paused', async () => {
    const f = fixture(); await f.configure(); f.activity.startRuntime('old'); await f.control('resume')
    const scheduled = f.activity.scheduleTask('old', { expectedRevision: 0, dueAt: f.now() + 10000, message: 'Persisted task' }) as JsonObject
    const taskId = String((scheduled.tasks as JsonObject[])[0]!.id)
    const reopened = new DshAutonomy(f.directory, () => true, () => {}, () => {}, f.now)
    const restored = reopened.snapshot().agenda as JsonObject
    expect((restored.tasks as JsonObject[]).map(task => task.message)).toEqual(['Persisted task'])
    reopened.ownerCancelTask({ expectedRevision: restored.revision, taskId })
    expect((reopened.snapshot().agenda as JsonObject).tasks).toEqual([])
  })
  it('rejects corrupted AI task files without overwriting them', async () => {
    const f = fixture(); await f.configure()
    const agendaPath = join(f.directory, 'autonomy-agenda.json'), bytes = '{"schemaVersion":1,"revision":0,"tasks":[{"bad":true}]}'
    writeFileSync(agendaPath, bytes)
    expect(() => new DshAutonomy(f.directory, () => true, () => {}, () => {})).toThrow()
    expect(readFileSync(agendaPath, 'utf8')).toBe(bytes)
  })
})
