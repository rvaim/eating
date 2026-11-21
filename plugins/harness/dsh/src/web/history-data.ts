import { HostApiError } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'

export interface SessionHistoryItem {
  readonly id: string
  readonly parentId: string | null
  readonly isRoot: boolean
  readonly isCurrentRoot: boolean
  readonly role: 'root' | 'conversation' | 'proactive' | 'execution' | 'other'
  readonly label: string
  readonly agentTypeId: string | null
  readonly live: boolean
  readonly archived: boolean
  readonly pinned: boolean
  readonly scheduled: boolean
  readonly deletable: boolean
  readonly requiresRestart: boolean
  readonly blockReason: 'live' | 'scheduled' | null
  readonly sizeBytes: number
  readonly createdAt: string | null
  readonly updatedAt: string | null
}
export interface SessionHistoryPreview {
  readonly previewId: string
  readonly expiresAt: string
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
  readonly residualStateCount: number
  readonly runtimeRunning: boolean
  readonly hasPendingQueue: boolean
  readonly sessions: readonly SessionHistoryItem[]
}
export interface SessionHistoryResult {
  readonly requestId: string
  readonly status: 'completed'
  readonly deletedCount: number
  readonly mode?: 'clear' | 'selected-online' | 'selected-offline' | 'residual'
  readonly restarted?: boolean
  readonly clearedResidualCount?: number
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestampOrNull = (value: unknown): value is string | null => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)))
const previewKeys = new Set(['previewId', 'expiresAt', 'sessionCount', 'rootCount', 'childCount', 'residualStateCount', 'runtimeRunning', 'hasPendingQueue', 'sessions'])
const itemKeys = new Set(['id', 'parentId', 'isRoot', 'isCurrentRoot', 'role', 'label', 'agentTypeId', 'live', 'archived', 'pinned', 'scheduled', 'deletable', 'requiresRestart', 'blockReason', 'sizeBytes', 'createdAt', 'updatedAt'])
const resultKeys = new Set(['requestId', 'status', 'deletedCount', 'mode', 'restarted', 'clearedResidualCount'])
const validRoles = new Set(['root', 'conversation', 'proactive', 'execution', 'other'])
function invalid(outcome: 'failed' | 'unknown'): never { throw new HostApiError('SESSION_HISTORY_RESPONSE_INVALID', '', outcome) }

function readSessionHistoryItem(value: unknown): SessionHistoryItem {
  if (!isJsonObject(value) || Object.keys(value).some(key => !itemKeys.has(key)) || !itemKeys.size) invalid('failed')
  for (const key of itemKeys) if (!Object.hasOwn(value, key)) invalid('failed')
  if (typeof value.id !== 'string' || !value.id.length || value.id.length > 256) invalid('failed')
  if (value.parentId !== null && (typeof value.parentId !== 'string' || !value.parentId.length || value.parentId.length > 256)) invalid('failed')
  if (typeof value.isRoot !== 'boolean' || typeof value.isCurrentRoot !== 'boolean') invalid('failed')
  if (typeof value.role !== 'string' || !validRoles.has(value.role)) invalid('failed')
  if (typeof value.label !== 'string' || value.label.length > 512) invalid('failed')
  if (value.agentTypeId !== null && (typeof value.agentTypeId !== 'string' || value.agentTypeId.length > 256)) invalid('failed')
  if (typeof value.live !== 'boolean' || typeof value.archived !== 'boolean' || typeof value.pinned !== 'boolean' || typeof value.scheduled !== 'boolean' || typeof value.deletable !== 'boolean' || typeof value.requiresRestart !== 'boolean') invalid('failed')
  if (value.blockReason !== null && value.blockReason !== 'live' && value.blockReason !== 'scheduled') invalid('failed')
  if (!count(value.sizeBytes) || !timestampOrNull(value.createdAt) || !timestampOrNull(value.updatedAt)) invalid('failed')
  return {
    id: value.id,
    parentId: value.parentId,
    isRoot: value.isRoot,
    isCurrentRoot: value.isCurrentRoot,
    role: value.role as SessionHistoryItem['role'],
    label: value.label,
    agentTypeId: value.agentTypeId,
    live: value.live,
    archived: value.archived,
    pinned: value.pinned,
    scheduled: value.scheduled,
    deletable: value.deletable,
    requiresRestart: value.requiresRestart,
    blockReason: value.blockReason,
    sizeBytes: value.sizeBytes,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

export function readSessionHistoryPreview(value: unknown): SessionHistoryPreview {
  if (!isJsonObject(value) || Object.keys(value).some(key => !previewKeys.has(key))
    || !uuid(value.previewId) || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))
    || !count(value.sessionCount) || !count(value.rootCount) || !count(value.childCount) || value.sessionCount !== value.rootCount + value.childCount) invalid('failed')
  const residualStateCount = value.residualStateCount === undefined ? 0 : count(value.residualStateCount) ? value.residualStateCount : invalid('failed')
  const runtimeRunning = value.runtimeRunning === undefined ? false : typeof value.runtimeRunning === 'boolean' ? value.runtimeRunning : invalid('failed')
  const hasPendingQueue = value.hasPendingQueue === undefined ? false : typeof value.hasPendingQueue === 'boolean' ? value.hasPendingQueue : invalid('failed')
  const sessions = value.sessions === undefined ? [] : Array.isArray(value.sessions) ? value.sessions.map(readSessionHistoryItem) : invalid('failed')
  return {
    previewId: value.previewId,
    expiresAt: value.expiresAt,
    sessionCount: value.sessionCount,
    rootCount: value.rootCount,
    childCount: value.childCount,
    residualStateCount,
    runtimeRunning,
    hasPendingQueue,
    sessions,
  }
}

export function readSessionHistoryResult(value: unknown, requestId: string, expectedDeletedCount: number): SessionHistoryResult {
  if (!isJsonObject(value) || Object.keys(value).some(key => !resultKeys.has(key))
    || !uuid(value.requestId) || value.requestId !== requestId || value.status !== 'completed' || !count(value.deletedCount) || value.deletedCount !== expectedDeletedCount) invalid('unknown')
  if (value.mode !== undefined && (typeof value.mode !== 'string' || !['clear', 'selected-online', 'selected-offline', 'residual'].includes(value.mode))) invalid('unknown')
  if (value.restarted !== undefined && typeof value.restarted !== 'boolean') invalid('unknown')
  if (value.clearedResidualCount !== undefined && !count(value.clearedResidualCount)) invalid('unknown')
  return {
    requestId: value.requestId,
    status: 'completed',
    deletedCount: value.deletedCount,
    ...(value.mode !== undefined ? { mode: value.mode as SessionHistoryResult['mode'] } : {}),
    ...(value.restarted !== undefined ? { restarted: value.restarted } : {}),
    ...(value.clearedResidualCount !== undefined ? { clearedResidualCount: value.clearedResidualCount } : {}),
  }
}
