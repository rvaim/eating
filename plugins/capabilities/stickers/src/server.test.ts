import { basename, dirname, join } from 'node:path'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, BackendPlugin, CapabilityInvocationScope, HostPluginContext, JsonObject, JsonValue } from '@eating/plugin-sdk'
import entry from './server'
import { fixtureImage } from './backend/test-fixtures'

const roots: string[] = [], plugins: BackendPlugin[] = []
afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.dispose()
  for (const root of roots.splice(0)) {
    const target = realpathSync(root)
    if (target !== root || dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('eating-sticker-api-')) throw new Error('Unsafe sticker API cleanup')
    rmSync(target, { recursive: true })
  }
})
const source: AgentInvocationScope = { agentId: 'child', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: 'fixture-instance', accountId: '123456', kind: 'private', targetId: '234567', conversationId: 'qq:123456:private:234567', messageIds: ['12'], resourceIds: ['received-image'] }
const scope: CapabilityInvocationScope = { agentId: 'child', agentTypeId: 'qq.private', source }
function fixture(withResources = true) {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-sticker-api-'))); roots.push(directory)
  const resources = { readReceivedImage: vi.fn(async () => fixtureImage()), readAsset: vi.fn(async () => fixtureImage()) }
  const cached = new Map<string, { params: string; result: JsonValue }>()
  const executeIdempotent = vi.fn<HostPluginContext['executeIdempotent']>(async (_plugin, action, params, requestId, execute) => {
    const key = action + requestId, previous = cached.get(key), fingerprint = JSON.stringify(params)
    if (previous && previous.params !== fingerprint) throw new Error('Fixture request changed')
    if (previous) return previous.result
    const result = await execute(); cached.set(key, { params: fingerprint, result }); return result
  })
  const context: HostPluginContext = { dataDirectory: directory, ...(withResources ? { resources } : {}), executeIdempotent, getSetting: () => null, setSetting: () => {}, listMessages: () => [], recordEvent: () => ({ inserted: true, eventId: 'fixture' }) }
  const plugin = entry.create(context); plugins.push(plugin)
  const add = () => plugin.manage!('add', { ...fixtureImage(), description: '开心挥手', tags: ['问候'] })
  return { plugin, resources, executeIdempotent, add }
}
const addArgs = { source: { messageId: '12', imageId: 'received-image' }, description: '欢迎回来', tags: ['问候', '开心'], request_id: 'sticker-request-0001' }

describe('sticker capability entry and authorization', () => {
  it('publishes exactly six independent API4 tools with correct side-effect and result declarations', () => {
    const { plugin } = fixture()
    expect(entry.kind).toBe('capability')
    expect(plugin.tools.map(tool => tool.name)).toEqual(['sticker_add', 'sticker_list', 'sticker_get', 'sticker_update', 'sticker_delete', 'sticker_list_tags'])
    for (const tool of plugin.tools) {
      expect(tool.protocolAction).toBeUndefined()
      expect(tool.resultFormat).toBe(tool.name === 'sticker_get' ? 'content' : 'json')
      const required = tool.inputSchema.required as string[]
      expect(required.includes('request_id')).toBe(!tool.readOnly)
    }
    expect(plugin.getStatus().state).toBe('connected')
    expect(plugin.getPublicConfiguration()).toMatchObject({ revision: 0, total: 0, ready: true })
    expect(plugin.media?.readTool).toBe('sticker_get')
  })

  it('uses Host resource services only for authorized current message/image references', async () => {
    const { plugin, resources, executeIdempotent } = fixture()
    const added = await plugin.invokeCapability!('sticker_add', addArgs, addArgs.request_id, scope)
    expect(added).toMatchObject({ duplicate: false, revision: 1, item: { description: '欢迎回来', tags: ['问候', '开心'] } })
    expect(resources.readReceivedImage).toHaveBeenCalledExactlyOnceWith(source, addArgs.source)
    expect(executeIdempotent).toHaveBeenCalledWith('stickers', 'sticker_add', { source: addArgs.source, description: addArgs.description, tags: addArgs.tags }, addArgs.request_id, expect.any(Function), { instanceId: source.instanceId, accountId: source.accountId })
    expect(JSON.stringify(executeIdempotent.mock.calls)).not.toContain(fixtureImage().data)
    expect(await plugin.invokeCapability!('sticker_add', addArgs, addArgs.request_id, scope)).toEqual(added)
    expect(resources.readReceivedImage).toHaveBeenCalledTimes(1)
  })

  it('refuses root collection without a trusted source, ungranted references and arbitrary model paths', async () => {
    const { plugin, resources, executeIdempotent } = fixture()
    await expect(plugin.invoke('sticker_add', addArgs, addArgs.request_id)).rejects.toMatchObject({ code: 'STICKER_SOURCE_REQUIRED' })
    await expect(plugin.invokeCapability!('sticker_add', addArgs, addArgs.request_id, { agentId: 'root', agentTypeId: 'main' })).rejects.toMatchObject({ code: 'STICKER_SOURCE_REQUIRED' })
    for (const input of [{ ...addArgs, source: { messageId: '13', imageId: 'received-image' } }, { ...addArgs, source: { messageId: '12', imageId: '/etc/passwd' } }, { ...addArgs, data: fixtureImage().data }, { ...addArgs, source: { ...addArgs.source, url: 'https://example.test' } }]) await expect(plugin.invokeCapability!('sticker_add', input, addArgs.request_id, scope)).rejects.toThrow()
    expect(resources.readReceivedImage).not.toHaveBeenCalled()
    expect(executeIdempotent).not.toHaveBeenCalled()
  })

  it('reports an absent resource service and never reads a supplied URL itself', async () => {
    const { plugin } = fixture(false)
    await expect(plugin.invokeCapability!('sticker_add', addArgs, addArgs.request_id, scope)).rejects.toMatchObject({ code: 'STICKER_RESOURCE_UNAVAILABLE' })
  })

  it('supports local uploads, metadata-only queries, real image get and media resolution', async () => {
    const { plugin, add } = fixture()
    const added = await add() as JsonObject
    const item = added.item as JsonObject
    const list = await plugin.invokeCapability!('sticker_list', {}, 'read-list', { agentId: 'root', agentTypeId: 'main' })
    expect(list).toMatchObject({ total: 1, items: [item], nextOffset: null })
    expect(JSON.stringify(list)).not.toContain(fixtureImage().data)
    const result = await plugin.invokeCapability!('sticker_get', { assetId: item.assetId }, 'read-image', scope)
    expect(result).toMatchObject({ content: [{ type: 'text' }, { type: 'image', data: fixtureImage().data, mimeType: 'image/png' }], structuredContent: { revision: 1, item, sendable: { type: 'image', data: { file: `eating-asset://stickers/${item.assetId}` } } } })
    expect(JSON.stringify((result as JsonObject).structuredContent)).not.toContain(fixtureImage().data)
    expect(await plugin.media!.readAsset(String(item.assetId))).toEqual(fixtureImage())
    expect(await plugin.manage!('get', { assetId: item.assetId })).toMatchObject({ revision: 1, item, image: fixtureImage() })
    expect(await plugin.invoke('sticker_list_tags', {}, 'read-tags')).toEqual({ revision: 1, tags: [{ tag: '问候', count: 1 }] })
  })

  it('requires stable request IDs and CAS for update/delete without storing image content in action params', async () => {
    const { plugin, add, executeIdempotent } = fixture()
    const added = await add() as JsonObject, item = added.item as JsonObject
    const update = { assetId: item.assetId, description: '修改描述', tags: ['编辑'], expectedRevision: 1, request_id: 'update-sticker-0001' }
    await expect(plugin.invoke('sticker_update', update, 'different-request')).rejects.toMatchObject({ code: 'REQUEST_ID_REQUIRED' })
    expect(await plugin.invoke('sticker_update', update, update.request_id)).toMatchObject({ revision: 2, item: { description: '修改描述' } })
    await expect(plugin.invoke('sticker_delete', { assetId: item.assetId, expectedRevision: 1, request_id: 'delete-sticker-0001' }, 'delete-sticker-0001')).rejects.toMatchObject({ code: 'STICKER_REVISION_CONFLICT' })
    expect(await plugin.invoke('sticker_delete', { assetId: item.assetId, expectedRevision: 2, request_id: 'delete-sticker-0002' }, 'delete-sticker-0002')).toMatchObject({ deleted: true, revision: 3 })
    expect(JSON.stringify(executeIdempotent.mock.calls)).not.toContain(fixtureImage().data)
  })

  it('keeps owner management separate from the disconnected MCP/media surface and rejects unknown configuration', async () => {
    const { plugin, add } = fixture()
    const added = await add() as JsonObject, item = added.item as JsonObject
    await plugin.disconnect()
    await expect(plugin.invoke('sticker_list', {}, 'read')).rejects.toMatchObject({ code: 'STICKER_NOT_READY' })
    await expect(plugin.media!.readAsset(String(item.assetId))).rejects.toMatchObject({ code: 'STICKER_NOT_READY' })
    expect(await plugin.manage!('list', {})).toMatchObject({ total: 1 })
    await expect(plugin.updateConfiguration({ apiKey: 'unneeded' })).rejects.toMatchObject({ code: 'STICKER_INVALID_INPUT' })
    await plugin.connect()
    expect(await plugin.invoke('sticker_list', {}, 'read')).toMatchObject({ total: 1 })
    await expect(plugin.invoke('not-a-tool', {}, 'read')).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
    await expect(plugin.manage!('unknown', {})).rejects.toMatchObject({ code: 'STICKER_OPERATION_NOT_FOUND' })
  })
})
