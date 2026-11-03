import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { QQMediaDirectoryMapping, QQMediaTransportSettings } from '../media-transport'
import { writeRestrictedJson } from './config-file'

interface StoredMapping extends QQMediaDirectoryMapping { readonly endpoint: string; readonly accountId: string | null }
interface StoredSettings { readonly schemaVersion: 1; readonly revision: number; readonly mode: 'auto' | 'shared-directory'; readonly mapping: StoredMapping | null }
export interface QQMediaConnection { readonly endpoint: string; readonly accountId: string | null }
const exact = (value: JsonObject, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function invalid(): never { throw new PlatformError('QQ_MEDIA_CONFIGURATION_INVALID', '图片传输设置格式无效；请填写绝对目录与明确的共享目录确认。', 400, 'not-sent') }
function corrupted(): never { throw new PlatformError('QQ_MEDIA_CONFIGURATION_CORRUPTED', '图片传输私有配置不是当前 schema1 或文件无效，原文件未覆盖。', 500, 'not-sent') }
function validPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) }
function mapping(value: unknown, stored = false): StoredMapping | null {
  if (value === null) return null
  if (!isJsonObject(value) || !exact(value, ['sourceRoot', 'hostMappingRoot', 'onebotRoot', 'ownerConfirmed', ...(stored ? ['endpoint', 'accountId'] : [])])
    || !validPath(value.sourceRoot) || !isAbsolute(value.sourceRoot) || !validPath(value.hostMappingRoot) || !isAbsolute(value.hostMappingRoot)
    || !validPath(value.onebotRoot) || !value.onebotRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value.onebotRoot)
    || value.onebotRoot.startsWith('//') || /(?:^|[\\/])\.\.?([\\/]|$)/.test(value.onebotRoot) || typeof value.ownerConfirmed !== 'boolean') invalid()
  if (stored && (typeof value.endpoint !== 'string' || value.endpoint.length > 4096 || value.accountId !== null && (typeof value.accountId !== 'string' || !/^[1-9]\d{0,15}$/.test(value.accountId)))) invalid()
  return { sourceRoot: value.sourceRoot, hostMappingRoot: value.hostMappingRoot, onebotRoot: value.onebotRoot,
    ownerConfirmed: value.ownerConfirmed, endpoint: stored ? String(value.endpoint) : '', accountId: stored ? value.accountId as string | null : null }
}
function localRoot(path: string): string {
  try {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) invalid()
    return realpathSync(path)
  } catch { throw new PlatformError('QQ_MEDIA_DIRECTORY_UNAVAILABLE', '本机源目录或映射目录不可验证，未保存共享目录设置。', 400, 'not-sent') }
}

export class QQMediaTransportConfiguration {
  private readonly path: string
  constructor(directory: string) { this.path = join(resolve(directory), 'media-transport.json') }
  private read(): StoredSettings {
    let descriptor: number | undefined
    try {
      const stat = lstatSync(this.path, { throwIfNoEntry: false })
      if (!stat) return { schemaVersion: 1, revision: 0, mode: 'auto', mapping: null }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || stat.size < 1) corrupted()
      descriptor = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > 32768 || opened.size < 1) corrupted()
      const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
      if (!isJsonObject(value) || !exact(value, ['schemaVersion', 'revision', 'mode', 'mapping']) || value.schemaVersion !== 1
        || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !['auto', 'shared-directory'].includes(String(value.mode))) corrupted()
      return { schemaVersion: 1, revision: value.revision, mode: value.mode as StoredSettings['mode'], mapping: mapping(value.mapping, true) }
    } catch { return corrupted() }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  snapshot(connection: QQMediaConnection): QQMediaTransportSettings {
    const current = this.read(), saved = current.mapping
    const fileEligible = Boolean(saved?.ownerConfirmed && saved.endpoint === connection.endpoint && saved.accountId && saved.accountId === connection.accountId)
    return { schemaVersion: 1, revision: current.revision, mode: current.mode,
      mapping: saved ? { sourceRoot: saved.sourceRoot, hostMappingRoot: saved.hostMappingRoot, onebotRoot: saved.onebotRoot, ownerConfirmed: fileEligible } : null, fileEligible }
  }
  save(input: unknown, connection: QQMediaConnection): QQMediaTransportSettings {
    const current = this.read()
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'mode', 'mapping']) || !['auto', 'shared-directory'].includes(String(input.mode))
      || typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) invalid()
    if (current.revision !== input.expectedRevision || current.revision === Number.MAX_SAFE_INTEGER) throw new PlatformError('QQ_MEDIA_CONFIGURATION_CONFLICT', '图片传输设置已变化，请重新读取并核对草稿。', 409, 'not-sent')
    const selected = mapping(input.mapping)
    if (input.mode === 'shared-directory' && !selected) invalid()
    if (selected?.ownerConfirmed && (!connection.endpoint || !connection.accountId)) throw new PlatformError('QQ_MEDIA_CONNECTION_REQUIRED', '确认共享目录前请先连接需使用映射的真实 OneBot 账号。', 409, 'not-sent')
    const saved = selected ? { ...selected, sourceRoot: localRoot(selected.sourceRoot), hostMappingRoot: localRoot(selected.hostMappingRoot),
      onebotRoot: /^[A-Za-z]:/.test(selected.onebotRoot) ? win32.normalize(selected.onebotRoot) : posix.normalize(selected.onebotRoot),
      endpoint: connection.endpoint, accountId: selected.ownerConfirmed ? connection.accountId : null } : null
    const next: StoredSettings = { schemaVersion: 1, revision: current.revision + 1, mode: input.mode as StoredSettings['mode'], mapping: saved }
    writeRestrictedJson(this.path, next as unknown as JsonObject)
    return this.snapshot(connection)
  }
}
