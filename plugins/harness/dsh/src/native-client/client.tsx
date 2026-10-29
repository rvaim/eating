import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { displayValue, object, platformEnvelope, textBlocks, toolOutcome } from './projection'
import type { ObjectValue } from './projection'

const zh = { title: 'Eating 原生会话', navigation: '打开会话列表', close: '关闭会话列表', readOnly: '只读会话页', readOnlyHelp: '在 Eating 管理运行与权限；此页只查看现有会话。', refresh: '刷新会话', loading: '正在读取原生会话…', empty: '尚无可读取的会话。', failed: '读取失败，请刷新重试。', main: '主 Agent', output: '模型输出', platform: '平台消息', sender: '发送者', account: '接收账号', private: '私聊对象', group: '群号', task: '主 Agent 委派', relay: 'Agent 内部消息', report: '子 Agent 回报', settled: '框架完成通知', clock: '运行时时间', system: '系统上下文', context: '运行时上下文', user: '原生用户消息', tool: '工具记录', arguments: '调用参数', result: '真实回执', succeeded: '工具执行成功', failedOutcome: '执行失败', unknown: '结果待确认', notSent: '未发送', running: '执行中', details: '查看详情', image: '会话图片', imageFailed: '图片读取失败', noQQReceipt: '模型文本不代表已发送 QQ', sourceSession: '来源会话', state: '状态', actions: '外部动作回执' }
const en: Record<keyof typeof zh, string> = { title: 'Eating native sessions', navigation: 'Open session list', close: 'Close session list', readOnly: 'Read-only sessions', readOnlyHelp: 'Manage runtime and permissions in Eating. This page reads existing sessions.', refresh: 'Refresh sessions', loading: 'Reading native sessions…', empty: 'No readable sessions yet.', failed: 'Read failed. Refresh to retry.', main: 'Main Agent', output: 'Model output', platform: 'Platform message', sender: 'Sender', account: 'Receiving account', private: 'Private target', group: 'Group', task: 'Main Agent delegation', relay: 'Internal Agent message', report: 'Child Agent report', settled: 'Framework completion notice', clock: 'Runtime time', system: 'System context', context: 'Runtime context', user: 'Native user message', tool: 'Tool record', arguments: 'Arguments', result: 'Recorded result', succeeded: 'Tool execution succeeded', failedOutcome: 'Execution failed', unknown: 'Outcome unknown', notSent: 'Not sent', running: 'Running', details: 'Details', image: 'Session image', imageFailed: 'Image unavailable', noQQReceipt: 'Model text is not a QQ delivery receipt', sourceSession: 'Source session', state: 'State', actions: 'External action receipts' }
type Key = keyof typeof zh
type Translator = (key: Key) => string
interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Summary { id: string; displayTitle: string; parentId?: string; running: boolean; projectionValues?: ObjectValue }
interface List { ids: string[]; byId: Record<string, Summary>; phase: string }
interface Props { t: Translator; collapsed?: boolean; node?: { kind: string; data: ObjectValue }; sessionId?: string; loadImage?: (reference: ObjectValue) => Promise<string>; useSessions?: <T>(selector: (value: List) => T) => T; select?: (id: string) => void; refresh?: () => void }
interface ClientContext {
  slots: { register(options: ObjectValue, component: ComponentType<Props>): () => void; inject(name: string, callback: () => (() => void) | Iterable<() => void>): () => void }
  locale: { register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void }
  sessions: { list: Observable<List>; refresh(): Promise<void>; subagentAddress(id: string): unknown }
  uiWorkspace: { openSession(target: unknown): void }
  on(name: string, callback: () => void): () => void
  effect(callback: () => (() => void) | void): unknown
}
declare global { interface Window { __EATING_NATIVE_WEB__?: { rootSessionId: string; readOnly: true; agentLabels?: Record<string, string> } } }
const rootId = () => window.__EATING_NATIVE_WEB__?.rootSessionId ?? ''
const instanceTitle = (row: Summary | undefined): string | undefined => {
  if (!row) return undefined
  const native = row.projectionValues?.subagent
  return window.__EATING_NATIVE_WEB__?.agentLabels?.[row.id] ?? (object(native) && typeof native.label === 'string' ? native.label : row.displayTitle)
}
export const name = 'eating-native-web'
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'uiConversation']

function time(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString(document.documentElement.lang || 'zh-CN') : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(document.documentElement.lang || 'zh-CN') : '' }
function body(content: unknown): string { return textBlocks(content) }
function pretty(value: unknown): string { return JSON.stringify(displayValue(value), null, 2) ?? '' }
function ReadOnly(props: Props) { return <div className="eating-native-readonly"><strong>{props.t('readOnly')}</strong><span>{props.t('readOnlyHelp')}</span></div> }
function Sidebar(props: Props) {
  const list = props.useSessions!(value => value), [expanded, setExpanded] = useState(false)
  const collapsed = props.collapsed === true
  useEffect(() => { if (!expanded) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }; document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close) }, [expanded])
  const navigation = <div className="eating-native-nav"><header><strong>{props.t('title')}</strong>{collapsed && <button type="button" onClick={() => setExpanded(false)}>{props.t('close')}</button>}<button type="button" onClick={props.refresh}>{props.t('refresh')}</button></header><p>{props.t('readOnly')}</p><div className="eating-native-session-list">{list.ids.map(id => list.byId[id]).filter((row): row is Summary => Boolean(row)).map(row => <button type="button" key={row.id} onClick={() => { props.select?.(row.id); setExpanded(false) }} className={row.parentId ? 'eating-native-child' : ''}><span>{row.id === rootId() ? props.t('main') : instanceTitle(row)}</span><small>{row.running ? props.t('running') : row.id}</small></button>)}{list.ids.length === 0 && <p role="status">{props.t(list.phase === 'ready' ? 'empty' : 'loading')}</p>}</div></div>
  return <nav className={collapsed ? 'eating-native-rail' : 'eating-native-sidebar'} aria-label={props.t('title')}>{collapsed ? <><button type="button" className="eating-native-menu" aria-label={props.t('navigation')} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>{expanded && <div className="eating-native-drawer">{navigation}</div>}</> : navigation}</nav>
}
function Image(props: { reference: ObjectValue; loadImage?: Props['loadImage']; t: Translator }) {
  const [url, setUrl] = useState<string>(), [failed, setFailed] = useState(false)
  useEffect(() => { let active = true; setUrl(undefined); setFailed(false); if (props.loadImage) void props.loadImage(props.reference).then(value => { if (active) setUrl(value) }, () => { if (active) setFailed(true) }); return () => { active = false } }, [props.reference, props.loadImage])
  return url ? <a href={url} target="_blank" rel="noreferrer"><img className="eating-native-image" src={url} alt={props.t('image')} /></a> : <span role="status">{props.t(failed ? 'imageFailed' : 'loading')}</span>
}
function Images(props: { content: unknown; loadImage?: Props['loadImage']; t: Translator }) {
  const refs = Array.isArray(props.content) ? props.content.filter(object).filter(block => block.type === 'image' && object(block.attachment)).map(block => block.attachment as ObjectValue) : []
  return <>{refs.map((reference, index) => <Image key={String(reference.id ?? index)} reference={reference} loadImage={props.loadImage} t={props.t} />)}</>
}
function Message(props: Props) {
  const data = props.node?.data ?? {}, source = object(data.source) ? data.source : {}, t = props.t
  const envelope = platformEnvelope(source, data.content, props.sessionId ?? '', rootId())
  if (envelope) return <div className="eating-native-exchange">{envelope.task && <details className="eating-native-context"><summary>{t('task')}</summary><p>{envelope.task}</p></details>}{envelope.events.map((event, index) => <article className="eating-native-platform" key={String(event.eventId ?? index)}><header><strong>{String(event.platform)} · {t('platform')}</strong><time>{time(event.receivedAt)}</time></header><dl><div><dt>{t('sender')}</dt><dd>{String(event.senderId)}</dd></div><div><dt>{t('account')}</dt><dd>{String(event.accountId)}</dd></div><div><dt>{t(object(event.source) && event.source.kind === 'group' ? 'group' : 'private')}</dt><dd>{String(event.targetId)}</dd></div></dl><p>{typeof event.text === 'string' ? event.text : pretty(event.content)}</p></article>)}</div>
  const kind = String(source.kind ?? ''), sender = typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined
  const label: Key = kind === 'time-context' ? 'clock' : kind === 'subagent-settled' ? 'settled' : kind === 'agent-message' ? sender === rootId() ? 'task' : 'report' : kind === 'user' ? 'user' : 'context'
  return <details className="eating-native-context"><summary>{t(label)}<time>{time(data.time)}</time></summary>{sender && <p>{t('sourceSession')}: {sender}</p>}<p>{body(data.content)}</p><Images content={data.content} loadImage={props.loadImage} t={t} /></details>
}
function Assistant(props: Props) {
  const data = props.node?.data ?? {}, blocks = Array.isArray(data.blocks) ? data.blocks.filter(object) : []
  const rows = props.useSessions?.(value => value.byId), label = props.sessionId === rootId() ? props.t('main') : instanceTitle(rows?.[props.sessionId ?? '']) ?? props.sessionId
  const text = blocks.filter(block => block.kind === 'text').map(block => typeof block.text === 'string' ? block.text : '').join('')
  const images = blocks.filter(block => block.kind === 'image' && object(block.attachment)).map(block => ({ type: 'image', attachment: block.attachment }))
  if (!text && !images.length) return null
  return <article className="eating-native-assistant"><header><strong>{label} · {props.t('output')}</strong><time>{time(data.time)}</time></header><p>{text}</p><Images content={images} loadImage={props.loadImage} t={props.t} /><small>{props.t('noQQReceipt')}</small></article>
}
function Tool(props: Props) {
  const root = props.node?.data.root, t = props.t
  if (!object(root)) return null
  const outcome = toolOutcome(root), key: Key = outcome === 'failed' ? 'failedOutcome' : outcome === 'not-sent' ? 'notSent' : outcome
  let parsed: unknown; try { parsed = JSON.parse(body(root.content)) } catch { parsed = undefined }
  return <details className="eating-native-tool"><summary><strong>{root.name === 'eating_delegate_task' ? t('task') : t('tool')} · {String(root.name || root.callId || '')}</strong><span data-outcome={outcome}>{t(key)}</span></summary><p>{t('arguments')}</p><pre>{typeof root.argsRaw === 'string' ? root.argsRaw : pretty(root.call)}</pre><p>{t('result')}</p>{object(parsed) && typeof parsed.summary === 'string' ? <><strong>{t('report')}</strong><p>{parsed.summary}</p><p>{t('actions')}</p><pre>{pretty(parsed.actions)}</pre></> : <pre>{parsed === undefined ? body(root.content) : pretty(parsed)}</pre>}<Images content={root.content} loadImage={props.loadImage} t={t} /></details>
}
function System(props: Props) { return <details className="eating-native-context"><summary>{props.t('system')}</summary><p>{typeof props.node?.data.text === 'string' ? props.node.data.text : ''}</p></details> }
function HeaderLabel(props: Props) {
  const rows = props.useSessions!(value => value.byId)
  return <strong className="eating-native-header-label">{props.sessionId === rootId() ? props.t('main') : instanceTitle(rows[props.sessionId ?? ''])}</strong>
}
function Empty() { return null }

const styles = `
.eating-native-header-label{font-size:14px;font-weight:600;overflow-wrap:anywhere;color:#20372a}.eating-native-sidebar{height:100%;min-height:0}.eating-native-rail{height:100%;background:#f7faf8}.eating-native-menu{display:grid;place-items:center;width:44px;height:44px;margin:8px 6px;color:#315d41;border:1px solid transparent;border-radius:6px;background:transparent;cursor:pointer}.eating-native-menu:focus-visible{outline:2px solid #34784d;outline-offset:1px}.eating-native-drawer{position:fixed;inset:0 auto 0 0;width:min(300px,85vw);z-index:100;border-right:1px solid #d7e4dc;box-shadow:8px 0 24px #20372a20}.eating-native-nav{height:100%;min-height:0;display:flex;flex-direction:column;padding:20px 12px;background:#f7faf8;color:#20372a;font:14px/1.55 system-ui,sans-serif}.eating-native-nav header{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center}.eating-native-nav header strong{font-size:16px}.eating-native-nav p{color:#51665a;font-size:12px}.eating-native-nav button{min-height:44px;text-align:left;color:inherit;cursor:pointer;background:none;border:1px solid transparent;border-radius:6px;padding:10px}.eating-native-nav button:hover{background:#e4f0e8}.eating-native-nav button:focus-visible,.eating-native-tool summary:focus-visible,.eating-native-context summary:focus-visible{outline:2px solid #34784d;outline-offset:2px}.eating-native-session-list{overflow:auto;min-height:0;scrollbar-color:#8eae9a #f7faf8}.eating-native-session-list button{display:flex;flex-direction:column;width:100%;overflow-wrap:anywhere}.eating-native-session-list small{font-size:11px;color:#51665a;overflow-wrap:anywhere}.eating-native-child{padding-inline-start:24px!important}.eating-native-readonly{display:flex;flex-wrap:wrap;gap:4px 12px;padding:14px 20px;border:1px solid #d7e4dc;border-radius:7px;color:#315d41;background:#f7faf8;font:12px/1.6 system-ui,sans-serif}.eating-native-platform,.eating-native-assistant{padding:18px 0;color:#20372a;max-width:75ch}.eating-native-platform header,.eating-native-assistant header{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 14px}.eating-native-platform strong,.eating-native-assistant strong{font-size:13px}.eating-native-platform time,.eating-native-assistant time,.eating-native-context time{font-size:11px;color:#52695b;font-variant-numeric:tabular-nums}.eating-native-platform p,.eating-native-assistant p,.eating-native-context p{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 system-ui,sans-serif;margin:10px 0}.eating-native-platform dl{display:flex;flex-wrap:wrap;gap:4px 18px;margin:8px 0;font-size:12px}.eating-native-platform dl div{display:flex;gap:7px}.eating-native-platform dt{color:#52695b}.eating-native-platform dd{margin:0}.eating-native-assistant small{font-size:11px;color:#52695b}.eating-native-context,.eating-native-tool{margin:10px 0;padding:12px 14px;border:1px solid #d7e4dc;border-radius:6px;color:#304d3b;background:#f9fbfa;max-width:75ch}.eating-native-context summary,.eating-native-tool summary{cursor:pointer;font-size:12px}.eating-native-context time{margin-inline-start:12px}.eating-native-tool summary span{margin-inline-start:12px}.eating-native-tool [data-outcome=failed]{color:#a13d35}.eating-native-tool [data-outcome=unknown]{color:#865c19}.eating-native-tool pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32rem;overflow:auto;font-size:12px}.eating-native-image{max-width:min(100%,520px);max-height:420px;object-fit:contain;margin:10px 0;border-radius:6px}.eating-native-exchange::selection,.eating-native-assistant::selection{background:#cbe6d5;color:#183b25}
@media(max-width:600px){.eating-native-nav{padding:14px 8px}.eating-native-readonly{padding:12px}.eating-native-platform,.eating-native-assistant{padding:14px 0}.eating-native-platform dl{gap:4px 12px}}
`
export function apply(ctx: ClientContext): void {
  ctx.locale.register('eating-native-web', { zh, en })
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
  ctx.on('dispose', () => style.remove())
  const register = (slot: string, component: ComponentType<Props>, extra: ObjectValue = {}) => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, priority: -100, locale: 'eating-native-web', ...extra }, component))
  register('sidebar', Sidebar, { inject: () => ({ select: (id: string) => ctx.uiWorkspace.openSession(ctx.sessions.subagentAddress(id) ?? id), refresh: () => { void ctx.sessions.refresh() } }) })
  register('conversation.composer.bar', ReadOnly)
  for (const key of ['user', 'steering', 'context', 'turn-trigger']) register('conversation.chat.node', Message, { key })
  register('conversation.chat.node', Assistant, { key: 'assistant-step' })
  register('conversation.chat.node', Tool, { key: 'tool-call' })
  register('conversation.chat.node', System, { key: 'system-prompt' })
  register('conversation.chat.reasoning.body', Empty)
  register('conversation.session.header.lineage', HeaderLabel)
  register('shell.leading', Empty)
  let selected = false
  const openRoot = () => { if (selected || !ctx.sessions.list.getSnapshot().byId[rootId()]) return; selected = true; ctx.uiWorkspace.openSession(rootId()) }
  const release = ctx.sessions.list.subscribe(openRoot); ctx.on('dispose', release)
  openRoot()
  void ctx.sessions.refresh().then(openRoot)
}
