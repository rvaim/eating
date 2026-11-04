import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { PlatformError } from '@eating/plugin-sdk'

export interface SessionHistoryPreview {
  readonly previewId: string
  readonly expiresAt: string
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
}
export interface SessionHistoryResult {
  readonly requestId: string
  readonly status: 'completed'
  readonly deletedCount: number
}

type RecordValue = Record<string, unknown>
type Identity = { dev: string; ino: string }
type Fingerprint = Identity & { size: string; mtime: string; sha256: string }
type ObservedFile = { fingerprint: Fingerprint; text?: string }
type DirectoryObservation = { identity: Identity; names?: string[] }
type ReceiptEntry = {
  requestId: string
  previewId: string
  parametersSha256: string
  acceptedAt: string
  state: 'pending' | 'completed' | 'unknown'
  result?: SessionHistoryResult
}
type Receipt = { schemaVersion: 1; entries: ReceiptEntry[] }
type Lock = { schemaVersion: 1; pid: number; requestId: string }
type Plan = {
  public: SessionHistoryPreview
  snapshot: Snapshot
  deletions: string[]
  replacements: Map<string, string>
  logDirectories: Set<string>
  sessionIds: Set<string>
  receipt: Receipt
  lock: Lock | null
}

const TTL = 5 * 60_000
const MAX_JSON_BYTES = 64 * 1024 * 1024
const MAX_RECEIPTS = 10_000
const RECEIPT = 'session-history-receipt.json'
const LOCK = 'session-history-lock.json'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const GENERATION = /^session(?:\.v[1-4])?\.jsonl$/
const BRIDGE = /^(?:(?:owner-policy|expected|ready|session-ready|native-web-ready|error)\.json|ack-[a-f0-9]{64}\.json|\.bridge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/
const METADATA = new Set(['session.json', 'agent-bindings.json', 'proactive-bindings.json'])
const SHARED = [join('dsh-home', 'attachments', 'v1', 'objects'), join('dsh-home', 'attachments', 'v1', 'file-objects'), join('dsh-home', 'attachments', 'v1', 'files'), join('dsh-home', 'attachments', 'v1', 'tmp'), join('dsh-home', 'cache', 'attachments', 'request-images')]
const CACHE = join('dsh-home', 'storages', 'session_projcache', 'sessions')
const WORKSPACE = join('dsh-home', 'storages', 'workspace.json')
const LEGACY_CACHE = join('dsh-home', 'storages', 'session_projcache.json')
const heldLocks = new Set<string>()
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const exact = (value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean => Reflect.ownKeys(value).length === Object.keys(value).length && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino
const sameStat = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const under = (value: string, directory: string): boolean => value.startsWith(directory + sep)
const missing = (error: unknown): boolean => object(error) && error.code === 'ENOENT'
function fail(code: string, status = 409, outcome: 'not-sent' | 'unknown' = 'not-sent'): never {
  const message = code === 'SESSION_HISTORY_SCHEDULED' ? '原生定时任务仍绑定历史会话，请先在官方界面删除相关定时任务（已停用的任务也需删除）。'
    : code === 'SESSION_HISTORY_PREVIEW_STALE' ? '清理预览已过期或资料已变化，请重新预览并确认。'
      : code === 'SESSION_HISTORY_REQUEST_UNKNOWN' || outcome === 'unknown' ? '本次清理结果未知，禁止重放原请求；请先重新预览核对。'
        : code === 'SESSION_HISTORY_RUNTIME_ACTIVE' ? '会话仍有运行锁，请完全停止 Eating Harness 后重试。'
          : code === 'SESSION_HISTORY_INVALID_INPUT' ? '清理参数无效，需要有效的预览、请求标识与明确确认。'
            : code === 'SESSION_HISTORY_UNSUPPORTED' ? '会话资料格式不受当前清理引擎支持，原文件已保留。'
              : code === 'SESSION_HISTORY_RECEIPT_INVALID' ? '清理回执格式无效，已停止操作并保留原文件。'
                : code === 'SESSION_HISTORY_BUSY' ? '另一次历史清理正在执行，请稍后重新预览。'
                  : code === 'SESSION_HISTORY_REQUEST_CONFLICT' ? '请求标识已用于另一清理意图，请核对原请求。'
                    : code === 'SESSION_HISTORY_CAPACITY' ? '清理回执已达到容量上限，未接受新请求。'
                      : code === 'SESSION_HISTORY_PATH_UNSAFE' ? '会话资料路径未通过安全核验，未执行清理。'
                        : '无法安全完成会话历史操作，原始错误详情未公开。'
  throw new PlatformError(code, message, status, outcome)
}
function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { fail('SESSION_HISTORY_UNSUPPORTED') }
}
function encodeSegment(value: string): string {
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const character = String.fromCharCode(code)
    encoded += /^[A-Za-z0-9._-]$/.test(character) ? character : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return encoded
}

class Guard {
  readonly root: string
  private readonly ancestors = new Map<string, Identity>()
  constructor(directory: string) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) fail('SESSION_HISTORY_PATH_UNSAFE')
    this.root = resolve(directory)
    const home = resolve(homedir())
    const mainDsh = resolve(home, '.dsh')
    if (this.root === dirname(this.root) || this.root === home || under(home, this.root) || this.root === mainDsh || under(this.root, mainDsh) || ['dsh-home', '.dsh'].includes(relative(dirname(this.root), this.root))) fail('SESSION_HISTORY_PATH_UNSAFE')
    try {
      let ancestor = this.root
      for (;;) {
        const stat = lstatSync(ancestor, { bigint: true })
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) fail('SESSION_HISTORY_PATH_UNSAFE')
        this.ancestors.set(ancestor, identity(stat))
        const parent = dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
    } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_PATH_UNSAFE') }
  }
  absolute(name: string): string {
    const absolute = resolve(this.root, name)
    const suffix = relative(this.root, absolute)
    if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix) || suffix !== name || name.includes('\0')) fail('SESSION_HISTORY_PATH_UNSAFE')
    return absolute
  }
  rootValid(): void {
    for (const [name, expected] of this.ancestors) {
      const stat = lstatSync(name, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), expected) || realpathSync(name) !== name) fail('SESSION_HISTORY_PATH_UNSAFE')
    }
  }
  inspect(name: string, directories?: Map<string, DirectoryObservation>): BigIntStats {
    this.rootValid()
    const absolute = this.absolute(name)
    const components = name.split(sep)
    let ancestor = this.root
    for (const component of components.slice(0, -1)) {
      ancestor = join(ancestor, component)
      const stat = lstatSync(ancestor, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) fail('SESSION_HISTORY_PATH_UNSAFE')
      const suffix = relative(this.root, ancestor)
      const expected = directories?.get(suffix)
      if (expected && !sameIdentity(identity(stat), expected.identity)) fail('SESSION_HISTORY_PATH_UNSAFE')
      if (directories && !expected) directories.set(suffix, { identity: identity(stat) })
    }
    const stat = lstatSync(absolute, { bigint: true })
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || realpathSync(absolute) !== absolute) fail('SESSION_HISTORY_PATH_UNSAFE')
    return stat
  }
  syncDirectory(name?: string): void {
    const absolute = name ? this.absolute(name) : this.root
    if (name) {
      if (!this.inspect(name).isDirectory()) fail('SESSION_HISTORY_PATH_UNSAFE')
    } else this.rootValid()
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0))
    try { if (!fstatSync(descriptor).isDirectory()) fail('SESSION_HISTORY_PATH_UNSAFE'); if (process.platform !== 'win32') fsyncSync(descriptor) }
    finally { closeSync(descriptor) }
  }
}

function observeFile(guard: Guard, name: string, mode: 'hash' | 'json' | 'header' = 'hash', directories?: Map<string, DirectoryObservation>): ObservedFile {
  const before = guard.inspect(name, directories)
  if (!before.isFile() || mode === 'json' && before.size > BigInt(MAX_JSON_BYTES)) fail('SESSION_HISTORY_UNSUPPORTED')
  const descriptor = openSync(guard.absolute(name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameStat(before, fstatSync(descriptor, { bigint: true }))) fail('SESSION_HISTORY_PREVIEW_STALE')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const chunks: Buffer[] = []
    let headerComplete = false
    let totalBytes = 0n
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!count) break
      totalBytes += BigInt(count)
      if (totalBytes > before.size) fail('SESSION_HISTORY_PREVIEW_STALE')
      const bytes = buffer.subarray(0, count)
      hash.update(bytes)
      if (mode === 'json') chunks.push(Buffer.from(bytes))
      else if (mode === 'header' && !headerComplete) {
        const newline = bytes.indexOf(10)
        chunks.push(Buffer.from(newline < 0 ? bytes : bytes.subarray(0, newline)))
        headerComplete = newline >= 0
        if (chunks.reduce((total, chunk) => total + chunk.length, 0) > 128 * 1024) fail('SESSION_HISTORY_UNSUPPORTED')
      }
    }
    if (totalBytes !== before.size || !sameStat(before, fstatSync(descriptor, { bigint: true })) || !sameStat(before, guard.inspect(name, directories))) fail('SESSION_HISTORY_PREVIEW_STALE')
    if (mode === 'header' && !headerComplete) fail('SESSION_HISTORY_UNSUPPORTED')
    return { fingerprint: { ...identity(before), size: String(before.size), mtime: String(before.mtimeNs), sha256: hash.digest('hex') }, ...(mode !== 'hash' ? { text: Buffer.concat(chunks).toString('utf8') } : {}) }
  } finally { closeSync(descriptor) }
}

class Snapshot {
  readonly files = new Map<string, Fingerprint>()
  readonly directories = new Map<string, DirectoryObservation>()
  readonly absent = new Set<string>()
  constructor(readonly guard: Guard) {}
  file(name: string, mode: 'hash' | 'json' | 'header' = 'hash'): ObservedFile | null {
    try {
      const result = observeFile(this.guard, name, mode, this.directories)
      this.files.set(name, result.fingerprint)
      return result
    } catch (error) { if (!missing(error)) throw error; this.absent.add(name); return null }
  }
  directory(name: string): string[] | null {
    try {
      const stat = this.guard.inspect(name, this.directories)
      if (!stat.isDirectory()) fail('SESSION_HISTORY_UNSUPPORTED')
      const names = readdirSync(this.guard.absolute(name)).sort()
      this.directories.set(name, { identity: identity(stat), names })
      return names
    } catch (error) { if (!missing(error)) throw error; this.absent.add(name); return null }
  }
  verify(skipLock = false): void {
    try {
      this.guard.rootValid()
      for (const [name, expected] of this.directories) {
        const stat = this.guard.inspect(name, this.directories)
        if (!stat.isDirectory() || !sameIdentity(identity(stat), expected.identity) || expected.names && JSON.stringify(readdirSync(this.guard.absolute(name)).sort()) !== JSON.stringify(expected.names)) fail('SESSION_HISTORY_PREVIEW_STALE')
      }
      for (const name of this.absent) {
        if (skipLock && name === LOCK) continue
        try { this.guard.inspect(name); fail('SESSION_HISTORY_PREVIEW_STALE') } catch (error) { if (!missing(error)) throw error }
      }
      for (const [name, fingerprint] of this.files) {
        if (skipLock && name === LOCK) continue
        if (JSON.stringify(observeFile(this.guard, name, 'hash', this.directories).fingerprint) !== JSON.stringify(fingerprint)) fail('SESSION_HISTORY_PREVIEW_STALE')
      }
    } catch { fail('SESSION_HISTORY_PREVIEW_STALE') }
  }
  requireFile(name: string): void {
    const expected = this.files.get(name)
    if (!expected || JSON.stringify(observeFile(this.guard, name, 'hash', this.directories).fingerprint) !== JSON.stringify(expected)) fail('SESSION_HISTORY_PREVIEW_STALE')
  }
}

function validResult(value: unknown, requestId: string): value is SessionHistoryResult {
  return object(value) && exact(value, ['requestId', 'status', 'deletedCount']) && value.requestId === requestId && value.status === 'completed' && integer(value.deletedCount)
}
function readReceipt(observed: ObservedFile | null): Receipt {
  if (!observed) return { schemaVersion: 1, entries: [] }
  let data: unknown
  try { data = JSON.parse(observed.text ?? '') as unknown } catch { fail('SESSION_HISTORY_RECEIPT_INVALID', 500) }
  if (!object(data) || !exact(data, ['schemaVersion', 'entries']) || data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_RECEIPTS) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
  const ids = new Set<string>()
  for (const entry of data.entries) {
    if (!object(entry) || !exact(entry, ['requestId', 'previewId', 'parametersSha256', 'acceptedAt', 'state'], ['result']) || typeof entry.requestId !== 'string' || !UUID.test(entry.requestId) || entry.requestId !== entry.requestId.toLowerCase() || ids.has(entry.requestId) || typeof entry.previewId !== 'string' || !UUID.test(entry.previewId) || typeof entry.parametersSha256 !== 'string' || !DIGEST.test(entry.parametersSha256) || typeof entry.acceptedAt !== 'string' || !Number.isFinite(Date.parse(entry.acceptedAt)) || !['pending', 'completed', 'unknown'].includes(String(entry.state)) || (entry.state === 'completed' ? !validResult(entry.result, entry.requestId) : entry.result !== undefined)) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
    if (entry.previewId !== entry.previewId.toLowerCase() || new Date(entry.acceptedAt).toISOString() !== entry.acceptedAt || entry.parametersSha256 !== digest(JSON.stringify({ previewId: entry.previewId, requestId: entry.requestId, confirmed: true }))) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
    ids.add(entry.requestId)
  }
  return data as unknown as Receipt
}
function readLock(observed: ObservedFile | null): Lock | null {
  if (!observed) return null
  const value = parseJson(observed.text ?? '')
  if (!object(value) || !exact(value, ['schemaVersion', 'pid', 'requestId']) || value.schemaVersion !== 1 || !integer(value.pid) || value.pid === 0 || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
  return value as Lock
}
function lockLive(root: string, lock: Lock): boolean {
  if (lock.pid === process.pid) return heldLocks.has(root)
  try { process.kill(lock.pid, 0); return true } catch (error) { return !object(error) || error.code !== 'ESRCH' }
}
function wrapper(value: unknown, name: string, versions: readonly number[], globalNull: boolean): value is RecordValue & { tables: RecordValue; global: unknown } {
  return object(value) && exact(value, ['unit', 'global', 'tables']) && object(value.unit) && exact(value.unit, ['name', 'version']) && value.unit.name === name && typeof value.unit.version === 'number' && versions.includes(value.unit.version) && object(value.tables) && (!globalNull || value.global === null)
}
function cacheRecord(value: unknown): boolean {
  return object(value) && exact(value, ['identity', 'rows']) && object(value.identity) && integer(value.identity.createdAt) && (value.identity.cwd === undefined || typeof value.identity.cwd === 'string') && (value.identity.isSeeded === undefined || typeof value.identity.isSeeded === 'boolean') && object(value.rows) && Object.values(value.rows).every(row => object(row) && exact(row, ['ver', 'seq', 'val']) && integer(row.ver) && typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= -1)
}

function workspace(plan: Plan): void {
  const observed = plan.snapshot.file(WORKSPACE, 'json')
  if (!observed) return
  const data = parseJson(observed.text ?? '')
  if (!wrapper(data, 'workspace', [2], false) || !object(data.global) || typeof data.global.initialized !== 'boolean' || !strings(data.global.workspaceIds) || !strings(data.global.archivedSessionIds) || !strings(data.global.pinnedSessionIds) || data.global.defaultWorkspaceId !== undefined && typeof data.global.defaultWorkspaceId !== 'string' || data.global.pendingMutation !== undefined && data.global.pendingMutation !== null || !exact(data.tables, ['workspaces']) || !object(data.tables.workspaces)) fail('SESSION_HISTORY_UNSUPPORTED')
  const global = data.global
  let changed = false
  const filter = (values: string[]): string[] => { const result = values.filter(value => !plan.sessionIds.has(value)); if (result.length !== values.length) changed = true; return result }
  global.archivedSessionIds = filter(global.archivedSessionIds as string[])
  global.pinnedSessionIds = filter(global.pinnedSessionIds as string[])
  for (const row of Object.values(data.tables.workspaces)) {
    if (!object(row) || typeof row.path !== 'string' || typeof row.title !== 'string' || !strings(row.sessionIds) || !timestamp(row.createdAt) || !timestamp(row.updatedAt)) fail('SESSION_HISTORY_UNSUPPORTED')
    row.sessionIds = filter(row.sessionIds)
  }
  if (changed) plan.replacements.set(WORKSPACE, JSON.stringify(data) + '\n')
}
function caches(plan: Plan): void {
  const observed = plan.snapshot.file(LEGACY_CACHE, 'json')
  if (observed) {
    const data = parseJson(observed.text ?? '')
    if (!wrapper(data, 'session_projcache', [3, 4, 5, 6, 7], true) || !exact(data.tables, ['sessions']) || !object(data.tables.sessions)) fail('SESSION_HISTORY_UNSUPPORTED')
    let changed = false
    for (const [id, value] of Object.entries(data.tables.sessions)) {
      if (!cacheRecord(value)) fail('SESSION_HISTORY_UNSUPPORTED')
      if (plan.sessionIds.has(id)) { delete data.tables.sessions[id]; changed = true }
    }
    if (changed) plan.replacements.set(LEGACY_CACHE, JSON.stringify(data) + '\n')
  }
  for (const filename of plan.snapshot.directory(CACHE) ?? []) {
    const match = /^([A-Za-z0-9_-]+)\.json(?:\.bak\.\d{12})?$/.exec(filename)
    if (!match || !match[1] || !plan.sessionIds.has(match[1])) continue
    const name = join(CACHE, filename)
    const value = plan.snapshot.file(name, 'json')
    if (!value) fail('SESSION_HISTORY_PREVIEW_STALE')
    const data = parseJson(value.text ?? '')
    if (!object(data) || !exact(data, ['version', 'record']) || data.version !== 7 || !cacheRecord(data.record)) fail('SESSION_HISTORY_UNSUPPORTED')
    plan.deletions.push(name)
  }
}
function schedules(plan: Plan): void {
  const observed = plan.snapshot.file(join('dsh-home', 'storages', 'schedule.json'), 'json')
  if (!observed) return
  const data = parseJson(observed.text ?? '')
  if (!wrapper(data, 'schedule', [1], true) || !exact(data.tables, ['tasks']) || !object(data.tables.tasks)) fail('SESSION_HISTORY_UNSUPPORTED')
  for (const row of Object.values(data.tables.tasks)) {
    if (!object(row) || !text(row.sessionId) || !object(row.record) || !['active', 'inactive'].includes(String(row.status))) fail('SESSION_HISTORY_UNSUPPORTED')
    if (plan.sessionIds.has(row.sessionId)) fail('SESSION_HISTORY_SCHEDULED')
  }
}
function sharedFiles(plan: Plan, directory: string): void {
  for (const filename of plan.snapshot.directory(directory) ?? []) {
    const name = join(directory, filename)
    const stat = plan.snapshot.guard.inspect(name, plan.snapshot.directories)
    if (stat.isDirectory()) sharedFiles(plan, name)
    else { if (!plan.snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE'); plan.deletions.push(name) }
  }
}
function allowedDelete(plan: Plan, name: string): boolean {
  if (METADATA.has(name) || dirname(name) === 'bridge' && BRIDGE.test(relative('bridge', name))) return true
  if (SHARED.some(directory => under(name, directory))) return true
  if (dirname(name) === CACHE) {
    const match = /^([A-Za-z0-9_-]+)\.json(?:\.bak\.\d{12})?$/.exec(relative(CACHE, name))
    return !!match?.[1] && plan.sessionIds.has(match[1])
  }
  return plan.logDirectories.has(dirname(name)) && GENERATION.test(relative(dirname(name), name))
}
function atomicWrite(guard: Guard, name: string, body: string, directories: Map<string, DirectoryObservation>, expected: Fingerprint | null): Fingerprint {
  if (![WORKSPACE, LEGACY_CACHE, RECEIPT].includes(name)) fail('SESSION_HISTORY_PATH_UNSAFE')
  const parent = dirname(name)
  const requireExpected = () => {
    if (expected) {
      if (JSON.stringify(observeFile(guard, name, 'hash', directories).fingerprint) !== JSON.stringify(expected)) fail('SESSION_HISTORY_PREVIEW_STALE')
    } else {
      try { guard.inspect(name, directories); fail('SESSION_HISTORY_PREVIEW_STALE') } catch (error) { if (!missing(error)) throw error }
    }
  }
  requireExpected()
  const temporary = parent === '.' ? `.session-history-${randomUUID()}.tmp` : join(parent, `.session-history-${randomUUID()}.tmp`)
  const descriptor = openSync(guard.absolute(temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const created = identity(fstatSync(descriptor, { bigint: true }))
  let renamed = false
  try {
    if (!sameIdentity(identity(guard.inspect(temporary, directories)), created)) fail('SESSION_HISTORY_PATH_UNSAFE')
    writeFileSync(descriptor, body)
    fsyncSync(descriptor)
    requireExpected()
    if (!sameIdentity(identity(guard.inspect(temporary, directories)), created)) fail('SESSION_HISTORY_PATH_UNSAFE')
    renameSync(guard.absolute(temporary), guard.absolute(name))
    renamed = true
    guard.syncDirectory(parent === '.' ? undefined : parent)
    const actual = observeFile(guard, name, 'hash', directories).fingerprint
    if (!sameIdentity(actual, created) || actual.sha256 !== digest(body)) fail('SESSION_HISTORY_PREVIEW_STALE')
    return actual
  } finally {
    closeSync(descriptor)
    if (!renamed) {
      try { if (sameIdentity(identity(guard.inspect(temporary, directories)), created)) unlinkSync(guard.absolute(temporary)) } catch (error) { if (!missing(error)) throw error }
    }
  }
}

export class DshSessionHistory {
  private readonly guard: Guard
  private current: Plan | null = null
  constructor(directory: string) { this.guard = new Guard(directory) }
  async preview(): Promise<SessionHistoryPreview> {
    this.current = null
    try {
      const snapshot = new Snapshot(this.guard)
      const receipt = readReceipt(snapshot.file(RECEIPT, 'json'))
      const lock = readLock(snapshot.file(LOCK, 'json'))
      if (lock && lockLive(this.guard.root, lock)) fail('SESSION_HISTORY_BUSY')
      const plan: Plan = { public: { previewId: randomUUID(), expiresAt: new Date(Date.now() + TTL).toISOString(), sessionCount: 0, rootCount: 0, childCount: 0 }, snapshot, receipt, lock, deletions: [], replacements: new Map(), logDirectories: new Set(), sessionIds: new Set() }
      let rootCount = 0
      let childCount = 0
      const sessions = join('dsh-home', 'sessions')
      const logs: string[] = []
      for (const project of snapshot.directory(sessions) ?? []) {
        const projectDirectory = join(sessions, project)
        if (!this.guard.inspect(projectDirectory, snapshot.directories).isDirectory()) continue
        for (const folder of snapshot.directory(projectDirectory) ?? []) {
          const directory = join(projectDirectory, folder)
          if (!this.guard.inspect(directory, snapshot.directories).isDirectory()) continue
          const names = snapshot.directory(directory) ?? []
          if (names.includes('session.lock') && !snapshot.file(join(directory, 'session.lock'))) fail('SESSION_HISTORY_PREVIEW_STALE')
          const header = snapshot.file(join(directory, 'session.v4.jsonl'), 'header')
          if (!header) { if (names.some(name => GENERATION.test(name))) fail('SESSION_HISTORY_UNSUPPORTED'); continue }
          const value = parseJson(header.text ?? '')
          if (!object(value) || value.type !== 'session' || value.version !== 4 || !text(value.id) || !integer(value.createdAt) || typeof value.isSeeded !== 'boolean' || !integer(value.delegationDepth) || value.cwd !== undefined && typeof value.cwd !== 'string' || value.parentSession !== undefined && !text(value.parentSession) || value.origin !== undefined && typeof value.origin !== 'string' || folder !== encodeSegment(value.id) || plan.sessionIds.has(value.id)) fail('SESSION_HISTORY_UNSUPPORTED')
          plan.sessionIds.add(value.id)
          if (value.parentSession !== undefined) childCount++; else rootCount++
          plan.logDirectories.add(directory)
          for (const filename of names) {
            if (!GENERATION.test(filename)) continue
            const name = join(directory, filename)
            if (filename !== 'session.v4.jsonl' && !snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE')
            logs.push(name)
          }
        }
      }
      plan.public = { ...plan.public, sessionCount: plan.sessionIds.size, rootCount, childCount }
      schedules(plan)
      workspace(plan)
      caches(plan)
      for (const name of METADATA) if (snapshot.file(name)) plan.deletions.push(name)
      for (const filename of snapshot.directory('bridge') ?? []) if (BRIDGE.test(filename)) {
        const name = join('bridge', filename)
        if (!snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE')
        plan.deletions.push(name)
      }
      if (plan.sessionIds.size) for (const directory of SHARED) sharedFiles(plan, directory)
      logs.sort((left, right) => Number(left.endsWith('session.v4.jsonl')) - Number(right.endsWith('session.v4.jsonl')) || left.localeCompare(right))
      plan.deletions.push(...logs)
      snapshot.verify()
      this.current = plan
      return { ...plan.public }
    } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
  }
  async clear(input: unknown, beforeMutation?: () => void): Promise<SessionHistoryResult> {
    if (!object(input) || !exact(input, ['previewId', 'requestId', 'confirmed']) || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !('value' in descriptor)) || typeof input.previewId !== 'string' || !UUID.test(input.previewId) || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || input.confirmed !== true) fail('SESSION_HISTORY_INVALID_INPUT', 400)
    const previewId = input.previewId.toLowerCase()
    const requestId = input.requestId.toLowerCase()
    const parametersSha256 = digest(JSON.stringify({ previewId, requestId, confirmed: true }))
    let receipt: Receipt
    try { receipt = readReceipt(new Snapshot(this.guard).file(RECEIPT, 'json')) }
    catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    const existing = receipt.entries.find(entry => entry.requestId === requestId)
    if (existing) {
      if (existing.parametersSha256 !== parametersSha256 || existing.previewId !== previewId) fail('SESSION_HISTORY_REQUEST_CONFLICT')
      if (existing.state === 'completed' && existing.result) return { ...existing.result }
      fail('SESSION_HISTORY_REQUEST_UNKNOWN', 409, 'unknown')
    }
    const plan = this.current
    if (!plan || plan.public.previewId !== previewId) fail('SESSION_HISTORY_PREVIEW_STALE')
    if (Date.now() >= Date.parse(plan.public.expiresAt)) { this.current = null; fail('SESSION_HISTORY_PREVIEW_STALE') }
    if (receipt.entries.length >= MAX_RECEIPTS) fail('SESSION_HISTORY_CAPACITY')
    plan.snapshot.verify()
    try { beforeMutation?.() } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    let lockIdentity: Identity | null = null
    let receiptFingerprint = plan.snapshot.files.get(RECEIPT) ?? null
    let accepted = false
    try {
      if (heldLocks.has(this.guard.root)) fail('SESSION_HISTORY_BUSY')
      if (plan.lock) {
        if (lockLive(this.guard.root, plan.lock)) fail('SESSION_HISTORY_BUSY')
        plan.snapshot.requireFile(LOCK)
        unlinkSync(this.guard.absolute(LOCK))
        this.guard.syncDirectory()
      }
      this.guard.rootValid()
      const descriptor = openSync(this.guard.absolute(LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        lockIdentity = identity(fstatSync(descriptor, { bigint: true }))
        heldLocks.add(this.guard.root)
        writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, pid: process.pid, requestId } satisfies Lock) + '\n')
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      this.guard.syncDirectory()
      plan.snapshot.verify(true)
      const entry: ReceiptEntry = { requestId, previewId, parametersSha256, acceptedAt: new Date().toISOString(), state: 'pending' }
      receipt.entries.push(entry)
      this.current = null
      try {
        receiptFingerprint = atomicWrite(this.guard, RECEIPT, JSON.stringify(receipt) + '\n', plan.snapshot.directories, receiptFingerprint)
        accepted = true
      } catch (error) {
        const persisted = new Snapshot(this.guard).file(RECEIPT, 'json')
        const entry = readReceipt(persisted).entries.find(value => value.requestId === requestId)
        if (entry?.parametersSha256 === parametersSha256) { accepted = true; receiptFingerprint = persisted?.fingerprint ?? null }
        throw error
      }
      for (const [name, body] of plan.replacements) {
        plan.snapshot.requireFile(name)
        atomicWrite(this.guard, name, body, plan.snapshot.directories, plan.snapshot.files.get(name) ?? null)
      }
      const modified = new Set<string>()
      for (const name of plan.deletions) {
        if (!allowedDelete(plan, name)) fail('SESSION_HISTORY_PATH_UNSAFE')
        plan.snapshot.requireFile(name)
        unlinkSync(this.guard.absolute(name))
        modified.add(dirname(name))
      }
      for (const directory of modified) this.guard.syncDirectory(directory === '.' ? undefined : directory)
      const result: SessionHistoryResult = { requestId, status: 'completed', deletedCount: plan.public.sessionCount }
      entry.state = 'completed'
      entry.result = result
      atomicWrite(this.guard, RECEIPT, JSON.stringify(receipt) + '\n', plan.snapshot.directories, receiptFingerprint)
      return { ...result }
    } catch (error) {
      if (accepted) {
        const entry = receipt.entries.find(value => value.requestId === requestId)
        if (entry) { entry.state = 'unknown'; delete entry.result }
        try { atomicWrite(this.guard, RECEIPT, JSON.stringify(receipt) + '\n', plan.snapshot.directories, receiptFingerprint) } catch {}
        return fail('SESSION_HISTORY_CLEAR_UNKNOWN', 500, 'unknown')
      }
      if (error instanceof PlatformError) throw error
      if (object(error) && error.code === 'EEXIST') return fail('SESSION_HISTORY_BUSY')
      return fail('SESSION_HISTORY_IO_FAILED', 500)
    } finally {
      if (lockIdentity) {
        try {
          if (!sameIdentity(identity(this.guard.inspect(LOCK)), lockIdentity)) fail('SESSION_HISTORY_PATH_UNSAFE')
          unlinkSync(this.guard.absolute(LOCK))
          this.guard.syncDirectory()
        } catch {}
        heldLocks.delete(this.guard.root)
      }
    }
  }
}
