import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import type { EatingHost } from '../../apps/host/src/app'
import type { HarnessRemount } from '@eating/plugin-sdk'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
const tool = (name: string, title: string) => ({ name, title, description: `${title}的说明`, inputSchema: { type: 'object' }, readOnly: true, destructive: false, resultFormat: 'json' as const })
const chooseLanguage = async (page: Page, locale: 'zh-CN' | 'en-US') => {
  await page.getByRole('combobox', { name: /^(界面语言|Display language)$/ }).selectOption(locale)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
}

function makeSnapshot() {
  return {
    protocolVersion: 1 as const,
    revision: 3,
    harnessRemounts: [] as HarnessRemount[],
    agentTypes: [{ id: 'main', title: '主 Agent' }, { id: 'qq.private', title: 'QQ 私聊' }, { id: 'qq.group', title: 'QQ 群聊' }],
    services: [
      { id: 'direct-stdio', name: '本地工具', source: { kind: 'direct' as const }, transport: 'stdio' as const, enabled: true, autoConnect: true, state: 'connected' as const, lastError: null,
        tools: [tool('local_lookup', '本地查询')], grant: { agentTypeIds: ['main', 'qq.private', 'qq.group'], toolNames: ['local_lookup'] },
        configuration: { command: 'npx', args: ['-y', 'fixture-mcp'], envKeys: ['API_KEY'] } },
      { id: 'direct-http', name: '远程 HTTP', source: { kind: 'direct' as const }, transport: 'streamable-http' as const, enabled: true, autoConnect: false, state: 'disconnected' as const, lastError: null,
        tools: [tool('remote_read', '远程读取')], grant: { agentTypeIds: ['main', 'qq.private', 'qq.group'], toolNames: ['remote_read'] },
        configuration: { url: 'https://mcp.example.com/server', urlHasQuery: true, queryKeys: ['token'], headerKeys: ['Authorization'] } },
      { id: 'plugin-cap', name: '图片能力 MCP', source: { kind: 'plugin' as const, pluginId: 'dsh', pluginName: 'DeepSeek Harness' }, transport: 'plugin' as const, enabled: true, autoConnect: false, state: 'connected' as const, lastError: null,
        tools: [tool('describe_image', '描述图片')], grant: { agentTypeIds: ['main', 'qq.private', 'qq.group'], toolNames: ['describe_image'] },
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
  let failList: boolean, failMutation: boolean, harnessStopped: boolean, errors: string[], readCount: number, writeCount: number

  // The grant DTO is a catalog summary; it is always derived from the current catalog.
  function summarize() {
    for (const service of snapshot.services) {
      if (service.configuration.permissionsManagedByPlugin === true) continue
      service.grant = { agentTypeIds: snapshot.agentTypes.map((entry: any) => entry.id), toolNames: service.tools.map((entry: any) => entry.name) }
    }
  }

  test.beforeEach(async ({ page }) => {
    errors = []
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_mcp_ui_')))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [], autoConnectOnStartup: false }); url = await host.listen()
    snapshot = makeSnapshot(); lastOperation = null; lastInput = null; failList = false; failMutation = false; harnessStopped = false; errors = []; readCount = 0; writeCount = 0
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/mcp', async route => {
      const request = route.request()
      if (request.method() === 'GET') {
        readCount++
        if (failList) { await json(route, { error: { code: 'FIXTURE_MCP', message: 'MCP 读取失败', outcome: 'failed' } }, 500); return }
        summarize(); await json(route, snapshot); return
      }
      const body = request.postDataJSON() as { operation: string; input: Record<string, unknown> }
      lastOperation = body.operation; lastInput = body.input; writeCount++
      if (failMutation) {
        await json(route, { error: { code: 'FIXTURE_MCP_OPERATION', message: 'MCP fixture operation failed', outcome: 'failed' }, harnessStopped, harnessRemounts: snapshot.harnessRemounts }, 500); return
      }
      const input = body.input
      if (!['save', 'connect', 'disconnect', 'delete'].includes(body.operation)) {
        await json(route, { error: { code: 'INVALID_MCP_OPERATION', message: 'Unsupported MCP operation', outcome: 'failed' } }, 400); return
      }
      if (body.operation === 'save' || body.operation === 'delete') {
        if (input.expectedRevision !== snapshot.revision) {
          await json(route, { error: { code: 'MCP_REVISION_CONFLICT', message: 'Revision conflict', outcome: 'failed' } }, 409); return
        }
      }
      if (body.operation === 'connect' || body.operation === 'disconnect') {
        const service = snapshot.services.find((entry: any) => entry.id === input.id)
        if (service) service.state = body.operation === 'connect' ? 'connected' : 'disconnected'
      } else if (body.operation === 'delete') {
        snapshot.services = snapshot.services.filter((entry: any) => entry.id !== input.id)
      } else if (body.operation === 'save') {
        const allowed = ['expectedRevision', 'id', 'name', 'transport', 'autoConnect', ...(input.transport === 'stdio' ? ['command', 'args', 'env', 'clearEnvKeys'] : ['url', 'headers', 'clearHeaderKeys'])]
        if (Object.keys(input).some(key => !allowed.includes(key))) {
          await json(route, { error: { code: 'INVALID_MCP_CONFIG', message: 'Unexpected MCP field', outcome: 'failed' } }, 400); return
        }
        const configured = (urlValue: string) => { const parsed = new URL(urlValue); return { url: `${parsed.origin}${parsed.pathname}`, ...(parsed.search ? { urlHasQuery: true, queryKeys: [...parsed.searchParams.keys()] } : {}) } }
        const keys = (previous: string[], updates: unknown, cleared: unknown) => [...new Set([...previous, ...Object.keys((updates as Record<string, string>) ?? {})])].filter(key => !(Array.isArray(cleared) && cleared.includes(key)))
        const id = typeof input.id === 'string' ? input.id : `direct-created-${snapshot.services.length + 1}`
        const existing = snapshot.services.find((entry: any) => entry.id === id)
        const configuration = input.transport === 'stdio'
          ? { command: input.command, args: input.args ?? [], envKeys: keys(existing?.configuration.envKeys ?? [], input.env, input.clearEnvKeys) }
          : { ...(typeof input.url === 'string' ? configured(input.url) : existing?.configuration ?? {}), headerKeys: keys(existing?.configuration.headerKeys ?? [], input.headers, input.clearHeaderKeys) }
        const next = { id, name: input.name as string, source: { kind: 'direct' as const }, transport: input.transport as 'stdio' | 'streamable-http',
          enabled: true, autoConnect: input.autoConnect === true, state: existing?.state ?? 'disconnected', lastError: null, tools: existing?.tools ?? [],
          grant: { agentTypeIds: [], toolNames: [] }, configuration }
        if (existing) Object.assign(existing, next); else snapshot.services.push(next)
      }
      snapshot.revision += 1; summarize()
      await json(route, { ...snapshot, harnessStopped })
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
    await expect(page.locator('.mcp-service-slot:not([hidden])').getByRole('heading', { name: '本地工具', exact: true })).toBeVisible()
  }
  const select = async (page: Page, name: string) => { await page.getByRole('navigation', { name: 'MCP 服务', exact: true }).getByRole('button', { name, exact: true }).click() }
  const card = (page: Page, name: string) => page.locator('.mcp-service').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const noManualGrants = async (page: Page) => {
    await expect(page.getByRole('button', { name: /^(编辑授权|保存授权|Edit authorization|Save authorization)$/ })).toHaveCount(0)
    await expect(page.locator('.mcp-grant-picker')).toHaveCount(0)
  }

  test('默认全类型与全部工具摘要只读，功能插件和直接来源无需手工授权', async ({ page }) => {
    await open(page)
    for (const name of ['本地工具', '远程 HTTP', '图片能力 MCP']) {
      await select(page, name)
      const service = card(page, name)
      await expect(service.getByText('默认所有 Agent 可用', { exact: true })).toBeVisible()
      await expect(service.getByText('当前 Agent 类型：主 Agent / QQ 私聊 / QQ 群聊', { exact: true })).toBeVisible()
      await expect(service.getByText('当前全部工具（1）', { exact: true })).toBeVisible()
      await expect(service.getByText('新增 Agent 类型和工具会自动纳入，无需单独授权。', { exact: true })).toBeVisible()
      await noManualGrants(page)
      await expect(service.getByRole('checkbox')).toHaveCount(0)
    }
    expect(writeCount).toBe(0)
  })

  test('新来源、类型和动态新增工具读取后自动纳入，无授权保存请求', async ({ page }) => {
    await open(page)
    snapshot.agentTypes.push({ id: 'research', title: '资料研究' })
    snapshot.services[0].tools.push(tool('local_new_tool', '自动加入的新工具'))
    snapshot.services.push({ id: 'plugin-new', name: '新增功能来源', source: { kind: 'plugin', pluginId: 'new-capability', pluginName: '新插件' }, transport: 'plugin', enabled: true, autoConnect: false, state: 'connected', lastError: null,
      tools: [tool('new_capability_tool', '新来源工具')], grant: { agentTypeIds: [], toolNames: [] }, configuration: { pluginKind: 'capability', permissionsManagedByPlugin: false } })
    snapshot.revision++
    await page.getByRole('button', { name: '刷新服务', exact: true }).click()
    const local = card(page, '本地工具')
    await expect(local.getByText('当前 Agent 类型：主 Agent / QQ 私聊 / QQ 群聊 / 资料研究', { exact: true })).toBeVisible()
    await expect(local.getByText('当前全部工具（2）', { exact: true })).toBeVisible()
    await local.locator('.mcp-tools > summary').click()
    await expect(local.getByText('自动加入的新工具', { exact: true })).toBeVisible()
    await select(page, '新增功能来源')
    const added = card(page, '新增功能来源')
    await expect(added.getByText('默认所有 Agent 可用', { exact: true })).toBeVisible()
    await expect(added.getByText('当前 Agent 类型：主 Agent / QQ 私聊 / QQ 群聊 / 资料研究', { exact: true })).toBeVisible()
    await added.locator('.mcp-tools > summary').click()
    await expect(added.getByText('新来源工具', { exact: true })).toBeVisible()
    await noManualGrants(page); expect(writeCount).toBe(0)
  })

  test('二级目录固定，切换保留连接草稿与工具搜索，长目录内部滚动', async ({ page }, info) => {
    snapshot.services[0].tools.push(...Array.from({ length: 50 }, (_, index) => tool(`fixture_tool_${index}`, `目录工具 ${index}`)))
    await open(page); await expect(page.locator('.mcp-service:visible')).toHaveCount(1)
    await select(page, '远程 HTTP')
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('保留连接草稿')
    await editor.getByLabel('值（留空保留）', { exact: true }).fill('Bearer fixture-draft-secret')
    await select(page, '本地工具'); await expect(page.locator('.mcp-service:visible')).toHaveCount(1)
    const local = card(page, '本地工具')
    await local.locator('.mcp-tools > summary').click()
    const list = local.locator('.mcp-tools > ul'); await expect(list).toBeVisible()
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    expect((await list.boundingBox())!.height).toBeLessThanOrEqual(420)
    const sidebar = await page.locator('.mcp-sidebar').boundingBox(); await list.evaluate(element => { element.scrollTop = element.scrollHeight }); expect((await page.locator('.mcp-sidebar').boundingBox())!.y).toBe(sidebar!.y)
    await local.getByLabel('搜索当前服务工具', { exact: true }).fill('fixture_tool_49'); await expect(list.locator('li')).toHaveCount(1)
    await select(page, '远程 HTTP')
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留连接草稿')
    await expect(editor.getByLabel('值（留空保留）', { exact: true })).toHaveValue('Bearer fixture-draft-secret')
    await select(page, '本地工具')
    await expect(local.getByLabel('搜索当前服务工具', { exact: true })).toHaveValue('fixture_tool_49')
    await noManualGrants(page); expect(writeCount).toBe(0)
    await page.screenshot({ path: info.outputPath('mcp-two-pane-search.png') })
  })

  test('宽屏边界和已连接编辑提示保留，窄屏无横向溢出', async ({ page }, info) => {
    await page.setViewportSize({ width: 2560, height: 1100 }); await open(page)
    const local = card(page, '本地工具')
    const box = await local.boundingBox(); expect(box!.width).toBeLessThanOrEqual(1200)
    const edit = local.getByRole('button', { name: '编辑配置', exact: true }); await edit.locator('..').hover()
    await expect(page.getByRole('tooltip')).toContainText('先断开')
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).not.toBeVisible()
    await edit.locator('..').focus(); await expect(page.getByRole('tooltip')).toBeVisible()
    const accessBox = await local.locator('.mcp-block-access').boundingBox(); expect(accessBox!.width).toBeGreaterThan(box!.width * .85)
    await noManualGrants(page)
    await page.screenshot({ path: info.outputPath('mcp-wide-default-access.png') })
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.locator('.mcp-page').evaluate(element => { element.scrollTop = element.scrollHeight })
    const toolbar = await page.locator('.mcp-toolbar').boundingBox(), main = await page.locator('.mcp-page').boundingBox()
    expect(Math.abs(toolbar!.y - main!.y)).toBeLessThan(1)
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await page.locator('.mcp-sidebar').boundingBox())!.height).toBeLessThanOrEqual(70)
    expect((await page.locator('.mcp-sidebar-add').boundingBox())!.height).toBeLessThanOrEqual(48)
  })

  test('通讯服务仍由原插件管理，功能来源默认开放且秘密不回显', async ({ page }, info) => {
    await open(page)
    await expect(page.getByText('直接接入', { exact: true }).first()).toBeVisible()
    await select(page, 'QQ 会话工具')
    const communication = card(page, 'QQ 会话工具')
    await expect(communication.getByText('此服务的权限由通讯插件管理，请到“QQ”的机器人面板授权。', { exact: true })).toBeVisible()
    await expect(communication.getByText('默认所有 Agent 可用', { exact: true })).toHaveCount(0)
    expect(await communication.getByRole('link', { name: '打开来源插件面板', exact: true }).getAttribute('href')).toBe('#robots/qq')
    await expect(communication.getByRole('button', { name: '连接', exact: true })).toHaveCount(0)
    await expect(communication.getByRole('button', { name: '编辑配置', exact: true })).toHaveCount(0)
    await noManualGrants(page)
    await select(page, '图片能力 MCP')
    await expect(card(page, '图片能力 MCP').getByText('默认所有 Agent 可用', { exact: true })).toBeVisible()
    expect(await card(page, '图片能力 MCP').getByRole('link', { name: '打开来源插件面板', exact: true }).getAttribute('href')).toBe('#plugins/dsh')
    await select(page, '本地工具')
    await expect(card(page, '本地工具').getByRole('button', { name: '编辑配置', exact: true })).toBeDisabled()
    await expect(card(page, '本地工具').getByRole('paragraph').filter({ hasText: '保存配置前请先断开此 MCP 服务。' })).toBeVisible()
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('fixture-draft-secret')
    await page.screenshot({ path: info.outputPath('mcp-direct-and-plugin.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: info.outputPath('mcp-direct-and-plugin-dark.png'), fullPage: true, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 390, height: 844 })
    await select(page, 'QQ 会话工具')
    await page.screenshot({ path: info.outputPath('mcp-communication-390.png'), fullPage: true })
    expect(writeCount).toBe(0)
  })

  test('未连接与停用服务如实显示不可调用，连接成功后生效', async ({ page }) => {
    snapshot.services[2].enabled = false
    await open(page); await select(page, '图片能力 MCP')
    await expect(card(page, '图片能力 MCP').getByText('已停用', { exact: true })).toBeVisible()
    await expect(card(page, '图片能力 MCP').getByText('启用并连接后生效；当前无法调用此服务。', { exact: true })).toBeVisible()
    await select(page, '远程 HTTP')
    const remote = card(page, '远程 HTTP')
    await expect(remote.getByText('未连接', { exact: true }).first()).toBeVisible()
    await expect(remote.getByText('启用并连接后生效；当前无法调用此服务。', { exact: true })).toBeVisible()
    await remote.getByRole('button', { name: '连接', exact: true }).click()
    await expect(remote.getByText('服务已启用并连接，当前目录中的工具可用。', { exact: true })).toBeVisible()
    expect(lastOperation).toBe('connect'); expect(lastInput).toEqual({ id: 'direct-http' })
  })

  test('直接 MCP 支持 stdio 与 HTTP 创建，精确提交连接字段与当前 CAS', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: '添加直接接入', exact: true }).click()
    let editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('本地新工具')
    await editor.getByLabel('启动命令', { exact: true }).fill('uvx')
    await editor.getByLabel('命令参数', { exact: true }).fill('  fixture mcp  \n\n--stdio')
    await editor.getByRole('button', { name: '创建 MCP', exact: true }).click()
    await expect(card(page, '本地新工具')).toBeVisible()
    expect(lastInput).toEqual({ expectedRevision: 3, name: '本地新工具', transport: 'stdio', command: 'uvx', args: ['  fixture mcp  ', '', '--stdio'], autoConnect: false })
    await expect(card(page, '本地新工具').getByText('默认所有 Agent 可用', { exact: true })).toBeVisible()
    await expect(card(page, '本地新工具').getByText('未连接', { exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: '添加直接接入', exact: true }).click()
    editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('HTTP 新工具')
    await editor.getByRole('radio', { name: 'Streamable HTTP', exact: true }).check()
    await editor.getByLabel('服务地址', { exact: true }).fill('https://mcp.example.com/mcp?token=private-query')
    await editor.getByRole('button', { name: '创建 MCP', exact: true }).click()
    await expect(card(page, 'HTTP 新工具')).toBeVisible()
    expect(lastInput).toEqual({ expectedRevision: 4, name: 'HTTP 新工具', transport: 'streamable-http', url: 'https://mcp.example.com/mcp?token=private-query', autoConnect: false })
    await expect(page.locator('body')).not.toContainText('private-query')
    await noManualGrants(page)
  })

  test('编辑省略已保存秘密与查询地址，只有明确清除才提交删除', async ({ page }) => {
    await open(page); await select(page, '远程 HTTP')
    const remote = card(page, '远程 HTTP')
    await remote.getByRole('button', { name: '编辑配置', exact: true }).click()
    let editor = page.locator('.mcp-editor')
    const urlInput = editor.getByLabel('服务地址', { exact: true })
    await expect(urlInput).toHaveValue('')
    await expect(urlInput).toHaveAttribute('placeholder', /已保存：https:\/\/mcp\.example\.com\/server/)
    await expect(urlInput).toHaveAttribute('placeholder', /token/)
    await editor.getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(lastInput).toEqual({ expectedRevision: 3, id: 'direct-http', name: '远程 HTTP', transport: 'streamable-http', autoConnect: false })
    await expect(remote.getByText('Authorization', { exact: true })).toBeVisible()
    await remote.getByRole('button', { name: '编辑配置', exact: true }).click()
    editor = page.locator('.mcp-editor')
    await editor.getByRole('checkbox', { name: '清除', exact: true }).check()
    await editor.getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(lastInput).toEqual({ expectedRevision: 4, id: 'direct-http', name: '远程 HTTP', transport: 'streamable-http', clearHeaderKeys: ['Authorization'], autoConnect: false })
    await expect(remote.getByText('Authorization', { exact: true })).toHaveCount(0)

    await select(page, '本地工具'); const local = card(page, '本地工具')
    await local.getByRole('button', { name: '断开', exact: true }).click()
    await local.getByRole('button', { name: '编辑配置', exact: true }).click()
    editor = page.locator('.mcp-editor')
    await expect(editor.getByLabel('值（留空保留）', { exact: true })).toHaveValue('')
    await editor.getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(lastInput).toEqual({ expectedRevision: 6, id: 'direct-stdio', name: '本地工具', transport: 'stdio', command: 'npx', args: ['-y', 'fixture-mcp'], autoConnect: true })
    await expect(local.getByText('API_KEY', { exact: true })).toBeVisible()
    await local.getByRole('button', { name: '编辑配置', exact: true }).click()
    await page.locator('.mcp-editor').getByRole('checkbox', { name: '清除', exact: true }).check()
    await page.locator('.mcp-editor').getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect(page.locator('.mcp-editor')).toHaveCount(0)
    expect(lastInput).toHaveProperty('clearEnvKeys', ['API_KEY']); expect(lastInput).not.toHaveProperty('grant')
    await expect(local.getByText('API_KEY', { exact: true })).toHaveCount(0)
  })

  test('连接草稿保留原 CAS，刷新后不会隐式覆盖新版配置', async ({ page }) => {
    await open(page); await select(page, '远程 HTTP')
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('冲突前的草稿')
    snapshot.revision++; snapshot.services[1].name = '外部更新的名称'
    await page.getByRole('button', { name: '刷新服务', exact: true }).click()
    await expect(card(page, '外部更新的名称')).toBeVisible()
    await editor.getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('配置已被其他操作修改，请重新读取后再试。')
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('冲突前的草稿')
    expect(lastInput).toMatchObject({ expectedRevision: 3, name: '冲突前的草稿' })
    expect(snapshot.services[1].name).toBe('外部更新的名称')
  })

  test('断开连接报告原运行 Harness 已自动恢复，移除仍需明确确认', async ({ page }) => {
    harnessStopped = true
    await open(page); const local = card(page, '本地工具')
    snapshot.harnessRemounts = [{ id: 'dsh-connected', status: 'reconnected' }]
    await local.getByRole('button', { name: '断开', exact: true }).click()
    const report = page.getByRole('status', { name: 'Harness 挂载结果', exact: true })
    await expect(report).toContainText('dsh-connected')
    await expect(report).toContainText('已按新工具目录自动恢复')
    await expect(page.locator('.mcp-page')).not.toContainText('请重新启动')
    expect(lastOperation).toBe('disconnect'); expect(writeCount).toBe(1)
    await local.getByRole('button', { name: '删除', exact: true }).click()
    expect(lastOperation).toBe('disconnect')
    await local.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(local).toHaveCount(0)
    expect(lastInput).toEqual({ id: 'direct-stdio', expectedRevision: 4 })
  })

  test('原停止实例没有重挂报告且保持停止，界面不发起 Harness 启动', async ({ page }) => {
    const harnessRequests: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/plugins\/[^/]+\/(connect|disconnect|operation)/.test(request.url())) harnessRequests.push(request.url()) })
    await open(page); await select(page, '远程 HTTP')
    await card(page, '远程 HTTP').getByRole('button', { name: '连接', exact: true }).click()
    const report = page.getByRole('status', { name: 'Harness 挂载结果', exact: true })
    await expect(report).toContainText('本次没有需要重挂的运行实例；已停止的 Harness 保持停止。')
    await expect(report).not.toContainText('已按新工具目录自动恢复')
    expect(writeCount).toBe(1); expect(harnessRequests).toEqual([])
  })

  test('GET 保留最近重挂成功失败取消结果，语言切换不请求或重做任务', async ({ page }, info) => {
    snapshot.harnessRemounts = [
      { id: 'dsh-ready', status: 'reconnected' },
      { id: 'dsh-failed', status: 'failed', code: 'HARNESS_CONNECTION_FAILED' },
      { id: 'dsh-owner-stopped', status: 'cancelled', code: 'HARNESS_REMOUNT_CANCELLED' },
    ]
    await open(page)
    let report = page.getByRole('status', { name: 'Harness 挂载结果', exact: true })
    await expect(report).toContainText('dsh-ready已按新工具目录自动恢复')
    await expect(report).toContainText('dsh-failed自动恢复失败，请检查 Harness 状态HARNESS_CONNECTION_FAILED')
    await expect(report).toContainText('dsh-owner-stopped自动恢复已取消HARNESS_REMOUNT_CANCELLED')
    await expect(report).toContainText('只恢复原先运行的实例一次；不自动重试或重做中断任务。')
    const reads = readCount
    await chooseLanguage(page, 'en-US')
    report = page.getByRole('status', { name: 'Harness mount results', exact: true })
    await expect(report).toContainText('Automatically restored with the new tool catalog')
    await expect(report).toContainText('Automatic restore failed; check the Harness state')
    await expect(report).toContainText('Automatic restore cancelled')
    expect(readCount).toBe(reads); expect(writeCount).toBe(0)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('mcp-remount-results-en-390.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Refresh services', exact: true }).click()
    await expect(report).toContainText('HARNESS_CONNECTION_FAILED')
    expect(writeCount).toBe(0)
  })

  test('操作失败也展示真实重挂报告，保留连接草稿且不自动重试', async ({ page }) => {
    await open(page); await select(page, '远程 HTTP')
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('保留失败操作草稿')
    harnessStopped = true; failMutation = true
    snapshot.harnessRemounts = [
      { id: 'dsh-restored', status: 'reconnected' },
      { id: 'dsh-offline', status: 'failed', code: 'HARNESS_CONNECTION_FAILED' },
      { id: 'dsh-cancelled', status: 'cancelled', code: 'HARNESS_REMOUNT_CANCELLED' },
    ]
    await editor.getByRole('button', { name: '保存 MCP', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('操作未完成，请刷新 MCP 服务后重试。')
    const report = page.getByRole('status', { name: 'Harness 挂载结果', exact: true })
    await expect(report).toContainText('dsh-restored已按新工具目录自动恢复')
    await expect(report).toContainText('dsh-offline自动恢复失败，请检查 Harness 状态HARNESS_CONNECTION_FAILED')
    await expect(report).toContainText('dsh-cancelled自动恢复已取消HARNESS_REMOUNT_CANCELLED')
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留失败操作草稿')
    const reads = readCount
    await chooseLanguage(page, 'en-US')
    await expect(page.getByRole('status', { name: 'Harness mount results', exact: true })).toContainText('Automatic restore failed; check the Harness state')
    expect(writeCount).toBe(1); expect(readCount).toBe(reads)
  })

  test('语言切换保留同一连接草稿、秘密和选区，不发起读取或保存', async ({ page }, info) => {
    await open(page); await select(page, '远程 HTTP')
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    const editor = page.locator('.mcp-editor')
    const nameInput = editor.getByLabel('名称', { exact: true }), nameId = await nameInput.getAttribute('id')
    await nameInput.fill('Language draft')
    await editor.getByLabel('服务地址', { exact: true }).fill('https://mcp.example.com/draft?token=locale-fixture')
    await editor.getByLabel('值（留空保留）', { exact: true }).fill('Bearer locale-fixture-secret')
    await nameInput.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 7))
    const reads = readCount, writes = writeCount
    await chooseLanguage(page, 'en-US')
    const translatedName = editor.getByLabel('Name', { exact: true })
    await expect(translatedName).toHaveAttribute('id', nameId!)
    await expect(translatedName).toHaveValue('Language draft')
    expect(await translatedName.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 7])
    await expect(editor.getByLabel('Service URL', { exact: true })).toHaveValue('https://mcp.example.com/draft?token=locale-fixture')
    await expect(editor.getByLabel('Value (empty keeps saved)', { exact: true })).toHaveValue('Bearer locale-fixture-secret')
    const remote = card(page, '远程 HTTP')
    await expect(remote.getByText('Available to all Agents by default', { exact: true })).toBeVisible()
    await expect(remote.getByText('Requires an enabled, connected service. This service is currently unavailable.', { exact: true })).toBeVisible()
    await noManualGrants(page)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('mcp-connection-draft-en-390.png'), fullPage: true })
    await chooseLanguage(page, 'zh-CN')
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('Language draft')
    await expect(editor.getByLabel('值（留空保留）', { exact: true })).toHaveValue('Bearer locale-fixture-secret')
    expect(readCount).toBe(reads); expect(writeCount).toBe(writes)
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('locale-fixture-secret')
  })

  test('隐藏页面清空编辑中的密钥与带查询地址，保留非密钥草稿', async ({ page }) => {
    await open(page); await select(page, '远程 HTTP')
    await card(page, '远程 HTTP').getByRole('button', { name: '编辑配置', exact: true }).click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('保留这个名称')
    await editor.getByLabel('服务地址', { exact: true }).fill('https://mcp.example.com/mcp?token=private-query')
    const headerValue = editor.getByLabel('值（留空保留）', { exact: true })
    await headerValue.fill('Bearer private-header')
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留这个名称')
    await expect(editor.getByLabel('服务地址', { exact: true })).toHaveValue('')
    await expect(headerValue).toHaveValue('')
    expect(writeCount).toBe(0)
  })

  test('空态、错误态与 390px 可用', async ({ page }, info) => {
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
    await page.screenshot({ path: info.outputPath('mcp-empty-390.png'), fullPage: true })
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
  test('真实保存并连接 stdio 后自动获得所有当前类型和工具摘要，无授权写入', async ({ page }, info) => {
    const writes: { operation: string; input: Record<string, unknown> }[] = []
    page.on('request', request => { if (request.url() === url + '/api/mcp' && request.method() === 'POST') writes.push(request.postDataJSON()) })
    await page.goto(url + '/#mcp')
    await expect(page.getByRole('heading', { name: 'MCP', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: '添加直接接入', exact: true }).first().click()
    const editor = page.locator('.mcp-editor')
    await editor.getByLabel('名称', { exact: true }).fill('SDK fixture')
    await editor.getByLabel('启动命令', { exact: true }).fill(process.execPath)
    await editor.getByLabel('命令参数', { exact: true }).fill(fixture)
    await editor.getByRole('button', { name: '创建 MCP', exact: true }).click()
    const serviceCard = page.locator('.mcp-service').filter({ has: page.getByRole('heading', { name: 'SDK fixture', exact: true }) })
    await expect(serviceCard).toBeVisible()
    await expect(serviceCard.getByText('默认所有 Agent 可用', { exact: true })).toBeVisible()
    await expect(serviceCard.getByText('启用并连接后生效；当前无法调用此服务。', { exact: true })).toBeVisible()
    expect(writes[0]?.input).not.toHaveProperty('grant')
    await serviceCard.getByRole('button', { name: '连接', exact: true }).click()
    await expect(serviceCard.getByText('已连接', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await expect(serviceCard.getByText('服务已启用并连接，当前目录中的工具可用。', { exact: true })).toBeVisible()
    await serviceCard.locator('.mcp-tools summary').click()
    await expect(serviceCard.getByText('Echo fixture', { exact: true })).toBeVisible()
    await expect(serviceCard.getByRole('button', { name: /^(编辑授权|保存授权)$/ })).toHaveCount(0)
    const snapshot = await (await page.request.get(url + '/api/mcp')).json() as { agentTypes: { id: string }[]; services: { name: string; state: string; tools: { name: string }[]; grant: { agentTypeIds: string[]; toolNames: string[] } }[] }
    const service = snapshot.services.find(entry => entry.name === 'SDK fixture')!
    expect(service.state).toBe('connected')
    expect(service.tools.map(tool => tool.name)).toContain('fixture_echo')
    expect(service.grant.agentTypeIds).toEqual(snapshot.agentTypes.map(type => type.id))
    expect(service.grant.agentTypeIds).toContain('main')
    expect(service.grant.toolNames).toEqual(service.tools.map(tool => tool.name))
    expect(writes.map(write => write.operation)).toEqual(['save', 'connect'])
    await page.screenshot({ path: info.outputPath('mcp-real-stdio.png'), fullPage: true })
    await serviceCard.getByRole('button', { name: '断开', exact: true }).click()
  })
})
