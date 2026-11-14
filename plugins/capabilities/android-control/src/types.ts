export interface AndroidConfiguration {
  readonly schemaVersion: 1
  readonly revision: number
  readonly mode: 'local' | 'remote'
  readonly adbPath: string
  readonly workspace: string
  readonly endpoint: string
  readonly token: string
}
export type PublicAndroidConfiguration = Omit<AndroidConfiguration, 'token'> & { readonly tokenConfigured: boolean; readonly ready: boolean }
export interface ProcessRecord {
  readonly processId: string
  readonly requestId: string
  readonly actorId: string
  readonly intent: string
  readonly createdAt: string
  readonly terminal: boolean
  status: 'queued' | 'running' | 'exited' | 'unknown' | 'failed'
  exitCode: number | null
  signal: string | null
  stdoutBytes: number
  stderrBytes: number
  pid: number | null
}
