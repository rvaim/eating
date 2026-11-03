import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

export const LIMITS = { jobs: 200, appendJobs: 100, scopes: 500, bufferedBytes: 2 * 1024 * 1024, jobBytes: 512 * 1024, messages: 1000, concurrent: 2, responseBytes: 2 * 1024 * 1024, query: 4000, save: 32000 } as const
export function error(code: string, status = 400, outcome: 'not-sent' | 'failed' | 'unknown' = 'not-sent'): PlatformError {
  return new PlatformError(code, code, status, outcome)
}
export function invalid(): never { throw error('MEMORY_INVALID_INPUT') }
export function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): JsonObject {
  if (!isJsonObject(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid()
  return value
}
export function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
  const result = value.trim()
  if (!empty && !result) invalid()
  return result
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
  return value
}
export function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value }
export function identity(value: unknown, empty = false): string {
  if (value === '' && empty) return ''
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,96}$/.test(value)) invalid()
  return value
}
/** Service identities follow OpenViking's public rules; peer tuple components remain separate. */
export function serviceIdentity(value: unknown, empty = false, account = false): string {
  if (value === '' && empty) return ''
  if (typeof value !== 'string' || value.length > 96 || !/^[A-Za-z0-9_.@-]+$/.test(value) || value === '.' || value === '..' || value.split('@').length > 2 || account && value.startsWith('_')) invalid()
  return value
}
export function platform(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value)) invalid()
  return value
}
export function identifier(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) invalid()
  return value
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) invalid()
  return new Date(value).toISOString()
}
export function schema(condition: unknown): asserts condition { if (!condition) throw error('MEMORY_UNSUPPORTED_SERVER', 502, 'failed') }
export function asJson(value: unknown): JsonObject { return value as JsonObject }
export function errorCode(value: unknown): string {
  return value instanceof PlatformError && /^MEMORY_[A-Z_]+$/.test(value.code) ? value.code : 'MEMORY_REQUEST_FAILED'
}
export function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw error('MEMORY_CANCELLED', 409) }
