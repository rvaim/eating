import type { HarnessDeliveryBatch } from './index.js'

/** Conversation scope is provided by the trusted Harness/Host, never parsed from model tool arguments. */
export interface MemoryScope {
  readonly kind: 'private' | 'group' | 'self'
  readonly platform: string
  readonly accountId: string
  readonly targetId: string
  readonly owner: boolean
}
export interface MemoryContext {
  readonly agentId: string
  readonly agentTypeId: string
  readonly turnId: string
  readonly scope: MemoryScope
}
export interface MemoryMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly timestamp: string
  readonly senderId?: string
  readonly senderRole?: 'owner' | 'administrator' | 'user'
  readonly messageId?: string
}
export interface MemoryAction {
  readonly tool: string
  /** returned only means a function returned; it is not an external success receipt. */
  readonly outcome: 'returned' | 'succeeded' | 'failed' | 'unknown'
}
export interface MemoryHit { readonly uri: string; readonly text: string; readonly score: number }
export interface MemoryRecallResult {
  readonly text: string
  readonly items: readonly MemoryHit[]
  readonly errors?: readonly string[]
}
export interface MemoryCaptureInput {
  readonly context: MemoryContext
  readonly messages: readonly MemoryMessage[]
  readonly actions: readonly MemoryAction[]
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly immediate?: boolean
}
export interface MemoryProvider {
  recall(context: MemoryContext, query: string, signal?: AbortSignal): Promise<MemoryRecallResult>
  capture(input: MemoryCaptureInput): Promise<void>
  flush?(): Promise<void>
}
export interface MemoryBeginInput {
  readonly agentId: string
  readonly agentTypeId: string
  readonly turnId: string
  readonly batch?: HarnessDeliveryBatch
  readonly messages?: readonly MemoryMessage[]
  readonly autonomous?: boolean
  readonly query?: string
}
export interface MemoryAppendInput {
  readonly agentId: string
  readonly turnId: string
  readonly messages: readonly MemoryMessage[]
}
export interface MemoryFinishInput {
  readonly agentId: string
  readonly turnId: string
  readonly assistantText: string
  readonly actions: readonly MemoryAction[]
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}
export interface HarnessMemoryServices {
  begin(input: MemoryBeginInput, signal?: AbortSignal): Promise<MemoryRecallResult>
  append(input: MemoryAppendInput, signal?: AbortSignal): Promise<MemoryRecallResult>
  finish(input: MemoryFinishInput): Promise<void>
  end(agentId: string, turnId: string): void
}
