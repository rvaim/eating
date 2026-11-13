import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { checkedInputAudio, MAX_INPUT_AUDIO_BYTES } from '@eating/plugin-sdk'
import { ActionButton, createRequestId, hostRequest, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { RecognitionConfiguration } from '../types'
import { errorKey, manageRecognition, readConfig, readPage } from './data'
import './i18n'
import './panel.css'
interface Draft { endpoint: string; timeout: string; key: string; clear: boolean }
const draftOf = (v: RecognitionConfiguration): Draft => ({ endpoint: v.endpoint, timeout: String(v.timeoutMs / 1000), key: '', clear: false })
export function RecognitionPanel({ enabled, onRefresh }: PluginPanelProps) {
  const { t, formatNumber, formatDateTime } = useI18n('speech-to-text'), prefix = useId()
  const [config, setConfig] = useState<RecognitionConfiguration | null>(null), [draft, setDraft] = useState<Draft | null>(null), [dirty, setDirty] = useState(false)
  const [page, setPage] = useState<ReturnType<typeof readPage> | null>(null), [offset, setOffset] = useState(0), [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState(false), [confirm, setConfirm] = useState<string | null>(null), [visible, setVisible] = useState(() => !document.hidden)
  const [fullTranscript, setFullTranscript] = useState<{ jobId: string; text: string } | null>(null)
  const [upload, setUpload] = useState<{ bytes: Uint8Array; name: string; durationMs: number; ticket: number } | null>(null)
  const alive = useRef(false), reads = useRef(new Set<AbortController>()), listRequest = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null)
  const enabledRef = useRef(enabled), offsetRef = useRef(offset), fileInput = useRef<HTMLInputElement | null>(null), ticket = useRef(0), identity = useRef<{ intent: string; id: string } | null>(null)
  enabledRef.current = enabled; offsetRef.current = offset
  const clearUpload = useCallback(() => { ++ticket.current; setUpload(null); if (fileInput.current) fileInput.current.value = '' }, [])
  const list = useCallback(async () => {
    if (!enabledRef.current || listRequest.current || document.hidden) return
    const c = new AbortController(), at = offsetRef.current; listRequest.current = c; reads.current.add(c)
    try { const v = readPage(await manageRecognition('jobs', { offset: at, limit: 20 }, c.signal)); if (alive.current && enabledRef.current && !c.signal.aborted && at === offsetRef.current) setPage(v) }
    catch (e) { if (alive.current && !c.signal.aborted) setError(errorKey(e)) }
    finally { reads.current.delete(c); if (listRequest.current === c) listRequest.current = null }
  }, [])
  const load = useCallback(async () => {
    const c = new AbortController(); reads.current.add(c)
    try { const v = readConfig(await hostRequest('/plugins/speech-to-text/configuration', { signal: c.signal })); if (alive.current && !c.signal.aborted) { setConfig(v); setDraft(draftOf(v)); setDirty(false); setError(null) } }
    catch (e) { if (alive.current && !c.signal.aborted) setError(errorKey(e)) }
    finally { reads.current.delete(c) }
  }, [])
  useEffect(() => {
    alive.current = true
    const hide = (e: Event) => { const hidden = document.hidden || e.type === 'pagehide'; setVisible(!hidden); if (hidden) { reads.current.forEach(c => c.abort()); reads.current.clear(); mutation.current?.abort(); mutation.current = null; setPending(false); setConfirm(null); setDraft(v => v ? { ...v, key: '' } : null); clearUpload(); setFullTranscript(null) } }
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', hide); void load()
    return () => { alive.current = false; ++ticket.current; reads.current.forEach(c => c.abort()); mutation.current?.abort(); if (fileInput.current) fileInput.current.value = ''; document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', hide) }
  }, [load, clearUpload])
  useEffect(() => { if (!enabled || !visible) return; void list(); return () => { listRequest.current?.abort(); listRequest.current = null } }, [enabled, visible, offset, list])
  const active = page?.items.some(j => ['queued', 'running'].includes(j.status)) ?? false
  useEffect(() => { if (!enabled || !visible || !active) return; const timer = setInterval(() => void list(), 2000); return () => clearInterval(timer) }, [enabled, visible, active, list])
  useEffect(() => { if (!enabled) { listRequest.current?.abort(); listRequest.current = null; mutation.current?.abort(); mutation.current = null; setPending(false); setConfirm(null); clearUpload(); setFullTranscript(null) } }, [enabled, clearUpload])
  useEffect(() => { if (confirm) document.getElementById(prefix + '-cancel')?.focus() }, [confirm, prefix])
  function change(v: Partial<Draft>) { setDraft(d => d ? { ...d, ...v } : null); setDirty(true); setNotice(false) }
  async function action(run: (signal: AbortSignal) => Promise<void>) {
    if (mutation.current || document.hidden) return
    const c = new AbortController(); mutation.current = c; setPending(true); setError(null); setNotice(false)
    try { await run(c.signal) } catch (e) { if (alive.current && !c.signal.aborted) setError(errorKey(e)) }
    finally { if (alive.current && mutation.current === c) { mutation.current = null; setPending(false); setConfirm(null) } }
  }
  async function save(signal: AbortSignal) {
    if (!draft || !config) return
    const valid = (() => { try { const u = new URL(draft.endpoint); return (u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) && !u.username && !u.password && !u.hash && !u.search } catch { return false } })()
    if (!valid || !/^\d+$/.test(draft.timeout) || Number(draft.timeout) < 10 || Number(draft.timeout) > 600) { setError('invalid'); return }
    const v = readConfig(await hostRequest('/plugins/speech-to-text/configuration', { method: 'POST', signal, body: { expectedRevision: config.revision, endpoint: draft.endpoint, provider: { protocol: 'deepseek-asr' }, timeoutMs: Number(draft.timeout) * 1000, apiKey: draft.key, clearApiKey: draft.clear } }))
    if (alive.current && !signal.aborted) { setConfig(v); setDraft(draftOf(v)); setDirty(false); setNotice(true); await onRefresh?.() }
  }
  async function selectFile(file: File | undefined) {
    const at = ++ticket.current; setUpload(null); setError(null)
    if (!file || document.hidden) return
    try {
      if (file.size > MAX_INPUT_AUDIO_BYTES) throw new Error('Too large')
      const checked = checkedInputAudio(new Uint8Array(await file.arrayBuffer()))
      if (alive.current && at === ticket.current && !document.hidden) setUpload({ ...checked, name: file.name, ticket: at })
    } catch { if (alive.current && at === ticket.current) { setError('invalidAudio'); if (fileInput.current) fileInput.current.value = '' } }
  }
  async function showTranscript(jobId: string) {
    const c = new AbortController(); reads.current.add(c)
    try { const job = await manageRecognition('job', { jobId }, c.signal) as { jobId: string; text: string | null }; if (alive.current && !c.signal.aborted && job.jobId === jobId && typeof job.text === 'string' && job.text.length <= 32000) setFullTranscript({ jobId, text: job.text }) }
    catch (e) { if (alive.current && !c.signal.aborted) setError(errorKey(e)) }
    finally { reads.current.delete(c) }
  }
  async function generate(signal: AbortSignal) {
    if (!upload) { setError('noFile'); return }
    const intent = JSON.stringify([upload.ticket, config?.revision])
    if (identity.current?.intent !== intent) identity.current = { intent, id: createRequestId() }
    let binary = ''; for (let at = 0; at < upload.bytes.length; at += 32768) binary += String.fromCharCode(...upload.bytes.subarray(at, at + 32768))
    await manageRecognition('transcribe', { data: btoa(binary), request_id: identity.current.id, confirmed: true }, signal)
    if (alive.current && !signal.aborted) { setOffset(0); offsetRef.current = 0; await list() }
  }
  return <div className="recognition-panel" onKeyDown={e => { if (e.key === 'Escape') setConfirm(null) }}>
    <p className="recognition-description">{t('description')}</p>
    {error && <p role="alert" className="recognition-error">{t(error)}</p>}{notice && <p role="status" className="recognition-success">{t('saved')}</p>}
    {!config || !draft ? <><p role="status">{t('loading')}</p><button type="button" className="text-button" onClick={() => void load()}>{t('refresh')}</button></> : <>
      <section aria-labelledby={prefix + '-settings'}><h3 id={prefix + '-settings'}>{t('configuration')}</h3><div className="recognition-fields">
        <label className="recognition-field recognition-field-wide"><span>{t('protocol')}</span><select aria-label={t('protocol')} value="deepseek-asr" disabled={pending} onChange={() => {}}><option value="deepseek-asr">DeepSeek ASR</option></select><small>{t('protocolHelp')}</small></label>
        <label className="recognition-field recognition-field-wide"><span>{t('endpoint')}</span><input aria-label={t('endpoint')} value={draft.endpoint} disabled={pending} onChange={e => change({ endpoint: e.target.value })} /><small>{t('endpointHelp')}</small></label>
        <label className="recognition-field"><span>{t('key')}</span><input type="password" aria-label={t('key')} autoComplete="new-password" value={draft.key} placeholder={t(config.apiKeyConfigured && draft.endpoint === config.endpoint ? 'keySaved' : 'keyEmpty')} disabled={pending} onChange={e => change({ key: e.target.value })} /></label>
        <label className="recognition-field"><span>{t('timeout')}</span><input type="number" aria-label={t('timeout')} min="10" max="600" value={draft.timeout} disabled={pending} onChange={e => change({ timeout: e.target.value })} /></label>
      </div><label><input type="checkbox" checked={draft.clear} disabled={pending} onChange={e => change({ clear: e.target.checked })} /> {t('clearKey')}</label><div className="recognition-actions"><ActionButton reason={t('needSave')} className="button button-primary" disabled={pending || !dirty} onClick={() => void action(save)}>{t(pending ? 'working' : 'save')}</ActionButton><button type="button" className="button button-secondary" disabled={pending} onClick={() => dirty ? setConfirm('reload') : void load()}>{t('refresh')}</button></div></section>
      <section aria-labelledby={prefix + '-upload'}><h3 id={prefix + '-upload'}>{t('preview')}</h3><label className="recognition-field"><span>{t('file')}</span><input ref={fileInput} aria-label={t('file')} type="file" accept=".wav,.ogg,.opus,audio/wav,audio/ogg" disabled={pending} onChange={e => void selectFile(e.target.files?.[0])} /><small>{t('fileHelp')}</small></label>{upload && <p className="recognition-description">{t('selected', { name: upload.name, seconds: formatNumber(upload.durationMs / 1000, { maximumFractionDigits: 1 }) })}</p>}<div className="recognition-actions"><ActionButton reason={t(!enabled ? 'disabled' : dirty ? 'needSave' : !config.ready ? 'notReady' : 'noFile')} className="button button-primary" disabled={!enabled || pending || dirty || !config.ready || !upload} onClick={() => setConfirm('generate')}>{t('generate')}</ActionButton></div></section>
    </>}
    {confirm && <div className="recognition-confirm" role="group" aria-label={t(confirm === 'generate' ? 'charge' : confirm === 'reload' ? 'reloadQuestion' : 'deleteHelp')}><p>{t(confirm === 'generate' ? 'charge' : confirm === 'reload' ? 'reloadQuestion' : 'deleteHelp')}</p><div className="recognition-actions"><button type="button" id={prefix + '-cancel'} className="button button-secondary" disabled={pending} onClick={() => setConfirm(null)}>{t('cancel')}</button><button type="button" className="button button-primary" disabled={pending} onClick={() => { if (confirm === 'reload') { setConfirm(null); void load() } else if (confirm === 'generate') void action(generate); else void action(async signal => { await manageRecognition('delete', { jobId: confirm, confirmed: true }, signal); setFullTranscript(null); await list() }) }}>{t(confirm === 'generate' ? 'confirm' : confirm === 'reload' ? 'reload' : 'confirmDelete')}</button></div></div>}
    <section aria-labelledby={prefix + '-jobs'}><h3 id={prefix + '-jobs'}>{t('jobs')}</h3>{!enabled ? <p className="recognition-description">{t('disabled')}</p> : !page?.items.length ? <p className="recognition-description">{t('empty')}</p> : <ul className="recognition-jobs">{page.items.map(j => <li className="recognition-job" key={j.jobId}><header><strong>{t('status.' + j.status)}</strong><time dateTime={j.createdAt}>{formatDateTime(j.createdAt)}</time></header>{j.textPreview !== null && <p className="recognition-result">{(fullTranscript?.jobId === j.jobId ? fullTranscript.text : j.textPreview) || t('silence')}</p>}{j.textTruncated && fullTranscript?.jobId !== j.jobId && <button type="button" className="text-button" onClick={() => void showTranscript(j.jobId)}>{t('fullTranscript')}</button>}{j.errorCode && <p className="recognition-error">{t(errorKey(j.errorCode))}</p>}{j.status === 'unknown' && <p>{t('unknown')}</p>}{!['queued', 'running'].includes(j.status) && <button type="button" className="text-button" disabled={pending} onClick={() => setConfirm(j.jobId)}>{t('delete')}</button>}</li>)}</ul>}<div className="recognition-actions"><button type="button" className="text-button" disabled={!enabled || pending} onClick={() => void list()}>{t('refreshJobs')}</button><button type="button" className="text-button" disabled={!enabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{t('previous')}</button><button type="button" className="text-button" disabled={!enabled || !page || offset + 20 >= page.total} onClick={() => setOffset(offset + 20)}>{t('next')}</button>{page && <small>{t('page', { count: page.total, formatted: formatNumber(page.total) })}</small>}</div></section>
  </div>
}
