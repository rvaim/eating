import type { JsonObject } from '@eating/plugin-sdk'

export interface NativeModule {
  readonly id: string
  readonly name: string
  readonly config?: JsonObject
}
export interface NativeFeatureDefinition {
  readonly id: string
  readonly modules: readonly NativeModule[]
  readonly services?: readonly NativeModule[]
  readonly platform?: 'win32' | 'posix'
}

/** These are native public plugins, mounted only in the Agent scope that the owner selected. */
export const NATIVE_FEATURES: readonly NativeFeatureDefinition[] = [
  { id: 'time', modules: [{ id: 'time-context', name: '@deepseek-ai/dsh-time-context', config: { timeZone: 'Asia/Shanghai', refreshIntervalMs: 600000 } }] },
  { id: 'files', modules: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: true, write: false, edit: false } }] },
  { id: 'search', modules: [{ id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }] },
  { id: 'directory', modules: [{ id: 'tool-working-directory', name: '@deepseek-ai/dsh-tool-working-directory' }] },
  { id: 'bash', platform: 'posix', modules: [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }] },
  { id: 'powershell', platform: 'win32', modules: [{ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }] },
  { id: 'jobs', modules: [{ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' }] },
  { id: 'web', services: [{ id: 'native-web-provider', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } }, { id: 'native-web-fetch', name: '@deepseek-ai/dsh-web-fetch-http' }, { id: 'native-web-api', name: '@deepseek-ai/dsh-web-deepseek-api' }, { id: 'native-web-search', name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }], modules: [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { search: false, fetch: true, fetchTimeoutMs: 30000, searchTimeoutMs: 60000 } }] },
  { id: 'skills', services: [{ id: 'native-skill', name: '@deepseek-ai/dsh-skill' }], modules: [{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' }, { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }] },
  { id: 'schedule', modules: [{ id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' }] },
  { id: 'goal', modules: [{ id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' }] },
  { id: 'todo', modules: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }] },
  { id: 'questions', modules: [{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }] },
  { id: 'deliverables', modules: [{ id: 'present', name: '@deepseek-ai/dsh-tool-present' }] },
] as const

export interface NativeFeatureSelection {
  readonly id: string
  readonly enabled: boolean
  readonly agentTypeIds: readonly string[]
  /** Module entry id -> complete raw native module configuration. */
  readonly config: JsonObject
}
export interface NativeToolGrant {
  readonly name: string
  readonly fingerprint: string
  readonly agentTypeIds: readonly string[]
}
export interface NativeCapabilitiesConfiguration {
  readonly schemaVersion: 1
  readonly revision: number
  readonly features: readonly NativeFeatureSelection[]
  readonly toolGrants: readonly NativeToolGrant[]
}
export const nativeDefaultConfig = (definition: NativeFeatureDefinition): JsonObject => Object.fromEntries([...(definition.services ?? []), ...definition.modules].map(module => [module.id, { ...module.config }]))
export function defaultNativeCapabilities(agentTypeIds: readonly string[]): NativeCapabilitiesConfiguration {
  return { schemaVersion: 1, revision: 0, features: NATIVE_FEATURES.map(definition => ({ id: definition.id, enabled: definition.id === 'time', agentTypeIds: definition.id === 'time' ? [...new Set(['main', ...agentTypeIds])] : [], config: nativeDefaultConfig(definition) })), toolGrants: [] }
}

/** The required transport/kernel is not an optional capability and cannot be removed by its own manager. */
export function protectedNativeModule(name: string): boolean {
  return /^(?:eating-|.*[/\\](?:runtime-bridge|native-web|native-capabilities)\.mjs$)/.test(name)
    || /^@deepseek-ai\/(?:cordis|dsh-(?:sdk-|llm|agent(?:$|-)|subagent|session(?:$|-)|system-prompt|tools$|tool-cordis\/host|typert|api-|client-|host-|web-app|workspace|file-reference|commands$|storage|authorization|user-approval|user-questions|credentials|settings|config-editor|plugin-manager$|permission-presets|bash-sandbox|pwsh-sandbox|sandbox|fs-|working-directory$|jobs-local|subprocess|attachment|terminal$|shell-env|timer|goal|schedule|message-feedback|office-to-pdf))/.test(name)
}
