import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, BrainCircuit, ChevronRight, Circle, Info, Layers, LoaderCircle, Plug, Plus, TriangleAlert } from 'lucide-react'
import { ActionButton, PluginLifecycleBar, useI18n } from '@eating/ui-sdk'
import { PlatformStatus } from '../components/PlatformStatus'
import type { ManagedPlugin } from '@eating/ui-sdk'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'
import { PanelBoundary } from '../components/PanelBoundary'
import '../i18n/app'

export function Robots({ kind, workspace, snapshot, selectedId, onSelect, onRegister, onFeedback, onDirtyChange, guardNavigation }: {
  readonly kind: ManagedPlugin['kind']
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
  readonly onRegister: () => void
  readonly onFeedback: (message: string) => void
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly guardNavigation?: (action: () => void) => void
}) {
  const { t, formatNumber } = useI18n('app')
  const plugins = snapshot.plugins.filter(plugin => plugin.kind === kind)
  const selected = plugins.find(plugin => plugin.id === selectedId)
  const directoryHeading = useRef<HTMLHeadingElement>(null)
  const focusDirectory = useRef(false)
  const stale = Boolean(snapshot.storageError)
  useEffect(() => {
    if (snapshot.ready && !stale && selectedId && !selected) onSelect(null)
    if (!selected && focusDirectory.current) {
      directoryHeading.current?.focus()
      focusDirectory.current = false
    }
  }, [selectedId, selected, onSelect, snapshot.ready, stale])

  function selectTarget(id: string | null) {
    if (id === (selected?.id ?? null)) return
    if (guardNavigation && selected) guardNavigation(() => onSelect(id))
    else onSelect(id)
  }

  return <div className="robot-workspace">
    <aside className="platform-sidebar" aria-label={t(`robots.sidebar.${kind}`)}>
      <p className="platform-nav-heading">{t(`robots.category.${kind}`)}<span>{formatNumber(plugins.length)}</span></p>
      <nav aria-label={t(`robots.navigation.${kind}`)}>
        <ActionButton reasonCode="busy" className={`platform-nav-item ${!selected ? 'is-selected' : ''}`} aria-current={!selected ? 'page' : undefined} onClick={() => selectTarget(null)}><Layers size={18} /><span>{t(`robots.all.${kind}`)}</span></ActionButton>
        <div className="platform-nav-divider" />
        {plugins.map(plugin => {
          const Icon = plugin.icon
          return <ActionButton reasonCode="busy" key={plugin.id} className={`platform-nav-item ${selected?.id === plugin.id ? 'is-selected' : ''}`} aria-current={selected?.id === plugin.id ? 'page' : undefined} onClick={() => selectTarget(plugin.id)}><Icon size={18} /><span>{plugin.name}</span>{selected?.id === plugin.id && <ChevronRight size={15} className="nav-chevron" />}</ActionButton>
        })}
      </nav>
    </aside>
    <main id="main-content" className="robot-content">
      {!snapshot.ready ? <p className="subtle" role="status">{t('robots.loading')}</p> : selected ? <PluginDetails key={selected.id} plugin={selected} snapshot={snapshot} workspace={workspace} onFeedback={onFeedback} onDirtyChange={onDirtyChange} onRemoved={() => { focusDirectory.current = true; onDirtyChange?.(false); onSelect(null) }} /> : <PlatformDirectory kind={kind} plugins={plugins} snapshot={snapshot} headingRef={directoryHeading} onSelect={onSelect} onRegister={onRegister} />}
    </main>
  </div>
}

function PluginStatus({ kind, status, stale }: { readonly kind: ManagedPlugin['kind']; readonly status: ConnectionStatus | undefined; readonly stale: boolean }) {
  const { t } = useI18n('app')
  if (kind === 'communication') return <PlatformStatus status={status} stale={stale} />
  const state = status?.state ?? 'unconfigured'
  const Icon = stale || state === 'error' ? TriangleAlert : state === 'connecting' || state === 'reconnecting' ? LoaderCircle : state === 'connected' ? BrainCircuit : Circle
  return <span className={`status-badge status-${stale ? 'warning' : state}`}><Icon size={12} />{t(stale ? 'status.stale' : `status.harness.${state}`)}</span>
}

function PlatformDirectory({ kind, plugins, snapshot, headingRef, onSelect, onRegister }: {
  readonly kind: ManagedPlugin['kind']
  readonly plugins: readonly ManagedPlugin[]
  readonly snapshot: WorkspaceSnapshot
  readonly headingRef: { readonly current: HTMLHeadingElement | null }
  readonly onSelect: (id: string | null) => void
  readonly onRegister: () => void
}) {
  const { t, formatNumber } = useI18n('app')
  const harness = kind === 'harness'
  const Icon = harness ? BrainCircuit : Plug
  return <section>
    <div className="panel-title-row"><h2 ref={headingRef} tabIndex={-1}>{t(`robots.all.${kind}`)}</h2><span className="count-label">{t('count.enabled', { count: plugins.length, total: formatNumber(plugins.length) })}</span></div>
    {harness && <p className="panel-description">{t('robots.description.harness')}</p>}
    {plugins.length === 0 ? <div className="empty-state directory-empty"><Icon size={32} /><h3>{t(`robots.emptyTitle.${kind}`)}</h3><p>{t(`robots.emptyDescription.${kind}`)}</p><ActionButton reasonCode="busy" className="button button-primary" onClick={onRegister}><Plus size={16} />{t(`robots.add.${kind}`)}</ActionButton></div> : <div className="directory-list">
      {plugins.map(plugin => {
        const PluginIcon = plugin.icon
        const saved = snapshot.configurations[plugin.id]
        return <div key={plugin.id} className="directory-row">
          <div className="platform-symbol" style={{ color: plugin.brandColor }}><PluginIcon size={26} /></div>
          <div className="directory-copy"><h3>{plugin.name}<span className="version-label">v{plugin.version}</span></h3><p>{plugin.description}</p><small>{saved ? t('robots.savedSummary', { summary: plugin.summary(saved.values) }) : t('robots.configurationNeeded')}</small></div>
          <div className="directory-actions"><PluginStatus kind={kind} status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /><ActionButton reasonCode="busy" className="button button-secondary" onClick={() => onSelect(plugin.id)} aria-label={t('robots.openConfiguration', { name: plugin.name })}>{t('robots.configure')}<ArrowRight size={15} /></ActionButton></div>
        </div>
      })}
      <ActionButton reasonCode="busy" className="register-row" onClick={onRegister}><Plus size={20} /><span>{t(`robots.add.${kind}`)}<small>{t('robots.enableInstalled')}</small></span><ArrowRight size={17} /></ActionButton>
    </div>}
    <div className="directory-footnote"><Info size={16} /><p>{t(harness ? 'robots.harnessHint' : 'robots.connectionHint')}</p></div>
  </section>
}

function PluginDetails({ plugin, snapshot, workspace, onFeedback, onDirtyChange, onRemoved }: {
  readonly plugin: ManagedPlugin
  readonly snapshot: WorkspaceSnapshot
  readonly workspace: PlatformWorkspace
  readonly onFeedback: (message: string) => void
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly onRemoved: () => void
}) {
  const { t } = useI18n('app')
  const [dirty, setDirty] = useState(false)
  const Panel = plugin.Panel
  const enabled = snapshot.plugins.some(entry => entry.id === plugin.id)
  const status = snapshot.statuses[plugin.id]

  const handleDirtyChange = useCallback((next: boolean) => {
    setDirty(next)
    onDirtyChange?.(next)
  }, [onDirtyChange])

  useEffect(() => {
    onDirtyChange?.(false)
    return () => { onDirtyChange?.(false) }
  }, [plugin.id, onDirtyChange])

  return <article className="plugin-details">
    <PluginLifecycleBar
      plugin={plugin}
      enabled={enabled}
      status={status}
      stale={Boolean(snapshot.storageError)}
      dirty={dirty}
      connectionBusy={snapshot.busyPluginId === plugin.id}
      subtitle={t(`robots.detailDescription.${plugin.kind}`)}
      updateHref="#plugins"
      onToggleEnabled={next => workspace.toggleEnabled(plugin.id, next)}
      onConnect={() => workspace.connect(plugin.id)}
      onDisconnect={() => workspace.disconnect(plugin.id)}
      onFeedback={onFeedback}
      onAfterDisable={onRemoved}
    />
    <PanelBoundary key={plugin.id}>
      <Panel
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
  </article>
}
