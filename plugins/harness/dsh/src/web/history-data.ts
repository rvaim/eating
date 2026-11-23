import { HostApiError } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'

export type DshResetQueueAction = 'none' | 'keep' | 'clear'

export interface DshResetPreview {
  readonly previewId: string
  readonly expiresAt: string
  readonly runtimeRunning: boolean
  readonly sessionCount: number
  readonly rootCount: number
  readonly childCount: number
  readonly scheduledCount: number
  readonly workspaceEntryCount: number
  readonly residualStateCount: number
  readonly hasResettableData: boolean
  readonly hasPendingQueue: boolean
  readonly pendingQueueCount: number
  readonly uncertainQueueCount: number
}

export interface DshResetResult {
  readonly requestId: string
  readonly status: 'completed'
  readonly deletedSessions: number
  readonly clearedWorkspaceEntries: number
  readonly clearedScheduledCount: number
  readonly clearedQueueCount: number
  readonly queueAction: DshResetQueueAction
  readonly wasRunning: boolean
  readonly restarted: boolean
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))

const previewKeys = new Set([
  'previewId',
  'expiresAt',
  'runtimeRunning',
  'sessionCount',
  'rootCount',
  'childCount',
  'scheduledCount',
  'workspaceEntryCount',
  'residualStateCount',
  'hasResettableData',
  'hasPendingQueue',
  'pendingQueueCount',
  'uncertainQueueCount',
])

const resultKeys = new Set([
  'requestId',
  'status',
  'deletedSessions',
  'clearedWorkspaceEntries',
  'clearedScheduledCount',
  'clearedQueueCount',
  'queueAction',
  'wasRunning',
  'restarted',
])

function invalid(outcome: 'failed' | 'unknown'): never {
  throw new HostApiError('DSH_RESET_RESPONSE_INVALID', '', outcome)
}

export function readDshResetPreview(value: unknown): DshResetPreview {
  if (
    !isJsonObject(value)
    || Object.keys(value).some(key => !previewKeys.has(key))
    || !uuid(value.previewId)
    || !isoTimestamp(value.expiresAt)
    || typeof value.runtimeRunning !== 'boolean'
    || !count(value.sessionCount)
    || !count(value.rootCount)
    || !count(value.childCount)
    || value.sessionCount !== value.rootCount + value.childCount
    || !count(value.scheduledCount)
    || !count(value.workspaceEntryCount)
    || !count(value.residualStateCount)
    || typeof value.hasResettableData !== 'boolean'
    || typeof value.hasPendingQueue !== 'boolean'
    || !count(value.pendingQueueCount)
    || !count(value.uncertainQueueCount)
    || value.hasPendingQueue !== (value.pendingQueueCount + value.uncertainQueueCount > 0)
  ) invalid('failed')

  return {
    previewId: value.previewId,
    expiresAt: value.expiresAt,
    runtimeRunning: value.runtimeRunning,
    sessionCount: value.sessionCount,
    rootCount: value.rootCount,
    childCount: value.childCount,
    scheduledCount: value.scheduledCount,
    workspaceEntryCount: value.workspaceEntryCount,
    residualStateCount: value.residualStateCount,
    hasResettableData: value.hasResettableData,
    hasPendingQueue: value.hasPendingQueue,
    pendingQueueCount: value.pendingQueueCount,
    uncertainQueueCount: value.uncertainQueueCount,
  }
}

export function readDshResetResult(value: unknown, requestId: string): DshResetResult {
  if (
    !isJsonObject(value)
    || Object.keys(value).some(key => !resultKeys.has(key))
    || !uuid(value.requestId)
    || value.requestId !== requestId
    || value.status !== 'completed'
    || !count(value.deletedSessions)
    || !count(value.clearedWorkspaceEntries)
    || !count(value.clearedScheduledCount)
    || !count(value.clearedQueueCount)
    || (value.queueAction !== 'none' && value.queueAction !== 'keep' && value.queueAction !== 'clear')
    || typeof value.wasRunning !== 'boolean'
    || typeof value.restarted !== 'boolean'
  ) invalid('unknown')

  return {
    requestId: value.requestId,
    status: 'completed',
    deletedSessions: value.deletedSessions,
    clearedWorkspaceEntries: value.clearedWorkspaceEntries,
    clearedScheduledCount: value.clearedScheduledCount,
    clearedQueueCount: value.clearedQueueCount,
    queueAction: value.queueAction,
    wasRunning: value.wasRunning,
    restarted: value.restarted,
  }
}
