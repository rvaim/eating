import { accessSync, constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { JsonObject } from '@eating/plugin-sdk'
import type { AndroidConfiguration, PublicAndroidConfiguration } from '../types'
import { failure, object, readDocument, text, writeDocument } from './files'

const defaults = (): AndroidConfiguration => ({ schemaVersion: 1, revision: 0, mode: 'local', adbPath: '', workspace: '', endpoint: '', token: '' })
function validate(value: JsonObject): AndroidConfiguration {
  object(value, Object.keys(defaults()), Object.keys(defaults()))
  if (value.schemaVersion !== 1 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.mode !== 'local' && value.mode !== 'remote' || !['adbPath', 'workspace', 'endpoint', 'token'].every(key => text(value[key]))) throw failure('ANDROID_CONFIGURATION_INVALID', '安卓插件配置格式不支持，原配置未覆盖。')
  if (value.adbPath && !isAbsolute(String(value.adbPath)) || value.workspace && !isAbsolute(String(value.workspace))) throw failure('ANDROID_CONFIGURATION_INVALID', 'ADB 和工作目录需使用执行端绝对路径。')
  if (value.endpoint) { let url: URL; try { url = new URL(String(value.endpoint)) } catch { throw failure('ANDROID_CONFIGURATION_INVALID', '请填写有效的远程执行端地址。') }; if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw failure('ANDROID_CONFIGURATION_INVALID', '执行端地址不支持内嵌凭据、查询参数或片段。') }
  return value as unknown as AndroidConfiguration
}
export class AndroidConfig {
  readonly file: string
  constructor(directory: string) { this.file = join(directory, 'config.json') }
  read(): AndroidConfiguration { const value = readDocument(this.file); return value === null ? defaults() : validate(value) }
  public(ready: boolean): PublicAndroidConfiguration { const { token, ...value } = this.read(); return { ...value, tokenConfigured: Boolean(token), ready } }
  save(input: unknown): AndroidConfiguration {
    const current = this.read(), value = object(input, ['expectedRevision', 'mode', 'adbPath', 'workspace', 'endpoint', 'token', 'clearToken'], ['expectedRevision', 'mode', 'adbPath', 'workspace', 'endpoint'])
    if (value.expectedRevision !== current.revision) throw failure('ANDROID_CONFIGURATION_CONFLICT', '配置已被其他页面修改，请保留草稿并刷新。', 'not-sent', 409)
    if (current.revision === Number.MAX_SAFE_INTEGER || value.clearToken !== undefined && typeof value.clearToken !== 'boolean' || value.token !== undefined && !text(value.token)) throw failure('ANDROID_CONFIGURATION_INVALID')
    const token = value.clearToken === true ? '' : typeof value.token === 'string' && value.token ? value.token : value.endpoint === current.endpoint ? current.token : ''
    const next = validate({ schemaVersion: 1, revision: current.revision + 1, mode: value.mode!, adbPath: value.adbPath!, workspace: value.workspace!, endpoint: value.endpoint!, token })
    writeDocument(this.file, next); return next
  }
}
export function locateAdb(configured: string): string {
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => resolve(dir, process.platform === 'win32' ? 'adb.exe' : 'adb'))
  for (const candidate of candidates) try { accessSync(candidate, constants.X_OK); return candidate } catch { /* Continue executable discovery only. */ }
  throw failure('ANDROID_ADB_NOT_FOUND', '未找到 ADB。请配置已安装的 Android Platform Tools 路径。', 'not-sent', 409)
}
