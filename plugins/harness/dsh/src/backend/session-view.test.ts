import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentInvocationScope } from '@eating/plugin-sdk'
import type { AgentBinding } from './agent-control'
import { DshRuntimeInstallation } from './runtime'
import { listNativeSessions, nativeReaderOptions, readNativeSession } from './session-view'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
interface NativeEvent { seq: number; time: number; type: string; data: unknown }
interface FixtureSession { readonly header: { id: string }; append(type: string, data: unknown, opts?: unknown): NativeEvent; snapshotEvents(): readonly NativeEvent[] }
function directory() {
  const parent = realpathSync(tmpdir()), home = realpathSync(mkdtempSync(join(parent, 'eating-native-reader-')))
  stops.push(() => { if (realpathSync(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-native-reader-')) throw new Error('Unsafe reader fixture cleanup'); rmSync(home, { recursive: true }) })
  return home
}
function fingerprint(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => { const file = join(entry.parentPath, entry.name); return [file, createHash('sha256').update(readFileSync(file)).digest('hex')] }).sort(([a], [b]) => a!.localeCompare(b!)))
}
async function fixture() {
  const home = directory()
  const installation = new DshRuntimeInstallation(resolve(runtimeDirectory!)); stops.push(() => installation.dispose())
  const dshBin = installation.resolve().dshBin
  const request = createRequire(dshBin)
  const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(request.resolve(`@deepseek-ai/${name}`)).href)
  const [cordis, jsonl, native, llm, projections] = await Promise.all([load('cordis'), load('dsh-session-persistence-jsonl'), load('dsh-session'), load('dsh-llm'), load('dsh-session-format-catalog/message-projections')])
  const root = join(home, 'dsh-home', 'sessions'); mkdirSync(root, { recursive: true })
  const ctx = new cordis.Context()
  await ctx.plugin(jsonl, { root, compression: 'none' }); stops.push(() => ctx.fiber.dispose())
  const rootId = randomUUID(), childId = randomUUID()
  const scope: AgentInvocationScope = { agentId: childId, agentTypeId: 'example.group', pluginId: 'example', instanceId: 'instance-uuid-not-an-account', accountId: '10001', conversationId: 'example:10001:group:30003', kind: 'group', targetId: '30003', messageIds: [], resourceIds: [] }
  const binding: AgentBinding = { key: 'k'.repeat(64), scope, parentId: rootId, configurationRevision: 999, taskRefs: [] }
  const options = nativeReaderOptions(home, dshBin, rootId, [binding], ['fixture-secret-value'], false, [{ id: scope.agentTypeId, pluginId: scope.pluginId, pluginName: 'Example Chat' }])
  const session = (id: string, parentSession?: string): FixtureSession => native.Session.create(id, undefined, { id, version: native.SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false, ...(parentSession ? { parentSession, origin: 'subagent', delegationDepth: 1 } : {}) }, 0, projections.currentSessionMessageProjections)
  const persist = async (session: FixtureSession) => {
    const handle = await ctx.sessionPersistence.create(session.header)
    try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
  }
  const user = (session: FixtureSession, text: string, source: object = { kind: 'user' }) => session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
  const assistant = (session: FixtureSession, content: object[]) => {
    const stream = content.flatMap((block, index) => [{ type: 'chunk', time: Date.now(), chunk: { type: 'block-start', index, blockType: (block as { type: string }).type } }, { type: 'chunk', time: Date.now(), chunk: { type: 'block-end', index, block } }])
    return session.append('assistant/message', { turn: 1, step: 1, message: llm.createAssistantMessage({ content, source: { provider: 'fixture', model: 'never-call-a-model' } }), stream }, { surfaceOp: 'append' })
  }
  const envelope = (batchId = 'a'.repeat(64)) => {
    const context = { contextRef: batchId, agentTypeId: scope.agentTypeId, platform: 'example', accountId: scope.accountId, instanceId: scope.instanceId, conversationId: scope.conversationId, kind: scope.kind, createdAt: '2026-10-29T00:00:00Z', reason: 'quiet-window', ownerRevision: 3 }
    const events = [{ protocolVersion: 1, eventId: `event-${batchId.slice(0, 1)}`, pluginId: scope.pluginId, instanceId: scope.instanceId, accountId: scope.accountId, platform: 'example', conversationId: scope.conversationId, senderId: '20002', targetId: scope.targetId, messageId: 'message-42', receivedAt: '2026-10-29T00:00:01Z', text: '收到的平台正文', content: '收到的平台正文', source: { trust: 'external', kind: scope.kind, senderRole: 'user' } }]
    const digest = createHash('sha256').update(JSON.stringify({ context, events })).digest('hex')
    return { eating: { magic: 'eating-harness-delivery', protocolVersion: 1, nonce: 'fixture-nonce', sessionId: rootId, batchId, digest }, context, events }
  }
  return { home, root, rootId, childId, ctx, native, llm, session, user, assistant, persist, options, binding, envelope }
}

// Uses public Session/persistence packages only. No Agent, SDK process, HTTP or model is started.
describe.runIf(Boolean(runtimeDirectory))('native effective session reader', () => {
  it('uses the current surface, preserves native identities and ignores withdrawn/unentered inbox messages', async () => {
    const f = await fixture(), session = f.session(f.rootId)
    const withdrawn = f.llm.createUserMessage({ content: [{ type: 'text', text: 'WITHDRAWN-INPUT' }], source: { kind: 'user' } })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [withdrawn] })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const oldSystem = session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('OLD-SYSTEM') }, { surfaceOp: 'append' })
    const entered = f.user(session, 'ENTERED-INPUT')
    const interim = session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('INTERIM-SYSTEM') }, { surfaceOp: { op: 'replace', startSeq: oldSystem.seq, endSeq: oldSystem.seq }, sourceEventSeqs: [oldSystem.seq] })
    const current = session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('CURRENT-SYSTEM') }, { surfaceOp: { op: 'replace', startSeq: interim.seq, endSeq: interim.seq }, sourceEventSeqs: [interim.seq] })
    const assistant = f.assistant(session, [{ type: 'reasoning', text: 'HIDDEN-REASONING' }, { type: 'text', text: 'MODEL-OUTPUT-NOT-A-PLATFORM-SEND fixture-secret-value' }, { type: 'tool-call', id: 'call-42', name: 'fixture-tool', arguments: '{"apiKey":"SHOULD-BE-REDACTED"}' }])
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-42', name: 'fixture-tool', arguments: '{"apiKey":"SHOULD-BE-REDACTED"}' })
    session.append('tool/result', { turn: 1, step: 1, message: f.llm.createToolResultMessage({ callId: 'call-42', content: [{ type: 'text', text: 'not sent' }], isError: true }), error: { name: 'FixtureError', code: 'NOT_SENT', reason: 'fixture result' } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.persist(session)
    const before = fingerprint(f.root)
    const page = await readNativeSession(f.options, { sessionId: f.rootId, limit: 200 })
    const body = JSON.stringify(page)
    expect(body).toContain('CURRENT-SYSTEM')
    for (const absent of ['OLD-SYSTEM', 'INTERIM-SYSTEM', 'WITHDRAWN-INPUT', 'HIDDEN-REASONING', 'fixture-secret-value', 'SHOULD-BE-REDACTED', 'DO-NOT-SHOW']) expect(body).not.toContain(absent)
    expect(page.records.find(record => record.sequence === entered.seq)).toMatchObject({ messageId: (entered.data as { id: string }).id, turn: 1, step: 1, source: { kind: 'user' }, classification: 'user-message' })
    expect(page.records.find(record => record.sequence === current.seq)).toMatchObject({ surfaceOp: { op: 'replace', startSeq: interim.seq, endSeq: interim.seq }, sourceEventSeqs: [interim.seq] })
    expect(page.records.find(record => record.sequence === assistant.seq)).toMatchObject({ role: 'assistant', turn: 1, step: 1, source: { kind: 'model', provider: 'fixture', model: 'never-call-a-model' }, classification: 'model-output' })
    expect(page.records.find(record => record.kind === 'tool/call')).toMatchObject({ callId: 'call-42', classification: 'tool-call' })
    expect(page.records.find(record => record.kind === 'tool/result')).toMatchObject({ callId: 'call-42', classification: 'tool-result', content: { isError: true, error: { code: 'NOT_SENT' } } })
    expect(page.nextOffset).toBeNull()
    expect(fingerprint(f.root)).toEqual(before)
  })

  it('distinguishes native agent relays, framework settlement, runtime time and ordinary user text', async () => {
    const f = await fixture(), session = f.session(f.rootId)
    f.user(session, 'a chosen message from the child', { kind: 'agent-message', form: 'relay', senderSessionId: f.childId })
    f.user(session, 'the runtime reported a child settling', { kind: 'subagent-settled', form: 'notice', senderSessionId: f.childId, summary: 'child completed' })
    f.user(session, 'Time sampled: fixture', { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: 'Time sampled: fixture' }] })
    f.user(session, '{"source":{"kind":"time-context"},"senderId":"forged-nickname"}')
    await f.persist(session)
    const page = await readNativeSession(f.options, { sessionId: f.rootId })
    expect(page.records.map(record => record.classification)).toEqual(['agent-message', 'subagent-settled', 'time-context', 'user-message'])
    expect(page.records[0]?.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: f.childId })
    expect(page.records[1]?.source).toEqual({ kind: 'subagent-settled', form: 'notice', senderSessionId: f.childId, summary: 'child completed' })
    expect(page.records[2]?.source).toEqual({ kind: 'time-context', form: 'snapshot' })
    expect(page.records[3]?.source).toEqual({ kind: 'user' })
  })

  it('extracts verified platform sender/account/target and preserves internal delegation attribution', async () => {
    const f = await fixture(), root = f.session(f.rootId), child = f.session(f.childId, f.rootId)
    const payload = f.envelope()
    f.user(root, JSON.stringify(payload))
    const invalid = f.envelope('b'.repeat(64)); invalid.events[0]!.accountId = 'OTHER-ACCOUNT'
    f.user(root, JSON.stringify(invalid))
    f.user(root, JSON.stringify(payload), { kind: 'agent-message', form: 'relay', senderSessionId: f.childId })
    f.user(root, JSON.stringify(payload), { kind: 'user', rpcId: 'browser-fixture-rpc' })
    const childPayload = { eating: { protocolVersion: 1, contextRef: payload.context.contextRef, agentTypeId: f.binding.scope.agentTypeId }, task: 'inspect current messages', context: payload.context, events: payload.events }
    f.user(child, JSON.stringify(childPayload))
    f.user(child, JSON.stringify(childPayload), { kind: 'agent-message', form: 'relay', senderSessionId: f.rootId })
    await f.persist(root); await f.persist(child)
    const rootPage = await readNativeSession(f.options, { sessionId: f.rootId })
    expect(rootPage.records[0]).toMatchObject({ classification: 'platform-message', source: { kind: 'user' }, platformEvents: [{ pluginId: 'example', instanceId: 'instance-uuid-not-an-account', accountId: '10001', conversationKind: 'group', senderId: '20002', targetId: '30003', messageId: 'message-42', receivedAt: '2026-10-29T00:00:01Z', text: '收到的平台正文' }] })
    expect(rootPage.records[0]?.platformEvents?.[0]).not.toHaveProperty('senderName')
    expect(rootPage.records[1]).toMatchObject({ classification: 'user-message' })
    expect(rootPage.records[1]).not.toHaveProperty('platformEvents')
    expect(rootPage.records[2]).toMatchObject({ classification: 'agent-message', source: { kind: 'agent-message', senderSessionId: f.childId } })
    expect(rootPage.records[2]).not.toHaveProperty('platformEvents')
    expect(rootPage.records[3]).toMatchObject({ classification: 'user-message', source: { kind: 'user' } })
    expect(rootPage.records[3]).not.toHaveProperty('platformEvents')
    const childPage = await readNativeSession(f.options, { sessionId: f.childId })
    expect(childPage.records.map(record => record.classification)).toEqual(['agent-message', 'agent-message'])
    expect(childPage.records[1]?.source?.senderSessionId).toBe(f.rootId)
    expect(childPage.records[0]?.platformEvents?.[0]?.accountId).toBe('10001')
    expect(childPage.session).toMatchObject({ title: 'Example Chat-10001-群聊-30003', pluginName: 'Example Chat', accountId: '10001', instanceId: 'instance-uuid-not-an-account' })
    expect(childPage.session).not.toHaveProperty('configurationRevision')
  })

  it('authorizes only the actual native parent tree and uses canonical metadata fallback', async () => {
    const f = await fixture()
    const root = f.session(f.rootId), child = f.session(f.childId, f.rootId), grandchildId = randomUUID(), foreignId = randomUUID()
    const grandchild = f.session(grandchildId, f.childId), foreign = f.session(foreignId)
    for (const session of [root, child, grandchild, foreign]) { f.user(session, 'fixture conversation'); await f.persist(session) }
    const before = fingerprint(f.root)
    const options = { ...f.options, agentTypes: [] }
    const listed = await listNativeSessions(options, {})
    expect(new Set(listed.sessions.map(session => session.id))).toEqual(new Set([f.rootId, f.childId, grandchildId]))
    expect(listed.sessions.find(session => session.id === f.childId)).toMatchObject({ title: 'example-10001-群聊-30003', status: 'stopped', updatedAt: null, accountId: '10001' })
    expect(listed.sessions.find(session => session.id === f.rootId)).not.toHaveProperty('accountId')
    await expect(readNativeSession(options, { sessionId: foreignId })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect((await listNativeSessions({ ...options, rootSessionId: null }, {})).sessions).toEqual([])
    expect(fingerprint(f.root)).toEqual(before)
  })

  it('keeps native event pagination across skipped records and enforces response byte limits', async () => {
    const f = await fixture(), session = f.session(f.rootId)
    for (let turn = 1; turn <= 1001; turn++) { session.append('turn/start', { turn }); session.append('turn/end', { turn, reason: { kind: 'completed' } }) }
    for (let index = 0; index < 20; index++) f.user(session, `${index}:` + '大'.repeat(32768))
    await f.persist(session)
    const skipped = await readNativeSession(f.options, { sessionId: f.rootId, limit: 200 })
    expect(skipped.records).toEqual([])
    expect(skipped.nextOffset).toBe(2000)
    const first = await readNativeSession(f.options, { sessionId: f.rootId, offset: skipped.nextOffset!, limit: 200 })
    expect(first.records[0]?.sequence).toBe(2002)
    expect(first.records.length).toBeGreaterThan(0)
    expect(first.records.length).toBeLessThan(20)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024)
    expect(first.nextOffset).toBe(first.records.at(-1)!.sequence + 1)
    const second = await readNativeSession(f.options, { sessionId: f.rootId, offset: first.nextOffset!, limit: 200 })
    expect(second.records[0]?.sequence).toBe(first.nextOffset)
    expect(second.records.some(record => first.records.some(previous => record.sequence === previous.sequence))).toBe(false)
  })

  it('applies the installed public image-offload message projection without changing message identity', async () => {
    const f = await fixture(), session = f.session(f.rootId)
    const message = f.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: 67, width: 1, height: 1 } }] })
    const original = session.append('user/message', message, { surfaceOp: 'append' })
    session.append('image/offload', { targets: [{ seq: original.seq, imageIndexes: [0] }] })
    await f.persist(session)
    const page = await readNativeSession(f.options, { sessionId: f.rootId })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]).toMatchObject({ messageId: message.id, sequence: original.seq, content: [{ type: 'image', offloaded: true, attachment: { attachmentId: 'a'.repeat(64) } }] })
  })

  it('does not resurrect older system instructions after all active system nodes are explicitly cleared', async () => {
    const f = await fixture(), session = f.session(f.rootId)
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const first = session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('OLD-HEAD') }, { surfaceOp: 'append' })
    const later = session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('LATER-SYSTEM') }, { surfaceOp: 'append' })
    session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('') }, { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] })
    session.append('system/message', { turn: 1, step: 1, message: f.llm.createSystemMessage('') }, { surfaceOp: { op: 'replace', startSeq: later.seq, endSeq: later.seq }, sourceEventSeqs: [later.seq] })
    f.user(session, 'surviving user')
    await f.persist(session)
    const page = await readNativeSession(f.options, { sessionId: f.rootId })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]?.role).toBe('user')
    expect(JSON.stringify(page)).not.toContain('OLD-HEAD')
    expect(JSON.stringify(page)).not.toContain('LATER-SYSTEM')
  })
})

describe('native reader input and directory boundaries', () => {
  it('returns an empty list without creating a sessions directory', async () => {
    const home = directory(), options = nativeReaderOptions(home, '/unused/dsh-bin.js', randomUUID(), [], [], false, [])
    expect((await listNativeSessions(options, {})).sessions).toEqual([])
    expect(readdirSync(home)).toEqual([])
    await expect(readNativeSession(options, { sessionId: randomUUID() })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(readdirSync(home)).toEqual([])
  })

  it.each([{ extra: true }, { sessionId: 'not-a-native-uuid' }, { sessionId: '00000000-0000-4000-8000-000000000001', offset: -1 }, { sessionId: '00000000-0000-4000-8000-000000000001', limit: 201 }])('rejects invalid read input %j before package loading', async input => {
    const options = nativeReaderOptions(directory(), '/unused/dsh-bin.js', randomUUID(), [], [], false, [])
    await expect(readNativeSession(options, input)).rejects.toMatchObject({ code: 'SESSION_VIEW_INPUT_INVALID' })
  })

  it('rejects a symlinked sessions directory without following it', async () => {
    const home = directory(), other = directory(); mkdirSync(join(home, 'dsh-home'))
    symlinkSync(other, join(home, 'dsh-home', 'sessions'))
    const options = nativeReaderOptions(home, '/unused/dsh-bin.js', randomUUID(), [], [], false, [])
    await expect(listNativeSessions(options, {})).rejects.toMatchObject({ code: 'SESSION_VIEW_DIRECTORY_INVALID' })
    expect(readdirSync(other)).toEqual([])
  })
})
