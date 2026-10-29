export * from './authoring.js'
export * from './agents.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

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
  readonly resultFormat: 'json' | 'content'
  readonly protocolAction?: string
  readonly sensitiveResult?: boolean
}

export type PluginToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' }

export interface PluginContentResult {
  readonly content: readonly PluginToolContent[]
  readonly structuredContent?: JsonObject
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
  readonly messageId?: string
  readonly targetId?: string
  readonly resourceIds?: readonly string[]
  readonly receivedAt: string
  readonly source: { readonly trust: 'external'; readonly kind: 'private' | 'group'; readonly senderRole?: 'owner' | 'administrator' | 'user' }
  readonly content: JsonValue
  readonly text: string
}

export interface DeliverySettings {
  readonly storageMode: 'persistent' | 'memory'
  readonly maxQueuedMessages: number
  readonly maxQueuedBytes: number
  readonly overflowPolicy: 'reject-new' | 'drop-oldest'
  readonly quietWindowMs: number
  readonly maxWaitMs: number
  readonly maxBatchMessages: number
  readonly batchTargetBytes: number
  readonly deliveryTimeoutMs: number
  readonly retryIntervalMs: number
  readonly maxDeliveryAttempts: number
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = Object.freeze({
  storageMode: 'persistent', maxQueuedMessages: 1000, maxQueuedBytes: 10 * 1024 * 1024,
  overflowPolicy: 'reject-new', quietWindowMs: 500, maxWaitMs: 2000,
  maxBatchMessages: 10, batchTargetBytes: 32 * 1024, deliveryTimeoutMs: 15000,
  retryIntervalMs: 10000, maxDeliveryAttempts: 5,
})

export interface DeliveryQueueStats {
  readonly storageMode: DeliverySettings['storageMode']
  readonly pending: number
  readonly delivering: number
  readonly uncertain: number
  readonly queuedMessages: number
  readonly queuedBytes: number
  readonly accepted: number
  readonly rejected: number
  readonly discarded: number
  readonly dedupIdentifiers: number
  readonly overCapacity: boolean
  readonly lastQueueError: string | null
}

export interface DeliverySettingsSnapshot {
  readonly protocolVersion: 1
  readonly revision: number
  readonly values: DeliverySettings
  readonly queue: DeliveryQueueStats
}

export interface HarnessDeliveryBatch {
  readonly protocolVersion: 1
  readonly batchId: string
  readonly conversationId: string
  readonly createdAt: string
  readonly reason: 'quiet-window' | 'max-wait' | 'max-messages' | 'target-bytes'
  readonly events: readonly HarnessEvent[]
}

/** durable=true transfers ownership; it still does not mean model consumption. */
export interface HarnessDeliveryReceipt {
  readonly accepted: boolean
  readonly durable?: boolean
  readonly receiptId?: string
}

export interface HarnessMessageSink {
  readonly id: string
  isReady?(): boolean
  deliverBatch(batch: HarnessDeliveryBatch, signal: AbortSignal): Promise<HarnessDeliveryReceipt>
}

export function validateDeliverySettings(input: unknown): DeliverySettings {
  if (!isJsonObject(input)) throw new PlatformError('INVALID_DELIVERY_SETTINGS', '消息投递设置必须为对象。')
  const keys = Object.keys(DEFAULT_DELIVERY_SETTINGS)
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) throw new PlatformError('INVALID_DELIVERY_SETTINGS', '消息投递设置字段不完整或包含未知项。')
  if (!['persistent', 'memory'].includes(String(input.storageMode)) || !['reject-new', 'drop-oldest'].includes(String(input.overflowPolicy))) throw new PlatformError('INVALID_DELIVERY_SETTINGS', '队列存储方式或溢出处理无效。')
  const ranges: Readonly<Record<string, readonly [number, number]>> = {
    maxQueuedMessages: [1, 100000], maxQueuedBytes: [1024, 100 * 1024 * 1024],
    quietWindowMs: [0, 60000], maxWaitMs: [1, 300000], maxBatchMessages: [1, 200],
    batchTargetBytes: [256, 4 * 1024 * 1024], deliveryTimeoutMs: [100, 120000],
    retryIntervalMs: [100, 300000], maxDeliveryAttempts: [1, 20],
  }
  const labels: Readonly<Record<string, string>> = { maxQueuedMessages: '队列消息上限', maxQueuedBytes: '队列容量上限', quietWindowMs: '聚合静默时间', maxWaitMs: '最长聚合等待时间', maxBatchMessages: '单批消息上限', batchTargetBytes: '批次目标大小', deliveryTimeoutMs: '投递超时', retryIntervalMs: '拒收重试间隔', maxDeliveryAttempts: '最大投递尝试次数' }
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PlatformError('INVALID_DELIVERY_SETTINGS', `${labels[key] ?? '设置项'}需为 ${minimum} 至 ${maximum} 范围内的整数。`)
  }
  if (Number(input.maxWaitMs) < Number(input.quietWindowMs)) throw new PlatformError('INVALID_DELIVERY_SETTINGS', '最长聚合等待时间不能小于聚合静默时间。')
  if (Number(input.maxBatchMessages) > Number(input.maxQueuedMessages)) throw new PlatformError('INVALID_DELIVERY_SETTINGS', '单批消息上限不能大于队列消息上限。')
  if (Number(input.batchTargetBytes) > Number(input.maxQueuedBytes)) throw new PlatformError('INVALID_DELIVERY_SETTINGS', '批次目标大小不能大于队列容量上限。')
  return Object.freeze({ ...input }) as unknown as DeliverySettings
}

export interface HarnessOwnerConfiguration {
  readonly revision: number
  readonly prompts: readonly import('./authoring.js').PromptDocument[]
  readonly activePersona: import('./authoring.js').PersonaDocument | null
  readonly agentTypes: readonly import('./agents.js').RegisteredAgentType[]
  readonly pluginInstructions: readonly import('./agents.js').RegisteredAgentInstructions[]
  readonly bindings: Readonly<Record<string, string>>
}

export interface HarnessHostServices {
  registerSink(sink: HarnessMessageSink): () => void
  wake(): void
  readOwnerConfiguration(): HarnessOwnerConfiguration
  getMcpConnection(pluginId: string, scope: import('./agents.js').AgentInvocationScope): import('./agents.js').AgentMcpConnection
  readAgentActions(agentId: string): readonly import('./agents.js').AgentActionReceipt[]
  revokeAgentAccess(agentId: string): void
}

export interface HostPluginContext {
  /** Present only for installed, approved Harness plugins. */
  readonly harness?: HarnessHostServices
  readonly dataDirectory: string
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  recordEvent(pluginId: string, deduplicationKey: string, event: JsonObject, harnessEvent: HarnessEvent | null, metadata?: { readonly conversationId: string; readonly text: string; readonly instanceId?: string }): { readonly inserted: boolean; readonly eventId: string; readonly queued?: boolean; readonly admission?: 'queued' | 'not-forwarded' | 'rejected' }
  /** Diagnostic view of outstanding delivery only; never a chat archive. */
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

export interface PluginLogEntry {
  readonly id: string
  readonly timestamp: string
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly message: string
  readonly metadata?: JsonObject
}

/** No replay or retention: events exist only while a viewer subscribes. */
export interface PluginLogSource {
  subscribe(listener: (entry: PluginLogEntry) => void): () => void
}

export interface BackendPlugin {
  readonly kind: 'communication' | 'harness'
  manage?(operation: string, input: unknown): Promise<JsonValue>
  readonly logs?: PluginLogSource
  readonly id: string
  readonly name: string
  readonly version: string
  readonly capabilities: readonly PluginCapability[]
  readonly tools: readonly PluginToolDefinition[]
  readonly agentTypes?: readonly import('./agents.js').AgentTypeDefinition[]
  readonly agentInstructions?: readonly import('./agents.js').AgentInstructions[]
  getAgentIdentity?(): import('./agents.js').AgentIdentityConfiguration
  invokeScoped?(name: string, input: unknown, requestId: string, scope: import('./agents.js').AgentInvocationScope): Promise<JsonValue>
  getStatus(): ConnectionStatus
  getPublicConfiguration(): JsonObject
  updateConfiguration(input: unknown): Promise<JsonObject>
  connect(): Promise<void>
  disconnect(): Promise<void>
  invoke(name: string, input: unknown, requestId: string): Promise<JsonValue>
  dispose(): Promise<void>
}

export interface PluginPackageManifest {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly kind: 'communication' | 'harness'
  readonly apiVersion: 3
  readonly storageDirectory: string
  readonly backend: string
  readonly frontend: {
    readonly entry: string
    readonly style: string
    readonly order: number
    readonly brandColor: string
    readonly icon: string
  }
  readonly assets: readonly string[]
  readonly integrity: Readonly<Record<string, string>>
}

export interface BackendPluginEntry {
  readonly kind: 'communication' | 'harness'
  readonly id: string
  readonly storageDirectory: string
  readonly installed?: { readonly manifest: PluginPackageManifest; readonly directory: string }
  create(context: HostPluginContext): BackendPlugin
}

const platformErrorBrand = Symbol.for('eating.platform-error.v1')

export class PlatformError extends Error {
  readonly [platformErrorBrand] = true
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && (value as unknown as Record<symbol, unknown>)[Symbol.for('eating.platform-error.v1')] === true
  }
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
