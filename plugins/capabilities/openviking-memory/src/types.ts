import type { MemoryScope } from '@eating/plugin-sdk'

export type MemberMode = 'all' | 'allowlist' | 'denylist'
export interface ScopeRule {
  id: string
  label: string
  platform: string
  accountId: string
  kind: 'private' | 'group'
  targetId: string
  capture: boolean
  recall: boolean
  memberMode: MemberMode
  memberIds: string[]
}
export interface MemorySettings {
  enabled: boolean
  autoCapture: boolean
  autoRecall: boolean
  globalMemory: boolean
  ownerCrossSession: boolean
  privateCapture: boolean
  privateRecall: boolean
  groupCapture: boolean
  groupRecall: boolean
  archiveMaxMiB: number
  recallLimit: number
  recallMaxChars: number
  scoreThreshold: number
  rules: ScopeRule[]
}
export interface MemoryConfiguration {
  schemaVersion: 2
  revision: number
  endpoint: string
  account: string
  user: string
  apiKeyConfigured: boolean
  autoConnect: boolean
  timeoutMs: number
  ready: boolean
  settings: MemorySettings
}
export interface MemoryConfigurationInput {
  expectedRevision: number
  endpoint: string
  account: string
  user: string
  apiKey?: string
  clearApiKey?: boolean
  autoConnect: boolean
  timeoutMs: number
  settings: MemorySettings
}
export type ExtractionStatus = 'queued' | 'submitting' | 'processing' | 'completed' | 'failed' | 'unknown'
export interface MemoryJob {
  id: string
  peerId: string
  sessionId: string
  taskId: string | null
  archiveUri: string | null
  status: ExtractionStatus
  createdAt: string
  updatedAt: string
  messages: number
  changes: { added: number; updated: number; deleted: number } | null
  errorCode: string | null
}
export interface ScopeSummary {
  peerId: string
  scope: MemoryScope
  label: string
  capture: boolean
  recall: boolean
  bufferedMessages: number
  lastSeenAt: string | null
}
export interface RuntimeSnapshot {
  ready: boolean
  lastErrorCode: string | null
  lastRecallAt: string | null
  lastCaptureAt: string | null
  todayExtractions: number
  pending: number
  jobs: MemoryJob[]
  scopes: ScopeSummary[]
}
export const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true, autoCapture: true, autoRecall: true, globalMemory: true, ownerCrossSession: true,
  privateCapture: true, privateRecall: true, groupCapture: false, groupRecall: true,
  archiveMaxMiB: 8, recallLimit: 6, recallMaxChars: 4800, scoreThreshold: 0.35, rules: [],
}
