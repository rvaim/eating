import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { AlertCircle, Check, RefreshCw } from 'lucide-react'
import { HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { readModelCapabilities } from './panel-data'
import type { ModelCapabilities } from './panel-data'
import type { DshTranslationKey } from './i18n'

/** Independent owner settings: no polling, no connection payload, no locale effects. */
export function ModelCapabilitiesSettings({ active, enabled, runtimeActive, busy, actionLock, onBusy, routeKey }: {
  readonly active: boolean; readonly enabled: boolean; readonly runtimeActive: boolean; readonly busy: boolean; readonly routeKey: string
  readonly actionLock: MutableRefObject<boolean>; readonly onBusy: (value: boolean) => void
}) {
  const { t } = useI18n('dsh')
  const prefix = useId()
  const [snapshot, setSnapshot] = useState<ModelCapabilities | null>(null)
  const [draft, setDraft] = useState<boolean | null>(null)
  const dirty = useRef(false)
  const [pending, setPending] = useState<'read' | 'save' | null>(null)
  const [failure, setFailure] = useState<DshTranslationKey | null>(null)
  const [saved, setSaved] = useState(false)
  const [needsRead, setNeedsRead] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const attempted = useRef(false)
  const savedRoute = useRef(routeKey)
  const alive = useRef(false)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const saving = useRef(false)
  const onBusyRef = useRef(onBusy)
  const context = useRef({ active, enabled })
  context.current = { active, enabled }; onBusyRef.current = onBusy

  const cancel = useCallback(() => {
    ++generation.current
    request.current?.abort(); request.current = null
    if (saving.current) {
      saving.current = false; actionLock.current = false; onBusyRef.current(false)
      setNeedsRead(true); setFailure('capabilities.unknown')
    }
    setPending(null)
  }, [actionLock])
  useEffect(() => {
    alive.current = true
    const hidden = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', cancel)
    return () => { alive.current = false; cancel(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cancel) }
  }, [cancel])
  useEffect(() => { if (!active || !enabled) cancel() }, [active, enabled, cancel])

  const read = useCallback(async () => {
    if (!context.current.active || !context.current.enabled || document.hidden || request.current) return
    attempted.current = true
    const controller = new AbortController(), ticket = ++generation.current
    request.current = controller; setPending('read'); setFailure(null); setSaved(false)
    try {
      const response = readModelCapabilities(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: 'get-model-capabilities', input: {} }, signal: controller.signal }))
      if (!alive.current || controller.signal.aborted || ticket !== generation.current || document.hidden) return
      setSnapshot(response)
      if (!dirty.current) setDraft(response.imageInput)
      setNeedsRead(false); setExhausted(false)
    } catch {
      if (alive.current && !controller.signal.aborted && ticket === generation.current) setFailure('capabilities.readFailed')
    } finally {
      if (request.current === controller) { request.current = null; if (alive.current) setPending(null) }
    }
  }, [])
  useEffect(() => {
    if (savedRoute.current !== routeKey) {
      savedRoute.current = routeKey; cancel(); attempted.current = false; dirty.current = false
      setSnapshot(null); setDraft(null); setNeedsRead(false); setExhausted(false); setSaved(false); setFailure(null)
    }
    if (active && enabled && !attempted.current) void read()
  }, [active, enabled, routeKey, read, cancel])

  async function save() {
    if (!snapshot || draft === null || draft === snapshot.imageInput || !active || !enabled || document.hidden || request.current || runtimeActive || busy || actionLock.current || needsRead || exhausted) return
    const controller = new AbortController(), ticket = ++generation.current
    request.current = controller; saving.current = true; actionLock.current = true; onBusyRef.current(true)
    setPending('save'); setFailure(null); setSaved(false)
    try {
      const response = readModelCapabilities(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: 'save-model-capabilities', input: { expectedRevision: snapshot.revision, imageInput: draft } }, signal: controller.signal }))
      if (!alive.current || controller.signal.aborted || ticket !== generation.current || document.hidden) return
      setSnapshot(response); setDraft(response.imageInput); dirty.current = false; setNeedsRead(false); setSaved(true)
    } catch (error) {
      if (!alive.current || controller.signal.aborted || ticket !== generation.current) return
      if (error instanceof HostApiError && error.code === 'MODEL_CAPABILITIES_CONFLICT') { setNeedsRead(true); setFailure('capabilities.conflict') }
      else if (error instanceof HostApiError && error.code === 'MODEL_CAPABILITIES_RUNTIME_ACTIVE') setFailure('capabilities.stopFirst')
      else if (error instanceof HostApiError && error.code === 'MODEL_CAPABILITIES_EXHAUSTED') { setExhausted(true); setFailure('capabilities.exhausted') }
      else { setNeedsRead(true); setFailure('capabilities.unknown') }
    } finally {
      if (request.current === controller) {
        request.current = null; saving.current = false; actionLock.current = false; onBusyRef.current(false)
        if (alive.current) setPending(null)
      }
    }
  }

  return <section className="dsh-capabilities" aria-labelledby={`${prefix}-title`}>
    <div className="section-heading"><h3 id={`${prefix}-title`}>{t('capabilities.title')}</h3><p>{t('capabilities.description')}</p></div>
    {snapshot && draft !== null ? <label className="check-field"><input type="checkbox" checked={draft} disabled={pending !== null || !enabled} aria-describedby={`${prefix}-help`} onChange={event => { dirty.current = true; setDraft(event.target.checked); setSaved(false) }} /><span><strong>{t('capabilities.imageInput')}</strong><small id={`${prefix}-help`}>{t('capabilities.declaration')}</small></span></label>
      : <p className="dsh-help" role="status">{t(pending === 'read' ? 'capabilities.loading' : 'capabilities.unread')}</p>}
    <p className="dsh-help">{t('capabilities.stopFirst')}</p>
    <div className="dsh-capability-actions"><button type="button" className="button button-secondary" disabled={pending !== null || !enabled || !active} onClick={() => void read()}><RefreshCw size={15} aria-hidden="true" />{t(pending === 'read' ? 'capabilities.reading' : 'capabilities.reread')}</button>
      <button type="button" className="button button-primary" disabled={!snapshot || draft === null || draft === snapshot.imageInput || pending !== null || !enabled || !active || runtimeActive || busy || needsRead || exhausted} onClick={() => void save()}>{t(pending === 'save' ? 'capabilities.saving' : 'capabilities.save')}</button></div>
    {failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><p>{t(failure)}</p></div>}
    {saved && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('capabilities.saved')}</p>}
  </section>
}
