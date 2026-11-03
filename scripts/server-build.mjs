import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isOutside = (root, target) => { const difference = relative(root, target); return difference === '..' || difference.startsWith('..' + sep) }

export function validateBuildConfiguration(configuration, root = repository) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
    || Object.keys(configuration).some(key => !['commit', 'lockSha256', 'dependencyInstallApproved', 'pnpmScript', 'packageStore', 'logFile'].includes(key))
    || !/^[a-f0-9]{40}$/.test(configuration.commit ?? '')
    || !/^[a-f0-9]{64}$/.test(configuration.lockSha256 ?? '')
    || configuration.dependencyInstallApproved !== true) throw new Error('Deployment configuration or dependency approval is invalid')
  for (const key of ['pnpmScript', 'packageStore', 'logFile']) {
    const value = configuration[key]
    if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Deployment paths must come from private absolute configuration')
    const target = existsSync(value) ? realpathSync(value) : resolve(realpathSync(dirname(value)), value.slice(dirname(value).length + 1))
    if (!isOutside(root, target)) throw new Error('Private deployment paths must be outside the repository')
  }
  return configuration
}

export function buildServer(configuration, root = repository) {
  const config = validateBuildConfiguration(configuration, root)
  const version = process.versions.node.split('.').map(Number)
  if (version[0] < 24 || version[0] === 24 && version[1] < 9) throw new Error('Node 24.9 or later is required; no runtime is installed automatically')
  const actualCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (actualCommit.status !== 0 || actualCommit.stdout.trim() !== config.commit) throw new Error('Git checkout differs from the approved commit')
  if (spawnSync('git', ['diff', '--quiet'], { cwd: root }).status !== 0 || spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root }).status !== 0) throw new Error('Cloud project source has local changes')
  const lock = createHash('sha256').update(readFileSync(resolve(root, 'pnpm-lock.yaml'))).digest('hex')
  if (lock !== config.lockSha256) throw new Error('Lock file differs from the dependency approval')
  const log = openSync(config.logFile, 'a', 0o600)
  const run = (args, timeout) => {
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, CI: 'true' }, stdio: ['ignore', log, log], timeout })
    if (result.status !== 0 || result.error) throw new Error('Build step failed; inspect the private deployment log')
  }
  try {
    const pnpmVersion = spawnSync(process.execPath, [config.pnpmScript, '--version'], { encoding: 'utf8', timeout: 30000 })
    const expectedPnpm = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager.split('@').at(-1)
    if (pnpmVersion.status !== 0 || pnpmVersion.stdout.trim() !== expectedPnpm) throw new Error('The configured pnpm version does not match the repository')
    run([config.pnpmScript, 'install', '--frozen-lockfile', '--store-dir', config.packageStore, '--child-concurrency=1', '--network-concurrency=4'], 1200000)
    console.log(JSON.stringify({ stage: 'locked-project-dependencies-ready', ok: true }))
    run([resolve(root, 'scripts/build.mjs')], 900000)
    console.log(JSON.stringify({ stage: 'linux-production-build-ready', ok: true }))
    run([resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'apps/host/src/harness.test.ts', 'apps/host/src/memory-access.test.ts', 'apps/host/src/agent-access.test.ts', 'apps/host/src/capability-access.test.ts', 'plugins/harness/dsh/src/backend/agent-control.test.ts', '--maxWorkers=1'], 300000)
    console.log(JSON.stringify({ stage: 'linux-host-control-regression-ready', ok: true }))
  } finally { closeSync(log) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_DEPLOY_CONFIG
    if (!path || !isAbsolute(path)) throw new Error('Set EATING_DEPLOY_CONFIG to an external private configuration file')
    const resolved = realpathSync(path)
    if (!isOutside(repository, resolved)) throw new Error('Private configuration cannot be stored in the repository')
    buildServer(JSON.parse(readFileSync(resolved, 'utf8')))
  } catch (error) {
    console.error(error instanceof Error && /^Deployment |^Private |^Node |^Git |^Cloud |^Lock |^Build |^The configured |^Set EATING_/.test(error.message) ? error.message : 'Server build failed; connection details are not displayed')
    process.exitCode = 1
  }
}
