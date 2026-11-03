import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkedImageBytes, isJsonObject, parseImageAssetUri, PlatformError } from '@eating/plugin-sdk'
import type { CapabilityInvocationScope, ImageAssetLease, JsonObject, JsonValue, PluginResourceServices } from '@eating/plugin-sdk'
import type { QQMediaDirectoryMapping, QQMediaTransportSettings } from '../media-transport'

function mappedImageFile(source: string, mapping: QQMediaDirectoryMapping, asset: ImageAssetLease): string | null {
  let descriptor: number | undefined
  try {
    if (!isAbsolute(source) || resolve(source) !== source || realpathSync(mapping.sourceRoot) !== mapping.sourceRoot || realpathSync(mapping.hostMappingRoot) !== mapping.hostMappingRoot) return null
    const suffix = relative(mapping.sourceRoot, source)
    if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)) return null
    const target = join(mapping.hostMappingRoot, suffix)
    if (realpathSync(target) !== target || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) return null
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size !== asset.byteLength) return null
    const bytes = checkedImageBytes(readFileSync(descriptor), asset.mimeType)
    if (bytes.byteLength !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) return null
    const remotePath = /^[A-Za-z]:/.test(mapping.onebotRoot) ? win32.join(mapping.onebotRoot, ...suffix.split(sep)) : posix.join(mapping.onebotRoot, ...suffix.split(sep))
    if (!/^[A-Za-z]:/.test(remotePath)) return pathToFileURL(remotePath).href
    const portable = remotePath.replaceAll('\\', '/')
    return `file:///${portable.slice(0, 2)}/${portable.slice(3).split('/').map(encodeURIComponent).join('/')}`
  } catch { return null }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}

export function containsQQImageAssets(params: JsonObject): boolean {
  const contains = (value: JsonValue | undefined): boolean => {
    if (Array.isArray(value)) return value.some(contains)
    if (!isJsonObject(value) || !isJsonObject(value.data)) return false
    return value.type === 'image' && typeof value.data.file === 'string' && value.data.file.startsWith('eating-asset:')
      || value.type === 'node' && contains(value.data.content)
  }
  return contains(params.message) || isJsonObject(params.operation) && contains(params.operation.reply)
}

export async function resolveQQImageAssets(params: JsonObject, resources: PluginResourceServices | undefined, settings: QQMediaTransportSettings, scope?: CapabilityInvocationScope): Promise<{ params: JsonObject; imageBase64Bytes: number }> {
  let totalBytes = 0
  const images: { data: JsonObject; asset: ImageAssetLease; bytes: Uint8Array; source: string | null }[] = []
  const resolveMessage = async (value: JsonValue): Promise<JsonValue> => {
    if (Array.isArray(value)) {
      const segments: JsonValue[] = []
      for (const segment of value) segments.push(await resolveMessage(segment))
      return segments
    }
    if (!isJsonObject(value) || !isJsonObject(value.data)) return value
    if (value.type === 'image' && typeof value.data.file === 'string') {
      const reference = parseImageAssetUri(value.data.file)
      if (!reference) return value
      if (images.length >= 4) throw new PlatformError('MEDIA_ASSET_LIMIT', '单次发送最多解析4张插件图片。', 400, 'not-sent')
      if (!resources) throw new PlatformError('MEDIA_RESOURCE_SERVICE_UNAVAILABLE', '宿主未提供图片资源服务。', 503, 'not-sent')
      const asset = await resources.getAsset(reference, scope), bytes = checkedImageBytes(await asset.readBytes(), asset.mimeType)
      if (asset.byteLength !== bytes.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new PlatformError('INVALID_IMAGE_RESOURCE', '图片资源摘要或大小无效，未发送。', 502, 'not-sent')
      totalBytes += bytes.byteLength
      if (totalBytes > 10 * 1024 * 1024) throw new PlatformError('MEDIA_ASSET_LIMIT', '单次发送的插件图片总大小不能超过10MiB。', 400, 'not-sent')
      let source: string | null = null
      if (settings.fileEligible && settings.mapping && asset.localFile) {
        try { source = await asset.localFile() }
        catch { await asset.assertActive() }
      }
      const data = { ...value.data }
      images.push({ data, asset, bytes, source })
      return { ...value, data }
    }
    if (value.type === 'node' && value.data.content !== undefined) return { ...value, data: { ...value.data, content: await resolveMessage(value.data.content) } }
    return value
  }
  const result = { ...params }
  if (result.message !== undefined) result.message = await resolveMessage(result.message)
  if (isJsonObject(result.operation) && result.operation.reply !== undefined) result.operation = { ...result.operation, reply: await resolveMessage(result.operation.reply) }
  for (const image of images) await image.asset.assertActive()
  let imageBase64Bytes = 0
  for (const image of images) {
    const file = image.source && settings.mapping ? mappedImageFile(image.source, settings.mapping, image.asset) : null
    if (file) image.data.file = file
    else {
      const encoded = Buffer.from(image.bytes).toString('base64')
      image.data.file = 'base64://' + encoded
      imageBase64Bytes += encoded.length
    }
  }
  for (const image of images) image.asset.assertCurrent()
  return { params: result, imageBase64Bytes }
}
