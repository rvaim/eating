import { HostApiError } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import { STICKER_LIMITS } from '../types'
import type { StickerImage, StickerItem, StickerList, StickerPreview, StickerTags } from '../types'
import { st } from './i18n'

function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', st('error.invalidResponse')) }
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function readStickerItem(value: unknown): StickerItem {
  if (!isJsonObject(value) || typeof value.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(value.assetId) || typeof value.description !== 'string' || !value.description.trim() || [...value.description].length > 1000
    || !Array.isArray(value.tags) || value.tags.length > 32 || value.tags.some(tag => typeof tag !== 'string' || !tag || [...tag].length > 32)
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mimeType)) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > STICKER_LIMITS.imageBytes
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) invalid()
  return value as unknown as StickerItem
}
export function readStickerList(value: unknown): StickerList {
  if (!isJsonObject(value) || !validRevision(value.revision) || !Array.isArray(value.items) || value.items.length > 50
    || !validRevision(value.offset) || !validRevision(value.total) || !validRevision(value.limit) || value.limit < 1 || value.limit > 50
    || typeof value.hasMore !== 'boolean' || value.nextOffset !== null && !validRevision(value.nextOffset)) invalid()
  const items = value.items.map(readStickerItem)
  if (items.length > value.limit || value.hasMore !== (value.offset + items.length < value.total) || value.nextOffset !== (value.hasMore ? value.offset + items.length : null)) invalid()
  return { revision: value.revision, items, offset: value.offset, limit: value.limit, total: value.total, hasMore: value.hasMore, nextOffset: value.nextOffset as number | null }
}
export function readStickerTags(value: unknown): StickerTags {
  if (!isJsonObject(value) || !validRevision(value.revision) || !Array.isArray(value.tags) || value.tags.length > 10000) invalid()
  const tags = value.tags.map(tag => {
    if (!isJsonObject(tag) || typeof tag.tag !== 'string' || !tag.tag || [...tag.tag].length > 32 || !validRevision(tag.count) || tag.count < 1) invalid()
    return { tag: tag.tag, count: tag.count }
  })
  return { revision: value.revision, tags }
}
export function readStickerImage(value: unknown): StickerImage {
  if (!isJsonObject(value) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mimeType)) || typeof value.data !== 'string' || !value.data
    || value.data.length > Math.ceil(STICKER_LIMITS.imageBytes / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) invalid()
  return { data: value.data, mimeType: value.mimeType as StickerImage['mimeType'] }
}
export function readStickerPreview(value: unknown): StickerPreview {
  if (!isJsonObject(value) || !validRevision(value.revision)) invalid()
  return { revision: value.revision, item: readStickerItem(value.item), image: readStickerImage(value.image) }
}
export function tagsFromText(text: string): string[] {
  const tags = text.split(/\r?\n/).map(tag => tag.trim()).filter(Boolean)
  if (tags.length > 32 || tags.some(tag => [...tag].length > 32 || /[\u0000-\u001f\u007f]/u.test(tag))) throw new HostApiError('STICKER_TAGS_INVALID', st('error.tags'))
  const seen = new Set<string>()
  return tags.filter(tag => { const key = tag.normalize('NFKC').toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true })
}
export function imageBlob(image: StickerImage): Blob {
  const binary = atob(image.data)
  if (!binary.length || binary.length > STICKER_LIMITS.imageBytes || btoa(binary) !== image.data) invalid()
  return new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: image.mimeType })
}
export async function localImage(file: File): Promise<StickerImage> {
  const mime = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.gif$/i.test(file.name) ? 'image/gif' : /\.webp$/i.test(file.name) ? 'image/webp' : '')
  if (!file.size || file.size > STICKER_LIMITS.imageBytes || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new HostApiError('STICKER_INVALID_IMAGE', st('error.image'))
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size) invalid()
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return { mimeType: mime as StickerImage['mimeType'], data: btoa(binary) }
}
