import type { ConnectionStatus } from '@eating/plugin-sdk'
import { useI18n } from '@eating/ui-sdk'
import { Circle, Link2, Link2Off, LoaderCircle, TriangleAlert } from 'lucide-react'
import '../i18n/app'

export function PlatformStatus({ status, stale = false }: { readonly status?: ConnectionStatus; readonly stale?: boolean }) {
  const { t } = useI18n('app')
  if (stale) return <span className="status-badge status-warning"><TriangleAlert size={12} />{t('status.stale')}</span>
  const state = status?.state ?? 'unconfigured'
  const Icon = state === 'connected' ? Link2 : state === 'connecting' || state === 'reconnecting' ? LoaderCircle : state === 'error' ? TriangleAlert : state === 'unconfigured' ? Circle : Link2Off
  return <span className={`status-badge status-${state}`}><Icon size={12} />{t(`status.communication.${state}`)}</span>
}
