import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonObject } from '@eating/plugin-sdk'
import type { ReportedModelCapabilities } from '../../plugins/harness/dsh/src/model-information'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })

// All operations below are UI fixtures. They never start a native runtime or call a provider.
test.describe('DSH 原生 Web 入口与独立能力', () => {
  test.setTimeout(45_000)
  let directory: string, host: EatingHost, url: string
  let dsh: { enabled: boolean; configuration: JsonObject; status: JsonObject }
  let runtime: JsonObject
  let launch: unknown
  let nativeGate: Promise<void> | null
  let reads: number, opens: number, saves: JsonObject[], errors: string[]
  let snapshot: { schemaVersion: 1; revision: number; imageInput: boolean }
  let readFailure: boolean, conflict: boolean
  let reported: ReportedModelCapabilities | null, informationReads: number

  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_native_web_ui_')))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/harness/dsh/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [] }); url = await host.listen()
    errors = []
    expect((await page.request.get(url + '/api/bootstrap')).status()).toBe(200)
    const workspaceResponse = await page.request.get(url + '/api/workspace'); expect(workspaceResponse.status()).toBe(200)
    const initial = await workspaceResponse.json() as { plugins: (typeof dsh & { id: string })[] }
    dsh = initial.plugins.find(plugin => plugin.id === 'dsh')!; runtime = dsh.configuration.runtimeStatus as JsonObject
    runtime.nativeWeb = { ready: false }
    dsh.configuration.endpoint = 'http://127.0.0.1:1/v1'; dsh.configuration.model = 'fixture-model'
    reported = null; informationReads = 0
    reads = 0; opens = 0; saves = []; errors = []; readFailure = false; conflict = false; nativeGate = null
    snapshot = { schemaVersion: 1, revision: 0, imageInput: false }
    launch = { url: url + '/native-ui-fixture/session?token=fixture-only-private-entry', rootSessionId: 'native-ui-main' }
    page.on('pageerror', error => errors.push(error.message))
    await page.context().route('**/native-ui-fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native UI fixture</title><p>Official native fixture</p>' }))
    await page.route('**/api/workspace', route => json(route, initial))
    await page.route('**/api/plugins/dsh/manage', async route => {
      const body = route.request().postDataJSON() as { operation: string; input: JsonObject }
      if (body.operation === 'read-model-information' || body.operation === 'get-model-information') { informationReads++; await json(route, { model: dsh.configuration.model, capabilities: reported, fetchedAt: reported ? '2026-11-01T08:00:00.000Z' : null, imageInput: reported?.imageInput ?? snapshot.imageInput, appliedImageInput: runtime.ready ? snapshot.imageInput : null }); return }
      if (body.operation === 'list-models') { await json(route, { models: [{ id: 'fixture-model', ...(reported ? { capabilities: reported } : {}) }, { id: 'another-model', capabilities: { ...reported, imageInput: false, toolCalling: null, reasoning: null, inputModalities: ['text'], outputModalities: ['text'], contextWindow: 32768, maxOutputTokens: 4096 } }] }); return }
      if (body.operation === 'get-model-capabilities') { reads++; await json(route, readFailure ? { error: { code: 'FIXTURE_READ_FAILED', outcome: 'failed' } } : snapshot, readFailure ? 500 : 200); return }
      if (body.operation === 'save-model-capabilities') {
        saves.push(body.input)
        if (runtime.ready) { await json(route, { error: { code: 'MODEL_CAPABILITIES_RUNTIME_ACTIVE', outcome: 'not-sent' } }, 409); return }
        if (conflict || body.input.expectedRevision !== snapshot.revision) { conflict = false; await json(route, { error: { code: 'MODEL_CAPABILITIES_CONFLICT', outcome: 'not-sent' } }, 409); return }
        snapshot = { schemaVersion: 1, revision: snapshot.revision + 1, imageInput: body.input.imageInput === true }; await json(route, snapshot); return
      }
      if (body.operation === 'open-native-web') { opens++; const response = launch; await nativeGate; await json(route, response).catch(() => {}); return }
      await route.continue()
    })
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_native_web_ui_')) throw new Error('Unsafe native UI fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })
  const ready = (value: boolean) => { runtime.ready = value; runtime.nativeWeb = { ready: value }; dsh.status.state = value ? 'connected' : 'disconnected' }
  async function open(page: Page) { await page.goto(url + '/#harness/dsh'); await expect(page.getByLabel('模型名称', { exact: true })).toBeVisible() }
  async function refresh(page: Page) { await page.getByRole('button', { name: '刷新状态', exact: true }).click() }
  async function hide(page: Page) {
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  }
  async function show(page: Page) {
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  }

  test('只在启用且原生 Web 就绪时开放，点击获取新入口并隔离 opener/referrer，URL 不出现在面板', async ({ page }, info) => {
    ready(false); await open(page)
    const button = page.getByRole('button', { name: '打开 DSH Web', exact: true })
    await expect(button).toBeDisabled(); expect(opens).toBe(0)
    dsh.enabled = false; ready(true); await refresh(page); await expect(button).toBeDisabled()
    dsh.enabled = true; dsh.status.state = 'connecting'; await refresh(page); await expect(button).toBeDisabled()
    dsh.status.state = 'connected'; await refresh(page); await expect(button).toBeEnabled()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(button).toBeDisabled()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(button).toBeEnabled()
    const created = page.waitForEvent('popup'); await button.click(); const popup = await created
    await popup.waitForURL('**/native-ui-fixture/session?*')
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    expect(await popup.evaluate(() => document.referrer)).toBe('')
    await popup.screenshot({ path: info.outputPath('native-new-tab-fixture.png') })
    await expect(page.locator('body')).not.toContainText('fixture-only-private-entry')
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('fixture-only-private-entry')
    expect(opens).toBe(1); await popup.close()
    ready(false); await refresh(page); await expect(button).toBeDisabled()
    await page.screenshot({ path: info.outputPath('native-unavailable-zh-desktop.png') })
  })

  test('拒绝外部、脚本、错误端口及非严格响应，失败只显示固定文案', async ({ page }) => {
    ready(true); await open(page)
    const button = page.getByRole('button', { name: '打开 DSH Web', exact: true })
    const values = [
      { url: 'https://outside.invalid/private-token', rootSessionId: 'root' },
      { url: 'javascript:alert(1)', rootSessionId: 'root' },
      { url: 'http://127.0.0.1:65536/private-token', rootSessionId: 'root' },
      { url: url + '/native-ui-fixture/', rootSessionId: 'root', readOnly: false },
      { url: url + '/native-ui-fixture/', rootSessionId: 'root', token: 'private-token' },
    ]
    for (const [index, value] of values.entries()) {
      launch = value; await button.click()
      await expect.poll(() => opens).toBe(index + 1)
      await expect(page.getByText('无法打开 DSH Web。请刷新运行状态后重试。', { exact: true })).toBeVisible()
      await expect.poll(() => page.context().pages().length).toBe(1)
    }
    await expect(page.locator('body')).not.toContainText('private-token')
    await page.evaluate(() => { window.open = () => null })
    const before = opens; await button.click()
    await expect(page.getByText(/浏览器未能打开新标签页/)).toBeVisible(); expect(opens).toBe(before)
  })

  test('切离时取消待打开页面，迟到入口不恢复且不泄露到反馈', async ({ page }) => {
    ready(true); let release!: () => void; nativeGate = new Promise<void>(done => { release = done })
    await open(page)
    await page.getByRole('button', { name: '打开 DSH Web', exact: true }).click(); await expect.poll(() => opens).toBe(1)
    await hide(page)
    release(); await expect.poll(() => page.context().pages().length).toBe(1)
    await show(page)
    await expect(page.locator('body')).not.toContainText('fixture-only-private-entry')
  })

  test('例行状态轮询不会取消较慢的开窗请求', async ({ page }) => {
    ready(true); let release!: () => void; nativeGate = new Promise<void>(done => { release = done })
    await open(page)
    const created = page.waitForEvent('popup')
    await page.getByRole('button', { name: '打开 DSH Web', exact: true }).click()
    const popup = await created
    await expect.poll(() => opens).toBe(1)
    await page.waitForTimeout(3400)
    expect(popup.isClosed()).toBe(false)
    expect(page.context().pages().length).toBe(2)
    release()
    await popup.waitForURL('**/native-ui-fixture/session?*')
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    await popup.close()
  })

  test('服务声明的能力紧邻模型选择自动显示，语言切换不重新读取，未知手动补充隐藏', async ({ page }, info) => {
    reported = { imageInput: true, toolCalling: true, reasoning: true, inputModalities: ['text', 'image'], outputModalities: ['text'], contextWindow: 1000000, maxOutputTokens: 128000 }
    ready(false); await open(page)
    const capabilities = page.locator('.dsh-model-feedback .dsh-model-capabilities')
    await expect(capabilities).toContainText('1,000,000 token')
    await expect(capabilities).toContainText('128,000 token')
    await expect(capabilities.locator('dd').filter({ hasText: '支持' })).toHaveCount(3)
    await expect(capabilities.locator('input[type="checkbox"]')).toHaveCount(0)
    const inputBox = await page.getByLabel('模型名称', { exact: true }).boundingBox(), capabilityBox = await capabilities.boundingBox(), keyBox = await page.getByLabel('API Key', { exact: true }).boundingBox()
    expect(capabilityBox!.y).toBeGreaterThan(inputBox!.y)
    expect(capabilityBox!.y + capabilityBox!.height).toBeLessThanOrEqual(keyBox!.y)
    const before = informationReads
    await page.locator('#display-language').selectOption('en-US')
    await expect(capabilities.getByRole('heading', { name: 'Model capabilities' })).toBeVisible()
    expect(informationReads).toBe(before); expect(saves).toEqual([])
    await page.screenshot({ path: info.outputPath('model-capabilities-en-desktop.png') })
    await page.locator('#display-language').selectOption('zh-CN'); await page.setViewportSize({ width: 390, height: 844 }); await capabilities.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('model-capabilities-zh-mobile.png') })
  })

  test('切换草稿模型立即显示对应能力，保存前不采用为运行配置', async ({ page }) => {
    reported = { imageInput: true, toolCalling: true, reasoning: true, inputModalities: ['text', 'image'], outputModalities: ['text'], contextWindow: 1000000, maxOutputTokens: 128000 }
    await open(page)
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    await page.getByLabel('从模型列表选择', { exact: true }).selectOption('another-model')
    const capabilities = page.locator('.dsh-model-capabilities')
    await expect(capabilities).toContainText('不支持')
    await expect(capabilities).toContainText('32,768 token')
    await expect(capabilities).toContainText('这是未保存模型的能力预览')
    await expect(capabilities.getByRole('button', { name: '刷新模型能力' })).toBeDisabled()
    expect(dsh.configuration.model).toBe('fixture-model'); expect(saves).toEqual([])
  })

  test('能力只初读一次，CAS冲突保草稿且必须重读，独立保存不改变连接草稿', async ({ page }, info) => {
    ready(false); await open(page)
    await page.getByText('服务未声明图片能力时，手动补充', { exact: true }).click()
    const checkbox = page.locator('.dsh-capabilities input[type="checkbox"]')
    await expect(checkbox).not.toBeChecked(); expect(reads).toBe(1)
    await page.getByLabel('显示名称', { exact: true }).fill('connection-draft-kept')
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
    await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue('connection-draft-kept')
    const before = reads; await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('connection-draft-kept')
    await page.waitForTimeout(2200); expect(reads).toBe(before)
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('capabilities-en-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  })

  test('读取失败不会显示false已读状态，运行中不能保存', async ({ page }) => {
    readFailure = true; ready(false); await open(page)
    await expect(page.getByText(/无法读取模型输入能力/)).toBeVisible()
    await page.getByText('服务未声明图片能力时，手动补充', { exact: true }).click()
    await expect(page.locator('.dsh-capabilities input')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存输入能力', exact: true })).toBeDisabled()
    readFailure = false; await page.getByRole('button', { name: '重新读取能力配置', exact: true }).click()
    await page.locator('.dsh-capabilities input[type="checkbox"]').check()
    ready(true); await refresh(page)
    await expect(page.getByRole('button', { name: '保存输入能力', exact: true })).toBeDisabled(); expect(saves).toEqual([])
  })
})
