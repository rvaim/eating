import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ExternalLink } from 'lucide-react'
import { hostRequest, useI18n } from '@eating/ui-sdk'
import { readNativeWebLaunch } from './panel-data'

/**
 * Opens the official DSH Web in a new tab. The authenticated URL exists only in the
 * click request and the reserved window; it never enters React state or browser storage.
 */
export function NativeWebButton({ enabled, ready, blocked, visible }: {
  readonly enabled: boolean
  readonly ready: boolean
  readonly blocked: boolean
  readonly visible: boolean
}) {
  const { t } = useI18n('dsh')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<'blocked' | 'failed' | null>(null)
  const controller = useRef<AbortController | null>(null)
  const popup = useRef<Window | null>(null)
  const generation = useRef(0)
  const available = enabled && ready && !blocked && visible
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
    // Reserve the tab during the user gesture; opening it after the request may be blocked.
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
      const result = readNativeWebLaunch(await hostRequest<unknown>('/plugins/dsh/manage', {
        method: 'POST', body: { operation: 'open-native-web', input: {} }, signal: request.signal,
      }))
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

  const title = !enabled ? t('native.disabled') : !ready ? t('native.unavailable') : undefined
  return <div className="dsh-native-control">
    <button type="button" className="button button-secondary dsh-native-open" disabled={!available || pending} title={title} onClick={() => void open()}>
      <ExternalLink size={15} aria-hidden="true" />{t(pending ? 'native.opening' : 'native.open')}
    </button>
    {failure && <p className="dsh-native-failure" role="alert"><AlertCircle size={13} aria-hidden="true" />{t(failure === 'blocked' ? 'native.blocked' : 'native.failed')}</p>}
  </div>
}
