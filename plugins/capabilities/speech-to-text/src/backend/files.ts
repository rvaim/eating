import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { PlatformError } from '@eating/plugin-sdk'

export function storageError(): never { throw new PlatformError('ASR_STORAGE_FAILED', '语音识别插件数据格式或存储无效，原数据未覆盖。', 500, 'unknown') }
export function directory(path: string): string {
  const root = resolve(path), stat = lstatSync(root, { throwIfNoEntry: false })
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) storageError()
  mkdirSync(root, { recursive: true, mode: 0o700 }); return root
}
export function read(path: string, maximum: number): Buffer | null {
  const stat = lstatSync(path, { throwIfNoEntry: false }); if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) storageError()
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const current = fstatSync(fd); if (!current.isFile() || current.size > maximum) storageError(); const bytes = readFileSync(fd); if (bytes.length > maximum) storageError(); return bytes } finally { closeSync(fd) }
}
export function write(path: string, bytes: Buffer): void {
  const parent = directory(dirname(path)); if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) storageError()
  const temporary = join(parent, '.asr-' + randomUUID() + '.tmp')
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temporary, path); if (process.platform !== 'win32') { const d = openSync(parent, constants.O_RDONLY); try { fsyncSync(d) } finally { closeSync(d) } } }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
export function json(value: unknown): Buffer { return Buffer.from(JSON.stringify(value, null, 2) + '\n') }
