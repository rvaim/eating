import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareRestrictedDirectory } from './config'

/** Official browser plugins, with their shipped Host halves and current dependency roster. */
const CLIENT_MODULES = [
  'dsh-client-modules', 'dsh-client-connection', 'dsh-client-file-upload', 'dsh-api-remotes', 'dsh-cordis-client-runner',
  'dsh-client-ui-theme', 'dsh-client-locale', 'dsh-client-shortcuts', 'dsh-client-ui-shortcuts',
  'dsh-client-ui-layout', 'dsh-client-ui-renderer', 'dsh-client-ui-session', 'dsh-client-resources',
  'dsh-client-ui-sidebar', 'dsh-client-ui-sidebar-right', 'dsh-client-ui-sidebar-documentpreview',
  'dsh-client-ui-sidebar-terminal', 'dsh-client-ui-sidebar-files', 'dsh-client-ui-settings',
  'dsh-client-ui-settings-general', 'dsh-client-ui-settings-models', 'dsh-client-ui-settings-account',
  'dsh-client-ui-plugin-manager', 'dsh-client-ui-settings-plugin-inventory', 'dsh-client-ui-conversation',
  'dsh-client-ui-approval', 'dsh-client-ui-chat', 'dsh-client-ui-brand-official', 'dsh-client-ui-attachment',
  'dsh-client-ui-tool', 'dsh-client-ui-cordis', 'dsh-client-ui-deliverables', 'dsh-client-ui-workspace',
  'dsh-client-ui-workflow-run', 'dsh-client-ui-input-trigger', 'dsh-client-ui-commands', 'dsh-client-ui-skill',
  'dsh-client-ui-subagent', 'dsh-client-ui-reference', 'dsh-client-ui-secret-mask', 'dsh-client-ui-jobs',
  'dsh-client-ui-schedule', 'dsh-client-ui-goal', 'dsh-client-ui-message-feedback', 'dsh-client-ui-model-selection',
  'dsh-client-ui-deepseek-model-label-1017', 'dsh-client-ui-permission-presets', 'dsh-client-ui-agent-preset',
  'dsh-client-ui-entry-customization', 'dsh-client-ui-settings-session-log', 'dsh-client-ui-settings-plugins',
  'dsh-client-ui-settings-shell', 'dsh-client-ui-settings-agent-loop', 'dsh-client-ui-settings-subagent',
  'dsh-client-ui-settings-web-search', 'dsh-client-ui-plan', 'dsh-client-ui-user-questions', 'dsh-client-ui-trajectory',
  'dsh-client-ui-open-in-app',
] as const

export const NATIVE_WEB_MODULES = [
  'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace', 'dsh-commands',
  'dsh-session-reference', 'dsh-file-reference-local', 'dsh-agent-default-model', 'dsh-credentials-local',
  'dsh-typert-registry', 'dsh-typert-loader', 'dsh-api-remote-access', 'dsh-api-gateway',
  'dsh-api-session-controller', 'dsh-api-workspace-controller', 'dsh-api-settings-controller',
  'dsh-api-account-controller', 'dsh-api-job-controller', 'dsh-api-terminal-controller', 'dsh-api-workspace-files',
  'dsh-host-webserver', 'dsh-web-app', 'dsh-host-directory-picker-auto', 'dsh-host-plugin-inventory',
  'dsh-config-editor', 'dsh-settings', 'dsh-plugin-manager', 'dsh-user-approval', 'dsh-user-questions',
  'dsh-authorization', 'dsh-deepseek-account-platform', 'dsh-message-feedback', 'dsh-session-log-export',
  'dsh-host-open-in-app', 'dsh-session-stats', 'dsh-session-turn-outline', 'dsh-session-projection-cache',
  'dsh-cordis-host-runner', 'dsh-tool-cordis/host', 'dsh-office-to-pdf', 'dsh-workspace-changes',
  'dsh-schedule', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-permission-presets', 'dsh-bash-sandbox',
  'dsh-shell-env', 'dsh-time-context', ...CLIENT_MODULES,
] as const

/** Compose the official Web application over the existing SDK kernel without replacing its model tools. */
export function nativeWebRows(directory: string, configuration: { model: string }): Readonly<Record<string, unknown>>[] {
  const id = (name: string): string => ({
    'dsh-credentials-local': 'credentials', 'dsh-host-webserver': 'webserver', 'dsh-web-app': 'web-runtime',
    'dsh-host-directory-picker-auto': 'directory-picker', 'dsh-host-plugin-inventory': 'plugin-inventory',
    'dsh-host-open-in-app': 'open-in-app', 'dsh-tool-cordis/host': 'cordis-inspect-providers',
  }[name] ?? name.replace(/^dsh-(?:client-|api-)?/, ''))
  const row = (name: string, config?: unknown) => ({ id: id(name), name: `@deepseek-ai/${name}`, ...(config === undefined ? {} : { config }) })
  const configured = new Set(['dsh-storage-json', 'dsh-storage-domain', 'dsh-agent-default-model', 'dsh-host-webserver', 'dsh-web-app', 'dsh-time-context', 'dsh-message-feedback', 'dsh-host-open-in-app', 'dsh-session-projection-cache', 'dsh-permission-presets'])
  const scoped = new Set(['dsh-bash-sandbox'])
  return [
    row('dsh-storage-json', { root: join(dirname(directory), 'dsh-home', 'storages') }),
    row('dsh-storage-domain', { backend: 'json' }),
    row('dsh-agent-default-model', { provider: 'eating-openai', model: configuration.model }),
    row('dsh-host-webserver', { host: '127.0.0.1', port: 0 }),
    row('dsh-web-app', { printUrl: false, openBrowser: false, surfaceContext: false }),
    row('dsh-message-feedback', { maxNoteBytes: 8192 }),
    row('dsh-host-open-in-app', { probeTimeoutMs: 10000, iconTimeoutMs: 10000, launchWatchMs: 1000 }),
    row('dsh-session-projection-cache', { writeEveryEvents: 200, writeIntervalMs: 5000 }),
    row('dsh-permission-presets', { defaultPreset: 'workspace-write' }),
    ...NATIVE_WEB_MODULES.filter(name => !configured.has(name) && !scoped.has(name)).map(name => row(name)),
    { ...row('dsh-bash-sandbox', { timeoutMs: 60000 }), disabled: process.platform === 'win32' },
    { id: 'eating-web-entry', name: join(directory, 'native-web.mjs') },
  ]
}

/** Official configuration writes target the profile layer; CLI overlays deliberately remain limited to the SDK bridge. */
export async function prepareNativeWebProfile(directory: string, modules: Readonly<Record<string, string>>, configuration: { model: string }, writeSource: (path: string, source: string) => void): Promise<void> {
  const profile = prepareRestrictedDirectory(join(dirname(directory), 'dsh-home', 'profiles', 'sdk-minimal'))
  const patchPath = join(profile, 'cordis.patch.yml')
  if (existsSync(patchPath) && (lstatSync(patchPath).isSymbolicLink() || !lstatSync(patchPath).isFile())) throw new Error('Native Web profile patch is not a regular file')
  const request = createRequire(modules['dsh-web-app']!)
  const boot = await import(/* @vite-ignore */ pathToFileURL(request.resolve('@deepseek-ai/dsh-app-boot')).href)
  boot.initProfile(profile, ['@deepseek-ai/dsh-sdk-minimal'])
  const patches = boot.loadOptionalPatches('dsh', patchPath) as { insert?: { id?: string }[] }[]
  if (patches.some(patch => patch.insert?.some(row => row.id === 'web-runtime'))) return
  const yaml = await import(/* @vite-ignore */ pathToFileURL(request.resolve('yaml')).href)
  const document = yaml.parseDocument(readFileSync(patchPath, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !yaml.isSeq(document.contents)) throw new Error('Native Web profile patch must be a valid sequence')
  document.contents.flow = false
  document.contents.items.unshift(document.createNode({ insert: nativeWebRows(directory, configuration) }))
  writeSource(patchPath, String(document))
}
