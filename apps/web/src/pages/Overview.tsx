import { ArrowRight, Check, CircleDashed, Plug, Plus } from 'lucide-react'
import type { WorkspaceSnapshot } from '../state/workspace'
import { PlatformStatus } from '../components/PlatformStatus'

export function Overview({ snapshot, onRobots, onRegister }: {
  readonly snapshot: WorkspaceSnapshot
  readonly onRobots: (id?: string) => void
  readonly onRegister: () => void
}) {
  const configured = snapshot.plugins.filter(plugin => Boolean(snapshot.configurations[plugin.id]))
  const connected = snapshot.plugins.filter(plugin => snapshot.statuses[plugin.id]?.state === 'connected')
  return <main id="main-content" className="overview-content">
    <section className="welcome-section">
      <div><h2>连接 Eating 与世界。</h2><p>管理通讯连接、查看消息与工具，让每个平台各司其职。</p><button className="button button-primary" onClick={() => onRobots()}>管理机器人<ArrowRight size={16} /></button></div>
      <div className="welcome-illustration" aria-hidden="true"><Plug size={50} strokeWidth={1.2} /><span className="connection-line" /><div className="illustration-socket"><CircleDashed size={32} strokeWidth={1.3} /></div></div>
    </section>
    <section className="workspace-facts" aria-label="当前工作区状态">
      <div><span>通讯插件</span><strong>{snapshot.plugins.length} 个已启用</strong></div>
      <div><span>账号配置</span><strong>{configured.length} 个已配置</strong></div>
      <div><span>协议连接</span><strong>{snapshot.storageError ? '状态待确认' : `${connected.length} 个已连接`}</strong></div>
      <div><span>认知运行时</span><strong className="fact-muted">{snapshot.harness.state === 'attached' ? '已接入' : '尚未接入'}</strong></div>
    </section>
    <section className="overview-platforms" aria-labelledby="overview-platforms-title">
      <div className="section-title-row"><div><h2 id="overview-platforms-title">通讯平台</h2><p>连接、消息、MCP 与功能测试由各插件管理。</p></div><button className="text-button" onClick={onRegister}><Plus size={16} />平台插件</button></div>
      {!snapshot.ready ? <p className="loading-line" role="status">正在读取 Host 状态…</p> : snapshot.plugins.length === 0 ? <div className="empty-state"><Plug size={28} /><h3>还没有启用通讯插件</h3><p>启用已安装的平台插件后，就可以配置账号和测试功能。</p><button className="button button-secondary" onClick={onRegister}>查看平台插件</button></div> : <div className="platform-list">
        {snapshot.plugins.map(plugin => {
          const Icon = plugin.icon
          const saved = snapshot.configurations[plugin.id]
          return <button className="platform-list-row" key={plugin.id} onClick={() => onRobots(plugin.id)} aria-label={`配置${plugin.name}`}>
            <span className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={23} /></span>
            <span className="platform-row-copy"><strong>{plugin.name}</strong><small>{saved ? plugin.summary(saved.values) : plugin.description}</small></span>
            <span className="row-configuration">{saved ? <><Check size={14} />配置已保存</> : '等待配置'}</span>
            <PlatformStatus status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /><ArrowRight className="row-arrow" size={17} />
          </button>
        })}
      </div>}
    </section>
    <div className="overview-bottom">
      <section className="activity-section" aria-labelledby="activity-title"><div className="section-title-row"><h2 id="activity-title">Harness 消息投递</h2><span className="subtle">接口已预留</span></div>
        <p className="subtle">{snapshot.harness.state === 'attached' ? '主要接收者已接入。' : '尚未注册 Harness 接收者，外部消息在 Host 持久保存并等待投递。'}</p>
        <p className="delivery-counts">待投递 <strong>{String(snapshot.harness.pending ?? 0)}</strong><span>已接受 <strong>{String(snapshot.harness.accepted ?? 0)}</strong></span><span>结果待核对 <strong>{String(snapshot.harness.uncertain ?? 0)}</strong></span></p>
      </section>
      <aside className="version-note"><h3>数据与运行环境</h3><p>配置保存到 EATING_HOME，默认 ~/.eating；机器人实例独立存储，停用不会删除配置或消息。</p><span>Eating · 正式开发版本 0.2</span></aside>
    </div>
  </main>
}
