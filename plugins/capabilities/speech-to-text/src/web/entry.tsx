import { Mic } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { RecognitionPanel } from './panel'
import { rt } from './i18n'
const plugin: CapabilityPlugin = { id: 'speech-to-text', get name() { return rt('name') }, get description() { return rt('description') }, version: '0.1.0', kind: 'capability', apiVersion: 4, order: 55, icon: Mic, brandColor: 'var(--color-primary)', defaultRegistered: false, initialValues: {}, validate: () => ({ valid: true, errors: {} }), summary: () => rt('summary'), Panel: RecognitionPanel }
export default plugin
