import { DEFAULT_IMAGE_LIMITS, PlatformError } from '@eating/plugin-sdk'
import { basename, dirname, join } from 'node:path'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, BackendPlugin, ConnectionStatus, HostPluginContext } from '@eating/plugin-sdk'
import entry from './server'
import { qqMessageSplitPresets } from './message-split'

const transport = vi.hoisted(() => ({
  clients: [] as Array<{
    call: ReturnType<typeof vi.fn>
    status: ConnectionStatus
  }>,
}))

vi.mock('./backend/onebot', () => ({
  OneBotClient: class {
    call = vi.fn(async () => ({ message_id: 100 }))
    status: ConnectionStatus = { state: 'connected', accountId: '123456', accountName: 'Fixture', lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
    constructor() { transport.clients.push(this) }
    getStatus() { return this.status }
    connect = vi.fn(async () => {})
    disconnect = vi.fn(async () => {})
    async dispose() {}
  },
}))

const roots: string[] = []
const plugins: BackendPlugin[] = []
afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.dispose()
  transport.clients.splice(0)
  const parent = realpathSync(tmpdir())
  for (const root of roots.splice(0)) {
    const target = realpathSync(root)
    if (target !== root || dirname(target) !== parent || !basename(target).startsWith('eating-qq-split-srv-')) throw new Error('Unexpected temp path')
    rmSync(target, { recursive: true })
  }
})

function fixture() {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-qq-split-srv-')))
  roots.push(directory)
  const idempotentCache = new Map<string, { state: 'succeeded'; value: unknown } | { state: 'error'; error: unknown }>()
  const executeIdempotent = vi.fn<HostPluginContext['executeIdempotent']>(async (_pluginId, _action, _params, requestId, execute) => {
    const cached = idempotentCache.get(requestId)
    if (cached) {
      if (cached.state === 'succeeded') return cached.value as never
      throw cached.error
    }
    try {
      const value = await execute()
      idempotentCache.set(requestId, { state: 'succeeded', value })
      return value
    } catch (error) {
      idempotentCache.set(requestId, { state: 'error', error })
      throw error
    }
  })
  const context: HostPluginContext = {
    imageLimits: () => DEFAULT_IMAGE_LIMITS,
    dataDirectory: directory,
    getSetting: () => null,
    setSetting: () => {},
    listMessages: () => [],
    executeIdempotent,
    recordEvent: () => ({ inserted: true, eventId: 'evt', admission: 'queued' }),
  }
  const plugin = entry.create(context)
  plugins.push(plugin)
  const client = transport.clients.at(-1)!
  return { plugin, client, executeIdempotent }
}

function scopeFor(plugin: BackendPlugin, kind: 'private' | 'group' = 'private', signal?: AbortSignal): AgentInvocationScope {
  const instanceId = String(plugin.getPublicConfiguration().instanceId)
  const targetId = kind === 'private' ? '234567' : '998877'
  return {
    agentId: 'test-agent-id',
    agentTypeId: kind === 'private' ? 'qq.private' : 'qq.group',
    pluginId: 'qq',
    instanceId,
    accountId: '123456',
    conversationId: `qq:123456:${kind}:${targetId}`,
    kind,
    targetId,
    messageIds: ['42'],
    resourceIds: [],
    ...(signal ? { signal } : {}),
  }
}

async function enableDefaultSplit(plugin: BackendPlugin, delayMs = 0) {
  const period = qqMessageSplitPresets.find(preset => preset.id === 'zh-en-period')!
  const exclaim = qqMessageSplitPresets.find(preset => preset.id === 'zh-en-exclaim-question')!
  const blank = qqMessageSplitPresets.find(preset => preset.id === 'blank-lines')!
  await plugin.manage!('save-message-split', {
    expectedRevision: 0,
    enabled: true,
    maxSegments: 8,
    delayMs,
    trimSegments: true,
    rules: [
      { id: 'blank', name: '空行', enabled: true, pattern: blank.pattern, flags: blank.flags, delimiterMode: blank.delimiterMode },
      { id: 'period', name: '句号', enabled: true, pattern: period.pattern, flags: period.flags, delimiterMode: period.delimiterMode },
      { id: 'exclaim', name: '感叹问号', enabled: true, pattern: exclaim.pattern, flags: exclaim.flags, delimiterMode: exclaim.delimiterMode },
    ],
  })
}

describe('QQ plugin Harness message regex splitting', () => {
  it('splits messages only for Harness invokeScoped calls and leaves manual invoke untouched', async () => {
    const { plugin, client } = fixture()
    let nextId = 100
    client.call.mockImplementation(async () => ({ message_id: ++nextId }))

    expect(await plugin.manage!('message-split', {})).toMatchObject({ schemaVersion: 1, revision: 0, enabled: false })
    await enableDefaultSplit(plugin, 0)

    const manual = await plugin.invoke('qq_send_private_message', {
      user_id: '234567',
      message: '第一句。第二句！',
      request_id: 'manual-req-0001',
    }, 'manual-req-0001')
    expect(manual).toEqual({ message_id: 101 })
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenLastCalledWith('send_private_msg', expect.objectContaining({ message: '第一句。第二句！' }), expect.any(Object))

    const scoped = await plugin.invokeScoped!('qq_send_private_message', {
      user_id: '234567',
      message: '第一句。第二句！\n\n第三句？',
      request_id: 'harness-req-0001',
    }, 'harness-req-0001', scopeFor(plugin, 'private'))
    expect(scoped).toEqual({
      message_id: 102,
      message_ids: [102, 103, 104],
      split: true,
      parts_sent: 3,
      results: [{ message_id: 102 }, { message_id: 103 }, { message_id: 104 }],
    })
    expect(client.call).toHaveBeenCalledTimes(4)
    expect(client.call.mock.calls[1]?.[1]).toMatchObject({ user_id: 234567, message: '第一句' })
    expect(client.call.mock.calls[2]?.[1]).toMatchObject({ user_id: 234567, message: '第二句！' })
    expect(client.call.mock.calls[3]?.[1]).toMatchObject({ user_id: 234567, message: '第三句？' })

    // Replaying the same request_id returns cached result without re-sending any part.
    const replayed = await plugin.invokeScoped!('qq_send_private_message', {
      user_id: '234567',
      message: '第一句。第二句！\n\n第三句？',
      request_id: 'harness-req-0001',
    }, 'harness-req-0001', scopeFor(plugin, 'private'))
    expect(replayed).toEqual(scoped)
    expect(client.call).toHaveBeenCalledTimes(4)
  })

  it('attaches leading reply and at segments to the first group bubble and sends remaining parts as text segments', async () => {
    const { plugin, client } = fixture()
    let nextId = 200
    client.call.mockImplementation(async () => ({ message_id: ++nextId }))
    await enableDefaultSplit(plugin, 0)

    const result = await plugin.invokeScoped!('qq_send_group_message', {
      group_id: '998877',
      message: [
        { type: 'reply', data: { id: '42' } },
        { type: 'at', data: { qq: '234567' } },
        { type: 'text', data: { text: '收到啦！我马上处理。' } },
      ],
      request_id: 'group-req-0001',
    }, 'group-req-0001', scopeFor(plugin, 'group'))

    expect(result).toMatchObject({ message_id: 201, message_ids: [201, 202], split: true, parts_sent: 2 })
    expect(client.call.mock.calls[0]?.[1]).toMatchObject({
      group_id: 998877,
      message: [
        { type: 'reply', data: { id: '42' } },
        { type: 'at', data: { qq: '234567' } },
        { type: 'text', data: { text: '收到啦！' } },
      ],
    })
    expect(client.call.mock.calls[1]?.[1]).toMatchObject({
      group_id: 998877,
      message: [{ type: 'text', data: { text: '我马上处理' } }],
    })
  })

  it('reports partial send failure as unknown outcome with already-sent message_ids and stops further sends', async () => {
    const { plugin, client } = fixture()
    let calls = 0
    client.call.mockImplementation(async () => {
      calls++
      if (calls === 1) return { message_id: 501 }
      throw new PlatformError('ONEBOT_CALL_FAILED', '协议端发送失败', 502, 'failed')
    })
    await enableDefaultSplit(plugin, 0)

    await expect(plugin.invokeScoped!('qq_send_private_message', {
      user_id: '234567',
      message: '第一条。第二条。第三条。',
      request_id: 'partial-req-0001',
    }, 'partial-req-0001', scopeFor(plugin, 'private'))).rejects.toMatchObject({
      code: 'QQ_SPLIT_PARTIAL_SEND',
      outcome: 'unknown',
      message: expect.stringContaining('501'),
    })
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('aborts delay wait immediately when scope signal cancels and stops remaining bubbles', async () => {
    const { plugin, client } = fixture()
    const abort = new AbortController()
    client.call.mockImplementationOnce(async () => {
      setTimeout(() => abort.abort(), 15)
      return { message_id: 601 }
    })
    await enableDefaultSplit(plugin, 5000)

    const started = Date.now()
    await expect(plugin.invokeScoped!('qq_send_private_message', {
      user_id: '234567',
      message: '第一条。第二条。',
      request_id: 'abort-req-0001',
    }, 'abort-req-0001', scopeFor(plugin, 'private', abort.signal))).rejects.toMatchObject({
      code: 'QQ_SPLIT_SEND_INTERRUPTED',
      outcome: 'unknown',
      message: expect.stringContaining('601'),
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it('strips trailing delimiter on single-part match while preserving standard single-message response shape', async () => {
    const { plugin, client } = fixture()
    client.call.mockResolvedValueOnce({ message_id: 701 })
    await enableDefaultSplit(plugin, 0)

    const result = await plugin.invokeScoped!('qq_send_private_message', {
      user_id: '234567',
      message: '你好。',
      request_id: 'single-req-0001',
    }, 'single-req-0001', scopeFor(plugin, 'private'))
    expect(result).toEqual({ message_id: 701 })
    expect(client.call).toHaveBeenCalledWith('send_private_msg', expect.objectContaining({ message: '你好' }), expect.any(Object))
  })
})
