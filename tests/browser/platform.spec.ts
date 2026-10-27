import { test, expect } from '@playwright/test'
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { startOneBotFixture } from '../fixtures/onebot'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))

test.describe('正式 QQ 平台与 OneBot v11', () => {
  let directory: string
  let host: EatingHost
  let url: string
  let onebot: Awaited<ReturnType<typeof startOneBotFixture>>

  test.beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_browser_')))
    onebot = await startOneBotFixture({ accessToken: 'browser-fixture-secret', onRequest: request => request.action.startsWith('send_') && request.params.message === 'delay-for-unknown' })
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  })
  test.afterEach(async () => {
    await host?.close()
    await onebot?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || !target.startsWith((await realpath(tmpdir())) + '/Eating_browser_')) throw new Error('Unexpected test directory')
    await rm(target, { recursive: true })
  })

  async function configure(page: import('@playwright/test').Page) {
    await page.goto(`${url}/#robots/qq`)
    await page.getByLabel('显示名称', { exact: true }).fill('正式 QQ 连接')
    await page.getByLabel('OneBot 地址', { exact: true }).fill(onebot.endpoint)
    await page.getByLabel('Bearer 访问令牌', { exact: true }).fill('browser-fixture-secret')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存到 Eating Host。旧连接已断开，点击“连接 OneBot”核验账号与状态。')).toBeVisible()
  }
  async function connect(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: '连接 OneBot', exact: true }).click()
    await expect(page.getByText('账号：本地协议测试账号（123456789）')).toBeVisible()
  }

  test('仅有正式 QQ，保存到实例文件且刷新不回显令牌', async ({ page }) => {
    await configure(page)
    const classes = page.getByRole('navigation', { name: '平台分类', exact: true })
    await expect(classes.getByRole('button', { name: 'QQ', exact: true })).toBeVisible()
    await expect(classes.getByRole('button', { name: '飞书', exact: true })).toHaveCount(0)
    await expect(classes.getByRole('button', { name: '微信', exact: true })).toHaveCount(0)
    await expect(page.getByText(/本地示例|示例插件|demo/i)).toHaveCount(0)
    const index = JSON.parse(await readFile(join(directory, 'bot/qq-bot/accounts.json'), 'utf8')) as { defaultInstanceId: string; instances: unknown[] }
    expect(index.instances).toHaveLength(1)
    const path = join(directory, 'bot/qq-bot/accounts', index.defaultInstanceId, 'config.json')
    const config = JSON.parse(await readFile(path, 'utf8')) as { configuration: { accessToken: string; endpoint: string } }
    expect(config.configuration.accessToken).toBe('browser-fixture-secret')
    expect(config.configuration.endpoint).toBe(onebot.endpoint)
    expect(await readdir(join(directory, 'bot/qq-bot/accounts'))).toEqual([index.defaultInstanceId])
    await page.reload()
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('正式 QQ 连接')
    await expect(page.getByLabel('Bearer 访问令牌', { exact: true })).toHaveValue('')
    await expect(page.getByText(path, { exact: true })).toBeVisible()
    await connect(page)
    await page.getByRole('button', { name: '断开连接', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '连接配置', exact: true }).getByText('QQ 的 OneBot 连接已断开。')).toBeVisible()
  })

  test('功能面板调用真实工具，发送必须确认且只发到协议夹具', async ({ page }) => {
    await configure(page); await connect(page)
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByText('QQ 功能测试已完成，请查看真实返回结果。')).toBeVisible()
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_send_private_message')
    await page.getByLabel('收件人 QQ 号（必填）', { exact: true }).fill('987654321')
    await page.getByLabel('消息内容（必填）', { exact: true }).fill('测试夹具消息，不发送到真人')
    await expect(page.getByRole('button', { name: '执行测试', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: '我已核对目标和内容，确认执行此次真实发送。', exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'send_private_msg').length).toBe(1)
    expect(onebot.requests.find(request => request.action === 'send_private_msg')?.params).toMatchObject({ user_id: 987654321, message: '测试夹具消息，不发送到真人', auto_escape: true })
    await expect(page.getByRole('checkbox', { name: '我已核对目标和内容，确认执行此次真实发送。', exact: true })).not.toBeChecked()
  })

  test('消息持久化、去重和 Harness 未接入状态可见，MCP 令牌按需读取', async ({ page }) => {
    await configure(page); await connect(page)
    const event = { time: 1, self_id: 123456789, post_type: 'message', message_type: 'private', sub_type: 'friend',
      message_id: 456, user_id: 987654321, message: [{ type: 'text', data: { text: '真实协议输入测试' } }], raw_message: '真实协议输入测试', sender: { nickname: '协议夹具联系人' } }
    onebot.emitEvent(event); onebot.emitEvent(event)
    await page.getByRole('tab', { name: '消息记录', exact: true }).click()
    await expect(page.getByText('真实协议输入测试', { exact: true })).toBeVisible()
    await expect(page.locator('.qq-message-list > li')).toHaveCount(1)
    await expect(page.locator('.qq-message-list').getByText('等待投递', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'MCP 能力', exact: true }).click()
    await expect(page.getByText('Harness 消息接口尚未接入', { exact: true })).toBeVisible()
    await expect(page.getByText('QQ 空间发布', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '查看 / 复制 MCP 配置', exact: true }).click()
    await expect(page.getByLabel('MCP 连接配置', { exact: true })).toContainText('/mcp/qq')
    await page.getByRole('tab', { name: '消息记录', exact: true }).click()
    await expect(page.getByLabel('MCP 连接配置', { exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: 'MCP 能力', exact: true }).click()
    await expect(page.getByLabel('MCP 连接配置', { exact: true })).toHaveCount(0)
  })

  test('发送超时明确未知，显式复用请求 ID 不重复发送', async ({ page }) => {
    await configure(page)
    await page.getByLabel('请求超时', { exact: true }).fill('1000')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await connect(page)
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_send_private_message')
    await page.getByLabel('收件人 QQ 号（必填）', { exact: true }).fill('987654321')
    await page.getByLabel('消息内容（必填）', { exact: true }).fill('delay-for-unknown')
    const before = await page.getByLabel('请求 ID（必填）', { exact: true }).inputValue()
    await page.getByRole('checkbox', { name: '我已核对目标和内容，确认执行此次真实发送。', exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByRole('heading', { name: '上次动作结果未知', exact: true })).toBeVisible()
    await expect(page.getByLabel('请求 ID（必填）', { exact: true })).toHaveValue(before)
    await page.getByRole('checkbox', { name: '我已核查真实状态，理解上次动作仍可能已执行。', exact: true }).check()
    await page.getByRole('checkbox', { name: '我已核对目标和内容，确认执行此次真实发送。', exact: true }).check()
    await page.getByRole('button', { name: '重试原请求（复用 ID）', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'send_private_msg').length).toBe(1)
    await expect(page.getByLabel('请求 ID（必填）', { exact: true })).toHaveValue(before)
  })

  test('配置损坏保持插件局部错误，已安装面板仍可打开', async ({ page }) => {
    await host.close()
    const index = JSON.parse(await readFile(join(directory, 'bot/qq-bot/accounts.json'), 'utf8')) as { defaultInstanceId: string }
    const config = join(directory, 'bot/qq-bot/accounts', index.defaultInstanceId, 'config.json')
    await writeFile(config, '{broken')
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
    await page.goto(`${url}/#robots/qq`)
    await expect(page.getByRole('tab', { name: '连接配置', exact: true })).toBeVisible()
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
    await expect(page.getByText('QQ 配置格式损坏或版本不兼容，未覆盖原文件。', { exact: true })).toBeVisible()
    await expect(page.locator('.storage-error')).toHaveCount(0)
    expect(await readFile(config, 'utf8')).toBe('{broken')
  })

  test('合法SemVer构建元数据版本能加载独立前端', async ({ page }) => {
    await host.close()
    const source = join(directory, 'upgrade-source')
    await cp(fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)), source, { recursive: true })
    const manifestPath = join(source, 'eating-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; integrity: Record<string, string> }
    manifest.version = '0.2.1+local'
    for (const [name, before, after] of [['server.mjs', 'version = "0.2.0"', 'version = "0.2.1+local"'], ['ui/index.js', 'version:"0.2.0"', 'version:"0.2.1+local"']]) {
      const path = join(source, name!)
      const text = await readFile(path, 'utf8')
      expect(text).toContain(before!)
      await writeFile(path, text.replace(before!, after!))
      manifest.integrity[name!] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await installPluginPackage(directory, source)
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
    await page.goto(`${url}/#robots/qq`)
    await expect(page.getByRole('tab', { name: '连接配置', exact: true })).toBeVisible()
    await expect(page.getByText('v0.2.1+local', { exact: true })).toBeVisible()
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
  })

  test('面板资源失败局限于插件，通用目录仍可管理', async ({ page }) => {
    await page.route('**/plugins/qq/*/ui/index.js', route => route.abort())
    await page.goto(`${url}/#robots/qq`)
    await expect(page.getByRole('alert').getByText('此插件的管理面板加载失败，请检查安装包并重启 Host。其他插件仍可使用。', { exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '平台分类', exact: true }).getByRole('button', { name: 'QQ', exact: true })).toBeVisible()
    await expect(page.locator('.storage-error')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '移除插件', exact: true })).toBeVisible()
  })

  test('窄屏功能面板与停用保留配置均可操作', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await configure(page)
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await page.getByRole('button', { name: '移除插件', exact: true }).click()
    await page.getByRole('button', { name: '确认移除', exact: true }).click()
    await expect(page.getByRole('heading', { name: '从一个连接开始', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '查看平台插件', exact: true }).click()
    await page.getByRole('button', { name: '注册QQ插件', exact: true }).click()
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('正式 QQ 连接')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})
