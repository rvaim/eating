import { Check, Plus, Puzzle, X } from 'lucide-react'
import type { CommunicationPlugin } from '@eating/ui-sdk'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'

interface CatalogProps {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly onClose: () => void
  readonly onRegistered: (plugin: CommunicationPlugin) => void
  readonly onFeedback: (message: string) => void
}

export function PluginCatalog({ workspace, snapshot, onClose, onRegistered, onFeedback }: CatalogProps) {
  return <section className="plugin-catalog" aria-labelledby="plugin-catalog-title">
    <div className="catalog-heading"><div><h2 id="plugin-catalog-title">平台插件</h2><p>启用已安装平台后，它的分类、配置和功能面板会一起出现。</p></div><button className="icon-button" aria-label="关闭插件目录" onClick={onClose}><X size={19} /></button></div>
    <p className="catalog-note"><Puzzle size={16} />此处管理已安装的正式插件。新增可执行插件需另行批准。</p>
    <div className="catalog-list">{workspace.catalog.map(plugin => {
      const registered = snapshot.plugins.some(current => current.id === plugin.id)
      const Icon = plugin.icon
      return <div className="catalog-entry" key={plugin.id}>
        <div className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={23} /></div>
        <div className="catalog-entry-copy"><h3>{plugin.name}<span>v{plugin.version}</span></h3><p>{plugin.description}</p><small>独立配置 · MCP 与功能测试</small></div>
        <button className={`button ${registered ? 'button-quiet' : 'button-secondary'}`} disabled={registered || Boolean(snapshot.storageError)} aria-label={registered ? `${plugin.name}已注册` : `注册${plugin.name}插件`} onClick={async () => {
          const result = await workspace.register(plugin.id)
          if (result.ok) onRegistered(plugin)
          else onFeedback(result.error)
        }}>{registered ? <><Check size={16} />已注册</> : <><Plus size={16} />注册插件</>}</button>
      </div>
    })}</div>
  </section>
}
