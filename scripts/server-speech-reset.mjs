import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outside = (root, target) => { const part = relative(root, target); return part === '..' || part.startsWith('..' + sep) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function inspectSpeechDirectory(directory) {
  const files = []
  const visit = root => {
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Speech reset refuses symbolic links')
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push({ path: relative(directory, path).split(sep).join('/'), byteLength: stat.size, sha256: digest(readFileSync(path)) })
      else throw new Error('Speech reset refuses special files')
    }
  }
  visit(directory)
  return { files, sha256: digest(JSON.stringify(files)) }
}
/** Owner-authorized destructive reset, offline only. Never called by production readers. */
export function applySpeechDataReset(input) {
  const keys = ['dataDirectory', 'backupDirectory', 'expectedSpeechManifestSha256', 'confirmation']
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))
    || input.confirmation !== 'reset-tts-for-multi-protocol-v2' || !/^[a-f0-9]{64}$/.test(input.expectedSpeechManifestSha256 ?? '')) throw new Error('Explicit speech reset confirmation and original manifest are required')
  for (const key of ['dataDirectory', 'backupDirectory']) if (typeof input[key] !== 'string' || !isAbsolute(input[key]) || !outside(repository, resolve(input[key]))) throw new Error('Speech reset paths must be private and outside the checkout')
  const data = realpathSync(input.dataDirectory)
  if (data !== resolve(input.dataDirectory) || !lstatSync(data).isDirectory() || !outside(repository, data)) throw new Error('Speech reset requires a regular private data directory')
  if (existsSync(join(data, 'host/host.lock'))) throw new Error('Stop Eating cleanly before resetting speech data')
  const speech = join(data, 'capabilities/text-to-speech')
  if (realpathSync(speech) !== speech || !lstatSync(speech).isDirectory()) throw new Error('Speech reset requires the exact plugin directory')
  const backup = resolve(input.backupDirectory), parent = realpathSync(dirname(backup))
  if (existsSync(backup) || parent !== dirname(backup) || !outside(repository, parent) || !outside(data, parent)) throw new Error('Use a new backup directory outside application data')
  const before = inspectSpeechDirectory(speech)
  if (before.sha256 !== input.expectedSpeechManifestSha256) throw new Error('Speech files changed after inspection; nothing was reset')
  renameSync(speech, backup)
  try { mkdirSync(speech, { mode: 0o700 }) } catch (error) { renameSync(backup, speech); throw error }
  if (inspectSpeechDirectory(backup).sha256 !== before.sha256) throw new Error('Speech backup verification failed; preserve both directories for review')
  return { speechDataReset: true, movedFiles: before.files.length, backupVerified: true, configurationMigrated: false, otherPluginDataChanged: false }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.env.EATING_SPEECH_RESET_CONFIG
    if (!path || !isAbsolute(path) || realpathSync(path) !== resolve(path) || !outside(repository, resolve(path)) || !lstatSync(path).isFile()) throw new Error('Use an external private speech reset configuration')
    console.log(JSON.stringify(applySpeechDataReset(JSON.parse(readFileSync(path, 'utf8')))))
  } catch { console.error('Speech reset was not completed; inspect the private configuration and preserve the data for review'); process.exitCode = 1 }
}
