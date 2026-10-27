import type { BackendPluginEntry } from '@eating/plugin-sdk'
import { DshPlugin } from './backend/adapter'

export { DshPlugin } from './backend/adapter'

const entry: BackendPluginEntry = {
  id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create: context => new DshPlugin(context),
}

export default entry
