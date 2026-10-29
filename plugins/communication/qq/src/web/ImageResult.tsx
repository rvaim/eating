import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { HostApiError, useI18n } from '@eating/ui-sdk'

export interface ImagePreviewResult {
  readonly parts: readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly blob: Blob })[]
  readonly metadata: JsonObject
}
const mimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const maxBytes = 5 * 1024 * 1024
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }

/** Decode only declared image content. Base64 never enters the ordinary execution model. */
export function readImagePreview(value: unknown): ImagePreviewResult {
  if (!isJsonObject(value) || Object.keys(value).some(key => !['content', 'structuredContent'].includes(key)) || !Array.isArray(value.content) || !value.content.length || value.content.length > 32) return invalid()
  let bytes = 0, textSize = 0
  const parts: ImagePreviewResult['parts'] = value.content.map(part => {
    if (!isJsonObject(part)) return invalid()
    if (part.type === 'text') {
      if (Object.keys(part).some(key => !['type', 'text'].includes(key)) || typeof part.text !== 'string' || (textSize += part.text.length) > 128_000) return invalid()
      return { type: 'text', text: part.text }
    }
    if (part.type !== 'image' || Object.keys(part).some(key => !['type', 'mimeType', 'data'].includes(key))
      || !mimeTypes.includes(part.mimeType as typeof mimeTypes[number]) || typeof part.data !== 'string' || !part.data.length
      || part.data.length > Math.ceil(maxBytes / 3) * 4 || part.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(part.data)) return invalid()
    let decoded: string
    try { decoded = atob(part.data); if (btoa(decoded) !== part.data) return invalid() } catch { return invalid() }
    bytes += decoded.length
    if (bytes > maxBytes) return invalid()
    const data = Uint8Array.from(decoded, character => character.charCodeAt(0))
    const matches = part.mimeType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte)
      : part.mimeType === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : part.mimeType === 'image/gif' ? /^GIF8[79]a/u.test(decoded.slice(0, 6))
      : decoded.slice(0, 4) === 'RIFF' && decoded.slice(8, 12) === 'WEBP'
    if (!matches) return invalid()
    return { type: 'image', blob: new Blob([data], { type: part.mimeType as string }) }
  })
  if (!parts.some(part => part.type === 'image')) return invalid()
  const metadata: JsonObject = {}
  if (value.structuredContent !== undefined) {
    const structured = value.structuredContent
    if (!isJsonObject(structured) || Object.keys(structured).some(key => !['mimeType', 'bytes', 'messageId', 'imageId'].includes(key))) return invalid()
    if (structured.mimeType !== undefined && !mimeTypes.includes(structured.mimeType as typeof mimeTypes[number])
      || structured.bytes !== undefined && (typeof structured.bytes !== 'number' || !Number.isSafeInteger(structured.bytes) || structured.bytes < 1 || structured.bytes > maxBytes)
      || structured.messageId !== undefined && (typeof structured.messageId !== 'string' || !/^-?\d{1,160}$/u.test(structured.messageId))
      || structured.imageId !== undefined && (typeof structured.imageId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(structured.imageId))) return invalid()
    Object.assign(metadata, structured)
  }
  return { parts, metadata }
}

function PreviewImage({ blob }: { readonly blob: Blob }) {
  const { t } = useI18n('qq')
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const next = URL.createObjectURL(blob); setUrl(next); setFailed(false)
    return () => { URL.revokeObjectURL(next) }
  }, [blob])
  return failed ? <p className="qq-error" role="alert">{t('image.invalid')}</p> : url ? <img className="qq-result-image" src={url} alt={t('image.previewAlt')} onError={() => setFailed(true)} /> : null
}

export function ImageResult({ result, onClear }: { readonly result: ImagePreviewResult; readonly onClear: () => void }) {
  const { t } = useI18n('qq')
  return <section className="qq-image-result" aria-label={t('image.previewTitle')}>
    <div className="qq-execution-heading"><h4>{t('image.previewTitle')}</h4><button type="button" className="button button-secondary" onClick={onClear}>{t('image.clear')}</button></div>
    <p className="qq-help">{t('image.previewHelp')}</p>
    <div className="qq-image-parts">{result.parts.map((part, index) => part.type === 'image' ? <PreviewImage key={index} blob={part.blob} /> : <p key={index} dir="auto">{part.text}</p>)}</div>
    {Object.keys(result.metadata).length > 0 && <details><summary>{t('image.metadata')}</summary><pre className="qq-image-metadata">{JSON.stringify(result.metadata, null, 2)}</pre></details>}
    <p className="qq-help"><AlertCircle size={13} aria-hidden="true" /> {t('image.safeResult')}</p>
  </section>
}
