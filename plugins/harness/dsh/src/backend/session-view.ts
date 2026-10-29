import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PlatformError } from '@eating/plugin-sdk'
import type { HarnessPlatformMessage, HarnessSessionContent, HarnessSessionList, HarnessSessionRecord, HarnessSessionSummary, JsonValue, RegisteredAgentType } from '@eating/plugin-sdk'
import type { AgentBinding } from './agent-control'
import { agentInstanceLabel } from './agent-label'

type Header = { id: string; parentSession?: string; createdAt?: number }
type SurfaceOp = NonNullable<HarnessSessionRecord['surfaceOp']>
type Event = { seq: number; time?: number; type: string; data: unknown; surfaceOp?: SurfaceOp; sourceEventSeqs?: readonly number[] }
type Message = { id: string; role: string; content: readonly unknown[]; source: unknown; toolCallId?: string; isError?: boolean }
interface ReadHandle { readonly header: Header; readonly inheritedEventCount: number; read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly Event[]; eventState: unknown }>; close(): Promise<void> }
interface Persistence { list(options?: { signal?: AbortSignal }): Promise<readonly { header: Header }[]>; open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandle> }
interface ReaderContext { plugin(plugin: unknown, options: unknown): PromiseLike<unknown>; readonly sessionPersistence: Persistence; readonly fiber: { dispose(): Promise<void> } }
interface NativeSession { readonly surface: { readonly nodes: readonly number[] }; deriveEventMessage(event: Event): Message | null }
interface NativeSessionModule { Session: { fromRestore(id: string, events: readonly Event[], header: Header, inheritedEventCount: number, eventState: unknown, projections: readonly unknown[]): NativeSession } }
export interface NativeSessionReaderOptions {
  dataDirectory: string
  dshBin: string
  rootSessionId: string | null
  bindings: readonly AgentBinding[]
  secrets: readonly string[]
  running: boolean
  agentTypes: readonly Pick<RegisteredAgentType, 'id' | 'pluginId' | 'pluginName'>[]
}
const MAX_BYTES = 1024 * 1024
const MAX_TEXT = 32768
const MAX_SCAN = 2000
const sensitiveName = /(?:api.?key|secret|token|authorization|cookie|credential|pass(?:word)|headers)/i
const digestPattern = /^[a-f0-9]{64}$/
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(): never { throw new PlatformError('SESSION_VIEW_INPUT_INVALID', '会话读取参数无效。', 400, 'not-sent') }
function date(value: unknown): string | null { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null }
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function scrubText(value: string, secrets: readonly string[]): string {
  let text = value
  for (const secret of secrets) if (secret.length >= 3) text = text.split(secret).join('[REDACTED]')
  text = text.replace(/("(?:api[_-]?key|access[_-]?token|authorization|cookies?|credentials?|pass(?:word)|secret)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3')
  text = text.replace(/\bBearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]')
  text = text.replace(/((?:api[_-]?key|access[_-]?token|authorization|cookies?|credentials?|pass(?:word)|secret)["']?\s*[:=]\s*["']?)[^\s,"'\n}]+/gi, '$1[REDACTED]')
  return text
}
function scrub(value: unknown, secrets: readonly string[], depth = 0, budget = { nodes: 0, characters: 131072 }): JsonValue {
  if (++budget.nodes > 5000 || depth > 16 || budget.characters <= 0) return '[TRUNCATED]'
  if (typeof value === 'string') { const text = scrubText(value, secrets).slice(0, Math.min(MAX_TEXT, budget.characters)); budget.characters -= text.length; return text }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value as JsonValue
  if (Array.isArray(value)) return value.filter(item => !object(item) || !['thinking', 'reasoning', 'redacted_thinking'].includes(String(item.type))).slice(0, 200).map(item => scrub(item, secrets, depth + 1, budget))
  if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).filter(([key]) => !['__proto__', 'constructor', 'prototype', 'thinking', 'reasoning', 'reasoning_content', 'reasoningText', 'signature'].includes(key)).map(([key, item]) => { const name = scrubText(key.slice(0, 160), secrets); budget.characters -= name.length; return [name, sensitiveName.test(key) ? '[REDACTED]' : scrub(item, secrets, depth + 1, budget)] }))
  return null
}
function summary(header: Header, options: NativeSessionReaderOptions): HarnessSessionSummary {
  const binding = options.bindings.find(entry => entry.scope.agentId === header.id)
  const pluginName = binding && options.agentTypes.find(type => type.id === binding.scope.agentTypeId && type.pluginId === binding.scope.pluginId)?.pluginName
  return { id: header.id, parentId: header.parentSession ?? null, title: binding ? agentInstanceLabel(binding.scope, pluginName) : header.id === options.rootSessionId ? 'Main Agent' : 'Agent',
    ...(binding ? { agentTypeId: binding.scope.agentTypeId, pluginId: binding.scope.pluginId, ...(pluginName ? { pluginName } : {}), instanceId: binding.scope.instanceId, accountId: binding.scope.accountId, conversationKind: binding.scope.kind, targetId: binding.scope.targetId } : {}), status: options.running ? 'unknown' : 'stopped', updatedAt: null }
}
function authorize(headers: readonly Header[], options: NativeSessionReaderOptions): Header[] {
  if (!options.rootSessionId) return []
  const visible = new Set([options.rootSessionId]); let changed = true
  while (changed) { changed = false; for (const header of headers) if (header.parentSession && visible.has(header.parentSession) && !visible.has(header.id)) { visible.add(header.id); changed = true } }
  return headers.filter(header => visible.has(header.id))
}
async function withReader<T>(options: NativeSessionReaderOptions, read: (persistence: Persistence, request: NodeJS.Require) => Promise<T>, empty: () => T): Promise<T> {
  const root = resolve(options.dataDirectory, 'dsh-home', 'sessions')
  if (!existsSync(root)) return empty()
  const expectedHome = resolve(options.dataDirectory, 'dsh-home')
  if (lstatSync(expectedHome).isSymbolicLink() || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new PlatformError('SESSION_VIEW_DIRECTORY_INVALID', '原生会话目录不可读取。', 409, 'not-sent')
  const actual = realpathSync(root), parent = realpathSync(expectedHome), difference = relative(parent, actual)
  if (!difference || difference.startsWith(`..${sep}`) || difference === '..' || isAbsolute(difference)) throw new PlatformError('SESSION_VIEW_DIRECTORY_INVALID', '原生会话目录范围无效。', 409, 'not-sent')
  const request = createRequire(options.dshBin)
  const cordis = await import(/* @vite-ignore */ pathToFileURL(request.resolve('@deepseek-ai/cordis')).href) as { Context: new () => ReaderContext }
  const jsonl = await import(/* @vite-ignore */ pathToFileURL(request.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as unknown
  const ctx = new cordis.Context()
  try { await ctx.plugin(jsonl, { root: actual, compression: 'none' }); return await read(ctx.sessionPersistence, request) }
  catch (error) {
    if (error instanceof PlatformError) throw error
    throw new PlatformError('SESSION_VIEW_FAILED', '原生会话记录无法读取，请核对运行时与存储状态。', 409, 'not-sent')
  } finally { await ctx.fiber.dispose() }
}
function nativeSource(message: Message, secrets: readonly string[]): HarnessSessionRecord['source'] {
  const source = message.source
  if (!object(source) || !identifier(source.kind)) return undefined
  // Source is native message metadata, never parsed from the message's text or replay state.
  const fields = Object.fromEntries(['form', 'senderSessionId', 'summary', 'provider', 'model'].flatMap(key => typeof source[key] === 'string' ? [[key, scrubText(source[key], secrets).slice(0, key === 'summary' ? 1024 : 256)]] : []))
  return { kind: scrubText(source.kind, secrets), ...fields }
}

/** Recognize current delivery/task envelopes; their external fields never grant authority. */
function platformPayload(message: Message, header: Header, options: NativeSessionReaderOptions): { events: HarnessPlatformMessage[]; delegated: boolean } | undefined {
  if (message.role !== 'user' || !object(message.source) || !['user', 'agent-message'].includes(String(message.source.kind))) return undefined
  for (const block of message.content) {
    if (!object(block) || block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 4 * MAX_BYTES) continue
    let value: unknown
    try { value = JSON.parse(block.text) } catch { continue }
    if (!object(value) || !object(value.eating) || value.eating.protocolVersion !== 1 || !object(value.context) || !Array.isArray(value.events) || !value.events.length || value.events.length > 200) continue
    const { eating, context, events } = value
    const first = events[0]
    if (!object(first) || !object(first.source)) continue
    const binding = options.bindings.find(entry => entry.parentId === options.rootSessionId && entry.scope.pluginId === first.pluginId && entry.scope.instanceId === first.instanceId && entry.scope.accountId === first.accountId && entry.scope.conversationId === first.conversationId && entry.scope.kind === (first.source as Record<string, unknown>).kind && entry.scope.targetId === first.targetId && entry.scope.agentTypeId === context.agentTypeId)
    if (!binding || context.accountId !== binding.scope.accountId || context.instanceId !== binding.scope.instanceId || context.conversationId !== binding.scope.conversationId || context.kind !== binding.scope.kind || typeof context.contextRef !== 'string' || !digestPattern.test(context.contextRef)) continue
    const delegated = header.id === binding.scope.agentId && header.parentSession === options.rootSessionId
    if (delegated) {
      if (eating.contextRef !== context.contextRef || eating.agentTypeId !== binding.scope.agentTypeId || typeof value.task !== 'string' || message.source.kind === 'agent-message' && message.source.senderSessionId !== options.rootSessionId) continue
    } else {
      if (message.source.kind !== 'user' || 'rpcId' in message.source || header.id !== options.rootSessionId || eating.magic !== 'eating-harness-delivery' || eating.sessionId !== options.rootSessionId || eating.batchId !== context.contextRef || typeof eating.digest !== 'string' || !digestPattern.test(eating.digest) || eating.digest !== createHash('sha256').update(JSON.stringify({ context, events })).digest('hex')) continue
    }
    const extracted: HarnessPlatformMessage[] = []
    let metadataBytes = 0
    let valid = true
    for (const event of events) {
      if (!object(event) || !object(event.source) || event.protocolVersion !== 1 || event.source.trust !== 'external' || event.pluginId !== binding.scope.pluginId || event.instanceId !== binding.scope.instanceId || event.accountId !== binding.scope.accountId || event.conversationId !== binding.scope.conversationId || event.source.kind !== binding.scope.kind || event.targetId !== binding.scope.targetId || !identifier(event.eventId) || !identifier(event.senderId) || !identifier(event.receivedAt) || !Number.isFinite(Date.parse(event.receivedAt)) || event.messageId !== undefined && !identifier(event.messageId)) { valid = false; break }
      const text = (value: string): string => scrubText(value, options.secrets)
      const entry: HarnessPlatformMessage = { eventId: text(event.eventId), pluginId: text(binding.scope.pluginId), instanceId: text(binding.scope.instanceId), accountId: text(binding.scope.accountId), conversationId: text(binding.scope.conversationId), conversationKind: binding.scope.kind, senderId: text(event.senderId), targetId: text(binding.scope.targetId), ...(typeof event.messageId === 'string' ? { messageId: text(event.messageId) } : {}), receivedAt: text(event.receivedAt), ...(typeof event.text === 'string' ? { text: text(event.text).slice(0, MAX_TEXT) } : {}) }
      // Keep source metadata bounded independently of the already bounded body.
      const bytes = Buffer.byteLength(JSON.stringify(entry))
      if (metadataBytes + bytes <= 131072) { extracted.push(entry); metadataBytes += bytes }
    }
    if (valid) return { events: extracted, delegated }
  }
  return undefined
}
function classification(message: Message, payload: ReturnType<typeof platformPayload>): HarnessSessionRecord['classification'] {
  if (message.role === 'assistant') return 'model-output'
  if (message.role === 'tool') return 'tool-result'
  if (message.role === 'system' || message.role === 'developer') return 'system-context'
  const kind = object(message.source) ? message.source.kind : undefined
  if (kind === 'agent-message' || kind === 'subagent-settled' || kind === 'time-context') return kind
  if (payload?.delegated) return 'agent-message'
  if (payload) return 'platform-message'
  return kind === 'user' ? 'user-message' : 'runtime-context'
}
function locations(events: readonly Event[]): Map<number, { turn?: number; step?: number }> {
  const result = new Map<number, { turn?: number; step?: number }>()
  let turn: number | undefined, step: number | undefined
  let pending: number[] = []
  for (const event of events) {
    const data = object(event.data) ? event.data : {}
    if (event.type === 'turn/start') { turn = count(data.turn) ? data.turn : undefined; step = undefined; pending = [] }
    if (event.type === 'step/start') {
      step = count(data.step) ? data.step : undefined
      if (data.turn === turn) for (const seq of pending) result.set(seq, { turn, step })
      pending = []
    }
    result.set(event.seq, { ...(turn !== undefined ? { turn } : {}), ...(step !== undefined ? { step } : {}), ...(count(data.turn) ? { turn: data.turn } : {}), ...(count(data.step) ? { step: data.step } : {}) })
    if (event.type === 'user/message' && turn !== undefined && step === undefined) pending.push(event.seq)
    if (event.type === 'step/end') step = undefined
    if (event.type === 'turn/end') { turn = undefined; step = undefined; pending = [] }
  }
  return result
}

/** Each explicit request creates only a persistence reader; no Agent or model is started. */
export async function listNativeSessions(options: NativeSessionReaderOptions, input: unknown): Promise<HarnessSessionList> {
  if (!object(input) || Object.keys(input).length) invalid()
  const refreshedAt = new Date().toISOString()
  return withReader(options, async persistence => {
    const rows = authorize((await persistence.list()).map(row => row.header), options).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    return { sessions: rows.slice(0, 100).map(header => summary(header, options)), truncated: rows.length > 100, refreshedAt }
  }, () => ({ sessions: [], truncated: false, refreshedAt }))
}

export async function readNativeSession(options: NativeSessionReaderOptions, input: unknown): Promise<HarnessSessionContent> {
  if (!object(input) || Object.keys(input).some(key => !['sessionId', 'offset', 'limit'].includes(key)) || typeof input.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.sessionId)) invalid()
  const offset = input.offset === undefined ? 0 : input.offset, limit = input.limit === undefined ? 50 : input.limit
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid()
  const id = input.sessionId
  const missing = (): never => { throw new PlatformError('SESSION_NOT_FOUND', '此原生会话不存在或不属于当前运行时。', 404, 'not-sent') }
  return withReader(options, async (persistence, request) => {
    const headers = authorize((await persistence.list()).map(row => row.header), options)
    const header = headers.find(entry => entry.id === id); if (!header) return missing()
    const handle = await persistence.open(id, 'read')
    try {
      const [native, projections] = await Promise.all([
        import(/* @vite-ignore */ pathToFileURL(request.resolve('@deepseek-ai/dsh-session')).href) as Promise<NativeSessionModule>,
        import(/* @vite-ignore */ pathToFileURL(request.resolve('@deepseek-ai/dsh-session-format-catalog/message-projections')).href) as Promise<{ currentSessionMessageProjections: readonly unknown[] }>,
      ])
      // One immutable observation cut, replayed by the public native Session. Inbox
      // edits/retractions remain log-only; only actually entered messages join surface.
      const snapshot = await handle.read()
      const events = snapshot.events
      const session = native.Session.fromRestore(id, events, handle.header, handle.inheritedEventCount, snapshot.eventState, projections.currentSessionMessageProjections)
      const messages = new Map<number, Message>()
      const calls = new Set<string>()
      for (const seq of session.surface.nodes) {
        const event = events[seq]
        if (!event) continue
        const message = session.deriveEventMessage(event)
        if (!message) continue
        messages.set(seq, message)
        if (message.toolCallId) calls.add(message.toolCallId)
        for (const block of message.content) if (object(block) && block.type === 'tool-call' && typeof block.id === 'string') calls.add(block.id)
      }
      const positions = locations(events)
      const records: HarnessSessionRecord[] = []
      let cursor = offset, bytes = 0
      // Offset/nextOffset are native log positions, never indexes into filtered rows.
      while (cursor < events.length && cursor - offset < MAX_SCAN && records.length < limit) {
        const event = events[cursor]!
        const data = object(event.data) ? event.data : {}
        const message = messages.get(cursor)
        let record: HarnessSessionRecord | undefined
        if (message) {
          const payload = platformPayload(message, header, options)
          const source = nativeSource(message, options.secrets)
          const callId = message.toolCallId ?? (object(message.source) && typeof message.source.callId === 'string' ? message.source.callId : undefined)
          const content = message.role === 'tool' ? { content: message.content, ...(message.isError !== undefined ? { isError: message.isError } : {}), ...(object(data.error) ? { error: data.error } : {}) } : message.content
          record = { sequence: event.seq, timestamp: date(event.time), kind: event.type, role: message.role, messageId: scrubText(message.id, options.secrets), ...positions.get(cursor), ...(callId ? { callId: scrubText(callId, options.secrets) } : {}), ...(source ? { source } : {}), classification: classification(message, payload), ...(payload ? { platformEvents: payload.events } : {}), ...(event.surfaceOp ? { surfaceOp: event.surfaceOp } : {}), ...(event.sourceEventSeqs && event.sourceEventSeqs.length <= MAX_SCAN ? { sourceEventSeqs: event.sourceEventSeqs } : {}), content: scrub(content, options.secrets) }
        } else if (event.type === 'tool/call' && typeof data.callId === 'string' && calls.has(data.callId)) {
          record = { sequence: event.seq, timestamp: date(event.time), kind: event.type, role: 'tool', ...positions.get(cursor), callId: scrubText(data.callId, options.secrets), classification: 'tool-call', content: scrub({ name: data.name, arguments: data.arguments }, options.secrets) }
        }
        if (record) {
          const size = Buffer.byteLength(JSON.stringify(record))
          if (size > MAX_BYTES - 8192) throw new PlatformError('SESSION_VIEW_RECORD_TOO_LARGE', '此会话记录超过单次读取容量。', 409, 'not-sent')
          if (bytes + size > MAX_BYTES - 8192) break
          records.push(record); bytes += size
        }
        cursor = event.seq + 1
      }
      return { session: summary(header, options), records, nextOffset: cursor >= events.length ? null : cursor, refreshedAt: new Date().toISOString() }
    } finally { await handle.close() }
  }, missing)
}

export function nativeReaderOptions(dataDirectory: string, dshBin: string, rootSessionId: string | null, bindings: readonly AgentBinding[], secrets: readonly string[], running: boolean, agentTypes: NativeSessionReaderOptions['agentTypes']): NativeSessionReaderOptions {
  return { dataDirectory, dshBin, rootSessionId, bindings, secrets, running, agentTypes }
}
