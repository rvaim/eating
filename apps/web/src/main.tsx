import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { StoragePort } from '@eating/plugin-core'
import { App } from './App'
import { PanelBoundary } from './components/PanelBoundary'
import { localPluginCatalog } from './plugins/catalog'
import { PlatformWorkspace } from './state/workspace'
import './styles.css'

// Access storage lazily so a denied localStorage getter produces a visible readonly state.
const browserStorage: StoragePort = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
}
const workspace = new PlatformWorkspace(localPluginCatalog, browserStorage)
const root = document.getElementById('root')
if (!root) throw new Error('Eating 页面缺少挂载入口。')

createRoot(root).render(<StrictMode><PanelBoundary><App workspace={workspace} /></PanelBoundary></StrictMode>)
