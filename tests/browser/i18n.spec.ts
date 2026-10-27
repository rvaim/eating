import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = (path: string) => fileURLToPath(new URL(`../../plugins/${path}/dist/`, import.meta.url))
const oldDevelopmentCopy = ['选择一个平台，打开它自己的配置面板。', '我的工作区', '交接完成即删除正文', '未转交不保存正文', '仅短期保留去重标识']
const chooseLanguage = async (page: Page, language: 'zh-CN' | 'en-US') => {
  await page.getByRole('combobox', { name: /^(界面语言|Display language)$/ }).selectOption(language)
  await expect(page.locator('html')).toHaveAttribute('lang', language)
}
const promptEditor = (page: Page) => page.locator('.template-editor [role="textbox"]')

test.describe('用户文案与宿主/独立插件的共享语言', () => {
  test.setTimeout(45000)
  let home: string
  let host: EatingHost
  let url: string
  let errors: string[]

  test.beforeEach(async ({ page }) => {
    errors = []
    page.on('pageerror', error => errors.push(error.message))
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_locale_browser_')))
    await installPluginPackage(home, pluginDirectory('communication/qq'))
    await installPluginPackage(home, pluginDirectory('harness/dsh'))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      const target = await realpath(home)
      if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_locale_browser_')) throw new Error('Unsafe locale test cleanup')
      await rm(target, { recursive: true })
    }
    expect(errors).toEqual([])
  })

  test('主界面与迟加载QQ插件共享语言，切换保留未保存配置且不发起写操作', async ({ page }) => {
    const mutations: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().startsWith(url + '/api/')) mutations.push(request.url()) })
    await page.goto(`${url}/#overview`)
    await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible()
    await chooseLanguage(page, 'en-US')
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    await expect(page).toHaveTitle('Eating · Overview')
    await page.getByRole('link', { name: 'Connections', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible()
    await page.goto(`${url}/#robots/qq`)
    await expect(page.getByLabel('OneBot address', { exact: true })).toBeVisible()
    await page.getByLabel('Display name', { exact: true }).fill('保留用户配置名称')
    await chooseLanguage(page, 'zh-CN')
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('保留用户配置名称')
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
    for (const phrase of oldDevelopmentCopy) await expect(page.getByText(phrase, { exact: false })).toHaveCount(0)
    expect(mutations).toEqual([])
  })

  test('语言偏好刷新后保留，并同步到另一个已有页面和独立DSH面板', async ({ page, context }) => {
    await page.goto(`${url}/#overview`)
    await chooseLanguage(page, 'en-US')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('eating.locale'))).toBe('en-US')
    const other = await context.newPage()
    other.on('pageerror', error => errors.push(error.message))
    try {
      await other.goto(`${url}/#harness/dsh`)
      await expect(other.getByLabel('API base URL', { exact: true })).toBeVisible()
      await other.getByLabel('Display name', { exact: true }).fill('独立模型草稿名称')
      await chooseLanguage(page, 'zh-CN')
      await expect(other.locator('html')).toHaveAttribute('lang', 'zh-CN')
      await expect(other.getByLabel('API 基础地址', { exact: true })).toBeVisible()
      await expect(other.getByLabel('显示名称', { exact: true })).toHaveValue('独立模型草稿名称')
      await expect(other.getByRole('button', { name: '启动 Harness', exact: true })).toBeDisabled()
    } finally { await other.close() }
  })

  test('切换语言不丢提示词草稿与撤销历史，诊断和补全说明随语言更新', async ({ page }) => {
    await page.goto(`${url}/#prompts/main`)
    const editor = promptEditor(page)
    await expect(editor).toBeVisible()
    const original = await editor.innerText()
    const draft = '用户填写的正文保持原样 {{当前时间}}'
    await editor.fill(draft)
    await chooseLanguage(page, 'en-US')
    await expect(editor).toHaveAttribute('aria-label', 'Prompt content')
    await expect(editor).toHaveText(draft)
    await editor.press('ControlOrMeta+z')
    await expect.poll(() => editor.innerText()).toBe(original)
    await editor.fill('用户正文 {{未提供的变量}}')
    await expect(page.getByLabel('Template variable diagnostics', { exact: true })).toContainText('Unknown variable')
    await expect(page.getByRole('button', { name: 'Save prompt', exact: true })).toBeDisabled()
    await editor.fill('')
    await editor.pressSequentially('{{')
    const candidates = page.getByRole('listbox', { name: 'Available variables', exact: true })
    await expect(candidates).toBeVisible()
    await expect(candidates).toContainText('The current time')
    await editor.press('Escape')
    await chooseLanguage(page, 'zh-CN')
    await expect(editor).toHaveAttribute('aria-label', '提示词内容')
    await expect(editor).toHaveText('{{')
  })

  test('英语设置保留数值草稿，冲突提示不显示后台内部文案', async ({ page }) => {
    await page.goto(`${url}/#settings/delivery`)
    const delay = page.getByLabel('合并等待时间', { exact: true })
    await expect(delay).toBeVisible()
    await delay.fill('321')
    await chooseLanguage(page, 'en-US')
    await expect(page.getByLabel('Grouping delay', { exact: true })).toHaveValue('321')
    await page.route('**/api/settings', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DELIVERY_SETTINGS_CONFLICT', message: '后台开发说明不应成为用户主文案', outcome: 'failed' } }) }) : route.continue())
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect(page.locator('.settings-notice-error')).toContainText(/changed elsewhere/i)
    await expect(page.getByText('后台开发说明不应成为用户主文案', { exact: false })).toHaveCount(0)
    await expect(page.getByLabel('Grouping delay', { exact: true })).toHaveValue('321')
    await chooseLanguage(page, 'zh-CN')
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('321')
    await expect(page.locator('.settings-notice-error')).toContainText('其他位置')
  })

  test('English QQ功能目录和结构化错误本地化，消息正文与配置内容不被翻译', async ({ page }) => {
    await page.goto(`${url}/#robots/qq`)
    await chooseLanguage(page, 'en-US')
    await page.getByLabel('OneBot address', { exact: true }).fill('ws://127.0.0.1:3001')
    await page.getByLabel('Display name', { exact: true }).fill('这个名称不能翻译')
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('这个名称不能翻译')
    const index = JSON.parse(await readFile(join(home, 'bot/qq-bot/accounts.json'), 'utf8')) as { defaultInstanceId: string }
    const configuration = JSON.parse(await readFile(join(home, 'bot/qq-bot/accounts', index.defaultInstanceId, 'config.json'), 'utf8')) as { configuration: { displayName: string } }
    expect(configuration.configuration.displayName).toBe('这个名称不能翻译')
    await page.getByRole('tab', { name: 'Function tests', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Test function', exact: true })).toBeVisible()
    const functions = await page.getByRole('combobox', { name: 'Test function', exact: true }).innerText()
    expect(functions).toContain('Send private message')
    expect(functions).not.toContain('发送私聊消息')
    await page.getByRole('tab', { name: 'Live logs', exact: true }).click()
    await expect(page.getByRole('tabpanel')).not.toContainText('交接完成即删除正文')
  })

  test('390px英文长文案在主要页面无横向溢出，语言控件可用', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${url}/#overview`)
    await chooseLanguage(page, 'en-US')
    for (const route of ['robots/qq', 'harness/dsh', 'settings/queue', 'prompts/main', 'personas/new']) {
      await page.goto(`${url}/#${route}`)
      await expect(page.getByRole('combobox', { name: 'Display language', exact: true })).toBeVisible()
      if (route === 'robots/qq') await expect(page.getByLabel('OneBot address', { exact: true })).toBeVisible()
      else if (route === 'harness/dsh') await expect(page.getByLabel('API base URL', { exact: true })).toBeVisible()
      else if (route.startsWith('settings')) await expect(page.getByLabel('Message storage', { exact: true })).toBeVisible()
      else await expect(promptEditor(page)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await page.screenshot({ path: testInfo.outputPath(`en-mobile-${route.replace('/', '-')}.png`), fullPage: true })
    }
  })
})
