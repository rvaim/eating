import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { AndroidEngine } from './engine'
import { AndroidConfig } from './config'
import { RemoteExecutor, startAndroidExecutor } from './executor'
import { adbFixturePng, writeAdbFixture } from '../../../../../tests/fixtures/adb'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
async function fixture() {
  const parent = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(parent, 'eating-android-test-')))
  stops.push(async () => { if (await realpath(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-android-test-')) throw Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true }) })
  const adb = await writeAdbFixture(directory), engine = new AndroidEngine(join(directory, 'state'), adb, join(directory, 'work'))
  stops.push(() => engine.close()); return { engine, directory, adb }
}
function data(v: JsonObject): JsonObject { if (!isJsonObject(v.structuredContent)) throw Error('Missing structured result'); return v.structuredContent }
describe('full ADB execution and durable command results', () => {
  it.runIf(Boolean(process.env.EATING_ADB_TEST_BIN))('runs the explicitly selected installed ADB binary without opening any device connection', async () => {
    const f = await fixture(), engine = new AndroidEngine(join(f.directory, 'installed-adb'), process.env.EATING_ADB_TEST_BIN!, join(f.directory, 'work'))
    stops.push(() => engine.close())
    const result = data(await engine.execute({ args: ['version'], wait_ms: 5000 }, 'actor-a', 'installed-version'))
    expect(result.exitCode).toBe(0); expect(result.text).toContain('Android Debug Bridge')
  })
  it('passes unenumerated subcommands, all global arguments and literal shell input unchanged, and never starts the same request twice', async () => {
    const f = await fixture(), marker = join(f.directory, 'must-not-exist')
    const args = ['-H', 'fixture.invalid', '-P', '5038', 'future-adb-command', 'spaces and 中文', `$(touch ${marker})`, "'quoted'"]
    const first = data(await f.engine.execute({ args, wait_ms: 5000 }, 'actor-a', 'same-request'))
    expect(JSON.parse(String(first.text))).toEqual(args)
    expect(data(await f.engine.execute({ args, wait_ms: 5000 }, 'actor-a', 'same-request')).processId).toBe(first.processId)
    expect(f.engine.list().processes).toHaveLength(1)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.engine.execute({ args: ['other'] }, 'actor-a', 'same-request')).rejects.toMatchObject({ code: 'ANDROID_REQUEST_CONFLICT' })
  })
  it('keeps a long process alive after the initial response, sends stdin once, and reads bytes with cursors', async () => {
    const f = await fixture(), started = data(await f.engine.execute({ args: ['logcat'], wait_ms: 20 }, 'actor-a', 'long-request'))
    const id = String(started.processId)
    await expect.poll(() => data(f.engine.read({ process_id: id }, 'actor-a')).text).toContain('READY')
    const input = { process_id: id, data: '中文 input\n' }
    f.engine.write(input, 'actor-a', 'stdin-request'); f.engine.write(input, 'actor-a', 'stdin-request')
    await expect.poll(() => data(f.engine.read({ process_id: id }, 'actor-a')).text).toContain('INPUT:中文 input\n')
    const text = String(data(f.engine.read({ process_id: id }, 'actor-a')).text)
    expect(text.match(/INPUT:/g)).toHaveLength(1)
    expect(data(f.engine.read({ process_id: id, offset: 6 }, 'actor-a')).text).toBe(text.slice(6))
    expect(data(f.engine.read({ process_id: id }, 'actor-a')).status).toBe('running')
    f.engine.write({ process_id: id, eof: true }, 'actor-a', 'close-input')
    await expect.poll(() => data(f.engine.read({ process_id: id }, 'actor-a')).status).toBe('exited')
    expect(data(f.engine.read({ process_id: id }, 'actor-a')).exitCode).toBe(0)
  })
  it('revokes the exact controller and leaves completed receipts readable by the owner without granting old control again', async () => {
    const f = await fixture(), started = data(await f.engine.execute({ args: ['hold'] }, 'actor-a', 'held-request'))
    await expect(f.engine.execute({ args: ['version'] }, 'actor-b', 'new-request')).rejects.toMatchObject({ code: 'ANDROID_EXECUTOR_BUSY' })
    await f.engine.revoke('actor-a')
    await expect.poll(() => data(f.engine.read({ process_id: started.processId! }, 'owner')).status).toBe('exited')
    await expect(f.engine.execute({ args: ['version'] }, 'actor-a', 'after-revoke')).rejects.toMatchObject({ code: 'ANDROID_ACCESS_REVOKED' })
    expect(data(await f.engine.execute({ args: ['version'] }, 'actor-b', 'new-request')).exitCode).toBe(0)
  })
  it('preserves binary files across chunk retries and returns genuine MCP image bytes', async () => {
    const f = await fixture(), file = join(f.directory, 'input.bin'), first = Buffer.alloc(65536, 0x71), second = Buffer.from([0, 255, 1, 128])
    const put = { op: 'put', path: file, data: first.toString('base64'), offset: 0, overwrite: true }
    f.engine.files(put, 'actor-a', 'chunk-one'); f.engine.files(put, 'actor-a', 'chunk-one')
    f.engine.files({ op: 'put', path: file, data: second.toString('base64'), offset: first.length }, 'actor-a', 'chunk-two')
    expect((await readFile(file)).equals(Buffer.concat([first, second]))).toBe(true)
    const read = data(f.engine.files({ op: 'get', path: file, offset: first.length, output: 'binary' }, 'actor-a', 'read-file'))
    expect(Buffer.from(String(read.data), 'base64').equals(second)).toBe(true)
    const image = await f.engine.invoke('android_screenshot', {}, 'actor-a', 'screen-request')
    expect(image.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: adbFixturePng.toString('base64') })
  })
  it('uses the actual terminal program, including stdin and clean terminal exit', async () => {
    const f = await fixture(), result = data(await f.engine.execute({ args: ['hold'], terminal: true, wait_ms: 20 }, 'actor-a', 'tty-request'))
    await expect.poll(() => data(f.engine.read({ process_id: result.processId! }, 'actor-a')).text).toContain('READY')
    f.engine.write({ process_id: result.processId!, data: 'terminal-input\n' }, 'actor-a', 'tty-input')
    await expect.poll(() => data(f.engine.read({ process_id: result.processId! }, 'actor-a')).text).toContain('INPUT:terminal-input')
    f.engine.stop({ process_id: result.processId!, signal: 'terminate' }, 'actor-a', 'tty-stop')
    await expect.poll(() => data(f.engine.read({ process_id: result.processId! }, 'actor-a')).status).toBe('exited')
  })
  it('keeps a persisted unconfirmed command unknown after restart and never respawns it', async () => {
    const f = await fixture(), started = data(await f.engine.execute({ args: ['version'] }, 'actor-a', 'persisted-command'))
    const index = join(f.directory, 'state/processes.json'), value = JSON.parse(await readFile(index, 'utf8'))
    value.processes[0].status = 'running'; await writeFile(index, JSON.stringify(value))
    const restored = new AndroidEngine(join(f.directory, 'state'), f.adb, join(f.directory, 'work')); stops.push(() => restored.close())
    const result = data(await restored.execute({ args: ['version'] }, 'actor-a', 'persisted-command'))
    expect(result.processId).toBe(started.processId); expect(result.status).toBe('unknown'); expect(result.pid).toBeNull()
  })
  it('retains command tombstones after output cleanup so the same request never runs again', async () => {
    const f = await fixture(), started = data(await f.engine.execute({ args: ['version'], wait_ms: 5000 }, 'actor-a', 'archived-command'))
    expect(f.engine.prune()).toEqual({ removed: 1 })
    const result = data(await f.engine.execute({ args: ['version'] }, 'actor-a', 'archived-command'))
    expect(result.processId).toBe(started.processId); expect(result.outputUnavailable).toBe(true); expect(f.engine.list().processes).toHaveLength(0)
  })
  it('does not split UTF-8 characters between model-facing output chunks', async () => {
    const f = await fixture(), first = data(await f.engine.execute({ args: ['utf8-boundary'], wait_ms: 5000 }, 'actor-a', 'utf8-request'))
    expect(String(first.text)).not.toContain('�')
    const next = data(f.engine.read({ process_id: first.processId!, offset: first.nextOffset! }, 'actor-a'))
    expect(next.text).toBe('你🙂end')
  })
})
describe('Android remote executor and current configuration', () => {
  it('uses the same full execution and image protocol over authenticated MCP, with durable request identity', async () => {
    const f = await fixture(), configFile = join(f.directory, 'remote.json'), token = 'fixture-android-remote-token-00000001'
    await writeFile(configFile, JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port: 0, token, adbPath: f.adb, workspace: join(f.directory, 'remote-work') }))
    const server = await startAndroidExecutor(configFile); stops.push(() => server.close())
    if (!server.address || typeof server.address === 'string') throw Error('Missing remote fixture port')
    const endpoint = `http://127.0.0.1:${server.address.port}/mcp`, client = new RemoteExecutor(endpoint, token); stops.push(() => client.close())
    expect((await fetch(endpoint, { method: 'POST', body: '{}' })).status).toBe(401)
    await client.connect()
    const args = { args: ['never-enumerated', 'all arguments'], wait_ms: 5000 }, first = data(await client.invoke('android_adb_exec', args, 'remote-actor-a', 'remote-request'))
    expect(JSON.parse(String(first.text))).toEqual(args.args)
    expect(data(await client.invoke('android_adb_exec', args, 'remote-actor-a', 'remote-request')).processId).toBe(first.processId)
    await expect(client.invoke('android_process_read', { process_id: first.processId! }, 'remote-actor-b')).rejects.toMatchObject({ code: 'ANDROID_PROCESS_UNAVAILABLE' })
    const image = await client.invoke('android_screenshot', {}, 'remote-actor-a', 'remote-picture')
    expect(image.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: adbFixturePng.toString('base64') })
  })
  it('preserves configuration on rejected CAS and does not leak or carry tokens to another endpoint', async () => {
    const f = await fixture(), config = new AndroidConfig(join(f.directory, 'configuration'))
    expect(config.read().revision).toBe(0)
    const input = { expectedRevision: 0, mode: 'remote', adbPath: '', workspace: '', endpoint: 'http://127.0.0.1:1234/mcp', token: 'private-test-token' }
    config.save(input)
    expect(config.public(false)).not.toHaveProperty('token')
    expect(() => config.save(input)).toThrow('配置已被其他页面修改')
    config.save({ ...input, expectedRevision: 1, endpoint: 'http://127.0.0.1:1235/mcp', token: '' })
    expect(config.read().token).toBe('')
    const before = await readFile(config.file, 'utf8'); await writeFile(config.file, before.replace('"schemaVersion":1', '"schemaVersion":99'))
    expect(() => config.save({ ...input, expectedRevision: 2 })).toThrow(); expect(await readFile(config.file, 'utf8')).toContain('"schemaVersion":99')
  })
})
