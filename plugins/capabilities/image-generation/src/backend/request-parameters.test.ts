import { mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_LIMITS, isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { startImagesProviderFixture } from '../../../../../tests/fixtures/images-provider'
import { ImageGenerationPlugin } from '../server'
import { DEFAULT_REQUEST_PARAMETERS, parseRequestParameters } from '../request-parameters'
import { ImageRequestParametersStore } from './request-parameters'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function home() {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-request-parameters-')))
  stops.push(async () => { if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-request-parameters-')) throw Error('Unsafe request parameter cleanup'); await rm(root, { recursive: true }) })
  return root
}
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw Error('Expected fixture JSON'); return value }
async function fixture(defer = false) {
  const root = await home(), provider = await startImagesProviderFixture('base64', { edit: true, defer }); stops.push(() => provider.close())
  const plugin = new ImageGenerationPlugin({ dataDirectory: root, imageLimits: () => DEFAULT_IMAGE_LIMITS, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: true, eventId: 'parameter-fixture' }), listMessages: () => [], executeIdempotent: async (_plugin, _action, _params, _id, run) => run() }); stops.push(() => plugin.dispose())
  await plugin.updateConfiguration({ expectedRevision: 0, baseUrl: provider.baseUrl, model: 'fixture-images-model', apiKey: provider.apiKey })
  return { root, plugin, provider }
}
const generate = (id: string, source?: JsonObject) => ({ prompt: 'parameter fixture', request_id: id, confirmed: true, ...(source ? { source } : {}) })
async function complete(plugin: ImageGenerationPlugin, job: JsonObject) { return object(await plugin.manage('job', { jobId: job.jobId!, waitMs: 20000 })) }

describe('owner configured image request parameters', () => {
  it('defaults to low without creating files, saves independently with CAS, and preserves original connection configuration', async () => {
    const f = await fixture(), before = await readFile(join(f.root, 'config.json'))
    expect(await f.plugin.manage('request-parameters', {})).toEqual({ schemaVersion: 1, revision: 0, parameters: { moderation: 'low' } })
    expect(await readdir(f.root)).not.toContain('request-parameters.json')
    const input = { expectedRevision: 0, parameters: { moderation: 'auto', output_compression: 75, provider_flag: false } }
    expect(await f.plugin.manage('save-request-parameters', input)).toEqual({ schemaVersion: 1, revision: 1, parameters: input.parameters })
    expect(new ImageRequestParametersStore(f.root).snapshot()).toEqual({ schemaVersion: 1, revision: 1, parameters: input.parameters })
    await expect(f.plugin.manage('save-request-parameters', input)).rejects.toMatchObject({ code: 'IMAGE_REQUEST_PARAMETERS_CONFLICT', outcome: 'not-sent' })
    expect(await readFile(join(f.root, 'config.json'))).toEqual(before)
    expect(f.provider.requests).toHaveLength(0); expect(f.provider.edits).toHaveLength(0)
  })

  it.each([false, true])('sends default low, custom primitive types, and explicit empty service defaults through real generation/edit requests: %s', async edit => {
    const f = await fixture(), source = edit ? { kind: 'upload', mimeType: 'image/png', data: f.provider.image.toString('base64') } : undefined
    const first = await complete(f.plugin, object(await f.plugin.manage('generate', generate('parameter-default-0001', source))))
    expect(first.status).toBe('succeeded')
    const requests = () => edit ? f.provider.edits.map(item => item.fields) : f.provider.requests.map(item => item.body)
    expect(requests()[0]).toMatchObject({ moderation: 'low', n: edit ? '1' : 1 })
    await f.plugin.manage('save-request-parameters', { expectedRevision: 0, parameters: { moderation: 'auto', output_format: 'webp', output_compression: 0, provider_flag: false } })
    expect(await f.plugin.manage('generate', generate('parameter-default-0001', source))).toEqual(first)
    expect(requests()).toHaveLength(1)
    const second = await complete(f.plugin, object(await f.plugin.manage('generate', generate('parameter-custom-0001', source))))
    expect(second.status).toBe('succeeded')
    expect(requests()[1]).toMatchObject({ moderation: 'auto', output_format: 'webp', output_compression: edit ? '0' : 0, provider_flag: edit ? 'false' : false })
    await f.plugin.manage('save-request-parameters', { expectedRevision: 1, parameters: {} })
    expect((await complete(f.plugin, object(await f.plugin.manage('generate', generate('parameter-service-0001', source))))).status).toBe('succeeded')
    expect(requests()[2]).toEqual({ model: 'fixture-images-model', prompt: 'parameter fixture', n: edit ? '1' : 1 })
    expect(edit ? f.provider.requests : f.provider.edits).toHaveLength(0)
  })

  it('keeps accepted jobs on their submission parameters and refuses parameter changes while they run', async () => {
    const f = await fixture(true), job = object(await f.plugin.manage('generate', generate('parameter-running-0001')))
    await expect(f.plugin.manage('save-request-parameters', { expectedRevision: 0, parameters: { moderation: 'auto' } })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BUSY', outcome: 'not-sent' })
    f.provider.release(); expect((await complete(f.plugin, job)).status).toBe('succeeded')
    expect(f.provider.requests).toHaveLength(1); expect(f.provider.requests[0]!.body.moderation).toBe('low')
  })

  it('reports an unsupported moderation parameter without dropping it or sending a second paid request', async () => {
    const f = await fixture(), requests: JsonObject[] = []
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        requests.push(object(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Unsupported moderation parameter' } }))
      })()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    stops.push(async () => { const closing = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closing })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture address')
    await f.plugin.updateConfiguration({ expectedRevision: 1, baseUrl: `http://127.0.0.1:${address.port}/v1` })
    const input = generate('parameter-rejected-0001')
    const result = await complete(f.plugin, object(await f.plugin.manage('generate', input)))
    expect(result).toMatchObject({ status: 'failed', error: { code: 'IMAGE_GENERATION_HTTP_400', outcome: 'failed' } })
    expect(requests).toHaveLength(1); expect(requests[0]!.moderation).toBe('low')
    expect(await f.plugin.manage('generate', input)).toEqual(result); expect(requests).toHaveLength(1)
  })

  it.each([null, [], { n: 2 }, { model: 'different' }, { size: 'auto' }, { image: 'file:///private' }, { stream: true }, { authorization: 'secret' }, { nested: {} }, { list: [1] }, { moderation: 'disabled' }, { value: 'a'.repeat(4097) }, Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['p' + index, true]))])('rejects invalid or protocol-changing input before saving or sending: %j', async parameters => {
    const root = await home(), store = new ImageRequestParametersStore(root)
    expect(() => store.update({ expectedRevision: 0, parameters })).toThrowError(expect.objectContaining({ code: 'IMAGE_REQUEST_PARAMETERS_INVALID', outcome: 'not-sent' }))
    expect(store.snapshot().parameters).toEqual(DEFAULT_REQUEST_PARAMETERS)
    expect(await readdir(root)).toEqual([])
  })

  it('bounds UTF-8 data and blocks prototype keys without polluting objects', () => {
    expect(() => parseRequestParameters({ value: Infinity })).toThrow()
    expect(() => parseRequestParameters({ one: '图'.repeat(4000), two: '图'.repeat(4000) })).toThrow()
    expect(() => parseRequestParameters(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow()
    expect(() => parseRequestParameters({ constructor: 'invalid' })).toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses an external file change and a damaged file while retaining their original bytes', async () => {
    const root = await home(), path = join(root, 'request-parameters.json'), first = new ImageRequestParametersStore(root), other = new ImageRequestParametersStore(root)
    other.update({ expectedRevision: 0, parameters: { moderation: 'auto' } })
    const saved = await readFile(path)
    expect(() => first.update({ expectedRevision: 0, parameters: {} })).toThrowError(expect.objectContaining({ code: 'IMAGE_REQUEST_PARAMETERS_CONFLICT' }))
    expect(await readFile(path)).toEqual(saved)
    await writeFile(path, '{"schemaVersion":0}')
    expect(() => new ImageRequestParametersStore(root)).toThrowError(expect.objectContaining({ code: 'IMAGE_REQUEST_PARAMETERS_CORRUPTED' }))
    expect(await readFile(path, 'utf8')).toBe('{"schemaVersion":0}')
  })
})
