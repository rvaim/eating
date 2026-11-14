import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { ActionButton, createRequestId, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import type { PluginPanelProps } from '@eating/ui-sdk'
import type { PublicAndroidConfiguration } from '../types'
import './i18n'
import './panel.css'

interface Draft { mode: 'local' | 'remote'; adbPath: string; workspace: string; endpoint: string; token: string; clear: boolean }
const draftOf = (c: PublicAndroidConfiguration): Draft => ({ mode: c.mode, adbPath: c.adbPath, workspace: c.workspace, endpoint: c.endpoint, token: '', clear: false })
function configOf(v: unknown): PublicAndroidConfiguration {
  if (!isJsonObject(v) || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || v.mode !== 'local' && v.mode !== 'remote' || !['adbPath', 'workspace', 'endpoint'].every(key => typeof v[key] === 'string') || typeof v.tokenConfigured !== 'boolean' || typeof v.ready !== 'boolean') throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
  return v as unknown as PublicAndroidConfiguration
}
function structured(v: unknown): JsonObject {
  if (!isJsonObject(v)) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
  if (isJsonObject(v.structuredContent)) return v.structuredContent
  return v
}
const manage = (operation: string, input: object, signal: AbortSignal) => hostRequest<unknown>('/plugins/android-control/manage', { method: 'POST', body: { operation, input }, signal })
function bytesFrom(data: string): Uint8Array<ArrayBuffer> { const text = atob(data), bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes }
function base64(bytes: Uint8Array): string { let text = ''; for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(text) }

export function AndroidPanel({ enabled, saved, onRefresh }: PluginPanelProps) {
  const { t, formatDateTime } = useI18n('android-control'), prefix = useId()
  const [config, setConfig] = useState<PublicAndroidConfiguration | null>(null), [draft, setDraft] = useState<Draft | null>(null), [dirty, setDirty] = useState(false)
  const [argv, setArgv] = useState('["devices", "-l"]'), [terminal, setTerminal] = useState(false), [stdin, setStdin] = useState(''), [serial, setSerial] = useState('')
  const [processes, setProcesses] = useState<JsonObject[]>([]), [selected, setSelected] = useState<string | null>(null), [output, setOutput] = useState(''), [image, setImage] = useState<string | null>(null)
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout'), [lastMeta, setLastMeta] = useState<JsonObject | null>(null), cursors = useRef<Record<string, number>>({})
  const writeIdentity = useRef<{ intent: string; id: string } | null>(null)
  const [path, setPath] = useState(''), [file, setFile] = useState<File | null>(null), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [confirmPrune, setConfirmPrune] = useState(false), [visible, setVisible] = useState(() => !document.hidden)
  const alive = useRef(false), requests = useRef(new Set<AbortController>()), mutation = useRef<AbortController | null>(null), imageRef = useRef<string | null>(null), enabledRef = useRef(enabled), readyRef = useRef(false), identity = useRef<{ intent: string; id: string } | null>(null), uploadIdentity = useRef<{ file: File; path: string; offset: number; id: string } | null>(null)
  enabledRef.current = enabled; readyRef.current = config?.ready === true
  const hostReady = saved?.values.ready === true
  useEffect(() => { setConfig(current => current ? { ...current, ready: hostReady } : current) }, [hostReady])
  const clearImage = useCallback(() => { if (imageRef.current) URL.revokeObjectURL(imageRef.current); imageRef.current = null; setImage(null) }, [])
  const read = useCallback(async (callback: (signal: AbortSignal) => Promise<void>) => { const c = new AbortController(); requests.current.add(c); try { await callback(c.signal) } catch (e) { if (alive.current && !c.signal.aborted) setError(errorCode(e)) } finally { requests.current.delete(c) } }, [])
  const load = useCallback(async () => read(async signal => { const value = configOf(await hostRequest('/plugins/android-control/configuration', { signal })); if (alive.current && !signal.aborted) { setConfig(value); setDraft(draftOf(value)); setDirty(false) } }), [read])
  const refreshProcesses = useCallback(async () => { if (!enabledRef.current || !readyRef.current || document.hidden) return; await read(async signal => { const value = structured(await manage('state', {}, signal)); if (!Array.isArray(value.processes) || value.processes.some(p => !isJsonObject(p) || typeof p.processId !== 'string' || typeof p.status !== 'string')) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed'); if (alive.current && !signal.aborted) setProcesses(value.processes as JsonObject[]) }) }, [read])
  useEffect(() => {
    alive.current = true; void load()
    const visibility = () => { setVisible(!document.hidden); if (document.hidden) { for (const c of requests.current) c.abort(); mutation.current?.abort(); clearImage(); setOutput(''); setLastMeta(null); cursors.current = {}; setDraft(d => d ? { ...d, token: '' } : d); setFile(null); uploadIdentity.current = null } }
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', visibility)
    return () => { alive.current = false; for (const c of requests.current) c.abort(); mutation.current?.abort(); if (imageRef.current) URL.revokeObjectURL(imageRef.current); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', visibility) }
  }, [load, clearImage])
  useEffect(() => { if (!enabled || !visible || !config?.ready) return; void refreshProcesses(); const timer = setInterval(() => { void refreshProcesses() }, 2000); return () => clearInterval(timer) }, [enabled, visible, config?.ready, refreshProcesses])
  async function action(callback: (signal: AbortSignal) => Promise<void>) {
    if (mutation.current) return
    const c = new AbortController(); mutation.current = c; setPending(true); setError(null); setNotice(null)
    try { await callback(c.signal); if (alive.current && !c.signal.aborted) await refreshProcesses() } catch (e) { if (alive.current && !c.signal.aborted) setError(errorCode(e)) }
    finally { if (mutation.current === c) mutation.current = null; if (alive.current) setPending(false) }
  }
  function display(value: unknown, append = false) {
    const meta = structured(value)
    const hasImage = isJsonObject(value) && Array.isArray(value.content) && value.content.some(b => isJsonObject(b) && b.type === 'image')
    const text = typeof meta.text === 'string' ? meta.text : JSON.stringify(meta, null, 2)
    if (!hasImage) setOutput(previous => (append ? previous + text : text).slice(-262144))
    setLastMeta(meta)
    if (typeof meta.processId === 'string' && typeof meta.stream === 'string' && typeof meta.nextOffset === 'number') cursors.current[meta.processId + '.' + meta.stream] = meta.nextOffset
    if (typeof meta.processId === 'string') setSelected(meta.processId)
    if (isJsonObject(value) && Array.isArray(value.content)) {
      const block = value.content.find(b => isJsonObject(b) && b.type === 'image')
      if (isJsonObject(block) && typeof block.data === 'string' && typeof block.mimeType === 'string') { clearImage(); const url = URL.createObjectURL(new Blob([bytesFrom(block.data)], { type: block.mimeType })); imageRef.current = url; setImage(url) }
    }
  }
  async function invoke(name: string, args: JsonObject, signal: AbortSignal, requestId?: string, readOnly = false): Promise<unknown> {
    const automatic = requestId === undefined && !readOnly
    if (automatic) { const intent = JSON.stringify([name, args]); if (writeIdentity.current?.intent !== intent) writeIdentity.current = { intent, id: createRequestId() }; requestId = writeIdentity.current.id }
    requestId ??= createRequestId()
    const value = await hostRequest<unknown>('/plugins/android-control/invoke', { method: 'POST', body: { name, arguments: { ...args, ...(!readOnly ? { request_id: requestId } : {}) }, requestId, confirmed: !readOnly }, signal })
    if (!isJsonObject(value) || value.ok !== true || !Object.hasOwn(value, 'result')) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'unknown')
    if (automatic) writeIdentity.current = null
    return value.result
  }
  async function run(signal: AbortSignal) {
    let args: unknown; try { args = JSON.parse(argv) } catch { throw new Error('invalidArgs') }
    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('invalidArgs')
    const intent = JSON.stringify([args, terminal])
    if (identity.current?.intent !== intent) identity.current = { intent, id: createRequestId() }
    const value = await invoke('android_adb_exec', { args, terminal }, signal, identity.current.id)
    if (alive.current && !signal.aborted) { display(value); identity.current = null }
  }
  async function save(signal: AbortSignal) {
    if (!config || !draft) return
    const value = configOf(await hostRequest('/plugins/android-control/configuration', { method: 'POST', body: { expectedRevision: config.revision, mode: draft.mode, adbPath: draft.adbPath, workspace: draft.workspace, endpoint: draft.endpoint, token: draft.token, clearToken: draft.clear }, signal }))
    if (alive.current && !signal.aborted) { setConfig(value); setDraft(draftOf(value)); setDirty(false); setNotice('saved'); await onRefresh?.() }
  }
  function change(value: Partial<Draft>) { setDraft(d => d ? { ...d, ...value } : d); setDirty(true); setNotice(null) }
  async function upload(signal: AbortSignal) {
    if (!file || !path) return
    if (!uploadIdentity.current || uploadIdentity.current.file !== file || uploadIdentity.current.path !== path) uploadIdentity.current = { file, path, offset: 0, id: createRequestId() }
    const current = uploadIdentity.current
    do {
      const bytes = new Uint8Array(await file.slice(current.offset, current.offset + 65536).arrayBuffer())
      const value = structured(await invoke('android_files', { op: 'put', path, data: base64(bytes), offset: current.offset, overwrite: current.offset === 0 }, signal, current.id))
      if (value.nextOffset !== current.offset + bytes.length) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'unknown')
      current.offset += bytes.length; current.id = createRequestId()
      if (signal.aborted) return
    } while (current.offset < file.size)
    uploadIdentity.current = null; if (alive.current) setNotice('uploaded')
  }
  async function download(signal: AbortSignal) {
    if (!path) return
    const parts: Uint8Array<ArrayBuffer>[] = []; let offset = 0, total = 0
    do {
      const value = structured(await invoke('android_files', { op: 'get', path, offset, output: 'binary' }, signal))
      if (typeof value.data !== 'string' || typeof value.nextOffset !== 'number' || typeof value.bytes !== 'number' || value.nextOffset < offset || value.nextOffset === offset && value.bytes > offset) throw new HostApiError('ANDROID_RESPONSE_INVALID', '', 'failed')
      total = value.bytes; parts.push(bytesFrom(value.data)); offset = value.nextOffset
    } while (offset < total && !signal.aborted)
    if (signal.aborted) return
    const url = URL.createObjectURL(new Blob(parts)), link = document.createElement('a'); link.href = url; link.download = path.split(/[\\/]/).at(-1) || 'download'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const disabled = !enabled || !config?.ready || pending || dirty
  return <div className="android-panel">
    <p className="android-description">{t('description')}</p>
    {error && <p role="alert" className="android-error">{t(error)}</p>}{notice && <p role="status" className="android-success">{t(notice)}</p>}
    <section aria-labelledby={prefix + '-configuration'}><h3 id={prefix + '-configuration'}>{t('configuration')}</h3>{!config || !draft ? <p role="status">{t('loading')}</p> : <>
      <div className="android-fields"><label className="android-field"><span>{t('mode')}</span><select aria-label={t('mode')} disabled={pending || config.ready} value={draft.mode} onChange={e => change({ mode: e.target.value as Draft['mode'] })}><option value="local">{t('local')}</option><option value="remote">{t('remote')}</option></select></label>
        {draft.mode === 'local' ? <><label className="android-field"><span>{t('adb')}</span><input aria-label={t('adb')} value={draft.adbPath} disabled={pending || config.ready} onChange={e => change({ adbPath: e.target.value })} /><small>{t('adbHelp')}</small></label><label className="android-field android-field-wide"><span>{t('workspace')}</span><input aria-label={t('workspace')} value={draft.workspace} disabled={pending || config.ready} onChange={e => change({ workspace: e.target.value })} /><small>{t('workspaceHelp')}</small></label></> : <><label className="android-field android-field-wide"><span>{t('endpoint')}</span><input aria-label={t('endpoint')} value={draft.endpoint} disabled={pending || config.ready} onChange={e => change({ endpoint: e.target.value })} /></label><label className="android-field"><span>{t('token')}</span><input type="password" autoComplete="new-password" aria-label={t('token')} value={draft.token} placeholder={t(config.tokenConfigured ? 'tokenSaved' : 'tokenEmpty')} disabled={pending || config.ready} onChange={e => change({ token: e.target.value })} /></label></>}
      </div>{draft.mode === 'remote' && <label className="android-check"><input type="checkbox" checked={draft.clear} disabled={pending || config.ready} onChange={e => change({ clear: e.target.checked })} />{t('clearToken')}</label>}
      <div className="android-actions"><ActionButton reason={t(config.ready ? 'stopFirst' : 'dirty')} disabled={pending || !dirty || config.ready} className="button button-primary" onClick={() => void action(save)}>{t('save')}</ActionButton><button type="button" className="button button-secondary" disabled={!enabled || pending || dirty} onClick={() => void action(async signal => { await hostRequest('/plugins/android-control/' + (config.ready ? 'disconnect' : 'connect'), { method: 'POST', body: {}, signal }); await load(); await onRefresh?.() })}>{t(config.ready ? 'disconnect' : 'connect')}</button><button className="button button-secondary" disabled={pending} type="button" onClick={() => void load()}>{t('refresh')}</button></div>
    </>}</section>
    <section aria-labelledby={prefix + '-console'}><h3 id={prefix + '-console'}>{t('console')}</h3>{!enabled || !config?.ready ? <p className="android-description">{t(!enabled ? 'disabled' : 'disconnected')}</p> : null}
      <label className="android-field"><span>{t('arguments')}</span><textarea className="android-argv" aria-label={t('arguments')} spellCheck={false} value={argv} disabled={pending} onChange={e => setArgv(e.target.value)} /><small>{t('argsHelp')}</small></label>
      <div className="android-actions"><label className="android-check"><input type="checkbox" checked={terminal} disabled={pending} onChange={e => setTerminal(e.target.checked)} />{t('terminal')}</label><ActionButton className="button button-primary" disabled={disabled} reason={t(dirty ? 'dirty' : 'disabled')} onClick={() => void action(run)}>{t(pending ? 'working' : 'run')}</ActionButton><button type="button" className="button button-secondary" disabled={!enabled || !config?.ready || pending} onClick={() => void action(async signal => { await manage('takeover', {}, signal); await refreshProcesses() })}>{t('takeover')}</button></div>
      <h3 style={{ marginTop: 24 }}>{t('processes')}</h3>{!processes.length ? <p className="android-description">{t('noProcesses')}</p> : <ul className="android-processes">{processes.map(p => <li key={String(p.processId)}><button type="button" className="text-button" onClick={() => { setSelected(String(p.processId)); void action(async signal => display(await invoke('android_process_read', { process_id: String(p.processId) }, signal, createRequestId(), true))) }}>{t('status.' + String(p.status))}</button><code>{String(p.processId).slice(0, 8)}</code>{typeof p.createdAt === 'string' && <time dateTime={p.createdAt}>{formatDateTime(p.createdAt)}</time>}</li>)}</ul>}
      <div className="android-actions"><button type="button" className="text-button" disabled={disabled || !selected} onClick={() => void action(async signal => display(await invoke('android_process_read', { process_id: selected!, stream, offset: cursors.current[selected! + '.' + stream] ?? 0 }, signal, createRequestId(), true), true))}>{t('read')}</button><button type="button" className="text-button" disabled={disabled || !selected} onClick={() => void action(async signal => display(await invoke('android_process_stop', { process_id: selected!, signal: 'interrupt' }, signal)))}>{t('interrupt')}</button><button type="button" className="text-button" disabled={disabled || !selected} onClick={() => void action(async signal => display(await invoke('android_process_stop', { process_id: selected! }, signal)))}>{t('stop')}</button><button type="button" className="text-button" disabled={disabled} onClick={() => setConfirmPrune(true)}>{t('prune')}</button></div>
      {confirmPrune && <div role="group" aria-label={t('confirmPrune')}><p>{t('confirmPrune')}</p><div className="android-actions"><button type="button" className="button button-secondary" onClick={() => setConfirmPrune(false)}>{t('cancel')}</button><button type="button" className="button button-primary" disabled={pending} onClick={() => void action(async signal => { await manage('prune', { confirmed: true }, signal); setConfirmPrune(false); setSelected(null) })}>{t('prune')}</button></div></div>}
      <label className="android-field" style={{ marginTop: 16 }}><span>{t('stdin')}</span><textarea aria-label={t('stdin')} value={stdin} disabled={pending} onChange={e => setStdin(e.target.value)} /></label><div className="android-actions"><button type="button" className="button button-secondary" disabled={disabled || !selected} onClick={() => void action(async signal => { display(await invoke('android_process_write', { process_id: selected!, data: stdin }, signal)); setStdin('') })}>{t('send')}</button><button type="button" className="text-button" disabled={disabled || !selected} onClick={() => void action(async signal => display(await invoke('android_process_write', { process_id: selected!, eof: true }, signal)))}>{t('eof')}</button></div>
      <h3 style={{ marginTop: 24 }}>{t('output')}</h3><label className="android-field"><span>{t('stream')}</span><select aria-label={t('stream')} value={stream} onChange={e => { setStream(e.target.value as 'stdout' | 'stderr'); setOutput('') }}><option value="stdout">stdout</option><option value="stderr">stderr</option></select></label>{lastMeta?.exitCode !== undefined && lastMeta.exitCode !== null && <p>{t('exitCode')}: {String(lastMeta.exitCode)}</p>}<pre className="android-output" aria-label={t('output')}>{output || t('emptyOutput')}</pre>
    </section>
    <section aria-labelledby={prefix + '-screen'}><h3 id={prefix + '-screen'}>{t('screenshot')}</h3><label className="android-field"><span>{t('serial')}</span><input aria-label={t('serial')} value={serial} onChange={e => setSerial(e.target.value)} /><small>{t('screenshotHelp')}</small></label><div className="android-actions"><button type="button" className="button button-secondary" disabled={disabled} onClick={() => void action(async signal => display(await invoke('android_screenshot', serial ? { serial } : {}, signal, createRequestId(), true)))}>{t('screenshot')}</button>{image && <button type="button" className="text-button" onClick={clearImage}>{t('clearImage')}</button>}</div>{image && <img className="android-screen" src={image} alt={t('image')} />}</section>
    <section aria-labelledby={prefix + '-files'}><h3 id={prefix + '-files'}>{t('files')}</h3><label className="android-field"><span>{t('path')}</span><input aria-label={t('path')} value={path} disabled={pending} onChange={e => setPath(e.target.value)} /></label><label className="android-field" style={{ marginTop: 16 }}><span>{t('file')}</span><input type="file" aria-label={t('file')} disabled={pending} onChange={e => { setFile(e.target.files?.[0] ?? null); uploadIdentity.current = null; if (!path && e.target.files?.[0]) setPath(e.target.files[0].name) }} /></label><div className="android-actions"><button type="button" className="button button-secondary" disabled={disabled || !path || !file} onClick={() => void action(upload)}>{t('upload')}</button><button type="button" className="button button-secondary" disabled={disabled || !path} onClick={() => void action(download)}>{t('download')}</button><button type="button" className="text-button" disabled={disabled || !path} onClick={() => void action(async signal => display(await invoke('android_files', { op: 'list', path }, signal)))}>{t('list')}</button></div></section>
  </div>
}
function errorCode(error: unknown): string {
  if (error instanceof Error && error.message === 'invalidArgs') return 'invalidArgs'
  if (error instanceof HostApiError) { if (error.outcome === 'unknown') return 'unknown'; if (error.code === 'ANDROID_CONFIGURATION_CONFLICT') return 'conflict'; if (error.code === 'ANDROID_EXECUTOR_BUSY') return 'busy'; if (error.code === 'ANDROID_ADB_NOT_FOUND') return 'notFound'; if (error.code === 'ANDROID_RESPONSE_INVALID') return 'invalidResponse' }
  return 'error'
}
