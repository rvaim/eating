import { AudioLines } from 'lucide-react'
import type { CapabilityPlugin } from '@eating/ui-sdk'
import { SpeechPanel } from './panel'
import { st } from './i18n'
const plugin: CapabilityPlugin = { id: 'text-to-speech', get name() { return st('name') }, get description() { return st('description') }, version: '0.1.2', kind: 'capability', apiVersion: 4, order: 50, icon: AudioLines, brandColor: 'var(--color-primary)', defaultRegistered: false, initialValues: {}, validate: () => ({ valid: true, errors: {} }), summary: () => st('summary'), Panel: SpeechPanel }
export default plugin
