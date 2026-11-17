import { expect, test } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import type { EatingHost } from '../../apps/host/src/app'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))

test.describe('设置 / 主题配色', () => {
  let directory: string
  let host: EatingHost
  let url: string
  let errors: string[]

  test.beforeEach(async ({ page }) => {
    errors = []
    page.on('pageerror', error => errors.push(error.message))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_theme_ui_')))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [] })
    url = await host.listen()
  })

  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_theme_ui_')) {
      throw new Error('Unsafe theme fixture cleanup')
    }
    await rm(target, { recursive: true })
    expect(errors).toEqual([])
  })

  test('支持预设切换、深浅模式、自定义配色、实时生效与刷新保留，窄屏无溢出', async ({ page }, info) => {
    await page.goto(`${url}/#settings/delivery`)
    await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '主题配色', exact: true }).click()
    await expect(page.getByRole('heading', { name: '主题配色', exact: true })).toBeVisible()

    // 切换内置预设：晴空钴蓝
    await page.getByRole('button', { name: /晴空钴蓝/ }).click()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#2563eb')

    // 切换为深色模式
    await page.getByRole('button', { name: '深色模式', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#60a5fa')

    // 自定义颜色校验与实时应用
    const primaryHex = page.getByLabel('主强调色', { exact: true })
    await primaryHex.fill('#bad')
    await primaryHex.fill('#zzzzzz')
    await expect(page.getByText('请输入 3 位或 6 位十六进制颜色，例如 #d94858。', { exact: true })).toBeVisible()
    // 仍保留上次合法样式
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#60a5fa')

    await primaryHex.fill('#0ea5e9')
    await expect(page.getByText('当前为自定义配色', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#0ea5e9')

    // 刷新页面后保留自定义配色，切到概览页也同样生效
    await page.reload()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#0ea5e9')
    await page.screenshot({ path: info.outputPath('theme-custom-desktop.png') })

    // 390px 窄屏与英文切换无溢出
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByRole('heading', { name: 'Theme & colors', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    // 恢复默认
    await page.getByRole('button', { name: 'Reset to default', exact: true }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)
    expect(await page.evaluate(() => localStorage.getItem('eating.theme'))).toBeNull()
  })
})
