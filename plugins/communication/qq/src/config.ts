export interface OneBotConfig {
  readonly displayName: string
  readonly endpoint: string
  readonly accessToken: string
  readonly autoConnect: boolean
  readonly forwardToHarness: boolean
  readonly receiveGroups: boolean
  readonly timeoutMs: number
}
