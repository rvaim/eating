import { basename, dirname, join, resolve } from 'node:path'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInvocationScope, BackendPlugin, ConnectionStatus, HarnessEvent, HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import entry from './server'
import { defaultAgentTools } from './backend/agent-policy'

const transport = vi.hoisted(() => ({ clients: [] as Array<{ options: { onEvent: (event: JsonObject) => void }; call: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; status: ConnectionStatus }> }))
vi.mock('./backend/onebot', () => ({ OneBotClient: class {
  options: { onEvent: (event: JsonObject) => void }
  call = vi.fn(async () => ({ message_id: 73 }))
  disconnect = vi.fn(async () => {})
  status: ConnectionStatus = { state: 'connected', accountId: '123456', accountName: 'Fixture', lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }
  constructor(options: { onEvent: (event: JsonObject) => void }) { this.options = options; transport.clients.push(this) }
  getStatus() { return this.status }
  async connect() {}
  async dispose() {}
} }))

const roots: string[] = []
const plugins: BackendPlugin[] = []
afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.dispose()
  transport.clients.splice(0)
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
    const result = await savePolicy(plugin, { owners: ['234567', '345678', '234567'] })
    expect(result).toMatchObject({ owners: ['234567', '345678'], administrators: ['234567', '456789'], policyRevision: 1 })
    expect(client.disconnect).not.toHaveBeenCalled()
    expect(plugin.getAgentIdentity!()).toEqual({ owners: ['234567', '345678'], administrators: ['234567', '456789'] })
    expect(plugin.agentTypes).toHaveLength(2)
    expect(plugin.agentInstructions?.[0]?.id).toBe('qq.instructions')
  })

  it('reads old configuration without rewriting bytes or silently assigning the login as owner', async () => {
    const { plugin, directory } = fixture()
    const file = resolve(String(plugin.getPublicConfiguration().configurationPath))
    expect(dirname(file)).toBe(resolve(directory, 'accounts', String(plugin.getPublicConfiguration().instanceId)))
    const legacy = JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-26T00:00:00Z', configuration: { displayName: 'Old', endpoint: 'ws://127.0.0.1:3001/', accessToken: 'fixture-token', autoConnect: false, forwardToHarness: true, receiveGroups: true, timeoutMs: 10000 } })
    writeFileSync(file, legacy)
    const reopened = fixture(directory)
    expect(reopened.plugin.getPublicConfiguration()).toMatchObject({ owners: [], administrators: [], policyRevision: 0, tokenConfigured: true })
    expect(reopened.plugin.getPublicConfiguration()).not.toHaveProperty('accessToken')
    expect(readFileSync(file, 'utf8')).toBe(legacy)
    reopened.client.options.onEvent(incoming(234567))
    expect(reopened.events[0]?.source).toEqual({ trust: 'external', kind: 'private', senderRole: 'user' })
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

  it('preserves permissions, revision and blank-keeps-token behavior when an older connection form saves', async () => {
    const { plugin, client } = fixture()
    await plugin.updateConfiguration({ endpoint: 'ws://127.0.0.1:3001/', accessToken: 'fixture-token' })
    await savePolicy(plugin)
    const before = plugin.getPublicConfiguration()
    await plugin.updateConfiguration({ displayName: 'Renamed', accessToken: '', policyRevision: 0 })
    expect(plugin.getPublicConfiguration()).toMatchObject({ owners: before.owners, administrators: before.administrators, agentTools: before.agentTools, policyRevision: 1, tokenConfigured: true })
    expect(client.disconnect).toHaveBeenCalledTimes(2)
    const file = String(plugin.getPublicConfiguration().configurationPath)
    const saved = readFileSync(file, 'utf8')
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
})
