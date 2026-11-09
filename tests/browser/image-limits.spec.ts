import { test, expect } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { createLargeImageFixturePng } from '../fixtures/image'
const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
test('主人图片大小设置：默认10、持久保存、CAS冲突、双语草稿和390px布局', async ({ page }, testInfo) => {
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-image-limit-browser-')))
  const host = new EatingHost({ dataDirectory: home, entries: [], port: 0, staticDirectory, allowedUiOrigins: [] })
  try {
    const url = await host.listen(); await page.goto(url + '/#settings/images')
    const size = page.getByLabel('单张图片上限（MiB）', { exact: true })
    await expect(size).toHaveValue('10')
    await size.fill('15'); await page.getByRole('button', { name: '保存图片设置', exact: true }).click()
    await expect(page.getByText('图片大小设置已保存，后续读取和发送立即使用新上限。', { exact: true })).toBeVisible()
    expect(host.imageLimits.snapshot().maxImageMiB).toBe(15)
    await size.fill('16')
    host.imageLimits.save({ expectedRevision: 1, maxImageMiB: 20 })
    await page.getByRole('button', { name: '保存图片设置', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('草稿已保留'); await expect(size).toHaveValue('16')
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Maximum image size (MiB)', { exact: true })).toHaveValue('16')
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Keep draft', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Discard draft and reload', exact: true }).click()
    await expect(page.getByLabel('Maximum image size (MiB)', { exact: true })).toHaveValue('20')
    await page.screenshot({ path: testInfo.outputPath('image-limits-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('image-limits-mobile.png') })
    await page.reload(); await expect(page.getByLabel('Maximum image size (MiB)', { exact: true })).toHaveValue('20')
  } finally {
    await host.close(); if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-image-limit-browser-')) throw new Error('Unsafe image limit browser cleanup'); await rm(home, { recursive: true })
  }
})

test('真实表情面板上传默认10 MiB，打开期间调至12 MiB后立即采用新上限', async ({ page }) => {
  test.setTimeout(60000)
  const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-image-limit-browser-')))
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await installPluginPackage(home, fileURLToPath(new URL('../../plugins/capabilities/stickers/dist/', import.meta.url)))
  const host = await createInstalledHost({ dataDirectory: home, port: 0, staticDirectory, allowedUiOrigins: [], autoConnectOnStartup: false })
  try {
    const url = await host.listen(), boot = await page.request.get(url + '/api/bootstrap'), csrf = (await boot.json()).csrfToken
    expect((await page.request.post(url + '/api/plugins/stickers/enable', { headers: { 'X-Eating-Csrf': csrf }, data: {} })).status()).toBe(200)
    await page.goto(url + '/#plugins/stickers')
    for (const size of [10, 12]) {
      if (size === 12) host.imageLimits.save({ expectedRevision: 0, maxImageMiB: 12 })
      await page.getByRole('button', { name: '添加表情', exact: true }).click()
      await page.getByLabel('本地图片', { exact: true }).setInputFiles({ name: `image-${size}.png`, mimeType: 'image/png', buffer: createLargeImageFixturePng(size * 1024 * 1024) })
      await expect(page.getByRole('img', { name: '所选表情图片', exact: true })).toBeVisible()
      await page.getByLabel('描述', { exact: true }).fill(`大图上传 ${size} MiB`)
      await page.getByRole('button', { name: '添加到表情库', exact: true }).click()
      await expect(page.getByRole('button', { name: new RegExp(`大图上传 ${size} MiB`) })).toBeVisible()
    }
    host.imageLimits.save({ expectedRevision: 1, maxImageMiB: 2 })
    await page.getByRole('button', { name: '添加表情', exact: true }).click()
    await page.getByLabel('本地图片', { exact: true }).setInputFiles({ name: 'over-current-limit.png', mimeType: 'image/png', buffer: createLargeImageFixturePng(3 * 1024 * 1024) })
    await expect(page.locator('.stickers-notice[role="alert"]')).toBeVisible()
    await expect(page.getByRole('img', { name: '所选表情图片', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await host.close(); if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-image-limit-browser-')) throw new Error('Unsafe image limit browser cleanup'); await rm(home, { recursive: true })
  }
})
