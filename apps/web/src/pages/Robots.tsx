import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BrainCircuit, Check, ChevronRight, Circle, Info, Layers, LoaderCircle, Plug, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { PlatformStatus } from '../components/PlatformStatus'
import type { ManagedPlugin } from '@eating/ui-sdk'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'
import { PanelBoundary } from '../components/PanelBoundary'

export function Robots({ kind, workspace, snapshot, selectedId, onSelect, onRegister, onFeedback }: {
  readonly kind: ManagedPlugin['kind']
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
  readonly onRegister: () => void
  readonly onFeedback: (message: string) => void
}) {
  const plugins = snapshot.plugins.filter(plugin => plugin.kind === kind)
  const selected = plugins.find(plugin => plugin.id === selectedId)
  const harness = kind === 'harness'
  const directoryHeading = useRef<HTMLHeadingElement>(null)
  const focusDirectory = useRef(false)
  useEffect(() => {
    if (snapshot.ready && !snapshot.storageError && selectedId && !selected) onSelect(null)
    if (!selected && focusDirectory.current) {
      directoryHeading.current?.focus()
      focusDirectory.current = false
    }
  }, [selectedId, selected, onSelect, snapshot.ready, snapshot.storageError])

  return <div className="robot-workspace">
    <aside className="platform-sidebar" aria-label={harness ? 'Harness 插件分类' : '机器人平台分类'}>
      <p className="platform-nav-heading">{harness ? 'Harness' : '通讯平台'}<span>{plugins.length}</span></p>
      <nav aria-label={harness ? 'Harness 分类' : '平台分类'}>
        <button className={`platform-nav-item ${!selected ? 'is-selected' : ''}`} aria-current={!selected ? 'page' : undefined} onClick={() => onSelect(null)}><Layers size={18} /><span>{harness ? '全部 Harness' : '全部平台'}</span></button>
        <div className="platform-nav-divider" />
        {plugins.map(plugin => {
          const Icon = plugin.icon
          return <button key={plugin.id} className={`platform-nav-item ${selected?.id === plugin.id ? 'is-selected' : ''}`} aria-current={selected?.id === plugin.id ? 'page' : undefined} onClick={() => onSelect(plugin.id)}><Icon size={18} /><span>{plugin.name}</span>{selected?.id === plugin.id && <ChevronRight size={15} className="nav-chevron" />}</button>
        })}
      </nav>
      <div className="platform-sidebar-footer"><Plug size={17} /><p>分类与配置面板<br />由各插件独立提供。</p></div>
    </aside>
    <main id="main-content" className="robot-content">
      {!snapshot.ready ? <p className="subtle" role="status">正在读取插件状态…</p> : selected ? <PluginDetails key={selected.id} plugin={selected} snapshot={snapshot} workspace={workspace} onFeedback={onFeedback} onRemoved={() => { focusDirectory.current = true; onSelect(null) }} /> : <PlatformDirectory kind={kind} plugins={plugins} snapshot={snapshot} headingRef={directoryHeading} onSelect={onSelect} onRegister={onRegister} />}
    </main>
  </div>
}

function PluginStatus({ kind, status, stale }: { readonly kind: ManagedPlugin['kind']; readonly status: ConnectionStatus | undefined; readonly stale: boolean }) {
  if (kind === 'communication') return <PlatformStatus status={status} stale={stale} />
  const state = status?.state ?? 'unconfigured'
  const labels: Record<ConnectionStatus['state'], string> = { unconfigured: '待配置', disconnected: '未启动', connecting: '正在启动', connected: '已启动', reconnecting: '正在恢复', error: '启动异常' }
  const Icon = stale || state === 'error' ? TriangleAlert : state === 'connecting' || state === 'reconnecting' ? LoaderCircle : state === 'connected' ? BrainCircuit : Circle
  return <span className={`status-badge status-${stale ? 'warning' : state}`}><Icon size={12} />{stale ? '状态待确认' : labels[state]}</span>
}

function PlatformDirectory({ kind, plugins, snapshot, headingRef, onSelect, onRegister }: {
  readonly kind: ManagedPlugin['kind']
  readonly plugins: readonly ManagedPlugin[]
  readonly snapshot: WorkspaceSnapshot
  readonly headingRef: { readonly current: HTMLHeadingElement | null }
  readonly onSelect: (id: string | null) => void
  readonly onRegister: () => void
}) {
  const harness = kind === 'harness'
  const Icon = harness ? BrainCircuit : Plug
  return <section>
    <div className="panel-title-row"><h2 ref={headingRef} tabIndex={-1}>{harness ? '全部 Harness' : '全部平台'}</h2><span className="count-label">{plugins.length} 个已注册</span></div>
    <p className="panel-description">{harness ? '选择已启用的 Harness，管理模型配置、运行时与主会话。' : '选择一个平台，打开它自己的配置面板。'}</p>
    {plugins.length === 0 ? <div className="empty-state directory-empty"><Icon size={32} /><h3>{harness ? '启用一个 Harness' : '从一个连接开始'}</h3><p>{harness ? '从已安装插件中启用 Harness，再配置并启动认知运行时。' : '启用一个已安装的平台插件，它的配置与功能面板会出现在这里。'}</p><button className="button button-primary" onClick={onRegister}><Plus size={16} />{harness ? '查看 Harness 插件' : '查看平台插件'}</button></div> : <div className="directory-list">
      {plugins.map(plugin => {
        const PluginIcon = plugin.icon
        const saved = snapshot.configurations[plugin.id]
        return <div key={plugin.id} className="directory-row">
          <div className="platform-symbol" style={{ color: plugin.brandColor }}><PluginIcon size={26} /></div>
          <div className="directory-copy"><h3>{plugin.name}<span className="version-label">v{plugin.version}</span></h3><p>{plugin.description}</p><small>{saved ? `配置已保存 · ${plugin.summary(saved.values)}` : '等待配置'}</small></div>
          <div className="directory-actions"><PluginStatus kind={kind} status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /><button className="button button-secondary" onClick={() => onSelect(plugin.id)} aria-label={`打开${plugin.name}配置`}>配置<ArrowRight size={15} /></button></div>
        </div>
      })}
      <button className="register-row" onClick={onRegister}><Plus size={20} /><span>{harness ? '添加一个 Harness' : '添加一个通讯平台'}<small>从已安装插件中启用，配置与功能由插件提供。</small></span><ArrowRight size={17} /></button>
    </div>}
    <div className="directory-footnote"><Info size={16} /><p>{harness ? '保存配置和启动是两个操作。消息是否回复、是否调用通讯工具由 Harness 中的主 Agent 决定。' : '平台配置由 Host 保存。连接需通过协议端身份与健康核验，消息入队不等于 Harness 已处理。'}</p></div>
  </section>
}

function PluginDetails({ plugin, snapshot, workspace, onFeedback, onRemoved }: {
  readonly plugin: ManagedPlugin
  readonly snapshot: WorkspaceSnapshot
  readonly workspace: PlatformWorkspace
  readonly onFeedback: (message: string) => void
  readonly onRemoved: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const removeLock = useRef(false)
  const mounted = useRef(false)
  const Panel = plugin.Panel
  const harness = plugin.kind === 'harness'
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (confirming) confirmButton.current?.focus()
    else if (wasConfirming.current) removeTrigger.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  return <article className="plugin-details">
    <div className="panel-title-row"><h2>{plugin.name}</h2><PluginStatus kind={plugin.kind} status={snapshot.statuses[plugin.id]} stale={Boolean(snapshot.storageError)} /></div>
    <p className="panel-description">{harness ? `模型配置、运行时和主会话由 ${plugin.name} 插件独立管理。` : `连接、消息和工具由 ${plugin.name} 插件独立管理。`}</p>
    <PanelBoundary key={plugin.id}><Panel saved={snapshot.configurations[plugin.id]} initialValues={plugin.initialValues} onSave={values => workspace.save(plugin.id, values)} onFeedback={onFeedback} onRefresh={() => workspace.refresh()} /></PanelBoundary>
    <section className="plugin-information" aria-label="插件信息与移除">
      <div><h3>{plugin.name} 插件<span className="version-label">v{plugin.version}</span></h3><p>{harness ? '停用会停止运行时并撤销消息接收入口，保留插件配置和独立数据。' : '停用会断开连接并撤销工具入口，保留账号配置；待投递消息由全局队列管理。'}</p></div>
      {!confirming && <button ref={removeTrigger} className="text-button remove-trigger" onClick={() => setConfirming(true)}><Trash2 size={15} />移除插件</button>}
    </section>
    {confirming && <div className="remove-confirmation" role="group" aria-label={`确认移除${plugin.name}插件`}>
      <div><strong>确定停用 {plugin.name} 插件？</strong><p>{harness ? '运行时会停止，消息接收入口撤销。插件配置和独立数据保留，通讯插件继续运行。' : '当前连接会断开，工具入口撤销。账号配置保留，待投递队列不受此操作影响，其他平台不受影响。'}</p></div>
      <div className="confirmation-actions"><button className="button button-secondary" disabled={removing} onClick={() => { setConfirming(false); setRemoveError(null) }}>取消</button><button className="button button-danger" disabled={removing} ref={confirmButton} onClick={async () => {
        if (removeLock.current) return
        removeLock.current = true; setRemoving(true)
        try {
          const result = await workspace.remove(plugin.id)
          if (!mounted.current) return
          if (result.ok) { onFeedback(`${plugin.name} 已停用，${harness ? '插件' : '账号'}配置保留`); onRemoved() }
          else setRemoveError(result.error)
        } finally { removeLock.current = false; if (mounted.current) setRemoving(false) }
      }}><Check size={15} />{removing ? '正在停用…' : '确认移除'}</button></div>
      {removeError && <p className="field-error" role="alert">{removeError}</p>}
    </div>}
  </article>
}
