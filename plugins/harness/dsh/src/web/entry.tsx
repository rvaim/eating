import { BrainCircuit } from 'lucide-react'
import { translate } from '@eating/ui-sdk'
import type { HarnessPlugin } from '@eating/ui-sdk'
import './i18n'
import { DSHPanel, validateConfiguration } from './panel'

const plugin: HarnessPlugin = {
  id: 'dsh', kind: 'harness', name: 'DeepSeek Harness',
  get description() { return translate('dsh', 'plugin.description') },
  version: '0.5.1', apiVersion: 3, order: 10,
  icon: BrainCircuit, brandColor: '#3876b6', defaultRegistered: true,
  initialValues: { displayName: 'DeepSeek Harness', endpoint: '', model: '', autoConnect: false, timeoutMs: '60000', maxTokens: '4096' },
  validate: validateConfiguration,
  summary: values => {
    const name = typeof values.displayName === 'string' && values.displayName.trim() ? values.displayName.trim() : 'DeepSeek Harness'
    const model = typeof values.model === 'string' ? values.model.trim() : ''
    return model ? translate('dsh', 'plugin.summary', { name, model }) : name
  },
  Panel: DSHPanel,
}
export default plugin
