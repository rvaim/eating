import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type WebSocket from 'ws'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { replyOneBot, startOneBotFixture } from '../fixtures/onebot'
import type { OneBotFixtureRequest } from '../fixtures/onebot'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const credentialValue = 'fixture-cookie-用户原值-{{raw}}'
const genericConfirmation = '我已核对目标和参数，确认执行本次操作。'
const englishConfirmation = 'I have checked the target and parameters and confirm this operation.'

async function chooseLanguage(page: Page, language: 'zh-CN' | 'en-US') {
  await page.getByRole('combobox', { name: /^(界面语言|Display language)$/ }).selectOption(language)
  await expect(page.locator('html')).toHaveAttribute('lang', language)
}
async function visibility(page: Page, hidden: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test.describe('完整 OneBot 工具的通用面板', () => {
  test.setTimeout(45000)
  let directory: string
  let host: EatingHost
  let url: string
  let onebot: Awaited<ReturnType<typeof startOneBotFixture>>
  let delayedCredentials: Array<{ request: OneBotFixtureRequest; peer: WebSocket }>
  let pageErrors: string[]

  test.beforeEach(async ({ page }) => {
    pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && /unsafe-eval|Content Security Policy|Evaluating a string as JavaScript/i.test(message.text())) pageErrors.push(message.text()) })
    delayedCredentials = []
    let messageId = 9000
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_qq_tools_browser_')))
    onebot = await startOneBotFixture({ onRequest: (request, peer) => {
      if (request.action === 'get_credentials') {
        if (request.params.domain === 'late.test') delayedCredentials.push({ request, peer })
        else replyOneBot(peer, request, { cookies: credentialValue, csrf_token: 777 })
        return true
      }
      if (request.action === 'set_group_ban' && request.params.duration === 42) return true
      if (request.action === 'set_group_whole_ban_rate_limited') { replyOneBot(peer, request, null, 'async'); return true }
      if (request.action === 'send_msg') { replyOneBot(peer, request, { message_id: ++messageId }); return true }
      if (request.action.startsWith('set_group_') || request.action === '.handle_quick_operation') { replyOneBot(peer, request, null); return true }
    } })
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      await onebot?.close()
      const target = await realpath(directory)
      if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_qq_tools_browser_')) throw new Error('Unsafe QQ tools browser cleanup')
      await rm(target, { recursive: true })
    }
    expect(pageErrors).toEqual([])
  })

  async function configure(page: Page, timeout = 1000) {
    await page.goto(`${url}/#robots/qq`)
    await page.getByLabel('显示名称', { exact: true }).fill('用户配置名称 {{原文}}')
    await page.getByLabel('OneBot 地址', { exact: true }).fill(onebot.endpoint)
    await page.getByLabel('请求超时', { exact: true }).fill(String(timeout))
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。点击“连接 OneBot”重新连接。')).toBeVisible()
    await page.getByRole('button', { name: '连接 OneBot', exact: true }).click()
    await expect(page.getByText('账号：本地协议测试账号（123456789）')).toBeVisible()
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
  }

  test('三十九项双语目录、帮助和390px布局完整，切换语言保留草稿与请求ID', async ({ page }, testInfo) => {
    await configure(page)
    const panel = page.getByRole('tabpanel', { name: '功能测试', exact: true })
    await expect(page.getByLabel('测试功能', { exact: true }).locator('option')).toHaveCount(40)
    await chooseLanguage(page, 'en-US')
    const selector = page.getByLabel('Test function', { exact: true })
    const names = await selector.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
    const englishPanel = page.getByRole('tabpanel', { name: 'Function tests', exact: true })
    for (const name of names) {
      await selector.selectOption(name)
      expect(await englishPanel.innerText(), name).not.toMatch(/\p{Script=Han}|\{\{/u)
      await expect(englishPanel.locator('input,select,textarea').first()).toBeEnabled()
    }
    await selector.selectOption('qq_handle_quick_operation')
    await page.getByText('Parameter help', { exact: true }).click()
    await expect(englishPanel.getByText('OneBot action: .handle_quick_operation', { exact: true })).toBeVisible()
    await page.getByLabel('Original event JSON (required)', { exact: true }).fill('{"self_id":123456789,"post_type":"request","request_type":"friend","user_id":987654321,"flag":"用户原值 {{raw}}"}')
    await page.getByLabel('Quick operation JSON (required)', { exact: true }).fill('{"approve":false}')
    const before = await page.getByLabel('Request ID (required)', { exact: true }).inputValue()
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    const posts: string[] = []
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()) })
    await chooseLanguage(page, 'zh-CN')
    await expect(page.getByLabel('原始事件 JSON（必填）', { exact: true })).toHaveValue(/用户原值 \{\{raw\}\}/)
    await expect(page.getByLabel('请求 ID（必填）', { exact: true })).toHaveValue(before)
    await expect(page.getByRole('checkbox', { name: genericConfirmation, exact: true })).toBeChecked()
    await page.screenshot({ path: testInfo.outputPath('qq-tools-zh-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('qq-tools-zh-mobile.png'), fullPage: true })
    await chooseLanguage(page, 'en-US')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('qq-tools-en-mobile.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: testInfo.outputPath('qq-tools-en-desktop.png'), fullPage: true })
    expect(posts).toEqual([])
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await expect(page.getByText(/Qzone|QQ 空间|Reverse WebSocket/)).toHaveCount(0)
    await chooseLanguage(page, 'zh-CN')
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('用户配置名称 {{原文}}')
    await expect(panel).toBeHidden()
  })

  test('文本、消息段数组与单个对象明确选择，布尔false和枚举按实际协议发送', async ({ page }) => {
    await configure(page)
    await chooseLanguage(page, 'en-US')
    await page.getByLabel('Test function', { exact: true }).selectOption('qq_send_message')
    await page.getByLabel('Message type (optional)', { exact: true }).selectOption('group')
    await page.getByLabel('Target group number (optional)', { exact: true }).fill('123456')
    await page.getByLabel('Message content (required)', { exact: true }).fill('[普通文本] [CQ:at,qq=987654321] {{当前时间}}')
    await page.getByLabel('Send text literally (optional)', { exact: true }).selectOption('false')
    await page.getByLabel('Call mode (optional)', { exact: true }).selectOption('sync')
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    await page.getByRole('button', { name: 'Run test', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'send_msg').length).toBe(1)
    expect(onebot.requests.find(request => request.action === 'send_msg')?.params).toEqual({ message_type: 'group', group_id: 123456, message: '[普通文本] [CQ:at,qq=987654321] {{当前时间}}', auto_escape: false })
    await expect(page.getByRole('checkbox', { name: englishConfirmation, exact: true })).not.toBeChecked()
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    const priorFormatId = await page.getByLabel('Request ID (required)', { exact: true }).inputValue()
    await page.getByLabel('Message content format', { exact: true }).selectOption('json')
    await expect(page.getByRole('checkbox', { name: englishConfirmation, exact: true })).not.toBeChecked()
    expect(await page.getByLabel('Request ID (required)', { exact: true }).inputValue()).not.toBe(priorFormatId)
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    await page.getByRole('button', { name: 'Run test', exact: true }).click()
    await expect(page.getByText('The JSON is invalid. Check quotation marks, commas, and brackets.', { exact: true })).toBeVisible()
    expect(onebot.requests.filter(request => request.action === 'send_msg')).toHaveLength(1)
    await page.getByLabel('Message content (required)', { exact: true }).fill('['.repeat(20000) + '0' + ']'.repeat(20000))
    await expect(page.getByLabel('Test function', { exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    await page.getByRole('button', { name: 'Run test', exact: true }).click()
    await expect(page.getByText('Message content does not match the input rules. Check its instructions and JSON structure.', { exact: true })).toBeVisible()
    expect(onebot.requests.filter(request => request.action === 'send_msg')).toHaveLength(1)
    const array = [{ type: 'text', data: { text: '消息与 {{当前时间}} 保留原文' } }, { type: 'image', data: { file: 'https://example.test/图.png', cache: false, proxy: 0, timeout: 1.5 } }]
    await page.getByLabel('Message content (required)', { exact: true }).fill(JSON.stringify(array))
    await expect(page.getByRole('checkbox', { name: englishConfirmation, exact: true })).not.toBeChecked()
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    await page.getByRole('button', { name: 'Run test', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'send_msg').length).toBe(2)
    expect(onebot.requests.filter(request => request.action === 'send_msg')[1]?.params.message).toEqual(array)
    const single = { type: 'face', data: { id: 123 } }
    await expect(page.getByRole('button', { name: 'Run test', exact: true })).toBeDisabled()
    await page.getByLabel('Message content (required)', { exact: true }).fill(JSON.stringify(single))
    await page.getByRole('checkbox', { name: englishConfirmation, exact: true }).check()
    await page.getByRole('button', { name: 'Run test', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'send_msg').length).toBe(3)
    expect(onebot.requests.filter(request => request.action === 'send_msg')[2]?.params.message).toEqual(single)
  })

  test('群管理使用通用确认和整数布尔表单，快捷操作JSON保持原值，普通记录最多十条', async ({ page }) => {
    await configure(page)
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_set_group_whole_ban')
    await expect(page.getByText('将执行“设置全员禁言”，请核对目标和参数', { exact: true })).toBeVisible()
    await expect(page.getByLabel('启用此设置（选填）', { exact: true }).locator('option[value=""]')).toHaveText('未指定（默认：true · 是）')
    await expect(page.locator('.qq-target-preview')).toContainText('默认值')
    await page.getByLabel('目标群号（必填）', { exact: true }).fill('123456')
    await page.getByLabel('启用此设置（选填）', { exact: true }).selectOption('false')
    await expect(page.getByRole('button', { name: '执行测试', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    const before = await page.getByLabel('请求 ID（必填）', { exact: true }).inputValue()
    await page.getByLabel('启用此设置（选填）', { exact: true }).selectOption('true')
    await expect(page.getByRole('checkbox', { name: genericConfirmation, exact: true })).not.toBeChecked()
    expect(await page.getByLabel('请求 ID（必填）', { exact: true }).inputValue()).not.toBe(before)
    await page.getByLabel('启用此设置（选填）', { exact: true }).selectOption('false')
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'set_group_whole_ban').length).toBe(1)
    expect(onebot.requests.find(request => request.action === 'set_group_whole_ban')?.params).toEqual({ group_id: 123456, enable: false })
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_set_group_ban')
    await page.getByLabel('目标群号（必填）', { exact: true }).fill('123456')
    await page.getByLabel('目标 QQ 号（必填）', { exact: true }).fill('987654321')
    await page.getByLabel('时长（秒）（选填）', { exact: true }).fill('0')
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'set_group_ban').length).toBe(1)
    expect(onebot.requests.find(request => request.action === 'set_group_ban')?.params.duration).toBe(0)
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_handle_quick_operation')
    const context = { self_id: 123456789, post_type: 'request', request_type: 'friend', user_id: 987654321, flag: '原始标记 {{flag}}' }
    const operation = { approve: false, remark: '用户原文 {{name}}' }
    await page.getByLabel('原始事件 JSON（必填）', { exact: true }).fill(JSON.stringify(context))
    await page.getByLabel('快捷操作 JSON（必填）', { exact: true }).fill(JSON.stringify(operation))
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === '.handle_quick_operation').length).toBe(1)
    expect(onebot.requests.find(request => request.action === '.handle_quick_operation')?.params).toEqual({ context, operation })
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_get_login_info')
    for (let index = 0; index < 12; index++) {
      const count = onebot.requests.filter(request => request.action === 'get_login_info').length
      await page.getByRole('button', { name: '执行测试', exact: true }).click()
      await expect.poll(() => onebot.requests.filter(request => request.action === 'get_login_info').length).toBe(count + 1)
      await expect(page.getByRole('button', { name: '执行测试', exact: true })).toBeEnabled()
    }
    await expect(page.locator('.qq-history summary')).toHaveText('最近的普通执行记录（10）')
    await page.locator('.qq-history summary').click()
    await expect(page.locator('.qq-history .qq-execution')).toHaveCount(10)
  })

  test('凭据仅主动显示，隐藏离开停用均清除，已取消的迟到结果不能恢复或进入记录', async ({ page }) => {
    await configure(page, 5000)
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_get_credentials')
    expect(onebot.requests.filter(request => request.action === 'get_credentials')).toHaveLength(0)
    const aborted: string[] = []
    page.on('requestfailed', request => { if (request.url().endsWith('/plugins/qq/invoke')) aborted.push(request.url()) })
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByLabel('请求与结果 JSON', { exact: true })).toContainText(credentialValue)
    await visibility(page, true)
    await expect(page.locator('.qq-execution')).toHaveCount(0)
    await visibility(page, false)
    await expect(page.locator('.qq-execution')).toHaveCount(0)
    await page.getByLabel('凭据域名（选填）', { exact: true }).fill('late.test')
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => delayedCredentials.length).toBe(1)
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await expect.poll(() => aborted.length).toBe(1)
    replyOneBot(delayedCredentials[0]!.peer, delayedCredentials[0]!.request, { cookies: 'late-secret-tab', csrf_token: 888 })
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await expect(page.locator('.qq-execution')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '执行测试', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => delayedCredentials.length).toBe(2)
    await visibility(page, true)
    await expect.poll(() => aborted.length).toBe(2)
    replyOneBot(delayedCredentials[1]!.peer, delayedCredentials[1]!.request, { cookies: 'late-secret-hidden', csrf_token: 999 })
    await visibility(page, false)
    await expect(page.locator('.qq-execution')).toHaveCount(0)
    await page.getByLabel('凭据域名（选填）', { exact: true }).fill('normal.test')
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByLabel('请求与结果 JSON', { exact: true })).toContainText(credentialValue)
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await expect(page.locator('.qq-execution')).toHaveCount(0)
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByLabel('请求与结果 JSON', { exact: true })).toContainText(credentialValue)
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_get_login_info')
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByLabel('请求与结果 JSON', { exact: true })).toContainText('本地协议测试账号')
    await expect(page.locator('.qq-history')).toHaveCount(0)
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain('secret')
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_get_credentials')
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.locator('.qq-execution').first()).toContainText(credentialValue)
    await page.getByRole('button', { name: '停用插件', exact: true }).click()
    await page.getByRole('button', { name: '确认停用', exact: true }).click()
    await expect(page.locator('.qq-panel')).toHaveCount(0)
    await page.getByRole('button', { name: '添加连接', exact: true }).click()
    await page.getByRole('button', { name: '启用 QQ 插件', exact: true }).click()
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await expect(page.locator('.qq-execution')).toHaveCount(0)
    await expect(page.locator('.qq-history')).toHaveCount(0)
    expect(await page.locator('body').innerText()).not.toMatch(/fixture-cookie|late-secret/)
  })

  test('未知群管理结果保留原ID和参数，核对原请求不重发，限速接纳不显示完成', async ({ page }) => {
    await configure(page)
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_set_group_ban')
    await page.getByLabel('目标群号（必填）', { exact: true }).fill('123456')
    await page.getByLabel('目标 QQ 号（必填）', { exact: true }).fill('987654321')
    await page.getByLabel('时长（秒）（选填）', { exact: true }).fill('42')
    const before = await page.getByLabel('请求 ID（必填）', { exact: true }).inputValue()
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByRole('heading', { name: '上次动作结果未知', exact: true })).toBeVisible()
    await visibility(page, true)
    await visibility(page, false)
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await expect(page.getByLabel('请求 ID（必填）', { exact: true })).toHaveValue(before)
    await expect(page.getByLabel('目标群号（必填）', { exact: true })).toBeDisabled()
    await expect(page.getByLabel('时长（秒）（选填）', { exact: true })).toHaveValue('42')
    await page.getByRole('checkbox', { name: '我已核对真实状态，理解上次动作可能已执行。', exact: true }).check()
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    const lookup = page.waitForResponse(response => response.url().endsWith('/plugins/qq/invoke') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '重试原请求（复用 ID）', exact: true }).click()
    const response = await lookup
    expect(response.request().postDataJSON()).toMatchObject({ requestId: before, arguments: { request_id: before, duration: 42 } })
    expect(onebot.requests.filter(request => request.action === 'set_group_ban')).toHaveLength(1)
    await expect(page.getByLabel('请求 ID（必填）', { exact: true })).toHaveValue(before)
    await page.getByRole('checkbox', { name: '我已核对真实状态，理解上次动作可能已执行。', exact: true }).check()
    await page.getByRole('button', { name: '创建新请求', exact: true }).click()
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_set_group_whole_ban')
    await page.getByLabel('目标群号（必填）', { exact: true }).fill('123456')
    await page.getByLabel('启用此设置（选填）', { exact: true }).selectOption('false')
    await page.getByLabel('调用模式（选填）', { exact: true }).selectOption('rate_limited')
    await expect(page.getByText('异步或限速模式仅表示请求已接收，无法确认动作完成。请核对真实状态；不会自动重试。', { exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: genericConfirmation, exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByRole('heading', { name: '上次动作结果未知', exact: true })).toBeVisible()
    expect(onebot.requests.filter(request => request.action === 'set_group_whole_ban_rate_limited')).toHaveLength(1)
    expect(onebot.requests.find(request => request.action === 'set_group_whole_ban_rate_limited')?.params).toEqual({ group_id: 123456, enable: false })
    await expect(page.getByRole('tabpanel', { name: '功能测试', exact: true }).locator(':scope > .qq-execution')).not.toContainText('执行完成')
  })
})
