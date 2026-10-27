import type { ConnectionStatus } from '@eating/plugin-sdk'
import { Circle, Link2, Link2Off, LoaderCircle, TriangleAlert } from 'lucide-react'

export function PlatformStatus({ status, stale = false }: { readonly status?: ConnectionStatus; readonly stale?: boolean }) {
  if (stale) return <span className="status-badge status-warning"><TriangleAlert size={12} />状态待确认</span>
  const state = status?.state ?? 'unconfigured'
  const label: Record<ConnectionStatus['state'], string> = { unconfigured: '未配置', disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '连接异常' }
  const Icon = state === 'connected' ? Link2 : state === 'connecting' || state === 'reconnecting' ? LoaderCircle : state === 'error' ? TriangleAlert : state === 'unconfigured' ? Circle : Link2Off
  return <span className={`status-badge status-${state}`}><Icon size={12} />{label[state]}</span>
}
