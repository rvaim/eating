import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { BackendPluginEntry, HarnessHostServices, JsonObject } from '@eating/plugin-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import imagesEntry from '../../../plugins/capabilities/image-generation/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { startImagesProviderFixture } from '../../../tests/fixtures/images-provider'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { fixtureToolTurns, startStickersModel } from '../../../tests/fixtures/stickers-model'
import type { FixtureModelAction } from '../../../tests/fixtures/stickers-model'
import { EatingHost } from './app'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected JSON object'); return value }
async function home() {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-images-integration-')))
  stops.push(async () => { if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-images-integration-')) throw new Error('Unsafe integration cleanup'); await rm(root, { recursive: true }) })
  return root
}
async function ownerApi(host: EatingHost) {
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), boot = await bootstrap.json(), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  return async (path: string, body?: object): Promise<JsonObject> => {
    const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-CSRF': boot.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return object(value)
  }
}
const grants = ['image_generate', 'image_job_get', 'image_get', 'image_list']
async function configure(api: Awaited<ReturnType<typeof ownerApi>>, provider: Awaited<ReturnType<typeof startImagesProviderFixture>>) {
  const current = await api('/plugins/image-generation/configuration')
  const configured = await api('/plugins/image-generation/configuration', { expectedRevision: current.revision, baseUrl: provider.baseUrl, model: 'fixture-images-model', apiKey: provider.apiKey, timeoutMs: 5000, size: '', quality: '', responseFormat: '' })
  expect(configured).toMatchObject({ apiKeyConfigured: true, ready: true }); expect(JSON.stringify(configured)).not.toContain(provider.apiKey)
  const directory = await api('/mcp')
  await api('/mcp', { operation: 'save-grants', input: { id: 'plugin.image-generation', expectedRevision: directory.revision, agentTypeIds: ['main'], toolNames: grants } })
}

describe('OpenAI Images through actual Host capability MCP', () => {
  it.each(['base64', 'url'] as const)('submits once, retrieves the generated %s asset, and retains jobs and data across Host restart', async mode => {
    const root = await home(), provider = await startImagesProviderFixture(mode); stops.push(() => provider.close())
    let services!: HarnessHostServices
    const harness: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { services = context.harness!; return { id: 'fixture', kind: 'harness', name: 'Fixture', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state: 'connected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, dispose: async () => {}, invoke: async () => null } } }
    let host = new EatingHost({ dataDirectory: root, entries: [imagesEntry, harness], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    let api = await ownerApi(host); await configure(api, provider)
    expect(provider.requests).toEqual([])
    const connection = services.getCapabilityMcpConnections({ agentId: 'images-main-fixture', agentTypeId: 'main' })[0]!
    const client = new Client({ name: 'images-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } })); stops.push(() => client.close())
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...grants].sort())
    const input = { prompt: '独立回环生图测试', request_id: 'images-stable-submit-0001' }
    const submitted = await client.callTool({ name: 'image_generate', arguments: input })
    expect(submitted.isError).toBe(false)
    const job = object(object(submitted.structuredContent).result)
    expect(typeof job.jobId).toBe('string')
    let done = job
    for (let count = 0; count < 10 && ['queued', 'running'].includes(String(done.status)); count++) {
      const status = await client.callTool({ name: 'image_job_get', arguments: { jobId: job.jobId!, waitMs: 1000 } })
      expect(status.isError).toBe(false); done = object(object(status.structuredContent).result)
    }
    expect(done).toMatchObject({ status: 'succeeded', assetIds: [expect.any(String)] })
    await client.callTool({ name: 'image_generate', arguments: input })
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]!.body).toEqual({ prompt: input.prompt, model: 'fixture-images-model', n: 1 })
    const assetId = (done.assetIds as string[])[0]!
    const image = await client.callTool({ name: 'image_get', arguments: { assetId } })
    expect(image.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', data: provider.image.toString('base64') })]))
    expect(JSON.stringify(image.structuredContent)).toContain('eating-asset://image-generation/')
    const listed = await client.callTool({ name: 'image_list', arguments: { limit: 1 } })
    expect(JSON.stringify(listed)).not.toContain(provider.image.toString('base64'))
    if (mode === 'url') { expect(provider.downloads).toHaveLength(1); expect(provider.downloads[0]!.authorization).toBeUndefined(); expect(provider.downloads[0]!.cookie).toBeUndefined() }
    await client.close(); await host.close()
    expect((await readFile(join(root, 'host/Eating.sqlite'))).includes(Buffer.from(provider.apiKey))).toBe(false)
    host = new EatingHost({ dataDirectory: root, entries: [imagesEntry, harness], port: 0, allowedUiOrigins: [] }); api = await ownerApi(host)
    expect(await api('/plugins/image-generation/manage', { operation: 'job', input: { jobId: job.jobId } })).toMatchObject({ status: 'succeeded' })
    expect(await api('/plugins/image-generation/manage', { operation: 'get', input: { assetId } })).toMatchObject({ image: { data: provider.image.toString('base64') } })
    expect(provider.requests).toHaveLength(1)
  })
})

describe('accepted generation ownership', () => {
  it('keeps an accepted paid task after Agent access ends, while denying further Agent reads', async () => {
    const root = await home(), provider = await startImagesProviderFixture('base64', { defer: true }); stops.push(() => provider.close())
    let services!: HarnessHostServices
    const harness: BackendPluginEntry = { id: 'fixture', kind: 'harness', storageDirectory: 'fixture', create(context) { services = context.harness!; return { id: 'fixture', kind: 'harness', name: 'Fixture', version: '1.0.0', tools: [], capabilities: [], getStatus: () => ({ state: 'connected', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }), getPublicConfiguration: () => ({}), updateConfiguration: async () => ({}), connect: async () => {}, disconnect: async () => {}, dispose: async () => {}, invoke: async () => null } } }
    const host = new EatingHost({ dataDirectory: root, entries: [imagesEntry, harness], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host); await configure(api, provider)
    const connection = services.getCapabilityMcpConnections({ agentId: 'ending-agent', agentTypeId: 'main' })[0]!
    const client = new Client({ name: 'accepted-job-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } })); stops.push(() => client.close())
    const submitted = await client.callTool({ name: 'image_generate', arguments: { prompt: '持续至Agent结束后的测试任务', request_id: 'accepted-generation-stable-0001' } })
    expect(submitted.isError).toBe(false)
    const job = object(object(submitted.structuredContent).result)
    for (let i = 0; i < 100 && !provider.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(provider.requests).toHaveLength(1)
    services.revokeAgentAccess('ending-agent')
    await expect(client.callTool({ name: 'image_job_get', arguments: { jobId: job.jobId! } })).rejects.toThrow()
    provider.release()
    const done = await api('/plugins/image-generation/manage', { operation: 'job', input: { jobId: job.jobId, waitMs: 2000 } })
    expect(done).toMatchObject({ status: 'succeeded' }); expect(provider.requests).toHaveLength(1)
  })
})

describe.skipIf(!process.env.EATING_DSH_TEST_SYSTEM_BIN)('system DSH uses OpenAI Images MCP jobs', () => {
  it('runs generation, polling and native image preview with one provider call and no QQ sends', async () => {
    const root = await home(), provider = await startImagesProviderFixture(); stops.push(() => provider.close())
    const onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    const prefix = 'mcp__plugin_image_generation__'
    const model = await startStickersModel((request): FixtureModelAction => {
      expect((request.tools ?? []).map(tool => tool.function?.name).sort()).toEqual(['eating_delegate_task', 'eating_list_agent_types', ...grants.map(name => prefix + name)].sort())
      const turns = fixtureToolTurns(request)
      if (!turns.length) return { name: prefix + 'image_generate', arguments: { prompt: 'NATIVE-IMAGES-FIXTURE', request_id: 'native-images-stable-0001' } }
      const last = turns.at(-1)!, value = object(JSON.parse(last.text.split('\n')[0]!))
      if (last.name.endsWith('__image_generate')) return { name: prefix + 'image_job_get', arguments: { jobId: value.jobId!, waitMs: 1000 } }
      if (last.name.endsWith('__image_job_get')) {
        if (value.status !== 'succeeded') return { name: prefix + 'image_job_get', arguments: { jobId: value.jobId!, waitMs: 1000 } }
        return { name: prefix + 'image_get', arguments: { assetId: (value.assetIds as string[])[0]! } }
      }
      expect(last.name).toBe(prefix + 'image_get')
      expect(JSON.stringify(value)).toContain('eating-asset://image-generation/')
      expect(JSON.stringify(request.messages)).toContain('data:image/png;base64,')
      return '图片已由生图工具生成，未向QQ发送。'
    }); stops.push(() => model.close())
    let plugin!: DshPlugin
    const dsh: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { plugin = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return plugin } }
    const host = new EatingHost({ dataDirectory: root, entries: [qqEntry, imagesEntry, dsh], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const api = await ownerApi(host); await configure(api, provider)
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, forwardToHarness: true, autoConnect: false }); await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-images-controller', apiKey: model.apiKey, timeoutMs: 15000, autoConnect: false })
    await api('/plugins/dsh/manage', { operation: 'save-model-capabilities', input: { expectedRevision: 0, imageInput: true } })
    await api('/plugins/dsh/connect', {})
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: 99901, message: '仅生成测试图片并核对结果，不发送到聊天。' })
    const deadline = Date.now() + 30000
    while (!(host.harness.getStatus().accepted === 1 && plugin.isReady()) && !model.errors.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    expect(model.errors).toEqual([]); expect(plugin.isReady()).toBe(true)
    expect(provider.requests).toHaveLength(1); expect(model.requests.length).toBeGreaterThanOrEqual(4)
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toEqual([])
    await host.close()
  }, 60000)
})
