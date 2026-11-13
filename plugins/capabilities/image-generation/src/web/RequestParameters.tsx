import { useEffect, useId, useRef, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { ActionButton, useI18n } from '@eating/ui-sdk'
import type { ImageRequestParameters, ImageRequestParametersConfiguration } from '../types'
import { DEFAULT_REQUEST_PARAMETERS, parseRequestParameters, REQUEST_PARAMETERS_MAX_BYTES } from '../request-parameters'
import { errorTextFrom, manage, readRequestParameters } from './data'
import { it } from './i18n'

export function RequestParameters({ blocked, onDirtyChange, onReadyChange }: { readonly blocked: boolean; readonly onDirtyChange: (dirty: boolean) => void; readonly onReadyChange: (ready: boolean) => void }) {
  const { t } = useI18n('image-generation'), id = useId()
  const [configuration, setConfiguration] = useState<ImageRequestParametersConfiguration | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [discard, setDiscard] = useState(false)
  const dirtyRef = useRef(false), mounted = useRef(false), action = useRef<AbortController | null>(null), saving = useRef(false)
  const callbacks = useRef({ onDirtyChange, onReadyChange }); callbacks.current = { onDirtyChange, onReadyChange }

  function edit(value: string) {
    setDraft(value); dirtyRef.current = true; setDirty(true); setSaved(false); setFailure(null)
    callbacks.current.onDirtyChange(true)
  }
  function accept(value: ImageRequestParametersConfiguration) {
    setConfiguration(value); setDraft(JSON.stringify(value.parameters, null, 2)); setFailure(null)
    dirtyRef.current = false; setDirty(false); setDiscard(false)
    callbacks.current.onDirtyChange(false); callbacks.current.onReadyChange(true)
  }
  async function load(force = false) {
    if (document.hidden || saving.current) return
    action.current?.abort()
    const controller = new AbortController(); action.current = controller; setBusy(true)
    try {
      const result = readRequestParameters(await manage('request-parameters', {}, controller.signal))
      if (!mounted.current || controller.signal.aborted || dirtyRef.current && !force) return
      accept(result)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) { setFailure(errorTextFrom(error, it('common.loadFailed'))); callbacks.current.onReadyChange(false) }
    } finally { if (action.current === controller) { action.current = null; if (mounted.current) setBusy(false) } }
  }
  async function save() {
    if (!configuration || saving.current || blocked) return
    let parameters: ImageRequestParameters
    try { parameters = parseRequestParameters(JSON.parse(draft)) }
    catch { setFailure(it('parameters.invalid')); return }
    saving.current = true; setBusy(true); setSaved(false); setFailure(null)
    action.current?.abort()
    const controller = new AbortController(); action.current = controller
    try {
      const result = readRequestParameters(await manage('save-request-parameters', { expectedRevision: configuration.revision, parameters }, controller.signal))
      if (result.revision !== configuration.revision + 1) throw new Error('Unexpected request parameter revision')
      if (!mounted.current || controller.signal.aborted) return
      accept(result); setSaved(true)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setFailure(errorTextFrom(error, it('parameters.unknown')))
    } finally {
      saving.current = false
      if (action.current === controller) { action.current = null; if (mounted.current) setBusy(false) }
    }
  }
  useEffect(() => {
    mounted.current = true; void load()
    const visibility = () => { if (document.hidden) action.current?.abort(); else void load() }
    const pagehide = () => action.current?.abort()
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide)
    return () => { mounted.current = false; action.current?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide) }
  }, [])
  return <div className="image-parameters">
    <form className="image-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="image-field"><label htmlFor={id}>{t('parameters.label')}</label><div>
        <p className="image-hint" id={`${id}-help`}>{t('parameters.help')}</p>
        <textarea id={id} className="image-parameters-editor" value={draft} rows={6} spellCheck={false} autoComplete="off" maxLength={REQUEST_PARAMETERS_MAX_BYTES} disabled={!configuration || busy} aria-describedby={`${id}-help`} onChange={event => edit(event.target.value)} />
        <p className="image-hint">{t('parameters.example')}</p>
        {dirty && <p className="image-hint">{t('parameters.dirty')}</p>}
        {failure && <p className="image-error" role="alert">{failure}</p>}
        {saved && <p className="image-success" role="status"><Check size={14} aria-hidden="true" />{t('parameters.saved')}</p>}
        {discard && <div className="image-confirm" role="alertdialog" aria-label={t('parameters.discardTitle')}><strong>{t('parameters.discardTitle')}</strong><p>{t('parameters.discardHelp')}</p><div className="image-form-actions"><button className="button button-secondary" type="button" onClick={() => setDiscard(false)}>{t('generate.cancel')}</button><button className="button button-danger" type="button" onClick={() => void load(true)}>{t('config.discardConfirm')}</button></div></div>}
        <div className="image-form-actions"><ActionButton reasonCode={busy ? 'busy' : blocked ? 'active' : 'unchanged'} type="submit" className="button button-primary" disabled={!configuration || busy || blocked || !dirty}>{t(busy && saving.current ? 'parameters.saving' : 'parameters.save')}</ActionButton><ActionButton reasonCode="busy" type="button" className="button button-secondary" disabled={busy} onClick={() => { setSaved(false); if (dirtyRef.current) setDiscard(true); else void load() }}><RefreshCw size={14} aria-hidden="true" />{t('parameters.reload')}</ActionButton><ActionButton reasonCode="busy" type="button" className="text-button" disabled={!configuration || busy || blocked} onClick={() => edit(JSON.stringify(DEFAULT_REQUEST_PARAMETERS, null, 2))}>{t('parameters.defaults')}</ActionButton></div>
      </div></div>
    </form>
  </div>
}
