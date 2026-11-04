import { HostApiError } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'

export interface SessionHistoryPreview {
  readonly previewId: string
  readonly expiresAt: string
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
}
export interface SessionHistoryResult {
  readonly requestId: string
  readonly status: 'completed'
  readonly deletedCount: number
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function invalid(outcome: 'failed' | 'unknown'): never { throw new HostApiError('SESSION_HISTORY_RESPONSE_INVALID', '', outcome) }

export function readSessionHistoryPreview(value: unknown): SessionHistoryPreview {
  if (!isJsonObject(value) || Object.keys(value).some(key => !['previewId', 'expiresAt', 'sessionCount', 'rootCount', 'childCount'].includes(key))
    || !uuid(value.previewId) || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))
    || !count(value.sessionCount) || !count(value.rootCount) || !count(value.childCount) || value.sessionCount !== value.rootCount + value.childCount) invalid('failed')
  return { previewId: value.previewId, expiresAt: value.expiresAt, sessionCount: value.sessionCount, rootCount: value.rootCount, childCount: value.childCount }
}

export function readSessionHistoryResult(value: unknown, requestId: string, sessionCount: number): SessionHistoryResult {
  if (!isJsonObject(value) || Object.keys(value).some(key => !['requestId', 'status', 'deletedCount'].includes(key))
    || !uuid(value.requestId) || value.requestId !== requestId || value.status !== 'completed' || !count(value.deletedCount) || value.deletedCount !== sessionCount) invalid('unknown')
  return { requestId: value.requestId, status: 'completed', deletedCount: value.deletedCount }
}
