import { useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { isJsonObject } from '@eating/plugin-sdk'
import { ActionButton, getErrorMessage, HostApiError, hostRequest, translate, useI18n } from '@eating/ui-sdk'
import type { QQMediaTransportSettings } from '../media-transport'
import type { QQTranslationKey } from './i18n'

const failureMessages: Readonly<Record<string, QQTranslationKey>> = {
  QQ_MEDIA_CONFIGURATION_INVALID: 'transport.invalid',
  QQ_MEDIA_DIRECTORY_UNAVAILABLE: 'transport.unavailable',
  QQ_MEDIA_CONFIGURATION_CONFLICT: 'transport.conflict',
  QQ_MEDIA_CONFIGURATION_CORRUPTED: 'transport.corrupted',
  QQ_MEDIA_CONNECTION_REQUIRED: 'transport.connectionRequired',
}

export function parseMediaTransport(value: unknown): QQMediaTransportSettings {
  const invalid = (): never => { throw new HostApiError('INVALID_HOST_RESPONSE', translate('common', 'errors.INVALID_HOST_RESPONSE')) }
  if (!isJsonObject(value) || Object.keys(value).length !== 5 || Object.keys(value).some(key => !['schemaVersion', 'revision', 'mode', 'mapping', 'fileEligible'].includes(key))
    || value.schemaVersion !== 1 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !['auto', 'shared-directory'].includes(String(value.mode)) || typeof value.fileEligible !== 'boolean') return invalid()
  if (value.mapping !== null && (!isJsonObject(value.mapping) || Object.keys(value.mapping).length !== 4
    || Object.keys(value.mapping).some(key => !['sourceRoot', 'hostMappingRoot', 'onebotRoot', 'ownerConfirmed'].includes(key))
    || ['sourceRoot', 'hostMappingRoot', 'onebotRoot'].some(key => typeof (value.mapping as Record<string, unknown>)[key] !== 'string') || typeof value.mapping.ownerConfirmed !== 'boolean')) invalid()
  return value as unknown as QQMediaTransportSettings
}
interface Props {
  active: boolean
  enabled: boolean
  busy: boolean
  connectionKey: string
  actionLock: MutableRefObject<boolean>
  onBusy: (busy: boolean) => void
  onFeedback: (message: string) => void
}
export function MediaTransportFields({ active, enabled, busy, connectionKey, actionLock, onBusy, onFeedback }: Props) {
  const { t } = useI18n('qq'), prefix = useId()
  const [draft, setDraft] = useState<QQMediaTransportSettings | null>(null)
  const [pending, setPending] = useState(false), [dirty, setDirty] = useState(false), [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const controller = useRef<AbortController | null>(null), callbacks = useRef({ onBusy, onFeedback }), previousConnection = useRef(connectionKey)
  callbacks.current = { onBusy, onFeedback }
  async function request(save: boolean) {
    if (actionLock.current || save && (!draft || !enabled)) return
    const current = new AbortController(); controller.current = current
    actionLock.current = true; setPending(true); setFailure(null); setSaved(false); callbacks.current.onBusy(true)
    try {
      const response = await hostRequest<unknown>('/plugins/qq/manage', { method: 'POST', signal: current.signal, body: save && draft
        ? { operation: 'save-media-transport', input: { expectedRevision: draft.revision, mode: draft.mode, mapping: draft.mapping } }
        : { operation: 'media-transport', input: {} } })
      if (current.signal.aborted) return
      setDraft(parseMediaTransport(response)); setDirty(false); setSaved(save)
      if (save) callbacks.current.onFeedback(translate('qq', 'transport.saved'))
    } catch (error) {
      if (!current.signal.aborted) setFailure(error instanceof HostApiError ? error : { code: 'UNEXPECTED_ERROR', message: '' })
    } finally {
      if (controller.current === current) { controller.current = null; actionLock.current = false; setPending(false); callbacks.current.onBusy(false) }
    }
  }
  useEffect(() => {
    if (previousConnection.current !== connectionKey && dirty) {
      setDraft(current => current ? { ...current, fileEligible: false, mapping: current.mapping ? { ...current.mapping, ownerConfirmed: false } : null } : current)
      setSaved(false)
    }
    previousConnection.current = connectionKey
    if (active && enabled && !dirty) void request(false)
  }, [active, enabled, connectionKey])
  useEffect(() => () => { controller.current?.abort(); if (controller.current) { actionLock.current = false; callbacks.current.onBusy(false); controller.current = null } }, [actionLock])
  function update(next: QQMediaTransportSettings) { setDraft(next); setDirty(true); setSaved(false); setFailure(null) }
  const blocked = busy || pending
  return <section className="qq-media-transport" aria-labelledby={`${prefix}-title`}>
    <div className="section-heading"><h3 id={`${prefix}-title`}>{t('transport.title')}</h3><p>{t('transport.description')}</p></div>
    {draft && <form className="form-fields" onSubmit={event => { event.preventDefault(); void request(true) }}>
      <fieldset className="qq-fieldset" disabled={blocked || !enabled}>
        <div className="field"><label htmlFor={`${prefix}-mode`}>{t('transport.mode')}</label><select id={`${prefix}-mode`} value={draft.mode} aria-describedby={`${prefix}-mode-help`} onChange={event => update({ ...draft, mode: event.target.value as QQMediaTransportSettings['mode'], mapping: event.target.value === 'shared-directory' ? draft.mapping ?? { sourceRoot: '', hostMappingRoot: '', onebotRoot: '', ownerConfirmed: false } : draft.mapping })}><option value="auto">{t('transport.auto')}</option><option value="shared-directory">{t('transport.shared')}</option></select><p className="field-hint" id={`${prefix}-mode-help`}>{t('transport.autoHelp')}</p></div>
        {draft.mapping && <>
          {(['sourceRoot', 'hostMappingRoot', 'onebotRoot'] as const).map(field => <div className="field" key={field}><label htmlFor={`${prefix}-${field}`}>{t(`transport.${field}`)}</label><input id={`${prefix}-${field}`} value={draft.mapping![field]} maxLength={4096} autoComplete="off" spellCheck={false} required aria-describedby={`${prefix}-${field}-help`} onChange={event => update({ ...draft, mapping: { ...draft.mapping!, [field]: event.target.value, ownerConfirmed: false } })} /><p className="field-hint" id={`${prefix}-${field}-help`}>{t(`transport.${field}Help`)}</p></div>)}
          <label className="check-field"><input type="checkbox" checked={draft.mapping.ownerConfirmed} onChange={event => update({ ...draft, mapping: { ...draft.mapping!, ownerConfirmed: event.target.checked } })} /><span><strong>{t('transport.confirmed')}</strong><small>{t('transport.confirmedHelp')}</small></span></label>
        </>}
      </fieldset>
      <p className="qq-help">{t(dirty ? 'transport.draft' : draft.fileEligible ? 'transport.eligible' : 'transport.base64')}</p>
      <p className="qq-help">{t('transport.private')}</p>
      <div className="qq-actions"><ActionButton type="submit" className="button button-primary" reasonCode={blocked ? 'busy' : !enabled ? 'enable' : failure?.code === 'QQ_MEDIA_CONFIGURATION_CONFLICT' ? 'read' : 'unchanged'} disabled={blocked || !enabled || !dirty || failure?.code === 'QQ_MEDIA_CONFIGURATION_CONFLICT'}>{t(pending ? 'action.saving' : 'transport.save')}</ActionButton><ActionButton type="button" className="button button-secondary" reasonCode="busy" disabled={blocked || !enabled} onClick={() => void request(false)}>{t('transport.read')}</ActionButton></div>
    </form>}
    {!draft && <ActionButton type="button" className="button button-secondary" reasonCode="busy" disabled={blocked || !enabled} onClick={() => void request(false)}>{t(pending ? 'transport.loading' : 'transport.read')}</ActionButton>}
    {saved && <p className="qq-operation-result" role="status">{t('transport.saved')}</p>}
    {failure && <p className="qq-error" role="alert">{failureMessages[failure.code] ? t(failureMessages[failure.code]!) : getErrorMessage(failure)} ({failure.code})</p>}
  </section>
}
