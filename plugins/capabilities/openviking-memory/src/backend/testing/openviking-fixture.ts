import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface FixtureRequest { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: Record<string, unknown> }
export interface FixtureSession { id: string; policy: Record<string, unknown>; messages: Array<Record<string, unknown>>; taskId: string | null; archiveUri: string | null; deleted: boolean }
export interface FixtureTask { task_id: string; task_type: string; resource_id: string; status: string; result: Record<string, unknown>; polls: number }
export interface FixtureControls {
  rejectAuth: boolean
  identityUser: string | null
  initialized: boolean
  taskStatus: 'completed' | 'running' | 'failed' | 'cancelled'
  taskPollsBeforeComplete: number
  commitDisconnect: boolean
  omitDiff: boolean
  diff: { added: number; updated: number; deleted: number }
  intercept?: (request: FixtureRequest, response: ServerResponse) => boolean | Promise<boolean>
}
export async function startOpenVikingFixture(options: { prefix?: string; user?: string; account?: string; apiKey?: string } = {}) {
  const user = options.user ?? 'fixture_user', account = options.account ?? 'fixture_account', apiKey = options.apiKey ?? 'PRIVATE-OV-FIXTURE-KEY', prefix = options.prefix ?? '/nested/ov'
  const requests: FixtureRequest[] = [], sessions = new Map<string, FixtureSession>(), tasks = new Map<string, FixtureTask>(), memories = new Map<string, string>(), cleaned: string[] = [], errors: string[] = []
  const committedSessions: FixtureSession[] = []
  const controls: FixtureControls = { rejectAuth: false, identityUser: null, initialized: true, taskStatus: 'completed', taskPollsBeforeComplete: 0, commitDisconnect: false, omitDiff: false, diff: { added: 1, updated: 2, deleted: 0 } }
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
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
    if (path === '/api/v1/system/status') { ok(response, { initialized: controls.initialized, user: controls.identityUser ?? user }); return }
    if (path === '/api/v1/search/find') {
      const targets = Array.isArray(body.target_uri) ? body.target_uri as string[] : [String(body.target_uri)], query = String(body.query).toLowerCase()
      const hits = [...memories].filter(([uri, content]) => targets.some(target => uri.startsWith(target + '/')) && content.toLowerCase().includes(query)).map(([uri, content]) => ({ uri, abstract: content.slice(0, 100), score: 0.8 }))
      ok(response, { memories: hits.slice(0, Number(body.limit ?? 10)), resources: [], skills: [], total: hits.length }); return
    }
    if (path === '/api/v1/content/read') {
      const uri = url.searchParams.get('uri') ?? ''
      if (uri.endsWith('/memory_diff.json')) {
        if (controls.omitDiff) { fail(response, 404, 'NOT_FOUND'); return }
        const session = [...sessions.values()].find(session => session.archiveUri && uri === session.archiveUri + '/memory_diff.json')
        const task = session?.taskId ? tasks.get(session.taskId) : undefined
        if (!session || task?.status !== 'completed') { fail(response, 409, 'NOT_READY'); return }
        ok(response, JSON.stringify({ summary: { total_adds: controls.diff.added, total_updates: controls.diff.updated, total_deletes: controls.diff.deleted }, operations: { adds: [{ content: 'PRIVATE-DIFF-MEMORY-BODY' }], updates: [], deletes: [] } })); return
      }
      const content = memories.get(uri)
      if (content === undefined) { fail(response, 404, 'NOT_FOUND'); return }
      ok(response, content); return
    }
    if (path === '/api/v1/fs/stat') { const uri = url.searchParams.get('uri') ?? ''; if (!memories.has(uri)) { fail(response, 404, 'NOT_FOUND'); return }; ok(response, { isDir: false, size: memories.get(uri)!.length }); return }
    if (path === '/api/v1/fs' && entry.method === 'DELETE') { const uri = url.searchParams.get('uri') ?? ''; if (url.searchParams.get('recursive') !== 'false') errors.push('Unexpected recursive delete'); if (!memories.delete(uri)) { fail(response, 404, 'NOT_FOUND'); return }; ok(response, null); return }
    if (path === '/api/v1/sessions' && entry.method === 'POST') {
      const id = String(body.session_id)
      if (sessions.has(id)) { fail(response, 409, 'ALREADY_EXISTS'); return }
      sessions.set(id, { id, policy: body.memory_policy as Record<string, unknown>, messages: [], taskId: null, archiveUri: null, deleted: false }); ok(response, { session_id: id, uri: `viking://user/${user}/sessions/${id}`, user: { user_id: user, account_id: account }, auto_commit_policy: body.auto_commit_policy }); return
    }
    const messageRoute = /^\/api\/v1\/sessions\/([^/]+)\/messages(?:\/(batch))?$/.exec(path)
    if (messageRoute && entry.method === 'POST') {
      const session = sessions.get(decodeURIComponent(messageRoute[1]!))
      if (!session || session.deleted) { fail(response, 404, 'NOT_FOUND'); return }
      const messages = messageRoute[2] ? body.messages as Array<Record<string, unknown>> : [body]
      session.messages.push(...messages); ok(response, { session_id: session.id, message_count: messages.length }); return
    }
    const commitRoute = /^\/api\/v1\/sessions\/([^/]+)\/commit$/.exec(path)
    if (commitRoute && entry.method === 'POST') {
      const session = sessions.get(decodeURIComponent(commitRoute[1]!))
      if (!session || session.deleted || session.taskId) { fail(response, 409, 'INVALID_COMMIT'); return }
      session.taskId = randomUUID(); session.archiveUri = `viking://user/${user}/sessions/${session.id}/history/archive_001`
      const task: FixtureTask = { task_id: session.taskId, task_type: 'session_commit', resource_id: session.id, status: controls.taskStatus, polls: 0, result: { session_id: session.id, archive_uri: session.archiveUri, memory_diff_uri: session.archiveUri + '/memory_diff.json' } }
      tasks.set(task.task_id, task); committedSessions.push(session)
      if (controls.commitDisconnect) { response.destroy(); return }
      ok(response, { session_id: session.id, status: 'accepted', task_id: session.taskId, archive_uri: session.archiveUri, archived: true }); return
    }
    const taskRoute = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path)
    if (taskRoute) {
      const task = tasks.get(decodeURIComponent(taskRoute[1]!))
      if (!task) { fail(response, 404, 'NOT_FOUND'); return }
      task.polls++
      if (controls.taskPollsBeforeComplete && task.polls <= controls.taskPollsBeforeComplete) { ok(response, { ...task, status: 'running' }); return }
      task.status = controls.taskStatus; ok(response, task); return
    }
    const sessionRoute = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path)
    if (sessionRoute && entry.method === 'DELETE') {
      const session = sessions.get(decodeURIComponent(sessionRoute[1]!))
      if (!session || session.deleted) { fail(response, 404, 'NOT_FOUND'); return }
      const task = session.taskId ? tasks.get(session.taskId) : undefined
      if (task && ['pending', 'running', 'cancelling'].includes(task.status)) { errors.push('Deleted active extraction'); fail(response, 409, 'ACTIVE_TASK'); return }
      session.deleted = true; session.messages = []; cleaned.push(session.id); ok(response, { session_id: session.id }); return
    }
    fail(response, 404, 'NOT_FOUND')
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  const endpoint = `http://127.0.0.1:${address.port}${prefix}`
  return { endpoint, user, account, apiKey, requests, sessions, tasks, memories, cleaned, committedSessions, controls, errors, close: async () => { const done = new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); server.closeAllConnections(); await done } }
}
