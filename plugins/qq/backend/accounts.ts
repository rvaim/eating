import { existsSync, lstatSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PlatformError, isJsonObject } from '../../../packages/platform-contract/src/index'
import { writeRestrictedJson } from './config-file'

export interface AccountInstance { readonly instanceId: string; readonly label: string; readonly createdAt: string }

/** Index supports multiple instances; this release only operates the selected default. */
export class QQAccountRegistry {
  readonly root: string
  readonly indexPath: string
  readonly instances: readonly AccountInstance[]
  readonly defaultInstanceId: string

  constructor(pluginDirectory: string) {
    this.root = resolve(pluginDirectory)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (lstatSync(this.root).isSymbolicLink()) throw new PlatformError('INVALID_DATA_DIRECTORY', 'QQ 数据目录不能是符号链接。', 500)
    chmodSync(this.root, 0o700)
    this.indexPath = join(this.root, 'accounts.json')
    if (existsSync(this.indexPath)) {
      if (lstatSync(this.indexPath).isSymbolicLink()) throw new PlatformError('INVALID_ACCOUNT_INDEX', '账号索引不能是符号链接。', 500)
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) }
      catch { throw new PlatformError('ACCOUNT_INDEX_CORRUPTED', 'QQ 账号索引不可读取，未覆盖原记录。', 500) }
      if (!isJsonObject(parsed) || parsed.schemaVersion !== 1 || typeof parsed.defaultInstanceId !== 'string' || !Array.isArray(parsed.instances) || parsed.instances.length < 1 || parsed.instances.length > 100) throw new PlatformError('ACCOUNT_INDEX_CORRUPTED', 'QQ 账号索引格式或版本不兼容。', 500)
      const entries: AccountInstance[] = parsed.instances.map(entry => {
        if (!isJsonObject(entry) || typeof entry.instanceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(entry.instanceId) || typeof entry.label !== 'string' || typeof entry.createdAt !== 'string') throw new PlatformError('ACCOUNT_INDEX_CORRUPTED', 'QQ 账号索引包含非法实例。', 500)
        return { instanceId: entry.instanceId, label: entry.label, createdAt: entry.createdAt }
      })
      if (new Set(entries.map(entry => entry.instanceId)).size !== entries.length || !entries.some(entry => entry.instanceId === parsed.defaultInstanceId)) throw new PlatformError('ACCOUNT_INDEX_CORRUPTED', 'QQ 默认实例不存在或标识重复。', 500)
      this.instances = entries
      this.defaultInstanceId = parsed.defaultInstanceId
    } else {
      if (existsSync(join(this.root, 'config.json'))) throw new PlatformError('ACCOUNT_MIGRATION_REQUIRED', '发现旧单文件 QQ 配置。请先明确迁移到账号实例目录，系统未覆盖原配置。', 409)
      const initial: AccountInstance = { instanceId: randomUUID(), label: '默认 QQ 账号', createdAt: new Date().toISOString() }
      this.instances = [initial]
      this.defaultInstanceId = initial.instanceId
      writeRestrictedJson(this.indexPath, { schemaVersion: 1, defaultInstanceId: initial.instanceId, instances: [{ ...initial }] })
    }
    const accounts = join(this.root, 'accounts')
    mkdirSync(accounts, { recursive: true, mode: 0o700 })
    if (lstatSync(accounts).isSymbolicLink()) throw new PlatformError('INVALID_DATA_DIRECTORY', 'QQ 账号目录不能是符号链接。', 500)
    chmodSync(accounts, 0o700)
  }

  directoryFor(instanceId: string): string {
    if (!this.instances.some(entry => entry.instanceId === instanceId)) throw new PlatformError('ACCOUNT_INSTANCE_NOT_FOUND', 'QQ 账号实例不存在。', 404)
    return join(this.root, 'accounts', instanceId)
  }
}
