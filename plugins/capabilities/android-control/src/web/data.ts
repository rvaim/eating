import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { HostApiError, createRequestId, hostRequest } from '@eating/ui-sdk'
import type {
  AdbDetectionSnapshot,
  AdbPlatformPackageDescriptor,
  AndroidDevicesSnapshot,
  PublicAndroidConfiguration,
} from '../types'
import type { AndroidTranslationKey } from './i18n'

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export function getErrorCode(error: unknown): string | null {
  if (error instanceof HostApiError) return error.code
  const obj = asObject(error)
  if (!obj) return null
  if (typeof obj.code === 'string') return obj.code
  const nested = asObject(obj.error)
  return typeof nested?.code === 'string' ? nested.code : null
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof HostApiError && error.code === 'REQUEST_CANCELLED') return true
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
}

export function readPublicConfig(value: unknown): PublicAndroidConfiguration | null {
  const obj = asObject(value)
  if (!obj || typeof obj.revision !== 'number' || typeof obj.configurationPath !== 'string') return null
  return value as PublicAndroidConfiguration
}

export function readDetection(value: unknown): AdbDetectionSnapshot | null {
  const obj = asObject(value)
  if (!obj || typeof obj.available !== 'boolean' || typeof obj.source !== 'string') return null
  return value as AdbDetectionSnapshot
}

export function readPackageDescriptor(value: unknown): AdbPlatformPackageDescriptor | null {
  const obj = asObject(value)
  if (!obj || typeof obj.supported !== 'boolean' || typeof obj.targetLabel !== 'string') return null
  return value as AdbPlatformPackageDescriptor
}

export function readDevicesSnapshot(value: unknown): AndroidDevicesSnapshot | null {
  const obj = asObject(value)
  if (!obj || !Array.isArray(obj.devices)) return null
  return value as AndroidDevicesSnapshot
}

export function androidErrorKey(code: string | null): AndroidTranslationKey {
  if (!code) return 'unknownError'
  const known = new Set<string>([
    'ANDROID_LEGACY_CONFIGURATION_UNSUPPORTED',
    'ANDROID_CONFIGURATION_INVALID',
    'ANDROID_CONFIGURATION_CONFLICT',
    'ANDROID_STOP_FIRST',
    'ANDROID_ADB_MISSING',
    'ANDROID_MANUAL_ADB_INVALID',
    'ANDROID_SYSTEM_ADB_EXISTS',
    'ANDROID_PLATFORM_UNSUPPORTED',
    'ANDROID_LICENSE_NOT_ACCEPTED',
    'ANDROID_INSTALL_CHECKSUM_FAILED',
    'ANDROID_INSTALL_SIZE_MISMATCH',
    'ANDROID_INSTALL_ARCHIVE_INVALID',
    'ANDROID_INSTALL_VERIFY_FAILED',
    'ANDROID_NETWORK_ADDRESS_INVALID',
    'ANDROID_DEVICE_REQUIRED',
    'ANDROID_DEVICE_UNAUTHORIZED',
    'ANDROID_DEVICE_OFFLINE',
    'ANDROID_PAIR_CODE_INVALID',
    'ANDROID_PAIR_FAILED',
    'ANDROID_NOT_CONNECTED',
    'ANDROID_REQUEST_CONFLICT',
    'ANDROID_OPERATION_UNKNOWN',
    'PLUGIN_DISABLED',
  ])
  return known.has(code) ? (`err.${code}` as AndroidTranslationKey) : 'unknownError'
}

export async function manageAndroid(operation: string, input: JsonObject, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result = await hostRequest<unknown>('/plugins/android-control/manage', {
    method: 'POST',
    body: { operation, input },
    signal,
  })
  return asObject(result) ?? {}
}

export async function invokeAndroid(
  name: string,
  args: JsonObject,
  signal?: AbortSignal,
  requestId = createRequestId(),
  readOnly = false,
): Promise<Record<string, unknown>> {
  const result = await hostRequest<unknown>('/plugins/android-control/invoke', {
    method: 'POST',
    body: { name, arguments: args, requestId, ...(readOnly ? {} : { confirmed: true }) },
    signal,
  })
  return asObject(result) ?? {}
}

export interface DecodedOutput {
  readonly structured: Record<string, unknown>
  readonly textBlocks: readonly string[]
  readonly image: { readonly mimeType: string; readonly data: string } | null
}

export function decodeToolOutput(raw: Record<string, unknown>): DecodedOutput {
  const wrapped = asObject(raw.result) ?? raw
  const structured = asObject(wrapped.structuredContent) ?? wrapped
  const content = Array.isArray(wrapped.content) ? wrapped.content : []
  const textBlocks: string[] = []
  let image: { readonly mimeType: string; readonly data: string } | null = null
  for (const item of content) {
    const obj = asObject(item)
    if (!obj) continue
    if (obj.type === 'text' && typeof obj.text === 'string') textBlocks.push(obj.text)
    if (obj.type === 'image' && typeof obj.mimeType === 'string' && typeof obj.data === 'string') {
      image = { mimeType: obj.mimeType, data: obj.data }
    }
  }
  return { structured, textBlocks, image }
}

export function isUnknownOutcomeError(error: unknown): boolean {
  if (error instanceof HostApiError && (error.outcome === 'unknown' || error.code === 'ANDROID_OPERATION_UNKNOWN')) return true
  const obj = asObject(error)
  if (!obj) return false
  if (obj.outcome === 'unknown') return true
  const nested = asObject(obj.error)
  return nested?.outcome === 'unknown' || getErrorCode(error) === 'ANDROID_OPERATION_UNKNOWN'
}

export function joinHostPath(directory: string, entry: string): string {
  const trimmed = directory.replace(/[\\/]+$/, '')
  if (!trimmed || trimmed === '.') return entry
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${sep}${entry}`
}

export function parentHostPath(directory: string): string | null {
  const normalized = directory.replace(/[\\/]+$/, '')
  if (!normalized || normalized === '/' || normalized === '.' || /^[A-Za-z]:$/.test(normalized)) return null
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (slash <= 0) return normalized.startsWith('/') ? '/' : null
  return normalized.slice(0, slash) || '/'
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function base64ToBlobUrl(mimeType: string, data: string): string {
  const bytes = base64ToBytes(data)
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }))
}

export function formatByteSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export { createRequestId, hostRequest }
export type { JsonValue }
