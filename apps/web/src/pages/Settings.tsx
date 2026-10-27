import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronRight, Database, Info, Send, Trash2 } from 'lucide-react'
import { validateDeliverySettings } from '@eating/plugin-sdk'
import type { DeliveryQueueStats, DeliverySettings, DeliverySettingsSnapshot } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import './Settings.css'

export type SettingsSection = 'delivery' | 'queue'
type NumericKey = Exclude<keyof DeliverySettings, 'storageMode' | 'overflowPolicy'>
type SettingsDraft = Record<NumericKey, string> & Pick<DeliverySettings, 'storageMode' | 'overflowPolicy'>
type FieldErrors = Partial<Record<keyof DeliverySettings, string>>
type Operation = 'read' | 'save' | 'clear'
type Notice = { readonly kind: 'error' | 'success' | 'info'; readonly message: string }

interface NumericField {
  readonly key: NumericKey
  readonly section: SettingsSection
  readonly label: string
  readonly unit: string
  readonly scale: number
  readonly minimum: number
  readonly maximum: number
  readonly hint: string
}

const numericFields: readonly NumericField[] = [
  { key: 'quietWindowMs', section: 'delivery', label: '聚合静默时间', unit: 'ms', scale: 1, minimum: 0, maximum: 60000, hint: '收到同会话的新消息会重新计时。0 表示不等待静默，仍按当前可用队列组成批次。' },
  { key: 'maxWaitMs', section: 'delivery', label: '最长聚合等待时间', unit: 'ms', scale: 1, minimum: 1, maximum: 300000, hint: '从同会话首条消息开始计时，不随新消息重置；不能小于聚合静默时间。' },
  { key: 'maxBatchMessages', section: 'delivery', label: '单批消息上限', unit: '条', scale: 1, minimum: 1, maximum: 200, hint: '达到上限即提前投递；不能大于队列消息上限。' },
  { key: 'batchTargetBytes', section: 'delivery', label: '批次目标大小', unit: 'KB', scale: 1024, minimum: 256, maximum: 4 * 1024 * 1024, hint: '1 KB = 1024 字节。达到目标即提前投递；单条超过目标时单独投递、不拆分，仍受队列总容量限制。这不是 token 数或模型上下文长度。' },
  { key: 'deliveryTimeoutMs', section: 'delivery', label: '投递超时', unit: 'ms', scale: 1, minimum: 100, maximum: 120000, hint: '等待接收端确认的最长时间。1000 ms = 1 秒；超时后结果未知，不自动重发。' },
  { key: 'retryIntervalMs', section: 'delivery', label: '拒收重试间隔', unit: 'ms', scale: 1, minimum: 100, maximum: 300000, hint: '只有接收端明确拒收才按此间隔重试；结果未知时不自动重发。' },
  { key: 'maxDeliveryAttempts', section: 'delivery', label: '最大投递尝试次数', unit: '次', scale: 1, minimum: 1, maximum: 20, hint: '包含首次投递；只有接收端明确拒收才会继续尝试，最多尝试此次数。' },
  { key: 'maxQueuedMessages', section: 'queue', label: '队列消息上限', unit: '条', scale: 1, minimum: 1, maximum: 100000, hint: '限制尚未完成交接的队列消息数量；这些消息不是聊天历史。不能小于单批消息上限。' },
  { key: 'maxQueuedBytes', section: 'queue', label: '队列容量上限', unit: 'MB', scale: 1024 * 1024, minimum: 1024, maximum: 100 * 1024 * 1024, hint: '此处 1 MB 按 1 MiB 计算，即 1024 × 1024 = 1,048,576 字节；不能小于批次目标大小。' },
]

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
    if (!Number.isSafeInteger(amount)) errors[field.key] = field.scale === 1 ? '请输入整数。' : '请输入有效数值，换算后必须是整数个字节。'
    else if (amount < field.minimum || amount > field.maximum) errors[field.key] = `请输入 ${field.minimum / field.scale} 至 ${field.maximum / field.scale} ${field.unit}。`
    numbers[field.key] = amount
  }
  if (!errors.maxWaitMs && !errors.quietWindowMs && numbers.maxWaitMs < numbers.quietWindowMs) errors.maxWaitMs = '最长聚合等待时间不能小于聚合静默时间。'
  if (!errors.maxBatchMessages && !errors.maxQueuedMessages && numbers.maxBatchMessages > numbers.maxQueuedMessages) {
    errors.maxBatchMessages = '单批消息上限不能大于队列消息上限。'
    errors.maxQueuedMessages = '队列消息上限不能小于单批消息上限。'
  }
  if (!errors.batchTargetBytes && !errors.maxQueuedBytes && numbers.batchTargetBytes > numbers.maxQueuedBytes) {
    errors.batchTargetBytes = '批次目标大小不能大于队列容量上限。'
    errors.maxQueuedBytes = '队列容量上限不能小于批次目标大小。'
  }
  if (Object.keys(errors).length) return { values: null, errors }
  try { return { values: validateDeliverySettings({ ...numbers, storageMode: draft.storageMode, overflowPolicy: draft.overflowPolicy }), errors } }
  catch { return { values: null, errors: { storageMode: '设置校验失败，请重新读取设置并检查各项输入。' } } }
}

function checkSnapshot(snapshot: DeliverySettingsSnapshot): DeliverySettingsSnapshot {
  if (!snapshot || snapshot.protocolVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new HostApiError('INVALID_HOST_RESPONSE', '设置响应不完整，无法读取当前设置。')
  try { validateDeliverySettings(snapshot.values) }
  catch { throw new HostApiError('INVALID_HOST_RESPONSE', '后台返回的设置无效，请检查后台运行状态后重新读取。') }
  const queue = snapshot.queue
  const counts: readonly (keyof DeliveryQueueStats)[] = ['pending', 'delivering', 'uncertain', 'queuedMessages', 'queuedBytes', 'accepted', 'rejected', 'discarded', 'dedupIdentifiers']
  if (!queue || !['persistent', 'memory'].includes(queue.storageMode) || typeof queue.overCapacity !== 'boolean'
    || !(queue.lastQueueError === null || typeof queue.lastQueueError === 'string')
    || counts.some(key => typeof queue[key] !== 'number' || !Number.isSafeInteger(queue[key]) || Number(queue[key]) < 0)) throw new HostApiError('INVALID_HOST_RESPONSE', '后台未返回完整的队列状态，请重新读取设置。')
  return snapshot
}

function isStaleRevision(error: unknown): boolean {
  return error instanceof HostApiError && (error.code === 'DELIVERY_SETTINGS_CONFLICT'
    || error.code === 'SETTINGS_REVISION_CONFLICT'
    || error.code.replace(/[_-]/g, '').toLowerCase() === 'stalerevision')
}

function readableError(error: unknown, operation: Operation): string {
  if (isStaleRevision(error)) return '设置已在其他位置更改。原草稿已保留，当前不能保存。请点击“重新读取设置”，确认放弃未保存修改后读取最新设置。'
  if (error instanceof HostApiError) {
    if (error.code === 'REQUEST_INTERRUPTED' && operation === 'read') return '读取设置超时或已中断，请重新读取。'
    if (error.code === 'REQUEST_INTERRUPTED') return '请求已中断，操作结果尚未确认。草稿已保留，请先重新读取设置核对结果。'
    return error.message
  }
  return operation === 'read' ? '无法读取设置，请检查后台运行状态后重新读取。' : operation === 'clear' ? '清空队列失败，请重新读取状态后再操作。' : '保存设置失败，未保存的草稿已保留，请稍后重试。'
}

const formatCount = (value: number) => value.toLocaleString('zh-CN')
const storageLabel = (mode: DeliverySettings['storageMode']) => mode === 'persistent' ? '本地暂存（重启恢复）' : '仅内存（重启丢失）'

export function Settings({ section, onSectionChange, onFeedback }: {
  readonly section: SettingsSection
  readonly onSectionChange: (section: SettingsSection) => void
  readonly onFeedback: (message: string) => void
}) {
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
      if (mounted.current && current === generation.current && !controller.signal.aborted) setNotice({ kind: 'error', message: readableError(error, 'read') })
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
      setNotice({ kind: 'error', message: '请检查标记的字段后再保存。两个分类的设置会一起保存。' })
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
      const message = kind === 'save' ? '设置已保存并应用' : '队列已清空，账号配置和发送账本已保留'
      setNotice({ kind: 'success', message })
      feedback.current(message)
      if (kind === 'clear') clearTrigger.current?.focus()
    } catch (error) {
      if (!mounted.current || current !== generation.current || controller.signal.aborted) return
      if (isStaleRevision(error) || error instanceof HostApiError && error.outcome === 'unknown') setRequiresRead(true)
      setNotice({ kind: 'error', message: readableError(error, kind) })
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
      <label htmlFor={`settings-${key}`}>{field.label}</label>
      <div className="settings-field-content">
        <div className="settings-number-input">
          <input id={`settings-${key}`} name={key} type="text" inputMode={field.scale === 1 ? 'numeric' : 'decimal'} autoComplete="off" maxLength={24}
            value={draft?.[key] ?? ''} disabled={busy} onChange={event => updateDraft(key, event.target.value)}
            aria-invalid={Boolean(error)} aria-describedby={`settings-${key}-hint${error ? ` settings-${key}-error` : ''}`} />
          <span aria-hidden="true">{field.unit}</span>
        </div>
        <p id={`settings-${key}-hint`} className="settings-field-hint">{field.hint} 范围：{field.minimum / field.scale}–{field.maximum / field.scale} {field.unit}。</p>
        {error && <p id={`settings-${key}-error`} className="settings-field-error">{error}</p>}
      </div>
    </div>
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void mutate('save') }

  return <div className="robot-workspace settings-workspace">
    <aside className="platform-sidebar settings-sidebar">
      <p className="platform-nav-heading">设置分类</p>
      <nav aria-label="设置分类">
        <button type="button" className={`platform-nav-item${section === 'delivery' ? ' is-selected' : ''}`} aria-current={section === 'delivery' ? 'page' : undefined} onClick={() => onSectionChange('delivery')}><Send size={18} aria-hidden="true" /><span>消息投递</span>{section === 'delivery' && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}</button>
        <button type="button" className={`platform-nav-item${section === 'queue' ? ' is-selected' : ''}`} aria-current={section === 'queue' ? 'page' : undefined} onClick={() => onSectionChange('queue')}><Database size={18} aria-hidden="true" /><span>队列与存储</span>{section === 'queue' && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}</button>
      </nav>
    </aside>
    <main id="main-content" className="robot-content settings-content" aria-busy={busy}>
      <div className="settings-title-row">
        <div><h2>{section === 'delivery' ? '消息投递' : '队列与存储'}</h2><p className="panel-description">{section === 'delivery' ? '调整消息聚合、投递与拒收后的重试方式。' : '管理尚未完成交接的消息，以及队列的暂存与容量。'}</p></div>
        <button ref={readTrigger} type="button" className="button button-secondary settings-read-button" disabled={busy} aria-expanded={confirmRead} aria-controls="settings-read-confirmation" onClick={() => { void readSettings() }}>{operation === 'read' ? '正在读取…' : '重新读取设置'}</button>
      </div>
      <p className="settings-retention-note"><Info size={16} aria-hidden="true" /><span>交接完成即删除正文；未转交不保存正文；仅短期保留去重标识，不保留聊天历史。</span></p>
      {confirmRead && <div id="settings-read-confirmation" className="settings-inline-confirmation" role="group" aria-label="确认重新读取设置"><p>重新读取会放弃两个分类中所有未保存的修改，使用后台的最新设置。</p><div className="settings-confirm-actions"><button ref={readCancel} type="button" className="button button-secondary" disabled={busy} onClick={() => { setConfirmRead(false); readTrigger.current?.focus() }}>继续编辑</button><button type="button" className="button button-secondary" disabled={busy} onClick={() => { void readSettings(true) }}>放弃未保存修改并重新读取</button></div></div>}
      {notice && <div className={`settings-notice settings-notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</div>}
      {!snapshot || !draft ? <div className="settings-read-state" role="status"><p>{operation === 'read' ? '正在读取当前设置和队列状态…' : '尚未读取到设置，请点击“重新读取设置”。'}</p></div> : <>
        <form className="settings-form" onSubmit={submit} noValidate>
          {section === 'delivery' ? <>
            <section className="settings-form-section" aria-labelledby="settings-aggregation-heading">
              <div className="section-heading"><h3 id="settings-aggregation-heading">消息聚合</h3><p>同一会话内聚合消息，达到任一批次条件时提前投递。</p></div>
              {renderNumber('quietWindowMs')}{renderNumber('maxWaitMs')}{renderNumber('maxBatchMessages')}{renderNumber('batchTargetBytes')}
            </section>
            <section className="settings-form-section" aria-labelledby="settings-delivery-heading">
              <div className="section-heading"><h3 id="settings-delivery-heading">投递与重试</h3><p>可靠接收表示接收端已接手，不等于模型已读。结果未知时不自动重发。</p></div>
              {renderNumber('deliveryTimeoutMs')}{renderNumber('retryIntervalMs')}{renderNumber('maxDeliveryAttempts')}
            </section>
          </> : <section className="settings-form-section" aria-labelledby="settings-storage-heading">
            <div className="section-heading"><h3 id="settings-storage-heading">队列设置</h3><p>队列只保留尚未完成交接的消息正文。</p></div>
            <div className={`settings-field${showErrors && validation.errors.storageMode ? ' is-invalid' : ''}`}>
              <label htmlFor="settings-storageMode">队列存储方式</label>
              <div className="settings-field-content">
                <select id="settings-storageMode" name="storageMode" value={draft.storageMode} disabled={busy} aria-describedby={`settings-storageMode-hint${showErrors && validation.errors.storageMode ? ' settings-storageMode-error' : ''}`} aria-invalid={Boolean(showErrors && validation.errors.storageMode)} onChange={event => updateDraft('storageMode', event.target.value as DeliverySettings['storageMode'])}>
                  <option value="persistent">本地暂存（重启恢复）</option><option value="memory">仅内存（重启丢失）</option>
                </select>
                <p id="settings-storageMode-hint" className="settings-field-hint">本地暂存可在重启后恢复尚未交接的队列；仅内存模式下，退出或重启会丢失这些消息。</p>
                {showErrors && validation.errors.storageMode && <p id="settings-storageMode-error" className="settings-field-error">{validation.errors.storageMode}</p>}
                {draft.storageMode === 'memory' && <p className="settings-storage-risk">{snapshot.values.storageMode !== 'memory' ? '保存后，尚未交接的消息会移入内存；重启后无法恢复。' : '当前队列仅在内存中；退出或重启后，尚未交接的消息无法恢复。'}</p>}
              </div>
            </div>
            {renderNumber('maxQueuedMessages')}{renderNumber('maxQueuedBytes')}
            <div className="settings-field">
              <label htmlFor="settings-overflowPolicy">队列溢出处理</label>
              <div className="settings-field-content">
                <select id="settings-overflowPolicy" name="overflowPolicy" value={draft.overflowPolicy} disabled={busy} aria-describedby="settings-overflowPolicy-hint" onChange={event => updateDraft('overflowPolicy', event.target.value as DeliverySettings['overflowPolicy'])}>
                  <option value="reject-new">拒绝新消息，保留现有队列</option><option value="drop-oldest">丢弃最旧待投递消息</option>
                </select>
                <p id="settings-overflowPolicy-hint" className="settings-field-hint">队列满时按所选策略处理。已在途或结果未知的消息不会自动丢弃；没有可丢弃的待投递消息时仍会拒绝新消息。拒绝与丢弃数量见下方状态。</p>
                {draft.overflowPolicy === 'drop-oldest' && <p className="settings-storage-risk">保存此策略后，队列满时允许丢弃最旧的待投递消息，其正文无法恢复。</p>}
              </div>
            </div>
          </section>}
          <div className="settings-actions">
            <button type="submit" className="button button-primary" disabled={busy || !dirty || requiresRead}>{operation === 'save' ? '正在保存…' : <><Check size={15} aria-hidden="true" />保存设置</>}</button>
            <button type="button" className="button button-secondary" disabled={busy || !dirty} onClick={() => setConfirmReset(true)}>放弃更改</button>
            <span className="settings-save-state">{dirty ? '有未保存更改 · 两个分类一起保存' : '当前设置已读取'}</span>
          </div>
          {confirmReset && <div className="settings-inline-confirmation" role="group" aria-label="确认放弃设置更改"><p>放弃两个分类中所有未保存的更改，恢复为最近读取的设置？</p><div className="settings-confirm-actions"><button type="button" className="button button-secondary" onClick={() => setConfirmReset(false)}>继续编辑</button><button type="button" className="button button-secondary" onClick={() => { replaceDraft(createDraft(snapshot.values)); dirtyRef.current = false; setConfirmReset(false); setShowErrors(false); if (!requiresRead) setNotice(null) }}>确认放弃更改</button></div></div>}
        </form>
        {section === 'queue' && <>
          <QueueStatus queue={snapshot.queue} stale={requiresRead || notice?.kind === 'error'} />
          <section className="settings-clear-section" aria-labelledby="settings-clear-heading">
            <div className="settings-clear-heading"><div><h3 id="settings-clear-heading">清空队列</h3><p>删除尚未完成交接的消息正文。若有正在投递的消息，后台会拒绝清空，请读取实际状态。</p></div><button ref={clearTrigger} type="button" className="text-button settings-clear-trigger" disabled={busy || requiresRead} aria-expanded={confirmClear} aria-controls="settings-clear-confirmation" onClick={() => { setConfirmClear(true); setClearAcknowledged(false) }}><Trash2 size={15} aria-hidden="true" />清空队列</button></div>
            {confirmClear && <div id="settings-clear-confirmation" className="settings-inline-confirmation" role="group" aria-label="确认清空队列">
              <p id="settings-clear-warning">将清除尚未投递及结果待核对的正文，不能恢复，不删除账号配置或发送账本</p>
              <label className="settings-confirm-checkbox"><input ref={clearCheckbox} type="checkbox" checked={clearAcknowledged} disabled={busy} aria-describedby="settings-clear-warning" onChange={event => setClearAcknowledged(event.target.checked)} /><span>我已了解，确认清除这些正文</span></label>
              <div className="settings-confirm-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setConfirmClear(false); setClearAcknowledged(false); clearTrigger.current?.focus() }}>取消</button><button type="button" className="button button-danger" disabled={busy || !clearAcknowledged || requiresRead} onClick={() => { void mutate('clear') }}>{operation === 'clear' ? '正在清空…' : '确认清空队列'}</button></div>
            </div>}
          </section>
        </>}
      </>}
    </main>
  </div>
}

function QueueStatus({ queue, stale }: { readonly queue: DeliveryQueueStats; readonly stale: boolean }) {
  const rows: readonly (readonly [string, string])[] = [
    ['待投递', `${formatCount(queue.pending)} 条`], ['正在投递', `${formatCount(queue.delivering)} 条`], ['结果待核对', `${formatCount(queue.uncertain)} 条`],
    ['队列消息总数', `${formatCount(queue.queuedMessages)} 条`], ['队列占用', `${formatCount(queue.queuedBytes)} 字节`],
    ['已可靠交接', `${formatCount(queue.accepted)} 条`], ['已拒绝入队', `${formatCount(queue.rejected)} 条`], ['已丢弃', `${formatCount(queue.discarded)} 条`],
    ['短期去重标识', `${formatCount(queue.dedupIdentifiers)} 个`], ['超出容量限制', queue.overCapacity ? '是' : '否'],
    ['当前存储方式', storageLabel(queue.storageMode)], ['最近队列错误', queue.lastQueueError ?? '无'],
  ]
  return <section className="settings-queue-status" aria-labelledby="settings-queue-heading">
    <div className="section-heading"><h3 id="settings-queue-heading">队列状态</h3><p>{stale ? '以下为最近一次读取的状态，可能已变化。请重新读取设置核对。' : '以下为最近一次读取的实际状态；点击“重新读取设置”更新。已可靠接收不代表模型已读。'}</p></div>
    <dl className="settings-stat-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}
