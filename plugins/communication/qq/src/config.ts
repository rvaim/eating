export type QQAgentTypeId = 'qq.private' | 'qq.group'
export type QQAgentTools = Record<QQAgentTypeId, string[]>

export interface QQAgentPolicy {
  readonly owners: string[]
  readonly administrators: string[]
  readonly agentTools: QQAgentTools
  readonly policyRevision: number
}

export interface OneBotConnectionConfig {
  readonly endpoint: string
  readonly accessToken: string
  readonly timeoutMs: number
}

export interface OneBotConfig extends QQAgentPolicy, OneBotConnectionConfig {
  readonly displayName: string
  readonly autoConnect: boolean
  readonly forwardToHarness: boolean
  readonly receiveGroups: boolean
}
