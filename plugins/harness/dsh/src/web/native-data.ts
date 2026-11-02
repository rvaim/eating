import { HostApiError } from '@eating/ui-sdk'
import { NATIVE_FEATURES, nativeGlobalToolAccess } from '../native-capabilities'
import type { NativeCapabilitiesConfiguration } from '../native-capabilities'

export type LocalizedText = string | Readonly<Record<string, string>>
export interface NativeFeatureStatus { id: string; available: boolean; platformAvailable: boolean; modules: { id: string; name: string; available: boolean }[] }
export interface NativePluginRow { entryId: string; moduleName: string; enabled: boolean; phase: string | null; observedPhase: string | null; protected: boolean; manageable: boolean; configured: boolean; fingerprint: string; title?: LocalizedText }
export interface NativeBundleRow { name: string; version: string | null; enabled: boolean; installed: boolean; availability: string; official: boolean; optional: boolean; removable: boolean; protected: boolean; fingerprint: string; rows: { id: string; name: string }[]; overrides: string[]; installTarget?: string; title?: LocalizedText; description?: LocalizedText; errorCode: string | null }
export interface NativeSnapshot {
  configuration: NativeCapabilitiesConfiguration
  agentTypes: { id: string; title: string; enabled: boolean }[]
  catalog: { schemaVersion: 1; features: NativeFeatureStatus[]; tools: { name: string; description: string; fingerprint: string; automaticAccess: 'main' | 'all' }[]; plugins: NativePluginRow[]; bundles: NativeBundleRow[];
    runtime: { running: boolean; appliedRevision: number | null; errorCode: string | null; mounted: { agentTypeId: string; featureId: string; state: string }[]; agents: { agentTypeId: string; nativeTools: string[]; mcpTools: string[] }[] } }
}
export const nativeObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 512 && value.every(text)
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function invalid(): never { throw new HostApiError('NATIVE_RESPONSE_INVALID', '', 'failed') }
export function readNativeConfiguration(value: unknown): NativeCapabilitiesConfiguration {
  if (!nativeObject(value) || value.schemaVersion !== 1 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.features) || value.features.length !== NATIVE_FEATURES.length || !Array.isArray(value.toolGrants) || value.toolGrants.length > 512) invalid()
  const ids = new Set<string>()
  for (const row of value.features) {
    if (!nativeObject(row) || !text(row.id) || ids.has(row.id) || !NATIVE_FEATURES.some(feature => feature.id === row.id) || typeof row.enabled !== 'boolean' || !texts(row.agentTypeIds) || !nativeObject(row.config)) invalid()
    ids.add(row.id)
  }
  const grants = (rows: unknown, overrides = false) => {
    if (!Array.isArray(rows) || rows.length > 512) invalid()
    const names = new Set<string>()
    for (const row of rows) {
      if (!nativeObject(row) || !text(row.name) || !/^[A-Za-z0-9_-]+$/.test(row.name) || nativeGlobalToolAccess(row.name) === 'reserved' || !overrides && row.name.startsWith('mcp__') || !fingerprint(row.fingerprint) || !texts(row.agentTypeIds) || new Set(row.agentTypeIds).size !== row.agentTypeIds.length || names.has(row.name)) invalid()
      names.add(row.name)
    }
  }
  grants(value.toolGrants)
  if (Object.hasOwn(value, 'toolAccessOverrides')) grants(value.toolAccessOverrides, true)
  return value as unknown as NativeCapabilitiesConfiguration
}
export function readNativeSnapshot(value: unknown): NativeSnapshot {
  if (!nativeObject(value) || !nativeObject(value.catalog) || !Array.isArray(value.agentTypes) || value.agentTypes.length > 101 || value.agentTypes.some(row => !nativeObject(row) || !text(row.id) || !text(row.title) || typeof row.enabled !== 'boolean')) invalid()
  readNativeConfiguration(value.configuration)
  const catalog = value.catalog
  if (catalog.schemaVersion !== 1 || !nativeObject(catalog.runtime) || typeof catalog.runtime.running !== 'boolean' || catalog.runtime.appliedRevision !== null && (!Number.isSafeInteger(catalog.runtime.appliedRevision) || Number(catalog.runtime.appliedRevision) < 0) || !Array.isArray(catalog.runtime.mounted) || !Array.isArray(catalog.runtime.agents)) invalid()
  for (const key of ['features', 'tools', 'plugins', 'bundles']) if (!Array.isArray(catalog[key]) || catalog[key].length > 2048) invalid()
  for (const row of catalog.features as unknown[]) if (!nativeObject(row) || !text(row.id) || typeof row.available !== 'boolean' || typeof row.platformAvailable !== 'boolean' || !Array.isArray(row.modules) || row.modules.some(module => !nativeObject(module) || !text(module.id) || !text(module.name) || typeof module.available !== 'boolean')) invalid()
  for (const row of catalog.tools as unknown[]) if (!nativeObject(row) || !text(row.name) || !text(row.description) || !fingerprint(row.fingerprint) || nativeGlobalToolAccess(row.name) === 'reserved' || row.automaticAccess !== nativeGlobalToolAccess(row.name)) invalid()
  for (const row of catalog.plugins as unknown[]) if (!nativeObject(row) || !text(row.entryId) || !text(row.moduleName) || !fingerprint(row.fingerprint) || ['enabled', 'protected', 'manageable', 'configured'].some(key => typeof row[key] !== 'boolean')) invalid()
  for (const row of catalog.bundles as unknown[]) if (!nativeObject(row) || !text(row.name) || !fingerprint(row.fingerprint) || !Array.isArray(row.rows) || !texts(row.overrides) || ['enabled', 'installed', 'official', 'optional', 'removable', 'protected'].some(key => typeof row[key] !== 'boolean')) invalid()
  for (const row of catalog.runtime.agents) if (!nativeObject(row) || !text(row.agentTypeId) || !texts(row.nativeTools) || !texts(row.mcpTools)) invalid()
  return value as unknown as NativeSnapshot
}
/** Clear newly typed secrets on hide while retaining saved placeholders and ordinary draft fields. */
export function clearNativeDraftSecrets(text: string, saved: unknown): string {
  const secretKey = (key: string) => !/Env$/.test(key) && /api.?key|secret|password|credential|authorization|cookie|token|headers|environment/i.test(key)
  const walk = (value: unknown, previous: unknown, key = '', inherited = false): unknown => {
    if (typeof value === 'string') {
      let privateUrl = false
      try { const url = new URL(value); privateUrl = ['http:', 'https:'].includes(url.protocol) && Boolean(url.search || url.username || url.password) } catch { /* Ordinary configuration strings are not URLs. */ }
      if (inherited || secretKey(key) || privateUrl) return previous === '<stored-secret>' ? previous : undefined
      return value
    }
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, Array.isArray(previous) ? previous[index] : undefined, key, inherited)).filter(entry => entry !== undefined)
    if (nativeObject(value)) return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, walk(entry, nativeObject(previous) ? previous[name] : undefined, name, inherited || /^(?:headers|environment|env|credentials)$/i.test(name))]).filter(([, entry]) => entry !== undefined))
    return value
  }
  try { const parsed: unknown = JSON.parse(text), cleared = walk(parsed, saved); return JSON.stringify(parsed) === JSON.stringify(cleared) ? text : JSON.stringify(cleared, null, 2) }
  catch { return /api.?key|secret|password|credential|authorization|cookie|token|https?:\/\/[^\s"]*[?@]/i.test(text) ? JSON.stringify(saved ?? {}, null, 2) : text }
}

export function nativeLabel(value: LocalizedText | undefined, locale: string, fallback: string): string {
  return typeof value === 'string' ? value : value?.[locale] ?? value?.[locale.split('-')[0]!] ?? value?.en ?? fallback
}
