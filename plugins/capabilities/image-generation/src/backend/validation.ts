import { createHash } from 'node:crypto'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { ImageGenerationParameters } from '../types'
import { IMAGE_GENERATION_LIMITS } from '../types'

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
export function parseGeneration(input: unknown): ImageGenerationParameters {
  const args = object(input, ['prompt', 'size', 'quality', 'response_format', 'request_id'], ['prompt', 'request_id'])
  if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(args.request_id)) invalid('需要 8 至 128 位稳定 request_id。')
  if (args.response_format !== undefined && !['', 'b64_json', 'url'].includes(String(args.response_format))) invalid('图片返回格式无效。')
  return { prompt: text(args.prompt, IMAGE_GENERATION_LIMITS.prompt, false), request_id: args.request_id,
    ...(args.size !== undefined ? { size: text(args.size, 64) } : {}), ...(args.quality !== undefined ? { quality: text(args.quality, 64) } : {}),
    ...(args.response_format !== undefined ? { response_format: args.response_format as ImageGenerationParameters['response_format'] } : {}) }
}
export function generationIntent(input: ImageGenerationParameters): JsonObject { return { prompt: input.prompt, size: input.size ?? null, quality: input.quality ?? null, responseFormat: input.response_format ?? null } }
export function generationHash(input: ImageGenerationParameters): string { return createHash('sha256').update(JSON.stringify(generationIntent(input))).digest('hex') }
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
