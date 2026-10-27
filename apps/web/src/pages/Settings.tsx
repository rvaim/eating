import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronRight, Database, Info, Send, Trash2 } from 'lucide-react'
import { validateDeliverySettings } from '@eating/plugin-sdk'
import type { DeliveryQueueStats, DeliverySettings, DeliverySettingsSnapshot } from '@eating/plugin-sdk'
import { HostApiError, formatNumber, getErrorMessage, hostRequest, translate, useI18n } from '@eating/ui-sdk'
import '../i18n/settings'
import './Settings.css'

export type SettingsSection = 'delivery' | 'queue'
type NumericKey = Exclude<keyof DeliverySettings, 'storageMode' | 'overflowPolicy'>
type SettingsDraft = Record<NumericKey, string> & Pick<DeliverySettings, 'storageMode' | 'overflowPolicy'>
type FieldErrors = Partial<Record<keyof DeliverySettings, string>>
type Operation = 'read' | 'save' | 'clear'
type Notice = { readonly kind: 'error' | 'success' | 'info'; readonly key: string }
  | { readonly kind: 'error'; readonly error: unknown; readonly operation: Operation }

interface NumericField {
  readonly key: NumericKey
  readonly section: SettingsSection
  readonly unitKey: string
  readonly scale: number
  readonly minimum: number
  readonly maximum: number
}

const numericFields: readonly NumericField[] = [
  { key: 'quietWindowMs', section: 'delivery', unitKey: 'unit.ms', scale: 1, minimum: 0, maximum: 60000 },
  { key: 'maxWaitMs', section: 'delivery', unitKey: 'unit.ms', scale: 1, minimum: 1, maximum: 300000 },
  { key: 'maxBatchMessages', section: 'delivery', unitKey: 'unit.messages', scale: 1, minimum: 1, maximum: 200 },
  { key: 'batchTargetBytes', section: 'delivery', unitKey: 'unit.kb', scale: 1024, minimum: 256, maximum: 4 * 1024 * 1024 },
  { key: 'deliveryTimeoutMs', section: 'delivery', unitKey: 'unit.ms', scale: 1, minimum: 100, maximum: 120000 },
  { key: 'retryIntervalMs', section: 'delivery', unitKey: 'unit.ms', scale: 1, minimum: 100, maximum: 300000 },
  { key: 'maxDeliveryAttempts', section: 'delivery', unitKey: 'unit.attempts', scale: 1, minimum: 1, maximum: 20 },
  { key: 'maxQueuedMessages', section: 'queue', unitKey: 'unit.messages', scale: 1, minimum: 1, maximum: 100000 },
  { key: 'maxQueuedBytes', section: 'queue', unitKey: 'unit.mb', scale: 1024 * 1024, minimum: 1024, maximum: 100 * 1024 * 1024 },
]

const settingsText = (key: string, params?: Record<string, string | number | boolean | null | undefined>) => translate('settings', key, params)
const rangeParams = (field: NumericField) => ({ minimum: formatNumber(field.minimum / field.scale, { maximumFractionDigits: 20 }), maximum: formatNumber(field.maximum / field.scale, { maximumFractionDigits: 20 }), unit: settingsText(field.unitKey) })

function createDraft(values: DeliverySettings): SettingsDraft {
  const draft: SettingsDraft = {
    storageMode: values.storageMode, overflowPolicy: values.overflowPolicy,
    quietWindowMs: '', maxWaitMs: '', maxBatchMessages: '', batchTargetBytes: '',
    deliveryTimeoutMs: '', retryIntervalMs: '', maxDeliveryAttempts: '',
    maxQueuedMessages: '', maxQueuedBytes: '',
  }
  for (const field of numericFields) draft[field.key] = String(values[field.key] / field.scale)
  return draft
}

function validateDraft(draft: SettingsDraft): { values: DeliverySettings | null; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const numbers = {} as Record<NumericKey, number>
  for (const field of numericFields) {
    const text = draft[field.key].trim()
    const amount = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * field.scale : NaN
    if (!Number.isSafeInteger(amount)) errors[field.key] = settingsText(field.scale === 1 ? 'error.integer' : 'error.bytes')
    else if (amount < field.minimum || amount > field.maximum) errors[field.key] = settingsText('error.range', rangeParams(field))
    numbers[field.key] = amount
  }
  if (!errors.maxWaitMs && !errors.quietWindowMs && numbers.maxWaitMs < numbers.quietWindowMs) errors.maxWaitMs = settingsText('error.maxWait')
  if (!errors.maxBatchMessages && !errors.maxQueuedMessages && numbers.maxBatchMessages > numbers.maxQueuedMessages) {
    errors.maxBatchMessages = settingsText('error.batchMessages')
    errors.maxQueuedMessages = settingsText('error.queueMessages')
  }
  if (!errors.batchTargetBytes && !errors.maxQueuedBytes && numbers.batchTargetBytes > numbers.maxQueuedBytes) {
    errors.batchTargetBytes = settingsText('error.batchBytes')
    errors.maxQueuedBytes = settingsText('error.queueBytes')
  }
  if (Object.keys(errors).length) return { values: null, errors }
  try { return { values: validateDeliverySettings({ ...numbers, storageMode: draft.storageMode, overflowPolicy: draft.overflowPolicy }), errors } }
  catch { return { values: null, errors: { storageMode: settingsText('error.validation') } } }
}

function checkSnapshot(snapshot: DeliverySettingsSnapshot): DeliverySettingsSnapshot {
  if (!snapshot || snapshot.protocolVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new HostApiError('INVALID_HOST_RESPONSE', settingsText('error.response'))
  try { validateDeliverySettings(snapshot.values) }
  catch { throw new HostApiError('INVALID_HOST_RESPONSE', settingsText('error.responseValues')) }
  const queue = snapshot.queue
  const counts: readonly (keyof DeliveryQueueStats)[] = ['pending', 'delivering', 'uncertain', 'queuedMessages', 'queuedBytes', 'accepted', 'rejected', 'discarded', 'dedupIdentifiers']
  if (!queue || !['persistent', 'memory'].includes(queue.storageMode) || typeof queue.overCapacity !== 'boolean'
    || !(queue.lastQueueError === null || typeof queue.lastQueueError === 'string')
    || counts.some(key => typeof queue[key] !== 'number' || !Number.isSafeInteger(queue[key]) || Number(queue[key]) < 0)) throw new HostApiError('INVALID_HOST_RESPONSE', settingsText('error.responseQueue'))
  return snapshot
}

function isStaleRevision(error: unknown): boolean {
  return error instanceof HostApiError && (error.code === 'DELIVERY_SETTINGS_CONFLICT'
    || error.code === 'SETTINGS_REVISION_CONFLICT'
    || error.code.replace(/[_-]/g, '').toLowerCase() === 'stalerevision')
}

function readableError(error: unknown, operation: Operation): string {
  if (isStaleRevision(error)) return settingsText('error.conflict')
  if (error instanceof HostApiError) {
    if (error.code === 'REQUEST_INTERRUPTED' && operation === 'read') return settingsText('error.readInterrupted')
    if (error.code === 'REQUEST_INTERRUPTED' || error.outcome === 'unknown') return settingsText('error.interrupted')
  }
  return getErrorMessage(error, settingsText(`error.${operation}`))
}

function noticeMessage(notice: Notice): string {
  return 'key' in notice ? settingsText(notice.key) : readableError(notice.error, notice.operation)
}

export function Settings({ section, onSectionChange, onFeedback }: {
  readonly section: SettingsSection
  readonly onSectionChange: (section: SettingsSection) => void
  readonly onFeedback: (message: string) => void
}) {
  const { t } = useI18n('settings')
  const [snapshot, setSnapshot] = useState<DeliverySettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [operation, setOperation] = useState<Operation | null>('read')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [requiresRead, setRequiresRead] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearAcknowledged, setClearAcknowledged] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRead, setConfirmRead] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const dirtyRef = useRef(false)
  const draftRef = useRef<SettingsDraft | null>(null)
  const focusField = useRef<keyof DeliverySettings | null>(null)
  const clearCheckbox = useRef<HTMLInputElement>(null)
  const clearTrigger = useRef<HTMLButtonElement>(null)
  const readTrigger = useRef<HTMLButtonElement>(null)
  const readCancel = useRef<HTMLButtonElement>(null)
  const feedback = useRef(onFeedback)
  feedback.current = onFeedback

  const dirty = draft !== null && snapshot !== null && JSON.stringify(draft) !== JSON.stringify(createDraft(snapshot.values))
  dirtyRef.current = dirty
  draftRef.current = draft
  const validation = draft ? validateDraft(draft) : { values: null, errors: {} as FieldErrors }
  const busy = operation !== null

  const replaceDraft = useCallback((next: SettingsDraft) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  const readSettings = useCallback(async (discardDraft = false) => {
    if (lock.current || !mounted.current) return
    if (dirtyRef.current && !discardDraft) { setConfirmRead(true); return }
    lock.current = true
    const current = ++generation.current
    const controller = new AbortController()
    activeRequest.current = controller
    setOperation('read')
    setConfirmRead(false)
    setNotice(null)
    try {
      const next = checkSnapshot(await hostRequest<DeliverySettingsSnapshot>('/settings', { signal: controller.signal }))
      if (!mounted.current || current !== generation.current || controller.signal.aborted) return
      setSnapshot(next)
      replaceDraft(createDraft(next.values))
      dirtyRef.current = false
      setRequiresRead(false)
      setConfirmReset(false)
      setConfirmClear(false)
      setClearAcknowledged(false)
      setShowErrors(false)
    } catch (error) {
      if (mounted.current && current === generation.current && !controller.signal.aborted) setNotice({ kind: 'error', error, operation: 'read' })
    } finally {
      if (mounted.current && current === generation.current) {
        lock.current = false
        activeRequest.current = null
        setOperation(null)
      }
    }
  }, [replaceDraft])

  useEffect(() => {
    mounted.current = true
    void readSettings()
    return () => {
      mounted.current = false
      ++generation.current
      activeRequest.current?.abort()
      activeRequest.current = null
      lock.current = false
    }
  }, [readSettings])

  useEffect(() => {
    if (!focusField.current) return
    const input = document.getElementById(`settings-${focusField.current}`)
    if (input) { input.focus(); focusField.current = null }
  })

  useEffect(() => {
    if (confirmClear && section === 'queue') clearCheckbox.current?.focus()
  }, [confirmClear, section])

  useEffect(() => {
    if (confirmRead) readCancel.current?.focus()
  }, [confirmRead])

  function updateDraft<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    if (!draftRef.current || lock.current) return
    dirtyRef.current = true
    replaceDraft({ ...draftRef.current, [key]: value })
    setConfirmReset(false)
    setConfirmRead(false)
    if (notice?.kind !== 'error') setNotice(null)
  }

  async function mutate(kind: 'save' | 'clear') {
    if (lock.current || !mounted.current || !snapshot || !draftRef.current || requiresRead) return
    if (kind === 'clear' && (!confirmClear || !clearAcknowledged)) return
    const checked = validateDraft(draftRef.current)
    if (kind === 'save' && !checked.values) {
      setShowErrors(true)
      setNotice({ kind: 'error', key: 'error.fields' })
      const first = numericFields.find(field => checked.errors[field.key])
      focusField.current = first?.key ?? 'storageMode'
      onSectionChange(first?.section ?? 'queue')
      return
    }
    lock.current = true
    const current = ++generation.current
    const controller = new AbortController()
    activeRequest.current = controller
    setOperation(kind)
    setConfirmRead(false)
    setNotice(null)
    try {
      const next = checkSnapshot(await hostRequest<DeliverySettingsSnapshot>(kind === 'save' ? '/settings' : '/settings/queue/clear', {
        method: 'POST', signal: controller.signal,
        body: kind === 'save' ? { expectedRevision: snapshot.revision, values: checked.values } : { confirmed: true, expectedRevision: snapshot.revision },
      }))
      if (!mounted.current || current !== generation.current || controller.signal.aborted) return
      setSnapshot(kind === 'save' ? next : { ...snapshot, queue: next.queue })
      if (kind === 'save') {
        replaceDraft(createDraft(next.values))
        dirtyRef.current = false
        setShowErrors(false)
      }
      setConfirmClear(false)
      setClearAcknowledged(false)
      setRequiresRead(false)
      const key = kind === 'save' ? 'success.saved' : 'success.cleared'
      setNotice({ kind: 'success', key })
      feedback.current(settingsText(key))
      if (kind === 'clear') clearTrigger.current?.focus()
    } catch (error) {
      if (!mounted.current || current !== generation.current || controller.signal.aborted) return
      if (isStaleRevision(error) || error instanceof HostApiError && error.outcome === 'unknown') setRequiresRead(true)
      setNotice({ kind: 'error', error, operation: kind })
    } finally {
      if (mounted.current && current === generation.current) {
        lock.current = false
        activeRequest.current = null
        setOperation(null)
      }
    }
  }

  function renderNumber(key: NumericKey) {
    const field = numericFields.find(item => item.key === key)!
    const error = showErrors ? validation.errors[key] : undefined
    return <div key={key} className={`settings-field${error ? ' is-invalid' : ''}`}>
      <label htmlFor={`settings-${key}`}>{t(`field.${key}.label`)}</label>
      <div className="settings-field-content">
        <div className="settings-number-input">
          <input id={`settings-${key}`} name={key} type="text" inputMode={field.scale === 1 ? 'numeric' : 'decimal'} autoComplete="off" maxLength={24}
            value={draft?.[key] ?? ''} disabled={busy} onChange={event => updateDraft(key, event.target.value)}
            aria-invalid={Boolean(error)} aria-describedby={`settings-${key}-hint${error ? ` settings-${key}-error` : ''}`} />
          <span aria-hidden="true">{t(field.unitKey)}</span>
        </div>
        <p id={`settings-${key}-hint`} className="settings-field-hint">{t(`field.${key}.hint`)} {t('field.range', rangeParams(field))}</p>
        {error && <p id={`settings-${key}-error`} className="settings-field-error">{error}</p>}
      </div>
    </div>
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void mutate('save') }

  return <div className="robot-workspace settings-workspace">
    <aside className="platform-sidebar settings-sidebar">
      <p className="platform-nav-heading">{t('nav.heading')}</p>
      <nav aria-label={t('nav.heading')}>
        <button type="button" className={`platform-nav-item${section === 'delivery' ? ' is-selected' : ''}`} aria-current={section === 'delivery' ? 'page' : undefined} onClick={() => onSectionChange('delivery')}><Send size={18} aria-hidden="true" /><span>{t('nav.delivery')}</span>{section === 'delivery' && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}</button>
        <button type="button" className={`platform-nav-item${section === 'queue' ? ' is-selected' : ''}`} aria-current={section === 'queue' ? 'page' : undefined} onClick={() => onSectionChange('queue')}><Database size={18} aria-hidden="true" /><span>{t('nav.queue')}</span>{section === 'queue' && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}</button>
      </nav>
    </aside>
    <main id="main-content" className="robot-content settings-content" aria-busy={busy}>
      <div className="settings-title-row">
        <div><h2>{t(`nav.${section}`)}</h2><p className="panel-description">{t(`description.${section}`)}</p></div>
        <button ref={readTrigger} type="button" className="button button-secondary settings-read-button" disabled={busy} aria-expanded={confirmRead} aria-controls="settings-read-confirmation" onClick={() => { void readSettings() }}>{t(operation === 'read' ? 'action.reading' : 'action.read')}</button>
      </div>
      <p className="settings-retention-note"><Info size={16} aria-hidden="true" /><span>{t('retention')}</span></p>
      {confirmRead && <div id="settings-read-confirmation" className="settings-inline-confirmation" role="group" aria-label={t('read.confirmLabel')}><p>{t('read.confirmText')}</p><div className="settings-confirm-actions"><button ref={readCancel} type="button" className="button button-secondary" disabled={busy} onClick={() => { setConfirmRead(false); readTrigger.current?.focus() }}>{t('action.continue')}</button><button type="button" className="button button-secondary" disabled={busy} onClick={() => { void readSettings(true) }}>{t('read.confirmAction')}</button></div></div>}
      {notice && <div className={`settings-notice settings-notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{noticeMessage(notice)}</div>}
      {!snapshot || !draft ? <div className="settings-read-state" role="status"><p>{t(operation === 'read' ? 'read.loading' : 'read.empty')}</p></div> : <>
        <form className="settings-form" onSubmit={submit} noValidate>
          {section === 'delivery' ? <>
            <section className="settings-form-section" aria-labelledby="settings-aggregation-heading">
              <div className="section-heading"><h3 id="settings-aggregation-heading">{t('section.aggregation')}</h3><p>{t('section.aggregationHint')}</p></div>
              {renderNumber('quietWindowMs')}{renderNumber('maxWaitMs')}{renderNumber('maxBatchMessages')}{renderNumber('batchTargetBytes')}
            </section>
            <section className="settings-form-section" aria-labelledby="settings-delivery-heading">
              <div className="section-heading"><h3 id="settings-delivery-heading">{t('section.delivery')}</h3><p>{t('section.deliveryHint')}</p></div>
              {renderNumber('deliveryTimeoutMs')}{renderNumber('retryIntervalMs')}{renderNumber('maxDeliveryAttempts')}
            </section>
          </> : <section className="settings-form-section" aria-labelledby="settings-storage-heading">
            <div className="section-heading"><h3 id="settings-storage-heading">{t('section.storage')}</h3><p>{t('section.storageHint')}</p></div>
            <div className={`settings-field${showErrors && validation.errors.storageMode ? ' is-invalid' : ''}`}>
              <label htmlFor="settings-storageMode">{t('storage.label')}</label>
              <div className="settings-field-content">
                <select id="settings-storageMode" name="storageMode" value={draft.storageMode} disabled={busy} aria-describedby={`settings-storageMode-hint${showErrors && validation.errors.storageMode ? ' settings-storageMode-error' : ''}`} aria-invalid={Boolean(showErrors && validation.errors.storageMode)} onChange={event => updateDraft('storageMode', event.target.value as DeliverySettings['storageMode'])}>
                  <option value="persistent">{t('storage.persistent')}</option><option value="memory">{t('storage.memory')}</option>
                </select>
                <p id="settings-storageMode-hint" className="settings-field-hint">{t('storage.hint')}</p>
                {showErrors && validation.errors.storageMode && <p id="settings-storageMode-error" className="settings-field-error">{validation.errors.storageMode}</p>}
                {draft.storageMode === 'memory' && <p className="settings-storage-risk">{t(snapshot.values.storageMode !== 'memory' ? 'storage.memoryChangeRisk' : 'storage.memoryRisk')}</p>}
              </div>
            </div>
            {renderNumber('maxQueuedMessages')}{renderNumber('maxQueuedBytes')}
            <div className="settings-field">
              <label htmlFor="settings-overflowPolicy">{t('overflow.label')}</label>
              <div className="settings-field-content">
                <select id="settings-overflowPolicy" name="overflowPolicy" value={draft.overflowPolicy} disabled={busy} aria-describedby="settings-overflowPolicy-hint" onChange={event => updateDraft('overflowPolicy', event.target.value as DeliverySettings['overflowPolicy'])}>
                  <option value="reject-new">{t('overflow.rejectNew')}</option><option value="drop-oldest">{t('overflow.dropOldest')}</option>
                </select>
                <p id="settings-overflowPolicy-hint" className="settings-field-hint">{t('overflow.hint')}</p>
                {draft.overflowPolicy === 'drop-oldest' && <p className="settings-storage-risk">{t('overflow.dropRisk')}</p>}
              </div>
            </div>
          </section>}
          <div className="settings-actions">
            <button type="submit" className="button button-primary" disabled={busy || !dirty || requiresRead}>{operation === 'save' ? t('action.saving') : <><Check size={15} aria-hidden="true" />{t('action.save')}</>}</button>
            <button type="button" className="button button-secondary" disabled={busy || !dirty} onClick={() => setConfirmReset(true)}>{t('action.discard')}</button>
            <span className="settings-save-state">{t(dirty ? 'state.dirty' : 'state.read')}</span>
          </div>
          {confirmReset && <div className="settings-inline-confirmation" role="group" aria-label={t('reset.confirmLabel')}><p>{t('reset.confirmText')}</p><div className="settings-confirm-actions"><button type="button" className="button button-secondary" onClick={() => setConfirmReset(false)}>{t('action.continue')}</button><button type="button" className="button button-secondary" onClick={() => { replaceDraft(createDraft(snapshot.values)); dirtyRef.current = false; setConfirmReset(false); setShowErrors(false); if (!requiresRead) setNotice(null) }}>{t('reset.confirmAction')}</button></div></div>}
        </form>
        {section === 'queue' && <>
          <QueueStatus queue={snapshot.queue} stale={requiresRead || notice?.kind === 'error'} />
          <section className="settings-clear-section" aria-labelledby="settings-clear-heading">
            <div className="settings-clear-heading"><div><h3 id="settings-clear-heading">{t('clear.heading')}</h3><p>{t('clear.description')}</p></div><button ref={clearTrigger} type="button" className="text-button settings-clear-trigger" disabled={busy || requiresRead} aria-expanded={confirmClear} aria-controls="settings-clear-confirmation" onClick={() => { setConfirmClear(true); setClearAcknowledged(false) }}><Trash2 size={15} aria-hidden="true" />{t('clear.action')}</button></div>
            {confirmClear && <div id="settings-clear-confirmation" className="settings-inline-confirmation" role="group" aria-label={t('clear.confirmLabel')}>
              <p id="settings-clear-warning">{t('clear.warning')}</p>
              <label className="settings-confirm-checkbox"><input ref={clearCheckbox} type="checkbox" checked={clearAcknowledged} disabled={busy} aria-describedby="settings-clear-warning" onChange={event => setClearAcknowledged(event.target.checked)} /><span>{t('clear.acknowledge')}</span></label>
              <div className="settings-confirm-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setConfirmClear(false); setClearAcknowledged(false); clearTrigger.current?.focus() }}>{t('action.cancel')}</button><button type="button" className="button button-danger" disabled={busy || !clearAcknowledged || requiresRead} onClick={() => { void mutate('clear') }}>{t(operation === 'clear' ? 'clear.clearing' : 'clear.confirmAction')}</button></div>
            </div>}
          </section>
        </>}
      </>}
    </main>
  </div>
}

function QueueStatus({ queue, stale }: { readonly queue: DeliveryQueueStats; readonly stale: boolean }) {
  const { t, formatNumber } = useI18n('settings')
  const amount = (key: string, count: number) => t(key, { count, formattedCount: formatNumber(count) })
  const rows: readonly (readonly [string, string])[] = [
    ['queue.pending', amount('count.messages', queue.pending)], ['queue.delivering', amount('count.messages', queue.delivering)], ['queue.uncertain', amount('count.messages', queue.uncertain)],
    ['queue.messages', amount('count.messages', queue.queuedMessages)], ['queue.bytes', amount('count.bytes', queue.queuedBytes)],
    ['queue.accepted', amount('count.messages', queue.accepted)], ['queue.rejected', amount('count.messages', queue.rejected)], ['queue.discarded', amount('count.messages', queue.discarded)],
    ['queue.overCapacity', t(queue.overCapacity ? 'queue.yes' : 'queue.no')],
    ['queue.storage', t(queue.storageMode === 'persistent' ? 'storage.persistent' : 'storage.memory')],
    ['queue.lastError', queue.lastQueueError === null ? t('queue.none') : getErrorMessage({ code: queue.lastQueueError }, t('queue.lastErrorPresent'))],
  ]
  return <section className="settings-queue-status" aria-labelledby="settings-queue-heading">
    <div className="section-heading"><h3 id="settings-queue-heading">{t('queue.heading')}</h3><p>{t(stale ? 'queue.stale' : 'queue.hint')}</p></div>
    <dl className="settings-stat-list">{rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}
