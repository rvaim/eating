import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrainCircuit, MessageCircle } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@eating/ui-sdk'
import type { ManagedPlugin } from '@eating/ui-sdk'
import { PlatformWorkspace } from '../state/workspace'
import type { WorkspaceSnapshot } from '../state/workspace'
import { loadPluginCatalog } from './catalog'
import { Overview } from '../pages/Overview'
import { Robots } from '../pages/Robots'
import dsh from '../../../../plugins/harness/dsh/src/web/entry'

const qq: ManagedPlugin = { id: 'qq', name: 'QQ', description: '正式通讯插件', version: '0.4.0', apiVersion: 2,
  kind: 'communication', order: 10, icon: MessageCircle, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: {}, validate: () => ({ valid: true, errors: {} }), summary: () => 'QQ 配置', Panel: () => createElement('p', null, 'QQ 专属面板') }
const harness: ManagedPlugin = { ...qq, id: 'other-harness', name: '另一 Harness', description: '独立认知插件', kind: 'harness', icon: BrainCircuit,
  summary: () => 'Harness 配置', Panel: () => createElement('p', null, 'Harness 专属面板') }
const connected = { state: 'connected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 } as const
const snapshot: WorkspaceSnapshot = { plugins: [qq, harness], configurations: { qq: { values: { endpoint: 'ws://fixture' }, savedAt: '' },
  'other-harness': { values: { endpoint: 'http://fixture', model: 'fixture' }, savedAt: '' } }, activity: [], storageError: null,
  unavailableIds: [], statuses: { qq: connected, 'other-harness': connected }, harness: { state: 'attached', pending: 0 }, ready: true }

afterEach(() => setLocale('zh-CN'))

describe('按真实插件类型组织管理界面', () => {
  it('失败面板保留当前插件显式声明的类型', async () => {
    const catalog = await loadPluginCatalog([
      { id: 'qq', kind: 'communication', name: 'QQ', version: '0.4.0', frontend: { entry: '/invalid/index.js', style: '/invalid/style.css' } },
      { id: 'other-harness', kind: 'harness', name: '另一 Harness', version: '0.1.0', frontend: { entry: '/invalid/index.js', style: '/invalid/style.css' } },
      { id: 'headless-harness', kind: 'harness', name: '无前端 Harness', version: '0.1.0' },
    ])
    expect(catalog.map(plugin => [plugin.id, plugin.kind])).toEqual([['qq', 'communication'], ['other-harness', 'harness'], ['headless-harness', 'harness']])
    const renderFailure = () => renderToStaticMarkup(createElement(catalog[1]!.Panel, { saved: undefined, initialValues: {}, onSave: () => ({ ok: true as const }), onFeedback: vi.fn() }))
    expect(renderFailure()).toContain('此插件的配置面板无法加载')
    setLocale('en-US')
    expect(renderFailure()).toContain('This plugin’s settings panel could not load')
    expect(catalog[1]!.description).toContain('This plugin’s settings panel could not load')
    expect(catalog[1]!.summary({})).toContain('This plugin’s settings panel could not load')
    expect(catalog[1]!.kind).toBe('harness')
  })

  it('拒绝缺少或不支持当前种类声明的目录，不猜测通讯类型', async () => {
    for (const entry of [{ id: 'qq', name: 'QQ' }, { id: 'qq', kind: 'unknown' }]) {
      await expect(loadPluginCatalog([entry] as unknown as Parameters<typeof loadPluginCatalog>[0])).rejects.toThrow()
    }
  })

  it('机器人目录只含通讯，Harness 目录只含已启用 Harness 并支持非 DSH 实现', () => {
    const props = { workspace: new PlatformWorkspace([qq, harness]), snapshot, selectedId: null, onSelect: vi.fn(), onRegister: vi.fn(), onFeedback: vi.fn() }
    const robots = renderToStaticMarkup(createElement(Robots, { ...props, kind: 'communication' }))
    expect(robots).toContain('正式通讯插件')
    expect(robots).not.toContain('另一 Harness')
    const harnesses = renderToStaticMarkup(createElement(Robots, { ...props, kind: 'harness' }))
    expect(harnesses).toContain('另一 Harness')
    expect(harnesses).not.toContain('正式通讯插件')
    expect(harnesses).toContain('已启动')
  })

  it('概览只统计通讯插件和真实网关接入状态', () => {
    const render = (value: WorkspaceSnapshot) => renderToStaticMarkup(createElement(Overview, { snapshot: value, onRobots: vi.fn(), onRegister: vi.fn() }))
    const overview = render(snapshot)
    expect(overview).toContain('1 个已启用')
    expect(overview).toContain('1 个已配置')
    expect(overview).toContain('1 个已连接')
    expect(overview).toContain('AI 状态')
    expect(overview).toContain('AI 已连接，可接收消息。')
    expect(overview).not.toContain('另一 Harness')
    expect(render({ ...snapshot, harness: { state: 'not-attached' } })).toContain('尚未连接')
    expect(render({ ...snapshot, storageError: 'Host 离线' })).toContain('状态待确认')
  })

  it('DSH 声明为 Harness，空配置允许保存且摘要不含写入密钥', () => {
    expect(dsh.kind).toBe('harness')
    expect(dsh.validate(dsh.initialValues)).toEqual({ valid: true, errors: {} })
    expect(dsh.summary({ ...dsh.initialValues, model: 'fixture-model', apiKey: 'private-input' })).toBe('DeepSeek Harness · fixture-model')
    expect(dsh.validate({ ...dsh.initialValues, endpoint: 'https://user:password@example.test/v1' }).errors).toHaveProperty('endpoint')
    expect(dsh.validate({ ...dsh.initialValues, endpoint: 'https://example.test/v1?' }).errors).toHaveProperty('endpoint')
    expect(dsh.validate({ ...dsh.initialValues, model: 'invalid\nmodel' }).errors).toHaveProperty('model')
    expect(dsh.validate({ ...dsh.initialValues, timeoutMs: '999', maxTokens: '0' }).valid).toBe(false)
    expect(dsh.validate({ ...dsh.initialValues, displayName: '名'.repeat(80), timeoutMs: '120000', maxTokens: '131072' }).valid).toBe(true)
  })
})
