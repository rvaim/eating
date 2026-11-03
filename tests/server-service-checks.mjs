import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const source = fs.readFileSync(new URL('../scripts/server-service.mjs', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replace("const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')", 'const repository = fixtureRepository')
const run = new Function('fixtureRepository', 'spawnSync', 'chmodSync', 'existsSync', 'lstatSync', 'mkdirSync', 'readFileSync', 'realpathSync', 'writeFileSync', 'homedir', 'dirname', 'isAbsolute', 'relative', 'resolve', 'sep', 'process', 'console', source)
const parent = fs.realpathSync(tmpdir())
const directory = fs.realpathSync(fs.mkdtempSync(join(parent, 'eating-service-check-')))
let checks = 0
function fixture(rootUser = false, configurationInside = false, symlinkState = false) {
  const base = fs.mkdtempSync(join(directory, 'case-'))
  const repository = join(base, 'repository')
  const home = join(base, 'home')
  const privateDirectory = join(base, 'private')
  for (const path of [repository, home, privateDirectory]) fs.mkdirSync(path)
  const node = join(privateDirectory, 'node')
  const dsh = join(privateDirectory, 'dsh.js')
  fs.writeFileSync(node, 'fixture')
  fs.writeFileSync(dsh, 'fixture')
  const config = { dataDirectory: join(privateDirectory, 'data'), runtimeNode: node, runtimeDsh: dsh, toolingBin: privateDirectory, listenHost: '0.0.0.0', publicOrigin: 'http://example.invalid:54321', ownerToken: 'fixture_token_'.repeat(4), port: 54321 }
  const actualConfiguration = join(privateDirectory, 'service.json')
  fs.writeFileSync(actualConfiguration, JSON.stringify(config))
  let configPath = actualConfiguration
  if (configurationInside) { configPath = join(repository, 'private-config.json'); fs.symlinkSync(actualConfiguration, configPath) }
  if (symlinkState) fs.symlinkSync(join(repository, 'private-output.json'), join(privateDirectory, 'service-state.json'))
  const calls = []
  const output = []
  const process = { platform: 'linux', getuid: () => rootUser ? 0 : 1000, env: { EATING_SERVICE_CONFIG: configPath }, exitCode: 0 }
  const spawn = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: args.includes('is-active') ? 'active\n' : '', error: undefined } }
  run(repository, spawn, fs.chmodSync, fs.existsSync, fs.lstatSync, fs.mkdirSync, fs.readFileSync, fs.realpathSync, fs.writeFileSync, () => home, dirname, isAbsolute, relative, resolve, sep, process, { log: value => output.push(value), error: value => output.push(value) })
  return { base, repository, home, privateDirectory, config, calls, output, code: process.exitCode }
}
try {
  const success = fixture()
  assert.equal(success.code, 0)
  assert.equal(success.calls.filter(call => call.command === success.config.runtimeNode).length, 5)
  assert(success.calls.filter(call => call.command === 'systemctl').every(call => call.args[0] === '--user' && (call.args.includes('daemon-reload') || call.args.includes('eating-managed.service'))))
  const unit = join(success.home, '.config/systemd/user/eating-managed.service')
  assert.equal(fs.statSync(unit).mode & 0o777, 0o600)
  const unitText = fs.readFileSync(unit, 'utf8')
  assert(unitText.split('\n').includes('WorkingDirectory=' + success.repository))
  assert(!unitText.includes('WorkingDirectory="'))
  assert(!success.output.join('\n').includes(success.config.ownerToken))
  assert.equal(fs.readdirSync(success.repository).length, 0)
  checks += 8
  for (const [rootUser, inside, symlinkState] of [[true, false, false], [false, true, false], [false, false, true]]) {
    const result = fixture(rootUser, inside, symlinkState)
    assert.equal(result.code, 1)
    assert.equal(result.calls.length, 0)
    assert.equal(fs.existsSync(join(result.repository, 'private-output.json')), false)
    checks += 3
  }
  console.log(JSON.stringify({ offlineChecksPassed: checks, actualServicesChanged: false, actualPluginsInstalled: false }))
} finally {
  if (fs.realpathSync(directory) !== directory || dirname(directory) !== parent || !directory.startsWith(join(parent, 'eating-service-check-'))) throw new Error('Unexpected fixture cleanup path')
  fs.rmSync(directory, { recursive: true })
}
