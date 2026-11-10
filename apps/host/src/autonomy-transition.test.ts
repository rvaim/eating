import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTONOMY_DEFAULTS, DshAutonomy } from '../../../plugins/harness/dsh/src/backend/autonomy'

const transitionModule = new URL('../../../scripts/server-autonomy-transition.mjs', import.meta.url).href
const { planExecutionAutonomyTransition, applyExecutionAutonomyTransition } = await import(transitionModule)
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (realpathSync(directory) !== directory || dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('eating-autonomy-transition-')) throw new Error('Unsafe autonomy transition fixture cleanup')
    rmSync(directory, { recursive: true })
  }
})
function previous(mode: 'active' | 'sleeping' | 'waiting' = 'sleeping', now = Date.now()) {
  return { schemaVersion: 2, revision: 7, configuration: { ...AUTONOMY_DEFAULTS, enabled: true, autoResume: true }, state: {
    revision: 9, ownerPaused: false, mode, wakeAt: mode === 'active' ? null : now + 5 * 60000, note: 'Preserve the original AI note', startedAt: null,
    windowAt: now - 60000, cycles: 3, contacts: 2, failures: 0, active: null, lastStartedAt: now - 50000, lastFinishedAt: now - 40000,
    lastOutcome: 'completed', errorCode: null, history: [{ cycleId: 'previous-completed-cycle', startedAt: now - 50000, finishedAt: now - 40000, outcome: 'completed', code: null }],
  } }
}
function fixture() {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-autonomy-transition-'))); directories.push(directory)
  const data = join(directory, 'data'), harness = join(data, 'harness/dsh'), file = join(harness, 'autonomy.json')
  mkdirSync(harness, { recursive: true }); mkdirSync(join(data, 'host'))
  const original = JSON.stringify(previous())
  writeFileSync(file, original)
  const input = { dataDirectory: data, backupDirectory: join(directory, 'original'), expectedAutonomySha256: createHash('sha256').update(original).digest('hex'), confirmation: 'execution-autonomy-v3' }
  return { directory, data, harness, file, original, input }
}

describe('explicit offline autonomy execution-budget transition', () => {
  it.each(['active', 'sleeping', 'waiting'] as const)('starts the new execution budget while preserving the %s arrangement and all other data', mode => {
    const now = 1700000000000, original = previous(mode, now), snapshot = structuredClone(original)
    const next = planExecutionAutonomyTransition(original)
    expect(original).toEqual(snapshot)
    expect(next).toMatchObject({ schemaVersion: 3, revision: 8, configuration: { maxRestMinutes: 15, enabled: true, autoResume: true }, state: { revision: 10, mode, wakeAt: original.state.wakeAt, ownerPaused: false, runUsedMs: 0 } })
    const normalized = structuredClone(next); normalized.schemaVersion = 2; normalized.revision = original.revision; delete normalized.state.runUsedMs; normalized.state.startedAt = original.state.startedAt; normalized.state.revision = original.state.revision
    expect(normalized).toEqual(original)
  })
  it('keeps owner pause, error and unknown records rather than resuming them during conversion', () => {
    const initial = previous('waiting'), original = { ...initial, state: { ...initial.state, ownerPaused: true, errorCode: 'AUTONOMY_CYCLE_TIMEOUT', lastOutcome: 'unknown' } }
    const next = planExecutionAutonomyTransition(original)
    expect(next.state.ownerPaused).toBe(true)
    expect(next.state.errorCode).toBe('AUTONOMY_CYCLE_TIMEOUT')
    expect(next.state.lastOutcome).toBe('unknown')
    expect(next.state.history).toEqual(original.state.history)
    expect(next.state.contacts).toBe(2)
  })
  it('writes only the intended state, preserves an exact private backup and loads under the strict current reader', () => {
    const f = fixture(), untouched = join(f.harness, 'retained-session.jsonl')
    writeFileSync(untouched, 'existing native log\n')
    expect(() => new DshAutonomy(f.harness, () => false, () => {}, () => {})).toThrow(expect.objectContaining({ code: 'AUTONOMY_STATE_CORRUPTED' }))
    expect(readFileSync(f.file, 'utf8')).toBe(f.original)
    expect(applyExecutionAutonomyTransition(f.input)).toMatchObject({ schemaVersion: 3, executionBudgetMs: 0, originalFileBackedUp: true, ownerPauseRetained: true })
    const next = JSON.parse(readFileSync(f.file, 'utf8'))
    expect(next.state.wakeAt).toBe(JSON.parse(f.original).state.wakeAt)
    expect(next.state.runUsedMs).toBe(0)
    expect(next.state).not.toHaveProperty('startedAt')
    expect(readFileSync(join(f.input.backupDirectory, 'autonomy.schema2.json'), 'utf8')).toBe(f.original)
    expect(readFileSync(untouched, 'utf8')).toBe('existing native log\n')
    expect(new DshAutonomy(f.harness, () => false, () => {}, () => {}).configuration().maxRestMinutes).toBe(15)
    const converted = readFileSync(f.file, 'utf8')
    expect(() => applyExecutionAutonomyTransition(f.input)).toThrow()
    expect(readFileSync(f.file, 'utf8')).toBe(converted)
  })
  it('refuses a running host or stale original hash before creating a backup or modifying state', () => {
    const f = fixture()
    expect(() => applyExecutionAutonomyTransition({ ...f.input, expectedAutonomySha256: '0'.repeat(64) })).toThrow(/changed after inspection/)
    expect(existsSync(f.input.backupDirectory)).toBe(false)
    writeFileSync(join(f.data, 'host/host.lock'), 'fixture-owner-lock')
    expect(() => applyExecutionAutonomyTransition(f.input)).toThrow(/Stop Eating cleanly/)
    expect(readFileSync(f.file, 'utf8')).toBe(f.original)
    expect(existsSync(f.input.backupDirectory)).toBe(false)
  })
  it('rejects active, malformed, already current or contradictory input without guessing fields', () => {
    const original = previous()
    for (const value of [{ ...original, schemaVersion: 3 }, { ...original, extra: true }, { ...original, state: { ...original.state, active: {} } }, { ...original, state: { ...original.state, history: [{}] } }, { ...original, configuration: { ...original.configuration, minIntervalSeconds: 901 } }]) expect(() => planExecutionAutonomyTransition(value)).toThrow()
    expect(() => planExecutionAutonomyTransition({ ...original, schemaVersion: 1 })).toThrow()
  })
})
