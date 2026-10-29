import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_SCOPES, TEMPLATE_VARIABLES } from '@eating/plugin-sdk'
import type { AgentPromptPreview, AuthoringSnapshot, PersonaMutationResult, PluginPackageManifest } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage, uninstallPluginPackage } from '../../apps/host/src/plugin-installation'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const qqDirectory = fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url))
const platformId = 'relay-test'
const platformName = 'Relay / 测试平台'
const alphaId = 'agent:relay-test.alpha'
const zetaId = 'agent:relay-test.zeta'
const editor = (page: Page) => page.locator('.template-editor [role="textbox"]')
const nav = (page: Page) => page.locator('.authoring-sidebar nav')
const platform = (page: Page, id = platformId) => nav(page).locator(`.authoring-platform-group[data-plugin-id="${id}"]`)
const toggle = (page: Page, id = platformId) => platform(page, id).locator(':scope > button')
const children = (page: Page, id = platformId) => platform(page, id).locator(':scope > ul')

// A fully installed API2 communication package contributes real Host prompt metadata.
// Its platform name is unrelated to document titles, and roles arrive out of canonical order.
async function installRelayFixture(home: string) {
  const directory = join(home, 'relay-fixture-package')
  await mkdir(join(directory, 'ui'), { recursive: true })
  const agentTypes = ['zeta', 'alpha'].map((id, index) => ({
    id: `${platformId}.${id}`, title: index === 0 ? '群协作角色' : '独立联络角色',
    localizedTitles: { 'zh-CN': index === 0 ? '群协作角色' : '独立联络角色', 'en-US': index === 0 ? 'Group collaborator' : 'Private liaison' },
    description: `Loopback-only ${id} role`, conversationKind: index === 0 ? 'group' : 'private',
    defaultPrompt: `${id.toUpperCase()} original body {{主人}} {{人格名称}}`,
    availableTools: [], defaultTools: [], enabledTools: [],
  }))
  const agentInstructions = [{ id: `${platformId}.usage`, title: '会话路由说明', localizedTitles: { 'zh-CN': '会话路由说明', 'en-US': 'Conversation routing' }, body: 'RELAY_USAGE original instructions {{主人}}' }]
  const files: Record<string, string> = {
    'server.mjs': `export default {
      id: ${JSON.stringify(platformId)}, kind: 'communication', storageDirectory: 'relay-test-bot',
      create() { return {
        id: ${JSON.stringify(platformId)}, kind: 'communication', name: ${JSON.stringify(platformName)}, version: '1.0.0',
        tools: [], capabilities: [], agentTypes: ${JSON.stringify(agentTypes)}, agentInstructions: ${JSON.stringify(agentInstructions)},
        getAgentIdentity() { return { owners: ['relay-owner'], administrators: ['relay-administrator'] } },
        getStatus() { return { state: 'unconfigured', accountId: null, accountName: null, lastError: null, connectedAt: null, lastEventAt: null, reconnectAttempt: 0 } },
        getPublicConfiguration() { return { autoConnect: false } }, async updateConfiguration() { return { autoConnect: false } },
        async connect() {}, async disconnect() {}, async dispose() {}, async invoke() { throw new Error('No fixture tools') }
      } }
    }`,
    'ui/index.js': `export default {
      id: ${JSON.stringify(platformId)}, kind: 'communication', name: ${JSON.stringify(platformName)}, description: 'Loopback-only prompt grouping fixture',
      version: '1.0.0', apiVersion: 3, order: 20, brandColor: '#32634e', defaultRegistered: true,
      icon() { return null }, Panel() { return null }, initialValues: {}, validate() { return { valid: true, errors: {} } }, summary() { return '' }
    }`,
    'ui/style.css': '/* Temporary prompt grouping fixture has no panel styles. */\n',
  }
  const manifest: PluginPackageManifest = {
    schemaVersion: 1, id: platformId, name: platformName, description: 'Loopback-only prompt grouping fixture', version: '1.0.0',
    kind: 'communication', apiVersion: 3, assets: [], storageDirectory: 'relay-test-bot', backend: 'server.mjs',
    frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 20, brandColor: '#32634e', icon: 'message-circle' },
    integrity: Object.fromEntries(Object.entries(files).map(([entry, body]) => [entry, createHash('sha256').update(body).digest('hex')])),
  }
  for (const [entry, body] of Object.entries(files)) await writeFile(join(directory, entry), body)
  await writeFile(join(directory, 'eating-plugin.json'), JSON.stringify(manifest))
  await installPluginPackage(home, directory)
}

test.describe('平台提示词折叠目录', () => {
  test.setTimeout(45000)
  let home: string
  let host: EatingHost | undefined
  let url: string
  let errors: string[]

  async function startHost() {
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  }
  test.beforeEach(async ({ page }) => {
    errors = []
    page.on('pageerror', error => errors.push(error.message))
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_prompt_groups_browser_')))
    await installPluginPackage(home, qqDirectory)
    await installRelayFixture(home)
    await startHost()
    await page.request.get(`${url}/api/bootstrap`)
  })
  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      host = undefined
      const target = await realpath(home)
      if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_prompt_groups_browser_')) throw new Error('Unsafe prompt grouping fixture cleanup')
      await rm(target, { recursive: true })
    }
    expect(errors).toEqual([])
  })

  async function snapshot(page: Page): Promise<AuthoringSnapshot> {
    const response = await page.request.get(`${url}/api/authoring`)
    expect(response.status()).toBe(200)
    return response.json() as Promise<AuthoringSnapshot>
  }
  async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
    const bootstrap = await page.request.get(`${url}/api/bootstrap`)
    const { csrfToken } = await bootstrap.json() as { csrfToken: string }
    const response = await page.request.post(`${url}/api${path}`, { headers: { 'X-Eating-Csrf': csrfToken }, data })
    expect(response.status()).toBe(path === '/personas' ? 201 : 200)
    return response.json() as Promise<T>
  }
  async function selectAlpha(page: Page) {
    await children(page).getByRole('button', { name: /^(独立联络角色|Private liaison)/ }).click()
    await expect(page).toHaveURL(`${url}/#prompts/${encodeURIComponent(alphaId)}`)
  }

  test('两个真实平台按pluginId聚合，原生键盘折叠保留route、编辑器与各文档草稿', async ({ page }, testInfo) => {
    const initial = await snapshot(page)
    expect(initial.prompts.filter(doc => doc.pluginId === platformId).map(doc => doc.id).sort()).toEqual([alphaId, zetaId, 'plugin:relay-test.usage'].sort())
    await page.goto(`${url}/#prompts/common`)
    await expect(editor(page)).toBeVisible()
    await expect(toggle(page)).toHaveText(platformName)
    await expect(toggle(page, 'qq')).toHaveText('QQ')
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page, 'qq')).toHaveAttribute('aria-expanded', 'false')
    await expect(children(page)).toBeHidden()
    await expect(nav(page).getByRole('button')).toHaveCount(5)
    await expect(nav(page).getByRole('group', { name: '平台提示词', exact: true })).toHaveCount(1)
    await expect(nav(page).getByRole('group', { name: /^(插件使用说明|插件代理)$/ })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('default-collapsed-platforms.png') })
    await toggle(page).focus()
    await toggle(page).press('Enter')
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(children(page)).toHaveAttribute('id', (await toggle(page).getAttribute('aria-controls'))!)
    await expect(children(page)).toHaveAttribute('aria-label', `${platformName} 提示词`)
    await expect(children(page).getByRole('button')).toHaveText(['会话路由说明', '独立联络角色', '群协作角色'])
    await selectAlpha(page)
    const alpha = initial.prompts.find(doc => doc.id === alphaId)!
    await expect(editor(page)).toHaveText(alpha.body, { useInnerText: true })
    const content = await editor(page).elementHandle()
    await toggle(page).click()
    await expect(children(page)).toBeHidden()
    const reloaded = page.waitForResponse(response => response.url() === `${url}/api/authoring`)
    await page.getByRole('button', { name: '重新读取提示词', exact: true }).click()
    expect((await reloaded).status()).toBe(200)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(editor(page)).toHaveText(alpha.body, { useInnerText: true })
    expect(await editor(page).evaluate((element, previous) => element === previous, content)).toBe(true)
    const draft = '独立平台原文草稿 {{主人}} {{人格名称}}'
    await editor(page).fill(draft)
    await expect(toggle(page).getByLabel('有未保存修改', { exact: true })).toHaveCount(1)
    let reads = 0
    const mutations: string[] = []
    page.on('request', request => {
      if (/\/api\/(authoring|personas)(?:\/|$)/.test(request.url())) reads++
      if (request.method() === 'POST') mutations.push(request.url())
    })
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
    await expect(nav(page).getByRole('group', { name: 'Platform prompts', exact: true })).toHaveCount(1)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page)).toContainText(platformName)
    await expect(editor(page)).toHaveText(draft)
    expect(await editor(page).evaluate((element, previous) => element === previous, content)).toBe(true)
    await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame())))
    expect(reads).toBe(0)
    expect(mutations).toEqual([])
    await toggle(page).focus()
    await toggle(page).press('Space')
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(children(page).getByRole('button')).toHaveText(['Conversation routing', 'Private liaison', 'Group collaborator'])
    await toggle(page, 'qq').click()
    await children(page, 'qq').getByRole('button', { name: 'QQ private chat', exact: true }).click()
    await expect(page).toHaveURL(`${url}/#prompts/agent%3Aqq.private`)
    await selectAlpha(page)
    await expect(editor(page)).toHaveText(draft)
    await editor(page).press('ControlOrMeta+z')
    await expect(editor(page)).toHaveText(draft)
    await toggle(page).click()
    await page.evaluate(id => { window.location.hash = `prompts/${encodeURIComponent(id)}` }, zetaId)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(editor(page)).toHaveText(initial.prompts.find(doc => doc.id === zetaId)!.body, { useInnerText: true })
    await selectAlpha(page)
    await expect(editor(page)).toHaveText(draft)
    expect((await snapshot(page)).prompts.find(doc => doc.id === alphaId)!.body).toBe(alpha.body)
    await page.screenshot({ path: testInfo.outputPath('two-platform-groups-english.png') })
    expect(mutations).toEqual([])
  })

  test('深链接展开所选平台，停用和卸载保持来源、九变量、人格与主人正文', async ({ page }, testInfo) => {
    const created = await post<PersonaMutationResult>(page, '/personas', { name: '原文人格 / Persona', body: 'PERSONA original body {{人格名称}}' })
    await post(page, `/personas/${created.persona.id}/activate`, { expectedRevision: created.snapshot.revision, enabled: true })
    const initial = await snapshot(page)
    const original = initial.prompts.find(doc => doc.id === alphaId)!
    const ownerBody = `OWNER original body ${TEMPLATE_VARIABLES.map(variable => `{{${variable.name}}}`).join(' ')}`
    await post(page, `/prompts/${encodeURIComponent(alphaId)}`, { expectedRevision: original.revision, body: ownerBody })
    await page.goto(`${url}/#prompts/${encodeURIComponent(alphaId)}`)
    await expect(editor(page)).toHaveText(ownerBody)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(page, 'qq')).toHaveAttribute('aria-expanded', 'false')
    expect(TEMPLATE_SCOPES).toHaveLength(6)
    await page.getByRole('button', { name: '插入变量', exact: true }).click()
    const variables = page.getByRole('listbox', { name: '可用变量', exact: true })
    await expect(variables).toBeVisible()
    expect((await variables.locator('.cm-completionLabel').allTextContents()).sort()).toEqual(TEMPLATE_VARIABLES.map(variable => `{{${variable.name}}}`).sort())
    await editor(page).press('Escape')
    const previewResponse = page.waitForResponse(response => response.url() === `${url}/api/authoring/preview`)
    await page.getByRole('button', { name: '查看已保存的组合', exact: true }).click()
    const preview = await (await previewResponse).json() as AgentPromptPreview
    expect(preview.layers.map(layer => layer.id)).toEqual(['common', 'subagent', alphaId, `persona:${created.persona.id}`])
    expect(preview.systemPrompt).toContain('OWNER original body')
    expect(preview.systemPrompt).toContain('PERSONA original body 原文人格 / Persona')
    expect(preview.bindings.主人).toContain('relay-owner')
    await post(page, `/plugins/${platformId}/disable`, {})
    await page.reload()
    await expect(toggle(page)).toContainText(platformName)
    await expect(toggle(page)).toContainText('已停用')
    await expect(editor(page)).toHaveAttribute('aria-readonly', 'false')
    await expect(page.getByRole('button', { name: '查看已保存的组合', exact: true })).toBeDisabled()
    await host!.close()
    host = undefined
    await uninstallPluginPackage(home, platformId)
    await startHost()
    await page.goto(`${url}/#prompts/${encodeURIComponent(alphaId)}`)
    await expect(editor(page)).toHaveText(ownerBody)
    await expect(editor(page)).toHaveAttribute('aria-readonly', 'true')
    await expect(toggle(page)).toHaveText(`${platformId}来源不可用`)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.authoring-source-detail')).toHaveText(`来源插件：${platformId}`)
    await toggle(page).click()
    const mutations: string[] = []
    page.on('request', request => { if (request.method() === 'POST') mutations.push(request.url()) })
    await page.route(`${url}/api/authoring`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_READ_FAILED', message: 'Temporary fixture read failure' } }) }), { times: 1 })
    await page.getByRole('button', { name: '重新读取提示词', exact: true }).click()
    await expect(page.locator('.authoring-notice-error')).toContainText('原草稿与保存版本均已保留')
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.authoring-notice-info')).toContainText('来源插件不可用')
    await expect(editor(page)).toHaveText(ownerBody)
    await expect(editor(page)).toHaveAttribute('aria-readonly', 'true')
    await expect(page).toHaveURL(`${url}/#prompts/${encodeURIComponent(alphaId)}`)
    const after = await snapshot(page)
    expect(after.prompts.find(doc => doc.id === alphaId)).toMatchObject({ id: alphaId, pluginId: platformId, title: original.title, body: ownerBody, available: false })
    expect(after.activePersonaId).toBe(created.persona.id)
    await page.screenshot({ path: testInfo.outputPath('unavailable-collapsed-platform.png') })
    await page.getByRole('link', { name: '人格管理', exact: true }).click()
    await expect(editor(page)).toHaveText(created.persona.body)
    await expect(page.locator('.authoring-active-badge')).toHaveText('使用中')
    await expect(page.getByLabel('人格名称', { exact: true })).toHaveValue(created.persona.name)
    expect(mutations).toEqual([])
  })

  test('短窗口目录独立滚动，390px展开仍是横向tray并在resize后保留编辑区', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto(`${url}/#prompts/${encodeURIComponent(alphaId)}`)
    await expect(editor(page)).toBeVisible()
    await toggle(page, 'qq').click()
    const sidebar = page.locator('.authoring-sidebar')
    const pane = page.locator('#main-content')
    const paneTop = await pane.evaluate(element => element.scrollTop)
    const bounds = (await sidebar.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + 70)
    await page.mouse.wheel(0, 900)
    await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await pane.evaluate(element => element.scrollTop)).toBe(paneTop)
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('short-window-platform-groups.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    const expandedHeight = (await sidebar.boundingBox())!.height
    expect(expandedHeight).toBeLessThanOrEqual(76)
    await toggle(page).click()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    expect(Math.abs((await sidebar.boundingBox())!.height - expandedHeight)).toBeLessThanOrEqual(1)
    await expect(page).toHaveURL(`${url}/#prompts/${encodeURIComponent(alphaId)}`)
    await editor(page).fill('手机保留的原文草稿 '.repeat(80) + '{{主人}}')
    const draft = await editor(page).innerText()
    await toggle(page).focus()
    await toggle(page).press('Space')
    await expect(children(page)).toBeVisible()
    expect(Math.abs((await sidebar.boundingBox())!.height - expandedHeight)).toBeLessThanOrEqual(1)
    expect((await pane.boundingBox())!.height).toBeGreaterThan(300)
    expect(await nav(page).evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    await page.evaluate(id => { window.location.hash = `prompts/${encodeURIComponent(id)}` }, zetaId)
    await expect(editor(page)).toContainText('ZETA original body')
    const selected = nav(page).locator('[aria-current="page"]')
    await expect.poll(async () => {
      const selectedBounds = (await selected.boundingBox())!
      const navBounds = (await nav(page).boundingBox())!
      return selectedBounds.x >= navBounds.x - 1 && selectedBounds.x + selectedBounds.width <= navBounds.x + navBounds.width + 1
    }).toBe(true)
    await selectAlpha(page)
    await expect(editor(page)).toHaveText(draft)
    expect(await page.evaluate(() => ({ root: document.documentElement.scrollWidth - innerWidth, top: document.scrollingElement!.scrollTop, pane: document.getElementById('main-content')!.scrollWidth - document.getElementById('main-content')!.clientWidth }))).toEqual({ root: 0, top: 0, pane: 0 })
    await page.screenshot({ path: testInfo.outputPath('390-expanded-platform-tray.png') })
    await page.setViewportSize({ width: 390, height: 420 })
    expect((await sidebar.boundingBox())!.height).toBeLessThanOrEqual(76)
    expect((await pane.boundingBox())!.height).toBeGreaterThan(120)
    await expect(editor(page)).toHaveText(draft)
    await page.screenshot({ path: testInfo.outputPath('390-short-platform-tray.png') })
    await editor(page).evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest' }))
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const shortPaneBounds = (await pane.boundingBox())!
    const editorBounds = (await editor(page).boundingBox())!
    expect(editorBounds.y).toBeGreaterThanOrEqual(shortPaneBounds.y - 1)
    expect(editorBounds.y).toBeLessThan(shortPaneBounds.y + shortPaneBounds.height - 60)
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
    await toggle(page).evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    await expect(toggle(page)).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('390-short-editor-and-platform-header.png') })
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(editor(page)).toHaveText(draft)
  })
})
