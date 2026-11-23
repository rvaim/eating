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
import type { DshResetPreview } from '../../plugins/harness/dsh/src/web/history-data'

interface ManagementCall { readonly operation: string; readonly input: Record<string, unknown> }
type Handler = (call: ManagementCall, route: Route) => Promise<boolean>
const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })

const previewFixture = (rootCount = 2, childCount = 4, extra?: Partial<DshResetPreview>): DshResetPreview => {
  const pendingQueueCount = extra?.pendingQueueCount ?? 0
  const uncertainQueueCount = extra?.uncertainQueueCount ?? 0
  const workspaceEntryCount = extra?.workspaceEntryCount ?? 3
  const scheduledCount = extra?.scheduledCount ?? 0
  const residualStateCount = extra?.residualStateCount ?? (rootCount + childCount > 0 ? 4 : 0)
  return {
    previewId: randomUUID(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    runtimeRunning: false,
    sessionCount: rootCount + childCount,
    rootCount,
    childCount,
    scheduledCount,
    workspaceEntryCount,
    residualStateCount,
    hasResettableData: rootCount + childCount + workspaceEntryCount + scheduledCount + residualStateCount > 0,
    hasPendingQueue: pendingQueueCount + uncertainQueueCount > 0,
    pendingQueueCount,
    uncertainQueueCount,
    ...extra,
  }
}

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
    if (call.operation === 'preview-dsh-reset') { await json(route, current); return }
    if (call.operation === 'reset-dsh') {
      await json(route, {
        requestId: call.input.requestId,
        status: 'completed',
        deletedSessions: current.sessionCount,
        clearedWorkspaceEntries: current.workspaceEntryCount,
        clearedScheduledCount: current.scheduledCount,
        clearedQueueCount: call.input.queueAction === 'clear' ? current.pendingQueueCount + current.uncertainQueueCount : 0,
        queueAction: call.input.queueAction ?? 'none',
        wasRunning: current.runtimeRunning,
        restarted: current.runtimeRunning,
      })
      return
    }
    if (call.operation === 'get-model-capabilities') { await json(route, { schemaVersion: 1, revision: 0, imageInput: false }); return }
    if (call.operation === 'native-list') {
      await json(route, { configuration: defaultNativeCapabilities([]), agentTypes: [{ id: 'main', title: 'main', enabled: true }], catalog: { schemaVersion: 1, features: [], tools: [], plugins: [], bundles: [], runtime: { running: false, appliedRevision: null, errorCode: null, mounted: [], agents: [] } } })
      return
    }
    throw new Error(`Unexpected reset fixture operation: ${call.operation}`)
  })
  return { calls, resetCalls: () => calls.filter(call => call.operation === 'preview-dsh-reset' || call.operation === 'reset-dsh'), current }
}

async function scan(page: Page) {
  await page.getByRole('button', { name: '检查当前状态', exact: true }).click()
  await expect(page.getByRole('heading', { name: '当前 DSH 状态概览', exact: true })).toBeVisible()
}

async function openConfirm(page: Page) {
  await page.getByRole('button', { name: '重置 DSH', exact: true }).click()
  await expect(page.getByRole('heading', { name: '确认重置 DSH', exact: true })).toBeVisible()
}

test.describe('DSH 重置功能', () => {
  test.setTimeout(60000)
  let home: string, host: EatingHost, url: string
  let errors: string[]

  test.beforeEach(async ({ page }) => {
    errors = []; page.on('pageerror', error => errors.push(error.message))
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_reset_ui_')))
    await installPluginPackage(home, fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory, autoConnectOnStartup: false })
    url = await host.listen()
  })

  test.afterEach(async () => {
    await host?.close()
    if (home) {
      const target = await realpath(home)
      if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_reset_ui_')) throw new Error('Unsafe reset UI fixture cleanup')
      await rm(target, { recursive: true })
    }
    expect(errors).toEqual([])
  })

  const open = async (page: Page) => {
    await page.goto(url + '/#harness/dsh')
    await page.getByRole('tab', { name: '重置 DSH', exact: true }).click()
  }

  test('中文桌面检查状态、取消无副作用，勾选确认后重置停机 DSH', async ({ page }, info) => {
    const fixture = await mockManagement(page)
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' }); await open(page)
    expect(fixture.resetCalls()).toHaveLength(0)
    await expect(page.getByText('尚未检查当前状态。检查仅读取当前会话、工作区与消息队列概况，确认前不会修改或删除任何内容。', { exact: true })).toBeVisible()

    await scan(page)
    const counts = page.locator('.dsh-history-counts')
    await expect(counts.locator('div').filter({ hasText: '主会话' }).locator('dd')).toHaveText('2')
    await expect(counts.locator('div').filter({ hasText: '子会话' }).locator('dd')).toHaveText('4')
    await expect(counts.locator('div').filter({ hasText: '全部会话' }).locator('dd')).toHaveText('6')
    await expect(counts.locator('div').filter({ hasText: '工作区项目' }).locator('dd')).toHaveText('3')
    expect(fixture.resetCalls()).toEqual([{ operation: 'preview-dsh-reset', input: {} }])

    await openConfirm(page)
    const cancel = page.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeFocused()
    await expect(page.getByRole('button', { name: '确认重置 DSH', exact: true })).toBeDisabled()
    await page.locator('.dsh-history-confirm').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('reset-confirm-zh-desktop.png'), animations: 'disabled' })

    await cancel.click()
    await expect(page.getByRole('button', { name: '重置 DSH', exact: true })).toBeFocused()
    expect(fixture.resetCalls()).toHaveLength(1)

    await openConfirm(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    expect(fixture.resetCalls()).toHaveLength(1)

    await openConfirm(page)
    await page.getByRole('checkbox', { name: '我已核对重置范围与保留项，确认重置 DSH。', exact: true }).check()
    await page.getByRole('button', { name: '确认重置 DSH', exact: true }).click()
    await expect(page.getByText('DSH 已重置（已清空 6 个会话与 3 项工作区内容）。需要时可在“连接配置”中启动 Harness。', { exact: true })).toBeVisible()
    const resets = fixture.calls.filter(call => call.operation === 'reset-dsh')
    expect(resets).toHaveLength(1)
    expect(resets[0]!.input).toEqual({
      previewId: fixture.current.previewId,
      requestId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
      confirmed: true,
    })
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0)
  })

  test('存在待处理消息队列时弹窗内明确询问保留或清空队列，用户选择后才允许重置', async ({ page }, info) => {
    const queuedPreview = previewFixture(1, 2, { runtimeRunning: true, workspaceEntryCount: 4, scheduledCount: 1, pendingQueueCount: 2, uncertainQueueCount: 1 })
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation === 'preview-dsh-reset') { await json(route, queuedPreview); return true }
      if (call.operation === 'reset-dsh') {
        const action = call.input.queueAction as 'keep' | 'clear'
        await json(route, {
          requestId: call.input.requestId,
          status: 'completed',
          deletedSessions: 3,
          clearedWorkspaceEntries: 4,
          clearedScheduledCount: 1,
          clearedQueueCount: action === 'clear' ? 3 : 0,
          queueAction: action,
          wasRunning: true,
          restarted: true,
        })
        return true
      }
      return false
    })
    await page.route('**/api/workspace', route => workspaceFixture(route, true))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await open(page)
    await scan(page)
    await expect(page.getByText('检测到 1 个 DSH 原生定时任务；重置 DSH 时将一并清空。', { exact: true })).toBeVisible()
    await expect(page.getByText('当前消息队列中仍有 3 条未完成消息（待投递 2 条，结果待核对 1 条）。确认重置时可选择保留队列、清空队列或先取消处理。', { exact: true })).toBeVisible()

    // Flow 1: Choose keep queue
    await openConfirm(page)
    await page.getByRole('checkbox', { name: '我已核对重置范围与保留项，确认重置 DSH。', exact: true }).check()
    // Still disabled until user chooses keep or clear!
    await expect(page.getByRole('button', { name: '确认重置 DSH', exact: true })).toBeDisabled()
    await page.locator('.dsh-history-confirm').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('reset-queue-prompt-zh-desktop.png'), animations: 'disabled' })
    await page.getByRole('radio', { name: /保留队列消息并重置 DSH/ }).check()
    await expect(page.getByRole('button', { name: '确认重置 DSH', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '确认重置 DSH', exact: true }).click()
    await expect(page.getByText('DSH 已重置并自动重启，已创建全新会话（已清空 3 个会话与 4 项工作区内容）。 原消息队列已保留。', { exact: true })).toBeVisible()
    expect(fixture.calls.filter(c => c.operation === 'reset-dsh')[0]!.input.queueAction).toBe('keep')

    // Flow 2: Choose clear queue on mobile dark mode
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await scan(page)
    await openConfirm(page)
    await page.getByRole('radio', { name: /清空队列消息并重置 DSH/ }).check()
    await page.getByRole('checkbox', { name: '我已核对重置范围与保留项，确认重置 DSH。', exact: true }).check()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('reset-queue-clear-zh-mobile-dark.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '确认重置 DSH', exact: true }).click()
    await expect(page.getByText('DSH 已重置并自动重启，已创建全新会话（已清空 3 个会话与 4 项工作区内容）。 同时已清空 3 条队列消息。', { exact: true })).toBeVisible()
    expect(fixture.calls.filter(c => c.operation === 'reset-dsh')[1]!.input.queueAction).toBe('clear')
  })

  test('英文390暗色保留确认草稿，unknown不自动重发，重新检查后才可发起新操作', async ({ page }, info) => {
    let scans = 0
    const requestIds: unknown[] = []
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation === 'preview-dsh-reset') { scans++; await json(route, scans === 1 ? previewFixture() : previewFixture(1, 1, { workspaceEntryCount: 2 })); return true }
      if (call.operation !== 'reset-dsh') return false
      requestIds.push(call.input.requestId)
      if (requestIds.length === 1) await json(route, { error: { code: 'DSH_RESET_FAILED', message: 'fixture unknown', outcome: 'unknown' } }, 504)
      else await json(route, { requestId: call.input.requestId, status: 'completed', deletedSessions: 2, clearedWorkspaceEntries: 2, clearedScheduledCount: 0, clearedQueueCount: 0, queueAction: 'none', wasRunning: false, restarted: false })
      return true
    })
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' }); await open(page); await scan(page); await openConfirm(page)
    await page.getByRole('checkbox', { name: '我已核对重置范围与保留项，确认重置 DSH。', exact: true }).check()

    const before = fixture.calls.length
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
    const acknowledgement = page.getByRole('checkbox', { name: 'I have reviewed what will be cleared and preserved, and confirm resetting DSH.', exact: true })
    await expect(acknowledgement).toBeChecked()
    await expect(page.getByRole('button', { name: 'Confirm reset DSH', exact: true })).toBeEnabled()
    expect(fixture.calls).toHaveLength(before)

    const selectedTab = await page.getByRole('tab', { name: 'Reset DSH', exact: true }).boundingBox(), rail = await page.locator('.dsh-tabs').boundingBox()
    expect(selectedTab!.x).toBeGreaterThanOrEqual(rail!.x); expect(selectedTab!.x + selectedTab!.width).toBeLessThanOrEqual(rail!.x + rail!.width)
    await page.locator('.dsh-history-confirm').scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('reset-confirm-en-dark-mobile.png'), animations: 'disabled' })

    await page.getByRole('button', { name: 'Confirm reset DSH', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'The reset outcome is unconfirmed' })).toBeVisible()
    await nextFrames(page); expect(requestIds).toHaveLength(1)
    await expect(page.locator('.dsh-history-confirm')).toHaveCount(0); await expect(page.locator('.dsh-history-preview')).toHaveCount(0)

    await page.getByRole('button', { name: 'Check current status', exact: true }).click()
    await expect(page.locator('.dsh-history-counts div').filter({ hasText: 'All sessions' }).locator('dd')).toHaveText('2')
    expect(requestIds).toHaveLength(1)
    await page.getByRole('button', { name: 'Reset DSH', exact: true }).click()
    await expect(acknowledgement).not.toBeChecked(); await acknowledgement.check()
    await page.getByRole('button', { name: 'Confirm reset DSH', exact: true }).click()
    await expect(page.getByText('DSH has been reset (cleared 2 sessions and 2 workspace items). Start Harness from Connection whenever ready.', { exact: true })).toBeVisible()
    expect(requestIds).toHaveLength(2); expect(requestIds[0]).not.toBe(requestIds[1])
  })

  test('三页签键盘循环完整，连接草稿跨页保留，空态不可重置，过期/隐藏/错误处理正确', async ({ page }) => {
    let mode: 'normal' | 'empty' | 'error' = 'normal'
    const fixture = await mockManagement(page, async (call, route) => {
      if (call.operation !== 'preview-dsh-reset') return false
      if (mode === 'empty') { await json(route, previewFixture(0, 0, { workspaceEntryCount: 0, residualStateCount: 0 })); return true }
      if (mode === 'error') { await json(route, { error: { code: 'DSH_RESET_PATH_UNSAFE', message: '/private/fixture-do-not-render', outcome: 'not-sent' } }, 409); return true }
      return false
    })
    await page.goto(url + '/#harness/dsh')
    const displayName = page.getByRole('textbox', { name: '显示名称', exact: true })
    await displayName.fill('保留此连接草稿')
    const connection = page.getByRole('tab', { name: '连接配置', exact: true }), resetTab = page.getByRole('tab', { name: '重置 DSH', exact: true }), native = page.getByRole('tab', { name: '原生能力与插件', exact: true })
    await connection.focus(); await page.keyboard.press('ArrowLeft'); await expect(resetTab).toBeFocused(); await expect(resetTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight'); await expect(connection).toBeFocused()
    await page.keyboard.press('ArrowRight'); await expect(native).toBeFocused()
    await page.keyboard.press('ArrowRight'); await expect(resetTab).toBeFocused()
    await page.keyboard.press('Home'); await expect(connection).toBeFocused(); await page.keyboard.press('End'); await expect(resetTab).toBeFocused()
    await connection.click()
    await expect(displayName).toHaveValue('保留此连接草稿')

    await resetTab.click()
    mode = 'empty'
    await scan(page)
    await expect(page.getByText('未发现需要重置的 DSH 会话、工作区内容或运行残留，当前已为干净初始状态。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重置 DSH', exact: true })).toHaveCount(0)

    mode = 'error'
    await page.getByRole('button', { name: '检查当前状态', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('DSH 数据路径未通过安全核验')
    await expect(page.getByRole('alert')).toContainText('DSH_RESET_PATH_UNSAFE')
    await expect(page.locator('.dsh-history-settings')).not.toContainText('/private/fixture-do-not-render')
    expect(fixture.resetCalls()).toHaveLength(2)
  })

  test('扫描到期自动撤销确认且隐藏中止请求', async ({ page }) => {
    await page.clock.install()
    const fixture = await mockManagement(page)
    await open(page); await scan(page); await openConfirm(page)
    const timer = page.getByRole('timer')
    await expect(timer).toContainText('剩余有效期')
    await expect(timer).not.toHaveClass(/is-urgent/)
    await page.clock.fastForward(95000)
    await expect(timer).toHaveClass(/is-urgent/)
    await page.clock.fastForward(26000)
    await expect(page.getByRole('alert')).toContainText('本次检查已过期')
    await expect(page.locator('.dsh-history-preview')).toHaveCount(0); await expect(page.locator('.dsh-history-confirm')).toHaveCount(0)
    expect(fixture.resetCalls()).toHaveLength(1)
  })
})
