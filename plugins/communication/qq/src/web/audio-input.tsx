import { useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { isJsonObject } from '@eating/plugin-sdk'
import { ActionButton, FormSaveBar, HostApiError, hostRequest, registerTranslations, Switch, useI18n } from '@eating/ui-sdk'
const zh = {
  title: '收到语音的共享目录',
  description: '当 OneBot 只返回转换后的文件路径时，确认该音频缓存目录在 Eating 本机的映射。只读取获准消息的语音，不影响图片传输。',
  independentNote: '此分区有独立的保存与版本控制；点击下方保存按钮才会生效。',
  badgeSaved: '已保存',
  badgeDirty: '有未保存更改',
  use: '使用音频缓存共享目录',
  onebotRoot: 'OneBot 音频缓存目录',
  hostRoot: 'Eating 可读的对应目录',
  confirm: '我确认以上两个目录指向同一份音频缓存，并允许读取当前账号收到的语音。',
  bound: '目录确认绑定当前账号和服务地址；更换连接或修改目录后须重新确认。',
  save: '保存音频目录',
  saving: '正在保存…',
  read: '重新读取音频目录',
  saved: '音频目录设置已保存。',
  error: '音频目录操作未完成，请核对目录、连接及版本后重新读取。',
  conflict: '音频目录设置已在别处更改，草稿已保留。请重新读取后核对。',
  disabledReason: '请先启用 QQ 插件。',
}
const en: Record<keyof typeof zh, string> = {
  title: 'Shared directory for received audio',
  description: 'If OneBot returns a converted file path, confirm the matching audio cache directory readable by Eating. Only authorized message audio is read. Image transport is separate.',
  independentNote: 'This section is saved and versioned separately. Click Save below to apply changes.',
  badgeSaved: 'Saved',
  badgeDirty: 'Unsaved changes',
  use: 'Use a shared audio cache directory',
  onebotRoot: 'Audio cache directory on OneBot',
  hostRoot: 'Matching directory readable by Eating',
  confirm: 'I confirm these directories refer to the same audio cache and allow reading audio received by this account.',
  bound: 'Confirmation is bound to the current account and endpoint. Reconfirm after changing directories or connections.',
  save: 'Save audio directories',
  saving: 'Saving…',
  read: 'Reload audio directories',
  saved: 'Audio directory settings saved.',
  error: 'The operation did not complete. Check directories, connection and revision, then reload.',
  conflict: 'Audio directory settings changed elsewhere. Your draft is kept. Reload and review it.',
  disabledReason: 'Enable the QQ plugin first.',
}
registerTranslations('qq-audio-input', { 'zh-CN': zh, 'en-US': en })
interface AudioMapping { onebotRoot: string; hostRoot: string; ownerConfirmed: boolean }
interface Settings { schemaVersion: 1; revision: number; mapping: AudioMapping | null }
function parse(v: unknown): Settings {
  if (!isJsonObject(v) || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || v.mapping !== null && (!isJsonObject(v.mapping) || typeof v.mapping.onebotRoot !== 'string' || typeof v.mapping.hostRoot !== 'string' || typeof v.mapping.ownerConfirmed !== 'boolean')) throw new Error('Invalid audio directory response')
  return v as unknown as Settings
}
interface Props { active: boolean; enabled: boolean; busy: boolean; connectionKey: string; actionLock: MutableRefObject<boolean>; onBusy: (value: boolean) => void; onFeedback: (message: string) => void; onDirtyChange?: (dirty: boolean) => void }
export function AudioInputFields({ active, enabled, busy, connectionKey, actionLock, onBusy, onFeedback, onDirtyChange }: Props) {
  const { t } = useI18n('qq-audio-input'), id = useId()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [stashedMapping, setStashedMapping] = useState<AudioMapping | null>(null)
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false)
  const controller = useRef<AbortController | null>(null), modeRef = useRef<'read' | 'save' | null>(null), callbacks = useRef({ onBusy, onFeedback, onDirtyChange }), previousConnection = useRef(connectionKey), previousActive = useRef(false), needsLoad = useRef(true)
  callbacks.current = { onBusy, onFeedback, onDirtyChange }
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty) }, [dirty])
  async function request(save: boolean) {
    if (!enabled || document.hidden || pending || (save ? actionLock.current || !draft : busy || actionLock.current)) return
    const c = new AbortController(); controller.current = c
    modeRef.current = save ? 'save' : 'read'
    if (!save) needsLoad.current = false
    if (save) { actionLock.current = true; callbacks.current.onBusy(true) }
    setPending(true); setError(null); setSaved(false)
    try {
      const v = await hostRequest('/plugins/qq/manage', { method: 'POST', signal: c.signal, body: save && draft ? { operation: 'save-audio-input', input: { expectedRevision: draft.revision, mapping: draft.mapping } } : { operation: 'audio-input', input: {} } })
      if (!c.signal.aborted) {
        const parsed = parse(v)
        setDraft(parsed); setStashedMapping(parsed.mapping); setDirty(false); setSaved(save)
        if (save) callbacks.current.onFeedback(t('saved'))
      }
    } catch (e) { if (!c.signal.aborted) setError(e instanceof HostApiError && e.code === 'QQ_AUDIO_INPUT_CONFLICT' ? 'conflict' : 'error') }
    finally {
      if (controller.current === c) {
        const wasSave = modeRef.current === 'save'
        controller.current = null; modeRef.current = null
        if (wasSave) { actionLock.current = false; callbacks.current.onBusy(false) }
        setPending(false)
      }
    }
  }
  useEffect(() => {
    if (busy && modeRef.current === 'read' && controller.current) {
      controller.current.abort(); controller.current = null; modeRef.current = null; setPending(false); needsLoad.current = true
    }
  }, [busy])
  useEffect(() => {
    const connectionChanged = connectionKey !== previousConnection.current
    const activated = active && !previousActive.current
    if (connectionChanged) {
      if (!dirty) {
        setDraft(null); needsLoad.current = true
        if (modeRef.current === 'read' && controller.current) { controller.current.abort(); controller.current = null; modeRef.current = null; setPending(false) }
      } else {
        setDraft(d => d?.mapping ? { ...d, mapping: { ...d.mapping, ownerConfirmed: false } } : d)
      }
      setSaved(false)
    } else if (activated && !dirty) {
      needsLoad.current = true
    }
    previousConnection.current = connectionKey
    previousActive.current = active
    if (active && enabled && !dirty && !busy && !pending && !document.hidden && needsLoad.current) void request(false)
  }, [active, enabled, connectionKey, busy, dirty])
  const stateRef = useRef({ active, enabled, dirty, busy, pending, request })
  stateRef.current = { active, enabled, dirty, busy, pending, request }
  useEffect(() => {
    const stop = () => { if (controller.current) { controller.current.abort(); const wasSave = modeRef.current === 'save'; controller.current = null; modeRef.current = null; setPending(false); if (wasSave) { actionLock.current = false; callbacks.current.onBusy(false) } else { needsLoad.current = true } } }
    const onVis = () => {
      const s = stateRef.current
      if (document.hidden) stop()
      else if (s.active && s.enabled && !s.dirty && !s.busy && !s.pending && needsLoad.current) void s.request(false)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); stop(); callbacks.current.onDirtyChange?.(false) }
  }, [actionLock])
  function update(next: Settings) {
    if (next.mapping) setStashedMapping(next.mapping)
    setDraft(next); setDirty(true); setSaved(false); setError(null)
  }
  const blocked = busy || pending
  const conflict = error === 'conflict'
  return <section className="qq-media-transport qq-subcard" aria-labelledby={id + '-title'}>
    <div className="qq-subcard-header">
      <div className="section-heading"><h3 id={id + '-title'}>{t('title')}</h3><p>{t('description')}</p></div>
      <span className={`qq-subcard-badge${dirty ? ' is-dirty' : ''}`}>{t(dirty ? 'badgeDirty' : 'badgeSaved')}</span>
    </div>
    <p className="qq-help qq-subcard-note">{t('independentNote')}</p>
    {draft && <form className="form-fields" onSubmit={e => { e.preventDefault(); void request(true) }}><fieldset className="qq-fieldset" disabled={blocked || !enabled}>
      <div className="qq-switch-row"><Switch id={id + '-use'} checked={draft.mapping !== null} disabled={blocked || !enabled} reasonCode={blocked ? 'busy' : 'enable'} label={t('use')} onChange={checked => update({ ...draft, mapping: checked ? (stashedMapping ?? { onebotRoot: '', hostRoot: '', ownerConfirmed: false }) : null })} /></div>
      {draft.mapping && <>
        {(['onebotRoot', 'hostRoot'] as const).map(k => <div className="field" key={k}><label htmlFor={id + '-' + k}>{t(k)}</label><input id={id + '-' + k} value={draft.mapping![k]} required maxLength={4096} autoComplete="off" spellCheck={false} onChange={e => update({ ...draft, mapping: { ...draft.mapping!, [k]: e.target.value, ownerConfirmed: false } })} /></div>)}
        <div className="qq-switch-row"><Switch id={id + '-confirm'} checked={draft.mapping.ownerConfirmed} disabled={blocked || !enabled} reasonCode={blocked ? 'busy' : 'enable'} label={t('confirm')} onChange={checked => update({ ...draft, mapping: { ...draft.mapping!, ownerConfirmed: checked } })} /></div>
      </>}
    </fieldset><p className="qq-help">{t('bound')}</p>
    <FormSaveBar
      alwaysVisible
      dirty={dirty}
      saving={pending}
      disabled={!enabled || blocked || conflict}
      disabledReason={!enabled ? t('disabledReason') : conflict ? t('conflict') : undefined}
      conflict={conflict}
      saveLabel={t('save')}
      savingLabel={t('saving')}
      reloadLabel={t('read')}
      onSave={() => void request(true)}
      onReload={() => void request(false)}
      extraActions={!conflict ? <ActionButton type="button" className="button button-secondary" disabled={!enabled || blocked} reasonCode={blocked ? 'busy' : 'enable'} onClick={() => void request(false)}>{t('read')}</ActionButton> : undefined}
    /></form>}
    {!draft && <ActionButton type="button" className="button button-secondary" disabled={!enabled || blocked} reasonCode={blocked ? 'busy' : 'enable'} onClick={() => void request(false)}>{t('read')}</ActionButton>}
    {error && <p className="qq-error" role="alert">{t(error)}</p>}
    {saved && <p className="qq-operation-result" role="status">{t('saved')}</p>}
  </section>
}
