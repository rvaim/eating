import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { fixtureImage, fixturePng } from '../../plugins/capabilities/stickers/src/backend/test-fixtures'
import type { EatingHost } from '../../apps/host/src/app'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const row = (page: Page, name: string) => page.locator('.plugins-row').filter({ hasText: name })
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
const plugin = (id: string, name: string, version: string, kind: 'communication' | 'harness' | 'capability', enabled: boolean, state: string, withFrontend = true) => ({
  id, name, description: `${name} 的说明`, version, kind, enabled, status: { state, lastError: null },
  frontend: withFrontend ? { entry: `/plugins/${id}/${version}/ui/index.js`, style: `/plugins/${id}/${version}/ui/style.css` } : null,
})

function makePlugins() {
  return [
    plugin('qq', 'QQ', '0.11.0', 'communication', true, 'connected'),
    plugin('dsh', 'DeepSeek Harness', '0.8.0', 'harness', true, 'disconnected'),
    plugin('cap-fixture', '能力样例', '1.0.0', 'capability', false, 'unconfigured', false),
  ]
}

test.describe('插件管理页', () => {
  test.setTimeout(45_000)
  let directory: string, host: EatingHost, url: string
  let plugins: ReturnType<typeof makePlugins>
  let failList: boolean, errors: string[]
  let disableCalls: number, enableCalls: number, uninstallCalls: number, installCalls: number, previews: string[], installs: unknown[], uninstalls: unknown[]

  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_plugin_ui_')))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [] }); url = await host.listen()
    plugins = makePlugins(); failList = false; errors = []
    disableCalls = 0; enableCalls = 0; uninstallCalls = 0; installCalls = 0; previews = []; installs = []; uninstalls = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/plugin-packages', async route => {
      if (route.request().method() === 'GET') {
        if (failList) { await json(route, { error: { code: 'FIXTURE_PLUGINS', message: '插件读取失败', outcome: 'failed' } }, 500); return }
        await json(route, { protocolVersion: 1, plugins }); return
      }
      const body = route.request().postDataJSON() as { operation: string; input: Record<string, unknown> }
      if (body.operation === 'preview') {
        previews.push(String(body.input.sourceDirectory))
        await json(route, { planId: 'plan-fixture', manifest: { id: 'new-capability', name: '新能力插件', description: '本地构建的能力插件', version: '1.2.3', kind: 'capability', apiVersion: 4 }, packageBytes: 2048, digest: '0123456789abcdef0123456789abcdef' }); return
      }
      if (body.operation === 'install') {
        installCalls++; installs.push(body.input)
        plugins = [...plugins, plugin('new-capability', '新能力插件', '1.2.3', 'capability', true, 'unconfigured', false)]
        await json(route, { ok: true }); return
      }
      if (body.operation === 'uninstall') {
        uninstallCalls++; uninstalls.push(body.input)
        plugins = plugins.filter(entry => entry.id !== body.input.id)
        await json(route, { ok: true }); return
      }
      await json(route, { error: { code: 'FIXTURE_OPERATION', outcome: 'not-sent' } }, 400)
    })
    await page.route('**/api/plugins/*/disable', async route => {
      disableCalls++
      const id = decodeURIComponent(route.request().url().split('/').at(-2) ?? '')
      plugins = plugins.map(entry => entry.id === id ? { ...entry, enabled: false, status: { ...entry.status, state: 'disconnected' } } : entry)
      await json(route, { ok: true })
    })
    await page.route('**/api/plugins/*/enable', async route => {
      enableCalls++
      const id = decodeURIComponent(route.request().url().split('/').at(-2) ?? '')
      plugins = plugins.map(entry => entry.id === id ? { ...entry, enabled: true, status: { ...entry.status, state: 'connected' } } : entry)
      await json(route, { ok: true })
    })
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_plugin_ui_')) throw new Error('Unsafe plugin fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })

  const row = (page: Page, name: string) => page.locator('.plugins-row').filter({ hasText: name })
  async function goto(page: Page) {
    await page.goto(url + '/#plugins')
    await expect(page.getByRole('heading', { name: '插件', level: 1 })).toBeVisible()
  }

  test('统一列出三类插件，可筛选并跳转业务配置与独立面板', async ({ page }, info) => {
    await goto(page)
    await expect(row(page, 'QQ')).toContainText('通讯插件')
    await expect(row(page, 'DeepSeek Harness')).toContainText('Harness')
    await expect(row(page, '能力样例')).toContainText('能力插件')
    await page.getByRole('button', { name: '通讯', exact: true }).click()
    await expect(row(page, 'QQ')).toBeVisible(); await expect(row(page, 'DeepSeek Harness')).toHaveCount(0)
    await page.getByRole('button', { name: '能力', exact: true }).click()
    await expect(row(page, '能力样例')).toBeVisible(); await expect(row(page, 'QQ')).toHaveCount(0)
    await page.getByRole('button', { name: '全部', exact: true }).click()
    expect(await row(page, 'QQ').getByRole('link', { name: '打开面板', exact: true }).getAttribute('href')).toBe('#plugins/qq')
    expect(await row(page, 'QQ').getByRole('link', { name: '业务配置', exact: true }).getAttribute('href')).toBe('#robots/qq')
    expect(await row(page, 'DeepSeek Harness').getByRole('link', { name: '业务配置', exact: true }).getAttribute('href')).toBe('#harness/dsh')
    await page.screenshot({ path: info.outputPath('plugins-desktop.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300)
    await page.screenshot({ path: info.outputPath('plugins-desktop-dark.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(300)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath('plugins-390.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await row(page, 'QQ').getByRole('link', { name: '打开面板', exact: true }).click()
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#plugins/qq')
    await expect(page.getByRole('link', { name: '返回插件列表', exact: true })).toBeVisible()
  })

  test('启用停用与卸载确认保数据', async ({ page }, info) => {
    await goto(page)
    await row(page, 'QQ').getByRole('button', { name: '停用', exact: true }).click()
    await expect.poll(() => disableCalls).toBe(1)
    await expect(row(page, 'QQ')).toContainText('已停用')
    await row(page, 'QQ').getByRole('button', { name: '启用', exact: true }).click()
    await expect.poll(() => enableCalls).toBe(1)
    await row(page, '能力样例').getByRole('button', { name: '卸载', exact: true }).click()
    await expect(page.getByText('确定卸载“能力样例”？', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '确认卸载', exact: true }).click()
    await expect.poll(() => uninstallCalls).toBe(1)
    expect(uninstalls[0]).toEqual({ id: 'cap-fixture', confirmed: true })
    await expect(row(page, '能力样例')).toHaveCount(0)
    await expect(page.getByText('插件已卸载，配置与数据已保留。', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: info.outputPath('plugins-uninstall.png'), fullPage: true })
  })

  test('安装先预览后确认，预览不执行，确认后才调用 install', async ({ page }, info) => {
    await goto(page)
    await page.getByRole('button', { name: '安装或更新', exact: true }).click()
    await page.locator('#plugins-source').fill('/tmp/fixture-plugin/dist')
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect.poll(() => previews.length).toBe(1)
    expect(previews[0]).toBe('/tmp/fixture-plugin/dist')
    await expect(page.getByText('新能力插件 · v1.2.3', { exact: true })).toBeVisible()
    expect(installCalls).toBe(0)
    await page.getByRole('button', { name: '确认安装', exact: true }).click()
    await expect.poll(() => installCalls).toBe(1)
    expect(installs[0]).toEqual({ planId: 'plan-fixture', confirmed: true })
    await expect(page.getByText('插件已安装。', { exact: true }).first()).toBeVisible()
    await expect(row(page, '新能力插件')).toBeVisible()
    await page.screenshot({ path: info.outputPath('plugins-install.png'), fullPage: true })
  })

  test('空态、错误态与 390px 可用', async ({ page }, info) => {
    plugins = []
    await goto(page)
    await expect(page.getByText('没有找到插件', { exact: true })).toBeVisible()
    failList = true
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.getByText('无法读取插件列表。请检查 Eating 是否正在运行后重试。', { exact: true })).toBeVisible()
    failList = false
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.getByText('没有找到插件', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: info.outputPath('plugins-empty-390.png'), fullPage: true })
  })
})

test.describe('插件真实安装与表情库（临时 Host，无路由桩）', () => {
  test.setTimeout(90_000)
  let directory: string, host: EatingHost, url: string
  let errors: string[]
  const stickersDirectory = fileURLToPath(new URL('../../plugins/capabilities/stickers/dist/', import.meta.url))
  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_stickers_e2e_')))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
    url = await host.listen(); errors = []
    page.on('pageerror', error => errors.push(error.message))
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_stickers_e2e_')) throw new Error('Unsafe sticker E2E cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })
  async function bootstrap(page: Page) {
    const response = await page.request.get(url + '/api/bootstrap')
    expect(response.status()).toBe(200)
    return (await response.json() as { csrfToken: string }).csrfToken
  }
  async function installStickers(page: Page) {
    await page.goto(url + '/#plugins')
    await page.getByRole('button', { name: '安装或更新', exact: true }).click()
    await page.locator('#plugins-source').fill(stickersDirectory)
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.getByText('表情包 · v0.1.0', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '确认安装', exact: true }).click()
    await expect(row(page, '表情包')).toBeVisible()
  }
  async function openStickers(page: Page) {
    await row(page, '表情包').getByRole('link', { name: '打开面板', exact: true }).click()
    await expect(page.getByRole('heading', { name: /表情库/ })).toBeVisible()
  }
  test('预览安装真实插件，上传/分页/筛选/编辑，卸载重装保留表情库', async ({ page }, info) => {
    await installStickers(page)
    await openStickers(page)
    await page.getByRole('button', { name: '添加表情', exact: true }).click()
    await page.getByLabel('本地图片', { exact: true }).setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: fixturePng(99) })
    await page.getByLabel('描述', { exact: true }).fill('本地上传的 PNG')
    await page.getByLabel('标签', { exact: true }).fill('本地\n上传')
    await page.getByRole('button', { name: '添加到表情库', exact: true }).click()
    await expect(page.getByRole('button', { name: /本地上传的 PNG/ })).toBeVisible()
    const csrf = await bootstrap(page)
    for (let index = 0; index < 23; index++) {
      const response = await page.request.post(url + '/api/plugins/stickers/manage', { headers: { 'X-Eating-Csrf': csrf }, data: { operation: 'add', input: { ...fixtureImage(index), description: `Fixture ${String(index).padStart(2, '0')}`, tags: index % 2 ? ['fixture', 'greeting'] : ['fixture'] } } })
      expect(response.ok()).toBe(true)
    }
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.stickers-row').length === 20)
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.stickers-row').length === 4)
    await page.getByLabel('按标签筛选', { exact: true }).selectOption(['greeting'])
    await page.getByRole('button', { name: '筛选', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.stickers-row').length === 11)
    await page.getByRole('button', { name: /Fixture 01/ }).click()
    await expect(page.getByRole('img', { name: '所选表情图片' })).toBeVisible()
    await page.getByLabel('描述', { exact: true }).fill('Fixture 01 已编辑')
    await page.getByRole('button', { name: '保存资料', exact: true }).click()
    await expect(page.getByRole('button', { name: /Fixture 01 已编辑/ })).toBeVisible()
    await page.screenshot({ path: info.outputPath('stickers-real-library.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300)
    await page.screenshot({ path: info.outputPath('stickers-real-library-dark.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(300)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath('stickers-real-library-390.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(url + '/#plugins')
    await row(page, '表情包').getByRole('button', { name: '卸载', exact: true }).click()
    await page.getByRole('button', { name: '确认卸载', exact: true }).click()
    await expect(row(page, '表情包')).toHaveCount(0)
    await installStickers(page)
    await openStickers(page)
    await page.getByLabel('搜索描述或标签', { exact: true }).fill('Fixture 01 已编辑')
    await page.getByRole('button', { name: '筛选', exact: true }).click()
    await expect(page.getByRole('button', { name: /Fixture 01 已编辑/ })).toBeVisible()
    await page.getByLabel('搜索描述或标签', { exact: true }).fill('本地上传的 PNG')
    await page.getByRole('button', { name: '筛选', exact: true }).click()
    await expect(page.getByRole('button', { name: /本地上传的 PNG/ })).toBeVisible()
  })
})
