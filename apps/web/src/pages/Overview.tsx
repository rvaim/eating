import { ArrowRight, Check, CircleDashed, Plug, Plus } from 'lucide-react'
import { getErrorMessage, useI18n } from '@eating/ui-sdk'
import '../i18n/app'
import type { WorkspaceSnapshot } from '../state/workspace'
import { PlatformStatus } from '../components/PlatformStatus'

function messageCount(snapshot: WorkspaceSnapshot, key: string): number {
  const value = snapshot.harness[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function Overview({ snapshot, onRobots, onRegister }: {
  readonly snapshot: WorkspaceSnapshot
  readonly onRobots: (id?: string) => void
  readonly onRegister: () => void
}) {
  const { t, formatNumber } = useI18n('app')
  const communication = snapshot.plugins.filter(plugin => plugin.kind === 'communication')
  const configured = communication.filter(plugin => Boolean(snapshot.configurations[plugin.id]))
  const connected = communication.filter(plugin => snapshot.statuses[plugin.id]?.state === 'connected')
  const harnessAttached = snapshot.harness.state === 'attached'
  const harnessLabel = !snapshot.ready ? t('overview.loadingStatus') : snapshot.storageError ? t('status.stale') : t(harnessAttached ? 'overview.aiConnected' : 'overview.aiDisconnected')
  const countLabel = (key: string, count: number) => t(key, { count, total: formatNumber(count) })
  const connectionDescription = !snapshot.ready ? t('overview.loading') : snapshot.storageError ? t('workspace.loadError') : communication.length === 0 ? t('overview.connectionsEmpty') : connected.length === 0 ? t('overview.connectionsNeeded') : countLabel('overview.connectionsReady', connected.length)
  const deliveryError = snapshot.harness.lastError ?? snapshot.harness.lastQueueError
  return <main id="main-content" className="overview-content">
    <section className="welcome-section">
      <div><h2>{t('overview.connectionsTitle')}</h2><p>{connectionDescription}</p><button className="button button-primary" onClick={() => onRobots()}>{t('overview.manageConnections')}<ArrowRight size={16} /></button></div>
      <div className="welcome-illustration" aria-hidden="true"><Plug size={50} strokeWidth={1.2} /><span className="connection-line" /><div className="illustration-socket"><CircleDashed size={32} strokeWidth={1.3} /></div></div>
    </section>
    <section className="workspace-facts" aria-label={t('overview.summaryLabel')}>
      <div><span>{t('overview.communicationPlugins')}</span><strong>{countLabel('count.enabled', communication.length)}</strong></div>
      <div><span>{t('overview.accountSettings')}</span><strong>{countLabel('count.configured', configured.length)}</strong></div>
      <div><span>{t('overview.connectionsTitle')}</span><strong>{snapshot.storageError ? t('status.stale') : countLabel('count.connected', connected.length)}</strong></div>
      <div><span>{t('overview.aiStatus')}</span><strong className="fact-muted">{harnessLabel}</strong></div>
    </section>
    <section className="overview-platforms" aria-labelledby="overview-platforms-title">
      <div className="section-title-row"><div><h2 id="overview-platforms-title">{t('overview.accountsTitle')}</h2></div><button className="text-button" onClick={onRegister}><Plus size={16} />{t('overview.addConnection')}</button></div>
      {!snapshot.ready ? <p className="loading-line" role="status">{t('overview.loading')}</p> : communication.length === 0 ? <div className="empty-state"><Plug size={28} /><h3>{t('overview.noConnections')}</h3><p>{t('overview.emptyDescription')}</p><button className="button button-secondary" onClick={onRegister}>{t('overview.addConnection')}</button></div> : <div className="platform-list">
        {communication.map(plugin => {
          const Icon = plugin.icon
          const saved = snapshot.configurations[plugin.id]
          return <button className="platform-list-row" key={plugin.id} onClick={() => onRobots(plugin.id)} aria-label={t('overview.openConfiguration', { name: plugin.name })}>
            <span className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={23} /></span>
            <span className="platform-row-copy"><strong>{plugin.name}</strong><small>{saved ? plugin.summary(saved.values) : plugin.description}</small></span>
            <span className="row-configuration">{saved ? <><Check size={14} />{t('overview.configurationSaved')}</> : t('overview.configurationNeeded')}</span>
            <PlatformStatus status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /><ArrowRight className="row-arrow" size={17} />
          </button>
        })}
      </div>}
    </section>
    <div className="overview-bottom">
      <section className="activity-section" aria-labelledby="activity-title"><div className="section-title-row"><h2 id="activity-title">{t('overview.messagesTitle')}</h2><a className="text-button" href="#harness">{t('overview.manageAI')}<ArrowRight size={14} /></a></div>
        <p className="subtle">{!snapshot.ready ? t('overview.loadingDelivery') : snapshot.storageError ? t('overview.staleDelivery') : t(harnessAttached ? 'overview.aiReadyDescription' : 'overview.aiNeededDescription')}</p>
        <p className="delivery-counts"><span>{t('overview.pending')} <strong>{formatNumber(messageCount(snapshot, 'pending'))}</strong></span><span>{t('overview.accepted')} <strong>{formatNumber(messageCount(snapshot, 'accepted'))}</strong></span><span>{t('overview.uncertain')} <strong>{formatNumber(messageCount(snapshot, 'uncertain'))}</strong></span></p>
        <p className="subtle">{countLabel('overview.rejected', messageCount(snapshot, 'rejected'))}</p>
        <p className="subtle">{countLabel('overview.discarded', messageCount(snapshot, 'discarded'))}</p>
        {deliveryError && <p className="subtle" role="alert">{getErrorMessage(deliveryError, t('overview.deliveryError'))}</p>}
        <a className="text-button" href="#settings/queue">{t('overview.manageQueue')}<ArrowRight size={14} /></a>
      </section>
      <aside className="version-note"><h3>{t('overview.processingTitle')}</h3><p>{t('overview.acceptedDescription')}</p><p>{t('overview.processingDescription')}</p><span>Eating 0.10</span></aside>
    </div>
  </main>
}
