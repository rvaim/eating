import { describe, expect, it, vi } from 'vitest'
import { Bot } from 'lucide-react'
import { PREFERENCES_KEY, PluginRegistrationError, readPreferences } from '@eating/plugin-core'
import type {
  PluginConfiguration,
  StoragePort,
  WorkspacePreferences,
} from '@eating/plugin-core'
import type { CommunicationPlugin, ConfigurationValidation } from '../plugins/contract'
import { PlatformWorkspace } from './workspace'

class MemoryStorage implements StoragePort {
  raw: string | null
  readError = false
  writeError = false
  writeAttempts = 0
  onWrite: (() => void) | undefined

  constructor(raw: string | null = null) { this.raw = raw }

  getItem(key: string): string | null {
    if (this.readError) throw new Error('storage denied')
    return key === PREFERENCES_KEY ? this.raw : null
  }

  setItem(key: string, value: string): void {
    this.writeAttempts += 1
    if (this.writeError) throw new Error('quota exceeded')
    if (key !== PREFERENCES_KEY) throw new Error('unexpected storage key')
    this.raw = value
    this.onWrite?.()
  }
}

function values(displayName: string): PluginConfiguration {
  return { displayName, endpoint: 'ws://127.0.0.1:3001', enabled: true }
}

function plugin(id: string, order: number, defaultRegistered = true): CommunicationPlugin {
  return {
    id, order, defaultRegistered, name: `${id} 示例插件`, description: '只用于本地配置验证。',
    version: '0.1.0', apiVersion: 1, kind: 'communication', icon: Bot, brandColor: '#276e55',
    initialValues: values('本地示例'), Panel: () => null,
    validate: (configuration): ConfigurationValidation => typeof configuration.displayName === 'string' &&
      configuration.displayName.trim().length > 0
      ? { valid: true, errors: {} }
      : { valid: false, errors: { displayName: '请填写显示名称。' } },
    summary: configuration => String(configuration.displayName),
  }
}

const qq = plugin('qq.local', 10)
const feishu = plugin('feishu.local', 20, false)
const catalog = [feishu, qq]
const savedAt = '2026-10-26T12:00:00.000Z'

function preferences(overrides: Partial<WorkspacePreferences> = {}): WorkspacePreferences {
  return { schemaVersion: 1, registeredIds: ['qq.local'], configurations: {}, activity: [], ...overrides }
}

function persisted(storage: MemoryStorage): WorkspacePreferences {
  const loaded = readPreferences(storage)
  if (!loaded.ok || !loaded.value) throw new Error('expected valid persisted preferences')
  return loaded.value
}

function ids(workspace: PlatformWorkspace): readonly string[] {
  return workspace.getSnapshot().plugins.map(entry => entry.id)
}

describe('PlatformWorkspace', () => {
  it('uses only default registrations without writing or inventing initial activity', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    expect(ids(workspace)).toEqual(['qq.local'])
    expect(workspace.catalog.map(entry => entry.id)).toEqual(['qq.local', 'feishu.local'])
    expect(workspace.getSnapshot()).toMatchObject({
      configurations: {}, activity: [], storageError: null, unavailableIds: [],
    })
    expect(storage.raw).toBeNull()
    expect(storage.writeAttempts).toBe(0)
  })

  it('registers and removes each plugin independently in catalog order', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    expect(workspace.register('feishu.local')).toEqual({ ok: true })
    expect(ids(workspace)).toEqual(['qq.local', 'feishu.local'])
    expect(workspace.remove('qq.local')).toEqual({ ok: true })
    expect(ids(workspace)).toEqual(['feishu.local'])
    expect(persisted(storage).registeredIds).toEqual(['feishu.local'])
    expect(workspace.getSnapshot().activity.map(entry => entry.pluginId))
      .toEqual(['qq.local', 'feishu.local'])
    const restored = new PlatformWorkspace(catalog, storage)
    expect(ids(restored)).toEqual(['feishu.local'])
    expect(restored.getSnapshot().activity).toEqual(workspace.getSnapshot().activity)
  })

  it('keeps plugin configurations isolated across removal, reload and registration', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    workspace.register('feishu.local')
    expect(workspace.save('qq.local', values('我的 QQ'))).toEqual({ ok: true })
    expect(workspace.save('feishu.local', values('我的飞书'))).toEqual({ ok: true })
    const saved = workspace.getSnapshot().configurations
    expect(saved['qq.local']?.values).toEqual(values('我的 QQ'))
    expect(saved['feishu.local']?.values).toEqual(values('我的飞书'))
    workspace.remove('qq.local')
    expect(workspace.getSnapshot().configurations).toBe(saved)
    expect(persisted(storage).configurations).toEqual(saved)
    const restored = new PlatformWorkspace(catalog, storage)
    expect(ids(restored)).toEqual(['feishu.local'])
    expect(restored.register('qq.local')).toEqual({ ok: true })
    expect(restored.getSnapshot().configurations).toEqual(saved)
    expect(ids(restored)).toEqual(['qq.local', 'feishu.local'])
    restored.save('qq.local', values('修改后的 QQ'))
    expect(restored.getSnapshot().configurations['feishu.local']).toEqual(saved['feishu.local'])
  })

  it('rejects a stale save after removal without reviving the plugin or changing saved data', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    workspace.save('qq.local', values('原配置'))
    const staleSave = () => workspace.save('qq.local', values('迟到的配置'))
    workspace.remove('qq.local')
    const before = workspace.getSnapshot()
    const raw = storage.raw
    const attempts = storage.writeAttempts
    expect(staleSave()).toMatchObject({ ok: false })
    expect(workspace.getSnapshot()).toBe(before)
    expect(ids(workspace)).toEqual([])
    expect(storage.raw).toBe(raw)
    expect(storage.writeAttempts).toBe(attempts)
    expect(before.configurations['qq.local']?.values).toEqual(values('原配置'))
  })

  it('rejects duplicate registrations, unknown IDs and operations on an unregistered plugin', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    const before = workspace.getSnapshot()
    const listener = vi.fn()
    workspace.subscribe(listener)
    expect(workspace.register('qq.local')).toMatchObject({ ok: false })
    expect(workspace.register('missing.local')).toMatchObject({ ok: false })
    expect(workspace.remove('missing.local')).toMatchObject({ ok: false })
    expect(workspace.remove('feishu.local')).toMatchObject({ ok: false })
    expect(workspace.save('feishu.local', values('未注册'))).toMatchObject({ ok: false })
    expect(workspace.save('missing.local', values('未知'))).toMatchObject({ ok: false })
    expect(workspace.getSnapshot()).toBe(before)
    expect(storage.writeAttempts).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('validates with the owning plugin and leaves rejected configuration out of storage', () => {
    const validate = vi.fn(qq.validate)
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace([{ ...qq, validate }, feishu], storage)
    const before = workspace.getSnapshot()
    const invalid = values('  ')
    expect(workspace.save('qq.local', invalid)).toEqual({ ok: false, error: '请填写显示名称。' })
    expect(validate).toHaveBeenCalledExactlyOnceWith(invalid)
    expect(workspace.getSnapshot()).toBe(before)
    expect(storage.writeAttempts).toBe(0)
    expect(workspace.save('qq.local', values('有效配置'))).toEqual({ ok: true })
    expect(validate).toHaveBeenCalledTimes(2)
    expect(persisted(storage).configurations['qq.local']?.values).toEqual(values('有效配置'))
  })

  it('reports a thrown plugin validation error without committing anything', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace([
      { ...qq, validate: () => { throw new Error('validator failed') } },
    ], storage)
    const before = workspace.getSnapshot()
    expect(workspace.save('qq.local', values('示例'))).toMatchObject({ ok: false })
    expect(workspace.getSnapshot()).toBe(before)
    expect(storage.writeAttempts).toBe(0)
  })

  it('rejects values that could produce an unreadable persisted configuration', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    const before = workspace.getSnapshot()
    expect(workspace.save('qq.local', values('x'.repeat(2049)))).toMatchObject({ ok: false })
    expect(workspace.save('qq.local', { ...values('示例'), constructor: 'reserved' }))
      .toMatchObject({ ok: false })
    expect(workspace.getSnapshot()).toBe(before)
    expect(storage.writeAttempts).toBe(0)
  })

  it.each([
    ['malformed JSON', '{'],
    ['unsupported schema', JSON.stringify({ ...preferences(), schemaVersion: 2 })],
    ['invalid configuration', JSON.stringify(preferences({
      configurations: { 'qq.local': { values: { displayName: '示例' }, savedAt: 'invalid-date' } },
    }))],
  ])('keeps %s untouched and offers defaults for browsing only', (_name, raw) => {
    const storage = new MemoryStorage(raw)
    const workspace = new PlatformWorkspace(catalog, storage)
    const before = workspace.getSnapshot()
    expect(ids(workspace)).toEqual(['qq.local'])
    expect(before.storageError).toEqual(expect.any(String))
    expect(before.activity).toEqual([])
    expect(workspace.register('feishu.local')).toMatchObject({ ok: false })
    expect(workspace.remove('qq.local')).toMatchObject({ ok: false })
    expect(workspace.save('qq.local', values('禁止覆盖'))).toMatchObject({ ok: false })
    expect(workspace.getSnapshot()).toBe(before)
    expect(storage.raw).toBe(raw)
    expect(storage.writeAttempts).toBe(0)
  })

  it('blocks writes after a read failure until a new workspace can load the repaired storage', () => {
    const raw = JSON.stringify(preferences({ registeredIds: ['feishu.local'] }))
    const storage = new MemoryStorage(raw)
    storage.readError = true
    const workspace = new PlatformWorkspace(catalog, storage)
    const before = workspace.getSnapshot()
    expect(before.storageError).toEqual(expect.any(String))
    expect(workspace.remove('qq.local')).toMatchObject({ ok: false })
    storage.readError = false
    expect(workspace.register('feishu.local')).toMatchObject({ ok: false })
    expect(workspace.getSnapshot()).toBe(before)
    expect(storage.raw).toBe(raw)
    expect(storage.writeAttempts).toBe(0)
    const recovered = new PlatformWorkspace(catalog, storage)
    expect(recovered.getSnapshot().storageError).toBeNull()
    expect(ids(recovered)).toEqual(['feishu.local'])
    expect(recovered.register('qq.local')).toEqual({ ok: true })
  })

  it.each(['register', 'remove', 'save'] as const)(
    'does not publish a failed %s and allows a successful retry', action => {
      const storage = new MemoryStorage(JSON.stringify(preferences()))
      const workspace = new PlatformWorkspace(catalog, storage)
      const listener = vi.fn()
      workspace.subscribe(listener)
      const before = workspace.getSnapshot()
      const raw = storage.raw
      const act = () => action === 'register' ? workspace.register('feishu.local')
        : action === 'remove' ? workspace.remove('qq.local') : workspace.save('qq.local', values('重试配置'))
      storage.writeError = true
      expect(act()).toMatchObject({ ok: false, error: expect.any(String) })
      expect(workspace.getSnapshot()).toBe(before)
      expect(storage.raw).toBe(raw)
      expect(listener).not.toHaveBeenCalled()
      storage.writeError = false
      expect(act()).toEqual({ ok: true })
      expect(workspace.getSnapshot()).not.toBe(before)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(workspace.getSnapshot().activity).toHaveLength(1)
      expect(persisted(storage).activity).toEqual(workspace.getSnapshot().activity)
    },
  )

  it('retains unavailable plugin IDs and configurations without activating them', () => {
    const unknown = { values: values('保留的插件配置'), savedAt }
    const orphan = { values: values('仅有配置的插件'), savedAt }
    const storage = new MemoryStorage(JSON.stringify(preferences({
      registeredIds: ['qq.local', 'unavailable.local', 'qq.local'],
      configurations: { 'unavailable.local': unknown, 'orphan.local': orphan },
    })))
    const workspace = new PlatformWorkspace(catalog, storage)
    expect(ids(workspace)).toEqual(['qq.local'])
    expect(workspace.getSnapshot().unavailableIds).toEqual(['unavailable.local', 'orphan.local'])
    expect(workspace.register('unavailable.local')).toMatchObject({ ok: false })
    workspace.register('feishu.local')
    workspace.save('qq.local', values('QQ 配置'))
    workspace.remove('qq.local')
    const saved = persisted(storage)
    expect(saved.registeredIds).toEqual(['feishu.local', 'unavailable.local'])
    expect(saved.configurations['unavailable.local']).toEqual(unknown)
    expect(saved.configurations['orphan.local']).toEqual(orphan)
    expect(new PlatformWorkspace(catalog, storage).getSnapshot().unavailableIds)
      .toEqual(['unavailable.local', 'orphan.local'])
  })

  it('honors a stored empty registration list instead of restoring defaults', () => {
    const storage = new MemoryStorage(JSON.stringify(preferences({ registeredIds: [] })))
    const workspace = new PlatformWorkspace(catalog, storage)
    expect(ids(workspace)).toEqual([])
    expect(workspace.getSnapshot().activity).toEqual([])
    expect(storage.writeAttempts).toBe(0)
  })

  it('preserves catalog order for equal priorities even after re-registering', () => {
    const localCatalog = [plugin('first.local', 10), plugin('second.local', 10)]
    const workspace = new PlatformWorkspace(localCatalog, new MemoryStorage())
    workspace.remove('first.local')
    workspace.register('first.local')
    expect(ids(workspace)).toEqual(['first.local', 'second.local'])
  })

  it('publishes only after persistence and keeps snapshots stable between successful actions', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    const { getSnapshot, subscribe } = workspace
    const before = getSnapshot()
    expect(getSnapshot()).toBe(before)
    const listener = vi.fn(() => {
      expect(persisted(storage).registeredIds).toEqual(ids(workspace))
      expect(getSnapshot()).not.toBe(before)
    })
    const unsubscribe = subscribe(listener)
    storage.onWrite = () => {
      expect(getSnapshot()).toBe(before)
      expect(listener).not.toHaveBeenCalled()
    }
    workspace.register('feishu.local')
    expect(listener).toHaveBeenCalledTimes(1)
    const after = getSnapshot()
    expect(getSnapshot()).toBe(after)
    storage.onWrite = undefined
    unsubscribe()
    unsubscribe()
    workspace.remove('qq.local')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('cleans up only the subscription being removed', () => {
    const workspace = new PlatformWorkspace(catalog, new MemoryStorage())
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = workspace.subscribe(first)
    workspace.subscribe(second)
    unsubscribe()
    workspace.register('feishu.local')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('copies input values and freezes all published state containers', () => {
    const workspace = new PlatformWorkspace(catalog, new MemoryStorage())
    const input = { displayName: '保存时的名称', enabled: true }
    workspace.save('qq.local', input)
    input.displayName = '外部后来修改'
    const snapshot = workspace.getSnapshot()
    expect(snapshot.configurations['qq.local']?.values.displayName).toBe('保存时的名称')
    for (const value of [snapshot, snapshot.plugins, snapshot.plugins[0], snapshot.configurations,
      snapshot.configurations['qq.local'], snapshot.configurations['qq.local']?.values,
      snapshot.activity, snapshot.activity[0], snapshot.unavailableIds, workspace.catalog]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it('keeps only the latest 20 successful manual actions with distinct IDs', () => {
    const storage = new MemoryStorage()
    const workspace = new PlatformWorkspace(catalog, storage)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(savedAt))
      const entries = []
      for (let index = 0; index < 23; index += 1) {
        expect(workspace.save('qq.local', values(`配置 ${index}`))).toEqual({ ok: true })
        entries.push(workspace.getSnapshot().activity[0])
      }
      const activity = workspace.getSnapshot().activity
      expect(activity).toHaveLength(20)
      expect(new Set(entries.map(entry => entry?.id)).size).toBe(23)
      expect(activity).toEqual(entries.slice(-20).reverse())
      expect(persisted(storage).activity).toEqual(activity)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects duplicate catalog IDs before reading or writing storage', () => {
    const storage = new MemoryStorage()
    const read = vi.spyOn(storage, 'getItem')
    expect(() => new PlatformWorkspace([qq, { ...qq }], storage)).toThrow(PluginRegistrationError)
    expect(read).not.toHaveBeenCalled()
    expect(storage.writeAttempts).toBe(0)
  })
})
