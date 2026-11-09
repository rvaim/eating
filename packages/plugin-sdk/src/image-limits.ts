import { isJsonObject, PlatformError } from './index.js'
export const MIB = 1024 * 1024
export const MAX_CONFIGURED_IMAGE_MIB = 50
export interface ImageLimits {
  readonly schemaVersion: 1
  readonly revision: number
  readonly maxImageMiB: number
  readonly imageBytes: number
  readonly batchBytes: number
  readonly encodedBytes: number
  readonly wireBytes: number
  readonly uploadBytes: number
}
export function imageLimits(maxImageMiB = 10, revision = 0): ImageLimits {
  if (!Number.isSafeInteger(maxImageMiB) || maxImageMiB < 1 || maxImageMiB > MAX_CONFIGURED_IMAGE_MIB || !Number.isSafeInteger(revision) || revision < 0) throw new PlatformError('IMAGE_LIMITS_INVALID', '单图大小需为1至50 MiB的整数。', 400, 'not-sent')
  const imageBytes = maxImageMiB * MIB, batchBytes = imageBytes * 2, encodedBytes = Math.ceil(batchBytes / 3) * 4 + 16
  return Object.freeze({ schemaVersion: 1, revision, maxImageMiB, imageBytes, batchBytes, encodedBytes, wireBytes: Math.max(encodedBytes, 4 * MIB) + MIB, uploadBytes: Math.ceil(imageBytes / 3) * 4 + MIB })
}
export const DEFAULT_IMAGE_LIMITS = imageLimits()
export function readImageLimits(value: unknown): ImageLimits {
  if (!isJsonObject(value) || value.schemaVersion !== 1 || typeof value.maxImageMiB !== 'number' || typeof value.revision !== 'number') throw new PlatformError('IMAGE_LIMITS_INVALID', '图片大小设置响应无效。', 502, 'not-sent')
  const expected = imageLimits(value.maxImageMiB, value.revision)
  if (Object.keys(expected).length !== Object.keys(value).length || Object.keys(expected).some(key => value[key] !== expected[key as keyof ImageLimits])) throw new PlatformError('IMAGE_LIMITS_INVALID', '图片大小设置响应无效。', 502, 'not-sent')
  return expected
}
