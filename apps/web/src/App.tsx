import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, BrainCircuit, Check, FileText, LayoutDashboard, Plus, Settings as SettingsIcon, Sprout, TriangleAlert, UserRound, X } from 'lucide-react'
import { useI18n } from '@eating/ui-sdk'
import './i18n/app'
import { Overview } from './pages/Overview'
import { Robots } from './pages/Robots'
import { Settings } from './pages/Settings'
import { PluginCatalog } from './components/PluginCatalog'
import { LanguageSelector } from './components/LanguageSelector'
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

const navigation = [
  { page: 'overview', href: '#overview', Icon: LayoutDashboard },
  { page: 'robots', href: '#robots', Icon: Bot },
  { page: 'harness', href: '#harness', Icon: BrainCircuit },
  { page: 'prompts', href: '#prompts/common', Icon: FileText },
  { page: 'personas', href: '#personas', Icon: UserRound },
  { page: 'settings', href: '#settings/delivery', Icon: SettingsIcon },
] as const

export function App({ workspace }: { readonly workspace: PlatformWorkspace }) {
  const { locale, t, formatNumber } = useI18n('app')
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
  useEffect(() => {
    document.title = t('app.title', { page: t(`nav.${route.page}`) })
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (description) description.content = t(`page.${route.page}.description`)
  }, [route.page, locale, t])
  useEffect(() => { setFeedback(null) }, [locale])
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 4200)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const navigate = useCallback((page: Page, id: string | null = null) => {
    window.location.hash = page === 'robots' || page === 'harness' ? `${page}${id ? `/${encodeURIComponent(id)}` : ''}` : page === 'settings' ? 'settings/delivery' : page === 'prompts' ? 'prompts/common' : page
    setCatalogOpen(false)
  }, [])
  const selectPlugin = useCallback((id: string | null) => navigate(route.page === 'harness' ? 'harness' : 'robots', id), [navigate, route.page])
  const pluginPage = route.page === 'overview' || route.page === 'robots' || route.page === 'harness'

  return <div className="app-shell">
    <a href="#main-content" className="skip-link" onClick={event => {
      event.preventDefault()
      const main = document.getElementById('main-content')
      if (main) { main.tabIndex = -1; main.focus() }
    }}>{t('app.skipContent')}</a>
    <aside className="global-sidebar" aria-label={t('app.globalNavigation')}>
      <a className="brand" href="#overview" aria-label={t('app.brandOverview')}><Sprout size={25} strokeWidth={1.7} /><span>Eating</span></a>
      <nav>
        {navigation.map(({ page, href, Icon }) => <a key={page} className={`global-nav-item ${route.page === page ? 'is-selected' : ''}`} href={href} aria-current={route.page === page ? 'page' : undefined}><Icon size={page === 'robots' || page === 'harness' ? 20 : 19} /><span>{t(`nav.${page}`)}</span></a>)}
      </nav>
      <LanguageSelector />
    </aside>
    <div className="app-main">
      <header className="page-header"><div><h1>{t(`nav.${route.page}`)}</h1><p>{t(`page.${route.page}.description`)}</p></div>
        {pluginPage && <button className="button button-secondary" onClick={() => setCatalogOpen(current => !current)} aria-expanded={catalogOpen}><Plus size={17} />{t('app.addPlugin')}</button>}
      </header>
      {snapshot.storageError && <div className="storage-alert" role="alert"><TriangleAlert size={19} /><p>{snapshot.storageError} <strong>{t('app.statusStale')}</strong></p></div>}
      {snapshot.unavailableIds.length > 0 && <div className="storage-alert"><TriangleAlert size={18} /><p>{t('app.unavailablePlugins', { count: snapshot.unavailableIds.length, total: formatNumber(snapshot.unavailableIds.length) })}</p></div>}
      {catalogOpen && pluginPage && <div className="catalog-container"><PluginCatalog workspace={workspace} snapshot={snapshot} onClose={() => setCatalogOpen(false)} onFeedback={setFeedback} onRegistered={plugin => { navigate(plugin.kind === 'harness' ? 'harness' : 'robots', plugin.id); setFeedback(t('app.pluginEnabled', { name: plugin.name })) }} /></div>}
      {route.page === 'prompts' || route.page === 'personas' ? <Suspense fallback={<main id="main-content" className="robot-content" role="status">{t('app.loadingEditor')}</main>}><Authoring key={route.page} mode={route.page} selectedId={route.documentId ?? null} onSelect={id => { window.location.hash = `${route.page}/${encodeURIComponent(id)}` }} onFeedback={setFeedback} /></Suspense> : route.page === 'settings' ? <Settings section={route.section} onSectionChange={section => { window.location.hash = `settings/${section}` }} onFeedback={setFeedback} /> : route.page === 'overview' ? <Overview snapshot={snapshot} onRobots={id => navigate('robots', id ?? null)} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} /> : <Robots key={route.page} kind={route.page === 'harness' ? 'harness' : 'communication'} workspace={workspace} snapshot={snapshot} selectedId={route.pluginId} onSelect={selectPlugin} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} onFeedback={setFeedback} />}
    </div>
    {feedback && <div className="toast" role="status"><Check size={18} /><span>{feedback}</span><button className="icon-button" onClick={() => setFeedback(null)} aria-label={t('app.closeFeedback')}><X size={15} /></button></div>}
  </div>
}
