import { describe, expect, it, vi } from 'vitest'
import { PluginRegistry, validateManifest } from './index'
import type { PluginManifest } from './index'

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'example.qq',
    name: 'QQ 示例插件',
    description: '提供本地 QQ 配置示例，不连接真实平台。',
    version: '0.1.0',
    apiVersion: 3,
    ...overrides,
  }
}

describe('PluginRegistry', () => {
  it('通过快照反映动态注册，同时保留先前快照供订阅者比较', () => {
    const registry = new PluginRegistry<PluginManifest & { panel: string }>()
    const empty = registry.getSnapshot()
    expect(empty).toEqual([])
    expect(registry.getSnapshot()).toBe(empty)

    registry.register({ ...manifest(), panel: 'qq-settings' })
    const qqOnly = registry.getSnapshot()
    expect(qqOnly).not.toBe(empty)
    expect(qqOnly).toEqual([expect.objectContaining({ id: 'example.qq', panel: 'qq-settings' })])
    expect(registry.getSnapshot()).toBe(qqOnly)
    expect(registry.get('example.qq')).toBe(qqOnly[0])
    expect(empty).toEqual([])

    registry.register({ ...manifest({ id: 'example.feishu', name: '飞书示例插件' }), panel: 'feishu-settings' })
    expect(registry.getSnapshot().map(plugin => plugin.id)).toEqual(['example.qq', 'example.feishu'])
    expect(registry.getSnapshot()).not.toBe(qqOnly)
    expect(qqOnly.map(plugin => plugin.id)).toEqual(['example.qq'])
  })

  it('拒绝重复标识，保留原插件及其快照，不发布成功通知', () => {
    const registry = new PluginRegistry<PluginManifest>()
    registry.register(manifest())
    const original = registry.get('example.qq')
    const snapshot = registry.getSnapshot()
    const listener = vi.fn()
    registry.subscribe(listener)

    expect(() => registry.register(manifest({ name: '同标识的另一插件', version: '0.2.0' })))
      .toThrowError(expect.objectContaining({ name: 'PluginRegistrationError', code: 'duplicate-id' }))
    expect(registry.get('example.qq')).toBe(original)
    expect(registry.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
  })

  it('拒绝不支持的接口版本，且不留下部分注册记录', () => {
    const registry = new PluginRegistry<PluginManifest>()
    const listener = vi.fn()
    registry.subscribe(listener)
    const future = { ...manifest(), apiVersion: 1 } as unknown as PluginManifest

    expect(() => registry.register(future))
      .toThrowError(expect.objectContaining({ name: 'PluginRegistrationError', code: 'incompatible-version' }))
    expect(registry.get('example.qq')).toBeUndefined()
    expect(registry.getSnapshot()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<PluginManifest>]>([
    ['空标识', { id: '' }],
    ['包含路径的标识', { id: '../example.qq' }],
    ['大写标识', { id: 'Example.QQ' }],
    ['超长标识', { id: 'a'.repeat(81) }],
    ['空名称', { name: '   ' }],
    ['超长名称', { name: '名'.repeat(41) }],
    ['空描述', { description: ' \n ' }],
    ['缺少补丁版本号', { version: '0.1' }],
    ['非版本字符串', { version: 'latest' }],
  ])('拒绝无效声明：%s，且不影响已注册插件', (_, invalid) => {
    const registry = new PluginRegistry<PluginManifest>()
    registry.register(manifest({ id: 'example.feishu', name: '飞书示例插件' }))
    const before = registry.getSnapshot()
    const listener = vi.fn()
    registry.subscribe(listener)

    expect(() => registry.register(manifest(invalid)))
      .toThrowError(expect.objectContaining({ name: 'PluginRegistrationError', code: 'invalid-manifest' }))
    expect(registry.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('接受完整声明及预发布版本', () => {
    expect(() => validateManifest(manifest({ version: '0.1.0-local.1' }))).not.toThrow()
  })

  it('独立移除一个插件，保留其他插件；重复或未知移除不发布通知', () => {
    const registry = new PluginRegistry<PluginManifest>()
    registry.register(manifest())
    registry.register(manifest({ id: 'example.feishu', name: '飞书示例插件' }))
    const feishu = registry.get('example.feishu')
    const listener = vi.fn()
    registry.subscribe(listener)

    expect(registry.unregister('example.qq')).toBe(true)
    expect(registry.get('example.qq')).toBeUndefined()
    expect(registry.get('example.feishu')).toBe(feishu)
    expect(registry.getSnapshot()).toEqual([feishu])
    const remaining = registry.getSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    expect(registry.unregister('example.qq')).toBe(false)
    expect(registry.unregister('unknown.plugin')).toBe(false)
    expect(registry.getSnapshot()).toBe(remaining)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('旧的撤销函数不能移除同标识的新注册', () => {
    const registry = new PluginRegistry<PluginManifest>()
    const disposeOld = registry.register(manifest())
    disposeOld()
    const disposeNew = registry.register(manifest({ name: '重新注册的 QQ', version: '0.2.0' }))
    const current = registry.get('example.qq')
    const listener = vi.fn()
    registry.subscribe(listener)

    disposeOld()
    expect(registry.get('example.qq')).toBe(current)
    expect(registry.getSnapshot()).toEqual([current])
    expect(listener).not.toHaveBeenCalled()

    disposeNew()
    disposeNew()
    expect(registry.getSnapshot()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('发布变更后的快照，并允许各订阅者独立退订', () => {
    const registry = new PluginRegistry<PluginManifest>()
    const observed: string[][] = []
    const stopObserving = registry.subscribe(() => {
      observed.push(registry.getSnapshot().map(plugin => plugin.id))
    })
    const otherListener = vi.fn()
    const stopOther = registry.subscribe(otherListener)
    expect(observed).toEqual([])
    expect(otherListener).not.toHaveBeenCalled()

    registry.register(manifest())
    expect(observed).toEqual([['example.qq']])
    stopObserving()
    stopObserving()
    registry.register(manifest({ id: 'example.feishu', name: '飞书示例插件' }))
    expect(observed).toEqual([['example.qq']])
    expect(otherListener).toHaveBeenCalledTimes(2)

    stopOther()
    registry.unregister('example.qq')
    expect(otherListener).toHaveBeenCalledTimes(2)
  })
})
