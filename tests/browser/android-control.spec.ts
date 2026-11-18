import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { EatingHost } from '../../apps/host/src/app'
import { createInstalledHost } from '../../apps/host/src/installed-host'
import { installPluginPackage } from '../../apps/host/src/plugin-installation'
import { adbFixturePng, createAdbFixture } from '../fixtures/adb'
import type { AdbFixtureHandle } from '../fixtures/adb'

test.describe('完整 ADB 本机管理与 USB／网络设备面板端到端', () => {
  let directory = ''
  let host: EatingHost | null = null
  let url = ''
  let adbHandle!: AdbFixtureHandle

  test.beforeEach(async () => {
    const parent = await realpath(tmpdir())
    directory = await realpath(await mkdtemp(join(parent, 'eating-android-browser-')))
    adbHandle = await createAdbFixture(directory, {
      devices: [
        { serial: 'usb-phone-1', state: 'device', model: 'Pixel_USB', product: 'panther' },
      ],
      connectOutcomes: {
        '192.168.1.50:5555': { state: 'device', model: 'Pixel_Net', product: 'net' },
        '192.168.1.51:5555': { state: 'unauthorized', model: 'Locked_Phone' },
        '192.168.1.52:5555': { state: 'offline', model: 'Sleep_Phone' },
        '192.168.1.99:5555': { state: 'fail', message: 'cannot connect to 192.168.1.99:5555: Connection refused' },
        '[::1]:5555': { state: 'device', model: 'Tunnel_V6', product: 'v6' },
      },
      pairOutcomes: {
        '192.168.1.50:37123': { ok: true, expectedCode: '482910' },
      },
    })
    await installPluginPackage(directory, fileURLToPath(new URL('../../plugins/capabilities/android-control/dist/', import.meta.url)))
    host = await createInstalledHost({
      dataDirectory: directory,
      staticDirectory: fileURLToPath(new URL('../../dist/', import.meta.url)),
      port: 0,
      allowedUiOrigins: [],
    })
    url = await host.listen()
  })

  test.afterEach(async () => {
    await host?.close()
    host = null
    if (directory) {
      const parent = await realpath(tmpdir())
      if (await realpath(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-android-browser-')) {
        throw new Error('Unsafe fixture cleanup')
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('executes commands, host chunked files, live screenshot, dual status separation, and network ADB states cleanly', async ({ page }) => {
    const configPath = join(directory, 'capabilities', 'android-control', 'config.json')
    await page.goto(url + '/#plugins/android-control')
    await expect(page.getByRole('heading', { name: '玩手机' })).toBeVisible()

    const connTab = page.getByRole('tabpanel', { name: 'ADB 与设备连接' })

    // Open ADB & Device Connection tab cleanly regardless of pre-existing system ADB on host OS
    await page.getByRole('tab', { name: 'ADB 与设备连接' }).click()
    await expect(page.getByRole('tab', { name: 'ADB 与设备连接' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('执行与路径位于 Eating 所在机器').first()).toBeVisible()
    await expect(connTab.getByText(/127\.0\.0\.1 指 Eating 所在机器/)).toBeVisible()

    // Set manual ADB path -> save (handling connected reconnect confirmation if system ADB auto-connected)
    const adbInput = connTab.getByLabel('自定义 ADB 绝对路径（留空则自动检测）', { exact: true })
    await adbInput.fill(adbHandle.path)
    await connTab.getByRole('button', { name: /保存高级配置|停止运行时、保存配置并重连/ }).click()
    const reconnectConfirm = connTab.getByRole('alertdialog', { name: '保存并重启 ADB 运行时？' }).getByRole('button', { name: '停止运行时、保存配置并重连' })
    if (await reconnectConfirm.isVisible().catch(() => false)) {
      await reconnectConfirm.click()
      await expect(connTab.getByText('已停止原运行时、保存配置并重新连接。')).toBeVisible()
    } else {
      await expect(connTab.getByText('连接配置已保存。')).toBeVisible()
    }

    // Ensure plugin is enabled & connected, and wait until host connection cycle finishes
    const enableSwitch = page.getByRole('switch')
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click()
    }
    const connectBtn = page.getByRole('button', { name: '连接服务' })
    if (await connectBtn.isVisible().catch(() => false)) {
      await connectBtn.click()
    }
    await expect(page.getByRole('button', { name: '断开服务' })).toBeVisible()
    await expect(page.getByText('手机在线：usb-phone-1 (Pixel_USB)')).toBeVisible()

    // Connect a network device ([::1]:5555 / IPv4), inspect offline / unauthorized / failure states
    const netConnectBtn = connTab.getByRole('button', { name: '保存并连接设备' })
    const netAddr = connTab.getByLabel('网络设备地址（主机:端口）', { exact: true })
    await netAddr.fill('192.168.1.51:5555')
    await expect(netConnectBtn).toBeEnabled()
    await netConnectBtn.click()
    await expect(connTab.getByRole('alert').filter({ hasText: /未授权无线调试（unauthorized）/ })).toBeVisible()

    await netAddr.fill('192.168.1.52:5555')
    await netConnectBtn.click()
    await expect(connTab.getByRole('alert').filter({ hasText: /离线状态（offline）/ })).toBeVisible()

    await netAddr.fill('192.168.1.99:5555')
    await netConnectBtn.click()
    await expect(connTab.getByRole('alert').filter({ hasText: /Connection refused/ })).toBeVisible()

    // Online IPv4 device succeeds and sets defaultDevice
    await netAddr.fill('192.168.1.50:5555')
    await connTab.getByRole('button', { name: '保存并连接设备' }).click()
    await expect(connTab.getByText('已保存地址并确认设备在线：192.168.1.50:5555')).toBeVisible()
    await expect(page.getByText('手机在线：192.168.1.50:5555 (Pixel_Net)')).toBeVisible()

    // Wireless pairing clears ephemeral code on submit AND visibilitychange and never saves it to config.json
    await page.getByLabel('配对地址（主机:端口）', { exact: true }).fill('192.168.1.50:37123')
    await page.getByLabel('无线配对码', { exact: true }).fill('temp-secret-code')
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(connTab.getByLabel('无线配对码', { exact: true })).toHaveValue('')
    await expect(connTab.getByText(/已自动清空/)).toBeVisible()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await connTab.getByLabel('无线配对码', { exact: true }).fill('482910')
    await connTab.getByRole('button', { name: '执行无线配对' }).click()
    await expect(connTab.getByText(/无线配对已完成/)).toBeVisible()
    await expect(page.getByLabel('无线配对码', { exact: true })).toHaveValue('')
    expect(await readFile(configPath, 'utf8')).not.toContain('482910')

    // Console tab: run command on defaultDevice vs explicit serial
    const consoleTab = page.getByRole('tabpanel', { name: '控制台与进程' })
    await page.getByRole('tab', { name: '控制台与进程' }).click()
    await expect(consoleTab.getByText('当前默认目标：192.168.1.50:5555')).toBeVisible()
    await consoleTab.getByRole('button', { name: '系统属性' }).click()
    await consoleTab.getByRole('button', { name: '执行命令' }).click()
    await expect(consoleTab.getByText(/命令执行请求已完成/)).toBeVisible()
    await expect(consoleTab.locator('.android-output-pre')).toContainText('192.168.1.50:5555')

    // Explicit serial override targets usb-phone-1 without changing defaultDevice
    await consoleTab.getByLabel('目标设备 serial（可选，留空用默认设备）', { exact: true }).fill('usb-phone-1')
    await consoleTab.getByRole('button', { name: '执行命令' }).click()
    await expect(consoleTab.locator('.android-output-pre')).toContainText('usb-phone-1')

    // Screen & Files tab: upload chunked file to Eating host + browse + screenshot
    const filesTab = page.getByRole('tabpanel', { name: '屏幕与文件传输' })
    await page.getByRole('tab', { name: '屏幕与文件传输' }).click()
    await filesTab.getByLabel('Eating 本机路径（相对工作目录或绝对路径）', { exact: true }).fill('browser-note.txt')
    await filesTab.getByLabel('选择本地文件（待分块上传到 Eating 机器）', { exact: true }).setInputFiles({
      name: 'note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('eating-android-host-file-0.3.0'),
    })
    await filesTab.getByRole('button', { name: '上传（分块覆盖写入）' }).click()
    await expect(filesTab.getByText(/已分块写入到 Eating 机器.*browser-note\.txt/)).toBeVisible()
    expect(await readFile(join(directory, 'capabilities', 'android-control', 'workspace', 'browser-note.txt'), 'utf8')).toBe('eating-android-host-file-0.3.0')

    await filesTab.getByRole('button', { name: '立即截图' }).click()
    const shotImg = filesTab.getByAltText('安卓设备实时屏幕截图')
    await expect(shotImg).toBeVisible()
    expect(await shotImg.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true)

    // Verify 390px mobile responsive layout without horizontal overflow
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'ADB 与设备连接' }).click()
    await expect(page.getByRole('button', { name: '保存并连接设备' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })

  test('renders clean legacy v1 config rebuild flow without auto-migrating remote MCP fields', async ({ page }) => {
    await host!.close()
    const pluginDir = join(directory, 'capabilities', 'android-control')
    const cfgFile = join(pluginDir, 'config.json')
    const workDir = join(pluginDir, 'workspace')
    mkdirSync(workDir, { recursive: true })
    const legacy = JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      mode: 'remote',
      endpoint: 'http://127.0.0.1:9191/mcp',
      token: 'old-remote-token',
      adbPath: '',
      workspace: '',
    })
    await writeFile(cfgFile, legacy, 'utf8')
    await writeFile(join(workDir, 'keep.txt'), 'kept-during-rebuild', 'utf8')

    host = await createInstalledHost({
      dataDirectory: directory,
      staticDirectory: fileURLToPath(new URL('../../dist/', import.meta.url)),
      port: 0,
      allowedUiOrigins: [],
    })
    url = await host.listen()

    await page.goto(url + '/#plugins/android-control')
    await expect(page.getByRole('heading', { name: '检测到不受支持的旧版配置或损坏配置' })).toBeVisible()
    // Original legacy file must remain untouched and endpoint must NOT be interpreted as networkAddress
    expect(await readFile(cfgFile, 'utf8')).toBe(legacy)
    await expect(page.getByLabel('网络设备地址（主机:端口）', { exact: true })).toHaveValue('')

    const connTab = page.getByRole('tabpanel', { name: 'ADB 与设备连接' })
    await connTab.getByRole('button', { name: '重建连接配置' }).click()
    await connTab.getByRole('button', { name: '确认' }).click()
    await expect(connTab.getByText('连接配置已重建为全新 v2 默认状态。')).toBeVisible()
    const saved = JSON.parse(await readFile(cfgFile, 'utf8'))
    expect(saved.schemaVersion).toBe(2)
    expect(saved.endpoint).toBeUndefined()
    expect(saved.token).toBeUndefined()
    expect(saved.networkAddress).toBe('')
    expect(await readFile(join(workDir, 'keep.txt'), 'utf8')).toBe('kept-during-rebuild')
    expect(adbFixturePng.length).toBeGreaterThan(0)
  })

  test('handles missing ADB installer preview, license confirmation, removal flow, system-ADB lock, and English locale', async ({ page }) => {
    const toolsDir = join(directory, 'capabilities', 'android-control', 'tools', 'platform-tools')
    let fakeInstalled = false
    let fakeSystem = false

    const baseEnv = (overrides: Record<string, unknown> = {}) => ({
      available: fakeSystem || fakeInstalled,
      source: fakeSystem ? 'system' : fakeInstalled ? 'plugin' : 'none',
      version: fakeSystem ? '1.0.41 (35.0.2-system)' : fakeInstalled ? '1.0.41 (36.0.0-plugin)' : null,
      path: fakeSystem ? '/usr/bin/adb' : fakeInstalled ? join(toolsDir, 'adb') : null,
      systemAvailable: fakeSystem,
      systemPath: fakeSystem ? '/usr/bin/adb' : null,
      systemVersion: fakeSystem ? '1.0.41 (35.0.2-system)' : null,
      pluginInstalled: fakeInstalled,
      pluginPath: fakeInstalled ? join(toolsDir, 'adb') : null,
      pluginVersion: fakeInstalled ? '1.0.41 (36.0.0-plugin)' : null,
      pluginInstallRecord: fakeInstalled ? {
        schemaVersion: 1,
        version: '36.0.0',
        revision: '36.0.0',
        url: 'https://dl.google.com/android/repository/platform-tools_r36.0.0-darwin.zip',
        sha256: 'a'.repeat(64),
        sizeBytes: 12582912,
        license: 'Android SDK License Agreement',
        licenseUrl: 'https://developer.android.com/studio/terms',
        platform: process.platform,
        arch: process.arch,
        executablePath: join(toolsDir, 'adb'),
        installedAt: new Date().toISOString(),
      } : null,
      manualSpecified: false,
      manualValid: false,
      errorCode: fakeSystem || fakeInstalled ? null : 'ANDROID_ADB_MISSING',
      errorMessage: null,
      packageInfo: {
        supported: true,
        platform: process.platform,
        arch: process.arch,
        targetLabel: 'macOS / Linux Fixture',
        version: '36.0.0',
        sizeBytes: 12582912,
        licenseName: 'Android SDK License Agreement',
        licenseUrl: 'https://developer.android.com/studio/terms',
        releaseNotesUrl: 'https://developer.android.com/tools/releases/platform-tools',
        url: null,
        unsupportedReasonCode: null,
        unsupportedReason: null,
      },
      checkedAt: new Date().toISOString(),
      ...overrides,
    })

    const cfgPayload = () => ({
      configState: 'ok',
      configErrorCode: null,
      configErrorMessage: null,
      configurationPath: join(directory, 'capabilities', 'android-control', 'config.json'),
      schemaVersion: 2,
      revision: 0,
      connectionMode: 'usb',
      networkAddress: '',
      defaultDevice: '',
      adbPath: '',
      adbPathConfigured: false,
      workspace: '',
      dataDirectory: join(directory, 'capabilities', 'android-control'),
      toolsDirectory: join(directory, 'capabilities', 'android-control', 'tools'),
      platformToolsDirectory: toolsDir,
      defaultWorkspace: join(directory, 'capabilities', 'android-control', 'workspace'),
      hostPlatform: process.platform,
      hostArch: process.arch,
      connected: false,
      ready: false,
      adbAvailable: fakeSystem || fakeInstalled,
      adbEnvironment: baseEnv(),
      deviceOnline: false,
      activeDevice: null,
      devices: [],
      deviceCheckErrorCode: null,
      deviceCheckErrorMessage: null,
      uninstallNotice: 'Host uninstall retains data.',
    })

    await page.route('**/api/plugins/android-control/configuration', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: cfgPayload() })
        return
      }
      await route.continue()
    })

    await page.route('**/api/plugins/android-control/manage', async route => {
      const body = route.request().postDataJSON() as { operation?: string }
      if (body.operation === 'detect-adb') {
        await route.fulfill({ json: { detection: baseEnv(), devices: null, configuration: cfgPayload() } })
        return
      }
      if (body.operation === 'install-info') {
        await route.fulfill({ json: { packageInfo: baseEnv().packageInfo } })
        return
      }
      if (body.operation === 'install-adb') {
        fakeInstalled = true
        await route.fulfill({ json: { install: baseEnv().pluginInstallRecord, detection: baseEnv(), devices: null, configuration: cfgPayload() } })
        return
      }
      if (body.operation === 'remove-installed-adb') {
        fakeInstalled = false
        await route.fulfill({ json: { removed: true, detection: baseEnv(), devices: null, configuration: cfgPayload() } })
        return
      }
      await route.continue()
    })

    await page.goto(url + '/#plugins/android-control')
    await expect(page.getByText('ADB 未检测到')).toBeVisible()
    await expect(page.getByText('暂无在线手机')).toBeVisible()

    const connTab = page.getByRole('tabpanel', { name: 'ADB 与设备连接' })
    // Install official ADB via UI preview + license accept
    await connTab.getByRole('button', { name: '安装 ADB' }).click()
    await expect(connTab.getByText(/36\.0\.0/)).toBeVisible()
    await expect(connTab.getByText(/12\.0 MB/)).toBeVisible()
    await connTab.getByRole('checkbox').check()
    await connTab.getByRole('button', { name: '确认下载并安装' }).click()
    await expect(connTab.getByText(/插件已成功安装并验证 ADB/)).toBeVisible()
    await expect(page.getByText('ADB 可用（插件已安装）')).toBeVisible()
    // Device online remains strictly separate -> still shows no online phone!
    await expect(page.getByText('暂无在线手机')).toBeVisible()

    // Remove plugin-installed ADB
    await connTab.getByRole('button', { name: '移除插件安装的 ADB' }).click()
    await connTab.getByRole('button', { name: '确认移除' }).click()
    await expect(connTab.getByText('已停止相关使用并移除插件安装的 ADB，连接配置与工作文件均已保留。')).toBeVisible()

    // When system ADB exists, Install ADB button is disabled & shows reason
    fakeSystem = true
    await page.getByRole('button', { name: '重新检测' }).click()
    await expect(page.getByText('ADB 可用（系统 PATH / Android SDK）')).toBeVisible()
    await expect(page.getByRole('button', { name: '安装 ADB' })).toBeDisabled()

    // Verify English locale toggle works cleanly across labels without translation key leakage
    await page.evaluate(() => { localStorage.setItem('eating.locale', 'en-US') })
    await page.reload()
    await page.goto(url + '/#plugins/android-control')
    await page.getByRole('tab', { name: 'ADB & Device Connection' }).click()
    await expect(page.getByRole('tab', { name: 'ADB & Device Connection' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Install ADB' })).toBeDisabled()
    expect(existsSync(toolsDir)).toBe(false)
  })

  test('continues polling ANDROID_IMAGE_PENDING via android_process_read with progress and localizes image failures', async ({ page }) => {
    await page.goto(url + '/#plugins/android-control')
    const connTab = page.getByRole('tabpanel', { name: 'ADB 与设备连接' })
    await page.getByRole('tab', { name: 'ADB 与设备连接' }).click()
    await connTab.getByLabel('自定义 ADB 绝对路径（留空则自动检测）', { exact: true }).fill(adbHandle.path)
    await connTab.getByRole('button', { name: /保存高级配置|停止运行时、保存配置并重连/ }).click()
    const reconnectConfirm = connTab.getByRole('alertdialog', { name: '保存并重启 ADB 运行时？' }).getByRole('button', { name: '停止运行时、保存配置并重连' })
    if (await reconnectConfirm.isVisible().catch(() => false)) {
      await reconnectConfirm.click()
      await expect(connTab.getByText('已停止原运行时、保存配置并重新连接。')).toBeVisible()
    } else {
      await expect(connTab.getByText('连接配置已保存。')).toBeVisible()
    }
    const enableSwitch = page.getByRole('switch')
    if (!(await enableSwitch.isChecked())) await enableSwitch.click()
    const connectBtn = page.getByRole('button', { name: '连接服务' })
    if (await connectBtn.isVisible().catch(() => false)) await connectBtn.click()
    await expect(page.getByRole('button', { name: '断开服务' })).toBeVisible()

    let readCount = 0
    let failMode = false
    const pendingPid = '11111111-1111-4111-8111-111111111111'
    await page.route('**/api/plugins/android-control/invoke', async route => {
      const body = route.request().postDataJSON() as { name?: string }
      if (body.name === 'android_screenshot') {
        if (failMode) {
          await route.fulfill({
            json: {
              ok: true,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ processId: pendingPid, status: 'exited', output_error: 'ANDROID_IMAGE_UNAVAILABLE' }) }],
                structuredContent: { processId: pendingPid, status: 'exited', output_error: 'ANDROID_IMAGE_UNAVAILABLE' },
              },
            },
          })
          return
        }
        await route.fulfill({
          json: {
            ok: true,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ processId: pendingPid, status: 'running', stdoutBytes: 1048576, output_error: 'ANDROID_IMAGE_PENDING' }) }],
              structuredContent: { processId: pendingPid, status: 'running', stdoutBytes: 1048576, output_error: 'ANDROID_IMAGE_PENDING' },
            },
          },
        })
        return
      }
      if (body.name === 'android_process_read') {
        readCount++
        if (readCount === 1) {
          await route.fulfill({
            json: {
              ok: true,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ processId: pendingPid, status: 'running', stdoutBytes: 2097152, output_error: 'ANDROID_IMAGE_PENDING' }) }],
                structuredContent: { processId: pendingPid, status: 'running', stdoutBytes: 2097152, output_error: 'ANDROID_IMAGE_PENDING' },
              },
            },
          })
          return
        }
        await route.fulfill({
          json: {
            ok: true,
            result: {
              content: [
                { type: 'text', text: JSON.stringify({ processId: pendingPid, status: 'exited', exitCode: 0, stdoutBytes: adbFixturePng.length, complete: true }) },
                { type: 'image', mimeType: 'image/png', data: adbFixturePng.toString('base64') },
              ],
              structuredContent: { processId: pendingPid, status: 'exited', exitCode: 0, stdoutBytes: adbFixturePng.length, complete: true },
            },
          },
        })
        return
      }
      await route.continue()
    })

    const filesTab = page.getByRole('tabpanel', { name: '屏幕与文件传输' })
    await page.getByRole('tab', { name: '屏幕与文件传输' }).click()
    await filesTab.getByRole('button', { name: '立即截图' }).click()
    await expect(filesTab.getByText(/正在接收屏幕截图（已收到 1\.0 MB，进程 11111111）/)).toBeVisible()
    await expect(filesTab.getByRole('button', { name: '取消本次截图' })).toBeVisible()
    await expect(filesTab.getByText(/已收到 2\.0 MB/)).toBeVisible()
    const shotImg = filesTab.getByAltText('安卓设备实时屏幕截图')
    await expect(shotImg).toBeVisible()
    expect(await shotImg.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true)
    await expect(filesTab.getByRole('alert')).toHaveCount(0)

    failMode = true
    await filesTab.getByRole('button', { name: '立即截图' }).click()
    await expect(filesTab.getByRole('alert')).toContainText('截图未能成图（命令失败、设备离线或图片大小超过上限）')
  })
})
