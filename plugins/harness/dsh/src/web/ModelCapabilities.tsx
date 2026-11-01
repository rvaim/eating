import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { AlertCircle, Check, RefreshCw } from 'lucide-react'
import { ActionButton, HostApiError, hostRequest, useI18n } from '@eating/ui-sdk'
import { readModelCapabilities, readModelInformation } from './panel-data'
import type { ModelCapabilities, ModelInformationSnapshot, ModelOption } from './panel-data'
import type { DshTranslationKey } from './i18n'

/** Inline model facts; provider declarations take precedence over unknown-only manual supplementation. */
export function ModelCapabilitiesSettings({ active, enabled, runtimeActive, busy, actionLock, onBusy, routeKey, catalogKey, configured, savedModel, draftModel, identityMatches, models }: {
  readonly active: boolean; readonly enabled: boolean; readonly runtimeActive: boolean; readonly busy: boolean; readonly routeKey: string; readonly catalogKey: string; readonly configured: boolean
  readonly savedModel: string; readonly draftModel: string; readonly identityMatches: boolean; readonly models: readonly ModelOption[] | null
  readonly actionLock: MutableRefObject<boolean>; readonly onBusy: (value: boolean) => void
}) {
  const { t, formatNumber } = useI18n('dsh')
  const prefix = useId()
  const [snapshot, setSnapshot] = useState<ModelCapabilities | null>(null)
  const [draft, setDraft] = useState<boolean | null>(null)
  const [information, setInformation] = useState<ModelInformationSnapshot | null>(null)
  const [informationLoading, setInformationLoading] = useState(false)
  const [informationFailed, setInformationFailed] = useState(false)
  const [supplementOpen, setSupplementOpen] = useState(false)
  const dirty = useRef(false)
  const [pending, setPending] = useState<'read' | 'save' | null>(null)
  const [failure, setFailure] = useState<DshTranslationKey | null>(null)
  const [saved, setSaved] = useState(false)
  const [needsRead, setNeedsRead] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const attempted = useRef(false)
  const savedRoute = useRef(routeKey)
  const informationRoute = useRef('')
  const alive = useRef(false)
  const generation = useRef(0)
  const informationGeneration = useRef(0)
  const request = useRef<AbortController | null>(null)
  const informationRequest = useRef<AbortController | null>(null)
  const saving = useRef(false)
  const onBusyRef = useRef(onBusy)
  const context = useRef({ active, enabled, configured, catalogKey })
  context.current = { active, enabled, configured, catalogKey }; onBusyRef.current = onBusy

  const cancel = useCallback(() => {
    ++generation.current; ++informationGeneration.current
    if (request.current && !saving.current) attempted.current = false
    request.current?.abort(); request.current = null
    if (informationRequest.current) { informationRequest.current.abort(); informationRequest.current = null; informationRoute.current = ''; actionLock.current = false; onBusyRef.current(false) }
    setInformationLoading(false)
    if (saving.current) { saving.current = false; actionLock.current = false; onBusyRef.current(false); setNeedsRead(true); setFailure('capabilities.unknown') }
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
      setSnapshot(response); if (!dirty.current) setDraft(response.imageInput)
      setNeedsRead(false); setExhausted(false)
    } catch { if (alive.current && !controller.signal.aborted && ticket === generation.current) setFailure('capabilities.readFailed') }
    finally { if (request.current === controller) { request.current = null; if (alive.current) setPending(null) } }
  }, [])
  const readInformation = useCallback(async (refresh = true) => {
    if (!context.current.active || !context.current.enabled || !context.current.configured || document.hidden || informationRequest.current || request.current || actionLock.current) return
    const controller = new AbortController(), ticket = ++informationGeneration.current
    informationRoute.current = context.current.catalogKey
    informationRequest.current = controller; actionLock.current = true; onBusyRef.current(true); setInformationLoading(true); setInformationFailed(false)
    try {
      const response = readModelInformation(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: refresh ? 'read-model-information' : 'get-model-information', input: {} }, signal: controller.signal }))
      if (alive.current && !controller.signal.aborted && ticket === informationGeneration.current && !document.hidden) setInformation(response)
    } catch { if (alive.current && !controller.signal.aborted && ticket === informationGeneration.current) setInformationFailed(true) }
    finally { if (informationRequest.current === controller) { informationRequest.current = null; actionLock.current = false; onBusyRef.current(false); if (alive.current) setInformationLoading(false) } }
  }, [actionLock])
  useEffect(() => {
    if (savedRoute.current !== routeKey) {
      savedRoute.current = routeKey; cancel(); attempted.current = false; dirty.current = false
      setSnapshot(null); setDraft(null); setSupplementOpen(false); setNeedsRead(false); setExhausted(false); setSaved(false); setFailure(null)
    }
    if (active && enabled && !attempted.current) void read()
  }, [active, enabled, routeKey, read, cancel])
  useEffect(() => {
    if (informationRoute.current !== catalogKey && active && enabled && configured && snapshot) void readInformation()
  }, [active, enabled, configured, catalogKey, snapshot, readInformation])
  useEffect(() => { if (active && enabled && configured && informationRoute.current === catalogKey) void readInformation(false) }, [runtimeActive, active, enabled, configured, catalogKey, readInformation])

  const sameModel = identityMatches && draftModel.trim() === savedModel
  const listSelection = models?.find(model => model.id === draftModel.trim())
  const capabilities = identityMatches ? models !== null ? listSelection?.capabilities ?? null : sameModel && information?.model === savedModel ? information.capabilities : null : null
  const imageReported = capabilities?.imageInput ?? null
  const effectiveImageInput = imageReported ?? snapshot?.imageInput ?? false
  const canSupplement = configured && sameModel && imageReported === null && (!informationLoading || information !== null || informationFailed || supplementOpen)
  async function save() {
    if (!snapshot || draft === null || draft === snapshot.imageInput || !canSupplement || !active || !enabled || document.hidden || request.current || runtimeActive || busy || actionLock.current || needsRead || exhausted) return
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
      else if (error instanceof HostApiError && error.code === 'MODEL_CAPABILITIES_REPORTED') { setFailure('modelInfo.reported'); void readInformation(false) }
      else if (error instanceof HostApiError && error.code === 'MODEL_CAPABILITIES_EXHAUSTED') { setExhausted(true); setFailure('capabilities.exhausted') }
      else { setNeedsRead(true); setFailure('capabilities.unknown') }
    } finally { if (request.current === controller) { request.current = null; saving.current = false; actionLock.current = false; onBusyRef.current(false); if (alive.current) setPending(null) } }
  }
  const bool = (value: boolean | null | undefined) => t(value === true ? 'modelInfo.supported' : value === false ? 'modelInfo.unsupported' : 'modelInfo.unspecified')
  const pendingApply = runtimeActive && information?.appliedImageInput !== null && information?.appliedImageInput !== undefined && information.appliedImageInput !== effectiveImageInput
  return <section className="dsh-capabilities dsh-model-capabilities" aria-labelledby={`${prefix}-title`}>
    <div className="dsh-model-capabilities-heading"><h4 id={`${prefix}-title`}>{t('modelInfo.title')}</h4><ActionButton reasonCode={!enabled ? 'enable' : !configured ? 'configure' : !sameModel ? 'draft' : 'loading'} type="button" className="text-button" disabled={informationLoading || !active || !enabled || !configured || !sameModel || busy} onClick={() => void readInformation()}><RefreshCw size={13} aria-hidden="true" />{t(informationLoading ? 'modelInfo.reading' : 'modelInfo.refresh')}</ActionButton></div>
    <p className="dsh-model-help">{t(!identityMatches || !sameModel ? 'modelInfo.saveFirst' : informationLoading && !capabilities ? 'modelInfo.loading' : capabilities ? 'modelInfo.reported' : informationFailed ? 'modelInfo.failed' : 'modelInfo.unknown')}</p>
    <dl className="dsh-model-facts"><div><dt>{t('modelInfo.image')}</dt><dd>{bool(capabilities?.imageInput)}</dd></div><div><dt>{t('modelInfo.tools')}</dt><dd>{bool(capabilities?.toolCalling)}</dd></div><div><dt>{t('modelInfo.reasoning')}</dt><dd>{bool(capabilities?.reasoning)}</dd></div><div><dt>{t('modelInfo.context')}</dt><dd>{capabilities?.contextWindow ? t('modelInfo.tokens', { value: formatNumber(capabilities.contextWindow) }) : t('modelInfo.unspecified')}</dd></div><div><dt>{t('modelInfo.output')}</dt><dd>{capabilities?.maxOutputTokens ? t('modelInfo.tokens', { value: formatNumber(capabilities.maxOutputTokens) }) : t('modelInfo.unspecified')}</dd></div></dl>
    {sameModel && snapshot && <p className="dsh-model-help">{t(pendingApply ? 'modelInfo.restart' : imageReported !== null ? 'modelInfo.automatic' : 'modelInfo.manualCurrent', { input: t(effectiveImageInput ? 'modelInfo.textImage' : 'modelInfo.text') })}</p>}
    {canSupplement && <details className="dsh-model-supplement" open={supplementOpen} onToggle={event => setSupplementOpen(event.currentTarget.open)}><summary>{t('modelInfo.supplement')}</summary><p className="dsh-help">{t('capabilities.description')}</p>
      {snapshot && draft !== null ? <label className="check-field"><input type="checkbox" checked={draft} disabled={pending !== null || !enabled} aria-describedby={`${prefix}-help`} onChange={event => { dirty.current = true; setDraft(event.target.checked); setSaved(false) }} /><span><strong>{t('capabilities.imageInput')}</strong><small id={`${prefix}-help`}>{t('capabilities.declaration')}</small></span></label> : <p className="dsh-help" role="status">{t(pending === 'read' ? 'capabilities.loading' : 'capabilities.unread')}</p>}
      <p className="dsh-help">{t('capabilities.stopFirst')}</p><div className="dsh-capability-actions"><ActionButton reasonCode="busy" type="button" className="button button-secondary" disabled={pending !== null || informationLoading || !enabled || !active} onClick={() => void read()}>{t(pending === 'read' ? 'capabilities.reading' : 'capabilities.reread')}</ActionButton><ActionButton reasonCode={!enabled ? 'enable' : runtimeActive ? 'stop' : needsRead || exhausted || !snapshot ? 'read' : pending !== null || informationLoading || busy ? 'busy' : 'unchanged'} type="button" className="button button-primary" disabled={!snapshot || draft === null || draft === snapshot.imageInput || pending !== null || informationLoading || !enabled || !active || runtimeActive || busy || needsRead || exhausted} onClick={() => void save()}>{t(pending === 'save' ? 'capabilities.saving' : 'capabilities.save')}</ActionButton></div>
    </details>}
    {failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><p>{t(failure)}</p></div>}
    {saved && <p className="dsh-result" role="status"><Check size={15} aria-hidden="true" />{t('capabilities.saved')}</p>}
  </section>
}
