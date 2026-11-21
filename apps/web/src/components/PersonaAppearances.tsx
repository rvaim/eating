import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Expand, ImagePlus, Trash2, X } from 'lucide-react'
import { MAX_PERSONA_APPEARANCE_IMAGES, MAX_PERSONA_APPEARANCE_LABEL_LENGTH } from '@eating/plugin-sdk'
import type { PersonaAppearanceImageSummary } from '@eating/plugin-sdk'
import { HostApiError, formatNumber, hostRequest, useI18n } from '@eating/ui-sdk'
import '../i18n/authoring'

interface PersonaAppearancesSnapshot {
  readonly protocolVersion: 1
  readonly personaId: string
  readonly revision: number
  readonly maxImages: number
  readonly images: readonly PersonaAppearanceImageSummary[]
}

export interface PersonaAppearancesProps {
  readonly personaId: string | null
  readonly active: boolean
  readonly onChanged?: () => void
}

type UploadProgress = {
  readonly done: number
  readonly total: number
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Failed to read image file'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

export function PersonaAppearances({ personaId, active, onChanged }: PersonaAppearancesProps) {
  const { t } = useI18n('authoring')
  const headingId = useId()
  const lightboxTitleId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lightboxDialogRef = useRef<HTMLDialogElement>(null)
  const triggerBeforeLightboxRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(true)
  const currentPersonaRef = useRef<string | null>(personaId)
  currentPersonaRef.current = personaId

  const [snapshot, setSnapshot] = useState<PersonaAppearancesSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({})
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [lightboxImageId, setLightboxImageId] = useState<string | null>(null)
  const maxImagesRef = useRef(MAX_PERSONA_APPEARANCE_IMAGES)
  maxImagesRef.current = snapshot?.maxImages ?? MAX_PERSONA_APPEARANCE_IMAGES
  const tRef = useRef(t)
  tRef.current = t

  const syncSnapshot = useCallback((next: PersonaAppearancesSnapshot) => {
    setSnapshot(next)
    setLabelDrafts(previous => {
      const updated: Record<string, string> = {}
      for (const item of next.images) {
        updated[item.id] = previous[item.id] ?? item.label
      }
      return updated
    })
    setLightboxImageId(previous => (previous && next.images.some(item => item.id === previous) ? previous : null))
    setConfirmDeleteId(previous => (previous && next.images.some(item => item.id === previous) ? previous : null))
  }, [])

  const applyServerSnapshot = useCallback((next: PersonaAppearancesSnapshot) => {
    setSnapshot(next)
    setLabelDrafts(Object.fromEntries(next.images.map(item => [item.id, item.label])))
    setLightboxImageId(previous => (previous && next.images.some(item => item.id === previous) ? previous : null))
    setConfirmDeleteId(previous => (previous && next.images.some(item => item.id === previous) ? previous : null))
  }, [])

  const mapError = useCallback((error: unknown, maxLimit?: number): string => {
    const translate = tRef.current
    const limit = maxLimit ?? maxImagesRef.current
    if (error instanceof HostApiError) {
      switch (error.code) {
        case 'PERSONA_APPEARANCE_CONFLICT':
          return translate('appearances.errorConflict')
        case 'PERSONA_APPEARANCE_LIMIT_REACHED':
          return translate('appearances.errorLimit', { max: formatNumber(limit) })
        case 'IMAGE_TOO_LARGE':
          return translate('appearances.errorTooLarge')
        case 'INVALID_PERSONA_APPEARANCE_IMAGE':
          return translate('appearances.errorInvalidImage')
        case 'PERSONA_APPEARANCE_NOT_FOUND':
          return translate('appearances.errorNotFound')
        default:
          return error.message || translate('appearances.errorGeneric')
      }
    }
    return translate('appearances.errorGeneric')
  }, [])

  const loadAppearances = useCallback(async (targetId: string, signal?: AbortSignal) => {
    setLoading(true)
    setErrorMessage(null)
    try {
      const result = await hostRequest<PersonaAppearancesSnapshot>(`/personas/${encodeURIComponent(targetId)}/appearances`, { signal })
      if (!mountedRef.current || currentPersonaRef.current !== targetId) return
      applyServerSnapshot(result)
    } catch (error) {
      if (!mountedRef.current || currentPersonaRef.current !== targetId || signal?.aborted) return
      setErrorMessage(mapError(error))
    } finally {
      if (mountedRef.current && currentPersonaRef.current === targetId) setLoading(false)
    }
  }, [applyServerSnapshot, mapError])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    setSnapshot(null)
    setLabelDrafts({})
    setConfirmDeleteId(null)
    setLightboxImageId(null)
    setErrorMessage(null)
    setUploadProgress(null)
    setBusyKey(null)
    if (!personaId) return
    const controller = new AbortController()
    void loadAppearances(personaId, controller.signal)
    return () => controller.abort()
  }, [loadAppearances, personaId])

  const images = snapshot?.images ?? []
  const maxImages = snapshot?.maxImages ?? MAX_PERSONA_APPEARANCE_IMAGES
  const lightboxIndex = lightboxImageId ? images.findIndex(item => item.id === lightboxImageId) : -1
  const lightboxImage = lightboxIndex >= 0 ? images[lightboxIndex]! : null

  const closeLightbox = useCallback(() => {
    setLightboxImageId(null)
    const trigger = triggerBeforeLightboxRef.current
    triggerBeforeLightboxRef.current = null
    if (trigger && trigger.isConnected) {
      requestAnimationFrame(() => trigger.focus())
    }
  }, [])

  useEffect(() => {
    const dialog = lightboxDialogRef.current
    if (!dialog) return
    if (lightboxImage) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [lightboxImage])

  const busy = loading || busyKey !== null || uploadProgress !== null

  async function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    const targetPersonaId = personaId
    const fileList = event.target.files
    const files = fileList ? Array.from(fileList) : []
    event.target.value = ''
    if (!targetPersonaId || files.length === 0 || busy) return
    const currentSnapshot = snapshot
    if (!currentSnapshot) return

    if (currentSnapshot.images.length + files.length > currentSnapshot.maxImages) {
      setErrorMessage(t('appearances.errorLimit', { max: formatNumber(currentSnapshot.maxImages) }))
      return
    }

    setErrorMessage(null)
    setConfirmDeleteId(null)
    setUploadProgress({ done: 0, total: files.length })

    let latest = currentSnapshot
    let changed = false
    try {
      for (let index = 0; index < files.length; index++) {
        if (!mountedRef.current || currentPersonaRef.current !== targetPersonaId) return
        setUploadProgress({ done: index + 1, total: files.length })
        const file = files[index]!
        const dataUrl = await readFileAsDataUrl(file)
        if (!mountedRef.current || currentPersonaRef.current !== targetPersonaId) return
        const next = await hostRequest<PersonaAppearancesSnapshot>(`/personas/${encodeURIComponent(targetPersonaId)}/appearances`, {
          method: 'POST',
          body: { data: dataUrl, expectedRevision: latest.revision },
        })
        if (!mountedRef.current || currentPersonaRef.current !== targetPersonaId) return
        latest = next
        changed = true
        syncSnapshot(next)
      }
      if (changed) onChanged?.()
    } catch (error) {
      if (!mountedRef.current || currentPersonaRef.current !== targetPersonaId) return
      setErrorMessage(mapError(error, latest.maxImages))
      if (error instanceof HostApiError && (error.code === 'PERSONA_APPEARANCE_CONFLICT' || error.code === 'PERSONA_APPEARANCE_NOT_FOUND')) {
        void loadAppearances(targetPersonaId)
      } else if (changed) {
        onChanged?.()
      }
    } finally {
      if (mountedRef.current && currentPersonaRef.current === targetPersonaId) {
        setUploadProgress(null)
      }
    }
  }

  async function saveLabel(image: PersonaAppearanceImageSummary) {
    if (!personaId || !snapshot || busy) return
    const draft = (labelDrafts[image.id] ?? '').trim()
    if (draft.length > MAX_PERSONA_APPEARANCE_LABEL_LENGTH) {
      setErrorMessage(t('appearances.errorInvalidImage'))
      return
    }
    setBusyKey(`label:${image.id}`)
    setErrorMessage(null)
    try {
      const next = await hostRequest<PersonaAppearancesSnapshot>(`/personas/${encodeURIComponent(personaId)}/appearances/${encodeURIComponent(image.id)}/label`, {
        method: 'POST',
        body: { label: draft, expectedRevision: snapshot.revision },
      })
      if (!mountedRef.current || currentPersonaRef.current !== personaId) return
      syncSnapshot(next)
      setLabelDrafts(previous => ({ ...previous, [image.id]: draft }))
      onChanged?.()
    } catch (error) {
      if (!mountedRef.current || currentPersonaRef.current !== personaId) return
      setErrorMessage(mapError(error))
      if (error instanceof HostApiError && (error.code === 'PERSONA_APPEARANCE_CONFLICT' || error.code === 'PERSONA_APPEARANCE_NOT_FOUND')) {
        void loadAppearances(personaId)
      }
    } finally {
      if (mountedRef.current && currentPersonaRef.current === personaId) setBusyKey(null)
    }
  }

  async function moveImage(index: number, delta: -1 | 1) {
    if (!personaId || !snapshot || busy) return
    const targetIndex = index + delta
    if (targetIndex < 0 || targetIndex >= snapshot.images.length) return
    const reordered = [...snapshot.images]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(targetIndex, 0, moved!)
    setBusyKey(`reorder:${moved!.id}`)
    setErrorMessage(null)
    try {
      const next = await hostRequest<PersonaAppearancesSnapshot>(`/personas/${encodeURIComponent(personaId)}/appearances/reorder`, {
        method: 'POST',
        body: { imageIds: reordered.map(item => item.id), expectedRevision: snapshot.revision },
      })
      if (!mountedRef.current || currentPersonaRef.current !== personaId) return
      syncSnapshot(next)
      onChanged?.()
    } catch (error) {
      if (!mountedRef.current || currentPersonaRef.current !== personaId) return
      setErrorMessage(mapError(error))
      if (error instanceof HostApiError && (error.code === 'PERSONA_APPEARANCE_CONFLICT' || error.code === 'PERSONA_APPEARANCE_NOT_FOUND')) {
        void loadAppearances(personaId)
      }
    } finally {
      if (mountedRef.current && currentPersonaRef.current === personaId) setBusyKey(null)
    }
  }

  async function confirmDelete(imageId: string) {
    if (!personaId || !snapshot || busy) return
    setBusyKey(`delete:${imageId}`)
    setErrorMessage(null)
    try {
      const next = await hostRequest<PersonaAppearancesSnapshot>(`/personas/${encodeURIComponent(personaId)}/appearances/${encodeURIComponent(imageId)}/delete`, {
        method: 'POST',
        body: { confirmed: true, expectedRevision: snapshot.revision },
      })
      if (!mountedRef.current || currentPersonaRef.current !== personaId) return
      applyServerSnapshot(next)
      onChanged?.()
    } catch (error) {
      if (!mountedRef.current || currentPersonaRef.current !== personaId) return
      setErrorMessage(mapError(error))
      if (error instanceof HostApiError && (error.code === 'PERSONA_APPEARANCE_CONFLICT' || error.code === 'PERSONA_APPEARANCE_NOT_FOUND')) {
        void loadAppearances(personaId)
      }
    } finally {
      if (mountedRef.current && currentPersonaRef.current === personaId) setBusyKey(null)
    }
  }

  function handleLightboxKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (!lightboxImage) return
    if (event.key === 'ArrowLeft' && lightboxIndex > 0) {
      event.preventDefault()
      setLightboxImageId(images[lightboxIndex - 1]!.id)
    } else if (event.key === 'ArrowRight' && lightboxIndex < images.length - 1) {
      event.preventDefault()
      setLightboxImageId(images[lightboxIndex + 1]!.id)
    }
  }

  return (
    <section className="authoring-appearances" aria-labelledby={headingId}>
      <div className="authoring-appearances-head">
        <div>
          <div className="authoring-appearances-title-row">
            <h3 id={headingId}>{t('appearances.title')}</h3>
            <span className="authoring-appearances-count">
              {t('appearances.count', { countText: formatNumber(images.length), max: formatNumber(maxImages) })}
            </span>
            <span className={`authoring-appearances-badge${active ? ' active' : ''}`}>
              {t(active ? 'appearances.badgeActive' : 'appearances.badgeInactive')}
            </span>
          </div>
          <p className="authoring-appearances-desc">{t('appearances.description')}</p>
        </div>
        {personaId && (
          <div className="authoring-appearances-upload-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy || images.length >= maxImages}
              className="authoring-appearances-file-input"
              aria-label={t('appearances.upload')}
              onChange={handleFileSelect}
            />
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || images.length >= maxImages || snapshot === null}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={15} aria-hidden="true" />
              {uploadProgress
                ? t('appearances.uploading', { done: formatNumber(uploadProgress.done), total: formatNumber(uploadProgress.total) })
                : t('appearances.upload')}
            </button>
          </div>
        )}
      </div>

      {!personaId ? (
        <p className="authoring-field-hint">{t('appearances.unsavedHint')}</p>
      ) : (
        <>
          <p className="authoring-field-hint">{t('appearances.uploadHint', { max: formatNumber(maxImages) })}</p>

          {errorMessage && (
            <div className="authoring-appearances-error" role="alert">
              <span>{errorMessage}</span>
              {snapshot === null && !loading && (
                <button type="button" className="button button-secondary" onClick={() => void loadAppearances(personaId)}>
                  {t('appearances.retryLoad')}
                </button>
              )}
            </div>
          )}

          {loading && snapshot === null ? (
            <p className="authoring-field-hint">{t('appearances.loading')}</p>
          ) : images.length === 0 ? (
            <div className="authoring-appearances-empty">{t('appearances.empty')}</div>
          ) : (
            <div className="authoring-appearances-grid">
              {images.map((image, index) => {
                const draftLabel = labelDrafts[image.id] ?? image.label
                const labelDirty = draftLabel.trim() !== image.label
                const labelTooLong = draftLabel.trim().length > MAX_PERSONA_APPEARANCE_LABEL_LENGTH
                const contentUrl = `/api/personas/${encodeURIComponent(personaId)}/appearances/${encodeURIComponent(image.id)}/content`
                const deleting = busyKey === `delete:${image.id}`
                const savingLabel = busyKey === `label:${image.id}`

                return (
                  <article key={image.id} className="authoring-appearance-card" data-appearance-id={image.id}>
                    <button
                      type="button"
                      className="authoring-appearance-thumb"
                      aria-label={t('appearances.preview')}
                      onClick={event => {
                        triggerBeforeLightboxRef.current = event.currentTarget
                        setLightboxImageId(image.id)
                      }}
                    >
                      <img src={contentUrl} alt={image.label || t('appearances.labelInput', { index: formatNumber(index + 1) })} loading="lazy" />
                      <span className="authoring-appearance-zoom" aria-hidden="true"><Expand size={14} /></span>
                    </button>

                    <div className="authoring-appearance-meta">
                      <span>#{formatNumber(index + 1)}</span>
                      <span>{image.mimeType.replace('image/', '').toUpperCase()}</span>
                      {image.width !== null && image.height !== null && (
                        <span>{t('appearances.metaDimensions', { width: formatNumber(image.width), height: formatNumber(image.height) })}</span>
                      )}
                    </div>

                    <div className="authoring-appearance-label-row">
                      <input
                        type="text"
                        value={draftLabel}
                        disabled={busy}
                        placeholder={t('appearances.labelPlaceholder')}
                        aria-label={t('appearances.labelInput', { index: formatNumber(index + 1) })}
                        aria-invalid={labelTooLong}
                        onChange={event => {
                          const value = event.target.value
                          setLabelDrafts(previous => ({ ...previous, [image.id]: value }))
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            if (labelDirty && !labelTooLong && !busy) void saveLabel(image)
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy || !labelDirty || labelTooLong}
                        onClick={() => void saveLabel(image)}
                      >
                        <Check size={14} aria-hidden="true" />
                        {savingLabel ? t('appearances.savingLabel') : t('appearances.saveLabel')}
                      </button>
                    </div>

                    {confirmDeleteId === image.id ? (
                      <div className="authoring-appearance-confirm" role="group" aria-label={t('appearances.confirmDelete')}>
                        <span>{t('appearances.confirmDelete')}</span>
                        <div className="authoring-appearance-confirm-buttons">
                          <button
                            type="button"
                            className="button button-danger"
                            disabled={busy}
                            onClick={() => void confirmDelete(image.id)}
                          >
                            {deleting ? t('appearances.deleting') : t('appearances.confirmDeleteAction')}
                          </button>
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            {t('appearances.cancelDelete')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="authoring-appearance-actions">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy || index === 0}
                          aria-label={t('appearances.moveUp')}
                          onClick={() => void moveImage(index, -1)}
                        >
                          <ArrowUp size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy || index === images.length - 1}
                          aria-label={t('appearances.moveDown')}
                          onClick={() => void moveImage(index, 1)}
                        >
                          <ArrowDown size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="button button-secondary authoring-appearance-delete"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(image.id)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {t('appearances.delete')}
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}

      <dialog
        ref={lightboxDialogRef}
        className="authoring-appearance-lightbox"
        aria-labelledby={lightboxTitleId}
        onCancel={event => {
          event.preventDefault()
          closeLightbox()
        }}
        onClick={event => {
          if (event.target === lightboxDialogRef.current) closeLightbox()
        }}
        onKeyDown={handleLightboxKeyDown}
      >
        {lightboxImage && personaId && (
          <div className="authoring-appearance-lightbox-card">
            <div className="authoring-appearance-lightbox-head">
              <strong id={lightboxTitleId}>
                {t('appearances.lightboxTitle', {
                  current: formatNumber(lightboxIndex + 1),
                  total: formatNumber(images.length),
                })}
              </strong>
              <button
                type="button"
                className="icon-button"
                aria-label={t('appearances.lightboxClose')}
                onClick={closeLightbox}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="authoring-appearance-lightbox-stage">
              <img
                src={`/api/personas/${encodeURIComponent(personaId)}/appearances/${encodeURIComponent(lightboxImage.id)}/content`}
                alt={lightboxImage.label || t('appearances.labelInput', { index: formatNumber(lightboxIndex + 1) })}
              />
            </div>
            <div className="authoring-appearance-lightbox-foot">
              <span>{lightboxImage.label || `#${formatNumber(lightboxIndex + 1)}`}</span>
              <div className="authoring-appearance-lightbox-nav">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={lightboxIndex <= 0}
                  onClick={() => setLightboxImageId(images[lightboxIndex - 1]!.id)}
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                  {t('appearances.lightboxPrev')}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={lightboxIndex >= images.length - 1}
                  onClick={() => setLightboxImageId(images[lightboxIndex + 1]!.id)}
                >
                  {t('appearances.lightboxNext')}
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        )}
      </dialog>
    </section>
  )
}
