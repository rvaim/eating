import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_IMAGE_LIMITS,
  MAX_PERSONA_APPEARANCE_IMAGES,
  MAX_PERSONA_APPEARANCE_LABEL_LENGTH,
  PlatformError,
  checkedImageResource,
  isJsonObject,
} from '@eating/plugin-sdk'
import type { ImageLimits, ImageResource, JsonObject, PersonaAppearanceImageSummary } from '@eating/plugin-sdk'

type SupportedAppearanceMimeType = PersonaAppearanceImageSummary['mimeType']

interface StoredAppearanceIndex {
  readonly schemaVersion: 1
  readonly revision: number
  readonly personas: Record<string, PersonaAppearanceImageSummary[]>
}

export interface PersonaAppearancesSnapshot {
  readonly protocolVersion: 1
  readonly personaId: string
  readonly revision: number
  readonly maxImages: number
  readonly images: readonly PersonaAppearanceImageSummary[]
}

const MAX_INDEX_BYTES = 2 * 1024 * 1024
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const SUPPORTED_MIMES = new Set<SupportedAppearanceMimeType>(['image/png', 'image/jpeg', 'image/webp'])
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function corrupted(): PlatformError {
  return new PlatformError('PERSONA_APPEARANCE_STORAGE_CORRUPTED', '人格外貌参考图索引或文件已损坏，原数据未被覆盖。', 500, 'not-sent')
}

function invalidImage(message: string): never {
  throw new PlatformError('INVALID_PERSONA_APPEARANCE_IMAGE', message, 400, 'not-sent')
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.length === Object.keys(value).length && required.every(key => Object.hasOwn(value, key))
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function sanitizeLabel(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') invalidImage('参考图说明必须为文本。')
  const trimmed = value.trim()
  if (trimmed.length > MAX_PERSONA_APPEARANCE_LABEL_LENGTH || CONTROL_CHARS.test(trimmed)) {
    invalidImage(`参考图说明不能超过 ${MAX_PERSONA_APPEARANCE_LABEL_LENGTH} 个字符，也不能包含控制字符。`)
  }
  return trimmed
}

function detectMimeType(bytes: Buffer): SupportedAppearanceMimeType | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 16 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function parseDimensions(bytes: Buffer, mimeType: SupportedAppearanceMimeType): { width: number | null; height: number | null } {
  const bounded = (width: number, height: number) =>
    Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 1 && height >= 1 && width <= 65_535 && height <= 65_535
      ? { width, height }
      : { width: null, height: null }

  if (mimeType === 'image/png') {
    if (bytes.length >= 24 && bytes.subarray(12, 16).toString('ascii') === 'IHDR') {
      return bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    }
    return { width: null, height: null }
  }

  if (mimeType === 'image/jpeg') {
    let offset = 2
    while (offset + 1 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.length) break
      const marker = bytes[offset]!
      offset += 1
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (marker === 0xd9 || marker === 0xda) break
      if (offset + 2 > bytes.length) break
      const segmentLength = bytes.readUInt16BE(offset)
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break
      if (SOF_MARKERS.has(marker) && segmentLength >= 7) {
        return bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
      }
      offset += segmentLength
    }
    return { width: null, height: null }
  }

  // WebP container headers
  if (bytes.length < 30) return { width: null, height: null }
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return bounded(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21)
    return bounded((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    return bounded(width, height)
  }
  return { width: null, height: null }
}

function ensurePrivateDirectory(directory: string): string {
  const absolute = resolve(directory)
  mkdirSync(absolute, { recursive: true, mode: 0o700 })
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw corrupted()
  chmodSync(absolute, 0o700)
  return absolute
}

function writeAtomic(filePath: string, payload: Buffer | string): void {
  const target = resolve(filePath)
  const directory = ensurePrivateDirectory(dirname(target))
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw corrupted()
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
    chmodSync(target, 0o600)
    if (process.platform !== 'win32') {
      const dirFd = openSync(directory, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function readPrivateFile(filePath: string, maxBytes: number): Buffer | null {
  const stat = lstatSync(filePath, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw corrupted()
  let fd: number | undefined
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > maxBytes) throw corrupted()
    chmodSync(filePath, 0o600)
    return readFileSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function validSummary(value: unknown): value is PersonaAppearanceImageSummary {
  if (!isJsonObject(value) || !exactKeys(value, ['id', 'label', 'mimeType', 'byteLength', 'width', 'height', 'sha256', 'createdAt'])) {
    return false
  }
  return typeof value.id === 'string' && UUID_V4.test(value.id)
    && typeof value.label === 'string' && value.label.length <= MAX_PERSONA_APPEARANCE_LABEL_LENGTH && !CONTROL_CHARS.test(value.label)
    && typeof value.mimeType === 'string' && SUPPORTED_MIMES.has(value.mimeType as SupportedAppearanceMimeType)
    && typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) && value.byteLength >= 1
    && (value.width === null || typeof value.width === 'number' && Number.isSafeInteger(value.width) && value.width >= 1)
    && (value.height === null || typeof value.height === 'number' && Number.isSafeInteger(value.height) && value.height >= 1)
    && typeof value.sha256 === 'string' && SHA256.test(value.sha256)
    && validTimestamp(value.createdAt)
}

/** Isolated per-persona appearance image repository stored independently of host:authoring SQLite rows. */
export class PersonaAppearanceStore {
  readonly directory: string
  private readonly indexPath: string

  constructor(directory: string, private readonly imageLimits: () => ImageLimits = () => DEFAULT_IMAGE_LIMITS) {
    this.directory = ensurePrivateDirectory(directory)
    this.indexPath = join(this.directory, 'index.json')
  }

  private blobPath(imageId: string): string {
    if (!UUID_V4.test(imageId)) invalidImage('参考图标识无效。')
    return join(this.directory, `${imageId.toLowerCase()}.bin`)
  }

  private readIndex(): StoredAppearanceIndex {
    const raw = readPrivateFile(this.indexPath, MAX_INDEX_BYTES)
    if (!raw) return { schemaVersion: 1, revision: 0, personas: {} }
    let parsed: unknown
    try { parsed = JSON.parse(raw.toString('utf8')) } catch { throw corrupted() }
    if (!isJsonObject(parsed) || !exactKeys(parsed, ['schemaVersion', 'revision', 'personas'])
      || parsed.schemaVersion !== 1
      || typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0
      || !isJsonObject(parsed.personas) || Object.keys(parsed.personas).length > 500) {
      throw corrupted()
    }
    const imageIds = new Set<string>()
    const personas: Record<string, PersonaAppearanceImageSummary[]> = {}
    for (const [personaId, items] of Object.entries(parsed.personas)) {
      if (!UUID_V4.test(personaId) || !Array.isArray(items) || items.length > MAX_PERSONA_APPEARANCE_IMAGES) throw corrupted()
      personas[personaId] = (items as unknown[]).map(item => {
        if (!validSummary(item)) throw corrupted()
        if (imageIds.has(item.id)) throw corrupted()
        imageIds.add(item.id)
        return { ...item }
      })
    }
    return { schemaVersion: 1, revision: parsed.revision, personas }
  }

  private saveIndex(current: StoredAppearanceIndex, nextPersonas: Record<string, PersonaAppearanceImageSummary[]>): StoredAppearanceIndex {
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new PlatformError('PERSONA_APPEARANCE_REVISION_EXHAUSTED', '人格外貌参考图配置版本已达上限。', 500, 'not-sent')
    }
    const next: StoredAppearanceIndex = { schemaVersion: 1, revision: current.revision + 1, personas: nextPersonas }
    writeAtomic(this.indexPath, JSON.stringify(next, null, 2) + '\n')
    return next
  }

  private requirePersonaId(personaId: string): void {
    if (typeof personaId !== 'string' || !UUID_V4.test(personaId)) {
      throw new PlatformError('PERSONA_NOT_FOUND', '人格不存在。', 404, 'not-sent')
    }
  }

  private assertRevision(actual: number, expected: unknown): void {
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== actual) {
      throw new PlatformError('PERSONA_APPEARANCE_CONFLICT', '外貌参考图列表已在其他位置修改，请刷新后重试。', 409, 'not-sent')
    }
  }

  list(personaId: string): PersonaAppearancesSnapshot {
    this.requirePersonaId(personaId)
    const index = this.readIndex()
    return {
      protocolVersion: 1,
      personaId,
      revision: index.revision,
      maxImages: MAX_PERSONA_APPEARANCE_IMAGES,
      images: structuredClone(index.personas[personaId] ?? []),
    }
  }

  add(personaId: string, input: unknown): PersonaAppearancesSnapshot & { readonly image: PersonaAppearanceImageSummary } {
    this.requirePersonaId(personaId)
    if (!isJsonObject(input) || Object.keys(input).some(key => !['data', 'mimeType', 'label', 'expectedRevision'].includes(key))) {
      invalidImage('上传参考图参数无效。')
    }
    if (typeof input.data !== 'string' || !input.data.trim()) invalidImage('请提供有效的图片数据。')
    const declaredMime = input.mimeType === undefined ? undefined
      : typeof input.mimeType === 'string' && SUPPORTED_MIMES.has(input.mimeType as SupportedAppearanceMimeType)
        ? input.mimeType as SupportedAppearanceMimeType
        : invalidImage('仅支持 PNG、JPEG 或 WebP 格式的参考图。')
    const label = sanitizeLabel(input.label)

    const limits = this.imageLimits()
    let base64 = input.data.trim()
    let dataUrlMime: SupportedAppearanceMimeType | undefined
    if (base64.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(base64)
      if (!match) invalidImage('仅支持 PNG、JPEG 或 WebP 格式的 Base64 图片数据。')
      dataUrlMime = match[1]!.toLowerCase() as SupportedAppearanceMimeType
      base64 = match[2]!.replace(/\s+/g, '')
    } else {
      base64 = base64.replace(/\s+/g, '')
    }
    if (declaredMime && dataUrlMime && declaredMime !== dataUrlMime) invalidImage('图片声明格式与内容前缀不一致。')
    if (base64.length > Math.ceil(limits.imageBytes / 3) * 4 + 16) {
      throw new PlatformError('IMAGE_TOO_LARGE', `参考图大小超过当前 ${limits.maxImageMiB} MiB 单图上限。`, 413, 'not-sent')
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64) || base64.length % 4 !== 0) invalidImage('图片 Base64 数据无效。')
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.toString('base64') !== base64) invalidImage('图片 Base64 数据无效。')
    if (bytes.length > limits.imageBytes) {
      throw new PlatformError('IMAGE_TOO_LARGE', `参考图大小超过当前 ${limits.maxImageMiB} MiB 单图上限。`, 413, 'not-sent')
    }

    const detectedMime = detectMimeType(bytes)
    if (!detectedMime) invalidImage('无法识别图片格式，仅支持真实的 PNG、JPEG 或 WebP 图片。')
    const expectedMime = declaredMime ?? dataUrlMime
    if (expectedMime && expectedMime !== detectedMime) invalidImage('图片实际文件内容与声明的媒体类型不匹配。')

    const index = this.readIndex()
    if (input.expectedRevision !== undefined) this.assertRevision(index.revision, input.expectedRevision)
    const currentList = index.personas[personaId] ?? []
    if (currentList.length >= MAX_PERSONA_APPEARANCE_IMAGES) {
      throw new PlatformError('PERSONA_APPEARANCE_LIMIT_REACHED', `单个人格最多上传 ${MAX_PERSONA_APPEARANCE_IMAGES} 张外貌参考图。`, 409, 'not-sent')
    }

    const imageId = randomUUID()
    const blob = this.blobPath(imageId)
    const { width, height } = parseDimensions(bytes, detectedMime)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const summary: PersonaAppearanceImageSummary = {
      id: imageId,
      label,
      mimeType: detectedMime,
      byteLength: bytes.length,
      width,
      height,
      sha256,
      createdAt: new Date().toISOString(),
    }

    writeAtomic(blob, bytes)
    try {
      const nextPersonas = { ...index.personas, [personaId]: [...currentList, summary] }
      const saved = this.saveIndex(index, nextPersonas)
      return {
        protocolVersion: 1,
        personaId,
        revision: saved.revision,
        maxImages: MAX_PERSONA_APPEARANCE_IMAGES,
        image: { ...summary },
        images: structuredClone(saved.personas[personaId] ?? []),
      }
    } catch (error) {
      try { if (existsSync(blob)) unlinkSync(blob) } catch { /* Best-effort rollback of unreferenced file. */ }
      throw error
    }
  }

  updateLabel(personaId: string, imageId: string, label: string, expectedRevision: number): PersonaAppearancesSnapshot {
    this.requirePersonaId(personaId)
    if (!UUID_V4.test(imageId)) throw new PlatformError('PERSONA_APPEARANCE_NOT_FOUND', '外貌参考图不存在。', 404, 'not-sent')
    const normalized = sanitizeLabel(label)
    const index = this.readIndex()
    this.assertRevision(index.revision, expectedRevision)
    const list = index.personas[personaId] ?? []
    const idx = list.findIndex(item => item.id === imageId)
    if (idx < 0) throw new PlatformError('PERSONA_APPEARANCE_NOT_FOUND', '外貌参考图不存在。', 404, 'not-sent')
    if (list[idx]!.label === normalized) {
      return { protocolVersion: 1, personaId, revision: index.revision, maxImages: MAX_PERSONA_APPEARANCE_IMAGES, images: structuredClone(list) }
    }
    const nextList = list.map(item => item.id === imageId ? { ...item, label: normalized } : item)
    const saved = this.saveIndex(index, { ...index.personas, [personaId]: nextList })
    return { protocolVersion: 1, personaId, revision: saved.revision, maxImages: MAX_PERSONA_APPEARANCE_IMAGES, images: structuredClone(saved.personas[personaId] ?? []) }
  }

  reorder(personaId: string, imageIds: readonly string[], expectedRevision: number): PersonaAppearancesSnapshot {
    this.requirePersonaId(personaId)
    if (!Array.isArray(imageIds) || imageIds.some(id => typeof id !== 'string' || !UUID_V4.test(id))) {
      invalidImage('外貌参考图排序名单无效。')
    }
    const index = this.readIndex()
    this.assertRevision(index.revision, expectedRevision)
    const list = index.personas[personaId] ?? []
    if (imageIds.length !== list.length || new Set(imageIds).size !== list.length || imageIds.some(id => !list.some(item => item.id === id))) {
      invalidImage('外貌参考图排序名单必须与当前已有图片一一对应。')
    }
    if (imageIds.every((id, position) => list[position]!.id === id)) {
      return { protocolVersion: 1, personaId, revision: index.revision, maxImages: MAX_PERSONA_APPEARANCE_IMAGES, images: structuredClone(list) }
    }
    const byId = new Map(list.map(item => [item.id, item]))
    const nextList = imageIds.map(id => byId.get(id)!)
    const saved = this.saveIndex(index, { ...index.personas, [personaId]: nextList })
    return { protocolVersion: 1, personaId, revision: saved.revision, maxImages: MAX_PERSONA_APPEARANCE_IMAGES, images: structuredClone(saved.personas[personaId] ?? []) }
  }

  remove(personaId: string, imageId: string, expectedRevision: number): PersonaAppearancesSnapshot {
    this.requirePersonaId(personaId)
    if (!UUID_V4.test(imageId)) throw new PlatformError('PERSONA_APPEARANCE_NOT_FOUND', '外貌参考图不存在。', 404, 'not-sent')
    const index = this.readIndex()
    this.assertRevision(index.revision, expectedRevision)
    const list = index.personas[personaId] ?? []
    if (!list.some(item => item.id === imageId)) {
      throw new PlatformError('PERSONA_APPEARANCE_NOT_FOUND', '外貌参考图不存在。', 404, 'not-sent')
    }
    const nextList = list.filter(item => item.id !== imageId)
    const nextPersonas = { ...index.personas }
    if (nextList.length === 0) delete nextPersonas[personaId]
    else nextPersonas[personaId] = nextList
    const saved = this.saveIndex(index, nextPersonas)
    const blob = this.blobPath(imageId)
    const stat = lstatSync(blob, { throwIfNoEntry: false })
    if (stat && stat.isFile() && !stat.isSymbolicLink()) unlinkSync(blob)
    return { protocolVersion: 1, personaId, revision: saved.revision, maxImages: MAX_PERSONA_APPEARANCE_IMAGES, images: structuredClone(saved.personas[personaId] ?? []) }
  }

  removePersona(personaId: string): void {
    this.requirePersonaId(personaId)
    const index = this.readIndex()
    const list = index.personas[personaId]
    if (!list || list.length === 0) return
    const nextPersonas = { ...index.personas }
    delete nextPersonas[personaId]
    this.saveIndex(index, nextPersonas)
    for (const item of list) {
      const blob = this.blobPath(item.id)
      const stat = lstatSync(blob, { throwIfNoEntry: false })
      if (stat && stat.isFile() && !stat.isSymbolicLink()) unlinkSync(blob)
    }
  }

  readImageBytes(personaId: string, imageId: string): { readonly bytes: Buffer; readonly mimeType: SupportedAppearanceMimeType; readonly summary: PersonaAppearanceImageSummary } {
    this.requirePersonaId(personaId)
    if (!UUID_V4.test(imageId)) throw new PlatformError('PERSONA_APPEARANCE_NOT_FOUND', '外貌参考图不存在。', 404, 'not-sent')
    const index = this.readIndex()
    const summary = (index.personas[personaId] ?? []).find(item => item.id === imageId)
    if (!summary) throw new PlatformError('PERSONA_APPEARANCE_NOT_FOUND', '外貌参考图不存在。', 404, 'not-sent')
    const blob = this.blobPath(imageId)
    const bytes = readPrivateFile(blob, this.imageLimits().imageBytes)
    if (!bytes) throw corrupted()
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    const actualMime = detectMimeType(bytes)
    if (bytes.length !== summary.byteLength || actualHash !== summary.sha256 || actualMime !== summary.mimeType) {
      throw corrupted()
    }
    return { bytes, mimeType: summary.mimeType, summary: { ...summary } }
  }

  readImageResource(personaId: string, imageId: string): ImageResource {
    const { bytes, mimeType } = this.readImageBytes(personaId, imageId)
    return checkedImageResource({ mimeType, data: bytes.toString('base64') }, this.imageLimits().imageBytes)
  }
}

export function asJsonSummary(value: PersonaAppearanceImageSummary): JsonObject {
  return value as unknown as JsonObject
}
