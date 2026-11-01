import { Brain } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { mt } from './i18n'
import { MemoryPanel } from './panel'

const plugin: CapabilityPlugin = {
  id: 'openviking-memory', get name() { return mt('plugin.name') }, get description() { return mt('plugin.description') },
  version: '0.1.0', apiVersion: 4, kind: 'capability', order: 50,
  icon: Brain, brandColor: 'var(--color-primary)', defaultRegistered: false, initialValues: {},
  validate: () => ({ valid: true, errors: {} }), summary: () => mt('plugin.summary'), Panel: MemoryPanel,
}
export default plugin
