import { PlatformError, isJsonObject } from './index.js'
import type { ImageAssetReference, ImageResource } from './capabilities.js'

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
