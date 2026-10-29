import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_VARIABLES, getPromptTemplateScope } from '@eating/plugin-sdk'
import type { AgentPromptPreview, AuthoringSnapshot, JsonObject, PersonaMutationResult, PromptDocument } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage, uninstallPluginPackage } from '../../apps/host/src/plugin-installation'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url))
const editor = (page: Page) => page.locator('.template-editor [role="textbox"]')
const navigation = (page: Page) => page.locator('.authoring-sidebar nav')
const chooseLanguage = async (page: Page, locale: 'zh-CN' | 'en-US') => {
  await page.getByRole('combobox', { name: /^(界面语言|Display language)$/ }).selectOption(locale)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
}

// Each case uses its own installed plugin and temporary Host; no model or OneBot connection is started.
test.describe('动态代理提示词与已保存组合', () => {
  test.setTimeout(45000)
  let home: string
  let host: EatingHost | undefined
  let url: string
  let errors: string[]

  const startHost = async () => {
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  }
  test.beforeEach(async ({ page }) => {
    errors = []
    page.on('pageerror', error => errors.push(error.message))
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_agent_prompts_browser_')))
    await installPluginPackage(home, pluginDirectory)
    await startHost()
    await page.request.get(`${url}/api/bootstrap`)
  })
  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      host = undefined
      const target = await realpath(home)
      if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_agent_prompts_browser_')) throw new Error('Unsafe Agent prompt test cleanup')
      await rm(target, { recursive: true })
    }
    expect(errors).toEqual([])
  })

  async function snapshot(page: Page): Promise<AuthoringSnapshot> {
    const response = await page.request.get(`${url}/api/authoring`)
    expect(response.status()).toBe(200)
    return response.json() as Promise<AuthoringSnapshot>
  }
  async function post<T>(page: Page, path: string, data: unknown, status = 200): Promise<T> {
    const bootstrap = await page.request.get(`${url}/api/bootstrap`)
    const { csrfToken } = await bootstrap.json() as { csrfToken: string }
    const response = await page.request.post(`${url}/api${path}`, { headers: { 'X-Eating-Csrf': csrfToken }, data })
    expect(response.status(), path).toBe(status)
    return response.json() as Promise<T>
  }
  async function save(page: Page) {
    await page.getByRole('button', { name: /^(保存提示词|Save prompt)$/ }).click()
    await expect(page.locator('.authoring-result.authoring-notice-success')).toBeVisible()
  }
  async function expandPlatform(page: Page, pluginId: string) {
    const toggle = navigation(page).locator(`.authoring-platform-group[data-plugin-id="${pluginId}"] > button`)
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  async function choose(page: Page, document: PromptDocument) {
    if (document.pluginId) await expandPlatform(page, document.pluginId)
    await navigation(page).getByRole('button', { name: document.localizedTitles?.['zh-CN'] ?? document.title, exact: true }).click()
    await expect(page).toHaveURL(`${url}/#prompts/${encodeURIComponent(document.id)}`)
    await expect(editor(page)).toHaveText(document.body, { useInnerText: true })
  }
  async function savedPreview(page: Page): Promise<AgentPromptPreview> {
    const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${url}/api/authoring/preview`)
    await page.getByRole('button', { name: /^(查看已保存的组合|View saved combination)$/ }).click()
    const result = await response
    expect(result.status()).toBe(200)
    const data = await result.json() as AgentPromptPreview
    await expect(page.locator('.authoring-preview-result')).toBeVisible()
    return data
  }

  test('真实插件贡献生成目录；停用仍可编辑，卸载后保留主人正文并只读', async ({ page }, testInfo) => {
    const initial = await snapshot(page)
    expect(initial.prompts.filter(doc => ['common', 'subagent', 'main'].includes(doc.id))).toHaveLength(3)
    expect(initial).not.toHaveProperty('legacyPrompts')
    const agents = initial.prompts.filter(doc => getPromptTemplateScope(doc.id) === 'agent')
    const instructions = initial.prompts.filter(doc => getPromptTemplateScope(doc.id) === 'plugin')
    expect(agents.length).toBeGreaterThanOrEqual(2)
    expect(instructions.length).toBeGreaterThan(0)
    expect(agents.every(doc => doc.source === 'plugin' && doc.pluginId && doc.agentTypeId && doc.available)).toBe(true)
    await page.goto(`${url}/#prompts/common`)
    await expect(editor(page)).toBeVisible()
    for (const document of [...instructions, ...agents]) await choose(page, document)
    await expect(navigation(page).getByRole('group', { name: '公共', exact: true })).toBeVisible()
    await expect(navigation(page).getByRole('group', { name: '旧消息输入模板', exact: true })).toHaveCount(0)
    const selected = agents[0]!
    await choose(page, selected)
    const body = 'Owner overlay kept across plugin removal {{主人}}'
    await editor(page).fill(body)
    await save(page)
    await post(page, `/plugins/${selected.pluginId}/disable`, {})
    await page.reload()
    await expect(editor(page)).toHaveAttribute('aria-readonly', 'false')
    await expect(page.locator('#main-content')).toContainText('可以编辑提示词')
    await expect(page.getByRole('button', { name: '查看已保存的组合', exact: true })).toBeDisabled()
    await editor(page).fill(body + ' disabled edit')
    await save(page)
    await host!.close()
    host = undefined
    await uninstallPluginPackage(home, selected.pluginId!)
    await startHost()
    await page.goto(`${url}/#prompts/${encodeURIComponent(selected.id)}`)
    await expect(editor(page)).toHaveText(body + ' disabled edit')
    await expect(editor(page)).toHaveAttribute('aria-readonly', 'true')
    await expect(page.getByRole('button', { name: '保存提示词', exact: true })).toBeDisabled()
    await expect(page.locator('#main-content')).toContainText('恢复插件后可继续编辑')
    await page.screenshot({ path: testInfo.outputPath('unavailable-source.png') })
  })

  test('仅显示当前目录；旧格式明确报错且不覆盖存储，QQ 页面可独立使用', async ({ page }) => {
    await page.goto(`${url}/#prompts/common`)
    await expect(editor(page)).toBeVisible()
    expect((await snapshot(page)).prompts.every(doc => ['common', 'subagent', 'main', 'agent', 'plugin'].includes(doc.scope))).toBe(true)
    await expect(navigation(page).getByRole('group', { name: '旧消息输入模板', exact: true })).toHaveCount(0)
    const data = { schemaVersion: 1, revision: 0, prompts: ['main', 'group', 'private'].map(id => ({ id, title: `旧 ${id}`, body: `旧正文 ${id}`, revision: 0, updatedAt: null })), personas: [], activePersonaId: null }
    const latest = { schemaVersion: 2, revision: 0, prompts: (await snapshot(page)).prompts.filter(doc => doc.source === 'owner').map(({ id, title, body, revision, updatedAt, scope, source }) => ({ id, title, body, revision, updatedAt, scope, source })), personas: [], activePersonaId: null }
    const mutations: string[] = []
    page.on('request', request => { if (request.method() === 'POST') mutations.push(request.url()) })
    for (const unsupported of [data, { ...latest, legacyPrompts: [] }]) {
      const raw = JSON.stringify(unsupported, null, 2) + '\n'
      host!.store.setSetting('host:authoring', raw)
      const failed = page.waitForResponse(response => response.url() === `${url}/api/authoring`)
      await page.reload()
      expect((await failed).status()).toBe(500)
      await expect(page.locator('.authoring-notice-error')).toContainText('原数据未被覆盖')
      await expect(editor(page)).toHaveCount(0)
      await expect(navigation(page).getByRole('button')).toHaveCount(0)
      expect(host!.store.getSetting('host:authoring')).toBe(raw)
      const reloaded = page.waitForResponse(response => response.url() === `${url}/api/authoring`)
      await page.getByRole('button', { name: '重新读取提示词', exact: true }).click()
      expect((await reloaded).status()).toBe(500)
      await expect(page.locator('.authoring-notice-error')).toContainText('原数据未被覆盖')
      expect(host!.store.getSetting('host:authoring')).toBe(raw)
      await page.goto(`${url}/#robots/qq`)
      await expect(page.getByLabel('显示名称', { exact: true })).toBeVisible()
      expect((await page.request.get(`${url}/api/plugins/qq/configuration`)).status()).toBe(200)
      expect(host!.store.getSetting('host:authoring')).toBe(raw)
      await page.goto(`${url}/#prompts/common`)
      await expect(page.locator('.authoring-notice-error')).toContainText('原数据未被覆盖')
    }
    expect(mutations).toEqual([])
  })

  test('保存 CAS 保留冲突草稿，预览仅组合已保存规则与同一人格及受信身份列表', async ({ page }, testInfo) => {
    const configurationResponse = await page.request.get(`${url}/api/plugins/qq/configuration`)
    const configuration = await configurationResponse.json() as JsonObject
    await post(page, '/plugins/qq/manage', { operation: 'save-agent-policy', input: {
      expectedRevision: configuration.policyRevision, owners: ['10001', '10002'], administrators: ['20001', '20002'], agentTools: configuration.agentTools,
    } })
    const persona = await post<PersonaMutationResult>(page, '/personas', { name: 'Shared owner persona', body: 'SHARED_PERSONA_BODY' }, 201)
    await post(page, `/personas/${persona.persona.id}/activate`, { expectedRevision: persona.snapshot.revision, enabled: true })
    let current = await snapshot(page)
    const common = current.prompts.find(doc => doc.id === 'common')!
    await post(page, '/prompts/common', { expectedRevision: common.revision, body: 'SAVED_COMMON owners={{主人}} admins={{管理员}} persona={{人格名称}}' })
    await page.goto(`${url}/#prompts/main`)
    await expect(editor(page)).toBeVisible()
    current = await snapshot(page)
    const main = current.prompts.find(doc => doc.id === 'main')!
    const draft = 'UNSAVED_MAIN_DRAFT {{主人}}'
    await editor(page).fill(draft)
    await post(page, '/prompts/main', { expectedRevision: main.revision, body: 'OTHER_SAVED_MAIN' })
    const conflicting = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${url}/api/prompts/main`)
    await page.getByRole('button', { name: '保存提示词', exact: true }).click()
    expect((await conflicting).status()).toBe(409)
    await expect(editor(page)).toHaveText(draft)
    await expect(page.locator('.authoring-result.authoring-notice-error')).toContainText('草稿与保存版本已保留')
    const preview = await savedPreview(page)
    expect(preview.systemPrompt).toContain('OTHER_SAVED_MAIN')
    expect(preview.systemPrompt).not.toContain('UNSAVED_MAIN_DRAFT')
    expect(preview.systemPrompt).not.toContain('{{消息内容}}')
    expect(String(preview.bindings.主人)).toContain('10001')
    expect(String(preview.bindings.主人)).toContain('10002')
    expect(String(preview.bindings.管理员)).toContain('20001')
    expect(String(preview.bindings.管理员)).toContain('20002')
    expect(preview.layers.filter(layer => layer.id.startsWith('persona:')).map(layer => layer.id)).toEqual([`persona:${persona.persona.id}`])
    await expect(page.locator('.authoring-preview')).toContainText('预览仅使用已保存内容')
    await page.getByRole('button', { name: '重新读取提示词', exact: true }).click()
    await page.getByRole('button', { name: '放弃修改并重新读取', exact: true }).click()
    await expect(editor(page)).toHaveText('OTHER_SAVED_MAIN')
    await editor(page).fill('OWNER_SAVED_MAIN')
    await save(page)
    expect((await savedPreview(page)).systemPrompt).toContain('OWNER_SAVED_MAIN')
    const role = (await snapshot(page)).prompts.find(doc => getPromptTemplateScope(doc.id) === 'agent')!
    await choose(page, role)
    const child = await savedPreview(page)
    expect(child.layers.map(layer => layer.id)).toContain('subagent')
    expect(child.layers.map(layer => layer.id)).not.toContain('main')
    expect(child.layers.filter(layer => layer.id.startsWith('persona:')).map(layer => layer.id)).toEqual([`persona:${persona.persona.id}`])
    expect(child.systemPrompt).not.toContain('OWNER_SAVED_MAIN')
    await page.locator('.authoring-preview').evaluate(element => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: testInfo.outputPath('saved-child-combination.png') })
    await chooseLanguage(page, 'en-US')
    await expect(page.locator('.authoring-preview-layer').filter({ hasText: role.id }).locator('summary')).toContainText(role.localizedTitles?.['en-US'] ?? role.title)
    await page.screenshot({ path: testInfo.outputPath('english-saved-child-combination.png') })
  })

  test('公共、子代理、插件与代理作用域按 SDK 提供受信变量补全并隔离文档撤销', async ({ page }) => {
    const index = await snapshot(page)
    const role = index.prompts.find(doc => getPromptTemplateScope(doc.id) === 'agent')!
    const instruction = index.prompts.find(doc => getPromptTemplateScope(doc.id) === 'plugin')!
    await page.goto(`${url}/#prompts/common`)
    await expect(editor(page)).toBeVisible()
    const cases = [index.prompts.find(doc => doc.id === 'common')!, index.prompts.find(doc => doc.id === 'subagent')!, instruction, role]
    for (const document of cases) {
      if (document.id === 'common' || document.id === 'subagent') await navigation(page).getByRole('button', { name: document.id === 'common' ? '通用前置提示词' : '通用子代理前置', exact: true }).click()
      else await choose(page, document)
      await expect(page).toHaveURL(`${url}/#prompts/${encodeURIComponent(document.id)}`)
      await expect(editor(page)).toHaveText(document.body, { useInnerText: true })
      await editor(page).fill('')
      await expect(editor(page)).toHaveText('')
      await editor(page).pressSequentially('{{')
      const list = page.getByRole('listbox', { name: '可用变量', exact: true })
      await expect(list).toBeVisible()
      const scope = getPromptTemplateScope(document.id)!
      expect((await list.locator('.cm-completionLabel').allTextContents()).sort()).toEqual(TEMPLATE_VARIABLES.filter(variable => variable.scopes.includes(scope)).map(variable => `{{${variable.name}}}`).sort())
      await list.getByRole('option').filter({ hasText: '{{主人}}' }).click()
      await expect(editor(page)).toHaveText('{{主人}}')
      await expect(page.locator('.template-variable-invalid')).toHaveCount(0)
    }
    await navigation(page).getByRole('button', { name: /^通用前置提示词/ }).click()
    await expect(editor(page)).toHaveText('{{主人}}')
    await editor(page).press('ControlOrMeta+z')
    await expect(editor(page)).toHaveText('{{主人}}')
    expect((await snapshot(page)).prompts.find(doc => doc.id === role.id)?.body).toBe(role.body)
  })

  test('短窗口的独立目录滚动和语言切换保留草稿，390px长文本无溢出或写请求', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto(`${url}/#prompts/common`)
    await expect(editor(page)).toBeVisible()
    await expandPlatform(page, 'qq')
    await editor(page).fill('Language draft {{主人}} {{管理员}}')
    const mutations: string[] = []
    page.on('request', request => { if (request.method() === 'POST') mutations.push(request.url()) })
    const sidebar = page.locator('.authoring-sidebar')
    const pane = page.locator('#main-content')
    const paneTop = await pane.evaluate(element => element.scrollTop)
    const bounds = (await sidebar.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + 70)
    await page.mouse.wheel(0, 700)
    await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await pane.evaluate(element => element.scrollTop)).toBe(paneTop)
    const before = await sidebar.evaluate(element => element.scrollTop)
    await chooseLanguage(page, 'en-US')
    await expect(editor(page)).toHaveText('Language draft {{主人}} {{管理员}}')
    expect(before).toBeGreaterThan(0)
    expect(await sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await pane.evaluate(element => element.scrollTop)).toBe(paneTop)
    await expect(navigation(page).getByRole('group', { name: 'Shared', exact: true })).toHaveCount(1)
    for (const document of (await snapshot(page)).prompts.filter(doc => doc.localizedTitles?.['en-US'])) {
      await expect(navigation(page).getByRole('button', { name: document.localizedTitles!['en-US'], exact: true })).toHaveCount(1)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await editor(page).fill('Long mobile author content '.repeat(250) + '{{主人}}')
    await editor(page).press('ControlOrMeta+End')
    await page.getByRole('button', { name: 'Insert variable', exact: true }).click()
    const list = page.getByRole('listbox', { name: 'Available variables', exact: true })
    await expect(list).toBeVisible()
    const listBounds = (await list.boundingBox())!
    expect(listBounds.x).toBeGreaterThanOrEqual(0)
    expect(listBounds.x + listBounds.width).toBeLessThanOrEqual(391)
    expect(await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, documentTop: document.scrollingElement!.scrollTop, paneOverflow: document.getElementById('main-content')!.scrollWidth - document.getElementById('main-content')!.clientWidth }))).toEqual({ overflow: 0, documentTop: 0, paneOverflow: 0 })
    await page.screenshot({ path: testInfo.outputPath('390-english-agent-prompt.png') })
    expect(mutations).toEqual([])
  })
})
