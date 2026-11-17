import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ConnectionStatus, PluginKind } from '@eating/plugin-sdk'
import type { PluginConfiguration, PluginManifest, SavedConfiguration } from '@eating/plugin-core'

export interface ConfigurationValidation {
  readonly valid: boolean
  readonly errors: Readonly<Record<string, string>>
}

export type WorkspaceActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

export interface PluginPanelProps {
  readonly enabled: boolean
  readonly saved: SavedConfiguration | undefined
  readonly initialValues: PluginConfiguration
  readonly onSave: (values: PluginConfiguration) => WorkspaceActionResult | Promise<WorkspaceActionResult>
  readonly onFeedback: (message: string) => void
  readonly onRefresh?: () => Promise<void>
  readonly status?: ConnectionStatus
  readonly connectionBusy?: boolean
  readonly onToggleEnabled?: (next: boolean) => Promise<WorkspaceActionResult>
  readonly onConnect?: () => Promise<WorkspaceActionResult>
  readonly onDisconnect?: () => Promise<WorkspaceActionResult>
  readonly onDirtyChange?: (dirty: boolean) => void
}

/** Shared frontend contribution for independently managed plugin kinds. */
export interface ManagedPlugin extends PluginManifest {
  readonly kind: PluginKind
  readonly order: number
  readonly icon: LucideIcon
  readonly brandColor: string
  readonly defaultRegistered: boolean
  readonly initialValues: PluginConfiguration
  readonly validate: (values: PluginConfiguration) => ConfigurationValidation
  readonly summary: (values: PluginConfiguration) => string
  readonly Panel: ComponentType<PluginPanelProps>
}

export interface CommunicationPlugin extends ManagedPlugin {
  readonly kind: 'communication'
}

export interface HarnessPlugin extends ManagedPlugin {
  readonly kind: 'harness'
}

export interface CapabilityPlugin extends ManagedPlugin {
  readonly kind: 'capability'
}
