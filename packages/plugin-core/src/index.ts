export { PluginRegistry, PluginRegistrationError, validateManifest } from './registry'
export type { PluginManifest } from './registry'
export { PREFERENCES_KEY, readPreferences, writePreferences } from './persistence'
export type {
  PluginConfiguration,
  ConfigurationValue,
  SavedConfiguration,
  ActivityEntry,
  WorkspacePreferences,
  StoragePort,
  StorageResult,
} from './persistence'
