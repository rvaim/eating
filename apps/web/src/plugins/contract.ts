import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { PluginConfiguration, PluginManifest, SavedConfiguration } from '@eating/plugin-core'

export interface ConfigurationValidation {
  readonly valid: boolean
  readonly errors: Readonly<Record<string, string>>
}

export type WorkspaceActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

export interface PluginPanelProps {
  readonly saved: SavedConfiguration | undefined
  readonly initialValues: PluginConfiguration
  readonly onSave: (values: PluginConfiguration) => WorkspaceActionResult
  readonly onFeedback: (message: string) => void
}

/** Frontend contribution only. Real connector services will have a separate entry. */
export interface CommunicationPlugin extends PluginManifest {
  readonly kind: 'communication'
  readonly order: number
  readonly icon: LucideIcon
  readonly brandColor: string
  readonly defaultRegistered: boolean
  readonly initialValues: PluginConfiguration
  readonly validate: (values: PluginConfiguration) => ConfigurationValidation
  readonly summary: (values: PluginConfiguration) => string
  readonly Panel: ComponentType<PluginPanelProps>
}
