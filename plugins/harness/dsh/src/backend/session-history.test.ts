import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshSessionHistory } from './session-history'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync), renameSync: vi.fn(actual.renameSync) }
})

const roots: string[] = []
const ROOT = '00000000-0000-4000-8000-000000000001'
const SECOND = '00000000-0000-4000-8000-000000000002'
const CHILD = '00000000-0000-4000-8000-000000000003'
const UNRELATED = '00000000-0000-4000-8000-000000000004'
const PROJECT = '--fixture-project--'
const receiptName = 'session-history-receipt.json'
const workspaceName = 'dsh-home/storages/workspace.json'
const legacyName = 'dsh-home/storages/session_projcache.json'
const cacheDirectory = 'dsh-home/storages/session_projcache/sessions'
const secret = 'fixture-private-body-and-credential-do-not-expose'

function fixture(): string {
  const parent = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(parent, 'eating-session-history-')))
  if (!isAbsolute(root) || dirname(root) !== parent || !basename(root).startsWith('eating-session-history-')) throw new Error('Invalid fixture root')
  roots.push(root)
  return root
}
function write(root: string, name: string, value: unknown, raw = false): string {
  const path = resolve(root, name)
  if (!path.startsWith(root + '/') || !roots.includes(root)) throw new Error('Invalid fixture file')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, raw ? String(value) : JSON.stringify(value) + '\n')
  return path
}
function json(root: string, name: string): Record<string, any> { return JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, any> }
function logName(id: string): string { return `dsh-home/sessions/${PROJECT}/${id}/session.v4.jsonl` }
function log(root: string, id: string, parentSession?: string, folder = id): string {
  const header = { type: 'session', version: 4, id, createdAt: 1_793_770_000_000, isSeeded: false, delegationDepth: 0, cwd: '/fixture/project', ...(parentSession ? { parentSession, origin: 'fork' } : {}) }
  return write(root, `dsh-home/sessions/${PROJECT}/${folder}/session.v4.jsonl`, JSON.stringify(header) + '\n' + JSON.stringify({ type: 'event', seq: 1, event: { type: 'goal/change', goal: { objective: secret, status: 'active' } } }) + '\n', true)
}
function record() {
  return { identity: { formatVersion: 4, createdAt: 1_793_770_000_000, cwd: '/fixture/project', isSeeded: false, inheritedEventCount: 0 }, rows: { goal: { ver: 1, seq: 1, val: { objective: secret, status: 'active' } }, watermark: { ver: 0, seq: -1, val: null } } }
}
function workspaceValue() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'workspace-fixture', workspaceIds: ['workspace-fixture'], archivedSessionIds: [ROOT, UNRELATED], pinnedSessionIds: [CHILD, UNRELATED] },
    tables: { workspaces: { 'workspace-fixture': { path: '/fixture/project', title: 'Keep workspace title', sessionIds: [ROOT, SECOND, CHILD, UNRELATED], createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T01:00:00.000Z', customField: 'retained-workspace-field' } } },
  }
}
function seed(root: string) {
  log(root, ROOT)
  log(root, SECOND)
  log(root, CHILD, ROOT)
  const removed = [
    ...[ROOT, SECOND, CHILD].map(logName),
    `dsh-home/sessions/${PROJECT}/${ROOT}/session.jsonl`,
    `dsh-home/sessions/${PROJECT}/${ROOT}/session.v1.jsonl`,
    `dsh-home/sessions/${PROJECT}/${ROOT}/session.v2.jsonl`,
    `dsh-home/sessions/${PROJECT}/${ROOT}/session.v3.jsonl`,
    'session.json', 'agent-bindings.json', 'proactive-bindings.json',
    'bridge/owner-policy.json', 'bridge/expected.json', 'bridge/ready.json', 'bridge/session-ready.json', 'bridge/native-web-ready.json', 'bridge/error.json', `bridge/ack-${'a'.repeat(64)}.json`, 'bridge/.bridge-00000000-0000-4000-8000-000000000005.tmp',
    'dsh-home/attachments/v1/objects/nested/object', 'dsh-home/attachments/v1/file-objects/source', 'dsh-home/attachments/v1/files/file', 'dsh-home/attachments/v1/tmp/upload', 'dsh-home/cache/attachments/request-images/image',
    `${cacheDirectory}/${ROOT}.json`, `${cacheDirectory}/${ROOT}.json.bak.202611041030`, `${cacheDirectory}/${CHILD}.json`,
  ]
  for (const name of removed.slice(3)) write(root, name, { fixture: secret })
  for (const name of removed.filter(name => name.startsWith(cacheDirectory))) write(root, name, { version: 7, record: record() })
  write(root, 'session.json', { schemaVersion: 1, sessionId: ROOT, created: true })
  write(root, 'agent-bindings.json', { schemaVersion: 2, bindings: [] })
  write(root, 'proactive-bindings.json', { schemaVersion: 1, bindings: [] })
  write(root, workspaceName, workspaceValue())
  write(root, legacyName, { unit: { name: 'session_projcache', version: 7 }, global: null, tables: { sessions: { [ROOT]: record(), [CHILD]: record(), [UNRELATED]: record() } } })
  write(root, `${cacheDirectory}/${UNRELATED}.json`, { version: 7, record: record() })
  const protectedNames = [
    'config.json', 'persona.json', 'native-capabilities.json', 'profiles/model-key.json', 'runtime-home/native-config.yaml', 'dsh-home/profiles/default/config.json', 'dsh-home/actions/receipts.json',
    'bridge/runtime-bridge.mjs', 'bridge/new-native.yaml', 'bridge/new-native.json', 'bridge/.unknown.tmp', 'bridge/ack-NOT-A-DIGEST.json',
    'capabilities/stickers/images/business.png', 'scopefiles/scope.json', `dsh-home/sessions/${PROJECT}/${ROOT}/scope.json`,
  ]
  for (const name of protectedNames) write(root, name, { retained: secret })
  return { removed, protectedFiles: new Map(protectedNames.map(name => [name, readFileSync(join(root, name))])) }
}
function hashes(root: string): Map<string, string> {
  const result = new Map<string, string>()
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else result.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(root)
  return result
}
async function confirmed(engine: DshSessionHistory) {
  const preview = await engine.preview()
  return { previewId: preview.previewId, requestId: randomUUID(), confirmed: true as const }
}

const originalUnlink = vi.mocked(unlinkSync).getMockImplementation()!
const originalRename = vi.mocked(renameSync).getMockImplementation()!
afterEach(() => {
  vi.mocked(unlinkSync).mockReset().mockImplementation(originalUnlink)
  vi.mocked(renameSync).mockReset().mockImplementation(originalRename)
  vi.restoreAllMocks()
  for (const root of roots.splice(0).reverse()) {
    if (resolve(root) !== root || realpathSync(root) !== root || lstatSync(root).isSymbolicLink() || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('eating-session-history-')) throw new Error('Invalid fixture cleanup path')
    rmSync(root, { recursive: true })
  }
})

describe('offline DSH session history', () => {
  it('counts roots and fork children from current native headers and previews without writes', async () => {
    const root = fixture()
    seed(root)
    const before = hashes(root)
    const preview = await new DshSessionHistory(root).preview()
    expect(preview).toEqual({ previewId: expect.any(String), expiresAt: expect.any(String), sessionCount: 3, rootCount: 2, childCount: 1 })
    expect(Date.parse(preview.expiresAt) - Date.now()).toBeGreaterThan(299_000)
    expect(JSON.stringify(preview)).not.toContain(root)
    expect(JSON.stringify(preview)).not.toContain(ROOT)
    expect(hashes(root)).toEqual(before)
    expect(existsSync(join(root, receiptName))).toBe(false)
  })

  it('clears confirmed native generations, shared attachments, caches and own metadata while preserving configuration and scopes', async () => {
    const root = fixture()
    const { removed, protectedFiles } = seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const result = await engine.clear(input)
    expect(result).toEqual({ requestId: input.requestId, status: 'completed', deletedCount: 3 })
    for (const name of removed) expect(existsSync(join(root, name)), name).toBe(false)
    for (const [name, bytes] of protectedFiles) expect(readFileSync(join(root, name)).equals(bytes), name).toBe(true)
    expect(existsSync(join(root, `${cacheDirectory}/${UNRELATED}.json`))).toBe(true)
    const expectedWorkspace = workspaceValue()
    expectedWorkspace.global.archivedSessionIds = [UNRELATED]
    expectedWorkspace.global.pinnedSessionIds = [UNRELATED]
    expectedWorkspace.tables.workspaces['workspace-fixture'].sessionIds = [UNRELATED]
    expect(json(root, workspaceName)).toEqual(expectedWorkspace)
    expect(Object.keys(json(root, legacyName).tables.sessions)).toEqual([UNRELATED])
    expect(json(root, legacyName).tables.sessions[UNRELATED]).toEqual(record())
    const receipt = json(root, receiptName)
    expect(receipt.schemaVersion).toBe(1)
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({ requestId: input.requestId, previewId: input.previewId, state: 'completed', result })
    expect(JSON.stringify(receipt)).not.toContain(secret)
    expect(JSON.stringify(receipt)).not.toContain(root)
    expect(JSON.stringify(receipt)).not.toContain(ROOT)
    expect(readdirSync(root).filter(name => name.includes('.tmp') || name.includes('lock'))).toEqual([])
    expect(await new DshSessionHistory(root).preview()).toMatchObject({ sessionCount: 0, rootCount: 0, childCount: 0 })
  })

  it('returns a durable completed result after reopening without executing or checking runtime again', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const result = await engine.clear(input)
    const before = hashes(root)
    const guard = vi.fn(() => { throw new Error(secret) })
    expect(await new DshSessionHistory(root).clear(input, guard)).toEqual(result)
    expect(guard).not.toHaveBeenCalled()
    expect(hashes(root)).toEqual(before)
    await expect(engine.clear({ ...input, previewId: randomUUID() })).rejects.toMatchObject({ code: 'SESSION_HISTORY_REQUEST_CONFLICT', outcome: 'not-sent' })
  })

  it('supports an empty state without creating session data or inventing sessions', async () => {
    const root = fixture()
    const engine = new DshSessionHistory(root)
    expect(await engine.preview()).toMatchObject({ sessionCount: 0, rootCount: 0, childCount: 0 })
    const input = await confirmed(engine)
    expect(await engine.clear(input)).toMatchObject({ deletedCount: 0, status: 'completed' })
    expect(readdirSync(root)).toEqual([receiptName])
  })

  it.each([
    { confirmed: false }, { confirmed: true }, { confirmed: 'true' },
    { confirmed: true, path: '/fixture/arbitrary' }, { confirmed: true, paths: [] }, { confirmed: true, sessionIds: [ROOT] }, { confirmed: true, extra: null },
  ])('requires explicit confirmation and rejects extra or missing input: %j', async input => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const prepared = await confirmed(engine)
    const value = Object.keys(input).length === 1 && input.confirmed === true ? input : { ...prepared, ...input }
    const before = hashes(root)
    await expect(engine.clear(value)).rejects.toMatchObject({ code: 'SESSION_HISTORY_INVALID_INPUT', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
  })

  it('calls the final runtime guard before any lock, receipt or destructive operation', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const before = hashes(root)
    const stop = new Error(secret + root)
    await expect(engine.clear(input, () => { throw stop })).rejects.toMatchObject({ code: 'SESSION_HISTORY_IO_FAILED', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
    expect(await engine.clear(input)).toMatchObject({ deletedCount: 3 })
  })

  it.each(['same-size-content', 'new-file', 'metadata', 'schedule'] as const)('rejects stale previews before accepting a request: %s', async change => {
    const root = fixture()
    seed(root)
    const path = join(root, logName(ROOT))
    const fixed = new Date('2026-11-04T00:00:00Z')
    utimesSync(path, fixed, fixed)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const beforeStat = statSync(path, { bigint: true })
    if (change === 'same-size-content') { writeFileSync(path, readFileSync(path, 'utf8').replace(secret, secret.toUpperCase())); utimesSync(path, fixed, fixed); expect(statSync(path, { bigint: true }).mtimeNs).toBe(beforeStat.mtimeNs); expect(statSync(path).size).toBe(Number(beforeStat.size)) }
    if (change === 'new-file') write(root, `dsh-home/sessions/${PROJECT}/${ROOT}/new-entry.json`, {})
    if (change === 'metadata') write(root, 'agent-bindings.json', { schemaVersion: 2, bindings: [], changed: true })
    if (change === 'schedule') write(root, 'dsh-home/storages/schedule.json', { fixture: secret })
    await expect(engine.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_PREVIEW_STALE', outcome: 'not-sent' })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(root, receiptName))).toBe(false)
  })

  it('expires previews at five minutes and keeps only the latest preview', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const original = await confirmed(engine)
    const latest = await confirmed(engine)
    await expect(engine.clear(original)).rejects.toMatchObject({ code: 'SESSION_HISTORY_PREVIEW_STALE' })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_000)
    await expect(engine.clear(latest)).rejects.toMatchObject({ code: 'SESSION_HISTORY_PREVIEW_STALE', outcome: 'not-sent' })
    expect(existsSync(join(root, logName(ROOT)))).toBe(true)
    expect(existsSync(join(root, receiptName))).toBe(false)
  })

  it.each(['active', 'inactive'])('blocks a native schedule binding before any mutation even when status is %s', async status => {
    const root = fixture()
    seed(root)
    write(root, 'dsh-home/storages/schedule.json', { unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { task: { sessionId: ROOT, record: { prompt: secret }, status, deliveryHistory: [{ prompt: secret }] } } } })
    const before = hashes(root)
    await expect(new DshSessionHistory(root).preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_SCHEDULED', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
  })

  it('preserves an unrelated native schedule and its delivery history', async () => {
    const root = fixture()
    seed(root)
    const path = write(root, 'dsh-home/storages/schedule.json', { unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { task: { sessionId: UNRELATED, record: { prompt: secret }, status: 'active', lastDelivery: { prompt: secret }, deliveryHistory: [{ prompt: secret }] } } } })
    const bytes = readFileSync(path)
    const engine = new DshSessionHistory(root)
    await engine.clear(await confirmed(engine))
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })

  it.each(['legacy-cache', 'workspace', 'pending-workspace', 'schedule'] as const)('refuses unknown or complex native storage without rewriting it: %s', async mode => {
    const root = fixture()
    seed(root)
    if (mode === 'legacy-cache') write(root, legacyName, { sessions: { [ROOT]: { body: secret } } })
    if (mode === 'workspace') write(root, workspaceName, { unit: { name: 'workspace', version: 1 }, global: {}, tables: {} })
    if (mode === 'pending-workspace') { const value = workspaceValue(); write(root, workspaceName, { ...value, global: { ...value.global, pendingMutation: { operation: 'attach', sessionId: ROOT } } }) }
    if (mode === 'schedule') write(root, 'dsh-home/storages/schedule.json', { unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { malformed: { prompt: secret } } } })
    const before = hashes(root)
    await expect(new DshSessionHistory(root).preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_UNSUPPORTED', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
  })

  it('does not treat old-only logs as a supported current session or migrate them', async () => {
    const root = fixture()
    write(root, `dsh-home/sessions/${PROJECT}/${ROOT}/session.v3.jsonl`, JSON.stringify({ type: 'session', version: 3, id: ROOT }) + '\n', true)
    const before = hashes(root)
    await expect(new DshSessionHistory(root).preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_UNSUPPORTED' })
    expect(hashes(root)).toEqual(before)
  })

  it.each(['missing-required', 'wrong-version', 'mismatched-folder'])('requires an authentic current header: %s', async mode => {
    const root = fixture()
    log(root, ROOT)
    const header = { type: 'session', version: mode === 'wrong-version' ? 3 : 4, id: mode === 'mismatched-folder' ? SECOND : ROOT, createdAt: 100, ...(mode === 'missing-required' ? {} : { isSeeded: false }), delegationDepth: 0 }
    write(root, logName(ROOT), JSON.stringify(header) + '\n', true)
    await expect(new DshSessionHistory(root).preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_UNSUPPORTED' })
    expect(existsSync(join(root, logName(ROOT)))).toBe(true)
  })

  it('uses the official UTF-16 segment encoding for non-UUID native identities', async () => {
    const root = fixture()
    log(root, 'root中😀/~', undefined, 'root~4E2D~D83D~DE00~002F~007E')
    const engine = new DshSessionHistory(root)
    expect(await engine.preview()).toMatchObject({ sessionCount: 1, rootCount: 1 })
    expect(await engine.clear(await confirmed(engine))).toMatchObject({ deletedCount: 1 })
  })

  it('preserves the persistent native POSIX lock inode while clearing a stopped session', async () => {
    const root = fixture()
    log(root, ROOT)
    const lock = write(root, `dsh-home/sessions/${PROJECT}/${ROOT}/session.lock`, '', true)
    const original = statSync(lock, { bigint: true })
    const engine = new DshSessionHistory(root)
    expect(await engine.clear(await confirmed(engine))).toMatchObject({ status: 'completed', deletedCount: 1 })
    expect(statSync(lock, { bigint: true }).ino).toBe(original.ino)
    expect(readFileSync(lock, 'utf8')).toBe('')
  })

  it.skipIf(process.platform === 'win32')('rejects symlink ancestors, intermediate directories and final deletion targets without touching outside data', async () => {
    const root = fixture()
    const outside = fixture()
    const outsideData = write(outside, 'plugin/outside.txt', secret, true)
    symlinkSync(outside, join(root, 'alias'))
    expect(() => new DshSessionHistory(join(root, 'alias', 'plugin'))).toThrowError(expect.objectContaining({ code: 'SESSION_HISTORY_PATH_UNSAFE' }))
    const engine = new DshSessionHistory(root)
    log(root, ROOT)
    mkdirSync(join(root, 'dsh-home', 'attachments', 'v1'), { recursive: true })
    symlinkSync(join(outside, 'plugin'), join(root, 'dsh-home', 'attachments', 'v1', 'objects'))
    await expect(engine.preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_PATH_UNSAFE', outcome: 'not-sent' })
    expect(readFileSync(outsideData, 'utf8')).toBe(secret)
    const secondRoot = fixture()
    log(secondRoot, ROOT)
    symlinkSync(outsideData, join(secondRoot, 'session.json'))
    await expect(new DshSessionHistory(secondRoot).preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_PATH_UNSAFE' })
    expect(readFileSync(outsideData, 'utf8')).toBe(secret)
  })

  it.skipIf(process.platform === 'win32')('rejects a target replaced with a symlink after preview before accepting a receipt', async () => {
    const root = fixture()
    const outside = fixture()
    seed(root)
    const target = write(outside, 'protected.txt', secret, true)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const metadata = join(root, 'session.json')
    if (realpathSync(metadata) !== metadata || dirname(metadata) !== root) throw new Error('Invalid fixture unlink path')
    unlinkSync(metadata)
    symlinkSync(target, metadata)
    await expect(engine.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_PREVIEW_STALE', outcome: 'not-sent' })
    expect(readFileSync(target, 'utf8')).toBe(secret)
    expect(existsSync(join(root, receiptName))).toBe(false)
  })

  it('records a partial failure as unknown, never replays it, and requires a fresh preview for a new confirmed intent', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    let failed = false
    vi.mocked(unlinkSync).mockImplementation(path => {
      if (!failed && String(path).endsWith('session.v4.jsonl')) { failed = true; throw new Error(secret + root) }
      originalUnlink(path)
    })
    await expect(engine.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_CLEAR_UNKNOWN', outcome: 'unknown' })
    expect(json(root, receiptName).entries[0]).toMatchObject({ requestId: input.requestId, state: 'unknown' })
    const before = hashes(root)
    const reopened = new DshSessionHistory(root)
    await expect(reopened.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_REQUEST_UNKNOWN', outcome: 'unknown' })
    await expect(engine.clear({ ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'SESSION_HISTORY_PREVIEW_STALE', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
    const renewed = await confirmed(reopened)
    expect(await reopened.clear(renewed)).toMatchObject({ deletedCount: 3, status: 'completed' })
    expect(json(root, receiptName).entries.map((entry: any) => entry.state)).toEqual(['unknown', 'completed'])
  })

  it('treats a persisted pending receipt after restart as unknown and exposes no private error details', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    await engine.clear(input)
    const value = json(root, receiptName)
    value.entries[0].state = 'pending'
    delete value.entries[0].result
    write(root, receiptName, value)
    const before = hashes(root)
    await expect(new DshSessionHistory(root).clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_REQUEST_UNKNOWN', outcome: 'unknown' })
    expect(hashes(root)).toEqual(before)
    write(root, receiptName, secret + root, true)
    try { await new DshSessionHistory(root).preview(); throw new Error('Expected receipt rejection') }
    catch (error) { expect(error).toMatchObject({ code: 'SESSION_HISTORY_RECEIPT_INVALID' }); expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(root) }
  })

  it('fails before acceptance if the pending receipt cannot be persisted and leaves history intact', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const before = hashes(root)
    vi.mocked(renameSync).mockImplementation((source, target) => {
      if (String(target) === join(root, receiptName)) throw new Error(secret + root)
      originalRename(source, target)
    })
    await expect(engine.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_IO_FAILED', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
  })

  it('records a completion-receipt failure as unknown without replaying deleted history', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    let receiptWrites = 0
    vi.mocked(renameSync).mockImplementation((source, target) => {
      if (String(target) === join(root, receiptName) && ++receiptWrites === 2) throw new Error(secret + root)
      originalRename(source, target)
    })
    await expect(engine.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_CLEAR_UNKNOWN', outcome: 'unknown' })
    expect(json(root, receiptName).entries[0].state).toBe('unknown')
    expect(existsSync(join(root, logName(ROOT)))).toBe(false)
    await expect(new DshSessionHistory(root).clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_REQUEST_UNKNOWN', outcome: 'unknown' })
    expect(await new DshSessionHistory(root).preview()).toMatchObject({ sessionCount: 0 })
  })

  it('rechecks ancestor inode identity after accepting a receipt and before rewriting native indexes', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    const sourceDirectory = join(root, 'dsh-home', 'storages')
    const retainedDirectory = join(root, 'retained-original-storages')
    let replaced = false
    vi.mocked(renameSync).mockImplementation((source, target) => {
      originalRename(source, target)
      if (!replaced && String(target) === join(root, receiptName)) {
        replaced = true
        if (realpathSync(sourceDirectory) !== sourceDirectory || resolve(retainedDirectory) !== retainedDirectory || dirname(retainedDirectory) !== root || existsSync(retainedDirectory)) throw new Error('Invalid fixture move path')
        originalRename(sourceDirectory, retainedDirectory)
        write(root, workspaceName, { fixture: 'replacement-must-remain' })
      }
    })
    await expect(engine.clear(input)).rejects.toMatchObject({ code: 'SESSION_HISTORY_CLEAR_UNKNOWN', outcome: 'unknown' })
    expect(json(root, workspaceName)).toEqual({ fixture: 'replacement-must-remain' })
    expect(existsSync(join(root, logName(ROOT)))).toBe(true)
    expect(json(root, receiptName).entries[0].state).toBe('unknown')
  })

  it('rechecks filesystem changes made during the final runtime callback before accepting', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    await expect(engine.clear(input, () => { write(root, 'session.json', { fixture: 'changed-during-admission' }) })).rejects.toMatchObject({ code: 'SESSION_HISTORY_PREVIEW_STALE', outcome: 'not-sent' })
    expect(existsSync(join(root, receiptName))).toBe(false)
    expect(existsSync(join(root, logName(ROOT)))).toBe(true)
    expect(readdirSync(root).filter(name => name.includes('lock'))).toEqual([])
  })

  it('requires a fresh read of a stale maintenance lock and recovers it without replaying its request', async () => {
    const root = fixture()
    log(root, ROOT)
    const abandonedId = randomUUID()
    const lock = write(root, 'session-history-lock.json', { schemaVersion: 1, pid: 123456789, requestId: abandonedId })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Fixture process exited'), { code: 'ESRCH' }) })
    const engine = new DshSessionHistory(root)
    const input = await confirmed(engine)
    expect(existsSync(lock)).toBe(true)
    expect(await engine.clear(input)).toMatchObject({ status: 'completed', deletedCount: 1 })
    expect(existsSync(lock)).toBe(false)
    expect(json(root, receiptName).entries.map((entry: any) => entry.requestId)).toEqual([input.requestId])
  })

  it('never accepts an unsupported receipt schema or silently forgets idempotency records', async () => {
    const root = fixture()
    log(root, ROOT)
    write(root, receiptName, { schemaVersion: 0, entries: [] })
    const before = hashes(root)
    await expect(new DshSessionHistory(root).preview()).rejects.toMatchObject({ code: 'SESSION_HISTORY_RECEIPT_INVALID', outcome: 'not-sent' })
    expect(hashes(root)).toEqual(before)
  })
})
