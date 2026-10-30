import { PlatformError } from '@eating/plugin-sdk'
import type { ImageMimeType } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from '../types'

export interface GeneratedImageBytes { readonly mimeType: ImageMimeType; readonly bytes: Buffer }
export function imageFailure(): never { throw new PlatformError('IMAGE_GENERATION_INVALID_IMAGE', '生成服务返回的图片无效、格式不符或超过 5 MiB；请求可能已计费，请先核对任务。', 502, 'unknown') }
export function imageBytes(bytes: Buffer, declared?: string): GeneratedImageBytes {
  if (!bytes.length || bytes.length > IMAGE_GENERATION_LIMITS.imageBytes) imageFailure()
  let mimeType: ImageMimeType | undefined
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) mimeType = 'image/png'
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) mimeType = 'image/jpeg'
  else if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 59) mimeType = 'image/gif'
  else if (bytes.length >= 26 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) mimeType = 'image/webp'
  if (!mimeType || declared && declared !== mimeType) imageFailure()
  return { mimeType, bytes }
}
export function base64Image(value: unknown): GeneratedImageBytes {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(IMAGE_GENERATION_LIMITS.imageBytes / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) imageFailure()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) imageFailure()
  return imageBytes(bytes)
}
