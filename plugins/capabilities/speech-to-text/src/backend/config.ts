import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import { directory, json, read, write } from './files'
import type { RecognitionConfiguration } from '../types'
export const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export function args(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!isJsonObject(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw new PlatformError('ASR_INVALID_INPUT', '语音识别参数无效。', 400, 'not-sent')
  return value
}
export function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || !empty && !v.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v)) throw new PlatformError('ASR_INVALID_INPUT', '语音识别文本或配置无效。', 400, 'not-sent')
  return v
}
export interface PrivateConfiguration { schemaVersion: 1; revision: number; endpoint: string; provider: { protocol: 'deepseek-asr' }; timeoutMs: number; apiKey: string }
const defaults: PrivateConfiguration = { schemaVersion: 1, revision: 0, endpoint: 'https://api.deepseek.com/v1/tools/asr', provider: { protocol: 'deepseek-asr' }, timeoutMs: 120000, apiKey: '' }
function parse(input: unknown): PrivateConfiguration {
  const v = args(input, Object.keys(defaults), Object.keys(defaults)), endpoint = text(v.endpoint, 2048), url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.hash || url.search || endpoint.includes('?') || endpoint.includes('#')
    || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || Number(v.revision) >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(v.timeoutMs) || Number(v.timeoutMs) < 10000 || Number(v.timeoutMs) > 600000) throw new Error('Invalid configuration')
  const p = args(v.provider, ['protocol'], ['protocol']); if (p.protocol !== 'deepseek-asr') throw new Error('Unsupported protocol')
  const apiKey = text(v.apiKey, 4096, true); if (/[\r\n]/.test(apiKey)) throw new Error('Invalid key')
  return { schemaVersion: 1, revision: Number(v.revision), endpoint, provider: { protocol: 'deepseek-asr' }, timeoutMs: Number(v.timeoutMs), apiKey }
}
export class RecognitionConfig {
  private value: PrivateConfiguration; private stamp: string | null; private readonly path: string
  constructor(root: string) {
    this.path = join(directory(root), 'config.json'); const bytes = read(this.path, 65536); this.stamp = bytes ? hash(bytes) : null
    try { this.value = bytes ? parse(JSON.parse(bytes.toString())) : structuredClone(defaults) } catch { throw new PlatformError('ASR_CONFIGURATION_CORRUPTED', '识别配置不是当前格式，原文件保留。', 500, 'not-sent') }
  }
  snapshot() { return structuredClone(this.value) }
  public(connected: boolean): RecognitionConfiguration { const { apiKey, ...v } = this.snapshot(); return { ...v, apiKeyConfigured: Boolean(apiKey), ready: connected && Boolean(apiKey) } }
  update(input: unknown) {
    const v = args(input, ['expectedRevision', 'endpoint', 'provider', 'timeoutMs', 'apiKey', 'clearApiKey'], ['expectedRevision']), current = read(this.path, 65536)
    if (v.expectedRevision !== this.value.revision || (current ? hash(current) : null) !== this.stamp) throw new PlatformError('ASR_CONFIGURATION_CONFLICT', '识别配置已变化，请保留草稿并刷新。', 409, 'not-sent')
    if (v.clearApiKey !== undefined && typeof v.clearApiKey !== 'boolean' || v.apiKey !== undefined && typeof v.apiKey !== 'string') throw new PlatformError('ASR_INVALID_INPUT', '密钥参数无效。', 400, 'not-sent')
    let next: PrivateConfiguration
    try { next = parse({ ...this.value, ...Object.fromEntries(Object.entries(v).filter(([k]) => !['expectedRevision', 'apiKey', 'clearApiKey'].includes(k))), revision: this.value.revision + 1, apiKey: v.clearApiKey === true ? '' : typeof v.apiKey === 'string' && v.apiKey.trim() ? v.apiKey : v.endpoint !== undefined && v.endpoint !== this.value.endpoint ? '' : this.value.apiKey }) }
    catch { throw new PlatformError('ASR_INVALID_CONFIGURATION', '请检查识别协议、服务地址与超时。', 400, 'not-sent') }
    const bytes = json(next); write(this.path, bytes); this.value = next; this.stamp = hash(bytes)
  }
}
