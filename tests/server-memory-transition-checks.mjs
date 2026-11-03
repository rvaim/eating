import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyStandardMemoryTransition, planStandardMemoryTransition } from '../scripts/server-memory-transition.mjs'

const settings = { enabled: true, autoCapture: true, autoRecall: true, globalMemory: true, ownerCrossSession: true, privateCapture: true, privateRecall: true, groupCapture: false, groupRecall: true, archiveMaxMiB: 8, recallLimit: 6, recallMaxChars: 4800, scoreThreshold: 0.35, rules: [{ id: 'fixture-rule', label: 'Example only', platform: 'qq', accountId: '100', kind: 'private', targetId: '200', capture: true, recall: true, memberMode: 'all', memberIds: [] }] }
const configuration = { schemaVersion: 2, revision: 12, endpoint: 'http://example.invalid', account: 'fixture-account', user: 'fixture-user', apiKey: 'fixture-not-a-real-key', autoConnect: true, timeoutMs: 15000, settings }
const state = { schemaVersion: 2, jobs: [], scopes: [], lastRecallAt: null, lastCaptureAt: null, lastErrorCode: 'MEMORY_INCREMENTAL_UNSUPPORTED', extractionDay: '2026-11-04', extractionCount: 0 }
const planned = planStandardMemoryTransition(configuration, state)
assert.equal(planned.configuration.schemaVersion, 3)
assert.equal(planned.configuration.revision, 13)
assert.equal(planned.configuration.settings.archiveMaxMiB, undefined)
assert.equal(planned.configuration.settings.autoCommit, true)
assert.equal(planned.configuration.settings.commitTokenThreshold, 20000)
for (const key of ['endpoint', 'account', 'user', 'apiKey', 'autoConnect', 'timeoutMs']) assert.deepEqual(planned.configuration[key], configuration[key])
assert.deepEqual(planned.configuration.settings.rules, settings.rules)
assert.deepEqual(planned.state, { ...state, schemaVersion: 3 })
assert.equal(configuration.schemaVersion, 2)
for (const patch of [{ schemaVersion: 3 }, { jobs: [{ status: 'unknown' }] }, { scopes: [{ bufferedMessages: 1 }] }]) assert.throws(() => planStandardMemoryTransition(configuration, { ...state, ...patch }))
assert.throws(() => planStandardMemoryTransition({ ...configuration, settings: { ...settings, autoCommit: true } }, state))
const parent = realpathSync(tmpdir())
const root = realpathSync(mkdtempSync(join(parent, 'eating-memory-transition-check-')))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const data = join(root, 'private-data')
  const memory = join(data, 'capabilities/openviking-memory')
  mkdirSync(memory, { recursive: true })
  mkdirSync(join(data, 'host'))
  const configPath = join(memory, 'config.json')
  const statePath = join(memory, 'state.json')
  const originalConfiguration = JSON.stringify(configuration)
  const originalState = JSON.stringify(state)
  writeFileSync(configPath, originalConfiguration)
  writeFileSync(statePath, originalState)
  const input = { dataDirectory: data, backupDirectory: join(root, 'backup'), expectedConfigurationSha256: digest(originalConfiguration), expectedStateSha256: digest(originalState), confirmation: 'standard-memory-v3-empty-state' }
  assert.throws(() => applyStandardMemoryTransition({ ...input, confirmation: 'not-confirmed' }))
  assert.throws(() => applyStandardMemoryTransition({ ...input, expectedConfigurationSha256: 'a'.repeat(64) }))
  writeFileSync(join(data, 'host/host.lock'), 'fixture running')
  assert.throws(() => applyStandardMemoryTransition(input))
  assert.equal(readFileSync(configPath, 'utf8'), originalConfiguration)
  const lock = join(data, 'host/host.lock')
  if (lock !== join(root, 'private-data/host/host.lock')) throw new Error('Unexpected fixture lock')
  rmSync(lock)
  const result = applyStandardMemoryTransition(input)
  assert.equal(result.schemaVersion, 3)
  assert.equal(result.remoteMemoryModified, false)
  assert.deepEqual(JSON.parse(readFileSync(configPath)), planned.configuration)
  assert.deepEqual(JSON.parse(readFileSync(statePath)), planned.state)
  assert.equal(readFileSync(join(input.backupDirectory, 'config.schema2.json'), 'utf8'), originalConfiguration)
  assert.equal(readFileSync(join(input.backupDirectory, 'state.schema2.json'), 'utf8'), originalState)
  assert.equal(statSync(configPath).mode & 0o777, 0o600)
  assert.equal(statSync(statePath).mode & 0o777, 0o600)
  assert.throws(() => applyStandardMemoryTransition(input))
  assert(existsSync(input.backupDirectory))
  console.log(JSON.stringify({ transitionChecksPassed: true, realUserConfigurationRead: false, remoteServiceModified: false }))
} finally {
  if (realpathSync(root) !== root || dirname(root) !== parent || !root.startsWith(join(parent, 'eating-memory-transition-check-'))) throw new Error('Unexpected fixture cleanup path')
  rmSync(root, { recursive: true })
}
