import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageManifest } from '@eating/plugin-sdk'
import { acquireWorkspaceLock } from './lock'
import { discoverBackendPlugins } from './discovery'
import { installPluginPackage, installPreparedPluginPackage, loadInstalledPluginPackages, parsePluginPackageManifest, preparePluginPackage, uninstallPluginPackage } from './plugin-installation'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const run = promisify(execFile)
let temporary: string
let temporaryParent: string
let home: string

beforeEach(async () => {
  vi.mocked(rename).mockImplementation(actualFs.rename)
  vi.mocked(open).mockImplementation(actualFs.open)
  temporaryParent = await realpath(tmpdir())
  temporary = await realpath(await mkdtemp(join(temporaryParent, 'eating-plugin-install-test-')))
  home = join(temporary, 'home')
  await mkdir(home)
})

afterEach(async () => {
  vi.mocked(rename).mockImplementation(actualFs.rename)
  vi.mocked(open).mockImplementation(actualFs.open)
  const target = await realpath(temporary)
  if (target !== temporary || dirname(target) !== temporaryParent || !basename(target).startsWith('eating-plugin-install-test-')) throw new Error('Refusing to remove an unknown test directory')
  await rm(target, { recursive: true })
})

async function removeTestPath(path: string): Promise<void> {
  if (resolve(path) !== path || !path.startsWith(`${temporary}/`) || !(await realpath(dirname(path))).startsWith(temporary)) throw new Error('Refusing to remove a path outside this test')
  if ((await lstat(path)).isSymbolicLink()) await unlink(path)
  else {
    if (await realpath(path) !== path) throw new Error('Refusing to remove an aliased test path')
    await rm(path, { recursive: true })
  }
}

async function makePackage(version = '0.2.0', id = 'qq', backend?: string): Promise<{ directory: string; manifest: PluginPackageManifest }> {
  const directory = join(temporary, `source-${randomUUID()}`)
  await mkdir(join(directory, 'ui'), { recursive: true })
  const files: Record<string, string> = {
    'server.mjs': backend ?? `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(temporary, 'executed.txt'))}, 'executed'); throw new Error('package code must not run'); // ${version}\n`,
    'ui/index.js': `throw new Error('frontend must not run during installation'); // ${version}\n`,
    'ui/style.css': `.plugin { color: #3876b6; } /* ${version} */\n`,
  }
  const manifest: PluginPackageManifest = {
    schemaVersion: 1, id, name: 'QQ', description: '独立构建插件测试', version, kind: 'communication', apiVersion: 4, assets: [],
    storageDirectory: id === 'qq' ? 'qq-bot' : `${id}-bot`, backend: 'server.mjs',
    frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 10, brandColor: '#3876b6', icon: 'message-circle' },
    integrity: Object.fromEntries(Object.entries(files).map(([entry, data]) => [entry, createHash('sha256').update(data).digest('hex')])),
  }
  for (const [entry, data] of Object.entries(files)) await writeFile(join(directory, entry), data)
  await writeFile(join(directory, 'eating-plugin.json'), JSON.stringify(manifest))
  return { directory, manifest }
}

async function readIndex(): Promise<unknown> {
  return JSON.parse(await readFile(join(home, 'plugins', 'installed.json'), 'utf8')) as unknown
}

async function expectCleanTransaction(): Promise<void> {
  expect((await readdir(join(home, 'plugins'))).filter(name => name.startsWith('.staging-') || name.startsWith('.installed-') || name === '.installation.lock')).toEqual([])
}

describe('independent plugin directory packages', () => {
  it('installs declared native client assets with hashes and rejects later tampering', async () => {
    const source = await makePackage('1.0.0')
    const asset = 'native-client/client.js', data = 'globalThis.fixtureNativeClient = true;'
    await mkdir(join(source.directory, 'native-client'))
    await writeFile(join(source.directory, asset), data)
    const manifest = { ...source.manifest, assets: [asset], integrity: { ...source.manifest.integrity, [asset]: createHash('sha256').update(data).digest('hex') } }
    await writeFile(join(source.directory, 'eating-plugin.json'), JSON.stringify(manifest))
    const installed = await installPluginPackage(home, source.directory)
    expect(await readFile(join(installed.directory, asset), 'utf8')).toBe(data)
    expect((await loadInstalledPluginPackages(home))[0]!.manifest.assets).toEqual([asset])
    await writeFile(join(installed.directory, asset), 'changed')
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    await expectCleanTransaction()
  })

  it.each([['../outside.js'], ['ui/index.js'], ['UI/index.js'], ['eating-plugin.json'], ['one/client.js', 'one/client.js'], ['one/client.js', 'one/CLIENT.js'], ['client.svg']].map(assets => ({ assets })))('rejects unsafe or duplicate asset declarations %j', async ({ assets }) => {
    const source = await makePackage('1.0.0')
    expect(() => parsePluginPackageManifest({ ...source.manifest, assets })).toThrow()
  })

  it('installs an independent Harness package using dsh storage with verified hashes', async () => {
    const source = await makePackage('1.0.0', 'dsh')
    const manifest = { ...source.manifest, kind: 'harness' as const, storageDirectory: 'dsh' }
    expect(parsePluginPackageManifest(manifest)).toEqual(manifest)
    await writeFile(join(source.directory, 'eating-plugin.json'), JSON.stringify(manifest))
    const installed = await installPluginPackage(home, source.directory)
    expect(installed.manifest).toEqual(manifest)
    expect(await loadInstalledPluginPackages(home)).toEqual([installed])
    await writeFile(join(installed.directory, 'server.mjs'), 'modified Harness backend')
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    await expect(lstat(join(temporary, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('discovers matching Harness entries and refuses missing or mismatched entry kinds', async () => {
    const backend = `export default { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create() { return { id: 'dsh', kind: 'harness', version: '1.0.0' } } }`
    const source = await makePackage('1.0.0', 'dsh', backend)
    await writeFile(join(source.directory, 'eating-plugin.json'), JSON.stringify({ ...source.manifest, kind: 'harness', storageDirectory: 'dsh' }))
    await installPluginPackage(home, source.directory)
    const [entry] = await discoverBackendPlugins(home)
    expect(entry?.kind).toBe('harness')
    expect(entry?.installed?.manifest.kind).toBe('harness')
    const mismatch = await makePackage('1.0.0', 'other', `export default { id: 'other', storageDirectory: 'other', create() {} }`)
    await writeFile(join(mismatch.directory, 'eating-plugin.json'), JSON.stringify({ ...mismatch.manifest, kind: 'harness', storageDirectory: 'other' }))
    await installPluginPackage(home, mismatch.directory)
    await expect(discoverBackendPlugins(home)).rejects.toMatchObject({ code: 'INVALID_PLUGIN_ENTRY' })
  })

  it('keeps kind-specific storage separate and refuses an implicit cross-kind upgrade', async () => {
    const communication = await makePackage()
    const old = await installPluginPackage(home, communication.directory)
    const harness = await makePackage('1.0.0', 'dsh')
    await writeFile(join(harness.directory, 'eating-plugin.json'), JSON.stringify({ ...harness.manifest, kind: 'harness', storageDirectory: 'qq-bot' }))
    const installed = await installPluginPackage(home, harness.directory)
    expect(await loadInstalledPluginPackages(home)).toEqual([old, installed])
    const upgrade = await makePackage('0.3.0')
    await writeFile(join(upgrade.directory, 'eating-plugin.json'), JSON.stringify({ ...upgrade.manifest, kind: 'harness' }))
    await expect(installPluginPackage(home, upgrade.directory)).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_MIGRATION_REQUIRED' })
    expect(await loadInstalledPluginPackages(home)).toEqual([old, installed])
    await expectCleanTransaction()
  })

  it('copies a complete independent package and discovers it after its source is deleted, without executing code', async () => {
    const source = await makePackage()
    const installed = await installPluginPackage(home, source.directory)
    expect(installed.directory).toBe(join(home, 'plugins', 'qq', 'versions', '0.2.0'))
    expect(installed.manifest).toEqual(source.manifest)
    await removeTestPath(source.directory)
    expect(await loadInstalledPluginPackages(home)).toEqual([installed])
    expect(await readIndex()).toEqual({ schemaVersion: 1, plugins: [{ id: 'qq', version: '0.2.0' }] })
    await expect(lstat(join(temporary, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('does not create a missing home when discovering or uninstalling', async () => {
    const missing = join(temporary, 'missing-home')
    expect(await loadInstalledPluginPackages(missing)).toEqual([])
    await uninstallPluginPackage(missing, 'qq')
    await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['server.mjs', 'ui/index.js', 'ui/style.css'])('refuses modified installed %s without executing any package code', async entry => {
    const source = await makePackage()
    const installed = await installPluginPackage(home, source.directory)
    await writeFile(join(installed.directory, entry), 'tampered')
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    await expect(lstat(join(temporary, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['server.mjs', 'ui/index.js', 'ui/style.css'])('rejects a source with the wrong digest for %s', async entry => {
    const source = await makePackage()
    await writeFile(join(source.directory, entry), 'tampered')
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
  })

  it('activates a new version and retains previous versions for an explicit rollback', async () => {
    const first = await makePackage()
    const second = await makePackage('0.3.0')
    const old = await installPluginPackage(home, first.directory)
    const current = await installPluginPackage(home, second.directory)
    expect(await loadInstalledPluginPackages(home)).toEqual([current])
    expect((await lstat(old.directory)).isDirectory()).toBe(true)
    expect(await installPluginPackage(home, first.directory)).toEqual(old)
    expect(await loadInstalledPluginPackages(home)).toEqual([old])
  })

  it('refuses another plugin using an active storage directory without changing the old index or configuration', async () => {
    const first = await makePackage()
    const installed = await installPluginPackage(home, first.directory)
    await mkdir(join(home, 'bot', 'qq-bot'), { recursive: true })
    const configuration = join(home, 'bot', 'qq-bot', 'accounts.json')
    await writeFile(configuration, 'original QQ accounts')
    const before = await readFile(join(home, 'plugins', 'installed.json'))
    const second = await makePackage('1.0.0', 'other')
    await writeFile(join(second.directory, 'eating-plugin.json'), JSON.stringify({ ...second.manifest, storageDirectory: 'qq-bot' }))
    await expect(installPluginPackage(home, second.directory)).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_CONFLICT', statusCode: 409 })
    expect(await readFile(join(home, 'plugins', 'installed.json'))).toEqual(before)
    expect(await readFile(configuration, 'utf8')).toBe('original QQ accounts')
    expect(await loadInstalledPluginPackages(home)).toEqual([installed])
    await expect(lstat(join(home, 'plugins', 'other'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('refuses an upgrade that changes active storage without changing the old index or configuration', async () => {
    const first = await makePackage()
    const installed = await installPluginPackage(home, first.directory)
    await mkdir(join(home, 'bot', 'qq-bot'), { recursive: true })
    const configuration = join(home, 'bot', 'qq-bot', 'accounts.json')
    await writeFile(configuration, 'original QQ accounts')
    const before = await readFile(join(home, 'plugins', 'installed.json'))
    const second = await makePackage('0.3.0')
    await writeFile(join(second.directory, 'eating-plugin.json'), JSON.stringify({ ...second.manifest, storageDirectory: 'other-bot' }))
    await expect(installPluginPackage(home, second.directory)).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_MIGRATION_REQUIRED', statusCode: 409 })
    expect(await readFile(join(home, 'plugins', 'installed.json'))).toEqual(before)
    expect(await readFile(configuration, 'utf8')).toBe('original QQ accounts')
    expect(await loadInstalledPluginPackages(home)).toEqual([installed])
    await expect(lstat(join(home, 'plugins', 'qq', 'versions', '0.3.0'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(home, 'bot', 'other-bot'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('allows two plugin IDs with distinct active data directories to coexist', async () => {
    const first = await makePackage()
    const second = await makePackage('1.0.0', 'other')
    const firstInstalled = await installPluginPackage(home, first.directory)
    const secondInstalled = await installPluginPackage(home, second.directory)
    expect(await loadInstalledPluginPackages(home)).toEqual([firstInstalled, secondInstalled])
    expect(firstInstalled.manifest.storageDirectory).toBe('qq-bot')
    expect(secondInstalled.manifest.storageDirectory).toBe('other-bot')
    await expectCleanTransaction()
  })

  it('verifies existing active packages before accepting storage bindings or publishing another plugin', async () => {
    const first = await makePackage()
    const installed = await installPluginPackage(home, first.directory)
    const before = await readFile(join(home, 'plugins', 'installed.json'))
    await writeFile(join(installed.directory, 'server.mjs'), 'modified active backend')
    const second = await makePackage('1.0.0', 'other')
    await expect(installPluginPackage(home, second.directory)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    expect(await readFile(join(home, 'plugins', 'installed.json'))).toEqual(before)
    await expect(lstat(join(home, 'plugins', 'other'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('makes identical same-version installation a no-op but refuses different bytes or metadata', async () => {
    const first = await makePackage()
    const installed = await installPluginPackage(home, first.directory)
    const indexBefore = await readFile(join(home, 'plugins', 'installed.json'))
    const modifiedAt = (await lstat(join(home, 'plugins', 'installed.json'))).mtimeMs
    const same = await makePackage()
    expect(await installPluginPackage(home, same.directory)).toEqual(installed)
    expect((await lstat(join(home, 'plugins', 'installed.json'))).mtimeMs).toBe(modifiedAt)
    const replacement = await makePackage('0.2.0', 'qq', 'export default {}')
    await expect(installPluginPackage(home, replacement.directory)).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IMMUTABLE' })
    await writeFile(join(same.directory, 'eating-plugin.json'), JSON.stringify({ ...same.manifest, name: 'Changed' }))
    await expect(installPluginPackage(home, same.directory)).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IMMUTABLE' })
    expect(await readFile(join(home, 'plugins', 'installed.json'))).toEqual(indexBefore)
    expect(await loadInstalledPluginPackages(home)).toEqual([installed])
    await expectCleanTransaction()
  })

  it('keeps the old index byte-for-byte and cleans its unpublished version if atomic index replacement fails', async () => {
    const first = await makePackage()
    const old = await installPluginPackage(home, first.directory)
    const second = await makePackage('0.3.0')
    const before = await readFile(join(home, 'plugins', 'installed.json'))
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === join(home, 'plugins', 'installed.json')) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
      return actualFs.rename(from, to)
    })
    await expect(installPluginPackage(home, second.directory)).rejects.toThrow('simulated disk failure')
    expect(await readFile(join(home, 'plugins', 'installed.json'))).toEqual(before)
    expect(await loadInstalledPluginPackages(home)).toEqual([old])
    await expect(lstat(join(home, 'plugins', 'qq', 'versions', '0.3.0'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('keeps the old activation if syncing the new index fails before rename', async () => {
    const first = await makePackage()
    const old = await installPluginPackage(home, first.directory)
    const second = await makePackage('0.3.0')
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode)
      if (typeof path === 'string' && basename(path).startsWith('.installed-')) handle.sync = async () => { throw new Error('index fsync failed') }
      return handle
    })
    await expect(installPluginPackage(home, second.directory)).rejects.toThrow('index fsync failed')
    expect(await loadInstalledPluginPackages(home)).toEqual([old])
    await expect(lstat(join(home, 'plugins', 'qq', 'versions', '0.3.0'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('preserves a published version and explicitly reports unknown durability after a post-commit directory sync failure', async () => {
    const source = await makePackage()
    let published = false
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actualFs.rename(from, to)
      if (to === join(home, 'plugins', 'installed.json')) published = true
    })
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode)
      if (path === join(home, 'plugins') && flags === 'r' && published) handle.sync = async () => { throw new Error('directory fsync failed') }
      return handle
    })
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'PLUGIN_INDEX_DURABILITY_UNKNOWN', outcome: 'unknown' })
    expect((await loadInstalledPluginPackages(home))[0]?.manifest.version).toBe('0.2.0')
    await expectCleanTransaction()
  })

  it('verifies copied staging files again before activation', async () => {
    const source = await makePackage()
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode)
      if (typeof path === 'string' && path.includes('/.staging-') && path.endsWith('/ui/style.css') && flags === 'wx') {
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          await actualFs.writeFile(join(dirname(path), 'index.js'), 'staging corrupted after copy')
        }
      }
      return handle
    })
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    await expectCleanTransaction()
  })

  it('uninstalls activation only, preserving bot configuration, Host state and version packages', async () => {
    const source = await makePackage()
    const installed = await installPluginPackage(home, source.directory)
    await mkdir(join(home, 'bot', 'qq-bot'), { recursive: true })
    await writeFile(join(home, 'bot', 'qq-bot', 'accounts.json'), 'preserve bot data')
    await writeFile(join(home, 'host', 'Eating.sqlite'), 'preserve Host state')
    await uninstallPluginPackage(home, 'qq')
    await uninstallPluginPackage(home, 'qq')
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    expect(await readFile(join(home, 'bot', 'qq-bot', 'accounts.json'), 'utf8')).toBe('preserve bot data')
    expect(await readFile(join(home, 'host', 'Eating.sqlite'), 'utf8')).toBe('preserve Host state')
    expect((await lstat(installed.directory)).isDirectory()).toBe(true)
    await expectCleanTransaction()
  })

  it('serializes simultaneous installations without losing another plugin from the index', async () => {
    const first = await makePackage()
    const second = await makePackage('1.0.0', 'other')
    await Promise.all([installPluginPackage(home, first.directory), installPluginPackage(home, second.directory)])
    expect((await loadInstalledPluginPackages(home)).map(entry => entry.manifest.id).sort()).toEqual(['other', 'qq'])
    await expectCleanTransaction()
  })

  it('serializes separate Node processes that install into the same global index', async () => {
    const first = await makePackage()
    const second = await makePackage('1.0.0', 'other')
    const module = pathToFileURL(fileURLToPath(new URL('./plugin-installation.ts', import.meta.url))).href
    const script = `import { installPluginPackage } from ${JSON.stringify(module)}; await installPluginPackage(process.argv[1], process.argv[2]);`
    await Promise.all([first, second].map(source => run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, home, source.directory], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 10000 })))
    expect((await loadInstalledPluginPackages(home)).map(entry => entry.manifest.id).sort()).toEqual(['other', 'qq'])
    await expectCleanTransaction()
  }, 15000)

  it('rejects installation and uninstallation while Host owns the workspace lock', async () => {
    const first = await makePackage()
    const old = await installPluginPackage(home, first.directory)
    const second = await makePackage('0.3.0')
    const release = acquireWorkspaceLock(join(home, 'host'))
    try {
      await expect(installPluginPackage(home, second.directory)).rejects.toMatchObject({ code: 'WORKSPACE_LOCKED' })
      await expect(uninstallPluginPackage(home, 'qq')).rejects.toMatchObject({ code: 'WORKSPACE_LOCKED' })
    } finally { release() }
    expect(await loadInstalledPluginPackages(home)).toEqual([old])
    await expectCleanTransaction()
  })

  it.each(['not-json', JSON.stringify({ pid: process.pid, machine: 'another-device' }), JSON.stringify({ pid: -1, machine: hostname() })])('rejects an unknown Host lock: %s', async contents => {
    const source = await makePackage()
    await mkdir(join(home, 'host'))
    await writeFile(join(home, 'host', 'host.lock'), contents)
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'WORKSPACE_LOCKED' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    expect(await readFile(join(home, 'host', 'host.lock'), 'utf8')).toBe(contents)
    await expectCleanTransaction()
  })

  it('retries if another transaction releases its lock between inspection and reading', async () => {
    const source = await makePackage()
    const plugins = join(home, 'plugins')
    const lock = join(plugins, '.installation.lock')
    await mkdir(plugins)
    await writeFile(lock, JSON.stringify({ pid: process.pid, machine: hostname(), lockId: randomUUID() }))
    let released = false
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (path === lock && typeof flags === 'number' && !released) {
        released = true
        await removeTestPath(lock)
        throw Object.assign(new Error('lock was released'), { code: 'ENOENT' })
      }
      return actualFs.open(path, flags, mode)
    })
    await installPluginPackage(home, source.directory)
    expect(released).toBe(true)
    expect((await loadInstalledPluginPackages(home))[0]?.manifest.id).toBe('qq')
    await expectCleanTransaction()
  })

  it('rejects an unknown installation lock without deleting it', async () => {
    const source = await makePackage()
    await mkdir(join(home, 'plugins'))
    await writeFile(join(home, 'plugins', '.installation.lock'), '{"pid":1}')
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_LOCKED' })
    expect(await readFile(join(home, 'plugins', '.installation.lock'), 'utf8')).toBe('{"pid":1}')
    expect((await readdir(join(home, 'plugins'))).filter(name => name.startsWith('.staging-'))).toEqual([])
  })
})

describe('封存预览与 Host 内插件安装事务', () => {
  it('预览不执行代码，源目录修改或删除后仍安装确认的同份快照', async () => {
    const source = await makePackage()
    const original = await readFile(join(source.directory, 'server.mjs'))
    const prepared = await preparePluginPackage(source.directory)
    expect(Object.keys(prepared).sort()).toEqual(['digest', 'manifest', 'packageBytes'])
    expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.packageBytes).toBeGreaterThan(original.length)
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    await writeFile(join(source.directory, 'server.mjs'), 'changed after owner preview')
    await removeTestPath(source.directory)
    const installed = await installPreparedPluginPackage(home, prepared)
    expect(await readFile(join(installed.directory, 'server.mjs'))).toEqual(original)
    expect(await preparePluginPackage(installed.directory)).toEqual(prepared)
    const bytes = await Promise.all(['eating-plugin.json', 'server.mjs', 'ui/index.js', 'ui/style.css'].map(entry => lstat(join(installed.directory, entry))))
    expect(bytes.reduce((total, stat) => total + stat.size, 0)).toBe(prepared.packageBytes)
    await expect(lstat(join(temporary, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectCleanTransaction()
  })

  it('公开预览元数据被冻结，复制或伪造的 JSON 不能替代内部快照', async () => {
    const source = await makePackage()
    const prepared = await preparePluginPackage(source.directory)
    for (const item of [prepared, prepared.manifest, prepared.manifest.frontend, prepared.manifest.assets, prepared.manifest.integrity]) expect(Object.isFrozen(item)).toBe(true)
    expect(Reflect.set(prepared.manifest, 'version', '99.0.0')).toBe(false)
    expect(Reflect.set(prepared.manifest.integrity, 'server.mjs', '0'.repeat(64))).toBe(false)
    await expect(installPreparedPluginPackage(home, { ...prepared })).rejects.toMatchObject({ code: 'INVALID_PREPARED_PLUGIN_PACKAGE' })
    await expect(installPreparedPluginPackage(home, JSON.parse(JSON.stringify(prepared)))).rejects.toMatchObject({ code: 'INVALID_PREPARED_PLUGIN_PACKAGE' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    expect((await installPreparedPluginPackage(home, prepared)).manifest.version).toBe('0.2.0')
  })

  it('API4 capability 仍要求完整前端与哈希，并拒绝同类存储冲突和跨 kind 更新', async () => {
    const source = await makePackage('1.0.0', 'images')
    const manifest = { ...source.manifest, kind: 'capability' as const, storageDirectory: 'image-reader' }
    expect(() => parsePluginPackageManifest({ ...manifest, frontend: undefined })).toThrow()
    await writeFile(join(source.directory, 'eating-plugin.json'), JSON.stringify(manifest))
    const installed = await installPluginPackage(home, source.directory)
    expect(installed.manifest).toEqual(manifest)
    const other = await makePackage('1.0.0', 'other-images')
    await writeFile(join(other.directory, 'eating-plugin.json'), JSON.stringify({ ...other.manifest, kind: 'capability', storageDirectory: 'image-reader' }))
    await expect(installPluginPackage(home, other.directory)).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_CONFLICT' })
    const changed = await makePackage('2.0.0', 'images')
    await writeFile(join(changed.directory, 'eating-plugin.json'), JSON.stringify({ ...changed.manifest, kind: 'harness', storageDirectory: 'image-reader' }))
    await expect(installPluginPackage(home, changed.directory)).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_MIGRATION_REQUIRED' })
    expect(await loadInstalledPluginPackages(home)).toEqual([installed])
    await expectCleanTransaction()
  })

  it('Host 显式持锁时安装和卸载仍保留同一工作区锁及用户数据', async () => {
    const source = await makePackage()
    const prepared = await preparePluginPackage(source.directory)
    const release = acquireWorkspaceLock(join(home, 'host'))
    try {
      const lock = await readFile(join(home, 'host', 'host.lock'))
      await writeFile(join(home, 'host', 'owner-state.json'), 'owner state')
      await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'WORKSPACE_LOCKED' })
      const installed = await installPreparedPluginPackage(home, prepared, { hostOwnsWorkspace: true })
      expect(await loadInstalledPluginPackages(home)).toEqual([installed])
      expect(await readFile(join(home, 'host', 'host.lock'))).toEqual(lock)
      await expect(uninstallPluginPackage(home, 'qq')).rejects.toMatchObject({ code: 'WORKSPACE_LOCKED' })
      await uninstallPluginPackage(home, 'qq', { hostOwnsWorkspace: true })
      expect(await loadInstalledPluginPackages(home)).toEqual([])
      expect(await readFile(join(home, 'host', 'host.lock'))).toEqual(lock)
      expect(await readFile(join(home, 'host', 'owner-state.json'), 'utf8')).toBe('owner state')
      expect((await lstat(installed.directory)).isDirectory()).toBe(true)
    } finally { release() }
    await expectCleanTransaction()
  })

  it('Host 内并发安装仍由独立索引锁串行，不丢另一插件', async () => {
    const first = await preparePluginPackage((await makePackage()).directory)
    const second = await preparePluginPackage((await makePackage('1.0.0', 'other')).directory)
    const release = acquireWorkspaceLock(join(home, 'host'))
    try {
      const lock = await readFile(join(home, 'host', 'host.lock'))
      await Promise.all([first, second].map(prepared => installPreparedPluginPackage(home, prepared, { hostOwnsWorkspace: true })))
      expect((await loadInstalledPluginPackages(home)).map(entry => entry.manifest.id).sort()).toEqual(['other', 'qq'])
      expect(await readFile(join(home, 'host', 'host.lock'))).toEqual(lock)
    } finally { release() }
    await expectCleanTransaction()
  })

  it.each(['missing', 'foreign', 'malformed'] as const)('hostOwnsWorkspace 不能伪造未持有的 %s Host 锁', async state => {
    const prepared = await preparePluginPackage((await makePackage()).directory)
    if (state !== 'missing') {
      await mkdir(join(home, 'host'))
      await writeFile(join(home, 'host', 'host.lock'), JSON.stringify(state === 'foreign'
        ? { pid: process.pid + 1, machine: hostname(), lockId: randomUUID() }
        : { pid: process.pid, machine: hostname() }))
    }
    await expect(installPreparedPluginPackage(home, prepared, { hostOwnsWorkspace: true })).rejects.toMatchObject({ code: 'WORKSPACE_LOCK_NOT_OWNED' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    await expectCleanTransaction()
  })
})

describe('plugin package trust boundaries', () => {
  it.each(['../server.mjs', '/server.mjs', 'C:/server.mjs', 'ui\\index.js', 'ui/../server.mjs', './server.mjs', 'server.mjs?query', 'server.mjs#hash', 'ui//index.js', 'ui/%2e%2e/server.mjs'])('rejects malformed relative entries: %s', async path => {
    const source = await makePackage()
    expect(() => parsePluginPackageManifest({ ...source.manifest, backend: path })).toThrow()
    expect(() => parsePluginPackageManifest({ ...source.manifest, frontend: { ...source.manifest.frontend, entry: path } })).toThrow()
    expect(() => parsePluginPackageManifest({ ...source.manifest, frontend: { ...source.manifest.frontend, style: path } })).toThrow()
  })

  it.each([
    { schemaVersion: 2 }, { apiVersion: 1 }, { apiVersion: 2 }, { apiVersion: 3 }, { apiVersion: 5 }, { kind: 'unknown' }, { id: '../escape' }, { id: 'con' },
    { version: '../escape' }, { version: '01.2.0' }, { version: '1.0.0-01' }, { storageDirectory: '../bot' }, { storageDirectory: 'foo' },
    { name: '' }, { description: 42 }, { backend: 'other.mjs' }, { unknown: true }, { integrity: {} },
    { frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 0, brandColor: 'javascript:evil', icon: 'message-circle' } },
  ])('rejects malformed or incompatible complete manifests: %j', async patch => {
    const source = await makePackage()
    await writeFile(join(source.directory, 'eating-plugin.json'), JSON.stringify({ ...source.manifest, ...patch }))
    await expect(installPluginPackage(home, source.directory)).rejects.toThrow()
    expect(await loadInstalledPluginPackages(home)).toEqual([])
  })

  it('rejects an oversized package before copying it', async () => {
    const source = await makePackage('1.0.0', 'qq', 'x'.repeat(16 * 1024 * 1024))
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_TOO_LARGE' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
  })

  it('rejects undeclared executable files instead of copying them', async () => {
    const source = await makePackage()
    await writeFile(join(source.directory, 'extra.mjs'), 'throw new Error("must not run")')
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'UNDECLARED_PLUGIN_FILE' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
  })

  it.each(['server.mjs', 'eating-plugin.json', 'ui'])('rejects package file or directory symlinks: %s', async entry => {
    const source = await makePackage()
    const path = join(source.directory, entry)
    const target = join(temporary, `target-${basename(entry)}`)
    await actualFs.rename(path, target)
    await symlink(target, path, entry === 'ui' ? 'dir' : 'file')
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_PATH' })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
  })

  it('rejects a symlink source root', async () => {
    const source = await makePackage()
    const alias = join(temporary, 'source-alias')
    await symlink(source.directory, alias, 'dir')
    await expect(installPluginPackage(home, alias)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_PATH' })
  })

  it('rejects managed directory symlinks and never follows them during cleanup', async () => {
    const source = await makePackage()
    const outside = join(temporary, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'keep')
    await symlink(outside, join(home, 'plugins'), 'dir')
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_PATH' })
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_PATH' })
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep')
  })

  it('rejects an installed version symlink', async () => {
    const source = await makePackage()
    const installed = await installPluginPackage(home, source.directory)
    const target = join(temporary, 'version-moved')
    await actualFs.rename(installed.directory, target)
    await symlink(target, installed.directory, 'dir')
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_PATH' })
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_PATH' })
    expect((await lstat(target)).isDirectory()).toBe(true)
    await expectCleanTransaction()
  })

  it('refuses incompatible or identity-mismatched installed metadata', async () => {
    const source = await makePackage()
    const installed = await installPluginPackage(home, source.directory)
    await writeFile(join(installed.directory, 'eating-plugin.json'), JSON.stringify({ ...source.manifest, apiVersion: 1 }))
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'INCOMPATIBLE_PLUGIN_API' })
    await writeFile(join(installed.directory, 'eating-plugin.json'), JSON.stringify({ ...source.manifest, id: 'other' }))
    await expect(loadInstalledPluginPackages(home)).rejects.toMatchObject({ code: 'PLUGIN_IDENTITY_MISMATCH' })
  })

  it('does not overwrite a damaged index during installation or uninstall', async () => {
    const source = await makePackage()
    await mkdir(join(home, 'plugins'))
    await writeFile(join(home, 'plugins', 'installed.json'), '{broken')
    await expect(installPluginPackage(home, source.directory)).rejects.toMatchObject({ code: 'INVALID_PLUGIN_INDEX' })
    await expect(uninstallPluginPackage(home, 'qq')).rejects.toMatchObject({ code: 'INVALID_PLUGIN_INDEX' })
    expect(await readFile(join(home, 'plugins', 'installed.json'), 'utf8')).toBe('{broken')
    await expectCleanTransaction()
  })
})
