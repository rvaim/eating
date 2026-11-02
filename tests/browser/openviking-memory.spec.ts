import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import type { EatingHost } from '../../apps/host/src/app'
import { DEFAULT_SETTINGS } from '../../plugins/capabilities/openviking-memory/src/types'
import type { MemoryConfiguration, MemoryConfigurationInput, RuntimeSnapshot } from '../../plugins/capabilities/openviking-memory/src/types'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = fileURLToPath(new URL('../../plugins/capabilities/openviking-memory/dist/', import.meta.url))
const fixtureKey = 'openviking-browser-test-key'
const firstUri = 'viking://user/owner/memories/preferences/first.md'
const secondUri = 'viking://user/owner/memories/preferences/second.md'
interface ManageCall { operation: string; input: Record<string, unknown> }
interface Fixture {
  config: MemoryConfiguration; snapshot: RuntimeSnapshot; reads: number; writes: MemoryConfigurationInput[]; calls: ManageCall[]; connectCalls: number
  connectError: string | null; saveError: string | null; readHandler: ((route: Route, uri: string) => Promise<void>) | null
  searchHandler: ((route: Route, query: string) => Promise<void>) | null
  retryHandler: ((route: Route, jobId: string) => Promise<void>) | null
}
const initialConfiguration = (): MemoryConfiguration => ({ schemaVersion: 2, revision: 0, endpoint: '', account: '', user: '', apiKeyConfigured: false,
  autoConnect: false, timeoutMs: 15000, ready: false, settings: structuredClone(DEFAULT_SETTINGS) })
const initialSnapshot = (): RuntimeSnapshot => ({ ready: false, lastErrorCode: null, lastRecallAt: null, lastCaptureAt: null,
  todayExtractions: 0, pending: 0, jobs: [], scopes: [] })
async function hide(page: Page, hidden: boolean) {
  await page.evaluate(hidden => { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new Event('visibilitychange')) }, hidden)
}

// The real Host loads the installed plugin bundle. Only OpenViking-facing configuration and manage responses are fixtures.
test.describe('OpenViking memory installed panel', () => {
  test.setTimeout(120_000)
  let directory: string, host: EatingHost, url: string, fixture: Fixture, pageErrors: string[]
  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_openviking_memory_')))
    await installPluginPackage(directory, pluginDirectory)
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
    url = await host.listen(); pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const bootstrap = await page.request.get(url + '/api/bootstrap')
    expect(bootstrap.status()).toBe(200)
    const csrf = (await bootstrap.json() as { csrfToken: string }).csrfToken
    const workspace = await (await page.request.get(url + '/api/workspace')).json() as { plugins: { id: string; enabled: boolean }[] }
    if (!workspace.plugins.find(plugin => plugin.id === 'openviking-memory')?.enabled) {
      expect((await page.request.post(url + '/api/plugins/openviking-memory/enable', { headers: { 'X-Eating-Csrf': csrf }, data: {} })).status()).toBe(200)
    }
    fixture = { config: initialConfiguration(), snapshot: initialSnapshot(), reads: 0, writes: [], calls: [], connectCalls: 0,
      connectError: null, saveError: null, readHandler: null, searchHandler: null, retryHandler: null }
    await page.route('**/api/plugins/openviking-memory/configuration', async route => {
      if (route.request().method() === 'GET') { fixture.reads++; await route.fulfill({ json: fixture.config }); return }
      const input = route.request().postDataJSON() as MemoryConfigurationInput; fixture.writes.push(input)
      if (fixture.saveError || input.expectedRevision !== fixture.config.revision) {
        await route.fulfill({ status: 409, json: { error: { code: fixture.saveError ?? 'MEMORY_CONFIGURATION_CONFLICT', message: 'RAW_SERVER_MESSAGE', outcome: 'not-sent' } } }); return
      }
      fixture.config = { ...fixture.config, revision: fixture.config.revision + 1, endpoint: input.endpoint, account: input.account, user: input.user,
        timeoutMs: input.timeoutMs, autoConnect: input.autoConnect, settings: input.settings, ready: false,
        apiKeyConfigured: input.clearApiKey ? false : Boolean(input.apiKey) || fixture.config.apiKeyConfigured }
      await route.fulfill({ json: fixture.config })
    })
    await page.route('**/api/plugins/openviking-memory/connect', async route => {
      fixture.connectCalls++
      if (fixture.connectError) { await route.fulfill({ status: 400, json: { error: { code: fixture.connectError, message: 'RAW_SERVER_KEY_DO_NOT_RENDER', outcome: 'failed' } } }); return }
      fixture.config.ready = true; fixture.snapshot.ready = true; await route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/plugins/openviking-memory/manage', async route => {
      const call = route.request().postDataJSON() as ManageCall; fixture.calls.push(call)
      if (call.operation === 'snapshot' || call.operation === 'flush') { await route.fulfill({ json: fixture.snapshot }); return }
      if (call.operation === 'test-connection') { await route.fulfill({ json: { ok: true } }); return }
      if (call.operation === 'retry' && fixture.retryHandler) { await fixture.retryHandler(route, String(call.input.jobId)); return }
      if (call.operation === 'search') {
        if (fixture.searchHandler) { await fixture.searchHandler(route, String(call.input.query)); return }
        await route.fulfill({ json: { items: [{ uri: firstUri, text: 'First result excerpt', score: 0.91 }, { uri: secondUri, text: 'Second result excerpt', score: 0.8 }] } }); return
      }
      if (call.operation === 'read') {
        if (fixture.readHandler) { await fixture.readHandler(route, String(call.input.uri)); return }
        await route.fulfill({ json: { uri: call.input.uri, text: 'Private memory detail from the fixture' } }); return
      }
      if (call.operation === 'delete') { await route.fulfill({ json: { deleted: true } }); return }
      await route.fulfill({ status: 400, json: { error: { code: 'MEMORY_INVALID_INPUT', message: 'unhandled fixture operation' } } })
    })
  })
  test.afterEach(async () => {
    await host?.close()
    if (directory) {
      const target = await realpath(directory)
      if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_openviking_memory_')) throw new Error('Unsafe OpenViking browser fixture cleanup')
      await rm(target, { recursive: true })
    }
    expect(pageErrors).toEqual([])
  })
  async function open(page: Page) {
    await page.goto(url + '/#plugins/openviking-memory')
    await expect(page.locator('.ov-panel').getByLabel('服务地址', { exact: true })).toBeVisible({ timeout: 20_000 })
  }
  async function configure(page: Page, connect = false) {
    const panel = page.locator('.ov-panel')
    await panel.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:1933')
    await panel.getByLabel('OpenViking 用户 ID', { exact: true }).fill('owner')
    await panel.getByLabel('API Key', { exact: true }).fill(fixtureKey)
    await panel.getByRole('button', { name: connect ? '保存并连接' : '保存配置', exact: true }).click()
    await expect(panel.getByText(connect ? '配置已保存，连接检查通过。' : '配置已保存；未提取记忆。', { exact: true })).toBeVisible()
    if (await page.locator('.toast button').isVisible()) await page.locator('.toast button').click()
  }
  async function activity(page: Page) {
    await page.getByRole('tab', { name: '活动', exact: true }).click()
    await expect(page.locator('.ov-runtime')).toBeVisible()
  }
  async function browse(page: Page) {
    await activity(page)
    await page.locator('.ov-panel summary').filter({ hasText: '查找与管理记忆' }).click()
    await page.getByLabel('搜索记忆', { exact: true }).fill('preferences')
    await page.locator('.ov-memory-search').getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.ov-memory-results li')).toHaveCount(2)
  }

  test('saves v2 without extraction, requires the paired extension, keeps blank keys, and reports partial connection success', async ({ page }) => {
    await open(page)
    await expect(page.locator('.ov-panel')).toContainText('本版需要第 2 版配置。旧配置不会自动转换或覆盖')
    await expect(page.locator('.ov-panel').getByRole('button', { name: '连接', exact: true })).toBeDisabled()
    await configure(page)
    expect(fixture.calls).toHaveLength(0); expect(fixture.connectCalls).toBe(0)
    expect(fixture.writes[0]).toMatchObject({ expectedRevision: 0, endpoint: 'http://127.0.0.1:1933', user: 'owner', apiKey: fixtureKey,
      settings: { enabled: true, globalMemory: true, ownerCrossSession: true, privateCapture: true, groupCapture: false, archiveMaxMiB: 8, recallLimit: 6 } })
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    expect(Object.keys(fixture.writes[0]!.settings)).toEqual(Object.keys(DEFAULT_SETTINGS))
    await page.getByRole('button', { name: '测试已保存连接', exact: true }).click()
    await expect(page.getByText('服务、认证及增量扩展检查通过；未进行模型提取测试。', { exact: true })).toBeVisible()
    await activity(page)
    await expect(page.locator('.ov-runtime')).toContainText('未连接')
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    fixture.connectError = 'MEMORY_INCREMENTAL_UNSUPPORTED'
    await page.locator('.ov-panel').getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.locator('.ov-notice').getByText('服务缺少所需的增量提取能力。请安装与本插件配套的 OpenViking 增量扩展（能力版本 1），再重新连接；仅健康检查通过不能启用记忆。', { exact: true })).toBeVisible()
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.locator('.ov-notice')).toContainText('Install the paired OpenViking incremental extension')
    await page.locator('#display-language').selectOption('zh-CN')
    await page.locator('.ov-panel').getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:1934')
    await expect(page.locator('.ov-panel').getByRole('button', { name: '连接', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '测试已保存连接', exact: true })).toBeDisabled()
    fixture.connectError = 'MEMORY_HTTP_401'
    await page.locator('.ov-panel').getByRole('button', { name: '保存并连接', exact: true }).click()
    await expect(page.getByText('配置已保存，但连接检查未完成。可根据下方原因重新连接。', { exact: true })).toBeVisible()
    await expect(page.locator('.ov-notice').getByText('OpenViking 拒绝了认证，请检查已保存的用户、账号和 API Key。', { exact: true })).toBeVisible()
    expect(fixture.writes[1]).not.toHaveProperty('apiKey'); expect(fixture.connectCalls).toBe(2)
    expect(await page.locator('.ov-panel').innerText()).not.toContain('RAW_SERVER_KEY')
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByText('OpenViking rejected authentication. Check the saved user, account and API Key.', { exact: true })).toBeVisible()
    fixture.connectError = null
    await page.locator('.ov-panel').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByText('Connection check completed.', { exact: true })).toBeVisible()
    await page.getByLabel('Clear the saved API Key on save', { exact: true }).check()
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    expect(fixture.writes.at(-1)).toMatchObject({ clearApiKey: true }); expect(fixture.writes.at(-1)).not.toHaveProperty('apiKey')
  })

  test('preserves scope drafts, inline editor, remove/undo and locale without configuration requests', async ({ page }) => {
    await open(page); await configure(page)
    await page.getByRole('tab', { name: '范围', exact: true }).click()
    await expect(page.getByLabel('群聊 提取', { exact: true })).not.toBeChecked()
    await page.getByRole('button', { name: '添加群聊', exact: true }).click()
    await expect(page.getByLabel('规则名称', { exact: true })).toBeFocused()
    await page.getByLabel('规则名称', { exact: true }).fill('Friends group')
    await page.getByLabel('会话账号 ID', { exact: true }).fill('10001')
    await page.getByLabel('目标 ID', { exact: true }).fill('20002')
    await page.getByLabel('群成员范围', { exact: true }).selectOption('allowlist')
    await page.getByLabel('成员 ID（每行一个）', { exact: true }).fill('30003\n40004')
    await expect(page.locator('.ov-rule-editor output')).toHaveText('viking://user/owner/peers/qq-10001-group-20002/memories')
    const reads = fixture.reads, writes = fixture.writes.length, calls = fixture.calls.length
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    await page.locator('#display-language').selectOption('en-US')
    await page.getByRole('tab', { name: 'Ranges', exact: true }).click()
    await expect(page.getByLabel('Rule name', { exact: true })).toHaveValue('Friends group')
    await expect(page.getByLabel('Member IDs (one per line)', { exact: true })).toHaveValue('30003\n40004')
    expect(fixture.reads).toBe(reads); expect(fixture.writes.length).toBe(writes); expect(fixture.calls.length).toBe(calls)
    await page.getByRole('button', { name: 'Remove rule: Friends group', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Undo removal', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Undo removal', exact: true }).click()
    await expect(page.getByLabel('Rule name', { exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(page.locator('.ov-save-state').getByText('Configuration saved. No memory was extracted.', { exact: true })).toBeVisible()
    expect(fixture.writes.at(-1)!.settings.rules[0]).toMatchObject({ label: 'Friends group', platform: 'qq', accountId: '10001', kind: 'group', targetId: '20002', capture: false, recall: true, memberMode: 'allowlist', memberIds: ['30003', '40004'] })
    await expect(page.locator('.ov-save-state')).toBeFocused()
  })

  test('focuses linked errors, retains CAS revision on conflicts, and requires explicit discard/reload', async ({ page }) => {
    await open(page); await configure(page)
    await page.getByRole('tab', { name: '范围', exact: true }).click()
    await page.getByRole('button', { name: '添加群聊', exact: true }).click()
    await page.getByLabel('会话账号 ID', { exact: true }).fill('10001')
    await page.getByLabel('目标 ID', { exact: true }).fill('20002')
    await page.getByLabel('群成员范围', { exact: true }).selectOption('denylist')
    await page.getByLabel('成员 ID（每行一个）', { exact: true }).fill('30003\n30003')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('.ov-validation')).toBeFocused()
    expect(fixture.writes).toHaveLength(1)
    await page.locator('.ov-validation').getByRole('button').first().click()
    await expect(page.getByLabel('成员 ID（每行一个）', { exact: true })).toBeFocused()
    await page.getByLabel('成员 ID（每行一个）', { exact: true }).fill('30003')
    fixture.config.revision = 4; fixture.config.user = 'external_owner'
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('.ov-panel > .ov-notice').first()).toBeFocused()
    expect(fixture.writes.at(-1)!.expectedRevision).toBe(1)
    await hide(page, true); await hide(page, false)
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    await expect(page.getByLabel('OpenViking 用户 ID', { exact: true })).toHaveValue('owner')
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled()
    await page.locator('.ov-save-rail').getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.getByText('放弃未保存的更改？', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '保留草稿', exact: true }).click()
    await expect(page.getByLabel('OpenViking 用户 ID', { exact: true })).toHaveValue('owner')
    await page.locator('.ov-save-rail').getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('button', { name: '放弃并重读', exact: true }).click()
    await expect(page.getByLabel('OpenViking 用户 ID', { exact: true })).toHaveValue('external_owner')
    await page.getByLabel('OpenViking 用户 ID', { exact: true }).fill('next_owner')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    expect(fixture.writes.at(-1)!.expectedRevision).toBe(4)
  })

  test('polls only visible Activity, clears secrets and memory content while retaining non-secret drafts', async ({ page }) => {
    await open(page); await configure(page, true)
    await page.clock.install()
    await page.clock.fastForward(10_000)
    expect(fixture.calls.filter(call => call.operation === 'snapshot')).toHaveLength(0)
    await browse(page)
    await page.locator('.ov-memory-result').first().click()
    await expect(page.locator('.ov-memory-detail pre')).toHaveText('Private memory detail from the fixture')
    const before = fixture.calls.filter(call => call.operation === 'snapshot').length
    await page.clock.fastForward(5000)
    await expect.poll(() => fixture.calls.filter(call => call.operation === 'snapshot').length).toBe(before + 1)
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    await page.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:1999')
    await page.getByLabel('API Key', { exact: true }).fill('unsaved-key-clear-on-hide')
    await page.clock.fastForward(10_000)
    expect(fixture.calls.filter(call => call.operation === 'snapshot')).toHaveLength(before + 1)
    await hide(page, true)
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(page.locator('.ov-memory-detail')).toHaveCount(0)
    await page.clock.fastForward(10_000)
    expect(fixture.calls.filter(call => call.operation === 'snapshot')).toHaveLength(before + 1)
    await hide(page, false)
    await expect(page.getByLabel('服务地址', { exact: true })).toHaveValue('http://127.0.0.1:1999')
    expect(fixture.writes).toHaveLength(1)
  })

  test('reveals invalid archive volume in advanced settings and preserves the cross-tab draft until corrected', async ({ page }, info) => {
    await open(page); await configure(page)
    await page.getByRole('tab', { name: '范围', exact: true }).click()
    await expect(page.getByRole('heading', { name: '实时记录与历史分段', exact: true })).toBeVisible()
    await expect(page.getByLabel('历史分段体积（MiB）', { exact: true })).toBeHidden()
    await page.locator('.ov-panel summary').filter({ hasText: '高级处理设置' }).click()
    await page.getByLabel('历史分段体积（MiB）', { exact: true }).fill('65')
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('.ov-validation')).toBeFocused()
    expect(fixture.writes).toHaveLength(1)
    await page.locator('.ov-validation').getByRole('button').first().click()
    await expect(page.getByLabel('历史分段体积（MiB）', { exact: true })).toBeFocused()
    await expect(page.getByLabel('历史分段体积（MiB）', { exact: true })).toHaveValue('65')
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.locator('#display-language').selectOption('en-US')
    const input = page.getByLabel('History segment size (MiB)', { exact: true })
    await input.focus()
    await expect.poll(async () => {
      const field = await input.boundingBox(), rail = await page.locator('.ov-save-rail').boundingBox(), tabs = await page.locator('.ov-tabs').boundingBox()
      return Boolean(field && rail && tabs && field.y >= tabs.y + tabs.height + 8 && field.y + field.height <= rail.y - 8)
    }).toBe(true)
    await page.screenshot({ path: info.outputPath('openviking-archive-volume-focus-390-dark-en.png'), fullPage: false, animations: 'disabled' })
    await input.fill('9')
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(page.locator('.ov-save-state').getByText('Configuration saved. No memory was extracted.', { exact: true })).toBeVisible()
    expect(fixture.writes.at(-1)!.settings).toMatchObject({ archiveMaxMiB: 9 })
    expect(Object.keys(fixture.writes.at(-1)!.settings)).toEqual(Object.keys(DEFAULT_SETTINGS))
  })

  test('keeps clean Activity clear and preserves dirty cross-tab actions through locale changes', async ({ page }, info) => {
    await open(page); await configure(page, true)
    await page.clock.install()
    await activity(page)
    await expect(page.locator('.ov-save-rail')).toBeHidden()
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('openviking-clean-activity-390-dark.png'), fullPage: false, animations: 'disabled' })
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    await page.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:1999')
    await activity(page)
    await expect(page.locator('.ov-save-rail')).toBeVisible()
    await expect(page.locator('.ov-save-rail').getByRole('button', { name: '保存配置', exact: true })).toBeEnabled()
    await expect(page.locator('.ov-save-rail').getByRole('button', { name: '放弃草稿', exact: true })).toBeEnabled()
    const reads = fixture.reads, writes = fixture.writes.length, calls = fixture.calls.length
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.locator('.ov-save-rail')).toContainText('Unsaved changes')
    expect(fixture.reads).toBe(reads); expect(fixture.writes.length).toBe(writes); expect(fixture.calls.length).toBe(calls)
    await page.getByRole('tab', { name: 'Connection', exact: true }).click()
    await expect(page.getByLabel('Endpoint', { exact: true })).toHaveValue('http://127.0.0.1:1999')
    await page.getByRole('tab', { name: 'Activity', exact: true }).click()
    await page.locator('.ov-save-rail').getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(page.locator('.ov-save-rail')).toBeHidden()
    await expect(page.getByRole('tabpanel', { name: 'Activity', exact: true })).toBeFocused()
    expect(fixture.writes.at(-1)!.endpoint).toBe('http://127.0.0.1:1999')
  })

  test('ignores stale search/read responses and confirms deletion at an exact URI', async ({ page }) => {
    await open(page); await configure(page, true); await browse(page)
    let releaseFirst: (() => void) | undefined
    const held = new Promise<void>(resolve => { releaseFirst = resolve })
    fixture.readHandler = async (route, uri) => { if (uri === firstUri) await held; await route.fulfill({ json: { uri, text: uri === firstUri ? 'STALE FIRST MEMORY' : 'Current second memory' } }).catch(() => {}) }
    await page.locator('.ov-memory-result').first().click()
    await expect.poll(() => fixture.calls.filter(call => call.operation === 'read').length).toBe(1)
    await page.locator('.ov-memory-result').nth(1).click()
    await expect(page.locator('.ov-memory-detail pre')).toHaveText('Current second memory')
    releaseFirst!()
    await expect(page.locator('.ov-memory-detail pre')).toHaveText('Current second memory')
    await page.getByRole('button', { name: '删除这条记忆', exact: true }).click()
    await expect(page.getByRole('group', { name: '删除以下 URI 的记忆？', exact: true }).getByText(secondUri, { exact: true })).toBeVisible()
    expect(fixture.calls.filter(call => call.operation === 'delete')).toHaveLength(0)
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByText('该 URI 的记忆已删除。', { exact: true })).toBeVisible()
    expect(fixture.calls.find(call => call.operation === 'delete')!.input).toEqual({ uri: secondUri, confirmed: true })
    let releaseSearch: (() => void) | undefined
    const heldSearch = new Promise<void>(resolve => { releaseSearch = resolve })
    fixture.searchHandler = async (route, query) => { if (query === 'old') await heldSearch; await route.fulfill({ json: { items: [{ uri: secondUri, text: query === 'old' ? 'STALE SEARCH' : 'Latest search', score: 0.9 }] } }).catch(() => {}) }
    await page.getByLabel('搜索记忆', { exact: true }).fill('old')
    await page.locator('.ov-memory-search').getByRole('button', { name: '搜索', exact: true }).click()
    await expect.poll(() => fixture.calls.filter(call => call.operation === 'search').length).toBe(2)
    await page.getByLabel('搜索记忆', { exact: true }).fill('new')
    await page.locator('.ov-memory-search').getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.ov-memory-result')).toContainText('Latest search')
    releaseSearch!()
    await expect(page.locator('.ov-memory-result')).toContainText('Latest search')
    expect(await page.locator('.ov-panel').innerText()).not.toContain('STALE')
  })

  test('keyboard tabs, inline errors, dark theme and 390px form remain usable', async ({ page }, info) => {
    await open(page)
    const connectionTab = page.getByRole('tab', { name: '连接', exact: true })
    await connectionTab.focus(); await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: '范围', exact: true })).toBeFocused()
    await expect(page.getByRole('tab', { name: '范围', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('End'); await expect(page.getByRole('tab', { name: '活动', exact: true })).toBeFocused()
    await page.keyboard.press('Home'); await expect(connectionTab).toBeFocused()
    await page.getByLabel('服务地址', { exact: true }).fill('bad endpoint')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('.ov-validation')).toBeFocused()
    await page.locator('.ov-validation').getByRole('button').first().click()
    await expect(page.getByLabel('服务地址', { exact: true })).toBeFocused()
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('openviking-390-dark-errors.png'), fullPage: false, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
    const targets = await page.locator('.ov-panel').locator('button:visible').evaluateAll(buttons => buttons.map(button => ({ text: button.textContent, height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })))
    expect(targets.filter(target => target.height < 44 || target.width < 44)).toEqual([])
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' })
    await page.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:1933'); await page.getByLabel('OpenViking 用户 ID', { exact: true }).fill('owner')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('.ov-save-state').getByText('配置已保存；未提取记忆。', { exact: true })).toBeVisible()
    if (await page.locator('.toast button').isVisible()) await page.locator('.toast button').click()
    await page.locator('#display-language').selectOption('en-US')
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.mouse.move(0, 0); await page.keyboard.press('Escape')
    await page.screenshot({ path: info.outputPath('openviking-desktop-en.png'), fullPage: false, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: info.outputPath('openviking-desktop-dark-en.png'), fullPage: false, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('tab', { name: 'Ranges', exact: true }).click()
    await page.getByRole('button', { name: 'Add group', exact: true }).click()
    await page.getByLabel('Conversation account ID', { exact: true }).fill('10001'); await page.getByLabel('Target ID', { exact: true }).fill('20002')
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('openviking-ranges-en.png'), fullPage: false, animations: 'disabled' })
    await page.locator('.ov-rule-editor').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('openviking-rule-editor-en.png'), fullPage: false, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 560 })
    await page.getByLabel('Conversation account ID', { exact: true }).focus(); await page.keyboard.press('Tab')
    await expect(page.getByLabel('Target ID', { exact: true })).toBeFocused()
    await page.screenshot({ path: info.outputPath('openviking-short-window.png'), fullPage: false, animations: 'disabled' })
    await expect(page.getByRole('tab', { name: 'Ranges', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeVisible()
  })

  test('keeps the entire newly focused group name above the wrapped English save rail at 390px', async ({ page }, info) => {
    await open(page); await configure(page)
    await page.locator('#display-language').selectOption('en-US')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'Ranges', exact: true }).click()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.getByRole('button', { name: 'Add group', exact: true }).click()
      const input = page.getByLabel('Rule name', { exact: true })
      await expect(input).toBeFocused()
      await expect.poll(async () => {
        const field = await input.boundingBox(), rail = await page.locator('.ov-save-rail').boundingBox(), tabs = await page.locator('.ov-tabs').boundingBox()
        return Boolean(field && rail && tabs && field.y >= tabs.y + tabs.height + 8 && field.y + field.height <= rail.y - 8)
      }).toBe(true)
      expect(await page.evaluate(() => ({ y: window.scrollY, htmlTop: document.documentElement.getBoundingClientRect().top,
        htmlBottom: document.documentElement.getBoundingClientRect().bottom, bodyTop: document.body.getBoundingClientRect().top,
        bodyBottom: document.body.getBoundingClientRect().bottom, viewport: innerHeight }))).toEqual({ y: 0, htmlTop: 0, htmlBottom: 844, bodyTop: 0, bodyBottom: 844, viewport: 844 })
      await expect(page.getByRole('banner')).toBeInViewport()
      const measured = await page.locator('.ov-panel').evaluate(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--ov-save-rail-height')))
      const rail = await page.locator('.ov-save-rail').boundingBox()
      expect(Math.abs(measured - rail!.height)).toBeLessThan(1)
      await page.screenshot({ path: info.outputPath(`openviking-rule-focus-390-${colorScheme}.png`), fullPage: false, animations: 'disabled' })
    }
  })

  test('keeps the full member-ID textarea clear of sticky controls during keyboard Tab', async ({ page }, info) => {
    await open(page); await configure(page)
    await page.locator('#display-language').selectOption('en-US')
    await page.getByRole('tab', { name: 'Ranges', exact: true }).click()
    await page.getByRole('button', { name: 'Add group', exact: true }).click()
    await page.getByLabel('Conversation account ID', { exact: true }).fill('10001')
    await page.getByLabel('Target ID', { exact: true }).fill('20002')
    const mode = page.getByLabel('Group member range', { exact: true }), members = page.getByLabel('Member IDs (one per line)', { exact: true })
    await mode.selectOption('allowlist')
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 560 }]) {
      await page.setViewportSize(viewport)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await mode.focus(); await page.keyboard.press('Tab')
        await expect(members).toBeFocused()
        await expect.poll(async () => {
          const field = await members.boundingBox(), rail = await page.locator('.ov-save-rail').boundingBox(), tabs = await page.locator('.ov-tabs').boundingBox()
          return Boolean(field && rail && tabs && field.y >= tabs.y + tabs.height + 8 && field.y + field.height <= rail.y - 8)
        }).toBe(true)
        const pageBounds = await page.evaluate(() => ({ y: window.scrollY, htmlTop: document.documentElement.getBoundingClientRect().top,
          htmlBottom: document.documentElement.getBoundingClientRect().bottom, bodyTop: document.body.getBoundingClientRect().top,
          bodyBottom: document.body.getBoundingClientRect().bottom }))
        expect(pageBounds).toEqual({ y: 0, htmlTop: 0, htmlBottom: viewport.height, bodyTop: 0, bodyBottom: viewport.height })
        await page.screenshot({ path: info.outputPath(`openviking-member-focus-${viewport.width}-${colorScheme}.png`), fullPage: false, animations: 'disabled' })
      }
    }
  })

  test('keeps memory range selection text readable in the narrow search form', async ({ page }, info) => {
    await open(page); await configure(page, true)
    await page.locator('#display-language').selectOption('en-US')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'Activity', exact: true }).click()
    await expect(page.locator('.ov-runtime')).toBeVisible()
    await page.locator('.ov-panel summary').filter({ hasText: 'Find and manage memory' }).click()
    const range = page.locator('.ov-memory-search').getByLabel('Action range', { exact: true })
    await expect(range).toHaveValue('all')
    await range.scrollIntoViewIfNeeded()
    const metrics = await range.evaluate(element => {
      const select = element as HTMLSelectElement, style = getComputedStyle(select), canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')!
      context.font = `${style.fontSize} ${style.fontFamily}`
      return { available: select.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - 32,
        text: context.measureText(select.selectedOptions[0]!.text).width, width: select.getBoundingClientRect().width }
    })
    expect(metrics.available).toBeGreaterThanOrEqual(metrics.text)
    expect(metrics.width).toBeGreaterThan(200)
    await expect(page.locator('.ov-save-rail')).toBeHidden()
    await expect.poll(() => page.locator('.ov-panel').evaluate(element => getComputedStyle(element).getPropertyValue('--ov-save-rail-height'))).toBe('0px')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.screenshot({ path: info.outputPath(`openviking-memory-search-390-${colorScheme}.png`), fullPage: false, animations: 'disabled' })
    }
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('retries only a failed extraction with the same job and refreshes processing through completion without an archive', async ({ page }, info) => {
    const timestamp = '2026-11-02T05:32:00Z', jobId = 'failed-incremental-job'
    fixture.snapshot.jobs = [{ id: jobId, peerId: 'self', sessionId: 'fixed-self-session', taskId: null, archiveUri: null,
      status: 'failed', createdAt: timestamp, updatedAt: timestamp, messages: 2, changes: null, errorCode: 'MEMORY_NETWORK_ERROR' },
    { id: 'unknown-incremental-job', peerId: 'qq-10001-private-20002', sessionId: 'fixed-private-session', taskId: null, archiveUri: null,
      status: 'unknown', createdAt: timestamp, updatedAt: timestamp, messages: 2, changes: null, errorCode: 'MEMORY_SUBMISSION_UNKNOWN' }]
    let releaseRetry: (() => void) | undefined
    const heldRetry = new Promise<void>(resolve => { releaseRetry = resolve })
    fixture.retryHandler = async (route, retriedJobId) => {
      expect(retriedJobId).toBe(jobId)
      await heldRetry
      fixture.snapshot.jobs[0]!.status = 'processing'; fixture.snapshot.jobs[0]!.errorCode = null; fixture.snapshot.pending = 1
      await route.fulfill({ json: { ok: true } })
    }
    await open(page); await configure(page, true)
    await page.clock.install()
    fixture.snapshot.ready = false
    await activity(page)
    const failed = page.locator('.ov-jobs > li').first(), unknown = page.locator('.ov-jobs > li').nth(1)
    await expect(failed.getByRole('button', { name: '重试提取', exact: true })).toBeDisabled()
    await expect(unknown.getByRole('button', { name: '重试提取', exact: true })).toHaveCount(0)
    fixture.snapshot.ready = true
    await page.getByRole('button', { name: '刷新活动', exact: true }).click()
    await expect(failed.getByRole('button', { name: '重试提取', exact: true })).toBeEnabled()
    const callsBeforeLocale = fixture.calls.length
    await page.locator('#display-language').selectOption('en-US')
    const retry = failed.getByRole('button', { name: 'Retry extraction', exact: true })
    await expect(retry).toBeEnabled()
    expect(fixture.calls).toHaveLength(callsBeforeLocale)
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await retry.scrollIntoViewIfNeeded()
    const target = await retry.boundingBox()
    expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: info.outputPath('openviking-retry-failed-390-dark-en.png'), fullPage: false, animations: 'disabled' })
    const snapshotsBeforeRetry = fixture.calls.filter(call => call.operation === 'snapshot').length
    await retry.click()
    await expect.poll(() => fixture.calls.filter(call => call.operation === 'retry').length).toBe(1)
    await expect(retry).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Submit buffered content', exact: true })).toBeDisabled()
    releaseRetry!()
    await expect(failed).toContainText('Extracting')
    await expect(failed.getByRole('button', { name: 'Retry extraction', exact: true })).toHaveCount(0)
    expect(fixture.calls.filter(call => call.operation === 'retry')).toEqual([{ operation: 'retry', input: { jobId } }])
    expect(fixture.calls.filter(call => call.operation === 'snapshot').length).toBeGreaterThan(snapshotsBeforeRetry)
    expect(fixture.snapshot.jobs[0]).toMatchObject({ id: jobId, sessionId: 'fixed-self-session', messages: 2, archiveUri: null })
    fixture.snapshot.jobs[0]!.status = 'completed'; fixture.snapshot.jobs[0]!.changes = { added: 0, updated: 0, deleted: 0 }; fixture.snapshot.pending = 0
    await page.clock.fastForward(5000)
    await expect(failed).toContainText('Completed')
    await expect(failed).toContainText('This incremental extraction created no history segment.')
    await failed.locator('summary').click()
    await expect(failed.getByText('fixed-self-session', { exact: true })).toBeVisible()
    await expect(failed.getByText('History segment URI', { exact: true })).toHaveCount(0)
    await expect(page.locator('.ov-jobs').getByRole('button', { name: 'Retry extraction', exact: true })).toHaveCount(0)
    expect(fixture.calls.filter(call => call.operation === 'retry')).toHaveLength(1)
    await failed.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('openviking-retry-completed-no-archive-390-dark-en.png'), fullPage: false, animations: 'disabled' })
  })

  test('renders runtime metadata without a daily limit and explicitly submits a selected peer', async ({ page }, info) => {
    const peerId = 'qq-10001-group-20002', timestamp = '2026-11-01T15:00:00Z'
    fixture.snapshot = { ready: false, lastErrorCode: null, lastRecallAt: timestamp, lastCaptureAt: timestamp, todayExtractions: 3, pending: 1,
      scopes: [{ peerId, label: 'Friends group', scope: { platform: 'qq', accountId: '10001', kind: 'group', targetId: '20002', owner: false }, capture: true, recall: true, bufferedMessages: 8, lastSeenAt: timestamp }],
      jobs: [{ id: 'fixture-job-1', peerId, sessionId: 'fixture-session-1', taskId: 'server-task-1', archiveUri: null, status: 'completed', createdAt: timestamp, updatedAt: timestamp, messages: 8, changes: { added: 2, updated: 1, deleted: 0 }, errorCode: null },
        { id: 'fixture-job-2', peerId, sessionId: 'fixture-session-1', taskId: null, archiveUri: null, status: 'unknown', createdAt: timestamp, updatedAt: timestamp, messages: 4, changes: null, errorCode: 'MEMORY_SUBMISSION_UNKNOWN' }] }
    await open(page); await configure(page, true); await activity(page)
    await expect(page.locator('.ov-runtime')).toContainText('今日提取次数')
    await expect(page.locator('.ov-runtime')).toContainText('最近采集')
    await expect(page.locator('.ov-jobs')).toContainText('已完成')
    await expect(page.locator('.ov-jobs')).toContainText('结果未知')
    const completed = page.locator('.ov-jobs > li').first()
    await expect(completed).toContainText('本次增量提取未生成历史分段。')
    await completed.locator('summary').click()
    await expect(completed.getByText('fixture-session-1', { exact: true })).toBeVisible()
    await expect(completed.getByText('历史分段 URI', { exact: true })).toHaveCount(0)
    await expect(completed).not.toContainText('archive_')
    expect(await page.locator('.ov-panel').innerText()).not.toMatch(/每日上限|daily limit|已提交的会话和归档保留|Submitted sessions and archives are retained/i)
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('openviking-activity-desktop.png'), fullPage: false, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: info.outputPath('openviking-activity-dark.png'), fullPage: false, animations: 'disabled' })
    await page.locator('.ov-activity-controls').getByLabel('操作范围', { exact: true }).selectOption(peerId)
    await page.getByRole('button', { name: '提交待处理内容', exact: true }).click()
    expect(fixture.calls.filter(call => call.operation === 'flush')).toHaveLength(0)
    await expect(page.getByRole('group', { name: '提交待处理内容', exact: true })).toContainText(peerId)
    await page.getByRole('button', { name: '确认提交缓存', exact: true }).click()
    await expect(page.getByText('已处理提交请求。请查看任务的实际状态。', { exact: true })).toBeVisible()
    expect(fixture.calls.find(call => call.operation === 'flush')!.input).toEqual({ peerId })
    await page.locator('.ov-panel summary').filter({ hasText: '查找与管理记忆' }).click()
    await page.getByLabel('搜索记忆', { exact: true }).fill('team notes')
    await page.locator('.ov-memory-search').getByLabel('操作范围', { exact: true }).selectOption('peer')
    await page.locator('.ov-memory-search').getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.ov-memory-results li')).toHaveCount(2)
    expect(fixture.calls.filter(call => call.operation === 'search').at(-1)!.input).toEqual({ query: 'team notes', peerId })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#main-content').evaluate(element => element.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath('openviking-activity-390-dark.png'), fullPage: false, animations: 'disabled' })
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
  })
})
