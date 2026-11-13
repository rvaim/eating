import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import type { EatingHost } from '../../apps/host/src/app'
import { startDeepSeekSpeechFixture } from '../fixtures/deepseek-speech'
import { startOneBotFixture } from '../fixtures/onebot'
import { inputWav } from '../fixtures/input-audio'
const staticDirectory = fileURLToPath(new URL('../../dist/', import.meta.url))
test.describe('DeepSeek speech plugins installed panels', () => {
  let root: string, host: EatingHost, url: string, provider: Awaited<ReturnType<typeof startDeepSeekSpeechFixture>>, onebot: Awaited<ReturnType<typeof startOneBotFixture>>, errors: string[]
  test.beforeEach(async ({ page }) => {
    root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'eating-deepseek-browser-'))); await mkdir(join(root, 'audio-cache'))
    provider = await startDeepSeekSpeechFixture(); onebot = await startOneBotFixture()
    for (const folder of ['capabilities/text-to-speech', 'capabilities/speech-to-text', 'communication/qq']) await installPluginPackage(root, fileURLToPath(new URL('../../plugins/' + folder + '/dist/', import.meta.url)))
    host = await createInstalledHost({ dataDirectory: root, port: 0, allowedUiOrigins: [], staticDirectory, autoConnectOnStartup: false }); url = await host.listen(); errors = []; page.on('pageerror', e => errors.push(e.message))
    const boot = await page.request.get(url + '/api/bootstrap'), { csrfToken } = await boot.json(), w = await (await page.request.get(url + '/api/workspace')).json()
    for (const id of ['text-to-speech', 'speech-to-text']) if (!w.plugins.find((p: { id: string; enabled: boolean }) => p.id === id)?.enabled) expect((await page.request.post(url + '/api/plugins/' + id + '/enable', { headers: { 'X-Eating-Csrf': csrfToken }, data: {} })).ok()).toBe(true)
  })
  test.afterEach(async () => { await host.close(); await provider.close(); await onebot.close(); await rm(root, { recursive: true }); expect(errors).toEqual([]) })
  async function configureRecognition(page: Page) {
    await page.goto(url + '/#plugins/speech-to-text'); await page.getByLabel('服务地址', { exact: true }).fill(provider.asrEndpoint); await page.getByLabel('API Key', { exact: true }).fill(['fixture', 'deepseek', 'key'].join('-')); await page.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(page.getByText('配置已保存，未调用语音识别。', { exact: true })).toBeVisible()
  }
  test('switches synthesis capabilities, forwards exact DeepSeek settings and plays one completed preview', async ({ page }, info) => {
    await page.goto(url + '/#plugins/text-to-speech'); await page.getByLabel('接口格式', { exact: true }).selectOption('deepseek-tts')
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(0); expect(await page.getByLabel('音色', { exact: true }).locator('option').allTextContents()).toEqual(['stella', 'tide']); await expect(page.getByText('海星女声或暗潮男声；当前不支持自定义语气、语速或声音克隆。', { exact: true })).toBeVisible()
    await page.getByLabel('服务地址', { exact: true }).fill(provider.ttsEndpoint); await page.getByLabel('API Key', { exact: true }).fill(['fixture', 'deepseek', 'key'].join('-')); await page.getByLabel('音色', { exact: true }).selectOption('tide'); await page.getByLabel('朗读前去除 Markdown 格式', { exact: true }).uncheck(); await page.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(page.getByText('配置已保存，未调用语音合成。', { exact: true })).toBeVisible(); expect(provider.synthesis).toHaveLength(0)
    await page.getByLabel('朗读文本', { exact: true }).fill('你好。'); await page.getByRole('button', { name: '生成试听', exact: true }).click(); expect(provider.synthesis).toHaveLength(0); await page.getByRole('button', { name: '确认生成', exact: true }).click(); await expect(page.locator('.speech-job').getByText('合成成功', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '播放语音', exact: true }).click(); await expect.poll(() => page.locator('audio').evaluate((e: HTMLAudioElement) => e.readyState)).toBeGreaterThanOrEqual(1)
    expect(provider.synthesis).toEqual([{ text: '你好。', parameters: { voice_id: 'tide', format: 'pcm', filter_markdown: 'false' } }]); await page.screenshot({ path: info.outputPath('deepseek-tts-desktop.png') })
    await page.locator('#display-language').selectOption('en-US'); await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('Voice', { exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath('deepseek-tts-mobile.png') })
  })
  test('validates uploads locally, requires paid confirmation, shows the real transcript and supports deletion', async ({ page }, info) => {
    await configureRecognition(page); expect(provider.recognition).toHaveLength(0)
    await page.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.from('Invalid audio') }); await expect(page.getByRole('alert')).toHaveText('请选择有效的 16 位 PCM WAV 或 Ogg Opus，最多 8 MiB／120 秒。'); expect(provider.recognition).toHaveLength(0)
    await page.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'speech.wav', mimeType: 'audio/wav', buffer: inputWav() }); await page.getByRole('button', { name: '开始识别', exact: true }).click(); await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused(); expect(provider.recognition).toHaveLength(0); await page.getByRole('button', { name: '确认识别', exact: true }).click(); await expect(page.getByText('上海今天天气怎么样？', { exact: true })).toBeVisible(); expect(provider.recognition).toHaveLength(1)
    await page.screenshot({ path: info.outputPath('asr-desktop.png') }); await page.locator('#display-language').selectOption('en-US'); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Transcribe', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath('asr-mobile.png') }); await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Delete task and transcript', exact: true }).click(); await expect(page.locator('.recognition-job')).toHaveCount(0); expect(provider.recognition).toHaveLength(1)
  })
  test('locale changes keep drafts without mutations and hiding clears unsaved key and selected audio', async ({ page }) => {
    await configureRecognition(page); await page.getByLabel('API Key', { exact: true }).fill('temporary-fixture-key'); await page.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'speech.wav', mimeType: 'audio/wav', buffer: inputWav() })
    const writes: string[] = []; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/speech-to-text/')) writes.push(r.url()) }); await page.locator('#display-language').selectOption('en-US'); await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('temporary-fixture-key'); expect(writes).toEqual([])
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) }); await expect(page.getByLabel('API Key', { exact: true })).toHaveValue(''); expect(await page.getByLabel('Audio file', { exact: true }).inputValue()).toBe(''); expect(provider.recognition).toHaveLength(0)
  })
  test('QQ audio mapping binds owner confirmation to the connected account and keeps drafts across locale', async ({ page }, info) => {
    await page.goto(url + '/#robots/qq'); await page.getByLabel('OneBot 地址', { exact: true }).fill(onebot.endpoint); await page.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(page.getByText('配置已保存。点击“连接 OneBot”重新连接。', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '连接 OneBot', exact: true }).click(); await expect.poll(() => onebot.connections.length).toBe(1)
    await page.getByRole('button', { name: '重新读取音频目录', exact: true }).click(); await page.getByRole('checkbox', { name: '使用音频缓存共享目录', exact: true }).check(); await page.getByLabel('OneBot 音频缓存目录', { exact: true }).fill('/onebot/audio'); await page.getByLabel('Eating 可读的对应目录', { exact: true }).fill(join(root, 'audio-cache')); await page.getByRole('checkbox', { name: '我确认以上两个目录指向同一份音频缓存，并允许读取当前账号收到的语音。', exact: true }).check(); await page.getByRole('button', { name: '保存音频目录', exact: true }).click(); await expect(page.getByRole('tabpanel').getByText('音频目录设置已保存。', { exact: true })).toBeVisible(); expect(onebot.connections).toHaveLength(1)
    await page.getByLabel('OneBot 音频缓存目录', { exact: true }).fill('/onebot/changed'); await expect(page.getByRole('checkbox', { name: '我确认以上两个目录指向同一份音频缓存，并允许读取当前账号收到的语音。', exact: true })).not.toBeChecked(); await page.locator('#display-language').selectOption('en-US'); await expect(page.getByLabel('Audio cache directory on OneBot', { exact: true })).toHaveValue('/onebot/changed'); await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('Audio cache directory on OneBot', { exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath('qq-audio-cache-mobile.png') })
  })
  test('loads a long transcript explicitly from a bounded task preview without another paid request', async ({ page }) => {
    await provider.close(); provider = await startDeepSeekSpeechFixture('long'); await configureRecognition(page)
    await page.getByLabel('音频文件', { exact: true }).setInputFiles({ name: 'speech.wav', mimeType: 'audio/wav', buffer: inputWav() }); await page.getByRole('button', { name: '开始识别', exact: true }).click(); await page.getByRole('button', { name: '确认识别', exact: true }).click()
    await expect(page.locator('.recognition-result')).toHaveText('长'.repeat(160)); await page.getByRole('button', { name: '查看完整转写', exact: true }).click(); await expect(page.locator('.recognition-result')).toHaveText('长'.repeat(32000)); expect(provider.recognition).toHaveLength(1)
  })

})
