import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const outside = path => { const difference = relative(repository, path); return difference === '..' || difference.startsWith('..' + sep) }
const configurationKeys = ['enabled', 'autoResume', 'minIntervalSeconds', 'maxCyclesPerHour', 'maxRunMinutes', 'cycleTimeoutSeconds', 'maxConsecutiveFailures', 'maxContactsPerHour', 'targets']
const stateKeys = ['revision', 'ownerPaused', 'mode', 'wakeAt', 'note', 'startedAt', 'windowAt', 'cycles', 'contacts', 'failures', 'active', 'lastStartedAt', 'lastFinishedAt', 'lastOutcome', 'errorCode', 'history']
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

/** Explicit offline operation; production readers never invoke this transition. */
export function planBoundedAutonomyTransition(document, maxRestMinutes, now = Date.now()) {
  if (!exact(document, ['schemaVersion', 'revision', 'configuration', 'state']) || document.schemaVersion !== 1 || !integer(document.revision, 0, Number.MAX_SAFE_INTEGER - 1)
    || !exact(document.configuration, configurationKeys) || !exact(document.state, stateKeys) || !integer(maxRestMinutes, 1, 1440) || !integer(now)) throw new Error('Unexpected previous autonomy format or rest limit; nothing was changed')
  const c = document.configuration, s = document.state
  const bounds = { minIntervalSeconds: [1, 86400], maxCyclesPerHour: [1, 3600], maxRunMinutes: [1, 10080], cycleTimeoutSeconds: [10, 3600], maxConsecutiveFailures: [1, 10], maxContactsPerHour: [0, 1000] }
  if (typeof c.enabled !== 'boolean' || typeof c.autoResume !== 'boolean' || Object.entries(bounds).some(([key, range]) => !integer(c[key], ...range)) || c.minIntervalSeconds > maxRestMinutes * 60 || !Array.isArray(c.targets) || c.targets.length > 50) throw new Error('Unexpected previous autonomy configuration; nothing was changed')
  const ids = new Set(), identities = new Set()
  for (const target of c.targets) {
    if (!exact(target, ['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId', 'toolNames']) || !['id', 'label', 'pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId'].every(key => text(target[key], key === 'label' ? 80 : 160))
      || !Array.isArray(target.toolNames) || !target.toolNames.length || target.toolNames.length > 256 || target.toolNames.some(name => !text(name, 160)) || new Set(target.toolNames).size !== target.toolNames.length || ids.has(target.id)) throw new Error('Unexpected previous autonomy targets; nothing was changed')
    const identity = JSON.stringify([target.pluginId, target.instanceId, target.accountId, target.agentTypeId, target.targetId])
    if (identities.has(identity)) throw new Error('Unexpected previous autonomy targets; nothing was changed')
    ids.add(target.id); identities.add(identity)
  }
  if (!integer(s.revision, 0, Number.MAX_SAFE_INTEGER - 1) || typeof s.ownerPaused !== 'boolean' || !['active', 'sleeping', 'waiting'].includes(s.mode) || s.active !== null
    || typeof s.note !== 'string' || s.note.length > 500 || ['wakeAt', 'startedAt', 'lastStartedAt', 'lastFinishedAt'].some(key => s[key] !== null && !integer(s[key]))
    || ['windowAt', 'cycles', 'contacts', 'failures'].some(key => !integer(s[key])) || s.mode === 'sleeping' && s.wakeAt === null
    || ![null, 'completed', 'failed', 'unknown', 'cancelled'].includes(s.lastOutcome) || s.errorCode !== null && !text(s.errorCode, 100)
    || !Array.isArray(s.history) || s.history.length > 20) throw new Error('Previous autonomy state is active or invalid; preserve it for review')
  if (s.history.some(row => !exact(row, ['cycleId', 'startedAt', 'finishedAt', 'outcome', 'code']) || !text(row.cycleId) || !integer(row.startedAt) || !integer(row.finishedAt) || !['completed', 'failed', 'unknown', 'cancelled'].includes(row.outcome) || row.code !== null && !text(row.code, 100)) || !integer(now + maxRestMinutes * 60000)) throw new Error('Previous autonomy state is invalid; nothing was changed')
  const next = structuredClone(document)
  next.schemaVersion = 2
  next.revision++
  next.configuration.maxRestMinutes = maxRestMinutes
  next.state.revision++
  const ceiling = now + maxRestMinutes * 60000
  if (s.mode === 'waiting') next.state.wakeAt = ceiling
  else if (s.wakeAt !== null) next.state.wakeAt = Math.min(s.wakeAt, ceiling)
  return next
}

function privateFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !outside(resolve(path)) || !outside(realpathSync(path)) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('Transition files must be regular private files outside the checkout')
  return realpathSync(path)
}

export function applyBoundedAutonomyTransition(input) {
  if (!exact(input, ['dataDirectory', 'backupDirectory', 'expectedAutonomySha256', 'maxRestMinutes', 'confirmation']) || input.confirmation !== 'bounded-autonomy-v2'
    || !/^[a-f0-9]{64}$/.test(input.expectedAutonomySha256 ?? '')) throw new Error('Explicit autonomy transition confirmation and original hash are required')
  if (typeof input.dataDirectory !== 'string' || !isAbsolute(input.dataDirectory) || !outside(resolve(input.dataDirectory)) || !outside(realpathSync(input.dataDirectory)) || lstatSync(input.dataDirectory).isSymbolicLink()) throw new Error('The data directory must be private and outside the checkout')
  if (existsSync(resolve(input.dataDirectory, 'host/host.lock'))) throw new Error('Stop Eating cleanly before changing autonomy storage')
  const directory = resolve(input.dataDirectory, 'harness/dsh')
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw new Error('The autonomy directory must be a regular private directory')
  const path = privateFile(resolve(directory, 'autonomy.json')), original = readFileSync(path)
  if (original.length > 256 * 1024 || digest(original) !== input.expectedAutonomySha256) throw new Error('Private autonomy state changed after inspection; nothing was changed')
  const next = planBoundedAutonomyTransition(JSON.parse(original), input.maxRestMinutes)
  if (typeof input.backupDirectory !== 'string' || !isAbsolute(input.backupDirectory) || !outside(resolve(input.backupDirectory)) || existsSync(input.backupDirectory)) throw new Error('Use a new private backup directory outside the checkout')
  const parent = realpathSync(dirname(input.backupDirectory)), difference = relative(realpathSync(input.dataDirectory), parent)
  if (!outside(parent) || difference !== '..' && !difference.startsWith('..' + sep)) throw new Error('Backup storage must be outside application data')
  mkdirSync(input.backupDirectory, { mode: 0o700 })
  if (realpathSync(input.backupDirectory) !== resolve(input.backupDirectory)) throw new Error('Unexpected backup directory resolution')
  writeFileSync(resolve(input.backupDirectory, 'autonomy.schema1.json'), original, { mode: 0o600, flag: 'wx' })
  const temporary = resolve(directory, '.bounded-autonomy-' + randomUUID() + '.tmp')
  try {
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
    if (existsSync(resolve(input.dataDirectory, 'host/host.lock')) || digest(readFileSync(path)) !== input.expectedAutonomySha256) throw new Error('Private autonomy state changed during backup; nothing was changed')
    renameSync(temporary, path)
  } finally { if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) unlinkSync(temporary) }
  return { schemaVersion: 2, maxRestMinutes: input.maxRestMinutes, originalFileBackedUp: true, ownerPauseRetained: true, existingRecordsRetained: true }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_AUTONOMY_TRANSITION_CONFIG
    if (!path) throw new Error('Set EATING_AUTONOMY_TRANSITION_CONFIG to a private confirmation file')
    console.log(JSON.stringify(applyBoundedAutonomyTransition(JSON.parse(readFileSync(privateFile(path), 'utf8')))))
  } catch (error) {
    console.error(error instanceof Error && /^(Unexpected previous|Previous autonomy|Transition files|Explicit autonomy|The data|Stop Eating|The autonomy|Private autonomy|Use a new|Backup storage|Unexpected backup|Set EATING_)/.test(error.message) ? error.message : 'Private autonomy transition failed; connection details are not displayed')
    process.exitCode = 1
  }
}
