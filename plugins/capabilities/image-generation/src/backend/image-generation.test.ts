import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { fsyncSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import { createImageFixturePng } from '../../../../../tests/fixtures/image'
import { startImagesProviderFixture } from '../../../../../tests/fixtures/images-provider'
import { ImageGenerationPlugin } from '../server'
import { IMAGE_GENERATION_LIMITS } from '../types'
import { ImageGenerationStore } from './store'
import { imageBytes } from './image'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) }
})
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync)
  vi.mocked(renameSync).mockImplementation(actualFs.renameSync)
  vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync)
  for (const stop of stops.splice(0).reverse()) await stop()
  vi.restoreAllMocks()
})
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected structured test value'); return value }
function gate() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept }); return { promise, resolve } }
async function home() {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'eating-images-backend-')))
  stops.push(async () => { if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-images-backend-')) throw new Error('Unsafe backend cleanup'); await rm(root, { recursive: true }) })
  return root
}
async function fixture(directory?: string, execute?: HostPluginContext['executeIdempotent']) {
  directory ??= await home()
  const submissions: { params: JsonObject; requestId: string }[] = []
  const context: HostPluginContext = { dataDirectory: directory, getSetting: () => null, setSetting: () => {}, recordEvent: () => ({ inserted: true, eventId: 'unit-event' }), listMessages: () => [],
    executeIdempotent: execute ?? (async (_id, _action, params, requestId, run) => { submissions.push({ params, requestId }); return run() }) }
  const plugin = new ImageGenerationPlugin(context)
  stops.push(() => plugin.dispose())
  return { plugin, context, directory, submissions }
}
async function configuredFixture(baseUrl: string, apiKey = 'PRIVATE-IMAGES-TEST-KEY', extra: JsonObject = {}) {
  const f = await fixture()
  await f.plugin.updateConfiguration({ expectedRevision: 0, baseUrl, apiKey, model: 'fixture-images-model', ...extra })
  return f
}
const generation = (requestId = 'generation-request-0001', extra: JsonObject = {}) => ({ prompt: '画一张绿色的回环测试图', request_id: requestId, confirmed: true, ...extra })
async function finalJob(plugin: ImageGenerationPlugin, job: JsonObject) { return object(await plugin.manage('job', { jobId: job.jobId!, waitMs: 20000 })) }

async function provider(handle: (request: IncomingMessage, response: ServerResponse, body: JsonObject) => void | Promise<void>) {
  const requests: { url: string | undefined; headers: IncomingHttpHeaders; body: JsonObject }[] = [], downloaded: IncomingHttpHeaders[] = [], entered = gate()
  let origin = ''
  const image = createImageFixturePng()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') { downloaded.push(request.headers); await handle(request, response, {}); return }
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part))
      const body = object(JSON.parse(Buffer.concat(parts).toString('utf8')))
      requests.push({ url: request.url, headers: request.headers, body }); entered.resolve()
      await handle(request, response, body)
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No provider fixture port')
  origin = `http://127.0.0.1:${address.port}`
  stops.push(async () => { const closing = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closing })
  return { baseUrl: origin + '/nested/v1', origin, requests, downloaded, entered: entered.promise, image }
}
const imageResponse = (response: ServerResponse, bytes = createImageFixturePng()) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] })) }

// Every provider and downloaded image is a real independent loopback HTTP peer.
describe('OpenAI Images 后端与任务边界', () => {
  it('保存和启停仅检查本地配置，Key保持/清除与CAS明确，不发生成请求', async () => {
    const p = await provider((_request, response) => imageResponse(response)), f = await fixture()
    expect(f.plugin.getPublicConfiguration()).toMatchObject({ schemaVersion: 1, revision: 0, baseUrl: 'https://api.openai.com/v1', model: '', timeoutMs: 180000, ready: false, apiKeyConfigured: false })
    await f.plugin.disconnect(); await f.plugin.connect()
    expect(f.plugin.getStatus().state).toBe('unconfigured')
    await f.plugin.updateConfiguration({ expectedRevision: 0, baseUrl: p.baseUrl, model: 'custom-image-model', apiKey: 'PRIVATE-IMAGES-TEST-KEY' })
    expect(f.plugin.getPublicConfiguration()).toMatchObject({ revision: 1, ready: true, apiKeyConfigured: true })
    await f.plugin.updateConfiguration({ expectedRevision: 1, apiKey: '', quality: 'high' })
    expect(f.plugin.getPublicConfiguration().apiKeyConfigured).toBe(true)
    await expect(f.plugin.updateConfiguration({ expectedRevision: 1, model: 'stale' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_CONFIGURATION_CONFLICT' })
    expect(JSON.stringify(f.plugin.getPublicConfiguration())).not.toContain('PRIVATE-IMAGES-TEST-KEY')
    await f.plugin.updateConfiguration({ expectedRevision: 2, clearApiKey: true })
    expect(f.plugin.getPublicConfiguration()).toMatchObject({ revision: 3, ready: false, apiKeyConfigured: false })
    expect(p.requests).toHaveLength(0)
    const disk = object(JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8')))
    expect(disk).toMatchObject({ schemaVersion: 1, revision: 3, apiKey: '' })
    if (process.platform !== 'win32') expect((await lstat(join(f.directory, 'config.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(f.plugin.agentInstructions)).toContain('queued/running 不代表图片已生成')
  })

  it.each([{ baseUrl: 'file:///etc/test' }, { baseUrl: 'https://user:private@fixture.invalid/v1' }, { baseUrl: 'https://fixture.invalid/v1?key=private' }, { baseUrl: 'https://fixture.invalid/#private' }, { timeoutMs: 999 }, { timeoutMs: 600001 }, { responseFormat: 'chat' }, { autoConnect: true }, { n: 2 }])('拒绝不属于当前配置契约的参数 %j', async patch => {
    const f = await fixture()
    await expect(f.plugin.updateConfiguration({ expectedRevision: 0, ...patch })).rejects.toThrow()
    expect(f.plugin.getPublicConfiguration().revision).toBe(0)
  })

  it.each(['base64', 'url'] as const)('真实 %s 响应只发一次POST，保前缀/n1/认证并无认证下载；元数据和提交账本无原图', async mode => {
    const p = await startImagesProviderFixture(mode); stops.push(() => p.close())
    const f = await configuredFixture(p.baseUrl, p.apiKey, { size: '1024x1024', quality: 'high', responseFormat: mode === 'url' ? 'url' : 'b64_json' })
    const submitted = object(await f.plugin.manage('generate', generation()))
    expect(submitted).toMatchObject({ status: 'queued', assetIds: [] })
    const completed = await finalJob(f.plugin, submitted)
    expect(completed).toMatchObject({ status: 'succeeded', model: 'fixture-images-model', assetIds: [expect.stringMatching(/^[a-f0-9]{64}$/)] })
    expect(p.requests).toHaveLength(1)
    expect(p.requests[0]).toMatchObject({ path: '/custom/v1/images/generations', headers: { authorization: 'Bearer ' + p.apiKey }, body: { model: 'fixture-images-model', prompt: generation().prompt, n: 1, size: '1024x1024', quality: 'high', response_format: mode === 'url' ? 'url' : 'b64_json' } })
    if (mode === 'url') { expect(p.downloads).toHaveLength(1); expect(p.downloads[0]!.authorization).toBeUndefined(); expect(p.downloads[0]!.cookie).toBeUndefined() }
    const list = await f.plugin.manage('list', {}), jobs = await f.plugin.manage('jobs', {})
    expect(list).toMatchObject({ total: 1, offset: 0, limit: 20, hasMore: false, nextOffset: null })
    for (const value of [submitted, completed, list, jobs, f.submissions]) {
      expect(JSON.stringify(value)).not.toContain(p.apiKey)
      expect(JSON.stringify(value)).not.toContain(p.image.toString('base64'))
      expect(JSON.stringify(value)).not.toContain('signature=')
    }
    expect(f.submissions).toHaveLength(1)
    const assetId = (completed.assetIds as string[])[0]!
    const preview = object(await f.plugin.manage('get', { assetId }))
    expect(preview).toMatchObject({ image: { mimeType: 'image/png', data: p.image.toString('base64') }, sendable: { type: 'image', data: { file: 'eating-asset://image-generation/' + assetId } } })
    const content = object(await f.plugin.invoke('image_get', { assetId }, 'readonly-get-request'))
    expect(content.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('eating-asset://image-generation/') }), { type: 'image', mimeType: 'image/png', data: p.image.toString('base64') }])
    expect(await f.plugin.media.readAsset(assetId)).toEqual(preview.image)
  })

  it('默认可选字段不发送，重复参数同job，异参冲突，跨重启同ID不再付费', async () => {
    const p = await provider((_request, response) => imageResponse(response)), f = await configuredFixture(p.baseUrl)
    const submitted = object(await f.plugin.manage('generate', generation()))
    const completed = await finalJob(f.plugin, submitted)
    expect(p.requests[0]!.body).toEqual({ model: 'fixture-images-model', prompt: generation().prompt, n: 1 })
    expect(await f.plugin.manage('generate', generation())).toEqual(completed)
    await expect(f.plugin.manage('generate', generation('generation-request-0001', { prompt: 'different' }))).rejects.toMatchObject({ code: 'IMAGE_GENERATION_IDEMPOTENCY_CONFLICT' })
    await f.plugin.dispose()
    const reopened = await fixture(f.directory)
    expect(await reopened.plugin.manage('generate', generation())).toEqual(completed)
    expect(p.requests).toHaveLength(1)
    expect(await reopened.plugin.manage('jobs', {})).toMatchObject({ total: 1, items: [completed] })
  })

  it('同时最多一个活跃任务，配置变更和未确认owner生成不产生请求', async () => {
    const hold = gate(), p = await provider(async (_request, response) => { await hold.promise; imageResponse(response) }), f = await configuredFixture(p.baseUrl)
    await expect(f.plugin.manage('generate', { prompt: 'x', request_id: 'unconfirmed-0001', confirmed: false })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_CONFIRMATION_REQUIRED' })
    const submitted = object(await f.plugin.manage('generate', generation()))
    await p.entered
    await expect(f.plugin.manage('generate', generation('second-generation-id'))).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BUSY' })
    await expect(f.plugin.updateConfiguration({ expectedRevision: 1, model: 'changed' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BUSY' })
    expect(object(await f.plugin.manage('job', { jobId: submitted.jobId!, waitMs: 0 })).status).toBe('running')
    hold.resolve(); expect((await finalJob(f.plugin, submitted)).status).toBe('succeeded')
    expect(p.requests).toHaveLength(1)
  })

  it('已接受付费任务在Agent正常撤lease后完成；预撤销或receipt等待期间撤销均0POST', async () => {
    const hold = gate(), p = await provider(async (_request, response) => { await hold.promise; imageResponse(response) }), f = await configuredFixture(p.baseUrl)
    const signal = new AbortController()
    const input = { prompt: 'accepted background job', request_id: 'accepted-background-0001' }
    const submitted = object(await f.plugin.invokeCapability('image_generate', input, input.request_id, { agentId: 'child', agentTypeId: 'qq.private', signal: signal.signal }))
    await p.entered; signal.abort(); hold.resolve()
    expect((await finalJob(f.plugin, submitted)).status).toBe('succeeded')
    expect(p.requests).toHaveLength(1)
    const before = new AbortController(); before.abort()
    await expect(f.plugin.invokeCapability('image_generate', { ...input, request_id: 'pre-aborted-id-0002' }, 'pre-aborted-id-0002', { agentId: 'child', agentTypeId: 'qq.private', signal: before.signal })).rejects.toMatchObject({ outcome: 'not-sent' })
    const receiptReady = gate(), releaseReceipt = gate(), deferred = await fixture(await home(), async (_id, _action, _params, _requestId, run) => { const result = await run(); receiptReady.resolve(); await releaseReceipt.promise; return result })
    await deferred.plugin.updateConfiguration({ expectedRevision: 0, baseUrl: p.baseUrl, apiKey: 'PRIVATE-IMAGES-TEST-KEY', model: 'fixture-images-model' })
    const revoked = new AbortController(), lateInput = { prompt: 'revoked before POST', request_id: 'deferred-receipt-0003' }
    const pending = deferred.plugin.invokeCapability('image_generate', lateInput, lateInput.request_id, { agentId: 'late-child', agentTypeId: 'qq.private', signal: revoked.signal })
    await receiptReady.promise; revoked.abort(); releaseReceipt.resolve()
    const queued = object(await pending), terminal = await finalJob(deferred.plugin, queued)
    expect(terminal).toMatchObject({ status: 'failed', error: { code: 'IMAGE_GENERATION_CANCELLED_BEFORE_SEND', outcome: 'not-sent' } })
    expect(await deferred.plugin.manage('jobs', {})).toMatchObject({ total: 1, items: [terminal] })
    expect(await deferred.plugin.invokeCapability('image_generate', lateInput, lateInput.request_id, { agentId: 'new-child', agentTypeId: 'qq.private' })).toEqual(terminal)
    await deferred.plugin.updateConfiguration({ expectedRevision: 1, quality: 'high' })
    expect(p.requests).toHaveLength(1)
  })

  it.each(['disconnect', 'dispose'] as const)('%s取消插件自有活动请求为unknown，释放socket且不落图片/不重放', async operation => {
    let held: ServerResponse | undefined
    const p = await provider((_request, response) => { held = response }), f = await configuredFixture(p.baseUrl)
    const submitted = object(await f.plugin.manage('generate', generation()))
    await p.entered
    await f.plugin[operation]()
    const terminal = object(await f.plugin.manage('job', { jobId: submitted.jobId! }).catch(() => new ImageGenerationStore(f.directory).job(String(submitted.jobId))))
    expect(terminal).toMatchObject({ status: 'unknown', error: { outcome: 'unknown' } })
    expect(new ImageGenerationStore(f.directory).images({}).total).toBe(0)
    expect(p.requests).toHaveLength(1)
    await vi.waitFor(() => expect(held?.destroyed).toBe(true), { timeout: 2000, interval: 10 })
    const reopened = await fixture(f.directory)
    expect(await reopened.plugin.manage('generate', generation())).toMatchObject({ jobId: submitted.jobId, status: 'unknown' })
    expect(p.requests).toHaveLength(1)
  })

  it.each([401, 429, 500])('HTTP%s只一次POST，错误不泄露原body/Key/URL，4xx失败而5xx未知', async status => {
    const secret = 'PRIVATE-IMAGES-TEST-KEY', signed = 'https://fixture.invalid/result?signature=DO-NOT-LEAK'
    const p = await provider((_request, response) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ apiKey: secret, url: signed, error: secret })) }), f = await configuredFixture(p.baseUrl, secret)
    const submitted = object(await f.plugin.manage('generate', generation())), terminal = await finalJob(f.plugin, submitted)
    expect(terminal).toMatchObject({ status: status < 500 ? 'failed' : 'unknown', error: { code: 'IMAGE_GENERATION_HTTP_' + status, outcome: status < 500 ? 'failed' : 'unknown' } })
    expect(p.requests).toHaveLength(1)
    for (const value of [terminal, await f.plugin.manage('jobs', {}), await readFile(join(f.directory, 'state.json'), 'utf8'), f.plugin.getPublicConfiguration(), f.plugin.getStatus()]) {
      expect(JSON.stringify(value)).not.toContain(secret); expect(JSON.stringify(value)).not.toContain(signed)
    }
    expect(await f.plugin.manage('generate', generation())).toEqual(terminal)
    expect(p.requests).toHaveLength(1)
  })

  it('整体超时取消一次付费请求并标unknown，不后台重试', async () => {
    const p = await provider(() => {}), f = await configuredFixture(p.baseUrl, 'PRIVATE-IMAGES-TEST-KEY', { timeoutMs: 1000 })
    const terminal = await finalJob(f.plugin, object(await f.plugin.manage('generate', generation())))
    expect(terminal).toMatchObject({ status: 'unknown', error: { code: 'IMAGE_GENERATION_TIMEOUT', outcome: 'unknown' } })
    expect(p.requests).toHaveLength(1)
    expect(object(await f.plugin.manage('list', {})).total).toBe(0)
  })

  it('无效JSON、非canonical图片、空data和断网都为unknown且不保留下载材料', async () => {
    for (const kind of ['json', 'image', 'empty', 'network'] as const) {
      const p = await provider((request, response) => {
        if (kind === 'network') { request.socket.destroy(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(kind === 'json' ? 'not-json PRIVATE-IMAGES-TEST-KEY' : JSON.stringify(kind === 'empty' ? { data: [] } : { data: [{ b64_json: 'not canonical image====' }] }))
      }), f = await configuredFixture(p.baseUrl)
      const terminal = await finalJob(f.plugin, object(await f.plugin.manage('generate', generation())))
      expect(terminal).toMatchObject({ status: 'unknown', error: { outcome: 'unknown' } })
      expect(p.requests).toHaveLength(1)
      expect(await f.plugin.manage('list', {})).toMatchObject({ total: 0 })
      expect((await readdir(f.directory)).filter(name => name.includes('.tmp'))).toEqual([])
    }
  })

  it('API及图片下载均不跟随redirect，也不把认证头带到结果URL', async () => {
    let targetRequests = 0
    const target = await provider((_request, response) => { targetRequests++; response.end('target') })
    for (const redirectDownload of [false, true]) {
      let origin = ''
      const p = await provider((request, response) => {
        if (!redirectDownload || request.method === 'GET') { response.writeHead(302, { Location: target.origin + '/steal' }); response.end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ url: origin + '/result.png?private=signature' }] }))
      }); origin = p.origin
      const f = await configuredFixture(p.baseUrl)
      const terminal = await finalJob(f.plugin, object(await f.plugin.manage('generate', generation())))
      expect(terminal).toMatchObject({ status: 'unknown', error: { code: 'IMAGE_GENERATION_REDIRECT_REFUSED' } })
      expect(p.requests).toHaveLength(1)
      expect(p.downloaded).toHaveLength(redirectDownload ? 1 : 0)
      for (const headers of p.downloaded) { expect(headers.authorization).toBeUndefined(); expect(headers.cookie).toBeUndefined() }
      expect(targetRequests).toBe(0)
    }
  })

  it.each(['blob', 'state'] as const)('真实POST200后%s写失败必须unknown而非not-sent，清理未引用图片且不重放', async stage => {
    const p = await provider((_request, response) => imageResponse(response)), f = await configuredFixture(p.baseUrl)
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (Buffer.isBuffer(data) && (stage === 'blob' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : data.toString('utf8').includes('"status": "succeeded"'))) throw new Error('fixture storage failure')
      return actualFs.writeFileSync(path, data, options)
    })
    const submitted = object(await f.plugin.manage('generate', generation())), terminal = await finalJob(f.plugin, submitted)
    expect(terminal).toMatchObject({ status: 'unknown', error: { code: 'IMAGE_GENERATION_STORAGE_FAILED', outcome: 'unknown' } })
    expect(p.requests).toHaveLength(1)
    expect(new ImageGenerationStore(f.directory).images({}).total).toBe(0)
    expect((await readdir(join(f.directory, 'blobs'))).filter(name => /^[a-f0-9]{64}$/.test(name))).toEqual([])
    expect(await f.plugin.manage('generate', generation())).toEqual(terminal)
    expect(p.requests).toHaveLength(1)
  })

  it('enqueue rename已提交而dirfsync失败时找回任务标unknown，不留下无worker的queued成功回执', async () => {
    const p = await provider((_request, response) => imageResponse(response)), f = await configuredFixture(p.baseUrl)
    let renamed = false, failOnce = true
    vi.mocked(renameSync).mockImplementation((from, to) => { actualFs.renameSync(from, to); if (String(to) === join(f.directory, 'state.json')) renamed = true })
    vi.mocked(fsyncSync).mockImplementation(fd => { if (renamed && failOnce) { failOnce = false; throw new Error('fixture directory fsync failed') }; actualFs.fsyncSync(fd) })
    await expect(f.plugin.manage('generate', generation())).rejects.toMatchObject({ code: 'IMAGE_GENERATION_STORAGE_FAILED', outcome: 'unknown' })
    const page = object(await f.plugin.manage('jobs', {}))
    expect(page).toMatchObject({ total: 1, items: [expect.objectContaining({ status: 'unknown', requestId: generation().request_id })] })
    expect(p.requests).toHaveLength(0)
    expect(await f.plugin.manage('generate', generation())).toMatchObject({ status: 'unknown' })
    await f.plugin.updateConfiguration({ expectedRevision: 1, quality: 'high' })
    expect(p.requests).toHaveLength(0)
  })

  it.each(['queued', 'running'] as const)('跨重启%s转unknown且原ID可找回，不自动POST', async status => {
    const p = await provider((_request, response) => imageResponse(response)), directory = await home()
    const store = new ImageGenerationStore(directory), params = { prompt: generation().prompt, request_id: 'restart-current-request' }
    const intent = { prompt: params.prompt, size: null, quality: null, responseFormat: null }, requestHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex')
    const old = store.enqueue(params.request_id, requestHash, params.prompt, 'fixture-images-model')
    if (status === 'running') store.running(old.jobId)
    const f = await fixture(directory)
    await f.plugin.updateConfiguration({ expectedRevision: 0, baseUrl: p.baseUrl, apiKey: 'PRIVATE-IMAGES-TEST-KEY', model: 'fixture-images-model' })
    expect(await f.plugin.manage('job', { jobId: old.jobId })).toMatchObject({ jobId: old.jobId, status: 'unknown', error: { code: 'IMAGE_GENERATION_INTERRUPTED' } })
    expect(await f.plugin.manage('generate', { ...params, confirmed: true })).toMatchObject({ jobId: old.jobId, status: 'unknown' })
    expect(p.requests).toHaveLength(0)
    expect((await f.plugin.manage('jobs', {}))).toMatchObject({ total: 1 })
  })

  it('坏配置或任务schema明确拒绝且不覆盖，500任务容量在付费请求前拒绝', async () => {
    const directory = await home(), configuration = join(directory, 'config.json')
    await writeFile(configuration, '{"schemaVersion":0,"apiKey":"PRIVATE-IMAGES-TEST-KEY"}')
    await expect(fixture(directory)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_CONFIGURATION_CORRUPTED' })
    expect(await readFile(configuration, 'utf8')).toBe('{"schemaVersion":0,"apiKey":"PRIVATE-IMAGES-TEST-KEY"}')
    const p = await provider((_request, response) => imageResponse(response)), other = await home(), now = new Date().toISOString()
    const jobs = Array.from({ length: 500 }, (_, index) => ({ jobId: randomUUID(), requestId: 'capacity-request-' + index, requestHash: 'a'.repeat(64), status: 'failed', prompt: 'capacity fixture', model: 'fixture-images-model', createdAt: now, updatedAt: now, assetIds: [] }))
    await writeFile(join(other, 'state.json'), JSON.stringify({ schemaVersion: 1, revision: 1, jobs, images: [] }))
    const f = await fixture(other)
    await f.plugin.updateConfiguration({ expectedRevision: 0, baseUrl: p.baseUrl, apiKey: 'PRIVATE-IMAGES-TEST-KEY', model: 'fixture-images-model' })
    await expect(f.plugin.manage('generate', generation())).rejects.toMatchObject({ code: 'IMAGE_GENERATION_CAPACITY_REACHED' })
    expect(p.requests).toHaveLength(0)
    expect((await f.plugin.manage('jobs', { offset: 499, limit: 1 }))).toMatchObject({ total: 500, hasMore: false, nextOffset: null, offset: 499, limit: 1 })
    await expect(f.plugin.manage('jobs', { limit: 51 })).rejects.toThrow()
    expect(() => imageBytes(Buffer.alloc(IMAGE_GENERATION_LIMITS.imageBytes + 1))).toThrow()
  })

  it('拒绝数据目录或配置符号链接，不读取或替换目标', async () => {
    const directory = await home(), outside = join(directory, 'outside.json'), data = join(directory, 'data')
    await writeFile(outside, 'preserve target'); await mkdir(data)
    await symlink(outside, join(data, 'config.json'))
    await expect(fixture(data)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('preserve target')
  })
})
