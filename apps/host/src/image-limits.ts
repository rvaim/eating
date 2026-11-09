import { imageLimits, isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { ImageLimits } from '@eating/plugin-sdk'
import type { HostStore } from './store'
const key = 'host:image-limits'
export class ImageLimitsService {
  constructor(private readonly store: Pick<HostStore, 'getSetting' | 'setSetting'>) { this.snapshot() }
  snapshot(): ImageLimits {
    const raw = this.store.getSetting(key)
    if (raw === null) return imageLimits()
    try {
      if (raw.length > 1024) throw new Error()
      const v: unknown = JSON.parse(raw)
      if (!isJsonObject(v) || Object.keys(v).length !== 3 || v.schemaVersion !== 1 || typeof v.revision !== 'number' || typeof v.maxImageMiB !== 'number') throw new Error()
      return imageLimits(v.maxImageMiB, v.revision)
    } catch { throw new PlatformError('IMAGE_LIMITS_CORRUPTED', '图片大小设置不是有效的当前格式，原数据已保留。', 500, 'not-sent') }
  }
  save(input: unknown): ImageLimits {
    if (!isJsonObject(input) || Object.keys(input).length !== 2 || typeof input.expectedRevision !== 'number' || typeof input.maxImageMiB !== 'number') throw new PlatformError('IMAGE_LIMITS_INVALID', '请填写有效的图片大小设置。', 400, 'not-sent')
    const current = this.snapshot()
    if (current.revision !== input.expectedRevision || current.revision >= Number.MAX_SAFE_INTEGER) throw new PlatformError('IMAGE_LIMITS_CONFLICT', '图片大小设置已变化，请保留草稿并重新读取。', 409, 'not-sent')
    const next = imageLimits(input.maxImageMiB, current.revision + 1)
    this.store.setSetting(key, JSON.stringify({ schemaVersion: 1, revision: next.revision, maxImageMiB: next.maxImageMiB }))
    return next
  }
}
