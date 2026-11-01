import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryConfiguration, MemorySettings, ScopeRule } from '../types'
import { DEFAULT_SETTINGS } from '../types'
import { directory, readBytes, writeJson } from './files'
import { peerId } from './scopes'
import { bool, error, identity, identifier, integer, LIMITS, object, platform, serviceIdentity, text } from './validation'

export interface PrivateConfiguration {
  schemaVersion: 1; revision: number; endpoint: string; account: string; user: string; apiKey: string; autoConnect: boolean; timeoutMs: number; settings: MemorySettings
}
const defaultConfiguration = (): PrivateConfiguration => ({ schemaVersion: 1, revision: 0, endpoint: '', account: '', user: '', apiKey: '', autoConnect: false, timeoutMs: 15000, settings: structuredClone(DEFAULT_SETTINGS) })
const hash = (value: Buffer | null): string | null => value === null ? null : createHash('sha256').update(value).digest('hex')
export function endpoint(value: unknown): string {
  const input = text(value, 2048, true)
  if (!input) return ''
  let url: URL
  try { url = new URL(input) } catch { throw error('MEMORY_INVALID_CONFIGURATION') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[?#]/.test(input)) throw error('MEMORY_INVALID_CONFIGURATION')
  return url.href.replace(/\/+$/, '')
}
export function settings(value: unknown): MemorySettings {
  const input = object(value, Object.keys(DEFAULT_SETTINGS))
  if (!['batch', 'turn', 'tokens'].includes(String(input.submissionMode)) || typeof input.scoreThreshold !== 'number' || !Number.isFinite(input.scoreThreshold) || input.scoreThreshold < 0 || input.scoreThreshold > 1 || !Array.isArray(input.rules) || input.rules.length > LIMITS.scopes) throw error('MEMORY_INVALID_CONFIGURATION')
  const ids = new Set<string>(), peers = new Set<string>()
  const rules: ScopeRule[] = input.rules.map(value => {
    const rule = object(value, ['id', 'label', 'platform', 'accountId', 'kind', 'targetId', 'capture', 'recall', 'memberMode', 'memberIds'])
    if (!['private', 'group'].includes(String(rule.kind)) || !['all', 'allowlist', 'denylist'].includes(String(rule.memberMode)) || !Array.isArray(rule.memberIds) || rule.memberIds.length > 1000) throw error('MEMORY_INVALID_CONFIGURATION')
    const result: ScopeRule = { id: identifier(rule.id), label: text(rule.label, 160, true), platform: platform(rule.platform), accountId: identity(rule.accountId), kind: rule.kind as 'private' | 'group', targetId: identity(rule.targetId), capture: bool(rule.capture), recall: bool(rule.recall), memberMode: rule.memberMode as ScopeRule['memberMode'], memberIds: rule.memberIds.map(value => identity(value)) }
    const peer = peerId({ ...result, owner: false })
    if (ids.has(result.id) || peers.has(peer) || new Set(result.memberIds).size !== result.memberIds.length) throw error('MEMORY_INVALID_CONFIGURATION')
    ids.add(result.id); peers.add(peer)
    return result
  })
  return { enabled: bool(input.enabled), autoCapture: bool(input.autoCapture), autoRecall: bool(input.autoRecall), globalMemory: bool(input.globalMemory), ownerCrossSession: bool(input.ownerCrossSession), privateCapture: bool(input.privateCapture), privateRecall: bool(input.privateRecall), groupCapture: bool(input.groupCapture), groupRecall: bool(input.groupRecall), submissionMode: input.submissionMode as MemorySettings['submissionMode'], batchMessages: integer(input.batchMessages, 1, 100), batchChars: integer(input.batchChars, 256, 100000), idleSeconds: integer(input.idleSeconds, 5, 86400), tokenThreshold: integer(input.tokenThreshold, 128, 50000), recallLimit: integer(input.recallLimit, 1, 50), recallMaxChars: integer(input.recallMaxChars, 256, 50000), scoreThreshold: input.scoreThreshold, rules }
}
function configuration(value: unknown): PrivateConfiguration {
  const input = object(value, Object.keys(defaultConfiguration()))
  if (input.schemaVersion !== 1) throw error('MEMORY_INVALID_CONFIGURATION')
  const apiKey = text(input.apiKey, 4096, true)
  if (/[\r\n]/.test(apiKey)) throw error('MEMORY_INVALID_CONFIGURATION')
  return { schemaVersion: 1, revision: integer(input.revision, 0, Number.MAX_SAFE_INTEGER), endpoint: endpoint(input.endpoint), account: serviceIdentity(input.account, true, true), user: serviceIdentity(input.user, true), apiKey, autoConnect: bool(input.autoConnect), timeoutMs: integer(input.timeoutMs, 1000, 120000), settings: settings(input.settings) }
}
export function configured(value: PrivateConfiguration): boolean { return Boolean(value.endpoint && value.user) }
/** Binds recovery metadata to its server identity without persisting credentials or URLs in jobs. */
export function configurationKey(value: PrivateConfiguration): string { return createHash('sha256').update(JSON.stringify([value.endpoint, value.account, value.user])).digest('hex') }
export class ConfigurationStore {
  private value: PrivateConfiguration
  private stamp: string | null
  private readonly path: string
  constructor(root: string) {
    this.path = join(directory(root), 'config.json')
    const bytes = readBytes(this.path, 2 * 1024 * 1024); this.stamp = hash(bytes)
    try { this.value = bytes ? configuration(JSON.parse(bytes.toString('utf8'))) : defaultConfiguration() }
    catch { throw error('MEMORY_CONFIGURATION_CORRUPTED', 500) }
  }
  snapshot(): PrivateConfiguration { return structuredClone(this.value) }
  public(ready: boolean): MemoryConfiguration { const { apiKey, ...value } = this.snapshot(); return { ...value, apiKeyConfigured: Boolean(apiKey), ready: ready && configured(value as PrivateConfiguration) } }
  prepare(value: unknown): PrivateConfiguration {
    try {
      const input = object(value, ['expectedRevision', 'endpoint', 'account', 'user', 'apiKey', 'clearApiKey', 'autoConnect', 'timeoutMs', 'settings'], ['expectedRevision', 'endpoint', 'account', 'user', 'autoConnect', 'timeoutMs', 'settings'])
      if (input.expectedRevision !== this.value.revision || !Number.isSafeInteger(input.expectedRevision)) throw error('MEMORY_CONFIGURATION_CONFLICT', 409)
      if (input.clearApiKey !== undefined) bool(input.clearApiKey)
      const apiKey = input.apiKey === undefined ? '' : text(input.apiKey, 4096, true)
      if (input.clearApiKey === true && apiKey) throw error('MEMORY_INVALID_CONFIGURATION')
      return configuration({ schemaVersion: 1, revision: this.value.revision + 1, endpoint: input.endpoint, account: input.account, user: input.user, apiKey: input.clearApiKey === true ? '' : apiKey || this.value.apiKey, autoConnect: input.autoConnect, timeoutMs: input.timeoutMs, settings: input.settings })
    } catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'MEMORY_CONFIGURATION_CONFLICT') throw cause; throw error('MEMORY_INVALID_CONFIGURATION') }
  }
  commit(next: PrivateConfiguration): void {
    if (next.revision !== this.value.revision + 1 || hash(readBytes(this.path, 2 * 1024 * 1024)) !== this.stamp) throw error('MEMORY_CONFIGURATION_CONFLICT', 409)
    writeJson(this.path, next)
    this.value = structuredClone(next); this.stamp = hash(readBytes(this.path, 2 * 1024 * 1024))
  }
}
