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
import { createImageFixturePng } from '../fixtures/image'
import { ImageGenerationStore } from '../../plugins/capabilities/image-generation/src/backend/store'

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
  async function seedHistory(page: Page, count: number) {
    await host.close()
    const store = new ImageGenerationStore(join(directory, 'capabilities/image-generation'))
    for (let index = 1; index <= count; index++) {
      const job = store.enqueue(`history-fixture-${index}`, String(index).padStart(64, '0'), `历史图片 ${index}：晨光花园`, index % 2 ? 'watercolor' : 'photo')
      store.complete(job.jobId, { bytes: createImageFixturePng([index * 10 % 255, 165, 94, 255]), mimeType: 'image/png' }, () => {})
    }
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
    url = await host.listen()
    const bootstrap = await page.request.get(url + '/api/bootstrap')
    csrf = (await bootstrap.json() as { csrfToken: string }).csrfToken
  }

  test('历史图片单删、批量选择、翻页和搜索，确认后才删除原图并保留任务', async ({ page }, info) => {
    await seedHistory(page, 22); await open(page)
    const history = page.locator('.image-history'), rows = history.locator('.image-assets > li')
    await expect(rows).toHaveCount(20)
    const deletes: unknown[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/image-generation/manage') && request.postDataJSON().operation === 'delete') deletes.push(request.postDataJSON()) })
    await rows.first().getByRole('checkbox').check()
    await rows.nth(1).getByRole('checkbox').check()
    await expect(history.getByRole('checkbox', { name: '选择本页', exact: true })).toHaveJSProperty('indeterminate', true)
    await history.getByRole('button', { name: '删除所选', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '删除 2 张图片？', exact: true })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    expect(deletes).toHaveLength(0)
    await confirm.screenshot({ path: info.outputPath('image-delete-confirm-desktop.png') })
    await page.keyboard.press('Escape')
    await expect(confirm).not.toBeVisible()
    await history.getByRole('button', { name: '删除所选', exact: true }).click()
    await confirm.getByRole('button', { name: '确认删除 2 张', exact: true }).click()
    await expect(history.locator('.image-history-count')).toHaveText('20')
    await expect(rows).toHaveCount(20)
    expect(deletes).toHaveLength(1)
    await expect(page.getByText('图片已删除，生成记录保留', { exact: true })).toHaveCount(2)
    await rows.first().getByRole('checkbox').check()
    await history.getByLabel('搜索历史图片', { exact: true }).fill('watercolor')
    await history.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(rows).toHaveCount(10)
    await expect(history.getByText('已选 0 张', { exact: true })).toBeVisible()
    await history.getByRole('button', { name: '清除搜索', exact: true }).click()
    await expect(rows).toHaveCount(20)
    await history.getByRole('checkbox', { name: '选择本页', exact: true }).check()
    await expect(history.getByText('已选 20 张', { exact: true })).toBeVisible()
    await history.getByRole('checkbox', { name: '选择本页', exact: true }).uncheck()
    await rows.first().getByRole('button', { name: /^删除图片：/ }).click()
    const single = page.getByRole('dialog', { name: '删除 1 张图片？', exact: true })
    await single.getByRole('button', { name: '确认删除 1 张', exact: true }).click()
    await expect(rows).toHaveCount(19); expect(deletes).toHaveLength(2)
    await history.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-history-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' })
    await history.scrollIntoViewIfNeeded()
    await rows.first().getByRole('checkbox').check()
    await history.getByRole('button', { name: '删除所选', exact: true }).click()
    await expect(single).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: info.outputPath('image-delete-confirm-mobile-dark.png') })
    await single.getByRole('button', { name: '取消', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    await page.locator('#display-language').selectOption('en-US')
    await history.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Delete 1 image?', exact: true })).toBeVisible()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(history.getByText('0 selected', { exact: true })).toBeVisible()
    expect(deletes).toHaveLength(2); expect(provider.requests).toHaveLength(0)
    await host.close()
    const store = new ImageGenerationStore(join(directory, 'capabilities/image-generation'))
    expect(store.images({}).total).toBe(19); expect(store.jobs({}).total).toBe(22)
  })

  test('翻页清除选择，删除最后一页后返回有效页；列表变动时旧确认不删除', async ({ page }) => {
    await seedHistory(page, 21); await open(page)
    const history = page.locator('.image-history'), rows = history.locator('.image-assets > li')
    await rows.first().getByRole('checkbox').check()
    await history.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(history.getByText('已选 0 张', { exact: true })).toBeVisible()
    const selectedName = await rows.first().locator('strong').innerText()
    await rows.first().getByRole('button', { name: /^删除图片：/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认删除 1 张', exact: true }).click()
    await expect(rows).toHaveCount(20)
    await expect(history.getByRole('button', { name: '上一页', exact: true })).toBeDisabled()
    expect(await rows.allTextContents()).not.toContain(selectedName)
    await rows.first().getByRole('checkbox').check()
    await history.getByRole('button', { name: '删除所选', exact: true }).click()
    const response = await page.request.post(url + '/api/plugins/image-generation/manage', { headers: { 'X-Eating-Csrf': csrf }, data: { operation: 'list', input: {} } })
    const list = await response.json() as { revision: number; items: { assetId: string }[] }
    const otherDelete = await page.request.post(url + '/api/plugins/image-generation/manage', { headers: { 'X-Eating-Csrf': csrf }, data: { operation: 'delete', input: { assetIds: [list.items[1]!.assetId], expectedRevision: list.revision, confirmed: true } } })
    expect(otherDelete.status()).toBe(200)
    await page.getByRole('dialog').getByRole('button', { name: '确认删除 1 张', exact: true }).click()
    await expect(history.getByRole('alert')).toContainText('图片列表已变化')
    await expect(rows).toHaveCount(19)
    const selectedStillPresent = await page.request.post(url + '/api/plugins/image-generation/manage', { headers: { 'X-Eating-Csrf': csrf }, data: { operation: 'get', input: { assetId: list.items[0]!.assetId } } })
    expect(selectedStillPresent.status()).toBe(200)
    expect(provider.requests).toHaveLength(0)
  })

  test('删除已生效但响应丢失时只读核对列表，不自动再次删除', async ({ page }) => {
    await seedHistory(page, 2); await open(page)
    let deletions = 0
    await page.route('**/api/plugins/image-generation/manage', async route => {
      if (route.request().postDataJSON().operation !== 'delete') { await route.continue(); return }
      deletions++
      const response = await route.fetch(); expect(response.status()).toBe(200)
      await route.abort('failed')
    })
    const history = page.locator('.image-history')
    await history.getByRole('checkbox', { name: '选择本页', exact: true }).check()
    await history.getByRole('button', { name: '删除所选', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认删除 2 张', exact: true }).click()
    await expect(history.getByRole('alert')).toContainText('删除结果待核对')
    await expect(history.locator('.image-asset-row')).toHaveCount(0)
    await expect(page.getByText('图片已删除，生成记录保留', { exact: true })).toHaveCount(2)
    expect(deletions).toBe(1); expect(provider.requests).toHaveLength(0)
  })

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
        await route.fulfill({ json: { revision: 1, items, total: items.length, offset: 0, limit: 20, hasMore: false, nextOffset: null } }); return
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
      if (width === 1440 && theme === 'light') {
        await preview.getByRole('button', { name: '下一张', exact: true }).click()
        await expect(preview.locator('.image-preview-caption')).toContainText('预览示例 4')
        await preview.getByRole('button', { name: '上一张', exact: true }).click()
        await expect(preview.locator('.image-preview-caption')).toContainText('预览示例 3')
      }
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
