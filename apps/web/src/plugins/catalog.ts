import { createElement } from 'react'
import { Plug } from 'lucide-react'
import { validateManifest } from '@eating/plugin-core'
import { translate, useI18n } from '@eating/ui-sdk'
import type { ManagedPlugin } from '@eating/ui-sdk'
import '../i18n/app'

export interface InstalledFrontendContribution {
  readonly id: string
  readonly kind: ManagedPlugin['kind']
  readonly name?: string
  readonly version?: string
  readonly frontend?: { readonly entry: string; readonly style: string } | null
}
const loaded = new Map<string, Promise<ManagedPlugin>>()

function FailedPluginPanel() {
  const { t } = useI18n('app')
  return createElement('p', { role: 'alert' }, t('catalog.loadError'))
}

function failedContribution(entry: InstalledFrontendContribution): ManagedPlugin {
  return { id: entry.id, name: entry.name ?? entry.id, get description() { return translate('app', 'catalog.loadError') }, version: entry.version ?? '0.0.0', apiVersion: 4,
    kind: entry.kind, order: 100000, icon: Plug, brandColor: '#65736b', defaultRegistered: true,
    initialValues: {}, validate: () => ({ valid: false, errors: {} }), summary: () => translate('app', 'catalog.loadError'),
    Panel: FailedPluginPanel }
}

export async function loadPluginCatalog(entries: readonly InstalledFrontendContribution[]): Promise<readonly ManagedPlugin[]> {
  if (entries.some(entry => !entry || !['communication', 'harness', 'capability'].includes(entry.kind))) throw new Error(translate('app', 'catalog.error.kindMismatch'))
  const plugins = await Promise.all(entries.map(async entry => {
    try {
      const frontend = entry.frontend
      if (!frontend) throw new Error(translate('app', 'catalog.error.missingFrontend'))
      // IDs and SemVer are validated by Host; use the same literal path representation.
      const expected = `/plugins/${entry.id}/${entry.version ?? ''}/`
      if (!frontend.entry.startsWith(expected) || !frontend.style.startsWith(expected)) throw new Error(translate('app', 'catalog.error.invalidEntry'))
      let loading = loaded.get(frontend.entry)
      if (!loading) {
        const stylesheet = document.createElement('link')
        stylesheet.rel = 'stylesheet'; stylesheet.href = frontend.style
        loading = (async () => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(translate('app', 'catalog.error.stylesheetTimeout'))), 5000)
            stylesheet.onload = () => { clearTimeout(timer); resolve() }
            stylesheet.onerror = () => { clearTimeout(timer); reject(new Error(translate('app', 'catalog.error.stylesheetFailed'))) }
            document.head.append(stylesheet)
          })
          const module = await import(/* @vite-ignore */ frontend.entry) as { default?: ManagedPlugin }
          const plugin = module.default
          if (!plugin || plugin.id !== entry.id || plugin.version !== entry.version || typeof plugin.Panel !== 'function'
            || plugin.kind !== (entry.kind)) throw new Error(translate('app', 'catalog.error.incompatible'))
          validateManifest(plugin)
          return plugin
        })().catch(error => { stylesheet.remove(); loaded.delete(frontend.entry); throw error })
        loaded.set(frontend.entry, loading)
      }
      const plugin = await loading
      if (plugin.kind !== (entry.kind)) throw new Error(translate('app', 'catalog.error.kindMismatch'))
      return plugin
    } catch { return failedContribution(entry) }
  }))
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) throw new Error(translate('app', 'catalog.error.duplicate'))
  return plugins.sort((a, b) => a.order - b.order)
}
