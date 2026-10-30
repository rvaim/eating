import type { ConnectionStatus, PluginKind } from '@eating/plugin-sdk'
import { HostApiError } from '@eating/ui-sdk'

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const kinds: readonly PluginKind[] = ['communication', 'harness', 'capability']
const states: readonly ConnectionStatus['state'][] = ['unconfigured', 'disconnected', 'connecting', 'connected', 'reconnecting', 'error']

export interface PluginPackageStatus { readonly state: ConnectionStatus['state']; readonly lastError: string | null }
export interface PluginPackageInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly kind: PluginKind
  readonly enabled: boolean
  readonly status: PluginPackageStatus
  readonly frontend: { readonly entry: string; readonly style: string } | null
}
export interface PluginPackagesSnapshot { readonly protocolVersion: 1; readonly plugins: readonly PluginPackageInfo[] }
export interface PluginPreviewManifest {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly kind: PluginKind
  readonly apiVersion: number
}
export interface PluginInstallPreview {
  readonly planId: string
  readonly manifest: PluginPreviewManifest
  readonly packageBytes: number
  readonly digest: string
}

function readStatus(value: unknown): PluginPackageStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (!states.includes(record.state as ConnectionStatus['state'])) return invalid()
  if (record.lastError !== null && record.lastError !== undefined && typeof record.lastError !== 'string') return invalid()
  return { state: record.state as ConnectionStatus['state'], lastError: typeof record.lastError === 'string' ? record.lastError : null }
}

function readFrontend(value: unknown): PluginPackageInfo['frontend'] {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (!text(record.entry, 4096) || !text(record.style, 4096)) return invalid()
  return { entry: record.entry, style: record.style }
}

function readPlugin(value: unknown): PluginPackageInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (!text(record.id, 160) || !text(record.name, 200) || !text(record.version, 64) || !kinds.includes(record.kind as PluginKind)
    || typeof record.enabled !== 'boolean') return invalid()
  return { id: record.id, name: record.name, version: record.version, kind: record.kind as PluginKind,
    enabled: record.enabled, description: typeof record.description === 'string' ? record.description.slice(0, 4000) : '',
    status: readStatus(record.status), frontend: readFrontend(record.frontend) }
}

export function readPluginPackages(value: unknown): PluginPackagesSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (record.protocolVersion !== 1 || !Array.isArray(record.plugins) || record.plugins.length > 500) return invalid()
  const plugins = record.plugins.map(readPlugin)
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) return invalid()
  return { protocolVersion: 1, plugins }
}

export function readPluginInstallPreview(value: unknown): PluginInstallPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (!onlyKeys(record, ['planId', 'manifest', 'packageBytes', 'digest']) || !text(record.planId, 200)
    || !integer(record.packageBytes) || !text(record.digest, 200) || !record.manifest || typeof record.manifest !== 'object' || Array.isArray(record.manifest)) return invalid()
  const manifest = record.manifest as Record<string, unknown>
  if (!text(manifest.id, 160) || !text(manifest.name, 200) || !text(manifest.version, 64) || !kinds.includes(manifest.kind as PluginKind)
    || !integer(manifest.apiVersion) || !text(manifest.description, 4000)) return invalid()
  return { planId: record.planId, manifest: { id: manifest.id, name: manifest.name, description: manifest.description,
    version: manifest.version, kind: manifest.kind as PluginKind, apiVersion: manifest.apiVersion }, packageBytes: record.packageBytes, digest: record.digest }
}
