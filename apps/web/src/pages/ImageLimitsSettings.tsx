import { useEffect, useRef, useState } from 'react'
import { imageLimits, readImageLimits } from '@eating/plugin-sdk'
import type { ImageLimits } from '@eating/plugin-sdk'
import { HostApiError, hostRequest, registerTranslations, useI18n } from '@eating/ui-sdk'

registerTranslations('image-limits', {
  'zh-CN': { title: '图片大小', help: '统一控制生图、表情库、收到的图片、预览和 QQ 发送。调整上限不会删除已有图片。', label: '单张图片上限（MiB）', hint: '默认10 MiB，可设1–50 MiB；PNG、JPEG、WebP和GIF使用相同限制。外部服务和QQ仍可能有自身限制。', batch: '单次多图总量上限：{{value}} MiB，最多4张。', save: '保存图片设置', reload: '重新读取', cancel: '保留草稿', confirm: '放弃草稿并读取', question: '重新读取会放弃当前图片大小草稿。', saved: '图片大小设置已保存，后续读取和发送立即使用新上限。', invalid: '请输入1–50范围内的整数。', conflict: '设置已在别处修改，草稿已保留，请重新读取后核对。', error: '操作未完成，请重新读取核对；草稿已保留。', loading: '正在读取图片大小设置…', busy: '处理中…' },
  'en-US': { title: 'Image size', help: 'One limit for generated images, stickers, received images, previews and QQ sending. Existing images are kept when the limit changes.', label: 'Maximum image size (MiB)', hint: 'Default 10 MiB, configurable from 1 to 50 MiB. The same limit applies to PNG, JPEG, WebP and GIF. Providers and QQ may impose their own limits.', batch: 'Combined image limit per send: {{value}} MiB, up to 4 images.', save: 'Save image settings', reload: 'Reload', cancel: 'Keep draft', confirm: 'Discard draft and reload', question: 'Reloading will discard this image-size draft.', saved: 'Image settings saved. Subsequent reads and sends use the new limit.', invalid: 'Enter a whole number from 1 to 50.', conflict: 'Settings changed elsewhere. Your draft is kept; reload and review before saving.', error: 'The operation did not complete. Reload to verify; your draft is kept.', loading: 'Reading image-size settings…', busy: 'Working…' },
})
export function ImageLimitsSettings({ active }: { active: boolean }) {
  const { t, formatNumber } = useI18n('image-limits')
  const [snapshot, setSnapshot] = useState<ImageLimits | null>(null), [draft, setDraft] = useState('10'), [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false), [saved, setSaved] = useState(false), [confirm, setConfirm] = useState(false)
  const alive = useRef(false), controller = useRef<AbortController | null>(null), cancel = useRef<HTMLButtonElement | null>(null), activeRef = useRef(active)
  const snapshotRef = useRef(snapshot)
  activeRef.current = active
  snapshotRef.current = snapshot
  const read = async () => {
    if (controller.current || !activeRef.current || document.hidden) return
    const abort = new AbortController(); controller.current = abort; setPending(true); setSaved(false)
    try { const result = readImageLimits(await hostRequest('/image-limits', { signal: abort.signal })); if (alive.current && !abort.signal.aborted) { setSnapshot(result); setDraft(String(result.maxImageMiB)); setDirty(false); setError(null); setConfirm(false) } }
    catch { if (alive.current && !abort.signal.aborted) setError('error') }
    finally { if (controller.current === abort) { controller.current = null; if (alive.current) setPending(false) } }
  }
  useEffect(() => {
    alive.current = true
    const hide = () => {
      if (document.hidden) { controller.current?.abort(); controller.current = null; setPending(false); setConfirm(false) }
      else if (!snapshotRef.current) void read()
    }
    document.addEventListener('visibilitychange', hide)
    return () => { alive.current = false; controller.current?.abort(); document.removeEventListener('visibilitychange', hide) }
  }, [])
  useEffect(() => { if (active && !snapshot) void read(); if (!active) { controller.current?.abort(); controller.current = null; setPending(false) } }, [active])
  useEffect(() => { if (confirm) cancel.current?.focus() }, [confirm])
  const save = async () => {
    if (!snapshot || controller.current || document.hidden || !activeRef.current) return
    if (!/^\d+$/.test(draft) || Number(draft) < 1 || Number(draft) > 50) { setError('invalid'); return }
    const abort = new AbortController(); controller.current = abort; setPending(true); setSaved(false)
    try {
      const result = readImageLimits(await hostRequest('/image-limits', { method: 'POST', signal: abort.signal, body: { expectedRevision: snapshot.revision, maxImageMiB: Number(draft) } }))
      if (alive.current && !abort.signal.aborted) { setSnapshot(result); setDraft(String(result.maxImageMiB)); setDirty(false); setError(null); setSaved(true) }
    } catch (e) { if (alive.current && !abort.signal.aborted) setError(e instanceof HostApiError && e.code === 'IMAGE_LIMITS_CONFLICT' ? 'conflict' : 'error') }
    finally { if (controller.current === abort) { controller.current = null; if (alive.current) setPending(false) } }
  }
  const total = /^\d+$/.test(draft) && Number(draft) >= 1 && Number(draft) <= 50 ? imageLimits(Number(draft)).batchBytes / 1024 / 1024 : null
  return <section className="settings-section" aria-labelledby="image-limits-title" aria-busy={pending} onKeyDown={e => { if (e.key === 'Escape') setConfirm(false) }}>
    <h2 id="image-limits-title">{t('title')}</h2><p className="panel-description">{t('help')}</p>
    {pending && !snapshot && <p role="status">{t('loading')}</p>}
    <form onSubmit={e => { e.preventDefault(); void save() }}><div className="settings-field"><label htmlFor="image-size-mib">{t('label')}</label><div className="settings-field-content"><div className="settings-number-input"><input id="image-size-mib" type="number" min="1" max="50" step="1" value={draft} disabled={pending || !snapshot} aria-describedby="image-size-hint" aria-invalid={error === 'invalid'} onChange={e => { setDraft(e.target.value); setDirty(e.target.value !== String(snapshot?.maxImageMiB)); setSaved(false); setError(null) }} /><span aria-hidden="true">MiB</span></div><p id="image-size-hint" className="field-hint">{t('hint')}</p>{total !== null && <p className="field-hint">{t('batch', { value: formatNumber(total) })}</p>}</div></div>
    <div className="settings-actions"><button type="submit" className="button button-primary" disabled={!dirty || pending || !snapshot}>{t(pending ? 'busy' : 'save')}</button><button type="button" className="button button-secondary" disabled={pending} onClick={() => dirty ? setConfirm(true) : void read()}>{t('reload')}</button></div></form>
    {confirm && <div className="settings-inline-confirmation" role="group" aria-label={t('question')}><p>{t('question')}</p><div className="settings-confirm-actions"><button ref={cancel} type="button" className="button button-secondary" onClick={() => setConfirm(false)}>{t('cancel')}</button><button type="button" className="button button-primary" onClick={() => void read()}>{t('confirm')}</button></div></div>}
    {error && <p role="alert" className="field-error">{t(error)}</p>}{saved && <p role="status" className="settings-notice settings-notice-success">{t('saved')}</p>}
  </section>
}
