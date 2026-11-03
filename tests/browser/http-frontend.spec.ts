import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { startOneBotFixture } from '../fixtures/onebot'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const pluginDirectories = [
  '../../plugins/communication/qq/dist/',
  '../../plugins/harness/dsh/dist/',
  '../../plugins/capabilities/stickers/dist/',
  '../../plugins/capabilities/image-generation/dist/',
  '../../plugins/capabilities/openviking-memory/dist/',
].map(path => fileURLToPath(new URL(path, import.meta.url)))
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const panelError = /这个面板暂时无法打开|此插件的配置面板无法加载/

async function unusedPort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolveListen, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolveListen)
  })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP fixture port')
  await new Promise<void>((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

test.use({
  browserName: 'chromium',
  launchOptions: {
    args: [
      '--no-proxy-server',
      '--host-resolver-rules=MAP eating-http.test 127.0.0.1, MAP * ~NOTFOUND',
    ],
  },
})

test.describe('真实非安全 HTTP 域名的插件前端', () => {
  test.setTimeout(60_000)

  let directory: string | undefined
  let host: EatingHost | undefined
  let onebot: Awaited<ReturnType<typeof startOneBotFixture>> | undefined
  let origin: string
  let ownerToken: string
  let pageErrors: string[]
  let consoleTypeErrors: string[]
  let escapedRequests: string[]
  let toolInvocations: string[]

  test.beforeEach(async ({ page, context }) => {
    pageErrors = []; consoleTypeErrors = []; escapedRequests = []; toolInvocations = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && /TypeError|randomUUID/i.test(message.text())) consoleTypeErrors.push(message.text())
    })
    context.on('request', request => {
      const target = new URL(request.url())
      if (target.origin !== origin) escapedRequests.push(target.origin)
      if (target.pathname === '/api/plugins/qq/invoke') toolInvocations.push(target.pathname)
    })
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { await route.abort('blockedbyclient'); return }
      await route.continue()
    })
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_http_frontend_')))
    for (const pluginDirectory of pluginDirectories) await installPluginPackage(directory, pluginDirectory)
    const port = await unusedPort()
    origin = `http://eating-http.test:${port}`
    ownerToken = randomBytes(32).toString('base64url')
    host = await createInstalledHost({
      dataDirectory: directory, port, listenHost: '127.0.0.1', publicOrigin: origin, ownerToken,
      allowedUiOrigins: [], staticDirectory, autoConnectOnStartup: false,
    })
    expect(await host.listen()).toBe(`http://127.0.0.1:${port}`)
  })

  test.afterEach(async () => {
    try { await host?.close() }
    finally {
      host = undefined
      try { await onebot?.close() }
      finally {
        onebot = undefined
        if (directory) {
          const target = await realpath(directory)
          if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_http_frontend_')) {
            throw new Error('Unsafe HTTP frontend fixture cleanup')
          }
          await rm(target, { recursive: true })
          directory = undefined
        }
      }
    }
    expect(escapedRequests, 'All browser traffic stays on the HTTP fixture origin').toEqual([])
    expect(toolInvocations, 'No QQ tool is executed').toEqual([])
    expect(consoleTypeErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  async function enter(page: Page, hash: string) {
    const response = await page.goto(`${origin}/?token=${ownerToken}#${hash}`)
    expect(response?.status()).toBe(200)
    const exchange = await response?.request().redirectedFrom()?.response()
    expect(exchange?.status()).toBe(303)
    expect(exchange?.headers().location).toBe('/')
    expect(exchange?.headers()['cache-control']).toBe('no-store')
    await expect(page).toHaveURL(`${origin}/#${hash}`)
    const cookie = (await page.context().cookies(origin)).find(item => item.name === 'EatingOwnerAccess')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false, path: '/' })
    expect(await page.evaluate(() => ({
      origin: location.origin,
      secure: isSecureContext,
      randomUUID: typeof crypto.randomUUID,
      getRandomValues: typeof crypto.getRandomValues,
      randomBytes: crypto.getRandomValues(new Uint8Array(16)).length,
    }))).toEqual({ origin, secure: false, randomUUID: 'undefined', getRandomValues: 'function', randomBytes: 16 })
  }

  test('QQ 隐藏工具面板仍能挂载，UUID v4 草稿在页签切换时稳定', async ({ page }, info) => {
    await enter(page, 'robots/qq')
    await expect(page.getByRole('tab', { name: '连接配置', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: '功能测试', exact: true })).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByLabel('显示名称', { exact: true })).toBeVisible()
    await expect(page.getByLabel('OneBot 地址', { exact: true })).toBeVisible()
    await expect(page.getByText(panelError)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('http-qq-configuration.png') })

    onebot = await startOneBotFixture()
    await page.getByLabel('显示名称', { exact: true }).fill('HTTP 隔离协议夹具')
    await page.getByLabel('OneBot 地址', { exact: true }).fill(onebot.endpoint)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。点击“连接 OneBot”重新连接。')).toBeVisible()
    await page.getByRole('button', { name: '连接 OneBot', exact: true }).click()
    await expect(page.getByRole('button', { name: '断开连接', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    const initialId = (await page.locator('.qq-request-id').innerText()).match(uuidV4.source.replace(/^\^|\$$/g, ''))?.[0]
    expect(initialId).toMatch(uuidV4)
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_send_private_message')
    const requestId = page.getByLabel('请求 ID（必填）', { exact: true })
    await expect(requestId).toHaveValue(uuidV4)
    const selectedId = await requestId.inputValue()
    expect(selectedId).not.toBe(initialId)
    await page.getByLabel('收件人 QQ 号（必填）', { exact: true }).fill('123456789')
    await page.getByLabel('消息内容（必填）', { exact: true }).fill('仅预览，绝不发送')
    const draftId = await requestId.inputValue()
    expect(draftId).toMatch(uuidV4)
    expect(draftId).not.toBe(selectedId)
    await expect(page.getByRole('button', { name: '执行测试', exact: true })).toBeDisabled()
    await page.getByRole('tab', { name: '连接配置', exact: true }).click()
    await page.getByRole('tab', { name: '功能测试', exact: true }).click()
    await expect(requestId).toHaveValue(draftId)
    await expect(page.getByLabel('消息内容（必填）', { exact: true })).toHaveValue('仅预览，绝不发送')
    expect(onebot.requests.some(request => request.action.startsWith('send_'))).toBe(false)
    await requestId.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('http-qq-request-id.png') })
  })

  test('记忆范围添加规则在 HTTP 创建 UUID，切换页签保留未保存草稿', async ({ page }, info) => {
    await enter(page, 'plugins/openviking-memory')
    await page.getByRole('tab', { name: '范围', exact: true }).click()
    await page.getByRole('button', { name: '添加群聊', exact: true }).click()
    await expect(page.getByLabel('规则名称', { exact: true })).toBeVisible()
    const groupId = (await page.locator('.ov-rule-toggle').getAttribute('id'))?.match(uuidV4.source.replace(/^\^|\$$/g, ''))?.[0]
    expect(groupId).toMatch(uuidV4)
    await page.getByLabel('规则名称', { exact: true }).fill('HTTP 群聊草稿')
    await page.getByRole('button', { name: '添加私聊', exact: true }).click()
    await expect(page.locator('.ov-rule')).toHaveCount(2)
    const privateId = (await page.locator('.ov-rule-toggle').last().getAttribute('id'))?.match(uuidV4.source.replace(/^\^|\$$/g, ''))?.[0]
    expect(privateId).toMatch(uuidV4)
    expect(privateId).not.toBe(groupId)
    await page.getByRole('tab', { name: '连接', exact: true }).click()
    await page.getByRole('tab', { name: '范围', exact: true }).click()
    await expect(page.locator('.ov-rule-toggle').first()).toContainText('HTTP 群聊草稿')
    await expect(page.locator('.ov-rule-toggle').first()).toHaveAttribute('id', new RegExp(groupId!))
    await expect(page.getByText(panelError)).toHaveCount(0)
    await page.locator('.ov-rule-editor').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('http-memory-rule-id.png') })
  })

  test('生图确认提交在 HTTP 生成稳定 UUID，拦截提交且不调用生成服务', async ({ page }, info) => {
    const submissions: Array<{ request_id: string; prompt: string }> = []
    await page.route('**/api/plugins/image-generation/manage', async route => {
      const body = route.request().postDataJSON() as { operation: string; input: { request_id: string; prompt: string } }
      if (body.operation !== 'generate') { await route.fallback(); return }
      submissions.push(body.input)
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        error: { code: 'HTTP_BROWSER_FIXTURE_NOT_SENT', message: 'HTTP fixture intercepted generation', outcome: 'not-sent' },
      }) })
    })
    await enter(page, 'plugins/image-generation')
    await expect(page.getByLabel('Base URL', { exact: true })).toBeVisible()
    await expect(page.getByText(panelError)).toHaveCount(0)
    await page.getByLabel('Base URL', { exact: true }).fill(`${origin}/unused-images-provider`)
    await page.getByLabel('API Key', { exact: true }).fill('http-browser-fixture-only')
    await page.getByLabel('模型', { exact: true }).fill('http-browser-fixture')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.getByText('配置已保存。保存只更新本地配置。', { exact: true }).first()).toBeVisible()
    await page.getByLabel('提示词', { exact: true }).fill('HTTP request ID only; no generation')
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    const submit = page.getByRole('button', { name: '确认提交', exact: true })
    await submit.click()
    await expect.poll(() => submissions.length).toBe(1)
    expect(submissions[0]!.request_id).toMatch(uuidV4)
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect.poll(() => submissions.length).toBe(2)
    expect(submissions[1]!.request_id).toBe(submissions[0]!.request_id)
    await expect(submit).toBeEnabled()
    await page.getByLabel('提示词', { exact: true }).fill('Changed HTTP draft; still no generation')
    await page.getByRole('button', { name: '生成图片', exact: true }).click()
    await submit.click()
    await expect.poll(() => submissions.length).toBe(3)
    expect(submissions[2]!.request_id).toMatch(uuidV4)
    expect(submissions[2]!.request_id).not.toBe(submissions[0]!.request_id)
    await expect(submit).toBeEnabled()
    expect(submissions.map(input => input.prompt)).toEqual([
      'HTTP request ID only; no generation', 'HTTP request ID only; no generation', 'Changed HTTP draft; still no generation',
    ])
    await expect(page.locator('.image-job')).toHaveCount(0)
    await page.getByLabel('提示词', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('http-image-generation-request-id.png') })
  })
})
