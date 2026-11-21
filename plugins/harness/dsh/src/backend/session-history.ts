import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { PlatformError } from '@eating/plugin-sdk'

export interface SessionBindingInfo {
  readonly sessionId: string
  readonly role: 'conversation' | 'proactive' | 'execution'
  readonly agentTypeId: string
  readonly label: string
  readonly platform?: string
  readonly kind?: string
  readonly targetId?: string
  readonly hasPendingTask?: boolean
}
export interface SessionHistoryItem {
  readonly id: string
  readonly parentId: string | null
  readonly isRoot: boolean
  readonly isCurrentRoot: boolean
  readonly role: 'root' | 'conversation' | 'proactive' | 'execution' | 'other'
  readonly label: string
  readonly agentTypeId: string | null
  readonly live: boolean
  readonly archived: boolean
  readonly pinned: boolean
  readonly scheduled: boolean
  readonly deletable: boolean
  readonly requiresRestart: boolean
  readonly blockReason: 'live' | 'scheduled' | null
  readonly sizeBytes: number
  readonly createdAt: string | null
  readonly updatedAt: string | null
}
export interface SessionHistoryPreview {
  readonly previewId: string
  readonly expiresAt: string
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
  readonly residualStateCount: number
  readonly runtimeRunning: boolean
  readonly hasPendingQueue: boolean
  readonly sessions: readonly SessionHistoryItem[]
}
export interface SessionHistoryResult {
  readonly requestId: string
  readonly status: 'completed'
  readonly deletedCount: number
  readonly mode?: 'clear' | 'selected-online' | 'selected-offline' | 'residual'
  readonly restarted?: boolean
  readonly clearedResidualCount?: number
}
export interface SessionHistoryPreviewOptions {
  readonly runtimeRunning?: boolean
  readonly liveSessionIds?: ReadonlySet<string>
  readonly archivedSessionIds?: ReadonlySet<string>
  readonly pinnedSessionIds?: ReadonlySet<string>
  readonly bindings?: readonly SessionBindingInfo[]
  readonly hasPendingQueue?: boolean
  readonly currentRootId?: string | null
}
export interface SessionHistoryClearOptions {
  readonly restarted?: boolean
}
export interface SessionHistoryDeleteOptions {
  readonly online: boolean
  readonly beforeMutation?: () => void
  readonly assertStopped?: () => void
  readonly restarted?: boolean
  readonly detachNativeSessions?: (sessionIds: readonly string[]) => Promise<void>
  readonly removeBindings?: (sessionIds: ReadonlySet<string>) => number
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
  sessionIds?: string[]
  result?: SessionHistoryResult
}
type Receipt = { schemaVersion: 1; entries: ReceiptEntry[] }
type Lock = { schemaVersion: 1; pid: number; requestId: string }
type SessionArtifactGroup = { directory: string; logFiles: string[]; cacheFiles: string[]; hasLock: boolean }
type Plan = {
  public: SessionHistoryPreview
  snapshot: Snapshot
  deletions: string[]
  replacements: Map<string, string>
  logDirectories: Set<string>
  sessionIds: Set<string>
  scheduledIds: Set<string>
  runtimeRunning: boolean
  currentRootId: string | null
  liveSessionIds: Set<string>
  residualCount: number
  sessionArtifacts: Map<string, SessionArtifactGroup>
  sessionSnapshots: Map<string, Snapshot>
  receipt: Receipt
  lock: Lock | null
}

const TTL = 5 * 60_000
const MAX_JSON_BYTES = 64 * 1024 * 1024
const MAX_RECEIPTS = 10_000
const MAX_SELECTION = 512
const RECEIPT = 'session-history-receipt.json'
const LOCK = 'session-history-lock.json'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const GENERATION = /^session(?:\.v[1-4])?\.jsonl$/
const RESIDUAL_BRIDGE = /^(?:(?:expected|deliveries|async-outbox|ready|session-ready|native-web-ready|error)\.json|(?:ack|expected)-[a-f0-9]{64}\.json|\.bridge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/
const BRIDGE = /^(?:(?:owner-policy|expected|deliveries|async-outbox|ready|session-ready|native-web-ready|error)\.json|(?:ack|expected)-[a-f0-9]{64}\.json|\.bridge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/
const BINDING_FILES = new Set(['agent-bindings.json', 'proactive-bindings.json', 'execution-bindings.json'])
const METADATA = new Set(['session.json', ...BINDING_FILES])
const CACHE_FILE = /^([A-Za-z0-9_-]+)\.json(?:\.bak\.\d{12})?$/
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
  const message = code === 'SESSION_HISTORY_SCHEDULED' ? '原生定时任务仍绑定该历史会话，请先在官方界面删除相关定时任务（已停用的任务也需删除）。'
    : code === 'SESSION_HISTORY_RESTART_REQUIRED' ? '所选会话包含当前主会话或活跃子会话，需要短暂重启 Harness 后删除。'
      : code === 'SESSION_HISTORY_SESSION_ACTIVE' ? '所选会话正在运行中，无法在线直接删除，请刷新状态后重试。'
        : code === 'SESSION_HISTORY_UNKNOWN_SESSION' ? '所选会话不存在或已不在当前预览中，请重新扫描后再试。'
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
  if (!object(value) || !exact(value, ['requestId', 'status', 'deletedCount'], ['mode', 'restarted', 'clearedResidualCount'])) return false
  if (value.requestId !== requestId || value.status !== 'completed' || !integer(value.deletedCount)) return false
  if (value.mode !== undefined && !['clear', 'selected-online', 'selected-offline', 'residual'].includes(String(value.mode))) return false
  if (value.restarted !== undefined && typeof value.restarted !== 'boolean') return false
  if (value.clearedResidualCount !== undefined && !integer(value.clearedResidualCount)) return false
  return true
}
function readReceipt(observed: ObservedFile | null): Receipt {
  if (!observed) return { schemaVersion: 1, entries: [] }
  let data: unknown
  try { data = JSON.parse(observed.text ?? '') as unknown } catch { fail('SESSION_HISTORY_RECEIPT_INVALID', 500) }
  if (!object(data) || !exact(data, ['schemaVersion', 'entries']) || data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_RECEIPTS) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
  const ids = new Set<string>()
  for (const entry of data.entries) {
    if (!object(entry) || !exact(entry, ['requestId', 'previewId', 'parametersSha256', 'acceptedAt', 'state'], ['result', 'sessionIds']) || typeof entry.requestId !== 'string' || !UUID.test(entry.requestId) || entry.requestId !== entry.requestId.toLowerCase() || ids.has(entry.requestId) || typeof entry.previewId !== 'string' || !UUID.test(entry.previewId) || typeof entry.parametersSha256 !== 'string' || !DIGEST.test(entry.parametersSha256) || typeof entry.acceptedAt !== 'string' || !Number.isFinite(Date.parse(entry.acceptedAt)) || !['pending', 'completed', 'unknown'].includes(String(entry.state)) || (entry.state === 'completed' ? !validResult(entry.result, entry.requestId) : entry.result !== undefined)) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
    if (entry.previewId !== entry.previewId.toLowerCase() || new Date(entry.acceptedAt).toISOString() !== entry.acceptedAt) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
    if (entry.sessionIds !== undefined) {
      if (!Array.isArray(entry.sessionIds) || entry.sessionIds.length === 0 || entry.sessionIds.length > MAX_SELECTION || entry.sessionIds.some(id => !text(id) || id.length > 256)) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
      const sorted = [...new Set(entry.sessionIds)].sort()
      if (sorted.length !== entry.sessionIds.length || entry.sessionIds.some((id, index) => id !== sorted[index])) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
      if (entry.parametersSha256 !== digest(JSON.stringify({ previewId: entry.previewId, requestId: entry.requestId, sessionIds: entry.sessionIds, confirmed: true }))) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
    } else if (entry.parametersSha256 !== digest(JSON.stringify({ previewId: entry.previewId, requestId: entry.requestId, confirmed: true }))) fail('SESSION_HISTORY_RECEIPT_INVALID', 500)
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
function readConcurrentHeader(guard: Guard, name: string): { headerText: string; sizeBytes: number; updatedMs: number } | null {
  let stat: BigIntStats
  try { stat = guard.inspect(name) } catch (error) { if (missing(error)) return null; throw error }
  if (!stat.isFile()) fail('SESSION_HISTORY_UNSUPPORTED')
  const descriptor = openSync(guard.absolute(name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, total)
      if (!read) break
      const slice = chunk.subarray(0, read)
      const newline = slice.indexOf(10)
      chunks.push(Buffer.from(newline < 0 ? slice : slice.subarray(0, newline)))
      total += read
      if (newline >= 0) return { headerText: Buffer.concat(chunks).toString('utf8'), sizeBytes: Number(stat.size), updatedMs: Number(stat.mtimeNs / 1_000_000n) }
      if (total > 128 * 1024) fail('SESSION_HISTORY_UNSUPPORTED')
    }
    fail('SESSION_HISTORY_UNSUPPORTED')
  } finally { closeSync(descriptor) }
}
function parseWorkspaceState(observed: ObservedFile | null): { data: RecordValue & { global: RecordValue; tables: { workspaces: RecordValue } }; archived: Set<string>; pinned: Set<string> } | null {
  if (!observed) return null
  const data = parseJson(observed.text ?? '')
  if (!wrapper(data, 'workspace', [2], false) || !object(data.global) || typeof data.global.initialized !== 'boolean' || !strings(data.global.workspaceIds) || !strings(data.global.archivedSessionIds) || !strings(data.global.pinnedSessionIds) || data.global.defaultWorkspaceId !== undefined && typeof data.global.defaultWorkspaceId !== 'string' || data.global.pendingMutation !== undefined && data.global.pendingMutation !== null || !exact(data.tables, ['workspaces']) || !object(data.tables.workspaces)) fail('SESSION_HISTORY_UNSUPPORTED')
  for (const row of Object.values(data.tables.workspaces)) {
    if (!object(row) || typeof row.path !== 'string' || typeof row.title !== 'string' || !strings(row.sessionIds) || !timestamp(row.createdAt) || !timestamp(row.updatedAt)) fail('SESSION_HISTORY_UNSUPPORTED')
  }
  return {
    data: data as RecordValue & { global: RecordValue; tables: { workspaces: RecordValue } },
    archived: new Set(data.global.archivedSessionIds),
    pinned: new Set(data.global.pinnedSessionIds),
  }
}
function workspaceFor(snapshot: Snapshot, replacements: Map<string, string>, targetIds: ReadonlySet<string>): { archived: Set<string>; pinned: Set<string> } {
  const observed = snapshot.file(WORKSPACE, 'json')
  const parsed = parseWorkspaceState(observed)
  if (!parsed) return { archived: new Set(), pinned: new Set() }
  const { data, archived, pinned } = parsed
  let changed = false
  const filter = (values: string[]): string[] => { const result = values.filter(value => !targetIds.has(value)); if (result.length !== values.length) changed = true; return result }
  data.global.archivedSessionIds = filter(data.global.archivedSessionIds as string[])
  data.global.pinnedSessionIds = filter(data.global.pinnedSessionIds as string[])
  for (const row of Object.values(data.tables.workspaces) as RecordValue[]) row.sessionIds = filter(row.sessionIds as string[])
  if (changed) replacements.set(WORKSPACE, JSON.stringify(data) + '\n')
  return { archived, pinned }
}
function cachesFor(snapshot: Snapshot, deletions: string[], replacements: Map<string, string>, targetIds: ReadonlySet<string>): void {
  const observed = snapshot.file(LEGACY_CACHE, 'json')
  if (observed) {
    const data = parseJson(observed.text ?? '')
    if (!wrapper(data, 'session_projcache', [3, 4, 5, 6, 7], true) || !exact(data.tables, ['sessions']) || !object(data.tables.sessions)) fail('SESSION_HISTORY_UNSUPPORTED')
    let changed = false
    for (const [id, value] of Object.entries(data.tables.sessions)) {
      if (!cacheRecord(value)) fail('SESSION_HISTORY_UNSUPPORTED')
      if (targetIds.has(id)) { delete data.tables.sessions[id]; changed = true }
    }
    if (changed) replacements.set(LEGACY_CACHE, JSON.stringify(data) + '\n')
  }
  for (const filename of snapshot.directory(CACHE) ?? []) {
    const match = CACHE_FILE.exec(filename)
    if (!match || !match[1] || !targetIds.has(match[1])) continue
    const name = join(CACHE, filename)
    const value = snapshot.file(name, 'json')
    if (!value) fail('SESSION_HISTORY_PREVIEW_STALE')
    const data = parseJson(value.text ?? '')
    if (!object(data) || !exact(data, ['version', 'record']) || data.version !== 7 || !cacheRecord(data.record)) fail('SESSION_HISTORY_UNSUPPORTED')
    deletions.push(name)
  }
}
function pruneBindings(snapshot: Snapshot, replacements: Map<string, string>, targetIds: ReadonlySet<string>): void {
  for (const name of BINDING_FILES) {
    const observed = snapshot.file(name, 'json')
    if (!observed) continue
    let data: unknown
    try { data = JSON.parse(observed.text ?? '') as unknown } catch { continue }
    if (!object(data) || !Array.isArray(data.bindings)) continue
    const kept = data.bindings.filter(row => {
      if (!object(row)) return true
      const id = name === 'agent-bindings.json' ? (object(row.scope) && typeof row.scope.agentId === 'string' ? row.scope.agentId : undefined) : (typeof row.agentId === 'string' ? row.agentId : undefined)
      return !id || !targetIds.has(id)
    })
    if (kept.length !== data.bindings.length) replacements.set(name, JSON.stringify({ ...data, bindings: kept }, null, 2) + '\n')
  }
}
function readSchedules(snapshot: Snapshot): Set<string> {
  const scheduled = new Set<string>()
  const observed = snapshot.file(join('dsh-home', 'storages', 'schedule.json'), 'json')
  if (!observed) return scheduled
  const data = parseJson(observed.text ?? '')
  if (!wrapper(data, 'schedule', [1], true) || !exact(data.tables, ['tasks']) || !object(data.tables.tasks)) fail('SESSION_HISTORY_UNSUPPORTED')
  for (const row of Object.values(data.tables.tasks)) {
    if (!object(row) || !text(row.sessionId) || !object(row.record) || !['active', 'inactive'].includes(String(row.status))) fail('SESSION_HISTORY_UNSUPPORTED')
    scheduled.add(row.sessionId)
  }
  return scheduled
}
function sharedFiles(plan: Plan, directory: string): void {
  for (const filename of plan.snapshot.directory(directory) ?? []) {
    const name = join(directory, filename)
    const stat = plan.snapshot.guard.inspect(name, plan.snapshot.directories)
    if (stat.isDirectory()) sharedFiles(plan, name)
    else { if (!plan.snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE'); plan.deletions.push(name) }
  }
}
function allowedDelete(logDirectories: ReadonlySet<string>, targetIds: ReadonlySet<string>, name: string): boolean {
  if (METADATA.has(name) || dirname(name) === 'bridge' && BRIDGE.test(relative('bridge', name))) return true
  if (SHARED.some(directory => under(name, directory))) return true
  if (dirname(name) === CACHE) {
    const match = CACHE_FILE.exec(relative(CACHE, name))
    return !!match?.[1] && targetIds.has(match[1])
  }
  return logDirectories.has(dirname(name)) && GENERATION.test(relative(dirname(name), name))
}
function atomicWrite(guard: Guard, name: string, body: string, directories: Map<string, DirectoryObservation>, expected: Fingerprint | null): Fingerprint {
  if (![WORKSPACE, LEGACY_CACHE, RECEIPT].includes(name) && !BINDING_FILES.has(name)) fail('SESSION_HISTORY_PATH_UNSAFE')
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

  private scanPlan(options: SessionHistoryPreviewOptions = {}, previewId: string = randomUUID()): Plan {
    const runtimeRunning = Boolean(options.runtimeRunning)
    const snapshot = new Snapshot(this.guard)
    const receipt = readReceipt(snapshot.file(RECEIPT, 'json'))
    const lock = readLock(snapshot.file(LOCK, 'json'))
    if (lock && lockLive(this.guard.root, lock)) fail('SESSION_HISTORY_BUSY')
    const liveSessionIds = new Set(options.liveSessionIds ?? [])
    const archivedOption = new Set(options.archivedSessionIds ?? [])
    const pinnedOption = new Set(options.pinnedSessionIds ?? [])
    const bindingsMap = new Map((options.bindings ?? []).map(binding => [binding.sessionId, binding]))
    const hasPendingQueue = Boolean(options.hasPendingQueue)

    let storedRootId: string | null = null
    const sessionMeta = runtimeRunning ? (() => {
      try {
        const stat = this.guard.inspect('session.json')
        if (!stat.isFile()) return null
        const fd = openSync(this.guard.absolute('session.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const buf = Buffer.alloc(Number(stat.size) > 0 && Number(stat.size) <= 65536 ? Number(stat.size) : 4096)
          const n = readSync(fd, buf, 0, buf.length, 0)
          return parseJson(buf.subarray(0, n).toString('utf8'))
        } finally { closeSync(fd) }
      } catch { return null }
    })() : (() => {
      const obs = snapshot.file('session.json', 'json')
      if (!obs) return null
      try { return JSON.parse(obs.text ?? '') as unknown } catch { return null }
    })()
    if (object(sessionMeta) && typeof sessionMeta.sessionId === 'string' && text(sessionMeta.sessionId)) storedRootId = sessionMeta.sessionId
    const currentRootId = options.currentRootId ?? storedRootId

    const scheduledAll = runtimeRunning ? (() => {
      try { return readSchedules(new Snapshot(this.guard)) } catch (error) { if (error instanceof PlatformError) throw error; return new Set<string>() }
    })() : readSchedules(snapshot)

    let rootCount = 0
    let childCount = 0
    const sessionsDir = join('dsh-home', 'sessions')
    const logs: string[] = []
    const sessionIds = new Set<string>()
    const scheduledIds = new Set<string>()
    const logDirectories = new Set<string>()
    const sessionArtifacts = new Map<string, SessionArtifactGroup>()
    const sessionSnapshots = new Map<string, Snapshot>()
    const rawItems: Array<{
      id: string; parentId: string | null; isRoot: boolean; isCurrentRoot: boolean;
      createdAt: string | null; updatedAt: string | null; sizeBytes: number; hasLock: boolean; origin: string | null
    }> = []

    for (const project of snapshot.directory(sessionsDir) ?? []) {
      const projectDirectory = join(sessionsDir, project)
      if (!this.guard.inspect(projectDirectory, runtimeRunning ? undefined : snapshot.directories).isDirectory()) continue
      for (const folder of (runtimeRunning ? readdirSync(this.guard.absolute(projectDirectory)).sort() : snapshot.directory(projectDirectory) ?? [])) {
        const directory = join(projectDirectory, folder)
        if (!this.guard.inspect(directory, runtimeRunning ? undefined : snapshot.directories).isDirectory()) continue
        const names = runtimeRunning ? readdirSync(this.guard.absolute(directory)).sort() : (snapshot.directory(directory) ?? [])
        const hasLock = names.includes('session.lock')
        if (!runtimeRunning && hasLock && !snapshot.file(join(directory, 'session.lock'))) fail('SESSION_HISTORY_PREVIEW_STALE')
        let headerText: string | undefined
        let headerUpdatedMs = 0
        if (runtimeRunning) {
          const observed = readConcurrentHeader(this.guard, join(directory, 'session.v4.jsonl'))
          if (!observed) { if (names.some(name => GENERATION.test(name))) fail('SESSION_HISTORY_UNSUPPORTED'); continue }
          headerText = observed.headerText
          headerUpdatedMs = observed.updatedMs
        } else {
          const header = snapshot.file(join(directory, 'session.v4.jsonl'), 'header')
          if (!header) { if (names.some(name => GENERATION.test(name))) fail('SESSION_HISTORY_UNSUPPORTED'); continue }
          headerText = header.text
        }
        const value = parseJson(headerText ?? '')
        if (!object(value) || value.type !== 'session' || value.version !== 4 || !text(value.id) || !integer(value.createdAt) || typeof value.isSeeded !== 'boolean' || !integer(value.delegationDepth) || value.cwd !== undefined && typeof value.cwd !== 'string' || value.parentSession !== undefined && !text(value.parentSession) || value.origin !== undefined && typeof value.origin !== 'string' || folder !== encodeSegment(value.id) || sessionIds.has(value.id)) fail('SESSION_HISTORY_UNSUPPORTED')
        sessionIds.add(value.id)
        if (scheduledAll.has(value.id)) scheduledIds.add(value.id)
        if (value.parentSession !== undefined) childCount++; else rootCount++
        logDirectories.add(directory)

        let sizeBytes = 0
        let maxMtimeNs = BigInt(headerUpdatedMs) * 1_000_000n
        const sessionLogs: string[] = []
        for (const filename of names) {
          if (!GENERATION.test(filename)) continue
          const name = join(directory, filename)
          if (!runtimeRunning && filename !== 'session.v4.jsonl' && !snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE')
          try {
            const st = this.guard.inspect(name)
            sizeBytes += Number(st.size)
            if (st.mtimeNs > maxMtimeNs) maxMtimeNs = st.mtimeNs
          } catch (error) { if (!runtimeRunning || !missing(error)) throw error }
          sessionLogs.push(name)
          logs.push(name)
        }
        sessionLogs.sort((left, right) => Number(left.endsWith('session.v4.jsonl')) - Number(right.endsWith('session.v4.jsonl')) || left.localeCompare(right))
        sessionArtifacts.set(value.id, { directory, logFiles: sessionLogs, cacheFiles: [], hasLock })
        rawItems.push({
          id: value.id,
          parentId: typeof value.parentSession === 'string' ? value.parentSession : null,
          isRoot: value.parentSession === undefined,
          isCurrentRoot: currentRootId !== null && value.id === currentRootId,
          createdAt: Number.isSafeInteger(value.createdAt) ? new Date(value.createdAt).toISOString() : null,
          updatedAt: maxMtimeNs > 0n ? new Date(Number(maxMtimeNs / 1_000_000n)).toISOString() : null,
          sizeBytes,
          hasLock,
          origin: typeof value.origin === 'string' && value.origin.trim() ? value.origin.trim() : null,
        })
      }
    }

    const deletions: string[] = []
    const replacements = new Map<string, string>()
    const plan: Plan = {
      public: { previewId, expiresAt: new Date(Date.now() + TTL).toISOString(), sessionCount: sessionIds.size, rootCount, childCount, residualStateCount: 0, runtimeRunning, hasPendingQueue, sessions: [] },
      snapshot, deletions, replacements, logDirectories, sessionIds, scheduledIds, runtimeRunning, currentRootId, liveSessionIds, residualCount: 0, sessionArtifacts, sessionSnapshots, receipt, lock,
    }

    let workspaceArchived = new Set<string>()
    let workspacePinned = new Set<string>()
    if (!runtimeRunning) {
      const ws = workspaceFor(snapshot, replacements, sessionIds)
      workspaceArchived = ws.archived
      workspacePinned = ws.pinned
      cachesFor(snapshot, deletions, replacements, sessionIds)
      if (sessionIds.size) for (const directory of SHARED) sharedFiles(plan, directory)
    } else {
      const ws = parseWorkspaceState(snapshot.file(WORKSPACE, 'json'))
      if (ws) { workspaceArchived = ws.archived; workspacePinned = ws.pinned }
    }

    const cacheEntries = (runtimeRunning ? (() => { try { return readdirSync(this.guard.absolute(CACHE)).sort() } catch { return [] } })() : (snapshot.directory(CACHE) ?? []))
    for (const filename of cacheEntries) {
      const match = CACHE_FILE.exec(filename)
      if (match?.[1] && sessionArtifacts.has(match[1])) sessionArtifacts.get(match[1])!.cacheFiles.push(join(CACHE, filename))
    }

    let metadataCount = 0
    for (const name of METADATA) {
      const present = runtimeRunning ? (() => { try { return this.guard.inspect(name).isFile() } catch { return false } })() : Boolean(snapshot.file(name))
      if (present) { metadataCount++; if (!runtimeRunning) deletions.push(name) }
    }
    let residualBridgeCount = 0
    const bridgeNames = runtimeRunning ? (() => { try { return readdirSync(this.guard.absolute('bridge')).sort() } catch { return [] } })() : (snapshot.directory('bridge') ?? [])
    for (const filename of bridgeNames) {
      if (!BRIDGE.test(filename)) continue
      const name = join('bridge', filename)
      if (!runtimeRunning && !snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE')
      if (!runtimeRunning) deletions.push(name)
      if (RESIDUAL_BRIDGE.test(filename)) residualBridgeCount++
    }
    const residualStateCount = runtimeRunning ? 0 : (sessionIds.size === 0 ? metadataCount : 0) + residualBridgeCount
    plan.residualCount = metadataCount + residualBridgeCount

    logs.sort((left, right) => Number(left.endsWith('session.v4.jsonl')) - Number(right.endsWith('session.v4.jsonl')) || left.localeCompare(right))
    if (!runtimeRunning) deletions.push(...logs)

    const items: SessionHistoryItem[] = rawItems.map(item => {
      const binding = bindingsMap.get(item.id)
      const scheduled = scheduledIds.has(item.id)
      const live = runtimeRunning && (item.isCurrentRoot || liveSessionIds.has(item.id) || item.hasLock || Boolean(binding?.hasPendingTask))
      const role: SessionHistoryItem['role'] = item.isCurrentRoot ? 'root' : binding ? binding.role : item.isRoot ? 'root' : 'other'
      const requiresRestart = Boolean(runtimeRunning && !scheduled && (item.isCurrentRoot || live))
      const deletable = !scheduled
      const archived = archivedOption.has(item.id) || workspaceArchived.has(item.id)
      const pinned = pinnedOption.has(item.id) || workspacePinned.has(item.id)
      if (runtimeRunning && !item.isCurrentRoot && !live && !scheduled) {
        const sub = new Snapshot(this.guard)
        const group = sessionArtifacts.get(item.id)!
        sub.directory(group.directory)
        for (const file of group.logFiles) sub.file(file)
        for (const file of group.cacheFiles) sub.file(file)
        sessionSnapshots.set(item.id, sub)
      }
      return {
        id: item.id,
        parentId: item.parentId,
        isRoot: item.isRoot,
        isCurrentRoot: item.isCurrentRoot,
        role,
        label: binding?.label ?? item.origin ?? '',
        agentTypeId: binding?.agentTypeId ?? null,
        live,
        archived,
        pinned,
        scheduled,
        deletable,
        requiresRestart,
        blockReason: scheduled ? ('scheduled' as const) : null,
        sizeBytes: item.sizeBytes,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }
    }).sort((left, right) => Number(right.isCurrentRoot) - Number(left.isCurrentRoot) || Number(right.live) - Number(left.live) || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id))

    if (!runtimeRunning) snapshot.verify()
    plan.public = { ...plan.public, residualStateCount, sessions: items }
    return plan
  }

  async preview(options: SessionHistoryPreviewOptions = {}): Promise<SessionHistoryPreview> {
    this.current = null
    try {
      const plan = this.scanPlan(options)
      this.current = plan
      return { ...plan.public, sessions: [...plan.public.sessions] }
    } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
  }

  private commitTransaction(args: {
    requestId: string
    previewId: string
    parametersSha256: string
    sessionIds?: string[]
    receipt: Receipt
    lock: Lock | null
    snapshot: Snapshot
    verifyBeforeLock: () => void
    requireLockFileSnapshot: Snapshot | null
    replacements: Map<string, string>
    deletions: string[]
    allowed: (name: string) => boolean
    onAfterDelete?: () => void
    result: SessionHistoryResult
  }): SessionHistoryResult {
    const { requestId, previewId, parametersSha256, sessionIds, receipt, lock, snapshot, verifyBeforeLock, requireLockFileSnapshot, replacements, deletions, allowed, onAfterDelete, result } = args
    let lockIdentity: Identity | null = null
    let receiptFingerprint = snapshot.files.get(RECEIPT) ?? null
    let accepted = false
    try {
      if (heldLocks.has(this.guard.root)) fail('SESSION_HISTORY_BUSY')
      if (lock) {
        if (lockLive(this.guard.root, lock)) fail('SESSION_HISTORY_BUSY')
        snapshot.requireFile(LOCK)
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
      verifyBeforeLock()
      const entry: ReceiptEntry = { requestId, previewId, parametersSha256, acceptedAt: new Date().toISOString(), state: 'pending', ...(sessionIds ? { sessionIds } : {}) }
      receipt.entries.push(entry)
      this.current = null
      try {
        receiptFingerprint = atomicWrite(this.guard, RECEIPT, JSON.stringify(receipt) + '\n', snapshot.directories, receiptFingerprint)
        accepted = true
      } catch (error) {
        const persisted = new Snapshot(this.guard).file(RECEIPT, 'json')
        const saved = readReceipt(persisted).entries.find(value => value.requestId === requestId)
        if (saved?.parametersSha256 === parametersSha256) { accepted = true; receiptFingerprint = persisted?.fingerprint ?? null }
        throw error
      }
      for (const [name, body] of replacements) {
        snapshot.requireFile(name)
        atomicWrite(this.guard, name, body, snapshot.directories, snapshot.files.get(name) ?? null)
      }
      const modified = new Set<string>()
      const fileSnapshot = requireLockFileSnapshot ?? snapshot
      for (const name of deletions) {
        if (!allowed(name)) fail('SESSION_HISTORY_PATH_UNSAFE')
        fileSnapshot.requireFile(name)
        unlinkSync(this.guard.absolute(name))
        modified.add(dirname(name))
      }
      for (const directory of modified) this.guard.syncDirectory(directory === '.' ? undefined : directory)
      onAfterDelete?.()
      entry.state = 'completed'
      entry.result = result
      atomicWrite(this.guard, RECEIPT, JSON.stringify(receipt) + '\n', snapshot.directories, receiptFingerprint)
      return { ...result }
    } catch (error) {
      if (accepted) {
        const entry = receipt.entries.find(value => value.requestId === requestId)
        if (entry) { entry.state = 'unknown'; delete entry.result }
        try { atomicWrite(this.guard, RECEIPT, JSON.stringify(receipt) + '\n', snapshot.directories, receiptFingerprint) } catch {}
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

  isResidualOnlyPreview(input: unknown): boolean {
    if (!this.current || !object(input) || typeof input.previewId !== 'string') return false
    return this.current.public.previewId === input.previewId.toLowerCase() && this.current.public.sessionCount === 0 && this.current.public.residualStateCount > 0
  }

  inspectDeleteRequest(input: unknown): { replay?: SessionHistoryResult; includesCurrentRoot: boolean; requiresRestart: boolean } {
    if (!object(input) || !exact(input, ['previewId', 'requestId', 'sessionIds', 'confirmed'], ['allowRestart']) || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !('value' in descriptor)) || typeof input.previewId !== 'string' || !UUID.test(input.previewId) || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || input.confirmed !== true || (input.allowRestart !== undefined && typeof input.allowRestart !== 'boolean') || !Array.isArray(input.sessionIds) || input.sessionIds.length === 0 || input.sessionIds.length > MAX_SELECTION || input.sessionIds.some(id => !text(id) || id.length > 256)) fail('SESSION_HISTORY_INVALID_INPUT', 400)
    const sortedIds = [...new Set(input.sessionIds)].sort()
    if (sortedIds.length !== input.sessionIds.length) fail('SESSION_HISTORY_INVALID_INPUT', 400)
    const previewId = input.previewId.toLowerCase()
    const requestId = input.requestId.toLowerCase()
    const parametersSha256 = digest(JSON.stringify({ previewId, requestId, sessionIds: sortedIds, confirmed: true }))
    let receipt: Receipt
    try { receipt = readReceipt(new Snapshot(this.guard).file(RECEIPT, 'json')) }
    catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    const existing = receipt.entries.find(entry => entry.requestId === requestId)
    if (existing) {
      if (existing.parametersSha256 !== parametersSha256 || existing.previewId !== previewId) fail('SESSION_HISTORY_REQUEST_CONFLICT')
      if (existing.state === 'completed' && existing.result) return { replay: { ...existing.result }, includesCurrentRoot: false, requiresRestart: false }
      fail('SESSION_HISTORY_REQUEST_UNKNOWN', 409, 'unknown')
    }
    const plan = this.current
    if (!plan || plan.public.previewId !== previewId) fail('SESSION_HISTORY_PREVIEW_STALE')
    if (Date.now() >= Date.parse(plan.public.expiresAt)) { this.current = null; fail('SESSION_HISTORY_PREVIEW_STALE') }
    if (receipt.entries.length >= MAX_RECEIPTS) fail('SESSION_HISTORY_CAPACITY')
    for (const id of sortedIds) {
      if (!plan.sessionIds.has(id)) fail('SESSION_HISTORY_UNKNOWN_SESSION')
      if (plan.scheduledIds.has(id)) fail('SESSION_HISTORY_SCHEDULED')
    }
    const includesCurrentRoot = Boolean(plan.currentRootId && sortedIds.includes(plan.currentRootId))
    const requiresRestart = plan.runtimeRunning && (includesCurrentRoot || sortedIds.some(id => plan.liveSessionIds.has(id)))
    return { includesCurrentRoot, requiresRestart }
  }

  private scanStoppedSafely(currentRootId: string | null, previewId: string): Plan {
    try { return this.scanPlan({ runtimeRunning: false, currentRootId }, previewId) }
    catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
  }

  async clear(input: unknown, beforeMutation?: () => void, options?: SessionHistoryClearOptions): Promise<SessionHistoryResult> {
    if (!object(input) || !exact(input, ['previewId', 'requestId', 'confirmed'], ['allowRestart']) || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !('value' in descriptor)) || typeof input.previewId !== 'string' || !UUID.test(input.previewId) || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || input.confirmed !== true || (input.allowRestart !== undefined && typeof input.allowRestart !== 'boolean')) fail('SESSION_HISTORY_INVALID_INPUT', 400)
    const previewId = input.previewId.toLowerCase()
    const requestId = input.requestId.toLowerCase()
    const parametersSha256 = digest(JSON.stringify({ previewId, requestId, confirmed: true }))
    let receipt: Receipt
    try { receipt = readReceipt(new Snapshot(this.guard).file(RECEIPT, 'json')) }
    catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    const existing = receipt.entries.find(entry => entry.requestId === requestId)
    if (existing) {
      if (existing.parametersSha256 !== parametersSha256 || existing.previewId !== previewId || existing.sessionIds !== undefined) fail('SESSION_HISTORY_REQUEST_CONFLICT')
      if (existing.state === 'completed' && existing.result) return { ...existing.result }
      fail('SESSION_HISTORY_REQUEST_UNKNOWN', 409, 'unknown')
    }
    const plan = this.current
    if (!plan || plan.public.previewId !== previewId) fail('SESSION_HISTORY_PREVIEW_STALE')
    if (Date.now() >= Date.parse(plan.public.expiresAt)) { this.current = null; fail('SESSION_HISTORY_PREVIEW_STALE') }
    if (receipt.entries.length >= MAX_RECEIPTS) fail('SESSION_HISTORY_CAPACITY')
    if (plan.scheduledIds.size > 0) fail('SESSION_HISTORY_SCHEDULED')
    if (!plan.runtimeRunning) plan.snapshot.verify()
    try { beforeMutation?.() } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    const execPlan = plan.runtimeRunning ? (options?.restarted ? this.scanStoppedSafely(plan.currentRootId, previewId) : fail('SESSION_HISTORY_RUNTIME_ACTIVE')) : plan
    if (execPlan.scheduledIds.size > 0) fail('SESSION_HISTORY_SCHEDULED')
    const mode: SessionHistoryResult['mode'] = execPlan.public.sessionCount === 0 && execPlan.public.residualStateCount > 0 ? 'residual' : 'clear'
    const result: SessionHistoryResult = {
      requestId, status: 'completed', deletedCount: execPlan.public.sessionCount,
      mode, restarted: Boolean(options?.restarted), clearedResidualCount: execPlan.residualCount,
    }
    return this.commitTransaction({
      requestId, previewId, parametersSha256, receipt, lock: execPlan.lock, snapshot: execPlan.snapshot,
      verifyBeforeLock: () => execPlan.snapshot.verify(true), requireLockFileSnapshot: null,
      replacements: execPlan.replacements, deletions: execPlan.deletions,
      allowed: name => allowedDelete(execPlan.logDirectories, execPlan.sessionIds, name),
      result,
    })
  }

  async deleteSelected(input: unknown, options: SessionHistoryDeleteOptions): Promise<SessionHistoryResult> {
    if (!object(input) || !exact(input, ['previewId', 'requestId', 'sessionIds', 'confirmed'], ['allowRestart']) || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !('value' in descriptor)) || typeof input.previewId !== 'string' || !UUID.test(input.previewId) || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || input.confirmed !== true || (input.allowRestart !== undefined && typeof input.allowRestart !== 'boolean') || !Array.isArray(input.sessionIds) || input.sessionIds.length === 0 || input.sessionIds.length > MAX_SELECTION || input.sessionIds.some(id => !text(id) || id.length > 256)) fail('SESSION_HISTORY_INVALID_INPUT', 400)
    const sortedIds = [...new Set(input.sessionIds)].sort()
    if (sortedIds.length !== input.sessionIds.length) fail('SESSION_HISTORY_INVALID_INPUT', 400)
    const previewId = input.previewId.toLowerCase()
    const requestId = input.requestId.toLowerCase()
    const parametersSha256 = digest(JSON.stringify({ previewId, requestId, sessionIds: sortedIds, confirmed: true }))
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
    for (const id of sortedIds) {
      if (!plan.sessionIds.has(id)) fail('SESSION_HISTORY_UNKNOWN_SESSION')
      if (plan.scheduledIds.has(id)) fail('SESSION_HISTORY_SCHEDULED')
    }

    const selectedSet = new Set(sortedIds)
    if (options.online) {
      if (sortedIds.some(id => id === plan.currentRootId || plan.liveSessionIds.has(id))) fail('SESSION_HISTORY_SESSION_ACTIVE')
      for (const id of sortedIds) {
        const sub = plan.sessionSnapshots.get(id)
        if (!sub) fail('SESSION_HISTORY_SESSION_ACTIVE')
        sub.verify()
      }
      await options.detachNativeSessions?.(sortedIds)
      try { options.beforeMutation?.() } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }

      const receiptSnapshot = new Snapshot(this.guard)
      const currentReceipt = readReceipt(receiptSnapshot.file(RECEIPT, 'json'))
      const currentLock = readLock(receiptSnapshot.file(LOCK, 'json'))
      const fileSnapshot = new Snapshot(this.guard)
      const deletions: string[] = []
      const allowedLogs = new Set<string>()
      for (const id of sortedIds) {
        const artifacts = plan.sessionArtifacts.get(id)
        const sub = plan.sessionSnapshots.get(id)
        if (!artifacts || !sub) fail('SESSION_HISTORY_PREVIEW_STALE')
        sub.verify()
        allowedLogs.add(artifacts.directory)
        for (const name of [...artifacts.cacheFiles, ...artifacts.logFiles]) {
          fileSnapshot.file(name)
          deletions.push(name)
        }
      }
      const deletionsSet = new Set(deletions)
      const result: SessionHistoryResult = {
        requestId, status: 'completed', deletedCount: sortedIds.length,
        mode: 'selected-online', restarted: false, clearedResidualCount: 0,
      }
      return this.commitTransaction({
        requestId, previewId, parametersSha256, sessionIds: sortedIds, receipt: currentReceipt, lock: currentLock,
        snapshot: receiptSnapshot, verifyBeforeLock: () => fileSnapshot.verify(), requireLockFileSnapshot: fileSnapshot,
        replacements: new Map(), deletions, allowed: name => deletionsSet.has(name) && allowedDelete(allowedLogs, selectedSet, name),
        onAfterDelete: () => { options.removeBindings?.(selectedSet) },
        result,
      })
    }

    try { options.assertStopped?.() } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    try { options.beforeMutation?.() } catch (error) { if (error instanceof PlatformError) throw error; fail('SESSION_HISTORY_IO_FAILED', 500) }
    if (plan.runtimeRunning && !options.restarted) fail('SESSION_HISTORY_RUNTIME_ACTIVE')
    if (!plan.runtimeRunning) plan.snapshot.verify()
    const execPlan = plan.runtimeRunning ? this.scanStoppedSafely(plan.currentRootId, previewId) : plan
    for (const id of sortedIds) {
      if (!execPlan.sessionIds.has(id)) fail('SESSION_HISTORY_UNKNOWN_SESSION')
      if (execPlan.scheduledIds.has(id)) fail('SESSION_HISTORY_SCHEDULED')
    }

    const deletions: string[] = []
    const replacements = new Map<string, string>()
    const allowedLogs = new Set<string>()
    workspaceFor(execPlan.snapshot, replacements, selectedSet)
    cachesFor(execPlan.snapshot, deletions, replacements, selectedSet)
    pruneBindings(execPlan.snapshot, replacements, selectedSet)

    const clearingAll = selectedSet.size === execPlan.sessionIds.size
    const includesRoot = Boolean(execPlan.currentRootId && selectedSet.has(execPlan.currentRootId))
    let clearedResidualCount = 0
    if (clearingAll || includesRoot) {
      if (clearingAll) for (const directory of SHARED) sharedFiles(execPlan, directory)
      if (clearingAll) for (const name of execPlan.deletions) if (SHARED.some(dir => under(name, dir))) deletions.push(name)
      for (const name of (clearingAll ? METADATA : ['session.json'])) {
        if (execPlan.snapshot.file(name)) {
          deletions.push(name)
          replacements.delete(name)
          clearedResidualCount++
        }
      }
      for (const filename of execPlan.snapshot.directory('bridge') ?? []) {
        if (!BRIDGE.test(filename)) continue
        const name = join('bridge', filename)
        if (!execPlan.snapshot.file(name)) fail('SESSION_HISTORY_PREVIEW_STALE')
        deletions.push(name)
        if (RESIDUAL_BRIDGE.test(filename)) clearedResidualCount++
      }
    }
    for (const id of sortedIds) {
      const group = execPlan.sessionArtifacts.get(id)
      if (!group) fail('SESSION_HISTORY_UNKNOWN_SESSION')
      allowedLogs.add(group.directory)
      deletions.push(...group.logFiles)
    }

    const result: SessionHistoryResult = {
      requestId, status: 'completed', deletedCount: sortedIds.length,
      mode: 'selected-offline', restarted: Boolean(options.restarted), clearedResidualCount,
    }
    return this.commitTransaction({
      requestId, previewId, parametersSha256, sessionIds: sortedIds, receipt: execPlan.receipt, lock: execPlan.lock,
      snapshot: execPlan.snapshot, verifyBeforeLock: () => execPlan.snapshot.verify(true), requireLockFileSnapshot: null,
      replacements, deletions, allowed: name => allowedDelete(allowedLogs, selectedSet, name),
      onAfterDelete: () => { options.removeBindings?.(selectedSet) },
      result,
    })
  }
}
