import { MAX_IMAGE_RESOURCE_BYTES } from '@eating/plugin-sdk'
import type { ImageMimeType, ImageResource } from '@eating/plugin-sdk'

export type ImageGenerationResponseFormat = '' | 'b64_json' | 'url'
export type ImageGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'
export type ImageGenerationSourceKind = 'received' | 'asset' | 'upload'
export interface ImageGenerationSourceSummary {
  readonly kind: ImageGenerationSourceKind
  readonly mimeType: ImageMimeType
  readonly bytes: number
  readonly assetId?: string
}
export interface ImageGenerationConfiguration {
  readonly schemaVersion: 1
  readonly revision: number
  readonly baseUrl: string
  readonly model: string
  readonly timeoutMs: number
  readonly size: string
  readonly quality: string
  readonly responseFormat: ImageGenerationResponseFormat
  readonly apiKeyConfigured: boolean
  readonly ready: boolean
}
export interface ImageGenerationConfigurationPatch {
  readonly expectedRevision: number
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly clearApiKey?: boolean
  readonly model?: string
  readonly timeoutMs?: number
  readonly size?: string
  readonly quality?: string
  readonly responseFormat?: ImageGenerationResponseFormat
}
export interface ImageGenerationParameters {
  readonly prompt: string
  readonly size?: string
  readonly quality?: string
  readonly response_format?: ImageGenerationResponseFormat
  readonly request_id: string
}
export interface ImageGenerationOwnerRequest extends ImageGenerationParameters { readonly confirmed: true }
export interface ImageGenerationJobError {
  readonly code: string
  readonly message: string
  readonly outcome: 'not-sent' | 'failed' | 'unknown'
}
export interface ImageGenerationJob {
  readonly jobId: string
  readonly requestId: string
  readonly status: ImageGenerationJobStatus
  readonly prompt: string
  readonly model: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly assetIds: readonly string[]
  readonly source?: ImageGenerationSourceSummary
  readonly error?: ImageGenerationJobError
}
export interface GeneratedImageItem {
  readonly assetId: string
  readonly prompt: string
  readonly model: string
  readonly mimeType: ImageMimeType
  readonly bytes: number
  readonly createdAt: string
}
export interface ImageGenerationPage<T> {
  readonly revision: number
  readonly items: readonly T[]
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly hasMore: boolean
  readonly nextOffset: number | null
}
export interface ImageGenerationDeleteResult {
  readonly revision: number
  readonly deletedAssetIds: readonly string[]
  readonly deletedBytes: number
}
export interface ImageGenerationSendable { readonly type: 'image'; readonly data: { readonly file: string } }
export interface ImageGenerationPreview {
  readonly item: GeneratedImageItem
  readonly image: ImageResource
  readonly sendable: ImageGenerationSendable
}
export const IMAGE_GENERATION_LIMITS = Object.freeze({
  imageBytes: MAX_IMAGE_RESOURCE_BYTES, libraryBytes: 256 * 1024 * 1024, jobs: 500, images: 500,
  page: 50, prompt: 12000, waitMs: 20000, minimumTimeoutMs: 1000, maximumTimeoutMs: 600000,
})
