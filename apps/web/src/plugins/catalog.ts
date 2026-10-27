import { createElement } from 'react'
import { Plug } from 'lucide-react'
import { validateManifest } from '@eating/plugin-core'
import type { CommunicationPlugin } from '@eating/ui-sdk'

export interface InstalledFrontendContribution {
  readonly id: string
  readonly name?: string
  readonly version?: string
  readonly frontend?: { readonly entry: string; readonly style: string } | null
}
const loaded = new Map<string, Promise<CommunicationPlugin>>()
const loadFailure = '此插件的管理面板加载失败，请检查安装包并重启 Host。其他插件仍可使用。'

function failedContribution(entry: InstalledFrontendContribution): CommunicationPlugin {
  return { id: entry.id, name: entry.name ?? entry.id, description: loadFailure, version: entry.version ?? '0.0.0', apiVersion: 1,
    kind: 'communication', order: 100000, icon: Plug, brandColor: '#65736b', defaultRegistered: true,
    initialValues: {}, validate: () => ({ valid: false, errors: {} }), summary: () => loadFailure,
    Panel: () => createElement('p', { role: 'alert' }, loadFailure) }
}

export async function loadPluginCatalog(entries: readonly InstalledFrontendContribution[]): Promise<readonly CommunicationPlugin[]> {
  const plugins = await Promise.all(entries.filter(entry => entry.frontend).map(async entry => {
    const frontend = entry.frontend!
    try {
      // IDs and SemVer are validated by Host; use the same literal path representation.
      const expected = `/plugins/${entry.id}/${entry.version ?? ''}/`
      if (!frontend.entry.startsWith(expected) || !frontend.style.startsWith(expected)) throw new Error('插件页面入口不属于已安装版本。')
      let loading = loaded.get(frontend.entry)
      if (!loading) {
        const stylesheet = document.createElement('link')
        stylesheet.rel = 'stylesheet'; stylesheet.href = frontend.style
        loading = (async () => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('插件样式加载超时。')), 5000)
            stylesheet.onload = () => { clearTimeout(timer); resolve() }
            stylesheet.onerror = () => { clearTimeout(timer); reject(new Error('插件样式加载失败。')) }
            document.head.append(stylesheet)
          })
          const module = await import(/* @vite-ignore */ frontend.entry) as { default?: CommunicationPlugin }
          const plugin = module.default
          if (!plugin || plugin.id !== entry.id || plugin.version !== entry.version || typeof plugin.Panel !== 'function') throw new Error('已安装插件面板与清单不兼容。')
          validateManifest(plugin)
          return plugin
        })().catch(error => { stylesheet.remove(); loaded.delete(frontend.entry); throw error })
        loaded.set(frontend.entry, loading)
      }
      return await loading
    } catch { return failedContribution(entry) }
  }))
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) throw new Error('插件页面存在重复标识。')
  return plugins.sort((a, b) => a.order - b.order)
}
