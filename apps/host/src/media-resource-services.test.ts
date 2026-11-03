import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackendPlugin, BackendPluginEntry, HarnessHostServices, PluginResourceServices } from '@eating/plugin-sdk'
import { createImageFixturePng } from '../../../tests/fixtures/image'
import { EatingHost } from './app'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function fixture() {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-host-media-')))
  stops.push(async () => {
    if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-host-media-')) throw new Error('Unsafe Host media cleanup')
    await rm(root, { recursive: true })
  })
  let resources!: PluginResourceServices, services!: HarnessHostServices, connected = true, afterRead: (() => void) | undefined
  const bytes = createImageFixturePng()
  function plugin(id: string, kind: BackendPlugin['kind']): BackendPlugin {
    return { id, kind, name: 'Media fixture', version: '1.0.0', tools: [], capabilities: [],
      getStatus: () => ({ state: connected ? 'connected' : 'disconnected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
      getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, dispose: async () => {}, invoke: async () => null }
  }
  const source: BackendPluginEntry = { id: 'fixture-images', kind: 'capability', storageDirectory: 'images', create: () => ({ ...plugin('fixture-images', 'capability'), invokeCapability: async () => null,
    tools: [{ name: 'image_get', title: 'Image', description: '', inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'content' }],
    media: { readTool: 'image_get', readAsset: async () => ({ mimeType: 'image/png', data: bytes.toString('base64') }),
      getAsset: async () => ({ mimeType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        readBytes: async () => { afterRead?.(); return bytes }, localFile: async () => '/fixture/source.png' }) } }) }
  const caller: BackendPluginEntry = { id: 'fixture-chat', kind: 'communication', storageDirectory: 'chat-bot', create: context => { resources = context.resources!; return plugin('fixture-chat', 'communication') } }
  const harness: BackendPluginEntry = { id: 'fixture-harness', kind: 'harness', storageDirectory: 'harness', create: context => { services = context.harness!; return plugin('fixture-harness', 'harness') } }
  const host = new EatingHost({ dataDirectory: root, entries: [source, caller, harness], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
  await host.listen()
  const scope = { agentId: 'fixture-child', agentTypeId: 'main' }, reference = { pluginId: 'fixture-images', assetId: 'opaque-id' }
  return { host, resources, services, scope, reference, bytes, connected: (value: boolean) => { connected = value }, afterRead: (callback: () => void) => { afterRead = callback } }
}
describe('Host media service source permissions and revocation', () => {
  it('requires the current source read-tool grant and revokes an existing lease when Agent access ends', async () => {
    const f = await fixture()
    await expect(f.resources.getAsset(f.reference, f.scope)).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    f.services.getCapabilityMcpConnections(f.scope)
    const lease = await f.resources.getAsset(f.reference, f.scope)
    expect(Buffer.from(await lease.readBytes())).toEqual(f.bytes)
    f.services.revokeAgentAccess(f.scope.agentId)
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    await expect(lease.localFile!()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
  })
  it('revokes owner sending leases when Host shutdown starts', async () => {
    const f = await fixture(), lease = await f.resources.getAsset(f.reference)
    await f.host.close()
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
  })
  it('rechecks authorization after a provider read and refuses sources disconnected before sending', async () => {
    const f = await fixture(); f.services.getCapabilityMcpConnections(f.scope)
    f.afterRead(() => f.services.revokeAgentAccess(f.scope.agentId))
    await expect(f.resources.getAsset(f.reference, f.scope)).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    const next = await fixture(), lease = await next.resources.getAsset(next.reference)
    next.connected(false)
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
  })
})
