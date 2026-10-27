export { PluginRegistry, PluginRegistrationError, validateManifest } from './registry.js'
export type { PluginManifest } from './registry.js'
export { PREFERENCES_KEY, readPreferences, writePreferences } from './persistence.js'
export type {
  PluginConfiguration,
  ConfigurationValue,
  SavedConfiguration,
  ActivityEntry,
  WorkspacePreferences,
  StoragePort,
  StorageResult,
} from './persistence.js'
