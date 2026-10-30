import { PlatformError } from '@eating/plugin-sdk'
import type { ImageResource } from '@eating/plugin-sdk'
import { STICKER_LIMITS } from '../types'
import type { StickerMimeType } from '../types'

function invalid(): never { throw new PlatformError('STICKER_INVALID_IMAGE', '请选择有效的 PNG、JPEG、GIF 或 WebP 图片，大小不超过 5 MiB。', 400, 'not-sent') }
export function imageMime(bytes: Buffer): StickerMimeType | null {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg'
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 59) return 'image/gif'
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length
    && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp'
  return null
}
export function decodeStickerImage(input: unknown): { bytes: Buffer; mimeType: StickerMimeType } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const image = input as Partial<ImageResource>
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(image.mimeType)) || typeof image.data !== 'string'
    || image.data.length === 0 || image.data.length > Math.ceil(STICKER_LIMITS.imageBytes / 3) * 4 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) invalid()
  const bytes = Buffer.from(image.data, 'base64')
  if (!bytes.length || bytes.length > STICKER_LIMITS.imageBytes || bytes.toString('base64') !== image.data || imageMime(bytes) !== image.mimeType) invalid()
  return { bytes, mimeType: image.mimeType as StickerMimeType }
}
