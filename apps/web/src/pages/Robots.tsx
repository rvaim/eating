import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BrainCircuit, Check, ChevronRight, Circle, Info, Layers, LoaderCircle, Plug, Plus, Power, TriangleAlert } from 'lucide-react'
import { useI18n } from '@eating/ui-sdk'
import { PlatformStatus } from '../components/PlatformStatus'
import type { ManagedPlugin, WorkspaceActionResult } from '@eating/ui-sdk'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'
import { PanelBoundary } from '../components/PanelBoundary'
import '../i18n/app'

export function Robots({ kind, workspace, snapshot, selectedId, onSelect, onRegister, onFeedback }: {
  readonly kind: ManagedPlugin['kind']
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
  readonly onRegister: () => void
  readonly onFeedback: (message: string) => void
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

  return <div className="robot-workspace">
    <aside className="platform-sidebar" aria-label={t(`robots.sidebar.${kind}`)}>
      <p className="platform-nav-heading">{t(`robots.category.${kind}`)}<span>{formatNumber(plugins.length)}</span></p>
      <nav aria-label={t(`robots.navigation.${kind}`)}>
        <button className={`platform-nav-item ${!selected ? 'is-selected' : ''}`} aria-current={!selected ? 'page' : undefined} onClick={() => onSelect(null)}><Layers size={18} /><span>{t(`robots.all.${kind}`)}</span></button>
        <div className="platform-nav-divider" />
        {plugins.map(plugin => {
          const Icon = plugin.icon
          return <button key={plugin.id} className={`platform-nav-item ${selected?.id === plugin.id ? 'is-selected' : ''}`} aria-current={selected?.id === plugin.id ? 'page' : undefined} onClick={() => onSelect(plugin.id)}><Icon size={18} /><span>{plugin.name}</span>{selected?.id === plugin.id && <ChevronRight size={15} className="nav-chevron" />}</button>
        })}
      </nav>
    </aside>
    <main id="main-content" className="robot-content">
      {!snapshot.ready ? <p className="subtle" role="status">{t('robots.loading')}</p> : selected ? <PluginDetails key={selected.id} plugin={selected} snapshot={snapshot} workspace={workspace} onFeedback={onFeedback} onRemoved={() => { focusDirectory.current = true; onSelect(null) }} /> : <PlatformDirectory kind={kind} plugins={plugins} snapshot={snapshot} headingRef={directoryHeading} onSelect={onSelect} onRegister={onRegister} />}
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
    {plugins.length === 0 ? <div className="empty-state directory-empty"><Icon size={32} /><h3>{t(`robots.emptyTitle.${kind}`)}</h3><p>{t(`robots.emptyDescription.${kind}`)}</p><button className="button button-primary" onClick={onRegister}><Plus size={16} />{t(`robots.add.${kind}`)}</button></div> : <div className="directory-list">
      {plugins.map(plugin => {
        const PluginIcon = plugin.icon
        const saved = snapshot.configurations[plugin.id]
        return <div key={plugin.id} className="directory-row">
          <div className="platform-symbol" style={{ color: plugin.brandColor }}><PluginIcon size={26} /></div>
          <div className="directory-copy"><h3>{plugin.name}<span className="version-label">v{plugin.version}</span></h3><p>{plugin.description}</p><small>{saved ? t('robots.savedSummary', { summary: plugin.summary(saved.values) }) : t('robots.configurationNeeded')}</small></div>
          <div className="directory-actions"><PluginStatus kind={kind} status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /><button className="button button-secondary" onClick={() => onSelect(plugin.id)} aria-label={t('robots.openConfiguration', { name: plugin.name })}>{t('robots.configure')}<ArrowRight size={15} /></button></div>
        </div>
      })}
      <button className="register-row" onClick={onRegister}><Plus size={20} /><span>{t(`robots.add.${kind}`)}<small>{t('robots.enableInstalled')}</small></span><ArrowRight size={17} /></button>
    </div>}
    <div className="directory-footnote"><Info size={16} /><p>{t(harness ? 'robots.harnessHint' : 'robots.connectionHint')}</p></div>
  </section>
}

function PluginDetails({ plugin, snapshot, workspace, onFeedback, onRemoved }: {
  readonly plugin: ManagedPlugin
  readonly snapshot: WorkspaceSnapshot
  readonly workspace: PlatformWorkspace
  readonly onFeedback: (message: string) => void
  readonly onRemoved: () => void
}) {
  const { t } = useI18n('app')
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<Extract<WorkspaceActionResult, { readonly ok: false }> | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const removeLock = useRef(false)
  const mounted = useRef(false)
  const Panel = plugin.Panel
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (confirming) confirmButton.current?.focus()
    else if (wasConfirming.current) removeTrigger.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  return <article className="plugin-details">
    <div className="panel-title-row"><h2>{plugin.name}</h2><PluginStatus kind={plugin.kind} status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /></div>
    <p className="panel-description">{t(`robots.detailDescription.${plugin.kind}`)}</p>
    <PanelBoundary key={plugin.id}><Panel saved={snapshot.configurations[plugin.id]} initialValues={plugin.initialValues} onSave={values => workspace.save(plugin.id, values)} onFeedback={onFeedback} onRefresh={() => workspace.refresh()} /></PanelBoundary>
    <section className="plugin-information" aria-label={t('robots.pluginInformation')}>
      <div><h3>{t('robots.pluginTitle', { name: plugin.name })}<span className="version-label">v{plugin.version}</span></h3><p>{t(`robots.disableHint.${plugin.kind}`)}</p></div>
      {!confirming && <button ref={removeTrigger} className="text-button remove-trigger" onClick={() => setConfirming(true)}><Power size={15} />{t('robots.disable')}</button>}
    </section>
    {confirming && <div className="remove-confirmation" role="group" aria-label={t('robots.confirmLabel', { name: plugin.name })}>
      <div><strong>{t('robots.confirmTitle', { name: plugin.name })}</strong><p>{t(`robots.confirmDescription.${plugin.kind}`)}</p></div>
      <div className="confirmation-actions"><button className="button button-secondary" disabled={removing} onClick={() => { setConfirming(false); setRemoveError(null) }}>{t('robots.cancel')}</button><button className="button button-danger" disabled={removing} ref={confirmButton} onClick={async () => {
        if (removeLock.current) return
        removeLock.current = true; setRemoving(true)
        try {
          const result = await workspace.remove(plugin.id)
          if (!mounted.current) return
          if (result.ok) { onFeedback(t(`robots.disabledFeedback.${plugin.kind}`, { name: plugin.name })); onRemoved() }
          else setRemoveError(result)
        } finally { removeLock.current = false; if (mounted.current) setRemoving(false) }
      }}><Check size={15} />{t(removing ? 'robots.disabling' : 'robots.confirmDisable')}</button></div>
      {removeError && <p className="field-error" role="alert">{removeError.error}</p>}
    </div>}
  </article>
}
