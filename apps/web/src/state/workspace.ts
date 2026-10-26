import {
  PluginRegistry,
  PluginRegistrationError,
  readPreferences,
  validateManifest,
  writePreferences,
} from '@eating/plugin-core'
import type {
  ActivityEntry,
  PluginConfiguration,
  SavedConfiguration,
  StoragePort,
  WorkspacePreferences,
} from '@eating/plugin-core'
import type { CommunicationPlugin, WorkspaceActionResult } from '../plugins/contract'

export interface WorkspaceSnapshot {
  readonly plugins: readonly CommunicationPlugin[]
  readonly configurations: Readonly<Record<string, SavedConfiguration>>
  readonly activity: readonly ActivityEntry[]
  readonly storageError: string | null
  readonly unavailableIds: readonly string[]
}

type ActivityKind = 'register' | 'remove' | 'save'

function freezeConfigurations(
  configurations: Readonly<Record<string, SavedConfiguration>>,
): Readonly<Record<string, SavedConfiguration>> {
  return Object.freeze(Object.fromEntries(Object.entries(configurations).map(([id, saved]) => [
    id,
    Object.freeze({ savedAt: saved.savedAt, values: Object.freeze({ ...saved.values }) }),
  ])))
}

/** Local example directory and preferences; it never loads executable plugins. */
export class PlatformWorkspace {
  readonly catalog: readonly CommunicationPlugin[]
  private readonly registry = new PluginRegistry<CommunicationPlugin>()
  private readonly listeners = new Set<() => void>()
  private readonly unavailableRegisteredIds: readonly string[]
  private snapshot: WorkspaceSnapshot
  private activitySequence = 0

  constructor(catalog: readonly CommunicationPlugin[], private readonly storage: StoragePort) {
    const catalogIds = new Set<string>()
    this.catalog = Object.freeze(catalog.map(plugin => {
      validateManifest(plugin)
      if (catalogIds.has(plugin.id)) {
        throw new PluginRegistrationError('duplicate-id', `${plugin.name} 的目录 ID 重复。`)
      }
      catalogIds.add(plugin.id)
      return Object.freeze({ ...plugin, initialValues: Object.freeze({ ...plugin.initialValues }) })
    }).sort((left, right) => left.order - right.order))

    const loaded = readPreferences(storage)
    const preferences = loaded.ok ? loaded.value : null
    const registeredIds = new Set(preferences?.registeredIds ??
      this.catalog.filter(plugin => plugin.defaultRegistered).map(plugin => plugin.id))
    for (const plugin of this.catalog) {
      if (registeredIds.has(plugin.id)) this.registry.register(plugin)
    }
    this.unavailableRegisteredIds = Object.freeze(
      [...registeredIds].filter(id => !catalogIds.has(id)),
    )
    const configurations = freezeConfigurations(preferences?.configurations ?? {})
    this.snapshot = Object.freeze({
      plugins: this.registeredPlugins(),
      configurations,
      activity: Object.freeze((preferences?.activity ?? []).map(entry => Object.freeze({ ...entry }))),
      storageError: loaded.ok ? null : loaded.error,
      unavailableIds: Object.freeze([...new Set([
        ...this.unavailableRegisteredIds,
        ...Object.keys(configurations).filter(id => !catalogIds.has(id)),
      ])]),
    })
  }

  readonly getSnapshot = (): WorkspaceSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  register(id: string): WorkspaceActionResult {
    const blocked = this.writeBlocked()
    if (blocked) return blocked
    const plugin = this.catalog.find(entry => entry.id === id)
    if (!plugin) return { ok: false, error: '未找到此本地示例插件，无法注册。' }
    if (this.registry.get(id)) return { ok: false, error: `${plugin.name} 已注册，无需重复添加。` }
    const plugins = this.catalog.filter(entry => entry.id === id || this.registry.get(entry.id))
    return this.commit(plugins, this.snapshot.configurations, plugin, 'register', () => {
      this.registry.register(plugin)
    })
  }

  remove(id: string): WorkspaceActionResult {
    const blocked = this.writeBlocked()
    if (blocked) return blocked
    const plugin = this.registry.get(id)
    if (!plugin) return { ok: false, error: '此插件未注册，无法移除。' }
    const plugins = this.snapshot.plugins.filter(entry => entry.id !== id)
    return this.commit(plugins, this.snapshot.configurations, plugin, 'remove', () => {
      this.registry.unregister(id)
    })
  }

  save(id: string, values: PluginConfiguration): WorkspaceActionResult {
    const blocked = this.writeBlocked()
    if (blocked) return blocked
    const plugin = this.registry.get(id)
    if (!plugin) return { ok: false, error: '此插件当前未注册，无法保存配置。请先注册后重试。' }
    const candidate = Object.freeze({ ...values })
    if (Object.keys(candidate).length > 30 || Object.entries(candidate).some(([key, value]) =>
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !(typeof value === 'boolean' || typeof value === 'string' && value.length <= 2048),
    )) return { ok: false, error: '配置格式不受支持，请检查字段内容与长度。' }
    try {
      const validation = plugin.validate(candidate)
      if (!validation.valid) {
        return { ok: false, error: Object.values(validation.errors).filter(Boolean).join('；') ||
          '配置未通过本地校验，请检查输入。' }
      }
    } catch {
      return { ok: false, error: '插件本地校验失败，配置未保存。请检查输入后重试。' }
    }
    const configurations = Object.freeze({
      ...this.snapshot.configurations,
      [id]: Object.freeze({ values: candidate, savedAt: new Date().toISOString() }),
    })
    return this.commit(this.snapshot.plugins, configurations, plugin, 'save', () => {})
  }

  private registeredPlugins(): readonly CommunicationPlugin[] {
    return Object.freeze(this.catalog.filter(plugin => this.registry.get(plugin.id)))
  }

  private writeBlocked(): WorkspaceActionResult | null {
    return this.snapshot.storageError
      ? { ok: false, error: `${this.snapshot.storageError} 请修复存储记录或权限后重新加载工作区。` }
      : null
  }

  private commit(
    plugins: readonly CommunicationPlugin[],
    configurations: Readonly<Record<string, SavedConfiguration>>,
    plugin: CommunicationPlugin,
    kind: ActivityKind,
    applyRegistration: () => void,
  ): WorkspaceActionResult {
    const at = new Date().toISOString()
    let suffix = this.activitySequence + 1
    const baseId = `${plugin.id}:${at}`
    while (this.snapshot.activity.some(entry => entry.id === `${baseId}:${suffix}`)) suffix += 1
    const verb: Record<ActivityKind, string> = { register: '注册', remove: '移除', save: '保存配置' }
    const entry: ActivityEntry = Object.freeze({
      id: `${baseId}:${suffix}`, pluginId: plugin.id, label: `${verb[kind]} · ${plugin.name}`, at,
    })
    const activity = Object.freeze([entry, ...this.snapshot.activity].slice(0, 20))
    const registeredIds = [...plugins.map(current => current.id), ...this.unavailableRegisteredIds]
    if (registeredIds.length > 50 || Object.keys(configurations).length > 50) {
      return { ok: false, error: '本地示例工作区容量已满，配置未更改。' }
    }
    const preferences: WorkspacePreferences = {
      schemaVersion: 1, registeredIds, configurations, activity,
    }
    const written = writePreferences(this.storage, preferences)
    if (!written.ok) return written

    applyRegistration()
    this.activitySequence = suffix
    this.snapshot = Object.freeze({
      ...this.snapshot, plugins: this.registeredPlugins(), configurations, activity,
    })
    for (const listener of [...this.listeners]) listener()
    return { ok: true }
  }
}
