import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import type { EatingHost } from '../../apps/host/src/app'
import { startImagesProviderFixture } from '../fixtures/images-provider'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = fileURLToPath(new URL('../../plugins/capabilities/image-generation/dist/', import.meta.url))

test.describe('生图插件真实临时 Host', () => {
  test.setTimeout(120_000)
  let directory: string, host: EatingHost, url: string, csrf: string
  let provider: Awaited<ReturnType<typeof startImagesProviderFixture>>
  let errors: string[]

  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_image_generation_')))
    provider = await startImagesProviderFixture('base64', { edit: true })
    await installPluginPackage(directory, pluginDirectory)
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
    url = await host.listen(); errors = []
    page.on('pageerror', error => errors.push(error.message))
    const bootstrap = await page.request.get(url + '/api/bootstrap')
    expect(bootstrap.status()).toBe(200)
    csrf = (await bootstrap.json() as { csrfToken: string }).csrfToken
    const workspace = await page.request.get(url + '/api/workspace')
    expect(workspace.status()).toBe(200)
    const state = await workspace.json() as { plugins: { id: string; enabled: boolean }[] }
    if (!state.plugins.find(entry => entry.id === 'image-generation')?.enabled) {
      const enabled = await page.request.post(url + '/api/plugins/image-generation/enable', { headers: { 'X-Eating-Csrf': csrf }, data: {} })
      expect(enabled.status()).toBe(200)
    }
  })
  test.afterEach(async () => {
    await host?.close()
    await provider?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_image_generation_')) throw new Error('Unsafe image generation fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })

  async function open(page: Page) {
    await page.goto(url + '/#plugins/image-generation')
    await expect(page.getByLabel('Base URL', { exact: true })).toBeVisible({ timeout: 20_000 })
  }

  test('英文错误态按后端 code 映射固定文案，不显示原始中文', async ({ page }) => {
    await open(page)
    await page.getByLabel('Base URL', { exact: true }).fill(provider.baseUrl)
    await page.getByLabel('API Key', { exact: true }).fill('wrong-fixture-key')
    await page.getByLabel('模型', { exact: true }).fill('gpt-image-fixture')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。保存只更新本地配置。', { exact: true }).first()).toBeVisible()
    await page.getByLabel('提示词', { exact: true }).fill('English error fixture')
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    await page.getByRole('button', { name: '确认提交', exact: true }).click()
    await expect(page.locator('.image-job').filter({ hasText: 'English error fixture' }).getByText('失败', { exact: true })).toBeVisible({ timeout: 20_000 })
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByText('The provider rejected authentication (HTTP 401). Check the API Key.', { exact: false })).toBeVisible()
    expect(await page.locator('body').innerText()).not.toContain('生成服务认证失败')
  })

  test('参考图上传后走 /images/edits，任务标记编辑来源并保留图片预览', async ({ page }, info) => {
    await open(page)
    await page.getByLabel('Base URL', { exact: true }).fill(provider.baseUrl)
    await page.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
    await page.getByLabel('模型', { exact: true }).fill('gpt-image-fixture')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。保存只更新本地配置。', { exact: true }).first()).toBeVisible()
    await page.getByLabel('参考图（可选）', { exact: true }).setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: provider.image })
    await expect(page.locator('.image-source-preview img')).toBeVisible()
    await page.locator('.image-source-preview').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-generation-edit-source.png') })
    const prompt = '把这张图改成蓝色'
    await page.getByLabel('提示词', { exact: true }).fill(prompt)
    await page.getByRole('button', { name: '编辑图片', exact: true }).click()
    await expect(page.getByText('确认编辑图片？', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '确认提交', exact: true }).click()
    const job = page.locator('.image-job').filter({ hasText: prompt })
    await expect(job.getByText('已完成', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(job.getByText('编辑自上传图片', { exact: true })).toBeVisible()
    expect(provider.edits).toHaveLength(1)
    expect(provider.requests).toHaveLength(0)
    expect(provider.edits[0]!.fields).toEqual({ model: 'gpt-image-fixture', prompt, n: '1' })
    expect(provider.edits[0]!.image).toEqual(provider.image)
    expect(provider.edits[0]!.mimeType).toBe('image/png')
  })

  test('配置 CAS 冲突不静默推进版本，必须放弃草稿后重读', async ({ page }) => {
    await open(page)
    await page.getByLabel('Base URL', { exact: true }).fill(provider.baseUrl)
    await page.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
    await page.getByLabel('模型', { exact: true }).fill('conflict-model')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。保存只更新本地配置。', { exact: true }).first()).toBeVisible()
    const current = await (await page.request.get(url + '/api/plugins/image-generation/configuration')).json() as { revision: number }
    const external = await page.request.post(url + '/api/plugins/image-generation/configuration', { headers: { 'X-Eating-Csrf': csrf }, data: { expectedRevision: current.revision, model: 'external-model' } })
    expect(external.status()).toBe(200)
    await page.getByLabel('模型', { exact: true }).fill('unsaved-draft')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText(/生图配置已变更/)).toBeVisible()
    await page.getByRole('button', { name: '重新读取', exact: true }).first().click()
    await expect(page.getByText('放弃未保存的配置？', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '放弃并重读', exact: true }).click()
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('external-model')
  })

  test('未配置 Key 时停用再启用不报错', async ({ page }) => {
    await open(page)
    const footer = page.locator('.plugins-panel-footer')
    await footer.getByRole('button', { name: '停用', exact: true }).click()
    await expect(footer.getByRole('button', { name: '启用', exact: true })).toBeVisible()
    await footer.getByRole('button', { name: '启用', exact: true }).click()
    await expect(page.getByLabel('Base URL', { exact: true })).toBeVisible()
    await expect(page.locator('.image-notice[role="alert"]')).toHaveCount(0)
    await expect(page.getByText('生图尚未就绪：请填写并保存图片模型名称。', { exact: true }).first()).toBeVisible()
  })

  test('无配置禁生成，保存 key/model 后确认计费生成，预览/刷新/语言/隐藏/重启状态正确', async ({ page }, info) => {
    await open(page)
    await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeDisabled()
    expect(provider.requests).toHaveLength(0)

    await page.getByLabel('Base URL', { exact: true }).fill(provider.baseUrl)
    await page.getByLabel('API Key', { exact: true }).fill(provider.apiKey)
    await page.getByLabel('模型', { exact: true }).fill('gpt-image-fixture')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。保存只更新本地配置。', { exact: true }).first()).toBeVisible()
    await expect(page.locator('.plugins-panel-head').getByText('已就绪', { exact: true })).toBeVisible()
    expect(provider.requests).toHaveLength(0)
    const saved = await page.request.get(url + '/api/plugins/image-generation/configuration')
    expect(saved.status()).toBe(200)
    const configuration = await saved.json() as { apiKey?: string; apiKeyConfigured: boolean; model: string; ready: boolean }
    expect(configuration.apiKey).toBeUndefined()
    expect(configuration.apiKeyConfigured).toBe(true)
    expect(configuration.model).toBe('gpt-image-fixture')
    expect(configuration.ready).toBe(true)

    const prompt = '一只在晨光里伸懒腰的橘猫，柔和的水彩风格'
    await page.getByLabel('提示词', { exact: true }).fill(prompt)
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(prompt)
    expect(provider.requests).toHaveLength(0)
    await page.locator('#display-language').selectOption('zh-CN')
    await expect(page.getByLabel('提示词', { exact: true })).toHaveValue(prompt)

    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    await expect(page.getByText('确认生图？', { exact: true })).toBeVisible()
    await expect(page.getByText(/可能产生费用/)).toBeVisible()
    await page.getByRole('button', { name: '确认提交', exact: true }).click()
    const job = page.locator('.image-job').filter({ hasText: prompt })
    await expect(job.getByText('已完成', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => provider.requests.length).toBe(1)
    await job.getByRole('button', { name: '查看图片', exact: true }).first().click()
    await expect(page.locator('.image-preview img')).toBeVisible()
    const preview = page.getByRole('dialog', { name: '图片预览', exact: true })
    await expect(preview).toBeInViewport({ ratio: 1 })
    await expect(preview.getByRole('button', { name: '关闭预览', exact: true })).toBeFocused()
    await page.screenshot({ path: info.outputPath('image-preview-desktop.png') })
    await page.keyboard.press('Escape')
    await expect(preview).not.toBeVisible()
    await expect(job.getByRole('button', { name: '查看图片', exact: true }).first()).toBeFocused()
    expect(provider.requests).toHaveLength(1)

    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await page.getByRole('button', { name: '刷新资源', exact: true }).click()
    await page.waitForTimeout(500)
    expect(provider.requests).toHaveLength(1)

    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('image-generation-desktop.png'), fullPage: true })
    await page.locator('.image-jobs').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-generation-resources.png'), fullPage: true })
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300)
    await page.screenshot({ path: info.outputPath('image-generation-dark.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(300)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('image-generation-390.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByLabel('API Key', { exact: true }).fill('unsaved-private-key')
    await page.locator('.image-asset-row').first().click()
    await expect(preview).toBeVisible()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(preview).not.toBeVisible()
    await expect(page.locator('.image-preview img')).toHaveCount(0)
    expect(provider.requests).toHaveLength(1)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })

    await host.close()
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
    url = await host.listen()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(url + '/#plugins/image-generation')
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('gpt-image-fixture')
    await expect(page.locator('.image-job').filter({ hasText: prompt }).getByText('已完成', { exact: true })).toBeVisible({ timeout: 20_000 })
    expect(provider.requests).toHaveLength(1)
  })

  test('长图片列表在当前位置预览，明暗窄屏、取消读取、失败及关闭均保持可操作', async ({ page }, info) => {
    const items = Array.from({ length: 20 }, (_, index) => ({ assetId: String(index + 1).padStart(64, '0'), mimeType: 'image/png', bytes: provider.image.length,
      prompt: `预览示例 ${index + 1}：晨光中的绿色花园`, model: 'fixture-images-model', createdAt: '2026-11-13T08:00:00.000Z' }))
    let previewRequests = 0
    let fail = false
    let release: (() => void) | undefined
    let gate: Promise<void> | undefined
    await page.route('**/api/plugins/image-generation/manage', async route => {
      const body = route.request().postDataJSON() as { operation: string; input: { assetId?: string } }
      if (body.operation === 'list') {
        await route.fulfill({ json: { items, total: items.length, offset: 0, limit: 20, hasMore: false, nextOffset: null } }); return
      }
      if (body.operation !== 'get') { await route.continue(); return }
      previewRequests++
      const item = items.find(item => item.assetId === body.input.assetId)!
      const failure = fail
      await gate
      await route.fulfill(failure ? { status: 404, json: { error: { code: 'IMAGE_GENERATION_NOT_FOUND' } } } : { json: { item,
        image: { mimeType: 'image/png', data: provider.image.toString('base64') }, sendable: { type: 'image', data: { file: `eating-asset://image-generation/${item.assetId}` } } } }).catch(() => {})
    })
    await open(page)
    await expect(page.locator('.image-asset-row')).toHaveCount(20)
    expect(previewRequests).toBe(0)
    const preview = page.getByRole('dialog', { name: '图片预览', exact: true })
    for (const [width, height, theme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [390, 844, 'light'], [390, 844, 'dark']] as const) {
      await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: theme })
      const trigger = page.locator('.image-asset-row').nth(2)
      await trigger.scrollIntoViewIfNeeded()
      const position = await page.locator('#main-content').evaluate(element => element.scrollTop)
      await trigger.click()
      await expect(preview.locator('img')).toBeVisible()
      await expect(preview).toBeInViewport({ ratio: 1 })
      await expect(preview.locator('img')).toBeInViewport({ ratio: 1 })
      expect(await page.locator('#main-content').evaluate(element => element.scrollTop)).toBe(position)
      await expect(preview.getByRole('button', { name: '关闭预览', exact: true })).toBeFocused()
      await page.getByLabel('Base URL', { exact: true }).evaluate(element => element.focus())
      await expect(preview.getByRole('button', { name: '关闭预览', exact: true })).toBeFocused()
      await page.screenshot({ path: info.outputPath(`image-preview-${width}-${theme}.png`) })
      await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
      await expect(preview).not.toBeVisible()
      await expect(trigger).toBeFocused()
      expect(await page.locator('#main-content').evaluate(element => element.scrollTop)).toBe(position)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    }
    gate = new Promise<void>(resolve => { release = resolve })
    await page.locator('.image-asset-row').first().click()
    await expect(preview.getByRole('status')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview).not.toBeVisible()
    release!(); gate = undefined
    fail = true
    await page.locator('.image-asset-row').nth(1).click()
    await expect(preview.getByRole('alert')).toBeVisible()
    await expect(preview.locator('img')).toHaveCount(0)
    await page.mouse.click(1, 1)
    await expect(preview).not.toBeVisible()
    fail = false
    await page.locator('.image-asset-row').nth(2).click()
    await expect(preview.locator('img')).toBeVisible()
    await expect(preview.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.locator('#display-language').selectOption('en-US')
    await page.locator('.image-asset-row').nth(2).click()
    await expect(page.getByRole('dialog', { name: 'Image preview', exact: true }).getByRole('button', { name: 'Close preview', exact: true })).toBeVisible()
    expect(provider.requests).toHaveLength(0)
  })
})
