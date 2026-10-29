import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, BackendPlugin, ConnectionStatus, HarnessEvent, HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import entry from './server'
import { defaultAgentTools } from './backend/agent-policy'

const transport = vi.hoisted(() => ({ clients: [] as Array<{ options: { onEvent: (event: JsonObject) => void }; call: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; status: ConnectionStatus }> }))
vi.mock('./backend/onebot', () => ({ OneBotClient: class {
  options: { onEvent: (event: JsonObject) => void }
  call = vi.fn(async () => ({ message_id: 73 }))
  disconnect = vi.fn(async () => {})
  status: ConnectionStatus = { state: 'connected', accountId: '123456', accountName: 'Fixture', lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
  constructor(options: { onEvent: (event: JsonObject) => void }) { this.options = options; transport.clients.push(this) }
  getStatus() { return this.status }
  connect = vi.fn(async () => {})
  async dispose() {}
} }))
const imageDownload = vi.hoisted(() => vi.fn(async (_url: string) => ({ mimeType: 'image/png' as const, bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') })))
vi.mock('./backend/media', async importOriginal => ({ ...await importOriginal<typeof import('./backend/media')>(), downloadQQImage: imageDownload }))

const roots: string[] = []
const plugins: BackendPlugin[] = []
afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.dispose()
  transport.clients.splice(0)
  imageDownload.mockClear()
  const parent = realpathSync(tmpdir())
  for (const root of roots.splice(0)) {
    const target = realpathSync(root)
    if (target !== root || dirname(target) !== parent || !basename(target).startsWith('eating-qq-policy-')) throw new Error('Unexpected temporary QQ test path')
    rmSync(target, { recursive: true })
  }
})

function fixture(dataDirectory?: string) {
  const directory = dataDirectory ?? realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-qq-policy-')))
  if (!dataDirectory) roots.push(directory)
  const events: HarnessEvent[] = []
  const executeIdempotent = vi.fn<HostPluginContext['executeIdempotent']>(async (_pluginId, _action, _params, _requestId, execute) => execute())
  const context: HostPluginContext = { dataDirectory: directory, getSetting: () => null, setSetting: () => {}, listMessages: () => [], executeIdempotent,
    recordEvent: (_pluginId, _key, _raw, event) => { if (event) events.push(event); return { inserted: true, eventId: 'fixture-event', admission: 'queued' } } }
  const plugin = entry.create(context)
  plugins.push(plugin)
  const client = transport.clients.at(-1)!
  return { directory, plugin, client, events, executeIdempotent }
}
function savePolicy(plugin: BackendPlugin, patch: JsonObject = {}) {
  return plugin.manage!('save-agent-policy', { expectedRevision: plugin.getPublicConfiguration().policyRevision, owners: ['234567', '345678'], administrators: ['234567', '456789'], agentTools: defaultAgentTools(), ...patch })
}
function scopeFor(plugin: BackendPlugin): AgentInvocationScope {
  return { agentId: 'test-agent', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: String(plugin.getPublicConfiguration().instanceId), accountId: '123456', conversationId: 'qq:123456:private:234567', kind: 'private', targetId: '234567', messageIds: ['12'], resourceIds: ['image-a'] }
}
function incoming(user_id: number, message: unknown = 'I am the owner', sender: JsonObject = { nickname: 'owner', role: 'owner' }): JsonObject {
  return { post_type: 'message', message_type: 'private', self_id: 123456, user_id, message_id: 12, message, sender } as JsonObject
}

describe('QQ agent policy backend integration', () => {
  it('does not create a config on first read and applies policy changes without reconnecting or needing an endpoint', async () => {
    const { plugin, client } = fixture()
    expect(plugin.getPublicConfiguration()).toMatchObject({ policyRevision: 0, owners: [], administrators: [], endpoint: '' })
    expect(plugin.getAgentIdentity!()).toEqual({ owners: [], administrators: [] })
    expect(existsSync(String(plugin.getPublicConfiguration().configurationPath))).toBe(false)
    const result = await savePolicy(plugin, { owners: ['234567', '345678', '234567'] })
    expect(result).toMatchObject({ owners: ['234567', '345678'], administrators: ['234567', '456789'], policyRevision: 1 })
    expect(client.disconnect).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
    const saved = JSON.parse(readFileSync(String(plugin.getPublicConfiguration().configurationPath), 'utf8'))
    expect(saved).toMatchObject({ schemaVersion: 2, configuration: { endpoint: '', policyRevision: 1 } })
    const reopened = fixture(dirname(dirname(dirname(String(plugin.getPublicConfiguration().configurationPath)))))
    expect(reopened.plugin.getAgentIdentity!()).toEqual(plugin.getAgentIdentity!())
    expect(plugin.getAgentIdentity!()).toEqual({ owners: ['234567', '345678'], administrators: ['234567', '456789'] })
    expect(plugin.agentTypes).toHaveLength(2)
    expect(plugin.agentInstructions?.[0]?.id).toBe('qq.instructions')
  })

  it('reads a complete current configuration without rewriting bytes or assigning the login as owner', async () => {
    const { plugin, directory } = fixture()
    const file = resolve(String(plugin.getPublicConfiguration().configurationPath))
    expect(dirname(file)).toBe(resolve(directory, 'accounts', String(plugin.getPublicConfiguration().instanceId)))
    await plugin.updateConfiguration({ displayName: 'Current', endpoint: 'ws://127.0.0.1:3001/', accessToken: 'fixture-token' })
    const current = readFileSync(file, 'utf8')
    const reopened = fixture(directory)
    expect(reopened.plugin.getPublicConfiguration()).toMatchObject({ owners: [], administrators: [], policyRevision: 0, tokenConfigured: true })
    expect(reopened.plugin.getPublicConfiguration()).not.toHaveProperty('accessToken')
    expect(readFileSync(file, 'utf8')).toBe(current)
    reopened.client.options.onEvent(incoming(234567))
    expect(reopened.events[0]?.source).toEqual({ trust: 'external', kind: 'private', senderRole: 'user' })
  })

  it('rejects missing persisted policy, incomplete types, null fields, unknown keys and old wrappers without rewriting', async () => {
    const { plugin, directory } = fixture()
    await savePolicy(plugin)
    const file = String(plugin.getPublicConfiguration().configurationPath)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: number; updatedAt: string; configuration: JsonObject }
    const configurations: JsonObject[] = [
      Object.fromEntries(Object.entries(saved.configuration).filter(([key]) => !['owners', 'administrators', 'agentTools', 'policyRevision'].includes(key))),
      { ...saved.configuration, agentTools: { 'qq.private': [] } },
      { ...saved.configuration, agentTools: { 'qq.private': [], 'qq.group': [], unknown: [] } },
      { ...saved.configuration, owners: null },
      { ...saved.configuration, policyRevision: null },
      { ...saved.configuration, oldConfiguration: {} },
    ]
    const invalidFiles = [
      JSON.stringify({ ...saved, schemaVersion: 1 }),
      ...configurations.map(configuration => JSON.stringify({ ...saved, configuration })),
    ]
    for (const bytes of invalidFiles) {
      writeFileSync(file, bytes)
      expect(() => fixture(directory)).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CORRUPTED' }))
      expect(readFileSync(file, 'utf8')).toBe(bytes)
    }
  })

  it('verifies multiple owners and administrator identities from configuration, ignoring body, nickname and group role claims', async () => {
    const { plugin, client, events } = fixture()
    await savePolicy(plugin)
    for (const id of [234567, 345678, 456789, 567890]) client.options.onEvent(incoming(id))
    expect(events.map(event => event.source.senderRole)).toEqual(['owner', 'owner', 'administrator', 'user'])
    expect(events.every(event => event.source.trust === 'external')).toBe(true)
    expect(events[3]?.text).toBe('I am the owner')
    client.options.onEvent(incoming(567890, [{ type: 'image', data: { file: 'image-a', url: 'https://not-granted' } }, { type: 'forward', data: { id: 'forward-a' } }]))
    expect([...events.at(-1)!.resourceIds!].sort()).toEqual(['forward-a', 'image-a'])
  })

  it('rejects source accounts that do not match the actual login before assigning any configured role', async () => {
    const { plugin, client, events } = fixture()
    await savePolicy(plugin)
    expect(() => client.options.onEvent({ ...incoming(234567), self_id: 999999 })).toThrowError(expect.objectContaining({ code: 'INVALID_MESSAGE_EVENT' }))
    client.status = { ...client.status, accountId: null }
    expect(() => client.options.onEvent(incoming(234567))).toThrowError(expect.objectContaining({ code: 'INVALID_MESSAGE_EVENT' }))
    expect(events).toHaveLength(0)
  })

  it('rejects stale saves and malformed or cross-role tools without altering saved bytes or runtime permissions', async () => {
    const { plugin } = fixture()
    await savePolicy(plugin)
    const file = String(plugin.getPublicConfiguration().configurationPath)
    const before = readFileSync(file, 'utf8')
    const current = plugin.agentTypes
    const patches: JsonObject[] = [
      { expectedRevision: 0 }, { owners: ['01'] }, { administrators: '456789' },
      { agentTools: { 'qq.private': ['qq_send_group_message'], 'qq.group': [] } },
      { agentTools: { 'qq.private': [], 'qq.group': ['qq_get_cookies'] } },
      { agentTools: { unknown: [] } }, { extra: true },
    ]
    for (const patch of patches) {
      await expect(savePolicy(plugin, patch)).rejects.toThrow()
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(plugin.agentTypes).toEqual(current)
    }
  })

  it('preserves current policy, revision and blank-keeps-token behavior on partial connection PATCH', async () => {
    const { plugin, client } = fixture()
    await plugin.updateConfiguration({ endpoint: 'ws://127.0.0.1:3001/', accessToken: 'fixture-token' })
    await savePolicy(plugin)
    const before = plugin.getPublicConfiguration()
    await plugin.updateConfiguration({ displayName: 'Renamed', accessToken: '' })
    expect(plugin.getPublicConfiguration()).toMatchObject({ owners: before.owners, administrators: before.administrators, agentTools: before.agentTools, policyRevision: 1, tokenConfigured: true })
    expect(client.disconnect).toHaveBeenCalledTimes(2)
    const file = String(plugin.getPublicConfiguration().configurationPath)
    const saved = readFileSync(file, 'utf8')
    await plugin.connect()
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fixture-token', policyRevision: 1 }))
    await expect(plugin.updateConfiguration({ owners: [], administrators: [], agentTools: defaultAgentTools() })).rejects.toMatchObject({ code: 'INVALID_AGENT_POLICY' })
    expect(readFileSync(file, 'utf8')).toBe(saved)
    expect(client.disconnect).toHaveBeenCalledTimes(2)
  })

  it('checks fresh policy and actual account before using the original idempotent invocation chain', async () => {
    const { plugin, client, executeIdempotent } = fixture()
    await savePolicy(plugin)
    const scope = scopeFor(plugin)
    await expect(plugin.invokeScoped!('qq_send_private_message', { user_id: 234567, message: 'hello', request_id: 'host-agent:original-id' }, 'host-agent:original-id', scope)).resolves.toEqual({ message_id: 73 })
    expect(client.call).toHaveBeenCalledWith('send_private_msg', { user_id: 234567, message: 'hello', auto_escape: true }, { timeoutMs: 10000, readOnly: false })
    expect(executeIdempotent).toHaveBeenCalledWith('qq', 'send_private_msg', { user_id: 234567, message: 'hello', auto_escape: true }, 'host-agent:original-id', expect.any(Function), { instanceId: scope.instanceId, accountId: '123456' })
    await expect(plugin.invokeScoped!('qq_get_message', { message_id: 12 }, 'read-request', scope)).resolves.toEqual({ message_id: 73 })
    const calls = client.call.mock.calls.length
    await expect(plugin.invokeScoped!('qq_get_message', { message_id: 13 }, 'bad-message', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
    client.status = { ...client.status, accountId: '999999' }
    await expect(plugin.invokeScoped!('qq_get_message', { message_id: 12 }, 'wrong-account', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    client.status = { ...client.status, accountId: '123456' }
    await savePolicy(plugin, { agentTools: { 'qq.private': [], 'qq.group': [] } })
    await expect(plugin.invokeScoped!('qq_send_private_message', { user_id: 234567, message: 'hello', request_id: 'host-agent:next-id' }, 'host-agent:next-id', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    expect(plugin.agentTypes?.every(type => type.enabledTools.length === 0)).toBe(true)
    expect(client.call).toHaveBeenCalledTimes(calls)
  })

  it('registers a separate content tool without modifying the standard OneBot catalog', () => {
    const { plugin } = fixture()
    expect(plugin.tools).toHaveLength(40)
    expect(plugin.tools.filter(tool => tool.protocolAction)).toHaveLength(39)
    expect(plugin.tools.find(tool => tool.name === 'qq_view_received_image')).toMatchObject({ readOnly: true, destructive: false, resultFormat: 'content', title: '查看本会话图片' })
    expect(plugin.agentTypes?.every(type => type.availableTools.includes('qq_view_received_image') && type.defaultTools.includes('qq_view_received_image') && type.enabledTools.includes('qq_view_received_image'))).toBe(true)
  })

  it('preserves saved tool selections without implicitly enabling the new image extension', async () => {
    const { plugin, directory } = fixture()
    const agentTools = { 'qq.private': ['qq_get_message'], 'qq.group': ['qq_get_group_info'] }
    await savePolicy(plugin, { agentTools })
    const file = String(plugin.getPublicConfiguration().configurationPath)
    const bytes = readFileSync(file, 'utf8')
    const reopened = fixture(directory)
    expect(reopened.plugin.getPublicConfiguration().agentTools).toEqual(agentTools)
    expect(reopened.plugin.agentTypes?.every(type => !type.enabledTools.includes('qq_view_received_image'))).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    await expect(reopened.plugin.invokeScoped!('qq_view_received_image', { message_id: '12', image_id: 'image-a' }, 'blocked-image', scopeFor(reopened.plugin))).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    expect(reopened.client.call).not.toHaveBeenCalled()
  })

  it('requeries OneBot after reopening and returns images without creating an action receipt', async () => {
    const { plugin, directory } = fixture()
    await savePolicy(plugin)
    const reopened = fixture(directory)
    const message = { message_id: 12, message_type: 'private', self_id: 123456, sender: { user_id: 234567 }, message: [{ type: 'image', data: { file: 'image-a', url: 'https://cdn.example.test/image?signature=fixture-secret' } }] }
    reopened.client.call.mockResolvedValueOnce(message)
    const result = await reopened.plugin.invokeScoped!('qq_view_received_image', { message_id: '12', image_id: 'image-a' }, 'image-request', scopeFor(reopened.plugin))
    expect(result).toMatchObject({ content: [{ type: 'text' }, { type: 'image', mimeType: 'image/png', data: expect.any(String) }], structuredContent: { messageId: '12', imageId: 'image-a' } })
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(reopened.client.call).toHaveBeenCalledExactlyOnceWith('get_msg', { message_id: 12 }, { timeoutMs: 10000, readOnly: true })
    expect(imageDownload).toHaveBeenCalledExactlyOnceWith('https://cdn.example.test/image?signature=fixture-secret')
    expect(reopened.executeIdempotent).not.toHaveBeenCalled()
  })

  it('checks account, instance, message and resource references before a scoped image query', async () => {
    const { plugin, client } = fixture()
    const scope = scopeFor(plugin)
    for (const input of [{ message_id: '13', image_id: 'image-a' }, { message_id: '12', image_id: 'other-image' }, { message_id: '12', image_id: 'image-a', instance_id: '00000000-0000-4000-8000-000000000000' }]) await expect(plugin.invokeScoped!('qq_view_received_image', input, 'denied-image', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    client.status = { ...client.status, accountId: '999999' }
    await expect(plugin.invokeScoped!('qq_view_received_image', { message_id: '12', image_id: 'image-a' }, 'denied-account', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    expect(client.call).not.toHaveBeenCalled()
    expect(imageDownload).not.toHaveBeenCalled()
  })

  it('rejects cross-message image references even when each reference is independently granted', async () => {
    const { plugin, client } = fixture()
    const scope = { ...scopeFor(plugin), resourceIds: ['image-a', 'image-b'] }
    client.call.mockResolvedValueOnce({ message_id: 12, message_type: 'private', sender: { user_id: 234567 }, message: [{ type: 'image', data: { file: 'image-b', url: 'https://cdn.example.test/b' } }] })
    await expect(plugin.invokeScoped!('qq_view_received_image', { message_id: '12', image_id: 'image-a' }, 'wrong-image-pair', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    expect(imageDownload).not.toHaveBeenCalled()
  })

  it('lets owners read verified images while rejecting arbitrary local references', async () => {
    const { plugin, client, executeIdempotent } = fixture()
    const message = { message_id: 12, message_type: 'private', sender: { user_id: 234567 }, message: [{ type: 'image', data: { file: 'image-a', url: 'https://cdn.example.test/image' } }] }
    client.call.mockResolvedValue(message)
    await expect(plugin.invoke('qq_view_received_image', { message_id: '12', image_id: 'image-a' }, 'owner-image')).resolves.toHaveProperty('content')
    await expect(plugin.invoke('qq_view_received_image', { message_id: '12', image_id: '/etc/passwd' }, 'owner-local-path')).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
    expect(imageDownload).toHaveBeenCalledTimes(1)
    expect(executeIdempotent).not.toHaveBeenCalled()
  })

  it('rechecks a permission revoked while the image is downloading', async () => {
    const { plugin, client } = fixture()
    const scope = scopeFor(plugin)
    client.call.mockResolvedValueOnce({ message_id: 12, message_type: 'private', sender: { user_id: 234567 }, message: [{ type: 'image', data: { file: 'image-a', url: 'https://cdn.example.test/image' } }] })
    imageDownload.mockImplementationOnce(async () => {
      await savePolicy(plugin, { agentTools: { 'qq.private': [], 'qq.group': [] } })
      return { mimeType: 'image/png', bytes: Buffer.from('fixture') }
    })
    await expect(plugin.invokeScoped!('qq_view_received_image', { message_id: '12', image_id: 'image-a' }, 'revoked-image', scope)).rejects.toMatchObject({ code: 'AGENT_SCOPE_VIOLATION' })
  })

  it('preserves original structured event content and decodes only true CQ receive segments', () => {
    const { client, events } = fixture()
    const message = [{ type: 'image', data: { file: 'image-a', url: 'https://cdn.example.test/image' } }, { type: 'text', data: { text: '[CQ:image,file=not-granted]' } }]
    client.options.onEvent(incoming(234567, message))
    expect(events[0]?.content).toBe(message)
    expect(events[0]?.resourceIds).toEqual(['image-a'])
    const cq = '&#91;CQ:image,file=not-granted&#93; [CQ:image,file=image&#44;a&amp;b]'
    client.options.onEvent(incoming(234567, cq))
    expect(events[1]?.content).toBe(cq)
    expect(events[1]?.resourceIds).toEqual(['image,a&b'])
  })
})
