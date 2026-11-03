import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { checkedImageBytes, MAX_IMAGE_RESOURCE_BYTES, PlatformError } from '@eating/plugin-sdk'
import type { ImageAssetLease, PluginImageAsset } from '@eating/plugin-sdk'

function invalid(): never { throw new PlatformError('INVALID_IMAGE_RESOURCE', '插件未返回有效、有界的图片资源。', 502, 'not-sent') }

export async function verifiedImageAsset(value: PluginImageAsset, assertAllowed: () => void): Promise<ImageAssetLease> {
  assertAllowed()
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_IMAGE_RESOURCE_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.readBytes !== 'function'
    || value.localFile !== undefined && typeof value.localFile !== 'function') invalid()
  const { mimeType, byteLength, sha256 } = value
  const readBytes = async (): Promise<Uint8Array> => {
    assertAllowed()
    const bytes = checkedImageBytes(await value.readBytes(), mimeType)
    assertAllowed()
    if (bytes.byteLength !== byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) invalid()
    return bytes
  }
  await readBytes()
  return Object.freeze({ mimeType, byteLength, sha256, readBytes, assertCurrent: assertAllowed,
    assertActive: async () => { await readBytes(); assertAllowed() },
    ...(value.localFile ? { localFile: async () => {
      assertAllowed()
      const path = await value.localFile!()
      assertAllowed()
      if (typeof path !== 'string' || path.length > 8192 || !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) invalid()
      await readBytes()
      return path
    } } : {}),
  })
}
