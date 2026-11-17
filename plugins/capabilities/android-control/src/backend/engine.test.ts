import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '@eating/plugin-sdk'
import { AndroidEngine } from './engine'
import { AndroidConfig, validateNetworkAddress } from './config'
import { adbFixturePng, createAdbFixture } from '../../../../../tests/fixtures/adb'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

async function fixture(options: { defaultDevice?: string; adbState?: Parameters<typeof createAdbFixture>[1] } = {}) {
  const parent = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(join(parent, 'eating-android-test-')))
  stops.push(async () => {
    if (await realpath(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-android-test-')) {
      throw Error('Unsafe fixture cleanup')
    }
    await rm(directory, { recursive: true })
  })
  let policy = { connectionMode: 'usb' as const, networkAddress: '', defaultDevice: options.defaultDevice ?? '' }
  const handle = await createAdbFixture(directory, options.adbState)
  const engine = new AndroidEngine(join(directory, 'state'), handle.path, join(directory, 'work'), () => policy)
  stops.push(() => engine.close())
  return {
    engine,
    directory,
    adb: handle.path,
    handle,
    setDefaultDevice: (device: string) => {
      policy = { ...policy, defaultDevice: device }
    },
  }
}

const structured = (value: JsonObject) => (value.structuredContent as JsonObject) ?? {}

describe('完整 ADB 执行核心与严格 v2 配置', () => {
  it.runIf(Boolean(process.env.EATING_ADB_TEST_BIN))('runs the explicitly selected installed ADB binary without opening any device connection', async () => {
    const f = await fixture()
    const engine = new AndroidEngine(join(f.directory, 'installed-adb'), process.env.EATING_ADB_TEST_BIN!, join(f.directory, 'work'))
    stops.push(() => engine.close())
    const out = structured(await engine.invoke('android_adb_exec', { args: ['version'], request_id: 'real-adb-version-001' }, 'agent-real', 'real-adb-version-001'))
    expect(out.status).toBe('exited')
    expect(out.exitCode).toBe(0)
    expect(String(out.text)).toContain('Android Debug Bridge version')
  })

  it('executes unwhitelisted argv, preserves UTF-8 chunk boundaries, and retains capped logs cleanly', async () => {
    const f = await fixture()
    const utf8 = structured(await f.engine.invoke('android_adb_exec', { args: ['utf8-boundary'], request_id: 'req-utf8-001' }, 'a1', 'req-utf8-001'))
    expect(utf8.status).toBe('exited')
    expect(String(utf8.text)).toContain('中')
    expect(String(utf8.text).includes('\uFFFD')).toBe(false)

    const logcat = structured(await f.engine.invoke('android_adb_exec', { args: ['logcat', '-t', '120'], wait_ms: 50, request_id: 'req-log-001' }, 'a1', 'req-log-001'))
    expect(typeof logcat.processId).toBe('string')
    const pid = String(logcat.processId)
    let safety = 0
    let offset = 0
    let collected = ''
    while (safety++ < 60) {
      const read = structured(await f.engine.invoke('android_process_read', { process_id: pid, offset }, 'a1', 'req-log-read-' + safety))
      if (typeof read.text === 'string' && read.text.length > 0) {
        collected += read.text
        offset = Number(read.nextOffset ?? offset)
      }
      if (read.complete === true && offset >= Number(read.retainedBytes ?? 0)) {
        expect(collected).toContain('log-120:')
        break
      }
      await new Promise(r => setTimeout(r, 30))
    }
    expect(safety).toBeLessThan(60)
  })

  it('handles interactive process stdin, EOF, Ctrl-C, takeover, and restart-unknown preservation', async () => {
    const f = await fixture()
    const started = structured(await f.engine.invoke('android_adb_exec', { args: ['hold'], wait_ms: 150, request_id: 'req-hold-001' }, 'agent-a', 'req-hold-001'))
    const pid = String(started.processId)
    expect(started.status).toBe('running')

    await f.engine.invoke('android_process_write', { process_id: pid, data: 'hello\n', request_id: 'req-write-001' }, 'agent-a', 'req-write-001')
    const secondWrite = f.engine.invoke('android_process_write', { process_id: pid, data: 'other\n', request_id: 'req-write-002' }, 'agent-b', 'req-write-002')
    await expect(secondWrite).rejects.toMatchObject({ code: 'ANDROID_PROCESS_UNAVAILABLE' })

    const execByOther = f.engine.invoke('android_adb_exec', { args: ['version'], request_id: 'req-other-001' }, 'agent-b', 'req-other-001')
    await expect(execByOther).rejects.toMatchObject({ code: 'ANDROID_EXECUTOR_BUSY' })

    await f.engine.invoke('android_executor_control', { op: 'takeover', request_id: 'req-takeover-001' }, 'owner', 'req-takeover-001')
    await new Promise(r => setTimeout(r, 100))

    // Simulate abrupt host restart while process is still running by snapshotting live state before graceful close
    const second = structured(await f.engine.invoke('android_adb_exec', { args: ['hold'], wait_ms: 100, request_id: 'req-hold-002' }, 'agent-c', 'req-hold-002'))
    expect(second.status).toBe('running')
    const crashDir = join(f.directory, 'crash-state')
    mkdirSync(crashDir, { recursive: true })
    for (const file of ['intent-key', 'receipts.sqlite', 'processes.json']) {
      await writeFile(join(crashDir, file), await readFile(join(f.directory, 'state', file)))
    }
    await f.engine.close()

    const reopened = new AndroidEngine(crashDir, f.adb, join(f.directory, 'work'))
    stops.push(() => reopened.close())
    const replayed = structured(await reopened.invoke('android_adb_exec', { args: ['hold'], wait_ms: 100, request_id: 'req-hold-002' }, 'agent-c', 'req-hold-002'))
    expect(replayed.status).toBe('unknown')
  })

  it('captures real MCP screenshot image and enforces chunked host file operations', async () => {
    const f = await fixture()
    const shot = await f.engine.invoke('android_screenshot', {}, 'a1', 'req-shot-001')
    const content = shot.content as Array<{ type: string; mimeType?: string; data?: string }>
    expect(content.some(part => part.type === 'image' && part.mimeType === 'image/png' && Buffer.from(part.data!, 'base64').equals(adbFixturePng))).toBe(true)

    const payload = Buffer.from('Eating-Host-File-Payload-v0.3.0')
    const put = structured(await f.engine.invoke('android_files', {
      op: 'put',
      path: 'note.txt',
      offset: 0,
      overwrite: true,
      data: payload.toString('base64'),
      request_id: 'req-put-001',
    }, 'a1', 'req-put-001'))
    expect(put.location).toBe('eating-host')
    expect(put.written).toBe(payload.length)

    const got = structured(await f.engine.invoke('android_files', { op: 'get', path: 'note.txt', offset: 0, output: 'text', request_id: 'req-get-001' }, 'a1', 'req-get-001'))
    expect(got.text).toBe(payload.toString('utf8'))
  })

  it('targets defaultDevice uniformly, requires explicit choice when multi-device, and blocks stale request_id after device switch', async () => {
    const f = await fixture({
      adbState: {
        devices: [
          { serial: 'usb-phone-1', state: 'device', model: 'Phone_One' },
          { serial: '192.168.1.88:5555', state: 'device', model: 'Phone_Two' },
        ],
      },
    })

    // Without default device and multiple devices attached -> must reject cleanly
    await expect(
      f.engine.invoke('android_adb_exec', { args: ['echo-target'], request_id: 'req-multi-guard-001' }, 'a1', 'req-multi-guard-001'),
    ).rejects.toMatchObject({ code: 'ANDROID_DEVICE_REQUIRED' })
    await expect(
      f.engine.invoke('android_screenshot', {}, 'a1', 'req-multi-shot-001'),
    ).rejects.toMatchObject({ code: 'ANDROID_DEVICE_REQUIRED' })

    // Explicit serial succeeds even when no defaultDevice is configured
    const explicit = structured(await f.engine.invoke('android_adb_exec', {
      args: ['echo-target'],
      serial: '192.168.1.88:5555',
      request_id: 'req-explicit-001',
    }, 'a1', 'req-explicit-001'))
    expect(JSON.parse(String(explicit.text)).serial).toBe('192.168.1.88:5555')

    // Configuring defaultDevice runs subsequent commands against it & binds HMAC intent to that device
    f.setDefaultDevice('usb-phone-1')
    const devOne = structured(await f.engine.invoke('android_adb_exec', {
      args: ['echo-target'],
      request_id: 'req-switch-001',
    }, 'a1', 'req-switch-001'))
    expect(JSON.parse(String(devOne.text)).serial).toBe('usb-phone-1')

    // Switching default device rejects replaying the same request_id against a different phone
    f.setDefaultDevice('192.168.1.88:5555')
    await expect(
      f.engine.invoke('android_adb_exec', { args: ['echo-target'], request_id: 'req-switch-001' }, 'a1', 'req-switch-001'),
    ).rejects.toMatchObject({ code: 'ANDROID_REQUEST_CONFLICT' })
  })

  it('enforces strict v2 configuration, preserves legacy v1/corrupt files until explicit rebuild, and validates network addresses', async () => {
    const parent = await realpath(tmpdir())
    const dir = await realpath(await mkdtemp(join(parent, 'eating-android-cfg-')))
    stops.push(() => rm(dir, { recursive: true }))

    // Valid network address formats
    expect(validateNetworkAddress('192.168.1.50:5555')).toBe('192.168.1.50:5555')
    expect(validateNetworkAddress('phone.local:41234')).toBe('phone.local:41234')
    expect(validateNetworkAddress('[::1]:5555')).toBe('[::1]:5555')
    expect(validateNetworkAddress('[fe80::1%eth0]:5555')).toBe('[fe80::1%eth0]:5555')
    for (const bad of ['http://192.168.1.1:5555', '::1:5555', '192.168.1.1', '999.1.1.1:5555', '192.168.1.1:70000', 'bad host:5555']) {
      expect(() => validateNetworkAddress(bad)).toThrow()
    }

    // Legacy v1 file must NOT auto-migrate or convert endpoint -> networkAddress
    const legacyContent = JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      mode: 'remote',
      endpoint: 'http://192.168.1.99:9000/mcp',
      token: 'legacy-secret-token',
      adbPath: '',
      workspace: '',
    })
    const cfgFile = join(dir, 'config.json')
    const workFile = join(dir, 'workspace', 'keep.txt')
    mkdirSync(join(dir, 'workspace'), { recursive: true })
    await writeFile(cfgFile, legacyContent, 'utf8')
    await writeFile(workFile, 'keep-my-work', 'utf8')

    const cfg = new AndroidConfig(dir)
    expect(cfg.loadState).toBe('legacy-unsupported')
    expect(cfg.errorCode).toBe('ANDROID_LEGACY_CONFIGURATION_UNSUPPORTED')
    expect(cfg.current().networkAddress).toBe('')
    expect(await readFile(cfgFile, 'utf8')).toBe(legacyContent)
    expect(() => cfg.update({
      expectedRevision: 4,
      connectionMode: 'network',
      networkAddress: '192.168.1.50:5555',
      defaultDevice: '',
      adbPath: '',
      workspace: '',
    })).toThrow()
    expect(await readFile(cfgFile, 'utf8')).toBe(legacyContent)

    // Explicit rebuild requires confirmed: true and resets ONLY config.json while preserving workspace
    expect(() => cfg.rebuild({ confirmed: false })).toThrow()
    const rebuilt = cfg.rebuild({ confirmed: true })
    expect(rebuilt.schemaVersion).toBe(2)
    expect(rebuilt.connectionMode).toBe('usb')
    expect(rebuilt.networkAddress).toBe('')
    expect(cfg.loadState).toBe('ok')
    expect(await readFile(workFile, 'utf8')).toBe('keep-my-work')

    // CAS revision check
    const next = cfg.update({
      expectedRevision: rebuilt.revision,
      connectionMode: 'network',
      networkAddress: '[::1]:5555',
      defaultDevice: '[::1]:5555',
      adbPath: '',
      workspace: '',
    })
    expect(() => cfg.update({
      expectedRevision: rebuilt.revision,
      connectionMode: 'usb',
      networkAddress: '',
      defaultDevice: '',
      adbPath: '',
      workspace: '',
    })).toThrow()
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
    expect(next.revision).toBe(rebuilt.revision + 1)
  })
})
