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
  it('supersedes old sleep times with a structured revision and honors indefinite waiting', async () => {
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
