import { Smartphone } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { AndroidPanel } from './panel'
import { at } from './i18n'
const plugin: CapabilityPlugin = { id: 'android-control', get name() { return at('name') }, get description() { return at('description') }, version: '0.2.0', kind: 'capability', apiVersion: 4, order: 60, icon: Smartphone, brandColor: 'var(--color-primary)', defaultRegistered: false, initialValues: {}, validate: () => ({ valid: true, errors: {} }), summary: () => at('summary'), Panel: AndroidPanel }
export default plugin
