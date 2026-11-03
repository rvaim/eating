import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { startImagesProviderFixture } from '../fixtures/images-provider'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectories = ['../../plugins/harness/dsh/dist/', '../../plugins/capabilities/image-generation/dist/'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected prerequisite fixture object'); return value }
async function json(route: Route, value: unknown, status = 200) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }) }
async function unusedPort() {
  const reservation = createServer()
  await new Promise<void>((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept) })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No prerequisite fixture port')
  await new Promise<void>((accept, reject) => reservation.close(error => error ? reject(error) : accept()))
  return address.port
}

test.use({ browserName: 'chromium', launchOptions: { args: ['--no-proxy-server', '--host-resolver-rules=MAP eating-prerequisite.test 127.0.0.1, MAP * ~NOTFOUND'] } })

test.describe('HTTP 面板前置条件与尺寸覆盖', () => {
  test.setTimeout(60_000)
  let directory: string | undefined
  let host: EatingHost | undefined
  let provider: Awaited<ReturnType<typeof startImagesProviderFixture>> | undefined
  let origin: string, ownerToken: string
  let errors: string[], escaped: string[], runtimeStarts: string[]

  test.beforeEach(async ({ page, context }) => {
    errors = []; escaped = []; runtimeStarts = []
    page.on('pageerror', error => errors.push(error.message))
    context.on('request', request => {
      const target = new URL(request.url())
      if (target.origin !== origin) escaped.push(target.origin)
      if (target.pathname === '/api/plugins/dsh/connect') runtimeStarts.push(target.pathname)
    })
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { await route.abort('blockedbyclient'); return }
      await route.continue()
    })
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_prerequisite_size_')))
    for (const pluginDirectory of pluginDirectories) await installPluginPackage(directory, pluginDirectory)
    origin = `http://eating-prerequisite.test:${await unusedPort()}`
    ownerToken = randomBytes(32).toString('base64url')
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: Number(new URL(origin).port), listenHost: '127.0.0.1', publicOrigin: origin, ownerToken, allowedUiOrigins: [], autoConnectOnStartup: false })
    await host.listen()
  })
  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      host = undefined
      try { await provider?.close() }
      finally {
        provider = undefined
        if (directory) {
          const target = await realpath(directory)
          if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_prerequisite_size_')) throw new Error('Unsafe prerequisite fixture cleanup')
          await rm(target, { recursive: true })
          directory = undefined
        }
      }
    }
    expect(escaped, 'Browser requests stay on the isolated HTTP host').toEqual([])
    expect(runtimeStarts, 'No actual DSH runtime is started').toEqual([])
    expect(errors).toEqual([])
  })

  async function enter(page: Page, hash: string) {
    const response = await page.goto(`${origin}/?token=${ownerToken}#${hash}`)
    expect(response?.status()).toBe(200)
    await expect(page).toHaveURL(`${origin}/#${hash}`)
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues }))).toEqual({ secure: false, uuid: 'undefined', random: 'function' })
  }

  async function dshFixture(page: Page) {
    const initial = host!.getWorkspace()
    const plugins = initial.plugins as JsonObject[]
    const entry = plugins.find(plugin => plugin.id === 'dsh')!
    let configuration = object(entry.configuration)
    let system: JsonObject = { found: false, path: null, version: null, source: null }
    let lastError: string | null = null
    let detectionCount = 0
    let unavailable = false
    const publicConfiguration = () => ({ ...configuration, runtimeStatus: { ...object(configuration.runtimeStatus), system, lastError } })
    await page.route('**/api/workspace', route => unavailable ? json(route, { error: { code: 'FIXTURE_STATUS_UNAVAILABLE', message: 'isolated status read failed', outcome: 'not-sent' } }, 503) : json(route, { ...initial, plugins: plugins.map(plugin => plugin.id === 'dsh' ? { ...plugin, configuration: publicConfiguration(), status: { ...object(plugin.status), state: lastError ? 'error' : 'disconnected', lastError } } : plugin) }))
    await page.route('**/api/plugins/dsh/configuration', async route => {
      const { apiKey, clearApiKey, ...patch } = object(route.request().postDataJSON())
      configuration = { ...configuration, ...patch, apiKeyConfigured: clearApiKey === true ? false : typeof apiKey === 'string' && Boolean(apiKey.trim()) || configuration.apiKeyConfigured === true, updatedAt: new Date().toISOString() }
      await json(route, publicConfiguration())
    })
    await page.route('**/api/plugins/dsh/manage', async route => {
      const body = object(route.request().postDataJSON())
      if (body.operation === 'detect-system-dsh') { detectionCount++; await json(route, system); return }
      if (body.operation === 'get-model-capabilities') { await json(route, { schemaVersion: 1, revision: 0, imageInput: false }); return }
      if (body.operation === 'get-model-information' || body.operation === 'read-model-information') { await json(route, { model: configuration.model, capabilities: null, fetchedAt: null, imageInput: false, appliedImageInput: null }); return }
      throw new Error('Unexpected DSH operation in prerequisite fixture: ' + String(body.operation))
    })
    return {
      get detections() { return detectionCount },
      found() { system = { found: true, path: '/fixture/runtime/bin/dsh', version: null, source: 'path' } },
      fail() { lastError = '独立夹具：DSH 启动入口返回错误（未实际启动）。' },
      loseStatus() { unavailable = true },
    }
  }

  test('缺少 DSH 顶部给服务器安装入口，草稿可保存，重新检测不伪造不可运行', async ({ page }, info) => {
    const fixture = await dshFixture(page)
    await enter(page, 'harness/dsh')
    const prerequisite = page.locator('.dsh-runtime')
    await expect(prerequisite.getByText('未检测到系统 DSH', { exact: true })).toBeVisible()
    await expect(prerequisite).toContainText('运行 Eating 的服务器未检测到 DSH')
    await expect(prerequisite.getByRole('link', { name: '官方安装说明与桌面下载' })).toHaveAttribute('href', 'https://www.deepseek.com/en/harness/')
    await expect(prerequisite).toContainText('npm install -g @deepseek-ai/dsh')
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath('missing-dsh-desktop.png') })
    await page.getByRole('tab', { name: '原生能力与插件', exact: true }).click()
    await expect(prerequisite).toContainText('运行 Eating 的服务器未检测到 DSH')
    await expect(page.locator('.dsh-native-settings [role="alert"]')).toHaveCount(0)
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await page.getByLabel('显示名称', { exact: true }).fill('未安装时保存的草稿')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存，运行已停止。需要时请重新启动 Harness。', { exact: true })).toBeVisible()
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('未安装时保存的草稿')
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    await page.getByLabel('模型名称', { exact: true }).fill('尚未保存的模型草稿')
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await expect.poll(() => fixture.detections).toBe(1)
    await expect(prerequisite).toContainText('运行 Eating 的服务器未检测到 DSH')
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('尚未保存的模型草稿')
    await expect(page.getByRole('button', { name: '重新检测', exact: true })).toBeEnabled()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await prerequisite.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('missing-dsh-390-dark.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByLabel('API 基础地址', { exact: true }).fill(`${origin}/unused-chat-fixture`)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存，运行已停止。需要时请重新启动 Harness。', { exact: true })).toBeVisible()
    fixture.found()
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await expect.poll(() => fixture.detections).toBe(2)
    await expect(prerequisite).toContainText('已找到可执行命令，但未取得版本号')
    await expect(prerequisite).toContainText('这不表示 DSH 无法运行')
    await expect(page.getByRole('button', { name: '启动 Harness', exact: true })).toBeEnabled()
    fixture.fail()
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(prerequisite).toContainText('已找到 DSH，运行状态需检查')
    await expect(page.getByText('独立夹具：DSH 启动入口返回错误（未实际启动）。', { exact: true })).toBeVisible()
    expect(runtimeStarts).toHaveLength(0)
  })

  test('检测读取失败显示未确认，不能冒充未安装，草稿与语言切换保持', async ({ page }) => {
    const fixture = await dshFixture(page)
    await enter(page, 'harness/dsh')
    await expect(page.getByLabel('模型名称', { exact: true })).toBeVisible()
    await page.getByLabel('模型名称', { exact: true }).fill('保留这份草稿')
    fixture.loseStatus()
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(page.locator('.dsh-runtime')).toContainText('DSH 检测状态尚未确认')
    await expect(page.locator('.dsh-runtime')).not.toContainText('运行 Eating 的服务器未检测到 DSH')
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.locator('.dsh-runtime')).toContainText('DSH installation status is unconfirmed')
    await expect(page.getByLabel('Model name', { exact: true })).toHaveValue('保留这份草稿')
    await expect(page.getByRole('button', { name: 'Start Harness', exact: true })).toBeDisabled()
  })

  test('生图前置原因明确，无 Key 可本地就绪，生成与编辑按单次尺寸覆盖', async ({ page }, info) => {
    provider = await startImagesProviderFixture('base64', { edit: true })
    await enter(page, 'plugins/image-generation')
    await expect(page.getByText('生图尚未就绪：请填写并保存图片模型名称。', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeDisabled()
    await page.getByLabel('Base URL', { exact: true }).fill(provider.baseUrl)
    await page.getByLabel('模型', { exact: true }).fill('size-browser-fixture')
    await page.getByLabel('默认图片尺寸', { exact: true }).fill('1024x1024')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('本地就绪', { exact: true })).toBeVisible()
    await expect(page.getByText(/允许匿名访问的服务可留空/)).toBeVisible()
    expect(provider.requests).toHaveLength(0)
    expect(provider.edits).toHaveLength(0)
    await page.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。保存只更新本地配置。', { exact: true }).first()).toBeVisible()
    await page.getByText('本次参数覆盖（可选）', { exact: true }).click()
    await page.getByLabel('本次尺寸', { exact: true }).fill('513x1793')
    await page.getByLabel('提示词', { exact: true }).fill('自定义竖图尺寸')
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Size for this job', { exact: true })).toHaveValue('513x1793')
    await page.locator('#display-language').selectOption('zh-CN')
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    expect(provider.requests).toHaveLength(0)
    await page.getByRole('button', { name: '确认提交', exact: true }).click()
    await expect(page.locator('.image-job').filter({ hasText: '自定义竖图尺寸' }).getByText('已完成', { exact: true })).toBeVisible()
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]!.body.size).toBe('513x1793')
    await page.getByLabel('参考图（可选）', { exact: true }).setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: provider.image })
    await page.getByLabel('本次尺寸', { exact: true }).fill('1024x1536')
    await page.getByLabel('提示词', { exact: true }).fill('编辑图单次竖向尺寸')
    await page.getByRole('button', { name: '编辑图片', exact: true }).click()
    await page.getByRole('button', { name: '确认提交', exact: true }).click()
    await expect(page.locator('.image-job').filter({ hasText: '编辑图单次竖向尺寸' }).getByText('已完成', { exact: true })).toBeVisible()
    expect(provider.edits).toHaveLength(1)
    expect(provider.edits[0]!.fields.size).toBe('1024x1536')
    await page.getByRole('checkbox', { name: '本次使用服务默认尺寸', exact: true }).check()
    await expect(page.getByLabel('本次尺寸', { exact: true })).toBeDisabled()
    await page.getByLabel('提示词', { exact: true }).fill('显式省略默认尺寸')
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    await page.getByRole('button', { name: '确认提交', exact: true }).click()
    await expect(page.locator('.image-job').filter({ hasText: '显式省略默认尺寸' }).getByText('已完成', { exact: true })).toBeVisible()
    expect(provider.requests).toHaveLength(2)
    expect(Object.hasOwn(provider.requests[1]!.body, 'size')).toBe(false)
    await page.getByLabel('默认图片尺寸', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-size-defaults.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('checkbox', { name: '本次使用服务默认尺寸', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-size-390-dark.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test('HTTP 尺寸提交失败不自动请求，原意图重试保 ID，空串与沿用默认有独立意图', async ({ page }) => {
    const submissions: JsonObject[] = []
    await page.route('**/api/plugins/image-generation/manage', async route => {
      const body = object(route.request().postDataJSON())
      if (body.operation !== 'generate') { await route.fallback(); return }
      submissions.push(object(body.input))
      await json(route, { error: { code: 'IMAGE_GENERATION_HTTP_400', message: 'isolated size refusal', outcome: 'failed' } }, 400)
    })
    await enter(page, 'plugins/image-generation')
    await page.getByLabel('Base URL', { exact: true }).fill(`${origin}/unused-image-provider`)
    await page.getByLabel('模型', { exact: true }).fill('size-intent-browser-fixture')
    await page.getByLabel('默认图片尺寸', { exact: true }).fill('1024x1024')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('本地就绪', { exact: true })).toBeVisible()
    await page.getByLabel('提示词', { exact: true }).fill('仅 HTTP 参数夹具，无真实生成')
    await page.getByText('本次参数覆盖（可选）', { exact: true }).click()
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    const submit = page.getByRole('button', { name: '确认提交', exact: true })
    await submit.click()
    await expect(submit).toBeEnabled()
    expect(submissions).toHaveLength(1)
    expect(submissions[0]!.request_id).toMatch(uuid)
    expect(Object.hasOwn(submissions[0]!, 'size')).toBe(false)
    await submit.click()
    await expect(submit).toBeEnabled()
    expect(submissions).toHaveLength(2)
    expect(submissions[1]!.request_id).toBe(submissions[0]!.request_id)
    await page.getByRole('checkbox', { name: '本次使用服务默认尺寸', exact: true }).check()
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    await submit.click()
    await expect(submit).toBeEnabled()
    expect(submissions).toHaveLength(3)
    expect(submissions[2]!.size).toBe('')
    expect(submissions[2]!.request_id).not.toBe(submissions[0]!.request_id)
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByRole('button', { name: 'Confirm submit', exact: true })).toBeEnabled()
    expect(submissions).toHaveLength(3)
  })
})
