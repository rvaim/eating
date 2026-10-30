export type StickerMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface StickerItem {
  readonly assetId: string
  readonly description: string
  readonly tags: readonly string[]
  readonly mimeType: StickerMimeType
  readonly bytes: number
  readonly createdAt: string
  readonly updatedAt: string
}
export interface StickerList {
  readonly revision: number
  readonly items: readonly StickerItem[]
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly hasMore: boolean
  readonly nextOffset: number | null
}
export interface StickerTags { readonly revision: number; readonly tags: readonly { readonly tag: string; readonly count: number }[] }
export interface StickerImage { readonly data: string; readonly mimeType: StickerMimeType }
export interface StickerPreview { readonly revision: number; readonly item: StickerItem; readonly image: StickerImage }
export const STICKER_LIMITS = Object.freeze({ imageBytes: 5 * 1024 * 1024, items: 1000, libraryBytes: 256 * 1024 * 1024, description: 1000, tags: 32, uniqueTags: 2048, tagLength: 32, page: 50 })
