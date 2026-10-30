import { Images } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { st } from './i18n'
import { StickersPanel } from './panel'

const plugin: CapabilityPlugin = {
  id: 'stickers', get name() { return st('plugin.name') }, get description() { return st('plugin.description') },
  version: '0.1.0', apiVersion: 4, kind: 'capability', order: 30,
  icon: Images, brandColor: 'var(--color-primary)', defaultRegistered: false, initialValues: {},
  validate: () => ({ valid: true, errors: {} }), summary: () => st('plugin.summary'), Panel: StickersPanel,
}
export default plugin
