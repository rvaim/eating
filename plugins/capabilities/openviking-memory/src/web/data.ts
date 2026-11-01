import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, MemoryHit, MemoryScope } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import type { MemoryConfiguration, MemoryConfigurationInput, MemoryJob, MemorySettings, RuntimeSnapshot, ScopeRule, ScopeSummary } from '../types'
import type { MemoryTranslationKey } from './i18n'

const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const nullableDate = (value: unknown): value is string | null => value === null || date(value)
const flags = (value: JsonObject, keys: string[]) => keys.every(key => typeof value[key] === 'boolean')
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }
function readRule(value: unknown): ScopeRule {
  if (!isJsonObject(value) || !['id', 'label', 'platform', 'accountId', 'targetId'].every(key => text(value[key]))
    || !['private', 'group'].includes(String(value.kind)) || !flags(value, ['capture', 'recall'])
    || !['all', 'allowlist', 'denylist'].includes(String(value.memberMode)) || !Array.isArray(value.memberIds)
    || value.memberIds.length > 1000 || !value.memberIds.every(value => text(value))) return invalid()
  return { id: value.id as string, label: value.label as string, platform: value.platform as string, accountId: value.accountId as string,
    targetId: value.targetId as string, kind: value.kind as ScopeRule['kind'], capture: value.capture as boolean, recall: value.recall as boolean,
    memberMode: value.memberMode as ScopeRule['memberMode'], memberIds: [...value.memberIds] as string[] }
}
export function readSettings(value: unknown): MemorySettings {
  if (!isJsonObject(value) || !flags(value, ['enabled', 'autoCapture', 'autoRecall', 'globalMemory', 'ownerCrossSession', 'privateCapture', 'privateRecall', 'groupCapture', 'groupRecall'])
    || !['batch', 'turn', 'tokens'].includes(String(value.submissionMode))
    || !['batchMessages', 'batchChars', 'idleSeconds', 'tokenThreshold', 'recallLimit', 'recallMaxChars'].every(key => integer(value[key]))
    || typeof value.scoreThreshold !== 'number' || !Number.isFinite(value.scoreThreshold) || value.scoreThreshold < 0 || value.scoreThreshold > 1
    || !Array.isArray(value.rules) || value.rules.length > 1000) return invalid()
  return { enabled: value.enabled as boolean, autoCapture: value.autoCapture as boolean, autoRecall: value.autoRecall as boolean,
    globalMemory: value.globalMemory as boolean, ownerCrossSession: value.ownerCrossSession as boolean, privateCapture: value.privateCapture as boolean,
    privateRecall: value.privateRecall as boolean, groupCapture: value.groupCapture as boolean, groupRecall: value.groupRecall as boolean,
    submissionMode: value.submissionMode as MemorySettings['submissionMode'], batchMessages: value.batchMessages as number, batchChars: value.batchChars as number,
    idleSeconds: value.idleSeconds as number, tokenThreshold: value.tokenThreshold as number, recallLimit: value.recallLimit as number,
    recallMaxChars: value.recallMaxChars as number, scoreThreshold: value.scoreThreshold, rules: value.rules.map(readRule) }
}
export function readConfiguration(value: unknown): MemoryConfiguration {
  if (!isJsonObject(value) || value.schemaVersion !== 1 || !integer(value.revision) || !text(value.endpoint) || !text(value.account)
    || !text(value.user) || !integer(value.timeoutMs) || !flags(value, ['apiKeyConfigured', 'autoConnect', 'ready'])
    || 'apiKey' in value) return invalid()
  return { schemaVersion: 1, revision: value.revision, endpoint: value.endpoint, account: value.account, user: value.user,
    apiKeyConfigured: value.apiKeyConfigured as boolean, autoConnect: value.autoConnect as boolean, timeoutMs: value.timeoutMs,
    ready: value.ready as boolean, settings: readSettings(value.settings) }
}
function readJob(value: unknown): MemoryJob {
  if (!isJsonObject(value) || !['id', 'peerId', 'sessionId'].every(key => text(value[key]))
    || !['taskId', 'archiveUri', 'errorCode'].every(key => nullableText(value[key]))
    || !['queued', 'submitting', 'processing', 'cleaning', 'completed', 'failed', 'unknown'].includes(String(value.status))
    || !date(value.createdAt) || !date(value.updatedAt) || !integer(value.messages)) return invalid()
  let changes: MemoryJob['changes'] = null
  if (value.changes !== null) {
    if (!isJsonObject(value.changes) || !integer(value.changes.added) || !integer(value.changes.updated) || !integer(value.changes.deleted)) return invalid()
    changes = { added: value.changes.added, updated: value.changes.updated, deleted: value.changes.deleted }
  }
  return { id: value.id as string, peerId: value.peerId as string, sessionId: value.sessionId as string,
    taskId: value.taskId as string | null, archiveUri: value.archiveUri as string | null, errorCode: value.errorCode as string | null,
    status: value.status as MemoryJob['status'], createdAt: value.createdAt, updatedAt: value.updatedAt, messages: value.messages, changes }
}
function readScope(value: unknown): ScopeSummary {
  if (!isJsonObject(value) || !text(value.peerId) || !text(value.label) || !flags(value, ['capture', 'recall'])
    || !integer(value.bufferedMessages) || !nullableDate(value.lastSeenAt) || !isJsonObject(value.scope)
    || !['self', 'private', 'group'].includes(String(value.scope.kind)) || !['platform', 'accountId', 'targetId'].every(key => text((value.scope as JsonObject)[key]))
    || typeof value.scope.owner !== 'boolean') return invalid()
  const scope: MemoryScope = { kind: value.scope.kind as MemoryScope['kind'], platform: value.scope.platform as string,
    accountId: value.scope.accountId as string, targetId: value.scope.targetId as string, owner: value.scope.owner }
  return { peerId: value.peerId, scope, label: value.label, capture: value.capture as boolean, recall: value.recall as boolean,
    bufferedMessages: value.bufferedMessages, lastSeenAt: value.lastSeenAt }
}
export function readSnapshot(value: unknown): RuntimeSnapshot {
  if (!isJsonObject(value) || typeof value.ready !== 'boolean' || !nullableText(value.lastErrorCode) || !nullableDate(value.lastRecallAt)
    || !nullableDate(value.lastCaptureAt) || !integer(value.todayExtractions) || !integer(value.pending)
    || !Array.isArray(value.jobs) || value.jobs.length > 1000 || !Array.isArray(value.scopes) || value.scopes.length > 1000) return invalid()
  return { ready: value.ready, lastErrorCode: value.lastErrorCode, lastRecallAt: value.lastRecallAt, lastCaptureAt: value.lastCaptureAt,
    todayExtractions: value.todayExtractions, pending: value.pending, jobs: value.jobs.map(readJob), scopes: value.scopes.map(readScope) }
}
export function readSearch(value: unknown): MemoryHit[] {
  if (!isJsonObject(value) || !Array.isArray(value.items) || value.items.length > 1000) return invalid()
  return value.items.map(item => {
    if (!isJsonObject(item) || !text(item.uri) || !item.uri.startsWith('viking://') || !text(item.text, 500_000)
      || typeof item.score !== 'number' || !Number.isFinite(item.score)) return invalid()
    return { uri: item.uri, text: item.text, score: item.score }
  })
}
export function readMemory(value: unknown): { uri: string; text: string } {
  if (!isJsonObject(value) || !text(value.uri) || !value.uri.startsWith('viking://') || !text(value.text, 500_000)) return invalid()
  return { uri: value.uri, text: value.text }
}
export async function fetchConfiguration(signal?: AbortSignal): Promise<MemoryConfiguration> {
  return readConfiguration(await hostRequest<unknown>('/plugins/openviking-memory/configuration', { signal }))
}
export async function updateConfiguration(input: MemoryConfigurationInput, signal?: AbortSignal): Promise<MemoryConfiguration> {
  return readConfiguration(await hostRequest<unknown>('/plugins/openviking-memory/configuration', { method: 'POST', body: input, signal }))
}
export function manage(operation: 'snapshot' | 'test-connection' | 'flush' | 'search' | 'read' | 'delete', input: JsonObject, signal?: AbortSignal): Promise<unknown> {
  return hostRequest<unknown>('/plugins/openviking-memory/manage', { method: 'POST', body: { operation, input }, signal })
}
export function connect(signal?: AbortSignal): Promise<unknown> { return hostRequest('/plugins/openviking-memory/connect', { method: 'POST', body: {}, signal }) }

export interface UiFailure { key: MemoryTranslationKey; code?: string }
export function failure(error: unknown, fallback: MemoryTranslationKey = 'error.generic'): UiFailure {
  const code = error instanceof HostApiError ? error.code : ''
  return { key: errorKey(code, fallback), ...(/^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? { code } : {}) }
}
const knownErrors: Readonly<Record<string, MemoryTranslationKey>> = {
  MEMORY_AUTH_FAILED: 'error.auth', MEMORY_IDENTITY_MISMATCH: 'error.auth', MEMORY_ACCESS_DENIED: 'error.denied',
  MEMORY_REDIRECT_DENIED: 'error.redirect', MEMORY_UNSUPPORTED_SERVER: 'error.response', MEMORY_RESPONSE_TOO_LARGE: 'error.response',
  MEMORY_SERVER_NOT_READY: 'error.notReady', MEMORY_NOT_CONFIGURED: 'error.notReady', MEMORY_NOT_READY: 'error.notReady',
  MEMORY_CAPACITY: 'error.capacity', MEMORY_EXTRACTION_FAILED: 'error.extraction', MEMORY_BUFFER_LOST: 'error.bufferLost',
  MEMORY_TASK_PENDING: 'error.taskPending', MEMORY_TASK_UNKNOWN: 'error.unknown', MEMORY_SUBMISSION_UNKNOWN: 'error.unknown',
  MEMORY_STORAGE_FAILED: 'error.storage', MEMORY_CANCELLED: 'error.cancelled', MEMORY_CONFIGURATION_CHANGED: 'error.cancelled',
  MEMORY_SCOPE_DENIED: 'error.denied', MEMORY_URI_DENIED: 'error.denied', MEMORY_CONFIRMATION_REQUIRED: 'error.invalid',
}
export function errorKey(code: string, fallback: MemoryTranslationKey = 'error.generic'): MemoryTranslationKey {
  const known = knownErrors[code]
  if (known) return known
  if (/CONFIGURATION_CONFLICT|CONFIG_CONFLICT/.test(code)) return 'error.conflict'
  if (/CORRUPTED|SCHEMA/.test(code)) return 'error.corrupted'
  if (/HTTP_401|HTTP_403|AUTH|UNAUTHORIZED/.test(code)) return 'error.auth'
  if (/HTTP_429|RATE_LIMIT/.test(code)) return 'error.rateLimit'
  if (/TIMEOUT/.test(code)) return 'error.timeout'
  if (/NETWORK|HOST_UNAVAILABLE|REQUEST_INTERRUPTED/.test(code)) return 'error.network'
  if (/INVALID_HOST_RESPONSE|INVALID_RESPONSE|RESPONSE_TOO_LARGE/.test(code)) return 'error.response'
  if (/NOT_READY|NOT_CONNECTED|UNCONFIGURED|PLUGIN_DISABLED/.test(code)) return 'error.notReady'
  if (/DENIED|FORBIDDEN|UNAVAILABLE_TOOL/.test(code)) return 'error.denied'
  if (/IDEMPOTENCY|UNKNOWN|INTERRUPTED/.test(code)) return 'error.unknown'
  if (/PHASE/.test(code)) return 'error.phase'
  if (/NOT_FOUND/.test(code)) return 'error.notFound'
  if (/BUSY/.test(code)) return 'error.busy'
  if (/INVALID/.test(code)) return 'error.invalid'
  return fallback
}
