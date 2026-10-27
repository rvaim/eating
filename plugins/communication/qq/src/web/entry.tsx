import { MessageCircle } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import type { CommunicationPlugin, ConfigurationValidation } from '@eating/ui-sdk'
import { QQPanel } from './panel'

function validate(values: PluginConfiguration): ConfigurationValidation {
  const errors: Record<string, string> = {}
  if (typeof values.displayName !== 'string' || !values.displayName.trim() || values.displayName.trim().length > 40) errors.displayName = '显示名称需为 1 至 40 个字符。'
  try {
    const endpoint = new URL(typeof values.endpoint === 'string' ? values.endpoint : '')
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) errors.endpoint = '请使用不含账号、令牌和查询参数的 ws:// 或 wss:// 地址。'
    else if (/\/(?:api|event)\/?$/.test(endpoint.pathname)) errors.endpoint = '请使用同时提供 API 与事件的统一 WebSocket 端点。'
  } catch { errors.endpoint = '请填写有效的 OneBot WebSocket 地址。' }
  return { valid: Object.keys(errors).length === 0, errors }
}

const plugin: CommunicationPlugin = {
  id: 'qq', name: 'QQ', description: '通过真实 OneBot v11 连接 QQ，接收消息并提供独立 MCP 工具。',
  version: '0.5.0', apiVersion: 1, kind: 'communication', order: 10,
  icon: MessageCircle, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: { displayName: 'QQ', endpoint: '', autoConnect: false, forwardToHarness: true, receiveGroups: true, timeoutMs: '10000' },
  validate, summary: values => typeof values.displayName === 'string' && values.displayName.trim() ? values.displayName : 'QQ 配置', Panel: QQPanel,
}
export default plugin
