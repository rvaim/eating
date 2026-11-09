import { PlatformError, isJsonObject } from './index.js'
import type { ImageAssetReference, ImageMimeType, ImageResource } from './capabilities.js'

export const MAX_IMAGE_RESOURCE_BYTES = 5 * 1024 * 1024
export const MAX_AUDIO_DURATION_MS = 60000
export const MAX_AUDIO_RESOURCE_BYTES = 44 + MAX_AUDIO_DURATION_MS * 48

/** Current audio contract: canonical 24 kHz mono PCM16 WAV, at most 60 seconds. */
export function checkedAudioBytes(value: unknown, mimeType: unknown): Uint8Array {
  const invalid = (): never => { throw new PlatformError('INVALID_AUDIO_RESOURCE', '音频资源格式、时长或大小无效。', 502, 'not-sent') }
  if (!(value instanceof Uint8Array) || value.byteLength <= 44 || value.byteLength > MAX_AUDIO_RESOURCE_BYTES || mimeType !== 'audio/wav') return invalid()
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  const ascii = (start: number, end: number) => String.fromCharCode(...value.subarray(start, end))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE' || ascii(12, 16) !== 'fmt ' || ascii(36, 40) !== 'data'
    || view.getUint32(4, true) !== value.byteLength - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 24000 || view.getUint32(28, true) !== 48000
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== value.byteLength - 44 || (value.byteLength - 44) % 2) return invalid()
  return new Uint8Array(value)
}
export function parseAudioAssetUri(value: string): ImageAssetReference | null {
  if (!value.startsWith('eating-audio:')) return null
  const match = /^eating-audio:\/\/([a-z][a-z0-9-]{0,63})\/([a-f0-9]{64})$/.exec(value)
  if (!match) throw new PlatformError('INVALID_ASSET_REFERENCE', '语音资源引用格式无效。', 400, 'not-sent')
  return { pluginId: match[1]!, assetId: match[2]! }
}

export function checkedImageBytes(value: unknown, mimeType: unknown): Uint8Array {
  const invalid = (): never => { throw new PlatformError('INVALID_IMAGE_RESOURCE', '插件未返回有效、有界的图片资源。', 502, 'not-sent') }
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_IMAGE_RESOURCE_BYTES) return invalid()
  const prefix = (...expected: number[]) => expected.every((byte, index) => value[index] === byte)
  const ascii = (start: number, end: number) => String.fromCharCode(...value.subarray(start, end))
  const detected: ImageMimeType | null = prefix(137, 80, 78, 71, 13, 10, 26, 10) ? 'image/png'
    : prefix(255, 216, 255) ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) ? 'image/gif'
        : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp' : null
  if (!detected || mimeType !== detected) return invalid()
  return new Uint8Array(value)
}

export function parseImageAssetUri(value: string): ImageAssetReference | null {
  if (!value.startsWith('eating-asset:')) return null
  const match = /^eating-asset:\/\/([a-z][a-z0-9-]{0,63})\/([A-Za-z0-9_-]{1,128})$/.exec(value)
  if (!match) throw new PlatformError('INVALID_ASSET_REFERENCE', '图片资源引用格式无效。', 400, 'not-sent')
  return { pluginId: match[1]!, assetId: match[2]! }
}

/** Validate bounded canonical image bytes at the cross-plugin boundary. */
export function checkedImageResource(value: unknown): ImageResource {
  const invalid = (): never => { throw new PlatformError('INVALID_IMAGE_RESOURCE', '插件未返回有效、有界的图片资源。', 502, 'not-sent') }
  if (!isJsonObject(value) || typeof value.data !== 'string' || typeof value.mimeType !== 'string'
    || value.data.length === 0 || value.data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return invalid()
  let bytes: string
  try { bytes = atob(value.data) } catch { return invalid() }
  if (bytes.length > 5 * 1024 * 1024 || btoa(bytes) !== value.data) return invalid()
  const mime = bytes.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
    : bytes.startsWith('\xff\xd8\xff') ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.slice(0, 6)) ? 'image/gif'
        : bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP' ? 'image/webp' : null
  if (!mime || mime !== value.mimeType) return invalid()
  return { mimeType: mime, data: value.data }
}
