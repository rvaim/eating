import { useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { isJsonObject } from '@eating/plugin-sdk'
import { ActionButton, HostApiError, hostRequest, registerTranslations, useI18n } from '@eating/ui-sdk'
const zh = { title: '收到语音的共享目录', description: '当 OneBot 只返回转换后的文件路径时，确认该音频缓存目录在 Eating 本机的映射。只读取获准消息的语音，不影响图片传输。', use: '使用音频缓存共享目录', onebotRoot: 'OneBot 音频缓存目录', hostRoot: 'Eating 可读的对应目录', confirm: '我确认以上两个目录指向同一份音频缓存，并允许读取当前账号收到的语音。', bound: '目录确认绑定当前账号和服务地址；更换连接或修改目录后须重新确认。', save: '保存音频目录', read: '重新读取音频目录', saved: '音频目录设置已保存。', error: '音频目录操作未完成，请核对目录、连接及版本后重新读取。', conflict: '音频目录设置已在别处更改，草稿已保留。请重新读取后核对。' }
const en: Record<keyof typeof zh, string> = { title: 'Shared directory for received audio', description: 'If OneBot returns a converted file path, confirm the matching audio cache directory readable by Eating. Only authorized message audio is read. Image transport is separate.', use: 'Use a shared audio cache directory', onebotRoot: 'Audio cache directory on OneBot', hostRoot: 'Matching directory readable by Eating', confirm: 'I confirm these directories refer to the same audio cache and allow reading audio received by this account.', bound: 'Confirmation is bound to the current account and endpoint. Reconfirm after changing directories or connections.', save: 'Save audio directories', read: 'Reload audio directories', saved: 'Audio directory settings saved.', error: 'The operation did not complete. Check directories, connection and revision, then reload.', conflict: 'Audio directory settings changed elsewhere. Your draft is kept. Reload and review it.' }
registerTranslations('qq-audio-input', { 'zh-CN': zh, 'en-US': en })
interface Settings { schemaVersion: 1; revision: number; mapping: { onebotRoot: string; hostRoot: string; ownerConfirmed: boolean } | null }
function parse(v: unknown): Settings {
  if (!isJsonObject(v) || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || v.mapping !== null && (!isJsonObject(v.mapping) || typeof v.mapping.onebotRoot !== 'string' || typeof v.mapping.hostRoot !== 'string' || typeof v.mapping.ownerConfirmed !== 'boolean')) throw new Error('Invalid audio directory response')
  return v as unknown as Settings
}
interface Props { active: boolean; enabled: boolean; busy: boolean; connectionKey: string; actionLock: MutableRefObject<boolean>; onBusy: (value: boolean) => void; onFeedback: (message: string) => void }
export function AudioInputFields({ active, enabled, busy, connectionKey, actionLock, onBusy, onFeedback }: Props) {
  const { t } = useI18n('qq-audio-input'), id = useId(), [draft, setDraft] = useState<Settings | null>(null), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false)
  const controller = useRef<AbortController | null>(null), callbacks = useRef({ onBusy, onFeedback }), previousConnection = useRef(connectionKey); callbacks.current = { onBusy, onFeedback }
  async function request(save: boolean) {
    if (actionLock.current || !enabled || document.hidden || save && !draft) return
    const c = new AbortController(); controller.current = c; actionLock.current = true; setPending(true); setError(null); setSaved(false); callbacks.current.onBusy(true)
    try {
      const v = await hostRequest('/plugins/qq/manage', { method: 'POST', signal: c.signal, body: save && draft ? { operation: 'save-audio-input', input: { expectedRevision: draft.revision, mapping: draft.mapping } } : { operation: 'audio-input', input: {} } })
      if (!c.signal.aborted) { setDraft(parse(v)); setDirty(false); setSaved(save); if (save) callbacks.current.onFeedback(t('saved')) }
    } catch (e) { if (!c.signal.aborted) setError(e instanceof HostApiError && e.code === 'QQ_AUDIO_INPUT_CONFLICT' ? 'conflict' : 'error') }
    finally { if (controller.current === c) { controller.current = null; actionLock.current = false; setPending(false); callbacks.current.onBusy(false) } }
  }
  useEffect(() => {
    if (connectionKey !== previousConnection.current) { if (!dirty) setDraft(null); else setDraft(d => d?.mapping ? { ...d, mapping: { ...d.mapping, ownerConfirmed: false } } : d); setSaved(false) }
    previousConnection.current = connectionKey
    if (active && enabled && !dirty && !busy && !draft) void request(false)
  }, [active, enabled, connectionKey, busy, draft, dirty])
  useEffect(() => {
    const stop = () => { if (controller.current) { controller.current.abort(); controller.current = null; actionLock.current = false; setPending(false); callbacks.current.onBusy(false) } }
    const hide = () => { if (document.hidden) stop() }; document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); stop() }
  }, [active, actionLock])
  function update(next: Settings) { setDraft(next); setDirty(true); setSaved(false); setError(null) }
  return <section className="qq-media-transport" aria-labelledby={id + '-title'}><div className="section-heading"><h3 id={id + '-title'}>{t('title')}</h3><p>{t('description')}</p></div>
    {draft && <form className="form-fields" onSubmit={e => { e.preventDefault(); void request(true) }}><fieldset className="qq-fieldset" disabled={busy || pending || !enabled}>
      <label className="check-field"><input type="checkbox" checked={draft.mapping !== null} onChange={e => update({ ...draft, mapping: e.target.checked ? { onebotRoot: '', hostRoot: '', ownerConfirmed: false } : null })} /><span>{t('use')}</span></label>
      {draft.mapping && <>{(['onebotRoot', 'hostRoot'] as const).map(k => <div className="field" key={k}><label htmlFor={id + '-' + k}>{t(k)}</label><input id={id + '-' + k} value={draft.mapping![k]} required maxLength={4096} autoComplete="off" spellCheck={false} onChange={e => update({ ...draft, mapping: { ...draft.mapping!, [k]: e.target.value, ownerConfirmed: false } })} /></div>)}<label className="check-field"><input type="checkbox" checked={draft.mapping.ownerConfirmed} onChange={e => update({ ...draft, mapping: { ...draft.mapping!, ownerConfirmed: e.target.checked } })} /><span>{t('confirm')}</span></label></>}
    </fieldset><p className="qq-help">{t('bound')}</p><div className="qq-actions"><ActionButton type="submit" className="button button-primary" disabled={!enabled || busy || pending || !dirty || error === 'conflict'} reason={t('error')}>{t('save')}</ActionButton><ActionButton type="button" className="button button-secondary" disabled={!enabled || busy || pending} reason={t('error')} onClick={() => void request(false)}>{t('read')}</ActionButton></div></form>}
    {!draft && <button type="button" className="button button-secondary" disabled={!enabled || busy || pending} onClick={() => void request(false)}>{t('read')}</button>}{error && <p className="qq-error" role="alert">{t(error)}</p>}{saved && <p className="qq-operation-result" role="status">{t('saved')}</p>}
  </section>
}
