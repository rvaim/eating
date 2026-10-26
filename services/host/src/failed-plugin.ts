import type { BackendPlugin, BackendPluginEntry } from '../../../packages/platform-contract/src/index'
import { PlatformError } from '../../../packages/platform-contract/src/index'

/** A real failed module state, not a substitute connector implementation. */
export function failedPlugin(entry: BackendPluginEntry, cause: unknown): BackendPlugin {
  const failure = cause instanceof PlatformError ? cause : new PlatformError('PLUGIN_INITIALIZATION_FAILED', '平台插件初始化失败，请检查配置和依赖。', 500)
  const reject = async (): Promise<never> => { throw failure }
  return { id: entry.id, name: entry.id, version: '0.0.0', tools: [], capabilities: [],
    getStatus: () => ({ state: 'error', accountId: null, accountName: null, lastError: failure.message,
      connectedAt: null, lastEventAt: null, reconnectAttempt: 0 }),
    getPublicConfiguration: () => ({ initializationError: failure.message }),
    updateConfiguration: reject, connect: reject, disconnect: async () => {}, invoke: reject, dispose: async () => {},
  }
}
