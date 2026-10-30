import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlatformError } from '@eating/plugin-sdk'
import type { JsonValue } from '@eating/plugin-sdk'
import { EatingHost } from '../../apps/host/src/app'
import { discoverBackendPlugins } from '../../apps/host/src/discovery'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { DEFAULT_CONFIGURATION, parseConfiguration } from '../../plugins/harness/dsh/src/backend/config'
import { listModels, testModelConnection } from '../../plugins/harness/dsh/src/backend/model-service'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url))
const release = () => { let resolvePromise!: () => void; const promise = new Promise<void>(resolve => { resolvePromise = resolve }); return { promise, resolve: resolvePromise } }

test.describe('Harness 模型连接（本地夹具）', () => {
  test.setTimeout(45000)
  let directory: string
  let host: EatingHost | undefined
  let modelServer: Server | undefined
  let url: string
  let modelUrl: string
  let modelStatus: number
  let modelRequests: { path: string; authorization: string | undefined; body: string }[]
  let operations: { operation: string; input: unknown }[]
  let pageErrors: string[]

  test.beforeEach(async ({ page }) => {
    operations = []; modelRequests = []; modelStatus = 200; pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    modelServer = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        modelRequests.push({ path: request.url ?? '', authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
        response.writeHead(modelStatus, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(modelStatus !== 200 ? { error: { message: 'fixture-only-provider-key' } } : request.method === 'GET' ? { data: [{ id: 'fixture-alpha', name: 'Alpha' }, { id: 'fixture-beta' }] } : { choices: [{ message: { role: 'assistant', content: 'fixture-output-never-displayed' } }] }))
      })
    })
    modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening')
    const address = modelServer.address()
    if (!address || typeof address === 'string') throw new Error('Invalid local model fixture')
    modelUrl = `http://127.0.0.1:${address.port}/custom/api/`
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_harness_agents_')))
    await installPluginPackage(directory, pluginDirectory)
    let configuration = { ...DEFAULT_CONFIGURATION }
    const entries = (await discoverBackendPlugins(directory)).map(entry => ({ ...entry, create(context: Parameters<typeof entry.create>[0]) {
      const original = entry.create(context)
      return new Proxy(original, { get(target, key) {
        if (key === 'updateConfiguration') return async (input: unknown) => { const result = await target.updateConfiguration(input); configuration = parseConfiguration(input, configuration); return result }
        if (key === 'manage') return async (operation: string, input: unknown): Promise<JsonValue> => {
          if (operation === 'get-model-capabilities') return target.manage!(operation, input)
          operations.push({ operation, input })
          if (operation === 'list-models') return { models: (await listModels(configuration)).models.map(model => ({ ...model })) }
          if (operation === 'test-connection') return testModelConnection(configuration)
          throw new PlatformError('MANAGEMENT_OPERATION_UNSUPPORTED', 'fixture unsupported')
        }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }))
    host = new EatingHost({ dataDirectory: directory, entries, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  })

  test.afterEach(async () => {
    await host?.close(); host = undefined
    if (modelServer) {
      const closed = new Promise<void>((resolveClosed, reject) => modelServer!.close(error => error ? reject(error) : resolveClosed()))
      modelServer.closeAllConnections(); await closed; modelServer = undefined
    }
    if (directory) {
      const target = await realpath(directory)
      if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_harness_agents_')) throw new Error('Refuse unverified fixture cleanup')
      await rm(target, { recursive: true })
    }
    expect(pageErrors).toEqual([])
  })

  async function open(page: Page) { await page.goto(`${url}/#harness/dsh`); await expect(page.getByLabel('API 基础地址', { exact: true })).toBeVisible() }
  async function saveModel(page: Page) {
    await page.getByLabel('API 基础地址', { exact: true }).fill(modelUrl)
    await page.getByLabel('模型名称', { exact: true }).fill('fixture-manual')
    await page.getByLabel('API Key', { exact: true }).fill('fixture-only-provider-key')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存，运行已停止。需要时请重新启动 Harness。', { exact: true })).toBeVisible()
  }
  async function hide(page: Page) {
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  }
  async function show(page: Page) {
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  }

  test('模型按钮使用保存配置，列表选择只写草稿，真实测试只请求一次且随语言即时翻译', async ({ page }, testInfo) => {
    await open(page)
    await expect(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeDisabled()
    await saveModel(page)
    let saves = 0
    page.on('request', request => { if (request.url().endsWith('/configuration') && request.method() === 'POST') saves++ })
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    await expect(page.getByLabel('从模型列表选择', { exact: true })).toBeVisible()
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('fixture-manual')
    await page.getByLabel('从模型列表选择', { exact: true }).selectOption('fixture-beta')
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('fixture-beta')
    await expect(page.getByRole('button', { name: '测试模型连接', exact: true })).toBeDisabled()
    expect(saves).toBe(0)
    expect(operations).toEqual([{ operation: 'list-models', input: {} }])
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByRole('button', { name: '测试模型连接', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '测试模型连接', exact: true }).click()
    await expect(page.getByText(/模型 fixture-beta 请求成功/)).toBeVisible()
    expect(modelRequests).toHaveLength(2)
    expect(modelRequests[0]).toMatchObject({ path: '/custom/api/models', authorization: 'Bearer fixture-only-provider-key' })
    expect(JSON.parse(modelRequests[1]!.body)).toEqual({ model: 'fixture-beta', messages: [{ role: 'user', content: 'Ping.' }], max_tokens: 1, stream: false })
    await expect(page.getByText('fixture-output-never-displayed', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await page.getByLabel('界面语言', { exact: true }).selectOption('en-US')
    await expect(page.getByText(/Request to model fixture-beta succeeded/)).toBeVisible()
    expect(operations.map(item => item.operation)).toEqual(['list-models', 'test-connection'])
    await page.screenshot({ path: testInfo.outputPath('models-en-desktop.png') })
  })

  test('服务商无列表接口明确失败并允许手填，隐藏页面后迟到列表不恢复', async ({ page }, testInfo) => {
    await open(page); await saveModel(page)
    modelStatus = 404
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    await expect(page.getByText(/MODEL_LIST_UNSUPPORTED/)).toBeVisible()
    await expect(page.getByLabel('从模型列表选择', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('模型名称', { exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('models-error-zh-desktop.png') })
    await page.getByLabel('模型名称', { exact: true }).fill('manually-kept')
    await expect(page.getByRole('button', { name: '测试模型连接', exact: true })).toBeDisabled()
    expect(modelRequests).toHaveLength(1)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
    modelStatus = 200
    const held = release()
    await page.route('**/api/plugins/dsh/manage', async route => {
      const response = await route.fetch()
      await held.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    await expect.poll(() => modelRequests.length).toBe(2)
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled()
    await hide(page)
    held.resolve(); await show(page)
    await expect(page.getByLabel('从模型列表选择', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('manually-kept')
  })
})
