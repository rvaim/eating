import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

export function failure(code: string, message = '安卓执行请求未完成，请核对设备或执行端状态。', outcome: 'not-sent' | 'failed' | 'unknown' = 'not-sent', status = 400): PlatformError { return new PlatformError(code, message, status, outcome) }
export function rejectError(code: string, message: string, status = 400): PlatformError { return new PlatformError(code, message, status, 'not-sent') }
export function object(value: unknown, keys: readonly string[], required: readonly string[] = []): JsonObject {
  if (!isJsonObject(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw failure('ANDROID_ARGUMENTS_INVALID', '请提供当前接口要求的参数。')
  return value
}
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw failure('ANDROID_ARGUMENTS_INVALID', '数值参数超出允许范围。')
  return value
}
export function text(value: unknown, maximum = 4096): value is string { return typeof value === 'string' && value.length <= maximum && !value.includes('\0') }
export function stringField(value: unknown, code: string, message: string, maximum = 4096, allowEmpty = true): string {
  if (!text(value, maximum)) throw rejectError(code, message, 400)
  const trimmed = value.trim()
  if (!trimmed && !allowEmpty) throw rejectError(code, message, 400)
  return trimmed
}
export function readDocument(file: string, maximum = 2 * 1024 * 1024): JsonObject | null {
  if (!existsSync(file)) return null
  try { if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile() || statSync(file).size > maximum) throw Error('invalid'); const value: unknown = JSON.parse(readFileSync(file, 'utf8')); if (!isJsonObject(value)) throw Error('invalid'); return value }
  catch { throw failure('ANDROID_STATE_INVALID', '安卓插件数据格式无效，原文件未覆盖。', 'failed', 500) }
}
export function writeDocument(file: string, value: object): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (lstatSync(dirname(file)).isSymbolicLink() || existsSync(file) && lstatSync(file).isSymbolicLink()) throw failure('ANDROID_STATE_INVALID', '插件私有状态不能使用符号链接。', 'failed', 500)
  const temporary = file + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file)
}
