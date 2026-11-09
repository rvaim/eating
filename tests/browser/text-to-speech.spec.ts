import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import type { EatingHost } from '../../apps/host/src/app'
import { startSpeechFixture } from '../fixtures/speech-provider'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url)), pluginDirectory = fileURLToPath(new URL('../../plugins/capabilities/text-to-speech/dist/', import.meta.url))
test.describe('OpenAI speech plugin installed UI', () => {
  let root: string, host: EatingHost, url: string, provider: Awaited<ReturnType<typeof startSpeechFixture>>, errors: string[]
  test.beforeEach(async ({ page }) => {
    root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'eating-speech-browser-')))
    provider = await startSpeechFixture()
    await installPluginPackage(root, pluginDirectory)
    host = await createInstalledHost({ dataDirectory: root, port: 0, staticDirectory, allowedUiOrigins: [], autoConnectOnStartup: false }); url = await host.listen(); errors = []
    page.on('pageerror', error => errors.push(error.message))
    const boot = await page.request.get(url + '/api/bootstrap'), { csrfToken } = await boot.json()
    const w = await (await page.request.get(url + '/api/workspace')).json()
    if (!w.plugins.find((p: { id: string; enabled: boolean }) => p.id === 'text-to-speech')?.enabled) expect((await page.request.post(url + '/api/plugins/text-to-speech/enable', { headers: { 'X-Eating-Csrf': csrfToken }, data: {} })).ok()).toBe(true)
  })
  test.afterEach(async () => { await host.close(); await provider.close(); const parent = await realpath(tmpdir()); if (await realpath(root) !== root || dirname(root) !== parent || !basename(root).startsWith('eating-speech-browser-')) throw new Error('Unsafe speech browser cleanup'); await rm(root, { recursive: true }); expect(errors).toEqual([]) })
  async function open(page: Page) { await page.goto(url + '/#plugins/text-to-speech'); await expect(page.getByLabel('服务地址', { exact: true })).toBeVisible() }
  async function configure(page: Page) {
    await open(page)
    await page.getByLabel('服务地址', { exact: true }).fill(provider.endpoint)
    await page.getByLabel('API Key', { exact: true }).fill(['fixture', 'speech', 'key'].join('-'))
    await page.getByLabel('音色', { exact: true }).selectOption('coral')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存，未调用语音合成。', { exact: true })).toBeVisible()
  }
  test('disabled plugin keeps service settings editable, sends no job requests and resumes reads only after enabling', async ({ page }) => {
    const boot = await page.request.get(url + '/api/bootstrap'), { csrfToken } = await boot.json()
    expect((await page.request.post(url + '/api/plugins/text-to-speech/disable', { headers: { 'X-Eating-Csrf': csrfToken }, data: {} })).ok()).toBe(true)
    let jobReads = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/text-to-speech/manage') && request.postDataJSON()?.operation === 'jobs') jobReads++ })
    await configure(page)
    await expect(page.getByRole('region', { name: '语音任务', exact: true }).getByText('插件尚未启用，可先保存服务配置，再点击页面底部的启用。', { exact: true })).toBeVisible()
    await page.waitForTimeout(2200)
    expect(jobReads).toBe(0)
    await expect(page.locator('.speech-error[role="alert"]')).toHaveCount(0)
    await page.getByRole('region', { name: '插件操作', exact: true }).getByRole('button', { name: '启用', exact: true }).click()
    await expect.poll(() => jobReads).toBe(1)
    await page.waitForTimeout(2200)
    expect(jobReads).toBe(1)
    expect(provider.connections()).toBe(0)
    expect(provider.requests).toHaveLength(0)
    await page.getByRole('region', { name: '插件操作', exact: true }).getByRole('button', { name: '停用', exact: true }).click()
    await expect(page.getByRole('region', { name: '语音任务', exact: true }).getByText('插件尚未启用，可先保存服务配置，再点击页面底部的启用。', { exact: true })).toBeVisible()
    await page.waitForTimeout(2200)
    expect(jobReads).toBe(1)
    await expect(page.locator('.speech-error[role="alert"]')).toHaveCount(0)
  })
  test('owner voice is saved with no cloud call, locale changes keep drafts and do not submit requests', async ({ page }) => {
    await configure(page); expect(provider.requests).toHaveLength(0); expect(provider.connections()).toBe(0)
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await page.getByLabel('音色', { exact: true }).selectOption('sage')
    await page.getByLabel('朗读文本', { exact: true }).fill('保留我的试听草稿')
    const writes: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/text-to-speech/')) writes.push(request.url()) })
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Voice', { exact: true })).toHaveValue('sage')
    await expect(page.getByLabel('Text to read', { exact: true })).toHaveValue('保留我的试听草稿')
    expect(writes).toEqual([])
    await page.getByRole('button', { name: 'Reload configuration', exact: true }).click()
    await expect(page.getByText('Reloading discards your configuration draft.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Discard draft and reload', exact: true }).click()
    await expect(page.getByLabel('Voice', { exact: true })).toHaveValue('coral')
    expect(provider.requests).toHaveLength(0)
  })
  test('explicit paid preview creates one task and playable audio, supports confirmed deletion and narrow layouts', async ({ page }, testInfo) => {
    await configure(page)
    await page.getByLabel('朗读文本', { exact: true }).fill('你好，今天过得怎么样？')
    await page.getByRole('button', { name: '生成试听', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    expect(provider.requests).toHaveLength(0)
    await page.getByRole('button', { name: '确认生成', exact: true }).click()
    await expect(page.locator('.speech-job').getByText('合成成功', { exact: true })).toBeVisible({ timeout: 15000 })
    expect(provider.requests).toHaveLength(1)
    await page.getByRole('button', { name: '播放语音', exact: true }).click()
    await expect(page.getByLabel('AI 合成语音试听', { exact: true })).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath('speech-desktop.png') })
    await page.locator('#display-language').selectOption('en-US'); await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Voice', { exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('speech-mobile.png') })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete task and audio', exact: true }).click()
    await expect(page.locator('.speech-job')).toHaveCount(0)
    await expect(page.locator('audio')).toHaveCount(0)
    expect(provider.requests).toHaveLength(1)
  })
  test('page hide clears key and preview without losing non-secret draft or repeating generation', async ({ page }) => {
    await configure(page)
    await page.getByLabel('API Key', { exact: true }).fill('temporary-unsaved-fixture-key')
    await page.getByLabel('音色', { exact: true }).selectOption('sage')
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('音色', { exact: true })).toHaveValue('sage')
    expect(provider.requests).toHaveLength(0)
  })
})
