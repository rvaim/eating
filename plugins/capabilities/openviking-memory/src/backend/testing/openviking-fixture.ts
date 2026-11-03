import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface FixtureRequest { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: Record<string, unknown> }
export interface FixtureMessage { role: 'user' | 'assistant'; content: string; peer_id: string; created_at: string }
export interface FixtureSession { id: string; policy: Record<string, unknown>; messages: FixtureMessage[]; pendingTokens: number; archiveUris: string[] }
export interface FixtureAppend { sessionId: string; messages: FixtureMessage[] }
export interface FixtureCommit { sessionId: string; taskId: string; archiveUri: string; messages: FixtureMessage[] }
export interface FixtureTask { task_id: string; task_type: 'session_commit'; resource_id: string; status: 'pending' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; result: Record<string, unknown> | null }
export interface FixtureControls {
  rejectAuth: boolean
  identityUser: string | null
  initialized: boolean
  taskStatus: FixtureTask['status']
  taskStatusBySession: Map<string, FixtureTask['status']>
  taskPollsBeforeComplete: number
  taskUnavailable: boolean
  createDisconnect: boolean
  appendDisconnect: boolean
  commitDisconnect: boolean
  pendingTokens: number | null
  intercept?: (request: FixtureRequest, response: ServerResponse) => boolean | Promise<boolean>
}

export async function startOpenVikingFixture(options: { prefix?: string; user?: string; account?: string; apiKey?: string } = {}) {
  const user = options.user ?? 'fixture_user', account = options.account ?? 'fixture_account', apiKey = options.apiKey ?? 'PRIVATE-OV-FIXTURE-KEY', prefix = options.prefix ?? '/nested/ov'
  const requests: FixtureRequest[] = [], sessions = new Map<string, FixtureSession>(), tasks = new Map<string, FixtureTask>(), archives = new Map<string, FixtureCommit>(), memories = new Map<string, string>(), errors: string[] = []
  const appendBatches: FixtureAppend[] = [], commits: FixtureCommit[] = [], extractions: FixtureCommit[] = [], polls = new Map<string, number>()
  const controls: FixtureControls = { rejectAuth: false, identityUser: null, initialized: true, taskStatus: 'completed', taskStatusBySession: new Map(), taskPollsBeforeComplete: 0, taskUnavailable: false, createDisconnect: false, appendDisconnect: false, commitDisconnect: false, pendingTokens: null }
  const ok = (response: ServerResponse, result: unknown): void => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', result })) }
  const fail = (response: ServerResponse, status: number, code: string): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: 'error', error: { code, message: 'PROVIDER-PRIVATE-BODY ' + apiKey } })) }
  const server = createServer((request, response) => {
    void handle(request, response).catch(cause => { errors.push(String(cause)); if (!response.headersSent) fail(response, 500, 'FIXTURE_FAILED'); else response.end() })
  })
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk))
    const raw = Buffer.concat(parts).toString('utf8'), body = raw ? JSON.parse(raw) as Record<string, unknown> : {}, url = new URL(request.url ?? '/', 'http://fixture')
    const entry: FixtureRequest = { method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: request.headers, body }; requests.push(entry)
    if (await controls.intercept?.(entry, response)) return
    if (controls.rejectAuth || apiKey && request.headers['x-api-key'] !== apiKey) { fail(response, 401, 'UNAUTHENTICATED'); return }
    const path = url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : ''
    if (path === '/api/v1/system/status' && entry.method === 'GET') { ok(response, { initialized: controls.initialized, user: controls.identityUser ?? user }); return }
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
      sessions.set(id, { id, policy: structuredClone(body.memory_policy as Record<string, unknown>), messages: [], pendingTokens: 0, archiveUris: [] })
      if (controls.createDisconnect) { response.destroy(); return }
      ok(response, { session_id: id, uri: `viking://user/${user}/sessions/${id}`, user: { user_id: user, account_id: account }, auto_commit_policy: null }); return
    }
    const sessionRoute = /^\/api\/v1\/sessions\/([^/]+)(?:\/(messages(?:\/batch)?|commit))?$/.exec(path)
    if (sessionRoute) {
      const session = sessions.get(decodeURIComponent(sessionRoute[1]!))
      if (!session) { fail(response, 404, 'NOT_FOUND'); return }
      if (!sessionRoute[2] && entry.method === 'GET') { ok(response, { session_id: session.id, uri: `viking://user/${user}/sessions/${session.id}`, user: { user_id: user, account_id: account }, auto_commit_policy: null, memory_policy: session.policy, message_count: session.messages.length, pending_tokens: session.pendingTokens }); return }
      if (sessionRoute[2]?.startsWith('messages') && entry.method === 'POST') {
        const messages = sessionRoute[2] === 'messages/batch' ? body.messages : [body]
        if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some(message => !message || typeof message !== 'object' || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content || typeof message.peer_id !== 'string' || !message.peer_id || typeof message.created_at !== 'string' || !Number.isFinite(Date.parse(message.created_at)))) { fail(response, 422, 'INVALID_ARGUMENT'); return }
        const appended = structuredClone(messages) as FixtureMessage[]
        session.messages.push(...appended)
        session.pendingTokens = controls.pendingTokens ?? session.pendingTokens + appended.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 4)), 0)
        appendBatches.push({ sessionId: session.id, messages: appended })
        if (controls.appendDisconnect) { response.destroy(); return }
        ok(response, { session_id: session.id, message_count: session.messages.length, pending_tokens: session.pendingTokens, ...(sessionRoute[2] === 'messages/batch' ? { added: appended.length } : {}) }); return
      }
      if (sessionRoute[2] === 'commit' && entry.method === 'POST') {
        if (Object.keys(body).join(',') !== 'keep_recent_count' || body.keep_recent_count !== 0) { fail(response, 422, 'INVALID_ARGUMENT'); return }
        if (!session.messages.length) { ok(response, { session_id: session.id, status: 'skipped', archived: false }); return }
        const taskId = randomUUID(), archiveUri = `viking://user/${user}/sessions/${session.id}/history/archive_${String(session.archiveUris.length + 1).padStart(3, '0')}`
        const commit: FixtureCommit = { sessionId: session.id, taskId, archiveUri, messages: structuredClone(session.messages) }
        commits.push(commit); archives.set(archiveUri, commit); session.archiveUris.push(archiveUri); session.messages = []; session.pendingTokens = 0
        tasks.set(taskId, { task_id: taskId, task_type: 'session_commit', resource_id: session.id, status: 'pending', result: null })
        if (controls.commitDisconnect) { response.destroy(); return }
        ok(response, { session_id: session.id, status: 'accepted', task_id: taskId, archive_uri: archiveUri, archived: true }); return
      }
    }
    const taskRoute = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path)
    if (taskRoute && entry.method === 'GET') {
      const task = tasks.get(decodeURIComponent(taskRoute[1]!))
      if (controls.taskUnavailable || !task) { fail(response, 404, 'NOT_FOUND'); return }
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        const count = (polls.get(task.task_id) ?? 0) + 1; polls.set(task.task_id, count)
        task.status = count <= controls.taskPollsBeforeComplete ? 'running' : controls.taskStatusBySession.get(task.resource_id) ?? controls.taskStatus
        if (task.status === 'completed') {
          const commit = commits.find(commit => commit.taskId === task.task_id)!
          task.result = { session_id: task.resource_id, archive_uri: commit.archiveUri, memories_extracted: { total: 1 } }; extractions.push(commit)
        }
      }
      ok(response, task); return
    }
    fail(response, 404, 'NOT_FOUND')
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  const endpoint = `http://127.0.0.1:${address.port}${prefix}`
  return { endpoint, user, account, apiKey, requests, sessions, tasks, appendBatches, commits, extractions, archives, memories, controls, errors, close: async () => { const done = new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); server.closeAllConnections(); await done } }
}
