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
    await page.getByLabel('访问令牌（Bearer）', { exact: true }).fill('browser-fixture-secret')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。点击“连接 OneBot”重新连接。')).toBeVisible()
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
    await expect(page.getByLabel('访问令牌（Bearer）', { exact: true })).toHaveValue('')
    await page.getByText('配置与数据位置', { exact: true }).click()
    await expect(page.getByText(path, { exact: true })).toBeVisible()
    await connect(page)
    await page.getByRole('button', { name: '断开连接', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '连接配置', exact: true }).getByText('QQ 连接已断开。')).toBeVisible()
  })

  test('功能面板调用真实工具，发送必须确认且只发到协议夹具', async ({ page }) => {
    await configure(page); await connect(page)
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByText('QQ 功能测试已完成，请查看返回结果。')).toBeVisible()
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_send_private_message')
    await page.getByLabel('收件人 QQ 号（必填）', { exact: true }).fill('987654321')
    await page.getByLabel('消息内容（必填）', { exact: true }).fill('测试夹具消息，不发送到真人')
    await expect(page.getByRole('button', { name: '执行测试', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: '我已核对目标和内容，确认发送此次真实 QQ 消息。', exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'send_private_msg').length).toBe(1)
    expect(onebot.requests.find(request => request.action === 'send_private_msg')?.params).toMatchObject({ user_id: 987654321, message: '测试夹具消息，不发送到真人', auto_escape: true })
    await expect(page.getByRole('checkbox', { name: '我已核对目标和内容，确认发送此次真实 QQ 消息。', exact: true })).not.toBeChecked()
  })

  test('无聊天历史入口，待投递去重且MCP令牌按需读取', async ({ page }) => {
    await configure(page); await connect(page)
    const event = { time: 1, self_id: 123456789, post_type: 'message', message_type: 'private', sub_type: 'friend',
      message_id: 456, user_id: 987654321, message: [{ type: 'text', data: { text: '真实协议输入测试' } }], raw_message: '真实协议输入测试', sender: { nickname: '协议夹具联系人' } }
    onebot.emitEvent(event); onebot.emitEvent(event)
    await expect.poll(() => host.store.getDeliverySettingsSnapshot().queue.pending).toBe(1)
    await expect(page.getByRole('tab', { name: '消息记录', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: 'MCP 能力', exact: true }).click()
    await expect(page.getByText('等待连接 AI', { exact: true })).toBeVisible()
    await expect(page.getByText('发布 QQ 空间动态', { exact: true })).toHaveCount(0)
    await expect(page.getByText('QQ 空间评论与回复', { exact: true })).toHaveCount(0)
    await expect(page.getByText('设置全员禁言', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '查看 MCP 配置', exact: true }).click()
    await expect(page.getByLabel('MCP 连接配置', { exact: true })).toContainText('/mcp/qq')
    await page.getByRole('tab', { name: '实时日志', exact: true }).click()
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
    await page.getByRole('checkbox', { name: '我已核对目标和内容，确认发送此次真实 QQ 消息。', exact: true }).check()
    await page.getByRole('button', { name: '执行测试', exact: true }).click()
    await expect(page.getByRole('heading', { name: '上次动作结果未知', exact: true })).toBeVisible()
    await expect(page.getByLabel('请求 ID（必填）', { exact: true })).toHaveValue(before)
    await page.getByRole('checkbox', { name: '我已核对真实状态，理解上次动作可能已执行。', exact: true }).check()
    await page.getByRole('checkbox', { name: '我已核对目标和内容，确认发送此次真实 QQ 消息。', exact: true }).check()
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
    await expect(page.getByText('QQ 连接异常。请检查 OneBot 服务、地址和令牌后重新连接。', { exact: true })).toBeVisible()
    await page.getByText('诊断详情', { exact: true }).click()
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
    const originalVersion = manifest.version
    const fixtureVersion = `${originalVersion}+local`
    manifest.version = fixtureVersion
    for (const [name, before, after] of [['server.mjs', `version = "${originalVersion}"`, `version = "${fixtureVersion}"`], ['ui/index.js', `version:"${originalVersion}"`, `version:"${fixtureVersion}"`]]) {
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
    await expect(page.getByText(`v${fixtureVersion}`, { exact: true })).toBeVisible()
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
  })

  test('面板资源失败局限于插件，通用目录仍可管理', async ({ page }) => {
    await page.route('**/plugins/qq/*/ui/index.js', route => route.abort())
    await page.goto(`${url}/#robots/qq`)
    await expect(page.getByRole('alert').getByText('此插件的配置面板无法加载，请检查插件安装后重启 Eating。其他插件仍可使用。', { exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '平台分类', exact: true }).getByRole('button', { name: 'QQ', exact: true })).toBeVisible()
    await expect(page.locator('.storage-error')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '停用插件', exact: true })).toBeVisible()
  })

  test('实时日志自动到达并在浏览器内限量保留，不修改账号配置', async ({ page }) => {
    const streamRequests: string[] = []
    page.on('request', request => { if (request.url().endsWith('/logs/stream')) streamRequests.push(request.url()) })
    await configure(page); await connect(page)
    const index = JSON.parse(await readFile(join(directory, 'bot/qq-bot/accounts.json'), 'utf8')) as { defaultInstanceId: string }
    const accountDirectory = join(directory, 'bot/qq-bot/accounts', index.defaultInstanceId)
    const configPath = join(accountDirectory, 'config.json')
    const configBefore = await readFile(configPath, 'utf8')
    const event = (id: number, text: string) => ({ post_type: 'message', message_type: 'private', self_id: 123456789,
      user_id: 987654321, message_id: id, message: [{ type: 'text', data: { text } }], raw_message: text })
    onebot.emitEvent(event(40000, '没有打开日志页时的消息'))
    await expect.poll(() => host.store.listMessages('qq').length).toBe(1)
    expect(streamRequests).toHaveLength(0)
    await page.getByRole('tab', { name: '实时日志', exact: true }).click()
    await expect(page.getByText('实时接收中', { exact: true })).toBeVisible()
    const log = page.getByRole('log')
    await expect(log.getByText('没有打开日志页时的消息', { exact: true })).toHaveCount(0)
    const first = event(40001, '无需点击刷新就能看到的消息')
    onebot.emitEvent(first); onebot.emitEvent(first)
    await expect(log.getByText('无需点击刷新就能看到的消息', { exact: true })).toBeVisible()
    await expect(log.getByRole('listitem')).toHaveCount(1)
    await expect(page.getByLabel('保留条数', { exact: true })).toHaveValue('100')
    for (let start = 0; start < 110; start += 10) {
      for (let i = start; i < start + 10; i++) onebot.emitEvent(event(41000 + i, `实时日志条目 ${i}`))
      await expect(log.getByText(`实时日志条目 ${start + 9}`, { exact: true })).toBeVisible()
    }
    await expect(log.getByRole('listitem')).toHaveCount(100)
    await expect(log.getByText('实时日志条目 9', { exact: true })).toHaveCount(0)
    await page.getByLabel('保留条数', { exact: true }).selectOption('50')
    await expect(log.getByRole('listitem')).toHaveCount(50)
    await page.getByLabel('保留条数', { exact: true }).selectOption('200')
    await expect(log.getByRole('listitem')).toHaveCount(50)
    expect(await readFile(configPath, 'utf8')).toBe(configBefore)
    expect(await readdir(accountDirectory)).toEqual(['config.json'])
    expect(streamRequests).toHaveLength(1)
  })

  test('隐藏或离开日志页立即退订清空，正常QQ接收继续', async ({ page }) => {
    const streams = new Set<import('@playwright/test').Request>()
    page.on('request', request => { if (request.url().endsWith('/logs/stream')) streams.add(request) })
    page.on('requestfinished', request => streams.delete(request))
    page.on('requestfailed', request => streams.delete(request))
    await configure(page); await connect(page)
    await page.getByRole('tab', { name: '实时日志', exact: true }).click()
    await expect(page.getByText('实时接收中', { exact: true })).toBeVisible()
    const event = (id: number, text: string) => ({ post_type: 'message', message_type: 'group', self_id: 123456789,
      group_id: 123456, user_id: 987654321, message_id: id, message: text, raw_message: text })
    onebot.emitEvent(event(50000, '可见页面收到'))
    await expect(page.getByRole('log').getByText('可见页面收到', { exact: true })).toBeVisible()
    await expect.poll(() => streams.size).toBe(1)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect.poll(() => streams.size).toBe(0)
    onebot.emitEvent(event(50001, '页面隐藏时仍正常入库'))
    await expect.poll(() => host.store.listMessages('qq').length).toBe(2)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByText('实时接收中', { exact: true })).toBeVisible()
    await expect(page.getByRole('log').getByRole('listitem')).toHaveCount(0)
    onebot.emitEvent(event(50002, '重新可见后的新消息'))
    await expect(page.getByRole('log').getByText('重新可见后的新消息', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await expect.poll(() => streams.size).toBe(0)
    onebot.emitEvent(event(50003, '离开日志页仍正常入库'))
    await expect.poll(() => host.store.listMessages('qq').length).toBe(4)
    await page.getByRole('tab', { name: '实时日志', exact: true }).click()
    await expect(page.getByText('实时接收中', { exact: true })).toBeVisible()
    await expect(page.getByRole('log').getByRole('listitem')).toHaveCount(0)
    await page.close()
    await expect.poll(() => {
      const plugins = host.getWorkspace().plugins as Array<{ logViewerCount: number }>
      return plugins[0]?.logViewerCount
    }).toBe(0)
  })

  test('设置侧栏分类保留草稿，保存后参数与存储方式实际生效', async ({ page }) => {
    await page.goto(`${url}/#overview`)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('500')
    await page.getByLabel('合并等待时间', { exact: true }).fill('800')
    await page.getByLabel('最长等待时间', { exact: true }).fill('2500')
    const categories = page.getByRole('navigation', { name: '设置分类', exact: true })
    await categories.getByRole('button', { name: '队列与存储', exact: true }).click()
    await page.getByLabel('消息保存方式', { exact: true }).selectOption('memory')
    await page.getByLabel('暂存消息上限', { exact: true }).fill('500')
    await categories.getByRole('button', { name: '消息投递', exact: true }).click()
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('800')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.locator('.settings-notice-success')).toContainText('设置已保存并应用')
    expect(host.store.getDeliverySettingsSnapshot()).toMatchObject({ revision: 1, values: { quietWindowMs: 800, maxWaitMs: 2500, storageMode: 'memory', maxQueuedMessages: 500 } })
    await categories.getByRole('button', { name: '队列与存储', exact: true }).click()
    await page.reload()
    await expect(page.getByLabel('消息保存方式', { exact: true })).toHaveValue('memory')
    await expect(page.getByLabel('暂存消息上限', { exact: true })).toHaveValue('500')
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await categories.getByRole('button', { name: '消息投递', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test('设置冲突保留原草稿，明确放弃后才能读取新版本，禁止隐式覆盖', async ({ page }) => {
    let reads = 0
    page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/api/settings')) reads++ })
    await page.goto(`${url}/#settings/delivery`)
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('500')
    await page.getByLabel('合并等待时间', { exact: true }).fill('750')
    const bootstrap = await page.request.get(`${url}/api/bootstrap`)
    const { csrfToken } = await bootstrap.json() as { csrfToken: string }
    const current = host.store.getDeliverySettingsSnapshot()
    const external = await page.request.post(`${url}/api/settings`, { headers: { 'X-Eating-Csrf': csrfToken }, data: { expectedRevision: current.revision, values: { ...current.values, maxWaitMs: 5000 } } })
    expect(external.status()).toBe(200)
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.locator('.settings-notice-error')).toContainText('草稿已保留')
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('750')
    await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled()
    const before = reads
    await page.getByRole('button', { name: '重新读取设置', exact: true }).click()
    await expect(page.getByRole('button', { name: '放弃未保存修改并重新读取', exact: true })).toBeVisible()
    expect(reads).toBe(before)
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('750')
    await page.getByRole('button', { name: '重新读取设置', exact: true }).click()
    await page.getByRole('button', { name: '放弃未保存修改并重新读取', exact: true }).click()
    await expect(page.getByLabel('合并等待时间', { exact: true })).toHaveValue('500')
    await expect(page.getByLabel('最长等待时间', { exact: true })).toHaveValue('5000')
    expect(reads).toBe(before + 1)
    await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled()
  })

  test('清空队列必须明确确认，仅删除待投递正文并保留账号配置', async ({ page }) => {
    await configure(page); await connect(page)
    const index = JSON.parse(await readFile(join(directory, 'bot/qq-bot/accounts.json'), 'utf8')) as { defaultInstanceId: string }
    const configPath = join(directory, 'bot/qq-bot/accounts', index.defaultInstanceId, 'config.json')
    const before = await readFile(configPath, 'utf8')
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: 64001, message: '待投递清理测试' })
    await expect.poll(() => host.store.getDeliverySettingsSnapshot().queue.queuedMessages).toBe(1)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '队列与存储', exact: true }).click()
    await page.getByRole('button', { name: '清空队列', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认清空队列', exact: true })).toBeDisabled()
    expect(host.store.getDeliverySettingsSnapshot().queue.queuedMessages).toBe(1)
    await page.getByRole('checkbox', { name: '我已了解，确认删除这些消息内容', exact: true }).check()
    await page.getByRole('button', { name: '确认清空队列', exact: true }).click()
    await expect(page.locator('.settings-notice-success')).toContainText('队列已清空')
    expect(host.store.getDeliverySettingsSnapshot().queue).toMatchObject({ queuedMessages: 0, queuedBytes: 0, discarded: 1 })
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('窄屏功能面板与停用保留配置均可操作', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await configure(page)
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await page.getByRole('button', { name: '停用插件', exact: true }).click()
    await page.getByRole('button', { name: '确认停用', exact: true }).click()
    await expect(page.getByRole('heading', { name: '还没有通讯连接', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '添加连接', exact: true }).click()
    await page.getByRole('button', { name: '启用 QQ 插件', exact: true }).click()
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('正式 QQ 连接')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})
