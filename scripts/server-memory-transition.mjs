import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const outside = path => { const difference = relative(repository, path); return difference === '..' || difference.startsWith('..' + sep) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function exact(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }

export function planStandardMemoryTransition(configuration, state) {
  if (!exact(configuration, ['schemaVersion', 'revision', 'endpoint', 'account', 'user', 'apiKey', 'autoConnect', 'timeoutMs', 'settings']) || configuration.schemaVersion !== 2
    || !Number.isSafeInteger(configuration.revision) || configuration.revision < 0 || configuration.revision >= Number.MAX_SAFE_INTEGER
    || !object(configuration.settings) || !Number.isInteger(configuration.settings.archiveMaxMiB) || configuration.settings.archiveMaxMiB < 1 || configuration.settings.archiveMaxMiB > 64
    || Object.hasOwn(configuration.settings, 'autoCommit') || Object.hasOwn(configuration.settings, 'commitTokenThreshold')) throw new Error('Unexpected previous memory configuration; no transition was applied')
  if (!exact(state, ['schemaVersion', 'jobs', 'scopes', 'lastRecallAt', 'lastCaptureAt', 'lastErrorCode', 'extractionDay', 'extractionCount']) || state.schemaVersion !== 2
    || !Array.isArray(state.jobs) || state.jobs.length || !Array.isArray(state.scopes) || state.scopes.length) throw new Error('Previous memory state contains records or has an unexpected format; preserve and review it separately')
  const next = structuredClone(configuration)
  next.schemaVersion = 3
  next.revision++
  delete next.settings.archiveMaxMiB
  next.settings.autoCommit = true
  next.settings.commitTokenThreshold = 20000
  return { configuration: next, state: { ...structuredClone(state), schemaVersion: 3 } }
}

function privateFile(path) {
  if (!isAbsolute(path) || !outside(resolve(path)) || !outside(realpathSync(path)) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('Transition files must be regular files outside the code checkout')
  return realpathSync(path)
}

export function applyStandardMemoryTransition(input) {
  if (!exact(input, ['dataDirectory', 'backupDirectory', 'expectedConfigurationSha256', 'expectedStateSha256', 'confirmation']) || input.confirmation !== 'standard-memory-v3-empty-state'
    || !/^[a-f0-9]{64}$/.test(input.expectedConfigurationSha256 ?? '') || !/^[a-f0-9]{64}$/.test(input.expectedStateSha256 ?? '')) throw new Error('Explicit transition confirmation and original file hashes are required')
  if (typeof input.dataDirectory !== 'string' || !isAbsolute(input.dataDirectory) || !outside(resolve(input.dataDirectory)) || !outside(realpathSync(input.dataDirectory)) || lstatSync(input.dataDirectory).isSymbolicLink()) throw new Error('The data directory must be private and outside the checkout')
  if (existsSync(resolve(input.dataDirectory, 'host/host.lock'))) throw new Error('Stop Eating cleanly before transforming its private memory configuration')
  const memory = resolve(input.dataDirectory, 'capabilities/openviking-memory')
  if (realpathSync(memory) !== memory || lstatSync(memory).isSymbolicLink()) throw new Error('The memory directory must be a regular private directory')
  const configurationPath = privateFile(resolve(memory, 'config.json'))
  const statePath = privateFile(resolve(memory, 'state.json'))
  const configurationBytes = readFileSync(configurationPath)
  const stateBytes = readFileSync(statePath)
  if (configurationBytes.length > 2 * 1024 * 1024 || stateBytes.length > 4 * 1024 * 1024 || digest(configurationBytes) !== input.expectedConfigurationSha256 || digest(stateBytes) !== input.expectedStateSha256) throw new Error('Private memory files changed after inspection; no transition was applied')
  const planned = planStandardMemoryTransition(JSON.parse(configurationBytes), JSON.parse(stateBytes))
  if (typeof input.backupDirectory !== 'string' || !isAbsolute(input.backupDirectory) || !outside(resolve(input.backupDirectory)) || existsSync(input.backupDirectory)) throw new Error('Use a new private backup directory outside the checkout')
  const backupParent = realpathSync(dirname(input.backupDirectory))
  if (!outside(backupParent) || backupParent === realpathSync(input.dataDirectory) || !relative(realpathSync(input.dataDirectory), backupParent).startsWith('..' + sep) && relative(realpathSync(input.dataDirectory), backupParent) !== '..') throw new Error('Backup storage must be outside the application data directory')
  mkdirSync(input.backupDirectory, { mode: 0o700 })
  if (realpathSync(input.backupDirectory) !== resolve(input.backupDirectory)) throw new Error('Unexpected backup directory resolution')
  writeFileSync(resolve(input.backupDirectory, 'config.schema2.json'), configurationBytes, { mode: 0o600, flag: 'wx' })
  writeFileSync(resolve(input.backupDirectory, 'state.schema2.json'), stateBytes, { mode: 0o600, flag: 'wx' })
  const nonce = randomUUID()
  const configurationTemporary = resolve(memory, '.standard-config-' + nonce + '.tmp')
  const stateTemporary = resolve(memory, '.standard-state-' + nonce + '.tmp')
  const nextStateBytes = JSON.stringify(planned.state)
  let stateReplaced = false
  try {
    writeFileSync(configurationTemporary, JSON.stringify(planned.configuration), { mode: 0o600, flag: 'wx' })
    writeFileSync(stateTemporary, nextStateBytes, { mode: 0o600, flag: 'wx' })
    if (digest(readFileSync(configurationPath)) !== input.expectedConfigurationSha256 || digest(readFileSync(statePath)) !== input.expectedStateSha256) throw new Error('Private memory files changed during backup; no transition was applied')
    renameSync(stateTemporary, statePath)
    stateReplaced = true
    renameSync(configurationTemporary, configurationPath)
    chmodSync(statePath, 0o600)
    chmodSync(configurationPath, 0o600)
  } catch (error) {
    if (stateReplaced && digest(readFileSync(statePath)) === digest(nextStateBytes) && digest(readFileSync(configurationPath)) === input.expectedConfigurationSha256) {
      writeFileSync(stateTemporary, stateBytes, { mode: 0o600, flag: 'wx' })
      renameSync(stateTemporary, statePath)
    }
    throw error
  } finally {
    for (const path of [configurationTemporary, stateTemporary]) if (dirname(path) === memory && existsSync(path) && !lstatSync(path).isSymbolicLink()) unlinkSync(path)
  }
  return { schemaVersion: 3, emptyStateConfirmed: true, connectionIdentityRetained: true, originalFilesBackedUp: true, remoteMemoryModified: false }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_MEMORY_TRANSITION_CONFIG
    if (!path) throw new Error('Set EATING_MEMORY_TRANSITION_CONFIG to an external private confirmation file')
    console.log(JSON.stringify(applyStandardMemoryTransition(JSON.parse(readFileSync(privateFile(path), 'utf8')))))
  } catch (error) {
    const message = error instanceof Error && /^(Unexpected previous|Previous memory|Transition files|Explicit transition|The data|Stop Eating|The memory|Private memory|Use a new|Backup storage|Unexpected backup|Set EATING_)/.test(error.message) ? error.message : 'Private memory transition failed; original backups and connection details are not displayed'
    console.error(message)
    process.exitCode = 1
  }
}
