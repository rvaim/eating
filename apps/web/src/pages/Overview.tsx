import { ArrowRight, Check, Plug, Plus } from 'lucide-react'
import { getErrorMessage, useI18n } from '@eating/ui-sdk'
import '../i18n/app'
import type { WorkspaceSnapshot } from '../state/workspace'
import { PlatformStatus } from '../components/PlatformStatus'
import { applicationVersion } from '../version'

function messageCount(snapshot: WorkspaceSnapshot, key: string): number {
  const value = snapshot.harness[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function Overview({ snapshot, onRobots, onRegister, onPlugin }: {
  readonly snapshot: WorkspaceSnapshot
  readonly onRobots: (id?: string) => void
  readonly onRegister: () => void
  readonly onPlugin?: (id: string) => void
}) {
  const { t, formatNumber } = useI18n('app')
  const communication = snapshot.plugins.filter(plugin => plugin.kind === 'communication')
  const capabilities = snapshot.plugins.filter(plugin => plugin.kind === 'capability')
  const configured = communication.filter(plugin => Boolean(snapshot.configurations[plugin.id]))
  const connected = communication.filter(plugin => snapshot.statuses[plugin.id]?.state === 'connected')
  const harnessAttached = snapshot.harness.state === 'attached'
  const harnessLabel = !snapshot.ready ? t('overview.loadingStatus') : snapshot.storageError ? t('status.stale') : t(harnessAttached ? 'overview.aiConnected' : 'overview.aiDisconnected')
  const countLabel = (key: string, count: number) => t(key, { count, total: formatNumber(count) })
  const connectionDescription = !snapshot.ready ? t('overview.loading') : snapshot.storageError ? t('workspace.loadError') : communication.length === 0 ? t('overview.connectionsEmpty') : connected.length === 0 ? t('overview.connectionsNeeded') : countLabel('overview.connectionsReady', connected.length)
  const deliveryError = snapshot.harness.lastError ?? snapshot.harness.lastQueueError
  const pendingCount = messageCount(snapshot, 'pending')
  const acceptedCount = messageCount(snapshot, 'accepted')
  const uncertainCount = messageCount(snapshot, 'uncertain')
  return <main id="main-content" className="overview-content">
    <div className="overview-top-grid">
      <section className="welcome-section">
        <div className="welcome-copy">
          <span className="welcome-eyebrow"><span className={`live-dot ${connected.length > 0 && harnessAttached ? 'is-live' : ''}`} aria-hidden="true" />Eating {applicationVersion}</span>
          <h2>{t('overview.connectionsTitle')}</h2>
          <p>{connectionDescription}</p>
          <div className="welcome-actions">
            <button className="button button-primary" onClick={() => onRobots()}>{t('overview.manageConnections')}<ArrowRight size={16} /></button>
            <a className="button button-hero-ghost" href="#harness">{t('overview.manageAI')}</a>
          </div>
        </div>
        <div className="hero-topology" aria-hidden="true">
          <div className="topology-node">
            <span className={`live-dot ${connected.length > 0 ? 'is-live' : ''}`} />
            <div>
              <span>{t('overview.communicationPlugins')}</span>
              <strong>{formatNumber(connected.length)} / {formatNumber(communication.length)}</strong>
            </div>
          </div>
          <div className="topology-node">
            <span className={`live-dot ${harnessAttached ? 'is-live' : ''}`} />
            <div>
              <span>{t('overview.accepted')}</span>
              <strong>{formatNumber(acceptedCount)}</strong>
            </div>
          </div>
          <div className="topology-node">
            <span className={`live-dot ${pendingCount > 0 ? 'is-busy' : ''}`} />
            <div>
              <span>{t('overview.pending')}</span>
              <strong>{formatNumber(pendingCount)}</strong>
            </div>
          </div>
        </div>
      </section>
      <section className="workspace-facts" aria-label={t('overview.summaryLabel')}>
        <div className="fact-card"><span>{t('overview.communicationPlugins')}</span><strong>{countLabel('count.enabled', communication.length)}</strong></div>
        <div className="fact-card"><span>{t('overview.accountSettings')}</span><strong>{countLabel('count.configured', configured.length)}</strong></div>
        <div className="fact-card"><span>{t('overview.connectionsTitle')}</span><strong>{snapshot.storageError ? t('status.stale') : countLabel('count.connected', connected.length)}</strong></div>
        <div className="fact-card"><span>{t('overview.aiStatus')}</span><strong className={harnessAttached ? 'fact-live' : 'fact-muted'}>{harnessLabel}</strong></div>
      </section>
    </div>
    <div className="overview-mid-grid">
      <section className="overview-platforms" aria-labelledby="overview-platforms-title">
        <div className="section-title-row"><div><h2 id="overview-platforms-title">{t('overview.accountsTitle')}</h2></div><button className="text-button" onClick={onRegister}><Plus size={16} />{t('overview.addConnection')}</button></div>
        {!snapshot.ready ? <p className="loading-line" role="status">{t('overview.loading')}</p> : communication.length === 0 ? <div className="empty-state overview-card"><Plug size={28} /><h3>{t('overview.noConnections')}</h3><p>{t('overview.emptyDescription')}</p><button className="button button-secondary" onClick={onRegister}>{t('overview.addConnection')}</button></div> : <div className="platform-list overview-card">
          {communication.map(plugin => {
            const Icon = plugin.icon
            const saved = snapshot.configurations[plugin.id]
            return <button className="platform-list-row" key={plugin.id} onClick={() => onRobots(plugin.id)} aria-label={t('overview.openConfiguration', { name: plugin.name })}>
              <span className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={22} /></span>
              <span className="platform-row-copy"><strong>{plugin.name}</strong><small>{saved ? plugin.summary(saved.values) : plugin.description}</small></span>
              <span className="row-configuration">{saved ? <><Check size={14} />{t('overview.configurationSaved')}</> : t('overview.configurationNeeded')}</span>
              <PlatformStatus status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /><ArrowRight className="row-arrow" size={16} />
            </button>
          })}
        </div>}
      </section>
      <section className="overview-capabilities" aria-labelledby="overview-capabilities-title">
        <div className="section-title-row">
          <div><h2 id="overview-capabilities-title">{t('overview.capabilitiesTitle')}</h2></div>
          <a className="text-button" href="#plugins">{t('overview.managePlugins')}<ArrowRight size={14} /></a>
        </div>
        {snapshot.ready && capabilities.length === 0 ? <p className="subtle">{t('overview.capabilitiesEmpty')}</p> : (
          <div className="capability-grid">
            {capabilities.map(plugin => {
              const Icon = plugin.icon
              const saved = snapshot.configurations[plugin.id]
              const state = snapshot.statuses[plugin.id]?.state ?? 'unconfigured'
              const statusText = snapshot.storageError ? t('status.stale') : t(`status.capability.${state}`)
              return (
                <button
                  key={plugin.id}
                  className="capability-card"
                  aria-label={t('overview.openPanel', { name: plugin.name })}
                  onClick={() => {
                    if (onPlugin) onPlugin(plugin.id)
                    else window.location.hash = `plugins/${encodeURIComponent(plugin.id)}`
                  }}>
                  <div className="capability-card-top">
                    <span className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={22} /></span>
                    <span className={`status-badge status-${snapshot.storageError ? 'warning' : state}`}>{statusText}</span>
                  </div>
                  <div className="capability-card-body">
                    <strong>{plugin.name}</strong>
                    <small>{saved ? plugin.summary(saved.values) : plugin.description}</small>
                  </div>
                  <div className="capability-card-foot">
                    <span className="row-configuration">{saved ? <><Check size={14} />{t('overview.configurationSaved')}</> : t('overview.configurationNeeded')}</span>
                    <ArrowRight className="row-arrow" size={16} />
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
    <div className="overview-bottom">
      <section className="activity-section overview-card" aria-labelledby="activity-title"><div className="section-title-row"><h2 id="activity-title">{t('overview.messagesTitle')}</h2><a className="text-button" href="#harness">{t('overview.manageAI')}<ArrowRight size={14} /></a></div>
        <p className="subtle">{!snapshot.ready ? t('overview.loadingDelivery') : snapshot.storageError ? t('overview.staleDelivery') : t(harnessAttached ? 'overview.aiReadyDescription' : 'overview.aiNeededDescription')}</p>
        <p className="delivery-counts"><span>{t('overview.pending')} <strong>{formatNumber(pendingCount)}</strong></span><span>{t('overview.accepted')} <strong>{formatNumber(acceptedCount)}</strong></span><span>{t('overview.uncertain')} <strong>{formatNumber(uncertainCount)}</strong></span></p>
        <p className="subtle">{countLabel('overview.rejected', messageCount(snapshot, 'rejected'))}</p>
        <p className="subtle">{countLabel('overview.discarded', messageCount(snapshot, 'discarded'))}</p>
        {deliveryError && <p className="subtle" role="alert">{getErrorMessage(deliveryError, t('overview.deliveryError'))}</p>}
        <a className="text-button" href="#settings/queue">{t('overview.manageQueue')}<ArrowRight size={14} /></a>
      </section>
      <aside className="version-note overview-card"><h3>{t('overview.processingTitle')}</h3><p>{t('overview.acceptedDescription')}</p><p>{t('overview.processingDescription')}</p><span>Eating {applicationVersion}</span></aside>
    </div>
  </main>
}
