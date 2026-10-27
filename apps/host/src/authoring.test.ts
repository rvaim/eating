import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError, analyzeTemplate } from '@eating/plugin-sdk'
import type { HarnessEvent, TemplateVariable } from '@eating/plugin-sdk'
import { AUTHORING_SETTING_KEY, AuthoringService } from './authoring'
import { HostStore } from './store'

const cleanups: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture() {
  const temporaryParent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryParent, 'eating-authoring-test-')))
  const databasePath = resolve(directory, 'database', 'host.sqlite')
  if (relative(directory, databasePath).startsWith('..')) throw new Error('Test database escaped temporary directory.')
  const opened = new Set<HostStore>()
  const open = () => { const store = new HostStore(databasePath); opened.add(store); return store }
  const close = (store: HostStore) => { store.close(); opened.delete(store) }
  cleanups.push(() => {
    for (const store of opened) store.close()
    const target = realpathSync(directory)
    if (target !== directory || dirname(target) !== temporaryParent || !basename(target).startsWith('eating-authoring-test-')) {
      throw new Error('Refusing to remove a path outside the test mkdtemp directory.')
    }
    rmSync(target, { recursive: true })
  })
  return { open, close }
}

function failure(operation: () => unknown, code: string, statusCode = 400): PlatformError {
  try { operation() } catch (error) {
    expect(error).toBeInstanceOf(PlatformError)
    expect(error).toMatchObject({ code, statusCode })
    return error as PlatformError
  }
  throw new Error(`Expected ${code}.`)
}

function stored(store: HostStore): string {
  const saved = store.getSetting(AUTHORING_SETTING_KEY)
  if (saved === null) throw new Error('Expected authoring document.')
  return saved
}

function parseStored(store: HostStore): Record<string, unknown> {
  return JSON.parse(stored(store)) as Record<string, unknown>
}

function message(): HarnessEvent {
  return { protocolVersion: 1, eventId: 'test-authoring-event', pluginId: 'test-platform', instanceId: 'test-instance', platform: 'test-platform',
    accountId: 'test-account', conversationId: 'test:private:one', senderId: 'test-sender', receivedAt: '2026-10-27T12:00:00.000Z',
    source: { trust: 'external', kind: 'private' }, content: { type: 'text', text: 'test pending envelope' }, text: 'test pending envelope' }
}

describe('AuthoringService defaults and document persistence', () => {
  it('returns honest empty personas and production prompt defaults without writing on construction or any ordinary read', () => {
    const store = fixture().open()
    const write = vi.spyOn(store, 'setSetting')
    const service = new AuthoringService(store)
    expect(write).not.toHaveBeenCalled()
    const snapshot = service.getSnapshot()
    expect(snapshot).toMatchObject({ protocolVersion: 1, revision: 0, personas: [], activePersonaId: null })
    expect(snapshot.variables).toHaveLength(11)
    expect(snapshot.prompts.map(prompt => prompt.id)).toEqual(['main', 'group', 'private'])
    for (const prompt of snapshot.prompts) {
      expect(prompt).toMatchObject({ revision: 0, updatedAt: null })
      expect(prompt.body.trim().length).toBeGreaterThan(100)
      expect(analyzeTemplate(prompt.body, prompt.id).valid).toBe(true)
    }
    const main = snapshot.prompts.find(prompt => prompt.id === 'main')!
    expect(main.body).toContain('唯一自主 AI 身份')
    expect(main.body).toContain('保持沉默')
    expect(main.body).toContain('主动调用')
    expect(main.body).toContain('外部')
    expect(main.body).toContain('主人独立配置')
    expect(analyzeTemplate(main.body, 'main').tokens.map(token => token.name)).toEqual(['当前时间', '人格名称'])
    expect(service.getSnapshot()).toEqual(snapshot)
    failure(() => service.getPersona('missing'), 'PERSONA_NOT_FOUND', 404)
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('creates trimmed owner personas without activation, exposes body only in detail, and persists schema after reopening', () => {
    const { open, close } = fixture()
    const firstStore = open()
    const first = new AuthoringService(firstStore)
    const created = first.createPersona('  认真生活  ', '保持真诚。当前时间：{{当前时间}}。名字：{{人格名称}}。')
    expect(created.persona.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(created.persona).toMatchObject({ name: '认真生活', revision: 1, createdAt: expect.any(String), updatedAt: expect.any(String) })
    expect(created.persona.createdAt).toBe(created.persona.updatedAt)
    expect(created.snapshot).toMatchObject({ revision: 1, activePersonaId: null })
    expect(created.snapshot.personas).toEqual([{ id: created.persona.id, name: '认真生活', revision: 1, createdAt: created.persona.createdAt, updatedAt: created.persona.updatedAt }])
    expect(first.getPersona(created.persona.id)).toEqual(created.persona)
    expect(parseStored(firstStore)).toMatchObject({ schemaVersion: 1, revision: 1 })
    close(firstStore)
    const secondStore = open()
    const second = new AuthoringService(secondStore)
    expect(second.getSnapshot()).toEqual(created.snapshot)
    expect(second.getPersona(created.persona.id)).toEqual(created.persona)
    const updated = second.updatePrompt('main', '始终保持唯一身份。{{当前时间}} / {{人格名称}}', 0)
    close(secondStore)
    expect(new AuthoringService(open()).getSnapshot()).toEqual(updated)
  })

  it('returns deeply independent snapshots, persona details and mutation results', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    const created = service.createPersona('真实人格', '人格原文')
    const before = service.getSnapshot()
    const raw = stored(store)
    const mutable = created.snapshot as unknown as { prompts: Array<{ body: string }>; personas: Array<{ name: string }>; variables: Array<{ name: string; scopes: string[] }> }
    mutable.prompts[0]!.body = 'tampered'
    mutable.personas[0]!.name = 'tampered'
    mutable.variables[0]!.name = 'tampered'
    mutable.variables[0]!.scopes.push('tampered')
    ;(created.persona as { body: string }).body = 'tampered'
    const detail = service.getPersona(created.persona.id) as { name: string }
    detail.name = 'tampered'
    expect(service.getSnapshot()).toEqual(before)
    expect(service.getPersona(created.persona.id)).toMatchObject({ name: '真实人格', body: '人格原文' })
    expect(stored(store)).toBe(raw)
    const nextVariables: readonly TemplateVariable[] = service.getSnapshot().variables
    expect(nextVariables[0]!.name).toBe('当前时间')
  })
})

describe('AuthoringService template and size validation', () => {
  it.each(['', ' \n\t', '{{不存在}}', '{{当前时间', '{{外层{{当前时间}}}}', '{{消息内容}}'])('never persists an invalid main/persona body: %s', body => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    failure(() => service.updatePrompt('main', body, 0), 'INVALID_TEMPLATE')
    failure(() => service.createPersona('名称', body), 'INVALID_TEMPLATE')
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
    const created = service.createPersona('名称', '原正文')
    const before = stored(store)
    failure(() => service.updatePersona(created.persona.id, '名称', body, 1), 'INVALID_TEMPLATE')
    expect(stored(store)).toBe(before)
    expect(service.getPersona(created.persona.id).body).toBe('原正文')
  })

  it('bounds UTF16 bodies and trimmed names with fixed errors that do not echo content', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    const secret = 'private-owner-content-'.repeat(3000)
    const error = failure(() => service.updatePrompt('main', secret, 0), 'INVALID_TEMPLATE')
    expect(error.message).not.toContain('private-owner-content')
    expect(error.message).toContain('50000')
    for (const name of ['', '  ', '名'.repeat(81)]) failure(() => service.createPersona(name, '正文'), 'INVALID_PERSONA_NAME')
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
    const created = service.createPersona(` ${'名'.repeat(80)} `, '🐟'.repeat(25_000))
    expect(created.persona.body.length).toBe(50_000)
    const saved = stored(store)
    failure(() => service.updatePersona(created.persona.id, '名字', '🐟'.repeat(25_001), 1), 'INVALID_TEMPLATE')
    failure(() => service.updatePersona(created.persona.id, '名'.repeat(81), '正文', 1), 'INVALID_PERSONA_NAME')
    expect(stored(store)).toBe(saved)
  })

  it('rejects persona self-body references and prototype variables without saving', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    for (const body of ['{{人格正文}}', '{{__proto__}}', '{{constructor}}']) failure(() => service.createPersona('名称', body), 'INVALID_TEMPLATE')
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
  })

  it('allows 100 personas, rejects a 101st atomically, and bounds the one-setting JSON byte size', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    for (let index = 0; index < 100; index += 1) service.createPersona(`人格${index}`, 'a')
    const before = stored(store)
    failure(() => service.createPersona('第101个', '正文'), 'PERSONA_LIMIT_REACHED')
    expect(stored(store)).toBe(before)
    expect(service.getSnapshot().personas).toHaveLength(100)
    const ids = service.getSnapshot().personas.map(persona => persona.id)
    let capacityReached = false
    for (const id of ids) {
      const current = service.getPersona(id)
      const saved = stored(store)
      try { service.updatePersona(id, current.name, '字'.repeat(50_000), current.revision) }
      catch (error) {
        expect(error).toMatchObject({ code: 'AUTHORING_CAPACITY_EXCEEDED', statusCode: 400 })
        expect(stored(store)).toBe(saved)
        capacityReached = true
        break
      }
    }
    expect(capacityReached).toBe(true)
    expect(Buffer.byteLength(stored(store), 'utf8')).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
})

describe('AuthoringService revision and active-persona invariants', () => {
  it('uses independent per-prompt CAS and leaves unchanged saves at the same global and document revision', () => {
    const store = fixture().open()
    const first = new AuthoringService(store)
    const second = new AuthoringService(store)
    const main = first.updatePrompt('main', '主策略 {{当前时间}}', 0)
    expect(main.revision).toBe(1)
    const group = second.updatePrompt('group', '群策略 {{消息列表}}', 0)
    expect(group.revision).toBe(2)
    expect(group.prompts.map(prompt => prompt.revision)).toEqual([1, 1, 0])
    const saved = stored(store)
    failure(() => first.updatePrompt('main', '过期写入', 0), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => first.updatePrompt('main', '过期写入', Number.NaN), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => first.updatePrompt('unknown' as 'main', '正文', 0), 'PROMPT_NOT_FOUND', 404)
    expect(first.updatePrompt('main', '主策略 {{当前时间}}', 1)).toEqual(group)
    expect(stored(store)).toBe(saved)
    const updated = first.updatePrompt('main', '新主策略', 1)
    expect(updated.revision).toBe(3)
    expect(updated.prompts.find(prompt => prompt.id === 'main')).toMatchObject({ revision: 2, updatedAt: expect.any(String) })
  })

  it('uses per-persona CAS for update/delete independently of another persona and global revisions', () => {
    const store = fixture().open()
    const first = new AuthoringService(store)
    const second = new AuthoringService(store)
    const a = first.createPersona('甲', '甲正文').persona
    const b = first.createPersona('乙', '乙正文').persona
    const a2 = second.updatePersona(a.id, '甲新名', '甲新文', 1)
    const b2 = first.updatePersona(b.id, '乙新名', '乙新文', 1)
    expect(a2.snapshot.revision).toBe(3)
    expect(b2.snapshot.revision).toBe(4)
    expect(a2.persona.revision).toBe(2)
    expect(a2.persona.createdAt).toBe(a.createdAt)
    const saved = stored(store)
    failure(() => first.updatePersona(a.id, '过期', '过期', 1), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => second.deletePersona(a.id, 1), 'AUTHORING_REVISION_CONFLICT', 409)
    expect(stored(store)).toBe(saved)
    expect(first.updatePersona(a.id, ' 甲新名 ', '甲新文', 2).snapshot).toEqual(b2.snapshot)
    expect(stored(store)).toBe(saved)
    expect(second.deletePersona(a.id, 2)).toMatchObject({ revision: 5, personas: [expect.objectContaining({ id: b.id, revision: 2 })] })
    failure(() => first.getPersona(a.id), 'PERSONA_NOT_FOUND', 404)
    failure(() => first.updatePersona('missing', '名', '正文', 0), 'PERSONA_NOT_FOUND', 404)
    failure(() => first.deletePersona('missing', 0), 'PERSONA_NOT_FOUND', 404)
  })

  it('resolves concurrent switches with global CAS, keeps one active, and checks stale versions before idempotent disable', async () => {
    const store = fixture().open()
    const first = new AuthoringService(store)
    const second = new AuthoringService(store)
    const a = first.createPersona('甲', '甲正文').persona
    const b = first.createPersona('乙', '乙正文').persona
    const expectedRevision = first.getSnapshot().revision
    const results = await Promise.allSettled([
      Promise.resolve().then(() => first.setPersonaEnabled(a.id, true, expectedRevision)),
      Promise.resolve().then(() => second.setPersonaEnabled(b.id, true, expectedRevision)),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'AUTHORING_REVISION_CONFLICT', statusCode: 409 })
    const selected = first.getSnapshot()
    expect(selected).toMatchObject({ revision: 3, activePersonaId: a.id })
    expect(selected.personas.map(persona => persona.revision)).toEqual([1, 1])
    const switched = second.setPersonaEnabled(b.id, true, selected.revision)
    expect(switched).toMatchObject({ revision: 4, activePersonaId: b.id })
    const saved = stored(store)
    expect(first.setPersonaEnabled(a.id, false, switched.revision)).toEqual(switched)
    expect(first.setPersonaEnabled(b.id, true, switched.revision)).toEqual(switched)
    failure(() => first.setPersonaEnabled(a.id, false, 3), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => first.setPersonaEnabled('missing', false, 3), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => first.setPersonaEnabled('missing', true, 4), 'PERSONA_NOT_FOUND', 404)
    expect(stored(store)).toBe(saved)
    expect(second.setPersonaEnabled(b.id, false, 4)).toMatchObject({ revision: 5, activePersonaId: null })
    expect(first.getPersona(a.id)).toEqual(a)
    expect(first.getPersona(b.id)).toEqual(b)
  })

  it('edits the active persona without touching other prompts, personas, settings, pending messages or action deduplication', async () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    store.setSetting('test:account-owner-configuration', '{"connected":true}')
    store.recordEvent('test-platform', 'test-authoring-pending', {}, message())
    const execute = vi.fn(async () => ({ messageId: 'test-sent' }))
    await store.executeIdempotent('test-platform', 'send', { text: 'test-action' }, 'authoring-action-001', execute)
    const a = service.createPersona('甲', '甲正文').persona
    const b = service.createPersona('乙', '乙正文').persona
    const enabled = service.setPersonaEnabled(a.id, true, 2)
    const queue = store.getQueuedHarnessEvents()
    const delivery = store.getDeliverySettingsSnapshot()
    const write = vi.spyOn(store, 'setSetting')
    const edited = service.updatePersona(a.id, '甲编辑', '新正文 {{人格名称}}', 1)
    expect(edited.snapshot.activePersonaId).toBe(a.id)
    expect(edited.snapshot.prompts).toEqual(enabled.prompts)
    expect(service.getPersona(b.id)).toEqual(b)
    expect(store.getSetting('test:account-owner-configuration')).toBe('{"connected":true}')
    expect(store.getQueuedHarnessEvents()).toEqual(queue)
    expect(store.getDeliverySettingsSnapshot()).toEqual(delivery)
    expect(write.mock.calls.map(([key]) => key)).toEqual([AUTHORING_SETTING_KEY])
    await store.executeIdempotent('test-platform', 'send', { text: 'test-action' }, 'authoring-action-001', execute)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('protects active deletion until switched or stopped and removes no other persona', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    const a = service.createPersona('甲', '甲正文').persona
    const b = service.createPersona('乙', '乙正文').persona
    service.setPersonaEnabled(a.id, true, 2)
    const before = stored(store)
    failure(() => service.deletePersona(a.id, 1), 'ACTIVE_PERSONA', 409)
    expect(stored(store)).toBe(before)
    service.setPersonaEnabled(b.id, true, 3)
    expect(service.deletePersona(a.id, 1)).toMatchObject({ revision: 5, activePersonaId: b.id })
    service.setPersonaEnabled(b.id, false, 5)
    expect(service.deletePersona(b.id, 1)).toMatchObject({ revision: 7, activePersonaId: null, personas: [] })
  })
})

describe('AuthoringService corruption and failed writes', () => {
  it.each(['{invalid-json', 'null', '[]', '{"schemaVersion":2}', 'x'.repeat(5 * 1024 * 1024 + 1)])('rejects malformed or oversized storage without constructor failure or replacement (%#)', saved => {
    const store = fixture().open()
    store.setSetting(AUTHORING_SETTING_KEY, saved)
    const write = vi.spyOn(store, 'setSetting')
    const service = new AuthoringService(store)
    failure(() => service.getSnapshot(), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.getPersona('missing'), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.updatePrompt('main', '新正文', 0), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.createPersona('新人格', '新正文'), 'AUTHORING_STORAGE_CORRUPTED', 500)
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBe(saved)
    expect(store.getDeliverySettingsSnapshot().values.storageMode).toBe('persistent')
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['negative-revision', 'unknown-field', 'invalid-body', 'missing-prompt', 'duplicate-prompt', 'bad-persona-name', 'duplicate-persona', 'unknown-active', 'invalid-timestamp', 'prototype-key'] as const)('validates full schema and refuses all writes after %s corruption', kind => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    const created = service.createPersona('原人格', '原正文')
    const value = parseStored(store)
    const prompts = value.prompts as Array<Record<string, unknown>>
    const personas = value.personas as Array<Record<string, unknown>>
    if (kind === 'negative-revision') value.revision = -1
    if (kind === 'unknown-field') value.ownerHistory = []
    if (kind === 'invalid-body') prompts[0]!.body = '{{不存在}}'
    if (kind === 'missing-prompt') prompts.pop()
    if (kind === 'duplicate-prompt') prompts[1]!.id = prompts[0]!.id
    if (kind === 'bad-persona-name') personas[0]!.name = ' '
    if (kind === 'duplicate-persona') personas.push({ ...personas[0] })
    if (kind === 'unknown-active') value.activePersonaId = 'missing'
    if (kind === 'invalid-timestamp') personas[0]!.createdAt = 'not-a-date'
    const saved = kind === 'prototype-key' ? stored(store).replace('"schemaVersion":1', '"__proto__":{},"schemaVersion":1') : JSON.stringify(value)
    store.setSetting(AUTHORING_SETTING_KEY, saved)
    const write = vi.spyOn(store, 'setSetting')
    failure(() => service.getSnapshot(), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.updatePersona(created.persona.id, '新名', '正文', 1), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.setPersonaEnabled(created.persona.id, true, 1), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.deletePersona(created.persona.id, 1), 'AUTHORING_STORAGE_CORRUPTED', 500)
    expect(write).not.toHaveBeenCalled()
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBe(saved)
  })

  it('keeps the previous document after an atomic setting write fails and succeeds on a later retry', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    const a = service.createPersona('甲', '甲正文').persona
    const b = service.createPersona('乙', '乙正文').persona
    const active = service.setPersonaEnabled(a.id, true, 2)
    const before = stored(store)
    const write = vi.spyOn(store, 'setSetting').mockImplementationOnce(() => { throw new Error('Test SQLite write failure') })
    expect(() => service.setPersonaEnabled(b.id, true, active.revision)).toThrow('Test SQLite write failure')
    expect(stored(store)).toBe(before)
    expect(service.getSnapshot()).toEqual(active)
    write.mockRestore()
    expect(service.setPersonaEnabled(b.id, true, active.revision)).toMatchObject({ revision: 4, activePersonaId: b.id })
    expect(service.getPersona(a.id)).toEqual(a)
  })

  it('rejects invalid runtime enabled types without coercion', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    const created = service.createPersona('人格', '正文')
    const saved = stored(store)
    failure(() => service.setPersonaEnabled(created.persona.id, 'false' as unknown as boolean, 1), 'INVALID_PERSONA_STATE')
    expect(stored(store)).toBe(saved)
  })
})
