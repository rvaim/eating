import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from '../types'
import type { ImageGenerationConfiguration, ImageGenerationResponseFormat } from '../types'
import { ImageStorageError, jsonBytes, prepareDirectory, readBytes, writeBytes } from './files'
import { object, safeInteger, text } from './validation'

export interface PrivateImageConfiguration {
  readonly schemaVersion: 1
  readonly revision: number
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly timeoutMs: number
  readonly size: string
  readonly quality: string
  readonly responseFormat: ImageGenerationResponseFormat
}
const defaults: PrivateImageConfiguration = { schemaVersion: 1, revision: 0, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', timeoutMs: 180000, size: '', quality: '', responseFormat: '' }
const keys = Object.keys(defaults)
const digest = (bytes: Buffer | null) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
function baseUrl(input: unknown): string {
  const value = text(input, 2048, false)
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformError('IMAGE_GENERATION_INVALID_CONFIGURATION', '请填写有效的 OpenAI Images HTTP/HTTPS 基础地址。', 400, 'not-sent') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) throw new PlatformError('IMAGE_GENERATION_INVALID_CONFIGURATION', '基础地址不能包含认证、查询参数或片段。', 400, 'not-sent')
  return url.href.replace(/\/+$/, '')
}
function configuration(value: unknown): PrivateImageConfiguration {
  if (!isJsonObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1) throw new ImageStorageError()
  const key = text(value.apiKey, 4096)
  if (/[\r\n]/.test(key) || !['', 'b64_json', 'url'].includes(String(value.responseFormat))) throw new ImageStorageError()
  return { schemaVersion: 1, revision: safeInteger(value.revision, 0, Number.MAX_SAFE_INTEGER), baseUrl: baseUrl(value.baseUrl), apiKey: key,
    model: text(value.model, 160), timeoutMs: safeInteger(value.timeoutMs, IMAGE_GENERATION_LIMITS.minimumTimeoutMs, IMAGE_GENERATION_LIMITS.maximumTimeoutMs),
    size: text(value.size, 64), quality: text(value.quality, 64), responseFormat: value.responseFormat as ImageGenerationResponseFormat }
}
export function configured(value: PrivateImageConfiguration): boolean { return Boolean(value.baseUrl && value.apiKey && value.model) }

export class ImageConfigurationStore {
  private value: PrivateImageConfiguration
  private stamp: string | null
  private readonly path: string
  constructor(directory: string) {
    this.path = join(prepareDirectory(directory), 'config.json')
    const bytes = readBytes(this.path, 64 * 1024)
    this.stamp = digest(bytes)
    try { this.value = bytes ? configuration(JSON.parse(bytes.toString('utf8'))) : { ...defaults } }
    catch { throw new PlatformError('IMAGE_GENERATION_CONFIGURATION_CORRUPTED', '生图配置格式损坏或不是当前 schema1，原文件未覆盖。', 500, 'not-sent') }
  }
  snapshot(): PrivateImageConfiguration { return { ...this.value } }
  public(ready: boolean): ImageGenerationConfiguration {
    const { apiKey, ...value } = this.value
    return { ...value, apiKeyConfigured: Boolean(apiKey), ready: ready && configured(this.value) }
  }
  update(input: unknown): PrivateImageConfiguration {
    const args = object(input, ['expectedRevision', 'baseUrl', 'apiKey', 'clearApiKey', 'model', 'timeoutMs', 'size', 'quality', 'responseFormat'], ['expectedRevision'])
    if (args.expectedRevision !== this.value.revision || !Number.isSafeInteger(args.expectedRevision)) throw new PlatformError('IMAGE_GENERATION_CONFIGURATION_CONFLICT', '生图配置已变更，请刷新后核对并重试。', 409, 'not-sent')
    if (args.clearApiKey !== undefined && typeof args.clearApiKey !== 'boolean' || args.apiKey !== undefined && typeof args.apiKey !== 'string') throw new PlatformError('IMAGE_GENERATION_INVALID_CONFIGURATION', '密钥及清除密钥选项无效。', 400, 'not-sent')
    const next = configuration({ ...this.value, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'expectedRevision' && key !== 'clearApiKey' && key !== 'apiKey')),
      apiKey: args.clearApiKey === true ? '' : typeof args.apiKey === 'string' && args.apiKey.trim() ? args.apiKey : this.value.apiKey,
      revision: this.value.revision + 1 })
    if (digest(readBytes(this.path, 64 * 1024)) !== this.stamp) throw new PlatformError('IMAGE_GENERATION_CONFIGURATION_CONFLICT', '生图配置已被其他实例修改，未覆盖原文件。', 409, 'not-sent')
    const bytes = jsonBytes(next)
    try { writeBytes(this.path, bytes) }
    catch (error) { if (error instanceof ImageStorageError && error.committed) { this.value = next; this.stamp = digest(bytes) }; throw error }
    this.value = next; this.stamp = digest(bytes)
    return this.snapshot()
  }
}
