import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { error } from './validation'

export function directory(path: string): string {
  const root = resolve(path), stat = lstatSync(root, { throwIfNoEntry: false })
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw error('MEMORY_STORAGE_FAILED', 500)
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
  return root
}
export function readBytes(path: string, maximum: number): Buffer | null {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > maximum) throw error('MEMORY_STORAGE_FAILED', 500)
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(descriptor).isFile()) throw error('MEMORY_STORAGE_FAILED', 500)
    const bytes = readFileSync(descriptor)
    if (bytes.length > maximum) throw error('MEMORY_STORAGE_FAILED', 500)
    return bytes
  } catch { throw error('MEMORY_STORAGE_FAILED', 500) }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
export function writeJson(path: string, value: unknown): void {
  const parent = directory(dirname(path)), target = resolve(path)
  if (dirname(target) !== parent || lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw error('MEMORY_STORAGE_FAILED', 500)
  const temporary = join(parent, `.write-${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
    // Both paths have been resolved and constrained to this plugin's private directory.
    renameSync(temporary, target)
    if (process.platform !== 'win32') { const fd = openSync(parent, constants.O_RDONLY); try { fsyncSync(fd) } finally { closeSync(fd) } }
  } catch { throw error('MEMORY_STORAGE_FAILED', 500, 'unknown') }
  finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (dirname(resolve(temporary)) === parent && existsSync(temporary)) unlinkSync(temporary)
  }
}
