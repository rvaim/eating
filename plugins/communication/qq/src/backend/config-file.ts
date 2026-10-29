import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { OneBotConfig } from '../config'
import { parseQQAgentPolicy } from './agent-policy'

export function readConfiguration(input: unknown): OneBotConfig {
  const fields = ['displayName', 'endpoint', 'accessToken', 'autoConnect', 'forwardToHarness', 'receiveGroups', 'timeoutMs', 'owners', 'administrators', 'agentTools', 'policyRevision']
  if (!isJsonObject(input) || fields.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !fields.includes(key))) throw new PlatformError('INVALID_CONFIGURATION', 'QQ 配置必须完整包含当前版本字段，不能包含未知字段。')
  if (typeof input.displayName !== 'string' || input.displayName !== input.displayName.trim() || input.displayName.length < 1 || input.displayName.length > 40) throw new PlatformError('INVALID_CONFIGURATION', '显示名称需为1至40个字符。')
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(input.endpoint)) throw new PlatformError('INVALID_CONFIGURATION', '请填写有效的 ws:// 或 wss:// OneBot 地址。')
  if (input.endpoint) {
    let url: URL
    try { url = new URL(input.endpoint) } catch { throw new PlatformError('INVALID_CONFIGURATION', '请填写有效的 ws:// 或 wss:// OneBot 地址。') }
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || input.endpoint.includes('@') || input.endpoint.includes('?') || input.endpoint.includes('#')) throw new PlatformError('INVALID_CONFIGURATION', 'OneBot 地址只能使用 ws/wss，不要在地址中填写令牌、账号、查询参数或片段。')
    if (/\/(?:api|event)\/?$/.test(url.pathname)) throw new PlatformError('INVALID_CONFIGURATION', '请使用同时支持 API 和事件的统一 WebSocket 端点，不要使用 /api 或 /event 分离接口。')
  }
  if (typeof input.accessToken !== 'string' || input.accessToken.length > 4096 || /[\r\n]/.test(input.accessToken)) throw new PlatformError('INVALID_CONFIGURATION', '访问令牌格式不正确。')
  if (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 60000) throw new PlatformError('INVALID_CONFIGURATION', '请求超时需在1000至60000毫秒之间。')
  if (typeof input.autoConnect !== 'boolean' || typeof input.forwardToHarness !== 'boolean' || typeof input.receiveGroups !== 'boolean') throw new PlatformError('INVALID_CONFIGURATION', 'QQ 连接与消息设置必须为布尔值。')
  return {
    displayName: input.displayName, endpoint: input.endpoint, accessToken: input.accessToken, timeoutMs: input.timeoutMs,
    autoConnect: input.autoConnect, forwardToHarness: input.forwardToHarness, receiveGroups: input.receiveGroups,
    ...parseQQAgentPolicy({ owners: input.owners, administrators: input.administrators, agentTools: input.agentTools, policyRevision: input.policyRevision }),
  }
}

export function writeRestrictedJson(filePath: string, data: JsonObject): void {
  const directory = resolve(dirname(filePath))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink() || existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw new PlatformError('INVALID_CONFIGURATION_FILE', '配置目录或文件不能是符号链接。', 500)
  chmodSync(directory, 0o700)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  if (dirname(resolve(temporary)) !== directory) throw new Error('Invalid configuration path')
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(data, null, 2) + '\n')
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    renameSync(temporary, filePath)
    chmodSync(filePath, 0o600)
    if (process.platform !== 'win32') {
      const handle = openSync(directory, 'r')
      try { fsyncSync(handle) } finally { closeSync(handle) }
    }
  } catch { throw new PlatformError('CONFIGURATION_SAVE_FAILED', 'QQ 配置保存失败，请检查目录权限与磁盘空间。', 500) }
  finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary) && dirname(resolve(temporary)) === directory) unlinkSync(temporary)
  }
}

export class QQConfigurationFile {
  readonly filePath: string
  readonly directory: string
  updatedAt: string | null = null

  constructor(directory: string) {
    this.directory = resolve(directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (lstatSync(this.directory).isSymbolicLink()) throw new PlatformError('INVALID_DATA_DIRECTORY', 'QQ 数据目录不能指向符号链接。', 500)
    chmodSync(this.directory, 0o700)
    this.filePath = join(this.directory, 'config.json')
  }

  read(): OneBotConfig | null {
    if (!existsSync(this.filePath)) return null
    if (lstatSync(this.filePath).isSymbolicLink()) throw new PlatformError('INVALID_CONFIGURATION_FILE', 'QQ 配置不能使用符号链接。', 500)
    chmodSync(this.filePath, 0o600)
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!isJsonObject(data) || Object.keys(data).some(key => !['schemaVersion', 'updatedAt', 'configuration'].includes(key)) || data.schemaVersion !== 2 || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('schema')
      const configuration = readConfiguration(data.configuration)
      this.updatedAt = data.updatedAt
      return configuration
    } catch { throw new PlatformError('CONFIGURATION_CORRUPTED', 'QQ 配置格式无效或版本不支持，未覆盖原文件。', 500) }
  }

  write(configuration: OneBotConfig): void {
    const current = readConfiguration(configuration)
    const updatedAt = new Date().toISOString()
    writeRestrictedJson(this.filePath, { schemaVersion: 2, updatedAt, configuration: { ...current } })
    this.updatedAt = updatedAt
  }
}
