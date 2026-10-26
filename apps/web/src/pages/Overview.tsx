import { ArrowRight, Check, CircleDashed, Link2Off, Plug, Plus } from 'lucide-react'
import type { WorkspaceSnapshot } from '../state/workspace'

export function Overview({ snapshot, onRobots, onRegister }: {
  readonly snapshot: WorkspaceSnapshot
  readonly onRobots: (id?: string) => void
  readonly onRegister: () => void
}) {
  const configured = snapshot.plugins.filter(plugin => Boolean(snapshot.configurations[plugin.id]))
  return <main id="main-content" className="overview-content">
    <section className="welcome-section">
      <div><h2>让连接从这里开始。</h2><p>为 Eating 选择通讯平台，留好它与世界交流的位置。</p><button className="button button-primary" onClick={() => onRobots()}>管理机器人<ArrowRight size={16} /></button></div>
      <div className="welcome-illustration" aria-hidden="true"><Plug size={50} strokeWidth={1.2} /><span className="connection-line" /><div className="illustration-socket"><CircleDashed size={32} strokeWidth={1.3} /></div></div>
    </section>

    <section className="workspace-facts" aria-label="当前工作区状态">
      <div><span>通讯插件</span><strong>{snapshot.plugins.length} 个已注册</strong></div>
      <div><span>本地配置</span><strong>{configured.length} 个已保存</strong></div>
      <div><span>真实平台</span><strong className="fact-muted">尚未连接</strong></div>
      <div><span>认知运行时</span><strong className="fact-muted">尚未接入</strong></div>
    </section>

    <section className="overview-platforms" aria-labelledby="overview-platforms-title">
      <div className="section-title-row"><div><h2 id="overview-platforms-title">通讯平台</h2><p>每个平台都有自己的配置面板。</p></div><button className="text-button" onClick={onRegister}><Plus size={16} />注册插件</button></div>
      {snapshot.plugins.length === 0 ? <div className="empty-state"><Plug size={28} /><h3>还没有注册通讯插件</h3><p>从本地示例中添加一个平台，它的配置入口会自动出现。</p><button className="button button-secondary" onClick={onRegister}>选择示例插件</button></div> : <div className="platform-list">
        {snapshot.plugins.map(plugin => {
          const Icon = plugin.icon
          const saved = snapshot.configurations[plugin.id]
          return <button className="platform-list-row" key={plugin.id} onClick={() => onRobots(plugin.id)} aria-label={`配置${plugin.name}`}>
            <span className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={23} /></span>
            <span className="platform-row-copy"><strong>{plugin.name}</strong><small>{saved ? plugin.summary(saved.values) : plugin.description}</small></span>
            <span className="row-configuration">{saved ? <><Check size={14} />配置已保存</> : '等待配置'}</span>
            <span className="status-badge"><Link2Off size={12} />未连接</span><ArrowRight className="row-arrow" size={17} />
          </button>
        })}
      </div>}
    </section>

    <div className="overview-bottom">
      <section className="activity-section" aria-labelledby="activity-title"><div className="section-title-row"><h2 id="activity-title">最近操作</h2><span className="subtle">仅记录此浏览器中的操作</span></div>
        {snapshot.activity.length ? <ol className="activity-list">{snapshot.activity.slice(0, 5).map(entry => <li key={entry.id}><span className="activity-dot" /><span>{entry.label}</span><time dateTime={entry.at}>{new Date(entry.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol> : <div className="activity-empty"><CircleDashed size={19} /><p>还没有操作记录。注册插件或保存配置后，会在这里留下记录。</p></div>}
      </section>
      <aside className="version-note"><h3>这是一个开始</h3><p>当前验证平台管理与配置体验。真实通讯和 AI 运行时尚未接入。</p><span>Eating · 本地验证版</span></aside>
    </div>
  </main>
}
