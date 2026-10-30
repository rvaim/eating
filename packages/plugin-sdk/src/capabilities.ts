import type { AgentInvocationScope } from './agents.js'
import type { JsonObject, PluginToolDefinition } from './index.js'

export type PluginKind = 'communication' | 'harness' | 'capability'
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Bounded image bytes; data is canonical base64, never a local filesystem path. */
export interface ImageResource {
  readonly mimeType: ImageMimeType
  readonly data: string
}
export interface ImageAssetReference { readonly pluginId: string; readonly assetId: string }
export interface ReceivedImageReference { readonly messageId: string; readonly imageId: string }

/** Trusted Host-supplied identity; models cannot supply this as tool arguments. */
export interface CapabilityInvocationScope {
  /** Trusted in-memory call lifetime, not part of saved grants. */
  readonly signal?: AbortSignal
  readonly agentId: string
  readonly agentTypeId: string
  readonly source?: AgentInvocationScope
}
export interface PluginResourceServices {
  readReceivedImage(scope: AgentInvocationScope, reference: ReceivedImageReference): Promise<ImageResource>
  readAsset(reference: ImageAssetReference, scope?: CapabilityInvocationScope): Promise<ImageResource>
}
export interface PluginMediaProvider {
  /** Tool authorization required when another plugin resolves one of this plugin's assets. */
  readonly readTool: string
  readAsset(assetId: string): Promise<ImageResource>
}

export interface McpGrant {
  readonly agentTypeIds: readonly string[]
  readonly toolNames: readonly string[]
}
export interface HarnessCapabilityConnection {
  readonly id: string
  readonly serverName: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly tools: readonly string[]
}
export type McpTransportConfiguration =
  | { readonly transport: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly clearEnvKeys?: readonly string[] }
  | { readonly transport: 'streamable-http'; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly clearHeaderKeys?: readonly string[] }
export type DirectMcpConfiguration = McpTransportConfiguration & {
  readonly id: string
  readonly name: string
  readonly autoConnect: boolean
  readonly grant: McpGrant
}
export interface McpServiceSummary {
  readonly id: string
  readonly name: string
  readonly source: { readonly kind: 'direct' } | { readonly kind: 'plugin'; readonly pluginId: string; readonly pluginName: string }
  readonly transport: 'stdio' | 'streamable-http' | 'plugin'
  readonly enabled: boolean
  readonly autoConnect: boolean
  readonly state: 'disconnected' | 'connecting' | 'connected' | 'error'
  readonly lastError: string | null
  readonly tools: readonly PluginToolDefinition[]
  readonly grant: McpGrant
  /** Owner-facing connection details omit saved secret values. */
  readonly configuration: JsonObject
}
export interface McpDirectorySnapshot {
  readonly protocolVersion: 1
  readonly revision: number
  readonly services: readonly McpServiceSummary[]
  readonly agentTypes: readonly { readonly id: string; readonly title: string }[]
}
