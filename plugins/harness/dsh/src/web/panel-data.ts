import { HostApiError } from '@eating/ui-sdk'
import type { HarnessPlatformMessage, HarnessSessionContent, HarnessSessionList, HarnessSessionRecord, HarnessSessionSummary, JsonValue } from '@eating/plugin-sdk'

export interface ModelOption { readonly id: string; readonly name?: string }
export interface ModelTestResult { readonly ok: true; readonly model: string; readonly latencyMs: number }
export interface SystemDshStatus {
  readonly found: boolean
  readonly path: string | null
  readonly version: string | null
  readonly source: 'override' | 'path' | 'common' | 'application' | null
}
export interface ModelCapabilities { readonly schemaVersion: 1; readonly revision: number; readonly imageInput: boolean }
export interface SessionRow { readonly session: HarnessSessionSummary; readonly depth: number; readonly issue: 'parent-missing' | 'cycle' | null }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const date = (value: unknown): value is string | null => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))

export function readSystemDsh(value: unknown): SystemDshStatus {
  if (!object(value) || !onlyKeys(value, ['found', 'path', 'version', 'source']) || typeof value.found !== 'boolean') return invalid()
  if (value.found === false) {
    if (value.path !== null || value.version !== null || value.source !== null) return invalid()
    return { found: false, path: null, version: null, source: null }
  }
  if (!text(value.path, 2048) || !value.path || !text(value.version, 64) || !value.version
    || !['override', 'path', 'common', 'application'].includes(String(value.source))) return invalid()
  return { found: true, path: value.path, version: value.version, source: value.source as SystemDshStatus['source'] }
}

export function readModelCapabilities(value: unknown): ModelCapabilities {
  if (!object(value) || !onlyKeys(value, ['schemaVersion', 'revision', 'imageInput']) || value.schemaVersion !== 1
    || !integer(value.revision) || typeof value.imageInput !== 'boolean') return invalid()
  return { schemaVersion: 1, revision: value.revision, imageInput: value.imageInput }
}

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
    || value.pluginName !== undefined && !text(value.pluginName, 256) || value.instanceId !== undefined && !text(value.instanceId, 160)
    || value.accountId !== undefined && !text(value.accountId, 160)
    || value.conversationKind !== undefined && !['private', 'group'].includes(String(value.conversationKind))) return invalid()
  return { id: value.id, parentId: value.parentId, title: value.title, status: value.status as HarnessSessionSummary['status'], updatedAt: value.updatedAt,
    ...(typeof value.pluginName === 'string' ? { pluginName: value.pluginName } : {}), ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
    ...(typeof value.accountId === 'string' ? { accountId: value.accountId } : {}),
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

const classifications = ['platform-message', 'agent-message', 'subagent-settled', 'time-context', 'model-output', 'system-context', 'tool-call', 'tool-result', 'user-message', 'runtime-context'] as const

function readSource(value: unknown): NonNullable<HarnessSessionRecord['source']> {
  if (!object(value) || !onlyKeys(value, ['kind', 'form', 'senderSessionId', 'summary', 'provider', 'model']) || !text(value.kind, 100) || !value.kind
    || ['form', 'senderSessionId', 'summary', 'provider', 'model'].some(key => value[key] !== undefined && !text(value[key], key === 'summary' ? 4000 : 256))) return invalid()
  return { kind: value.kind, ...Object.fromEntries(['form', 'senderSessionId', 'summary', 'provider', 'model'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) }
}

function readPlatformMessage(value: unknown): HarnessPlatformMessage {
  const required = ['eventId', 'pluginId', 'instanceId', 'accountId', 'conversationId', 'senderId', 'targetId']
  if (!object(value) || !onlyKeys(value, [...required, 'conversationKind', 'senderName', 'messageId', 'receivedAt', 'text'])
    || required.some(key => !text(value[key], 256) || !value[key]) || !['private', 'group'].includes(String(value.conversationKind))
    || typeof value.receivedAt !== 'string' || !date(value.receivedAt)
    || ['senderName', 'messageId', 'text'].some(key => value[key] !== undefined && !text(value[key], key === 'text' ? 250_000 : 1000))) return invalid()
  return { eventId: value.eventId as string, pluginId: value.pluginId as string, instanceId: value.instanceId as string,
    accountId: value.accountId as string, conversationId: value.conversationId as string, senderId: value.senderId as string,
    targetId: value.targetId as string, conversationKind: value.conversationKind as 'private' | 'group', receivedAt: value.receivedAt,
    ...(typeof value.senderName === 'string' ? { senderName: value.senderName } : {}), ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}) }
}

function readRecord(entry: unknown): HarnessSessionRecord {
  if (!object(entry) || !integer(entry.sequence) || !date(entry.timestamp) || !text(entry.kind, 100) || !entry.kind
    || entry.role !== undefined && !text(entry.role, 100) || !jsonValue(entry.content)
    || ['messageId', 'callId'].some(key => entry[key] !== undefined && (!text(entry[key], 256) || !entry[key]))
    || ['turn', 'step'].some(key => entry[key] !== undefined && !integer(entry[key]))
    || entry.classification !== undefined && !classifications.includes(entry.classification as typeof classifications[number])
    || entry.platformEvents !== undefined && (!Array.isArray(entry.platformEvents) || entry.platformEvents.length > 256)
    || entry.sourceEventSeqs !== undefined && (!Array.isArray(entry.sourceEventSeqs) || entry.sourceEventSeqs.length > 1000 || !entry.sourceEventSeqs.every(integer))) return invalid()
  let surfaceOp: HarnessSessionRecord['surfaceOp']
  if (entry.surfaceOp !== undefined) {
    if (entry.surfaceOp === 'append') surfaceOp = 'append'
    else if (object(entry.surfaceOp) && onlyKeys(entry.surfaceOp, ['op', 'startSeq', 'endSeq']) && entry.surfaceOp.op === 'replace'
      && integer(entry.surfaceOp.startSeq) && integer(entry.surfaceOp.endSeq) && entry.surfaceOp.startSeq <= entry.surfaceOp.endSeq) {
      surfaceOp = { op: 'replace', startSeq: entry.surfaceOp.startSeq, endSeq: entry.surfaceOp.endSeq }
    } else return invalid()
  }
  return { sequence: entry.sequence, timestamp: entry.timestamp, kind: entry.kind, content: entry.content,
    ...(typeof entry.role === 'string' ? { role: entry.role } : {}), ...(typeof entry.messageId === 'string' ? { messageId: entry.messageId } : {}),
    ...(typeof entry.callId === 'string' ? { callId: entry.callId } : {}), ...(typeof entry.turn === 'number' ? { turn: entry.turn } : {}),
    ...(typeof entry.step === 'number' ? { step: entry.step } : {}), ...(entry.source !== undefined ? { source: readSource(entry.source) } : {}),
    ...(entry.classification !== undefined ? { classification: entry.classification as typeof classifications[number] } : {}),
    ...(Array.isArray(entry.platformEvents) ? { platformEvents: entry.platformEvents.map(readPlatformMessage) } : {}), ...(surfaceOp !== undefined ? { surfaceOp } : {}),
    ...(Array.isArray(entry.sourceEventSeqs) ? { sourceEventSeqs: [...entry.sourceEventSeqs] as number[] } : {}) }
}

export function readSessionContent(value: unknown, sessionId: string, offset: number): HarnessSessionContent {
  if (!object(value) || !Array.isArray(value.records) || value.records.length > 50 || typeof value.refreshedAt !== 'string' || !date(value.refreshedAt)
    || value.nextOffset !== null && (!integer(value.nextOffset) || value.nextOffset <= offset)) return invalid()
  const session = summary(value.session)
  if (session.id !== sessionId) return invalid()
  let previous = -1
  const records = value.records.map((entry): HarnessSessionRecord => {
    const record = readRecord(entry)
    if (record.sequence <= previous) return invalid()
    previous = record.sequence
    return record
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

/** Reasoning is never exposed by either the reading view or its detail disclosure. */
export function visibleSessionRecord(record: HarnessSessionRecord): boolean {
  return !/reasoning|thinking|analysis/i.test(record.kind) && !/^(analysis|reasoning|thinking)$/i.test(record.role ?? '')
    && !/^(analysis|reasoning|thinking)$/i.test(record.source?.kind ?? '')
}

export function recordText(content: JsonValue): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.flatMap(item => {
      if (!object(item) || /reasoning|thinking|analysis/i.test(String(item.type ?? '')) || item.type !== 'text') return []
      return typeof item.text === 'string' ? [item.text] : []
    })
    return parts.length ? parts.join('\n') : null
  }
  if (object(content)) {
    if (/reasoning|thinking|analysis/i.test(String(content.type ?? ''))) return null
    if (typeof content.text === 'string') return content.text
    if (content.content !== undefined) return recordText(content.content as JsonValue)
  }
  return null
}

export function safeRecordData(content: JsonValue): JsonValue {
  if (Array.isArray(content)) return content.filter(item => !object(item) || !/reasoning|thinking|analysis/i.test(String(item.type ?? ''))).map(safeRecordData)
  if (!object(content)) return content
  if (/reasoning|thinking|analysis/i.test(String(content.type ?? ''))) return null
  const media = content.type === 'image' || typeof content.mimeType === 'string' && content.mimeType.startsWith('image/')
  return Object.fromEntries(Object.entries(content).filter(([key]) => !/reasoning|thinking|analysis|signature/i.test(key) && !(media && ['data', 'url', 'base64'].includes(key)))
    .map(([key, value]) => [key, safeRecordData(value as JsonValue)]))
}
