import { validateManifest } from '@eating/plugin-core'
import type { CommunicationPlugin } from './contract'

// Vite discovers module entry points; the application shell never enumerates platforms.
const modules = import.meta.glob<CommunicationPlugin>('../../../../plugins/*/entry.tsx', {
  eager: true,
  import: 'default',
})

const plugins = Object.values(modules)
for (const plugin of plugins) validateManifest(plugin)
const ids = new Set(plugins.map(plugin => plugin.id))
if (ids.size !== plugins.length) throw new Error('本地示例插件包含重复标识，无法启动工作区。')

export const localPluginCatalog: readonly CommunicationPlugin[] = Object.freeze(
  [...plugins].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN')),
)
