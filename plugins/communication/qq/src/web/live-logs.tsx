import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { HostApiError, subscribePluginLogs } from '@eating/ui-sdk'
import type { PluginLogEntry } from '@eating/plugin-sdk'
import './live-logs.css'

interface LiveLogsProps { active: boolean; enabled: boolean; available: boolean }
type LogStreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
interface LogFailure { message: string; code: string }

const retentionOptions = [50, 100, 200, 500, 1000] as const
const streamLabels: Record<LogStreamState, string> = {
  connecting: '正在连接日志流', connected: '实时接收中', reconnecting: '连接中断，正在重连', closed: '已停止',
}
const levelLabels: Record<PluginLogEntry['level'], string> = { info: '信息', warn: '警告', error: '错误' }
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

function trimEntries(buffer: Map<string, PluginLogEntry>, limit: number) {
  while (buffer.size > limit) {
    const oldest = buffer.keys().next().value
    if (oldest === undefined) break
    buffer.delete(oldest)
  }
}
function failureFrom(error: unknown): LogFailure {
  if (error instanceof HostApiError) return { message: error.message, code: error.code }
  return { message: error instanceof Error ? error.message : '无法订阅日志，请检查 Eating Host 后重新打开此页签。', code: 'LOG_SUBSCRIPTION_FAILED' }
}
function metadataValue(entry: PluginLogEntry, key: string): string | null {
  const value = entry.metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}
function timeLabel(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.valueOf()) ? timestamp : timeFormatter.format(date)
}

const LogRow = memo(function LogRow({ entry }: { entry: PluginLogEntry }) {
  const kind = metadataValue(entry, 'kind')
  const admission = metadataValue(entry, 'queueAdmission')
  const identifiers: [string, string | null][] = [
    ['投递', admission === 'queued' ? '已进入待投递队列' : admission === 'rejected' ? '队列未接纳' : admission === 'not-forwarded' ? '未转交' : null],
    ['发送者', metadataValue(entry, 'senderId')],
    ['群号', kind === 'group' ? metadataValue(entry, 'groupId') : null],
    ['会话', metadataValue(entry, 'conversationId')],
    ['消息 ID', metadataValue(entry, 'messageId')],
    ['账号', metadataValue(entry, 'accountId')],
    ['实例', metadataValue(entry, 'instanceId')],
  ]
  return <li className="qq-live-log-row">
    <div className="qq-live-log-heading">
      <time dateTime={entry.timestamp} title={entry.timestamp}>{timeLabel(entry.timestamp)}</time>
      <span className="qq-live-log-level" data-level={entry.level}>{levelLabels[entry.level]}</span>
      <strong>{entry.event === 'message.received' ? '收到消息' : entry.event}</strong>
      {(kind === 'private' || kind === 'group') && <span>{kind === 'group' ? '群聊' : '私聊'}</span>}
    </div>
    <dl className="qq-live-log-identifiers">{identifiers.map(([label, value]) => value !== null && <div key={label}><dt>{label}</dt><dd><bdi>{value}</bdi></dd></div>)}</dl>
    <p className="qq-live-log-message">{entry.message}</p>
  </li>
})

export function LiveLogs({ active, enabled, available }: LiveLogsProps) {
  const prefix = useId()
  const [entries, setEntries] = useState<PluginLogEntry[]>([])
  const [limit, setLimit] = useState<number>(100)
  const [streamState, setStreamState] = useState<LogStreamState>('closed')
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden)
  const [failure, setFailure] = useState<LogFailure | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const buffer = useRef(new Map<string, PluginLogEntry>())
  const limitRef = useRef(100)
  const generation = useRef(0)
  const frame = useRef<number | null>(null)
  const announcementTimer = useRef<number | null>(null)
  const pendingAnnouncements = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)

  const clearDisplay = useCallback((updateDisplay = true) => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    if (announcementTimer.current !== null) window.clearTimeout(announcementTimer.current)
    frame.current = null
    announcementTimer.current = null
    pendingAnnouncements.current = 0
    buffer.current.clear()
    followLatest.current = true
    if (updateDisplay) { setEntries([]); setAnnouncement('') }
  }, [])

  useLayoutEffect(() => {
    let disposed = false
    let pageHidden = false
    let running = false
    let received = 0
    let cleanup: (() => void) | null = null

    function stop() {
      running = false
      ++generation.current
      const cancel = cleanup
      cleanup = null
      cancel?.()
      received = 0
      clearDisplay(!disposed)
      if (!disposed) { setStreamState('closed'); setFailure(null) }
    }
    function start() {
      if (disposed || running || !active || !enabled || !available || document.hidden || pageHidden) return
      running = true
      const current = ++generation.current
      const isCurrent = () => !disposed && running && current === generation.current && active && enabled && available && !document.hidden && !pageHidden
      setStreamState('connecting')
      setFailure(null)
      try {
        const unsubscribe = subscribePluginLogs('qq', {
          onEntry(entry) {
            if (!isCurrent() || buffer.current.has(entry.id)) return
            buffer.current.set(entry.id, entry)
            trimEntries(buffer.current, limitRef.current)
            ++received
            ++pendingAnnouncements.current
            if (frame.current === null) frame.current = window.requestAnimationFrame(() => {
              if (!isCurrent()) return
              frame.current = null
              setEntries(Array.from(buffer.current.values()))
            })
            if (announcementTimer.current === null) announcementTimer.current = window.setTimeout(() => {
              if (!isCurrent()) return
              announcementTimer.current = null
              const count = pendingAnnouncements.current
              pendingAnnouncements.current = 0
              setAnnouncement(`新增 ${count} 条日志，本次共接收 ${received} 条。`)
            }, 1000)
          },
          onState(state) { if (isCurrent()) setStreamState(state) },
          onError(error) { if (isCurrent()) setFailure(failureFrom(error)) },
        })
        if (isCurrent()) cleanup = unsubscribe
        else unsubscribe()
      } catch (error) {
        if (isCurrent()) { setStreamState('closed'); setFailure(failureFrom(error)) }
      }
    }
    function synchronize() {
      if (disposed) return
      const pageVisible = !document.hidden && !pageHidden
      setVisible(pageVisible)
      if (active && enabled && available && pageVisible) start()
      else stop()
    }
    function onPageHide() { pageHidden = true; synchronize() }
    function onPageShow() { pageHidden = false; synchronize() }

    document.addEventListener('visibilitychange', synchronize)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    synchronize()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', synchronize)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      stop()
    }
  }, [active, enabled, available, clearDisplay])

  useLayoutEffect(() => {
    if (followLatest.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [entries])

  function changeLimit(value: string) {
    const next = Number(value)
    if (!retentionOptions.some(option => option === next)) return
    limitRef.current = next
    setLimit(next)
    trimEntries(buffer.current, next)
    setEntries(Array.from(buffer.current.values()))
  }

  const listening = active && enabled && available && visible
  const displayedState = listening ? streamState : 'closed'
  const stoppedReason = !enabled ? 'QQ 插件未启用' : !available ? '当前插件未提供实时日志' : !visible ? '页面不可见' : ''
  const waiting = listening && streamState !== 'closed'

  return <div className="qq-live-logs" hidden={!active} aria-labelledby={`${prefix}-heading`}>
    <div className="section-heading"><h3 id={`${prefix}-heading`}>实时日志</h3><p id={`${prefix}-notice`}>仅在此页签打开且页面可见时显示新消息。离开即停止并清空；日志不保存到磁盘。</p></div>
    <div className="qq-live-logs-toolbar">
      <div className="field qq-live-logs-limit"><label htmlFor={`${prefix}-limit`}>保留条数</label><select id={`${prefix}-limit`} value={limit} aria-describedby={`${prefix}-limit-hint`} onChange={event => changeLimit(event.target.value)}>{retentionOptions.map(value => <option key={value} value={value}>{value} 条</option>)}</select></div>
      <button className="button button-secondary" type="button" disabled={entries.length === 0} onClick={() => clearDisplay()}>清空显示</button>
    </div>
    <p className="qq-help" id={`${prefix}-limit-hint`}>仅保留页面内存中的最新日志，增加条数不补历史。“清空显示”后继续监听，不影响消息接收与待投递队列。</p>
    <div className="qq-live-logs-status">
      <p role="status" aria-live="polite" aria-atomic="true"><span>日志通道：</span><strong data-state={displayedState}>{streamLabels[displayedState]}</strong>{stoppedReason && <span> · {stoppedReason}</span>}</p>
      <span className="qq-live-logs-count">当前 {entries.length} / {limit} 条</span>
    </div>
    {failure && <div className="qq-error" role="alert"><div><p>最近一次日志通道错误：{failure.message}</p><small>错误代码：{failure.code}。若未恢复，可离开后重新打开此页签重试。</small></div></div>}
    <div className="qq-live-logs-scroller" ref={scroller} role="log" aria-label="QQ 实时日志" aria-describedby={`${prefix}-notice`} aria-live="off" aria-relevant="additions" aria-atomic="false" tabIndex={entries.length > 0 ? 0 : -1} onScroll={event => {
      const element = event.currentTarget
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    }}>
      {entries.length > 0 ? <ol className="qq-live-logs-list">{entries.map(entry => <LogRow key={entry.id} entry={entry} />)}</ol> : <div className="qq-empty qq-live-logs-empty"><strong>{waiting ? '等待新消息' : '日志接收已停止'}</strong><p>{waiting ? '使用另一个 QQ 给机器人发消息或群发测试。' : !enabled ? '启用 QQ 插件后，在此页签保持页面可见即可监听。' : !available ? '当前插件未提供实时日志能力。' : '重新打开此页签并保持页面可见后，从新消息开始显示。'}</p></div>}
    </div>
    <p className="qq-live-logs-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
  </div>
}
