import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import type { EatingHost } from '../../apps/host/src/app'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { startOneBotFixture } from '../fixtures/onebot'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
test.describe('QQ private media transport settings', () => {
  let home: string, host: EatingHost, url: string, sourceRoot: string, hostMappingRoot: string, onebot: Awaited<ReturnType<typeof startOneBotFixture>>
  test.beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_qq_media_browser_')))
    sourceRoot = join(home, 'source'); hostMappingRoot = join(home, 'shared')
    await mkdir(sourceRoot); await mkdir(hostMappingRoot)
    onebot = await startOneBotFixture()
    await installPluginPackage(home, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    await host?.close(); await onebot?.close()
    const target = await realpath(home)
    if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_qq_media_browser_')) throw new Error('Unsafe media browser cleanup')
    await rm(target, { recursive: true })
  })
  async function api(page: Page, path: string, body?: unknown) {
    return page.evaluate(async ({ path, body }) => {
      const bootstrap = await fetch('/api/bootstrap').then(response => response.json()) as { csrfToken: string }
      const response = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Eating-Csrf': bootstrap.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (!response.ok) throw new Error('Fixture media API failed')
      return response.json()
    }, { path, body })
  }
  test('shows real prerequisites and keeps mapping drafts across locale and tabs without implicit writes', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(url + '/#robots/qq')
    await expect(page.getByText('请先运行 OneBot v11 服务并登录 QQ，再填写地址、保存并连接。OneBot 可在本机、容器或远程运行；Eating 不安装、启动或代登录该服务。', { exact: true })).toBeVisible()
    await page.getByLabel('传输方式', { exact: true }).selectOption('shared-directory')
    await page.getByLabel('图片源目录（Host）', { exact: true }).fill(sourceRoot)
    await page.getByLabel('映射目录（Host 可读）', { exact: true }).fill(hostMappingRoot)
    await page.getByLabel('映射目录（OneBot 可见）', { exact: true }).fill('/container/media')
    await expect(page.getByText('草稿尚未保存；实际发送使用已保存的图片传输设置。', { exact: true })).toBeVisible()
    const writes: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.postData()?.includes('save-media-transport')) writes.push(request.url()) })
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Image source directory (Host)', { exact: true })).toHaveValue(sourceRoot)
    await page.getByRole('tab', { name: 'Agent access', exact: true }).click()
    await page.getByRole('tab', { name: 'Connection', exact: true }).click()
    await expect(page.getByLabel('Mapped directory (OneBot visible)', { exact: true })).toHaveValue('/container/media')
    expect(writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: info.outputPath('qq-media-transport-en-narrow.png'), fullPage: true })
    expect(pageErrors).toEqual([])
  })
  test('saves a confirmed mapping for the real fixture account without reconnecting and detects CAS conflicts', async ({ page }, info) => {
    await page.goto(url + '/#robots/qq')
    await page.getByLabel('OneBot 地址', { exact: true }).fill(onebot.endpoint)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。点击“连接 OneBot”重新连接。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '连接 OneBot', exact: true }).click()
    await expect.poll(() => onebot.connections.length).toBe(1)
    await page.getByRole('button', { name: '读取图片传输设置', exact: true }).click()
    await page.getByLabel('传输方式', { exact: true }).selectOption('shared-directory')
    await page.getByLabel('图片源目录（Host）', { exact: true }).fill(sourceRoot)
    await page.getByLabel('映射目录（Host 可读）', { exact: true }).fill(hostMappingRoot)
    await page.getByLabel('映射目录（OneBot 可见）', { exact: true }).fill('/container/media')
    await page.getByRole('checkbox', { name: /我已确认此账号的 OneBot/ }).check()
    await page.getByRole('button', { name: '保存图片传输设置', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '连接配置', exact: true }).getByText('图片传输设置已保存，QQ 连接保持。', { exact: true })).toBeVisible()
    await expect(page.getByText('已保存当前账号的主人映射确认；每次发送仍需本机文件校验通过。', { exact: true })).toBeVisible()
    expect(onebot.connections).toHaveLength(1)
    const configuration = await api(page, '/plugins/qq/configuration')
    expect(JSON.stringify(configuration)).not.toContain(sourceRoot)
    const saved = await api(page, '/plugins/qq/manage', { operation: 'media-transport', input: {} })
    expect(saved).toMatchObject({ schemaVersion: 1, revision: 1, fileEligible: true })
    await page.getByLabel('映射目录（OneBot 可见）', { exact: true }).fill('/container/changed')
    await expect(page.getByRole('checkbox', { name: /我已确认此账号的 OneBot/ })).not.toBeChecked()
    await api(page, '/plugins/qq/manage', { operation: 'save-media-transport', input: { expectedRevision: 1, mode: 'auto', mapping: null } })
    await page.getByRole('button', { name: '保存图片传输设置', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'QQ_MEDIA_CONFIGURATION_CONFLICT' })).toBeVisible()
    await expect(page.getByLabel('映射目录（OneBot 可见）', { exact: true })).toHaveValue('/container/changed')
    await expect(page.getByRole('button', { name: '保存图片传输设置', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath('qq-media-transport-zh-desktop.png'), fullPage: true })
    expect(onebot.requests.some(request => request.action.startsWith('send_') || request.action === 'get_image')).toBe(false)
  })
})
