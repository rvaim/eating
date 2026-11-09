import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { imageLimits, isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject, PluginResourceServices } from '@eating/plugin-sdk'
import imagesEntry from '../../../plugins/capabilities/image-generation/src/server'
import qqEntry from '../../../plugins/communication/qq/src/server'
import stickersEntry from '../../../plugins/capabilities/stickers/src/server'
import { downloadQQImage } from '../../../plugins/communication/qq/src/backend/media'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { createLargeImageFixturePng } from '../../../tests/fixtures/image'
import { ImageLimitsService } from './image-limits'
import { EatingHost } from './app'
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected image limit object'); return value }
async function temporaryHome() {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-image-limits-')))
  stops.push(async () => { if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-image-limits-')) throw new Error('Unsafe image limit cleanup'); await rm(home, { recursive: true }) })
  return home
}

describe('owner-controlled image size policy', () => {
  it('defaults to 10 MiB without writing, validates strict storage and saves with CAS', () => {
    const state = new Map<string, string>(), store = { getSetting: (key: string) => state.get(key) ?? null, setSetting: (key: string, value: string) => { state.set(key, value) } }
    const service = new ImageLimitsService(store)
    expect(service.snapshot()).toMatchObject({ maxImageMiB: 10, imageBytes: 10 * 1024 * 1024, batchBytes: 20 * 1024 * 1024 })
    expect(state.size).toBe(0)
    expect(service.save({ expectedRevision: 0, maxImageMiB: 25 })).toMatchObject({ revision: 1, maxImageMiB: 25 })
    expect(() => service.save({ expectedRevision: 0, maxImageMiB: 10 })).toThrow(expect.objectContaining({ code: 'IMAGE_LIMITS_CONFLICT' }))
    const bytes = state.get('host:image-limits')
    for (const maxImageMiB of [0, 51, 10.5]) expect(() => service.save({ expectedRevision: 1, maxImageMiB })).toThrow()
    expect(state.get('host:image-limits')).toBe(bytes)
    state.set('host:image-limits', '{"schemaVersion":0}')
    expect(() => new ImageLimitsService(store)).toThrow(expect.objectContaining({ code: 'IMAGE_LIMITS_CORRUPTED' }))
    expect(state.get('host:image-limits')).toBe('{"schemaVersion":0}')
  })
  it('uses a coherent derived budget for the full supported range', () => {
    for (const max of [1, 10, 50]) {
      const limits = imageLimits(max)
      expect(limits.encodedBytes).toBeGreaterThanOrEqual(Math.ceil(limits.batchBytes / 3) * 4)
      expect(limits.wireBytes).toBeGreaterThanOrEqual(limits.encodedBytes + 1024 * 1024)
      expect(limits.wireBytes).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    }
  })
  it('requires an owner session and CSRF to change the image policy', async () => {
    const host = new EatingHost({ dataDirectory: await temporaryHome(), entries: [], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const url = await host.listen()
    expect((await fetch(url + '/api/image-limits')).status).toBe(401)
    const boot = await fetch(url + '/api/bootstrap'), cookie = boot.headers.get('set-cookie')!.split(';')[0]!, token = (await boot.json()).csrfToken
    const save = (csrf?: string) => fetch(url + '/api/image-limits', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-Eating-Csrf': csrf } : {}) }, body: JSON.stringify({ expectedRevision: 0, maxImageMiB: 12 }) })
    expect((await save()).status).toBe(403)
    expect(host.imageLimits.snapshot().maxImageMiB).toBe(10)
    expect((await save(token)).status).toBe(200)
    expect((await fetch(url + '/api/image-limits', { headers: { Cookie: cookie } })).status).toBe(200)
  })
  it.each([10, 12])('generates and sends a %i MiB asset, revokes a lease on limit changes and preserves the stored asset across restart', async size => {
    const home = await temporaryHome()
    const bytes = createLargeImageFixturePng(size * 1024 * 1024), requests: JsonObject[] = []
    const provider = createServer((request, response) => { void (async () => {
      if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length }); response.end(bytes); return }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }))
    })() }); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); stops.push(() => new Promise<void>(resolve => provider.close(() => resolve())))
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const onebot = await startOneBotFixture(); stops.push(() => onebot.close())
    let resources!: PluginResourceServices
    const qq: BackendPluginEntry = { ...qqEntry, create(context) { resources = context.resources!; return qqEntry.create(context) } }
    const entries = [imagesEntry, qq, stickersEntry]
    let host = new EatingHost({ dataDirectory: home, entries, port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const owner = async () => {
      const url = await host.listen(), response = await fetch(url + '/api/bootstrap'), boot = await response.json(), cookie = response.headers.get('set-cookie')!.split(';')[0]!
      return async (path: string, input?: object) => {
        const r = await fetch(url + '/api' + path, { method: input ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-Csrf': boot.csrfToken, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
        return { status: r.status, body: object(await r.json()) }
      }
    }
    let api = await owner()
    if (size !== 10) expect((await api('/image-limits', { expectedRevision: 0, maxImageMiB: size })).status).toBe(200)
    const downloaded = await downloadQQImage(`http://127.0.0.1:${address.port}/received`, { maxBytes: host.imageLimits.snapshot().imageBytes })
    expect(downloaded.bytes.equals(bytes)).toBe(true)
    const added = await api('/plugins/stickers/manage', { operation: 'add', input: { data: bytes.toString('base64'), mimeType: 'image/png', description: 'Image-size fixture', tags: [] } })
    expect(added.status).toBe(200)
    const stickerId = String(object(added.body.item).assetId)
    expect((await api('/plugins/image-generation/configuration', { expectedRevision: 0, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'bounded-image-fixture' })).status).toBe(200)
    const submitted = await api('/plugins/image-generation/manage', { operation: 'generate', input: { prompt: 'Large image boundary fixture', request_id: 'image-limit-generate-001', confirmed: true } })
    expect(submitted.status).toBe(200)
    let job = submitted.body
    for (let i = 0; i < 15 && ['queued', 'running'].includes(String(job.status)); i++) job = (await api('/plugins/image-generation/manage', { operation: 'job', input: { jobId: job.jobId, waitMs: 1000 } })).body
    expect(job.status).toBe('succeeded')
    const id = String((job.assetIds as string[])[0]), reference = { pluginId: 'image-generation', assetId: id }, lease = await resources.getAsset(reference)
    expect((await lease.readBytes()).byteLength).toBe(bytes.byteLength)
    const client = new Client({ name: 'image-policy-fixture', version: '1.0.0' }); stops.push(() => client.close())
    const registration = (await api('/plugins/image-generation/mcp-registration', {})).body
    await client.connect(new StreamableHTTPClientTransport(new URL(String(registration.url)), { requestInit: { headers: { Authorization: String(object(registration.headers).Authorization) } } }))
    const preview = CallToolResultSchema.parse(await client.callTool({ name: 'image_get', arguments: { assetId: id } }))
    expect(preview.isError).toBe(false)
    const block = preview.content.find(part => part.type === 'image')
    expect(block?.type === 'image' && Buffer.from(block.data, 'base64').equals(bytes)).toBe(true)
    const settings = (await api('/image-limits')).body
    expect((await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, autoConnect: false })).status).toBe(200)
    expect((await api('/plugins/qq/connect', {})).status).toBe(200)
    const image = { type: 'image', data: { file: `eating-asset://image-generation/${id}` } }
    expect((await api('/plugins/qq/invoke', { name: 'qq_send_private_message', requestId: 'image-limit-send-001', confirmed: true, arguments: { user_id: '987654321', message: [image, image] } })).status).toBe(200)
    const sent = onebot.requests.filter(x => x.action === 'send_private_msg'); expect(sent).toHaveLength(1)
    for (const segment of sent[0]!.params.message as JsonObject[]) expect(Buffer.from(String(object(segment.data).file).slice(9), 'base64').equals(bytes)).toBe(true)
    expect((await api('/image-limits', { expectedRevision: settings.revision, maxImageMiB: 2 })).status).toBe(200)
    expect(object((await api('/plugins/stickers/configuration')).body.limits).imageBytes).toBe(2 * 1024 * 1024)
    await expect(lease.assertActive()).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })
    await expect(resources.getAsset(reference)).rejects.toMatchObject({ code: 'INVALID_IMAGE_RESOURCE' })
    expect((await api('/plugins/image-generation/manage', { operation: 'get', input: { assetId: id } })).status).toBe(413)
    expect((await api('/plugins/stickers/manage', { operation: 'get', input: { assetId: stickerId } })).status).toBe(413)
    expect((await client.callTool({ name: 'image_get', arguments: { assetId: id } })).isError).toBe(true)
    await client.close()
    const stored = await readFile(join(home, 'capabilities/image-generation/blobs', id)); expect(stored.equals(bytes)).toBe(true)
    await host.close()
    host = new EatingHost({ dataDirectory: home, entries, port: 0, allowedUiOrigins: [] }); api = await owner()
    const page = await api('/plugins/image-generation/manage', { operation: 'list', input: {} }); expect(page.status).toBe(200); expect(page.body.total).toBe(1)
    expect((await api('/image-limits', { expectedRevision: Number(settings.revision) + 1, maxImageMiB: size })).status).toBe(200)
    expect(Buffer.from(await (await resources.getAsset(reference)).readBytes()).equals(bytes)).toBe(true)
    expect((await api('/plugins/stickers/manage', { operation: 'get', input: { assetId: stickerId } })).status).toBe(200)
    expect(requests).toHaveLength(1)
  }, 30000)
})
