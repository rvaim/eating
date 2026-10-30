import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonObject } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = (kind: string, id: string) => fileURLToPath(new URL(`../../plugins/${kind}/${id}/dist/`, import.meta.url))
const delay = () => {
  let release!: () => void
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise })
  return { promise, release }
}

test.describe('Harness 独立面板与泛型目录', () => {
  test.setTimeout(45000)
  let directory: string | undefined
  let host: EatingHost | undefined
  let url: string
  let pageErrors: string[]

  test.beforeEach(async ({ page }) => {
    pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_harness_ui_')))
    await installPluginPackage(directory, pluginDirectory('communication', 'qq'))
    await installPluginPackage(directory, pluginDirectory('harness', 'dsh'))
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      host = undefined
      if (directory) {
        const target = await realpath(directory)
        const temporaryRoot = await realpath(tmpdir())
        if (target !== resolve(directory) || dirname(target) !== temporaryRoot || !basename(target).startsWith('Eating_harness_ui_')) throw new Error('拒绝删除未核对的 Harness 测试目录')
        await rm(target, { recursive: true })
        directory = undefined
      }
    }
    expect(pageErrors).toEqual([])
  })

  async function open(page: Page) {
    await page.goto(`${url}/#harness/dsh`)
    await expect(page.getByLabel('API 基础地址', { exact: true })).toBeVisible()
  }
  async function save(page: Page) {
    const response = page.waitForResponse(response => response.url() === `${url}/api/plugins/dsh/configuration` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    expect((await response).status()).toBe(200)
    await expect(page.getByText('配置已保存，运行已停止。需要时请重新启动 Harness。', { exact: true })).toBeVisible()
  }
  async function json(route: Route, value: unknown, status = 200) {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  }

  test('真实空配置保持待配置，密钥只写入且通讯与 Harness 目录独立', async ({ page }, testInfo) => {
    await open(page)
    await expect(page.getByRole('navigation', { name: 'Harness 分类', exact: true }).getByRole('button', { name: 'QQ', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    await expect(page.getByText('待配置', { exact: true }).first()).toBeVisible()
    await expect(page.getByLabel('API 基础地址', { exact: true })).toHaveValue('')
    await save(page)
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    await page.getByLabel('API 基础地址', { exact: true }).fill('https://api.example.test/v1')
    await page.getByLabel('模型名称', { exact: true }).fill('fixture-model')
    await page.getByLabel('API Key', { exact: true }).fill('ui-fixture-key')
    await save(page)
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    const workspace = await (await page.request.get(`${url}/api/workspace`)).json() as { plugins: { id: string; configuration: JsonObject }[] }
    const config = workspace.plugins.find(plugin => plugin.id === 'dsh')!.configuration
    expect(config.apiKeyConfigured).toBe(true)
    expect(config.apiKey).toBeUndefined()
    const path = String(config.configurationPath)
    expect(path.startsWith(directory! + '/')).toBe(true)
    const disk = () => readFile(path, 'utf8').then(text => JSON.parse(text) as { configuration: { apiKey: string } })
    expect((await disk()).configuration.apiKey).toBe('ui-fixture-key')
    await page.getByLabel('显示名称', { exact: true }).fill('独立 Harness 配置')
    await save(page)
    expect((await disk()).configuration.apiKey).toBe('ui-fixture-key')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('checkbox', { name: '清除已保存的 API Key', exact: false }).check()
    await save(page)
    expect((await disk()).configuration.apiKey).toBe('')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: testInfo.outputPath('harness-desktop.png'), fullPage: true })
    await page.getByRole('button', { name: '添加插件', exact: true }).click()
    const catalog = page.getByRole('region', { name: '已安装插件', exact: true })
    await expect(catalog.getByRole('heading', { name: 'QQ', exact: false })).toBeVisible()
    await expect(catalog.getByRole('heading', { name: 'DeepSeek Harness', exact: false })).toBeVisible()
    await expect(catalog.getByText('通讯插件', { exact: true })).toBeVisible()
    await expect(catalog.getByText('Harness', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: '机器人', exact: true }).click()
    await expect(page.getByRole('navigation', { name: '平台分类', exact: true }).getByRole('button', { name: 'QQ', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '平台分类', exact: true }).getByRole('button', { name: 'DeepSeek Harness', exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: '概览', exact: true }).click()
    await expect(page.getByText('1 个已启用', { exact: true })).toBeVisible()
    await expect(page.getByText('尚未连接', { exact: true })).toBeVisible()
  })

  test('界面状态夹具：异步安装、启动停止与未知结果不重复提交，390px可操作', async ({ page }, testInfo) => {
    expect((await page.request.get(`${url}/api/bootstrap`)).status()).toBe(200)
    const initialResponse = await page.request.get(`${url}/api/workspace`)
    expect(initialResponse.status()).toBe(200)
    const initial = await initialResponse.json() as { plugins: { id: string; configuration: JsonObject; status: JsonObject }[] }
    const dsh = initial.plugins.find(plugin => plugin.id === 'dsh')!
    const configuration: JsonObject = { ...dsh.configuration, endpoint: 'https://api.example.test/v1', model: 'fixture-model' }
    const runtime = configuration.runtimeStatus as JsonObject
    const status = { ...dsh.status, state: 'disconnected' }
    let installCount = 0
    let connectCount = 0
    let disconnectCount = 0
    let unknown = false
    const installation = delay()
    const connection = delay()
    await page.route('**/api/workspace', route => json(route, { ...initial, plugins: initial.plugins.map(plugin => plugin.id === 'dsh' ? { ...plugin, configuration, status } : plugin) }))
    await page.route('**/api/plugins/dsh/manage', async route => {
      if (route.request().postDataJSON().operation === 'get-model-capabilities') { await route.continue(); return }
      installCount++
      expect(route.request().postDataJSON()).toEqual({ operation: 'install-runtime', input: {} })
      runtime.installing = true; runtime.progress = '界面夹具：正在安装'
      await installation.promise
      await json(route, { started: true })
    })
    await page.route('**/api/plugins/dsh/connect', async route => {
      connectCount++
      if (unknown) { await json(route, { error: { code: 'FIXTURE_UNKNOWN', message: '界面夹具：启动结果未知', outcome: 'unknown' } }, 504); return }
      status.state = 'connecting'
      await connection.promise
      status.state = 'connected'; runtime.ready = true; runtime.busy = true; runtime.sessionId = 'fixture-main-session'
      await json(route, status)
    })
    await page.route('**/api/plugins/dsh/disconnect', async route => {
      disconnectCount++; status.state = 'disconnected'; runtime.ready = false; runtime.busy = false
      await json(route, status)
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    await page.getByRole('button', { name: '安装运行时', exact: true }).click()
    await expect.poll(() => installCount).toBe(1)
    await expect(page.getByRole('button', { name: '正在安装…', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    installation.release()
    await expect(page.getByText('正在安装运行时，请稍候…', { exact: true })).toBeVisible()
    runtime.installing = false; runtime.installed = true; runtime.progress = null
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '启动 Harness', exact: true }).click()
    await expect.poll(() => connectCount).toBe(1)
    await expect(page.getByRole('button', { name: '正在启动…', exact: true })).toBeDisabled()
    connection.release()
    await expect(page.getByText('正在处理', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('fixture-main-session', { exact: true })).toBeVisible()
    await expect(page.getByText('账号：', { exact: false })).toHaveCount(0)
    runtime.busy = false; runtime.lastOutcome = 'completed'
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(page.getByText('空闲', { exact: true }).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: testInfo.outputPath('harness-mobile.png'), fullPage: true })
    await page.getByRole('button', { name: '停止 Harness', exact: true }).click()
    await expect.poll(() => disconnectCount).toBe(1)
    unknown = true
    await page.getByRole('button', { name: '启动 Harness', exact: true }).click()
    await expect(page.getByText('操作未完成，请刷新状态后重试。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '我已核对当前状态', exact: true })).toBeEnabled()
    expect(connectCount).toBe(2)
    expect(installCount).toBe(1)
  })

  test('页面隐藏清理密钥并停止读取，离页后的迟到保存不影响作者页面', async ({ page }) => {
    let workspaceReads = 0
    page.on('request', request => { if (request.url() === `${url}/api/workspace`) workspaceReads++ })
    await open(page)
    await page.getByLabel('API Key', { exact: true }).fill('transient-fixture-key')
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    const before = workspaceReads
    await page.waitForTimeout(3200)
    expect(workspaceReads).toBe(before)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect.poll(() => workspaceReads).toBeGreaterThan(before)
    const saved = delay()
    let saving = false
    await page.route('**/api/plugins/dsh/configuration', async route => {
      const response = await route.fetch()
      saving = true
      await saved.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await page.getByLabel('显示名称', { exact: true }).fill('迟到保存夹具')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect.poll(() => saving).toBe(true)
    await page.getByRole('link', { name: '提示词管理', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '提示词内容', exact: true })).toBeVisible()
    saved.release()
    await expect(page.getByRole('heading', { name: '通用前置提示词', exact: true })).toBeVisible()
    await expect(page.getByText('DeepSeek Harness 配置已保存。', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('API Key', { exact: true })).toHaveCount(0)
  })

  test('限流错误直接显示提供商原因，只出现一次并随成功状态清除', async ({ page }, testInfo) => {
    await page.request.get(`${url}/api/bootstrap`)
    const initial = await (await page.request.get(`${url}/api/workspace`)).json() as { plugins: { id: string; configuration: JsonObject; status: JsonObject }[] }
    const detail = '模型服务限流（HTTP 429），请按提供商提示等待额度恢复或选择其他可用模型。 错误代码：RATE_LIMIT。 提供商详情：WorkBuddy AI: usage exceeds frequency limit; reset at 2026-10-30 10:57:58 UTC+8.'
    let lastError: string | null = detail
    await page.route('**/api/workspace', route => json(route, { ...initial, plugins: initial.plugins.map(plugin => plugin.id === 'dsh' ? {
      ...plugin,
      status: { ...plugin.status, state: 'connected', lastError },
      configuration: { ...plugin.configuration, endpoint: 'http://127.0.0.1:1/v1', model: 'fixture-model',
        runtimeStatus: { ...(plugin.configuration.runtimeStatus as JsonObject), ready: true, busy: false, lastError } },
    } : plugin) }))
    await page.emulateMedia({ colorScheme: 'dark' })
    await open(page)
    const alerts = page.locator('.dsh-panel [role="alert"]')
    await expect(alerts).toHaveCount(1)
    await expect(alerts).toContainText('HTTP 429')
    await expect(alerts).toContainText('2026-10-30 10:57:58 UTC+8')
    await expect(page.getByText('运行中', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('rate-limit-dark.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(alerts).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('rate-limit-mobile.png'), fullPage: true })
    lastError = null
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(alerts).toHaveCount(0)
    await expect(page.getByText('运行中', { exact: true })).toBeVisible()
  })

  test('DSH面板资源失败仍归Harness且QQ配置继续可用', async ({ page }) => {
    await page.route('**/plugins/dsh/*/ui/index.js', route => route.abort())
    await page.goto(`${url}/#harness/dsh`)
    await expect(page.getByRole('alert').getByText('此插件的配置面板无法加载，请检查插件安装后重启 Eating。其他插件仍可使用。', { exact: true })).toBeVisible()
    const harnessNav = page.getByRole('navigation', { name: 'Harness 分类', exact: true })
    await expect(harnessNav.getByRole('button', { name: 'DeepSeek Harness', exact: true })).toBeVisible()
    await expect(harnessNav.getByRole('button', { name: 'QQ', exact: true })).toHaveCount(0)
    await page.goto(`${url}/#robots/qq`)
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '平台分类', exact: true }).getByRole('button', { name: 'DeepSeek Harness', exact: true })).toHaveCount(0)
    await expect(page.locator('.storage-alert')).toHaveCount(0)
  })
})
