import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises'
import { renameSync, unlinkSync, fsyncSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE_LIMITS } from '@eating/plugin-sdk'
import { createImageFixturePng } from '../../../../../tests/fixtures/image'
import { ImageGenerationPlugin } from '../server'
import { ImageGenerationStore } from './store'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync), fsyncSync: vi.fn(actual.fsyncSync) }
})
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const roots: string[] = []
afterEach(async () => {
  vi.mocked(renameSync).mockImplementation(actualFs.renameSync); vi.mocked(unlinkSync).mockImplementation(actualFs.unlinkSync); vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync)
  for (const root of roots.splice(0)) { expect(dirname(root)).toBe(await realpath(tmpdir())); expect(basename(root)).toMatch(/^eating-image-delete-/); await rm(root, { recursive: true }) }
})
async function seed() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eating-image-delete-'))); roots.push(root)
  const store = new ImageGenerationStore(root)
  const add = (n: number, source?: string) => {
    const bytes = createImageFixturePng([n, 165, 94, 255]), assetId = createHash('sha256').update(bytes).digest('hex')
    const job = store.enqueue(`delete-test-job-${n}`, String(n).padStart(64, '0'), `图片 ${n}`, 'fixture-model', source ? { kind: 'asset', assetId: source, hash: source, bytes, mimeType: 'image/png' } : undefined)
    store.complete(job.jobId, { bytes, mimeType: 'image/png' }, () => {})
    return { job, bytes, assetId }
  }
  return { root, store, add }
}
describe('owner image deletion', () => {
  it('deletes a batch including shared outputs, retains idempotent jobs and edit provenance, and reloads safely', async () => {
    const f = await seed(), first = f.add(1), second = f.add(2, first.assetId), third = f.add(3)
    const duplicate = f.store.enqueue('same-output-job', 'a'.repeat(64), 'duplicate image', 'fixture-model')
    f.store.complete(duplicate.jobId, { bytes: first.bytes, mimeType: 'image/png' }, () => {})
    const lease = f.store.getAsset(first.assetId), revision = f.store.images({}).revision
    expect(f.store.images({ query: '图片 2' }).items.map(item => item.assetId)).toEqual([second.assetId])
    expect(f.store.images({ query: 'FIXTURE-MODEL' }).total).toBe(3)
    expect(f.store.remove({ assetIds: [first.assetId, third.assetId], expectedRevision: revision, confirmed: true })).toEqual({ revision: revision + 1, deletedAssetIds: [first.assetId, third.assetId], deletedBytes: first.bytes.length + third.bytes.length })
    expect(await readdir(join(f.root, 'blobs'))).toEqual([second.assetId])
    await expect(lease.readBytes()).rejects.toMatchObject({ code: 'IMAGE_GENERATION_IMAGE_NOT_FOUND' })
    const reopened = new ImageGenerationStore(f.root)
    expect(reopened.job(first.job.jobId)).toMatchObject({ status: 'succeeded', assetIds: [] })
    expect(reopened.job(duplicate.jobId)).toMatchObject({ status: 'succeeded', assetIds: [] })
    expect(reopened.job(second.job.jobId).source).toMatchObject({ assetId: first.assetId })
    expect(reopened.existing(first.job.requestId, '1'.padStart(64, '0'))).toMatchObject({ jobId: first.job.jobId, assetIds: [] })
    expect(reopened.get(second.assetId).image.data).toBe(second.bytes.toString('base64'))
  })

  it('rejects missing confirmation, duplicates, stale lists, absent IDs and running jobs without deleting any bytes', async () => {
    const f = await seed(), first = f.add(1), revision = f.store.images({}).revision
    const input = { assetIds: [first.assetId], expectedRevision: revision, confirmed: true }
    for (const invalid of [{ ...input, confirmed: false }, { ...input, assetIds: [] }, { ...input, assetIds: [first.assetId, first.assetId] }, { ...input, assetIds: [first.assetId, 'f'.repeat(64)] }, { ...input, expectedRevision: revision - 1 }, { ...input, assetIds: ['../outside'] }]) {
      expect(() => f.store.remove(invalid)).toThrow()
      expect(f.store.images({}).revision).toBe(revision)
      expect(await readFile(join(f.root, 'blobs', first.assetId))).toEqual(first.bytes)
    }
    f.store.enqueue('active-job-00001', 'b'.repeat(64), 'active', 'fixture')
    expect(() => f.store.remove({ ...input, expectedRevision: f.store.images({}).revision })).toThrow('任务仍在执行')
    expect(f.store.images({}).total).toBe(1)
  })

  it('preserves every image if the index never committed and abandons the uncommitted deletion after restart', async () => {
    const f = await seed(), first = f.add(1), before = await readFile(join(f.root, 'state.json'))
    vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === join(f.root, 'state.json')) throw Error('fixture write failure'); actualFs.renameSync(from, to) })
    expect(() => f.store.remove({ assetIds: [first.assetId], expectedRevision: f.store.images({}).revision, confirmed: true })).toThrow()
    expect(await readFile(join(f.root, 'state.json'))).toEqual(before)
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync)
    expect(new ImageGenerationStore(f.root).get(first.assetId).image.data).toBe(first.bytes.toString('base64'))
    expect(await readdir(f.root)).not.toContain('image-deletion.json')
  })

  it('finishes only the committed deletion after a partial unlink failure and keeps all unselected images', async () => {
    const f = await seed(), first = f.add(1), second = f.add(2), third = f.add(3)
    vi.mocked(unlinkSync).mockImplementation(path => { if (String(path) === join(f.root, 'blobs', second.assetId)) throw Error('fixture unlink failure'); actualFs.unlinkSync(path) })
    expect(() => f.store.remove({ assetIds: [first.assetId, second.assetId], expectedRevision: f.store.images({}).revision, confirmed: true })).toThrow('文件清理未完成')
    expect(f.store.images({}).items.map(item => item.assetId)).toEqual([third.assetId])
    vi.mocked(unlinkSync).mockImplementation(actualFs.unlinkSync)
    const reopened = new ImageGenerationStore(f.root)
    expect(reopened.images({}).total).toBe(1)
    expect(await readdir(join(f.root, 'blobs'))).toEqual([third.assetId])
    expect(await readdir(f.root)).not.toContain('image-deletion.json')
  })

  it('recovers an index committed before directory fsync failed without resurrecting deleted resources', async () => {
    const f = await seed(), first = f.add(1)
    let renamed = false, failOnce = true
    vi.mocked(renameSync).mockImplementation((from, to) => { actualFs.renameSync(from, to); if (String(to) === join(f.root, 'state.json')) renamed = true })
    vi.mocked(fsyncSync).mockImplementation(fd => { if (renamed && failOnce) { failOnce = false; throw Error('fixture fsync failed') }; actualFs.fsyncSync(fd) })
    expect(() => f.store.remove({ assetIds: [first.assetId], expectedRevision: f.store.images({}).revision, confirmed: true })).toThrow()
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync); vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync)
    const reopened = new ImageGenerationStore(f.root)
    expect(reopened.images({}).total).toBe(0); expect(reopened.job(first.job.jobId).assetIds).toEqual([])
    expect(await readdir(join(f.root, 'blobs'))).toEqual([])
  })

  it('preserves original data on external index changes and refuses a symlink before committing deletion', async () => {
    const f = await seed(), first = f.add(1), revision = f.store.images({}).revision
    const path = join(f.root, 'state.json'), before = await readFile(path)
    await writeFile(path, Buffer.concat([before, Buffer.from('\n')]))
    expect(() => f.store.remove({ assetIds: [first.assetId], expectedRevision: revision, confirmed: true })).toThrow('索引已变化')
    await writeFile(path, before)
    const external = join(f.root, 'unrelated.png'); await writeFile(external, first.bytes)
    await unlink(join(f.root, 'blobs', first.assetId)); await symlink(external, join(f.root, 'blobs', first.assetId))
    expect(() => f.store.remove({ assetIds: [first.assetId], expectedRevision: revision, confirmed: true })).toThrow()
    expect(await readFile(external)).toEqual(first.bytes); expect(await readFile(path)).toEqual(before)
  })

  it('exposes deletion only through the owner manager, independent of provider configuration', async () => {
    const f = await seed(), first = f.add(1)
    const plugin = new ImageGenerationPlugin({ dataDirectory: f.root, imageLimits: () => DEFAULT_IMAGE_LIMITS, getSetting: () => null, setSetting: () => {}, listMessages: () => [], recordEvent: () => ({ inserted: false, eventId: 'unused' }), executeIdempotent: async () => { throw Error('No generation or send expected') } })
    try {
      expect(plugin.tools.some(tool => /delete|remove/.test(tool.name))).toBe(false)
      await expect(plugin.manage('delete', { assetIds: [first.assetId], expectedRevision: f.store.images({}).revision, confirmed: true })).resolves.toMatchObject({ deletedAssetIds: [first.assetId] })
      await expect(plugin.manage('get', { assetId: first.assetId })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_IMAGE_NOT_FOUND' })
    } finally { await plugin.dispose() }
  })
})
