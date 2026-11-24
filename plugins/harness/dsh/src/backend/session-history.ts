import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { PlatformError } from '@eating/plugin-sdk'
import type { HarnessQueueSummary } from '@eating/plugin-sdk'

export type DshResetQueueAction = 'none' | 'keep' | 'clear'

export interface DshResetPreview {
  readonly previewId: string
  readonly expiresAt: string
  readonly runtimeRunning: boolean
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
  readonly scheduledCount: number
  readonly workspaceEntryCount: number
  readonly residualStateCount: number
  readonly hasResettableData: boolean
  readonly hasPendingQueue: boolean
  readonly pendingQueueCount: number
  readonly uncertainQueueCount: number
}

export interface DshResetResult {
  readonly requestId: string
  readonly status: 'completed'
  readonly deletedSessions: number
  readonly clearedWorkspaceEntries: number
  readonly clearedScheduledCount: number
  readonly clearedQueueCount: number
  readonly queueAction: DshResetQueueAction
  readonly wasRunning: boolean
  readonly restarted: boolean
}

export interface DshResetPreviewOptions {
  readonly runtimeRunning?: boolean
  readonly queue?: HarnessQueueSummary
}

export interface PreparedDshReset {
  readonly previewId: string
  readonly requestId: string
  readonly parametersSha256: string
  readonly queueAction: DshResetQueueAction
}

export interface InspectedDshReset {
  readonly replay?: DshResetResult
  readonly prepared?: PreparedDshReset
}

type RecordValue = Record<string, unknown>
type Identity = { dev: string; ino: string }
type Fingerprint = Identity & { size: string; mtime: string; sha256: string }
type ObservedFile = { fingerprint: Fingerprint; text?: string }
type ReceiptEntry = {
  requestId: string
  previewId: string
  parametersSha256: string
  acceptedAt: string
  state: 'pending' | 'completed' | 'unknown'
  queueAction: DshResetQueueAction
  result?: DshResetResult
}
type Receipt = { schemaVersion: 1; entries: ReceiptEntry[] }
type Lock = { schemaVersion: 1; pid: number; requestId: string }

interface ActivePreview {
  readonly preview: DshResetPreview
  readonly expiresAtMs: number
}

interface ScanStats {
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
  readonly scheduledCount: number
  readonly workspaceEntryCount: number
  readonly residualStateCount: number
  readonly hasResettableData: boolean
}

const TTL = 5 * 60_000
const MAX_JSON_BYTES = 64 * 1024 * 1024
const MAX_RECEIPTS = 10_000
const RECEIPT = 'dsh-reset-receipt.json'
const LOCK = 'dsh-reset-lock.json'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const LEGACY_TEMP = /^\.session-history-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i
const RESET_ROOT_FILES = new Set([
  'session.json',
  'agent-bindings.json',
  'proactive-bindings.json',
  'execution-bindings.json',
  'session-history-receipt.json',
  'session-history-lock.json',
])
const DSH_HOME_SYMLINK_SUBDIRS = new Set(['profiles'])
const RESET_CLEAN_DIRS = ['agents-home', 'runtime-home', 'native-management'] as const
const heldLocks = new Set<string>()

const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const exact = (value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean =>
  Reflect.ownKeys(value).length === Object.keys(value).length
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino
const sameStat = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const under = (value: string, directory: string): boolean => value.startsWith(directory + sep)
const missing = (error: unknown): boolean => object(error) && error.code === 'ENOENT'

function fail(code: string, status = 409, outcome: 'not-sent' | 'unknown' = 'not-sent'): never {
  const message = code === 'DSH_RESET_QUEUE_DECISION_REQUIRED' ? '当前消息队列中仍有待处理或待核对的消息，请先选择保留队列或清空队列后再重置 DSH。'
    : code === 'DSH_RESET_PREVIEW_STALE' ? '重置预览已过期，请重新检查当前状态并确认。'
      : code === 'DSH_RESET_REQUEST_UNKNOWN' || outcome === 'unknown' ? '本次重置结果尚未确认，禁止自动重放原请求；请重新检查当前状态。'
        : code === 'DSH_RESET_RUNTIME_ACTIVE' ? 'DSH 运行时尚未完全停止，无法执行重置。'
          : code === 'DSH_RESET_INVALID_INPUT' ? '重置参数无效，需要有效的预览标识、请求标识与明确确认。'
            : code === 'DSH_RESET_RECEIPT_INVALID' ? '重置回执格式无效，已停止操作并保留原文件。'
              : code === 'DSH_RESET_BUSY' ? '另一次 DSH 重置或管理操作正在执行，请稍后再试。'
                : code === 'DSH_RESET_REQUEST_CONFLICT' ? '请求标识已用于另一重置意图，请核对原请求。'
                  : code === 'DSH_RESET_CAPACITY' ? '重置回执已达到容量上限，未接受新请求。'
                    : code === 'DSH_RESET_PATH_UNSAFE' ? 'DSH 数据路径未通过安全核验，未执行重置。'
                      : '无法安全完成 DSH 重置操作，原始错误详情未公开。'
  throw new PlatformError(code, message, status, outcome)
}

class Guard {
  readonly root: string
  private readonly ancestors = new Map<string, Identity>()
  constructor(directory: string) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) fail('DSH_RESET_PATH_UNSAFE')
    this.root = resolve(directory)
    const home = resolve(homedir())
    const mainDsh = resolve(home, '.dsh')
    if (
      this.root === dirname(this.root)
      || this.root === home
      || under(home, this.root)
      || this.root === mainDsh
      || under(this.root, mainDsh)
      || ['dsh-home', '.dsh'].includes(relative(dirname(this.root), this.root))
    ) fail('DSH_RESET_PATH_UNSAFE')
    try {
      let ancestor = this.root
      for (;;) {
        const stat = lstatSync(ancestor, { bigint: true })
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) fail('DSH_RESET_PATH_UNSAFE')
        this.ancestors.set(ancestor, identity(stat))
        const parent = dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
    } catch (error) {
      if (error instanceof PlatformError) throw error
      fail('DSH_RESET_PATH_UNSAFE')
    }
  }

  absolute(name: string): string {
    const absolute = resolve(this.root, name)
    const suffix = relative(this.root, absolute)
    if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix) || suffix !== name || name.includes('\0')) {
      fail('DSH_RESET_PATH_UNSAFE')
    }
    return absolute
  }

  rootValid(): void {
    for (const [name, expected] of this.ancestors) {
      const stat = lstatSync(name, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), expected) || realpathSync(name) !== name) {
        fail('DSH_RESET_PATH_UNSAFE')
      }
    }
  }

  inspect(name: string, allowLeafSymlink = false): BigIntStats {
    this.rootValid()
    const absolute = this.absolute(name)
    const components = name.split(sep)
    let ancestor = this.root
    for (const component of components.slice(0, -1)) {
      ancestor = join(ancestor, component)
      const stat = lstatSync(ancestor, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) fail('DSH_RESET_PATH_UNSAFE')
    }
    const stat = lstatSync(absolute, { bigint: true })
    if (stat.isSymbolicLink()) {
      if (!allowLeafSymlink) fail('DSH_RESET_PATH_UNSAFE')
      return stat
    }
    if ((!stat.isDirectory() && !stat.isFile()) || realpathSync(absolute) !== absolute) fail('DSH_RESET_PATH_UNSAFE')
    return stat
  }

  syncDirectory(name?: string): void {
    const absolute = name ? this.absolute(name) : this.root
    if (name) {
      if (!this.inspect(name).isDirectory()) fail('DSH_RESET_PATH_UNSAFE')
    } else this.rootValid()
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0))
    try {
      if (!fstatSync(descriptor).isDirectory()) fail('DSH_RESET_PATH_UNSAFE')
      if (process.platform !== 'win32') fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
}

function observeFile(guard: Guard, name: string, readText = false): ObservedFile | null {
  let before: BigIntStats
  try { before = guard.inspect(name) } catch (error) { if (missing(error)) return null; throw error }
  if (!before.isFile() || (readText && before.size > BigInt(MAX_JSON_BYTES))) fail('DSH_RESET_RECEIPT_INVALID', 500)
  const descriptor = openSync(guard.absolute(name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameStat(before, fstatSync(descriptor, { bigint: true }))) fail('DSH_RESET_BUSY')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const chunks: Buffer[] = []
    let totalBytes = 0n
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!count) break
      totalBytes += BigInt(count)
      if (totalBytes > before.size) fail('DSH_RESET_BUSY')
      const bytes = buffer.subarray(0, count)
      hash.update(bytes)
      if (readText) chunks.push(Buffer.from(bytes))
    }
    if (totalBytes !== before.size || !sameStat(before, fstatSync(descriptor, { bigint: true }))) fail('DSH_RESET_BUSY')
    return {
      fingerprint: { ...identity(before), size: String(before.size), mtime: String(before.mtimeNs), sha256: hash.digest('hex') },
      ...(readText ? { text: Buffer.concat(chunks).toString('utf8') } : {}),
    }
  } finally {
    closeSync(descriptor)
  }
}

function validQueueAction(value: unknown): value is DshResetQueueAction {
  return value === 'none' || value === 'keep' || value === 'clear'
}

function validResult(value: unknown, requestId: string): value is DshResetResult {
  if (!object(value) || !exact(value, [
    'requestId', 'status', 'deletedSessions', 'clearedWorkspaceEntries', 'clearedScheduledCount', 'clearedQueueCount', 'queueAction', 'wasRunning', 'restarted',
  ])) return false
  return value.requestId === requestId
    && value.status === 'completed'
    && integer(value.deletedSessions)
    && integer(value.clearedWorkspaceEntries)
    && integer(value.clearedScheduledCount)
    && integer(value.clearedQueueCount)
    && validQueueAction(value.queueAction)
    && typeof value.wasRunning === 'boolean'
    && typeof value.restarted === 'boolean'
}

function readReceipt(observed: ObservedFile | null): Receipt {
  if (!observed) return { schemaVersion: 1, entries: [] }
  let data: unknown
  try { data = JSON.parse(observed.text ?? '') as unknown } catch { fail('DSH_RESET_RECEIPT_INVALID', 500) }
  if (!object(data) || !exact(data, ['schemaVersion', 'entries']) || data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_RECEIPTS) {
    fail('DSH_RESET_RECEIPT_INVALID', 500)
  }
  const ids = new Set<string>()
  for (const entry of data.entries) {
    if (
      !object(entry)
      || !exact(entry, ['requestId', 'previewId', 'parametersSha256', 'acceptedAt', 'state', 'queueAction'], ['result'])
      || typeof entry.requestId !== 'string' || !UUID.test(entry.requestId) || entry.requestId !== entry.requestId.toLowerCase() || ids.has(entry.requestId)
      || typeof entry.previewId !== 'string' || !UUID.test(entry.previewId) || entry.previewId !== entry.previewId.toLowerCase()
      || typeof entry.parametersSha256 !== 'string' || !DIGEST.test(entry.parametersSha256)
      || typeof entry.acceptedAt !== 'string' || !Number.isFinite(Date.parse(entry.acceptedAt)) || new Date(entry.acceptedAt).toISOString() !== entry.acceptedAt
      || !['pending', 'completed', 'unknown'].includes(String(entry.state))
      || !validQueueAction(entry.queueAction)
      || (entry.state === 'completed' ? !validResult(entry.result, entry.requestId) : entry.result !== undefined)
    ) fail('DSH_RESET_RECEIPT_INVALID', 500)
    const expectedDigest = digest(JSON.stringify({ previewId: entry.previewId, requestId: entry.requestId, confirmed: true, queueAction: entry.queueAction }))
    if (entry.parametersSha256 !== expectedDigest) fail('DSH_RESET_RECEIPT_INVALID', 500)
    ids.add(entry.requestId)
  }
  return data as unknown as Receipt
}

function readLock(observed: ObservedFile | null): Lock | null {
  if (!observed) return null
  let value: unknown
  try { value = JSON.parse(observed.text ?? '') as unknown } catch { fail('DSH_RESET_RECEIPT_INVALID', 500) }
  if (!object(value) || !exact(value, ['schemaVersion', 'pid', 'requestId']) || value.schemaVersion !== 1 || !integer(value.pid) || value.pid === 0 || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
    fail('DSH_RESET_RECEIPT_INVALID', 500)
  }
  return value as Lock
}

function lockLive(root: string, lock: Lock): boolean {
  if (lock.pid === process.pid) return heldLocks.has(root)
  try { process.kill(lock.pid, 0); return true } catch (error) { return !object(error) || error.code !== 'ESRCH' }
}

function atomicWriteReceipt(guard: Guard, receipt: Receipt, expected: Fingerprint | null): Fingerprint {
  const body = JSON.stringify(receipt, null, 2) + '\n'
  const verifyCurrent = () => {
    const current = observeFile(guard, RECEIPT)
    if (expected) {
      if (!current || JSON.stringify(current.fingerprint) !== JSON.stringify(expected)) fail('DSH_RESET_BUSY')
    } else if (current) {
      fail('DSH_RESET_BUSY')
    }
  }
  verifyCurrent()
  const temporary = `.dsh-reset-${randomUUID()}.tmp`
  const descriptor = openSync(guard.absolute(temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const created = identity(fstatSync(descriptor, { bigint: true }))
  let renamed = false
  try {
    if (!sameIdentity(identity(guard.inspect(temporary)), created)) fail('DSH_RESET_PATH_UNSAFE')
    writeFileSync(descriptor, body)
    fsyncSync(descriptor)
    verifyCurrent()
    if (!sameIdentity(identity(guard.inspect(temporary)), created)) fail('DSH_RESET_PATH_UNSAFE')
    renameSync(guard.absolute(temporary), guard.absolute(RECEIPT))
    renamed = true
    guard.syncDirectory()
    const actual = observeFile(guard, RECEIPT)?.fingerprint
    if (!actual || !sameIdentity(actual, created) || actual.sha256 !== digest(body)) fail('DSH_RESET_BUSY')
    return actual
  } finally {
    closeSync(descriptor)
    if (!renamed) {
      try {
        if (sameIdentity(identity(guard.inspect(temporary)), created)) unlinkSync(guard.absolute(temporary))
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
  }
}

function readFirstLine(guard: Guard, name: string): string | null {
  let stat: BigIntStats
  try { stat = guard.inspect(name) } catch (error) { if (missing(error)) return null; throw error }
  if (!stat.isFile()) return null
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
      if (newline >= 0) return Buffer.concat(chunks).toString('utf8')
      if (total > 128 * 1024) return null
    }
    return chunks.length ? Buffer.concat(chunks).toString('utf8') : null
  } finally {
    closeSync(descriptor)
  }
}

function readSmallJson(guard: Guard, name: string): unknown {
  let stat: BigIntStats
  try { stat = guard.inspect(name) } catch (error) { if (missing(error)) return null; throw error }
  if (!stat.isFile() || stat.size > BigInt(MAX_JSON_BYTES)) return null
  const descriptor = openSync(guard.absolute(name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!count) break
      chunks.push(Buffer.from(buffer.subarray(0, count)))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  } finally {
    closeSync(descriptor)
  }
}

function validateTree(guard: Guard, relativePath: string, allowSymlinkEntries: boolean, skipNames?: ReadonlySet<string>): void {
  let stat: BigIntStats
  try { stat = guard.inspect(relativePath, false) } catch (error) { if (missing(error)) return; throw error }
  if (!stat.isDirectory()) fail('DSH_RESET_PATH_UNSAFE')
  const walk = (current: string, topLevel: boolean) => {
    const names = readdirSync(guard.absolute(current)).sort()
    for (const entry of names) {
      if (topLevel && skipNames?.has(entry)) continue
      const child = join(current, entry)
      const childStat = guard.inspect(child, allowSymlinkEntries)
      if (childStat.isSymbolicLink()) continue
      if (childStat.isDirectory()) walk(child, false)
    }
  }
  walk(relativePath, true)
}

function clearTree(guard: Guard, relativePath: string, options: {
  readonly keepDirectory: boolean
  readonly allowSymlinkEntries: boolean
  readonly skipNames?: ReadonlySet<string>
}): number {
  let stat: BigIntStats
  try { stat = guard.inspect(relativePath, false) } catch (error) { if (missing(error)) return 0; throw error }
  if (!stat.isDirectory()) fail('DSH_RESET_PATH_UNSAFE')
  let removedTopEntries = 0
  const removeChildren = (current: string, topLevel: boolean) => {
    const names = readdirSync(guard.absolute(current)).sort()
    for (const entry of names) {
      if (topLevel && options.skipNames?.has(entry)) continue
      const child = join(current, entry)
      const childStat = guard.inspect(child, options.allowSymlinkEntries)
      if (childStat.isSymbolicLink()) {
        unlinkSync(guard.absolute(child))
      } else if (childStat.isDirectory()) {
        removeChildren(child, false)
        rmdirSync(guard.absolute(child))
      } else {
        unlinkSync(guard.absolute(child))
      }
      if (topLevel) removedTopEntries += 1
    }
  }
  removeChildren(relativePath, true)
  if (!options.keepDirectory) {
    rmdirSync(guard.absolute(relativePath))
  } else {
    guard.syncDirectory(relativePath)
  }
  return removedTopEntries
}

export class DshResetEngine {
  private readonly guard: Guard
  private current: ActivePreview | null = null

  constructor(directory: string) {
    this.guard = new Guard(directory)
  }

  private validateAllTargets(): void {
    this.guard.rootValid()
    validateTree(this.guard, 'dsh-home', false, DSH_HOME_SYMLINK_SUBDIRS)
    validateTree(this.guard, join('dsh-home', 'profiles'), true)
    validateTree(this.guard, 'workspace', true)
    validateTree(this.guard, 'bridge', true)
    for (const directory of RESET_CLEAN_DIRS) validateTree(this.guard, directory, true)
    for (const name of RESET_ROOT_FILES) {
      try {
        const stat = this.guard.inspect(name, false)
        if (!stat.isFile()) fail('DSH_RESET_PATH_UNSAFE')
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    for (const entry of readdirSync(this.guard.root)) {
      if (!LEGACY_TEMP.test(entry)) continue
      const stat = this.guard.inspect(entry, false)
      if (!stat.isFile()) fail('DSH_RESET_PATH_UNSAFE')
    }
  }

  private scanStats(): ScanStats {
    this.validateAllTargets()
    let rootCount = 0
    let childCount = 0
    let residualStateCount = 0
    const seenSessions = new Set<string>()

    const sessionsDir = join('dsh-home', 'sessions')
    let sessionsStat: BigIntStats | null = null
    try { sessionsStat = this.guard.inspect(sessionsDir, false) } catch (error) { if (!missing(error)) throw error }
    if (sessionsStat?.isDirectory()) {
      for (const project of readdirSync(this.guard.absolute(sessionsDir)).sort()) {
        const projectDir = join(sessionsDir, project)
        const projectStat = this.guard.inspect(projectDir, false)
        if (!projectStat.isDirectory()) { residualStateCount += 1; continue }
        const folders = readdirSync(this.guard.absolute(projectDir)).sort()
        if (!folders.length) { residualStateCount += 1; continue }
        for (const folder of folders) {
          const sessionDir = join(projectDir, folder)
          const folderStat = this.guard.inspect(sessionDir, false)
          if (!folderStat.isDirectory()) { residualStateCount += 1; continue }
          const firstLine = readFirstLine(this.guard, join(sessionDir, 'session.v4.jsonl'))
          let parsed: unknown = null
          if (firstLine) {
            try { parsed = JSON.parse(firstLine) as unknown } catch { parsed = null }
          }
          if (object(parsed) && parsed.type === 'session' && parsed.version === 4 && typeof parsed.id === 'string' && parsed.id.length > 0 && !seenSessions.has(parsed.id)) {
            seenSessions.add(parsed.id)
            if (typeof parsed.parentSession === 'string' && parsed.parentSession.length > 0) childCount += 1
            else rootCount += 1
          } else {
            residualStateCount += 1
          }
        }
      }
    }

    let scheduledCount = 0
    const scheduleData = readSmallJson(this.guard, join('dsh-home', 'storages', 'schedule.json'))
    if (object(scheduleData) && object(scheduleData.tables) && object(scheduleData.tables.tasks)) {
      scheduledCount = Object.keys(scheduleData.tables.tasks).length
    }

    let dshHomeStat: BigIntStats | null = null
    try { dshHomeStat = this.guard.inspect('dsh-home', false) } catch (error) { if (!missing(error)) throw error }
    if (dshHomeStat?.isDirectory()) {
      for (const entry of readdirSync(this.guard.absolute('dsh-home'))) {
        if (entry === 'sessions') continue
        residualStateCount += 1
      }
    }

    let workspaceEntryCount = 0
    let workspaceStat: BigIntStats | null = null
    try { workspaceStat = this.guard.inspect('workspace', false) } catch (error) { if (!missing(error)) throw error }
    if (workspaceStat?.isDirectory()) {
      workspaceEntryCount = readdirSync(this.guard.absolute('workspace')).length
    }

    let bridgeStat: BigIntStats | null = null
    try { bridgeStat = this.guard.inspect('bridge', false) } catch (error) { if (!missing(error)) throw error }
    if (bridgeStat?.isDirectory()) {
      residualStateCount += readdirSync(this.guard.absolute('bridge')).length
    }

    for (const directory of RESET_CLEAN_DIRS) {
      try {
        if (this.guard.inspect(directory, false).isDirectory()) residualStateCount += 1
      } catch (error) {
        if (!missing(error)) throw error
      }
    }

    for (const name of RESET_ROOT_FILES) {
      try {
        if (this.guard.inspect(name, false).isFile()) residualStateCount += 1
      } catch (error) {
        if (!missing(error)) throw error
      }
    }

    const sessionCount = rootCount + childCount
    const hasResettableData = sessionCount > 0 || workspaceEntryCount > 0 || scheduledCount > 0 || residualStateCount > 0
    return { sessionCount, rootCount, childCount, scheduledCount, workspaceEntryCount, residualStateCount, hasResettableData }
  }

  async preview(options: DshResetPreviewOptions = {}): Promise<DshResetPreview> {
    try {
      this.guard.rootValid()
      readReceipt(observeFile(this.guard, RECEIPT, true))
      const lock = readLock(observeFile(this.guard, LOCK, true))
      if (lock && lockLive(this.guard.root, lock)) fail('DSH_RESET_BUSY')
      const stats = this.scanStats()
      const pendingQueueCount = (options.queue?.pending ?? 0) + (options.queue?.delivering ?? 0)
      const uncertainQueueCount = options.queue?.uncertain ?? 0
      const hasPendingQueue = (options.queue?.queuedMessages ?? (pendingQueueCount + uncertainQueueCount)) > 0
      const expiresAtMs = Date.now() + TTL
      const preview: DshResetPreview = {
        previewId: randomUUID(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        runtimeRunning: Boolean(options.runtimeRunning),
        sessionCount: stats.sessionCount,
        rootCount: stats.rootCount,
        childCount: stats.childCount,
        scheduledCount: stats.scheduledCount,
        workspaceEntryCount: stats.workspaceEntryCount,
        residualStateCount: stats.residualStateCount,
        hasResettableData: stats.hasResettableData,
        hasPendingQueue,
        pendingQueueCount,
        uncertainQueueCount,
      }
      this.current = { preview, expiresAtMs }
      return { ...preview }
    } catch (error) {
      if (error instanceof PlatformError) throw error
      fail('DSH_RESET_IO_FAILED', 500)
    }
  }

  inspectResetRequest(input: unknown, liveQueue?: HarnessQueueSummary): InspectedDshReset {
    if (
      !object(input)
      || !exact(input, ['previewId', 'requestId', 'confirmed'], ['queueAction'])
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !('value' in descriptor))
      || typeof input.previewId !== 'string' || !UUID.test(input.previewId)
      || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
      || input.confirmed !== true
      || (input.queueAction !== undefined && input.queueAction !== 'keep' && input.queueAction !== 'clear')
    ) fail('DSH_RESET_INVALID_INPUT', 400)

    const previewId = input.previewId.toLowerCase()
    const requestId = input.requestId.toLowerCase()
    const queueAction: DshResetQueueAction = input.queueAction ?? 'none'
    const parametersSha256 = digest(JSON.stringify({ previewId, requestId, confirmed: true, queueAction }))

    let receipt: Receipt
    try {
      this.guard.rootValid()
      receipt = readReceipt(observeFile(this.guard, RECEIPT, true))
    } catch (error) {
      if (error instanceof PlatformError) throw error
      fail('DSH_RESET_IO_FAILED', 500)
    }

    const existing = receipt.entries.find(entry => entry.requestId === requestId)
    if (existing) {
      if (existing.parametersSha256 !== parametersSha256 || existing.previewId !== previewId || existing.queueAction !== queueAction) {
        fail('DSH_RESET_REQUEST_CONFLICT')
      }
      if (existing.state === 'completed' && existing.result) return { replay: { ...existing.result } }
      fail('DSH_RESET_REQUEST_UNKNOWN', 409, 'unknown')
    }

    const active = this.current
    if (!active || active.preview.previewId !== previewId) fail('DSH_RESET_PREVIEW_STALE')
    if (Date.now() >= active.expiresAtMs) {
      this.current = null
      fail('DSH_RESET_PREVIEW_STALE')
    }
    if (receipt.entries.length >= MAX_RECEIPTS) fail('DSH_RESET_CAPACITY')

    const lock = readLock(observeFile(this.guard, LOCK, true))
    if (lock && lockLive(this.guard.root, lock)) fail('DSH_RESET_BUSY')

    const queuedMessages = liveQueue?.queuedMessages ?? (active.preview.hasPendingQueue ? 1 : 0)
    if (queuedMessages > 0 && queueAction === 'none') fail('DSH_RESET_QUEUE_DECISION_REQUIRED')

    try { this.validateAllTargets() } catch (error) {
      if (error instanceof PlatformError) throw error
      fail('DSH_RESET_PATH_UNSAFE')
    }

    return { prepared: { previewId, requestId, parametersSha256, queueAction } }
  }

  executeReset(prepared: PreparedDshReset, hooks: { readonly assertStopped?: () => void } = {}): DshResetResult {
    hooks.assertStopped?.()
    this.guard.rootValid()
    if (heldLocks.has(this.guard.root)) fail('DSH_RESET_BUSY')

    const existingLock = readLock(observeFile(this.guard, LOCK, true))
    if (existingLock && lockLive(this.guard.root, existingLock)) fail('DSH_RESET_BUSY')
    if (existingLock) {
      try { unlinkSync(this.guard.absolute(LOCK)) } catch (error) { if (!missing(error)) fail('DSH_RESET_BUSY') }
    }

    const receiptFile = observeFile(this.guard, RECEIPT, true)
    const receipt = readReceipt(receiptFile)
    const duplicate = receipt.entries.find(entry => entry.requestId === prepared.requestId)
    if (duplicate) {
      if (duplicate.parametersSha256 !== prepared.parametersSha256 || duplicate.previewId !== prepared.previewId || duplicate.queueAction !== prepared.queueAction) {
        fail('DSH_RESET_REQUEST_CONFLICT')
      }
      if (duplicate.state === 'completed' && duplicate.result) return { ...duplicate.result }
      fail('DSH_RESET_REQUEST_UNKNOWN', 409, 'unknown')
    }
    if (receipt.entries.length >= MAX_RECEIPTS) fail('DSH_RESET_CAPACITY')

    const stats = this.scanStats()
    let lockDescriptor: number | null = null
    let lockIdentity: Identity | null = null
    let accepted = false
    let receiptFingerprint = receiptFile?.fingerprint ?? null
    const pendingEntry: ReceiptEntry = {
      requestId: prepared.requestId,
      previewId: prepared.previewId,
      parametersSha256: prepared.parametersSha256,
      acceptedAt: new Date().toISOString(),
      state: 'pending',
      queueAction: prepared.queueAction,
    }
    const nextReceipt: Receipt = { schemaVersion: 1, entries: [...receipt.entries, pendingEntry] }

    try {
      lockDescriptor = openSync(this.guard.absolute(LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      lockIdentity = identity(fstatSync(lockDescriptor, { bigint: true }))
      writeFileSync(lockDescriptor, JSON.stringify({ schemaVersion: 1, pid: process.pid, requestId: prepared.requestId }) + '\n')
      fsyncSync(lockDescriptor)
      closeSync(lockDescriptor)
      lockDescriptor = null
      this.guard.syncDirectory()
      heldLocks.add(this.guard.root)

      hooks.assertStopped?.()
      this.validateAllTargets()

      receiptFingerprint = atomicWriteReceipt(this.guard, nextReceipt, receiptFingerprint)
      accepted = true
      this.current = null

      clearTree(this.guard, join('dsh-home', 'profiles'), { keepDirectory: false, allowSymlinkEntries: true })
      clearTree(this.guard, 'dsh-home', { keepDirectory: false, allowSymlinkEntries: false })
      const clearedWorkspaceEntries = clearTree(this.guard, 'workspace', { keepDirectory: true, allowSymlinkEntries: true })
      clearTree(this.guard, 'bridge', { keepDirectory: true, allowSymlinkEntries: true })
      for (const directory of RESET_CLEAN_DIRS) {
        clearTree(this.guard, directory, { keepDirectory: false, allowSymlinkEntries: true })
      }
      for (const name of RESET_ROOT_FILES) {
        try {
          const stat = this.guard.inspect(name, false)
          if (!stat.isFile()) fail('DSH_RESET_PATH_UNSAFE')
          unlinkSync(this.guard.absolute(name))
        } catch (error) {
          if (!missing(error)) throw error
        }
      }
      for (const entry of readdirSync(this.guard.root)) {
        if (!LEGACY_TEMP.test(entry)) continue
        const stat = this.guard.inspect(entry, false)
        if (!stat.isFile()) fail('DSH_RESET_PATH_UNSAFE')
        unlinkSync(this.guard.absolute(entry))
      }
      // Ensure bridge directory exists cleanly for DshDeliveryRegistry reload.
      try {
        this.guard.inspect('bridge', false)
      } catch (error) {
        if (missing(error)) mkdirSync(this.guard.absolute('bridge'), { mode: 0o700 })
        else throw error
      }
      this.guard.syncDirectory()

      const result: DshResetResult = {
        requestId: prepared.requestId,
        status: 'completed',
        deletedSessions: stats.sessionCount,
        clearedWorkspaceEntries,
        clearedScheduledCount: stats.scheduledCount,
        clearedQueueCount: 0,
        queueAction: prepared.queueAction,
        wasRunning: false,
        restarted: false,
      }
      const completedReceipt: Receipt = {
        schemaVersion: 1,
        entries: [...receipt.entries, { ...pendingEntry, state: 'completed', result }],
      }
      atomicWriteReceipt(this.guard, completedReceipt, receiptFingerprint)
      return result
    } catch (error) {
      if (accepted) {
        try {
          const unknownReceipt: Receipt = {
            schemaVersion: 1,
            entries: [...receipt.entries, { ...pendingEntry, state: 'unknown' }],
          }
          atomicWriteReceipt(this.guard, unknownReceipt, receiptFingerprint)
        } catch { /* Preserve unknown outcome even if receipt rewrite fails. */ }
        fail('DSH_RESET_FAILED', 500, 'unknown')
      }
      if (error instanceof PlatformError) throw error
      return fail('DSH_RESET_IO_FAILED', 500)
    } finally {
      if (lockDescriptor !== null) {
        try { closeSync(lockDescriptor) } catch {}
      }
      if (lockIdentity) {
        try {
          if (sameIdentity(identity(this.guard.inspect(LOCK)), lockIdentity)) {
            unlinkSync(this.guard.absolute(LOCK))
            this.guard.syncDirectory()
          }
        } catch {}
        heldLocks.delete(this.guard.root)
      }
    }
  }

  finalizeReceipt(result: DshResetResult): DshResetResult {
    try {
      this.guard.rootValid()
      const observed = observeFile(this.guard, RECEIPT, true)
      const receipt = readReceipt(observed)
      const index = receipt.entries.findIndex(entry => entry.requestId === result.requestId && entry.state === 'completed')
      if (index < 0) return result
      const updatedEntries = receipt.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, result } : entry,
      )
      atomicWriteReceipt(this.guard, { schemaVersion: 1, entries: updatedEntries }, observed?.fingerprint ?? null)
    } catch {
      // Best-effort metadata update; completed receipt is already durable on disk.
    }
    return result
  }
}
