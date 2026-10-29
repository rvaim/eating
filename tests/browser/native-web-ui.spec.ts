import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessSessionContent, HarnessSessionSummary, JsonObject } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const refreshedAt = '2026-10-29T00:00:00Z'
const session: HarnessSessionSummary = { id: 'native-ui-child', parentId: 'native-ui-main', title: '原始会话标题', pluginId: 'example', pluginName: '演示平台', instanceId: 'instance-fixture', accountId: '10001', conversationKind: 'group', targetId: '30003', status: 'stopped', updatedAt: refreshedAt }
const content: HarnessSessionContent = { session, refreshedAt, nextOffset: null, records: [
  { sequence: 1, timestamp: refreshedAt, kind: 'user/message', role: 'user', classification: 'platform-message', source: { kind: 'user' }, content: '原始信封不作为主要消息', platformEvents: [{ eventId: 'event-1', pluginId: 'example', instanceId: 'instance-fixture', accountId: '10001', conversationId: 'example:10001:group:30003', conversationKind: 'group', senderId: '20002', senderName: '夹具昵称', targetId: '30003', messageId: '42', receivedAt: refreshedAt, text: '真实来源的平台正文' }] },
  { sequence: 2, timestamp: refreshedAt, kind: 'assistant/message', role: 'assistant', classification: 'model-output', source: { kind: 'model', provider: 'fixture', model: 'no-provider-call' }, content: [{ type: 'text', text: '模型拟议回复尚未发送' }, { type: 'reasoning', text: 'private-reasoning-must-not-appear' }] },
  { sequence: 3, timestamp: refreshedAt, kind: 'user/message', role: 'user', classification: 'agent-message', source: { kind: 'agent', form: 'agent-message', senderSessionId: 'native-ui-main', summary: '主 Agent 委派' }, content: '内部任务交接' },
  { sequence: 4, timestamp: refreshedAt, kind: 'user/message', role: 'user', classification: 'time-context', source: { kind: 'time-context' }, content: '运行时读数夹具' },
  { sequence: 5, timestamp: refreshedAt, kind: 'system/message', role: 'system', classification: 'system-context', content: '历史系统上下文夹具', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] },
  { sequence: 6, timestamp: refreshedAt, kind: 'tool/result', role: 'tool', classification: 'tool-result', callId: 'call-fixture', content: { isError: true, error: { code: 'NOT_SENT' }, content: [{ type: 'text', text: '工具明确未发送' }], reasoning: 'private-tool-analysis' } },
] }
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })

// All operations below are UI fixtures. They never start a native runtime or call a provider.
test.describe('原生只读入口、独立能力与来源展示', () => {
  test.setTimeout(45_000)
  let directory: string, host: EatingHost, url: string
  let dsh: { enabled: boolean; configuration: JsonObject; status: JsonObject }
  let runtime: JsonObject
  let launch: unknown
  let nativeGate: Promise<void> | null
  let reads: number, opens: number, saves: JsonObject[], errors: string[]
  let snapshot: { schemaVersion: 1; revision: number; imageInput: boolean }
  let readFailure: boolean, conflict: boolean

  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_native_web_ui_')))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [] }); url = await host.listen()
    errors = []
    expect((await page.request.get(url + '/api/bootstrap')).status()).toBe(200)
    const workspaceResponse = await page.request.get(url + '/api/workspace'); expect(workspaceResponse.status()).toBe(200)
    const initial = await workspaceResponse.json() as { plugins: (typeof dsh & { id: string })[] }
    dsh = initial.plugins.find(plugin => plugin.id === 'dsh')!; runtime = dsh.configuration.runtimeStatus as JsonObject
    reads = 0; opens = 0; saves = []; errors = []; readFailure = false; conflict = false; nativeGate = null
    snapshot = { schemaVersion: 1, revision: 0, imageInput: false }
    launch = { url: url + '/native-ui-fixture/session?token=fixture-only-private-entry', rootSessionId: 'native-ui-main', readOnly: true }
    page.on('pageerror', error => errors.push(error.message))
    await page.context().route('**/native-ui-fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native UI fixture</title><p>Read-only native fixture</p>' }))
    await page.route('**/api/workspace', route => json(route, initial))
    await page.route('**/api/plugins/dsh/manage', async route => {
      const body = route.request().postDataJSON() as { operation: string; input: JsonObject }
      if (body.operation === 'get-model-capabilities') { reads++; await json(route, readFailure ? { error: { code: 'FIXTURE_READ_FAILED', outcome: 'failed' } } : snapshot, readFailure ? 500 : 200); return }
      if (body.operation === 'save-model-capabilities') {
        saves.push(body.input)
        if (runtime.ready) { await json(route, { error: { code: 'MODEL_CAPABILITIES_RUNTIME_ACTIVE', outcome: 'not-sent' } }, 409); return }
        if (conflict || body.input.expectedRevision !== snapshot.revision) { conflict = false; await json(route, { error: { code: 'MODEL_CAPABILITIES_CONFLICT', outcome: 'not-sent' } }, 409); return }
        snapshot = { schemaVersion: 1, revision: snapshot.revision + 1, imageInput: body.input.imageInput === true }; await json(route, snapshot); return
      }
      if (body.operation === 'open-native-web') { opens++; const response = launch; await nativeGate; await json(route, response).catch(() => {}); return }
      if (body.operation === 'list-sessions') { await json(route, { sessions: [session], truncated: false, refreshedAt }); return }
      if (body.operation === 'read-session') { await json(route, content); return }
      await route.continue()
    })
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_native_web_ui_')) throw new Error('Unsafe native UI fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })
  const ready = (value: boolean) => { runtime.ready = value; runtime.nativeWeb = { ready: value, readOnly: true }; dsh.status.state = value ? 'connected' : 'disconnected' }
  async function open(page: Page) { await page.goto(url + '/#harness/dsh'); await expect(page.getByLabel('模型名称', { exact: true })).toBeVisible() }
  async function sessions(page: Page) { await page.getByRole('tab', { name: '会话看板', exact: true }).click() }

  test('只在真实就绪与启用时开放，点击获取新入口并隔离 opener/referrer，URL不出现在面板', async ({ page }, info) => {
    ready(false); await open(page); await sessions(page)
    const button = page.getByRole('button', { name: '打开原生会话（只读）', exact: true })
    await expect(button).toBeDisabled(); expect(opens).toBe(0)
    ready(true); await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await expect(button).toBeEnabled()
    const created = page.waitForEvent('popup'); await button.click(); const popup = await created
    await popup.waitForURL('**/native-ui-fixture/session?*')
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    expect(await popup.evaluate(() => document.referrer)).toBe('')
    await popup.screenshot({ path: info.outputPath('native-new-tab-fixture.png') })
    await expect(page.locator('body')).not.toContainText('fixture-only-private-entry')
    expect(opens).toBe(1); await popup.close()
    ready(false); await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await expect(button).toBeDisabled()
    await page.screenshot({ path: info.outputPath('native-unavailable-zh-desktop.png') })
  })

  test('拒绝外部、脚本、错误端口及非严格响应，失败只显示固定文案', async ({ page }) => {
    ready(true); await open(page); await sessions(page)
    for (const value of [
      { url: 'https://outside.invalid/private-token', rootSessionId: 'root', readOnly: true },
      { url: 'javascript:alert(1)', rootSessionId: 'root', readOnly: true },
      { url: 'http://127.0.0.1:65536/private-token', rootSessionId: 'root', readOnly: true },
      { url: url + '/native-ui-fixture/', rootSessionId: 'root', readOnly: false },
      { url: url + '/native-ui-fixture/', rootSessionId: 'root', readOnly: true, token: 'private-token' },
    ]) {
      launch = value; await page.getByRole('button', { name: '打开原生会话（只读）', exact: true }).click()
      await expect(page.getByText('无法打开原生会话页面。请刷新运行状态后重试。', { exact: true })).toBeVisible()
      await expect.poll(() => page.context().pages().length).toBe(1)
    }
    await expect(page.locator('body')).not.toContainText('private-token')
    await page.evaluate(() => { window.open = () => null })
    const before = opens; await page.getByRole('button', { name: '打开原生会话（只读）', exact: true }).click()
    await expect(page.getByText(/浏览器未能打开新标签页/)).toBeVisible(); expect(opens).toBe(before)
  })

  test('切离时取消待打开页面，迟到入口不恢复且不泄露到反馈', async ({ page }) => {
    ready(true); let release!: () => void; nativeGate = new Promise<void>(done => { release = done })
    await open(page); await sessions(page)
    await page.getByRole('button', { name: '打开原生会话（只读）', exact: true }).click(); await expect.poll(() => opens).toBe(1)
    await page.getByRole('tab', { name: '配置', exact: true }).click(); release()
    await expect.poll(() => page.context().pages().length).toBe(1)
    await sessions(page); await expect(page.locator('body')).not.toContainText('fixture-only-private-entry')
  })

  test('能力只初读一次，CAS冲突保草稿且必须重读，独立保存不改变连接草稿', async ({ page }, info) => {
    ready(false); await open(page)
    const checkbox = page.locator('.dsh-capabilities input[type="checkbox"]')
    await expect(checkbox).not.toBeChecked(); expect(reads).toBe(1)
    await page.getByLabel('模型名称', { exact: true }).fill('connection-draft-kept')
    await checkbox.check(); conflict = true; snapshot = { ...snapshot, revision: 3 }
    await page.getByRole('button', { name: '保存输入能力', exact: true }).click()
    await expect(page.getByText(/能力配置已被修改/)).toBeVisible(); await expect(checkbox).toBeChecked()
    await expect(page.getByRole('button', { name: '保存输入能力', exact: true })).toBeDisabled()
    await page.locator('#display-language').selectOption('en-US'); await expect(checkbox).toBeChecked(); expect(reads).toBe(1)
    await page.locator('.dsh-capabilities').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('capabilities-conflict-en-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.dsh-capabilities').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('capabilities-conflict-en-mobile.png') })
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('#display-language').selectOption('zh-CN')
    await page.getByRole('button', { name: '重新读取能力配置', exact: true }).click(); await expect(checkbox).toBeChecked()
    await page.getByRole('button', { name: '保存输入能力', exact: true }).click()
    await expect(page.getByText('模型输入能力已保存。下次启动 Harness 时生效。', { exact: true })).toBeVisible()
    expect(saves).toEqual([{ expectedRevision: 0, imageInput: true }, { expectedRevision: 3, imageInput: true }])
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('connection-draft-kept')
    const before = reads; await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Model name', { exact: true })).toHaveValue('connection-draft-kept')
    await page.waitForTimeout(2200); expect(reads).toBe(before)
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('capabilities-en-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  })

  test('读取失败不会显示false已读状态，运行中不能保存', async ({ page }) => {
    readFailure = true; ready(false); await open(page)
    await expect(page.getByText(/无法读取模型输入能力/)).toBeVisible()
    await expect(page.locator('.dsh-capabilities input')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存输入能力', exact: true })).toBeDisabled()
    readFailure = false; await page.getByRole('button', { name: '重新读取能力配置', exact: true }).click()
    await page.locator('.dsh-capabilities input[type="checkbox"]').check()
    ready(true); await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存输入能力', exact: true })).toBeDisabled(); expect(saves).toEqual([])
  })

  test('离线快照保留历史账号，平台发送者、协作、模型与折叠上下文区分且不显示推理', async ({ page }, info) => {
    ready(false); await open(page); await sessions(page)
    await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
    await page.getByRole('navigation', { name: '会话层级' }).getByRole('button', { name: /演示平台-10001-群聊-30003/ }).click()
    await expect(page.getByText('真实来源的平台正文', { exact: true })).toBeVisible()
    await expect(page.getByText('夹具昵称 · 20002', { exact: true })).toBeVisible()
    await expect(page.getByText('子 Agent 模型输出', { exact: true })).toBeVisible()
    await expect(page.getByText('Agent 内部协作', { exact: true })).toBeVisible()
    await expect(page.getByText('运行时读数夹具', { exact: true })).toBeHidden()
    await expect(page.getByText('历史系统上下文夹具', { exact: true })).toBeHidden()
    await page.locator('[data-classification="time-context"] > details > summary').click()
    await expect(page.getByText('运行时读数夹具', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('private-reasoning-must-not-appear')
    await expect(page.locator('body')).not.toContainText('private-tool-analysis')
    await expect(page.getByText('未发送', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('session-sources-zh-desktop.png') })
  })
})
