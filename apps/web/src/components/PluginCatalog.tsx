import { useRef, useState } from 'react'
import { Check, Plus, Puzzle, X } from 'lucide-react'
import type { ManagedPlugin } from '@eating/ui-sdk'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'

interface CatalogProps {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly onClose: () => void
  readonly onRegistered: (plugin: ManagedPlugin) => void
  readonly onFeedback: (message: string) => void
}

export function PluginCatalog({ workspace, snapshot, onClose, onRegistered, onFeedback }: CatalogProps) {
  const [registering, setRegistering] = useState<string | null>(null)
  const lock = useRef(false)
  return <section className="plugin-catalog" aria-labelledby="plugin-catalog-title">
    <div className="catalog-heading"><div><h2 id="plugin-catalog-title">已安装插件</h2><p>启用插件后，可在对应的机器人或 Harness 页面管理配置与运行状态。</p></div><button className="icon-button" aria-label="关闭插件目录" onClick={onClose}><X size={19} /></button></div>
    <p className="catalog-note"><Puzzle size={16} />此处管理已安装的正式插件。新增可执行插件需另行批准。</p>
    <div className="catalog-list">{workspace.catalog.map(plugin => {
      const registered = snapshot.plugins.some(current => current.id === plugin.id)
      const Icon = plugin.icon
      return <div className="catalog-entry" key={plugin.id}>
        <div className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={23} /></div>
        <div className="catalog-entry-copy"><h3>{plugin.name}<span>v{plugin.version}</span></h3><p>{plugin.description}</p><small><span className="status-badge">{plugin.kind === 'harness' ? 'Harness' : '通讯插件'}</span> · 独立配置与管理</small></div>
        <button className={`button ${registered ? 'button-quiet' : 'button-secondary'}`} disabled={registered || registering !== null || Boolean(snapshot.storageError)} aria-label={registered ? `${plugin.name}已注册` : `注册${plugin.name}插件`} onClick={async () => {
          if (lock.current) return
          lock.current = true; setRegistering(plugin.id)
          try {
            const result = await workspace.register(plugin.id)
            if (result.ok) onRegistered(plugin)
            else onFeedback(result.error)
          } finally { lock.current = false; setRegistering(null) }
        }}>{registered ? <><Check size={16} />已注册</> : registering === plugin.id ? '正在注册…' : <><Plus size={16} />注册插件</>}</button>
      </div>
    })}</div>
    {snapshot.ready && workspace.catalog.length === 0 && <p className="subtle">尚未发现已安装的插件。</p>}
  </section>
}
