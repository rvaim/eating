import { isIPv4, isIPv6 } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { isJsonObject } from '@eating/plugin-sdk'
import type { AndroidConfiguration, AndroidConnectionMode, ConfigLoadState, PublicAndroidConfiguration, AdbDetectionSnapshot, AndroidDevicesSnapshot } from '../types'
import { object, readDocument, rejectError, stringField, writeDocument } from './files'

export const TOOLS_DIR_NAME = 'tools'
export const PLATFORM_TOOLS_DIR_NAME = 'platform-tools'
export const INSTALL_RECORD_NAME = 'install.json'
export const DEFAULT_WORKSPACE_NAME = 'workspace'

const UNINSTALL_NOTICE = '在宿主卸载本插件仍会保留工作目录、连接配置、动作回执和已安装工具；如需仅删除插件下载的 ADB 与安装临时文件，请在连接配置页点击“移除插件安装的 ADB”。'

export const DEFAULT_ANDROID_CONFIGURATION: AndroidConfiguration = {
  schemaVersion: 2,
  revision: 0,
  connectionMode: 'usb',
  networkAddress: '',
  defaultDevice: '',
  adbPath: '',
  workspace: '',
}

export function defaultWorkspacePath(dataDirectory: string): string {
  return join(dataDirectory, DEFAULT_WORKSPACE_NAME)
}

export function toolsDirectoryPath(dataDirectory: string): string {
  return join(dataDirectory, TOOLS_DIR_NAME)
}

export function platformToolsDirectoryPath(dataDirectory: string): string {
  return join(dataDirectory, TOOLS_DIR_NAME, PLATFORM_TOOLS_DIR_NAME)
}

export function installRecordPath(dataDirectory: string): string {
  return join(dataDirectory, TOOLS_DIR_NAME, INSTALL_RECORD_NAME)
}

export function pluginAdbExecutablePath(dataDirectory: string, platform: NodeJS.Platform = process.platform): string {
  return join(platformToolsDirectoryPath(dataDirectory), platform === 'win32' ? 'adb.exe' : 'adb')
}

export function validateAbsolutePath(value: unknown, code: string, label: string, options: { allowEmpty?: boolean; checkExistingDir?: boolean } = {}): string {
  const path = stringField(value, code, `${label}必须是有效字符串。`, 4096, options.allowEmpty ?? true)
  if (!path) return ''
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) {
    throw rejectError(code, `${label}必须是有效的绝对路径。`, 400)
  }
  if (options.checkExistingDir && existsSync(path) && !statSync(path).isDirectory()) {
    throw rejectError(code, `${label}指向的现有路径不是目录。`, 400)
  }
  return path
}

export function validateNetworkAddress(value: unknown, allowEmpty = false): string {
  const raw = stringField(value, 'ANDROID_NETWORK_ADDRESS_INVALID', '网络 ADB 地址不能为空，格式为 主机:端口，例如 192.168.1.50:5555 或 [::1]:5555。', 255, allowEmpty)
  if (!raw) return ''
  if (/[\s\r\n\0/?#@\\]/.test(raw) || raw.includes('://')) {
    throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '网络 ADB 地址只接受 主机:端口（不支持 URL 协议、路径、空格或凭据）。', 400)
  }
  let host = ''
  let portText = ''
  if (raw.startsWith('[')) {
    const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw)
    if (!match) {
      throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', 'IPv6 地址必须使用方括号加端口，例如 [::1]:5555。', 400)
    }
    host = match[1]!
    portText = match[2]!
    const zoneIndex = host.indexOf('%')
    const baseIpv6 = zoneIndex >= 0 ? host.slice(0, zoneIndex) : host
    const zoneId = zoneIndex >= 0 ? host.slice(zoneIndex + 1) : ''
    if (!isIPv6(baseIpv6) || (zoneIndex >= 0 && !/^[A-Za-z0-9._-]+$/.test(zoneId))) {
      throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '方括号内不是有效的 IPv6 地址。', 400)
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '网络 ADB 端口必须是 1 到 65535 的整数。', 400)
    }
    return `[${host}]:${port}`
  }

  const colon = raw.lastIndexOf(':')
  if (colon <= 0 || colon === raw.length - 1) {
    throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '请使用 主机:端口 格式（IPv4、域名或 [IPv6]:端口）。', 400)
  }
  host = raw.slice(0, colon)
  portText = raw.slice(colon + 1)
  if (host.includes(':')) {
    throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', 'IPv6 地址必须使用方括号包裹，例如 [::1]:5555。', 400)
  }
  if (!/^\d{1,5}$/.test(portText)) {
    throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '网络 ADB 端口必须是 1 到 65535 的整数。', 400)
  }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '网络 ADB 端口必须是 1 到 65535 的整数。', 400)
  }

  if (/^\d+(?:\.\d+)*$/.test(host)) {
    if (!isIPv4(host)) {
      throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', 'IPv4 地址格式不正确。', 400)
    }
    return `${host}:${port}`
  }

  const normalizedHost = host.endsWith('.') ? host.slice(0, -1) : host
  const labels = normalizedHost.split('.')
  const validDomain =
    normalizedHost.length > 0 &&
    normalizedHost.length <= 253 &&
    labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  if (!validDomain) {
    throw rejectError('ANDROID_NETWORK_ADDRESS_INVALID', '主机名或域名格式不正确。', 400)
  }
  return `${normalizedHost}:${port}`
}

export function validateDeviceSerial(value: unknown, allowEmpty = true): string {
  const serial = stringField(value, 'ANDROID_DEVICE_INVALID', '设备标识不能为空。', 255, allowEmpty)
  if (!serial) return ''
  if (/[\s\r\n\0]/.test(serial)) {
    throw rejectError('ANDROID_DEVICE_INVALID', '设备标识不能包含空格或控制字符。', 400)
  }
  return serial
}

function validateConnectionMode(value: unknown): AndroidConnectionMode {
  if (value === 'usb' || value === 'network') return value
  throw rejectError('ANDROID_CONFIGURATION_INVALID', '连接方式必须是 usb 或 network。', 400)
}

function parseStrictV2(raw: unknown): { config: AndroidConfiguration; state: ConfigLoadState; errorCode: string | null; errorMessage: string | null; observedRevision: number } {
  if (!isJsonObject(raw)) {
    return {
      config: DEFAULT_ANDROID_CONFIGURATION,
      state: 'corrupted',
      errorCode: 'ANDROID_CONFIGURATION_INVALID',
      errorMessage: '手机连接配置文件结构无效，原文件保持未改动；请由主人明确执行“重建连接配置”。',
      observedRevision: 0,
    }
  }
  const observedRevision = typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
  if (raw.schemaVersion === 1 || 'mode' in raw || 'endpoint' in raw || 'token' in raw) {
    return {
      config: DEFAULT_ANDROID_CONFIGURATION,
      state: 'legacy-unsupported',
      errorCode: 'ANDROID_LEGACY_CONFIGURATION_UNSUPPORTED',
      errorMessage: '检测到旧版远程执行端连接配置（v1），已停止自动迁移或复用；原文件完整保留，请确认后点击“重建连接配置”。',
      observedRevision,
    }
  }
  if (raw.schemaVersion !== 2) {
    return {
      config: DEFAULT_ANDROID_CONFIGURATION,
      state: 'corrupted',
      errorCode: 'ANDROID_CONFIGURATION_INVALID',
      errorMessage: '手机连接配置文件版本不支持，原文件保持未改动；请由主人明确执行“重建连接配置”。',
      observedRevision,
    }
  }
  const allowedKeys = new Set(['schemaVersion', 'revision', 'connectionMode', 'networkAddress', 'defaultDevice', 'adbPath', 'workspace'])
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) {
    return {
      config: DEFAULT_ANDROID_CONFIGURATION,
      state: 'corrupted',
      errorCode: 'ANDROID_CONFIGURATION_INVALID',
      errorMessage: '手机连接配置文件包含未知字段，原文件保持未改动；请确认后重建配置。',
      observedRevision,
    }
  }
  try {
    if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new Error('invalid revision')
    const connectionMode = validateConnectionMode(raw.connectionMode)
    const networkAddress = validateNetworkAddress(raw.networkAddress, true)
    const defaultDevice = validateDeviceSerial(raw.defaultDevice, true)
    const adbPath = validateAbsolutePath(raw.adbPath, 'ANDROID_CONFIGURATION_INVALID', 'ADB')
    const workspace = validateAbsolutePath(raw.workspace, 'ANDROID_CONFIGURATION_INVALID', '工作目录', { checkExistingDir: true })
    return {
      config: {
        schemaVersion: 2,
        revision: Number(raw.revision),
        connectionMode,
        networkAddress,
        defaultDevice,
        adbPath,
        workspace,
      },
      state: 'ok',
      errorCode: null,
      errorMessage: null,
      observedRevision,
    }
  } catch {
    return {
      config: DEFAULT_ANDROID_CONFIGURATION,
      state: 'corrupted',
      errorCode: 'ANDROID_CONFIGURATION_INVALID',
      errorMessage: '手机连接配置文件字段校验失败，原文件保持未改动；请确认后重建配置。',
      observedRevision,
    }
  }
}

export class AndroidConfig {
  readonly file: string
  private value: AndroidConfiguration = DEFAULT_ANDROID_CONFIGURATION
  private _state: ConfigLoadState = 'ok'
  private _errorCode: string | null = null
  private _errorMessage: string | null = null
  private _observedRevision = 0

  constructor(private readonly dataDirectory: string) {
    this.file = join(dataDirectory, 'config.json')
    this.reload()
  }

  reload(): void {
    try {
      const raw = readDocument(this.file)
      if (raw === null) {
        this.value = DEFAULT_ANDROID_CONFIGURATION
        this._state = 'ok'
        this._errorCode = null
        this._errorMessage = null
        this._observedRevision = 0
        return
      }
      const parsed = parseStrictV2(raw)
      this.value = parsed.config
      this._state = parsed.state
      this._errorCode = parsed.errorCode
      this._errorMessage = parsed.errorMessage
      this._observedRevision = parsed.observedRevision
    } catch {
      this.value = DEFAULT_ANDROID_CONFIGURATION
      this._state = 'corrupted'
      this._errorCode = 'ANDROID_CONFIGURATION_INVALID'
      this._errorMessage = '无法解析手机连接配置文件，原文件保持未改动；请由主人确认后重建连接配置。'
    }
  }

  get loadState(): ConfigLoadState {
    return this._state
  }

  get errorCode(): string | null {
    return this._errorCode
  }

  get errorMessage(): string | null {
    return this._errorMessage
  }

  assertValid(): AndroidConfiguration {
    if (this._state !== 'ok') {
      throw rejectError(
        this._errorCode ?? 'ANDROID_CONFIGURATION_INVALID',
        this._errorMessage ?? '手机连接配置无效，请先重建连接配置。',
        409,
      )
    }
    return this.value
  }

  current(): AndroidConfiguration {
    return this.value
  }

  workspacePath(): string {
    return this.value.workspace ? resolve(this.value.workspace) : defaultWorkspacePath(this.dataDirectory)
  }

  update(input: unknown): AndroidConfiguration {
    const existing = this.assertValid()
    const body = object(input, ['expectedRevision', 'connectionMode', 'networkAddress', 'defaultDevice', 'adbPath', 'workspace'], ['expectedRevision', 'connectionMode'])
    if (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== existing.revision) {
      throw rejectError('ANDROID_CONFIGURATION_CONFLICT', '连接配置已被其他操作更新，请刷新后重试。', 409)
    }
    const next: AndroidConfiguration = {
      schemaVersion: 2,
      revision: existing.revision + 1,
      connectionMode: validateConnectionMode(body.connectionMode),
      networkAddress: validateNetworkAddress(body.networkAddress ?? '', true),
      defaultDevice: validateDeviceSerial(body.defaultDevice ?? '', true),
      adbPath: validateAbsolutePath(body.adbPath ?? '', 'ANDROID_CONFIGURATION_INVALID', 'ADB'),
      workspace: validateAbsolutePath(body.workspace ?? '', 'ANDROID_CONFIGURATION_INVALID', '工作目录', { checkExistingDir: true }),
    }
    writeDocument(this.file, next)
    this.value = next
    this._observedRevision = next.revision
    return next
  }

  saveTargetState(patch: { connectionMode?: AndroidConnectionMode; networkAddress?: string; defaultDevice?: string }): AndroidConfiguration {
    const existing = this.assertValid()
    const nextConnectionMode = patch.connectionMode ?? existing.connectionMode
    const nextNetworkAddress = patch.networkAddress !== undefined ? validateNetworkAddress(patch.networkAddress, true) : existing.networkAddress
    const nextDefaultDevice = patch.defaultDevice !== undefined ? validateDeviceSerial(patch.defaultDevice, true) : existing.defaultDevice
    if (
      nextConnectionMode === existing.connectionMode &&
      nextNetworkAddress === existing.networkAddress &&
      nextDefaultDevice === existing.defaultDevice
    ) {
      return existing
    }
    const next: AndroidConfiguration = {
      ...existing,
      revision: existing.revision + 1,
      connectionMode: nextConnectionMode,
      networkAddress: nextNetworkAddress,
      defaultDevice: nextDefaultDevice,
    }
    writeDocument(this.file, next)
    this.value = next
    this._observedRevision = next.revision
    return next
  }

  rebuild(input: unknown): AndroidConfiguration {
    const body = object(input, ['confirmed'], ['confirmed'])
    if (body.confirmed !== true) {
      throw rejectError('ANDROID_REBUILD_CONFIRMATION_REQUIRED', '重建连接配置需要主人明确确认。', 400)
    }
    const nextRevision = Math.max(this._observedRevision, this.value.revision) + 1
    const next: AndroidConfiguration = {
      schemaVersion: 2,
      revision: nextRevision,
      connectionMode: 'usb',
      networkAddress: '',
      defaultDevice: '',
      adbPath: '',
      workspace: '',
    }
    writeDocument(this.file, next)
    this.value = next
    this._state = 'ok'
    this._errorCode = null
    this._errorMessage = null
    this._observedRevision = next.revision
    return next
  }

  publicView(options: {
    readonly connected: boolean
    readonly adbEnvironment: AdbDetectionSnapshot | null
    readonly devices: AndroidDevicesSnapshot | null
  }): PublicAndroidConfiguration {
    const config = this.value
    const adbAvailable = Boolean(this._state === 'ok' && options.adbEnvironment?.available)
    const deviceList = options.devices?.devices ?? []
    const deviceOnline = Boolean(options.devices?.deviceOnline && options.devices.activeDevice?.online)
    return {
      configState: this._state,
      configErrorCode: this._errorCode,
      configErrorMessage: this._errorMessage,
      configurationPath: this.file,
      schemaVersion: 2,
      revision: config.revision,
      connectionMode: config.connectionMode,
      networkAddress: config.networkAddress,
      defaultDevice: config.defaultDevice,
      adbPath: config.adbPath,
      adbPathConfigured: Boolean(config.adbPath),
      workspace: config.workspace,
      dataDirectory: this.dataDirectory,
      toolsDirectory: toolsDirectoryPath(this.dataDirectory),
      platformToolsDirectory: platformToolsDirectoryPath(this.dataDirectory),
      defaultWorkspace: defaultWorkspacePath(this.dataDirectory),
      hostPlatform: process.platform,
      hostArch: process.arch,
      connected: options.connected,
      ready: Boolean(this._state === 'ok' && options.connected && adbAvailable),
      adbAvailable,
      adbEnvironment: options.adbEnvironment,
      deviceOnline,
      activeDevice: options.devices?.activeDevice ?? null,
      devices: deviceList,
      deviceCheckErrorCode: options.devices?.errorCode ?? null,
      deviceCheckErrorMessage: options.devices?.errorMessage ?? null,
      uninstallNotice: UNINSTALL_NOTICE,
    }
  }
}
