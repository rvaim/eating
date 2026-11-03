import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validateBuildConfiguration } from '../scripts/server-build.mjs'

const parent = realpathSync(tmpdir())
const temporary = realpathSync(mkdtempSync(join(parent, 'eating-server-build-check-')))
const repository = join(temporary, 'repository')
const privateDirectory = join(temporary, 'private')
mkdirSync(repository)
mkdirSync(privateDirectory)
const base = { commit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), dependencyInstallApproved: true, pnpmScript: join(privateDirectory, 'pnpm.cjs'), packageStore: join(privateDirectory, 'store'), logFile: join(privateDirectory, 'build.log') }
writeFileSync(base.pnpmScript, '')
let checks = 0
try {
  assert.equal(validateBuildConfiguration(base, repository), base)
  checks++
  for (const value of [undefined, null, false, 'yes']) {
    assert.throws(() => validateBuildConfiguration({ ...base, dependencyInstallApproved: value }, repository))
    checks++
  }
  for (const patch of [{ commit: 'main' }, { lockSha256: 'unknown' }, { extra: true }]) {
    assert.throws(() => validateBuildConfiguration({ ...base, ...patch }, repository))
    checks++
  }
  for (const key of ['pnpmScript', 'packageStore', 'logFile']) {
    assert.throws(() => validateBuildConfiguration({ ...base, [key]: 'relative-path' }, repository))
    assert.throws(() => validateBuildConfiguration({ ...base, [key]: join(repository, 'private-file') }, repository))
    checks += 2
  }
  mkdirSync(join(repository, '..private'))
  assert.throws(() => validateBuildConfiguration({ ...base, logFile: join(repository, '..private', 'log') }, repository))
  checks++
  console.log(JSON.stringify({ offlineChecksPassed: checks, dependenciesInstalled: false, serverConnected: false }))
} finally {
  if (realpathSync(temporary) !== temporary || dirname(temporary) !== parent || !temporary.startsWith(join(parent, 'eating-server-build-check-'))) throw new Error('Unexpected fixture cleanup path')
  rmSync(temporary, { recursive: true })
}
