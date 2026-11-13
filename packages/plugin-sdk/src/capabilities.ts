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
export interface ReceivedAudioReference { readonly messageId: string; readonly audioId: string }
/** Incoming audio is independent of the canonical short WAV used for sending. */
export interface ReceivedAudioAsset {
  readonly mimeType: 'audio/wav' | 'audio/ogg'
  readonly byteLength: number
  readonly durationMs: number
  readonly sha256: string
  readBytes(): Promise<Uint8Array>
}
export interface ReceivedAudioLease extends ReceivedAudioAsset { assertCurrent(): void }

/** Trusted Host-supplied identity; models cannot supply this as tool arguments. */
export interface CapabilityInvocationScope {
  /** Trusted in-memory call lifetime, not part of saved grants. */
  readonly signal?: AbortSignal
  readonly readOnly?: boolean
  readonly agentId: string
  readonly agentTypeId: string
  readonly source?: AgentInvocationScope
  readonly memory?: import('./memory.js').MemoryContext
}
export interface ImageAssetMetadata {
  readonly mimeType: ImageMimeType
  readonly byteLength: number
  readonly sha256: string
}
export interface PluginImageAsset extends ImageAssetMetadata {
  readBytes(): Promise<Uint8Array>
  readonly localFile?: () => Promise<string>
}
export interface ImageAssetLease extends PluginImageAsset {
  assertActive(): Promise<void>
  assertCurrent(): void
}
export interface PluginAudioAsset {
  readonly mimeType: 'audio/wav'
  readonly byteLength: number
  readonly sha256: string
  readonly durationMs: number
  readBytes(): Promise<Uint8Array>
}
export interface AudioAssetLease extends PluginAudioAsset {
  assertActive(): Promise<void>
  assertCurrent(): void
}
export interface PluginAudioProvider {
  readonly readTool: string
  getAsset(assetId: string): Promise<PluginAudioAsset>
}
export interface PluginResourceServices {
  readReceivedAudio(scope: CapabilityInvocationScope, reference: ReceivedAudioReference): Promise<ReceivedAudioLease>
  readReceivedImage(scope: AgentInvocationScope, reference: ReceivedImageReference): Promise<ImageResource>
  readAsset(reference: ImageAssetReference, scope?: CapabilityInvocationScope): Promise<ImageResource>
  getAsset(reference: ImageAssetReference, scope?: CapabilityInvocationScope): Promise<ImageAssetLease>
  getAudioAsset(reference: ImageAssetReference, scope?: CapabilityInvocationScope): Promise<AudioAssetLease>
}
export interface PluginMediaProvider {
  /** Tool authorization required when another plugin resolves one of this plugin's assets. */
  readonly readTool: string
  readAsset(assetId: string): Promise<ImageResource>
  getAsset(assetId: string): Promise<PluginImageAsset>
}

/** Owner-selected functional MCP access. New sources use all, including future types and tools. */
export type McpAccessPolicy =
  | { readonly mode: 'all' }
  | { readonly mode: 'custom'; readonly agentTypeIds: readonly string[]; readonly toolNames: readonly string[] }
/** Read-only effective selection intersected with the current directory. */
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
  /** Current owner policy; null for communication/Harness sources managed by their plugin. */
  readonly accessPolicy: McpAccessPolicy | null
  /** Current known Agent types and tools allowed by the policy or the source plugin. */
  readonly grant: McpGrant
  /** Owner-facing connection details omit saved secret values. */
  readonly configuration: JsonObject
}
/** One attempt to restore an already connected Harness after a capability topology change. */
export interface HarnessRemount {
  readonly id: string
  readonly status: 'reconnected' | 'failed' | 'cancelled'
  readonly code?: string
}
export interface HarnessRemountReport {
  /** Present for a management transaction; a directory read may omit it. */
  readonly harnessStopped?: boolean
  readonly harnessRemounts: readonly HarnessRemount[]
}
export interface McpDirectorySnapshot extends HarnessRemountReport {
  readonly protocolVersion: 1
  readonly revision: number
  readonly services: readonly McpServiceSummary[]
  readonly agentTypes: readonly { readonly id: string; readonly title: string }[]
}
