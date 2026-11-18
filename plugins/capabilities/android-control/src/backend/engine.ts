import { execFile, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import type { AndroidTargetPolicy, ProcessRecord } from '../types'
import { parseAdbDevicesOutput } from './adb'
import { validateDeviceSerial } from './config'
import { failure, integer, object, readDocument, text, writeDocument } from './files'
import { terminalCommand } from './terminal'

const VALUE_FLAGS = new Set(['-s', '-H', '-P', '-L', '-t'])
const HOST_GLOBAL_COMMANDS = new Set(['version', 'devices', 'start-server', 'kill-server', 'connect', 'disconnect', 'pair', 'mdns', 'help', 'keygen', 'reconnect', 'wait-for-disconnect'])

const OUTPUT_BYTES = 16 * 1024 * 1024
const BLOCK_BYTES = 65536
const TEXT_BYTES = 16384
type OutputMode = 'text' | 'binary' | 'image'
type Live = { child: ChildProcessWithoutNullStreams; done: Promise<void>; actorId: string; controlled: boolean; signal?: AbortSignal }
export function resultContent(value: JsonObject, bytes?: Buffer, output: OutputMode = 'text'): JsonObject {
  const content: JsonValue[] = [{ type: 'text', text: JSON.stringify(value) }]
  if (bytes !== undefined && output === 'image') {
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null
    if (!mimeType) return { content: [...content, { type: 'text', text: JSON.stringify({ output_error: 'ANDROID_OUTPUT_NOT_IMAGE' }) }], structuredContent: { ...value, output_error: 'ANDROID_OUTPUT_NOT_IMAGE' } }
    content.push({ type: 'image', mimeType, data: bytes.toString('base64') })
  }
  return { content, structuredContent: value }
}
const outputMode = (value: unknown): OutputMode => { if (value === undefined) return 'text'; if (value !== 'text' && value !== 'binary' && value !== 'image') throw failure('ANDROID_ARGUMENTS_INVALID'); return value }
function utf8Prefix(bytes: Buffer): Buffer {
  let start = bytes.length - 1
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--
  if (start < 0) return bytes
  const lead = bytes[start]!, length = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1
  return bytes.length - start < length ? bytes.subarray(0, start) : bytes
}
function decoded(value: unknown): Buffer {
  if (!text(value, 4 * Math.ceil(BLOCK_BYTES / 3)) || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('ANDROID_ARGUMENTS_INVALID', '文件块必须是有效 Base64。')
  const bytes = Buffer.from(value, 'base64')
    if (bytes.length > BLOCK_BYTES || bytes.toString('base64') !== value) throw failure('ANDROID_ARGUMENTS_INVALID', '文件块超过64KiB或编码不完整。')
  return bytes
}

/** Owns command lifetime, never interprets or whitelists ADB subcommands. */
export class AndroidEngine {
  private readonly records = new Map<string, ProcessRecord>()
  private readonly live = new Map<string, Live>()
  private readonly receipts: DatabaseSync
  private storageClosed = false
  private readonly blocked = new Set<string>()
  private readonly leaseSignals = new Map<string, AbortSignal>()
  private readonly revokedSignals = new WeakSet<AbortSignal>()
  private readonly key: Buffer
  private controller: string | null = null
  private closed = false
  readonly workspace: string
  private readonly getPolicy: () => AndroidTargetPolicy
  constructor(
    readonly directory: string,
    readonly adbPath: string,
    workspace: string,
    getPolicy: () => AndroidTargetPolicy = () => ({ connectionMode: 'usb', networkAddress: '', defaultDevice: '' }),
  ) {
    this.getPolicy = getPolicy
    this.workspace = resolve(workspace || join(directory, 'workspace'))
    mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(this.workspace, { recursive: true, mode: 0o700 })
    const keyFile = join(directory, 'intent-key')
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
    this.key = readFileSync(keyFile); if (this.key.length !== 32) throw failure('ANDROID_STATE_INVALID', '执行端意图校验数据无效。', 'failed', 500)
    const databaseFile = join(directory, 'receipts.sqlite'), fresh = !existsSync(databaseFile)
    this.receipts = new DatabaseSync(databaseFile); chmodSync(databaseFile, 0o600)
    if (fresh) this.receipts.exec('CREATE TABLE receipts (id TEXT PRIMARY KEY, intent TEXT NOT NULL, result TEXT NOT NULL); PRAGMA user_version=1;')
    else if (Number(this.receipts.prepare('PRAGMA user_version').get()?.user_version) !== 1 || this.receipts.prepare('PRAGMA table_info(receipts)').all().map(row => row.name).join(',') !== 'id,intent,result') { this.receipts.close(); throw failure('ANDROID_STATE_INVALID', '执行端回执格式不支持，原数据未覆盖。', 'failed', 500) }
    const stored = readDocument(join(directory, 'processes.json'))
    if (stored !== null) {
      object(stored, ['schemaVersion', 'processes'], ['schemaVersion', 'processes'])
      if (stored.schemaVersion !== 1 || !Array.isArray(stored.processes) || stored.processes.length > 512) throw failure('ANDROID_STATE_INVALID')
      for (const raw of stored.processes) {
        const row = object(raw, ['processId', 'requestId', 'actorId', 'intent', 'createdAt', 'terminal', 'status', 'exitCode', 'signal', 'stdoutBytes', 'stderrBytes', 'pid'], ['processId', 'requestId', 'actorId', 'intent', 'createdAt', 'terminal', 'status', 'exitCode', 'signal', 'stdoutBytes', 'stderrBytes', 'pid'])
        if (!/^[a-f0-9-]{36}$/.test(String(row.processId)) || !text(row.requestId) || !text(row.actorId) || !/^[a-f0-9]{64}$/.test(String(row.intent)) || typeof row.terminal !== 'boolean' || !['queued', 'running', 'exited', 'unknown', 'failed'].includes(String(row.status)) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || ['stdoutBytes', 'stderrBytes'].some(k => typeof row[k] !== 'number' || !Number.isSafeInteger(row[k]) || Number(row[k]) < 0) || row.exitCode !== null && !Number.isSafeInteger(row.exitCode) || row.pid !== null && !Number.isSafeInteger(row.pid) || row.signal !== null && !text(row.signal, 64)) throw failure('ANDROID_STATE_INVALID')
        const record = row as unknown as ProcessRecord
        this.records.set(record.processId, { ...record, status: record.status === 'running' || record.status === 'queued' ? 'unknown' : record.status, pid: null })
      }
    }
  }
  private save(): void { if (!this.storageClosed) writeDocument(join(this.directory, 'processes.json'), { schemaVersion: 1, processes: [...this.records.values()] }) }
  private previous(id: string, intent: string): JsonObject | undefined {
    const row = this.receipts.prepare('SELECT intent,result FROM receipts WHERE id=?').get(id)
    if (!row) return undefined
    if (row.intent !== intent || typeof row.result !== 'string') throw failure('ANDROID_REQUEST_CONFLICT', '同一request_id不能用于不同操作。', 'not-sent', 409)
    const result: unknown = JSON.parse(row.result)
    if (!isJsonObject(result)) throw failure('ANDROID_STATE_INVALID', '执行端回执格式无效。', 'failed', 500)
    return result
  }
  private remember(id: string, intent: string, result: JsonObject): void {
    if (!this.storageClosed) this.receipts.prepare('INSERT INTO receipts(id,intent,result) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result WHERE receipts.intent=excluded.intent').run(id, intent, JSON.stringify(result))
  }
  digest(value: unknown): string { return createHmac('sha256', this.key).update(JSON.stringify(value)).digest('hex') }
  private activateLease(actor: string, signal?: AbortSignal): void {
    if (this.closed) throw failure('ANDROID_ACCESS_REVOKED', '该执行授权已结束，请由当前任务重新取得连接。', 'not-sent', 403)
    if (!signal) return
    if (signal.aborted || this.revokedSignals.has(signal)) throw failure('ANDROID_ACCESS_REVOKED', '该执行授权已结束，请由当前任务重新取得连接。', 'not-sent', 403)
    if (this.leaseSignals.get(actor) !== signal) {
      this.leaseSignals.set(actor, signal)
      this.blocked.delete(actor)
    }
  }
  private active(actor: string, acquire = false, signal?: AbortSignal): void {
    if (this.closed || signal?.aborted || (signal && this.revokedSignals.has(signal)) || this.blocked.has(actor)) throw failure('ANDROID_ACCESS_REVOKED', '该执行授权已结束，请由当前任务重新取得连接。', 'not-sent', 403)
    if (acquire) { if (this.controller !== null && this.controller !== actor) throw failure('ANDROID_EXECUTOR_BUSY', '执行端由另一个代理控制，请由主Agent协调或主人接管。', 'not-sent', 409); this.controller = actor }
  }
  private releaseControllerIfIdle(actor: string): void {
    if (this.controller !== actor) return
    if (![...this.live.values()].some(job => job.controlled && job.actorId === actor)) this.controller = null
  }
  private record(id: unknown, actor: string, signal?: AbortSignal): ProcessRecord {
    this.active(actor, false, signal)
    const record = typeof id === 'string' ? this.records.get(id) : undefined
    if (!record || record.actorId !== actor && actor !== 'owner') throw failure('ANDROID_PROCESS_UNAVAILABLE', '进程不属于当前调用者或已不在执行端。', 'not-sent', 404)
    return record
  }
  private summary(row: ProcessRecord): JsonObject { const { intent: _intent, actorId: _actor, ...value } = row; return { ...value, stdoutRetained: Math.min(row.stdoutBytes, OUTPUT_BYTES), stderrRetained: Math.min(row.stderrBytes, OUTPUT_BYTES), outputTruncated: row.stdoutBytes > OUTPUT_BYTES || row.stderrBytes > OUTPUT_BYTES, mergedOutput: row.terminal } }
  list(actor?: string): JsonObject {
    const policy = this.getPolicy()
    const rows = [...this.records.values()].filter(row => !actor || row.actorId === actor)
    return {
      processes: rows.slice(-100).reverse().map(row => this.summary(row)),
      total: rows.length,
      controlled: this.controller !== null,
      workspace: this.workspace,
      connectionMode: policy.connectionMode,
      defaultDevice: policy.defaultDevice || null,
      location: 'eating-host',
    }
  }
  private inspectLeadingArgs(rawArgs: readonly string[]): { subcommand: string | null; explicitSelector: string | null } {
    let explicitSelector: string | null = null
    for (let index = 0; index < rawArgs.length; index++) {
      const token = rawArgs[index]!
      if (!token.startsWith('-') || token === '-') {
        return { subcommand: token, explicitSelector }
      }
      if (token === '-d' || token === '-e') {
        explicitSelector ??= token
        continue
      }
      if (token === '-s' || token === '-t') {
        const value = rawArgs[index + 1]
        if (value === undefined) throw failure('ANDROID_ARGUMENTS_INVALID', `ADB 选项 ${token} 缺少目标设备参数。`)
        explicitSelector ??= `${token}:${value}`
        index++
        continue
      }
      if (token.startsWith('-s') && token.length > 2) {
        explicitSelector ??= `-s:${token.slice(2)}`
        continue
      }
      if (token.startsWith('-t') && token.length > 2) {
        explicitSelector ??= `-t:${token.slice(2)}`
        continue
      }
      if (VALUE_FLAGS.has(token)) {
        if (index + 1 >= rawArgs.length) throw failure('ANDROID_ARGUMENTS_INVALID', `ADB 选项 ${token} 缺少参数。`)
        index++
      }
    }
    return { subcommand: null, explicitSelector }
  }
  private async probeOnlineDevices(): Promise<ReturnType<typeof parseAdbDevicesOutput> | null> {
    return new Promise(resolveProbe => {
      execFile(this.adbPath, ['devices', '-l'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 }, (error, stdout) => {
        if (error || !stdout || !stdout.includes('List of devices')) {
          resolveProbe(null)
          return
        }
        resolveProbe(parseAdbDevicesOutput(stdout, this.getPolicy().defaultDevice))
      })
    })
  }
  private async resolveExecutionTarget(rawArgs: readonly string[], explicitSerial?: string): Promise<{ finalArgs: string[]; targetKey: string }> {
    const { subcommand, explicitSelector } = this.inspectLeadingArgs(rawArgs)
    if (explicitSerial !== undefined) {
      const cleanSerial = validateDeviceSerial(explicitSerial, false)
      if (explicitSelector) {
        throw failure('ANDROID_ARGUMENTS_INVALID', '不能同时指定 serial 参数与 -s/-d/-e/-t 选项。')
      }
      if (subcommand && HOST_GLOBAL_COMMANDS.has(subcommand)) {
        throw failure('ANDROID_ARGUMENTS_INVALID', `全局 ADB 命令 ${subcommand} 不接受设备 serial 参数。`)
      }
      return { finalArgs: ['-s', cleanSerial, ...rawArgs], targetKey: `device:${cleanSerial}` }
    }
    if (explicitSelector) {
      return { finalArgs: [...rawArgs], targetKey: `selector:${explicitSelector}` }
    }
    if (subcommand && HOST_GLOBAL_COMMANDS.has(subcommand)) {
      return { finalArgs: [...rawArgs], targetKey: `host:${subcommand}` }
    }
    const policy = this.getPolicy()
    if (policy.defaultDevice) {
      return { finalArgs: ['-s', policy.defaultDevice, ...rawArgs], targetKey: `device:${policy.defaultDevice}` }
    }
    const probed = await this.probeOnlineDevices()
    if (probed) {
      if (probed.onlineCount > 1) {
        throw failure('ANDROID_DEVICE_REQUIRED', '检测到多台在线安卓设备且未设置默认设备，请在命令参数中显式指定 serial／-s，或在“ADB 与设备连接”中选择默认设备。', 'not-sent', 409)
      }
      const single = probed.devices.find(device => device.online)
      if (single) {
        return { finalArgs: ['-s', single.serial, ...rawArgs], targetKey: `device:${single.serial}` }
      }
    }
    return { finalArgs: [...rawArgs], targetKey: 'device:unspecified' }
  }
  async execute(input: unknown, actor: string, requestId: string, acquire = true, signal?: AbortSignal): Promise<JsonObject> {
    const args = object(input, ['args', 'serial', 'stdin', 'terminal', 'wait_ms', 'output', 'request_id'], ['args'])
    if (!Array.isArray(args.args) || args.args.length > 1024 || !args.args.every(arg => text(arg, 65536)) || Buffer.byteLength(JSON.stringify(args.args)) > 512 * 1024 || args.stdin !== undefined && !text(args.stdin, 262144) || args.terminal !== undefined && typeof args.terminal !== 'boolean') throw failure('ANDROID_ARGUMENTS_INVALID')
    const explicitSerial = args.serial !== undefined ? validateDeviceSerial(args.serial, false) : undefined
    const resolvedTarget = await this.resolveExecutionTarget(args.args as string[], explicitSerial)
    const mode = outputMode(args.output), wait = integer(args.wait_ms, 1000, 0, 30000), terminal = args.terminal === true
    const intent = this.digest([actor, resolvedTarget.targetKey, resolvedTarget.finalArgs, args.args, args.stdin ?? null, terminal, this.adbPath, this.workspace])
    let row = [...this.records.values()].find(item => item.requestId === requestId)
    const previous = this.previous(requestId, intent)
    if (previous && !row) {
      this.active(actor, false, signal)
      return resultContent({ ...previous, status: previous.status === 'running' || previous.status === 'queued' ? 'unknown' : previous.status!, pid: null, outputUnavailable: true })
    }
    if (row && (row.intent !== intent || row.actorId !== actor)) throw failure('ANDROID_REQUEST_CONFLICT', '同一 request_id 不能用于不同命令、目标设备或参数。', 'not-sent', 409)
    if (!row) {
      this.active(actor, acquire, signal)
      if (this.records.size >= 512) this.prune()
      if (this.records.size >= 512) throw failure('ANDROID_PROCESS_CAPACITY', '执行端活跃／待核对进程达到容量，请先核对现有进程。', 'not-sent', 409)
      const command = [this.adbPath, ...resolvedTarget.finalArgs]
      const launch = terminal ? terminalCommand(command) : { executable: this.adbPath, args: resolvedTarget.finalArgs }
      row = { processId: randomUUID(), requestId, actorId: actor, intent, createdAt: new Date().toISOString(), terminal, status: 'queued', exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, pid: null }
      this.records.set(row.processId, row); this.save()
      this.remember(requestId, intent, this.summary(row))
      const child = spawn(launch.executable, launch.args, { cwd: this.workspace, detached: process.platform !== 'win32', stdio: 'pipe' })
      const current = row
      const done = new Promise<void>(resolveDone => {
        const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
          const key = stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes', previous = current[key]
          current[key] += chunk.length
          if (previous < OUTPUT_BYTES) appendFileSync(join(this.directory, current.processId + '.' + stream), chunk.subarray(0, OUTPUT_BYTES - previous), { mode: 0o600 })
        }
        child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
        child.once('error', () => { current.status = 'failed'; current.pid = null; this.save(); this.remember(requestId, intent, this.summary(current)) })
        child.once('close', (code, exitSignal) => {
          current.status = current.status === 'failed' ? 'failed' : 'exited'; current.exitCode = code; current.signal = exitSignal; current.pid = null
          this.live.delete(current.processId)
          if (acquire) this.releaseControllerIfIdle(current.actorId)
          this.save(); this.remember(requestId, intent, this.summary(current)); resolveDone()
        })
      })
      row.pid = child.pid ?? null; if (child.pid) row.status = 'running'
      this.live.set(row.processId, { child, done, actorId: actor, controlled: acquire, ...(signal ? { signal } : {}) })
      this.save()
      child.stdin.on('error', () => { /* The process status/exit remains the authoritative result. */ })
      if (typeof args.stdin === 'string') child.stdin.write(args.stdin)
    } else {
      this.active(actor, false, signal)
    }
    const live = this.live.get(row.processId)
    if (live && wait) { const timeout = new AbortController(); await Promise.race([live.done, delay(wait, undefined, { signal: timeout.signal }).catch(() => {})]); timeout.abort() }
    return this.read({ process_id: row.processId, output: mode }, actor, signal)
  }
  read(input: unknown, actor: string, signal?: AbortSignal): JsonObject {
    const args = object(input, ['process_id', 'offset', 'limit', 'stream', 'output'], ['process_id']), row = this.record(args.process_id, actor, signal)
    const stream = args.stream ?? 'stdout'; if (stream !== 'stdout' && stream !== 'stderr') throw failure('ANDROID_ARGUMENTS_INVALID')
    const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), mode = outputMode(args.output), requested = integer(args.limit, mode === 'image' ? OUTPUT_BYTES : mode === 'text' ? TEXT_BYTES : BLOCK_BYTES, 1, mode === 'image' ? OUTPUT_BYTES : BLOCK_BYTES), limit = mode === 'text' ? Math.min(requested, TEXT_BYTES) : requested
    const file = join(this.directory, row.processId + '.' + stream), retained = existsSync(file) ? statSync(file).size : 0
    const pendingOrInvalidImage = mode === 'image' && (row.status !== 'exited' || row.exitCode !== 0 || row.stdoutBytes > OUTPUT_BYTES)
    const bytes = pendingOrInvalidImage ? Buffer.alloc(0) : Buffer.alloc(Math.min(limit, Math.max(0, retained - offset)))
    if (bytes.length) { const fd = openSync(file, 'r'); try { readSync(fd, bytes, 0, bytes.length, offset) } finally { closeSync(fd) } }
    const decoded = mode === 'text' ? utf8Prefix(bytes) : bytes
    const value: JsonObject = { ...this.summary(row), stream, offset, nextOffset: offset + decoded.length, retainedBytes: retained, complete: row.status !== 'queued' && row.status !== 'running', ...(mode === 'binary' ? { data: bytes.toString('base64'), encoding: 'base64' } : mode === 'text' ? { text: decoded.toString('utf8') } : {}) }
    if (pendingOrInvalidImage) return resultContent({ ...value, output_error: row.status === 'running' || row.status === 'queued' ? 'ANDROID_IMAGE_PENDING' : 'ANDROID_IMAGE_UNAVAILABLE' })
    return resultContent(value, mode === 'image' ? bytes : undefined, mode)
  }
  private once(requestId: string, input: JsonObject, action: () => JsonObject): JsonObject {
    const intent = this.digest(input), previous = this.previous(requestId, intent)
    if (previous) { if (previous.outcome === 'unknown') throw failure('ANDROID_OPERATION_UNKNOWN', '该输入或文件操作结果未确认，不重复执行。', 'unknown', 409); return previous }
    this.remember(requestId, intent, { outcome: 'unknown' })
    try { const result = action(); this.remember(requestId, intent, result); return result }
    catch (error) { if (error instanceof Error && 'outcome' in error && error.outcome === 'not-sent') this.receipts.prepare('DELETE FROM receipts WHERE id=?').run(requestId); throw error }
  }
  private async onceAsync(requestId: string, input: JsonObject, action: () => Promise<JsonObject>): Promise<JsonObject> {
    const intent = this.digest(input), previous = this.previous(requestId, intent)
    if (previous) { if (previous.outcome === 'unknown') throw failure('ANDROID_OPERATION_UNKNOWN', '协调操作结果未确认，不自动重放。', 'unknown', 409); return previous }
    this.remember(requestId, intent, { outcome: 'unknown' })
    try { const result = await action(); this.remember(requestId, intent, result); return result }
    catch (error) { if (error instanceof Error && 'outcome' in error && error.outcome === 'not-sent') this.receipts.prepare('DELETE FROM receipts WHERE id=?').run(requestId); throw error }
  }
  write(input: unknown, actor: string, requestId: string, signal?: AbortSignal): JsonObject {
    const args = object(input, ['process_id', 'data', 'encoding', 'eof', 'request_id'], ['process_id']), row = this.record(args.process_id, actor, signal)
    this.active(actor, true, signal)
    if (args.data !== undefined && !text(args.data, 350000) || args.encoding !== undefined && args.encoding !== 'utf8' && args.encoding !== 'base64' || args.eof !== undefined && typeof args.eof !== 'boolean') throw failure('ANDROID_ARGUMENTS_INVALID')
    return resultContent(this.once(requestId, { actor, args }, () => {
      const live = this.live.get(row.processId); if (!live || !live.child.stdin.writable) throw failure('ANDROID_PROCESS_NOT_RUNNING', '该进程已结束，未再次写入。', 'not-sent', 409)
      if (args.data !== undefined) live.child.stdin.write(args.encoding === 'base64' ? decoded(args.data) : String(args.data))
      if (args.eof === true) live.child.stdin.end()
      return { accepted: true, processId: row.processId, outcome: 'succeeded' }
    }))
  }
  stop(input: unknown, actor: string, requestId: string, signal?: AbortSignal): JsonObject {
    const args = object(input, ['process_id', 'signal', 'request_id'], ['process_id']), row = this.record(args.process_id, actor, signal)
    if (args.signal !== undefined && args.signal !== 'interrupt' && args.signal !== 'terminate') throw failure('ANDROID_ARGUMENTS_INVALID')
    return resultContent(this.once(requestId, { actor, args }, () => { const live = this.live.get(row.processId); if (live) this.kill(live.child, args.signal === 'interrupt' ? 'SIGINT' : 'SIGTERM'); return { processId: row.processId, stopRequested: Boolean(live), status: row.status } }))
  }
  private kill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  private async stopActorJobs(actor: string, signal?: AbortSignal): Promise<void> {
    const jobs = [...this.records.values()]
      .filter(row => row.actorId === actor)
      .flatMap(row => {
        const live = this.live.get(row.processId)
        if (!live) return []
        if (signal && live.signal && live.signal !== signal) return []
        return [live]
      })
    for (const live of jobs) this.kill(live.child, 'SIGTERM')
    await Promise.race([Promise.all(jobs.map(job => job.done)), delay(500)])
    for (const live of jobs) this.kill(live.child, 'SIGKILL')
  }
  async revoke(actor: string, signal?: AbortSignal): Promise<void> {
    if (signal) this.revokedSignals.add(signal)
    const currentLease = this.leaseSignals.get(actor)
    const matchesCurrent = !signal || currentLease === undefined || currentLease === signal
    if (matchesCurrent) {
      this.blocked.add(actor)
      if (signal && currentLease === signal) this.leaseSignals.delete(actor)
      if (this.controller === actor) this.controller = null
    }
    await this.stopActorJobs(actor, signal)
  }
  async takeover(): Promise<void> {
    const holder = this.controller
    this.controller = null
    this.blocked.delete('owner')
    if (holder) await this.stopActorJobs(holder)
  }
  prune(): JsonObject {
    let removed = 0
    for (const [id, row] of this.records) if (row.status === 'exited' || row.status === 'failed') {
      this.records.delete(id); for (const stream of ['stdout', 'stderr']) rmSync(join(this.directory, id + '.' + stream), { force: true }); removed++
    }
    this.save(); return { removed }
  }
  files(input: unknown, actor: string, requestId: string, signal?: AbortSignal): JsonObject {
    this.active(actor, false, signal)
    const args = object(input, ['op', 'path', 'offset', 'limit', 'data', 'overwrite', 'output', 'request_id'], ['op', 'path'])
    if (!text(args.path) || !args.path) throw failure('ANDROID_ARGUMENTS_INVALID')
    const file = isAbsolute(args.path) ? args.path : resolve(this.workspace, args.path), offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, BLOCK_BYTES, 1, BLOCK_BYTES)
    if (args.op === 'list') { const entries = readdirSync(file, { withFileTypes: true }); return resultContent({ path: file, location: 'eating-host', entries: entries.slice(offset, offset + 200).map(entry => ({ name: entry.name, directory: entry.isDirectory() })), total: entries.length, nextOffset: Math.min(entries.length, offset + 200), truncated: entries.length > offset + 200 }) }
    if (args.op === 'stat') { const info = statSync(file); return resultContent({ path: file, location: 'eating-host', bytes: info.size, directory: info.isDirectory() }) }
    if (args.op === 'get') {
      const mode = outputMode(args.output)
      if (mode === 'image' && (offset !== 0 || statSync(file).size > OUTPUT_BYTES)) return resultContent({ path: file, location: 'eating-host', output_error: 'ANDROID_IMAGE_UNAVAILABLE', bytes: statSync(file).size })
      const count = mode === 'image' ? statSync(file).size : mode === 'text' ? Math.min(limit, TEXT_BYTES) : limit, bytes = Buffer.alloc(Math.min(count, Math.max(0, statSync(file).size - offset))), fd = openSync(file, 'r')
      try { readSync(fd, bytes, 0, bytes.length, offset) } finally { closeSync(fd) }
      const decoded = mode === 'text' ? utf8Prefix(bytes) : bytes
      return resultContent({ path: file, location: 'eating-host', offset, nextOffset: offset + decoded.length, bytes: statSync(file).size, ...(mode === 'binary' ? { data: bytes.toString('base64'), encoding: 'base64' } : mode === 'text' ? { text: decoded.toString('utf8') } : {}) }, mode === 'image' ? bytes : undefined, mode)
    }
    if (args.op !== 'put' || args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw failure('ANDROID_ARGUMENTS_INVALID')
    const hadControl = this.controller === actor
    this.active(actor, true, signal)
    try {
      const bytes = decoded(args.data)
      return resultContent(this.once(requestId, { actor, args }, () => {
        if (!(offset === 0 && args.overwrite === true) && (existsSync(file) ? statSync(file).size : 0) !== offset) throw failure('ANDROID_FILE_CONFLICT', '文件长度已变化，未重复追加。', 'not-sent', 409)
        if (offset === 0 && args.overwrite === true) writeFileSync(file, bytes, { mode: 0o600 }); else appendFileSync(file, bytes, { mode: 0o600 })
        return { path: file, location: 'eating-host', bytes: statSync(file).size, written: bytes.length, nextOffset: offset + bytes.length }
      }))
    } finally {
      if (!hadControl) this.releaseControllerIfIdle(actor)
    }
  }
  async invoke(name: string, args: unknown, actor: string, requestId: string, signal?: AbortSignal): Promise<JsonObject> {
    this.activateLease(actor, signal)
    if (name === 'android_executor_control') {
      const value = object(args, ['op', 'request_id'], ['op'])
      if (value.op === 'state') { this.active(actor, false, signal); return resultContent(this.list()) }
      if (value.op !== 'release' && value.op !== 'takeover') throw failure('ANDROID_ARGUMENTS_INVALID')
      return resultContent(await this.onceAsync(requestId, { actor, args: value }, async () => {
        this.active(actor, false, signal)
        if (value.op === 'release') {
          for (const job of this.live.values()) if (job.actorId === actor) job.controlled = false
          if (this.controller === actor) this.controller = null
        } else {
          await this.takeover()
        }
        return { released: true }
      }))
    }
    if (name === 'android_adb_exec') return this.execute(args, actor, requestId, true, signal)
    if (name === 'android_process_read') return this.read(args, actor, signal)
    if (name === 'android_process_write') return this.write(args, actor, requestId, signal)
    if (name === 'android_process_stop') return this.stop(args, actor, requestId, signal)
    if (name === 'android_files') return this.files(args, actor, requestId, signal)
    if (name === 'android_screenshot') {
      const value = object(args, ['serial', 'wait_ms'])
      if (value.serial !== undefined) validateDeviceSerial(value.serial, false)
      const waitMs = integer(value.wait_ms, 30000, 0, 30000)
      return this.execute({ args: ['exec-out', 'screencap', '-p'], ...(value.serial ? { serial: String(value.serial) } : {}), output: 'image', wait_ms: waitMs }, actor, requestId, false, signal)
    }
    throw failure('TOOL_NOT_FOUND', '未提供此安卓工具。', 'not-sent', 404)
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...new Set([...this.records.values()].map(row => row.actorId))].map(actor => this.revoke(actor)))
    for (const row of this.records.values()) if (row.status === 'running' || row.status === 'queued') { row.status = 'unknown'; row.pid = null; this.remember(row.requestId, row.intent, this.summary(row)) }
    this.save(); this.storageClosed = true; this.receipts.close()
  }
}
