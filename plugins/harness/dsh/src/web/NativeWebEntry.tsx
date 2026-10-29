import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, ExternalLink } from 'lucide-react'
import { hostRequest, useI18n } from '@eating/ui-sdk'
import { readNativeWebLaunch } from './panel-data'

/** The authenticated URL exists only inside the click request and the new window. */
export function NativeWebEntry({ enabled, ready, active }: { readonly enabled: boolean; readonly ready: boolean; readonly active: boolean }) {
  const { t } = useI18n('dsh')
  const heading = useId()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<'blocked' | 'failed' | null>(null)
  const controller = useRef<AbortController | null>(null)
  const popup = useRef<Window | null>(null)
  const generation = useRef(0)
  const available = enabled && ready && active
  const availability = useRef(available)
  availability.current = available

  const cancel = useCallback(() => {
    ++generation.current
    controller.current?.abort(); controller.current = null
    popup.current?.close(); popup.current = null
    setPending(false)
  }, [])
  useEffect(() => {
    window.addEventListener('pagehide', cancel)
    return () => { cancel(); window.removeEventListener('pagehide', cancel) }
  }, [cancel])
  useEffect(() => { if (!available) cancel() }, [available, cancel])

  async function open() {
    if (!availability.current || controller.current || document.hidden) return
    setFailure(null)
    // Reserve the tab during the user gesture; opening after await can be blocked.
    let target: Window | null = null
    try {
      target = window.open('about:blank', '_blank')
      if (target) target.opener = null
    } catch { target?.close(); target = null }
    if (!target) { setFailure('blocked'); return }
    popup.current = target
    const request = new AbortController(), ticket = ++generation.current
    controller.current = request; setPending(true)
    try {
      const result = readNativeWebLaunch(await hostRequest<unknown>('/plugins/dsh/manage', { method: 'POST', body: { operation: 'open-native-web', input: {} }, signal: request.signal }))
      if (request.signal.aborted || ticket !== generation.current || !availability.current) return
      if (target.closed) { setFailure('blocked'); return }
      const policy = target.document.createElement('meta')
      policy.name = 'referrer'; policy.content = 'no-referrer'; target.document.head.append(policy)
      const link = target.document.createElement('a')
      link.href = result.url; link.target = '_self'; link.rel = 'noopener noreferrer'
      target.document.body.append(link); link.click()
      popup.current = null
    } catch {
      if (!request.signal.aborted && ticket === generation.current) setFailure('failed')
    } finally {
      if (popup.current === target) { target.close(); popup.current = null }
      if (controller.current === request) { controller.current = null; setPending(false) }
    }
  }

  return <section className="dsh-native-entry" aria-labelledby={heading}>
    <div className="dsh-native-heading"><div><h3 id={heading}>{t('native.title')}</h3><p>{t('native.description')}</p></div>
      <button type="button" className="button button-primary" disabled={!available || pending} onClick={() => void open()}><ExternalLink size={16} aria-hidden="true" />{t(pending ? 'native.opening' : 'native.open')}</button>
    </div>
    <p className="dsh-help" role="status">{t(!enabled ? 'native.disabled' : !ready ? 'native.unavailable' : 'native.lifecycle')}</p>
    {failure && <div className="dsh-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><p>{t(failure === 'blocked' ? 'native.blocked' : 'native.failed')}</p></div>}
  </section>
}
