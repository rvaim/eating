import { describe, expect, it, vi } from 'vitest'
import { PREFERENCES_KEY, readPreferences, writePreferences } from './index'
import type { WorkspacePreferences } from './index'

const savedAt = '2026-10-26T13:00:00.000Z'

function preferences(): WorkspacePreferences {
  return {
    schemaVersion: 1,
    registeredIds: ['example.qq', 'example.feishu'],
    configurations: {
      'example.qq': {
        values: { displayName: 'Eating 的 QQ', endpoint: 'ws://127.0.0.1:3001', enabled: false },
        savedAt,
      },
      'example.feishu': {
        values: { displayName: '飞书本地示例', enabled: true },
        savedAt,
      },
    },
    activity: [{ id: 'saved-qq', pluginId: 'example.qq', label: '保存 QQ 本地配置', at: savedAt }],
  }
}

function memoryStorage(raw: string | null = null) {
  const records = new Map<string, string>()
  if (raw !== null) records.set(PREFERENCES_KEY, raw)
  const storage = {
    getItem: vi.fn((key: string) => records.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { records.set(key, value) }),
  }
  return { storage, records }
}

describe('workspace preferences', () => {
  it('序列化保存并重新读取多个插件的独立配置、布尔值与活动记录', () => {
    const { storage, records } = memoryStorage()
    const original = preferences()

    expect(writePreferences(storage, original)).toEqual({ ok: true, value: undefined })
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledWith(PREFERENCES_KEY, expect.any(String))
    expect(JSON.parse(records.get(PREFERENCES_KEY)!)).toEqual(original)
    expect(readPreferences(storage)).toEqual({ ok: true, value: original })
    expect(storage.getItem).toHaveBeenCalledWith(PREFERENCES_KEY)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('没有保存记录时返回空工作区信号，读取不写入默认数据', () => {
    const { storage, records } = memoryStorage()

    expect(readPreferences(storage)).toEqual({ ok: true, value: null })
    expect(storage.getItem).toHaveBeenCalledWith(PREFERENCES_KEY)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })

  it('可重新读取所有插件均已移除的空记录', () => {
    const empty: WorkspacePreferences = { schemaVersion: 1, registeredIds: [], configurations: {}, activity: [] }
    const { storage } = memoryStorage(JSON.stringify(empty))

    expect(readPreferences(storage)).toEqual({ ok: true, value: empty })
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('读取重复注册标识时仅保留首次出现的顺序，且不改写原始存储', () => {
    const original = preferences()
    const raw = JSON.stringify({ ...original, registeredIds: ['example.qq', 'example.feishu', 'example.qq'] })
    const { storage, records } = memoryStorage(raw)

    expect(readPreferences(storage)).toEqual({ ok: true, value: original })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
  })

  it('未注册插件的已保存配置仍可读取，便于移除后重新注册', () => {
    const retained = { ...preferences(), registeredIds: ['example.feishu'] }
    const { storage } = memoryStorage(JSON.stringify(retained))

    expect(readPreferences(storage)).toEqual({ ok: true, value: retained })
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['空字符串', ''],
    ['截断的 JSON', '{"schemaVersion":1'],
    ['null 数据', 'null'],
    ['数组数据', '[]'],
    ['缺少结构的数据', '{}'],
  ])('拒绝损坏数据：%s，并保留原始记录', (_, raw) => {
    const { storage, records } = memoryStorage(raw)

    expect(readPreferences(storage)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
  })

  it('拒绝未来版本的数据，不用当前结构覆盖未来版本记录', () => {
    const raw = JSON.stringify({ ...preferences(), schemaVersion: 2, futureSetting: '保留' })
    const { storage, records } = memoryStorage(raw)

    expect(readPreferences(storage)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
  })

  it.each([
    ['注册标识不是字符串', { registeredIds: [42] }],
    ['配置集合是数组', { configurations: [] }],
    ['单个配置缺少保存时间', { configurations: { 'example.qq': { values: { displayName: 'QQ' } } } }],
    ['配置保存时间无效', { configurations: { 'example.qq': { values: {}, savedAt: 'not-a-date' } } }],
    ['配置值包含嵌套对象', { configurations: { 'example.qq': { values: { nested: {} }, savedAt } } }],
    ['配置值包含数字', { configurations: { 'example.qq': { values: { port: 3001 }, savedAt } } }],
    ['配置值不是映射', { configurations: { 'example.qq': { values: [], savedAt } } }],
    ['活动记录缺少平台', { activity: [{ id: 'entry', label: '示例', at: savedAt }] }],
    ['活动记录时间无效', { activity: [{ id: 'entry', pluginId: 'example.qq', label: '示例', at: 'invalid' }] }],
  ])('拒绝不完整或不受支持的记录：%s，且不覆盖原始配置', (_, overrides) => {
    const raw = JSON.stringify({ ...preferences(), ...overrides })
    const { storage, records } = memoryStorage(raw)

    expect(readPreferences(storage)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
  })

  it.each(['__proto__', 'constructor', 'prototype'])('拒绝配置中的危险字段 %s，且不保存替代值', key => {
    const raw = JSON.stringify({
      ...preferences(),
      configurations: { 'example.qq': { values: { [key]: '不允许的字段' }, savedAt } },
    })
    const { storage, records } = memoryStorage(raw)

    expect(readPreferences(storage)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
  })

  it('存储读取抛错时明确失败，不写入默认数据或返回伪造的成功配置', () => {
    const { storage } = memoryStorage(JSON.stringify(preferences()))
    storage.getItem.mockImplementation(() => { throw new Error('Storage access denied') })

    expect(readPreferences(storage)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.getItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('存储写入失败时明确未保存，先前保存的配置仍可读取', () => {
    const original = preferences()
    const raw = JSON.stringify(original)
    const { storage, records } = memoryStorage(raw)
    storage.setItem.mockImplementation(() => { throw new Error('Quota exceeded') })
    const changed: WorkspacePreferences = { ...original, registeredIds: [] }

    expect(writePreferences(storage, changed)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
    expect(readPreferences(storage)).toEqual({ ok: true, value: original })
  })

  it('序列化抛错时不调用存储写入，也不声称保存成功', () => {
    const raw = JSON.stringify(preferences())
    const { storage, records } = memoryStorage(raw)
    const unserializable = {
      ...preferences(),
      toJSON(): never { throw new Error('Serialization failed') },
    }

    expect(writePreferences(storage, unserializable)).toEqual({ ok: false, error: expect.any(String) })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(records.get(PREFERENCES_KEY)).toBe(raw)
  })
})
