export interface QQMediaDirectoryMapping {
  readonly sourceRoot: string
  readonly hostMappingRoot: string
  readonly onebotRoot: string
  readonly ownerConfirmed: boolean
}
export interface QQMediaTransportSettings {
  readonly schemaVersion: 1
  readonly revision: number
  readonly mode: 'auto' | 'shared-directory'
  readonly mapping: QQMediaDirectoryMapping | null
  readonly fileEligible: boolean
}
