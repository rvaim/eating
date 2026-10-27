export * from './api.js'
export type { ManagedPlugin, CommunicationPlugin, HarnessPlugin, ConfigurationValidation, PluginPanelProps, WorkspaceActionResult } from './contract.js'

/** One shared React instance for independently built frontend contributions. */
export function registerUiRuntime(react: unknown, jsxRuntime: unknown): void {
  const runtime = globalThis as typeof globalThis & { __EATING_UI_RUNTIME_V1__?: { react: unknown; jsxRuntime: unknown } }
  runtime.__EATING_UI_RUNTIME_V1__ = { react, jsxRuntime }
}
