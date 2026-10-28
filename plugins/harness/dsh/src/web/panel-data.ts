import { HostApiError } from '@eating/ui-sdk'
import type { HarnessSessionContent, HarnessSessionList, HarnessSessionRecord, HarnessSessionSummary, JsonValue } from '@eating/plugin-sdk'

export interface ModelOption { readonly id: string; readonly name?: string }
export interface ModelTestResult { readonly ok: true; readonly model: string; readonly latencyMs: number }
export interface SessionRow { readonly session: HarnessSessionSummary; readonly depth: number; readonly issue: 'parent-missing' | 'cycle' | null }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const date = (value: unknown): value is string | null => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }

export function readModels(value: unknown): readonly ModelOption[] {
  if (!object(value) || !Array.isArray(value.models) || value.models.length > 2000) return invalid()
  const seen = new Set<string>()
  return value.models.map(entry => {
    if (!object(entry) || !text(entry.id, 160) || !entry.id.trim() || seen.has(entry.id) || entry.name !== undefined && !text(entry.name, 256)) return invalid()
    seen.add(entry.id)
    return { id: entry.id, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) }
  })
}

export function readModelTest(value: unknown, model: string): ModelTestResult {
  if (!object(value) || value.ok !== true || value.model !== model || !integer(value.latencyMs) || value.latencyMs > 120_000) return invalid()
  return { ok: true, model, latencyMs: value.latencyMs }
}

function summary(value: unknown): HarnessSessionSummary {
  if (!object(value) || !text(value.id, 160) || !value.id || value.parentId !== null && (!text(value.parentId, 160) || !value.parentId)
    || !text(value.title, 1000) || !['running', 'idle', 'stopped', 'unknown'].includes(String(value.status)) || !date(value.updatedAt)
    || value.agentTypeId !== undefined && !text(value.agentTypeId, 160) || value.configurationRevision !== undefined && !integer(value.configurationRevision)
    || value.pluginId !== undefined && !text(value.pluginId, 80) || value.targetId !== undefined && !text(value.targetId, 160)
    || value.conversationKind !== undefined && !['private', 'group'].includes(String(value.conversationKind))) return invalid()
  return { id: value.id, parentId: value.parentId, title: value.title, status: value.status as HarnessSessionSummary['status'], updatedAt: value.updatedAt,
    ...(typeof value.pluginId === 'string' ? { pluginId: value.pluginId } : {}), ...(typeof value.targetId === 'string' ? { targetId: value.targetId } : {}),
    ...(value.conversationKind === 'private' || value.conversationKind === 'group' ? { conversationKind: value.conversationKind } : {}),
    ...(typeof value.agentTypeId === 'string' ? { agentTypeId: value.agentTypeId } : {}), ...(typeof value.configurationRevision === 'number' ? { configurationRevision: value.configurationRevision } : {}) }
}

function jsonValue(value: unknown): value is JsonValue {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const entry = stack.pop()!
    if (++nodes > 50_000 || entry.depth > 64) return false
    if (entry.value === null || typeof entry.value === 'string' || typeof entry.value === 'boolean' || typeof entry.value === 'number' && Number.isFinite(entry.value)) continue
    if (Array.isArray(entry.value)) {
      if (entry.value.length + nodes + stack.length > 50_000) return false
      for (const item of entry.value) stack.push({ value: item, depth: entry.depth + 1 })
    }
    else if (object(entry.value)) {
      for (const [key, child] of Object.entries(entry.value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false
        stack.push({ value: child, depth: entry.depth + 1 })
      }
    } else return false
  }
  return true
}

export function readSessionList(value: unknown): HarnessSessionList {
  if (!object(value) || !Array.isArray(value.sessions) || value.sessions.length > 100 || typeof value.truncated !== 'boolean' || typeof value.refreshedAt !== 'string' || !date(value.refreshedAt)) return invalid()
  const sessions = value.sessions.map(summary)
  return { sessions, truncated: value.truncated, refreshedAt: value.refreshedAt }
}

export function readSessionContent(value: unknown, sessionId: string, offset: number): HarnessSessionContent {
  if (!object(value) || !Array.isArray(value.records) || value.records.length > 50 || typeof value.refreshedAt !== 'string' || !date(value.refreshedAt)
    || value.nextOffset !== null && (!integer(value.nextOffset) || value.nextOffset <= offset)) return invalid()
  const session = summary(value.session)
  if (session.id !== sessionId) return invalid()
  let previous = -1
  const records = value.records.map((entry): HarnessSessionRecord => {
    if (!object(entry) || !integer(entry.sequence) || entry.sequence <= previous || !date(entry.timestamp) || !text(entry.kind, 100) || !entry.kind
      || entry.role !== undefined && !text(entry.role, 100) || !jsonValue(entry.content)) return invalid()
    previous = entry.sequence
    return { sequence: entry.sequence, timestamp: entry.timestamp, kind: entry.kind, content: entry.content,
      ...(typeof entry.role === 'string' ? { role: entry.role } : {}) }
  })
  return { session, records, nextOffset: value.nextOffset, refreshedAt: value.refreshedAt }
}

/** Bound hierarchy traversal and display every unique session once, including orphans and cycles. */
export function sessionRows(sessions: readonly HarnessSessionSummary[]): readonly SessionRow[] {
  const unique = [...new Map(sessions.map(session => [session.id, session])).values()].slice(0, 100)
  const ids = new Set(unique.map(session => session.id))
  const children = new Map<string, HarnessSessionSummary[]>()
  for (const session of unique) if (session.parentId) children.set(session.parentId, [...children.get(session.parentId) ?? [], session])
  const visited = new Set<string>()
  const rows: SessionRow[] = []
  const walk = (session: HarnessSessionSummary, depth: number, issue: SessionRow['issue']) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    rows.push({ session, depth, issue })
    for (const child of children.get(session.id) ?? []) walk(child, depth + 1, null)
  }
  for (const session of unique) if (session.parentId === null || !ids.has(session.parentId)) walk(session, 0, session.parentId === null ? null : 'parent-missing')
  for (const session of unique) if (!visited.has(session.id)) walk(session, 0, 'cycle')
  return rows
}

export function appendSessionRecords(previous: readonly HarnessSessionRecord[], page: HarnessSessionContent, sessionId: string): readonly HarnessSessionRecord[] {
  if (page.session.id !== sessionId || previous.length + page.records.length > 1000) return invalid()
  const last = previous.at(-1)?.sequence ?? -1
  if (page.records.length && page.records[0]!.sequence <= last) return invalid()
  return [...previous, ...page.records]
}

/** Reasoning entries stay private even if an older backend returns one. */
export function visibleSessionRecord(record: HarnessSessionRecord): boolean {
  return !/reasoning|thinking|analysis/i.test(record.kind) && !/^(analysis|reasoning|thinking)$/i.test(record.role ?? '')
}

export function recordText(content: JsonValue): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.filter(item => object(item) && item.type === 'text' && typeof item.text === 'string').map(item => (item as { text: string }).text)
    return parts.length ? parts.join('\n') : null
  }
  if (object(content)) {
    if (typeof content.text === 'string' && !/reasoning|thinking|analysis/i.test(String(content.type ?? ''))) return content.text
    if (typeof content.content === 'string') return content.content
  }
  return null
}
