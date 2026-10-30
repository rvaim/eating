import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, LoaderCircle, Package, Plus, Puzzle, RefreshCw, Trash2, X } from 'lucide-react'
import type { ConnectionStatus, PluginKind } from '@eating/plugin-sdk'
import { getErrorMessage, hostRequest, useI18n } from '@eating/ui-sdk'
import type { ManagedPlugin } from '@eating/ui-sdk'
import { PanelBoundary } from '../components/PanelBoundary'
import { readPluginInstallPreview, readPluginPackages } from '../state/plugin-packages'
import type { PluginInstallPreview, PluginPackageInfo } from '../state/plugin-packages'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'
import '../i18n/app'
import './Plugins.css'

type Filter = 'all' | PluginKind

const filterValues: readonly Filter[] = ['all', 'communication', 'harness', 'capability']

function statusText(kind: PluginKind, state: ConnectionStatus['state']): string {
  return `status.${kind}.${state}`
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function PluginsPage({ workspace, snapshot, selectedId, onFeedback }: {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly selectedId: string | null
  readonly onFeedback: (message: string) => void
}) {
  return selectedId
    ? <PluginPanelPage workspace={workspace} snapshot={snapshot} pluginId={selectedId} onFeedback={onFeedback} />
    : <PluginDirectoryPage workspace={workspace} onFeedback={onFeedback} />
}

function PluginDirectoryPage({ workspace, onFeedback }: {
  readonly workspace: PlatformWorkspace
  readonly onFeedback: (message: string) => void
}) {
  const { t, formatNumber } = useI18n('app')
  const [packages, setPackages] = useState<readonly PluginPackageInfo[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
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

  const visible = (packages ?? []).filter(plugin => filter === 'all' || plugin.kind === filter)
  const catalog = new Map(workspace.catalog.map(plugin => [plugin.id, plugin]))
  const showInstall = installOpen

  return <main id="main-content" className="robot-content plugins-page">
    <div className="plugins-toolbar">
      <div className="plugins-filter" role="group" aria-label={t('plugins.filterLabel')}>
        {filterValues.map(value => <button key={value} type="button" className={`plugins-filter-item${filter === value ? ' is-selected' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`plugins.filter.${value}`)}</button>)}
      </div>
      <div className="plugins-toolbar-actions">
        <button type="button" className="button button-secondary" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />{t(loading ? 'plugins.loading' : 'plugins.retry')}</button>
        <button type="button" className="button button-primary" disabled={busy !== null} onClick={openInstall}><Plus size={16} aria-hidden="true" />{t('plugins.install')}</button>
      </div>
    </div>
    {failure && <div className="plugins-alert" role="alert"><AlertCircle size={17} aria-hidden="true" /><p>{failure}</p></div>}
    {showInstall && <section className="plugins-install" aria-labelledby="plugins-install-title">
      <div className="plugins-install-heading"><div><h2 id="plugins-install-title">{t('plugins.installTitle')}</h2><p>{t('plugins.installDescription')}</p></div><button type="button" className="icon-button" aria-label={t('plugins.cancel')} onClick={() => setInstallOpen(false)}><X size={18} aria-hidden="true" /></button></div>
      <div className="field"><label htmlFor="plugins-source">{t('plugins.sourceDirectory')}</label><div className="plugins-source-row"><input id="plugins-source" value={source} maxLength={4096} autoComplete="off" spellCheck={false} placeholder={t('plugins.sourcePlaceholder')} onChange={event => { setSource(event.target.value); setPreview(null); setPreviewError(null) }} /><button type="button" className="button button-secondary" disabled={!source.trim() || previewing} onClick={() => void doPreview()}>{previewing ? t('plugins.previewing') : t('plugins.preview')}</button></div></div>
      {previewError && <p className="field-error" role="alert">{previewError}</p>}
      {preview && <div className="plugins-preview">
        <div className="plugins-preview-head"><Package size={18} aria-hidden="true" /><div><strong>{t('plugins.manifest', { name: preview.manifest.name, version: preview.manifest.version })}</strong><p><code>{preview.manifest.id}</code> · {t(`plugins.kind.${preview.manifest.kind}`)} · {t('plugins.apiVersion', { version: String(preview.manifest.apiVersion) })}</p></div></div>
        <p className="plugins-preview-description">{preview.manifest.description}</p>
        <dl className="plugins-preview-facts"><div><dt>{t('plugins.packageBytes')}</dt><dd>{formatBytes(preview.packageBytes)}</dd></div><div><dt>{t('plugins.digest')}</dt><dd><code>{preview.digest.slice(0, 24)}</code></dd></div></dl>
        <p className="plugins-warning">{t('plugins.installWarning')}</p>
        <div className="plugins-inline-actions"><button type="button" className="button button-primary" disabled={installing || busy !== null} onClick={() => void install()}>{installing ? t('plugins.installing') : t('plugins.confirmInstall')}</button><button type="button" className="button button-secondary" disabled={installing} onClick={() => setInstallOpen(false)}>{t('plugins.cancel')}</button></div>
      </div>}
    </section>}
    {loading && packages === null && <p className="plugins-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />{t('plugins.loading')}</p>}
    {packages && visible.length === 0 && <div className="empty-state plugins-empty"><Puzzle size={30} aria-hidden="true" /><h3>{t('plugins.emptyTitle')}</h3><p>{t('plugins.emptyDescription')}</p></div>}
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
  const business = plugin.kind === 'communication' ? `#robots/${encodeURIComponent(plugin.id)}` : plugin.kind === 'harness' ? `#harness/${encodeURIComponent(plugin.id)}` : null
  return <section className="plugins-row" aria-labelledby={`plugin-row-${plugin.id}`}>
    <div className="plugins-row-main">
      <div className="plugins-symbol" style={{ color: catalog?.brandColor ?? 'var(--color-icon-soft)' }}><Icon size={24} aria-hidden="true" /></div>
      <div className="plugins-copy"><h2 id={`plugin-row-${plugin.id}`}>{plugin.name}<span className="version-label">v{plugin.version}</span></h2><p>{plugin.description || catalog?.description || t(`plugins.kind.${plugin.kind}`)}</p><p className="plugins-meta"><span>{t(`plugins.kind.${plugin.kind}`)}</span><span>{plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}</span></p></div>
      <span className={`status-badge plugins-status plugins-status-${plugin.status.state}`}>{t(statusText(plugin.kind, plugin.status.state))}</span>
    </div>
    <div className="plugins-actions">
      <button type="button" className="button button-secondary" disabled={busy !== null} onClick={onToggle}>{toggling ? (plugin.enabled ? t('plugins.disabling') : t('plugins.enabling')) : (plugin.enabled ? t('plugins.disable') : t('plugins.enable'))}</button>
      {plugin.frontend && <a className="button button-secondary" href={`#plugins/${encodeURIComponent(plugin.id)}`}>{t('plugins.openPanel')}</a>}
      {business && <a className="text-button" href={business}>{t('plugins.businessConfiguration')}<ArrowRight size={14} aria-hidden="true" /></a>}
      <button type="button" className="text-button" disabled={busy !== null} onClick={onUpdate}>{t('plugins.update')}</button>
      <button type="button" className="text-button plugins-uninstall-trigger" disabled={busy !== null} onClick={onConfirm}><Trash2 size={14} aria-hidden="true" />{t('plugins.uninstall')}</button>
    </div>
    {confirming && <div className="plugins-confirm" role="alertdialog" aria-label={t('plugins.uninstallTitle', { name: plugin.name })}><div><strong>{t('plugins.uninstallTitle', { name: plugin.name })}</strong><p>{t('plugins.uninstallDescription')}</p></div><div className="plugins-inline-actions"><button type="button" className="button button-secondary" disabled={uninstalling} onClick={onCancel}>{t('plugins.cancel')}</button><button type="button" className="button button-danger" disabled={uninstalling || busy !== null} onClick={onUninstall}>{uninstalling ? t('plugins.uninstalling') : t('plugins.confirmUninstall')}</button></div></div>}
  </section>
}

function PluginPanelPage({ workspace, snapshot, pluginId, onFeedback }: {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly pluginId: string
  readonly onFeedback: (message: string) => void
}) {
  const { t } = useI18n('app')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [installed, setInstalled] = useState<PluginPackageInfo | null>(null)
  const [loadingPackage, setLoadingPackage] = useState(true)
  const mounted = useRef(false)
  const plugin = workspace.catalog.find(entry => entry.id === pluginId)
  const status = snapshot.statuses[pluginId]

  useEffect(() => {
    mounted.current = true
    void hostRequest<unknown>('/plugin-packages').then(value => {
      const found = readPluginPackages(value).plugins.find(entry => entry.id === pluginId) ?? null
      if (mounted.current) setInstalled(found)
    }).catch(() => {}).finally(() => { if (mounted.current) setLoadingPackage(false) })
    return () => { mounted.current = false }
  }, [pluginId])

  async function toggle(enabled: boolean) {
    if (busy || !plugin) return
    setBusy(true); setFailure(null)
    try {
      await hostRequest(`/plugins/${encodeURIComponent(plugin.id)}/${enabled ? 'disable' : 'enable'}`, { method: 'POST', body: {} })
      await workspace.refresh()
      onFeedback(t(enabled ? 'plugins.disabledFeedback' : 'plugins.enabledFeedback', { name: plugin.name }))
    } catch (error) { if (mounted.current) setFailure(getErrorMessage(error, t('plugins.loadError'))) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function uninstall() {
    if (busy || !plugin) return
    setBusy(true); setFailure(null)
    try {
      await hostRequest('/plugin-packages', { method: 'POST', body: { operation: 'uninstall', input: { id: plugin.id, confirmed: true } } })
      await workspace.refresh()
      onFeedback(t('plugins.uninstalledFeedback', { name: plugin.name }))
      window.location.hash = 'plugins'
    } catch (error) { if (mounted.current) setFailure(getErrorMessage(error, t('plugins.loadError'))) }
    finally { if (mounted.current) setBusy(false) }
  }

  if (snapshot.ready && !plugin && !loadingPackage) return <main id="main-content" className="robot-content plugins-page">
    <div className="empty-state plugins-empty"><Puzzle size={30} aria-hidden="true" /><h3>{t('plugins.panelMissing')}</h3><a className="button button-secondary" href="#plugins">{t('plugins.backToList')}</a></div>
  </main>
  if (!plugin) return <main id="main-content" className="robot-content plugins-page"><p className="plugins-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />{t('plugins.loading')}</p></main>

  const Icon = plugin.icon
  const state = installed?.status.state ?? status?.state ?? 'unconfigured'
  const enabled = installed?.enabled ?? snapshot.plugins.some(entry => entry.id === plugin.id)
  const business = plugin.kind === 'communication' ? `#robots/${encodeURIComponent(plugin.id)}` : plugin.kind === 'harness' ? `#harness/${encodeURIComponent(plugin.id)}` : null
  return <main id="main-content" className="robot-content plugins-page plugin-panel-page">
    <div className="plugins-panel-head">
      <div className="plugins-panel-title"><div className="plugins-symbol" style={{ color: plugin.brandColor }}><Icon size={24} aria-hidden="true" /></div><div><h2>{plugin.name}<span className="version-label">v{plugin.version}</span></h2><p>{t(`plugins.kind.${plugin.kind}`)} · {t('plugins.detailDescription')}</p></div></div>
      <div className="plugins-panel-actions"><span className={`status-badge plugins-status plugins-status-${state}`}>{t(statusText(plugin.kind, state))}</span><a className="text-button" href="#plugins"><ArrowLeft size={14} aria-hidden="true" />{t('plugins.backToList')}</a></div>
    </div>
    {failure && <div className="plugins-alert" role="alert"><AlertCircle size={17} aria-hidden="true" /><p>{failure}</p></div>}
    <PanelBoundary key={plugin.id}><plugin.Panel saved={snapshot.configurations[plugin.id]} initialValues={plugin.initialValues} onSave={values => workspace.save(plugin.id, values)} onFeedback={onFeedback} onRefresh={() => workspace.refresh()} /></PanelBoundary>
    <section className="plugins-panel-footer" aria-label={t('plugins.panelActions')}>
      <div className="plugins-panel-actions">
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void toggle(enabled)}>{busy ? t('plugins.busy') : t(enabled ? 'plugins.disable' : 'plugins.enable')}</button>
        {business && <a className="text-button" href={business}>{t('plugins.businessConfiguration')}<ArrowRight size={14} aria-hidden="true" /></a>}
        {!confirming && <button type="button" className="text-button plugins-uninstall-trigger" disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={14} aria-hidden="true" />{t('plugins.uninstall')}</button>}
      </div>
      {confirming && <div className="plugins-confirm" role="alertdialog" aria-label={t('plugins.uninstallTitle', { name: plugin.name })}><div><strong>{t('plugins.uninstallTitle', { name: plugin.name })}</strong><p>{t('plugins.uninstallDescription')}</p></div><div className="plugins-inline-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirming(false)}>{t('plugins.cancel')}</button><button type="button" className="button button-danger" disabled={busy} onClick={() => void uninstall()}>{busy ? t('plugins.uninstalling') : t('plugins.confirmUninstall')}</button></div></div>}
    </section>
  </main>
}
