import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { PlatformError } from '@eating/plugin-sdk'
import type {
  AdbDetectionSnapshot,
  AdbPlatformPackageDescriptor,
  AndroidConfiguration,
  AndroidConnectionMode,
  AndroidDeviceEntry,
  AndroidDeviceState,
  AndroidDevicesSnapshot,
  PluginAdbInstallMetadata,
} from '../types'
import {
  installRecordPath,
  platformToolsDirectoryPath,
  pluginAdbExecutablePath,
  toolsDirectoryPath,
  validateNetworkAddress,
} from './config'
import { readDocument, rejectError, stringField, writeDocument } from './files'

export const OFFICIAL_REPOSITORY_URL = 'https://dl.google.com/android/repository/repository2-3.xml'
export const OFFICIAL_RELEASE_NOTES_URL = 'https://developer.android.com/tools/releases/platform-tools'
export const OFFICIAL_LICENSE_NAME = 'Android SDK License Agreement'
export const OFFICIAL_LICENSE_URL = 'https://developer.android.com/studio/terms'

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 384 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024 * 1024
const ADB_VERSION_TIMEOUT_MS = 8000
const ADB_NETWORK_TIMEOUT_MS = 15000
const DOWNLOAD_TIMEOUT_MS = 120000

export interface AdbManagerOptions {
  readonly repositoryUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly env?: NodeJS.ProcessEnv
  readonly homeDir?: string
  readonly skipWellKnownPaths?: boolean
}

interface HostTarget {
  readonly supported: boolean
  readonly hostOs: 'macosx' | 'linux' | 'windows' | null
  readonly targetLabel: string
  readonly unsupportedReasonCode: string | null
  readonly unsupportedReason: string | null
}

interface ParsedArchive {
  readonly version: string
  readonly sizeBytes: number
  readonly checksumType: 'sha256' | 'sha1'
  readonly checksum: string
  readonly url: string
  readonly licenseRef: string
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1')
}

function validateDownloadUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw rejectError('ANDROID_INSTALL_URL_INVALID', 'Platform-Tools 下载地址无效。', 502)
  }
  if (parsed.protocol === 'https:' || isLoopbackHttpUrl(parsed)) {
    return parsed.toString()
  }
  throw rejectError('ANDROID_INSTALL_URL_INVALID', 'Platform-Tools 下载地址仅允许 HTTPS（或本地回环测试地址）。', 400)
}

export function resolveRepositoryUrl(configured?: string): string {
  if (configured) return validateDownloadUrl(configured)
  const testUrl = process.env.EATING_ANDROID_TEST_REPOSITORY_URL?.trim()
  if (testUrl) {
    let parsed: URL
    try {
      parsed = new URL(testUrl)
    } catch {
      throw rejectError('ANDROID_INSTALL_URL_INVALID', '测试仓库地址无效。', 400)
    }
    if (!isLoopbackHttpUrl(parsed)) {
      throw rejectError('ANDROID_INSTALL_URL_INVALID', 'EATING_ANDROID_TEST_REPOSITORY_URL 只允许本地回环地址。', 400)
    }
    return parsed.toString()
  }
  return OFFICIAL_REPOSITORY_URL
}

export function describeHostPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): HostTarget {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return {
      supported: true,
      hostOs: 'macosx',
      targetLabel: `macOS (${arch}, Universal Platform-Tools)`,
      unsupportedReasonCode: null,
      unsupportedReason: null,
    }
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      supported: true,
      hostOs: 'linux',
      targetLabel: 'Linux (x86_64)',
      unsupportedReasonCode: null,
      unsupportedReason: null,
    }
  }
  if (platform === 'win32' && arch === 'x64') {
    return {
      supported: true,
      hostOs: 'windows',
      targetLabel: 'Windows (x64)',
      unsupportedReasonCode: null,
      unsupportedReason: null,
    }
  }
  return {
    supported: false,
    hostOs: null,
    targetLabel: `${platform} (${arch})`,
    unsupportedReasonCode: 'ANDROID_PLATFORM_UNSUPPORTED',
    unsupportedReason: `Google 官方 Android SDK Platform-Tools 未提供适用于 ${platform} / ${arch} 架构的预编译发行包（官方仅提供 macOS arm64/x64、Linux x64、Windows x64）。请在系统手动安装适配构建后，在“高级配置”填写自定义 ADB 绝对路径。`,
  }
}

export function basePackageDescriptor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AdbPlatformPackageDescriptor {
  const target = describeHostPlatform(platform, arch)
  return {
    supported: target.supported,
    platform,
    arch,
    targetLabel: target.targetLabel,
    version: null,
    sizeBytes: null,
    licenseName: OFFICIAL_LICENSE_NAME,
    licenseUrl: OFFICIAL_LICENSE_URL,
    releaseNotesUrl: OFFICIAL_RELEASE_NOTES_URL,
    url: null,
    unsupportedReasonCode: target.unsupportedReasonCode,
    unsupportedReason: target.unsupportedReason,
  }
}

export function parsePlatformToolsPackage(xml: string, hostOs: 'macosx' | 'linux' | 'windows', repositoryUrl: string): ParsedArchive {
  const packageMatch = /<remotePackage\b[^>]*\bpath="platform-tools"[^>]*>([\s\S]*?)<\/remotePackage>/.exec(xml)
  if (!packageMatch) {
    throw rejectError('ANDROID_INSTALL_MANIFEST_INVALID', '官方仓库清单中未找到 platform-tools 软件包条目。', 502)
  }
  const block = packageMatch[1]!
  const major = /<major>(\d+)<\/major>/.exec(block)?.[1]
  const minor = /<minor>(\d+)<\/minor>/.exec(block)?.[1] ?? '0'
  const micro = /<micro>(\d+)<\/micro>/.exec(block)?.[1] ?? '0'
  if (!major) {
    throw rejectError('ANDROID_INSTALL_MANIFEST_INVALID', '无法读取 Platform-Tools 版本号。', 502)
  }
  const version = `${major}.${minor}.${micro}`
  const licenseRef = /<uses-license\b[^>]*\bref="([^"]+)"/.exec(block)?.[1] ?? 'android-sdk-license'

  const archives = [...block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map(match => match[1]!)
  for (const archive of archives) {
    const osTag = /<host-os>([^<]+)<\/host-os>/.exec(archive)?.[1]?.trim()
    if (osTag !== hostOs) continue
    const archTag = /<host-arch>([^<]+)<\/host-arch>/.exec(archive)?.[1]?.trim()
    if (archTag && archTag !== 'x64') continue
    const complete = /<complete>([\s\S]*?)<\/complete>/.exec(archive)?.[1] ?? archive
    const sizeRaw = /<size>(\d+)<\/size>/.exec(complete)?.[1]
    const checksumMatch = /<checksum(?:\s+type="(sha256|sha1)")?>([a-fA-F0-9]+)<\/checksum>/.exec(complete)
    const relativeUrl = /<url>([^<]+)<\/url>/.exec(complete)?.[1]?.trim()
    if (!sizeRaw || !checksumMatch || !relativeUrl) continue
    const sizeBytes = Number(sizeRaw)
    const checksumType = (checksumMatch[1] ?? (checksumMatch[2]!.length === 64 ? 'sha256' : 'sha1')) as 'sha256' | 'sha1'
    const checksum = checksumMatch[2]!.toLowerCase()
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ARCHIVE_BYTES) {
      throw rejectError('ANDROID_INSTALL_MANIFEST_INVALID', 'Platform-Tools 安装包大小超出预期范围。', 502)
    }
    const expectedHexLength = checksumType === 'sha256' ? 64 : 40
    if (checksum.length !== expectedHexLength) {
      throw rejectError('ANDROID_INSTALL_MANIFEST_INVALID', 'Platform-Tools 校验摘要格式无效。', 502)
    }
    const resolvedUrl = validateDownloadUrl(new URL(relativeUrl, repositoryUrl).toString())
    return { version, sizeBytes, checksumType, checksum, url: resolvedUrl, licenseRef }
  }
  throw rejectError('ANDROID_PLATFORM_UNSUPPORTED', `官方软件源未包含适用于 ${hostOs} 的 Platform-Tools 压缩包。`, 400)
}

function validateArchiveEntryName(rawName: string): string {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')) {
    throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '安装包包含非法路径分隔符或空字符。', 502)
  }
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '安装包包含绝对路径条目，已拒绝解压。', 502)
  }
  const normalized = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
  const parts = normalized.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '安装包包含目录穿越路径条目，已拒绝解压。', 502)
  }
  return rawName
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 65557)
  for (let offset = zip.length - 22; offset >= minOffset; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      const commentLen = zip.readUInt16LE(offset + 20)
      if (offset + 22 + commentLen === zip.length) return offset
    }
  }
  throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '压缩包损坏：缺少 ZIP 中央目录结束标记。', 502)
}

/** Pure Node ZIP extractor with zip-slip, symlink, size-limit, and CRC-32 checks. */
export function extractPlatformToolsZip(zipBytes: Buffer, destinationDir: string): void {
  const targetRoot = resolve(destinationDir)
  mkdirSync(targetRoot, { recursive: true })
  const eocdOffset = findEndOfCentralDirectory(zipBytes)
  const diskNumber = zipBytes.readUInt16LE(eocdOffset + 4)
  const cdDisk = zipBytes.readUInt16LE(eocdOffset + 6)
  const totalEntries = zipBytes.readUInt16LE(eocdOffset + 10)
  const cdSize = zipBytes.readUInt32LE(eocdOffset + 12)
  const cdOffset = zipBytes.readUInt32LE(eocdOffset + 16)
  if (diskNumber !== 0 || cdDisk !== 0 || totalEntries === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocdOffset) {
    throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '不支持的分卷或损坏 ZIP 结构。', 502)
  }

  let cursor = cdOffset
  let extractedTotal = 0
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > eocdOffset || zipBytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', 'ZIP 中央目录条目损坏。', 502)
    }
    const flags = zipBytes.readUInt16LE(cursor + 8)
    const method = zipBytes.readUInt16LE(cursor + 10)
    const expectedCrc = zipBytes.readUInt32LE(cursor + 16) >>> 0
    const compressedSize = zipBytes.readUInt32LE(cursor + 20)
    const uncompressedSize = zipBytes.readUInt32LE(cursor + 24)
    const nameLen = zipBytes.readUInt16LE(cursor + 28)
    const extraLen = zipBytes.readUInt16LE(cursor + 30)
    const commentLen = zipBytes.readUInt16LE(cursor + 32)
    const externalAttr = zipBytes.readUInt32LE(cursor + 38)
    const localHeaderOffset = zipBytes.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLen + extraLen + commentLen > eocdOffset) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', 'ZIP 条目元信息越界。', 502)
    }
    const entryName = validateArchiveEntryName(zipBytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'))
    cursor += 46 + nameLen + extraLen + commentLen

    const posixFileType = (externalAttr >>> 16) & 0o170000
    if (posixFileType === 0o120000) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '安装包包含符号链接条目，已拒绝解压。', 502)
    }
    if ((flags & 0x0001) !== 0) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '不支持加密 ZIP 条目。', 502)
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '解压条目超出单文件上限。', 502)
    }

    const isDir = entryName.endsWith('/') || posixFileType === 0o040000
    const relPath = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName
    const outPath = resolve(targetRoot, relPath)
    if (outPath !== targetRoot && !outPath.startsWith(targetRoot + sep)) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '解压目标路径越界。', 502)
    }
    if (isDir) {
      mkdirSync(outPath, { recursive: true })
      continue
    }

    if (localHeaderOffset + 30 > cdOffset || zipBytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', 'ZIP 本地文件头损坏。', 502)
    }
    const localNameLen = zipBytes.readUInt16LE(localHeaderOffset + 26)
    const localExtraLen = zipBytes.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + compressedSize
    if (dataEnd > cdOffset) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', 'ZIP 压缩数据范围越界。', 502)
    }
    const payload = zipBytes.subarray(dataStart, dataEnd)
    let output: Buffer
    if (method === 0) {
      output = Buffer.from(payload)
    } else if (method === 8) {
      output = inflateRawSync(payload, { maxOutputLength: MAX_ENTRY_BYTES })
    } else {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', `不支持的 ZIP 压缩方式 (${method})。`, 502)
    }
    if (output.length !== uncompressedSize) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '解压后文件长度与 ZIP 声明不一致。', 502)
    }
    if ((crc32(output) >>> 0) !== expectedCrc) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '解压条目 CRC-32 校验失败。', 502)
    }
    extractedTotal += output.length
    if (extractedTotal > MAX_EXTRACTED_BYTES) {
      throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '安装包总解压体积超出上限。', 502)
    }
    mkdirSync(dirname(outPath), { recursive: true })
    const posixMode = (externalAttr >>> 16) & 0o777
    const fileMode = posixMode !== 0 ? posixMode : 0o644
    writeFileSync(outPath, output, { mode: fileMode })
    if (process.platform !== 'win32' && posixMode !== 0) {
      chmodSync(outPath, posixMode)
    }
  }
}

function runAdbCommand(executable: string, args: readonly string[], timeoutMs = ADB_VERSION_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      [...args],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') {
            rejectRun(error)
            return
          }
          const exitStatus = typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 1
          resolveRun({ stdout: stdout ?? '', stderr: stderr || error.message, exitCode: exitStatus })
          return
        }
        resolveRun({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 })
      },
    )
  })
}

export function parseAdbVersionOutput(output: string): string | null {
  const firstMatch = /Android Debug Bridge version\s+([^\r\n]+)/i.exec(output)
  if (!firstMatch) return null
  const versionDetail = /^Version\s+([^\r\n]+)/m.exec(output)?.[1]?.trim()
  return versionDetail ? `${firstMatch[1]!.trim()} (${versionDetail})` : firstMatch[1]!.trim()
}

async function probeAdbExecutable(candidate: string): Promise<{ valid: boolean; version: string | null; error: string | null }> {
  if (!candidate || !isAbsolute(candidate)) {
    return { valid: false, version: null, error: '路径不是有效的绝对路径。' }
  }
  try {
    const info = statSync(candidate)
    if (!info.isFile()) return { valid: false, version: null, error: '目标路径不是可执行文件。' }
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { valid: false, version: null, error: '文件不存在。' }
    if (code === 'EACCES') return { valid: false, version: null, error: '文件没有可执行权限。' }
    return { valid: false, version: null, error: '无法访问该 ADB 文件。' }
  }
  try {
    const result = await runAdbCommand(candidate, ['version'], ADB_VERSION_TIMEOUT_MS)
    const parsed = parseAdbVersionOutput(`${result.stdout}\n${result.stderr}`)
    if (result.exitCode !== 0 || !parsed) {
      return { valid: false, version: null, error: '运行 adb version 未返回有效版本信息。' }
    }
    return { valid: true, version: parsed, error: null }
  } catch {
    return { valid: false, version: null, error: '执行 adb version 失败。' }
  }
}

function isInsideDirectory(candidate: string, parentDir: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedParent = resolve(parentDir)
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(resolvedParent + sep)
}

function systemAdbCandidates(dataDirectory: string, options: AdbManagerOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const exe = platform === 'win32' ? 'adb.exe' : 'adb'
  const pluginTools = toolsDirectoryPath(dataDirectory)

  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (candidate: string) => {
    const clean = candidate.trim()
    if (!clean || !isAbsolute(clean)) return
    const normalized = resolve(clean)
    if (isInsideDirectory(normalized, pluginTools)) return
    if (!seen.has(normalized)) {
      seen.add(normalized)
      candidates.push(normalized)
    }
  }

  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (isAbsolute(dir)) push(join(dir, exe))
  }
  for (const sdkVar of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (sdkVar && isAbsolute(sdkVar.trim())) {
      push(join(sdkVar.trim(), 'platform-tools', exe))
    }
  }
  if (options.skipWellKnownPaths) return candidates
  if (platform === 'darwin') {
    push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', exe))
    push('/opt/homebrew/bin/adb')
    push('/usr/local/bin/adb')
  } else if (platform === 'linux') {
    push(join(home, 'Android', 'Sdk', 'platform-tools', exe))
    push('/usr/lib/android-sdk/platform-tools/adb')
    push('/opt/android-sdk/platform-tools/adb')
    push('/usr/local/android-sdk/platform-tools/adb')
    push('/usr/bin/adb')
    push('/usr/local/bin/adb')
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe))
    if (env.USERPROFILE) push(join(env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe))
  }
  return candidates
}

function readInstallRecord(dataDirectory: string): PluginAdbInstallMetadata | null {
  try {
    const raw = readDocument(installRecordPath(dataDirectory))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Partial<PluginAdbInstallMetadata>
    if (record.schemaVersion !== 1 || typeof record.version !== 'string' || typeof record.executablePath !== 'string') return null
    return record as PluginAdbInstallMetadata
  } catch {
    return null
  }
}

export function classifyTransport(serial: string, tokens: readonly string[]): AndroidConnectionMode | 'unknown' {
  if (/^\[[^\]]+\]:\d{1,5}$/.test(serial) || /^[^:]+:\d{1,5}$/.test(serial)) return 'network'
  if (tokens.some(token => token.startsWith('usb:'))) return 'usb'
  if (/^emulator-\d+$/.test(serial) || serial.length > 0) return 'usb'
  return 'unknown'
}

export function parseAdbDevicesOutput(stdout: string, defaultDevice: string): AndroidDevicesSnapshot {
  const devices: AndroidDeviceEntry[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('List of devices') || line.startsWith('* daemon')) continue
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const serial = match[1]!
    const stateRaw = match[2]!
    const rest = match[3] ? match[3].trim().split(/\s+/) : []
    const state: AndroidDeviceState =
      stateRaw === 'device' || stateRaw === 'offline' || stateRaw === 'unauthorized' ? stateRaw : 'unknown'
    let model: string | null = null
    let product: string | null = null
    let device: string | null = null
    let transportId: string | null = null
    for (const token of rest) {
      if (token.startsWith('model:')) model = token.slice(6) || null
      else if (token.startsWith('product:')) product = token.slice(8) || null
      else if (token.startsWith('device:')) device = token.slice(7) || null
      else if (token.startsWith('transport_id:')) transportId = token.slice(13) || null
    }
    devices.push({
      serial,
      state,
      online: state === 'device',
      transport: classifyTransport(serial, rest),
      model,
      product,
      device,
      transportId,
      isDefault: Boolean(defaultDevice && serial === defaultDevice),
    })
  }

  const onlineDevices = devices.filter(entry => entry.online)
  let activeDevice: AndroidDeviceEntry | null = null
  let errorCode: string | null = null
  let errorMessage: string | null = null

  if (defaultDevice) {
    activeDevice = devices.find(entry => entry.serial === defaultDevice) ?? null
    if (!activeDevice) {
      errorCode = 'ANDROID_DEFAULT_DEVICE_MISSING'
      errorMessage = `默认设备 ${defaultDevice} 当前未出现在 adb devices 列表中。`
    } else if (activeDevice.state === 'unauthorized') {
      errorCode = 'ANDROID_DEVICE_UNAUTHORIZED'
      errorMessage = `默认设备 ${defaultDevice} 尚未授权 USB／无线调试，请在手机上点击允许。`
    } else if (!activeDevice.online) {
      errorCode = 'ANDROID_DEVICE_OFFLINE'
      errorMessage = `默认设备 ${defaultDevice} 当前状态为 ${activeDevice.state}（离线）。`
    }
  } else if (onlineDevices.length > 1) {
    errorCode = 'ANDROID_DEVICE_REQUIRED'
    errorMessage = `检测到 ${onlineDevices.length} 台在线设备且尚未设置默认设备，请明确选择目标设备。`
  } else if (onlineDevices.length === 1) {
    activeDevice = onlineDevices[0]!
  } else if (devices.length > 0) {
    activeDevice = devices[0]!
    if (activeDevice.state === 'unauthorized') {
      errorCode = 'ANDROID_DEVICE_UNAUTHORIZED'
      errorMessage = `设备 ${activeDevice.serial} 尚未授权调试，请在手机屏幕上确认授权。`
    } else {
      errorCode = 'ANDROID_DEVICE_OFFLINE'
      errorMessage = `设备 ${activeDevice.serial} 当前状态为 ${activeDevice.state}（离线）。`
    }
  }

  return {
    queried: true,
    devices,
    activeDevice,
    onlineCount: onlineDevices.length,
    deviceOnline: Boolean(activeDevice?.online),
    errorCode,
    errorMessage,
    checkedAt: new Date().toISOString(),
  }
}

function redactSecret(textValue: string, secretValue: string): string {
  if (!secretValue) return textValue
  return textValue.split(secretValue).join('[REDACTED]')
}

function ensureExtractedExecutables(platformToolsDir: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return
  const expected = new Set(['adb', 'fastboot', 'mke2fs', 'make_f2fs', 'make_f2fs_casefold', 'e2fsdroid', 'sqlite3', 'etc1tool', 'hprof-conv'])
  for (const name of expected) {
    const file = join(platformToolsDir, name)
    if (existsSync(file) && statSync(file).isFile()) {
      chmodSync(file, 0o755)
    }
  }
}

export class AdbManager {
  private activeInstall: Promise<PluginAdbInstallMetadata> | null = null
  private installAbort: AbortController | null = null

  constructor(
    private readonly dataDirectory: string,
    private readonly options: AdbManagerOptions = {},
  ) {}

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private arch(): string {
    return this.options.arch ?? process.arch
  }

  private fetchFn(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  async detect(config: Pick<AndroidConfiguration, 'adbPath'>): Promise<AdbDetectionSnapshot> {
    const checkedAt = new Date().toISOString()
    const platform = this.platform()
    const packageInfo = basePackageDescriptor(platform, this.arch())

    const manualPath = config.adbPath.trim()
    let manualValid = false
    let manualVersion: string | null = null
    let manualErrorMessage: string | null = null
    if (manualPath) {
      const probe = await probeAdbExecutable(manualPath)
      manualValid = probe.valid
      manualVersion = probe.version
      manualErrorMessage = probe.error
    }

    let systemPath: string | null = null
    let systemVersion: string | null = null
    for (const candidate of systemAdbCandidates(this.dataDirectory, this.options)) {
      if (!existsSync(candidate)) continue
      const probe = await probeAdbExecutable(candidate)
      if (probe.valid) {
        systemPath = candidate
        systemVersion = probe.version
        break
      }
    }

    const pluginExe = pluginAdbExecutablePath(this.dataDirectory, platform)
    let pluginInstalled = false
    let pluginVersion: string | null = null
    const installRecord = readInstallRecord(this.dataDirectory)
    if (existsSync(pluginExe)) {
      const probe = await probeAdbExecutable(pluginExe)
      if (probe.valid) {
        pluginInstalled = true
        pluginVersion = probe.version
      }
    }

    if (manualPath) {
      if (manualValid) {
        return {
          available: true,
          source: 'manual',
          version: manualVersion,
          path: manualPath,
          systemAvailable: Boolean(systemPath),
          systemPath,
          systemVersion,
          pluginInstalled,
          pluginPath: pluginInstalled ? pluginExe : null,
          pluginVersion,
          pluginInstallRecord: installRecord,
          manualSpecified: true,
          manualValid: true,
          errorCode: null,
          errorMessage: null,
          packageInfo,
          checkedAt,
        }
      }
      return {
        available: false,
        source: 'none',
        version: null,
        path: manualPath,
        systemAvailable: Boolean(systemPath),
        systemPath,
        systemVersion,
        pluginInstalled,
        pluginPath: pluginInstalled ? pluginExe : null,
        pluginVersion,
        pluginInstallRecord: installRecord,
        manualSpecified: true,
        manualValid: false,
        errorCode: 'ANDROID_MANUAL_ADB_INVALID',
        errorMessage: `手动指定的 ADB 路径无效（${manualErrorMessage ?? '不可用'}），未回退到系统或插件内置 ADB。请修正路径或留空改用自动检测。`,
        packageInfo,
        checkedAt,
      }
    }

    if (systemPath) {
      return {
        available: true,
        source: 'system',
        version: systemVersion,
        path: systemPath,
        systemAvailable: true,
        systemPath,
        systemVersion,
        pluginInstalled,
        pluginPath: pluginInstalled ? pluginExe : null,
        pluginVersion,
        pluginInstallRecord: installRecord,
        manualSpecified: false,
        manualValid: false,
        errorCode: null,
        errorMessage: null,
        packageInfo,
        checkedAt,
      }
    }

    if (pluginInstalled) {
      return {
        available: true,
        source: 'plugin',
        version: pluginVersion,
        path: pluginExe,
        systemAvailable: false,
        systemPath: null,
        systemVersion: null,
        pluginInstalled: true,
        pluginPath: pluginExe,
        pluginVersion,
        pluginInstallRecord: installRecord,
        manualSpecified: false,
        manualValid: false,
        errorCode: null,
        errorMessage: null,
        packageInfo,
        checkedAt,
      }
    }

    return {
      available: false,
      source: 'none',
      version: null,
      path: null,
      systemAvailable: false,
      systemPath: null,
      systemVersion: null,
      pluginInstalled: false,
      pluginPath: null,
      pluginVersion: null,
      pluginInstallRecord: null,
      manualSpecified: false,
      manualValid: false,
      errorCode: 'ANDROID_ADB_MISSING',
      errorMessage: '未在手动路径、系统 PATH／Android SDK 或插件目录检测到可用 ADB。',
      packageInfo,
      checkedAt,
    }
  }

  async resolvePackageInfo(): Promise<AdbPlatformPackageDescriptor> {
    const platform = this.platform()
    const arch = this.arch()
    const target = describeHostPlatform(platform, arch)
    const base = basePackageDescriptor(platform, arch)
    if (!target.supported || !target.hostOs) return base
    const repoUrl = resolveRepositoryUrl(this.options.repositoryUrl)
    const response = await this.fetchFn()(repoUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) {
      throw rejectError('ANDROID_INSTALL_DOWNLOAD_FAILED', `查询官方 Platform-Tools 版本清单失败（HTTP ${response.status}）。`, 502)
    }
    const xmlBytes = Buffer.from(await response.arrayBuffer())
    if (xmlBytes.length > MAX_MANIFEST_BYTES) {
      throw rejectError('ANDROID_INSTALL_MANIFEST_INVALID', '官方清单响应大小异常。', 502)
    }
    const parsed = parsePlatformToolsPackage(xmlBytes.toString('utf8'), target.hostOs, repoUrl)
    return {
      ...base,
      version: parsed.version,
      sizeBytes: parsed.sizeBytes,
      url: parsed.url,
    }
  }

  installPluginAdb(config: Pick<AndroidConfiguration, 'adbPath'>, input: unknown): Promise<PluginAdbInstallMetadata> {
    if (this.activeInstall) return this.activeInstall
    const args = input === undefined ? {} : input
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return Promise.reject(rejectError('INVALID_INPUT', '安装参数无效。', 400))
    }
    const body = args as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (key !== 'acceptLicense') return Promise.reject(rejectError('INVALID_INPUT', '安装参数包含未知字段。', 400))
    }
    if (body.acceptLicense !== true) {
      return Promise.reject(rejectError('ANDROID_LICENSE_NOT_ACCEPTED', '请先确认并同意 Android SDK License Agreement 许可后安装。', 400))
    }

    const abort = new AbortController()
    this.installAbort = abort
    const task = this.runInstall(config, abort.signal).finally(() => {
      if (this.activeInstall === task) this.activeInstall = null
      if (this.installAbort === abort) this.installAbort = null
    })
    this.activeInstall = task
    return task
  }

  private async runInstall(config: Pick<AndroidConfiguration, 'adbPath'>, signal: AbortSignal): Promise<PluginAdbInstallMetadata> {
    const platform = this.platform()
    const arch = this.arch()
    const target = describeHostPlatform(platform, arch)
    if (!target.supported || !target.hostOs) {
      throw rejectError('ANDROID_PLATFORM_UNSUPPORTED', target.unsupportedReason ?? '当前系统架构没有官方 Platform-Tools 发行包。', 400)
    }

    const detection = await this.detect(config)
    if (detection.systemAvailable) {
      throw rejectError('ANDROID_SYSTEM_ADB_EXISTS', `系统已存在可用 ADB（${detection.systemPath}），为避免冲突与重复下载，已阻止安装。`, 409)
    }
    if (detection.pluginInstalled && detection.pluginInstallRecord) {
      return detection.pluginInstallRecord
    }

    const toolsDir = toolsDirectoryPath(this.dataDirectory)
    const stagingDir = join(toolsDir, `.tmp-install-${randomUUID()}`)
    const repoUrl = resolveRepositoryUrl(this.options.repositoryUrl)

    try {
      mkdirSync(toolsDir, { recursive: true })
      const manifestResp = await this.fetchFn()(repoUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]), redirect: 'error' })
      if (!manifestResp.ok) {
        throw rejectError('ANDROID_INSTALL_DOWNLOAD_FAILED', `下载官方软件清单失败（HTTP ${manifestResp.status}）。`, 502)
      }
      const xmlBytes = Buffer.from(await manifestResp.arrayBuffer())
      if (xmlBytes.length > MAX_MANIFEST_BYTES) {
        throw rejectError('ANDROID_INSTALL_MANIFEST_INVALID', '官方软件清单大小超出预期限制。', 502)
      }
      const pkg = parsePlatformToolsPackage(xmlBytes.toString('utf8'), target.hostOs, repoUrl)

      const archiveResp = await this.fetchFn()(pkg.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]), redirect: 'error' })
      if (!archiveResp.ok) {
        throw rejectError('ANDROID_INSTALL_DOWNLOAD_FAILED', `下载 Platform-Tools 失败（HTTP ${archiveResp.status}）。`, 502)
      }
      const declaredLength = archiveResp.headers.get('content-length')
      if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_ARCHIVE_BYTES) {
        throw rejectError('ANDROID_INSTALL_SIZE_MISMATCH', '远程安装包声明大小超出限制。', 502)
      }

      const zipBytes = Buffer.from(await archiveResp.arrayBuffer())
      if (zipBytes.length !== pkg.sizeBytes) {
        throw rejectError('ANDROID_INSTALL_SIZE_MISMATCH', `下载大小校验失败：期望 ${pkg.sizeBytes} 字节，实际 ${zipBytes.length} 字节。`, 502)
      }

      const actualDigest = createHash(pkg.checksumType).update(zipBytes).digest('hex')
      if (actualDigest !== pkg.checksum) {
        throw rejectError('ANDROID_INSTALL_CHECKSUM_FAILED', `安装包校验和（${pkg.checksumType.toUpperCase()}）不匹配，已中止安装并清理临时文件。`, 502)
      }

      mkdirSync(stagingDir, { recursive: true })
      extractPlatformToolsZip(zipBytes, stagingDir)

      const extractedRoot = join(stagingDir, 'platform-tools')
      const exeName = platform === 'win32' ? 'adb.exe' : 'adb'
      const stagedExe = join(extractedRoot, exeName)
      if (!existsSync(stagedExe)) {
        throw rejectError('ANDROID_INSTALL_ARCHIVE_INVALID', '解压后未在 platform-tools 目录中找到 adb 可执行文件。', 502)
      }
      ensureExtractedExecutables(extractedRoot, platform)

      const verified = await probeAdbExecutable(stagedExe)
      if (!verified.valid || !verified.version) {
        throw rejectError('ANDROID_INSTALL_VERIFY_FAILED', `安装后的 ADB 运行验证失败（${verified.error ?? '未知原因'}）。`, 502)
      }

      const finalRoot = platformToolsDirectoryPath(this.dataDirectory)
      const previousBackup = join(toolsDir, `.backup-platform-tools-${randomUUID()}`)
      let movedOld = false
      if (existsSync(finalRoot)) {
        renameSync(finalRoot, previousBackup)
        movedOld = true
      }
      try {
        renameSync(extractedRoot, finalRoot)
      } catch (error) {
        if (movedOld && existsSync(previousBackup) && !existsSync(finalRoot)) {
          renameSync(previousBackup, finalRoot)
        }
        throw error
      } finally {
        if (existsSync(previousBackup)) {
          rmSync(previousBackup, { recursive: true, force: true })
        }
      }

      const finalExe = pluginAdbExecutablePath(this.dataDirectory, platform)
      const record: PluginAdbInstallMetadata = {
        schemaVersion: 1,
        version: verified.version,
        revision: pkg.version,
        url: pkg.url,
        sha256: pkg.checksumType === 'sha256' ? pkg.checksum : createHash('sha256').update(zipBytes).digest('hex'),
        sizeBytes: zipBytes.length,
        license: OFFICIAL_LICENSE_NAME,
        licenseUrl: OFFICIAL_LICENSE_URL,
        platform,
        arch,
        executablePath: finalExe,
        installedAt: new Date().toISOString(),
      }
      writeDocument(installRecordPath(this.dataDirectory), record)
      return record
    } catch (error) {
      if (error instanceof PlatformError) throw error
      if (signal.aborted) throw rejectError('ANDROID_INSTALL_ABORTED', 'ADB 安装已取消并清理临时文件。', 409)
      throw rejectError('ANDROID_INSTALL_DOWNLOAD_FAILED', error instanceof Error ? error.message : '安装 Platform-Tools 失败。', 502)
    } finally {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true })
      }
      if (existsSync(toolsDir)) {
        for (const entry of readdirSync(toolsDir)) {
          if (entry.startsWith('.tmp-install-') || entry.startsWith('.backup-platform-tools-')) {
            rmSync(join(toolsDir, entry), { recursive: true, force: true })
          }
        }
      }
    }
  }

  async abortInstall(): Promise<void> {
    if (this.installAbort) this.installAbort.abort()
    await this.activeInstall?.catch(() => {})
  }

  async removePluginAdb(stopRuntime: () => Promise<void>): Promise<void> {
    await this.abortInstall()
    await stopRuntime()
    const toolsDir = toolsDirectoryPath(this.dataDirectory)
    if (existsSync(toolsDir)) {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  }

  async listDevices(adbExecutable: string, defaultDevice: string): Promise<AndroidDevicesSnapshot> {
    try {
      const result = await runAdbCommand(adbExecutable, ['devices', '-l'], ADB_VERSION_TIMEOUT_MS)
      if (result.exitCode !== 0) {
        return {
          queried: true,
          devices: [],
          activeDevice: null,
          onlineCount: 0,
          deviceOnline: false,
          errorCode: 'ANDROID_DEVICES_QUERY_FAILED',
          errorMessage: (result.stderr || result.stdout || '执行 adb devices -l 失败。').trim(),
          checkedAt: new Date().toISOString(),
        }
      }
      return parseAdbDevicesOutput(result.stdout, defaultDevice)
    } catch (error) {
      return {
        queried: false,
        devices: [],
        activeDevice: null,
        onlineCount: 0,
        deviceOnline: false,
        errorCode: 'ANDROID_DEVICES_QUERY_FAILED',
        errorMessage: error instanceof Error ? error.message : '查询 ADB 设备失败。',
        checkedAt: new Date().toISOString(),
      }
    }
  }

  async connectNetworkDevice(
    adbExecutable: string,
    addressInput: unknown,
    defaultDevice: string,
  ): Promise<{
    readonly ok: boolean
    readonly state: AndroidDeviceState | 'failed'
    readonly address: string
    readonly message: string
    readonly device: AndroidDeviceEntry | null
    readonly devices: AndroidDevicesSnapshot
  }> {
    const address = validateNetworkAddress(addressInput, false)
    const connectResult = await runAdbCommand(adbExecutable, ['connect', address], ADB_NETWORK_TIMEOUT_MS)
    const combinedOutput = `${connectResult.stdout}\n${connectResult.stderr}`.trim()
    const connectedHint = /(?:connected to|already connected to)\s+(\S+)/i.exec(combinedOutput)?.[1]
    const devices = await this.listDevices(adbExecutable, address)

    const matched =
      devices.devices.find(entry => entry.serial === address) ??
      (connectedHint ? devices.devices.find(entry => entry.serial === connectedHint) : undefined) ??
      null
    const explicitFailure =
      connectResult.exitCode !== 0 ||
      /(cannot connect|failed to connect|unable to connect|connection refused|bad port|failed to resolve)/i.test(combinedOutput)

    if (matched?.online && !explicitFailure) {
      return {
        ok: true,
        state: 'device',
        address,
        message: combinedOutput || `已连接网络设备 ${address}。`,
        device: matched,
        devices,
      }
    }

    if (matched?.state === 'unauthorized') {
      return {
        ok: false,
        state: 'unauthorized',
        address,
        message: `设备 ${address} 已响应但未授权无线调试（unauthorized），请在手机屏幕允许调试后重新检测。`,
        device: matched,
        devices: await this.listDevices(adbExecutable, defaultDevice),
      }
    }

    if (matched?.state === 'offline') {
      return {
        ok: false,
        state: 'offline',
        address,
        message: `设备 ${address} 当前处于离线状态（offline），请检查手机调试与网络连接后重试。`,
        device: matched,
        devices: await this.listDevices(adbExecutable, defaultDevice),
      }
    }

    return {
      ok: false,
      state: 'failed',
      address,
      message: combinedOutput || `无法连接到 ${address}，且 adb devices -l 未确认设备在线。`,
      device: matched,
      devices: await this.listDevices(adbExecutable, defaultDevice),
    }
  }

  async disconnectNetworkDevice(adbExecutable: string, addressInput: unknown, defaultDevice: string): Promise<{ message: string; devices: AndroidDevicesSnapshot }> {
    const address = validateNetworkAddress(addressInput, false)
    const result = await runAdbCommand(adbExecutable, ['disconnect', address], ADB_NETWORK_TIMEOUT_MS)
    const message = `${result.stdout}\n${result.stderr}`.trim() || `已请求断开 ${address}。`
    const devices = await this.listDevices(adbExecutable, defaultDevice === address ? '' : defaultDevice)
    return { message, devices }
  }

  async pairNetworkDevice(
    adbExecutable: string,
    pairAddressInput: unknown,
    pairCodeInput: unknown,
    connectAddressInput: unknown,
    defaultDevice: string,
  ): Promise<{
    readonly paired: boolean
    readonly message: string
    readonly connectResult: Awaited<ReturnType<AdbManager['connectNetworkDevice']>> | null
    readonly devices: AndroidDevicesSnapshot
  }> {
    const pairAddress = validateNetworkAddress(pairAddressInput, false)
    const pairCode = stringField(pairCodeInput, 'ANDROID_PAIR_CODE_INVALID', '无线配对码格式无效。', 32, false)
    if (/[\r\n\0]/.test(pairCode)) {
      throw rejectError('ANDROID_PAIR_CODE_INVALID', '无线配对码格式无效。', 400)
    }
    const connectAddress = connectAddressInput === undefined || String(connectAddressInput).trim() === ''
      ? ''
      : validateNetworkAddress(connectAddressInput, false)

    const pairResult = await runAdbCommand(adbExecutable, ['pair', pairAddress, pairCode], ADB_NETWORK_TIMEOUT_MS)
    const safeOutput = redactSecret(`${pairResult.stdout}\n${pairResult.stderr}`.trim(), pairCode)
    const failed = pairResult.exitCode !== 0 || /(failed|error:|cannot|wrong|invalid)/i.test(safeOutput)
    if (failed) {
      throw rejectError('ANDROID_PAIR_FAILED', safeOutput || '无线配对失败，请确认手机屏幕上配对地址与配对码仍在有效期内。', 409)
    }

    if (connectAddress) {
      const connectResult = await this.connectNetworkDevice(adbExecutable, connectAddress, defaultDevice)
      return {
        paired: true,
        message: safeOutput || `已完成与 ${pairAddress} 的无线配对。`,
        connectResult,
        devices: connectResult.devices,
      }
    }

    const devices = await this.listDevices(adbExecutable, defaultDevice)
    return {
      paired: true,
      message: safeOutput || `已完成与 ${pairAddress} 的无线配对。`,
      connectResult: null,
      devices,
    }
  }
}
