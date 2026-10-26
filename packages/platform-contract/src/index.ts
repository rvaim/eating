export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface OneBotConfig {
  readonly displayName: string
  readonly endpoint: string
  readonly accessToken: string
  readonly autoConnect: boolean
  readonly forwardToHarness: boolean
  readonly receiveGroups: boolean
  readonly timeoutMs: number
}

export interface ConnectionStatus {
  readonly state: 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  readonly accountId: string | null
  readonly accountName: string | null
  readonly lastError: string | null
  readonly connectedAt: string | null
  readonly lastEventAt: string | null
  readonly reconnectAttempt: number
}

export interface PluginToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly readOnly: boolean
  readonly destructive: boolean
}

export interface PluginCapability {
  readonly id: string
  readonly name: string
  readonly support: 'supported' | 'unsupported' | 'unknown'
  readonly description: string
  readonly toolName?: string
}

export interface HarnessEvent {
  readonly protocolVersion: 1
  readonly eventId: string
  readonly pluginId: string
  readonly instanceId: string
  readonly platform: string
  readonly accountId: string
  readonly conversationId: string
  readonly senderId: string
  readonly receivedAt: string
  readonly source: { readonly trust: 'external'; readonly kind: 'private' | 'group' }
  readonly content: JsonValue
  readonly text: string
}

/** Acceptance is distinct from model consumption or external actions. */
export interface HarnessMessageSink {
  readonly id: string
  deliver(event: HarnessEvent, signal: AbortSignal): Promise<{ readonly accepted: boolean; readonly receiptId?: string }>
}

export interface HostPluginContext {
  readonly dataDirectory: string
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  recordEvent(pluginId: string, deduplicationKey: string, event: JsonObject, harnessEvent: HarnessEvent | null, metadata?: { readonly conversationId: string; readonly text: string; readonly instanceId?: string }): { readonly inserted: boolean; readonly eventId: string }
  listMessages(pluginId: string, options: { readonly conversationId?: string; readonly limit?: number; readonly before?: number; readonly instanceId?: string }): readonly StoredMessage[]
  executeIdempotent(pluginId: string, action: string, params: JsonObject, requestId: string, execute: () => Promise<JsonValue>, scope?: { readonly instanceId: string; readonly accountId: string }): Promise<JsonValue>
}

export interface StoredMessage {
  readonly sequence: number
  readonly eventId: string
  readonly pluginId: string
  readonly instanceId: string | null
  readonly conversationId: string | null
  readonly receivedAt: string
  readonly text: string
  readonly raw: JsonObject
  readonly harnessStatus: 'not-forwarded' | 'pending' | 'delivering' | 'accepted' | 'uncertain'
}

export interface BackendPlugin {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly capabilities: readonly PluginCapability[]
  readonly tools: readonly PluginToolDefinition[]
  getStatus(): ConnectionStatus
  getPublicConfiguration(): JsonObject
  updateConfiguration(input: unknown): Promise<JsonObject>
  connect(): Promise<void>
  disconnect(): Promise<void>
  invoke(name: string, input: unknown, requestId: string): Promise<JsonValue>
  dispose(): Promise<void>
}

export interface BackendPluginEntry {
  readonly id: string
  readonly storageDirectory: string
  create(context: HostPluginContext): BackendPlugin
}

export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly outcome: 'not-sent' | 'failed' | 'unknown' = 'failed',
  ) { super(message); this.name = 'PlatformError' }
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key) && isJsonValue(entry))
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 10000 && value.every(isJsonValue)
  return isJsonObject(value)
}
