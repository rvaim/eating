import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { isJsonObject, MAX_INPUT_AUDIO_BYTES, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { writeRestrictedJson } from './config-file'
interface Connection { endpoint: string; accountId: string | null }
interface Mapping { onebotRoot: string; hostRoot: string; ownerConfirmed: boolean; endpoint: string; accountId: string | null }
interface Stored { schemaVersion: 1; revision: number; mapping: Mapping | null }
const exact = (v: JsonObject, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k))
function invalid(): never { throw new PlatformError('QQ_AUDIO_INPUT_INVALID', '请核对音频缓存共享目录与当前连接确认。', 400, 'not-sent') }
function pathValue(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(v) && !/(?:^|[\\/])\.\.?([\\/]|$)/u.test(v) }
export class QQAudioInputConfig {
  private readonly path: string
  constructor(root: string) { this.path = join(root, 'audio-input.json') }
  private stored(): Stored {
    const s = lstatSync(this.path, { throwIfNoEntry: false }); if (!s) return { schemaVersion: 1, revision: 0, mapping: null }
    let fd: number | undefined
    try {
      if (!s.isFile() || s.isSymbolicLink() || s.size < 1 || s.size > 32768) invalid()
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const bytes = readFileSync(fd); if (bytes.length > 32768) invalid()
      const v: unknown = JSON.parse(bytes.toString())
      if (!isJsonObject(v) || !exact(v, ['schemaVersion', 'revision', 'mapping']) || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || Number(v.revision) >= Number.MAX_SAFE_INTEGER) invalid()
      if (v.mapping !== null) {
        const m = v.mapping
        if (!isJsonObject(m) || !exact(m, ['onebotRoot', 'hostRoot', 'ownerConfirmed', 'endpoint', 'accountId']) || !pathValue(m.hostRoot) || !isAbsolute(m.hostRoot) || !pathValue(m.onebotRoot) || !posix.isAbsolute(m.onebotRoot) && !win32.isAbsolute(m.onebotRoot) || typeof m.ownerConfirmed !== 'boolean' || typeof m.endpoint !== 'string' || m.accountId !== null && (typeof m.accountId !== 'string' || !/^[1-9]\d{0,15}$/.test(m.accountId))) invalid()
      }
      return v as unknown as Stored
    } catch { throw new PlatformError('QQ_AUDIO_INPUT_CORRUPTED', '音频共享目录配置不是当前格式，原文件保留。', 500, 'not-sent') }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  snapshot(connection: Connection) {
    const v = this.stored(), m = v.mapping
    return { schemaVersion: 1 as const, revision: v.revision, mapping: m ? { onebotRoot: m.onebotRoot, hostRoot: m.hostRoot, ownerConfirmed: Boolean(m.ownerConfirmed && connection.accountId && m.accountId === connection.accountId && m.endpoint === connection.endpoint) } : null }
  }
  save(input: unknown, connection: Connection) {
    const current = this.stored()
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'mapping']) || input.expectedRevision !== current.revision) throw new PlatformError('QQ_AUDIO_INPUT_CONFLICT', '音频共享目录设置已变化，请重新读取后核对。', 409, 'not-sent')
    let mapping: Mapping | null = null
    if (input.mapping !== null) {
      const m = input.mapping
      if (!isJsonObject(m) || !exact(m, ['onebotRoot', 'hostRoot', 'ownerConfirmed']) || !pathValue(m.onebotRoot) || !posix.isAbsolute(m.onebotRoot) && !win32.isAbsolute(m.onebotRoot) || !pathValue(m.hostRoot) || !isAbsolute(m.hostRoot) || typeof m.ownerConfirmed !== 'boolean') invalid()
      const root = realpathSync(m.hostRoot)
      if (!lstatSync(m.hostRoot).isDirectory() || lstatSync(m.hostRoot).isSymbolicLink() || m.ownerConfirmed && !connection.accountId) invalid()
      mapping = { onebotRoot: m.onebotRoot, hostRoot: root, ownerConfirmed: m.ownerConfirmed, ...connection }
    }
    writeRestrictedJson(this.path, { schemaVersion: 1, revision: current.revision + 1, mapping: mapping ? { ...mapping } : null }); return this.snapshot(connection)
  }
  readMapped(file: string, connection: Connection, revision: number): Uint8Array {
    const saved = this.snapshot(connection), m = saved.mapping
    if (saved.revision !== revision || !m?.ownerConfirmed) throw new PlatformError('QQ_AUDIO_INPUT_REQUIRED', '请在QQ设置中配置并确认收到语音的音频缓存共享目录；不能直接读取OneBot远端路径。', 409, 'not-sent')
    const paths = /^[A-Za-z]:[\\/]/.test(m.onebotRoot) ? win32 : posix
    if (!pathValue(file) || !paths.isAbsolute(file)) invalid()
    const tail = paths.relative(m.onebotRoot, file)
    if (!tail || paths.isAbsolute(tail) || tail === '..' || tail.startsWith('..' + paths.sep)) invalid()
    const local = resolve(m.hostRoot, ...tail.split(paths.sep)), real = realpathSync(local), rel = relative(m.hostRoot, real)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) invalid()
    // Parent symlinks are rejected too, so an approved directory cannot redirect a read.
    let parent = m.hostRoot
    for (const part of relative(m.hostRoot, local).split(sep)) { parent = join(parent, part); if (lstatSync(parent).isSymbolicLink()) invalid() }
    const expected = lstatSync(real)
    if (realpathSync(m.hostRoot) !== m.hostRoot || realpathSync(local) !== real) invalid()
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { const stat = fstatSync(fd); if (stat.dev !== expected.dev || stat.ino !== expected.ino || !stat.isFile() || stat.size > MAX_INPUT_AUDIO_BYTES || stat.size < 44) invalid(); const bytes = readFileSync(fd); if (bytes.length > MAX_INPUT_AUDIO_BYTES || bytes.length !== stat.size) invalid(); return bytes }
    finally { closeSync(fd) }
  }
}
