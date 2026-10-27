import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, Check, CircleUserRound, LayoutDashboard, Plus, Settings as SettingsIcon, Sprout, TriangleAlert, X } from 'lucide-react'
import { Overview } from './pages/Overview'
import { Robots } from './pages/Robots'
import { Settings } from './pages/Settings'
import { PluginCatalog } from './components/PluginCatalog'
import type { PlatformWorkspace } from './state/workspace'

type Route = { readonly page: 'overview' | 'robots' | 'settings'; readonly pluginId: string | null; readonly section: 'delivery' | 'queue' }

function readRoute(): Route {
  const [page, id] = window.location.hash.slice(1).split('/')
  if (page === 'settings') return { page: 'settings', pluginId: null, section: id === 'queue' ? 'queue' : 'delivery' }
  if (page !== 'robots') return { page: 'overview', pluginId: null, section: 'delivery' }
  try { return { page: 'robots', pluginId: id ? decodeURIComponent(id) : null, section: 'delivery' } }
  catch { return { page: 'robots', pluginId: null, section: 'delivery' } }
}

const pageCopy = {
  overview: { title: '概览', description: '看看 Eating 的工作区，准备下一次连接。' },
  robots: { title: '机器人', description: '管理通讯平台，以及各插件提供的配置。' },
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

  const navigate = useCallback((page: Route['page'], pluginId: string | null = null) => {
    window.location.hash = page === 'robots' ? `robots${pluginId ? `/${encodeURIComponent(pluginId)}` : ''}` : page === 'settings' ? 'settings/delivery' : 'overview'
    setCatalogOpen(false)
  }, [])
  const selectPlugin = useCallback((id: string | null) => navigate('robots', id), [navigate])

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
        <a className={`global-nav-item ${route.page === 'settings' ? 'is-selected' : ''}`} href="#settings/delivery" aria-current={route.page === 'settings' ? 'page' : undefined}><SettingsIcon size={19} /><span>设置</span></a>
      </nav>
      <div className="global-sidebar-footer"><CircleUserRound size={22} /><div><strong>我的工作区</strong><span>Eating <span className="version-label">0.3</span></span></div></div>
    </aside>
    <div className="app-main">
      <header className="page-header"><div><h1>{pageCopy[route.page].title}</h1><p>{pageCopy[route.page].description}</p></div>
        {route.page !== 'settings' && <button className="button button-secondary" onClick={() => setCatalogOpen(current => !current)} aria-expanded={catalogOpen}><Plus size={17} />注册插件</button>}
      </header>
      {snapshot.storageError && <div className="storage-alert" role="alert"><TriangleAlert size={19} /><p>{snapshot.storageError} <strong>最近状态可能已过期，请检查后台服务。</strong></p></div>}
      {snapshot.unavailableIds.length > 0 && <div className="storage-alert"><TriangleAlert size={18} /><p>有 {snapshot.unavailableIds.length} 个历史插件不在此版本中，它们的配置已保留。</p></div>}
      {catalogOpen && route.page !== 'settings' && <div className="catalog-container"><PluginCatalog workspace={workspace} snapshot={snapshot} onClose={() => setCatalogOpen(false)} onFeedback={setFeedback} onRegistered={plugin => { navigate('robots', plugin.id); setFeedback(`${plugin.name} 已注册`) }} /></div>}
      {route.page === 'settings' ? <Settings section={route.section} onSectionChange={section => { window.location.hash = `settings/${section}` }} onFeedback={setFeedback} /> : route.page === 'overview' ? <Overview snapshot={snapshot} onRobots={id => navigate('robots', id ?? null)} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} /> : <Robots workspace={workspace} snapshot={snapshot} selectedId={route.pluginId} onSelect={selectPlugin} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} onFeedback={setFeedback} />}
    </div>
    {feedback && <div className="toast" role="status"><Check size={18} /><span>{feedback}</span><button className="icon-button" onClick={() => setFeedback(null)} aria-label="关闭提示"><X size={15} /></button></div>}
  </div>
}
