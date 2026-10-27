import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PlatformError, isJsonObject, type PluginPackageManifest } from '@eating/plugin-sdk'
import { acquireWorkspaceLock } from './lock'

export interface InstalledPluginPackage {
  manifest: PluginPackageManifest
  directory: string
}

const MANIFEST = 'eating-plugin.json'
const ENTRIES = ['server.mjs', 'ui/index.js', 'ui/style.css'] as const
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

type ActivePlugin = { id: string; version: string }
type OwnedPath = { path: string; parent: string; stat: Stats }
type Snapshot = { manifest: PluginPackageManifest; files: ReadonlyMap<string, Buffer> }

function failure(code: string, message: string, statusCode = 400): PlatformError {
  return new PlatformError(code, message, statusCode)
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && ID.test(value) && !RESERVED.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && VERSION.test(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validEntry(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && value.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== '.' && part !== '..')
}

/** Parses data only. Approval of the local executable source belongs to the caller. */
export function parsePluginPackageManifest(value: unknown): PluginPackageManifest {
  if (!isJsonObject(value) || !exactKeys(value, ['schemaVersion', 'id', 'name', 'description', 'version', 'kind', 'apiVersion', 'storageDirectory', 'backend', 'frontend', 'integrity'])) {
    throw failure('INVALID_PLUGIN_MANIFEST', '插件清单字段不完整或含有未知字段。')
  }
  if (value.schemaVersion !== 1 || value.apiVersion !== 1) throw failure('INCOMPATIBLE_PLUGIN_API', '仅支持 schemaVersion 1 / SDK apiVersion 1 的插件包。')
  if (!validId(value.id) || !validVersion(value.version) || !validId(value.storageDirectory) || !value.storageDirectory.endsWith('-bot') || value.kind !== 'communication'
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100
    || typeof value.description !== 'string' || value.description.length > 2000) {
    throw failure('INVALID_PLUGIN_MANIFEST', '插件身份、版本、类型、数据目录或说明无效。')
  }
  const frontend = value.frontend
  if (!isJsonObject(frontend) || !exactKeys(frontend, ['entry', 'style', 'order', 'brandColor', 'icon'])
    || !validEntry(value.backend) || !validEntry(frontend.entry) || !validEntry(frontend.style)
    || value.backend !== 'server.mjs' || frontend.entry !== 'ui/index.js' || frontend.style !== 'ui/style.css'
    || typeof frontend.order !== 'number' || !Number.isSafeInteger(frontend.order) || Math.abs(frontend.order) > 100000
    || typeof frontend.brandColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(frontend.brandColor)
    || typeof frontend.icon !== 'string' || !validId(frontend.icon)) {
    throw failure('INVALID_PLUGIN_MANIFEST', '插件入口必须是 server.mjs、ui/index.js 和 ui/style.css，且前端元数据必须有效。')
  }
  const integrity = value.integrity
  if (!isJsonObject(integrity) || !exactKeys(integrity, ENTRIES)
    || !ENTRIES.every(entry => typeof integrity[entry] === 'string' && /^[0-9a-f]{64}$/.test(integrity[entry]))) {
    throw failure('INVALID_PLUGIN_INTEGRITY', '插件必须为每个声明入口提供准确的 SHA-256 摘要。')
  }
  // Canonical field order also makes immutable-version comparisons independent of JSON formatting.
  return {
    schemaVersion: 1, id: value.id, name: value.name, description: value.description,
    version: value.version, kind: 'communication', apiVersion: 1, storageDirectory: value.storageDirectory,
    backend: value.backend,
    frontend: { entry: frontend.entry, style: frontend.style, order: frontend.order, brandColor: frontend.brandColor, icon: frontend.icon },
    integrity: Object.fromEntries(ENTRIES.map(entry => [entry, integrity[entry] as string])),
  }
}

async function statOrMissing(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) }
  catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error }
}

async function checkedDirectory(path: string): Promise<Stats> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw failure('UNSAFE_PLUGIN_PATH', '插件目录必须是普通目录，不能包含符号链接。')
  }
  return stat
}

async function homeDirectory(home: string, create: boolean): Promise<string | undefined> {
  if (typeof home !== 'string' || !home.trim() || home.includes('\0')) throw failure('UNSAFE_PLUGIN_PATH', 'EATING_HOME 路径无效。')
  const path = resolve(home)
  if (!await statOrMissing(path)) {
    if (!create) return undefined
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PLUGIN_PATH', 'EATING_HOME 必须是普通目录。')
  // The caller chooses home; canonicalize OS aliases such as macOS /var before managing children.
  return realpath(path)
}

async function childDirectory(parent: string, name: string, create: boolean): Promise<string | undefined> {
  await checkedDirectory(parent)
  const path = join(parent, name)
  let stat = await statOrMissing(path)
  if (!stat) {
    if (!create) return undefined
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
    stat = await lstat(path)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PLUGIN_PATH', '插件管理目录不能是文件或符号链接。')
  await checkedDirectory(path)
  return path
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  await checkedDirectory(dirname(path))
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw failure('UNSAFE_PLUGIN_PATH', '插件清单和入口必须是普通文件，不能是符号链接。')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw failure('UNSAFE_PLUGIN_PATH', '读取插件期间文件发生变化。')
    if (stat.size > maximum) throw failure('PLUGIN_PACKAGE_TOO_LARGE', '插件包不得超过 16 MiB，清单及索引也有独立大小限制。')
    const data = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size || (await handle.stat()).size !== stat.size) throw failure('PLUGIN_PACKAGE_CHANGED', '校验时插件文件发生变化，请重新构建后安装。')
    return data.subarray(0, length)
  } finally { await handle.close() }
}

function parseJson(data: Buffer, code: string): unknown {
  try { return JSON.parse(data.toString('utf8')) as unknown }
  catch { throw failure(code, '插件清单或安装索引不是有效 JSON。') }
}

async function checkPackageTree(directory: string): Promise<void> {
  await checkedDirectory(directory)
  for (const [parent, expected] of [[directory, [MANIFEST, 'server.mjs', 'ui']], [join(directory, 'ui'), ['index.js', 'style.css']]] as const) {
    await checkedDirectory(parent)
    const entries = await readdir(parent)
    if (entries.length !== expected.length || entries.some(entry => !(expected as readonly string[]).includes(entry))) {
      throw failure('UNDECLARED_PLUGIN_FILE', '插件包仅允许清单及三个已声明的独立构建入口，不允许额外文件。')
    }
    for (const entry of entries) {
      const stat = await lstat(join(parent, entry))
      if (stat.isSymbolicLink() || (entry === 'ui' ? !stat.isDirectory() : !stat.isFile())) throw failure('UNSAFE_PLUGIN_PATH', '插件包不允许符号链接或特殊文件。')
    }
  }
}

async function verifyPackage(directory: string, expected?: ActivePlugin): Promise<Snapshot> {
  await checkPackageTree(directory)
  const manifestBytes = await readBounded(join(directory, MANIFEST), MAX_MANIFEST_BYTES)
  let manifest: PluginPackageManifest
  try { manifest = parsePluginPackageManifest(parseJson(manifestBytes, 'INVALID_PLUGIN_MANIFEST')) }
  catch (error) {
    if (error instanceof PlatformError) throw error
    throw failure('INVALID_PLUGIN_MANIFEST', '插件清单无法安全解析。')
  }
  if (expected && (manifest.id !== expected.id || manifest.version !== expected.version)) throw failure('PLUGIN_IDENTITY_MISMATCH', '安装索引与插件清单身份或版本不一致。')
  let size = manifestBytes.length
  const files = new Map<string, Buffer>()
  for (const entry of ENTRIES) {
    const data = await readBounded(join(directory, entry), MAX_PACKAGE_BYTES - size)
    size += data.length
    if (createHash('sha256').update(data).digest('hex') !== manifest.integrity[entry]) throw failure('PLUGIN_INTEGRITY_MISMATCH', `插件入口 ${entry} 的 SHA-256 校验失败，禁止加载。`)
    files.set(entry, data)
  }
  await checkPackageTree(directory)
  return { manifest, files }
}

async function readIndex(plugins: string): Promise<ActivePlugin[]> {
  const path = join(plugins, 'installed.json')
  if (!await statOrMissing(path)) return []
  const value = parseJson(await readBounded(path, 256 * 1024), 'INVALID_PLUGIN_INDEX')
  if (!isJsonObject(value) || !exactKeys(value, ['schemaVersion', 'plugins']) || value.schemaVersion !== 1 || !Array.isArray(value.plugins) || value.plugins.length > 1000) {
    throw failure('INVALID_PLUGIN_INDEX', '插件安装索引格式或版本无效，禁止覆盖。')
  }
  const ids = new Set<string>()
  return value.plugins.map(entry => {
    if (!isJsonObject(entry) || !exactKeys(entry, ['id', 'version']) || !validId(entry.id) || !validVersion(entry.version) || ids.has(entry.id)) throw failure('INVALID_PLUGIN_INDEX', '插件安装索引含有无效或重复身份。')
    ids.add(entry.id)
    return { id: entry.id, version: entry.version }
  })
}

async function versionDirectory(plugins: string, plugin: ActivePlugin, create: boolean): Promise<string | undefined> {
  const root = await childDirectory(plugins, plugin.id, create)
  if (!root) return undefined
  const versions = await childDirectory(root, 'versions', create)
  if (create) await syncDirectory(root)
  return versions
}

/** Fully verifies all active packages before discovery is allowed to import any code. */
export async function loadInstalledPluginPackages(home: string): Promise<readonly InstalledPluginPackage[]> {
  const root = await homeDirectory(home, false)
  if (!root) return []
  const plugins = await childDirectory(root, 'plugins', false)
  if (!plugins) return []
  const result: InstalledPluginPackage[] = []
  for (const entry of await readIndex(plugins)) {
    const versions = await versionDirectory(plugins, entry, false)
    if (!versions) throw failure('MISSING_PLUGIN_PACKAGE', '索引指向的插件版本目录不存在。')
    const directory = join(versions, entry.version)
    if (!await statOrMissing(directory)) throw failure('MISSING_PLUGIN_PACKAGE', '索引指向的插件版本不存在。')
    const { manifest } = await verifyPackage(directory, entry)
    result.push({ manifest, directory })
  }
  return result
}

async function assertHostStopped(home: string): Promise<void> {
  const host = await childDirectory(home, 'host', false)
  if (!host || !await statOrMissing(join(host, 'host.lock'))) return
  const value = parseJson(await readBounded(join(host, 'host.lock'), 4096), 'WORKSPACE_LOCKED')
  if (!isJsonObject(value) || value.machine !== hostname() || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647) {
    throw failure('WORKSPACE_LOCKED', '无法确认 Host 已退出，请先检查运行锁。', 409)
  }
  try { process.kill(value.pid, 0) }
  catch (error) { if (hasCode(error, 'ESRCH')) return; throw failure('WORKSPACE_LOCKED', '无法确认 Host 已退出。', 409) }
  throw failure('WORKSPACE_LOCKED', '安装、升级或卸载插件前必须停止 Host，完成后重启。', 409)
}

async function ownedFile(path: string, parent: string): Promise<OwnedPath> {
  await checkedDirectory(parent)
  if (resolve(path) !== path || dirname(path) !== parent) throw failure('UNSAFE_PLUGIN_PATH', '临时路径不在本次事务目录内。')
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || await realpath(path) !== path) throw failure('UNSAFE_PLUGIN_PATH', '临时路径不安全。')
  return { path, parent, stat }
}

async function removeOwned(owned: OwnedPath): Promise<void> {
  await checkedDirectory(owned.parent)
  if (resolve(owned.path) !== owned.path || dirname(owned.path) !== owned.parent) throw failure('UNSAFE_PLUGIN_PATH', '拒绝清理未知路径。')
  const current = await statOrMissing(owned.path)
  if (!current) return
  if (current.isSymbolicLink() || current.dev !== owned.stat.dev || current.ino !== owned.stat.ino || await realpath(owned.path) !== owned.path) throw failure('UNSAFE_PLUGIN_PATH', '临时内容归属发生变化，拒绝清理。')
  if (current.isDirectory()) await rm(owned.path, { recursive: true })
  else await unlink(owned.path)
}

async function syncDirectory(path: string): Promise<void> {
  await checkedDirectory(path)
  try {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch (error) {
    // Windows does not expose directory fsync through Node; file fsync remains mandatory.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].some(code => hasCode(error, code))) throw error
  }
}

async function acquireIndexLock(plugins: string): Promise<() => Promise<void>> {
  const path = join(plugins, '.installation.lock')
  const deadline = Date.now() + 5000
  for (;;) {
    await checkedDirectory(plugins)
    let handle
    try { handle = await open(path, 'wx', 0o600) }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
    if (handle) {
      const owned = await ownedFile(path, plugins)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, machine: hostname(), lockId: randomUUID() }))
        await handle.sync()
      } catch (error) {
        await handle.close()
        await removeOwned(owned)
        throw error
      }
      await handle.close()
      return () => removeOwned(owned)
    }
    const stat = await statOrMissing(path)
    if (!stat) continue
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('PLUGIN_INSTALL_LOCKED', '插件安装事务锁不是普通文件，拒绝修改。', 409)
    // A process can be between exclusive creation and writing its lock record.
    if (stat.size === 0 && Date.now() < deadline) { await delay(25); continue }
    let value: unknown
    try { value = parseJson(await readBounded(path, 4096), 'PLUGIN_INSTALL_LOCKED') }
    catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error }
    if (!isJsonObject(value) || value.machine !== hostname() || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647 || typeof value.lockId !== 'string' || !value.lockId) {
      throw failure('PLUGIN_INSTALL_LOCKED', '无法确认插件安装事务锁归属，请核对后处理。', 409)
    }
    try { process.kill(value.pid, 0) }
    catch { throw failure('PLUGIN_INSTALL_LOCKED', '旧插件安装事务锁需人工核对，拒绝自动移除。', 409) }
    if (Date.now() >= deadline) throw failure('PLUGIN_INSTALL_LOCKED', '另一个插件安装事务仍在执行，请稍后重试。', 409)
    await delay(25)
  }
}

async function withIndexTransaction<T>(home: string, plugins: string, run: () => Promise<T>): Promise<T> {
  const releaseIndex = await acquireIndexLock(plugins)
  let releaseHost: (() => void) | undefined
  let succeeded = false
  try {
    await assertHostStopped(home)
    const host = (await childDirectory(home, 'host', true))!
    // Holding the same lock as Host closes the check/start race during activation.
    releaseHost = acquireWorkspaceLock(host)
    const result = await run()
    succeeded = true
    return result
  } finally {
    const cleanupErrors: unknown[] = []
    try { releaseHost?.() } catch (error) { cleanupErrors.push(error) }
    try { await releaseIndex() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) {
      if (succeeded) process.emitWarning('插件事务已完成，但运行锁清理失败；请检查锁文件后重启 Host。', { code: 'PLUGIN_LOCK_CLEANUP_FAILED' })
      else throw new AggregateError(cleanupErrors, '插件事务失败，且锁清理失败。')
    }
  }
}

async function writeIndex(plugins: string, entries: readonly ActivePlugin[], onCommit: () => void): Promise<void> {
  const path = join(plugins, `.installed-${randomUUID()}.tmp`)
  const handle = await open(path, 'wx', 0o600)
  const owned = await ownedFile(path, plugins)
  let committed = false
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, plugins: entries }, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    await syncDirectory(plugins)
    await rename(path, join(plugins, 'installed.json'))
    committed = true
    onCommit()
    try { await syncDirectory(plugins) }
    catch { throw new PlatformError('PLUGIN_INDEX_DURABILITY_UNKNOWN', '插件索引已激活，但目录同步失败；请检查存储后重启 Host，切勿删除已发布版本。', 500, 'unknown') }
  } finally {
    await handle.close()
    if (!committed) await removeOwned(owned)
  }
}

/** The caller must obtain explicit owner approval of this trusted local package source before calling. */
export async function installPluginPackage(home: string, sourceDirectory: string): Promise<InstalledPluginPackage> {
  const source = resolve(sourceDirectory)
  // Reject a symlink root; canonicalize only ancestors supplied by the caller (e.g. /var).
  const sourceStat = await lstat(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw failure('UNSAFE_PLUGIN_PATH', '插件来源必须是受信任的普通本地目录。')
  const snapshot = await verifyPackage(await realpath(source))
  const root = (await homeDirectory(home, true))!
  const plugins = (await childDirectory(root, 'plugins', true))!
  const stagePath = await mkdtemp(join(plugins, '.staging-'))
  let stage: OwnedPath | undefined = await ownedFile(stagePath, plugins)
  let published: OwnedPath | undefined
  let committed = false
  try {
    await mkdir(join(stagePath, 'ui'), { mode: 0o700 })
    const manifestData = Buffer.from(`${JSON.stringify(snapshot.manifest, null, 2)}\n`)
    for (const [entry, data] of [[MANIFEST, manifestData], ...snapshot.files] as [string, Buffer][]) {
      const handle = await open(join(stagePath, entry), 'wx', 0o600)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    }
    await verifyPackage(stagePath, snapshot.manifest)
    await syncDirectory(join(stagePath, 'ui'))
    await syncDirectory(stagePath)
    return await withIndexTransaction(root, plugins, async () => {
      try {
        const index = await readIndex(plugins)
        for (const active of index) {
          const activeVersions = await versionDirectory(plugins, active, false)
          if (!activeVersions || !await statOrMissing(join(activeVersions, active.version))) throw failure('MISSING_PLUGIN_PACKAGE', '索引指向的插件版本不存在，禁止修改安装状态。')
          const { manifest } = await verifyPackage(join(activeVersions, active.version), active)
          if (active.id === snapshot.manifest.id && manifest.storageDirectory !== snapshot.manifest.storageDirectory) {
            throw failure('PLUGIN_STORAGE_MIGRATION_REQUIRED', '升级插件不能更改数据目录；需要先完成单独授权的数据迁移。', 409)
          }
          if (active.id !== snapshot.manifest.id && manifest.storageDirectory === snapshot.manifest.storageDirectory) {
            throw failure('PLUGIN_STORAGE_CONFLICT', '插件数据目录已由另一个活动插件使用，请为本插件声明独立目录。', 409)
          }
        }
        const versions = (await versionDirectory(plugins, snapshot.manifest, true))!
        const directory = join(versions, snapshot.manifest.version)
        if (await statOrMissing(directory)) {
          const existing = await verifyPackage(directory, snapshot.manifest)
          if (JSON.stringify(existing.manifest) !== JSON.stringify(snapshot.manifest)) throw failure('PLUGIN_VERSION_IMMUTABLE', '同一插件版本的内容不可替换，请使用新版本号。', 409)
          await removeOwned(stage!)
          stage = undefined
        } else {
          await rename(stagePath, directory)
          published = { ...stage!, path: directory, parent: versions }
          stage = undefined
          await syncDirectory(versions)
        }
        if (!index.some(entry => entry.id === snapshot.manifest.id && entry.version === snapshot.manifest.version)) {
          const next = index.filter(entry => entry.id !== snapshot.manifest.id)
          next.push({ id: snapshot.manifest.id, version: snapshot.manifest.version })
          await writeIndex(plugins, next, () => { committed = true })
        } else committed = true
        return { manifest: snapshot.manifest, directory }
      } catch (error) {
        // Roll back before releasing the lock: another installer may reuse this version.
        if (published && !committed) {
          const owned = published
          published = undefined
          try { await removeOwned(owned) }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], '安装失败，且未激活版本清理失败。') }
        }
        throw error
      }
    })
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (const owned of [stage, committed ? undefined : published]) {
      if (owned) { try { await removeOwned(owned) } catch (cleanupError) { cleanupErrors.push(cleanupError) } }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], '插件安装失败，且本次临时内容清理失败。')
    throw error
  }
}

/** Removes activation only; package versions, bot configuration and Host history are retained. */
export async function uninstallPluginPackage(home: string, id: string): Promise<void> {
  if (!validId(id)) throw failure('INVALID_PLUGIN_ID', '插件 ID 无效。')
  const root = await homeDirectory(home, false)
  if (!root) return
  const plugins = await childDirectory(root, 'plugins', false)
  if (!plugins) return
  await withIndexTransaction(root, plugins, async () => {
    const index = await readIndex(plugins)
    const next = index.filter(entry => entry.id !== id)
    if (next.length !== index.length) await writeIndex(plugins, next, () => {})
  })
}
