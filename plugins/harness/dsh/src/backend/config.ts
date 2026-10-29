import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

export interface DshConfiguration {
  readonly displayName: string
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
  readonly autoConnect: boolean
  readonly timeoutMs: number
  readonly maxTokens: number
}

export const DEFAULT_CONFIGURATION: DshConfiguration = Object.freeze({
  displayName: 'DeepSeek Harness', endpoint: '', model: '', apiKey: '', autoConnect: false,
  timeoutMs: 60_000, maxTokens: 4096,
})

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^[0-9a-f]{64}$/

export function parseConfiguration(input: unknown, previous: DshConfiguration = DEFAULT_CONFIGURATION): DshConfiguration {
  if (!isJsonObject(input)) throw new PlatformError('INVALID_CONFIGURATION', 'DSH 配置必须为对象。')
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_CONFIGURATION, key) && key !== 'clearApiKey')) throw new PlatformError('INVALID_CONFIGURATION', 'DSH 配置包含当前契约不支持的字段。')
  for (const name of ['displayName', 'endpoint', 'model', 'apiKey']) {
    if (input[name] !== undefined && typeof input[name] !== 'string') throw new PlatformError('INVALID_CONFIGURATION', '显示名称、地址、模型和密钥需为字符串。')
  }
  for (const name of ['autoConnect', 'clearApiKey']) {
    if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new PlatformError('INVALID_CONFIGURATION', '自动连接与清除密钥选项需为布尔值。')
  }
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : previous.displayName
  if (!displayName || displayName.length > 80) throw new PlatformError('INVALID_CONFIGURATION', '显示名称需为 1 至 80 个字符。')
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : previous.endpoint
  let normalizedEndpoint = ''
  if (endpoint) {
    let url: URL
    try { url = new URL(endpoint) } catch { throw new PlatformError('INVALID_CONFIGURATION', '请填写有效的 OpenAI 兼容 HTTP 或 HTTPS 基础地址。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || endpoint.includes('?') || endpoint.includes('#')) {
      throw new PlatformError('INVALID_CONFIGURATION', '模型地址仅支持 HTTP/HTTPS，且不能包含账号、密码、查询参数或片段。')
    }
    if (endpoint.length > 2048) throw new PlatformError('INVALID_CONFIGURATION', '模型地址不能超过 2048 个字符。')
    normalizedEndpoint = url.toString()
  }
  const model = typeof input.model === 'string' ? input.model.trim() : previous.model
  if (model.length > 160 || /[\r\n\0]/.test(model)) throw new PlatformError('INVALID_CONFIGURATION', '模型名称需为空草稿或 1 至 160 个字符。')
  const apiKey = input.clearApiKey === true ? '' : typeof input.apiKey === 'string' && input.apiKey.length ? input.apiKey : previous.apiKey
  if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new PlatformError('INVALID_CONFIGURATION', 'API 密钥格式无效。')
  const timeoutMs = input.timeoutMs === undefined ? previous.timeoutMs : input.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new PlatformError('INVALID_CONFIGURATION', '请求超时需为 1000 至 120000 毫秒之间的整数。')
  }
  const maxTokens = input.maxTokens === undefined ? previous.maxTokens : input.maxTokens
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131_072) {
    throw new PlatformError('INVALID_CONFIGURATION', '输出 token 上限需为 1 至 131072 之间的整数。')
  }
  return { displayName, endpoint: normalizedEndpoint, model, apiKey, timeoutMs, maxTokens,
    autoConnect: typeof input.autoConnect === 'boolean' ? input.autoConnect : previous.autoConnect }
}

export function prepareRestrictedDirectory(directory: string): string {
  const absolute = resolve(directory)
  mkdirSync(absolute, { recursive: true, mode: 0o700 })
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) {
    throw new PlatformError('INVALID_DATA_DIRECTORY', 'DSH 数据目录必须为独立目录，不能是符号链接。', 500)
  }
  chmodSync(absolute, 0o700)
  return absolute
}

/** This local implementation does not import another plugin's private files. */
export function writeRestrictedJson(filePath: string, data: JsonObject): void {
  const target = resolve(filePath)
  const directory = prepareRestrictedDirectory(dirname(target))
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile())) {
    throw new PlatformError('INVALID_CONFIGURATION_FILE', 'DSH 文件不能是符号链接或特殊文件。', 500)
  }
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(descriptor, JSON.stringify(data, null, 2) + '\n')
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    renameSync(temporary, target)
    chmodSync(target, 0o600)
    if (process.platform !== 'win32') {
      const handle = openSync(directory, 'r')
      try { fsyncSync(handle) } finally { closeSync(handle) }
    }
  } catch { throw new PlatformError('CONFIGURATION_SAVE_FAILED', 'DSH 文件保存失败，请检查目录权限与磁盘空间。', 500) }
  finally {
    if (descriptor !== undefined) closeSync(descriptor)
    // The temporary name is generated here, and is always directly under the verified directory.
    if (dirname(resolve(temporary)) === directory && existsSync(temporary)) unlinkSync(temporary)
  }
}

export function readRestrictedJson(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) return null
  if (lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()) throw new PlatformError('INVALID_CONFIGURATION_FILE', 'DSH 文件不能是符号链接或特殊文件。', 500)
  let descriptor: number | undefined
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    chmodSync(filePath, 0o600)
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (!isJsonObject(value)) throw new Error('schema')
    return value
  } catch { throw new PlatformError('CONFIGURATION_CORRUPTED', 'DSH 文件格式损坏或无法读取，未覆盖原文件。', 500) }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}

export class DshConfigurationFile {
  readonly directory: string
  readonly filePath: string
  updatedAt: string | null = null

  constructor(directory: string) {
    this.directory = prepareRestrictedDirectory(directory)
    this.filePath = join(this.directory, 'config.json')
  }

  read(): DshConfiguration {
    const data = readRestrictedJson(this.filePath)
    if (!data) return { ...DEFAULT_CONFIGURATION }
    try {
      if (data.schemaVersion !== 1 || !isJsonObject(data.configuration) || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('schema')
      const configurationValues = data.configuration
      const keys = Object.keys(DEFAULT_CONFIGURATION)
      if (keys.some(key => !Object.hasOwn(configurationValues, key)) || Object.keys(configurationValues).some(key => !keys.includes(key))) throw new Error('schema')
      const configuration = parseConfiguration(configurationValues)
      this.updatedAt = data.updatedAt
      return configuration
    } catch { throw new PlatformError('CONFIGURATION_CORRUPTED', 'DSH 配置格式损坏或版本不兼容，未覆盖原文件。', 500) }
  }

  write(configuration: DshConfiguration): void {
    const updatedAt = new Date().toISOString()
    writeRestrictedJson(this.filePath, { schemaVersion: 1, updatedAt, configuration: { ...configuration } })
    this.updatedAt = updatedAt
  }
}

export interface DshSessionMetadata {
  readonly sessionId: string
  readonly created: boolean
  readonly activeBatchId?: string
  readonly digest?: string
  readonly nonce?: string
  readonly receiptId?: string
  readonly lastOutcome?: 'pending' | 'durable' | 'unknown' | 'failed' | 'completed' | 'recovered'
}

export class DshSessionFile {
  readonly filePath: string
  constructor(directory: string) { this.filePath = join(prepareRestrictedDirectory(directory), 'session.json') }

  read(): DshSessionMetadata | null {
    const value = readRestrictedJson(this.filePath)
    if (!value) return null
    if (value.schemaVersion !== 1 || typeof value.sessionId !== 'string' || !uuidPattern.test(value.sessionId) || typeof value.created !== 'boolean' ||
      value.activeBatchId !== undefined && (typeof value.activeBatchId !== 'string' || !digestPattern.test(value.activeBatchId)) ||
      value.digest !== undefined && (typeof value.digest !== 'string' || !digestPattern.test(value.digest)) ||
      value.nonce !== undefined && (typeof value.nonce !== 'string' || !uuidPattern.test(value.nonce)) ||
      value.receiptId !== undefined && (typeof value.receiptId !== 'string' || value.receiptId.length > 256) ||
      value.lastOutcome !== undefined && !['pending', 'durable', 'unknown', 'failed', 'completed', 'recovered'].includes(String(value.lastOutcome)) ||
      value.activeBatchId !== undefined && (value.digest === undefined || value.nonce === undefined)) {
      throw new PlatformError('SESSION_METADATA_CORRUPTED', 'DSH 固定会话元数据损坏，未创建替代会话。', 500)
    }
    return { sessionId: value.sessionId, created: value.created,
      ...(typeof value.activeBatchId === 'string' ? { activeBatchId: value.activeBatchId } : {}),
      ...(typeof value.digest === 'string' ? { digest: value.digest } : {}),
      ...(typeof value.nonce === 'string' ? { nonce: value.nonce } : {}),
      ...(typeof value.receiptId === 'string' ? { receiptId: value.receiptId } : {}),
      ...(value.lastOutcome !== undefined ? { lastOutcome: value.lastOutcome as DshSessionMetadata['lastOutcome'] } : {}) }
  }

  write(value: DshSessionMetadata): void {
    writeRestrictedJson(this.filePath, { schemaVersion: 1, ...value })
  }
}
