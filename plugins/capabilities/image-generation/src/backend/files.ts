import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { PlatformError } from '@eating/plugin-sdk'

export class ImageStorageError extends PlatformError {
  constructor(readonly committed = false) { super('IMAGE_GENERATION_STORAGE_FAILED', '生图数据读写失败，请检查插件数据目录与存储状态。', 500, committed ? 'unknown' : 'not-sent') }
}
export function prepareDirectory(directory: string): string {
  const root = resolve(directory)
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) throw new ImageStorageError()
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
  return root
}
export function readBytes(path: string, maximum: number): Buffer | null {
  if (!existsSync(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })) throw new ImageStorageError()
    return null
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new ImageStorageError()
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new ImageStorageError()
    return readFileSync(descriptor)
  } catch { throw new ImageStorageError() }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
export function writeBytes(path: string, bytes: Buffer): void {
  const parent = prepareDirectory(dirname(path)), target = resolve(path)
  if (dirname(target) !== parent || basename(target) === '.' || basename(target) === '..') throw new ImageStorageError()
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ImageStorageError()
  const temporary = join(parent, `.write-${randomUUID()}.tmp`)
  let descriptor: number | undefined, committed = false
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
    renameSync(temporary, target); committed = true
    if (process.platform !== 'win32') {
      const directory = openSync(parent, constants.O_RDONLY)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } catch { throw new ImageStorageError(committed) }
  finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (dirname(resolve(temporary)) === parent && lstatSync(temporary, { throwIfNoEntry: false })?.isFile()) unlinkSync(temporary)
  }
}
export function jsonBytes(value: unknown): Buffer { return Buffer.from(JSON.stringify(value, null, 2) + '\n') }
export function removeOwnBlob(directory: string, assetId: string): void {
  if (!/^[a-f0-9]{64}$/.test(assetId)) throw new ImageStorageError()
  const root = prepareDirectory(directory), path = resolve(root, assetId)
  if (dirname(path) !== root) throw new ImageStorageError()
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ImageStorageError()
  if (stat) unlinkSync(path)
}
