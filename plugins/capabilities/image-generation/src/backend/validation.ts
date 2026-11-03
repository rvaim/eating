import { createHash } from 'node:crypto'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { ImageGenerationParameters, ImageGenerationSourceKind } from '../types'
import { IMAGE_GENERATION_LIMITS } from '../types'

export interface ImageSourceReference {
  readonly kind: 'received' | 'asset'
  readonly messageId?: string
  readonly imageId?: string
  readonly assetId?: string
}
export interface ResolvedSourceImage {
  readonly kind: ImageGenerationSourceKind
  readonly mimeType: import('@eating/plugin-sdk').ImageMimeType
  readonly bytes: Buffer
  readonly hash: string
  readonly assetId?: string
}

export function invalid(message = '生图参数不完整或包含不支持的字段。'): never { throw new PlatformError('IMAGE_GENERATION_INVALID_INPUT', message, 400, 'not-sent') }
export function object(input: unknown, allowed: readonly string[], required: readonly string[] = []): JsonObject {
  if (!isJsonObject(input) || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) invalid()
  return input
}
export function text(value: unknown, maximum: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid('文本参数格式或长度无效。')
  const normalized = value.trim()
  if (!allowEmpty && !normalized) invalid('请填写非空的模型或提示词。')
  return normalized
}
export function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('数值参数不在允许范围内。')
  return value
}
export function imageSize(value: unknown): string {
  const size = text(value, 64)
  if (!size || /^(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]*$/.test(size) && !/(?:\d|NaN|Infinity)x|x(?:\d|NaN|Infinity)/i.test(size)) return size
  const dimensions = /^([1-9]\d*)x([1-9]\d*)$/.exec(size)
  if (!dimensions || !dimensions.slice(1).every(dimension => Number.isSafeInteger(Number(dimension)))) {
    throw new PlatformError('IMAGE_GENERATION_INVALID_SIZE', '尺寸须为正整数宽x高（例如 1536x1024）或服务支持的尺寸关键字；留空使用服务默认值。', 400, 'not-sent')
  }
  return size
}
export function parseGeneration(input: unknown): ImageGenerationParameters {
  const args = object(input, ['prompt', 'size', 'quality', 'response_format', 'request_id'], ['prompt', 'request_id'])
  if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(args.request_id)) invalid('需要 8 至 128 位稳定 request_id。')
  if (args.response_format !== undefined && !['', 'b64_json', 'url'].includes(String(args.response_format))) invalid('图片返回格式无效。')
  return { prompt: text(args.prompt, IMAGE_GENERATION_LIMITS.prompt, false), request_id: args.request_id,
    ...(args.size !== undefined ? { size: imageSize(args.size) } : {}), ...(args.quality !== undefined ? { quality: text(args.quality, 64) } : {}),
    ...(args.response_format !== undefined ? { response_format: args.response_format as ImageGenerationParameters['response_format'] } : {}) }
}
function reference(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label}格式或长度无效。`)
  return value
}
/** Model-facing reference: only a current communication message image or this plugin's own asset. */
export function parseSourceReference(input: unknown): ImageSourceReference {
  const args = object(input, ['kind', 'messageId', 'imageId', 'assetId'], ['kind'])
  if (args.kind === 'received') {
    if (args.assetId !== undefined) invalid('收到图片只能提供 messageId 与 imageId。')
    return { kind: 'received', messageId: reference(args.messageId, 160, '消息 ID '), imageId: reference(args.imageId, 2048, '图片引用 ') }
  }
  if (args.kind === 'asset') {
    if (args.messageId !== undefined || args.imageId !== undefined) invalid('已有图片只能提供 assetId。')
    return { kind: 'asset', assetId: assetIdentifier(args.assetId) }
  }
  invalid('图片来源只能是 received 或 asset。')
}
export function generationIntent(input: ImageGenerationParameters, sourceHash: string | null = null): JsonObject { return { prompt: input.prompt, size: input.size ?? null, quality: input.quality ?? null, responseFormat: input.response_format ?? null, ...(sourceHash ? { sourceHash } : {}) } }
export function generationHash(input: ImageGenerationParameters, sourceHash: string | null = null): string { return createHash('sha256').update(JSON.stringify(generationIntent(input, sourceHash))).digest('hex') }
export function pageInput(input: unknown) {
  const args = object(input, ['offset', 'limit'])
  return { offset: args.offset === undefined ? 0 : safeInteger(args.offset, 0, Number.MAX_SAFE_INTEGER), limit: args.limit === undefined ? 20 : safeInteger(args.limit, 1, IMAGE_GENERATION_LIMITS.page) }
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) invalid('任务 ID 无效。')
  return value
}
export function assetIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('图片资源 ID 无效。')
  return value
}
