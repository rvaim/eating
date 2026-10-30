import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, ImagePlus, Images, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { formatDateTime, formatNumber, hostRequest, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { StickerItem, StickerList, StickerTags } from '../types'
import { imageBlob, localImage, readStickerItem, readStickerList, readStickerPreview, readStickerTags, tagsFromText } from './data'
import { st, stickerError } from './i18n'
import './panel.css'

interface Selection { readonly item: StickerItem; readonly revision: number }
interface Filter { readonly query: string; readonly tags: string[] }
type OpenTarget = StickerItem | 'add' | null
const blankPage: StickerList = { revision: 0, items: [], offset: 0, limit: 20, total: 0, hasMore: false, nextOffset: null }
function bytesLabel(bytes: number): string { return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KiB` }
async function manage(operation: string, input: JsonObject, signal: AbortSignal): Promise<unknown> {
  return hostRequest('/plugins/stickers/manage', { method: 'POST', body: { operation, input }, signal })
}

export function StickersPanel({ onFeedback }: PluginPanelProps) {
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
  const [tags, setTags] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pendingOpen, setPendingOpen] = useState<OpenTarget>(null)
  const [discarding, setDiscarding] = useState(false)
  const mounted = useRef(false)
  const controllers = useRef(new Set<AbortController>())
  const listController = useRef<AbortController | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const imageUrl = useRef<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const descriptionInput = useRef<HTMLTextAreaElement>(null)
  const editor = useRef<HTMLElement>(null)
  const browser = useRef<HTMLDivElement>(null)
  const reveal = (target: HTMLElement | null) => { if (window.matchMedia('(max-width: 1100px)').matches) target?.scrollIntoView({ block: 'start', behavior: 'instant' }) }
  const mutationLock = useRef(false)
  const generation = useRef(0)
  const feedback = useRef(onFeedback); feedback.current = onFeedback
  const dirty = adding ? Boolean(file || description.trim() || tags.trim()) : Boolean(selection && (description !== selection.item.description || tags !== selection.item.tags.join('\n')))

  const replaceImage = useCallback((url: string | null) => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
    imageUrl.current = url
    if (mounted.current) setPreviewUrl(url)
  }, [])
  const clearImage = useCallback(() => {
    ++generation.current
    previewController.current?.abort(); previewController.current = null
    replaceImage(null)
    if (mounted.current) { setFile(null); setPreviewLoading(false) }
    if (input.current) input.current.value = ''
  }, [replaceImage])
  const newController = useCallback(() => { const controller = new AbortController(); controllers.current.add(controller); return controller }, [])
  const load = useCallback(async (filters: Filter, offset = 0, expectedRevision?: number) => {
    if (document.hidden || !mounted.current) return
    listController.current?.abort()
    const controller = newController(); listController.current = controller
    setLoading(true); setFailure(null)
    try {
      const values = readStickerList(await manage('list', { ...filters, offset, limit: 20, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, controller.signal))
      if (controller.signal.aborted || !mounted.current) return
      setPage(values)
      const tagValues = readStickerTags(await manage('tags', { expectedRevision: values.revision }, controller.signal))
      if (!controller.signal.aborted && mounted.current) setTagList(tagValues)
    } catch (error) { if (!controller.signal.aborted && mounted.current) setFailure(stickerError(error)) }
    finally { controllers.current.delete(controller); if (listController.current === controller) { listController.current = null; if (mounted.current) setLoading(false) } }
  }, [newController])

  useEffect(() => {
    mounted.current = true
    void load({ query: '', tags: [] })
    const clear = () => {
      if (!document.hidden) return
      clearImage()
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear(); listController.current = null
      setLoading(false)
    }
    document.addEventListener('visibilitychange', clear)
    return () => {
      mounted.current = false
      ++generation.current
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
      document.removeEventListener('visibilitychange', clear)
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
      imageUrl.current = null
    }
  }, [clearImage, load])

  const open = async (target: OpenTarget, preserveDraft = false) => {
    if (mutationLock.current || document.hidden) return
    clearImage(); setFailure(null); setDeleting(false); setDiscarding(false)
    if (target === 'add') {
      setAdding(true); setSelection(null); setDescription(''); setTags('')
      requestAnimationFrame(() => { reveal(editor.current); descriptionInput.current?.focus({ preventScroll: true }) })
      return
    }
    if (!target) { setAdding(false); setSelection(null); setDescription(''); setTags(''); requestAnimationFrame(() => reveal(browser.current)); return }
    const current = generation.current, controller = newController(); previewController.current = controller
    setPreviewLoading(true)
    try {
      const result = readStickerPreview(await manage('get', { assetId: target.assetId, ...(!preserveDraft ? { expectedRevision: page.revision } : {}) }, controller.signal))
      if (controller.signal.aborted || !mounted.current || document.hidden || current !== generation.current) return
      const url = URL.createObjectURL(imageBlob(result.image))
      replaceImage(url)
      if (!preserveDraft) { setAdding(false); setSelection({ item: result.item, revision: result.revision }); setDescription(result.item.description); setTags(result.item.tags.join('\n')) }
      requestAnimationFrame(() => reveal(editor.current))
    } catch (error) { if (!controller.signal.aborted && mounted.current) setFailure(stickerError(error)) }
    finally { controllers.current.delete(controller); if (previewController.current === controller) { previewController.current = null; if (mounted.current) setPreviewLoading(false) } }
  }
  const choose = (target: OpenTarget) => {
    if (dirty) { setPendingOpen(target); setDiscarding(true); return }
    void open(target)
  }
  const chooseFile = (selected: File | undefined) => {
    if (!selected) return
    clearImage(); setFailure(null)
    if (!selected.size || selected.size > 5 * 1024 * 1024 || !(/\.(png|jpe?g|gif|webp)$/i.test(selected.name) || ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(selected.type))) { setFailure(st('error.image')); return }
    setFile(selected); replaceImage(URL.createObjectURL(selected))
  }
  const refresh = (reset = false) => {
    if (busy) return
    if (reset) { setQuery(''); setChosenTags([]); const next = { query: '', tags: [] }; setFilter(next); void load(next) }
    else void load(filter)
  }
  const applyFilters = (event: FormEvent) => { event.preventDefault(); const next = { query: query.trim(), tags: [...chosenTags] }; setFilter(next); void load(next) }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (mutationLock.current || document.hidden || (!adding && !selection)) return
    if (!description.trim() || [...description.trim()].length > 1000) { setFailure(st('error.description')); return }
    let normalizedTags: string[]
    try { normalizedTags = tagsFromText(tags) } catch { setFailure(st('error.tags')); return }
    if (adding && !file) { setFailure(st('error.file')); return }
    const controller = newController(), current = generation.current
    mutationLock.current = true; setBusy(true); setFailure(null)
    try {
      const data: JsonObject = adding ? { ...await localImage(file!), description: description.trim(), tags: normalizedTags, expectedRevision: page.revision }
        : { assetId: selection!.item.assetId, description: description.trim(), tags: normalizedTags, expectedRevision: selection!.revision }
      if (controller.signal.aborted || document.hidden || current !== generation.current) return
      const result = await manage(adding ? 'add' : 'update', data, controller.signal)
      if (controller.signal.aborted || !mounted.current || document.hidden) return
      if (!isJsonObject(result) || typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision)) throw new Error('Invalid response')
      const item = readStickerItem(result.item)
      const notice = adding ? result.duplicate === true ? 'feedback.duplicate' : 'feedback.added' : 'feedback.saved'
      setSelection({ item, revision: result.revision }); setAdding(false); setDescription(item.description); setTags(item.tags.join('\n')); setFile(null)
      if (input.current) input.current.value = ''
      feedback.current(st(notice))
      void load(filter)
    } catch (error) { if (!controller.signal.aborted && mounted.current) setFailure(stickerError(error)); else if (mounted.current) setFailure(st('error.interrupted')) }
    finally { controllers.current.delete(controller); mutationLock.current = false; if (mounted.current) setBusy(false) }
  }
  const remove = async () => {
    if (!selection || mutationLock.current || document.hidden) return
    const controller = newController()
    mutationLock.current = true; setBusy(true); setFailure(null)
    try {
      await manage('delete', { assetId: selection.item.assetId, expectedRevision: selection.revision }, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      clearImage(); setSelection(null); setDescription(''); setTags(''); setDeleting(false)
      feedback.current(st('feedback.deleted')); void load(filter)
    } catch (error) { if (mounted.current) setFailure(controller.signal.aborted ? st('error.interrupted') : stickerError(error)) }
    finally { controllers.current.delete(controller); mutationLock.current = false; if (mounted.current) setBusy(false) }
  }

  return <section className="stickers-panel" aria-label={t('library.title')}>
    <div className="stickers-toolbar"><div><h3>{t('library.title')} <span>{t('library.count', { count: page.total })}</span></h3><p>{t('library.help')}</p></div>
      <div className="stickers-actions"><button type="button" className="button button-secondary" disabled={busy || loading} onClick={() => refresh()}><RefreshCw size={15} aria-hidden="true" />{t('library.refresh')}</button><button type="button" className="button button-primary" disabled={busy} onClick={() => choose('add')}><ImagePlus size={16} aria-hidden="true" />{t('editor.add')}</button></div></div>
    {failure && <div className="stickers-notice" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>{failure}</span></div>}
    {discarding && <div className="stickers-confirm" role="group" aria-label={t('editor.unsaved')}><p>{t('editor.discard')}</p><div className="stickers-actions"><button type="button" className="button button-secondary" onClick={() => { setDiscarding(false); setPendingOpen(null) }}>{t('editor.keepDraft')}</button><button type="button" className="button button-primary" onClick={() => { const target = pendingOpen; setPendingOpen(null); void open(target) }}>{t('editor.discardAccept')}</button></div></div>}
    <div className="stickers-layout">
      <div ref={browser} className="stickers-browser">
        <form className="stickers-filter" onSubmit={applyFilters}><label htmlFor={`${id}-query`}>{t('search.label')}</label><div className="stickers-search"><Search size={16} aria-hidden="true" /><input id={`${id}-query`} value={query} maxLength={1000} onChange={event => setQuery(event.target.value)} placeholder={t('search.placeholder')} /><button className="button button-secondary" disabled={loading || busy}>{t('search.apply')}</button></div>
          <label htmlFor={`${id}-filter-tags`}>{t('tags.filter')}</label><select id={`${id}-filter-tags`} multiple value={chosenTags} size={Math.min(4, Math.max(2, tagList.tags.length))} onChange={event => setChosenTags([...event.currentTarget.selectedOptions].map(option => option.value))}><option value="" disabled>{t('tags.all')}</option>{tagList.tags.map(tag => <option key={tag.tag} value={tag.tag}>{t('tags.count', { tag: tag.tag, count: tag.count })}</option>)}</select><div className="stickers-filter-help"><small>{t('tags.and')}</small><button className="text-button" type="button" disabled={loading || busy} onClick={() => refresh(true)}>{t('search.reset')}</button></div></form>
        <div className="stickers-list" aria-busy={loading}>
          {loading && <p className="stickers-loading" role="status">{t('library.loading')}</p>}
          {!loading && page.items.length === 0 && <div className="stickers-empty"><Images size={30} aria-hidden="true" /><h4>{t(filter.query || filter.tags.length ? 'library.noResults' : 'library.empty')}</h4><p>{t(filter.query || filter.tags.length ? 'library.noResultsHelp' : 'library.emptyHelp')}</p></div>}
          {page.items.map(item => <button type="button" key={item.assetId} className={`stickers-row${selection?.item.assetId === item.assetId ? ' is-selected' : ''}`} aria-pressed={selection?.item.assetId === item.assetId} disabled={busy} onClick={() => choose(item)}><Images className="stickers-row-image" size={22} aria-hidden="true" /><span className="stickers-row-body"><strong>{item.description}</strong><span className="stickers-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</span><small>{t('editor.created', { date: formatDateTime(item.createdAt) })}</small></span><ChevronRight size={16} aria-hidden="true" /></button>)}
        </div>
        <nav className="stickers-pagination" aria-label={t('library.title')}><span>{t('library.page', { start: page.total ? page.offset + 1 : 0, end: Math.min(page.offset + page.items.length, page.total), total: page.total })}</span><div><button type="button" className="button button-secondary" disabled={loading || busy || page.offset === 0} aria-label={t('library.previous')} onClick={() => void load(filter, Math.max(0, page.offset - page.limit), page.revision)}><ChevronLeft size={17} aria-hidden="true" /></button><button type="button" className="button button-secondary" disabled={loading || busy || !page.hasMore} aria-label={t('library.next')} onClick={() => void load(filter, page.nextOffset!, page.revision)}><ChevronRight size={17} aria-hidden="true" /></button></div></nav>
      </div>
      <aside ref={editor} className="stickers-editor" aria-label={t(adding ? 'editor.add' : 'editor.edit')}>
        {!adding && !selection && !previewLoading ? <div className="stickers-empty"><Images size={32} aria-hidden="true" /><h4>{t('editor.placeholder')}</h4><p>{t('editor.placeholderHelp')}</p></div> : <>
          <div className="stickers-editor-heading"><h3>{t(adding ? 'editor.add' : 'editor.edit')}</h3><button className="icon-button" type="button" aria-label={t('editor.cancel')} onClick={() => choose(null)} disabled={busy}><X size={18} /></button></div>
          <div className="stickers-preview" aria-label={t('editor.preview')}>{previewLoading ? <p role="status">{t('library.loading')}</p> : previewUrl ? <img src={previewUrl} alt={t('editor.previewAlt')} onError={() => { replaceImage(null); setFailure(st('error.image')) }} /> : <p>{t('editor.previewCleared')}</p>}</div>
          <div className="stickers-preview-actions">{previewUrl && <button className="text-button" type="button" onClick={clearImage}>{t('editor.clearPreview')}</button>}{!adding && selection && !previewUrl && <button className="text-button" type="button" disabled={previewLoading} onClick={() => void open(selection.item, true)}>{t('editor.reloadPreview')}</button>}<small>{t('editor.previewHelp')}</small></div>
          <form onSubmit={save} className="stickers-edit-form"><fieldset disabled={busy || previewLoading}>
            {adding && <div className="stickers-field"><label htmlFor={`${id}-file`}>{t('editor.file')}</label><input ref={input} id={`${id}-file`} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => chooseFile(event.target.files?.[0])} /><small>{file ? t('editor.selectedFile', { name: file.name, size: bytesLabel(file.size) }) : t('editor.fileHelp')}</small></div>}
            <div className="stickers-field"><label htmlFor={`${id}-description`}>{t('editor.description')}</label><textarea ref={descriptionInput} id={`${id}-description`} rows={4} required maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} aria-describedby={`${id}-description-help`} /><small id={`${id}-description-help`}>{t('editor.descriptionHelp')}</small></div>
            <div className="stickers-field"><label htmlFor={`${id}-tags`}>{t('editor.tags')}</label><textarea id={`${id}-tags`} rows={3} value={tags} onChange={event => setTags(event.target.value)} aria-describedby={`${id}-tags-help`} /><small id={`${id}-tags-help`}>{t('editor.tagsHelp')}</small></div>
            {selection && <p className="stickers-metadata">{t('editor.bytes', { size: bytesLabel(selection.item.bytes), type: selection.item.mimeType })}</p>}
            <div className="stickers-actions"><button type="submit" className="button button-primary" disabled={busy || (!adding && !dirty)}>{t(busy ? 'editor.saving' : adding ? 'editor.upload' : 'editor.save')}</button>{dirty && <span className="stickers-dirty">{t('editor.unsaved')}</span>}</div>
          </fieldset></form>
          {!adding && selection && <div className="stickers-delete">{!deleting ? <button type="button" className="text-button" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={15} aria-hidden="true" />{t('editor.delete')}</button> : <div className="stickers-confirm" role="group" aria-label={t('editor.delete')}><p>{t('editor.deleteConfirm')}</p><div className="stickers-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setDeleting(false)}>{t('editor.cancel')}</button><button type="button" className="button button-danger" disabled={busy} onClick={() => void remove()}>{t('editor.deleteAccept')}</button></div></div>}</div>}
        </>}
      </aside>
    </div>
  </section>
}
