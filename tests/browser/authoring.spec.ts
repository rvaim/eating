import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthoringSnapshot, PersonaMutationResult } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectory = fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bodyEditor = (page: Page, persona = false) => page.getByRole('textbox', { name: persona ? '人格设定' : '提示词内容', exact: true })
const promptNav = (page: Page) => page.getByRole('navigation', { name: '提示词分类', exact: true })
const personaNav = (page: Page) => page.getByRole('navigation', { name: '人格列表', exact: true })

test.describe('提示词与人格的真实持久编辑', () => {
  test.setTimeout(45000)
  let directory: string | undefined
  let host: EatingHost | undefined
  let url: string
  let pageErrors: string[]

  test.beforeEach(async ({ page }) => {
    pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_authoring_browser_')))
    await installPluginPackage(directory, pluginDirectory)
    host = await createInstalledHost({ dataDirectory: directory, port: 0, allowedUiOrigins: [], staticDirectory: builtDirectory })
    url = await host.listen()
  })

  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      host = undefined
      if (directory) {
        const target = await realpath(directory)
        const temporaryRoot = await realpath(tmpdir())
        if (target !== resolve(directory) || dirname(target) !== temporaryRoot || !basename(target).startsWith('Eating_authoring_browser_')) throw new Error('拒绝删除未核对的测试目录')
        await rm(target, { recursive: true })
        directory = undefined
      }
    }
    expect(pageErrors).toEqual([])
  })

  async function snapshot(page: Page): Promise<AuthoringSnapshot> {
    const response = await page.request.get(`${url}/api/authoring`)
    expect(response.status()).toBe(200)
    return response.json() as Promise<AuthoringSnapshot>
  }

  async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
    const bootstrap = await page.request.get(`${url}/api/bootstrap`)
    expect(bootstrap.status()).toBe(200)
    const { csrfToken } = await bootstrap.json() as { csrfToken: string }
    const response = await page.request.post(`${url}/api${path}`, { headers: { 'X-Eating-Csrf': csrfToken }, data })
    expect(response.status()).toBe(path === '/personas' ? 201 : 200)
    return response.json() as Promise<T>
  }

  async function createPersona(page: Page, name: string, body: string): Promise<PersonaMutationResult> {
    await personaNav(page).getByRole('button', { name: '新增人格', exact: true }).click()
    await expect(page.getByRole('heading', { name: '新增人格', exact: true })).toBeVisible()
    await page.getByLabel('人格名称', { exact: true }).fill(name)
    await bodyEditor(page, true).fill(body)
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${url}/api/personas`)
    await page.getByRole('button', { name: '保存人格', exact: true }).click()
    const response = await saved
    expect(response.status()).toBe(201)
    const result = await response.json() as PersonaMutationResult
    expect(result.persona.id).toMatch(uuid)
    await expect(page).toHaveURL(`${url}/#personas/${result.persona.id}`)
    await expect(bodyEditor(page, true)).toHaveText(body)
    return result
  }

  test('三个提示词分类分别保留草稿并真实保存，刷新可恢复', async ({ page }, testInfo) => {
    await page.goto(`${url}/#overview`)
    await page.getByRole('link', { name: '提示词管理', exact: true }).click()
    await expect(bodyEditor(page)).toBeVisible()
    const entries = [
      { id: 'common', label: '通用前置提示词', body: '通用前置独立草稿 {{当前时间}}' },
      { id: 'subagent', label: '通用子代理前置', body: '子代理前置独立草稿 {{人格名称}}' },
      { id: 'main', label: '主 Agent 提示词', body: '主代理独立草稿 {{主人}}' },
    ] as const
    for (const entry of entries) {
      await promptNav(page).getByRole('button', { name: new RegExp(`^${entry.label}`) }).click()
      await expect(page).toHaveURL(`${url}/#prompts/${entry.id}`)
      await expect(page.getByRole('heading', { name: entry.label, exact: true })).toBeVisible()
      await bodyEditor(page).fill(entry.body)
    }
    for (const entry of entries) {
      await promptNav(page).getByRole('button', { name: new RegExp(`^${entry.label}`) }).click()
      await expect(page).toHaveURL(`${url}/#prompts/${entry.id}`)
      await expect(page.getByRole('heading', { name: entry.label, exact: true })).toBeVisible()
      await expect(bodyEditor(page)).toHaveText(entry.body)
      await page.getByRole('button', { name: '保存提示词', exact: true }).click()
      await expect(page.locator('.authoring-notice-success')).toHaveText('提示词已保存')
      await expect(page.getByRole('button', { name: '保存提示词', exact: true })).toBeDisabled()
    }
    await page.reload()
    for (const entry of entries) {
      await promptNav(page).getByRole('button', { name: new RegExp(`^${entry.label}`) }).click()
      await expect(page).toHaveURL(`${url}/#prompts/${entry.id}`)
      await expect(page.getByRole('heading', { name: entry.label, exact: true })).toBeVisible()
      await expect(bodyEditor(page)).toHaveText(entry.body)
    }
    const persisted = await snapshot(page)
    for (const entry of entries) expect(persisted.prompts.find(doc => doc.id === entry.id)).toMatchObject({ body: entry.body, revision: 1 })
    expect(persisted.personas).toEqual([])
    expect(persisted.activePersonaId).toBeNull()
    await page.screenshot({ path: testInfo.outputPath('authoring-desktop.png'), fullPage: true })
  })

  test('原生变量补全支持零后缀与Enter/Tab，闭合变量不重括号且撤销隔离文档', async ({ page }) => {
    await page.goto(`${url}/#prompts/main`)
    const editor = bodyEditor(page)
    await expect(editor).toBeVisible()
    await editor.fill('')
    await editor.pressSequentially('{{')
    await expect(page.getByRole('listbox', { name: '可用变量', exact: true })).toBeVisible()
    const enterVariable = await page.getByRole('listbox', { name: '可用变量', exact: true }).locator('[aria-selected="true"] .cm-completionLabel').innerText()
    await editor.press('Enter')
    await expect(editor).toHaveText(enterVariable)
    await expect(page.locator('.template-variable-valid')).toHaveText(enterVariable)
    await expect(page.locator('.template-variable-valid')).toHaveCSS('color', 'rgb(50, 99, 78)')
    await expect(page.getByRole('button', { name: '保存提示词', exact: true })).toBeEnabled()
    await editor.fill('')
    await editor.pressSequentially('{{')
    await expect(page.getByRole('listbox', { name: '可用变量', exact: true })).toBeVisible()
    const tabVariable = await page.getByRole('listbox', { name: '可用变量', exact: true }).locator('[aria-selected="true"] .cm-completionLabel').innerText()
    await editor.press('Tab')
    await expect(editor).toHaveText(tabVariable)
    await editor.fill('{{当前时间}}尾部')
    await editor.press('Home')
    for (let count = 0; count < 3; count++) await editor.press('ArrowRight')
    await page.getByRole('button', { name: '插入变量', exact: true }).click()
    await expect(page.getByRole('listbox', { name: '可用变量', exact: true })).toBeVisible()
    await editor.press('Enter')
    await expect(editor).toHaveText('{{当前时间}}尾部')
    await editor.fill('{{不存在的变量}}')
    await expect(page.locator('.template-variable-invalid')).toHaveText('{{不存在的变量}}')
    const dangerInk = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--color-danger-ink').trim()
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await expect(page.locator('.template-variable-invalid')).toHaveCSS('color', dangerInk)
    await expect(page.locator('.template-variable-invalid')).toHaveCSS('text-decoration-style', 'wavy')
    await expect(page.getByRole('button', { name: '保存提示词', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /定位变量错误 1/ })).toBeVisible()
    await editor.fill('主文档专属草稿')
    const groupBefore = (await snapshot(page)).prompts.find(doc => doc.id === 'agent:qq.group')!.body
    await promptNav(page).getByRole('button', { name: 'QQ', exact: true }).click()
    await promptNav(page).getByRole('button', { name: 'QQ 群聊', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'QQ 群聊', exact: true })).toBeVisible()
    await expect(editor).toHaveText(groupBefore, { useInnerText: true })
    await editor.press('ControlOrMeta+z')
    await expect(editor).toHaveText(groupBefore, { useInnerText: true })
    await editor.fill('群文档自己的修改')
    await editor.press('ControlOrMeta+z')
    await expect(editor).toHaveText(groupBefore, { useInnerText: true })
    await expect(editor).not.toContainText('主文档专属草稿')
    await promptNav(page).getByRole('button', { name: /^主 Agent 提示词/ }).click()
    await expect(editor).toHaveText('主文档专属草稿')
    await editor.press('ControlOrMeta+z')
    await expect(editor).toHaveText('主文档专属草稿')
  })

  test('两个人格真实创建且不自动启用，唯一启用、脏稿保护与确认删除生效', async ({ page }) => {
    let creates = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url() === `${url}/api/personas`) creates++ })
    await page.goto(`${url}/#personas`)
    await expect(page.getByRole('heading', { name: '还没有已保存的人格', exact: true })).toBeVisible()
    await expect(page.getByText('尚未保存人格', { exact: true })).toBeVisible()
    await expect(page.getByLabel('人格名称', { exact: true })).toHaveValue('')
    await expect(bodyEditor(page, true)).toHaveText('')
    expect(creates).toBe(0)
    const first = await createPersona(page, '人格甲', '人格甲保存的设定')
    const second = await createPersona(page, '人格乙', '人格乙保存的设定')
    expect(second.persona.id).not.toBe(first.persona.id)
    expect((await snapshot(page)).activePersonaId).toBeNull()
    expect((await snapshot(page)).personas).toHaveLength(2)
    await personaNav(page).getByRole('button', { name: '人格甲', exact: true }).click()
    await expect(bodyEditor(page, true)).toHaveText(first.persona.body)
    await page.getByRole('button', { name: '启用人格', exact: true }).click()
    await expect(personaNav(page).getByText('使用中', { exact: true })).toHaveCount(1)
    await expect.poll(async () => (await snapshot(page)).activePersonaId).toBe(first.persona.id)
    await personaNav(page).getByRole('button', { name: '人格乙', exact: true }).click()
    await expect(bodyEditor(page, true)).toHaveText(second.persona.body)
    await bodyEditor(page, true).fill('人格乙未保存的修改')
    await expect(page.getByRole('button', { name: '启用人格', exact: true })).toBeDisabled()
    await expect(page.getByText('请先保存修改，再启用人格。', { exact: true })).toBeVisible()
    await bodyEditor(page, true).fill(second.persona.body)
    await page.getByRole('button', { name: '启用人格', exact: true }).click()
    await expect.poll(async () => (await snapshot(page)).activePersonaId).toBe(second.persona.id)
    await expect(personaNav(page).getByText('使用中', { exact: true })).toHaveCount(1)
    await expect(personaNav(page).getByRole('button', { name: /人格乙/ })).toContainText('使用中')
    await expect(personaNav(page).getByRole('button', { name: /人格甲/ })).not.toContainText('使用中')
    await expect(page.getByRole('button', { name: '删除人格', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '停用人格', exact: true }).click()
    await expect.poll(async () => (await snapshot(page)).activePersonaId).toBeNull()
    await page.getByRole('button', { name: '删除人格', exact: true }).click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    expect((await snapshot(page)).personas).toHaveLength(2)
    await page.getByRole('button', { name: '删除人格', exact: true }).click()
    await page.getByRole('button', { name: '确认删除人格', exact: true }).click()
    await expect(page).toHaveURL(`${url}/#personas/new`)
    const after = await snapshot(page)
    expect(after.personas.map(persona => persona.id)).toEqual([first.persona.id])
    expect(after.activePersonaId).toBeNull()
    expect(creates).toBe(2)
    await expect(page.getByLabel('人格名称', { exact: true })).toHaveValue('')
  })

  test('409保留本地草稿与原版本，确认放弃后读取新版本才能再次保存', async ({ page }) => {
    let reads = 0
    const revisions: number[] = []
    page.on('request', request => {
      if (request.method() === 'GET' && request.url() === `${url}/api/authoring`) reads++
      if (request.method() === 'POST' && request.url() === `${url}/api/prompts/main`) revisions.push((request.postDataJSON() as { expectedRevision: number }).expectedRevision)
    })
    await page.goto(`${url}/#prompts/main`)
    await expect(bodyEditor(page)).toBeVisible()
    const original = (await snapshot(page)).prompts.find(doc => doc.id === 'main')!
    await bodyEditor(page).fill('本地草稿需要保留 {{当前时间}}')
    const external = await post<AuthoringSnapshot>(page, '/prompts/main', { expectedRevision: original.revision, body: '另一位置保存的正文' })
    const conflicting = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${url}/api/prompts/main`)
    await page.getByRole('button', { name: '保存提示词', exact: true }).click()
    expect((await conflicting).status()).toBe(409)
    await expect(page.locator('.authoring-result.authoring-notice-error')).toContainText('草稿与保存版本已保留')
    await expect(bodyEditor(page)).toHaveText('本地草稿需要保留 {{当前时间}}')
    await expect(page.getByRole('button', { name: '保存提示词', exact: true })).toBeDisabled()
    expect(revisions).toEqual([original.revision])
    const before = reads
    await page.getByRole('button', { name: '重新读取提示词', exact: true }).click()
    await expect(page.getByRole('button', { name: '放弃修改并重新读取', exact: true })).toBeVisible()
    expect(reads).toBe(before)
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(bodyEditor(page)).toHaveText('本地草稿需要保留 {{当前时间}}')
    await expect(page.getByRole('button', { name: '保存提示词', exact: true })).toBeDisabled()
    expect(reads).toBe(before)
    await page.getByRole('button', { name: '重新读取提示词', exact: true }).click()
    await page.getByRole('button', { name: '放弃修改并重新读取', exact: true }).click()
    await expect(bodyEditor(page)).toHaveText('另一位置保存的正文')
    expect(reads).toBe(before + 1)
    await bodyEditor(page).fill('确认重读后保存的新正文')
    await page.getByRole('button', { name: '保存提示词', exact: true }).click()
    await expect(page.locator('.authoring-notice-success')).toHaveText('提示词已保存')
    expect(revisions).toEqual([original.revision, external.prompts.find(doc => doc.id === 'main')!.revision])
    expect((await snapshot(page)).prompts.find(doc => doc.id === 'main')?.body).toBe('确认重读后保存的新正文')
  })

  test('人格甲真实GET迟到时切到乙，旧响应不能覆盖当前编辑内容', async ({ page }) => {
    const first = await post<PersonaMutationResult>(page, '/personas', { name: '慢读取人格甲', body: '人格甲的独立正文' })
    const second = await post<PersonaMutationResult>(page, '/personas', { name: '即时人格乙', body: '人格乙的独立正文' })
    let release!: () => void
    let entered!: () => void
    let delivered!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const pending = new Promise<void>(resolveEntered => { entered = resolveEntered })
    const finished = new Promise<void>(resolveDelivered => { delivered = resolveDelivered })
    await page.route(`**/api/personas/${first.persona.id}`, async route => {
      const response = await route.fetch()
      entered()
      await gate
      // Switching documents aborts this request; a cancelled browser route may reject delivery.
      try { await route.fulfill({ response }) } catch { /* The cancelled response must not update the UI. */ }
      finally { delivered() }
    }, { times: 1 })
    try {
      await page.goto(`${url}/#personas/${first.persona.id}`)
      await pending
      await personaNav(page).getByRole('button', { name: /^即时人格乙/ }).click()
      await expect(bodyEditor(page, true)).toHaveText(second.persona.body)
      await bodyEditor(page, true).fill('人格乙当前未保存的草稿')
      release()
      await finished
      await expect(page).toHaveURL(`${url}/#personas/${second.persona.id}`)
      await expect(page.getByLabel('人格名称', { exact: true })).toHaveValue('即时人格乙')
      await expect(bodyEditor(page, true)).toHaveText('人格乙当前未保存的草稿')
      await personaNav(page).getByRole('button', { name: '慢读取人格甲', exact: true }).click()
      await expect(bodyEditor(page, true)).toHaveText(first.persona.body)
      await personaNav(page).getByRole('button', { name: /^即时人格乙/ }).click()
      await expect(bodyEditor(page, true)).toHaveText('人格乙当前未保存的草稿')
      expect((await snapshot(page)).activePersonaId).toBeNull()
    } finally { release() }
  })

  test('390px长正文、人格名称与原生候选浮层均不横向溢出', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${url}/#prompts/agent%3Aqq.group`)
    const editor = bodyEditor(page)
    await expect(editor).toBeVisible()
    await editor.fill('连续窄屏正文'.repeat(100))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await editor.fill('')
    await editor.pressSequentially('{{')
    const candidates = page.getByRole('listbox', { name: '可用变量', exact: true })
    await expect(candidates).toBeVisible()
    const bounds = await candidates.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const selectedVariable = await candidates.locator('[aria-selected="true"] .cm-completionLabel').innerText()
    await page.screenshot({ path: testInfo.outputPath('authoring-mobile-completion.png'), fullPage: true })
    await editor.press('Enter')
    await expect(editor).toHaveText(selectedVariable)
    const persona = await post<PersonaMutationResult>(page, '/personas', { name: '窄屏人格'.repeat(20), body: '窄屏人格设定 {{当前时间}}' })
    await page.getByRole('link', { name: '人格管理', exact: true }).click()
    await expect(page).toHaveURL(`${url}/#personas/${persona.persona.id}`)
    await expect(bodyEditor(page, true)).toHaveText(persona.persona.body)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('authoring-mobile-persona.png'), fullPage: true })
  })
})
