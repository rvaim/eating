import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, ImagePlus, Images,
  RefreshCw, Search, Trash2, Upload, X,
} from 'lucide-react'
import {
  ActionButton, InlineConfirm, TagChipsInput, formatDateTime, formatNumber,
  hostRequest, splitTagTokens, useI18n,
} from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { HostApiError } from '@eating/ui-sdk'
import { isJsonObject, readImageLimits } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { StickerItem, StickerList, StickerTags } from '../types'
import { imageBlob, localImage, readStickerItem, readStickerList, readStickerPreview, readStickerTags } from './data'
import { st, stickerError } from './i18n'
import './panel.css'

interface Selection { readonly item: StickerItem; readonly revision: number }
interface Filter { readonly query: string; readonly tags: string[] }
type OpenTarget = StickerItem | 'add' | null
interface ThumbState { readonly status: 'loading' | 'ready' | 'error'; readonly url?: string }

const blankPage: StickerList = { revision: 0, items: [], offset: 0, limit: 20, total: 0, hasMore: false, nextOffset: null }
const MAX_CONCURRENT_THUMBS = 3

function bytesLabel(bytes: number): string {
  return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KiB`
}

async function manage(operation: string, input: JsonObject, signal: AbortSignal): Promise<unknown> {
  return hostRequest('/plugins/stickers/manage', { method: 'POST', body: { operation, input }, signal })
}

function validateStickerTag(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || [...trimmed].length > 32 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    return st('error.tagItem')
  }
  return null
}

function normalizeStickerTags(rawTags: readonly string[]): string[] {
  const cleaned = rawTags.map(tag => tag.trim()).filter(Boolean)
  if (cleaned.length > 32 || cleaned.some(tag => [...tag].length > 32 || /[\u0000-\u001f\u007f]/u.test(tag))) {
    throw new HostApiError('STICKER_TAGS_INVALID', st('error.tags'))
  }
  const seen = new Set<string>()
  return cleaned.filter(tag => {
    const key = tag.normalize('NFKC').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function StickersPanel({ enabled, onFeedback, onDirtyChange }: PluginPanelProps) {
  const { t } = useI18n('stickers')
  const id = useId()
  const [page, setPage] = useState<StickerList>(blankPage)
  const [tagList, setTagList] = useState<StickerTags>({ revision: 0, tags: [] })
  const [filter, setFilter] = useState<Filter>({ query: '', tags: [] })
  const [query, setQuery] = useState('')
  const [chosenTags, setChosenTags] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [adding, setAdding] = useState(false)
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [pendingTagText, setPendingTagText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pendingOpen, setPendingOpen] = useState<OpenTarget>(null)
  const [discarding, setDiscarding] = useState(false)
  const [thumbs, setThumbs] = useState<Readonly<Record<string, ThumbState>>>({})
  const [visible, setVisible] = useState(() => !document.hidden)

  const mounted = useRef(false)
  const enabledRef = useRef(enabled)
  const fileRef = useRef<File | null>(null)
  const addingRef = useRef(false)
  const listLoadedRef = useRef(false)
  const listInterruptedRef = useRef(false)
  const controllers = useRef(new Set<AbortController>())
  const listController = useRef<AbortController | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const thumbUrlsRef = useRef(new Map<string, string>())
  const thumbControllersRef = useRef(new Map<string, AbortController>())
  const thumbBatchRef = useRef(0)
  const imageUrl = useRef<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const descriptionInput = useRef<HTMLTextAreaElement>(null)
  const discardConfirmRef = useRef<HTMLDivElement | null>(null)
  const deleteConfirmRef = useRef<HTMLDivElement | null>(null)
  const mutationLock = useRef(false)
  const generation = useRef(0)
  const callbacks = useRef({ onFeedback, onDirtyChange })

  enabledRef.current = enabled
  fileRef.current = file
  addingRef.current = adding
  callbacks.current = { onFeedback, onDirtyChange }

  const dirty = adding
    ? Boolean(file || description.trim() || tags.length > 0 || pendingTagText.trim())
    : Boolean(
        selection && (
          description !== selection.item.description ||
          pendingTagText.trim().length > 0 ||
          JSON.stringify(tags) !== JSON.stringify(selection.item.tags)
        ),
      )

  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false) }, [])

  useEffect(() => {
    if (!discarding) return
    requestAnimationFrame(() => { discardConfirmRef.current?.querySelector('button')?.focus() })
  }, [discarding])

  useEffect(() => {
    if (!deleting) return
    requestAnimationFrame(() => { deleteConfirmRef.current?.querySelector('button')?.focus() })
  }, [deleting])

  const replaceImage = useCallback((url: string | null) => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
    imageUrl.current = url
    if (mounted.current) setPreviewUrl(url)
  }, [])

  const clearPreviewOnly = useCallback(() => {
    ++generation.current
    previewController.current?.abort()
    previewController.current = null
    replaceImage(null)
    if (mounted.current) setPreviewLoading(false)
  }, [replaceImage])

  const clearImage = useCallback(() => {
    clearPreviewOnly()
    if (mounted.current) setFile(null)
    if (input.current) input.current.value = ''
  }, [clearPreviewOnly])

  const abortThumbRequests = useCallback(() => {
    ++thumbBatchRef.current
    thumbControllersRef.current.forEach(controller => controller.abort())
    thumbControllersRef.current.clear()
  }, [])

  const clearThumbnails = useCallback(() => {
    abortThumbRequests()
    thumbUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    thumbUrlsRef.current.clear()
    if (mounted.current) setThumbs({})
  }, [abortThumbRequests])

  const newController = useCallback(() => {
    const controller = new AbortController()
    controllers.current.add(controller)
    return controller
  }, [])

  const load = useCallback(async (filters: Filter, offset = 0, expectedRevision?: number) => {
    if (!enabledRef.current || document.hidden || !mounted.current) {
      if (enabledRef.current && mounted.current) listInterruptedRef.current = true
      return
    }
    listController.current?.abort()
    const controller = newController()
    listController.current = controller
    setLoading(true)
    setFailure(null)
    try {
      const values = readStickerList(await manage('list', {
        ...filters,
        offset,
        limit: 20,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }, controller.signal))
      if (controller.signal.aborted || !mounted.current || !enabledRef.current) return
      setPage(values)
      listLoadedRef.current = true
      listInterruptedRef.current = false
      const tagValues = readStickerTags(await manage('tags', { expectedRevision: values.revision }, controller.signal))
      if (!controller.signal.aborted && mounted.current && enabledRef.current) setTagList(tagValues)
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setFailure(stickerError(error))
    } finally {
      controllers.current.delete(controller)
      if (listController.current === controller) {
        listController.current = null
        if (mounted.current) setLoading(false)
      }
    }
  }, [newController])

  // Load bounded-concurrency thumbnails for visible current page rows while enabled
  useEffect(() => {
    if (!enabled || !visible || document.hidden || page.items.length === 0) {
      clearThumbnails()
      return
    }
    abortThumbRequests()
    const batch = ++thumbBatchRef.current
    const keepIds = new Set(page.items.map(item => item.assetId))
    for (const [idKey, url] of thumbUrlsRef.current) {
      if (!keepIds.has(idKey)) {
        URL.revokeObjectURL(url)
        thumbUrlsRef.current.delete(idKey)
      }
    }

    const initial: Record<string, ThumbState> = {}
    const queue: StickerItem[] = []
    for (const item of page.items) {
      const cached = thumbUrlsRef.current.get(item.assetId)
      if (cached) initial[item.assetId] = { status: 'ready', url: cached }
      else {
        initial[item.assetId] = { status: 'loading' }
        queue.push(item)
      }
    }
    setThumbs(initial)

    let cursor = 0
    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++]
        if (!item || thumbBatchRef.current !== batch || !mounted.current || !enabledRef.current || document.hidden) return
        const controller = new AbortController()
        thumbControllersRef.current.set(item.assetId, controller)
        try {
          const preview = readStickerPreview(await manage('get', { assetId: item.assetId }, controller.signal))
          const url = URL.createObjectURL(imageBlob(preview.image))
          if (controller.signal.aborted || thumbBatchRef.current !== batch || !mounted.current || !enabledRef.current || document.hidden) {
            URL.revokeObjectURL(url)
            return
          }
          const prevUrl = thumbUrlsRef.current.get(item.assetId)
          if (prevUrl) URL.revokeObjectURL(prevUrl)
          thumbUrlsRef.current.set(item.assetId, url)
          setThumbs(prev => (thumbBatchRef.current === batch ? { ...prev, [item.assetId]: { status: 'ready', url } } : prev))
        } catch {
          if (!controller.signal.aborted && thumbBatchRef.current === batch && mounted.current) {
            setThumbs(prev => (thumbBatchRef.current === batch ? { ...prev, [item.assetId]: { status: 'error' } } : prev))
          }
        } finally {
          thumbControllersRef.current.delete(item.assetId)
        }
      }
    }

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_THUMBS, queue.length) }, () => void worker())
    void workers
    return () => { abortThumbRequests() }
  }, [enabled, visible, page.items, abortThumbRequests, clearThumbnails])

  useEffect(() => {
    mounted.current = true
    const handleVisibilityOrPageHide = (event: Event) => {
      const hidden = document.hidden || event.type === 'pagehide'
      setVisible(!hidden)
      if (hidden) {
        if (listController.current) listInterruptedRef.current = true
        for (const controller of controllers.current) controller.abort()
        controllers.current.clear()
        listController.current = null
        clearThumbnails()
        clearPreviewOnly()
        if (event.type === 'pagehide') {
          setFile(null)
          if (input.current) input.current.value = ''
        }
        setLoading(false)
        setBusy(false)
      } else if (enabledRef.current && addingRef.current && fileRef.current && !imageUrl.current) {
        replaceImage(URL.createObjectURL(fileRef.current))
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityOrPageHide)
    window.addEventListener('pagehide', handleVisibilityOrPageHide)
    return () => {
      mounted.current = false
      ++generation.current
      ++thumbBatchRef.current
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
      thumbControllersRef.current.forEach(c => c.abort())
      thumbControllersRef.current.clear()
      thumbUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
      thumbUrlsRef.current.clear()
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
      imageUrl.current = null
      document.removeEventListener('visibilitychange', handleVisibilityOrPageHide)
      window.removeEventListener('pagehide', handleVisibilityOrPageHide)
    }
  }, [clearPreviewOnly, clearThumbnails, replaceImage])

  useEffect(() => {
    if (!enabled) {
      listLoadedRef.current = false
      listInterruptedRef.current = false
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
      listController.current = null
      clearThumbnails()
      clearImage()
      setPage(blankPage)
      setTagList({ revision: 0, tags: [] })
      setSelection(null)
      setAdding(false)
      setDescription('')
      setTags([])
      setPendingTagText('')
      setDeleting(false)
      setDiscarding(false)
      setPendingOpen(null)
      setLoading(false)
      setBusy(false)
      setFailure(null)
      return
    }
    if (visible && (!listLoadedRef.current || listInterruptedRef.current)) {
      void load(filter, page.offset)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, visible])

  const open = async (target: OpenTarget, preserveDraft = false) => {
    if (!enabledRef.current || mutationLock.current || document.hidden) return
    clearImage()
    setFailure(null)
    setDeleting(false)
    setDiscarding(false)
    if (target === 'add') {
      setAdding(true)
      setSelection(null)
      setDescription('')
      setTags([])
      setPendingTagText('')
      requestAnimationFrame(() => { descriptionInput.current?.focus({ preventScroll: true }) })
      return
    }
    if (!target) {
      setAdding(false)
      setSelection(null)
      setDescription('')
      setTags([])
      setPendingTagText('')
      return
    }
    const current = generation.current
    const controller = newController()
    previewController.current = controller
    setPreviewLoading(true)
    try {
      const result = readStickerPreview(await manage('get', {
        assetId: target.assetId,
        ...(!preserveDraft ? { expectedRevision: page.revision } : {}),
      }, controller.signal))
      if (controller.signal.aborted || !mounted.current || !enabledRef.current || document.hidden || current !== generation.current) return
      const url = URL.createObjectURL(imageBlob(result.image))
      replaceImage(url)
      if (!preserveDraft) {
        setAdding(false)
        setSelection({ item: result.item, revision: result.revision })
        setDescription(result.item.description)
        setTags([...result.item.tags])
        setPendingTagText('')
      }
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setFailure(stickerError(error))
    } finally {
      controllers.current.delete(controller)
      if (previewController.current === controller) {
        previewController.current = null
        if (mounted.current) setPreviewLoading(false)
      }
    }
  }

  const choose = (target: OpenTarget) => {
    if (!enabled) return
    if (dirty) {
      setPendingOpen(target)
      setDiscarding(true)
      return
    }
    void open(target)
  }

  const chooseFile = async (selected: File | undefined) => {
    if (!selected || !enabledRef.current) return
    clearImage()
    setFailure(null)
    const controller = newController()
    const current = generation.current
    try {
      const limits = readImageLimits(await hostRequest<unknown>('/image-limits', { signal: controller.signal }))
      if (controller.signal.aborted || !mounted.current || !enabledRef.current || document.hidden || current !== generation.current) return
      if (
        !selected.size ||
        selected.size > limits.imageBytes ||
        !(/\.(png|jpe?g|gif|webp)$/i.test(selected.name) || ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(selected.type))
      ) {
        setFailure(st('error.image'))
        return
      }
      setFile(selected)
      replaceImage(URL.createObjectURL(selected))
    } catch (error) {
      if (!controller.signal.aborted && mounted.current && current === generation.current) setFailure(stickerError(error))
    } finally {
      controllers.current.delete(controller)
    }
  }

  const refresh = (reset = false) => {
    if (!enabled || busy) return
    if (reset) {
      setQuery('')
      setChosenTags([])
      const next = { query: '', tags: [] }
      setFilter(next)
      void load(next, 0)
    } else {
      void load(filter, page.offset)
    }
  }

  const toggleFilterTag = (tag: string) => {
    if (!enabled || busy) return
    const nextTags = chosenTags.includes(tag)
      ? chosenTags.filter(item => item !== tag)
      : [...chosenTags, tag]
    setChosenTags(nextTags)
    const nextFilter = { query: query.trim(), tags: nextTags }
    setFilter(nextFilter)
    void load(nextFilter, 0)
  }

  const applyFilters = (event: FormEvent) => {
    event.preventDefault()
    if (!enabled) return
    const next = { query: query.trim(), tags: [...chosenTags] }
    setFilter(next)
    void load(next, 0)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!enabled || mutationLock.current || document.hidden || (!adding && !selection)) return
    if (!description.trim() || [...description.trim()].length > 1000) {
      setFailure(st('error.description'))
      return
    }
    const rawTags = pendingTagText.trim()
      ? [...tags, ...splitTagTokens(pendingTagText, 'line-or-comma')]
      : tags
    let normalizedTags: string[]
    try {
      normalizedTags = normalizeStickerTags(rawTags)
    } catch {
      setFailure(st('error.tags'))
      return
    }
    if (adding && !file) {
      setFailure(st('error.file'))
      return
    }
    const controller = newController()
    const current = generation.current
    mutationLock.current = true
    setBusy(true)
    setFailure(null)
    try {
      const limits = adding ? readImageLimits(await hostRequest<unknown>('/image-limits', { signal: controller.signal })) : null
      const data: JsonObject = adding
        ? { ...await localImage(file!, limits!.imageBytes), description: description.trim(), tags: normalizedTags, expectedRevision: page.revision }
        : { assetId: selection!.item.assetId, description: description.trim(), tags: normalizedTags, expectedRevision: selection!.revision }
      if (controller.signal.aborted || !enabledRef.current || document.hidden || current !== generation.current) return
      const result = await manage(adding ? 'add' : 'update', data, controller.signal)
      if (controller.signal.aborted || !mounted.current || !enabledRef.current || document.hidden) return
      if (!isJsonObject(result) || typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision)) throw new Error('Invalid response')
      const item = readStickerItem(result.item)
      const notice = adding ? (result.duplicate === true ? 'feedback.duplicate' : 'feedback.added') : 'feedback.saved'
      setSelection({ item, revision: result.revision })
      setAdding(false)
      setDescription(item.description)
      setTags([...item.tags])
      setPendingTagText('')
      setFile(null)
      if (input.current) input.current.value = ''
      callbacks.current.onFeedback(st(notice))
      void load(filter, adding ? 0 : page.offset)
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setFailure(stickerError(error))
      else if (mounted.current) setFailure(st('error.interrupted'))
    } finally {
      controllers.current.delete(controller)
      mutationLock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const remove = async () => {
    if (!enabled || !selection || mutationLock.current || document.hidden) return
    const controller = newController()
    mutationLock.current = true
    setBusy(true)
    setFailure(null)
    try {
      await manage('delete', { assetId: selection.item.assetId, expectedRevision: selection.revision }, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      clearImage()
      setSelection(null)
      setDescription('')
      setTags([])
      setPendingTagText('')
      setDeleting(false)
      callbacks.current.onFeedback(st('feedback.deleted'))
      void load(filter, page.offset)
    } catch (error) {
      if (mounted.current) setFailure(controller.signal.aborted ? st('error.interrupted') : stickerError(error))
    } finally {
      controllers.current.delete(controller)
      mutationLock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const editorOpen = adding || Boolean(selection) || previewLoading

  return (
    <section className="stickers-panel" aria-label={t('library.title')}>
      {!enabled && (
        <div className="stickers-disabled-banner" role="status">
          <AlertCircle size={17} aria-hidden="true" />
          <div>
            <strong>{t('plugin.disabledTitle')}</strong>
            <p>{t('plugin.disabledBody')}</p>
          </div>
        </div>
      )}

      <div className="stickers-toolbar">
        <div>
          <h3>{t('library.title')} <span>{t('library.count', { count: page.total })}</span></h3>
          <p>{t('library.help')}</p>
        </div>
        <div className="stickers-actions">
          <ActionButton
            reason={!enabled ? t('error.STICKER_NOT_READY') : undefined}
            reasonCode={enabled ? 'busy' : 'enable'}
            type="button"
            className="button button-secondary"
            disabled={!enabled || busy || loading}
            onClick={() => refresh()}>
            <RefreshCw size={15} aria-hidden="true" />
            {t('library.refresh')}
          </ActionButton>
          <ActionButton
            reason={!enabled ? t('error.STICKER_NOT_READY') : undefined}
            reasonCode={enabled ? 'busy' : 'enable'}
            type="button"
            className="button button-primary"
            disabled={!enabled || busy}
            onClick={() => choose('add')}>
            <ImagePlus size={16} aria-hidden="true" />
            {t('editor.add')}
          </ActionButton>
        </div>
      </div>

      {failure && (
        <div className="stickers-notice" role="alert">
          <AlertCircle size={17} aria-hidden="true" />
          <span>{failure}</span>
        </div>
      )}

      <div className={`stickers-layout${editorOpen ? ' has-editor-open' : ''}`}>
        <div className="stickers-browser">
          <form className="stickers-filter" onSubmit={applyFilters}>
            <label htmlFor={`${id}-query`}>{t('search.label')}</label>
            <div className="stickers-search">
              <Search size={16} aria-hidden="true" />
              <input
                id={`${id}-query`}
                value={query}
                maxLength={1000}
                disabled={!enabled}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('search.placeholder')}
              />
              <ActionButton
                reasonCode={enabled ? 'busy' : 'enable'}
                className="button button-secondary"
                disabled={!enabled || loading || busy}>
                {t('search.apply')}
              </ActionButton>
            </div>

            <span id={`${id}-filter-tags-label`} className="stickers-filter-label">{t('tags.filter')}</span>
            <div className="stickers-tag-cloud" role="group" aria-labelledby={`${id}-filter-tags-label`}>
              {tagList.tags.length === 0 ? (
                <span className="stickers-tag-cloud-empty">{t('tags.all')}</span>
              ) : (
                tagList.tags.map(entry => {
                  const selected = chosenTags.includes(entry.tag)
                  return (
                    <button
                      key={entry.tag}
                      type="button"
                      className={`stickers-filter-chip${selected ? ' is-selected' : ''}`}
                      aria-pressed={selected}
                      disabled={!enabled || busy}
                      onClick={() => toggleFilterTag(entry.tag)}>
                      <span>{t('tags.count', { tag: entry.tag, count: entry.count })}</span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="stickers-filter-help">
              <small>
                {chosenTags.length > 0 ? `${t('tags.activeCount', { count: chosenTags.length })} · ${t('tags.and')}` : t('tags.and')}
              </small>
              {(Boolean(filter.query) || chosenTags.length > 0 || Boolean(query)) && (
                <ActionButton
                  reasonCode={enabled ? 'busy' : 'enable'}
                  className="text-button"
                  type="button"
                  disabled={!enabled || loading || busy}
                  onClick={() => refresh(true)}>
                  {t('search.reset')}
                </ActionButton>
              )}
            </div>
          </form>

          <div className="stickers-list" aria-busy={loading}>
            {loading && <p className="stickers-loading" role="status">{t('library.loading')}</p>}
            {!loading && page.items.length === 0 && (
              <div className="stickers-empty">
                <Images size={30} aria-hidden="true" />
                <h4>{t(filter.query || filter.tags.length ? 'library.noResults' : 'library.empty')}</h4>
                <p>{t(filter.query || filter.tags.length ? 'library.noResultsHelp' : 'library.emptyHelp')}</p>
              </div>
            )}
            {page.items.map(item => {
              const thumb = thumbs[item.assetId]
              const isSelected = selection?.item.assetId === item.assetId
              return (
                <ActionButton
                  reasonCode={enabled ? 'busy' : 'enable'}
                  type="button"
                  key={item.assetId}
                  className={`stickers-row${isSelected ? ' is-selected' : ''}`}
                  aria-pressed={isSelected}
                  disabled={!enabled || busy}
                  onClick={() => choose(item)}>
                  <span className="stickers-row-thumb-box" aria-hidden="true">
                    {thumb?.status === 'ready' && thumb.url ? (
                      <img src={thumb.url} alt="" className="stickers-row-thumb" />
                    ) : (
                      <Images className="stickers-row-image" size={20} />
                    )}
                  </span>
                  <span className="stickers-row-body">
                    <strong>{item.description}</strong>
                    {item.tags.length > 0 && (
                      <span className="stickers-tags">
                        {item.tags.map(tag => <span key={tag}>{tag}</span>)}
                      </span>
                    )}
                    <small>{t('editor.created', { date: formatDateTime(item.createdAt) })}</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </ActionButton>
              )
            })}
          </div>

          <nav className="stickers-pagination" aria-label={t('library.title')}>
            <span>
              {t('library.page', {
                start: page.total ? page.offset + 1 : 0,
                end: Math.min(page.offset + page.items.length, page.total),
                total: page.total,
              })}
            </span>
            <div>
              <ActionButton
                reasonCode={!enabled ? 'enable' : (loading || busy ? 'loading' : 'firstPage')}
                type="button"
                className="button button-secondary"
                disabled={!enabled || loading || busy || page.offset === 0}
                aria-label={t('library.previous')}
                onClick={() => void load(filter, Math.max(0, page.offset - page.limit), page.revision)}>
                <ChevronLeft size={17} aria-hidden="true" />
              </ActionButton>
              <ActionButton
                reasonCode={!enabled ? 'enable' : (loading || busy ? 'loading' : 'lastPage')}
                type="button"
                className="button button-secondary"
                disabled={!enabled || loading || busy || !page.hasMore}
                aria-label={t('library.next')}
                onClick={() => void load(filter, page.nextOffset!, page.revision)}>
                <ChevronRight size={17} aria-hidden="true" />
              </ActionButton>
            </div>
          </nav>
        </div>

        <aside className="stickers-editor" aria-label={t(adding ? 'editor.add' : 'editor.edit')}>
          {!editorOpen ? (
            <div className="stickers-empty">
              <Images size={32} aria-hidden="true" />
              <h4>{t('editor.placeholder')}</h4>
              <p>{t('editor.placeholderHelp')}</p>
            </div>
          ) : (
            <>
              <div className="stickers-editor-heading">
                <div className="stickers-editor-title">
                  <ActionButton
                    reasonCode="busy"
                    type="button"
                    className="button button-secondary stickers-mobile-back"
                    disabled={busy}
                    onClick={() => choose(null)}>
                    <ArrowLeft size={16} aria-hidden="true" />
                    {t('editor.backToList')}
                  </ActionButton>
                  <h3>{t(adding ? 'editor.add' : 'editor.edit')}</h3>
                </div>
                <ActionButton
                  reasonCode="busy"
                  className="icon-button"
                  type="button"
                  aria-label={t('editor.cancel')}
                  onClick={() => choose(null)}
                  disabled={busy}>
                  <X size={18} />
                </ActionButton>
              </div>

              {discarding && (
                <div ref={discardConfirmRef} className="stickers-inline-confirm">
                  <InlineConfirm
                    open
                    variant="warning"
                    title={t('editor.discard')}
                    cancelLabel={t('editor.keepDraft')}
                    confirmLabel={t('editor.discardAccept')}
                    busy={busy}
                    onCancel={() => { setDiscarding(false); setPendingOpen(null) }}
                    onConfirm={() => {
                      const target = pendingOpen
                      setPendingOpen(null)
                      void open(target)
                    }}
                  />
                </div>
              )}

              <div className="stickers-preview" aria-label={t('editor.preview')}>
                {previewLoading ? (
                  <p role="status">{t('library.loading')}</p>
                ) : previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={t('editor.previewAlt')}
                    onError={() => { replaceImage(null); setFailure(st('error.image')) }}
                  />
                ) : (
                  <p>{t('editor.previewCleared')}</p>
                )}
              </div>

              <div className="stickers-preview-actions">
                {previewUrl && (
                  <ActionButton reasonCode="busy" className="text-button" type="button" onClick={clearImage}>
                    {t('editor.clearPreview')}
                  </ActionButton>
                )}
                {!adding && selection && !previewUrl && (
                  <ActionButton
                    reasonCode="preview"
                    className="text-button"
                    type="button"
                    disabled={!enabled || previewLoading}
                    onClick={() => void open(selection.item, true)}>
                    {t('editor.reloadPreview')}
                  </ActionButton>
                )}
                <small>{t('editor.previewHelp')}</small>
              </div>

              <form onSubmit={save} className="stickers-edit-form">
                <fieldset disabled={!enabled || busy || previewLoading}>
                  {adding && (
                    <div className="stickers-field">
                      <label htmlFor={`${id}-file`}>{t('editor.file')}</label>
                      <div
                        className={`stickers-dropzone${dragOver ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
                        onDragOver={event => { event.preventDefault(); if (enabled && !busy) setDragOver(true) }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={event => {
                          event.preventDefault()
                          setDragOver(false)
                          if (enabled && !busy) void chooseFile(event.dataTransfer.files?.[0])
                        }}>
                        <input
                          ref={input}
                          id={`${id}-file`}
                          className="stickers-file-input"
                          type="file"
                          aria-label={t('editor.file')}
                          accept="image/png,image/jpeg,image/gif,image/webp"
                          onChange={event => void chooseFile(event.target.files?.[0])}
                        />
                        <Upload size={20} className="stickers-dropzone-icon" aria-hidden="true" />
                        <strong>{file ? t('editor.selectedFile', { name: file.name, size: bytesLabel(file.size) }) : t('editor.dropFile')}</strong>
                        <small>{t('editor.fileHelp')}</small>
                      </div>
                    </div>
                  )}

                  <div className="stickers-field">
                    <label htmlFor={`${id}-description`}>{t('editor.description')}</label>
                    <textarea
                      ref={descriptionInput}
                      id={`${id}-description`}
                      rows={4}
                      required
                      maxLength={2000}
                      value={description}
                      onChange={event => setDescription(event.target.value)}
                      aria-describedby={`${id}-description-help`}
                    />
                    <small id={`${id}-description-help`}>{t('editor.descriptionHelp')}</small>
                  </div>

                  <div className="stickers-field">
                    <label htmlFor={`${id}-tags`}>{t('editor.tags')}</label>
                    <TagChipsInput
                      id={`${id}-tags`}
                      aria-label={t('editor.tags')}
                      aria-describedby={`${id}-tags-help`}
                      values={tags}
                      onChange={next => setTags([...next])}
                      onPendingInputChange={setPendingTagText}
                      validateItem={validateStickerTag}
                      suggestions={tagList.tags.map(entry => ({ label: entry.tag, count: entry.count }))}
                      placeholder={t('editor.tagsPlaceholder')}
                      maxItems={32}
                      delimiter="line-or-comma"
                      disabled={!enabled || busy || previewLoading}
                    />
                    <small id={`${id}-tags-help`}>{t('editor.tagsHelp')}</small>
                  </div>

                  {selection && (
                    <p className="stickers-metadata">{t('editor.bytes', { size: bytesLabel(selection.item.bytes), type: selection.item.mimeType })}</p>
                  )}

                  <div className="stickers-actions">
                    <ActionButton
                      reasonCode={!enabled ? 'enable' : (busy ? 'busy' : 'unchanged')}
                      type="submit"
                      className="button button-primary"
                      disabled={!enabled || busy || (!adding && !dirty)}>
                      {t(busy ? 'editor.saving' : adding ? 'editor.upload' : 'editor.save')}
                    </ActionButton>
                    {dirty && <span className="stickers-dirty">{t('editor.unsaved')}</span>}
                  </div>
                </fieldset>
              </form>

              {!adding && selection && (
                <div className="stickers-delete">
                  {!deleting ? (
                    <ActionButton
                      reasonCode={enabled ? 'busy' : 'enable'}
                      type="button"
                      className="text-button"
                      disabled={!enabled || busy}
                      onClick={() => setDeleting(true)}>
                      <Trash2 size={15} aria-hidden="true" />
                      {t('editor.delete')}
                    </ActionButton>
                  ) : (
                    <div ref={deleteConfirmRef}>
                      <InlineConfirm
                        open
                        variant="danger"
                        title={t('editor.delete')}
                        description={t('editor.deleteConfirm')}
                        cancelLabel={t('editor.cancel')}
                        confirmLabel={t('editor.deleteAccept')}
                        busy={busy}
                        onCancel={() => setDeleting(false)}
                        onConfirm={() => void remove()}
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  )
}
