import { useRef, useState } from 'react'
import { Check, Plus, Puzzle, X } from 'lucide-react'
import { useI18n } from '@eating/ui-sdk'
import type { ManagedPlugin } from '@eating/ui-sdk'
import '../i18n/app'
import type { PlatformWorkspace, WorkspaceSnapshot } from '../state/workspace'

interface CatalogProps {
  readonly workspace: PlatformWorkspace
  readonly snapshot: WorkspaceSnapshot
  readonly onClose: () => void
  readonly onRegistered: (plugin: ManagedPlugin) => void
  readonly onFeedback: (message: string) => void
}

export function PluginCatalog({ workspace, snapshot, onClose, onRegistered, onFeedback }: CatalogProps) {
  const { t } = useI18n('app')
  const [registering, setRegistering] = useState<string | null>(null)
  const lock = useRef(false)
  return <section className="plugin-catalog" aria-labelledby="plugin-catalog-title">
    <div className="catalog-heading"><div><h2 id="plugin-catalog-title">{t('catalog.title')}</h2><p>{t('catalog.description')}</p></div><button className="icon-button" aria-label={t('catalog.close')} onClick={onClose}><X size={19} /></button></div>
    <p className="catalog-note"><Puzzle size={16} />{t('catalog.note')}</p>
    <div className="catalog-list">{workspace.catalog.map(plugin => {
      const registered = snapshot.plugins.some(current => current.id === plugin.id)
      const Icon = plugin.icon
      return <div className="catalog-entry" key={plugin.id}>
        <div className="platform-symbol" style={{ color: plugin.brandColor }}><Icon size={23} /></div>
        <div className="catalog-entry-copy"><h3>{plugin.name}<span>v{plugin.version}</span></h3><p>{plugin.description}</p><small><span className="status-badge">{t(`catalog.kind.${plugin.kind}`)}</span></small></div>
        <button className={`button ${registered ? 'button-quiet' : 'button-secondary'}`} disabled={registered || registering !== null || Boolean(snapshot.storageError)} aria-label={t(registered ? 'catalog.enabledLabel' : 'catalog.enableLabel', { name: plugin.name })} onClick={async () => {
          if (lock.current) return
          lock.current = true; setRegistering(plugin.id)
          try {
            const result = await workspace.register(plugin.id)
            if (result.ok) onRegistered(plugin)
            else onFeedback(result.error)
          } finally { lock.current = false; setRegistering(null) }
        }}>{registered ? <><Check size={16} />{t('catalog.enabled')}</> : registering === plugin.id ? t('catalog.enabling') : <><Plus size={16} />{t('catalog.enable')}</>}</button>
      </div>
    })}</div>
    {!snapshot.ready && <p className="subtle" role="status">{t('catalog.loading')}</p>}
    {snapshot.ready && !snapshot.storageError && workspace.catalog.length === 0 && <p className="subtle">{t('catalog.empty')}</p>}
  </section>
}
