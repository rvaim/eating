import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { NATIVE_FEATURES, defaultNativeCapabilities } from '../native-capabilities'
import type { NativeCapabilitiesConfiguration, NativeFeatureSelection, NativeToolGrant } from '../native-capabilities'
import { readRestrictedJson, writeRestrictedJson } from './config'

const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)
function fail(): never { throw new PlatformError('INVALID_NATIVE_CAPABILITIES', '原生能力配置无效，请读取当前目录后重新核对。', 400, 'not-sent') }
const exact = (value: JsonObject, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function agentTypes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 101 || input.some(value => !text(value)) || new Set(input).size !== input.length) fail()
  return [...input] as string[]
}
export function parseNativeCapabilities(input: unknown): NativeCapabilitiesConfiguration {
  if (!isJsonObject(input) || !exact(input, ['schemaVersion', 'revision', 'features', 'toolGrants']) || input.schemaVersion !== 1 || !revision(input.revision)
    || !Array.isArray(input.features) || input.features.length !== NATIVE_FEATURES.length || !Array.isArray(input.toolGrants) || input.toolGrants.length > 512 || Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) fail()
  const seen = new Set<string>()
  const features: NativeFeatureSelection[] = input.features.map(value => {
    if (!isJsonObject(value) || !exact(value, ['id', 'enabled', 'agentTypeIds', 'config']) || !text(value.id) || typeof value.enabled !== 'boolean' || !isJsonObject(value.config) || seen.has(value.id)) fail()
    const definition = NATIVE_FEATURES.find(entry => entry.id === value.id)
    const modules = definition ? [...(definition.services ?? []), ...definition.modules] : []
    if (!definition || Object.keys(value.config).length !== modules.length || modules.some(module => !isJsonObject((value.config as JsonObject)[module.id]))) fail()
    seen.add(value.id)
    return { id: value.id, enabled: value.enabled, agentTypeIds: agentTypes(value.agentTypeIds), config: structuredClone(value.config) }
  })
  seen.clear()
  const toolGrants: NativeToolGrant[] = input.toolGrants.map(value => {
    if (!isJsonObject(value) || !exact(value, ['name', 'fingerprint', 'agentTypeIds']) || !text(value.name) || !/^[A-Za-z0-9_-]+$/.test(value.name) || /^(?:eating_|mcp__)/.test(value.name) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) || seen.has(value.name)) fail()
    seen.add(value.name)
    return { name: value.name, fingerprint: value.fingerprint, agentTypeIds: agentTypes(value.agentTypeIds) }
  })
  return { schemaVersion: 1, revision: input.revision, features, toolGrants }
}

const STORED_SECRET = '<stored-secret>'
function privateValue(key: string, value: JsonValue): boolean {
  if (typeof value !== 'string') return false
  if (!/Env$/.test(key) && /api.?key|secret|password|credential|authorization|cookie|token|headers|environment/i.test(key)) return true
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.username || url.password || url.search) } catch { return false }
}
function publicConfig(value: JsonValue, key = '', hidden = false): JsonValue {
  if (typeof value === 'string' && (hidden || privateValue(key, value))) return STORED_SECRET
  if (Array.isArray(value)) return value.map(entry => publicConfig(entry, key, hidden))
  if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, publicConfig(entry, name, hidden || /^(?:headers|environment|env|credentials)$/i.test(name))]))
  return value
}
function restoreConfig(next: JsonValue, previous: JsonValue | undefined): JsonValue {
  if (next === STORED_SECRET) { if (previous === undefined || typeof previous !== 'string') fail(); return previous }
  if (Array.isArray(next)) return next.map((entry, index) => restoreConfig(entry, Array.isArray(previous) ? previous[index] : undefined))
  if (isJsonObject(next)) return Object.fromEntries(Object.entries(next).map(([name, entry]) => [name, restoreConfig(entry, isJsonObject(previous) ? previous[name] : undefined)]))
  return next
}
export function publicNativeConfiguration(configuration: NativeCapabilitiesConfiguration): JsonObject {
  return { ...configuration, features: configuration.features.map(feature => ({ ...feature, config: publicConfig(feature.config) })), toolGrants: configuration.toolGrants.map(grant => ({ ...grant, agentTypeIds: [...grant.agentTypeIds] })) } as unknown as JsonObject
}

export class DshNativeConfigurationFile {
  readonly filePath: string
  constructor(directory: string, private readonly agentTypeIds: () => readonly string[]) { this.filePath = join(directory, 'native-capabilities.json') }
  read(): NativeCapabilitiesConfiguration {
    try { if (statSync(this.filePath).size > 256 * 1024) throw new Error('size') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PlatformError('NATIVE_CAPABILITIES_CORRUPTED', '原生能力文件过大或无法读取，未覆盖原文件。', 500) }
    const value = readRestrictedJson(this.filePath)
    if (value === null) return defaultNativeCapabilities(this.agentTypeIds())
    try { return parseNativeCapabilities(value) }
    catch { throw new PlatformError('NATIVE_CAPABILITIES_CORRUPTED', '原生能力文件格式损坏或版本不支持，未覆盖原文件。', 500) }
  }
  prepare(input: unknown): NativeCapabilitiesConfiguration {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'features', 'toolGrants']) || !revision(input.expectedRevision)) fail()
    const current = this.read()
    if (current.revision !== input.expectedRevision) throw new PlatformError('NATIVE_CAPABILITIES_CONFLICT', '原生能力已被其他页面修改，请重新读取后再保存。', 409, 'not-sent')
    const parsed = parseNativeCapabilities({ schemaVersion: 1, revision: current.revision, features: input.features, toolGrants: input.toolGrants })
    const next: NativeCapabilitiesConfiguration = { ...parsed, features: parsed.features.map(feature => ({ ...feature, config: restoreConfig(feature.config, current.features.find(previous => previous.id === feature.id)?.config) as JsonObject })) }
    const allowed = new Set(['main', ...this.agentTypeIds()])
    if (next.features.some(feature => feature.agentTypeIds.some(id => !allowed.has(id))) || next.toolGrants.some(grant => grant.agentTypeIds.some(id => !allowed.has(id)))) fail()
    if (next.features.some(feature => feature.enabled && feature.agentTypeIds.length === 0)) throw new PlatformError('NATIVE_SCOPE_REQUIRED', '启用原生能力时至少选择一种代理。', 400, 'not-sent')
    if (JSON.stringify(current) === JSON.stringify(next)) return current
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new PlatformError('NATIVE_CAPABILITIES_EXHAUSTED', '原生能力配置版本已达到上限，未保存。', 409, 'not-sent')
    return { ...next, revision: current.revision + 1 }
  }
  commit(next: NativeCapabilitiesConfiguration, expectedRevision: number): NativeCapabilitiesConfiguration {
    if (this.read().revision !== expectedRevision) throw new PlatformError('NATIVE_CAPABILITIES_CONFLICT', '原生能力已被修改，请重新读取后再保存。', 409, 'not-sent')
    writeRestrictedJson(this.filePath, next as unknown as JsonObject)
    return next
  }
}
