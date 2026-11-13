import { isJsonObject } from '@eating/plugin-sdk'
import type { ImageMimeType, JsonObject } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import type {
  GeneratedImageItem, ImageGenerationConfiguration, ImageGenerationJob, ImageGenerationJobError,
  ImageGenerationDeleteResult, ImageGenerationPage, ImageGenerationPreview, ImageGenerationResponseFormat, ImageGenerationSourceKind, ImageGenerationSourceSummary,
  ImageRequestParametersConfiguration,
} from '../types'
import { parseRequestParameters } from '../request-parameters'
import { IMAGE_GENERATION_LIMITS } from '../types'
import { it } from './i18n'
import type { ImageGenerationTranslationKey } from './i18n'

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const nonEmpty = (value: unknown, max: number): value is string => text(value, max) && value.length > 0
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const formats: readonly ImageGenerationResponseFormat[] = ['', 'b64_json', 'url']
const statuses = ['queued', 'running', 'succeeded', 'failed', 'unknown'] as const
const sourceKinds: readonly ImageGenerationSourceKind[] = ['received', 'asset', 'upload']
const mimeTypes: readonly ImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function readConfiguration(value: unknown): ImageGenerationConfiguration {
  if (!isJsonObject(value) || !onlyKeys(value, ['schemaVersion', 'revision', 'baseUrl', 'model', 'timeoutMs', 'size', 'quality', 'responseFormat', 'apiKeyConfigured', 'ready'])
    || value.schemaVersion !== 1 || !integer(value.revision) || !nonEmpty(value.baseUrl, 4096) || !text(value.model, 200)
    || !integer(value.timeoutMs, IMAGE_GENERATION_LIMITS.maximumTimeoutMs) || value.timeoutMs < IMAGE_GENERATION_LIMITS.minimumTimeoutMs
    || !text(value.size, 200) || !text(value.quality, 200) || !formats.includes(value.responseFormat as ImageGenerationResponseFormat)
    || typeof value.apiKeyConfigured !== 'boolean' || typeof value.ready !== 'boolean') return invalid()
  return { schemaVersion: 1, revision: value.revision, baseUrl: value.baseUrl, model: value.model, timeoutMs: value.timeoutMs,
    size: value.size, quality: value.quality, responseFormat: value.responseFormat as ImageGenerationResponseFormat,
    apiKeyConfigured: value.apiKeyConfigured, ready: value.ready }
}
export function readRequestParameters(value: unknown): ImageRequestParametersConfiguration {
  if (!isJsonObject(value) || !onlyKeys(value, ['schemaVersion', 'revision', 'parameters']) || value.schemaVersion !== 1 || !integer(value.revision)) return invalid()
  try { return { schemaVersion: 1, revision: value.revision, parameters: parseRequestParameters(value.parameters) } } catch { return invalid() }
}

function readError(value: unknown): ImageGenerationJobError {
  if (!isJsonObject(value) || !onlyKeys(value, ['code', 'message', 'outcome']) || !nonEmpty(value.code, 160) || !text(value.message, 4000)
    || !['not-sent', 'failed', 'unknown'].includes(String(value.outcome))) return invalid()
  return { code: value.code, message: value.message, outcome: value.outcome as ImageGenerationJobError['outcome'] }
}

function readSource(value: unknown): ImageGenerationSourceSummary {
  if (!isJsonObject(value) || !onlyKeys(value, ['kind', 'mimeType', 'bytes', 'assetId'])
    || !sourceKinds.includes(value.kind as ImageGenerationSourceKind) || !mimeTypes.includes(value.mimeType as ImageMimeType)
    || !integer(value.bytes, IMAGE_GENERATION_LIMITS.imageBytes) || value.bytes < 1
    || (value.kind === 'asset' ? !nonEmpty(value.assetId, 160) : value.assetId !== undefined)) return invalid()
  return { kind: value.kind as ImageGenerationSourceKind, mimeType: value.mimeType as ImageMimeType, bytes: value.bytes,
    ...(value.kind === 'asset' ? { assetId: value.assetId as string } : {}) }
}

export function readJob(value: unknown): ImageGenerationJob {
  if (!isJsonObject(value) || !onlyKeys(value, ['jobId', 'requestId', 'status', 'prompt', 'model', 'createdAt', 'updatedAt', 'assetIds', 'source', 'error'])
    || !nonEmpty(value.jobId, 160) || !nonEmpty(value.requestId, 128) || !statuses.includes(value.status as (typeof statuses)[number])
    || !nonEmpty(value.prompt, IMAGE_GENERATION_LIMITS.prompt) || !text(value.model, 200) || !date(value.createdAt) || !date(value.updatedAt)
    || !Array.isArray(value.assetIds) || value.assetIds.length > IMAGE_GENERATION_LIMITS.images || value.assetIds.some(assetId => !nonEmpty(assetId, 160))
    || new Set(value.assetIds).size !== value.assetIds.length
    || value.source !== undefined && (!isJsonObject(value.source) || !readSource(value.source))
    || value.error !== undefined && (!isJsonObject(value.error) || !readError(value.error))) return invalid()
  return { jobId: value.jobId, requestId: value.requestId, status: value.status as ImageGenerationJob['status'], prompt: value.prompt,
    model: value.model, createdAt: value.createdAt, updatedAt: value.updatedAt, assetIds: [...value.assetIds] as string[],
    ...(value.source !== undefined ? { source: readSource(value.source) } : {}),
    ...(value.error !== undefined ? { error: readError(value.error) } : {}) }
}

export function readAsset(value: unknown): GeneratedImageItem {
  if (!isJsonObject(value) || !onlyKeys(value, ['assetId', 'prompt', 'model', 'mimeType', 'bytes', 'createdAt'])
    || !nonEmpty(value.assetId, 160) || !nonEmpty(value.prompt, IMAGE_GENERATION_LIMITS.prompt) || !text(value.model, 200)
    || !mimeTypes.includes(value.mimeType as ImageMimeType) || !integer(value.bytes, IMAGE_GENERATION_LIMITS.imageBytes) || value.bytes < 1
    || !date(value.createdAt)) return invalid()
  return { assetId: value.assetId, prompt: value.prompt, model: value.model, mimeType: value.mimeType as ImageMimeType, bytes: value.bytes, createdAt: value.createdAt }
}

function readPage<T>(value: unknown, readItem: (entry: unknown) => T): ImageGenerationPage<T> {
  if (!isJsonObject(value) || !onlyKeys(value, ['revision', 'items', 'offset', 'limit', 'total', 'hasMore', 'nextOffset']) || !integer(value.revision)
    || !Array.isArray(value.items) || value.items.length > IMAGE_GENERATION_LIMITS.page
    || !integer(value.offset) || !integer(value.limit) || value.limit < 1 || value.limit > IMAGE_GENERATION_LIMITS.page
    || !integer(value.total) || typeof value.hasMore !== 'boolean'
    || value.nextOffset !== null && !integer(value.nextOffset)) return invalid()
  const items = value.items.map(readItem)
  if (items.length > value.limit || value.hasMore !== (value.offset + items.length < value.total)
    || value.nextOffset !== (value.hasMore ? value.offset + items.length : null)) return invalid()
  return { revision: value.revision, items, offset: value.offset, limit: value.limit, total: value.total, hasMore: value.hasMore, nextOffset: value.nextOffset as number | null }
}
export function readDeleteResult(value: unknown): ImageGenerationDeleteResult {
  if (!isJsonObject(value) || !onlyKeys(value, ['revision', 'deletedAssetIds', 'deletedBytes']) || !integer(value.revision) || !integer(value.deletedBytes)
    || !Array.isArray(value.deletedAssetIds) || !value.deletedAssetIds.length || value.deletedAssetIds.length > IMAGE_GENERATION_LIMITS.page
    || value.deletedAssetIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(value.deletedAssetIds).size !== value.deletedAssetIds.length) return invalid()
  return { revision: value.revision, deletedAssetIds: value.deletedAssetIds as string[], deletedBytes: value.deletedBytes }
}
export function readJobPage(value: unknown): ImageGenerationPage<ImageGenerationJob> { return readPage(value, readJob) }
export function readAssetPage(value: unknown): ImageGenerationPage<GeneratedImageItem> { return readPage(value, readAsset) }

export function readPreview(value: unknown): ImageGenerationPreview {
  if (!isJsonObject(value) || !onlyKeys(value, ['item', 'image', 'sendable']) || !isJsonObject(value.image)
    || !onlyKeys(value.image, ['mimeType', 'data']) || !mimeTypes.includes(value.image.mimeType as ImageMimeType)
    || typeof value.image.data !== 'string' || !value.image.data || value.image.data.length > Math.ceil(IMAGE_GENERATION_LIMITS.imageBytes / 3) * 4
    || value.image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.image.data)
    || !isJsonObject(value.sendable) || value.sendable.type !== 'image' || !isJsonObject(value.sendable.data)
    || typeof value.sendable.data.file !== 'string' || !value.sendable.data.file) return invalid()
  return { item: readAsset(value.item), image: { mimeType: value.image.mimeType as ImageMimeType, data: value.image.data },
    sendable: { type: 'image', data: { file: value.sendable.data.file } } }
}

export function imageBlob(image: { readonly mimeType: ImageMimeType; readonly data: string }): Blob {
  const binary = atob(image.data)
  if (!binary.length || btoa(binary) !== image.data) invalid()
  return new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: image.mimeType })
}

export interface ImageGenerationUpload { readonly mimeType: ImageMimeType; readonly data: string }
export async function localImage(file: File, maximum = 10 * 1024 * 1024): Promise<ImageGenerationUpload> {
  const declared = file.type === 'image/jpg' ? 'image/jpeg' : file.type
  const mime = declared || (/\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.gif$/i.test(file.name) ? 'image/gif' : /\.webp$/i.test(file.name) ? 'image/webp' : '')
  if (!file.size || file.size > maximum || !mimeTypes.includes(mime as ImageMimeType)) throw new HostApiError('IMAGE_GENERATION_INVALID_SOURCE_IMAGE', it('generate.sourceInvalid'), 'not-sent')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size) invalid()
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return { mimeType: mime as ImageMimeType, data: btoa(binary) }
}

export async function fetchConfiguration(signal?: AbortSignal): Promise<ImageGenerationConfiguration> {
  return readConfiguration(await hostRequest<unknown>('/plugins/image-generation/configuration', { signal }))
}
export async function updateConfiguration(patch: JsonObject, signal?: AbortSignal): Promise<ImageGenerationConfiguration> {
  return readConfiguration(await hostRequest<unknown>('/plugins/image-generation/configuration', { method: 'POST', body: patch, signal }))
}
export async function manage(operation: 'generate' | 'job' | 'jobs' | 'list' | 'get' | 'delete' | 'request-parameters' | 'save-request-parameters', input: JsonObject, signal?: AbortSignal): Promise<unknown> {
  return hostRequest<unknown>('/plugins/image-generation/manage', { method: 'POST', body: { operation, input }, signal })
}

const errorKeys: Readonly<Record<string, ImageGenerationTranslationKey>> = {
  IMAGE_REQUEST_PARAMETERS_INVALID: 'parameters.invalid',
  IMAGE_REQUEST_PARAMETERS_CORRUPTED: 'parameters.corrupted',
  IMAGE_REQUEST_PARAMETERS_CONFLICT: 'parameters.conflict',
  IMAGE_GENERATION_BUSY: 'error.busy',
  IMAGE_GENERATION_REVISION_CONFLICT: 'error.listChanged',
  IMAGE_GENERATION_DELETE_CONFIRMATION_REQUIRED: 'error.deleteConfirmation',
  IMAGE_GENERATION_DELETE_INCOMPLETE: 'error.deleteIncomplete',
  IMAGE_GENERATION_INVALID_INPUT: 'error.invalidInput',
  IMAGE_GENERATION_INVALID_SIZE: 'error.invalidSize',
  IMAGE_GENERATION_INVALID_CONFIGURATION: 'error.invalidConfiguration',
  IMAGE_GENERATION_CONFIGURATION_CONFLICT: 'error.configConflict',
  IMAGE_GENERATION_CONFIGURATION_CORRUPTED: 'error.configCorrupted',
  IMAGE_GENERATION_INVALID_IMAGE: 'error.invalidImage',
  IMAGE_GENERATION_INVALID_SOURCE_IMAGE: 'error.invalidSourceImage',
  IMAGE_GENERATION_SOURCE_DENIED: 'error.sourceDenied',
  IMAGE_GENERATION_RESOURCE_UNAVAILABLE: 'error.sourceUnavailable',
  IMAGE_GENERATION_CANCELLED: 'error.cancelled',
  IMAGE_GENERATION_REDIRECT_REFUSED: 'error.redirect',
  IMAGE_GENERATION_HTTP_401: 'error.http401',
  IMAGE_GENERATION_HTTP_429: 'error.http429',
  IMAGE_GENERATION_HTTP_FAILED: 'error.httpFailed',
  IMAGE_GENERATION_TIMEOUT: 'error.timeout',
  IMAGE_GENERATION_NETWORK_ERROR: 'error.network',
  IMAGE_GENERATION_INVALID_RESPONSE: 'error.invalidResponse',
  IMAGE_GENERATION_RESPONSE_TOO_LARGE: 'error.responseTooLarge',
  IMAGE_GENERATION_DOWNLOAD_FAILED: 'error.downloadFailed',
  IMAGE_GENERATION_CAPACITY_REACHED: 'error.capacity',
  IMAGE_GENERATION_JOB_NOT_FOUND: 'error.jobNotFound',
  IMAGE_GENERATION_IMAGE_NOT_FOUND: 'error.imageNotFound',
  IMAGE_GENERATION_STORAGE_FAILED: 'error.storage',
  IMAGE_GENERATION_STATE_CORRUPTED: 'error.stateCorrupted',
  IMAGE_GENERATION_STATE_CONFLICT: 'error.stateConflict',
  IMAGE_GENERATION_IDEMPOTENCY_CONFLICT: 'error.idempotencyConflict',
  IMAGE_GENERATION_INTERRUPTED: 'error.interrupted',
}

/** Translate fixed backend errors by code; user text is never translated. */
export function errorTextFrom(error: unknown, fallback: string): string {
  const code = error instanceof HostApiError ? error.code : ''
  if (!code) return fallback
  const mapped = errorKeys[code]
  if (mapped) return it(mapped)
  const http = /^IMAGE_GENERATION_HTTP_(\d{3})$/.exec(code)
  if (http) return it('error.http', { status: http[1]! })
  return fallback
}

export function jobErrorText(error: ImageGenerationJobError): string {
  const mapped = errorKeys[error.code]
  if (mapped) return it(mapped)
  const http = /^IMAGE_GENERATION_HTTP_(\d{3})$/.exec(error.code)
  if (http) return it('error.http', { status: http[1]! })
  return it('error.generic')
}
