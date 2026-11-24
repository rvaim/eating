import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshResetEngine } from './session-history'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync), renameSync: vi.fn(actual.renameSync) }
})

const roots: string[] = []
const ROOT = '00000000-0000-4000-8000-000000000001'
const SECOND = '00000000-0000-4000-8000-000000000002'
const CHILD = '00000000-0000-4000-8000-000000000003'
const PROJECT = '--fixture-project--'
const receiptName = 'dsh-reset-receipt.json'
const secret = 'fixture-private-body-and-credential-do-not-expose'

function fixture(): string {
  const parent = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(parent, 'eating-dsh-reset-')))
  if (!isAbsolute(root) || dirname(root) !== parent || !basename(root).startsWith('eating-dsh-reset-')) throw new Error('Invalid fixture root')
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

function json(root: string, name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, any>
}

function writeSessionLog(root: string, id: string, parentSession?: string): string {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1_793_770_000_000,
    isSeeded: false,
    delegationDepth: parentSession ? 1 : 0,
    cwd: '/fixture/project',
    ...(parentSession ? { parentSession, origin: 'subagent' } : {}),
  }
  return write(
    root,
    `dsh-home/sessions/${PROJECT}/${id}/session.v4.jsonl`,
    JSON.stringify(header) + '\n' + JSON.stringify({ type: 'event', seq: 1, event: { type: 'goal/change', goal: { objective: secret } } }) + '\n',
    true,
  )
}

function seed(root: string) {
  writeSessionLog(root, ROOT)
  writeSessionLog(root, SECOND)
  writeSessionLog(root, CHILD, ROOT)
  const removed = [
    `dsh-home/sessions/${PROJECT}/${ROOT}/session.v4.jsonl`,
    `dsh-home/sessions/${PROJECT}/${ROOT}/session.lock`,
    `dsh-home/sessions/${PROJECT}/${SECOND}/session.v4.jsonl`,
    `dsh-home/sessions/${PROJECT}/${CHILD}/session.v4.jsonl`,
    'dsh-home/storages/workspace.json',
    'dsh-home/storages/schedule.json',
    `dsh-home/storages/session_projcache/sessions/${ROOT}.json`,
    'dsh-home/attachments/v1/objects/nested/object',
    'dsh-home/cache/attachments/request-images/image',
    'dsh-home/.credentials.yaml',
    'dsh-home/profiles/sdk-minimal/package.json',
    'dsh-home/profiles/sdk-minimal/cordis.patch.yml',
    'dsh-home/profiles/sdk-minimal/node_modules/user-plugin/index.js',
    'workspace/scratch.txt',
    'workspace/nested/project.md',
    'agents-home/cache.json',
    'runtime-home/.config/state.json',
    'native-management/runtime.patch.yaml',
    'bridge/owner-policy.json',
    'bridge/deliveries.json',
    'bridge/session-ready.json',
    'bridge/runtime-bridge.mjs',
    'session.json',
    'agent-bindings.json',
    'proactive-bindings.json',
    'execution-bindings.json',
    'session-history-receipt.json',
    'session-history-lock.json',
  ]
  write(root, `dsh-home/sessions/${PROJECT}/${ROOT}/session.lock`, '', true)
  write(root, 'dsh-home/storages/workspace.json', { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } })
  write(root, 'dsh-home/storages/schedule.json', { unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { t1: { sessionId: ROOT, record: { prompt: secret }, status: 'active' } } } })
  write(root, `dsh-home/storages/session_projcache/sessions/${ROOT}.json`, { version: 7, record: { identity: { createdAt: 1 }, rows: {} } })
  write(root, 'dsh-home/attachments/v1/objects/nested/object', secret, true)
  write(root, 'dsh-home/cache/attachments/request-images/image', secret, true)
  write(root, 'dsh-home/.credentials.yaml', 'cached: true\n', true)
  write(root, 'dsh-home/profiles/sdk-minimal/package.json', { name: 'dsh-profile-sdk-minimal' })
  write(root, 'dsh-home/profiles/sdk-minimal/cordis.patch.yml', '- id: stale\n', true)
  write(root, 'dsh-home/profiles/sdk-minimal/node_modules/user-plugin/index.js', 'export default {}\n', true)
  write(root, 'workspace/scratch.txt', 'workspace file 1', true)
  write(root, 'workspace/nested/project.md', 'workspace file 2', true)
  write(root, 'agents-home/cache.json', { ok: true })
  write(root, 'runtime-home/.config/state.json', { ok: true })
  write(root, 'native-management/runtime.patch.yaml', '[]', true)
  write(root, 'bridge/owner-policy.json', { schemaVersion: 1, revision: 1, systemPrompt: secret, agentTypes: [] })
  write(root, 'bridge/deliveries.json', { schemaVersion: 1, revision: 1, deliveries: [] })
  write(root, 'bridge/session-ready.json', { schemaVersion: 1, nonce: 'n', sessionId: ROOT })
  write(root, 'bridge/runtime-bridge.mjs', 'export default {}', true)
  write(root, 'session.json', { schemaVersion: 1, sessionId: ROOT, created: true })
  write(root, 'agent-bindings.json', { schemaVersion: 2, bindings: [] })
  write(root, 'proactive-bindings.json', { schemaVersion: 1, bindings: [] })
  write(root, 'execution-bindings.json', { schemaVersion: 1, bindings: [] })
  write(root, 'session-history-receipt.json', { schemaVersion: 1, entries: [] })
  write(root, 'session-history-lock.json', { schemaVersion: 1, pid: 999999, requestId: ROOT })

  const protectedNames = [
    'config.json',
    'model-capabilities.json',
    'model-information.json',
    'native-capabilities.json',
    'autonomy.json',
    'autonomy-agenda.json',
    'proactive-contact-policy.json',
  ]
  for (const name of protectedNames) write(root, name, { retained: secret })
  return { removed, protectedFiles: new Map(protectedNames.map(name => [name, readFileSync(join(root, name))])) }
}

function hashes(root: string): Map<string, string> {
  const result = new Map<string, string>()
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path)
      else result.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(root)
  return result
}

const originalUnlink = vi.mocked(unlinkSync).getMockImplementation()!
const originalRename = vi.mocked(renameSync).getMockImplementation()!
afterEach(() => {
  vi.mocked(unlinkSync).mockReset().mockImplementation(originalUnlink)
  vi.mocked(renameSync).mockReset().mockImplementation(originalRename)
  vi.restoreAllMocks()
  for (const root of roots.splice(0).reverse()) {
    if (resolve(root) !== root || realpathSync(root) !== root || lstatSync(root).isSymbolicLink() || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('eating-dsh-reset-')) throw new Error('Invalid fixture cleanup path')
    rmSync(root, { recursive: true })
  }
})

describe('DshResetEngine', () => {
  it('previews sessions, schedules, workspace items, and queue counts without writing any files', async () => {
    const root = fixture()
    seed(root)
    const before = hashes(root)
    const preview = await new DshResetEngine(root).preview({
      runtimeRunning: true,
      queue: { pending: 2, delivering: 1, uncertain: 1, queuedMessages: 4 },
    })
    expect(preview).toMatchObject({
      previewId: expect.any(String),
      expiresAt: expect.any(String),
      runtimeRunning: true,
      sessionCount: 3,
      rootCount: 2,
      childCount: 1,
      scheduledCount: 1,
      workspaceEntryCount: 2,
      hasResettableData: true,
      hasPendingQueue: true,
      pendingQueueCount: 3,
      uncertainQueueCount: 1,
    })
    expect(Date.parse(preview.expiresAt) - Date.now()).toBeGreaterThan(299_000)
    expect(JSON.stringify(preview)).not.toContain(root)
    expect(JSON.stringify(preview)).not.toContain(secret)
    expect(hashes(root)).toEqual(before)
    expect(existsSync(join(root, receiptName))).toBe(false)
  })

  it('resets the entire isolated DSH runtime directory (including dsh-home/profiles, sessions, storages, workspace, bridge and bindings) while strictly preserving Eating DSH plugin configs', async () => {
    const root = fixture()
    const { removed, protectedFiles } = seed(root)
    const engine = new DshResetEngine(root)
    const preview = await engine.preview()
    const requestId = randomUUID()
    const inspected = engine.inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true })
    expect(inspected.prepared).toBeDefined()

    const result = engine.executeReset(inspected.prepared!)
    expect(result).toEqual({
      requestId,
      status: 'completed',
      deletedSessions: 3,
      clearedWorkspaceEntries: 2,
      clearedScheduledCount: 1,
      clearedQueueCount: 0,
      queueAction: 'none',
      wasRunning: false,
      restarted: false,
    })

    for (const name of removed) expect(existsSync(join(root, name)), name).toBe(false)
    for (const [name, bytes] of protectedFiles) expect(readFileSync(join(root, name)).equals(bytes), name).toBe(true)
    expect(existsSync(join(root, 'dsh-home'))).toBe(false)
    expect(existsSync(join(root, 'workspace'))).toBe(true)
    expect(readdirSync(join(root, 'workspace'))).toEqual([])
    expect(existsSync(join(root, 'bridge'))).toBe(true)
    expect(readdirSync(join(root, 'bridge'))).toEqual([])
    expect(existsSync(join(root, 'agents-home'))).toBe(false)
    expect(existsSync(join(root, 'runtime-home'))).toBe(false)
    expect(existsSync(join(root, 'native-management'))).toBe(false)

    const receipt = json(root, receiptName)
    expect(receipt.schemaVersion).toBe(1)
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({ requestId, previewId: preview.previewId, state: 'completed', result })
    expect(JSON.stringify(receipt)).not.toContain(secret)
    expect(JSON.stringify(receipt)).not.toContain(root)

    const afterPreview = await new DshResetEngine(root).preview()
    expect(afterPreview).toMatchObject({
      sessionCount: 0,
      rootCount: 0,
      childCount: 0,
      scheduledCount: 0,
      workspaceEntryCount: 0,
      hasResettableData: false,
    })
  })

  it('replays completed receipts idempotently and rejects conflicts or unknown outcomes', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshResetEngine(root)
    const preview = await engine.preview()
    const requestId = randomUUID()
    const input = { previewId: preview.previewId, requestId, confirmed: true as const }
    const prepared = engine.inspectResetRequest(input).prepared!
    const initial = engine.executeReset(prepared)
    const finalized = engine.finalizeReceipt({ ...initial, wasRunning: true, restarted: true, clearedQueueCount: 2 })
    const beforeReplay = hashes(root)

    const replayed = new DshResetEngine(root).inspectResetRequest(input)
    expect(replayed.replay).toEqual(finalized)
    expect(hashes(root)).toEqual(beforeReplay)

    expect(() => engine.inspectResetRequest({ ...input, previewId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'DSH_RESET_REQUEST_CONFLICT', outcome: 'not-sent' }))
    expect(() => engine.inspectResetRequest({ ...input, queueAction: 'clear' })).toThrowError(expect.objectContaining({ code: 'DSH_RESET_REQUEST_CONFLICT', outcome: 'not-sent' }))
  })

  it('requires explicit queueAction when delivery queue is non-empty and rejects invalid or expired previews', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshResetEngine(root)
    const preview = await engine.preview({ queue: { pending: 1, delivering: 0, uncertain: 1, queuedMessages: 2 } })
    const requestId = randomUUID()

    expect(() => engine.inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true }, { pending: 1, delivering: 0, uncertain: 1, queuedMessages: 2 }))
      .toThrowError(expect.objectContaining({ code: 'DSH_RESET_QUEUE_DECISION_REQUIRED', outcome: 'not-sent' }))

    expect(engine.inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true, queueAction: 'keep' }, { pending: 1, delivering: 0, uncertain: 1, queuedMessages: 2 }).prepared?.queueAction).toBe('keep')
    expect(engine.inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true, queueAction: 'clear' }, { pending: 1, delivering: 0, uncertain: 1, queuedMessages: 2 }).prepared?.queueAction).toBe('clear')

    for (const invalid of [
      { previewId: preview.previewId, requestId, confirmed: false },
      { previewId: preview.previewId, requestId, confirmed: true, queueAction: 'drop' },
      { previewId: preview.previewId, requestId, confirmed: true, path: root },
    ]) {
      expect(() => engine.inspectResetRequest(invalid)).toThrowError(expect.objectContaining({ code: 'DSH_RESET_INVALID_INPUT', outcome: 'not-sent' }))
    }

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_000)
    expect(() => engine.inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true, queueAction: 'keep' }))
      .toThrowError(expect.objectContaining({ code: 'DSH_RESET_PREVIEW_STALE', outcome: 'not-sent' }))
  })

  it('recovers cleanly even when DSH session or storage files are corrupted/legacy', async () => {
    const root = fixture()
    write(root, `dsh-home/sessions/${PROJECT}/broken/session.v3.jsonl`, 'not valid json', true)
    write(root, 'dsh-home/storages/workspace.json', '{ broken', true)
    write(root, 'dsh-home/profiles/sdk-minimal/package.json', { kept: true })

    const engine = new DshResetEngine(root)
    const preview = await engine.preview()
    expect(preview.hasResettableData).toBe(true)
    const prepared = engine.inspectResetRequest({ previewId: preview.previewId, requestId: randomUUID(), confirmed: true }).prepared!
    const result = engine.executeReset(prepared)
    expect(result.status).toBe('completed')
    expect(existsSync(join(root, 'dsh-home'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('blocks symlink escape in root/dsh-home/profiles-root/session metadata while safely unlinking workspace and profile node_modules symlinks without touching outside data', async () => {
    const root = fixture()
    const outside = fixture()
    const outsideData = write(outside, 'plugin/outside.txt', secret, true)

    symlinkSync(outside, join(root, 'alias'))
    expect(() => new DshResetEngine(join(root, 'alias', 'plugin'))).toThrowError(expect.objectContaining({ code: 'DSH_RESET_PATH_UNSAFE' }))

    const badHome = fixture()
    mkdirSync(join(badHome, 'dsh-home', 'attachments', 'v1'), { recursive: true })
    symlinkSync(join(outside, 'plugin'), join(badHome, 'dsh-home', 'attachments', 'v1', 'objects'))
    await expect(new DshResetEngine(badHome).preview()).rejects.toMatchObject({ code: 'DSH_RESET_PATH_UNSAFE', outcome: 'not-sent' })
    expect(readFileSync(outsideData, 'utf8')).toBe(secret)

    const badProfilesRoot = fixture()
    mkdirSync(join(badProfilesRoot, 'dsh-home'), { recursive: true })
    symlinkSync(join(outside, 'plugin'), join(badProfilesRoot, 'dsh-home', 'profiles'))
    await expect(new DshResetEngine(badProfilesRoot).preview()).rejects.toMatchObject({ code: 'DSH_RESET_PATH_UNSAFE', outcome: 'not-sent' })
    expect(readFileSync(outsideData, 'utf8')).toBe(secret)

    const badMeta = fixture()
    symlinkSync(outsideData, join(badMeta, 'session.json'))
    await expect(new DshResetEngine(badMeta).preview()).rejects.toMatchObject({ code: 'DSH_RESET_PATH_UNSAFE', outcome: 'not-sent' })
    expect(readFileSync(outsideData, 'utf8')).toBe(secret)

    // Workspace and profile node_modules symlinks are unlinked directly without touching outside targets.
    const workspaceRoot = fixture()
    mkdirSync(join(workspaceRoot, 'workspace'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'dsh-home', 'profiles', 'sdk-minimal', 'node_modules', '.bin'), { recursive: true })
    symlinkSync(join(outside, 'plugin'), join(workspaceRoot, 'workspace', 'external-link'))
    symlinkSync(outsideData, join(workspaceRoot, 'dsh-home', 'profiles', 'sdk-minimal', 'node_modules', '.bin', 'tool'))
    const wsEngine = new DshResetEngine(workspaceRoot)
    const wsPreview = await wsEngine.preview()
    expect(wsPreview.workspaceEntryCount).toBe(1)
    const wsPrepared = wsEngine.inspectResetRequest({ previewId: wsPreview.previewId, requestId: randomUUID(), confirmed: true }).prepared!
    const wsResult = wsEngine.executeReset(wsPrepared)
    expect(wsResult.clearedWorkspaceEntries).toBe(1)
    expect(readdirSync(join(workspaceRoot, 'workspace'))).toEqual([])
    expect(existsSync(join(workspaceRoot, 'dsh-home'))).toBe(false)
    expect(readFileSync(outsideData, 'utf8')).toBe(secret)
  })

  it('marks receipt unknown and blocks automatic replay when filesystem deletion fails mid-flight', async () => {
    const root = fixture()
    seed(root)
    const engine = new DshResetEngine(root)
    const preview = await engine.preview()
    const requestId = randomUUID()
    const prepared = engine.inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true }).prepared!
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error('EIO simulated') })
    expect(() => engine.executeReset(prepared)).toThrowError(expect.objectContaining({ code: 'DSH_RESET_FAILED', outcome: 'unknown' }))
    expect(() => new DshResetEngine(root).inspectResetRequest({ previewId: preview.previewId, requestId, confirmed: true }))
      .toThrowError(expect.objectContaining({ code: 'DSH_RESET_REQUEST_UNKNOWN', outcome: 'unknown' }))
  })
})
