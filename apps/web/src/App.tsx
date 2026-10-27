import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, BrainCircuit, Check, CircleUserRound, FileText, LayoutDashboard, Plus, Settings as SettingsIcon, Sprout, TriangleAlert, UserRound, X } from 'lucide-react'
import { Overview } from './pages/Overview'
import { Robots } from './pages/Robots'
import { Settings } from './pages/Settings'
import { PluginCatalog } from './components/PluginCatalog'
import type { PlatformWorkspace } from './state/workspace'

const Authoring = lazy(() => import('./pages/Authoring').then(module => ({ default: module.Authoring })))

type Page = 'overview' | 'robots' | 'harness' | 'settings' | 'prompts' | 'personas'
type Route = { readonly page: Page; readonly pluginId: string | null; readonly section: 'delivery' | 'queue'; readonly documentId?: string | null }

function readRoute(): Route {
  const [page, id] = window.location.hash.slice(1).split('/')
  if (page === 'settings') return { page, pluginId: null, section: id === 'queue' ? 'queue' : 'delivery' }
  if (page === 'prompts' || page === 'personas') {
    try { return { page, pluginId: null, section: 'delivery', documentId: id ? decodeURIComponent(id) : null } }
    catch { return { page, pluginId: null, section: 'delivery', documentId: null } }
  }
  if (page !== 'robots' && page !== 'harness') return { page: 'overview', pluginId: null, section: 'delivery' }
  try { return { page, pluginId: id ? decodeURIComponent(id) : null, section: 'delivery' } }
  catch { return { page, pluginId: null, section: 'delivery' } }
}

const pageCopy = {
  overview: { title: '概览', description: '看看 Eating 的工作区，准备下一次连接。' },
  robots: { title: '机器人', description: '管理通讯平台，以及各插件提供的配置。' },
  harness: { title: 'Harness', description: '管理认知运行时、模型配置与主会话状态。' },
  prompts: { title: '提示词管理', description: '编写主 Agent、群聊与私聊提示词，插入可用变量。' },
  personas: { title: '人格管理', description: '保存多个人格配置，每次只启用一个。' },
  settings: { title: '设置', description: '配置消息投递、待投递队列与存储方式。' },
} as const

export function App({ workspace }: { readonly workspace: PlatformWorkspace }) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const [route, setRoute] = useState<Route>(readRoute)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    void workspace.refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void workspace.refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [workspace])

  useEffect(() => {
    const update = () => { setRoute(readRoute()); setCatalogOpen(false) }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => { document.title = `Eating · ${pageCopy[route.page].title}` }, [route.page])
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 4200)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const navigate = useCallback((page: Page, id: string | null = null) => {
    window.location.hash = page === 'robots' || page === 'harness' ? `${page}${id ? `/${encodeURIComponent(id)}` : ''}` : page === 'settings' ? 'settings/delivery' : page === 'prompts' ? 'prompts/main' : page
    setCatalogOpen(false)
  }, [])
  const selectPlugin = useCallback((id: string | null) => navigate(route.page === 'harness' ? 'harness' : 'robots', id), [navigate, route.page])
  const pluginPage = route.page === 'overview' || route.page === 'robots' || route.page === 'harness'

  return <div className="app-shell">
    <a href="#main-content" className="skip-link" onClick={event => {
      event.preventDefault()
      const main = document.getElementById('main-content')
      if (main) { main.tabIndex = -1; main.focus() }
    }}>跳到主要内容</a>
    <aside className="global-sidebar" aria-label="全局导航">
      <a className="brand" href="#overview" aria-label="Eating 概览"><Sprout size={25} strokeWidth={1.7} /><span>Eating</span></a>
      <nav>
        <a className={`global-nav-item ${route.page === 'overview' ? 'is-selected' : ''}`} href="#overview" aria-current={route.page === 'overview' ? 'page' : undefined}><LayoutDashboard size={19} /><span>概览</span></a>
        <a className={`global-nav-item ${route.page === 'robots' ? 'is-selected' : ''}`} href="#robots" aria-current={route.page === 'robots' ? 'page' : undefined}><Bot size={20} /><span>机器人</span></a>
        <a className={`global-nav-item ${route.page === 'harness' ? 'is-selected' : ''}`} href="#harness" aria-current={route.page === 'harness' ? 'page' : undefined}><BrainCircuit size={20} /><span>Harness</span></a>
        <a className={`global-nav-item ${route.page === 'prompts' ? 'is-selected' : ''}`} href="#prompts/main" aria-current={route.page === 'prompts' ? 'page' : undefined}><FileText size={19} /><span>提示词管理</span></a>
        <a className={`global-nav-item ${route.page === 'personas' ? 'is-selected' : ''}`} href="#personas" aria-current={route.page === 'personas' ? 'page' : undefined}><UserRound size={19} /><span>人格管理</span></a>
        <a className={`global-nav-item ${route.page === 'settings' ? 'is-selected' : ''}`} href="#settings/delivery" aria-current={route.page === 'settings' ? 'page' : undefined}><SettingsIcon size={19} /><span>设置</span></a>
      </nav>
      <div className="global-sidebar-footer"><CircleUserRound size={22} /><div><strong>我的工作区</strong><span>Eating <span className="version-label">0.5</span></span></div></div>
    </aside>
    <div className="app-main">
      <header className="page-header"><div><h1>{pageCopy[route.page].title}</h1><p>{pageCopy[route.page].description}</p></div>
        {pluginPage && <button className="button button-secondary" onClick={() => setCatalogOpen(current => !current)} aria-expanded={catalogOpen}><Plus size={17} />注册插件</button>}
      </header>
      {snapshot.storageError && <div className="storage-alert" role="alert"><TriangleAlert size={19} /><p>{snapshot.storageError} <strong>最近状态可能已过期，请检查后台服务。</strong></p></div>}
      {snapshot.unavailableIds.length > 0 && <div className="storage-alert"><TriangleAlert size={18} /><p>有 {snapshot.unavailableIds.length} 个历史插件不在此版本中，它们的配置已保留。</p></div>}
      {catalogOpen && pluginPage && <div className="catalog-container"><PluginCatalog workspace={workspace} snapshot={snapshot} onClose={() => setCatalogOpen(false)} onFeedback={setFeedback} onRegistered={plugin => { navigate(plugin.kind === 'harness' ? 'harness' : 'robots', plugin.id); setFeedback(`${plugin.name} 已注册`) }} /></div>}
      {route.page === 'prompts' || route.page === 'personas' ? <Suspense fallback={<main id="main-content" className="robot-content" role="status">正在加载编辑器…</main>}><Authoring key={route.page} mode={route.page} selectedId={route.documentId ?? null} onSelect={id => { window.location.hash = `${route.page}/${encodeURIComponent(id)}` }} onFeedback={setFeedback} /></Suspense> : route.page === 'settings' ? <Settings section={route.section} onSectionChange={section => { window.location.hash = `settings/${section}` }} onFeedback={setFeedback} /> : route.page === 'overview' ? <Overview snapshot={snapshot} onRobots={id => navigate('robots', id ?? null)} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} /> : <Robots key={route.page} kind={route.page === 'harness' ? 'harness' : 'communication'} workspace={workspace} snapshot={snapshot} selectedId={route.pluginId} onSelect={selectPlugin} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} onFeedback={setFeedback} />}
    </div>
    {feedback && <div className="toast" role="status"><Check size={18} /><span>{feedback}</span><button className="icon-button" onClick={() => setFeedback(null)} aria-label="关闭提示"><X size={15} /></button></div>}
  </div>
}
