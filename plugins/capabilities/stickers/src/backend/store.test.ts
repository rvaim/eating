import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { StickerLibrary } from './store'
import { fixtureImage, fixturePng } from './test-fixtures'
import { STICKER_LIMITS } from '../types'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const target = realpathSync(root)
    if (target !== root || dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('eating-sticker-test-')) throw new Error('Unsafe sticker fixture cleanup')
    rmSync(target, { recursive: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-sticker-test-'))); roots.push(root)
  return { root, library: new StickerLibrary(join(root, 'library')) }
}
const input = { description: '开心地挥手，适合打招呼。', tags: ['开心', '问候'] }
const invalid = expect.objectContaining({ code: 'STICKER_INVALID_INPUT' })

describe('sticker content-addressed collection', () => {
  it('creates no files for a new read, persists schema1 metadata and returns no image data from lists', async () => {
    const { root, library } = fixture()
    expect(await library.list()).toEqual({ revision: 0, items: [], offset: 0, limit: 20, total: 0, hasMore: false, nextOffset: null })
    expect(readdirSync(root)).toEqual([])
    const added = await library.add(fixtureImage(), input)
    expect(added).toMatchObject({ revision: 1, duplicate: false, item: { ...input, assetId: createHash('sha256').update(fixturePng()).digest('hex'), mimeType: 'image/png', bytes: fixturePng().length } })
    const saved = JSON.parse(readFileSync(library.indexPath, 'utf8'))
    expect(saved).toMatchObject({ schemaVersion: 1, revision: 1, items: [added.item] })
    expect(readdirSync(library.directory).sort()).toEqual(['blobs', 'library.json'])
    expect(readdirSync(join(library.directory, 'blobs'))).toEqual([added.item.assetId])
    const reopened = new StickerLibrary(library.directory)
    expect(await reopened.get({ assetId: added.item.assetId })).toEqual({ item: added.item, revision: 1, image: fixtureImage() })
    const list = await reopened.list()
    expect(list.items).toEqual([added.item])
    expect(JSON.stringify(list)).not.toContain(fixtureImage().data)
    expect(JSON.stringify(list)).not.toContain('eating-asset:')
  })

  it('deduplicates identical bytes without replacing the saved description, tags, revision or timestamps', async () => {
    const { library } = fixture()
    const first = await library.add(fixtureImage(), input)
    const duplicate = await library.add(fixtureImage(), { description: '不会覆盖', tags: ['新标签'] })
    expect(duplicate).toEqual({ ...first, duplicate: true })
    expect(readdirSync(join(library.directory, 'blobs'))).toEqual([first.item.assetId])
    expect(await library.list()).toMatchObject({ revision: 1, total: 1 })
  })

  it('deduplicates normalized tags and returns useful tag counts', async () => {
    const { library } = fixture()
    await library.add(fixtureImage(), { ...input, tags: [' 开心 ', '开心', 'HELLO', 'hello', 'constructor'] })
    await library.add(fixtureImage(1), { ...input, tags: ['开心', 'bye'] })
    expect((await library.list()).items.find(item => item.tags.includes('HELLO'))?.tags).toEqual(['开心', 'HELLO', 'constructor'])
    expect(await library.tags()).toEqual({ revision: 2, tags: [{ tag: 'bye', count: 1 }, { tag: 'constructor', count: 1 }, { tag: 'HELLO', count: 1 }, { tag: '开心', count: 2 }] })
  })

  it('uses stable pagination, total/nextOffset and query plus tag AND filtering', async () => {
    const { library } = fixture()
    for (let color = 0; color < 24; color++) await library.add(fixtureImage(color), { description: `Wave ${color}`, tags: color % 2 ? ['Happy', 'greeting'] : ['Happy', 'quiet'] })
    const first = await library.list()
    const second = await library.list({ offset: first.nextOffset, expectedRevision: first.revision })
    expect(first).toMatchObject({ revision: 24, offset: 0, limit: 20, total: 24, hasMore: true, nextOffset: 20 })
    expect(second).toMatchObject({ offset: 20, total: 24, hasMore: false, nextOffset: null })
    expect(new Set([...first.items, ...second.items].map(item => item.assetId)).size).toBe(24)
    expect((await library.list()).items.map(item => item.assetId)).toEqual(first.items.map(item => item.assetId))
    expect(await library.list({ query: 'WAVE', tags: ['happy', 'greeting'] })).toMatchObject({ total: 12 })
    expect(await library.list({ query: 'QUIET', tags: ['happy', 'quiet'] })).toMatchObject({ total: 12 })
    expect(await library.list({ tags: ['quiet', 'greeting'] })).toMatchObject({ total: 0 })
    await library.add(fixtureImage(25), input)
    await expect(library.list({ offset: 20, expectedRevision: first.revision })).rejects.toMatchObject({ code: 'STICKER_REVISION_CONFLICT' })
    expect(await library.list({ offset: 200, limit: 1 })).toMatchObject({ items: [], total: 25, hasMore: false, nextOffset: null })
  })

  it('requires full metadata with CAS for updates and serializes simultaneous saves from multiple instances', async () => {
    const { library } = fixture()
    const first = await library.add(fixtureImage(), input)
    const second = new StickerLibrary(library.directory)
    const results = await Promise.allSettled([library.update({ assetId: first.item.assetId, description: '第一份', tags: [], expectedRevision: 1 }), second.update({ assetId: first.item.assetId, description: '第二份', tags: [], expectedRevision: 1 })])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'STICKER_REVISION_CONFLICT' })
    const saved = await library.get({ assetId: first.item.assetId })
    expect(saved.revision).toBe(2)
    expect(saved.item.description).toBe('第一份')
    expect(saved.image).toEqual(fixtureImage())
    await expect(library.update({ assetId: first.item.assetId, description: 'no revision', tags: [] })).rejects.toEqual(invalid)
    const unchanged = await library.update({ assetId: first.item.assetId, description: '第一份', tags: [], expectedRevision: 2 })
    expect(unchanged.revision).toBe(2)
  })

  it('deletes only the chosen hash, rejects stale changes, and removes the image', async () => {
    const { library } = fixture()
    const first = await library.add(fixtureImage(), input), second = await library.add(fixtureImage(1), input)
    await expect(library.delete({ assetId: first.item.assetId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'STICKER_REVISION_CONFLICT' })
    expect(await library.delete({ assetId: first.item.assetId, expectedRevision: 2 })).toEqual({ revision: 3, assetId: first.item.assetId, deleted: true })
    expect(readdirSync(join(library.directory, 'blobs'))).toEqual([second.item.assetId])
    await expect(library.get({ assetId: first.item.assetId })).rejects.toMatchObject({ code: 'STICKER_NOT_FOUND' })
    await expect(library.delete({ assetId: first.item.assetId, expectedRevision: 3 })).rejects.toMatchObject({ code: 'STICKER_NOT_FOUND' })
  })

  it.each([null, {}, { description: '' }, { ...input, description: ' '.repeat(2) }, { ...input, description: 'x'.repeat(1001) }, { ...input, tags: Array(33).fill('a') }, { ...input, tags: ['x'.repeat(33)] }, { ...input, tags: [7] }, { ...input, tags: [''] }, { ...input, extra: true }])('rejects invalid metadata without creating data: %j', async values => {
    const { root, library } = fixture()
    await expect(library.add(fixtureImage(), values)).rejects.toEqual(invalid)
    expect(readdirSync(root)).toEqual([])
  })

  it.each(['../library.json', '/tmp/secret', 'file:///tmp/secret', 'https://example.test/image', 'a'.repeat(63), 'A'.repeat(64)])('never uses an arbitrary asset path %s', async assetId => {
    const { library } = fixture()
    await expect(library.get({ assetId })).rejects.toEqual(invalid)
  })

  it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.1 }, { offset: -1 }, { offset: '1' }, { query: 2 }, { expectedRevision: -1 }, { path: '/tmp' }])('rejects invalid pagination: %j', async input => {
    const { library } = fixture()
    await expect(library.list(input)).rejects.toEqual(invalid)
  })

  it('rejects a corrupted current index or unsupported schema before mutation and preserves its bytes', async () => {
    const { library } = fixture()
    await library.add(fixtureImage(), input)
    const current = JSON.parse(readFileSync(library.indexPath, 'utf8'))
    for (const saved of ['not json', JSON.stringify({ ...current, schemaVersion: 2 }), JSON.stringify({ ...current, revision: -1 }), JSON.stringify({ ...current, extra: true }), JSON.stringify({ ...current, items: [{ ...current.items[0], description: '' }] })]) {
      writeFileSync(library.indexPath, saved)
      await expect(library.add(fixtureImage(2), input)).rejects.toMatchObject({ code: 'STICKER_LIBRARY_CORRUPTED' })
      expect(() => new StickerLibrary(library.directory)).toThrowError(expect.objectContaining({ code: 'STICKER_LIBRARY_CORRUPTED' }))
      expect(readFileSync(library.indexPath, 'utf8')).toBe(saved)
    }
  })

  it('rejects corrupted image content and symbolic links, including dangling indexes', async () => {
    const { library, root } = fixture()
    const added = await library.add(fixtureImage(), input)
    const blob = join(library.directory, 'blobs', added.item.assetId)
    writeFileSync(blob, Buffer.alloc(fixturePng().length))
    await expect(library.get({ assetId: added.item.assetId })).rejects.toMatchObject({ code: 'STICKER_LIBRARY_CORRUPTED' })
    rmSync(blob)
    const outside = join(root, 'outside'); writeFileSync(outside, fixturePng()); symlinkSync(outside, blob)
    await expect(library.add(fixtureImage(1), input)).rejects.toMatchObject({ code: 'STICKER_LIBRARY_CORRUPTED' })
    const directory = join(root, 'dangling'); mkdirSync(directory); symlinkSync(join(root, 'absent'), join(directory, 'library.json'))
    expect(() => new StickerLibrary(directory)).toThrowError(expect.objectContaining({ code: 'STICKER_LIBRARY_CORRUPTED' }))
    expect(readFileSync(outside)).toEqual(fixturePng())
  })

  it('bounds the total unique tag directory without modifying an existing resource', async () => {
    const { library } = fixture()
    for (let index = 0; index < 64; index++) await library.add(fixtureImage(index), { description: `sticker ${index}`, tags: Array.from({ length: 32 }, (_, tag) => `tag-${index}-${tag}`) })
    const before = readFileSync(library.indexPath, 'utf8')
    expect((await library.tags()).tags).toHaveLength(2048)
    await expect(library.add(fixtureImage(100), { ...input, tags: ['one-more'] })).rejects.toMatchObject({ code: 'STICKER_CAPACITY_REACHED' })
    expect(readFileSync(library.indexPath, 'utf8')).toBe(before)
    expect(readdirSync(join(library.directory, 'blobs'))).toHaveLength(64)
  })

  it('bounds the number of resources and refuses additions at capacity', async () => {
    const { library } = fixture()
    const added = await library.add(fixtureImage(), input)
    const items = [added.item]
    for (let index = 1; index < STICKER_LIMITS.items; index++) {
      const bytes = fixturePng(index), assetId = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(resolve(library.directory, 'blobs', assetId), bytes)
      items.push({ ...added.item, assetId, bytes: bytes.length })
    }
    writeFileSync(library.indexPath, JSON.stringify({ schemaVersion: 1, revision: 1, items }))
    await expect(library.add(fixtureImage(2000), input)).rejects.toMatchObject({ code: 'STICKER_CAPACITY_REACHED' })
    expect((await library.list()).total).toBe(1000)
  })
})
