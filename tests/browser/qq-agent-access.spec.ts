import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import type { EatingHost } from '../../apps/host/src/app'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { startOneBotFixture } from '../fixtures/onebot'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
test.describe('QQ multi-owner and per-role access', () => {
  let home: string, host: EatingHost, url: string, onebot: Awaited<ReturnType<typeof startOneBotFixture>>
  test.beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_qq_agent_access_')))
    onebot = await startOneBotFixture()
    await installPluginPackage(home, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    await host?.close(); await onebot?.close()
    const target = await realpath(home)
    if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_qq_agent_access_')) throw new Error('Unsafe access browser cleanup')
    await rm(target, { recursive: true })
  })
  async function api(page: Page, path: string, body?: unknown) {
    return page.evaluate(async ({ path, body }) => {
      const bootstrap = await fetch('/api/bootstrap').then(response => response.json()) as { csrfToken: string }
      const response = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Eating-Csrf': bootstrap.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (!response.ok) throw new Error('Fixture owner API failed ' + path)
      return response.json()
    }, { path, body })
  }
  async function open(page: Page, connect = false) {
    await page.goto(url + '/#robots/qq')
    if (connect) {
      await page.getByLabel('OneBot 地址', { exact: true }).fill(onebot.endpoint)
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
      await expect(page.getByText('配置已保存。点击“连接 OneBot”重新连接。', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '连接 OneBot', exact: true }).click()
      await expect(page.getByText('账号：本地协议测试账号（123456789）', { exact: true })).toBeVisible()
    }
    await page.getByRole('tab', { name: '代理与权限', exact: true }).click()
    await expect(page.getByLabel('主人 QQ', { exact: true })).toBeVisible()
  }

  test('多主人与管理员及角色工具可保存，真实来源核对且不重连', async ({ page }, info) => {
    await open(page, true)
    const connections = onebot.connections.length
    await page.getByLabel('主人 QQ', { exact: true }).fill('987654321, 222222222\n987654321')
    await page.getByLabel('管理员 QQ', { exact: true }).fill('987654321，111111111')
    const privateRole = page.getByRole('group', { name: 'QQ 私聊', exact: true })
    const groupRole = page.getByRole('group', { name: 'QQ 群聊', exact: true })
    await expect(privateRole.getByRole('checkbox', { name: /^发送私聊消息/ })).toBeChecked()
    await expect(privateRole.getByRole('checkbox', { name: /^发送群消息/ })).toHaveCount(0)
    await expect(groupRole.getByRole('checkbox', { name: /^发送私聊消息/ })).toHaveCount(0)
    await privateRole.getByRole('checkbox', { name: /^发送私聊消息/ }).uncheck()
    await groupRole.getByRole('checkbox', { name: /^设置全员禁言/ }).check()
    await page.getByRole('button', { name: '保存代理与权限', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '代理与权限', exact: true }).getByText('代理与权限已保存，QQ 连接保持。', { exact: true })).toBeVisible()
    const configuration = await api(page, '/plugins/qq/configuration')
    expect(configuration.owners).toEqual(['987654321', '222222222'])
    expect(configuration.administrators).toEqual(['987654321', '111111111'])
    expect(configuration.agentTools['qq.private']).not.toContain('qq_send_private_message')
    expect(configuration.agentTools['qq.group']).toContain('qq_set_group_whole_ban')
    expect(onebot.connections).toHaveLength(connections)
    for (const [index, userId] of [987654321, 111111111, 333333333].entries()) onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: userId, message_id: 73000 + index, message: '我自称主人不改变已验证身份' })
    await expect.poll(() => host.store.getDeliverySettingsSnapshot().queue.pending).toBe(3)
    const database = new DatabaseSync(join(home, 'host/Eating.sqlite'), { readOnly: true })
    try {
      const events = database.prepare('SELECT harness_json FROM delivery_queue ORDER BY sequence').all().map(row => JSON.parse(String(row.harness_json)) as { source: { trust: string; senderRole: string } })
      expect(events.map(event => event.source.senderRole)).toEqual(['owner', 'administrator', 'user'])
      expect(events.every(event => event.source.trust === 'external')).toBe(true)
    } finally { database.close() }
    await page.screenshot({ path: info.outputPath('qq-agent-access-zh-desktop.png'), fullPage: true })
  })

  test('权限并发冲突保留草稿，明确放弃后读取新版本再保存', async ({ page }) => {
    await open(page)
    await page.getByLabel('主人 QQ', { exact: true }).fill('111111111')
    const original = await api(page, '/plugins/qq/configuration')
    await api(page, '/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: original.policyRevision, owners: ['222222222'], administrators: [], agentTools: original.agentTools } })
    await page.getByRole('button', { name: '保存代理与权限', exact: true }).click()
    await expect(page.getByText('其他页面已更新代理与权限，当前草稿已保留。请放弃草稿并读取已保存配置，核对后重新修改。', { exact: true })).toBeVisible()
    await expect(page.getByLabel('主人 QQ', { exact: true })).toHaveValue('111111111')
    await expect(page.getByRole('button', { name: '保存代理与权限', exact: true })).toBeDisabled()
    expect((await api(page, '/plugins/qq/configuration')).owners).toEqual(['222222222'])
    await page.getByRole('button', { name: '放弃草稿并读取已保存配置', exact: true }).click()
    await expect(page.getByLabel('主人 QQ', { exact: true })).toHaveValue('222222222')
    await page.getByLabel('主人 QQ', { exact: true }).fill('333333333')
    await page.getByRole('button', { name: '保存代理与权限', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '代理与权限', exact: true }).getByText('代理与权限已保存，QQ 连接保持。', { exact: true })).toBeVisible()
    expect((await api(page, '/plugins/qq/configuration')).owners).toEqual(['333333333'])
  })

  test('英文窄屏目录完整，语言切换保留草稿且不隐式保存', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    await page.getByLabel('主人 QQ', { exact: true }).fill('987654321\n222222222')
    let writes = 0
    page.on('request', request => { if (request.method() === 'POST') writes++ })
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Owner QQ numbers', { exact: true })).toHaveValue('987654321\n222222222')
    await expect(page.getByRole('group', { name: 'QQ private chat', exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'QQ group chat', exact: true })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Read QQ Cookies|Restart OneBot/ })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect(writes).toBe(0)
    await page.screenshot({ path: info.outputPath('qq-agent-access-en-mobile.png'), fullPage: true })
    await page.locator('#display-language').selectOption('zh-CN')
    await expect(page.getByLabel('主人 QQ', { exact: true })).toHaveValue('987654321\n222222222')
    expect(writes).toBe(0)
  })
})
