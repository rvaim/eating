import { Smartphone } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { at } from './i18n'
import { AndroidPanel } from './panel'

const plugin: CapabilityPlugin = {
  id: 'android-control',
  get name() { return at('name') },
  get description() { return at('description') },
  version: '0.3.5',
  kind: 'capability',
  apiVersion: 4,
  order: 60,
  icon: Smartphone,
  brandColor: 'var(--color-primary)',
  defaultRegistered: false,
  initialValues: {},
  validate: () => ({ valid: true, errors: {} }),
  summary: () => at('summary'),
  Panel: AndroidPanel,
}

export default plugin
