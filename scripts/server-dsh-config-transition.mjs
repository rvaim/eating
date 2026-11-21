import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const outside = path => { const difference = relative(repository, path); return difference === '..' || difference.startsWith('..' + sep) }
const configurationKeys = ['displayName', 'endpoint', 'model', 'apiKey', 'timeoutMs', 'maxTokens', 'autoConnect']

/** Explicit offline operation; production readers never invoke this transition. */
export function planDshConfigTransition(document) {
  if (!exact(document, ['schemaVersion', 'updatedAt', 'configuration']) || document.schemaVersion !== 1
    || typeof document.updatedAt !== 'string' || !Number.isFinite(Date.parse(document.updatedAt))
    || !exact(document.configuration, configurationKeys)) {
    throw new Error('Unexpected previous DSH configuration format; nothing was changed')
  }
  const c = document.configuration
  for (const key of ['displayName', 'endpoint', 'model', 'apiKey']) {
    if (typeof c[key] !== 'string' || /[\r\n\0]/.test(c[key])) throw new Error('Unexpected previous DSH configuration string field; nothing was changed')
  }
  if (!c.displayName.trim() || c.displayName.trim().length > 80 || c.endpoint.length > 2048 || c.model.length > 160 || c.apiKey.length > 4096
    || typeof c.autoConnect !== 'boolean' || !integer(c.timeoutMs, 1000, 120_000) || !integer(c.maxTokens, 1, 131_072)) {
    throw new Error('Unexpected previous DSH configuration values; nothing was changed')
  }
  return {
    schemaVersion: 2,
    updatedAt: document.updatedAt,
    configuration: {
      displayName: c.displayName,
      protocol: 'openai-completions',
      endpoint: c.endpoint,
      model: c.model,
      apiKey: c.apiKey,
      autoConnect: c.autoConnect,
      timeoutMs: c.timeoutMs,
      maxTokens: c.maxTokens,
    },
  }
}

function privateFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !outside(resolve(path)) || !outside(realpathSync(path)) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('Transition files must be regular private files outside the checkout')
  }
  return realpathSync(path)
}

export function applyDshConfigTransition(input) {
  if (!exact(input, ['dataDirectory', 'backupDirectory', 'expectedConfigSha256', 'confirmation'])
    || input.confirmation !== 'dsh-protocol-config-v2'
    || !/^[a-f0-9]{64}$/.test(input.expectedConfigSha256 ?? '')) {
    throw new Error('Explicit DSH configuration transition confirmation and original hash are required')
  }
  if (typeof input.dataDirectory !== 'string' || !isAbsolute(input.dataDirectory) || !outside(resolve(input.dataDirectory)) || !outside(realpathSync(input.dataDirectory)) || lstatSync(input.dataDirectory).isSymbolicLink()) {
    throw new Error('The data directory must be private and outside the checkout')
  }
  if (existsSync(resolve(input.dataDirectory, 'host/host.lock'))) {
    throw new Error('Stop Eating cleanly before changing DSH configuration storage')
  }
  const directory = resolve(input.dataDirectory, 'harness/dsh')
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) {
    throw new Error('The DSH directory must be a regular private directory')
  }
  const path = privateFile(resolve(directory, 'config.json'))
  const original = readFileSync(path)
  if (original.length > 256 * 1024 || digest(original) !== input.expectedConfigSha256) {
    throw new Error('Private DSH configuration changed after inspection; nothing was changed')
  }
  const next = planDshConfigTransition(JSON.parse(original))
  if (typeof input.backupDirectory !== 'string' || !isAbsolute(input.backupDirectory) || !outside(resolve(input.backupDirectory)) || existsSync(input.backupDirectory)) {
    throw new Error('Use a new private backup directory outside the checkout')
  }
  const parent = realpathSync(dirname(input.backupDirectory))
  const difference = relative(realpathSync(input.dataDirectory), parent)
  if (!outside(parent) || difference !== '..' && !difference.startsWith('..' + sep)) {
    throw new Error('Backup storage must be outside application data')
  }
  mkdirSync(input.backupDirectory, { mode: 0o700 })
  if (realpathSync(input.backupDirectory) !== resolve(input.backupDirectory)) throw new Error('Unexpected backup directory resolution')
  writeFileSync(resolve(input.backupDirectory, 'dsh-config.schema1.json'), original, { mode: 0o600, flag: 'wx' })
  const temporary = resolve(directory, '.dsh-config-' + randomUUID() + '.tmp')
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    if (existsSync(resolve(input.dataDirectory, 'host/host.lock')) || digest(readFileSync(path)) !== input.expectedConfigSha256) {
      throw new Error('Private DSH configuration changed during backup; nothing was changed')
    }
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) unlinkSync(temporary)
  }
  return {
    schemaVersion: 2,
    protocol: next.configuration.protocol,
    originalFileBackedUp: true,
    apiKeyRetained: next.configuration.apiKey.length > 0,
    existingFieldsRetained: true,
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_DSH_CONFIG_TRANSITION_CONFIG
    if (!path) throw new Error('Set EATING_DSH_CONFIG_TRANSITION_CONFIG to a private confirmation file')
    console.log(JSON.stringify(applyDshConfigTransition(JSON.parse(readFileSync(privateFile(path), 'utf8')))))
  } catch (error) {
    console.error(error instanceof Error && /^(Unexpected previous|Transition files|Explicit DSH|The data|Stop Eating|The DSH|Private DSH|Use a new|Backup storage|Unexpected backup|Set EATING_)/.test(error.message) ? error.message : 'Private DSH configuration transition failed; connection details are not displayed')
    process.exitCode = 1
  }
}
