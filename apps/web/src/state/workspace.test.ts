import { describe, expect, it, vi } from 'vitest'
import { MessageCircle } from 'lucide-react'
import type { CommunicationPlugin } from '@eating/ui-sdk'
import type { hostRequest } from '@eating/ui-sdk'
import { PlatformWorkspace } from './workspace'

const plugin: CommunicationPlugin = { id: 'qq', name: 'QQ', description: '平台', version: '0.2.0', apiVersion: 1,
  kind: 'communication', order: 1, icon: MessageCircle, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: {}, validate: () => ({ valid: true, errors: {} }), summary: () => 'QQ', Panel: () => null }
const disconnected = { state: 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }

function serverState(ids = ['qq']) {
  return { protocolVersion: 1, registeredIds: ids, plugins: [{ id: 'qq', configuration: { displayName: '我的 QQ', endpoint: 'ws://127.0.0.1:3001', updatedAt: '2026-10-26T00:00:00Z' }, status: disconnected }], harness: { state: 'not-attached', pending: 2 } }
}

function requester(value: unknown) {
  const mock = vi.fn().mockResolvedValue(value)
  return { mock, request: (async <T>(path: string, options?: unknown) => await mock(path, options) as T) as typeof hostRequest }
}

describe('正式 Host 工作区', () => {
  it('初始不编造注册/在线，加载真实 Host 后挂载相应插件', async () => {
    const { request } = requester(serverState())
    const workspace = new PlatformWorkspace([plugin], request)
    expect(workspace.getSnapshot().plugins).toEqual([])
    expect(workspace.getSnapshot().ready).toBe(false)
    await workspace.refresh()
    expect(workspace.getSnapshot().plugins.map(entry => entry.id)).toEqual(['qq'])
    expect(workspace.getSnapshot().harness.pending).toBe(2)
    expect(workspace.getSnapshot().statuses.qq?.state).toBe('disconnected')
    expect(workspace.getSnapshot().configurations.qq?.values.endpoint).toBe('ws://127.0.0.1:3001')
  })

  it('Host 故障显示错误并保留最近一次真实快照，不伪造新状态', async () => {
    const { request, mock } = requester(serverState())
    const workspace = new PlatformWorkspace([plugin], request)
    await workspace.refresh()
    mock.mockRejectedValueOnce(new Error('Host 离线'))
    await workspace.refresh()
    expect(workspace.getSnapshot().storageError).toBe('Host 离线')
    expect(workspace.getSnapshot().plugins).toHaveLength(1)
  })

  it('过期刷新响应不能覆盖较新的状态', async () => {
    const { request, mock } = requester(serverState())
    let finish!: (value: unknown) => void
    mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const workspace = new PlatformWorkspace([plugin], request)
    const old = workspace.refresh()
    await workspace.refresh()
    finish(serverState([]))
    await old
    expect(workspace.getSnapshot().plugins).toHaveLength(1)
  })

  it('真实停用成功后按 Host 目录撤销面板，而非先乐观清空', async () => {
    const { request, mock } = requester(serverState())
    const workspace = new PlatformWorkspace([plugin], request)
    await workspace.refresh()
    mock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(serverState([]))
    expect((await workspace.remove('qq')).ok).toBe(true)
    expect(mock).toHaveBeenCalledWith('/plugins/qq/disable', { method: 'POST', body: {} })
    expect(workspace.getSnapshot().plugins).toHaveLength(0)
  })

  it('保存失败不制造成功记录，不修改已加载的配置', async () => {
    const { request, mock } = requester(serverState())
    const workspace = new PlatformWorkspace([plugin], request)
    await workspace.refresh()
    mock.mockRejectedValueOnce(new Error('磁盘不可写'))
    expect(await workspace.save('qq', { endpoint: 'ws://invalid' })).toEqual({ ok: false, error: '磁盘不可写' })
    expect(workspace.getSnapshot().activity).toHaveLength(0)
    expect(workspace.getSnapshot().configurations.qq?.values.endpoint).toBe('ws://127.0.0.1:3001')
  })

  it('快照与订阅稳定，退订后不收到后续刷新', async () => {
    const { request } = requester(serverState())
    const workspace = new PlatformWorkspace([plugin], request)
    expect(workspace.getSnapshot()).toBe(workspace.getSnapshot())
    const listener = vi.fn()
    const release = workspace.subscribe(listener)
    await workspace.refresh()
    release()
    await workspace.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
