import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
// A complete 80x48 PNG with valid checksums, rather than a signature-only media stub.
function pngFixture(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type), body = Buffer.concat([name, data]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(80, 0); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc(48 * (80 * 3 + 1))
  for (let y = 0; y < 48; y++) for (let x = 0; x < 80; x++) { const at = y * 241 + 1 + x * 3; rows[at] = x < 40 ? 60 : 232; rows[at + 1] = x < 40 ? 116 : 238; rows[at + 2] = x < 40 ? 92 : 231 }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const png = pngFixture(), base64 = png.toString('base64')
const result: JsonValue = { content: [{ type: 'text', text: 'fixture-only image content' }, { type: 'image', mimeType: 'image/png', data: base64 }], structuredContent: { mimeType: 'image/png', bytes: png.length, messageId: '42', imageId: 'received-image-fixture' } }
const deferred = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done }); return { promise, release } }

// Owner HTTP UI fixtures only: no real QQ account, downloads, model, or native runtime.
test.describe('声明式图片结果预览与清理', () => {
  test.setTimeout(45_000)
  let directory: string, host: EatingHost, url: string
  let requests: JsonObject[], errors: string[], imageResult: JsonValue
  let gate: ReturnType<typeof deferred> | null
  let plugin: { id: string; enabled: boolean }
  test.beforeEach(async ({ page }) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_image_ui_')))
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: directory, staticDirectory, port: 0, allowedUiOrigins: [] }); url = await host.listen()
    errors = []
    expect((await page.request.get(url + '/api/bootstrap')).status()).toBe(200)
    const workspaceResponse = await page.request.get(url + '/api/workspace'); expect(workspaceResponse.status()).toBe(200)
    const workspace = await workspaceResponse.json() as { plugins: (typeof plugin)[] }
    plugin = workspace.plugins.find(entry => entry.id === 'qq')!
    requests = []; errors = []; imageResult = result; gate = null
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|unsafe-eval/u.test(message.text())) errors.push(message.text()) })
    await page.route('**/api/workspace', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(workspace) }))
    await page.route('**/api/plugins/qq/invoke', async route => {
      const body = route.request().postDataJSON() as JsonObject; requests.push(body)
      const payload = body.name === 'qq_view_received_image' ? imageResult : { user_id: '10001', nickname: 'fixture-json-standard-result' }
      if (body.name === 'qq_view_received_image') await gate?.promise
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, requestId: body.requestId, result: payload }) }).catch(() => {})
    })
  })
  test.afterEach(async () => {
    gate?.release(); await host?.close()
    const target = await realpath(directory)
    if (target !== resolve(directory) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_image_ui_')) throw new Error('Unsafe image UI fixture cleanup')
    await rm(target, { recursive: true }); expect(errors).toEqual([])
  })
  async function open(page: Page) { await page.goto(url + '/#robots/qq'); await page.getByRole('tab', { name: '功能测试', exact: true }).click(); await expect(page.getByLabel('测试功能', { exact: true })).toBeVisible() }
  async function chooseImage(page: Page) {
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_view_received_image')
    await page.getByLabel('消息 ID（必填）', { exact: true }).fill('42')
    await page.getByLabel('收到的图片引用（必填）', { exact: true }).fill('received-image-fixture')
  }
  async function run(page: Page) { await page.getByRole('button', { name: '执行测试', exact: true }).click() }
  const image = (page: Page) => page.locator('.qq-result-image')
  async function loaded(page: Page) { await expect(image(page)).toBeVisible(); await expect.poll(() => image(page).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(80) }
  async function hidden(page: Page, value: boolean) { await page.evaluate(hidden => { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new Event('visibilitychange')) }, value) }

  test('标准39加一个content图片扩展，图像可真实解码且不进入普通JSON/记录，切语言不重读', async ({ page }, info) => {
    await open(page)
    await expect(page.getByLabel('测试功能', { exact: true }).locator('option')).toHaveCount(40)
    await chooseImage(page); await expect(page.getByText(/会话图片扩展，独立于标准 OneBot 工具/)).toBeVisible(); await run(page); await loaded(page)
    const src = await image(page).getAttribute('src'); expect(src).toMatch(/^blob:/u)
    expect(await page.content()).not.toContain(base64); await expect(page.locator('.qq-execution pre')).toHaveCount(0)
    await expect(page.locator('.qq-history')).toHaveCount(0)
    await page.locator('#display-language').selectOption('en-US')
    await expect(page.getByRole('region', { name: 'Image result preview', exact: true })).toBeVisible()
    expect(await image(page).getAttribute('src')).toBe(src); expect(requests).toHaveLength(1)
    await page.getByRole('region', { name: 'Image result preview', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-result-en-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.getByRole('region', { name: 'Image result preview', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('image-result-en-mobile.png') })
    await page.getByLabel('Test function', { exact: true }).selectOption('qq_get_login_info')
    await expect(image(page)).toHaveCount(0); await page.getByRole('button', { name: 'Run test', exact: true }).click()
    await expect(page.locator('.qq-execution pre')).toContainText('fixture-json-standard-result')
    await expect(page.locator('.qq-history')).toHaveCount(0)
  })

  test('显式清除、隐藏、切离与停用均清空并撤销Blob，返回不恢复', async ({ page }) => {
    await open(page); await chooseImage(page); await run(page); await loaded(page)
    const src = (await image(page).getAttribute('src'))!
    await page.getByRole('button', { name: '清除图片结果', exact: true }).click(); await expect(image(page)).toHaveCount(0)
    expect(await page.evaluate(url => new Promise<boolean>(done => { const candidate = new Image(); candidate.onload = () => done(true); candidate.onerror = () => done(false); candidate.src = url }), src)).toBe(false)
    await run(page); await loaded(page); await hidden(page, true); await expect(image(page)).toHaveCount(0)
    await hidden(page, false); await expect(image(page)).toHaveCount(0)
    await run(page); await loaded(page); await page.getByRole('tab', { name: '连接配置', exact: true }).click(); await page.getByRole('tab', { name: '功能测试', exact: true }).click(); await expect(image(page)).toHaveCount(0)
    await run(page); await loaded(page); plugin.enabled = false
    await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await expect(image(page)).toHaveCount(0)
    plugin.enabled = true; await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await expect(image(page)).toHaveCount(0)
  })

  test('取消及隐藏拒绝迟到图片，返回不恢复也不复制到历史', async ({ page }, info) => {
    await open(page); await chooseImage(page); gate = deferred(); await run(page)
    await expect.poll(() => requests.length).toBe(1)
    await page.getByRole('button', { name: '取消图片读取', exact: true }).click(); gate.release()
    await expect(image(page)).toHaveCount(0); await expect(page.locator('.qq-history')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('image-cancelled-zh-desktop.png') })
    gate = deferred(); await run(page); await expect.poll(() => requests.length).toBe(2)
    await hidden(page, true); gate.release(); await hidden(page, false)
    await expect(image(page)).toHaveCount(0); expect(await page.content()).not.toContain(base64)
  })

  test('拒绝非canonical base64、未知mime与含payload的metadata，get_image仍是普通协议查询', async ({ page }) => {
    await open(page); await chooseImage(page)
    for (const payload of [
      { content: [{ type: 'image', mimeType: 'image/png', data: base64 + '\n' }] },
      { content: [{ type: 'image', mimeType: 'image/svg+xml', data: base64 }] },
      { content: [{ type: 'image', mimeType: 'image/jpeg', data: base64 }] },
      { content: [{ type: 'image', mimeType: 'image/png', data: base64 }], structuredContent: { data: base64 } },
    ] as JsonValue[]) {
      imageResult = payload; await run(page)
      await expect(page.getByText('图片结果格式无效，请重新读取。', { exact: true })).toBeVisible(); await expect(image(page)).toHaveCount(0)
      expect(await page.content()).not.toContain(base64)
    }
    await page.getByLabel('测试功能', { exact: true }).selectOption('qq_get_image')
    await expect(page.getByRole('tabpanel', { name: '功能测试', exact: true }).getByText('获取收到的图片，返回 OneBot 服务上的文件路径。', { exact: true })).toBeVisible()
    await expect(page.getByText(/会话图片扩展，独立于标准 OneBot 工具/)).toHaveCount(0)
  })
})
