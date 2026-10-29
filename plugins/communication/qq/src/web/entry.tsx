import { MessageCircle } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import { translate } from '@eating/ui-sdk'
import type { CommunicationPlugin, ConfigurationValidation } from '@eating/ui-sdk'
import './i18n'
import { QQPanel } from './panel'

function validate(values: PluginConfiguration): ConfigurationValidation {
  const errors: Record<string, string> = {}
  if (typeof values.displayName !== 'string' || !values.displayName.trim() || values.displayName.trim().length > 40) errors.displayName = translate('qq', 'validation.displayName')
  try {
    const endpoint = new URL(typeof values.endpoint === 'string' ? values.endpoint : '')
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) errors.endpoint = translate('qq', 'validation.endpointFormat')
    else if (/\/(?:api|event)\/?$/.test(endpoint.pathname)) errors.endpoint = translate('qq', 'validation.endpointUnified')
  } catch { errors.endpoint = translate('qq', 'validation.endpoint') }
  return { valid: Object.keys(errors).length === 0, errors }
}

const plugin: CommunicationPlugin = {
  id: 'qq', name: 'QQ', get description() { return translate('qq', 'plugin.description') },
  version: '0.10.1', apiVersion: 3, kind: 'communication', order: 10,
  icon: MessageCircle, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: { displayName: 'QQ', endpoint: '', autoConnect: false, forwardToHarness: true, receiveGroups: true, timeoutMs: '10000' },
  validate, summary: values => typeof values.displayName === 'string' && values.displayName.trim() ? values.displayName : translate('qq', 'plugin.summary'), Panel: QQPanel,
}
export default plugin
