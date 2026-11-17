import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_LIMITS } from '@eating/plugin-sdk'
import type { HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import { AdbManager, extractPlatformToolsZip } from './adb'
import { AndroidPlugin } from '../server'
import { buildZipBuffer, createAdbFixture, startPlatformToolsRepoFixture } from '../../../../../tests/fixtures/adb'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

async function makeTempDir(prefix = 'eating-adb-mgr-') {
  const parent = await realpath(tmpdir())
  const dir = await realpath(await mkdtemp(join(parent, prefix)))
  stops.push(async () => {
    if (await realpath(dir) !== dir || dirname(dir) !== parent || !basename(dir).startsWith(prefix)) {
      throw Error('Unsafe fixture cleanup')
    }
    await rm(dir, { recursive: true })
  })
  return dir
}

function makePluginContext(dataDirectory: string): HostPluginContext {
  return {
    dataDirectory,
    getSetting: () => null,
    setSetting: () => {},
    recordEvent: () => ({ inserted: true, eventId: 'evt-1' }),
    listMessages: () => [],
    imageLimits: () => DEFAULT_IMAGE_LIMITS,
    executeIdempotent: async (_p, _a, _params, _id, fn) => fn(),
  }
}

describe('ADB 检测顺序、内置安装校验、网络设备配对与工具移除', () => {
  it('follows strict precedence (manual -> system -> plugin) and never falls back when manual path is invalid', async () => {
    const dir = await makeTempDir()
    const sysDir = join(dir, 'sys-bin')
    const sdkDir = join(dir, 'android-sdk')
    mkdirSync(sysDir, { recursive: true })
    mkdirSync(join(sdkDir, 'platform-tools'), { recursive: true })

    const manualExe = join(dir, 'manual-adb.sh')
    const sysExe = join(sysDir, process.platform === 'win32' ? 'adb.exe' : 'adb')
    const pluginExeDir = join(dir, 'data', 'tools', 'platform-tools')
    mkdirSync(pluginExeDir, { recursive: true })
    const pluginExe = join(pluginExeDir, process.platform === 'win32' ? 'adb.exe' : 'adb')

    const makeExe = (path: string, versionTag: string) => {
      writeFileSync(path, `#!/bin/sh\necho "Android Debug Bridge version 1.0.41"\necho "Version ${versionTag}"\n`, { mode: 0o755 })
      chmodSync(path, 0o755)
    }
    makeExe(manualExe, '99.0.0-manual')
    makeExe(sysExe, '35.0.0-system')
    makeExe(pluginExe, '34.0.0-plugin')

    const mgr = new AdbManager(join(dir, 'data'), {
      env: { PATH: sysDir },
      platform: 'linux',
      arch: 'x64',
      skipWellKnownPaths: true,
    })

    // 1. Valid manual overrides both system & plugin
    const resManual = await mgr.detect({ adbPath: manualExe })
    expect(resManual.available).toBe(true)
    expect(resManual.source).toBe('manual')
    expect(resManual.version).toContain('99.0.0-manual')

    // 2. Invalid manual path MUST error and NOT fall back to system/plugin
    const resInvalid = await mgr.detect({ adbPath: join(dir, 'does-not-exist-adb') })
    expect(resInvalid.available).toBe(false)
    expect(resInvalid.errorCode).toBe('ANDROID_MANUAL_ADB_INVALID')
    expect(resInvalid.manualSpecified).toBe(true)
    expect(resInvalid.manualValid).toBe(false)
    expect(resInvalid.systemAvailable).toBe(true)

    // 3. Empty manual uses system PATH over plugin
    const resSystem = await mgr.detect({ adbPath: '' })
    expect(resSystem.available).toBe(true)
    expect(resSystem.source).toBe('system')
    expect(resSystem.version).toContain('35.0.0-system')

    // 4. Removing system binary falls back to plugin-installed
    await rm(sysExe)
    const resPlugin = await mgr.detect({ adbPath: '' })
    expect(resPlugin.available).toBe(true)
    expect(resPlugin.source).toBe('plugin')
    expect(resPlugin.version).toContain('34.0.0-plugin')
  })

  it('refuses duplicate download when system ADB exists or license unaccepted, and blocks unsupported OS/arch cleanly', async () => {
    const dir = await makeTempDir()
    const repo = await startPlatformToolsRepoFixture()
    stops.push(() => repo.close())

    const sysBin = join(dir, 'sysbin')
    mkdirSync(sysBin, { recursive: true })
    const sysAdb = join(sysBin, 'adb')
    writeFileSync(sysAdb, '#!/bin/sh\necho "Android Debug Bridge version 1.0.41"\n', { mode: 0o755 })
    chmodSync(sysAdb, 0o755)

    // System ADB exists -> refuses to download
    const mgrSys = new AdbManager(join(dir, 'd1'), {
      repositoryUrl: repo.repositoryUrl,
      env: { PATH: sysBin },
      platform: 'linux',
      arch: 'x64',
    })
    await expect(mgrSys.installPluginAdb({ adbPath: '' }, { acceptLicense: false })).rejects.toMatchObject({ code: 'ANDROID_LICENSE_NOT_ACCEPTED' })
    await expect(mgrSys.installPluginAdb({ adbPath: '' }, { acceptLicense: true })).rejects.toMatchObject({ code: 'ANDROID_SYSTEM_ADB_EXISTS' })
    expect(repo.manifestRequests).toBe(0)
    expect(repo.archiveRequests).toBe(0)

    // Unsupported CPU architecture (linux arm64) -> refuses before downloading
    const mgrArm = new AdbManager(join(dir, 'd2'), {
      repositoryUrl: repo.repositoryUrl,
      env: { PATH: '' },
      platform: 'linux',
      arch: 'arm64',
    })
    await expect(mgrArm.installPluginAdb({ adbPath: '' }, { acceptLicense: true })).rejects.toMatchObject({ code: 'ANDROID_PLATFORM_UNSUPPORTED' })
    expect(repo.manifestRequests).toBe(0)
    expect(repo.archiveRequests).toBe(0)
  })

  it('downloads, verifies SHA-256 & version, deduplicates concurrent clicks, and cleans up temp files on every failure mode', async () => {
    const dir = await makeTempDir()

    // 1. Happy path + concurrent dedupe into one install task
    const slowRepo = await startPlatformToolsRepoFixture({ delayMs: 40 })
    stops.push(() => slowRepo.close())
    const dataDir = join(dir, 'plugin-data')
    const mgr = new AdbManager(dataDir, {
      repositoryUrl: slowRepo.repositoryUrl,
      env: { PATH: '' },
      homeDir: join(dir, 'empty-home'),
      skipWellKnownPaths: true,
      platform: process.platform,
      arch: process.arch,
    })

    const results = await Promise.all([
      mgr.installPluginAdb({ adbPath: '' }, { acceptLicense: true }),
      mgr.installPluginAdb({ adbPath: '' }, { acceptLicense: true }),
      mgr.installPluginAdb({ adbPath: '' }, { acceptLicense: true }),
    ])
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
    expect(slowRepo.manifestRequests).toBe(1)
    expect(slowRepo.archiveRequests).toBe(1)
    expect(existsSync(join(dataDir, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'))).toBe(true)
    expect(existsSync(join(dataDir, 'tools', 'install.json'))).toBe(true)
    expect(readdirSync(join(dataDir, 'tools')).some(n => n.startsWith('.tmp-'))).toBe(false)

    // 2. Checksum mismatch, size mismatch, broken adb binary, HTTP failure all reject cleanly without leaving temps
    const badCheckRepo = await startPlatformToolsRepoFixture({ checksumOverride: '0'.repeat(64) })
    stops.push(() => badCheckRepo.close())
    const badCheckDir = join(dir, 'bad-check')
    const badCheckMgr = new AdbManager(badCheckDir, { repositoryUrl: badCheckRepo.repositoryUrl, env: { PATH: '' }, homeDir: join(dir, 'empty-home'), skipWellKnownPaths: true })
    await expect(badCheckMgr.installPluginAdb({ adbPath: '' }, { acceptLicense: true })).rejects.toMatchObject({ code: 'ANDROID_INSTALL_CHECKSUM_FAILED' })
    expect(existsSync(join(badCheckDir, 'tools', 'platform-tools'))).toBe(false)
    expect(readdirSync(join(badCheckDir, 'tools')).some(n => n.startsWith('.tmp-'))).toBe(false)

    const badSizeRepo = await startPlatformToolsRepoFixture({ sizeOverride: 9999999 })
    stops.push(() => badSizeRepo.close())
    const badSizeDir = join(dir, 'bad-size')
    const badSizeMgr = new AdbManager(badSizeDir, { repositoryUrl: badSizeRepo.repositoryUrl, env: { PATH: '' }, homeDir: join(dir, 'empty-home'), skipWellKnownPaths: true })
    await expect(badSizeMgr.installPluginAdb({ adbPath: '' }, { acceptLicense: true })).rejects.toMatchObject({ code: 'ANDROID_INSTALL_SIZE_MISMATCH' })
    expect(readdirSync(join(badSizeDir, 'tools')).some(n => n.startsWith('.tmp-'))).toBe(false)

    const brokenExeRepo = await startPlatformToolsRepoFixture({ script: '#!/bin/sh\necho "broken"\nexit 2\n' })
    stops.push(() => brokenExeRepo.close())
    const brokenDir = join(dir, 'broken-exe')
    const brokenMgr = new AdbManager(brokenDir, { repositoryUrl: brokenExeRepo.repositoryUrl, env: { PATH: '' }, homeDir: join(dir, 'empty-home'), skipWellKnownPaths: true })
    await expect(brokenMgr.installPluginAdb({ adbPath: '' }, { acceptLicense: true })).rejects.toMatchObject({ code: 'ANDROID_INSTALL_VERIFY_FAILED' })
    expect(existsSync(join(brokenDir, 'tools', 'platform-tools'))).toBe(false)

    // 3. Zip-slip & symlink extraction defenses
    const traversalZip = buildZipBuffer([{ name: '../escaped.txt', data: 'bad' }])
    expect(() => extractPlatformToolsZip(traversalZip, join(dir, 'zip-out-1'))).toThrow()
    const symlinkZip = buildZipBuffer([{ name: 'platform-tools/adb', data: '/etc/passwd', externalAttributes: (0o120777 << 16) >>> 0 }])
    expect(() => extractPlatformToolsZip(symlinkZip, join(dir, 'zip-out-2'))).toThrow()
  })

  it('connects/pairs network devices, never logs/persists pairing codes, separates ADB status from device online, and cleanly removes plugin ADB', async () => {
    const dir = await makeTempDir('eating-android-plugin-')
    const dataDir = join(dir, 'data')
    const repo = await startPlatformToolsRepoFixture()
    stops.push(() => repo.close())

    // Start plugin with empty PATH (no system ADB) -> ADB missing yet panel configuration still works
    const plugin = new AndroidPlugin(makePluginContext(dataDir), {
      installer: {
        repositoryUrl: repo.repositoryUrl,
        env: { PATH: '' },
        homeDir: join(dir, 'empty-home'),
        skipWellKnownPaths: true,
      },
    })
    stops.push(() => plugin.dispose())

    await expect(plugin.connect()).rejects.toMatchObject({ code: 'ANDROID_ADB_MISSING' })
    const initialCfg = await plugin.manage('configuration', {}) as JsonObject
    expect(initialCfg.adbAvailable).toBe(false)
    expect(initialCfg.deviceOnline).toBe(false)

    // Install plugin-managed ADB via manage -> now ADB available, STILL 0 online phones!
    await plugin.manage('install-adb', { acceptLicense: true })
    await plugin.connect()
    const afterInstallCfg = plugin.getPublicConfiguration()
    expect(afterInstallCfg.connected).toBe(true)
    expect(afterInstallCfg.adbAvailable).toBe(true)
    expect(afterInstallCfg.deviceOnline).toBe(false)
    expect(plugin.getStatus().state).toBe('connected')

    // Now test stateful fixture ADB for USB + Network + Pair + Offline + Unauthorized + Remove tool
    await plugin.disconnect()
    const handle = await createAdbFixture(dir, {
      devices: [{ serial: 'usb-01', state: 'device', model: 'USB_Phone' }],
      connectOutcomes: {
        '192.168.1.50:5555': { state: 'device', model: 'Net_Phone' },
        '192.168.1.51:5555': { state: 'unauthorized', model: 'Unauth_Phone' },
        '192.168.1.52:5555': { state: 'offline', model: 'Offline_Phone' },
        '192.168.1.99:5555': { state: 'fail', message: 'cannot connect to 192.168.1.99:5555: Connection refused' },
      },
      pairOutcomes: {
        '192.168.1.50:37123': { ok: true, expectedCode: '654321' },
      },
    })

    // Configure manual adbPath to fixture -> reconnect
    const cfg0 = plugin.getPublicConfiguration()
    await plugin.updateConfiguration({
      expectedRevision: cfg0.revision,
      connectionMode: 'usb',
      networkAddress: '',
      defaultDevice: '',
      adbPath: handle.path,
      workspace: join(dataDir, 'custom-work'),
    })
    await plugin.connect()

    // Checkpair-device + secret hygiene
    const paired = await plugin.manage('pair-device', {
      pairAddress: '192.168.1.50:37123',
      pairCode: '654321',
      connectAddress: '192.168.1.50:5555',
    }) as JsonObject
    expect(paired.paired).toBe(true)
    expect(JSON.stringify(paired)).not.toContain('654321')
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).not.toContain('654321')

    const afterNet = plugin.getPublicConfiguration()
    expect(afterNet.connectionMode).toBe('network')
    expect(afterNet.networkAddress).toBe('192.168.1.50:5555')
    expect(afterNet.defaultDevice).toBe('192.168.1.50:5555')
    expect(afterNet.deviceOnline).toBe(true)

    // Unauthorized, offline, failed network connect states must NOT pretend device is online or replace confirmed defaultDevice
    const unauth = await plugin.manage('connect-device', { address: '192.168.1.51:5555' }) as JsonObject
    expect(unauth.ok).toBe(false)
    expect(unauth.state).toBe('unauthorized')
    const offl = await plugin.manage('connect-device', { address: '192.168.1.52:5555' }) as JsonObject
    expect(offl.ok).toBe(false)
    expect(offl.state).toBe('offline')
    const refused = await plugin.manage('connect-device', { address: '192.168.1.99:5555' }) as JsonObject
    expect(refused.ok).toBe(false)
    expect(refused.state).toBe('failed')

    // Write a workspace file + run a command (creates receipts.sqlite & processes.json), then remove plugin ADB
    await plugin.invoke('android_files', {
      op: 'put',
      path: 'keep.txt',
      offset: 0,
      overwrite: true,
      data: Buffer.from('preserve-me').toString('base64'),
      request_id: 'keep-file-req-001',
    }, 'keep-file-req-001')

    expect(existsSync(join(dataDir, 'tools', 'platform-tools'))).toBe(true)
    await plugin.manage('remove-installed-adb', { confirmed: true })
    expect(existsSync(join(dataDir, 'tools'))).toBe(false)
    expect(existsSync(join(dataDir, 'config.json'))).toBe(true)
    expect(existsSync(join(dataDir, 'receipts.sqlite'))).toBe(true)
    expect(existsSync(join(dataDir, 'custom-work', 'keep.txt'))).toBe(true)
    expect(plugin.getStatus().state).toBe('disconnected')
  })
})
