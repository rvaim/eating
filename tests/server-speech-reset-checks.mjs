import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applySpeechDataReset, inspectSpeechDirectory } from '../scripts/server-speech-reset.mjs'
const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, 'eating-speech-reset-')))
let checks = 0
try {
  const data = join(root, 'data'), speech = join(data, 'capabilities/text-to-speech'), other = join(data, 'capabilities/other')
  mkdirSync(join(speech, 'audio'), { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(join(data, 'host'))
  writeFileSync(join(speech, 'config.json'), '{"schemaVersion":1}'); writeFileSync(join(speech, 'index.json'), '{"schemaVersion":1,"jobs":[]}'); writeFileSync(join(speech, 'audio/fixture'), 'fixture audio'); writeFileSync(join(other, 'config.json'), 'retain me')
  const input = { dataDirectory: data, backupDirectory: join(root, 'backup'), expectedSpeechManifestSha256: inspectSpeechDirectory(speech).sha256, confirmation: 'reset-tts-for-multi-protocol-v2' }
  writeFileSync(join(data, 'host/host.lock'), 'active'); assert.throws(() => applySpeechDataReset(input)); rmSync(join(data, 'host/host.lock')); checks++
  for (const patch of [{ confirmation: 'automatic' }, { expectedSpeechManifestSha256: '0'.repeat(64) }, { backupDirectory: join(data, 'backup') }, { extra: true }]) { assert.throws(() => applySpeechDataReset({ ...input, ...patch })); assert(existsSync(join(speech, 'config.json'))); checks += 2 }
  symlinkSync(join(other, 'config.json'), join(speech, 'audio/escape')); assert.throws(() => applySpeechDataReset(input)); rmSync(join(speech, 'audio/escape')); checks++
  const result = applySpeechDataReset(input); assert.deepEqual(result, { speechDataReset: true, movedFiles: 3, backupVerified: true, configurationMigrated: false, otherPluginDataChanged: false }); checks++
  assert(!existsSync(join(speech, 'config.json'))); assert.equal(inspectSpeechDirectory(speech).files.length, 0); assert.equal(inspectSpeechDirectory(input.backupDirectory).sha256, input.expectedSpeechManifestSha256); assert.equal(readFileSync(join(other, 'config.json'), 'utf8'), 'retain me'); checks += 4
  console.log(JSON.stringify({ offlineChecksPassed: checks, actualUserDataChanged: false }))
} finally { if (realpathSync(root) !== root || dirname(root) !== parent) throw new Error('Unsafe speech reset fixture cleanup'); rmSync(root, { recursive: true }) }
