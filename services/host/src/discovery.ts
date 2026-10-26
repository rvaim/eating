import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { isJsonObject } from '../../../packages/platform-contract/src/index'
import type { BackendPluginEntry } from '../../../packages/platform-contract/src/index'

export async function discoverBackendPlugins(): Promise<readonly BackendPluginEntry[]> {
  const directory = fileURLToPath(new URL('../../../plugins/', import.meta.url))
  const entries: BackendPluginEntry[] = []
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(item.name)) continue
    let loaded: { default?: unknown }
    try { loaded = await import(pathToFileURL(join(directory, item.name, 'server.ts')).href) as { default?: unknown } }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(join(item.name, 'server.ts'))) continue
      throw error
    }
    const entry = loaded.default
    if (!entry || typeof entry !== 'object' || !('id' in entry) || entry.id !== item.name || !('create' in entry) || typeof entry.create !== 'function') throw new Error(`平台插件 ${item.name} 后台入口不兼容。`)
    if (!('storageDirectory' in entry) || typeof entry.storageDirectory !== 'string' || !/^[a-z][a-z0-9-]*-bot$/.test(entry.storageDirectory)) throw new Error(`平台插件 ${item.name} 没有合法的 bot 目录声明。`)
    entries.push(entry as BackendPluginEntry)
  }
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('平台后台包含重复标识。')
  return entries
}

export function persistedEnabledIds(raw: string | null, defaults: readonly string[]): readonly string[] {
  if (raw === null) return defaults
  const parsed: unknown = JSON.parse(raw)
  if (!isJsonObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.ids) || !parsed.ids.every(id => typeof id === 'string')) throw new Error('平台启用记录损坏，未覆盖。')
  return parsed.ids as string[]
}
