export type ConfigurationValue = string | boolean
export type PluginConfiguration = Readonly<Record<string, ConfigurationValue>>

export interface SavedConfiguration {
  readonly values: PluginConfiguration
  readonly savedAt: string
}

export interface ActivityEntry {
  readonly id: string
  readonly pluginId: string
  readonly label: string
  readonly at: string
}

export interface WorkspacePreferences {
  readonly schemaVersion: 1
  readonly registeredIds: readonly string[]
  readonly configurations: Readonly<Record<string, SavedConfiguration>>
  readonly activity: readonly ActivityEntry[]
}

export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type StorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export const PREFERENCES_KEY = 'Eating.prototype.workspace.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeConfiguration(value: unknown): value is PluginConfiguration {
  if (!isRecord(value) || Object.keys(value).length > 30) return false
  return Object.entries(value).every(([key, entry]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) &&
    (typeof entry === 'boolean' || typeof entry === 'string' && entry.length <= 2048),
  )
}

function isSavedConfiguration(value: unknown): value is SavedConfiguration {
  return isRecord(value) && isSafeConfiguration(value.values) &&
    typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt))
}

function isConfigurationMap(value: unknown): value is Record<string, SavedConfiguration> {
  return isRecord(value) && Object.keys(value).length <= 50 &&
    Object.entries(value).every(([key, entry]) =>
      !['__proto__', 'constructor', 'prototype'].includes(key) && isSavedConfiguration(entry),
    )
}

function isActivity(value: unknown): value is ActivityEntry {
  return isRecord(value) && typeof value.id === 'string' && typeof value.pluginId === 'string' &&
    typeof value.label === 'string' && value.label.length < 200 &&
    typeof value.at === 'string' && Number.isFinite(Date.parse(value.at))
}

export function readPreferences(storage: StoragePort): StorageResult<WorkspacePreferences | null> {
  try {
    const raw = storage.getItem(PREFERENCES_KEY)
    if (raw === null) return { ok: true, value: null }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: '本地配置格式不兼容。当前使用默认工作区，不会覆盖原记录。' }
    }
    if (
      !isRecord(parsed) || parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.registeredIds) || parsed.registeredIds.length > 50 ||
      !parsed.registeredIds.every((id): id is string => typeof id === 'string' && id.length <= 80) ||
      !isConfigurationMap(parsed.configurations) ||
      !Array.isArray(parsed.activity) || parsed.activity.length > 20 || !parsed.activity.every(isActivity)
    ) return { ok: false, error: '本地配置格式不兼容。当前使用默认工作区，不会覆盖原记录。' }
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        registeredIds: [...new Set(parsed.registeredIds)],
        configurations: parsed.configurations,
        activity: parsed.activity,
      },
    }
  } catch {
    return { ok: false, error: '无法读取本地配置。请检查浏览器存储权限，原记录不会被覆盖。' }
  }
}

export function writePreferences(storage: StoragePort, preferences: WorkspacePreferences): StorageResult<void> {
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
    return { ok: true, value: undefined }
  } catch {
    return { ok: false, error: '配置未保存：浏览器存储不可用或空间不足。请释放空间后重试。' }
  }
}
