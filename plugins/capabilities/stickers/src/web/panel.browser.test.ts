import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { readFile, mkdtemp, realpath, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import entry from '../server'
import { fixtureImage, fixturePng } from '../backend/test-fixtures'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
interface HarnessState { readonly active: number; readonly revoked: number; readonly feedback: string[] }
async function fixture() {
  const parent = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(parent, 'eating-stickers-ui-')))
  stops.push(async () => { const target = await realpath(directory); if (target !== directory || dirname(target) !== parent || !basename(target).startsWith('eating-stickers-ui-')) throw new Error('Unsafe sticker UI cleanup'); await rm(target, { recursive: true }) })
  const context: HostPluginContext = { dataDirectory: directory, getSetting: () => null, setSetting: () => {}, listMessages: () => [], recordEvent: () => ({ eventId: 'fixture', inserted: true }), executeIdempotent: async (_plugin, _action, _params, _id, execute) => execute() }
  const plugin = entry.create(context); stops.push(() => plugin.dispose())
  const project = fileURLToPath(new URL('../../../../../', import.meta.url))
  const bundle = await build({ stdin: { sourcefile: 'sticker-harness.tsx', resolveDir: project, loader: 'tsx', contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {setLocale} from '@eating/ui-sdk'; import {StickersPanel} from './plugins/capabilities/stickers/src/web/panel'; const root=createRoot(document.getElementById('root')); const active=new Set(); let revoked=0; const feedback=[]; const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL); URL.createObjectURL=value=>{const url=create(value);active.add(url);return url;};URL.revokeObjectURL=url=>{active.delete(url);revoked++;return revoke(url);};window.stickerHarness={state:()=>({active:active.size,revoked,feedback}),locale:setLocale,unmount:()=>root.unmount()};root.render(<StickersPanel initialValues={{}} onSave={()=>({ok:true})} onFeedback={message=>feedback.push(message)}/>);` }, bundle: true, write: false, outfile: 'stickers-fixture.js', platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@eating/plugin-sdk': join(project, 'packages/plugin-sdk/src/index.ts'), '@eating/ui-sdk': join(project, 'packages/ui-sdk/src/index.ts') } })
  const browser: Browser = await chromium.launch({ headless: true }); stops.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const errors: string[] = [], operations: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://stickers.test/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/api/bootstrap') { await route.fulfill({ json: { csrfToken: 'local-ui-fixture' } }); return }
    if (url.pathname === '/api/plugins/stickers/manage') {
      const body = request.postDataJSON() as { operation: string; input: JsonObject }
      operations.push(body.operation)
      try { await route.fulfill({ json: await plugin.manage!(body.operation, body.input) }) }
      catch (error) { const cause = error as { code?: string; message?: string; statusCode?: number }; await route.fulfill({ status: cause.statusCode ?? 400, json: { error: { code: cause.code, message: cause.message } } }) }
      return
    }
    if (url.pathname === '/') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="root" style="max-width:1100px;margin:32px auto;padding:0 20px"></main></body></html>' }); return }
    await route.abort()
  })
  await page.goto('http://stickers.test/')
  await page.addStyleTag({ content: await readFile(join(project, 'apps/web/src/styles.css'), 'utf8') })
  for (const output of bundle.outputFiles) if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
  await page.addScriptTag({ content: bundle.outputFiles.find(output => output.path.endsWith('.js'))!.text })
  await page.getByText('还没有收藏表情', { exact: true }).waitFor()
  const state = () => page.evaluate<HarnessState>('window.stickerHarness.state()')
  return { page, plugin, errors, operations, state, directory }
}
async function settle(page: Page) { await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')) }
const suite = describe.runIf(process.env.EATING_STICKERS_BROWSER_TEST === '1')
suite('sticker panel isolated browser behavior', () => {
  it('uploads, previews, switches locale without refetching, edits and confirms deletion', async () => {
    const { page, state, errors, operations } = await fixture()
    await page.getByRole('button', { name: '添加表情', exact: true }).click()
    await page.getByLabel('本地图片', { exact: true }).setInputFiles({ name: 'greeting.png', mimeType: 'image/png', buffer: fixturePng() })
    await page.getByLabel('描述', { exact: true }).fill('开心挥手打招呼')
    await page.getByLabel('标签', { exact: true }).fill('开心\n问候')
    await page.getByRole('button', { name: '添加到表情库', exact: true }).click()
    await page.getByRole('button', { name: /开心挥手打招呼/ }).waitFor()
    await settle(page)
    expect((await state()).active).toBe(1)
    expect(operations.filter(operation => operation === 'get')).toHaveLength(0)
    const before = operations.length
    await page.evaluate('window.stickerHarness.locale("en-US")')
    await page.getByRole('button', { name: 'Save details', exact: true }).waitFor()
    expect(operations).toHaveLength(before)
    expect(await page.getByLabel('Description', { exact: true }).inputValue()).toBe('开心挥手打招呼')
    await page.getByLabel('Description', { exact: true }).fill('更新的表情描述')
    await page.getByRole('button', { name: 'Save details', exact: true }).click()
    await page.getByRole('button', { name: /更新的表情描述/ }).waitFor()
    await page.getByRole('button', { name: 'Delete sticker', exact: true }).click()
    expect(operations.filter(operation => operation === 'delete')).toHaveLength(0)
    await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click()
    await page.getByText('No stickers yet', { exact: true }).waitFor()
    expect((await state()).active).toBe(0)
    expect(errors).toEqual([])
  }, 30000)

  it('keeps a stale editing draft until the owner explicitly discards it and reloads', async () => {
    const { page, plugin, errors } = await fixture()
    await plugin.manage!('add', { ...fixtureImage(), description: '原始描述', tags: [] })
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('button', { name: /原始描述/ }).click()
    await page.getByRole('img', { name: '所选表情图片' }).waitFor()
    await page.getByLabel('描述', { exact: true }).fill('尚未保存的草稿')
    await plugin.manage!('add', { ...fixtureImage(1), description: '同时新加', tags: [] })
    await page.getByRole('button', { name: '保存资料', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '草稿已保留' }).waitFor()
    expect(await page.getByLabel('描述', { exact: true }).inputValue()).toBe('尚未保存的草稿')
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('button', { name: /原始描述/ }).click()
    await page.getByRole('button', { name: '放弃修改并继续', exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('.stickers-field textarea') as HTMLTextAreaElement)?.value === '原始描述')
    await page.getByLabel('描述', { exact: true }).fill('已核对的新描述')
    await page.getByRole('button', { name: '保存资料', exact: true }).click()
    await page.getByRole('button', { name: /已核对的新描述/ }).waitFor()
    expect(errors).toEqual([])
  }, 30000)

  it('uses bounded metadata paging, filters tags, clears Blob URLs while hidden and on unmount', async () => {
    const { page, plugin, operations, state, errors } = await fixture()
    for (let index = 0; index < 23; index++) await plugin.manage!('add', { ...fixtureImage(index), description: `Sticker ${index}`, tags: index % 2 ? ['greeting', 'happy'] : ['quiet'] })
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await settle(page)
    await page.waitForFunction(() => document.querySelectorAll('.stickers-row').length === 20)
    expect(operations.filter(operation => operation === 'get')).toHaveLength(0)
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.stickers-row').length === 3)
    await page.locator('.stickers-row').first().click()
    await page.getByRole('img', { name: '所选表情图片' }).waitFor()
    expect((await state()).active).toBe(1)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.getByText('图片预览已清除', { exact: true }).waitFor()
    expect((await state()).active).toBe(0)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.getByRole('button', { name: '读取图片', exact: true }).click()
    await page.getByRole('img', { name: '所选表情图片' }).waitFor()
    expect((await state()).active).toBe(1)
    await page.getByLabel('按标签筛选', { exact: true }).selectOption(['happy', 'greeting'])
    await page.getByRole('button', { name: '筛选', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.stickers-row').length === 11)
    await page.setViewportSize({ width: 390, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.EATING_STICKERS_SCREENSHOTS) {
      const output = fileURLToPath(new URL('../../.test-artifacts/', import.meta.url)); await mkdir(output, { recursive: true })
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;}' })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true })
      await page.setViewportSize({ width: 1280, height: 1000 }); await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true })
      await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(output, 'dark.png'), fullPage: true })
    }
    await page.evaluate('window.stickerHarness.unmount()')
    expect((await state()).active).toBe(0)
    expect(errors).toEqual([])
  }, 30000)
})
