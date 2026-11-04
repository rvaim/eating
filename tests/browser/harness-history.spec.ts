import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { defaultNativeCapabilities } from '../../plugins/harness/dsh/src/native-capabilities'
import type { SessionHistoryPreview } from '../../plugins/harness/dsh/src/web/history-data'

interface ManagementCall { readonly operation: string; readonly input: Record<string, unknown> }
type Handler = (call: ManagementCall, route: Route) => Promise<boolean>
const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
const previewFixture = (rootCount = 2, childCount = 4): SessionHistoryPreview => ({ previewId: randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString(), sessionCount: rootCount + childCount, rootCount, childCount })
const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
async function workspaceFixture(route: Route, running = false) {
  const response = await route.fetch()
  const value = await response.json()
  const plugin = value.plugins.find((entry: { id: string }) => entry.id === 'dsh')
  plugin.configuration.runtimeStatus.system = { found: true, path: '/fixture/bin/dsh', version: 'fixture', source: 'path' }
  plugin.configuration.configurationPath = '/fixture/harness/configuration.json'
  plugin.configuration.dataDirectory = '/fixture/harness'
  if (running) {
    plugin.status = { ...plugin.status, state: 'connected', lastError: null }
    plugin.configuration.runtimeStatus = { ...plugin.configuration.runtimeStatus, ready: true, busy: false }
  }
  await route.fulfill({ response, json: value })
}

async function mockManagement(page: Page, handler?: Handler) {
  const calls: ManagementCall[] = []
  await page.route('**/api/workspace', route => workspaceFixture(route))
  const current = previewFixture()
  await page.route('**/api/plugins/dsh/manage', async route => {
    const call = route.request().postDataJSON() as ManagementCall
    calls.push(call)
    if (await handler?.(call, route)) return
    if (call.operation === 'preview-session-history') { await json(route, current); return }
    if (call.operation === 'clear-session-history') { await json(route, { requestId: call.input.requestId, status: 'completed', deletedCount: current.sessionCount }); return }
    if (call.operation === 'get-model-capabilities') { await json(route, { schemaVersion: 1, revision: 0, imageInput: false }); return }
    if (call.operation === 'native-list') {
      await json(route, { configuration: defaultNativeCapabilities([]), agentTypes: [{ id: 'main', title: 'main', enabled: true }], catalog: { schemaVersion: 1, features: [], tools: [], plugins: [], bundles: [], runtime: { running: false, appliedRevision: null, errorCode: null, mounted: [], agents: [] } } }); return
    }
    throw new Error(`Unexpected history fixture operation: ${call.operation}`)
  })
  return { calls, historyCalls: () => calls.filter(call => call.operation.endsWith('session-history')), current }
}
async function scan(page: Page) {
  await page.getByRole('button', { name: '扫描历史会话', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本次扫描结果', exact: true })).toBeVisible()
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: '清理历史会话', exact: true }).click()
  await page.getByRole('checkbox', { name: '我已核对数量，确认永久删除上述主、子会话的对话历史。', exact: true }).check()
}

test.describe('DSH 历史会话清理', () => {
  test.setTimeout(60000)
  let home: string, host: EatingHost, url: string
  let errors: string[]
  test.beforeEach(async ({ page }) => {
    errors = []; page.on('pageerror', error => errors.push(error.message))
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_history_ui_')))
    await installPluginPackage(home, fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory, autoConnectOnStartup: false })
    url = await host.listen()
  })
  test.afterEach(async () => {
    await host?.close()
    if (home) {
      const target = await realpath(home)
      if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_history_ui_')) throw new Error('Unsafe history UI fixture cleanup')
      await rm(target, { recursive: true })
    }
    expect(errors).toEqual([])
  })
  const open = async (page: Page) => { await page.goto(url + '/#harness/dsh'); await page.getByRole('tab', { name: '历史会话', exact: true }).click() }

  test('中文桌面按真实数量预览，取消无副作用，勾选确认才发送并显示成功', async ({ page }, info) => {
    const fixture = await mockManagement(page)
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' }); await open(page)
    expect(fixture.historyCalls()).toHaveLength(0)
    await expect(page.getByText('尚未扫描历史会话。扫描只核对数量，确认清理前不会删除会话。', { exact: true })).toBeVisible()
    await scan(page)
    const counts = page.locator('.dsh-history-counts')
    await expect(counts.locator('div').filter({ hasText: '主会话' }).locator('dd')).toHaveText('2')
    await expect(counts.locator('div').filter({ hasText: '子会话' }).locator('dd')).toHaveText('4')
    await expect(counts.locator('div').filter({ hasText: '全部会话' }).locator('dd')).toHaveText('6')
    expect(fixture.historyCalls()).toEqual([{ operation: 'preview-session-history', input: {} }])
    await page.getByRole('button', { name: '清理历史会话', exact: true }).click()
    const cancel = page.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeFocused()
    await expect(page.getByRole('button', { name: '确认清理 6 个会话', exact: true })).toBeDisabled()
    await page.locator('.dsh-history-confirm').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('history-confirm-zh-desktop.png'), animations: 'disabled' })
    await cancel.click()
    await expect(page.getByRole('button', { name: '清理历史会话', exact: true })).toBeFocused()
    expect(fixture.historyCalls()).toHaveLength(1)
    await page.getByRole('button', { name: '清理历史会话', exact: true }).click(); await page.keyboard.press('Escape')
    await expect(page.locator('.dsh-history-confirm')).toHaveCount(0); expect(fixture.historyCalls()).toHaveLength(1)
    await confirm(page)
    await page.getByRole('button', { name: '确认清理 6 个会话', exact: true }).click()
    await expect(page.getByText('已清理 6 个历史会话。再次启动 Harness 后将创建新会话。', { exact: true })).toBeVisible()
    const clears = fixture.calls.filter(call => call.operation === 'clear-session-history')
    expect(clears).toHaveLength(1)
    expect(clears[0]!.input).toEqual({ previewId: fixture.current.previewId, requestId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/), confirmed: true })
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0)
  })

  test('英文390暗色保留确认草稿，unknown不自动重发，重新扫描后才可发起新操作', async ({ page }, info) => {
    let scans = 0
    const requestIds: unknown[] = []
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation === 'preview-session-history') { scans++; await json(route, scans === 1 ? previewFixture() : previewFixture(1, 1)); return true }
      if (call.operation !== 'clear-session-history') return false
      requestIds.push(call.input.requestId)
      if (requestIds.length === 1) await json(route, { error: { code: 'SESSION_HISTORY_CLEAR_UNKNOWN', message: 'fixture unknown', outcome: 'unknown' } }, 504)
      else await json(route, { requestId: call.input.requestId, status: 'completed', deletedCount: 2 })
      return true
    })
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' }); await open(page); await scan(page); await confirm(page)
    const before = fixture.calls.length
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
    const acknowledgement = page.getByRole('checkbox', { name: 'I have reviewed the counts and confirm permanently deleting the conversation history of these main and child sessions.', exact: true })
    await expect(acknowledgement).toBeChecked()
    await expect(page.getByRole('button', { name: 'Confirm clearing 6 sessions', exact: true })).toBeEnabled()
    expect(fixture.calls).toHaveLength(before)
    const selectedTab = await page.getByRole('tab', { name: 'Session history', exact: true }).boundingBox(), rail = await page.locator('.dsh-tabs').boundingBox()
    expect(selectedTab!.x).toBeGreaterThanOrEqual(rail!.x); expect(selectedTab!.x + selectedTab!.width).toBeLessThanOrEqual(rail!.x + rail!.width)
    await page.locator('.dsh-history-confirm').scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('history-confirm-en-dark-mobile.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Confirm clearing 6 sessions', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'The clearing outcome is unconfirmed' })).toBeVisible()
    await nextFrames(page); expect(requestIds).toHaveLength(1)
    await expect(page.locator('.dsh-history-confirm')).toHaveCount(0); await expect(page.locator('.dsh-history-preview')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('history-unknown-en-dark-mobile.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Scan session history', exact: true }).click()
    await expect(page.locator('.dsh-history-counts div').filter({ hasText: 'All sessions' }).locator('dd')).toHaveText('2')
    expect(requestIds).toHaveLength(1)
    await page.getByRole('button', { name: 'Clear session history', exact: true }).click()
    await expect(acknowledgement).not.toBeChecked(); await acknowledgement.check()
    await page.getByRole('button', { name: 'Confirm clearing 2 sessions', exact: true }).click()
    await expect(page.getByText('Cleared 2 historical sessions. Starting Harness again will create new sessions.', { exact: true })).toBeVisible()
    expect(requestIds).toHaveLength(2); expect(requestIds[0]).not.toBe(requestIds[1])
  })

  test('运行中禁用扫描并引导现有停止入口，不自动停止', async ({ page }, info) => {
    const fixture = await mockManagement(page)
    let mutations = 0
    await page.route('**/api/plugins/dsh/disconnect', async route => { mutations++; await json(route, {}) })
    await page.route('**/api/workspace', route => workspaceFixture(route, true))
    await open(page)
    await expect(page.getByRole('button', { name: '扫描历史会话', exact: true })).toBeDisabled()
    await expect(page.getByText('Harness 正在运行或尚未完全停止。请切回“连接配置”，使用“停止 Harness”，完全停止后再扫描或清理。', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('history-running-zh-desktop.png'), animations: 'disabled' })
    await nextFrames(page); expect(fixture.historyCalls()).toHaveLength(0); expect(mutations).toBe(0)
  })

  test('三页签键盘循环完整，语言切换不请求且连接草稿跨历史页保留', async ({ page }) => {
    const fixture = await mockManagement(page)
    await page.goto(url + '/#harness/dsh')
    const displayName = page.getByRole('textbox', { name: '显示名称', exact: true })
    await displayName.fill('保留此连接草稿')
    const connection = page.getByRole('tab', { name: '连接配置', exact: true }), history = page.getByRole('tab', { name: '历史会话', exact: true }), native = page.getByRole('tab', { name: '原生能力与插件', exact: true })
    await connection.focus(); await page.keyboard.press('ArrowLeft'); await expect(history).toBeFocused(); await expect(history).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight'); await expect(connection).toBeFocused()
    await page.keyboard.press('ArrowRight'); await expect(native).toBeFocused()
    await expect(page.getByRole('button', { name: '读取当前目录', exact: true })).toBeEnabled()
    await page.keyboard.press('ArrowRight'); await expect(history).toBeFocused()
    await page.keyboard.press('Home'); await expect(connection).toBeFocused(); await page.keyboard.press('End'); await expect(history).toBeFocused()
    expect(fixture.historyCalls()).toHaveLength(0)
    await scan(page); await confirm(page)
    const before = fixture.calls.length
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US'); await nextFrames(page)
    expect(fixture.calls).toHaveLength(before)
    await expect(page.getByRole('checkbox', { name: 'I have reviewed the counts and confirm permanently deleting the conversation history of these main and child sessions.', exact: true })).toBeChecked()
    await page.getByRole('tab', { name: 'Connection', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('保留此连接草稿')
    await page.getByRole('tab', { name: 'Session history', exact: true }).click()
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0); await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    expect(fixture.historyCalls()).toHaveLength(1)
  })

  test('过期冲突废弃旧确认，空态不可清理，错误代码以双语恢复提示显示', async ({ page }) => {
    let scans = 0
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation === 'preview-session-history') { scans++; await json(route, scans === 1 ? previewFixture() : previewFixture(0, 0)); return true }
      if (call.operation !== 'clear-session-history') return false
      await json(route, { error: { code: 'SESSION_HISTORY_PREVIEW_STALE', message: 'fixture stale', outcome: 'failed' } }, 409); return true
    })
    await open(page); await scan(page); await confirm(page); await page.getByRole('button', { name: '确认清理 6 个会话', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('本次扫描已过期或会话已变化。')
    await expect(page.getByRole('alert')).toContainText('SESSION_HISTORY_PREVIEW_STALE')
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0); await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    await scan(page)
    await expect(page.getByText('未发现历史会话，无需清理。下次启动 Harness 后将创建新会话。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '清理历史会话', exact: true })).toHaveCount(0)
    expect(fixture.historyCalls().filter(call => call.operation === 'clear-session-history')).toHaveLength(1)
  })

  test('隐藏中止请求并清除确认，迟到扫描结果不会恢复旧预览', async ({ page }) => {
    let releaseScan: (() => void) | undefined
    let scanStarted = false
    const gate = new Promise<void>(done => { releaseScan = done })
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation !== 'preview-session-history') return false
      scanStarted = true; await gate; await json(route, previewFixture(99, 99)); return true
    })
    await page.addInitScript(() => {
      const nativeFetch = window.fetch
      window.fetch = (input, options) => nativeFetch(input, typeof input === 'string' && input.endsWith('/api/plugins/dsh/manage') ? { ...options, signal: undefined } : options)
    })
    await open(page); await page.getByRole('button', { name: '扫描历史会话', exact: true }).click(); await expect.poll(() => scanStarted).toBe(true)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    releaseScan!(); await nextFrames(page)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByRole('button', { name: '扫描历史会话', exact: true })).toBeEnabled(); await nextFrames(page)
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0); await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    expect(fixture.historyCalls()).toHaveLength(1)
  })

  test('扫描到期自动撤销确认，只能显式重新扫描', async ({ page }) => {
    await page.clock.install()
    const fixture = await mockManagement(page)
    await open(page); await scan(page); await confirm(page)
    await page.clock.fastForward(120001)
    await expect(page.getByRole('alert')).toContainText('本次扫描已过期或会话已变化。')
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0); await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    expect(fixture.historyCalls()).toHaveLength(1)
    await expect(page.getByRole('button', { name: '扫描历史会话', exact: true })).toBeEnabled()
  })

  test('管理错误显示翻译与代码，未识别错误使用通用提示且不回显私有消息', async ({ page }) => {
    const failures = [
      { code: 'SESSION_HISTORY_RUNTIME_ACTIVE', message: 'Harness 尚未完全停止。', english: 'Harness has not fully stopped.' },
      { code: 'SESSION_HISTORY_QUEUE_PENDING', message: '还有待处理的消息，当前不能清理。', english: 'Messages are still pending' },
      { code: 'SESSION_HISTORY_BUSY', message: '另一个管理操作正在进行。', english: 'Another management operation is in progress.' },
      { code: 'SESSION_HISTORY_SCHEDULED', message: '请先在官方 DSH Web 中删除相关任务，再停止 Harness 并重新扫描。', english: 'Delete the related tasks in official DSH Web, then stop Harness and scan again.' },
      { code: 'SESSION_HISTORY_UNSUPPORTED', message: '当前会话资料暂不支持清理。', english: 'This session data cannot currently be cleared.' },
      { code: 'SESSION_HISTORY_PATH_UNSAFE', message: '会话资料未通过安全检查。', english: 'The session data did not pass the safety checks.' },
      { code: 'FIXTURE_UNRECOGNIZED', message: '无法扫描历史会话。', english: 'Could not scan session history.' },
    ]
    let attempts = 0
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation !== 'preview-session-history') return false
      const failure = failures[attempts++]!
      await json(route, { error: { code: failure.code, message: '/private/fixture-do-not-render', outcome: 'failed' } }, 409); return true
    })
    await open(page)
    for (const failure of failures) {
      await page.getByRole('button', { name: '扫描历史会话', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(failure.message)
      await expect(page.getByRole('alert')).toContainText(failure.code)
      await expect(page.locator('.dsh-history-settings')).not.toContainText('/private/fixture-do-not-render')
      await expect(page.locator('.dsh-history-preview')).toHaveCount(0)
      const before = fixture.calls.length
      await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
      await expect(page.getByRole('alert')).toContainText(failure.english)
      if (failure.code === 'SESSION_HISTORY_SCHEDULED') { await expect(page.getByRole('alert')).toContainText('including disabled tasks'); await expect(page.getByRole('alert')).not.toContainText('cancel') }
      expect(fixture.calls).toHaveLength(before)
      await page.getByRole('combobox', { name: 'Display language', exact: true }).selectOption('zh-CN')
    }
    expect(fixture.historyCalls()).toHaveLength(failures.length)
    const before = fixture.calls.length
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
    await expect(page.getByRole('alert')).toContainText('Could not scan session history.')
    expect(fixture.calls).toHaveLength(before)
  })

  test('清理途中隐藏后保持unknown，忽略迟到成功且不自动重发', async ({ page }) => {
    let releaseClear: (() => void) | undefined
    let clearStarted = false
    const gate = new Promise<void>(done => { releaseClear = done })
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation !== 'clear-session-history') return false
      clearStarted = true; await gate
      await json(route, { requestId: call.input.requestId, status: 'completed', deletedCount: 6 }); return true
    })
    await page.addInitScript(() => {
      const nativeFetch = window.fetch
      window.fetch = (input, options) => nativeFetch(input, typeof input === 'string' && input.endsWith('/api/plugins/dsh/manage') ? { ...options, signal: undefined } : options)
    })
    await open(page); await scan(page); await confirm(page)
    await page.getByRole('button', { name: '确认清理 6 个会话', exact: true }).click(); await expect.poll(() => clearStarted).toBe(true)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    releaseClear!(); await nextFrames(page)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(page.getByRole('alert')).toContainText('清理结果尚未确认，系统不会自动重试。')
    await expect(page.getByText('已清理 6 个历史会话。再次启动 Harness 后将创建新会话。', { exact: true })).toHaveCount(0)
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0); await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    await nextFrames(page); expect(fixture.historyCalls().filter(call => call.operation === 'clear-session-history')).toHaveLength(1)
  })
})
