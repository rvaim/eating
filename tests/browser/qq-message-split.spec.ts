import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import type { EatingHost } from '../../apps/host/src/app'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'

const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))

test.describe('QQ Harness message regex splitting UI', () => {
  let home: string
  let host: EatingHost
  let url: string

  test.beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_qq_split_browser_')))
    await installPluginPackage(home, fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [], staticDirectory })
    url = await host.listen()
  })

  test.afterEach(async () => {
    await host?.close()
    const target = await realpath(home)
    if (target !== resolve(home) || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_qq_split_browser_')) {
      throw new Error('Unsafe split browser cleanup')
    }
    await rm(target, { recursive: true })
  })

  async function api(page: Page, path: string, body?: unknown) {
    return page.evaluate(async ({ path, body }) => {
      const bootstrap = await fetch('/api/bootstrap').then(response => response.json()) as { csrfToken: string }
      const response = await fetch('/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Eating-Csrf': bootstrap.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error('Fixture split API failed')
      return response.json()
    }, { path, body })
  }

  test('applies presets, live previews bubbles, saves with CAS conflict detection, and preserves drafts across locale changes', async ({ page }, info) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(url + '/#robots/qq')

    const splitCard = page.locator('.qq-subcard').filter({ has: page.getByRole('heading', { name: 'Harness 消息正则拆分', exact: true }) })
    await expect(splitCard).toBeVisible()
    await expect(splitCard.locator('.qq-subcard-badge')).toHaveText('已保存')

    await splitCard.getByRole('button', { name: '一键套用推荐组合', exact: true }).click()
    await expect(splitCard.locator('.qq-subcard-badge')).toHaveText('有未保存更改')
    await expect(splitCard.locator('.qq-split-rule-card')).toHaveCount(3)
    await expect(splitCard).toContainText('已配置 3 / 20 条')
    await expect(splitCard).toContainText('规则 #1')
    await expect(splitCard).toContainText('将拆分为 5 条消息')
    await expect(splitCard).not.toContainText('{min}')
    await expect(splitCard).not.toContainText('{count}')
    await expect(splitCard.locator('.qq-split-bubble')).toHaveCount(5)
    await expect(splitCard.locator('.qq-split-bubble-text').nth(0)).toHaveText('你好呀！')
    await expect(splitCard.locator('.qq-split-bubble-text').nth(1)).toHaveText('今天天气真不错')
    await expect(splitCard.locator('.qq-split-bubble-text').nth(2)).toContainText('3.14')
    await expect(splitCard.locator('.qq-split-bubble-text').nth(2)).toContainText('https://example.com')

    await splitCard.locator('.qq-split-preview').scrollIntoViewIfNeeded()
    await splitCard.locator('.qq-split-preview').screenshot({ path: info.outputPath('qq-message-split-preview-zh.png') })
    await splitCard.screenshot({ path: info.outputPath('qq-message-split-zh-desktop.png') })

    await splitCard.getByRole('button', { name: '保存拆分设置', exact: true }).click()
    await expect(splitCard.getByRole('status')).toHaveText('消息拆分设置已保存。')
    await expect(splitCard.locator('.qq-subcard-badge')).toHaveText('已保存')

    const persisted = await api(page, '/plugins/qq/manage', { operation: 'message-split', input: {} })
    expect(persisted).toMatchObject({ schemaVersion: 1, revision: 1, enabled: true })
    expect(persisted.rules).toHaveLength(3)

    // Edit draft, switch locale without implicit writes, verify draft retained and zero horizontal overflow on mobile.
    await splitCard.getByRole('button', { name: /中英文分号/ }).click()
    await expect(splitCard.locator('.qq-split-rule-card')).toHaveCount(4)
    const writes: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.postData()?.includes('save-message-split')) writes.push(request.url())
    })
    await page.locator('#display-language').selectOption('en-US')
    const enCard = page.locator('.qq-subcard').filter({ has: page.getByRole('heading', { name: 'Harness regex message splitting', exact: true }) })
    await expect(enCard.locator('.qq-split-rule-card')).toHaveCount(4)
    expect(writes).toEqual([])

    // Verify CAS conflict handling keeps draft.
    await api(page, '/plugins/qq/manage', {
      operation: 'save-message-split',
      input: { expectedRevision: 1, enabled: false, maxSegments: 8, delayMs: 400, trimSegments: true, rules: [] },
    })
    await enCard.getByRole('button', { name: 'Save split settings', exact: true }).click()
    await expect(enCard.getByRole('alert')).toContainText('changed elsewhere')
    await expect(enCard.locator('.qq-split-rule-card')).toHaveCount(4)

    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await enCard.screenshot({ path: info.outputPath('qq-message-split-en-mobile.png') })
    expect(pageErrors).toEqual([])
  })
})
