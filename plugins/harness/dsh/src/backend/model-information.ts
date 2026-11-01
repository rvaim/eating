import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { validReportedCapabilities } from '../model-information'
import type { ModelInformation } from '../model-information'
import type { DshConfiguration } from './config'
import { readRestrictedJson, writeRestrictedJson } from './config'

type Identity = Pick<DshConfiguration, 'endpoint' | 'apiKey'>
interface Catalog { readonly schemaVersion: 1; readonly signature: string; readonly fetchedAt: string; readonly models: readonly ModelInformation[] }
const signature = (configuration: Identity) => createHash('sha256').update(configuration.endpoint + '\0' + configuration.apiKey).digest('hex')
export class DshModelInformationFile {
  readonly filePath: string
  constructor(directory: string) { this.filePath = join(directory, 'model-information.json') }
  private read(): Catalog | null {
    try { if (statSync(this.filePath).size > 1024 * 1024) throw new Error('size') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PlatformError('MODEL_INFORMATION_CORRUPTED', '模型能力目录无法读取，未覆盖原文件。', 500) }
    const value = readRestrictedJson(this.filePath)
    if (value === null) return null
    const invalid = () => new PlatformError('MODEL_INFORMATION_CORRUPTED', '模型能力目录格式不支持，未覆盖原文件。', 500)
    if (Object.keys(value).length !== 4 || value.schemaVersion !== 1 || typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature) || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) || !Array.isArray(value.models) || value.models.length > 2000) throw invalid()
    const ids = new Set<string>()
    for (const row of value.models) {
      if (!isJsonObject(row) || typeof row.id !== 'string' || !row.id || row.id.length > 160 || /[\u0000-\u001f]/.test(row.id) || ids.has(row.id) || Object.keys(row).some(key => !['id', 'name', 'capabilities'].includes(key)) || row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 256) || row.capabilities !== undefined && !validReportedCapabilities(row.capabilities)) throw invalid()
      ids.add(row.id)
    }
    return value as unknown as Catalog
  }
  save(configuration: Identity, models: readonly ModelInformation[]): void {
    this.read()
    const document: Catalog = { schemaVersion: 1, signature: signature(configuration), fetchedAt: new Date().toISOString(), models }
    if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) throw new PlatformError('MODEL_INFORMATION_TOO_LARGE', '模型能力目录超过保存上限。', 502)
    writeRestrictedJson(this.filePath, document as unknown as JsonObject)
  }
  selected(configuration: Identity & { model: string }): { readonly model: ModelInformation | null; readonly fetchedAt: string | null } {
    const catalog = this.read()
    if (!catalog || catalog.signature !== signature(configuration)) return { model: null, fetchedAt: null }
    return { model: catalog.models.find(model => model.id === configuration.model) ?? null, fetchedAt: catalog.fetchedAt }
  }
}
