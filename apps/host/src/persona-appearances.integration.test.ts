import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { composeAgentPrompt, isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, HarnessHostServices, HarnessOwnerConfiguration, JsonObject, JsonValue } from '@eating/plugin-sdk'
import imagesEntry from '../../../plugins/capabilities/image-generation/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { createImageFixturePng, createLargeImageFixturePng } from '../../../tests/fixtures/image'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { EatingHost } from './app'

const stops: Array<() => unknown | Promise<unknown>> = []

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected JSON object')
  return value
}

async function createHome(): Promise<string> {
  const parent = await realpath(tmpdir())
  const dir = await realpath(await mkdtemp(join(parent, 'eating-persona-integration-')))
  stops.push(async () => {
    if (await realpath(dir) !== dir || dirname(dir) !== parent || !basename(dir).startsWith('eating-persona-integration-')) {
      throw new Error('Unsafe integration cleanup')
    }
    await rm(dir, { recursive: true })
  })
  return dir
}

async function createHarnessHost(entries: readonly BackendPluginEntry[] = []) {
  const home = await createHome()
  let harnessServices!: HarnessHostServices
  let connected = false
  let connectCalls = 0
  let disconnectCalls = 0
  const harnessEntry: BackendPluginEntry = {
    id: 'fixture-harness',
    kind: 'harness',
    storageDirectory: 'fixture-harness',
    create: context => {
      harnessServices = context.harness!
      return {
        id: 'fixture-harness',
        kind: 'harness',
        name: 'Fixture Harness',
        version: '1.0.0',
        tools: [],
        capabilities: [],
        getStatus: () => ({
          state: connected ? 'connected' : 'disconnected',
          accountId: null,
          accountName: null,
          lastError: null,
          connectedAt: null,
          lastEventAt: null,
          reconnectAttempt: 0,
        }),
        getPublicConfiguration: () => ({}),
        updateConfiguration: async () => ({}),
        connect: async () => {
          connected = true
          connectCalls += 1
        },
        disconnect: async () => {
          connected = false
          disconnectCalls += 1
        },
        dispose: async () => {},
        invoke: async () => null,
      }
    },
  }

  const host = new EatingHost({ dataDirectory: home, entries: [harnessEntry, ...entries], port: 0, allowedUiOrigins: [] })
  stops.push(() => host.close())
  const url = await host.listen()
  const bootResponse = await fetch(`${url}/api/bootstrap`)
  expect(bootResponse.status).toBe(200)
  const cookie = bootResponse.headers.get('set-cookie')!.split(';')[0]!
  const bootBody = object(await bootResponse.json())
  const csrf = String(bootBody.csrfToken)

  async function api(path: string, body?: JsonValue, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(`${url}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        'X-Eating-Csrf': csrf,
        Origin: url,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, headers: response.headers, body: object(await response.json()) }
  }

  return {
    home,
    host,
    url,
    cookie,
    csrf,
    api,
    services: () => harnessServices,
    counts: () => ({ connectCalls, disconnectCalls }),
  }
}

async function connectMcp(url: string, headers: Readonly<Record<string, string>>, origin: string) {
  const client = new Client({ name: 'persona-appearance-mcp-test', version: '1.0.0' })
  stops.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { ...headers, Origin: origin } },
  }))
  return client
}

describe('Persona appearance integration', () => {
  it('injects implicit appearance instructions only when active persona has reference images and treats label syntax literally', () => {
    const baseConfig: HarnessOwnerConfiguration = {
      revision: 1,
      prompts: [
        { id: 'common', title: '通用', body: '通用 {{当前时间}} / {{人格名称}}', revision: 1, updatedAt: null, scope: 'common', source: 'owner' },
        { id: 'main', title: '主', body: '主协调', revision: 1, updatedAt: null, scope: 'main', source: 'owner' },
      ],
      activePersona: { id: 'p-1', name: '小橘', body: '开朗元气角色', revision: 1, createdAt: '', updatedAt: '' },
      agentTypes: [],
      pluginInstructions: [],
      bindings: { 主人: '[]', 管理员: '[]' },
    }

    const withoutImages = composeAgentPrompt(baseConfig, null, { 当前时间: '2026-11-21T00:00:00Z' })
    expect(withoutImages.systemPrompt).not.toContain('persona_appearance_list')
    expect(withoutImages.systemPrompt).not.toContain('外貌参考图')
    expect(withoutImages.layers.some(layer => layer.id === 'persona:appearance')).toBe(false)

    const id1 = '11111111-1111-4111-8111-111111111111'
    const withImages = composeAgentPrompt({
      ...baseConfig,
      activePersonaAppearances: [{
        id: id1,
        label: '正面设定 {{未定义模板}}',
        mimeType: 'image/png',
        byteLength: 68,
        width: 512,
        height: 512,
        sha256: 'a'.repeat(64),
        createdAt: '2026-11-21T00:00:00.000Z',
      }],
    }, null, { 当前时间: '2026-11-21T00:00:00Z' })

    expect(withImages.systemPrompt).toContain(id1)
    expect(withImages.systemPrompt).toContain('正面设定 {{未定义模板}}')
    expect(withImages.systemPrompt).toContain('persona_appearance_list')
    expect(withImages.systemPrompt).toContain('persona_appearance_get')
    expect(withImages.systemPrompt).toContain('kind:"persona"')
    expect(withImages.layers.some(layer => layer.id === 'persona:p-1' && layer.body.includes(id1))).toBe(true)
  })

  it('enforces auth, CRUD/reorder/delete/cascade HTTP routes, hides builtin MCP from /api/mcp, and remounts Harness only on 0<-> >0 transitions', async () => {
    const f = await createHarnessHost()
    expect((await f.api('/plugins/fixture-harness/connect', {})).status).toBe(200)
    const initialCounts = f.counts()

    const personaRes = await f.api('/personas', { name: '小蓝', body: '短发蓝瞳' })
    expect(personaRes.status).toBe(201)
    const personaId = String(object(personaRes.body.persona).id)
    expect(personaId).toMatch(/^[0-9a-f-]{36}$/i)

    expect((await fetch(`${f.url}/api/personas/${personaId}/appearances`)).status).toBe(401)
    expect((await fetch(`${f.url}/api/personas/${personaId}/appearances`, {
      method: 'POST',
      headers: { Cookie: f.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: createImageFixturePng().toString('base64') }),
    })).status).toBe(403)

    const png1 = createImageFixturePng([1, 2, 3, 255])
    const png2 = createImageFixturePng([4, 5, 6, 255])

    // Uploading to an inactive persona does not remount the connected harness.
    const up1 = await f.api(`/personas/${personaId}/appearances`, { data: png1.toString('base64'), mimeType: 'image/png', label: '立绘1', expectedRevision: 0 })
    expect(up1.status).toBe(201)
    const img1Id = String(object(up1.body.image).id)
    expect(f.counts()).toEqual(initialCounts)

    // Builtin MCP never leaks to /api/mcp snapshot.
    const mcpSnapshot = await f.api('/mcp')
    expect(mcpSnapshot.status).toBe(200)
    expect(JSON.stringify(mcpSnapshot.body)).not.toContain('persona_appearance')

    // Inactive persona -> Harness connections do not expose persona_appearance.
    expect(f.services().getCapabilityMcpConnections({ agentId: 'main-agent', agentTypeId: 'main' }).map(c => c.serverName)).not.toContain('persona_appearance')

    // Activating persona with images triggers Harness remount and exposes persona_appearance MCP.
    const activateRes = await f.api(`/personas/${personaId}/activate`, { enabled: true, expectedRevision: 1 })
    expect(activateRes.status).toBe(200)
    expect(f.counts().disconnectCalls).toBe(initialCounts.disconnectCalls + 1)
    expect(f.counts().connectCalls).toBe(initialCounts.connectCalls + 1)

    // Adding a second image while active does NOT transition 0 <-> >0, so no extra remount.
    const up2 = await f.api(`/personas/${personaId}/appearances`, { data: png2.toString('base64'), label: '立绘2', expectedRevision: Number(up1.body.revision) })
    expect(up2.status).toBe(201)
    const img2Id = String(object(up2.body.image).id)
    expect(f.counts().disconnectCalls).toBe(initialCounts.disconnectCalls + 1)

    // Content endpoint returns binary image with private no-store headers.
    const contentRes = await fetch(`${f.url}/api/personas/${personaId}/appearances/${img1Id}/content`, { headers: { Cookie: f.cookie } })
    expect(contentRes.status).toBe(200)
    expect(contentRes.headers.get('cache-control')).toBe('private, no-store')
    expect(contentRes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await contentRes.arrayBuffer())).toEqual(png1)

    // Relabel & Reorder
    const labelRes = await f.api(`/personas/${personaId}/appearances/${img1Id}/label`, { label: '更新后立绘1', expectedRevision: Number(up2.body.revision) })
    expect(labelRes.status).toBe(200)
    const reorderRes = await f.api(`/personas/${personaId}/appearances/reorder`, { imageIds: [img2Id, img1Id], expectedRevision: Number(labelRes.body.revision) })
    expect(reorderRes.status).toBe(200)
    expect((reorderRes.body.images as JsonObject[]).map(item => item.id)).toEqual([img2Id, img1Id])

    // Read-only MCP tool calls via real StreamableHTTP MCP connection
    const conn = f.services().getCapabilityMcpConnections({ agentId: 'main-agent', agentTypeId: 'main' }).find(c => c.serverName === 'persona_appearance')
    expect(conn).toBeDefined()
    const client = await connectMcp(conn!.url, conn!.headers, f.url)
    const listed = CallToolResultSchema.parse(await client.callTool({ name: 'persona_appearance_list', arguments: {} }))
    expect(listed.isError).toBe(false)
    expect(listed.structuredContent).toMatchObject({
      result: {
        personaId,
        personaName: '小蓝',
        images: [
          { imageId: img2Id, label: '立绘2' },
          { imageId: img1Id, label: '更新后立绘1' },
        ],
      },
    })
    const got = CallToolResultSchema.parse(await client.callTool({ name: 'persona_appearance_get', arguments: { imageId: img1Id } }))
    expect(got.isError).toBe(false)
    expect(got.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: png1.toString('base64') })
    expect(got.structuredContent).toMatchObject({ imageId: img1Id, imageGenerateSource: { kind: 'persona', imageId: img1Id } })
    await client.close()

    // Deleting 1 of 2 images keeps hasImages true -> no remount yet.
    const del1 = await f.api(`/personas/${personaId}/appearances/${img2Id}/delete`, { confirmed: true, expectedRevision: Number(reorderRes.body.revision) })
    expect(del1.status).toBe(200)
    expect(f.counts().disconnectCalls).toBe(initialCounts.disconnectCalls + 1)

    // Deleting last image transitions >0 -> 0 -> remounts Harness and removes MCP connection.
    const delLast = await f.api(`/personas/${personaId}/appearances/${img1Id}/delete`, { confirmed: true, expectedRevision: Number(del1.body.revision) })
    expect(delLast.status).toBe(200)
    expect(f.counts().disconnectCalls).toBe(initialCounts.disconnectCalls + 2)
    expect(f.services().getCapabilityMcpConnections({ agentId: 'main-agent', agentTypeId: 'main' }).map(c => c.serverName)).not.toContain('persona_appearance')

    // Upload again then delete persona -> cascade removes appearance files & index entries.
    const upAgain = await f.api(`/personas/${personaId}/appearances`, { data: png1.toString('base64'), expectedRevision: Number(delLast.body.revision) })
    const imgAgainId = String(object(upAgain.body.image).id)
    const deactivate = await f.api(`/personas/${personaId}/activate`, { enabled: false, expectedRevision: 2 })
    expect(deactivate.status).toBe(200)
    const deletePersona = await f.api(`/personas/${personaId}/delete`, { confirmed: true, expectedRevision: 1 })
    expect(deletePersona.status).toBe(200)
    expect((await f.api(`/personas/${personaId}/appearances`)).status).toBe(404)
    expect(() => f.host.personaAppearances.readImageBytes(personaId, imgAgainId)).toThrowError(expect.objectContaining({ code: 'PERSONA_APPEARANCE_NOT_FOUND' }))
  })

  it('links persona references into image_generate (single image / multi image[]), blocks inactive personas and batch caps, and blocks direct QQ sends', async () => {
    const png1 = createImageFixturePng([11, 22, 33, 255])
    const png2 = createImageFixturePng([44, 55, 66, 255])
    const out = createImageFixturePng([77, 88, 99, 255])
    const editRequests: Array<{ fileParts: Array<{ field: string; bytes: Buffer }> }> = []

    const provider = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        const contentType = String(req.headers['content-type'] ?? '')
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean) ?? ''
        const fileParts: Array<{ field: string; bytes: Buffer }> = []
        for (const raw of body.toString('latin1').split('--' + boundary)) {
          const section = raw.replace(/^\r\n/, '').replace(/\r\n$/, '')
          if (!section || section === '--') continue
          const split = section.indexOf('\r\n\r\n')
          if (split < 0) continue
          const headers = section.slice(0, split)
          const data = Buffer.from(section.slice(split + 4), 'latin1')
          const name = /name="([^"]+)"/.exec(headers)?.[1]
          if (name && /filename="/.test(headers)) fileParts.push({ field: name, bytes: data })
        }
        editRequests.push({ fileParts })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ b64_json: out.toString('base64') }] }))
      })()
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    stops.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())) })
    const addr = provider.address()
    if (!addr || typeof addr === 'string') throw new Error('Missing provider address')

    const onebot = await startOneBotFixture()
    stops.push(() => onebot.close())

    const f = await createHarnessHost([imagesEntry, qqEntry])
    expect((await f.api('/plugins/fixture-harness/connect', {})).status).toBe(200)
    expect((await f.api('/plugins/image-generation/configuration', { expectedRevision: 0, baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: 'edit-model', apiKey: 'test-key' })).status).toBe(200)
    expect((await f.api('/plugins/image-generation/connect', {})).status).toBe(200)
    expect((await f.api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false })).status).toBe(200)
    expect((await f.api('/plugins/qq/connect', {})).status).toBe(200)

    const pActiveRes = await f.api('/personas', { name: '主角', body: '主设定' })
    const pActiveId = String(object(pActiveRes.body.persona).id)
    const pInactiveRes = await f.api('/personas', { name: '备用', body: '备用设定' })
    const pInactiveId = String(object(pInactiveRes.body.persona).id)
    expect((await f.api(`/personas/${pActiveId}/activate`, { enabled: true, expectedRevision: Number(object(pInactiveRes.body.snapshot).revision) })).status).toBe(200)

    const upA1 = await f.api(`/personas/${pActiveId}/appearances`, { data: png1.toString('base64'), expectedRevision: 0 })
    const upA2 = await f.api(`/personas/${pActiveId}/appearances`, { data: png2.toString('base64'), expectedRevision: Number(upA1.body.revision) })
    const upInactive = await f.api(`/personas/${pInactiveId}/appearances`, { data: png1.toString('base64'), expectedRevision: Number(upA2.body.revision) })

    const activeImg1 = String(object(upA1.body.image).id)
    const activeImg2 = String(object(upA2.body.image).id)
    const inactiveImg = String(object(upInactive.body.image).id)

    const imgConn = f.services().getCapabilityMcpConnections({ agentId: 'worker-1', agentTypeId: 'main' }).find(c => c.id === 'plugin.image-generation')
    expect(imgConn).toBeDefined()
    const imgClient = await connectMcp(imgConn!.url, imgConn!.headers, f.url)

    // Single persona source -> multipart field "image"
    const singleCall = CallToolResultSchema.parse(await imgClient.callTool({
      name: 'image_generate',
      arguments: { prompt: 'draw self single', request_id: 'host-persona-single-0001', source: { kind: 'persona', imageId: activeImg1 } },
    }))
    expect(singleCall.isError).toBe(false)
    let job = object(object(singleCall.structuredContent).result)
    for (let i = 0; i < 20 && ['queued', 'running'].includes(String(job.status)); i++) {
      job = (await f.api('/plugins/image-generation/manage', { operation: 'job', input: { jobId: String(job.jobId), waitMs: 500 } })).body
    }
    expect(job.status).toBe('succeeded')
    expect(editRequests).toHaveLength(1)
    expect(editRequests[0]!.fileParts.map(p => [p.field, p.bytes])).toEqual([['image', png1]])

    // Multi persona sources -> multipart field "image[]"
    const multiCall = CallToolResultSchema.parse(await imgClient.callTool({
      name: 'image_generate',
      arguments: {
        prompt: 'draw self multi',
        request_id: 'host-persona-multi-0001',
        sources: [{ kind: 'persona', imageId: activeImg1 }, { kind: 'persona', imageId: activeImg2 }],
      },
    }))
    expect(multiCall.isError).toBe(false)
    let multiJob = object(object(multiCall.structuredContent).result)
    for (let i = 0; i < 20 && ['queued', 'running'].includes(String(multiJob.status)); i++) {
      multiJob = (await f.api('/plugins/image-generation/manage', { operation: 'job', input: { jobId: String(multiJob.jobId), waitMs: 500 } })).body
    }
    expect(multiJob.status).toBe('succeeded')
    expect(editRequests).toHaveLength(2)
    expect(editRequests[1]!.fileParts.map(p => [p.field, p.bytes])).toEqual([['image[]', png1], ['image[]', png2]])

    // Inactive persona's imageId must fail without touching provider
    const inactiveCall = CallToolResultSchema.parse(await imgClient.callTool({
      name: 'image_generate',
      arguments: { prompt: 'inactive ref', request_id: 'host-persona-inactive-0001', source: { kind: 'persona', imageId: inactiveImg } },
    }))
    expect(inactiveCall.isError).toBe(true)
    expect(editRequests).toHaveLength(2)

    // Exceeding batchBytes (maxImageMiB=2 -> 2 MiB per image, 4 MiB batch limit; 3x 1600 KiB = 4.6875 MiB) rejects cleanly
    expect((await f.api('/image-limits', { expectedRevision: 0, maxImageMiB: 2 })).status).toBe(200)
    const big = createLargeImageFixturePng(1600 * 1024)
    const big1 = await f.api(`/personas/${pActiveId}/appearances`, { data: big.toString('base64'), expectedRevision: Number(upInactive.body.revision) })
    const big2 = await f.api(`/personas/${pActiveId}/appearances`, { data: big.toString('base64'), expectedRevision: Number(big1.body.revision) })
    const big3 = await f.api(`/personas/${pActiveId}/appearances`, { data: big.toString('base64'), expectedRevision: Number(big2.body.revision) })
    const capCall = CallToolResultSchema.parse(await imgClient.callTool({
      name: 'image_generate',
      arguments: {
        prompt: 'exceed batch cap',
        request_id: 'host-persona-batchcap-0001',
        sources: [big1, big2, big3].map(r => ({ kind: 'persona', imageId: String(object(r.body.image).id) })),
      },
    }))
    expect(capCall.isError).toBe(true)
    expect(editRequests).toHaveLength(2)

    // QQ send_private_message refuses direct persona image references
    const badQqSend = await f.api('/plugins/qq/invoke', {
      name: 'qq_send_private_message',
      requestId: 'qq-persona-refuse-0001',
      confirmed: true,
      arguments: {
        user_id: '987654321',
        message: [{ type: 'image', data: { file: `eating-asset://host.persona-appearance/${activeImg1}` } }],
      },
    })
    expect(badQqSend.status).toBeGreaterThanOrEqual(400)
    expect(onebot.requests.filter(r => r.action === 'send_private_msg')).toHaveLength(0)
  }, 30000)
})
