import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { ImageRequestParametersConfiguration } from '../types'
import { DEFAULT_REQUEST_PARAMETERS, parseRequestParameters, REQUEST_PARAMETERS_MAX_BYTES } from '../request-parameters'
import { ImageStorageError, jsonBytes, prepareDirectory, readBytes, writeBytes } from './files'
import { object, safeInteger } from './validation'

const maximum = REQUEST_PARAMETERS_MAX_BYTES + 1024
const hash = (bytes: Buffer | null) => bytes ? createHash('sha256').update(bytes).digest('hex') : null

export class ImageRequestParametersStore {
  private value: ImageRequestParametersConfiguration
  private readonly path: string
  private fingerprint: string | null
  constructor(directory: string) {
    this.path = join(prepareDirectory(directory), 'request-parameters.json')
    const bytes = readBytes(this.path, maximum)
    this.fingerprint = hash(bytes)
    try {
      if (bytes) {
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        if (!isJsonObject(value) || value.schemaVersion !== 1 || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'parameters')) throw new Error('Invalid request parameters configuration')
        this.value = { schemaVersion: 1, revision: safeInteger(value.revision, 0, Number.MAX_SAFE_INTEGER), parameters: parseRequestParameters(value.parameters) }
      } else this.value = { schemaVersion: 1, revision: 0, parameters: { ...DEFAULT_REQUEST_PARAMETERS } }
    } catch { throw new PlatformError('IMAGE_REQUEST_PARAMETERS_CORRUPTED', '请求参数文件格式损坏或不是当前schema1，原文件已保留。', 500, 'not-sent') }
  }
  snapshot(): ImageRequestParametersConfiguration { return structuredClone(this.value) }
  update(input: unknown): ImageRequestParametersConfiguration {
    const args = object(input, ['expectedRevision', 'parameters'], ['expectedRevision', 'parameters'])
    if (args.expectedRevision !== this.value.revision || !Number.isSafeInteger(args.expectedRevision)
      || hash(readBytes(this.path, maximum)) !== this.fingerprint) throw new PlatformError('IMAGE_REQUEST_PARAMETERS_CONFLICT', '请求参数已变更，请重新读取后核对；草稿未覆盖。', 409, 'not-sent')
    if (this.value.revision >= Number.MAX_SAFE_INTEGER) throw new ImageStorageError()
    const next: ImageRequestParametersConfiguration = { schemaVersion: 1, revision: this.value.revision + 1, parameters: parseRequestParameters(args.parameters) }
    const bytes = jsonBytes(next)
    if (bytes.byteLength > maximum) throw new PlatformError('IMAGE_REQUEST_PARAMETERS_INVALID', '请求参数超过允许大小。', 400, 'not-sent')
    try { writeBytes(this.path, bytes) }
    catch (error) { if (error instanceof ImageStorageError && error.committed) { this.value = next; this.fingerprint = hash(bytes) }; throw error }
    this.value = next; this.fingerprint = hash(bytes)
    return this.snapshot()
  }
}
