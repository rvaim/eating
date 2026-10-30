import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageManifest } from '@eating/plugin-sdk'
import { acquireWorkspaceLock } from './lock'
import { installPreparedPluginPackage, loadInstalledPluginPackages, preparePluginPackage } from './plugin-installation'
import { PluginPackageActivationError, PluginPackageManager } from './plugin-manager'

let parent: string, temporary: string, home: string
let release: () => void
let manager: PluginPackageManager
const activate = vi.fn(async (_pkg: unknown) => {})
const deactivate = vi.fn(async (_id: string) => {})

beforeEach(async () => {
  vi.restoreAllMocks()
  activate.mockReset().mockResolvedValue(undefined)
  deactivate.mockReset().mockResolvedValue(undefined)
  parent = await realpath(tmpdir())
  temporary = await realpath(await mkdtemp(join(parent, 'eating-plugin-manager-test-')))
  home = join(temporary, 'home')
  await mkdir(home)
  release = acquireWorkspaceLock(join(home, 'host'))
  manager = new PluginPackageManager(home, { activate, deactivate })
})

afterEach(async () => {
  manager.close()
  release()
  vi.restoreAllMocks()
  const target = await realpath(temporary)
  if (target !== temporary || dirname(target) !== parent || !basename(target).startsWith('eating-plugin-manager-test-')) throw new Error('Unsafe manager fixture cleanup')
  await rm(target, { recursive: true })
})

async function makePackage(version = '1.0.0', id = 'image-reader', backend?: string) {
  const directory = join(temporary, `source-${randomUUID()}`)
  await mkdir(join(directory, 'ui'), { recursive: true })
  const files = {
    'server.mjs': backend ?? `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(temporary, 'executed.txt'))}, 'executed'); throw new Error('Installer must not execute code'); // ${version}`,
    'ui/index.js': `throw new Error('Preview must not execute UI'); // ${version}`,
    'ui/style.css': `/* ${version} */`,
  }
  const manifest: PluginPackageManifest = { schemaVersion: 1, id, version, apiVersion: 4, name: '图片能力', description: '本地已构建能力插件', kind: 'capability', storageDirectory: id,
    backend: 'server.mjs', frontend: { entry: 'ui/index.js', style: 'ui/style.css', order: 1, brandColor: '#3876b6', icon: 'image' }, assets: [],
    integrity: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')])) }
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value)
  await writeFile(join(directory, 'eating-plugin.json'), JSON.stringify(manifest))
  return { directory, manifest }
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

async function protectedData() {
  const file = join(home, 'capability', 'image-reader', 'owner.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'preserve owner configuration')
  return file
}

async function activeVersion() { return (await loadInstalledPluginPackages(home))[0]?.manifest.version }

async function noPackageCodeRan() {
  await expect(lstat(join(temporary, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('Host 插件管理器', () => {
  it('只预览当前可信产物，返回有界元数据且不执行代码或写安装索引', async () => {
    const source = await makePackage()
    const plan = await manager.preview(source.directory)
    expect(Object.keys(plan).sort()).toEqual(['digest', 'manifest', 'packageBytes', 'planId'])
    expect(plan.manifest).toEqual(source.manifest)
    expect(plan.planId).toMatch(/^[a-f0-9-]{36}$/)
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.packageBytes).toBeGreaterThan(0)
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    expect(activate).not.toHaveBeenCalled()
    expect(deactivate).not.toHaveBeenCalled()
    await noPackageCodeRan()
  })

  it('确认后安装预览字节，索引提交后才停止旧实例并交由 app 激活', async () => {
    const source = await makePackage()
    const original = await readFile(join(source.directory, 'server.mjs'))
    const plan = await manager.preview(source.directory)
    expect(Reflect.set(plan.manifest, 'version', '99.0.0')).toBe(false)
    await writeFile(join(source.directory, 'server.mjs'), 'source changed after preview')
    const events: string[] = []
    deactivate.mockImplementation(async id => { expect(await activeVersion()).toBe('1.0.0'); events.push('stop:' + id) })
    activate.mockImplementation(async pkg => {
      expect(await activeVersion()).toBe('1.0.0')
      expect(pkg).toMatchObject({ manifest: source.manifest })
      events.push('activate')
    })
    const installed = await manager.install(plan.planId)
    expect(events).toEqual(['stop:image-reader', 'activate'])
    expect(await readFile(join(installed.directory, 'server.mjs'))).toEqual(original)
    expect(await preparePluginPackage(installed.directory)).toMatchObject({ manifest: plan.manifest, digest: plan.digest, packageBytes: plan.packageBytes })
    await expect(manager.install(plan.planId)).rejects.toMatchObject({ code: 'PLUGIN_PLAN_NOT_FOUND' })
    await noPackageCodeRan()
  })

  it('最多保留两份计划，新预览逐出最旧计划并保留其余快照', async () => {
    const sources = await Promise.all(['1.0.0', '2.0.0', '3.0.0'].map(version => makePackage(version)))
    const plans = await Promise.all(sources.map(source => manager.preview(source.directory)))
    await expect(manager.install(plans[0]!.planId)).rejects.toMatchObject({ code: 'PLUGIN_PLAN_NOT_FOUND' })
    expect((await manager.install(plans[1]!.planId)).manifest.version).toBe('2.0.0')
    expect((await manager.install(plans[2]!.planId)).manifest.version).toBe('3.0.0')
    expect(await activeVersion()).toBe('3.0.0')
  })

  it('计划五分钟整即过期，不能执行回调或发布代码', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const source = await makePackage()
    const plan = await manager.preview(source.directory)
    now += 5 * 60 * 1000
    await expect(manager.install(plan.planId)).rejects.toMatchObject({ code: 'PLUGIN_PLAN_EXPIRED' })
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    expect(activate).not.toHaveBeenCalled()
    expect(deactivate).not.toHaveBeenCalled()
    await noPackageCodeRan()
  })

  it('同一计划的并发确认只执行一次激活，后续队列仍可使用', async () => {
    const plan = await manager.preview((await makePackage()).directory)
    const results = await Promise.allSettled([manager.install(plan.planId), manager.install(plan.planId)])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'PLUGIN_PLAN_NOT_FOUND' } })
    expect(activate).toHaveBeenCalledTimes(1)
    await manager.uninstall('image-reader')
    expect(await loadInstalledPluginPackages(home)).toEqual([])
  })

  it('拒绝未校验代码和已安装版本冲突时，不停止原运行实例', async () => {
    const first = await makePackage()
    await manager.install((await manager.preview(first.directory)).planId)
    activate.mockClear(); deactivate.mockClear()
    const changed = await makePackage('1.0.0', 'image-reader', 'export default { changed: true }')
    const plan = await manager.preview(changed.directory)
    await expect(manager.install(plan.planId)).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IMMUTABLE' })
    expect(await activeVersion()).toBe('1.0.0')
    expect(activate).not.toHaveBeenCalled()
    expect(deactivate).not.toHaveBeenCalled()
    await writeFile(join(changed.directory, 'server.mjs'), 'tampered after declared digest')
    await expect(manager.preview(changed.directory)).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' })
    expect(deactivate).not.toHaveBeenCalled()
    await noPackageCodeRan()
  })

  it('更新只在旧实例停止后激活新版本，保留旧版本和用户资料', async () => {
    const first = await makePackage()
    const old = await manager.install((await manager.preview(first.directory)).planId)
    const data = await protectedData()
    const events: string[] = []
    deactivate.mockImplementation(async () => { events.push('stop') })
    activate.mockImplementation(async () => { events.push('new') })
    const next = await makePackage('2.0.0')
    const current = await manager.install((await manager.preview(next.directory)).planId)
    expect(events).toEqual(['stop', 'new'])
    expect(current.manifest.version).toBe('2.0.0')
    expect((await lstat(old.directory)).isDirectory()).toBe(true)
    expect(await readFile(data, 'utf8')).toBe('preserve owner configuration')
  })

  it('新版本激活失败明确报告已提交状态，清理部分实例但不删除任何版本或数据', async () => {
    const first = await makePackage()
    const old = await installPreparedPluginPackage(home, await preparePluginPackage(first.directory), { hostOwnsWorkspace: true })
    const data = await protectedData()
    const cause = new Error('app rejects the new entry')
    activate.mockRejectedValue(cause)
    const next = await makePackage('2.0.0')
    const result = manager.install((await manager.preview(next.directory)).planId)
    await expect(result).rejects.toBeInstanceOf(PluginPackageActivationError)
    await expect(result).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', phase: 'activate', cause, cleanupFailed: false, installed: { manifest: { version: '2.0.0' } } })
    expect(await activeVersion()).toBe('2.0.0')
    expect(deactivate).toHaveBeenCalledTimes(2)
    expect((await lstat(old.directory)).isDirectory()).toBe(true)
    expect((await lstat(join(home, 'plugins/image-reader/versions/2.0.0'))).isDirectory()).toBe(true)
    expect(await readFile(data, 'utf8')).toBe('preserve owner configuration')
    await noPackageCodeRan()
  })

  it('停止旧实例失败时不激活新版，并如实保留已提交的新版索引', async () => {
    const source = await makePackage()
    deactivate.mockRejectedValue(new Error('old plugin did not stop'))
    await expect(manager.install((await manager.preview(source.directory)).planId)).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', phase: 'deactivate' })
    expect(activate).not.toHaveBeenCalled()
    expect(await activeVersion()).toBe('1.0.0')
  })

  it('激活失败后的部分实例清理也失败时，错误明确保留未确认清理状态', async () => {
    const source = await makePackage()
    const cause = new Error('activation failed')
    deactivate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup failed'))
    activate.mockRejectedValue(cause)
    await expect(manager.install((await manager.preview(source.directory)).planId)).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', cleanupFailed: true, cause: expect.any(AggregateError) })
    expect(await activeVersion()).toBe('1.0.0')
  })

  it('卸载先停止实例再撤索引，保留代码、数据和 Host 锁', async () => {
    const source = await makePackage()
    const installed = await manager.install((await manager.preview(source.directory)).planId)
    const data = await protectedData(), lock = await readFile(join(home, 'host/host.lock'))
    deactivate.mockImplementation(async () => { expect(await activeVersion()).toBe('1.0.0') })
    await manager.uninstall('image-reader')
    expect(await loadInstalledPluginPackages(home)).toEqual([])
    expect((await lstat(installed.directory)).isDirectory()).toBe(true)
    expect(await readFile(data, 'utf8')).toBe('preserve owner configuration')
    expect(await readFile(join(home, 'host/host.lock'))).toEqual(lock)
    expect((await readdir(join(home, 'plugins'))).filter(name => name.startsWith('.'))).toEqual([])
  })

  it('停止失败或 ID 无效时不撤销卸载索引', async () => {
    const source = await makePackage()
    await manager.install((await manager.preview(source.directory)).planId)
    const before = await readFile(join(home, 'plugins/installed.json'))
    deactivate.mockClear().mockRejectedValue(new Error('deactivate failed'))
    await expect(manager.uninstall('../outside')).rejects.toMatchObject({ code: 'INVALID_PLUGIN_ID' })
    expect(deactivate).not.toHaveBeenCalled()
    await expect(manager.uninstall('image-reader')).rejects.toMatchObject({ code: 'PLUGIN_DEACTIVATION_FAILED' })
    expect(await readFile(join(home, 'plugins/installed.json'))).toEqual(before)
  })

  it('关闭后释放计划并拒绝所有新操作', async () => {
    const source = await makePackage(), plan = await manager.preview(source.directory)
    manager.close()
    await expect(manager.install(plan.planId)).rejects.toMatchObject({ code: 'PLUGIN_MANAGER_CLOSED' })
    await expect(manager.preview(source.directory)).rejects.toMatchObject({ code: 'PLUGIN_MANAGER_CLOSED' })
    await expect(manager.uninstall('image-reader')).rejects.toMatchObject({ code: 'PLUGIN_MANAGER_CLOSED' })
    expect(activate).not.toHaveBeenCalled()
    expect(deactivate).not.toHaveBeenCalled()
  })

  it('停机期间迟到的旧实例停止回调不能再激活新版本', async () => {
    const entered = gate(), resume = gate()
    deactivate.mockImplementation(async () => { entered.resolve(); await resume.promise })
    const plan = await manager.preview((await makePackage()).directory)
    const installing = manager.install(plan.planId)
    await entered.promise
    manager.close(); resume.resolve()
    await expect(installing).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', cause: { code: 'PLUGIN_MANAGER_CLOSED' } })
    expect(activate).not.toHaveBeenCalled()
    expect(await activeVersion()).toBe('1.0.0')
  })

  it('关闭时迟到的激活结果必须清理，不能恢复已经撤销的实例', async () => {
    const entered = gate(), resume = gate()
    activate.mockImplementation(async () => { entered.resolve(); await resume.promise })
    const plan = await manager.preview((await makePackage()).directory)
    const installing = manager.install(plan.planId)
    await entered.promise
    manager.close(); resume.resolve()
    await expect(installing).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', cause: { code: 'PLUGIN_MANAGER_CLOSED' } })
    expect(deactivate).toHaveBeenCalledTimes(2)
    expect(await activeVersion()).toBe('1.0.0')
  })
})
