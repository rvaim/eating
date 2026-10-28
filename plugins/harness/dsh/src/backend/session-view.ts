import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PlatformError } from '@eating/plugin-sdk'
import type { HarnessSessionContent, HarnessSessionList, HarnessSessionRecord, HarnessSessionSummary, JsonValue } from '@eating/plugin-sdk'
import type { AgentBinding } from './agent-control'

type Header = { id: string; parentSession?: string; createdAt?: number }
type Event = { seq: number; time?: number; type: string; data: unknown }
interface ReadHandle { readonly header: Header; read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly Event[] }>; close(): Promise<void> }
interface Persistence { list(options?: { signal?: AbortSignal }): Promise<readonly { header: Header }[]>; open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandle> }
interface ReaderContext { plugin(plugin: unknown, options: unknown): PromiseLike<unknown>; readonly sessionPersistence: Persistence; readonly fiber: { dispose(): Promise<void> } }
interface ReaderOptions { dataDirectory: string; dshBin: string; rootSessionId: string | null; bindings: readonly AgentBinding[]; secrets: readonly string[]; running: boolean }
const MAX_BYTES = 1024 * 1024
const MAX_TEXT = 32768
const allowedTypes = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result', 'tool/call', 'tool/ptc-dispatch'])
const sensitiveName = /(?:api.?key|secret|token|authorization|cookie|credential|pass(?:word)|headers)/i
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(): never { throw new PlatformError('SESSION_VIEW_INPUT_INVALID', '会话读取参数无效。', 400, 'not-sent') }
function date(value: unknown): string | null { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null }
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
function summary(header: Header, options: ReaderOptions): HarnessSessionSummary {
  const binding = options.bindings.find(entry => entry.scope.agentId === header.id)
  return { id: header.id, parentId: header.parentSession ?? null, title: binding ? `${binding.scope.pluginId}-${binding.scope.kind}-${binding.scope.targetId}` : header.id === options.rootSessionId ? 'Main Agent' : 'Agent',
    ...(binding ? { agentTypeId: binding.scope.agentTypeId, configurationRevision: binding.configurationRevision, pluginId: binding.scope.pluginId, conversationKind: binding.scope.kind, targetId: binding.scope.targetId } : {}), status: options.running ? 'unknown' : 'stopped', updatedAt: null }
}
function authorize(headers: readonly Header[], options: ReaderOptions): Header[] {
  if (!options.rootSessionId) return []
  const visible = new Set([options.rootSessionId]); let changed = true
  while (changed) { changed = false; for (const header of headers) if (header.parentSession && visible.has(header.parentSession) && !visible.has(header.id)) { visible.add(header.id); changed = true } }
  return headers.filter(header => visible.has(header.id))
}
async function withReader<T>(options: ReaderOptions, read: (persistence: Persistence) => Promise<T>, empty: () => T): Promise<T> {
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
  try { await ctx.plugin(jsonl, { root: actual, compression: 'none' }); return await read(ctx.sessionPersistence) }
  catch (error) {
    if (error instanceof PlatformError) throw error
    throw new PlatformError('SESSION_VIEW_FAILED', '原生会话记录无法读取，请核对运行时与存储状态。', 409, 'not-sent')
  } finally { await ctx.fiber.dispose() }
}

/** Each explicit request creates only a persistence reader; no Agent or model is started. */
export async function listNativeSessions(options: ReaderOptions, input: unknown): Promise<HarnessSessionList> {
  if (!object(input) || Object.keys(input).length) invalid()
  const refreshedAt = new Date().toISOString()
  return withReader(options, async persistence => {
    const rows = authorize((await persistence.list()).map(row => row.header), options).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    return { sessions: rows.slice(0, 100).map(header => summary(header, options)), truncated: rows.length > 100, refreshedAt }
  }, () => ({ sessions: [], truncated: false, refreshedAt }))
}

export async function readNativeSession(options: ReaderOptions, input: unknown): Promise<HarnessSessionContent> {
  if (!object(input) || Object.keys(input).some(key => !['sessionId', 'offset', 'limit'].includes(key)) || typeof input.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.sessionId)) invalid()
  const offset = input.offset === undefined ? 0 : input.offset, limit = input.limit === undefined ? 50 : input.limit
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid()
  const id = input.sessionId
  const missing = (): never => { throw new PlatformError('SESSION_NOT_FOUND', '此原生会话不存在或不属于当前运行时。', 404, 'not-sent') }
  return withReader(options, async persistence => {
    const headers = authorize((await persistence.list()).map(row => row.header), options)
    const header = headers.find(entry => entry.id === id); if (!header) return missing()
    const handle = await persistence.open(id, 'read')
    try {
      const records: HarnessSessionRecord[] = []; let cursor = offset, bytes = 0, ended = false
      // Offset and nextOffset refer to native event positions, including skipped lifecycle records.
      while (records.length < limit && cursor - offset < 2000) {
        const slice = await handle.read(cursor, Math.min(200, limit - records.length + 20))
        if (!slice.events.length) { ended = true; break }
        let stopped = false
        for (const event of slice.events) {
          const data = object(event.data) ? event.data : null
          let content: unknown, role: string | undefined
          if (event.type === 'agent/inbox/spliced' && data && Array.isArray(data.inserted)) {
            role = 'user'; content = data.inserted.filter(message => object(message) && message.role === 'user').map(message => object(message) ? message.content : null)
            if (!(content as unknown[]).length) content = undefined
          } else if (allowedTypes.has(event.type) && data) {
            const message = object(data.message) ? data.message : null
            if (message && typeof message.role === 'string') { role = message.role; content = message.content }
            else if (event.type.startsWith('tool/')) { role = 'tool'; content = Object.fromEntries(Object.entries(data).filter(([key]) => ['name', 'toolName', 'callId', 'content', 'result', 'arguments', 'isError', 'code'].includes(key))) }
          }
          if (content !== undefined) {
            const record: HarnessSessionRecord = { sequence: event.seq, timestamp: date(event.time), kind: event.type, ...(role ? { role } : {}), content: scrub(content, options.secrets) }
            const size = Buffer.byteLength(JSON.stringify(record))
            if (bytes + size > MAX_BYTES - 8192) { stopped = true; break }
            records.push(record); bytes += size
          }
          cursor = event.seq + 1
          if (records.length >= limit) { stopped = true; break }
        }
        if (stopped) break
      }
      return { session: summary(header, options), records, nextOffset: ended ? null : cursor, refreshedAt: new Date().toISOString() }
    } finally { await handle.close() }
  }, missing)
}

export function nativeReaderOptions(dataDirectory: string, dshBin: string, rootSessionId: string | null, bindings: readonly AgentBinding[], secrets: readonly string[], running: boolean): ReaderOptions {
  return { dataDirectory, dshBin, rootSessionId, bindings, secrets, running }
}
