import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

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

  read(): JsonObject | null {
    if (!existsSync(this.filePath)) return null
    if (lstatSync(this.filePath).isSymbolicLink()) throw new PlatformError('INVALID_CONFIGURATION_FILE', 'QQ 配置不能使用符号链接。', 500)
    chmodSync(this.filePath, 0o600)
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!isJsonObject(data) || data.schemaVersion !== 1 || !isJsonObject(data.configuration)) throw new Error('schema')
      this.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null
      return data.configuration
    } catch { throw new PlatformError('CONFIGURATION_CORRUPTED', 'QQ 配置格式损坏或版本不兼容，未覆盖原文件。', 500) }
  }

  write(configuration: JsonObject): void {
    const updatedAt = new Date().toISOString()
    writeRestrictedJson(this.filePath, { schemaVersion: 1, updatedAt, configuration })
    this.updatedAt = updatedAt
  }
}
