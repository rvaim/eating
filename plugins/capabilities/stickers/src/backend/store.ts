import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { ImageResource, JsonObject } from '@eating/plugin-sdk'
import { STICKER_LIMITS } from '../types'
import type { StickerItem, StickerList, StickerPreview, StickerTags } from '../types'
import { decodeStickerImage, imageMime } from './image'

interface Index { schemaVersion: 1; revision: number; items: StickerItem[] }
const queues = new Map<string, Promise<unknown>>()
const HASH = /^[a-f0-9]{64}$/
const maxIndexBytes = 8 * 1024 * 1024
const existsSync = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined
function invalid(message: string): never { throw new PlatformError('STICKER_INVALID_INPUT', message, 400, 'not-sent') }
function corrupt(): never { throw new PlatformError('STICKER_LIBRARY_CORRUPTED', '表情库格式无效或文件损坏，原数据未被覆盖。', 500, 'not-sent') }
function failed(): never { throw new PlatformError('STICKER_STORAGE_FAILED', '表情库读写失败，请检查数据目录权限和磁盘空间。', 500, 'unknown') }
export function inputObject(value: unknown, allowed: readonly string[], required: readonly string[] = []): JsonObject {
  if (!isJsonObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid('表情参数不完整或包含未知字段。')
  return value
}
export function stickerAssetId(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid('表情标识无效。'); return value }
export function stickerDescription(value: unknown): string {
  if (typeof value !== 'string') invalid('请填写表情描述。')
  const text = value.trim()
  if (!text || [...text].length > STICKER_LIMITS.description || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) invalid('表情描述需为 1 至 1000 个字符。')
  return text
}
const folded = (value: string) => value.normalize('NFKC').toLowerCase()
export function stickerTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > STICKER_LIMITS.tags) invalid('最多填写 32 个标签。')
  const seen = new Set<string>(), tags: string[] = []
  for (const tag of value) {
    if (typeof tag !== 'string' || !tag.trim() || [...tag.trim()].length > STICKER_LIMITS.tagLength || /[\u0000-\u001f\u007f]/u.test(tag)) invalid('每个标签需为 1 至 32 个字符。')
    const text = tag.trim().normalize('NFC'), key = folded(text)
    if (!seen.has(key)) { seen.add(key); tags.push(text) }
  }
  return tags
}
function revision(value: unknown, required = false): number | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('请提供有效的表情库版本。')
  return value
}
function sameRevision(index: Index, expected: unknown, required = false) {
  const version = revision(expected, required)
  if (version !== undefined && index.revision !== version) throw new PlatformError('STICKER_REVISION_CONFLICT', '表情库已更新，草稿已保留。请重新读取后核对并重试。', 409, 'not-sent')
}
function nextRevision(index: Index) {
  if (index.revision === Number.MAX_SAFE_INTEGER) invalid('表情库版本已达到上限。')
  return index.revision + 1
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function readRegular(path: string, maximum: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > maximum || stat.size < 1) corrupt()
    return readFileSync(descriptor)
  } finally { closeSync(descriptor) }
}

/** A plugin-owned bounded resource collection. No received chat history or model-provided path is stored. */
export class StickerLibrary {
  readonly directory: string
  readonly indexPath: string
  private readonly blobs: string
  constructor(directory: string) {
    this.directory = resolve(directory)
    this.indexPath = join(this.directory, 'library.json')
    this.blobs = join(this.directory, 'blobs')
    this.load()
  }
  private assertDirectories(create = false) {
    for (const path of [this.directory, this.blobs]) {
      if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
      if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) corrupt()
    }
  }
  private blobPath(assetId: string): string {
    const path = resolve(this.blobs, stickerAssetId(assetId))
    if (dirname(path) !== this.blobs) corrupt()
    return path
  }
  private load(): Index {
    try {
      this.assertDirectories()
      if (!existsSync(this.indexPath)) return { schemaVersion: 1, revision: 0, items: [] }
      const raw: unknown = JSON.parse(readRegular(this.indexPath, maxIndexBytes).toString('utf8'))
      if (!isJsonObject(raw) || Object.keys(raw).sort().join(',') !== 'items,revision,schemaVersion' || raw.schemaVersion !== 1 || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.items) || raw.items.length > STICKER_LIMITS.items) corrupt()
      const seen = new Set<string>()
      let total = 0
      for (const item of raw.items) {
        if (!isJsonObject(item) || Object.keys(item).sort().join(',') !== 'assetId,bytes,createdAt,description,mimeType,tags,updatedAt'
          || typeof item.assetId !== 'string' || !HASH.test(item.assetId) || seen.has(item.assetId)
          || stickerDescription(item.description) !== item.description || JSON.stringify(stickerTags(item.tags)) !== JSON.stringify(item.tags)
          || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mimeType))
          || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > STICKER_LIMITS.imageBytes
          || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt
          || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || new Date(item.updatedAt).toISOString() !== item.updatedAt || item.updatedAt < item.createdAt) corrupt()
        const file = this.blobPath(item.assetId)
        if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile() || statSync(file).size !== item.bytes) corrupt()
        seen.add(item.assetId); total += item.bytes
      }
      if (total > STICKER_LIMITS.libraryBytes) corrupt()
      this.checkTagCapacity(raw.items as unknown as StickerItem[])
      return raw as unknown as Index
    } catch { corrupt() }
  }
  private serialize<T>(operation: () => T): Promise<T> {
    const previous = queues.get(this.directory) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(operation)
    queues.set(this.directory, task)
    void task.finally(() => { if (queues.get(this.directory) === task) queues.delete(this.directory) }).catch(() => {})
    return task
  }
  private atomic(path: string, bytes: Buffer) {
    const parent = dirname(path)
    if (![this.directory, this.blobs].includes(parent)) corrupt()
    const temporary = join(parent, `.write-${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) corrupt()
      renameSync(temporary, path)
      if (process.platform !== 'win32') {
        const directory = openSync(parent, constants.O_RDONLY)
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } catch { failed() }
    finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (dirname(resolve(temporary)) === parent && existsSync(temporary)) unlinkSync(temporary)
    }
  }
  private checkTagCapacity(items: readonly StickerItem[]) {
    if (new Set(items.flatMap(item => item.tags.map(folded))).size > STICKER_LIMITS.uniqueTags) throw new PlatformError('STICKER_CAPACITY_REACHED', '表情库标签数量已达到上限，请先整理不再需要的标签。', 409, 'not-sent')
  }
  private save(index: Index) {
    this.checkTagCapacity(index.items)
    const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n')
    if (bytes.length > maxIndexBytes) throw new PlatformError('STICKER_CAPACITY_REACHED', '表情库容量已满，请先删除不再需要的表情。', 409, 'not-sent')
    this.assertDirectories(true)
    this.atomic(this.indexPath, bytes)
  }
  private readImage(item: StickerItem): ImageResource {
    try {
      const bytes = readRegular(this.blobPath(item.assetId), STICKER_LIMITS.imageBytes)
      if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.assetId || imageMime(bytes) !== item.mimeType) corrupt()
      return { mimeType: item.mimeType, data: bytes.toString('base64') }
    } catch { corrupt() }
  }
  private removeOrphans(index: Index): number {
    if (!existsSync(this.blobs)) return 0
    const retained = new Set(index.items.map(item => item.assetId))
    let total = 0
    for (const name of readdirSync(this.blobs)) {
      if (!HASH.test(name)) continue
      const path = this.blobPath(name)
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) corrupt()
      if (retained.has(name)) total += statSync(path).size
      else if (dirname(path) === this.blobs) unlinkSync(path)
    }
    return total
  }
  stats() { const index = this.load(); return { revision: index.revision, total: index.items.length, bytes: index.items.reduce((sum, item) => sum + item.bytes, 0), limits: { ...STICKER_LIMITS } } }
  async list(input: unknown = {}): Promise<StickerList> {
    const values = inputObject(input, ['query', 'tags', 'offset', 'limit', 'expectedRevision'])
    const query = values.query ?? ''
    if (typeof query !== 'string' || [...query].length > 1000) invalid('搜索关键字不能超过 1000 个字符。')
    const tags = stickerTags(values.tags ?? [])
    const offset = values.offset ?? 0, limit = values.limit ?? 20
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > STICKER_LIMITS.page) invalid('分页范围无效，单页最多 50 项。')
    return this.serialize(() => {
      const index = this.load(); sameRevision(index, values.expectedRevision)
      const needle = folded(query.trim())
      const matching = index.items.filter(item => (!needle || folded(item.description).includes(needle) || item.tags.some(tag => folded(tag).includes(needle))) && tags.every(tag => item.tags.some(candidate => folded(candidate) === folded(tag))))
        .sort((a, b) => compare(b.createdAt, a.createdAt) || compare(a.assetId, b.assetId))
      const items = structuredClone(matching.slice(offset, offset + limit)), hasMore = offset + items.length < matching.length
      return { revision: index.revision, items, offset, limit, total: matching.length, hasMore, nextOffset: hasMore ? offset + items.length : null }
    })
  }
  async tags(input: unknown = {}): Promise<StickerTags> {
    const values = inputObject(input, ['expectedRevision'])
    return this.serialize(() => {
      const index = this.load(); sameRevision(index, values.expectedRevision)
      const counts = new Map<string, { tag: string; count: number }>()
      for (const item of index.items) for (const tag of item.tags) { const key = folded(tag), row = counts.get(key); counts.set(key, { tag: row?.tag ?? tag, count: (row?.count ?? 0) + 1 }) }
      return { revision: index.revision, tags: [...counts.values()].sort((a, b) => compare(folded(a.tag), folded(b.tag))) }
    })
  }
  async get(input: unknown): Promise<StickerPreview> {
    const values = inputObject(input, ['assetId', 'expectedRevision'], ['assetId']), assetId = stickerAssetId(values.assetId)
    return this.serialize(() => {
      const index = this.load(); sameRevision(index, values.expectedRevision)
      const item = index.items.find(item => item.assetId === assetId)
      if (!item) throw new PlatformError('STICKER_NOT_FOUND', '此表情已不存在，请重新读取列表。', 404, 'not-sent')
      return { revision: index.revision, item: structuredClone(item), image: this.readImage(item) }
    })
  }
  async add(image: unknown, input: unknown, assertActive: () => void = () => {}): Promise<{ revision: number; item: StickerItem; duplicate: boolean }> {
    const values = inputObject(input, ['description', 'tags', 'expectedRevision'], ['description', 'tags'])
    const description = stickerDescription(values.description), tags = stickerTags(values.tags)
    const decoded = decodeStickerImage(image), assetId = createHash('sha256').update(decoded.bytes).digest('hex')
    return this.serialize(() => {
      assertActive()
      const index = this.load(); sameRevision(index, values.expectedRevision)
      const present = index.items.find(item => item.assetId === assetId)
      if (present) { this.readImage(present); return { revision: index.revision, item: structuredClone(present), duplicate: true } }
      this.assertDirectories(true)
      const used = this.removeOrphans(index)
      if (index.items.length >= STICKER_LIMITS.items || used + decoded.bytes.length > STICKER_LIMITS.libraryBytes) throw new PlatformError('STICKER_CAPACITY_REACHED', '表情库容量已满，请先删除不再需要的表情。', 409, 'not-sent')
      const now = new Date().toISOString(), item: StickerItem = { assetId, description, tags, mimeType: decoded.mimeType, bytes: decoded.bytes.length, createdAt: now, updatedAt: now }
      this.checkTagCapacity([...index.items, item])
      const path = this.blobPath(assetId)
      this.atomic(path, decoded.bytes)
      this.save({ schemaVersion: 1, revision: nextRevision(index), items: [...index.items, item] })
      return { revision: index.revision + 1, item: structuredClone(item), duplicate: false }
    })
  }
  async update(input: unknown, assertActive: () => void = () => {}): Promise<{ revision: number; item: StickerItem }> {
    const values = inputObject(input, ['assetId', 'description', 'tags', 'expectedRevision'], ['assetId', 'description', 'tags', 'expectedRevision'])
    const assetId = stickerAssetId(values.assetId), description = stickerDescription(values.description), tags = stickerTags(values.tags)
    return this.serialize(() => {
      assertActive()
      const index = this.load(); sameRevision(index, values.expectedRevision, true)
      const previous = index.items.find(item => item.assetId === assetId)
      if (!previous) throw new PlatformError('STICKER_NOT_FOUND', '此表情已不存在，请重新读取列表。', 404, 'not-sent')
      if (previous.description === description && JSON.stringify(previous.tags) === JSON.stringify(tags)) return { revision: index.revision, item: structuredClone(previous) }
      const item = { ...previous, description, tags, updatedAt: new Date().toISOString() }, version = nextRevision(index)
      this.save({ ...index, revision: version, items: index.items.map(current => current.assetId === assetId ? item : current) })
      return { revision: version, item: structuredClone(item) }
    })
  }
  async delete(input: unknown, assertActive: () => void = () => {}): Promise<{ revision: number; assetId: string; deleted: true }> {
    const values = inputObject(input, ['assetId', 'expectedRevision'], ['assetId', 'expectedRevision']), assetId = stickerAssetId(values.assetId)
    return this.serialize(() => {
      assertActive()
      const index = this.load(); sameRevision(index, values.expectedRevision, true)
      if (!index.items.some(item => item.assetId === assetId)) throw new PlatformError('STICKER_NOT_FOUND', '此表情已不存在，请重新读取列表。', 404, 'not-sent')
      const version = nextRevision(index)
      this.save({ ...index, revision: version, items: index.items.filter(item => item.assetId !== assetId) })
      try { this.removeOrphans({ ...index, items: index.items.filter(item => item.assetId !== assetId) }) } catch { failed() }
      return { revision: version, assetId, deleted: true }
    })
  }
}
