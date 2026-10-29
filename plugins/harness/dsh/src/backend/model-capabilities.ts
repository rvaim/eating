import { join } from 'node:path'
import { PlatformError } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'

export interface DshModelCapabilities {
  readonly schemaVersion: 1
  readonly revision: number
  readonly imageInput: boolean
}
const defaults = (): DshModelCapabilities => ({ schemaVersion: 1, revision: 0, imageInput: false })
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** New feature state is independent of the saved connection and its credentials. */
export class DshModelCapabilitiesFile {
  readonly filePath: string
  constructor(directory: string) { this.filePath = join(directory, 'model-capabilities.json') }
  read(): DshModelCapabilities {
    const value = readRestrictedJson(this.filePath)
    if (value === null) return defaults()
    if (Object.keys(value).length !== 3 || value.schemaVersion !== 1 || !validRevision(value.revision) || typeof value.imageInput !== 'boolean') throw new PlatformError('MODEL_CAPABILITIES_CORRUPTED', '模型能力配置无法读取，原文件未被覆盖。', 500)
    return { schemaVersion: 1, revision: value.revision, imageInput: value.imageInput }
  }
  update(input: unknown): DshModelCapabilities {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'expectedRevision') || !Object.hasOwn(input, 'imageInput')) throw new PlatformError('INVALID_MODEL_CAPABILITIES', '请提供完整的图片输入能力与预期版本。')
    const value = input as Record<string, unknown>
    if (!validRevision(value.expectedRevision) || typeof value.imageInput !== 'boolean') throw new PlatformError('INVALID_MODEL_CAPABILITIES', '图片输入能力或版本无效。')
    const current = this.read()
    if (current.revision !== value.expectedRevision) throw new PlatformError('MODEL_CAPABILITIES_CONFLICT', '模型能力已被其他页面修改，请读取最新版本后再保存。', 409)
    if (current.imageInput === value.imageInput) return current
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new PlatformError('MODEL_CAPABILITIES_EXHAUSTED', '模型能力配置版本已达到上限，未保存修改。', 409)
    const next: DshModelCapabilities = { schemaVersion: 1, revision: current.revision + 1, imageInput: value.imageInput }
    writeRestrictedJson(this.filePath, { ...next })
    return next
  }
}
