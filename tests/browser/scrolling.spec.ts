import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PersonaMutationResult } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { startOneBotFixture } from '../fixtures/onebot'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = (path: string) => fileURLToPath(new URL(`../../plugins/${path}/dist/`, import.meta.url))
const rightPane = (page: Page) => page.locator('#main-content')
const secondSidebar = (page: Page) => page.locator('.platform-sidebar')
const tabbar = (page: Page) => page.getByRole('tablist')
const copy = {
  'zh-CN': { configuration: '连接配置', tests: '功能测试', mcp: 'MCP 能力', disable: '停用插件' },
  'en-US': { configuration: 'Connection', tests: 'Function tests', mcp: 'MCP tools', disable: 'Disable plugin' },
} as const

type Box = { x: number; y: number; width: number; height: number }
async function box(locator: Locator): Promise<Box> {
  const value = await locator.boundingBox()
  expect(value, `Missing bounds: ${locator}`).not.toBeNull()
  return value!
}
const scrollTop = (locator: Locator) => locator.evaluate(element => element.scrollTop)
const scrollRange = (locator: Locator) => locator.evaluate(element => element.scrollHeight - element.clientHeight)
async function chooseLanguage(page: Page, language: keyof typeof copy) {
  await page.getByRole('combobox', { name: /^(界面语言|Display language)$/ }).selectOption(language)
  await expect(page.locator('html')).toHaveAttribute('lang', language)
}

// Use a real wheel over the pane's edge so nested editors/JSON previews cannot consume it.
async function wheel(page: Page, pane: Locator, deltaY: number) {
  const bounds = await box(pane)
  await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height * .7)
  await page.mouse.wheel(0, deltaY)
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}
async function wheelToBottom(page: Page, pane: Locator) {
  await wheel(page, pane, 100000)
  await expect.poll(() => pane.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
}
async function wheelToTop(page: Page, pane: Locator) {
  await wheel(page, pane, -100000)
  await expect.poll(() => scrollTop(pane)).toBe(0)
}
async function inPane(locator: Locator, pane: Locator, obstruction?: Locator) {
  const element = await box(locator)
  const viewport = await box(pane)
  const obstructionBox = obstruction ? await box(obstruction) : undefined
  const top = obstructionBox ? Math.max(viewport.y, obstructionBox.y + obstructionBox.height) : viewport.y
  expect(element.y, `Element above its usable pane: ${locator}`).toBeGreaterThanOrEqual(top - 1)
  expect(element.y + element.height, `Element below its pane: ${locator}`).toBeLessThanOrEqual(viewport.y + viewport.height + 1)
  expect(element.x).toBeGreaterThanOrEqual(viewport.x - 1)
  expect(element.x + element.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1)
}
async function frameIsViewport(page: Page) {
  const dimensions = await page.evaluate(() => {
    const root = document.querySelector('.app-shell')!.getBoundingClientRect()
    return {
      rootTop: root.top, rootHeight: root.height, viewportHeight: innerHeight,
      documentTop: document.scrollingElement!.scrollTop, windowTop: scrollY,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      documentOverflow: document.scrollingElement!.scrollHeight - innerHeight,
      mainHorizontalOverflow: (() => { const main = document.getElementById('main-content')!; return main.scrollWidth - main.clientWidth })(),
    }
  })
  expect(dimensions.documentTop).toBe(0)
  expect(dimensions.windowTop).toBe(0)
  expect(dimensions.rootTop).toBe(0)
  expect(Math.abs(dimensions.rootHeight - dimensions.viewportHeight)).toBeLessThanOrEqual(1)
  expect(dimensions.horizontalOverflow).toBeLessThanOrEqual(0)
  expect(dimensions.documentOverflow).toBeLessThanOrEqual(1)
  expect(dimensions.mainHorizontalOverflow).toBeLessThanOrEqual(0)
}
async function chromePositions(page: Page) {
  const selectors = ['.page-header', '.global-sidebar', '.global-sidebar nav', '.platform-sidebar']
  const positions: Record<string, number> = {}
  for (const selector of selectors) {
    const element = page.locator(selector)
    if (await element.count()) positions[selector] = (await box(element)).y
  }
  return positions
}
async function chromeDidNotMove(page: Page, before: Record<string, number>) {
  for (const [selector, top] of Object.entries(before)) expect(Math.abs((await box(page.locator(selector))).y - top), selector).toBeLessThanOrEqual(1)
  await frameIsViewport(page)
}
async function tabsAtPaneTop(page: Page) {
  await expect.poll(async () => Math.abs((await box(tabbar(page))).y - (await box(rightPane(page))).y)).toBeLessThanOrEqual(1)
}
async function clickVisibleTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true })
  await inPane(tab, rightPane(page))
  const bounds = await box(tab)
  // A coordinate click cannot silently scroll a hidden tab back into view.
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
async function diagnostics(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.app-shell,.app-main,.page-header,.robot-workspace,.platform-sidebar,#main-content,.qq-panel,.qq-tabs,.qq-panel [role="tabpanel"]:not([hidden]),.plugin-information,.catalog-container')].map(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { tag: element.tagName, class: element.className, id: element.id,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      overflowY: style.overflowY, position: style.position, top: style.top,
      documentTop: document.scrollingElement!.scrollTop }
  }))
}

test.describe('视口框架、独立滚动区与 QQ 固定页签', () => {
  test.setTimeout(45000)
  let directory: string | undefined
  let host: EatingHost | undefined
  let onebot: Awaited<ReturnType<typeof startOneBotFixture>> | undefined
  let url: string
  let csrfToken: string
  let pageErrors: string[]

  async function post<T>(page: Page, path: string, data: unknown, status = 200): Promise<T> {
    const response = await page.request.post(`${url}/api${path}`, { headers: { 'X-Eating-Csrf': csrfToken }, data })
    expect(response.status(), path).toBe(status)
    return response.json() as Promise<T>
  }

  test.beforeEach(async ({ page }) => {
    pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && /unsafe-eval|Content Security Policy|Evaluating a string as JavaScript/i.test(message.text())) pageErrors.push(message.text())
    })
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_scrolling_browser_')))
    onebot = await startOneBotFixture()
    await installPluginPackage(directory, pluginDirectory('communication/qq'))
    await installPluginPackage(directory, pluginDirectory('harness/dsh'))
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
    const bootstrap = await page.request.get(`${url}/api/bootstrap`)
    expect(bootstrap.status()).toBe(200)
    ;({ csrfToken } = await bootstrap.json() as { csrfToken: string })
    await post(page, '/plugins/qq/configuration', {
      displayName: '滚动协议夹具', endpoint: onebot.endpoint, autoConnect: false,
      forwardToHarness: false, receiveGroups: true, timeoutMs: 1000,
    })
    await post(page, '/plugins/qq/connect', {})
  })
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
      await testInfo.attach('scroll-containers', { body: JSON.stringify(await diagnostics(page), null, 2), contentType: 'application/json' })
    }
    try { await host?.close() }
    finally {
      host = undefined
      try { await onebot?.close() }
      finally {
        onebot = undefined
        if (directory) {
          const target = await realpath(directory)
          if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_scrolling_browser_')) throw new Error('Unsafe scrolling test cleanup')
          await rm(target, { recursive: true })
          directory = undefined
        }
      }
    }
    expect(pageErrors).toEqual([])
  })

  for (const language of ['zh-CN', 'en-US'] as const) {
    test(`${language}：真实长目录只滚右面板，页签从状态下方吸顶并在底部仍可切换`, async ({ page }, testInfo) => {
      await page.goto(`${url}/#robots/qq`)
      await chooseLanguage(page, language)
      const labels = copy[language]
      await expect(page.locator('.qq-connection-strip')).toContainText('123456789')
      await page.getByRole('tab', { name: labels.mcp, exact: true }).click()
      await expect(page.locator('.qq-capability-list > li')).toHaveCount(41)
      await expect(page.locator('.qq-capability-list > li > code')).toHaveCount(40)
      const pane = rightPane(page)
      const before = await chromePositions(page)
      expect(await scrollTop(pane)).toBe(0)
      const strip = await box(page.locator('.qq-connection-strip'))
      expect((await box(tabbar(page))).y).toBeGreaterThanOrEqual(strip.y + strip.height - 1)
      expect((await box(tabbar(page))).y).toBeGreaterThan((await box(pane)).y + 40)
      const mutations: string[] = []
      page.on('request', request => { if (request.method() === 'POST' && !(request.url().endsWith('/api/plugins/dsh/manage') && request.postDataJSON()?.operation === 'get-model-capabilities')) mutations.push(request.url()) })

      await wheel(page, pane, 650)
      await expect.poll(() => scrollTop(pane)).toBeGreaterThan(0)
      await tabsAtPaneTop(page)
      await chromeDidNotMove(page, before)
      expect(await scrollTop(secondSidebar(page))).toBe(0)
      // Neither the plugin wrapper nor its active body becomes a second vertical viewport.
      for (const layer of [page.locator('.qq-panel'), page.getByRole('tabpanel', { name: labels.mcp, exact: true })]) {
        expect(await scrollRange(layer)).toBeLessThanOrEqual(1)
        expect(await scrollTop(layer)).toBe(0)
      }
      await page.screenshot({ path: testInfo.outputPath(`${language}-qq-sticky.png`) })

      await wheelToBottom(page, pane)
      await tabsAtPaneTop(page)
      const disable = page.getByRole('button', { name: labels.disable, exact: true })
      await inPane(disable, pane, tabbar(page))
      await disable.click({ trial: true })
      await wheel(page, pane, 1400)
      await chromeDidNotMove(page, before)
      await page.screenshot({ path: testInfo.outputPath(`${language}-qq-footer.png`) })
      await clickVisibleTab(page, labels.tests)
      await expect(page.getByRole('tabpanel', { name: labels.tests, exact: true })).toBeVisible()
      await clickVisibleTab(page, labels.configuration)
      await expect(page.getByLabel(language === 'zh-CN' ? 'OneBot 地址' : 'OneBot address', { exact: true })).toHaveValue(onebot!.endpoint)
      await wheelToTop(page, pane)
      await wheel(page, pane, -1400)
      await chromeDidNotMove(page, before)
      expect(mutations).toEqual([])
      expect(onebot!.requests.every(request => ['get_login_info', 'get_status'].includes(request.action))).toBe(true)
    })
  }

  test('短窗口下键盘聚焦可到屏外字段且不被页签遮挡，箭头切换保留双面板草稿', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto(`${url}/#robots/qq`)
    await chooseLanguage(page, 'en-US')
    const pane = rightPane(page)
    const mutations: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && !(request.url().endsWith('/api/plugins/dsh/manage') && request.postDataJSON()?.operation === 'get-model-capabilities')) mutations.push(request.url()) })
    const name = page.getByLabel('Display name', { exact: true })
    await name.fill('Unsaved connection draft')
    await wheelToTop(page, pane)
    const timeout = page.getByLabel('Request timeout', { exact: true })
    expect((await box(timeout)).y).toBeGreaterThan((await box(pane)).y + (await box(pane)).height)
    await timeout.focus()
    await expect(timeout).toBeFocused()
    await expect.poll(() => scrollTop(pane)).toBeGreaterThan(0)
    await inPane(timeout, pane, tabbar(page))
    await page.keyboard.press('Shift+Tab')
    const clearToken = page.getByRole('checkbox').first()
    await expect(clearToken).toBeFocused()
    await inPane(clearToken, pane, tabbar(page))
    await name.focus()
    await inPane(name, pane, tabbar(page))

    const connection = page.getByRole('tab', { name: 'Connection', exact: true })
    await connection.focus()
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { name: 'MCP tools', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    const tests = page.getByRole('tab', { name: 'Function tests', exact: true })
    await expect(tests).toBeFocused()
    await expect(tests).toHaveAttribute('aria-selected', 'true')
    await page.getByLabel('Test function', { exact: true }).selectOption('qq_send_private_message')
    await page.getByLabel('Recipient QQ number (required)', { exact: true }).fill('987654321')
    await page.getByLabel('Message content (required)', { exact: true }).fill('Unsaved test draft, never submitted')
    const requestId = await page.getByLabel('Request ID (required)', { exact: true }).inputValue()
    await tests.focus()
    await page.keyboard.press('Home')
    await expect(connection).toBeFocused()
    await expect(name).toHaveValue('Unsaved connection draft')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByLabel('Message content (required)', { exact: true })).toHaveValue('Unsaved test draft, never submitted')
    await expect(page.getByLabel('Request ID (required)', { exact: true })).toHaveValue(requestId)
    const lowerInput = page.getByLabel('Request ID (required)', { exact: true })
    await lowerInput.focus()
    await inPane(lowerInput, pane, tabbar(page))
    await frameIsViewport(page)
    await page.screenshot({ path: testInfo.outputPath('keyboard-focused-field.png') })
    expect(mutations).toEqual([])
    expect(onebot!.requests.every(request => ['get_login_info', 'get_status'].includes(request.action))).toBe(true)
  })

  test('四十个人格的二级列表自行滚动，编辑草稿和主区位置保持，列表尾部新增入口可达', async ({ page }, testInfo) => {
    const personas: PersonaMutationResult[] = []
    for (let index = 0; index < 40; index++) personas.push(await post<PersonaMutationResult>(page, '/personas', {
      name: `滚动人格 ${String(index + 1).padStart(2, '0')}`, body: `第 ${index + 1} 个人格的真实临时正文`,
    }, 201))
    await page.goto(`${url}/#personas/${personas[0]!.persona.id}`)
    await expect(page.getByRole('textbox', { name: '人格设定', exact: true })).toHaveText(personas[0]!.persona.body)
    const pane = rightPane(page)
    const sidebar = secondSidebar(page)
    const before = await chromePositions(page)
    expect(await scrollTop(pane)).toBe(0)
    expect(await scrollRange(sidebar)).toBeGreaterThan(500)
    await wheel(page, sidebar, 750)
    await expect.poll(() => scrollTop(sidebar)).toBeGreaterThan(0)
    expect(await scrollTop(pane)).toBe(0)
    const middle = page.getByRole('navigation', { name: '人格列表', exact: true }).getByRole('button', { name: '滚动人格 21', exact: true })
    await middle.scrollIntoViewIfNeeded()
    await inPane(middle, sidebar)
    await middle.click()
    const editor = page.getByRole('textbox', { name: '人格设定', exact: true })
    await expect(editor).toHaveText(personas[20]!.persona.body)
    await editor.fill('列表独立滚动时保留这份未保存的人格草稿')
    expect(await scrollTop(pane)).toBe(0)
    const titleTop = (await box(page.locator('.authoring-title-row'))).y
    const leftBefore = await scrollTop(sidebar)
    await wheel(page, sidebar, 200)
    await expect.poll(() => scrollTop(sidebar)).toBeGreaterThan(leftBefore)
    expect(await scrollTop(pane)).toBe(0)
    expect((await box(page.locator('.authoring-title-row'))).y).toBe(titleTop)
    await wheelToBottom(page, sidebar)
    const add = sidebar.getByRole('button', { name: '新增人格', exact: true })
    await inPane(add, sidebar)
    await add.click({ trial: true })
    expect(await scrollTop(pane)).toBe(0)
    const leftBottom = await scrollTop(sidebar)
    await wheel(page, pane, 350)
    await expect.poll(() => scrollTop(pane)).toBeGreaterThan(0)
    expect(await scrollTop(sidebar)).toBe(leftBottom)
    await expect(editor).toHaveText('列表独立滚动时保留这份未保存的人格草稿')
    await chromeDidNotMove(page, before)
    await page.screenshot({ path: testInfo.outputPath('independent-persona-sidebar.png') })
  })

  test('390px 分类保持横排且不随右面板滚动，横屏 resize 后页签和停用入口仍可用', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${url}/#robots/qq`)
    await chooseLanguage(page, 'en-US')
    await page.getByLabel('Display name', { exact: true }).fill('Mobile draft survives resize')
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await expect(page.locator('.qq-capability-list > li')).toHaveCount(41)
      await expect(page.locator('.qq-capability-list > li > code')).toHaveCount(40)
    const pane = rightPane(page)
    const sidebar = secondSidebar(page)
    const categories = sidebar.getByRole('button')
    const categoryBoxes = await Promise.all([box(categories.nth(0)), box(categories.nth(1))])
    expect(Math.abs(categoryBoxes[0]!.y - categoryBoxes[1]!.y)).toBeLessThanOrEqual(1)
    expect(categoryBoxes[1]!.x).toBeGreaterThan(categoryBoxes[0]!.x)
    const trayTop = (await box(sidebar)).y
    const before = await chromePositions(page)
    await wheel(page, pane, 750)
    await expect.poll(() => scrollTop(pane)).toBeGreaterThan(0)
    expect((await box(sidebar)).y).toBe(trayTop)
    await chromeDidNotMove(page, before)
    await tabsAtPaneTop(page)
    await page.screenshot({ path: testInfo.outputPath('390-mobile-fixed-category-tray.png') })

    await page.setViewportSize({ width: 844, height: 390 })
    await frameIsViewport(page)
    await wheelToBottom(page, pane)
    await tabsAtPaneTop(page)
    await inPane(page.getByRole('button', { name: 'Disable plugin', exact: true }), pane, tabbar(page))
    await clickVisibleTab(page, 'Connection')
    const name = page.getByLabel('Display name', { exact: true })
    await expect(name).toHaveValue('Mobile draft survives resize')
    await name.focus()
    await inPane(name, pane, tabbar(page))
    await frameIsViewport(page)
    await page.screenshot({ path: testInfo.outputPath('844-landscape-resize.png') })
  })

  test('1280×420 的概览、DSH、设置与编辑器底部均可滚达，打开插件目录仍能操作主区', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto(`${url}/#overview`)
    await chooseLanguage(page, 'en-US')
    const mutations: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && !(request.url().endsWith('/api/plugins/dsh/manage') && request.postDataJSON()?.operation === 'get-model-capabilities')) mutations.push(request.url()) })
    const routes = ['overview', 'harness/dsh', 'settings/delivery', 'settings/queue', 'prompts/main']
    for (const route of routes) await test.step(route, async () => {
      await page.goto(`${url}/#${route}`)
      let endpoint: Locator
      if (route === 'overview') endpoint = page.locator('.version-note > span')
      else if (route === 'harness/dsh') {
        await expect(page.getByLabel('API base URL', { exact: true })).toBeEnabled()
        endpoint = page.getByRole('button', { name: 'Disable plugin', exact: true })
      } else if (route === 'settings/delivery') {
        await page.getByLabel('Grouping delay', { exact: true }).fill('575')
        endpoint = page.getByRole('button', { name: 'Save settings', exact: true })
      } else if (route === 'settings/queue') {
        await expect(page.getByLabel('Message storage', { exact: true })).toBeEnabled()
        endpoint = page.locator('.settings-clear-trigger')
      } else {
        await page.getByRole('textbox', { name: 'Prompt content', exact: true }).fill('Short-window prompt draft')
        endpoint = page.getByRole('button', { name: 'Save prompt', exact: true })
      }
      await expect(endpoint).toBeAttached()
      const pane = rightPane(page)
      const before = await chromePositions(page)
      await wheel(page, pane, 360)
      await expect.poll(() => scrollTop(pane)).toBeGreaterThan(0)
      await wheelToBottom(page, pane)
      await inPane(endpoint, pane)
      if (route !== 'overview') { await expect(endpoint).toBeEnabled(); await endpoint.click({ trial: true }) }
      await chromeDidNotMove(page, before)
      await page.screenshot({ path: testInfo.outputPath(`short-${route.replace('/', '-')}.png`) })
    })

    await page.goto(`${url}/#robots/qq`)
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await page.getByRole('button', { name: 'Add plugin', exact: true }).click()
    const catalog = page.locator('.catalog-container')
    await expect(page.getByRole('heading', { name: 'Installed plugins', exact: true })).toBeVisible()
    const close = page.getByRole('button', { name: 'Close plugin list', exact: true })
    await inPane(close, catalog)
    const pane = rightPane(page)
    expect((await box(pane)).height).toBeGreaterThan((await box(tabbar(page))).height + 40)
    const before = await chromePositions(page)
    await wheel(page, pane, 600)
    await expect.poll(() => scrollTop(pane)).toBeGreaterThan(0)
    await tabsAtPaneTop(page)
    await wheelToBottom(page, pane)
    await tabsAtPaneTop(page)
    await inPane(page.getByRole('button', { name: 'Disable plugin', exact: true }), pane, tabbar(page))
    await chromeDidNotMove(page, before)
    await page.screenshot({ path: testInfo.outputPath('short-catalog-open.png') })
    await close.click()
    await expect(catalog).toHaveCount(0)
    await clickVisibleTab(page, 'Function tests')
    await frameIsViewport(page)
    expect(mutations).toEqual([])
  })
})
