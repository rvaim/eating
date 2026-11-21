import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyDshConfigTransition, planDshConfigTransition } from '../scripts/server-dsh-config-transition.mjs'

const parent = realpathSync(tmpdir())
const root = realpathSync(mkdtempSync(join(parent, 'eating-dsh-transition-check-')))
let checks = 0
try {
  const sample = {
    schemaVersion: 1,
    updatedAt: '2026-11-13T12:38:00.000Z',
    configuration: {
      displayName: 'DeepSeek Harness',
      endpoint: 'https://example.invalid/v1',
      model: 'fixture-model',
      apiKey: 'fixture-secret-not-real',
      timeoutMs: 60000,
      maxTokens: 4096,
      autoConnect: true,
    },
  }
  const planned = planDshConfigTransition(sample)
  assert.equal(planned.schemaVersion, 2)
  assert.equal(planned.updatedAt, sample.updatedAt)
  assert.equal(planned.configuration.protocol, 'openai-completions')
  assert.equal(planned.configuration.apiKey, sample.configuration.apiKey)
  assert.equal(planned.configuration.endpoint, sample.configuration.endpoint)
  checks += 5

  for (const invalid of [{ ...sample, schemaVersion: 2 }, { ...sample, configuration: { ...sample.configuration, protocol: 'openai-completions' } }]) {
    assert.throws(() => planDshConfigTransition(invalid))
    checks++
  }

  const dataDir = join(root, 'data')
  const dshDir = join(dataDir, 'harness/dsh')
  const hostDir = join(dataDir, 'host')
  mkdirSync(dshDir, { recursive: true, mode: 0o700 })
  mkdirSync(hostDir, { recursive: true, mode: 0o700 })
  const configPath = join(dshDir, 'config.json')
  const raw = JSON.stringify(sample, null, 2) + '\n'
  writeFileSync(configPath, raw, { mode: 0o600 })
  const hash = createHash('sha256').update(raw).digest('hex')
  const backupDir = join(root, 'backup-v1')

  // Refuses transition when host.lock exists
  const lockPath = join(hostDir, 'host.lock')
  writeFileSync(lockPath, '1234\n')
  assert.throws(() => applyDshConfigTransition({
    dataDirectory: dataDir,
    backupDirectory: backupDir,
    expectedConfigSha256: hash,
    confirmation: 'dsh-protocol-config-v2',
  }))
  rmSync(lockPath)
  checks++

  // Refuses wrong hash
  assert.throws(() => applyDshConfigTransition({
    dataDirectory: dataDir,
    backupDirectory: backupDir,
    expectedConfigSha256: '0'.repeat(64),
    confirmation: 'dsh-protocol-config-v2',
  }))
  checks++

  const result = applyDshConfigTransition({
    dataDirectory: dataDir,
    backupDirectory: backupDir,
    expectedConfigSha256: hash,
    confirmation: 'dsh-protocol-config-v2',
  })
  assert.deepEqual(result, {
    schemaVersion: 2,
    protocol: 'openai-completions',
    originalFileBackedUp: true,
    apiKeyRetained: true,
    existingFieldsRetained: true,
  })
  assert.equal(readFileSync(join(backupDir, 'dsh-config.schema1.json'), 'utf8'), raw)
  const migrated = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.configuration.protocol, 'openai-completions')
  assert.equal(migrated.configuration.apiKey, 'fixture-secret-not-real')
  chmodSync(configPath, 0o600)
  checks += 5

  console.log(JSON.stringify({ offlineChecksPassed: checks, actualDataChanged: false }))
} finally {
  if (realpathSync(root) !== root || dirname(root) !== parent || !root.startsWith(join(parent, 'eating-dsh-transition-check-'))) {
    throw new Error('Unexpected fixture cleanup path')
  }
  rmSync(root, { recursive: true })
}
