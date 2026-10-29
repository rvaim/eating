import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessSessionContent, HarnessSessionSummary, JsonValue } from '@eating/plugin-sdk'
import { EatingHost } from '../../apps/host/src/app'
import { discoverBackendPlugins } from '../../apps/host/src/discovery'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const refreshedAt = '2026-10-29T00:00:00Z'
const sessions: HarnessSessionSummary[] = Array.from({ length: 40 }, (_, index) => ({ id: `layout-session-${index}`, parentId: index ? 'layout-session-0' : null,
  title: `Conversation ${String(index + 1).padStart(2, '0')}`, status: 'unknown', updatedAt: null }))
const box = async (locator: Locator) => { const value = await locator.boundingBox(); if (!value) throw new Error('Expected a visible layout element'); return value }
async function wheel(page: Page, target: Locator, amount: number) {
  const rect = await box(target)
  await page.mouse.move(rect.x + rect.width * .72, Math.max(1, Math.min(rect.y + rect.height * .6, page.viewportSize()!.height - 20)))
  await page.mouse.wheel(0, amount)
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test.describe('会话导航与页签的布局', () => {
  let directory: string, host: EatingHost, url: string
  let operations: string[], errors: string[]
  test.beforeEach(async ({ page }) => {
    operations = []; errors = []
    page.on('pageerror', error => errors.push(error.message))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_panel_layout_')))
    for (const path of ['communication/qq', 'harness/dsh']) await installPluginPackage(directory, fileURLToPath(new URL(`../../plugins/${path}/dist/`, import.meta.url)))
    const entries = (await discoverBackendPlugins(directory)).map(entry => entry.id !== 'dsh' ? entry : { ...entry, create(context: Parameters<typeof entry.create>[0]) {
      const original = entry.create(context)
      return new Proxy(original, { get(target, key) {
        if (key === 'manage') return async (operation: string, input: { sessionId: string }): Promise<JsonValue> => {
          operations.push(operation)
          if (operation === 'list-sessions') return { sessions, truncated: false, refreshedAt } as unknown as JsonValue
          if (operation !== 'read-session') throw new Error('Unexpected model or runtime operation in layout fixture')
          const session = sessions.find(item => item.id === input.sessionId)!
          const content: HarnessSessionContent = { session, records: Array.from({ length: 50 }, (_, index) => ({ sequence: index + 1, timestamp: refreshedAt, kind: 'assistant/message', role: 'assistant',
            content: `Message ${index + 1}: ` + '用于验证真实长正文阅读与导航布局。'.repeat(20) })), nextOffset: null, refreshedAt }
          return content as unknown as JsonValue
        }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } })
    host = new EatingHost({ dataDirectory: directory, entries, staticDirectory, port: 0, allowedUiOrigins: [] })
    url = await host.listen()
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_panel_layout_')) throw new Error('Unsafe layout fixture cleanup')
    await rm(target, { recursive: true })
    expect(errors).toEqual([])
  })
  async function dashboard(page: Page) {
    await page.goto(url + '/#harness/dsh')
    await page.getByRole('tab', { name: '会话看板', exact: true }).click()
    await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
    await page.locator('.dsh-session-select').first().click()
    await expect(page.locator('.dsh-session-record')).toHaveCount(50)
  }
  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  }

  test('桌面长正文滚动时会话导航固定，长目录自行滚动且不额外读取', async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await dashboard(page)
    const main = page.locator('#main-content'), content = page.locator('.dsh-session-content'), navigation = page.locator('.dsh-session-navigation'), tabs = page.getByRole('tablist')
    await wheel(page, content, 850)
    await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeGreaterThan(500)
    const state = { main: await box(main), navigation: await box(navigation), tabs: await box(tabs), firstTab: await box(page.getByRole('tab').first()) }
    await info.attach('scroll-geometry', { body: JSON.stringify(state), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath('dashboard-scroll.png') })
    expect(state.navigation.y).toBeGreaterThanOrEqual(state.tabs.y + state.tabs.height + 7)
    expect(state.firstTab.y - state.tabs.y).toBeGreaterThanOrEqual(7)
    const top = state.navigation.y, outerScroll = await main.evaluate(element => element.scrollTop)
    await wheel(page, navigation, 1200)
    await expect.poll(() => navigation.evaluate(element => element.scrollTop)).toBeGreaterThan(200)
    expect(await main.evaluate(element => element.scrollTop)).toBeCloseTo(outerScroll, 0)
    expect((await box(navigation)).y).toBeCloseTo(top, 0)
    await wheel(page, content, 100000)
    await expect.poll(() => main.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
    expect((await box(navigation)).y).toBeGreaterThanOrEqual((await box(tabs)).y + (await box(tabs)).height + 7)
    await page.screenshot({ path: info.outputPath('dashboard-end.png') })
    const endScroll = await main.evaluate(element => element.scrollTop)
    await navigation.locator('button').last().focus()
    expect(await main.evaluate(element => element.scrollTop)).toBeCloseTo(endScroll, 0)
    await wheel(page, navigation, -100000)
    await expect.poll(() => navigation.evaluate(element => element.scrollTop)).toBe(0)
    expect((await box(navigation.locator('button').first())).y).toBeGreaterThanOrEqual((await box(tabs)).y + (await box(tabs)).height + 7)
    expect(operations).toEqual(['list-sessions', 'read-session'])
    await noOverflow(page)
  })

  test('窄屏和短窗口保持会话选择与正文可达，尺寸和语言变化不触发读取', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await dashboard(page)
    await wheel(page, page.locator('#main-content'), 700)
    const navigation = page.locator('.dsh-session-navigation'), tabs = page.getByRole('tablist')
    expect((await box(navigation)).y).toBeGreaterThanOrEqual((await box(tabs)).y + (await box(tabs)).height + 7)
    expect((await box(navigation)).height).toBeLessThan(220)
    await page.screenshot({ path: info.outputPath('dashboard-mobile.png') })
    await noOverflow(page)
    await page.locator('#display-language').selectOption('en-US')
    await page.setViewportSize({ width: 1280, height: 420 })
    await wheel(page, page.locator('.dsh-session-content'), 1000)
    expect((await box(navigation)).y).toBeGreaterThanOrEqual((await box(tabs)).y + (await box(tabs)).height + 7)
    expect((await box(navigation)).height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: info.outputPath('dashboard-short.png') })
    expect(operations).toEqual(['list-sessions', 'read-session'])
    await noOverflow(page)
  })

  for (const id of ['qq', 'dsh']) test(`${id} 页签吸顶后保留一致边距，末端可切换且不丢连接草稿`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await page.goto(url + (id === 'qq' ? '/#robots/qq' : '/#harness/dsh'))
    const name = page.getByLabel('显示名称', { exact: true })
    await name.fill('Layout draft stays intact')
    if (id === 'qq') await page.getByRole('tab', { name: 'MCP 能力', exact: true }).click()
    const main = page.locator('#main-content')
    await wheel(page, main, 100000)
    const tabs = page.getByRole('tablist'), rect = await box(tabs), first = await box(page.getByRole('tab').first()), viewport = await box(main)
    await info.attach('sticky-geometry', { body: JSON.stringify({ rect, first, viewport }), contentType: 'application/json' })
    expect(Math.abs(rect.y - viewport.y)).toBeLessThanOrEqual(1)
    expect(first.y - rect.y).toBeGreaterThanOrEqual(7)
    expect(rect.x).toBeGreaterThanOrEqual(viewport.x - 1)
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1)
    await page.screenshot({ path: info.outputPath(`${id}-tabs.png`) })
    await page.getByRole('tab', { name: id === 'qq' ? '连接配置' : '配置', exact: true }).click()
    await expect(name).toHaveValue('Layout draft stays intact')
    expect(operations).toEqual([])
    await noOverflow(page)
  })
})
