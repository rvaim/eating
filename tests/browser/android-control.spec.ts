import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import type { EatingHost } from '../../apps/host/src/app'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { writeAdbFixture } from '../fixtures/adb'

test.describe('完整ADB插件实际安装面板', () => {
  test.setTimeout(60000)
  let directory: string, host: EatingHost, url: string, adb: string, csrf: string
  const errors: string[] = []
  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'eating-android-browser-')))
    adb = await writeAdbFixture(directory)
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/capabilities/android-control/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory: fileURLToPath(new URL('../../dist/', import.meta.url)), port: 0, allowedUiOrigins: [] }); url = await host.listen()
    const response = await page.request.get(url + '/api/bootstrap'); csrf = (await response.json()).csrfToken
    expect((await page.request.post(url + '/api/plugins/android-control/enable', { headers: { 'X-Eating-Csrf': csrf }, data: {} })).ok()).toBe(true)
    expect((await page.request.post(url + '/api/plugins/android-control/disconnect', { headers: { 'X-Eating-Csrf': csrf }, data: {} })).ok()).toBe(true)
    errors.length = 0; page.on('pageerror', error => errors.push(error.message))
    await page.goto(url + '/#plugins/android-control')
    await expect(page.getByLabel('ADB 可执行文件', { exact: true })).toBeVisible()
  })
  test.afterEach(async () => {
    await host?.close()
    if (await realpath(directory) !== directory || dirname(directory) !== await realpath(tmpdir()) || !basename(directory).startsWith('eating-android-browser-')) throw Error('Unsafe browser fixture cleanup')
    await rm(directory, { recursive: true }); expect(errors).toEqual([])
  })
  test('保存、连接、完整命令及实际PNG预览，切语言／手机布局不重新执行', async ({ page }, info) => {
    const writes: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/invoke')) writes.push(request.postData() ?? '') })
    await page.getByLabel('ADB 可执行文件', { exact: true }).fill(adb)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible()
    await page.getByRole('button', { name: '连接执行端', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止连接', exact: true })).toBeVisible()
    await page.getByLabel('参数 JSON 数组', { exact: true }).fill('["future-command", "原样 参数"]')
    await page.getByRole('button', { name: '运行命令', exact: true }).click()
    await expect(page.getByLabel('输出', { exact: true })).toContainText('future-command')
    await expect(page.getByLabel('输出', { exact: true })).toContainText('原样 参数')
    await page.getByRole('button', { name: '查看屏幕', exact: true }).click()
    const image = page.getByAltText('手机屏幕预览', { exact: true }); await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
    const count = writes.length
    await page.getByRole('heading', { name: '执行端连接', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('android-desktop-zh.png'), fullPage: true })
    await page.locator('#display-language').selectOption('en-US'); await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByAltText('Phone screen preview')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(writes).toHaveLength(count)
    await page.getByRole('heading', { name: 'Executor connection', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('android-mobile-en.png'), fullPage: true })
    await page.getByRole('button', { name: 'Clear preview', exact: true }).click(); await expect(page.locator('.android-screen')).toHaveCount(0)
  })
  test('真实分块上传和下载保持文件字节一致', async ({ page }) => {
    await page.getByLabel('ADB 可执行文件', { exact: true }).fill(adb); await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByRole('button', { name: '连接执行端', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止连接', exact: true })).toBeVisible()
    const bytes = Buffer.alloc(180000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    await page.getByLabel('执行端路径', { exact: true }).fill('roundtrip.bin')
    await page.getByLabel('本机文件', { exact: true }).setInputFiles({ name: 'source.bin', mimeType: 'application/octet-stream', buffer: bytes })
    await page.getByRole('button', { name: '上传文件', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件已上传' })).toBeVisible()
    const ready = page.waitForEvent('download'); await page.getByRole('button', { name: '下载文件', exact: true }).click()
    const download = await ready, path = await download.path(); expect(path).not.toBeNull(); expect((await readFile(path!)).equals(bytes)).toBe(true)
  })
  test('远程配置草稿跨语言保持，隐藏清密钥且停止请求', async ({ page }) => {
    await page.getByLabel('执行位置', { exact: true }).selectOption('remote')
    await page.getByLabel('远程执行端 MCP 地址', { exact: true }).fill('http://127.0.0.1:12345/mcp')
    await page.getByLabel('执行端 Token', { exact: true }).fill('fixture-unsubmitted-private-token')
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Remote executor MCP endpoint', { exact: true })).toHaveValue('http://127.0.0.1:12345/mcp')
    await expect(page.getByLabel('Executor token', { exact: true })).toHaveValue('fixture-unsubmitted-private-token')
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByLabel('Executor token', { exact: true })).toHaveValue('')
    expect((await page.request.get(url + '/api/plugins/android-control/configuration')).ok()).toBe(true)
  })
})
