import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const box = async (locator: Locator) => { const value = await locator.boundingBox(); if (!value) throw new Error('Expected a visible layout element'); return value }
async function wheel(page: Page, target: Locator, amount: number) {
  const rect = await box(target)
  await page.mouse.move(rect.x + rect.width * .72, Math.max(1, Math.min(rect.y + rect.height * .6, page.viewportSize()!.height - 20)))
  await page.mouse.wheel(0, amount)
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test.describe('面板页签与 DSH 无页签布局', () => {
  let directory: string, host: EatingHost, url: string
  let errors: string[]
  test.beforeEach(async ({ page }) => {
    errors = []
    page.on('pageerror', error => errors.push(error.message))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_panel_layout_')))
    for (const path of ['communication/qq', 'harness/dsh']) await installPluginPackage(directory, fileURLToPath(new URL(`../../plugins/${path}/dist/`, import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_panel_layout_')) throw new Error('Unsafe layout fixture cleanup')
    await rm(target, { recursive: true })
    expect(errors).toEqual([])
  })
  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  }

  test('qq 页签吸顶后保留一致边距，末端可切换且不丢连接草稿', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await page.goto(url + '/#robots/qq')
    const name = page.getByLabel('显示名称', { exact: true })
    await name.fill('Layout draft stays intact')
    await page.getByRole('tab', { name: 'MCP 能力', exact: true }).click()
    const main = page.locator('#main-content')
    await wheel(page, main, 100000)
    const tabs = page.getByRole('tablist'), rect = await box(tabs), first = await box(page.getByRole('tab').first()), viewport = await box(main)
    await info.attach('sticky-geometry', { body: JSON.stringify({ rect, first, viewport }), contentType: 'application/json' })
    expect(Math.abs(rect.y - viewport.y)).toBeLessThanOrEqual(1)
    expect(first.y - rect.y).toBeGreaterThanOrEqual(7)
    expect(rect.x).toBeGreaterThanOrEqual(viewport.x - 1)
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1)
    await page.screenshot({ path: info.outputPath('qq-tabs.png') })
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await expect(name).toHaveValue('Layout draft stays intact')
    await noOverflow(page)
  })

  test('dsh 无页签，状态栏按钮与长表单在窄屏不溢出且草稿保留', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await page.goto(url + '/#harness/dsh')
    const name = page.getByLabel('显示名称', { exact: true })
    await expect(name).toBeVisible()
    await name.fill('Layout draft stays intact')
    await expect(page.getByRole('tablist')).toHaveCount(0)
    const main = page.locator('#main-content'), button = page.getByRole('button', { name: '打开 DSH Web', exact: true })
    await wheel(page, main, 100000)
    await expect(button).toBeVisible()
    await info.attach('dsh-status-actions', { body: JSON.stringify(await box(button)), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath('dsh-no-tabs-desktop.png') })
    await expect(name).toHaveValue('Layout draft stays intact')
    await noOverflow(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expect(button).toBeVisible()
    await info.attach('dsh-status-actions-mobile', { body: JSON.stringify(await box(button)), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath('dsh-no-tabs-mobile.png') })
    await noOverflow(page)
  })
})
