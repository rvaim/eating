import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import { createImageFixturePng } from '../../../../../tests/fixtures/image'
import { startImagesProviderFixture } from '../../../../../tests/fixtures/images-provider'
import { ImageGenerationPlugin } from '../server'
import type { PrivateImageConfiguration } from './config'
import { generateImage } from './provider'
import { imageGenerationTools } from './tools'
import { generationHash, imageSize, parseGeneration } from './validation'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const parameters = (extra: JsonObject = {}) => parseGeneration({ prompt: '尺寸透传回环测试', request_id: 'size-request-0001', ...extra })
const configuration = (baseUrl: string, apiKey = ''): PrivateImageConfiguration => ({ schemaVersion: 1, revision: 1, baseUrl, apiKey, model: 'service-defined-image-model', timeoutMs: 2000, size: '1024x1024', quality: '', responseFormat: '' })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected structured fixture result'); return value }

async function pluginFixture() {
  const parent = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(parent, 'eating-image-size-')))
  cleanups.push(async () => {
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== parent || !basename(target).startsWith('eating-image-size-')) throw new Error('Unsafe image size fixture cleanup')
    await rm(target, { recursive: true })
  })
  const context: HostPluginContext = { dataDirectory: directory, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: true, eventId: 'size-event' }), listMessages: () => [], executeIdempotent: async (_plugin, _action, _parameters, _requestId, run) => run() }
  const plugin = new ImageGenerationPlugin(context)
  cleanups.push(() => plugin.dispose())
  return plugin
}

async function responseFixture(status = 200) {
  const requests: Array<{ path: string | undefined; authorization: string | undefined; body: JsonObject }> = []
  const image = createImageFixturePng()
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({ path: request.url, authorization: request.headers.authorization, body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) })
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(status === 200 ? { data: [{ b64_json: image.toString('base64') }] } : { error: { message: 'size unsupported by this fixture model' } }))
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No image size fixture port')
  cleanups.push(async () => { const closing = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closing })
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, image }
}

describe('生图尺寸原样传递与服务默认值', () => {
  it.each(['', '1024x1024', '1536x1024', '1024x1536', '513x1793', '1x1', '16384x8192', 'auto', 'preserve', 'portrait', 'landscape', '2k', '4K', 'provider_native-size'])('接受通用格式而不锁死模型预设 %s', size => {
    expect(imageSize(size)).toBe(size)
    expect(parameters({ size }).size).toBe(size)
  })

  it.each(['0x1024', '1024x0', '-1x1024', '1024x-1', '1.5x1024', '1024', '1024x', 'x1024', '1024xNaN', 'NaNx1024', 'NaNxNaN', 'Infinityx1024', '1024xInfinity', '9007199254740992x1024', '1024x1024;echo bad', '1024 x 1024'])('非法尺寸在发出请求前拒绝 %s', size => {
    expect(() => parameters({ size })).toThrowError(expect.objectContaining({ code: 'IMAGE_GENERATION_INVALID_SIZE', outcome: 'not-sent' }))
  })

  it('AI 工具公开单次覆盖、空串和服务支持边界，不发布固定尺寸枚举', () => {
    const tool = imageGenerationTools.find(entry => entry.name === 'image_generate')!
    const size = object(object(tool.inputSchema.properties).size)
    expect(size.enum).toBeUndefined()
    expect(size.description).toContain('覆盖面板保存的默认尺寸')
    expect(size.examples).toContain('1536x1024')
    expect(size.examples).toContain('portrait')
    expect(size.examples).toContain('')
  })

  it.each([false, true])('%s 编辑模式真实 JSON/multipart 采用单次尺寸、默认尺寸或显式省略', async editing => {
    const provider = await startImagesProviderFixture('base64', { edit: true })
    cleanups.push(() => provider.close())
    const saved = configuration(provider.baseUrl, provider.apiKey)
    const source = editing ? { mimeType: 'image/png' as const, bytes: provider.image } : undefined
    const cases: Array<{ input: JsonObject; expected: string | undefined }> = [
      { input: {}, expected: '1024x1024' },
      { input: { size: '513x1793' }, expected: '513x1793' },
      { input: { size: 'portrait' }, expected: 'portrait' },
      { input: { size: 'auto' }, expected: 'auto' },
      { input: { size: 'preserve' }, expected: 'preserve' },
      { input: { size: '' }, expected: undefined },
    ]
    for (const entry of cases) {
      const result = await generateImage(saved, parameters(entry.input), source, new AbortController().signal)
      expect(result.bytes).toEqual(provider.image)
    }
    const requests = editing ? provider.edits.map(entry => ({ path: entry.path, body: entry.fields })) : provider.requests
    expect(requests).toHaveLength(cases.length)
    expect(editing ? provider.requests : provider.edits).toHaveLength(0)
    requests.forEach((request, index) => {
      expect(request.path).toBe(`/custom/v1/images/${editing ? 'edits' : 'generations'}`)
      expect(request.body.size).toBe(cases[index]!.expected)
      expect(Object.hasOwn(request.body, 'size')).toBe(cases[index]!.expected !== undefined)
      expect(request.body.n).toBe(editing ? '1' : 1)
    })
    if (editing) expect(provider.edits.every(entry => entry.image.equals(provider.image))).toBe(true)
  })

  it('没有 Key 的服务仅凭已保存地址和模型就绪，保存/连接零试生成且请求不带空 Bearer', async () => {
    const provider = await responseFixture()
    const plugin = await pluginFixture()
    await plugin.updateConfiguration({ expectedRevision: 0, baseUrl: provider.baseUrl, model: 'anonymous-image-model', size: '1536x1024' })
    await plugin.connect()
    expect(plugin.getPublicConfiguration()).toMatchObject({ ready: true, apiKeyConfigured: false, size: '1536x1024' })
    expect(provider.requests).toHaveLength(0)
    const submitted = object(await plugin.manage('generate', { ...parameters({ size: '1024x1536' }), confirmed: true }))
    const completed = await plugin.manage('job', { jobId: submitted.jobId!, waitMs: 20000 })
    expect(completed).toMatchObject({ status: 'succeeded' })
    expect(provider.requests).toEqual([{ path: '/v1/images/generations', authorization: undefined, body: { model: 'anonymous-image-model', prompt: parameters().prompt, n: 1, size: '1024x1536' } }])
  })

  it('同 request_id 改尺寸或改省略语义拒绝，查询和重复提交不会再次计费', async () => {
    const provider = await responseFixture()
    const plugin = await pluginFixture()
    await plugin.updateConfiguration({ expectedRevision: 0, baseUrl: provider.baseUrl, model: 'size-idempotency-model', size: '1024x1024' })
    const input = { ...parameters({ size: '513x1793' }), confirmed: true }
    const submitted = object(await plugin.manage('generate', input))
    const completed = await plugin.manage('job', { jobId: submitted.jobId!, waitMs: 20000 })
    expect(await plugin.manage('generate', input)).toEqual(completed)
    await expect(plugin.manage('generate', { ...input, size: '1793x513' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_IDEMPOTENCY_CONFLICT' })
    expect(generationHash(parameters())).not.toBe(generationHash(parameters({ size: '' })))
    expect(provider.requests).toHaveLength(1)
  })

  it('服务拒绝尺寸后保持失败，不改尺寸或接口回退再请求', async () => {
    const provider = await responseFixture(400)
    const plugin = await pluginFixture()
    await plugin.updateConfiguration({ expectedRevision: 0, baseUrl: provider.baseUrl, model: 'strict-size-model', size: '1024x1024' })
    const input = { ...parameters({ size: '17x19' }), confirmed: true }
    const submitted = object(await plugin.manage('generate', input))
    const completed = await plugin.manage('job', { jobId: submitted.jobId!, waitMs: 20000 })
    expect(completed).toMatchObject({ status: 'failed', error: { code: 'IMAGE_GENERATION_HTTP_400', outcome: 'failed' } })
    expect(await plugin.manage('generate', input)).toEqual(completed)
    await plugin.manage('jobs', {})
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]!.body.size).toBe('17x19')
    expect(provider.requests[0]!.path).toBe('/v1/images/generations')
  })

  it('默认尺寸保存拒绝非法格式，保留原配置版本且未请求服务', async () => {
    const provider = await responseFixture()
    const plugin = await pluginFixture()
    await expect(plugin.updateConfiguration({ expectedRevision: 0, baseUrl: provider.baseUrl, model: 'size-model', size: '0x1024' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_INVALID_SIZE', outcome: 'not-sent' })
    expect(plugin.getPublicConfiguration()).toMatchObject({ revision: 0, size: '' })
    expect(provider.requests).toHaveLength(0)
  })
})
