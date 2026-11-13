import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import { speechDefaults, speechVoices } from '../types'
import type { SpeechConfiguration, SpeechProvider } from '../types'
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
export interface PrivateConfiguration { schemaVersion: 2; revision: number; endpoint: string; provider: SpeechProvider; timeoutMs: number; apiKey: string }
export type OpenAISpeechConfiguration = PrivateConfiguration & { provider: Extract<SpeechProvider, { protocol: 'openai-realtime' }> }
const defaults: PrivateConfiguration = { schemaVersion: 2, revision: 0, ...speechDefaults('openai-realtime'), timeoutMs: 120000, apiKey: '' }
function parse(value: unknown): PrivateConfiguration {
  const v = args(value, Object.keys(defaults), Object.keys(defaults))
  const endpoint = text(v.endpoint, 2048), url = new URL(endpoint)
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash || endpoint.includes('?') || endpoint.includes('#')
    || v.schemaVersion !== 2 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || Number(v.revision) >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(v.timeoutMs) || Number(v.timeoutMs) < 10000 || Number(v.timeoutMs) > 300000 || !isJsonObject(v.provider)) throw new Error('Invalid speech configuration')
  const p = v.provider
  if (!['openai-realtime', 'deepseek-tts'].includes(String(p.protocol)) || !speechVoices(p.protocol as SpeechProvider['protocol']).includes(String(p.voice))) throw new Error('Invalid provider')
  let provider: SpeechProvider
  if (p.protocol === 'openai-realtime') { args(p, ['protocol', 'voice', 'model'], ['protocol', 'voice', 'model']); provider = { protocol: p.protocol, voice: String(p.voice), model: text(p.model, 160) } }
  else { args(p, ['protocol', 'voice', 'filterMarkdown'], ['protocol', 'voice', 'filterMarkdown']); if (typeof p.filterMarkdown !== 'boolean') throw new Error('Invalid provider'); provider = { protocol: 'deepseek-tts', voice: p.voice as 'stella' | 'tide', filterMarkdown: p.filterMarkdown } }
  const apiKey = text(v.apiKey, 4096, true)
  if (/[\r\n]/.test(apiKey)) throw new Error('Invalid key')
  return { schemaVersion: 2, revision: Number(v.revision), endpoint, provider, timeoutMs: Number(v.timeoutMs), apiKey }
}
export class SpeechConfig {
  private value: PrivateConfiguration
  private stamp: string | null
  private readonly path: string
  constructor(root: string) {
    this.path = join(directory(root), 'config.json'); const bytes = read(this.path, 65536); this.stamp = bytes ? hash(bytes) : null
    try { this.value = bytes ? parse(JSON.parse(bytes.toString())) : { ...defaults } } catch { throw new PlatformError('SPEECH_CONFIGURATION_CORRUPTED', '语音配置不是有效的当前格式，原文件保留。', 500, 'not-sent') }
  }
  snapshot(): PrivateConfiguration { return structuredClone(this.value) }
  public(ready: boolean): SpeechConfiguration { const { apiKey, ...v } = this.snapshot(); return { ...v, apiKeyConfigured: Boolean(apiKey), ready: ready && Boolean(apiKey) } }
  update(input: unknown): void {
    const v = args(input, ['expectedRevision', 'endpoint', 'provider', 'timeoutMs', 'apiKey', 'clearApiKey'], ['expectedRevision'])
    const current = read(this.path, 65536)
    if (v.expectedRevision !== this.value.revision || (current ? hash(current) : null) !== this.stamp) throw new PlatformError('SPEECH_CONFIGURATION_CONFLICT', '语音配置已变化，请保留草稿并刷新核对。', 409, 'not-sent')
    if (v.clearApiKey !== undefined && typeof v.clearApiKey !== 'boolean' || v.apiKey !== undefined && typeof v.apiKey !== 'string') throw new PlatformError('SPEECH_INVALID_INPUT', '密钥参数无效。', 400, 'not-sent')
    const changedService = v.endpoint !== undefined && v.endpoint !== this.value.endpoint || isJsonObject(v.provider) && v.provider.protocol !== this.value.provider.protocol
    let next: PrivateConfiguration
    try { next = parse({ ...this.value, ...Object.fromEntries(Object.entries(v).filter(([k]) => !['expectedRevision', 'apiKey', 'clearApiKey'].includes(k))), revision: this.value.revision + 1, apiKey: v.clearApiKey === true ? '' : typeof v.apiKey === 'string' && v.apiKey.trim() ? v.apiKey : changedService ? '' : this.value.apiKey }) }
    catch { throw new PlatformError('SPEECH_INVALID_CONFIGURATION', '请检查地址、模型、音色和超时设置。', 400, 'not-sent') }
    const bytes = json(next); write(this.path, bytes); this.value = next; this.stamp = hash(bytes)
  }
}
