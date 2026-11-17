import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle, Package, Plus, Puzzle, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { ConnectionStatus, PluginKind } from '@eating/plugin-sdk'
import { ActionButton, PluginLifecycleBar, Switch, getErrorMessage, hostRequest, useI18n } from '@eating/ui-sdk'
import type { ManagedPlugin, WorkspaceActionResult } from '@eating/ui-sdk'
import { PanelBoundary } from '../components/PanelBoundary'
import { readPluginInstallPreview, readPluginPackages } from '../state/plugin-packages'
import type { PluginInstallPreview, PluginPackageInfo } from '../state/plugin-packages'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'
import '../i18n/app'
import './Plugins.css'

type Filter = 'all' | PluginKind
type StatusFilter = 'all' | 'connected' | 'unconfigured' | 'disabled'

const filterValues: readonly Filter[] = ['all', 'communication', 'harness', 'capability']

function statusText(kind: PluginKind, state: ConnectionStatus['state']): string {
  return `status.${kind}.${state}`
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function PluginsPage({ workspace, snapshot, selectedId, onFeedback, onDirtyChange, guardNavigation }: {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly selectedId: string | null
  readonly onFeedback: (message: string) => void
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly guardNavigation?: (action: () => void) => void
}) {
  const { t, formatNumber } = useI18n('app')
  function navigateHash(hash: string, targetId: string | null, event: React.MouseEvent<HTMLAnchorElement>) {
    if (selectedId === targetId) return
    if (!guardNavigation || !selectedId) return
    event.preventDefault()
    guardNavigation(() => { window.location.hash = hash })
  }
  return <div className="robot-workspace plugins-workspace"><aside className="platform-sidebar plugins-sidebar" aria-label={t('plugins.navigation')}><p className="platform-nav-heading">{t('plugins.navigation')}<span>{formatNumber(workspace.catalog.length)}</span></p><nav aria-label={t('plugins.navigation')}><a href="#plugins" className={`platform-nav-item${!selectedId ? ' is-selected' : ''}`} aria-current={!selectedId ? 'page' : undefined} onClick={event => navigateHash('plugins', null, event)}><Package size={17} aria-hidden="true" /><span>{t('plugins.manageAll')}</span></a><div className="platform-nav-divider" />{workspace.catalog.map(plugin => { const Icon = plugin.icon; return <a key={plugin.id} href={`#plugins/${encodeURIComponent(plugin.id)}`} className={`platform-nav-item${selectedId === plugin.id ? ' is-selected' : ''}`} aria-current={selectedId === plugin.id ? 'page' : undefined} onClick={event => navigateHash(`plugins/${encodeURIComponent(plugin.id)}`, plugin.id, event)}><Icon size={17} aria-hidden="true" /><span>{plugin.name}</span></a> })}</nav></aside>{selectedId
    ? <PluginPanelPage key={selectedId} workspace={workspace} snapshot={snapshot} pluginId={selectedId} onFeedback={onFeedback} onDirtyChange={onDirtyChange} />
    : <PluginDirectoryPage workspace={workspace} onFeedback={onFeedback} guardNavigation={guardNavigation} />}</div>
}

function PluginDirectoryPage({ workspace, onFeedback, guardNavigation }: {
  readonly workspace: PlatformWorkspace
  readonly onFeedback: (message: string) => void
  readonly guardNavigation?: (action: () => void) => void
}) {
  const { t, formatNumber } = useI18n('app')
  const [packages, setPackages] = useState<readonly PluginPackageInfo[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [uninstallId, setUninstallId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [installing, setInstalling] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const actionController = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const feedback = useRef(onFeedback)
  feedback.current = onFeedback

  async function refresh() {
    const ticket = ++generation.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    try {
      const value = readPluginPackages(await hostRequest<unknown>('/plugin-packages', { signal: controller.signal }))
      if (!mounted.current || controller.signal.aborted || ticket !== generation.current) return
      setPackages(value.plugins); setFailure(null)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && ticket === generation.current) setFailure(getErrorMessage(error, t('plugins.loadError')))
    } finally {
      if (mounted.current && ticket === generation.current) setLoading(false)
      if (readController.current === controller) readController.current = null
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const cancel = () => { readController.current?.abort(); readController.current = null; actionController.current?.abort(); actionController.current = null }
    window.addEventListener('pagehide', cancel)
    return () => { mounted.current = false; ++generation.current; cancel(); window.removeEventListener('pagehide', cancel) }
    // Load once; mutations refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function action(key: string, run: (signal: AbortSignal) => Promise<unknown>, success: string): Promise<boolean> {
    if (lock.current || !mounted.current) return false
    lock.current = true; setBusy(key); setFailure(null)
    const controller = new AbortController()
    actionController.current = controller
    try {
      await run(controller.signal)
      if (!mounted.current || controller.signal.aborted) return false
      await refresh()
      await workspace.refresh()
      if (!mounted.current) return false
      feedback.current(success)
      return true
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setFailure(getErrorMessage(error, t('plugins.loadError')))
      return false
    } finally {
      if (actionController.current === controller) actionController.current = null
      lock.current = false
      if (mounted.current) setBusy(null)
    }
  }

  async function setEnabled(plugin: PluginPackageInfo) {
    const ok = await action(`toggle-${plugin.id}`, signal => hostRequest(`/plugins/${encodeURIComponent(plugin.id)}/${plugin.enabled ? 'disable' : 'enable'}`, { method: 'POST', body: {}, signal }),
      t(plugin.enabled ? 'plugins.disabledFeedback' : 'plugins.enabledFeedback', { name: plugin.name }))
    if (ok) setUninstallId(null)
  }

  async function uninstall(plugin: PluginPackageInfo) {
    const ok = await action(`uninstall-${plugin.id}`, signal => hostRequest('/plugin-packages', { method: 'POST', signal,
      body: { operation: 'uninstall', input: { id: plugin.id, confirmed: true } } }), t('plugins.uninstalledFeedback', { name: plugin.name }))
    if (ok) setUninstallId(null)
  }

  function openInstall() {
    setInstallOpen(true); setPreview(null); setPreviewError(null); setSource('')
  }

  async function doPreview() {
    const directory = source.trim()
    if (!directory || previewing) return
    if (/^(https?:|npm:)/i.test(directory)) { setPreviewError(t('plugins.sourceInvalid')); return }
    setPreviewing(true); setPreview(null); setPreviewError(null)
    const controller = new AbortController(); actionController.current = controller
    try {
      const value = readPluginInstallPreview(await hostRequest<unknown>('/plugin-packages', { method: 'POST', signal: controller.signal,
        body: { operation: 'preview', input: { sourceDirectory: directory } } }))
      if (mounted.current && !controller.signal.aborted) setPreview(value)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setPreviewError(getErrorMessage(error, t('plugins.previewError')))
    } finally {
      if (actionController.current === controller) actionController.current = null
      if (mounted.current) setPreviewing(false)
    }
  }

  async function install() {
    if (!preview || installing) return
    setInstalling(true)
    const ok = await action('install', signal => hostRequest('/plugin-packages', { method: 'POST', signal,
      body: { operation: 'install', input: { planId: preview.planId, confirmed: true } } }), t('plugins.installedFeedback', { name: preview.manifest.name }))
    if (mounted.current) setInstalling(false)
    if (ok) { setInstallOpen(false); setPreview(null); setSource('') }
  }

  const catalog = new Map(workspace.catalog.map(plugin => [plugin.id, plugin]))
  const query = search.trim().toLowerCase()
  const visible = (packages ?? []).filter(plugin => {
    if (filter !== 'all' && plugin.kind !== filter) return false
    if (statusFilter === 'disabled' && plugin.enabled) return false
    if (statusFilter === 'unconfigured' && (!plugin.enabled || plugin.status.state !== 'unconfigured')) return false
    if (statusFilter === 'connected' && (!plugin.enabled || plugin.status.state !== 'connected')) return false
    if (query) {
      const text = `${plugin.name} ${plugin.id} ${plugin.description || catalog.get(plugin.id)?.description || ''}`.toLowerCase()
      if (!text.includes(query)) return false
    }
    return true
  })
  const hasFilters = filter !== 'all' || statusFilter !== 'all' || query !== ''
  const showInstall = installOpen
  void guardNavigation

  return <main id="main-content" className="robot-content plugins-page">
    <div className="plugins-toolbar workspace-rail">
      <div className="plugins-filter-row">
        <div className="plugins-filter" role="group" aria-label={t('plugins.filterLabel')}>
          {filterValues.map(value => <ActionButton reason={t('ui.reason.busy')} key={value} type="button" className={`plugins-filter-item${filter === value ? ' is-selected' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`plugins.filter.${value}`)}</ActionButton>)}
        </div>
        <label className="plugins-search-wrap">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={search} aria-label={t('plugins.searchLabel')} placeholder={t('plugins.searchPlaceholder')} onChange={event => setSearch(event.target.value)} />
        </label>
        <select className="plugins-status-select" aria-label={t('plugins.statusFilterLabel')} value={statusFilter} onChange={event => setStatusFilter(event.target.value as StatusFilter)}>
          <option value="all">{t('plugins.statusFilter.all')}</option>
          <option value="connected">{t('plugins.statusFilter.connected')}</option>
          <option value="unconfigured">{t('plugins.statusFilter.unconfigured')}</option>
          <option value="disabled">{t('plugins.statusFilter.disabled')}</option>
        </select>
      </div>
      <div className="plugins-toolbar-actions">
        <ActionButton reason={loading ? t('ui.reason.loading') : t('ui.reason.busy')} type="button" className="button button-secondary" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />{t(loading ? 'plugins.loading' : 'plugins.retry')}</ActionButton>
        <ActionButton reason={t('ui.reason.busy')} type="button" className="button button-primary" disabled={busy !== null} onClick={openInstall}><Plus size={16} aria-hidden="true" />{t('plugins.install')}</ActionButton>
      </div>
    </div>
    {failure && <div className="plugins-alert" role="alert"><AlertCircle size={17} aria-hidden="true" /><p>{failure}</p></div>}
    {showInstall && <section className="plugins-install" aria-labelledby="plugins-install-title">
      <div className="plugins-install-heading"><div><h2 id="plugins-install-title">{t('plugins.installTitle')}</h2></div><ActionButton reason={t('ui.reason.busy')} type="button" className="icon-button" aria-label={t('plugins.cancel')} onClick={() => setInstallOpen(false)}><X size={18} aria-hidden="true" /></ActionButton></div>
      <details className="plugins-install-details"><summary>{t('plugins.installNoteSummary')}</summary><p>{t('plugins.installDescription')}</p></details>
      <div className="field"><label htmlFor="plugins-source">{t('plugins.sourceDirectory')}</label><div className="plugins-source-row"><input id="plugins-source" value={source} maxLength={4096} autoComplete="off" spellCheck={false} placeholder={t('plugins.sourcePlaceholder')} onChange={event => { setSource(event.target.value); setPreview(null); setPreviewError(null) }} /><ActionButton reason={!source.trim() ? t('ui.reason.source') : t('ui.reason.busy')} type="button" className="button button-secondary" disabled={!source.trim() || previewing} onClick={() => void doPreview()}>{previewing ? t('plugins.previewing') : t('plugins.preview')}</ActionButton></div></div>
      {previewError && <p className="field-error" role="alert">{previewError}</p>}
      {preview && <div className="plugins-preview">
        <div className="plugins-preview-head"><Package size={18} aria-hidden="true" /><div><strong>{t('plugins.manifest', { name: preview.manifest.name, version: preview.manifest.version })}</strong><p><code>{preview.manifest.id}</code> · {t(`plugins.kind.${preview.manifest.kind}`)} · {t('plugins.apiVersion', { version: String(preview.manifest.apiVersion) })}</p></div></div>
        <p className="plugins-preview-description">{preview.manifest.description}</p>
        <dl className="plugins-preview-facts"><div><dt>{t('plugins.packageBytes')}</dt><dd>{formatBytes(preview.packageBytes)}</dd></div><div><dt>{t('plugins.digest')}</dt><dd><code>{preview.digest.slice(0, 24)}</code></dd></div></dl>
        <p className="plugins-warning">{t('plugins.installWarning')}</p>
        <div className="plugins-inline-actions"><ActionButton reason={t('ui.reason.busy')} type="button" className="button button-primary" disabled={installing || busy !== null} onClick={() => void install()}>{installing ? t('plugins.installing') : t('plugins.confirmInstall')}</ActionButton><ActionButton reason={t('ui.reason.busy')} type="button" className="button button-secondary" disabled={installing} onClick={() => setInstallOpen(false)}>{t('plugins.cancel')}</ActionButton></div>
      </div>}
    </section>}
    {loading && packages === null && <p className="plugins-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />{t('plugins.loading')}</p>}
    {packages && visible.length === 0 && <div className="empty-state plugins-empty"><Puzzle size={30} aria-hidden="true" /><h3>{t('plugins.emptyTitle')}</h3><p>{t('plugins.emptyDescription')}</p>{hasFilters && <button type="button" className="button button-secondary" onClick={() => { setFilter('all'); setStatusFilter('all'); setSearch('') }}>{t('plugins.clearFilters')}</button>}</div>}
    <div className="plugins-list" aria-busy={loading}>
      {visible.map(plugin => <PluginRow key={plugin.id} plugin={plugin} catalog={catalog.get(plugin.id)} busy={busy} confirming={uninstallId === plugin.id}
        onToggle={() => void setEnabled(plugin)} onUninstall={() => void uninstall(plugin)} onConfirm={() => setUninstallId(plugin.id)} onCancel={() => setUninstallId(null)}
        onUpdate={() => { setInstallOpen(true); setPreview(null); setPreviewError(null); setSource('') }} />)}
    </div>
    {packages && <p className="plugins-count">{t('plugins.count', { count: visible.length, value: formatNumber(visible.length) })}</p>}
  </main>
}

function PluginRow({ plugin, catalog, busy, confirming, onToggle, onUninstall, onConfirm, onCancel, onUpdate }: {
  readonly plugin: PluginPackageInfo
  readonly catalog: ManagedPlugin | undefined
  readonly busy: string | null
  readonly confirming: boolean
  readonly onToggle: () => void
  readonly onUninstall: () => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly onUpdate: () => void
}) {
  const { t } = useI18n('app')
  const Icon = catalog?.icon ?? Puzzle
  const toggling = busy === `toggle-${plugin.id}`
  const uninstalling = busy === `uninstall-${plugin.id}`
  const panelHref = plugin.frontend ? `#plugins/${encodeURIComponent(plugin.id)}` : null
  return <section className="plugins-row" aria-labelledby={`plugin-row-${plugin.id}`}>
    <div className="plugins-row-main">
      <div className="plugins-symbol" style={{ color: catalog?.brandColor ?? 'var(--color-icon-soft)' }}><Icon size={24} aria-hidden="true" /></div>
      <div className="plugins-copy"><h2 id={`plugin-row-${plugin.id}`}>{panelHref ? <a href={panelHref}>{plugin.name}</a> : plugin.name}<span className="version-label">v{plugin.version}</span></h2><p>{plugin.description || catalog?.description || t(`plugins.kind.${plugin.kind}`)}</p><p className="plugins-meta"><span>{t(`plugins.kind.${plugin.kind}`)}</span><span>{t(plugin.enabled ? 'plugins.enabled' : 'plugins.disabled')}</span></p></div>
      <span className={`status-badge plugins-status plugins-status-${plugin.status.state}`}>{t(statusText(plugin.kind, plugin.status.state))}</span>
    </div>
    <div className="plugins-actions">
      <Switch
        checked={plugin.enabled}
        compact
        disabled={busy !== null}
        disabledReason={t('ui.reason.busy')}
        aria-label={t(plugin.enabled ? 'plugins.disableLabel' : 'plugins.enableLabel', { name: plugin.name })}
        label={t(toggling ? (plugin.enabled ? 'plugins.disabling' : 'plugins.enabling') : (plugin.enabled ? 'plugins.enabled' : 'plugins.disabled'))}
        onChange={() => onToggle()}
      />
      {panelHref && <a className="button button-secondary" href={panelHref}>{t('plugins.openSettings')}</a>}
      <ActionButton reason={t('ui.reason.busy')} type="button" className="text-button" disabled={busy !== null} onClick={onUpdate}>{t('plugins.update')}</ActionButton>
      <ActionButton reason={t('ui.reason.busy')} type="button" className="text-button plugins-uninstall-trigger" disabled={busy !== null} onClick={onConfirm}><Trash2 size={14} aria-hidden="true" />{t('plugins.uninstall')}</ActionButton>
    </div>
    {confirming && <div className="plugins-confirm" role="alertdialog" aria-label={t('plugins.uninstallTitle', { name: plugin.name })}><div><strong>{t('plugins.uninstallTitle', { name: plugin.name })}</strong><p>{t('plugins.uninstallDescription')}</p></div><div className="plugins-inline-actions"><ActionButton reason={t('ui.reason.busy')} type="button" className="button button-secondary" disabled={uninstalling} onClick={onCancel}>{t('plugins.cancel')}</ActionButton><ActionButton reason={t('ui.reason.busy')} type="button" className="button button-danger" disabled={uninstalling || busy !== null} onClick={onUninstall}>{uninstalling ? t('plugins.uninstalling') : t('plugins.confirmUninstall')}</ActionButton></div></div>}
  </section>
}

function PluginPanelPage({ workspace, snapshot, pluginId, onFeedback, onDirtyChange }: {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly pluginId: string
  readonly onFeedback: (message: string) => void
  readonly onDirtyChange?: (dirty: boolean) => void
}) {
  const { t } = useI18n('app')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [installed, setInstalled] = useState<PluginPackageInfo | null>(null)
  const [loadingPackage, setLoadingPackage] = useState(true)
  const mounted = useRef(false)
  const plugin = workspace.catalog.find(entry => entry.id === pluginId)
  const fallbackStatus: ConnectionStatus | undefined = installed ? {
    state: installed.status.state,
    accountId: null,
    accountName: null,
    lastError: installed.status.lastError,
    connectedAt: null,
    lastEventAt: null,
    reconnectAttempt: 0,
  } : undefined
  const status = snapshot.statuses[pluginId] ?? fallbackStatus

  const handleDirtyChange = useCallback((next: boolean) => {
    setDirty(next)
    onDirtyChange?.(next)
  }, [onDirtyChange])

  useEffect(() => {
    mounted.current = true
    onDirtyChange?.(false)
    void hostRequest<unknown>('/plugin-packages').then(value => {
      const found = readPluginPackages(value).plugins.find(entry => entry.id === pluginId) ?? null
      if (mounted.current) setInstalled(found)
    }).catch(() => {}).finally(() => { if (mounted.current) setLoadingPackage(false) })
    return () => {
      mounted.current = false
      onDirtyChange?.(false)
    }
  }, [pluginId, onDirtyChange])

  async function uninstall(): Promise<WorkspaceActionResult> {
    if (busy || !plugin) return { ok: false, error: t('workspace.busyError') }
    setBusy(true)
    try {
      await hostRequest('/plugin-packages', { method: 'POST', body: { operation: 'uninstall', input: { id: plugin.id, confirmed: true } } })
      await workspace.refresh()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: getErrorMessage(error, t('plugins.loadError')) }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (snapshot.ready && !plugin && !loadingPackage) return <main id="main-content" className="robot-content plugins-page">
    <div className="empty-state plugins-empty"><Puzzle size={30} aria-hidden="true" /><h3>{t('plugins.panelMissing')}</h3><a className="button button-secondary" href="#plugins">{t('plugins.backToList')}</a></div>
  </main>
  if (!plugin) return <main id="main-content" className="robot-content plugins-page"><p className="plugins-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />{t('plugins.loading')}</p></main>

  const enabled = snapshot.ready ? snapshot.plugins.some(entry => entry.id === plugin.id) : installed?.enabled ?? false
  return <main id="main-content" className="robot-content plugins-page plugin-panel-page">
    <PluginLifecycleBar
      plugin={plugin}
      enabled={enabled}
      status={status}
      stale={Boolean(snapshot.storageError)}
      dirty={dirty}
      busy={busy}
      connectionBusy={snapshot.busyPluginId === plugin.id}
      subtitle={`${t(`plugins.kind.${plugin.kind}`)} · ${t('plugins.detailDescription')}`}
      updateHref="#plugins"
      onToggleEnabled={next => workspace.toggleEnabled(plugin.id, next)}
      onConnect={() => workspace.connect(plugin.id)}
      onDisconnect={() => workspace.disconnect(plugin.id)}
      onUninstall={uninstall}
      onFeedback={onFeedback}
      onAfterUninstall={() => {
        onDirtyChange?.(false)
        window.location.hash = 'plugins'
      }}
    />
    <PanelBoundary key={plugin.id}>
      <plugin.Panel
        enabled={enabled}
        saved={snapshot.configurations[plugin.id]}
        initialValues={plugin.initialValues}
        status={status}
        connectionBusy={snapshot.busyPluginId === plugin.id}
        onToggleEnabled={next => workspace.toggleEnabled(plugin.id, next)}
        onConnect={() => workspace.connect(plugin.id)}
        onDisconnect={() => workspace.disconnect(plugin.id)}
        onDirtyChange={handleDirtyChange}
        onSave={values => workspace.save(plugin.id, values)}
        onFeedback={onFeedback}
        onRefresh={() => workspace.refresh()}
      />
    </PanelBoundary>
  </main>
}
