export type AndroidConnectionMode = 'usb' | 'network'
export type AdbSourceKind = 'manual' | 'system' | 'plugin' | 'none'
export type ConfigLoadState = 'ok' | 'legacy-unsupported' | 'corrupted'
export type AndroidDeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown'

export interface AndroidConfiguration {
  readonly schemaVersion: 2
  readonly revision: number
  readonly connectionMode: AndroidConnectionMode
  readonly networkAddress: string
  readonly defaultDevice: string
  readonly adbPath: string
  readonly workspace: string
}

export interface PluginAdbInstallMetadata {
  readonly schemaVersion: 1
  readonly version: string
  readonly revision: string | null
  readonly url: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly license: string
  readonly licenseUrl: string
  readonly platform: string
  readonly arch: string
  readonly executablePath: string
  readonly installedAt: string
}

export interface AdbPlatformPackageDescriptor {
  readonly supported: boolean
  readonly platform: string
  readonly arch: string
  readonly targetLabel: string
  readonly version: string | null
  readonly sizeBytes: number | null
  readonly licenseName: string
  readonly licenseUrl: string
  readonly releaseNotesUrl: string
  readonly url: string | null
  readonly unsupportedReasonCode: string | null
  readonly unsupportedReason: string | null
}

export interface AdbDetectionSnapshot {
  readonly available: boolean
  readonly source: AdbSourceKind
  readonly version: string | null
  readonly path: string | null
  readonly systemAvailable: boolean
  readonly systemPath: string | null
  readonly systemVersion: string | null
  readonly pluginInstalled: boolean
  readonly pluginPath: string | null
  readonly pluginVersion: string | null
  readonly pluginInstallRecord: PluginAdbInstallMetadata | null
  readonly manualSpecified: boolean
  readonly manualValid: boolean
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly packageInfo: AdbPlatformPackageDescriptor
  readonly checkedAt: string
}

export interface AndroidDeviceEntry {
  readonly serial: string
  readonly state: AndroidDeviceState
  readonly online: boolean
  readonly transport: AndroidConnectionMode | 'unknown'
  readonly model: string | null
  readonly product: string | null
  readonly device: string | null
  readonly transportId: string | null
  readonly isDefault: boolean
}

export interface AndroidDevicesSnapshot {
  readonly queried: boolean
  readonly devices: readonly AndroidDeviceEntry[]
  readonly activeDevice: AndroidDeviceEntry | null
  readonly onlineCount: number
  readonly deviceOnline: boolean
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly checkedAt: string
}

export interface PublicAndroidConfiguration {
  readonly configState: ConfigLoadState
  readonly configErrorCode: string | null
  readonly configErrorMessage: string | null
  readonly configurationPath: string
  readonly schemaVersion: 2
  readonly revision: number
  readonly connectionMode: AndroidConnectionMode
  readonly networkAddress: string
  readonly defaultDevice: string
  readonly adbPath: string
  readonly adbPathConfigured: boolean
  readonly workspace: string
  readonly dataDirectory: string
  readonly toolsDirectory: string
  readonly platformToolsDirectory: string
  readonly defaultWorkspace: string
  readonly hostPlatform: string
  readonly hostArch: string
  readonly connected: boolean
  readonly ready: boolean
  readonly adbAvailable: boolean
  readonly adbEnvironment: AdbDetectionSnapshot | null
  readonly deviceOnline: boolean
  readonly activeDevice: AndroidDeviceEntry | null
  readonly devices: readonly AndroidDeviceEntry[]
  readonly deviceCheckErrorCode: string | null
  readonly deviceCheckErrorMessage: string | null
  readonly uninstallNotice: string
}

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

export interface AndroidTargetPolicy {
  readonly connectionMode: AndroidConnectionMode
  readonly networkAddress: string
  readonly defaultDevice: string
}
