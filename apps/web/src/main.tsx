import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PanelBoundary } from './components/PanelBoundary'
import { localPluginCatalog } from './plugins/catalog'
import { PlatformWorkspace } from './state/workspace'
import './styles.css'

const workspace = new PlatformWorkspace(localPluginCatalog)
const root = document.getElementById('root')
if (!root) throw new Error('Eating 页面缺少挂载入口。')

createRoot(root).render(<StrictMode><PanelBoundary><App workspace={workspace} /></PanelBoundary></StrictMode>)
