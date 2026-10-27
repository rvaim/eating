import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { StrictMode } from 'react'
import { registerUiRuntime } from '@eating/ui-sdk'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PanelBoundary } from './components/PanelBoundary'
import { loadPluginCatalog } from './plugins/catalog'
import { PlatformWorkspace } from './state/workspace'
import './styles.css'

registerUiRuntime(React, JsxRuntime)
const workspace = new PlatformWorkspace([], undefined, loadPluginCatalog)
const root = document.getElementById('root')
if (!root) throw new Error('Eating 页面缺少挂载入口。')

createRoot(root).render(<StrictMode><PanelBoundary><App workspace={workspace} /></PanelBoundary></StrictMode>)
