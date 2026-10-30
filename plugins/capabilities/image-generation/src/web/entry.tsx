import { ImagePlus } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { it } from './i18n'
import { ImageGenerationPanel } from './panel'

const plugin: CapabilityPlugin = {
  id: 'image-generation', get name() { return it('plugin.name') }, get description() { return it('plugin.description') },
  version: '0.1.0', apiVersion: 4, kind: 'capability', order: 40,
  icon: ImagePlus, brandColor: 'var(--color-primary)', defaultRegistered: false, initialValues: {},
  validate: () => ({ valid: true, errors: {} }), summary: () => it('plugin.summary'), Panel: ImageGenerationPanel,
}
export default plugin
