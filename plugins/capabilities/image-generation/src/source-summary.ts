import { isJsonObject } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from './types'
import type { ImageGenerationSourceSummary } from './types'

/** The stored source summary is also part of the public job response. */
export function isImageGenerationSourceSummary(value: unknown): value is ImageGenerationSourceSummary {
  if (!isJsonObject(value) || Object.keys(value).some(key => !['kind', 'mimeType', 'bytes', 'assetId', 'imageId', 'count'].includes(key))) return false
  const { kind, mimeType, bytes, assetId, imageId, count } = value
  return typeof kind === 'string' && ['received', 'asset', 'upload', 'persona'].includes(kind)
    && typeof mimeType === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)
    && (count === undefined || typeof count === 'number' && Number.isSafeInteger(count) && count >= 2 && count <= 4)
    && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0
    && bytes <= IMAGE_GENERATION_LIMITS.imageBytes * (typeof count === 'number' ? count : 1)
    && (kind === 'asset' ? typeof assetId === 'string' && /^[a-f0-9]{64}$/.test(assetId) : assetId === undefined)
    && (kind === 'persona' ? typeof imageId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageId) : imageId === undefined)
}
