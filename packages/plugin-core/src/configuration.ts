export type ConfigurationValue = string | boolean
export type PluginConfiguration = Readonly<Record<string, ConfigurationValue>>

export interface SavedConfiguration {
  readonly values: PluginConfiguration
  readonly savedAt: string
}

export interface ActivityEntry {
  readonly id: string
  readonly pluginId: string
  readonly label: string
  readonly at: string
}
