import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { BackendPluginEntry } from '@eating/plugin-sdk'
import { loadInstalledPluginPackages } from './plugin-installation'

/** Only activated, verified build artifacts are executable plugin sources. */
export async function discoverBackendPlugins(home: string): Promise<readonly BackendPluginEntry[]> {
  const packages = await loadInstalledPluginPackages(home)
  const entries: BackendPluginEntry[] = []
  for (const installed of packages) {
    const loaded = await import(pathToFileURL(resolve(installed.directory, installed.manifest.backend)).href) as { default?: unknown }
    const entry = loaded.default
    if (!entry || typeof entry !== 'object' || !('id' in entry) || entry.id !== installed.manifest.id
      || !('storageDirectory' in entry) || entry.storageDirectory !== installed.manifest.storageDirectory
      || !('create' in entry) || typeof entry.create !== 'function') throw new PlatformError('INVALID_PLUGIN_ENTRY', `插件 ${installed.manifest.id} 后台入口与安装清单不匹配。`, 500)
    const original = entry as BackendPluginEntry
    entries.push({ ...original, installed, create(context) {
      const plugin = original.create(context)
      if (plugin.id !== installed.manifest.id || plugin.version !== installed.manifest.version) throw new PlatformError('PLUGIN_VERSION_MISMATCH', '插件运行版本与安装清单不匹配。', 500)
      return plugin
    } })
  }
  return entries
}

export function persistedEnabledIds(raw: string | null, defaults: readonly string[]): readonly string[] {
  if (raw === null) return defaults
  const parsed: unknown = JSON.parse(raw)
  if (!isJsonObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.ids) || !parsed.ids.every(id => typeof id === 'string')) throw new Error('平台启用记录损坏，未覆盖。')
  return parsed.ids as string[]
}
