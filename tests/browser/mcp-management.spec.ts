import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import type { EatingHost } from '../../apps/host/src/app'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
const tool = (name: string, title: string) => ({ name, title, description: `${title}的说明`, inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'json' as const })

function makeSnapshot() {
  return {
    protocolVersion: 1 as const,
    revision: 3,
    agentTypes: [{ id: 'main', title: '主 Agent' }, { id: 'qq.private', title: 'QQ 私聊' }, { id: 'qq.group', title: 'QQ 群聊' }],
    services: [
      { id: 'direct-stdio', name: '本地工具', source: { kind: 'direct' as const }, transport: 'stdio' as const, enabled: true, autoConnect: true, state: 'connected' as const, lastError: null,
        tools: [tool('local_lookup', '本地查询')], grant: { agentTypeIds: ['main'], toolNames: ['local_lookup'] },
        configuration: { command: 'npx', args: ['-y', 'fixture-mcp'], envKeys: ['API_KEY'] } },
      { id: 'direct-http', name: '远程 HTTP', source: { kind: 'direct' as const }, transport: 'streamable-http' as const, enabled: true, autoConnect: false, state: 'disconnected' as const, lastError: null,
        tools: [tool('remote_read', '远程读取')], grant: { agentTypeIds: [], toolNames: [] },
        configuration: { url: 'https://mcp.example.com/server', urlHasQuery: true, queryKeys: ['token'], headerKeys: ['Authorization'] } },
      { id: 'plugin-cap', name: '图片能力 MCP', source: { kind: 'plugin' as const, pluginId: 'dsh', pluginName: 'DeepSeek Harness' }, transport: 'plugin' as const, enabled: true, autoConnect: false, state: 'connected' as const, lastError: null,
        tools: [tool('describe_image', '描述图片')], grant: { agentTypeIds: ['main'], toolNames: ['describe_image'] },
        configuration: { pluginKind: 'capability', permissionsManagedByPlugin: false } },
      { id: 'plugin-qq', name: 'QQ 会话工具', source: { kind: 'plugin' as const, pluginId: 'qq', pluginName: 'QQ' }, transport: 'plugin' as const, enabled: true, autoConnect: false, state: 'connected' as const, lastError: null,
        tools: [tool('qq_send', '发送 QQ 消息')], grant: { agentTypeIds: ['qq.group'], toolNames: ['qq_send'] },
        configuration: { pluginKind: 'communication', permissionsManagedByPlugin: true } },
    ],
  }
}

test.describe('MCP 服务管理页', () => {
  test.setTimeout(45_000)
  let directory: string, host: EatingHost, url: string
  let snapshot: any
  let lastOperation: string | null, lastInput: Record<string, unknown> | null
  let failList: boolean, harnessStopped: boolean, errors: string[]

  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_mcp_ui_')))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [] }); url = await host.listen()
    snapshot = makeSnapshot(); lastOperation = null; lastInput = null; failList = false; harnessStopped = false; errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/mcp', async route => {
      const request = route.request()
      if (request.method() === 'GET') {
        if (failList) { await json(route, { error: { code: 'FIXTURE_MCP', message: 'MCP 读取失败', outcome: 'failed' } }, 500); return }
        await json(route, snapshot); return
      }
      const body = request.postDataJSON() as { operation: string; input: Record<string, unknown> }
      lastOperation = body.operation; lastInput = body.input
      if (body.operation === 'connect' || body.operation === 'disconnect') {
        const service = snapshot.services.find((entry: any) => entry.id === body.input.id)
        if (service) service.state = body.operation === 'connect' ? 'connected' : 'disconnected'
      } else if (body.operation === 'save-grants') {
        const service = snapshot.services.find((entry: any) => entry.id === body.input.id)
        if (service) service.grant = { agentTypeIds: body.input.agentTypeIds as string[], toolNames: body.input.toolNames as string[] }
      } else if (body.operation === 'delete') {
        snapshot.services = snapshot.services.filter((entry: any) => entry.id !== body.input.id)
      } else if (body.operation === 'save') {
        const configured = (urlValue: string) => { const parsed = new URL(urlValue); return { url: `${parsed.origin}${parsed.pathname}`, ...(parsed.search ? { urlHasQuery: true, queryKeys: [...parsed.searchParams.keys()] } : {}) } }
        const id = typeof body.input.id === 'string' ? body.input.id : `direct-created-${snapshot.services.length + 1}`
        const existing = snapshot.services.find((entry: any) => entry.id === id)
        const configuration = body.input.transport === 'stdio'
          ? { command: body.input.command, args: body.input.args ?? [], envKeys: Object.keys((body.input.env as Record<string, string>) ?? {}) }
          : { ...(typeof body.input.url === 'string' ? configured(body.input.url) : existing?.configuration ?? {}), headerKeys: Object.keys((body.input.headers as Record<string, string>) ?? {}) }
        const next = { id, name: body.input.name as string, source: { kind: 'direct' as const }, transport: body.input.transport as 'stdio' | 'streamable-http',
          enabled: true, autoConnect: body.input.autoConnect === true, state: existing?.state ?? 'disconnected', lastError: null, tools: existing?.tools ?? [],
          grant: body.input.grant as { agentTypeIds: string[]; toolNames: string[] }, configuration }
        if (existing) Object.assign(existing, next); else snapshot.services.push(next)
      }
      snapshot.revision += 1
      await json(route, harnessStopped && body.operation === 'save-grants' ? { ...snapshot, harnessStopped: true } : snapshot)
    })
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_mcp_ui_')) throw new Error('Unsafe MCP fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })

  async function goto(page: Page) {
    await page.goto(url + '/#mcp')
    await expect(page.getByRole('heading', { name: 'MCP', level: 1 })).toBeVisible()
  }
  async function open(page: Page) {
    await goto(page)
    await expect(page.getByText('本地工具', { exact: true })).toBeVisible()
  }
  const card = (page: Page, name: string) => page.locator('.mcp-service').filter({ has: page.getByRole('heading', { name, exact: true }) })

  test('区分直接接入与插件来源，通讯插件授权不能绕过机器人面板', async ({ page }, info) => {
    await open(page)
    await expect(page.getByText('直接接入', { exact: true }).first()).toBeVisible()
    await expect(card(page, 'QQ 会话工具').getByText('权限由通讯插件管理', { exact: false })).toBeVisible()
    await expect(card(page, 'QQ 会话工具').getByRole('button', { name: '编辑授权', exact: true })).toHaveCount(0)
    expect(await card(page, 'QQ 会话工具').getByRole('link', { name: '打开来源插件面板', exact: true }).getAttribute('href')).toBe('#robots/qq')
    await expect(card(page, '图片能力 MCP').getByRole('button', { name: '编辑授权', exact: true })).toBeVisible()
    await expect(card(page, '本地工具').getByRole('button', { name: '编辑配置', exact: true })).toBeDisabled()
    await expect(card(page, '本地工具').getByText('保存配置前请先断开此 MCP 服务。', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('super-secret-value')
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('super-secret-value')
    await page.screenshot({ path: info.outputPath('mcp-direct-and-plugin.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300)
    await page.screenshot({ path: info.outputPath('mcp-direct-and-plugin-dark.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(300)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath('mcp-direct-and-plugin-390.png'), fullPage: true })
  })

  test('直接 MCP 支持 stdio 与 HTTP 创建，HTTP 查询参数编辑留空保留', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: '添加直接接入', exact: true }).click()
    let editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('本地新工具')
    await editor.getByLabel('启动命令', { exact: true }).fill('uvx')
    await editor.getByLabel('命令参数', { exact: true }).fill('  fixture mcp  \n\n--stdio')
    await editor.getByRole('button', { name: '创建 MCP', exact: true }).click()
    await expect.poll(() => lastOperation).toBe('save')
    expect(lastInput).toMatchObject({ name: '本地新工具', transport: 'stdio', command: 'uvx', args: ['  fixture mcp  ', '', '--stdio'], autoConnect: false })
    expect(lastInput).not.toHaveProperty('url')

    await page.getByRole('button', { name: '添加直接接入', exact: true }).click()
    editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('HTTP 新工具')
    await editor.getByRole('radio', { name: 'Streamable HTTP', exact: true }).check()
    await editor.getByLabel('服务地址', { exact: true }).fill('https://mcp.example.com/mcp?token=private-query')
    await editor.getByRole('button', { name: '创建 MCP', exact: true }).click()
    await expect.poll(() => lastInput?.transport).toBe('streamable-http')
    expect(lastInput).toMatchObject({ name: 'HTTP 新工具', url: 'https://mcp.example.com/mcp?token=private-query' })

    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    editor = page.locator('.mcp-editor')
    const urlInput = editor.getByLabel('服务地址', { exact: true })
    await expect(urlInput).toHaveValue('')
    await expect(urlInput).toHaveAttribute('placeholder', /已保存：https:\/\/mcp\.example\.com\/server/)
    await expect(urlInput).toHaveAttribute('placeholder', /token/)
    await editor.getByLabel('名称', { exact: true }).fill('远程 HTTP')
    await editor.getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect.poll(() => lastOperation).toBe('save')
    expect(lastInput).not.toHaveProperty('url')
    await expect(page.locator('body')).not.toContainText('private-query')
  })

  test('授权保存返回 harnessStopped 时提示重启，普通配置保存需先断开', async ({ page }) => {
    harnessStopped = true
    await open(page)
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑授权', exact: true }).click()
    const picker = card(page, '远程 HTTP').locator('.mcp-grant-picker')
    await picker.getByRole('checkbox', { name: 'QQ 群聊', exact: true }).check()
    await card(page, '远程 HTTP').getByRole('button', { name: '保存授权', exact: true }).click()
    await expect.poll(() => lastOperation).toBe('save-grants')
    expect(lastInput).toMatchObject({ id: 'direct-http', expectedRevision: 3, agentTypeIds: ['qq.group'], toolNames: [] })
    await expect(page.getByText('授权/连接已更新，受影响 Harness 已停止，请重新启动。', { exact: true })).toBeVisible()
  })

  test('隐藏页面清空编辑中的密钥与带查询地址，保留非密钥草稿', async ({ page }) => {
    await open(page)
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('保留这个名称')
    await editor.getByLabel('服务地址', { exact: true }).fill('https://mcp.example.com/mcp?token=private-query')
    const headerValue = editor.locator('.mcp-kv-row').first().locator('input').nth(1)
    await headerValue.fill('Bearer private-header')
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留这个名称')
    await expect(editor.getByLabel('服务地址', { exact: true })).toHaveValue('')
    await expect(headerValue).toHaveValue('')
  })

  test('空态、错误态与 390px 可用', async ({ page }) => {
    snapshot.services = []
    await goto(page)
    await expect(page.getByText('还没有 MCP 服务', { exact: true })).toBeVisible()
    failList = true
    await page.getByRole('button', { name: '刷新服务', exact: true }).click()
    await expect(page.getByText('无法读取 MCP 服务。请检查 Eating 是否正在运行后重试。', { exact: true })).toBeVisible()
    failList = false
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.getByText('还没有 MCP 服务', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: 'test-results/mcp-empty-390.png', fullPage: true })
  })
})

test.describe('MCP 真实合同（临时 Host，无路由桩）', () => {
  test.setTimeout(90_000)
  let directory: string, host: EatingHost, url: string
  let errors: string[]
  const fixture = fileURLToPath(new URL('../fixtures/direct-mcp-stdio.mjs', import.meta.url))
  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_mcp_e2e_')))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false })
    url = await host.listen(); errors = []
    page.on('pageerror', error => errors.push(error.message))
  })
  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_mcp_e2e_')) throw new Error('Unsafe MCP E2E cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })
  test('真实 GET/POST 保存并连接 stdio MCP，工具与授权可读', async ({ page }, info) => {
    await page.goto(url + '/#mcp')
    await expect(page.getByRole('heading', { name: 'MCP', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: '添加直接接入', exact: true }).first().click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('SDK fixture')
    await editor.getByLabel('启动命令', { exact: true }).fill(process.execPath)
    await editor.getByLabel('命令参数', { exact: true }).fill(fixture)
    await editor.getByRole('button', { name: '创建 MCP', exact: true }).click()
    const card = page.locator('.mcp-service').filter({ hasText: 'SDK fixture' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: '连接', exact: true }).click()
    await expect(card.getByText('已连接', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await card.locator('.mcp-tools summary').click()
    await expect(card.getByText('Echo fixture', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: '编辑授权', exact: true }).click()
    await card.locator('.mcp-grant-picker').getByRole('checkbox', { name: /主 Agent/ }).check()
    await card.locator('.mcp-grant-picker').getByRole('checkbox', { name: /fixture_echo/ }).check()
    await card.getByRole('button', { name: '保存授权', exact: true }).click()
    await expect(page.getByText('MCP 授权已保存。', { exact: true }).first()).toBeVisible()
    const snapshot = await (await page.request.get(url + '/api/mcp')).json() as { services: { name: string; state: string; tools: { name: string }[]; grant: { agentTypeIds: string[]; toolNames: string[] } }[] }
    const service = snapshot.services.find(entry => entry.name === 'SDK fixture')!
    expect(service.state).toBe('connected')
    expect(service.tools.map(tool => tool.name)).toContain('fixture_echo')
    expect(service.grant.agentTypeIds).toContain('main')
    expect(service.grant.toolNames).toContain('fixture_echo')
    await page.screenshot({ path: info.outputPath('mcp-real-stdio.png'), fullPage: true })
    await card.getByRole('button', { name: '断开', exact: true }).click()
  })
})
