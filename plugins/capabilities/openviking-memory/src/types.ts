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
  autoCommit: boolean
  commitTokenThreshold: number
  recallLimit: number
  recallMaxChars: number
  scoreThreshold: number
  rules: ScopeRule[]
}
export interface MemoryConfiguration {
  schemaVersion: 3
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
export type ExtractionStatus = 'queued' | 'syncing' | 'synced' | 'committing' | 'processing' | 'completed' | 'failed' | 'unknown'
export type CommitTrigger = 'threshold' | 'manual' | 'compaction' | 'shutdown'
export interface MemoryJob {
  id: string
  kind: 'append' | 'commit'
  trigger: CommitTrigger | null
  peerId: string
  sessionId: string
  commitId: string | null
  taskId: string | null
  archiveUri: string | null
  status: ExtractionStatus
  createdAt: string
  updatedAt: string
  messages: number
  syncedMessages: number
  pendingTokens: number | null
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
  autoCommit: true, commitTokenThreshold: 20000, recallLimit: 6, recallMaxChars: 4800, scoreThreshold: 0.35, rules: [],
}
