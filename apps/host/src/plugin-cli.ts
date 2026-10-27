import { resolve } from 'node:path'
import { installPluginPackage, loadInstalledPluginPackages, uninstallPluginPackage } from './plugin-installation'
import { resolveEatingHome } from './paths'

const [operation, target] = process.argv.slice(2)
const home = resolveEatingHome()
try {
  if (operation === 'install' && target) {
    const plugin = await installPluginPackage(home, resolve(target))
    console.log(`已安装 ${plugin.manifest.name} ${plugin.manifest.version}。请启动或重启 Eating Host。`)
  } else if (operation === 'uninstall' && target) {
    await uninstallPluginPackage(home, target)
    console.log(`已卸载插件 ${target} 的运行入口，账号配置与消息保留。请启动 Eating Host。`)
  } else if (operation === 'list') {
    const plugins = await loadInstalledPluginPackages(home)
    console.log(plugins.length ? plugins.map(plugin => `${plugin.manifest.id}\t${plugin.manifest.version}\tAPI v${plugin.manifest.apiVersion}`).join('\n') : '尚未安装插件。')
  } else throw new Error('用法：pnpm plugin install <构建产物目录> | uninstall <插件ID> | list。安装和升级、卸载前请停止Host。')
} catch (error) {
  console.error(error instanceof Error ? error.message : '插件管理失败。')
  process.exitCode = 1
}
