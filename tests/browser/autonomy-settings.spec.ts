import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EatingHost } from '../../apps/host/src/app'
import qqEntry from '../../plugins/communication/qq/src/server'
import dshEntry from '../../plugins/harness/dsh/src/server'
import { replyOneBot, startOneBotFixture } from '../fixtures/onebot'

const root = fileURLToPath(new URL('../../', import.meta.url))
test.describe('自主运行设置与信息', () => {
  let home: string, host: EatingHost, url: string, onebot: Awaited<ReturnType<typeof startOneBotFixture>>
  let holdFriends = false
  test.beforeEach(async () => {
    holdFriends = false
    home = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'Eating_autonomy_browser_')))
    onebot = await startOneBotFixture({ onRequest: request => holdFriends && request.action === 'get_friend_list' ? true : undefined })
    host = new EatingHost({ dataDirectory: home, port: 0, entries: [qqEntry, dshEntry], staticDirectory: join(root, 'dist'), allowedUiOrigins: [] })
    url = await host.listen()
    const bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await bootstrap.json() as { csrfToken: string }
    for (const [path, body] of [['configuration', { endpoint: onebot.endpoint, timeoutMs: 1000 }], ['connect', {}]] as const) {
      const response = await fetch(url + '/api/plugins/qq/' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-CSRF': csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); expect(response.ok).toBe(true)
    }
  })
  test.afterEach(async () => {
    await host?.close(); await onebot?.close()
    const actual = await realpath(home)
    if (actual !== home || dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('Eating_autonomy_browser_')) throw new Error('Unsafe autonomy browser cleanup')
    await rm(actual, { recursive: true })
  })
  async function open(page: Page) {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(url + '/#settings/autonomy')
    await expect(page.getByRole('heading', { name: '自主运行', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '自主模式未启用', exact: true })).toBeVisible()
  }
  const plugin = () => Reflect.get(host, 'plugins').get('dsh')
  // UI state fixture only: the actual native runtime was validated separately, no model is started here.
  async function showReady(page: Page, calls: string[], failResume = false) {
    await page.route('**/api/autonomy', async route => {
      const operation = route.request().method() === 'POST' ? route.request().postDataJSON().operation : 'read'
      calls.push(operation)
      if (operation === 'resume' && failResume) { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUTONOMY_RUNTIME_NOT_READY', outcome: 'not-sent' } }) }); return }
      const response = await route.fetch(), value = await response.json()
      const ready = (snapshot: { state: { runtimeReady: boolean; reason: string; ownerPaused: boolean } }) => {
        snapshot.state.runtimeReady = true
        if (snapshot.state.reason === 'runtime-stopped') snapshot.state.reason = snapshot.state.ownerPaused ? 'owner-paused' : 'ready'
      }
      if (operation === 'read') { for (const row of value.harnesses) if (row.snapshot) ready(row.snapshot) }
      else ready(value)
      await route.fulfill({ response, json: value })
    })
  }
  const policyFile = () => join(home, 'harness/dsh/proactive-contact-policy.json')
  const contactList = (page: Page) => page.locator('.autonomy-policy-object-list')
  async function contacts(page: Page) { await open(page); await page.getByRole('tab', { name: '主动联系', exact: false }).click(); await expect(contactList(page).getByRole('checkbox', { name: /夹具联系人/ })).toBeVisible() }
  async function savePolicy(page: Page) { await page.getByRole('button', { name: '保存联系策略', exact: true }).click(); await expect(page.getByText('联系策略已保存，自主活动已暂停。', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存联系策略', exact: true })).toHaveCount(0) }
  test('私聊目录尚在读取时可立即切群聊，不因只读目录占用修改锁而报忙', async ({ page }) => {
    holdFriends = true; await open(page); await page.getByRole('tab', { name: '主动联系', exact: true }).click()
    await expect.poll(() => onebot.requests.filter(request => request.action === 'get_friend_list').length).toBeGreaterThan(0)
    await page.getByRole('tab', { name: '群聊', exact: true }).click()
    await expect(contactList(page).getByRole('checkbox', { name: /夹具测试群/ })).toBeVisible()
    holdFriends = false
    for (const request of onebot.requests.filter(request => request.action === 'get_friend_list')) replyOneBot(request.peer, request, [])
    await expect(page.locator('.autonomy-contact-policy [role="alert"]')).toHaveCount(0)
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0)
  })

  test('统一白名单同时选择私聊和群聊，保存后后台只列出名单对象且不修改原自主配置', async ({ page }) => {
    await contacts(page)
    await expect(page.getByRole('radio', { name: '白名单模式', exact: true })).toBeChecked()
    const radio = await page.getByRole('radio', { name: '白名单模式', exact: true }).boundingBox(); expect(radio!.width).toBeLessThanOrEqual(20); expect(radio!.height).toBeLessThanOrEqual(20)
    for (const mode of await page.locator('.autonomy-policy-modes label').all()) expect((await mode.boundingBox())!.height).toBeLessThanOrEqual(48)
    await expect(page.getByRole('button', { name: '添加群聊规则', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '添加主动联系对象', exact: true })).toHaveCount(0)
    await contactList(page).getByRole('checkbox', { name: /夹具联系人/ }).check()
    await page.getByRole('tab', { name: '群聊', exact: true }).click(); await contactList(page).getByRole('checkbox', { name: /夹具测试群/ }).check()
    await savePolicy(page)
    const saved = JSON.parse(await readFile(policyFile(), 'utf8')); expect(saved.mode).toBe('allowlist'); expect(saved.entries.map((entry: { agentTypeId: string }) => entry.agentTypeId).sort()).toEqual(['qq.group', 'qq.private'])
    const targets = await Reflect.get(plugin(), 'activity').listTargets(); expect(targets.map((target: { agentTypeId: string }) => target.agentTypeId).sort()).toEqual(['qq.group', 'qq.private'])
    expect(JSON.parse(await readFile(join(home, 'harness/dsh/autonomy.json'), 'utf8')).configuration.targets).toEqual([])
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0)
  })
  test('同一名单切换黑名单与全部放行，私聊群聊共同生效且不丢已选对象', async ({ page }) => {
    await contacts(page); await contactList(page).getByRole('checkbox', { name: /夹具联系人/ }).check(); await page.getByRole('tab', { name: '群聊', exact: true }).click(); await contactList(page).getByRole('checkbox', { name: /夹具测试群/ }).check()
    await page.getByRole('radio', { name: '黑名单模式', exact: true }).check(); await savePolicy(page); expect(await Reflect.get(plugin(), 'activity').listTargets()).toEqual([])
    await page.getByRole('radio', { name: '全部放行', exact: true }).check(); await expect(page.locator('.autonomy-policy-toolbar')).toBeHidden(); await savePolicy(page)
    expect((await Reflect.get(plugin(), 'activity').listTargets()).map((target: { agentTypeId: string }) => target.agentTypeId).sort()).toEqual(['qq.group', 'qq.private'])
    expect(JSON.parse(await readFile(policyFile(), 'utf8')).entries).toHaveLength(2)
    await page.getByRole('radio', { name: '白名单模式', exact: true }).check(); await expect(contactList(page).getByRole('checkbox', { name: /夹具测试群/ })).toBeChecked()
  })
  test('搜索和切分类保留选择，手动号码校验明确，语言和390px保持同一草稿', async ({ page }) => {
    await contacts(page); await contactList(page).getByRole('checkbox', { name: /夹具联系人/ }).check()
    await page.getByRole('searchbox', { name: '搜索名称或号码', exact: true }).fill('no-match'); await expect(page.getByText('没有匹配的对象。', { exact: true })).toBeVisible()
    await page.getByRole('searchbox', { name: '搜索名称或号码', exact: true }).fill(''); await expect(contactList(page).getByRole('checkbox', { name: /夹具联系人/ })).toBeChecked()
    await page.getByText('手动添加号码', { exact: true }).click(); await page.getByLabel('QQ 号码', { exact: true }).fill('not-an-id'); await page.getByRole('button', { name: '加入名单', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('请输入有效数字号码。')
    await page.getByLabel('界面语言', { exact: true }).selectOption('en-US'); await expect(page.getByRole('radio', { name: 'Allow list', exact: true })).toBeChecked(); await expect(page.getByRole('alert')).toHaveText('Enter valid numeric IDs.')
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await mkdir(join(root, '.impeccable/review/management-ui'), { recursive: true }); await page.screenshot({ path: join(root, '.impeccable/review/management-ui/unified-policy-fixture-mobile.png') })
    await expect(readFile(policyFile())).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('策略冲突保留名单，必须核对新模式后明确继续，保存仍暂停', async ({ page }) => {
    await contacts(page); await contactList(page).getByRole('checkbox', { name: /夹具联系人/ }).check()
    const current = plugin().autonomy.snapshot(); await plugin().autonomy.control('configure-contact-policy', { expectedRevision: 0, expectedConfigurationRevision: current.revision, expectedActivityRevision: current.state.revision, mode: 'all', entries: [] })
    await page.getByRole('button', { name: '刷新自主状态', exact: true }).click(); await expect(page.getByRole('button', { name: '保存联系策略', exact: true })).toBeDisabled()
    await page.getByText('查看最新已保存策略', { exact: true }).click(); await expect(page.locator('.autonomy-group-conflict')).toContainText('全部放行')
    await page.getByRole('button', { name: '已核对，保留草稿继续编辑', exact: true }).click(); await savePolicy(page)
    const saved = JSON.parse(await readFile(policyFile(), 'utf8')); expect(saved.revision).toBe(2); expect(saved.mode).toBe('allowlist'); expect(saved.entries).toHaveLength(1)
  })

  test('首次入口明确且没有禁用动作堆叠，独立保存和语言切换保留草稿', async ({ page }) => {
    const calls: string[] = []
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/autonomy') calls.push(request.method()) })
    await open(page)
    await expect(page.getByRole('button', { name: '开始设置', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '开始运行', exact: true })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: '运行 Harness', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '开始设置', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '允许自主运行', exact: false })).toBeFocused()
    const hit = await page.locator('.autonomy-enable-hit').boundingBox()
    expect(hit!.width).toBeGreaterThanOrEqual(44); expect(hit!.height).toBeGreaterThanOrEqual(44)
    await page.getByRole('checkbox', { name: '允许自主运行', exact: false }).check()
    await page.getByLabel('最短续行间隔（秒）', { exact: true }).fill('120')
    const before = calls.length
    await page.getByLabel('界面语言', { exact: true }).selectOption('en-US')
    await expect(page.getByRole('heading', { name: 'Autonomous activity', exact: true })).toBeVisible()
    expect(calls.length).toBe(before)
    await expect(page.getByLabel('Minimum continuation interval (seconds)', { exact: true })).toHaveValue('120')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Settings saved. Autonomous activity is paused; start it again when ready.', { exact: true })).toBeVisible()
    const saved = JSON.parse(await readFile(join(home, 'harness', 'dsh', 'autonomy.json'), 'utf8'))
    expect(saved.configuration).toMatchObject({ enabled: true, minIntervalSeconds: 120, targets: [] }); expect(saved.state.ownerPaused).toBe(true)
    await expect(page.getByRole('link', { name: 'Open Harness', exact: true })).toHaveAttribute('href', '#harness/dsh')
    await page.getByLabel('Minimum continuation interval (seconds)', { exact: true }).fill('130')
    await page.getByRole('tab', { name: 'Overview', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh activity status', exact: true }).click()
    await page.getByRole('tab', { name: 'Run settings', exact: true }).click()
    await expect(page.getByLabel('Minimum continuation interval (seconds)', { exact: true })).toHaveValue('130')
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0)
  })
  test('配置冲突保留草稿，明确核对最新配置后才能再次保存', async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: '运行设置', exact: true }).click()
    await page.getByLabel('最短续行间隔（秒）', { exact: true }).fill('150')
    const snapshot = plugin().autonomy.snapshot()
    await plugin().autonomy.configure({ expectedRevision: snapshot.revision, configuration: { ...snapshot.configuration, minIntervalSeconds: 200 } })
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '草稿保留' })).toBeVisible()
    await expect(page.getByLabel('最短续行间隔（秒）', { exact: true })).toHaveValue('150')
    await page.getByRole('button', { name: '刷新自主状态', exact: true }).click()
    await page.getByText('查看最新已保存配置', { exact: true }).click()
    await expect(page.locator('.autonomy-review').getByText('200', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '已核对最新配置，保留当前草稿继续编辑', exact: true }).click()
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect(page.getByText('设置已保存，自主运行已关闭。', { exact: true })).toBeVisible()
    const saved = JSON.parse(await readFile(join(home, 'harness', 'dsh', 'autonomy.json'), 'utf8')); expect(saved.configuration.minIntervalSeconds).toBe(150)
  })
  test('高级字段折叠且校验可定位，字段错误随语言更新，不发无效保存', async ({ page }) => {
    let writes = 0
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/autonomy' && request.method() === 'POST') writes++ })
    await open(page); await page.getByRole('tab', { name: '运行设置', exact: true }).click()
    await expect(page.getByLabel('单轮最长运行时间（秒）', { exact: true })).toBeHidden()
    await page.getByLabel('最短续行间隔（秒）', { exact: true }).fill('0')
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect(page.locator('.autonomy-error-summary')).toBeFocused()
    await page.locator('.autonomy-error-summary a').click()
    await expect(page.getByLabel('最短续行间隔（秒）', { exact: true })).toBeFocused()
    await expect(page.getByLabel('最短续行间隔（秒）', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await page.getByLabel('界面语言', { exact: true }).selectOption('en-US')
    await expect(page.locator('.autonomy-number-control .autonomy-field-error')).toContainText('Enter a whole number')
    expect(writes).toBe(0)
    await page.getByLabel('Minimum continuation interval (seconds)', { exact: true }).fill('90')
    await page.getByText('Advanced settings', { exact: true }).click()
    await page.getByLabel('Maximum round duration (seconds)', { exact: true }).fill('2')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.locator('.autonomy-error-summary a').click()
    await expect(page.getByLabel('Maximum round duration (seconds)', { exact: true })).toBeFocused()
    expect(writes).toBe(0)
  })
  test('保存并开始按顺序执行原有CAS与恢复，状态与按钮反映真实结果', async ({ page }) => {
    const calls: string[] = []; await showReady(page, calls); await open(page)
    await page.getByRole('button', { name: '开始设置', exact: true }).click()
    await page.getByRole('checkbox', { name: '允许自主运行', exact: false }).check()
    await page.getByRole('button', { name: '保存并开始', exact: true }).click()
    await expect(page.getByText('设置已保存，自主运行已恢复；AI 将按当前安排活动。', { exact: true })).toBeVisible()
    expect(calls.filter(call => call !== 'read')).toEqual(['configure', 'resume'])
    await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '暂停运行', exact: true }).click()
    await expect(page.getByRole('heading', { name: '主人已暂停', exact: true })).toBeVisible()
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toHaveLength(0)
  })
  test('组合保存第二步失败时如实显示已保存未开始，先核对再操作', async ({ page }) => {
    const calls: string[] = []; await showReady(page, calls, true); await open(page)
    await page.getByRole('button', { name: '开始设置', exact: true }).click()
    await page.getByRole('checkbox', { name: '允许自主运行', exact: false }).check()
    await page.getByRole('button', { name: '保存并开始', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '设置已保存，但尚未成功恢复自主运行' })).toBeVisible()
    const saved = JSON.parse(await readFile(join(home, 'harness', 'dsh', 'autonomy.json'), 'utf8'))
    expect(saved.configuration.enabled).toBe(true); expect(saved.state.ownerPaused).toBe(true)
    expect(calls.filter(call => call !== 'read')).toEqual(['configure', 'resume'])
    await expect(page.getByRole('button', { name: '开始运行', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '刷新并核对结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '开始运行', exact: true })).toBeEnabled()
  })
  test('375px与短横屏中焦点不被吸顶页签或保存栏遮挡，跨页签可直接保存', async ({ page }) => {
    await open(page); await page.getByRole('tab', { name: '运行设置', exact: true }).click()
    await page.getByLabel('最短续行间隔（秒）', { exact: true }).fill('80')
    await page.getByText('高级设置', { exact: true }).click()
    for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 420 }]) {
      await page.setViewportSize(viewport)
      const field = page.getByLabel('每小时最多主动联系任务', { exact: true })
      await field.focus()
      await expect(field).toBeFocused()
      await expect.poll(async () => { const input = await field.boundingBox(), rail = await page.locator('.autonomy-tabs').boundingBox(), save = await page.locator('.autonomy-save').boundingBox(); return Boolean(input && rail && save && input.y >= rail.y + rail.height - 1 && input.y + input.height <= save.y + 1 && save.y >= 0 && save.y + save.height <= viewport.height + 1) }).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.getByRole('tab', { name: '概览', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '运行设置', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: '主动联系', exact: true })).toBeFocused()
    await expect(page.getByRole('tab', { name: '主动联系', exact: true })).toHaveAttribute('aria-selected', 'true')
  })

})
