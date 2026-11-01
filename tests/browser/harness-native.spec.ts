import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultNativeCapabilities, NATIVE_FEATURES } from '../../plugins/harness/dsh/src/native-capabilities'
import type { NativeCapabilitiesConfiguration } from '../../plugins/harness/dsh/src/native-capabilities'
import type { NativeSnapshot } from '../../plugins/harness/dsh/src/web/native-data'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const captures = fileURLToPath(new URL('../../.impeccable/review/dsh-native/', import.meta.url))
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
function snapshotFixture(): NativeSnapshot {
  return { configuration: defaultNativeCapabilities(['qq.private', 'qq.group']), agentTypes: [{ id: 'main', title: 'main', enabled: true }, { id: 'qq.private', title: 'QQ 私聊', enabled: true }, { id: 'qq.group', title: 'QQ 群聊', enabled: true }], catalog: {
    schemaVersion: 1, features: NATIVE_FEATURES.map(feature => ({ id: feature.id, available: feature.id !== 'powershell', platformAvailable: feature.id !== 'powershell', modules: feature.modules.map(module => ({ id: module.id, name: module.name, available: true })) })),
    tools: [{ name: 'fixture_echo', description: 'Fixture plugin tool for exact per-Agent grants.', fingerprint: 'a'.repeat(64) }],
    plugins: [{ entryId: 'fixture-module', moduleName: '@fixture/native-plugin', enabled: true, phase: null, observedPhase: 'active', protected: false, manageable: true, configured: true, fingerprint: 'b'.repeat(64) }],
    bundles: [{ name: '@fixture/native-plugin', version: '1.0.0', enabled: false, installed: true, availability: 'profile', official: false, optional: false, removable: true, protected: false, fingerprint: 'c'.repeat(64), rows: [{ id: 'fixture-module', name: '@fixture/native-plugin' }], overrides: [], errorCode: null }],
    runtime: { running: false, appliedRevision: null, errorCode: null, mounted: [], agents: [] },
  } }
}

test.describe('DSH 原生能力与插件管理', () => {
  test.setTimeout(60000)
  let home: string, host: EatingHost, url: string
  let errors: string[]
  test.beforeEach(async ({ page }) => {
    errors = []; page.on('pageerror', error => errors.push(error.message))
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_native_ui_')))
    for (const plugin of ['communication/qq', 'harness/dsh']) await installPluginPackage(home, fileURLToPath(new URL(`../../plugins/${plugin}/dist/`, import.meta.url)))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory })
    url = await host.listen(); await mkdir(captures, { recursive: true })
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(home)
    if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_native_ui_')) throw new Error('Unsafe native UI fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })
  const open = async (page: Page) => { await page.goto(url + '/#harness/dsh'); await page.getByRole('tab', { name: '原生能力与插件', exact: true }).click() }
  async function mock(page: Page, snapshot: NativeSnapshot, handler?: (operation: string, input: Record<string, unknown>, route: Route) => Promise<boolean>) {
    await page.route('**/api/plugins/dsh/manage', async route => {
      const body = route.request().postDataJSON() as { operation: string; input: Record<string, unknown> }
      if (!body.operation.startsWith('native-')) { await route.continue(); return }
      const operation = body.operation.slice(7)
      if (await handler?.(operation, body.input, route)) return
      if (operation === 'list') { await json(route, snapshot); return }
      if (operation === 'save') {
        snapshot.configuration = { schemaVersion: 1, revision: snapshot.configuration.revision + 1, features: body.input.features, toolGrants: body.input.toolGrants } as NativeCapabilitiesConfiguration
        await json(route, { configuration: snapshot.configuration }); return
      }
      throw new Error('Unexpected fixture native operation: ' + operation)
    })
  }

  test('宽屏内外轨道边界一致，二级分类与基础筛选在长目录底部保持固定', async ({ page }, info) => {
    const original = snapshotFixture()
    const snapshot = { ...original, catalog: { ...original.catalog, bundles: [...original.catalog.bundles, ...Array.from({ length: 30 }, (_, index) => ({ ...original.catalog.bundles[0]!, name: `@fixture/long-plugin-${index}`, protected: index === 0 }))] } }
    await page.setViewportSize({ width: 2560, height: 1100 }); await mock(page, snapshot); await open(page)
    await expect(page.locator('.dsh-native-toolbar')).toBeVisible()
    const bounds = await page.evaluate(() => {
      const outer = document.querySelector('.dsh-tabs')!, inner = document.querySelector('.dsh-native-toolbar')!, heading = document.querySelector('.dsh-native-heading')!, main = document.querySelector('.robot-content')!
      const content = (element: Element) => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) } }
      return { outer: content(outer), inner: content(inner), heading: heading.getBoundingClientRect().toJSON(), main: main.getBoundingClientRect().toJSON(), rail: outer.getBoundingClientRect().toJSON() }
    })
    expect(Math.abs(bounds.outer.left - bounds.heading.left)).toBeLessThan(1)
    expect(Math.abs(bounds.outer.right - bounds.heading.right)).toBeLessThan(1)
    expect(Math.abs(bounds.inner.right - bounds.heading.right)).toBeLessThan(1)
    expect(Math.abs(bounds.rail.right - bounds.main.right)).toBeLessThan(1)
    expect(bounds.heading.width).toBeLessThanOrEqual(1200)
    await page.getByRole('button', { name: 'DSH 插件', exact: true }).click()
    const base = page.getByRole('checkbox', { name: '显示基础组件', exact: true }); await base.check()
    await page.locator('.robot-content').evaluate(element => { element.scrollTop = element.scrollHeight })
    const rail = await page.locator('.dsh-tabs').boundingBox(), toolbar = await page.locator('.dsh-native-toolbar').boundingBox()
    expect(toolbar!.y).toBeGreaterThanOrEqual(rail!.y + rail!.height - 1)
    expect(toolbar!.y).toBeLessThanOrEqual(rail!.y + rail!.height + 1)
    await expect(base).toBeInViewport(); await expect(page.getByRole('button', { name: '读取当前目录', exact: true })).toBeInViewport()
    await page.screenshot({ path: info.outputPath('native-sticky-wide.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(base).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('native-sticky-mobile.png') })
  })

  test('禁用保存的原因支持悬停、键盘和Escape，代理范围可全选清空且只改草稿', async ({ page }) => {
    let writes = 0; await mock(page, snapshotFixture(), async operation => { if (operation !== 'list') writes++; return false }); await open(page)
    const save = page.getByRole('button', { name: '保存原生能力与授权', exact: true }), hint = save.locator('..')
    await expect(save).toBeDisabled(); await hint.hover()
    await expect(page.getByRole('tooltip')).toHaveText('没有尚未保存的原生能力更改。')
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).not.toBeVisible()
    await hint.focus(); await expect(page.getByRole('tooltip')).toBeVisible(); await page.keyboard.press('Enter'); expect(writes).toBe(0)
    const row = page.locator('details.dsh-native-row').filter({ hasText: '任务清单' }).first(); await row.locator('summary').click()
    const scope = row.locator('.dsh-native-scopes'); await scope.getByRole('button', { name: '允许全部可用代理', exact: true }).click()
    expect(await scope.locator('input:checked').count()).toBe(3)
    await scope.getByRole('button', { name: '清空选择', exact: true }).click(); expect(await scope.locator('input:checked').count()).toBe(0)
    expect(writes).toBe(0)
  })

  test('真实系统目录在未配置模型时可读取和保存，代理授权进入独立配置', async ({ page }) => {
    await open(page)
    await expect(page.getByRole('button', { name: '读取当前目录', exact: true })).toBeEnabled({ timeout: 30000 })
    const row = page.locator('details.dsh-native-row').filter({ hasText: '任务清单' }).first()
    await row.locator('summary').click()
    await row.getByRole('checkbox', { name: '启用', exact: true }).check()
    await row.getByRole('checkbox', { name: '主 Agent', exact: true }).uncheck()
    await row.getByRole('checkbox', { name: /QQ.*群聊/ }).check()
    await page.getByRole('button', { name: '保存原生能力与授权', exact: true }).click()
    await expect(page.getByText('原生能力与授权已保存，下次启动生效。', { exact: true })).toBeVisible({ timeout: 30000 })
    const reading = page.waitForResponse(response => response.url() === url + '/api/plugins/dsh/manage' && response.request().postDataJSON().operation === 'native-list')
    await page.getByRole('button', { name: '读取当前目录', exact: true }).click()
    const result = await reading
    expect(result.status()).toBe(200)
    const saved = await result.json() as NativeSnapshot
    expect(saved.configuration.features.find(feature => feature.id === 'todo')?.agentTypeIds).toHaveLength(1)
    expect(saved.configuration.features.find(feature => feature.id === 'todo')?.agentTypeIds[0]).not.toBe('main')
    expect(saved.catalog.runtime.running).toBe(false)
  })

  test('功能草稿和工具范围可独立保存，切换语言不发请求且明暗窄屏不溢出', async ({ page }) => {
    const snapshot = snapshotFixture(); let calls = 0
    await mock(page, snapshot, async () => { calls++; return false })
    await page.setViewportSize({ width: 1440, height: 1000 }); await open(page)
    const row = page.locator('details.dsh-native-row').filter({ has: page.getByText('@deepseek-ai/dsh-tool-fs', { exact: true }) }).first()
    await row.locator('summary').click()
    await row.getByRole('checkbox', { name: '启用', exact: true }).check()
    await row.getByRole('checkbox', { name: 'QQ 群聊', exact: true }).check()
    const editor = row.getByRole('textbox', { name: '原生模块配置（JSON）', exact: true })
    await editor.fill('{\n  "tool-fs": { "read": true, "write": true }\n}')
    const before = calls
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
    await expect(row.getByRole('textbox')).toHaveValue('{\n  "tool-fs": { "read": true, "write": true }\n}')
    expect(calls).toBe(before)
    await page.getByRole('combobox', { name: 'Display language', exact: true }).selectOption('zh-CN')
    await page.getByRole('button', { name: '保存原生能力与授权', exact: true }).click()
    await expect(page.getByText('原生能力与授权已保存，下次启动生效。', { exact: true })).toBeVisible()
    expect(snapshot.configuration.features.find(feature => feature.id === 'files')).toMatchObject({ enabled: true, agentTypeIds: ['main', 'qq.group'], config: { 'tool-fs': { read: true, write: true } } })
    await row.locator('summary').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(captures, 'features-light-desktop.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(captures, 'features-dark-desktop.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '插件工具授权', exact: true }).click()
    const tool = page.locator('details.dsh-native-row').filter({ hasText: 'fixture_echo' }).first(); await tool.locator('summary').click()
    await tool.getByRole('checkbox', { name: 'QQ 私聊', exact: true }).check()
    await page.getByRole('button', { name: '保存原生能力与授权', exact: true }).click()
    await expect.poll(() => snapshot.configuration.toolGrants.length).toBe(1)
    expect(snapshot.configuration.toolGrants[0]).toEqual({ name: 'fixture_echo', fingerprint: 'a'.repeat(64), agentTypeIds: ['qq.private'] })
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'light' })
    await tool.locator('summary').scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(captures, 'tools-light-mobile.png'), animations: 'disabled' })
  })

  test('安装需要来源检查和信任选择，插件配置不回显，隐藏清理秘密并停止读取', async ({ page }) => {
    const snapshot = snapshotFixture(); const installations: Record<string, unknown>[] = []; let reads = 0
    await mock(page, snapshot, async (operation, input, route) => {
      if (operation === 'list') { reads++; return false }
      if (operation === 'inspect') { await json(route, { status: 'accepted', name: '@fixture/confirmed', version: '1.2.3', bundle: true, kind: 'registry' }); return true }
      if (operation === 'install') { installations.push(input); await json(route, { changed: true, application: 'restart-required', stage: 'install', target: '@fixture/confirmed' }); return true }
      return false
    })
    await open(page); await page.getByRole('button', { name: 'DSH 插件', exact: true }).click()
    await page.getByRole('textbox', { name: '插件来源', exact: true }).fill('@fixture/confirmed@1.2.3')
    await page.getByRole('button', { name: '检查来源', exact: true }).click()
    const install = page.getByRole('button', { name: '确认安装插件', exact: true })
    await expect(install).toBeDisabled()
    await page.getByRole('checkbox', { name: '我信任此来源的插件代码，确认安装到 Eating 专属 DSH', exact: true }).check()
    await install.click(); await expect.poll(() => installations.length).toBe(1)
    expect(installations[0]).toMatchObject({ confirmed: true, spec: '@fixture/confirmed@1.2.3' })
    expect(installations[0]!.requestId).toMatch(/^[a-f0-9-]{36}$/)
    const module = page.locator('details.dsh-native-row').filter({ has: page.getByText('@fixture/native-plugin', { exact: true }) }).last()
    await module.locator('summary').click()
    const config = module.getByRole('textbox', { name: '替换插件配置（JSON）', exact: true })
    await expect(config).toHaveValue('')
    await config.fill('{"apiKey":"transient-fixture-only"}')
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' }); await module.locator('summary').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(captures, 'plugins-dark-mobile.png'), animations: 'disabled' })
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(config).toHaveValue(''); await expect(page.getByRole('textbox', { name: '插件来源', exact: true })).toHaveValue('')
    const count = reads; await page.waitForTimeout(100); expect(reads).toBe(count)
  })

  test('未知结果先核对目录，配置冲突保留草稿并要求显式载入最新配置', async ({ page }) => {
    const snapshot = snapshotFixture(); let saves = 0
    await mock(page, snapshot, async (operation, _input, route) => {
      if (operation !== 'save') return false
      saves++; snapshot.configuration = { ...snapshot.configuration, revision: 1 }
      await json(route, { error: { code: 'NATIVE_CONTROL_UNKNOWN', message: 'fixture unknown', outcome: 'unknown' } }, 504); return true
    })
    await open(page)
    const row = page.locator('details.dsh-native-row').filter({ hasText: '任务清单' }).first(); await row.locator('summary').click(); await row.getByRole('checkbox', { name: '启用', exact: true }).check()
    await page.getByRole('button', { name: '保存原生能力与授权', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('操作结果尚未确认')
    await expect(page.getByRole('button', { name: '保存原生能力与授权', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '读取当前目录', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('目录或配置已变化')
    await expect(row.getByRole('checkbox', { name: '启用', exact: true })).toBeChecked()
    await page.getByRole('button', { name: '放弃草稿并载入已保存配置', exact: true }).click()
    await expect(row.getByRole('checkbox', { name: '启用', exact: true })).not.toBeChecked()
    expect(saves).toBe(1)
  })
})
