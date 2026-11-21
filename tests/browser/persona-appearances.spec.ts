import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PersonaMutationResult } from '@eating/plugin-sdk'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { createImageFixturePng } from '../fixtures/image'

const builtDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
const qqDirectory = fileURLToPath(new URL('../../plugins/communication/qq/dist/', import.meta.url))

const personaBodyEditor = (page: Page) => page.getByRole('textbox', { name: /^(人格设定|Persona instructions)$/, exact: true })
const personaNav = (page: Page) => page.getByRole('navigation', { name: /^(人格列表|Personas)$/, exact: true })

test.describe('人格外貌参考图配置与隐式提示词预览', () => {
  test.setTimeout(60000)
  let directory: string | undefined
  let host: EatingHost | undefined
  let url: string
  let pageErrors: string[]

  test.beforeEach(async ({ page }) => {
    pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_persona_appearances_ui_')))
    await installPluginPackage(directory, qqDirectory)
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
        if (target !== resolve(directory) || dirname(target) !== temporaryRoot || !basename(target).startsWith('Eating_persona_appearances_ui_')) {
          throw new Error('Unsafe persona appearance browser cleanup')
        }
        await rm(target, { recursive: true })
        directory = undefined
      }
    }
    expect(pageErrors).toEqual([])
  })

  test('支持未保存提示、多图上传、标签编辑、排序、灯箱预览、双语切换、隐式提示词预览与确认删除', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${url}/#personas`)
    await expect(personaNav(page)).toBeVisible()

    // Unsaved new persona shows save-first hint
    await personaNav(page).getByRole('button', { name: '新增人格', exact: true }).click()
    await expect(page.getByText('请先保存此人格配置，再上传外貌参考图。')).toBeVisible()

    await page.getByLabel('人格名称', { exact: true }).fill('小樱')
    await personaBodyEditor(page).fill('温柔活泼的蓝发红瞳少女。')
    const createdPromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${url}/api/personas`)
    await page.getByRole('button', { name: '保存人格', exact: true }).click()
    const createdResponse = await createdPromise
    expect(createdResponse.status()).toBe(201)
    const created = await createdResponse.json() as PersonaMutationResult
    const personaId = created.persona.id

    // Activate persona
    await page.getByRole('button', { name: '启用人格', exact: true }).click()
    await expect(page.getByText('已启用 · 可被识图与生图引用')).toBeVisible()

    // Modify text draft locally first; image upload must NOT alter or overwrite text draft
    await personaBodyEditor(page).fill('温柔活泼的蓝发红瞳少女。补充未保存草稿。')
    await expect(page.locator('.authoring-save-state')).toHaveText('有未保存修改')

    const png1 = createImageFixturePng([30, 120, 220, 255])
    const png2 = createImageFixturePng([220, 60, 90, 255])
    const fileInput = page.locator('.authoring-appearances-file-input')
    await fileInput.setInputFiles([
      { name: 'front.png', mimeType: 'image/png', buffer: png1 },
      { name: 'side.png', mimeType: 'image/png', buffer: png2 },
    ])

    const cards = page.locator('.authoring-appearance-card')
    await expect(cards).toHaveCount(2)
    await expect(page.locator('.authoring-appearances-count')).toHaveText('2 / 10 张')
    // Text draft remains untouched & unsaved
    await expect(personaBodyEditor(page)).toContainText('补充未保存草稿。')
    await expect(page.locator('.authoring-save-state')).toHaveText('有未保存修改')

    // Thumbnails actually decoded
    await expect.poll(async () => {
      return await cards.nth(0).locator('img').evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)
    }).toBe(true)
    await expect.poll(async () => {
      return await cards.nth(1).locator('img').evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)
    }).toBe(true)

    const firstId = await cards.nth(0).getAttribute('data-appearance-id')
    const secondId = await cards.nth(1).getAttribute('data-appearance-id')
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()

    // Edit label on first card
    const firstLabel = cards.nth(0).locator('input[type="text"]')
    await firstLabel.fill('正面蓝发定妆')
    await cards.nth(0).getByRole('button', { name: '保存说明', exact: true }).click()
    await expect(cards.nth(0).getByRole('button', { name: '保存说明', exact: true })).toBeDisabled()

    // Reorder: move second card up -> second becomes first
    await cards.nth(1).getByRole('button', { name: '上移', exact: true }).click()
    await expect(cards.nth(0)).toHaveAttribute('data-appearance-id', secondId!)
    await expect(cards.nth(1)).toHaveAttribute('data-appearance-id', firstId!)

    // Lightbox screenshot + Next/Prev navigation + Escape close
    await cards.nth(0).locator('.authoring-appearance-thumb').click()
    const lightbox = page.locator('dialog.authoring-appearance-lightbox')
    await expect(lightbox).toBeVisible()
    await expect(lightbox).toContainText('外貌参考图预览（1 / 2）')
    await page.screenshot({ path: testInfo.outputPath('appearance-lightbox-light.png') })
    await lightbox.getByRole('button', { name: '下一张' }).click()
    await expect(lightbox).toContainText('外貌参考图预览（2 / 2）')
    await expect(lightbox).toContainText('正面蓝发定妆')
    await page.keyboard.press('Escape')
    await expect(lightbox).toBeHidden()

    // Desktop dark screenshot of appearance grid
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.locator('.authoring-appearances').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('appearance-grid-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })

    // Switch language zh-CN -> en-US
    await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    await expect(page.getByRole('heading', { name: 'Appearance references', exact: true })).toBeVisible()
    await expect(page.locator('.authoring-appearances-count')).toHaveText('2 / 10')

    // Mobile 390px layout check + screenshot
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('appearance-mobile-en.png') })
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(horizontalOverflow).toBe(false)

    // Switch back to desktop & zh-CN, verify prompt preview includes implicit appearance block & imageIds
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('combobox', { name: 'Display language', exact: true }).selectOption('zh-CN')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

    await page.getByRole('link', { name: '提示词管理', exact: true }).click()
    await page.getByRole('navigation', { name: '提示词分类', exact: true }).getByRole('button', { name: /^主 Agent 提示词/ }).click()
    await expect(page.locator('.authoring-preview')).toBeVisible()
    await page.getByRole('button', { name: '查看已保存的组合', exact: true }).click()
    await expect(page.locator('.authoring-preview-result')).toContainText(firstId!)
    await expect(page.locator('.authoring-preview-result')).toContainText('正面蓝发定妆')
    await expect(page.locator('.authoring-preview-result')).toContainText('persona_appearance_get')

    // Return to persona page and delete one appearance image via inline confirmation
    await page.goto(`${url}/#personas/${personaId}`)
    await expect(page.locator('.authoring-appearance-card')).toHaveCount(2)
    await page.locator('.authoring-appearance-card').nth(0).getByRole('button', { name: '删除', exact: true }).click()
    await page.locator('.authoring-appearance-card').nth(0).getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.locator('.authoring-appearance-card')).toHaveCount(1)
    await expect(page.locator('.authoring-appearances-count')).toHaveText('1 / 10 张')
  })
})
