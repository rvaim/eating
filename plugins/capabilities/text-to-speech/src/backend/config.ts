import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import { SPEECH_VOICES } from '../types'
import type { SpeechConfiguration } from '../types'
import { directory, json, read, write } from './files'

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export function args(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!isJsonObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new PlatformError('SPEECH_INVALID_INPUT', '语音参数无效。', 400, 'not-sent')
  return value
}
export function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) throw new PlatformError('SPEECH_INVALID_INPUT', '语音文本或配置无效。', 400, 'not-sent')
  return value
}
export interface PrivateConfiguration { schemaVersion: 1; revision: number; endpoint: string; model: string; voice: string; timeoutMs: number; apiKey: string }
const defaults: PrivateConfiguration = { schemaVersion: 1, revision: 0, endpoint: 'wss://api.openai.com/v1/realtime', model: 'gpt-realtime-2.1-mini', voice: 'marin', timeoutMs: 120000, apiKey: '' }
function parse(value: unknown): PrivateConfiguration {
  const v = args(value, Object.keys(defaults), Object.keys(defaults))
  const endpoint = text(v.endpoint, 2048), url = new URL(endpoint)
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash || endpoint.includes('?') || endpoint.includes('#')
    || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || Number(v.revision) >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(v.timeoutMs) || Number(v.timeoutMs) < 10000 || Number(v.timeoutMs) > 300000 || !SPEECH_VOICES.includes(v.voice as typeof SPEECH_VOICES[number])) throw new Error('Invalid speech configuration')
  const apiKey = text(v.apiKey, 4096, true)
  if (/[\r\n]/.test(apiKey)) throw new Error('Invalid key')
  return { schemaVersion: 1, revision: Number(v.revision), endpoint, model: text(v.model, 160), voice: String(v.voice), timeoutMs: Number(v.timeoutMs), apiKey }
}
export class SpeechConfig {
  private value: PrivateConfiguration
  private stamp: string | null
  private readonly path: string
  constructor(root: string) {
    this.path = join(directory(root), 'config.json'); const bytes = read(this.path, 65536); this.stamp = bytes ? hash(bytes) : null
    try { this.value = bytes ? parse(JSON.parse(bytes.toString())) : { ...defaults } } catch { throw new PlatformError('SPEECH_CONFIGURATION_CORRUPTED', '语音配置不是有效的当前格式，原文件保留。', 500, 'not-sent') }
  }
  snapshot(): PrivateConfiguration { return { ...this.value } }
  public(ready: boolean): SpeechConfiguration { const { apiKey, ...v } = this.value; return { ...v, apiKeyConfigured: Boolean(apiKey), ready: ready && Boolean(apiKey) } }
  update(input: unknown): void {
    const v = args(input, ['expectedRevision', 'endpoint', 'model', 'voice', 'timeoutMs', 'apiKey', 'clearApiKey'], ['expectedRevision'])
    const current = read(this.path, 65536)
    if (v.expectedRevision !== this.value.revision || (current ? hash(current) : null) !== this.stamp) throw new PlatformError('SPEECH_CONFIGURATION_CONFLICT', '语音配置已变化，请保留草稿并刷新核对。', 409, 'not-sent')
    if (v.clearApiKey !== undefined && typeof v.clearApiKey !== 'boolean' || v.apiKey !== undefined && typeof v.apiKey !== 'string') throw new PlatformError('SPEECH_INVALID_INPUT', '密钥参数无效。', 400, 'not-sent')
    let next: PrivateConfiguration
    try { next = parse({ ...this.value, ...Object.fromEntries(Object.entries(v).filter(([k]) => !['expectedRevision', 'apiKey', 'clearApiKey'].includes(k))), revision: this.value.revision + 1, apiKey: v.clearApiKey === true ? '' : typeof v.apiKey === 'string' && v.apiKey.trim() ? v.apiKey : this.value.apiKey }) }
    catch { throw new PlatformError('SPEECH_INVALID_CONFIGURATION', '请检查地址、模型、音色和超时设置。', 400, 'not-sent') }
    const bytes = json(next); write(this.path, bytes); this.value = next; this.stamp = hash(bytes)
  }
}
