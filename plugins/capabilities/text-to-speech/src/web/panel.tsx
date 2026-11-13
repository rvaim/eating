import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ActionButton, createRequestId, hostRequest, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import { speechDefaults, speechVoices } from '../types'
import type { SpeechConfiguration, SpeechProvider } from '../types'
import { audioBlob, errorKey, manageSpeech, readConfig, readPage } from './data'
import './i18n'
import './panel.css'

interface Draft { endpoint: string; provider: SpeechProvider; timeout: string; key: string; clear: boolean }
const draftOf = (v: SpeechConfiguration): Draft => ({ endpoint: v.endpoint, provider: structuredClone(v.provider), timeout: String(v.timeoutMs / 1000), key: '', clear: false })
export function SpeechPanel({ onRefresh, enabled }: PluginPanelProps) {
  const { t, formatDateTime, formatNumber } = useI18n('text-to-speech'), prefix = useId()
  const [config, setConfig] = useState<SpeechConfiguration | null>(null), [draft, setDraft] = useState<Draft | null>(null), [dirty, setDirty] = useState(false)
  const [page, setPage] = useState<ReturnType<typeof readPage> | null>(null), [offset, setOffset] = useState(0), [input, setInput] = useState('')
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState(false)
  const [confirm, setConfirm] = useState<'generate' | 'reload' | string | null>(null), [preview, setPreview] = useState<string | null>(null), [visible, setVisible] = useState(() => !document.hidden)
  const alive = useRef(false), reads = useRef(new Set<AbortController>()), mutation = useRef<AbortController | null>(null), previewUrl = useRef<string | null>(null), previewTicket = useRef(0)
  const identity = useRef<{ intent: string; id: string } | null>(null), offsetRef = useRef(0)
  const listRequest = useRef<AbortController | null>(null)
  const enabledRef = useRef(enabled); enabledRef.current = enabled
  offsetRef.current = offset
  const clearPreview = useCallback(() => { ++previewTicket.current; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; if (alive.current) setPreview(null) }, [])
  const list = useCallback(async () => {
    if (!enabledRef.current || listRequest.current || document.hidden) return
    const controller = new AbortController(); reads.current.add(controller); const at = offsetRef.current
    listRequest.current = controller
    try { const value = readPage(await manageSpeech('jobs', { offset: at, limit: 20 }, controller.signal)); if (alive.current && enabledRef.current && !controller.signal.aborted && offsetRef.current === at) setPage(value) }
    catch (e) { if (alive.current && !controller.signal.aborted) setError(errorKey(e)) }
    finally { reads.current.delete(controller); if (listRequest.current === controller) listRequest.current = null }
  }, [])
  const load = useCallback(async () => {
    const controller = new AbortController(); reads.current.add(controller)
    try { const value = readConfig(await hostRequest<unknown>('/plugins/text-to-speech/configuration', { signal: controller.signal })); if (alive.current && !controller.signal.aborted) { setConfig(value); setDraft(draftOf(value)); setDirty(false); setError(null) } }
    catch (e) { if (alive.current && !controller.signal.aborted) setError(errorKey(e)) }
    finally { reads.current.delete(controller) }
  }, [])
  useEffect(() => {
    alive.current = true
    const hide = (event: Event) => { const hidden = document.hidden || event.type === 'pagehide'; setVisible(!hidden); if (hidden) { reads.current.forEach(c => c.abort()); reads.current.clear(); mutation.current?.abort(); mutation.current = null; setPending(false); setConfirm(null); setDraft(v => v ? { ...v, key: '' } : null); clearPreview() } }
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', hide)
    void load()
    return () => { alive.current = false; reads.current.forEach(c => c.abort()); reads.current.clear(); mutation.current?.abort(); clearPreview(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', hide) }
  }, [load, clearPreview])
  useEffect(() => {
    if (!enabled || !visible) return
    void list()
    return () => { listRequest.current?.abort(); listRequest.current = null }
  }, [enabled, visible, offset, list])
  const hasActiveJobs = page?.items.some(job => ['queued', 'running'].includes(job.status)) ?? false
  useEffect(() => {
    if (!enabled || !visible || !hasActiveJobs) return
    const timer = setInterval(() => { void list() }, 2000)
    return () => { clearInterval(timer) }
  }, [enabled, visible, hasActiveJobs, list])
  useEffect(() => {
    if (!enabled) { listRequest.current?.abort(); listRequest.current = null; mutation.current?.abort(); mutation.current = null; setPending(false); setConfirm(null); setError(null); clearPreview() }
  }, [enabled, clearPreview])
  useEffect(() => { if (confirm) document.getElementById(prefix + '-cancel')?.focus() }, [confirm, prefix])
  async function action(run: (signal: AbortSignal) => Promise<void>) {
    if (mutation.current || document.hidden) return
    const controller = new AbortController(); mutation.current = controller; setPending(true); setError(null); setNotice(false)
    try { await run(controller.signal) }
    catch (e) { if (alive.current && !controller.signal.aborted) setError(errorKey(e)) }
    finally { if (alive.current && mutation.current === controller) { mutation.current = null; setPending(false); setConfirm(null) } }
  }
  function change(values: Partial<Draft>) { setDraft(v => v ? { ...v, ...values } : null); setDirty(true); setNotice(false) }
  async function save(signal: AbortSignal) {
    if (!draft || !config) return
    const valid = (() => { try { const u = new URL(draft.endpoint); return (u.protocol === 'wss:' || u.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) && !u.username && !u.password && !u.search && !u.hash } catch { return false } })()
    if (!valid || draft.provider.protocol === 'openai-realtime' && !draft.provider.model.trim() || !/^\d+$/.test(draft.timeout) || Number(draft.timeout) < 10 || Number(draft.timeout) > 300) { setError('invalid'); return }
    const saved = readConfig(await hostRequest('/plugins/text-to-speech/configuration', { method: 'POST', signal, body: { expectedRevision: config.revision, endpoint: draft.endpoint, provider: draft.provider, timeoutMs: Number(draft.timeout) * 1000, apiKey: draft.key, clearApiKey: draft.clear } }))
    if (!alive.current || signal.aborted) return
    setConfig(saved); setDraft(draftOf(saved)); setDirty(false); setNotice(true); await onRefresh?.()
  }
  async function generate(signal: AbortSignal) {
    const intent = JSON.stringify([input, config?.revision])
    if (identity.current?.intent !== intent) identity.current = { intent, id: createRequestId() }
    await manageSpeech('generate', { text: input, request_id: identity.current.id, confirmed: true }, signal)
    if (alive.current && !signal.aborted) { setOffset(0); offsetRef.current = 0; await list() }
  }
  async function play(assetId: string) {
    clearPreview(); const ticket = previewTicket.current, controller = new AbortController(); reads.current.add(controller)
    try { const blob = audioBlob(await manageSpeech('preview', { assetId }, controller.signal)); if (alive.current && !controller.signal.aborted && ticket === previewTicket.current) { const url = URL.createObjectURL(blob); previewUrl.current = url; setPreview(url) } }
    catch (e) { if (alive.current && !controller.signal.aborted) setError(errorKey(e)) }
    finally { reads.current.delete(controller) }
  }
  return <div className="speech-panel" onKeyDown={e => { if (e.key === 'Escape') setConfirm(null) }}>
    <p className="speech-description">{t('description')}</p>
    {error && <p role="alert" className="speech-error">{t(error)}</p>}
    {notice && <p role="status" className="speech-success">{t('saved')}</p>}
    {!draft || !config ? <><p role="status">{t('loading')}</p><button type="button" className="text-button" onClick={() => void load()}>{t('refresh')}</button></> : <>
      <section aria-labelledby={prefix + '-settings'}><h3 id={prefix + '-settings'}>{t('configuration')}</h3><div className="speech-fields">
        <label className="speech-field speech-field-wide"><span>{t('protocol')}</span><select aria-label={t('protocol')} value={draft.provider.protocol} disabled={pending} onChange={e => { if (e.target.value === 'openai-realtime' || e.target.value === 'deepseek-tts') { change({ ...speechDefaults(e.target.value), key: '', clear: false }); clearPreview() } }}><option value="openai-realtime">OpenAI Realtime</option><option value="deepseek-tts">DeepSeek TTS</option></select><small>{t('provider.' + draft.provider.protocol)}</small></label>
        <label className="speech-field speech-field-wide"><span>{t('endpoint')}</span><input aria-label={t('endpoint')} value={draft.endpoint} disabled={pending} onChange={e => change({ endpoint: e.target.value })} /><small>{t('endpointHelp')}</small></label>
        {draft.provider.protocol === 'openai-realtime' && <label className="speech-field"><span>{t('model')}</span><input aria-label={t('model')} value={draft.provider.model} disabled={pending} onChange={e => { if (draft.provider.protocol === 'openai-realtime') change({ provider: { ...draft.provider, model: e.target.value } }) }} /></label>}
        <label className="speech-field"><span>{t('voice')}</span><select aria-label={t('voice')} value={draft.provider.voice} disabled={pending} onChange={e => change({ provider: { ...draft.provider, voice: e.target.value } as SpeechProvider })}>{speechVoices(draft.provider.protocol).map(v => <option key={v} value={v}>{v}</option>)}</select><small>{t('voiceHelp')}</small></label>
        {draft.provider.protocol === 'deepseek-tts' && <label className="speech-field"><span>{t('filterMarkdown')}</span><input type="checkbox" aria-label={t('filterMarkdown')} checked={draft.provider.filterMarkdown} disabled={pending} onChange={e => { if (draft.provider.protocol === 'deepseek-tts') change({ provider: { ...draft.provider, filterMarkdown: e.target.checked } }) }} /></label>}
        <label className="speech-field"><span>{t('key')}</span><input type="password" aria-label={t('key')} autoComplete="new-password" value={draft.key} placeholder={t(config.apiKeyConfigured && draft.provider.protocol === config.provider.protocol && draft.endpoint === config.endpoint ? 'keySaved' : 'keyEmpty')} disabled={pending} onChange={e => change({ key: e.target.value })} /></label>
        <label className="speech-field"><span>{t('timeout')}</span><input aria-label={t('timeout')} type="number" min="10" max="300" value={draft.timeout} disabled={pending} onChange={e => change({ timeout: e.target.value })} /></label>
      </div><label><input type="checkbox" checked={draft.clear} disabled={pending} onChange={e => change({ clear: e.target.checked })} /> {t('clearKey')}</label>
      <div className="speech-actions"><ActionButton reason={t('needSave')} className="button button-primary" disabled={pending || !dirty} onClick={() => void action(save)}>{t(pending ? 'working' : 'save')}</ActionButton><button type="button" className="button button-secondary" disabled={pending} onClick={() => dirty ? setConfirm('reload') : void load()}>{t('refresh')}</button></div>
      </section>
      <section aria-labelledby={prefix + '-try'}><h3 id={prefix + '-try'}>{t('preview')}</h3><p className="speech-description">{t('previewHelp')}</p><label className="speech-field"><span>{t('text')}</span><textarea aria-label={t('text')} maxLength={1000} value={input} onChange={e => setInput(e.target.value)} disabled={pending} /></label><div className="speech-actions"><ActionButton reason={t(!enabled ? 'disabled' : dirty ? 'needSave' : 'notReady')} className="button button-primary" disabled={!enabled || pending || dirty || !input.trim() || !config.ready} onClick={() => setConfirm('generate')}>{t('generate')}</ActionButton></div></section>
    </>}
    {confirm && <div className="speech-confirm" role="group" aria-label={t(confirm === 'generate' ? 'charge' : confirm === 'reload' ? 'reloadQuestion' : 'deleteHelp')}><p>{t(confirm === 'generate' ? 'charge' : confirm === 'reload' ? 'reloadQuestion' : 'deleteHelp')}</p><div className="speech-actions"><button type="button" id={prefix + '-cancel'} className="button button-secondary" disabled={pending} onClick={() => setConfirm(null)}>{t('cancel')}</button><button type="button" className="button button-primary" disabled={pending} onClick={() => { if (confirm === 'reload') { setConfirm(null); void load() } else if (confirm === 'generate') void action(generate); else void action(async signal => { await manageSpeech('delete', { jobId: confirm, confirmed: true }, signal); clearPreview(); await list() }) }}>{t(confirm === 'generate' ? 'confirm' : confirm === 'reload' ? 'reload' : 'confirmDelete')}</button></div></div>}
    {preview && <audio className="speech-player" controls src={preview} aria-label={t('audioLabel')} />}
    <section aria-labelledby={prefix + '-jobs'}><h3 id={prefix + '-jobs'}>{t('jobs')}</h3>{!enabled ? <p className="speech-description">{t('disabled')}</p> : !page?.items.length ? <p className="speech-description">{t('empty')}</p> : <ul className="speech-jobs">{page.items.map(job => <li className="speech-job" key={job.jobId}><header><strong>{t('status.' + job.status)}</strong><span>{job.voice}</span><small>{job.protocol === 'deepseek-tts' ? 'DeepSeek TTS' : 'OpenAI Realtime'}</small><time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>{job.durationMs !== null && <small>{t('seconds', { value: formatNumber(job.durationMs / 1000, { maximumFractionDigits: 1 }) })}</small>}</header><p>{job.text}</p>{job.errorCode && <p className="speech-error">{t(errorKey(job.errorCode))}</p>}{job.status === 'unknown' && <p>{t('unknown')}</p>}<div className="speech-actions">{job.assetId && <button type="button" className="button button-secondary" onClick={() => void play(job.assetId!)}>{t('play')}</button>}{!['queued', 'running'].includes(job.status) && <button type="button" className="text-button" disabled={pending} onClick={() => setConfirm(job.jobId)}>{t('delete')}</button>}</div></li>)}</ul>}
      <div className="speech-actions"><button type="button" className="text-button" disabled={!enabled || pending} onClick={() => void list()}>{t('refreshJobs')}</button><button type="button" className="text-button" disabled={!enabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{t('previous')}</button><button type="button" className="text-button" disabled={!enabled || !page || offset + 20 >= page.total} onClick={() => setOffset(offset + 20)}>{t('next')}</button>{page && <small>{t('page', { count: page.total, formatted: formatNumber(page.total), offset: formatNumber(offset + 1) })}</small>}</div>
    </section>
  </div>
}
