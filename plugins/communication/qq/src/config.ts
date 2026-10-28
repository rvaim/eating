export type QQAgentTypeId = 'qq.private' | 'qq.group'
export type QQAgentTools = Record<QQAgentTypeId, string[]>

export interface QQAgentPolicy {
  readonly owners: string[]
  readonly administrators: string[]
  readonly agentTools: QQAgentTools
  readonly policyRevision: number
}

// Legacy configurations and transport-only callers may omit the policy.
// QQPlugin normalizes all policy fields before exposing or executing them.
export interface OneBotConfig extends Partial<QQAgentPolicy> {
  readonly displayName: string
  readonly endpoint: string
  readonly accessToken: string
  readonly autoConnect: boolean
  readonly forwardToHarness: boolean
  readonly receiveGroups: boolean
  readonly timeoutMs: number
}
