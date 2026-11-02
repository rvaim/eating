import { isJsonObject } from '@eating/plugin-sdk'
import { archive } from './state'
import { identifier, integer, schema } from './validation'

export interface IncrementalState {
  session_id: string
  next_sequence: number
  extracted_sequence: number
  pending_messages: number
}
export interface IncrementalReceipt {
  session_id: string
  request_id: string
  status: 'accepted' | 'processing' | 'completed' | 'failed' | 'unknown'
  task_id: string
  from_sequence: number
  to_sequence: number
  changes: { added: number; updated: number; deleted: number } | null
  error_code: string | null
  archive_uris: string[]
}
export function incrementalState(value: unknown, sessionId: string): IncrementalState {
  schema(isJsonObject(value) && value.protocol_version === 1 && value.session_id === sessionId)
  const next = integer(value.next_sequence, 0, Number.MAX_SAFE_INTEGER), extracted = integer(value.extracted_sequence, 0, next)
  const pending = integer(value.pending_messages, 0, Number.MAX_SAFE_INTEGER)
  schema(pending <= next - extracted)
  return { session_id: sessionId, next_sequence: next, extracted_sequence: extracted, pending_messages: pending }
}
export function incrementalReceipt(value: unknown, sessionId: string, requestId: string, user: string): IncrementalReceipt {
  schema(isJsonObject(value) && value.protocol_version === 1 && value.session_id === sessionId && value.request_id === requestId
    && ['accepted', 'processing', 'completed', 'failed', 'unknown'].includes(String(value.status))
    && Array.isArray(value.archive_uris) && value.archive_uris.length <= 100)
  const from = integer(value.from_sequence, 0, Number.MAX_SAFE_INTEGER), to = integer(value.to_sequence, from, Number.MAX_SAFE_INTEGER)
  const taskId = identifier(value.task_id, 160)
  let changes: IncrementalReceipt['changes'] = null
  if (value.changes !== null) {
    schema(isJsonObject(value.changes))
    changes = { added: integer(value.changes.added, 0, Number.MAX_SAFE_INTEGER), updated: integer(value.changes.updated, 0, Number.MAX_SAFE_INTEGER), deleted: integer(value.changes.deleted, 0, Number.MAX_SAFE_INTEGER) }
  }
  schema(value.error_code === null || typeof value.error_code === 'string' && /^MEMORY_[A-Z_]+$/.test(value.error_code))
  schema(value.status !== 'completed' || changes !== null)
  return { session_id: sessionId, request_id: requestId, status: value.status as IncrementalReceipt['status'], task_id: taskId,
    from_sequence: from, to_sequence: to, changes, error_code: value.error_code as string | null,
    archive_uris: value.archive_uris.map(uri => archive(uri, sessionId, user)) }
}
