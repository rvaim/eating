import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Bot, BrainCircuit, Cable, Check, FileText, LayoutDashboard, Plus, Puzzle, Settings as SettingsIcon, Sprout, TriangleAlert, UserRound, X } from 'lucide-react'
import { useI18n } from '@eating/ui-sdk'
import './i18n/app'
import { Overview } from './pages/Overview'
import { Robots } from './pages/Robots'
import { Settings } from './pages/Settings'
import { McpPage } from './pages/Mcp'
import { PluginsPage } from './pages/Plugins'
import { PluginCatalog } from './components/PluginCatalog'
import { LanguageSelector } from './components/LanguageSelector'
import type { PlatformWorkspace } from './state/workspace'

const Authoring = lazy(() => import('./pages/Authoring').then(module => ({ default: module.Authoring })))

type Page = 'overview' | 'robots' | 'harness' | 'mcp' | 'plugins' | 'settings' | 'prompts' | 'personas'
type Route = { readonly page: Page; readonly pluginId: string | null; readonly section: 'delivery' | 'queue' | 'autonomy' | 'images' | 'theme'; readonly documentId?: string | null }

function readRoute(): Route {
  const [page, id] = window.location.hash.slice(1).split('/')
  if (page === 'settings') return { page, pluginId: null, section: id === 'theme' ? 'theme' : id === 'images' ? 'images' : id === 'autonomy' ? 'autonomy' : id === 'queue' ? 'queue' : 'delivery' }
  if (page === 'prompts' || page === 'personas') {
    try { return { page, pluginId: null, section: 'delivery', documentId: id ? decodeURIComponent(id) : null } }
    catch { return { page, pluginId: null, section: 'delivery', documentId: null } }
  }
  if (page === 'mcp') return { page, pluginId: null, section: 'delivery' }
  if (page !== 'robots' && page !== 'harness' && page !== 'plugins') return { page: 'overview', pluginId: null, section: 'delivery' }
  try { return { page, pluginId: id ? decodeURIComponent(id) : null, section: 'delivery' } }
  catch { return { page: 'overview', pluginId: null, section: 'delivery' } }
}

const navigation = [
  { page: 'overview', href: '#overview', Icon: LayoutDashboard },
  { page: 'robots', href: '#robots', Icon: Bot },
  { page: 'harness', href: '#harness', Icon: BrainCircuit },
  { page: 'mcp', href: '#mcp', Icon: Cable },
  { page: 'plugins', href: '#plugins', Icon: Puzzle },
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
  const [panelDirty, setPanelDirty] = useState(false)
  const [pendingNav, setPendingNav] = useState<{ readonly run: () => void } | null>(null)
  const guardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void workspace.refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void workspace.refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [workspace])

  useEffect(() => {
    const update = () => {
      setRoute(readRoute())
      setCatalogOpen(false)
      setPanelDirty(false)
      setPendingNav(null)
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    if (!panelDirty) setPendingNav(null)
  }, [panelDirty])
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

  const guardNavigation = useCallback((action: () => void) => {
    if (!panelDirty) {
      action()
      return
    }
    setPendingNav({ run: action })
    requestAnimationFrame(() => guardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }, [panelDirty])

  const navigate = useCallback((page: Page, id: string | null = null) => {
    window.location.hash = page === 'robots' || page === 'harness' || page === 'plugins' ? `${page}${id ? `/${encodeURIComponent(id)}` : ''}` : page === 'settings' ? 'settings/delivery' : page === 'prompts' ? 'prompts/common' : page
    setCatalogOpen(false)
  }, [])
  const selectPlugin = useCallback((id: string | null) => navigate(route.page === 'harness' ? 'harness' : 'robots', id), [navigate, route.page])
  const pluginPage = route.page === 'overview' || route.page === 'robots' || route.page === 'harness'

  function guardAnchor(hrefHash: string, sameTarget: boolean, event: React.MouseEvent<HTMLAnchorElement>) {
    if (!panelDirty || sameTarget) return
    event.preventDefault()
    guardNavigation(() => { window.location.hash = hrefHash })
  }

  return <div className="app-shell">
    <a href="#main-content" className="skip-link" onClick={event => {
      event.preventDefault()
      const main = document.getElementById('main-content')
      if (main) { main.tabIndex = -1; main.focus() }
    }}>{t('app.skipContent')}</a>
    <aside className="global-sidebar" aria-label={t('app.globalNavigation')}>
      <a className="brand" href="#overview" aria-label={t('app.brandOverview')} onClick={event => guardAnchor('overview', route.page === 'overview', event)}><span className="brand-mark" aria-hidden="true"><Sprout size={16} strokeWidth={2} /></span><span className="brand-name">Eating</span></a>
      <nav>
        {navigation.map(({ page, href, Icon }) => <a key={page} className={`global-nav-item ${route.page === page ? 'is-selected' : ''}`} href={href} aria-current={route.page === page ? 'page' : undefined} onClick={event => guardAnchor(href.slice(1), route.page === page && !route.pluginId, event)}><Icon size={18} strokeWidth={1.65} /><span>{t(`nav.${page}`)}</span></a>)}
      </nav>
      <LanguageSelector />
    </aside>
    <div className="app-main">
      <header className="page-header"><div><h1>{t(`nav.${route.page}`)}</h1><p>{t(`page.${route.page}.description`)}</p></div>
        {route.page === 'plugins' && route.pluginId && <a className="button button-secondary plugins-page-back" href="#plugins" onClick={event => guardAnchor('plugins', false, event)}><ArrowLeft size={16} aria-hidden="true" />{t('plugins.backToList')}</a>}
        {pluginPage && <button className="button button-secondary" onClick={() => setCatalogOpen(current => !current)} aria-expanded={catalogOpen}><Plus size={17} />{t('app.quickEnable')}</button>}
      </header>
      {snapshot.storageError && <div className="storage-alert" role="alert"><TriangleAlert size={19} /><p>{snapshot.storageError} <strong>{t('app.statusStale')}</strong></p></div>}
      {snapshot.unavailableIds.length > 0 && <div className="storage-alert"><TriangleAlert size={18} /><p>{t('app.unavailablePlugins', { count: snapshot.unavailableIds.length, total: formatNumber(snapshot.unavailableIds.length) })}</p></div>}
      {pendingNav && panelDirty && (
        <div ref={guardRef} className="host-dirty-guard" role="alertdialog" aria-labelledby="host-dirty-guard-title">
          <div className="host-dirty-guard-copy">
            <TriangleAlert size={18} aria-hidden="true" />
            <div>
              <strong id="host-dirty-guard-title">{t('app.dirtyGuardTitle')}</strong>
              <span> · {t('app.dirtyGuardBody')}</span>
            </div>
          </div>
          <div className="host-dirty-guard-actions">
            <button type="button" className="button button-secondary" onClick={() => setPendingNav(null)}>{t('app.dirtyGuardStay')}</button>
            <button type="button" className="button button-danger" onClick={() => {
              const next = pendingNav
              setPendingNav(null)
              setPanelDirty(false)
              next.run()
            }}>{t('app.dirtyGuardLeave')}</button>
          </div>
        </div>
      )}
      {catalogOpen && pluginPage && <div className="catalog-container"><PluginCatalog workspace={workspace} snapshot={snapshot} onClose={() => setCatalogOpen(false)} onFeedback={setFeedback} onRegistered={plugin => { guardNavigation(() => navigate(plugin.kind === 'harness' ? 'harness' : plugin.kind === 'capability' ? 'plugins' : 'robots', plugin.id)); setFeedback(t('app.pluginEnabled', { name: plugin.name })) }} /></div>}
      {route.page === 'prompts' || route.page === 'personas' ? <Suspense fallback={<main id="main-content" className="robot-content" role="status">{t('app.loadingEditor')}</main>}><Authoring key={route.page} mode={route.page} selectedId={route.documentId ?? null} pluginDisplayNames={Object.fromEntries(workspace.catalog.map(plugin => [plugin.id, plugin.name]))} onSelect={id => { window.location.hash = `${route.page}/${encodeURIComponent(id)}` }} onFeedback={setFeedback} /></Suspense> : route.page === 'settings' ? <Settings section={route.section} onSectionChange={section => { window.location.hash = `settings/${section}` }} onFeedback={setFeedback} /> : route.page === 'overview' ? <Overview snapshot={snapshot} onRobots={id => navigate('robots', id ?? null)} onPlugin={id => navigate('plugins', id)} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} /> : route.page === 'mcp' ? <McpPage onFeedback={setFeedback} /> : route.page === 'plugins' ? <PluginsPage workspace={workspace} snapshot={snapshot} selectedId={route.pluginId} onFeedback={setFeedback} onDirtyChange={setPanelDirty} guardNavigation={guardNavigation} /> : <Robots key={route.page} kind={route.page === 'harness' ? 'harness' : 'communication'} workspace={workspace} snapshot={snapshot} selectedId={route.pluginId} onSelect={selectPlugin} onRegister={() => { setCatalogOpen(true); window.scrollTo({ top: 0, behavior: 'instant' }) }} onFeedback={setFeedback} onDirtyChange={setPanelDirty} guardNavigation={guardNavigation} />}
    </div>
    {feedback && <div className="toast" role="status"><Check size={18} /><span>{feedback}</span><button className="icon-button" onClick={() => setFeedback(null)} aria-label={t('app.closeFeedback')}><X size={15} /></button></div>}
  </div>
}
