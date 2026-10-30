import type { JsonObject, JsonValue } from './index'

/** Plugin-owned role definition; the Host attaches plugin identity and enablement. */
export interface AgentTypeDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly localizedTitles?: Readonly<Record<string, string>>
  readonly conversationKind: 'private' | 'group'
  readonly defaultPrompt: string
  readonly availableTools: readonly string[]
  readonly defaultTools: readonly string[]
  readonly enabledTools: readonly string[]
}

export interface AgentInstructions {
  readonly id: string
  readonly title: string
  readonly localizedTitles?: Readonly<Record<string, string>>
  readonly body: string
}

export interface AgentIdentityConfiguration {
  readonly owners: readonly string[]
  readonly administrators: readonly string[]
}

export interface RegisteredAgentType extends AgentTypeDefinition {
  readonly pluginId: string
  readonly pluginName: string
  readonly enabled: boolean
  readonly identity: AgentIdentityConfiguration
}

export interface RegisteredAgentInstructions extends AgentInstructions {
  readonly pluginId: string
  readonly pluginName: string
  readonly enabled: boolean
}

/** Trusted runtime binding, never accepted from an LLM tool's argument object. */
export interface AgentInvocationScope {
  /** In-memory invocation lifetime; never persisted or supplied by model arguments. */
  readonly signal?: AbortSignal
  readonly agentId: string
  readonly agentTypeId: string
  readonly pluginId: string
  readonly instanceId: string
  readonly accountId: string
  readonly conversationId: string
  readonly kind: 'private' | 'group'
  readonly targetId: string
  readonly messageIds: readonly string[]
  readonly resourceIds: readonly string[]
}

export interface AgentActionReceipt {
  readonly requestId: string
  readonly tool: string
  readonly outcome: 'succeeded' | 'failed' | 'unknown' | 'not-sent'
  readonly result?: JsonValue
  readonly code?: string
}

export interface AgentMcpConnection {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export interface HarnessSessionSummary {
  readonly id: string
  readonly parentId: string | null
  readonly title: string
  readonly agentTypeId?: string
  readonly pluginId?: string
  readonly pluginName?: string
  readonly instanceId?: string
  readonly accountId?: string
  readonly conversationKind?: 'private' | 'group'
  readonly targetId?: string
  readonly status: 'running' | 'idle' | 'stopped' | 'unknown'
  readonly updatedAt: string | null
  readonly configurationRevision?: number
}

export interface HarnessPlatformMessage {
  readonly eventId: string
  readonly pluginId: string
  readonly instanceId: string
  readonly accountId: string
  readonly conversationId: string
  readonly conversationKind: 'private' | 'group'
  readonly senderId: string
  readonly senderName?: string
  readonly targetId: string
  readonly messageId?: string
  readonly receivedAt: string
  readonly text?: string
}

export interface HarnessSessionRecord {
  readonly sequence: number
  readonly timestamp: string | null
  readonly kind: string
  readonly role?: string
  readonly content: JsonValue
  readonly messageId?: string
  readonly turn?: number
  readonly step?: number
  readonly callId?: string
  readonly source?: { readonly kind: string; readonly form?: string; readonly senderSessionId?: string; readonly summary?: string; readonly provider?: string; readonly model?: string }
  readonly classification?: 'platform-message' | 'agent-message' | 'subagent-settled' | 'time-context' | 'model-output' | 'system-context' | 'tool-call' | 'tool-result' | 'user-message' | 'runtime-context'
  readonly platformEvents?: readonly HarnessPlatformMessage[]
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  readonly sourceEventSeqs?: readonly number[]
}

export interface HarnessSessionList {
  readonly sessions: readonly HarnessSessionSummary[]
  readonly truncated: boolean
  readonly refreshedAt: string
}

export interface HarnessSessionContent {
  readonly session: HarnessSessionSummary
  readonly records: readonly HarnessSessionRecord[]
  readonly nextOffset: number | null
  readonly refreshedAt: string
}

export interface AgentPromptPreview {
  readonly revision: number
  readonly agentTypeId: string | null
  readonly layers: readonly { readonly id: string; readonly title: string; readonly revision: number; readonly body: string }[]
  readonly systemPrompt: string
  readonly bindings: JsonObject
}
