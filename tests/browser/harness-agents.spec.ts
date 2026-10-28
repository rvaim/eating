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
import type { HarnessSessionContent, HarnessSessionList, HarnessSessionSummary, JsonValue } from '@eating/plugin-sdk'
import { EatingHost } from '../../apps/host/src/app'
import { discoverBackendPlugins } from '../../apps/host/src/discovery'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { DEFAULT_CONFIGURATION, parseConfiguration } from '../../plugins/harness/dsh/src/backend/config'
import { listModels, testModelConnection } from '../../plugins/harness/dsh/src/backend/model-service'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url))
const refreshedAt = '2026-10-28T13:00:00Z'
const summary = (id: string, parentId: string | null, title: string): HarnessSessionSummary => ({ id, parentId, title, status: 'unknown', updatedAt: refreshedAt })
const main = summary('fixture-main', null, '主会话夹具')
const child = summary('fixture-child', main.id, '子代理夹具')
const release = () => { let resolvePromise!: () => void; const promise = new Promise<void>(resolve => { resolvePromise = resolve }); return { promise, resolve: resolvePromise } }

test.describe('Harness 模型连接与手动原生会话看板（本地夹具）', () => {
  test.setTimeout(45000)
  let directory: string
  let host: EatingHost | undefined
  let modelServer: Server | undefined
  let url: string
  let modelUrl: string
  let modelStatus: number
  let modelRequests: { path: string; authorization: string | undefined; body: string }[]
  let operations: { operation: string; input: unknown }[]
  let sessionList: HarnessSessionList
  let readContent: (input: { sessionId: string; offset?: number; limit?: number }) => Promise<HarnessSessionContent>
  let pageErrors: string[]

  test.beforeEach(async ({ page }) => {
    operations = []; modelRequests = []; modelStatus = 200; pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    sessionList = { sessions: [main, child, summary('fixture-orphan', 'missing-parent', '孤立会话夹具'), summary('fixture-loop', 'fixture-loop', '循环会话夹具')], truncated: true, refreshedAt }
    readContent = async input => ({ session: input.sessionId === main.id ? main : child, records: [{ sequence: (input.offset ?? 0) + 1, timestamp: refreshedAt, kind: 'message', role: 'assistant', content: 'fixture-only-private-content' }], nextOffset: input.offset ? null : 50, refreshedAt })
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
      // Deliberate UI fixture: native session behavior is validated separately by official SDK integration.
      return new Proxy(original, { get(target, key) {
        if (key === 'updateConfiguration') return async (input: unknown) => { const result = await target.updateConfiguration(input); configuration = parseConfiguration(input, configuration); return result }
        if (key === 'manage') return async (operation: string, input: unknown): Promise<JsonValue> => {
          operations.push({ operation, input })
          if (operation === 'list-models') return { models: (await listModels(configuration)).models.map(model => ({ ...model })) }
          if (operation === 'test-connection') return testModelConnection(configuration)
          if (operation === 'list-sessions') return sessionList as unknown as JsonValue
          if (operation === 'read-session') return await readContent(input as { sessionId: string; offset?: number; limit?: number }) as unknown as JsonValue
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
  async function dashboard(page: Page) { await page.getByRole('tab', { name: '会话看板', exact: true }).click() }
  async function refresh(page: Page) { await page.getByRole('button', { name: '刷新会话列表', exact: true }).click(); await expect(page.getByRole('navigation', { name: '会话层级' })).toBeVisible() }
  const reads = () => operations.filter(item => item.operation === 'list-sessions' || item.operation === 'read-session')

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

  test('服务商无列表接口明确失败并允许手填，取消后迟到列表不恢复', async ({ page }, testInfo) => {
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
    await dashboard(page)
    held.resolve()
    await page.getByRole('tab', { name: '配置', exact: true }).click()
    await expect(page.getByLabel('从模型列表选择', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('manually-kept')
  })

  test('手动列表、层级异常、内容分页与语言切换均不触发后台读取，390px无横溢出', async ({ page }, testInfo) => {
    await open(page); await dashboard(page)
    await expect(page.getByText('点击“刷新会话列表”查看此 Harness 的会话。', { exact: true })).toBeVisible()
    await page.waitForTimeout(3200)
    expect(reads()).toHaveLength(0)
    await refresh(page)
    await expect(page.getByText('父会话未在当前列表中', { exact: true })).toBeVisible()
    await expect(page.getByText('层级关系异常，已作为根会话显示', { exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: '会话层级' }).getByRole('button', { name: /主会话夹具/ }).click()
    await expect(page.getByText('fixture-only-private-content', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await expect(page.getByText('fixture-only-private-content', { exact: true })).toHaveCount(2)
    expect(reads()).toEqual([{ operation: 'list-sessions', input: {} }, { operation: 'read-session', input: { sessionId: main.id, offset: 0, limit: 50 } }, { operation: 'read-session', input: { sessionId: main.id, offset: 50, limit: 50 } }])
    await page.screenshot({ path: testInfo.outputPath('sessions-zh-desktop.png') })
    await page.getByLabel('界面语言', { exact: true }).selectOption('en-US')
    await expect(page.getByRole('button', { name: 'Refresh session list', exact: true })).toBeVisible()
    await page.waitForTimeout(3200)
    expect(reads()).toHaveLength(3)
    await page.screenshot({ path: testInfo.outputPath('sessions-en-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('sessions-en-mobile.png') })
  })

  test('隐藏和切配置均清除会话正文，返回看板需再次手动刷新，配置草稿保留', async ({ page }) => {
    await open(page)
    await page.getByLabel('模型名称', { exact: true }).fill('keep-owner-draft')
    await dashboard(page); await refresh(page)
    await page.getByRole('navigation', { name: '会话层级' }).getByRole('button', { name: /主会话夹具/ }).click()
    await expect(page.getByText('fixture-only-private-content', { exact: true })).toBeVisible()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByText('fixture-only-private-content', { exact: true })).toHaveCount(0)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByText('点击“刷新会话列表”查看此 Harness 的会话。', { exact: true })).toBeVisible()
    expect(reads()).toHaveLength(2)
    await page.getByRole('tab', { name: '配置', exact: true }).click()
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('keep-owner-draft')
    await dashboard(page)
    await expect(page.getByText('点击“刷新会话列表”查看此 Harness 的会话。', { exact: true })).toBeVisible()
    expect(reads()).toHaveLength(2)
    await page.getByRole('tab', { name: '会话看板', exact: true }).press('ArrowLeft')
    await expect(page.getByRole('tab', { name: '配置', exact: true })).toBeFocused()
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('keep-owner-draft')
  })

  test('切换会话和离开页面时拒绝迟到正文；空列表有明确空态', async ({ page }) => {
    await open(page); await dashboard(page); await refresh(page)
    const held = release()
    await page.route('**/api/plugins/dsh/manage', async route => {
      const body = route.request().postDataJSON() as { operation?: string; input?: { sessionId?: string } }
      if (body.operation !== 'read-session' || body.input?.sessionId !== main.id) { await route.continue(); return }
      const response = await route.fetch()
      await held.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await page.getByRole('navigation', { name: '会话层级' }).getByRole('button', { name: /主会话夹具/ }).click()
    await expect.poll(() => reads().length).toBe(2)
    await page.getByRole('navigation', { name: '会话层级' }).getByRole('button', { name: /子代理夹具/ }).click()
    held.resolve()
    await expect(page.getByRole('heading', { name: '子代理夹具', exact: true })).toBeVisible()
    await expect(page.getByText('fixture-only-private-content', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '主会话夹具', exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: '概览', exact: true }).click()
    await expect(page.getByText('fixture-only-private-content', { exact: true })).toHaveCount(0)
    sessionList = { sessions: [], truncated: false, refreshedAt }
    await page.goto(`${url}/#harness/dsh`); await dashboard(page)
    await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
    await expect(page.getByText('尚无会话。', { exact: true })).toBeVisible()
  })
})
