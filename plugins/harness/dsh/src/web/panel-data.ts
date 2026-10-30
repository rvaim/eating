import { HostApiError } from '@eating/ui-sdk'

export interface ModelOption { readonly id: string; readonly name?: string }
export interface ModelTestResult { readonly ok: true; readonly model: string; readonly latencyMs: number }
export interface SystemDshStatus {
  readonly found: boolean
  readonly path: string | null
  readonly version: string | null
  readonly source: 'override' | 'path' | 'common' | 'application' | null
}
export interface ModelCapabilities { readonly schemaVersion: 1; readonly revision: number; readonly imageInput: boolean }
export interface NativeWebStatus { readonly ready: boolean }
export interface NativeWebLaunch { readonly url: string; readonly rootSessionId: string }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))

export function readSystemDsh(value: unknown): SystemDshStatus {
  if (!object(value) || !onlyKeys(value, ['found', 'path', 'version', 'source']) || typeof value.found !== 'boolean') return invalid()
  if (value.found === false) {
    if (value.path !== null || value.version !== null || value.source !== null) return invalid()
    return { found: false, path: null, version: null, source: null }
  }
  if (!text(value.path, 2048) || !value.path || !text(value.version, 64) || !value.version
    || !['override', 'path', 'common', 'application'].includes(String(value.source))) return invalid()
  return { found: true, path: value.path, version: value.version, source: value.source as SystemDshStatus['source'] }
}

/** The host only reports whether the official Web is ready; the authenticated URL is never part of it. */
export function readNativeWebStatus(value: unknown): NativeWebStatus {
  if (!object(value) || !onlyKeys(value, ['ready']) || typeof value.ready !== 'boolean') return invalid()
  return { ready: value.ready }
}

/** The authenticated URL is accepted only for the loopback official Web, strictly on demand. */
export function readNativeWebLaunch(value: unknown): NativeWebLaunch {
  if (!object(value) || !onlyKeys(value, ['url', 'rootSessionId'])
    || !text(value.rootSessionId, 160) || !value.rootSessionId || !text(value.url, 16_384) || /[\s\\]/u.test(value.url)) return invalid()
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\//u.exec(value.url)
  if (!match || Number(match[1]) > 65_535) return invalid()
  try {
    const url = new URL(value.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) return invalid()
  } catch { return invalid() }
  return { url: value.url, rootSessionId: value.rootSessionId }
}

export function readModelCapabilities(value: unknown): ModelCapabilities {
  if (!object(value) || !onlyKeys(value, ['schemaVersion', 'revision', 'imageInput']) || value.schemaVersion !== 1
    || !integer(value.revision) || typeof value.imageInput !== 'boolean') return invalid()
  return { schemaVersion: 1, revision: value.revision, imageInput: value.imageInput }
}

export function readModels(value: unknown): readonly ModelOption[] {
  if (!object(value) || !Array.isArray(value.models) || value.models.length > 2000) return invalid()
  const seen = new Set<string>()
  return value.models.map(entry => {
    if (!object(entry) || !text(entry.id, 160) || !entry.id.trim() || seen.has(entry.id) || entry.name !== undefined && !text(entry.name, 256)) return invalid()
    seen.add(entry.id)
    return { id: entry.id, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) }
  })
}

export function readModelTest(value: unknown, model: string): ModelTestResult {
  if (!object(value) || value.ok !== true || value.model !== model || !integer(value.latencyMs) || value.latencyMs > 120_000) return invalid()
  return { ok: true, model, latencyMs: value.latencyMs }
}
