import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

export interface FixtureRequest { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: Record<string, unknown> }
export interface FixtureMessage { role: 'user' | 'assistant'; content: string; peer_id: string; created_at: string }
export interface FixtureChanges { added: number; updated: number; deleted: number }
export type FixtureExtractionStatus = 'accepted' | 'processing' | 'completed' | 'failed' | 'unknown'
export interface FixtureReceipt {
  protocol_version: 1
  session_id: string
  request_id: string
  status: FixtureExtractionStatus
  task_id: string
  from_sequence: number
  to_sequence: number
  changes: FixtureChanges | null
  error_code: string | null
  archive_uris: string[]
}
export interface FixtureSession {
  id: string
  policy: Record<string, unknown>
  messages: FixtureMessage[]
  nextSequence: number
  extractedSequence: number
  archivedSequence: number
  historyBytes: number
  archiveUris: string[]
}
export interface FixtureSubmission { sessionId: string; requestId: string; expectedSequence: number; archiveMaxBytes: number; messages: FixtureMessage[] }
export interface FixtureExtraction { sessionId: string; requestId: string; fromSequence: number; toSequence: number; messages: FixtureMessage[]; changes: FixtureChanges }
export interface FixtureArchive { sessionId: string; fromSequence: number; toSequence: number; messages: FixtureMessage[] }
export interface FixtureTask { task_id: string; task_type: 'incremental_memory'; resource_id: string; status: string }
export interface FixtureControls {
  rejectAuth: boolean
  identityUser: string | null
  initialized: boolean
  extensionAvailable: boolean
  incrementalStatus: FixtureExtractionStatus
  incrementalStatusBySession: Map<string, FixtureExtractionStatus>
  extractionApplyStarted: boolean
  receiptPollsBeforeComplete: number
  submitDisconnect: boolean
  receiptUnavailable: boolean
  taskExpired: boolean
  /** Extra bytes in the next accepted append, without allocating a large chat body. */
  simulatedHistoryBytes: number
  diff: FixtureChanges
  intercept?: (request: FixtureRequest, response: ServerResponse) => boolean | Promise<boolean>
}
interface PendingExtraction { receipt: FixtureReceipt; fingerprint: string; polls: number; changes: FixtureChanges; applyStarted: boolean }

/** Current native SDK routes and Eating's extension, served entirely on loopback. */
export async function startOpenVikingFixture(options: { prefix?: string; user?: string; account?: string; apiKey?: string } = {}) {
  const user = options.user ?? 'fixture_user', account = options.account ?? 'fixture_account', apiKey = options.apiKey ?? 'PRIVATE-OV-FIXTURE-KEY', prefix = options.prefix ?? '/nested/ov'
  const requests: FixtureRequest[] = [], sessions = new Map<string, FixtureSession>(), tasks = new Map<string, FixtureTask>(), archives = new Map<string, FixtureArchive>(), memories = new Map<string, string>(), errors: string[] = []
  const receipts = new Map<string, FixtureReceipt>(), pending = new Map<string, PendingExtraction>(), submissions: FixtureSubmission[] = [], extractions: FixtureExtraction[] = []
  const controls: FixtureControls = { rejectAuth: false, identityUser: null, initialized: true, extensionAvailable: true, incrementalStatus: 'completed', incrementalStatusBySession: new Map(), extractionApplyStarted: false, receiptPollsBeforeComplete: 0, submitDisconnect: false, receiptUnavailable: false, taskExpired: false, simulatedHistoryBytes: 0, diff: { added: 1, updated: 2, deleted: 0 } }
  const receiptKey = (sessionId: string, requestId: string): string => `${sessionId}/${requestId}`
  const ok = (response: ServerResponse, result: unknown): void => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', result })) }
  const fail = (response: ServerResponse, status: number, code: string): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: 'error', error: { code, message: 'PROVIDER-PRIVATE-BODY ' + apiKey } })) }
  const server = createServer((request, response) => {
    void handle(request, response).catch(cause => { errors.push(String(cause)); if (!response.headersSent) fail(response, 500, 'FIXTURE_FAILED'); else response.end() })
  })
  function advance(extraction: PendingExtraction): void {
    const receipt = extraction.receipt
    if (receipt.status === 'completed' || receipt.status === 'failed') return
    extraction.polls++
    receipt.status = extraction.polls <= controls.receiptPollsBeforeComplete ? 'processing' : controls.incrementalStatusBySession.get(receipt.session_id) ?? controls.incrementalStatus
    receipt.error_code = receipt.status === 'failed' ? 'MEMORY_EXTRACTION_FAILED' : receipt.status === 'unknown' ? 'MEMORY_SUBMISSION_UNKNOWN' : null
    extraction.applyStarted ||= controls.extractionApplyStarted
    const task = tasks.get(receipt.task_id)
    if (task) task.status = receipt.status === 'completed' || receipt.status === 'failed' ? receipt.status : 'running'
    if (receipt.status !== 'completed') return
    if ([...pending.values()].some(other => other !== extraction && other.receipt.session_id === receipt.session_id && other.receipt.to_sequence <= receipt.from_sequence && other.receipt.status !== 'completed' && other.receipt.status !== 'failed')) { receipt.status = 'processing'; if (task) task.status = 'running'; return }
    const session = sessions.get(receipt.session_id)!
    extraction.applyStarted = true
    // Only the new sequence range is extracted, even after history segmentation.
    const fromSequence = session.extractedSequence
    receipt.changes = { ...extraction.changes }
    extractions.push({ sessionId: session.id, requestId: receipt.request_id, fromSequence, toSequence: receipt.to_sequence, messages: structuredClone(session.messages.slice(fromSequence, receipt.to_sequence)), changes: { ...extraction.changes } })
    session.extractedSequence = receipt.to_sequence
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk))
    const raw = Buffer.concat(parts).toString('utf8'), body = raw ? JSON.parse(raw) as Record<string, unknown> : {}, url = new URL(request.url ?? '/', 'http://fixture')
    const entry: FixtureRequest = { method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: request.headers, body }; requests.push(entry)
    if (await controls.intercept?.(entry, response)) return
    if (controls.rejectAuth || apiKey && request.headers['x-api-key'] !== apiKey) { fail(response, 401, 'UNAUTHENTICATED'); return }
    const path = url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : ''
    if (path === '/api/v1/system/status' && entry.method === 'GET') { ok(response, { initialized: controls.initialized, user: controls.identityUser ?? user }); return }
    if (path === '/api/v1/eating-memory/capabilities' && entry.method === 'GET') {
      if (!controls.extensionAvailable) { fail(response, 404, 'NOT_FOUND'); return }
      ok(response, { protocol_version: 1, server_version: '0.5.2.1', incremental_extraction: true, history_segmentation: true }); return
    }
    if (path === '/api/v1/search/find' && entry.method === 'POST') {
      const targets = Array.isArray(body.target_uri) ? body.target_uri as string[] : [String(body.target_uri)], query = String(body.query).toLowerCase()
      const hits = [...memories].filter(([uri, content]) => targets.some(target => uri.startsWith(target + '/')) && content.toLowerCase().includes(query)).map(([uri, content]) => ({ uri, abstract: content.slice(0, 100), score: 0.8 }))
      ok(response, { memories: hits.slice(0, Number(body.limit ?? 10)), resources: [], skills: [], total: hits.length }); return
    }
    if (path === '/api/v1/content/read' && entry.method === 'GET') {
      const uri = url.searchParams.get('uri') ?? '', content = memories.get(uri)
      if (content === undefined) { fail(response, 404, 'NOT_FOUND'); return }
      ok(response, content); return
    }
    if (path === '/api/v1/fs/stat' && entry.method === 'GET') { const uri = url.searchParams.get('uri') ?? ''; if (!memories.has(uri)) { fail(response, 404, 'NOT_FOUND'); return }; ok(response, { isDir: false, size: Buffer.byteLength(memories.get(uri)!) }); return }
    if (path === '/api/v1/fs' && entry.method === 'DELETE') { const uri = url.searchParams.get('uri') ?? ''; if (url.searchParams.get('recursive') !== 'false') errors.push('Unexpected recursive delete'); if (!memories.delete(uri)) { fail(response, 404, 'NOT_FOUND'); return }; ok(response, null); return }
    if (path === '/api/v1/sessions' && entry.method === 'POST') {
      const id = String(body.session_id)
      if (sessions.has(id)) { fail(response, 409, 'ALREADY_EXISTS'); return }
      if (body.auto_commit_policy !== null) { fail(response, 400, 'AUTO_COMMIT_MUST_BE_DISABLED'); return }
      sessions.set(id, { id, policy: structuredClone(body.memory_policy as Record<string, unknown>), messages: [], nextSequence: 0, extractedSequence: 0, archivedSequence: 0, historyBytes: 0, archiveUris: [] })
      ok(response, { session_id: id, uri: `viking://user/${user}/sessions/${id}`, user: { user_id: user, account_id: account }, memory_policy: body.memory_policy, auto_commit_policy: null }); return
    }
    const incrementalRoute = /^\/api\/v1\/sessions\/([^/]+)\/incremental-memory(?:\/requests\/([^/]+)(?:\/(retry))?)?$/.exec(path)
    if (incrementalRoute) {
      if (!controls.extensionAvailable) { fail(response, 404, 'NOT_FOUND'); return }
      const session = sessions.get(decodeURIComponent(incrementalRoute[1]!))
      if (!session) { fail(response, 404, 'NOT_FOUND'); return }
      const requestId = incrementalRoute[2] === undefined ? null : decodeURIComponent(incrementalRoute[2])
      if (requestId !== null && incrementalRoute[3] === 'retry') {
        if (entry.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
        if (Object.keys(body).length) { fail(response, 400, 'INVALID_REQUEST'); return }
        const extraction = pending.get(receiptKey(session.id, requestId))
        if (!extraction) { fail(response, 404, 'NOT_FOUND'); return }
        if (extraction.receipt.status !== 'failed' || extraction.applyStarted) { fail(response, 409, 'RETRY_NOT_ALLOWED'); return }
        Object.assign(extraction.receipt, { status: 'accepted', changes: null, error_code: null }); extraction.polls = 0
        const task = tasks.get(extraction.receipt.task_id); if (task) task.status = 'running'
        ok(response, extraction.receipt); return
      }
      if (requestId !== null && entry.method === 'GET') {
        const extraction = pending.get(receiptKey(session.id, requestId))
        if (controls.receiptUnavailable || !extraction) { fail(response, 404, 'NOT_FOUND'); return }
        advance(extraction); ok(response, extraction.receipt); return
      }
      if (requestId === null && entry.method === 'GET') { ok(response, { protocol_version: 1, session_id: session.id, next_sequence: session.nextSequence, extracted_sequence: session.extractedSequence, pending_messages: session.nextSequence - session.extractedSequence }); return }
      if (requestId === null && entry.method === 'POST') {
        const allowed = ['request_id', 'expected_sequence', 'messages', 'archive_max_bytes'], messages = body.messages
        if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.request_id !== 'string' || !body.request_id || !Number.isSafeInteger(body.expected_sequence) || Number(body.expected_sequence) < 0 || !Number.isSafeInteger(body.archive_max_bytes) || Number(body.archive_max_bytes) < 1024 * 1024 || Number(body.archive_max_bytes) > 64 * 1024 * 1024 || !Array.isArray(messages) || !messages.length || messages.some(message => !message || typeof message !== 'object' || Object.keys(message).sort().join(',') !== 'content,created_at,peer_id,role' || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content || typeof message.peer_id !== 'string' || !message.peer_id || typeof message.created_at !== 'string' || !Number.isFinite(Date.parse(message.created_at)))) { fail(response, 400, 'INVALID_REQUEST'); return }
        const key = receiptKey(session.id, body.request_id), fingerprint = createHash('sha256').update(JSON.stringify({ expected_sequence: body.expected_sequence, messages, archive_max_bytes: body.archive_max_bytes })).digest('hex'), existing = pending.get(key)
        if (existing) { if (existing.fingerprint !== fingerprint) fail(response, 409, 'REQUEST_ID_CONFLICT'); else ok(response, existing.receipt); return }
        if ([...pending.values()].some(extraction => extraction.receipt.session_id === session.id && extraction.receipt.status === 'failed')) { fail(response, 412, 'EXTRACTION_RETRY_REQUIRED'); return }
        if (body.expected_sequence !== session.nextSequence) { fail(response, 409, 'SEQUENCE_CONFLICT'); return }
        const from = session.nextSequence, appended = structuredClone(messages) as FixtureMessage[]
        session.messages.push(...appended); session.nextSequence += appended.length
        session.historyBytes += Buffer.byteLength(appended.map(message => JSON.stringify(message) + '\n').join('')) + controls.simulatedHistoryBytes
        controls.simulatedHistoryBytes = 0
        const archiveUris: string[] = []
        if (session.historyBytes >= Number(body.archive_max_bytes)) {
          const uri = `viking://user/${user}/sessions/${session.id}/history/archive_${String(session.archiveUris.length + 1).padStart(3, '0')}`
          archives.set(uri, { sessionId: session.id, fromSequence: session.archivedSequence, toSequence: session.nextSequence, messages: structuredClone(session.messages.slice(session.archivedSequence)) })
          session.archiveUris.push(uri); archiveUris.push(uri); session.archivedSequence = session.nextSequence; session.historyBytes = 0
        }
        const receipt: FixtureReceipt = { protocol_version: 1, session_id: session.id, request_id: body.request_id, status: 'accepted', task_id: randomUUID(), from_sequence: from, to_sequence: session.nextSequence, changes: null, error_code: null, archive_uris: archiveUris }
        receipts.set(key, receipt); pending.set(key, { receipt, fingerprint, polls: 0, changes: { ...controls.diff }, applyStarted: false })
        tasks.set(receipt.task_id, { task_id: receipt.task_id, task_type: 'incremental_memory', resource_id: session.id, status: 'running' })
        submissions.push({ sessionId: session.id, requestId: body.request_id, expectedSequence: from, archiveMaxBytes: Number(body.archive_max_bytes), messages: appended })
        if (controls.submitDisconnect) { response.destroy(); return }
        ok(response, receipt); return
      }
      fail(response, 405, 'METHOD_NOT_ALLOWED'); return
    }
    const taskRoute = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path)
    if (taskRoute && entry.method === 'GET') { const task = tasks.get(decodeURIComponent(taskRoute[1]!)); if (controls.taskExpired || !task) fail(response, 404, 'NOT_FOUND'); else ok(response, task); return }
    const sessionRoute = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path)
    if (sessionRoute && entry.method === 'GET') {
      const session = sessions.get(decodeURIComponent(sessionRoute[1]!))
      if (!session) { fail(response, 404, 'NOT_FOUND'); return }
      ok(response, { session_id: session.id, uri: `viking://user/${user}/sessions/${session.id}`, user: { user_id: user, account_id: account }, auto_commit_policy: null, memory_policy: session.policy, message_count: session.nextSequence - session.archivedSequence }); return
    }
    fail(response, 404, 'NOT_FOUND')
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  const endpoint = `http://127.0.0.1:${address.port}${prefix}`
  return { endpoint, user, account, apiKey, requests, sessions, tasks, receipts, submissions, extractions, archives, memories, controls, errors, close: async () => { const done = new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); server.closeAllConnections(); await done } }
}
