import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError, analyzeTemplate, composeAgentPrompt, getPromptTemplateScope } from '@eating/plugin-sdk'
import type { HarnessEvent, RegisteredAgentInstructions, RegisteredAgentType, TemplateVariable } from '@eating/plugin-sdk'
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
    expect(snapshot.variables).toHaveLength(14)
    expect(snapshot.prompts.map(prompt => prompt.id)).toEqual(['common', 'subagent', 'main'])
    const mainRole = snapshot.prompts.find(prompt => prompt.id === 'main')!
    expect(mainRole.body).toContain('eating_list_agent_types')
    expect(mainRole.body).toContain('eating_delegate_task')
    expect(mainRole.body).toContain('由对应子代理')
    expect(snapshot).not.toHaveProperty('legacyPrompts')
    for (const prompt of snapshot.prompts) {
      expect(prompt).toMatchObject({ revision: 0, updatedAt: null })
      expect(prompt.body.trim().length).toBeGreaterThan(100)
      expect(analyzeTemplate(prompt.body, getPromptTemplateScope(prompt.id)!).valid).toBe(true)
    }
    const main = snapshot.prompts.find(prompt => prompt.id === 'common')!
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
    expect(parseStored(firstStore)).toMatchObject({ schemaVersion: 2, revision: 1 })
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
    const main = first.updatePrompt('common', '主策略 {{当前时间}}', 0)
    expect(main.revision).toBe(1)
    const group = second.updatePrompt('subagent', '群策略 {{主人}}', 0)
    expect(group.revision).toBe(2)
    expect(group.prompts.map(prompt => prompt.revision)).toEqual([1, 1, 0])
    const saved = stored(store)
    failure(() => first.updatePrompt('common', '过期写入', 0), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => first.updatePrompt('common', '过期写入', Number.NaN), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => first.updatePrompt('unknown' as 'common', '正文', 0), 'PROMPT_NOT_FOUND', 404)
    expect(first.updatePrompt('common', '主策略 {{当前时间}}', 1)).toEqual(group)
    expect(stored(store)).toBe(saved)
    const updated = first.updatePrompt('common', '新主策略', 1)
    expect(updated.revision).toBe(3)
    expect(updated.prompts.find(prompt => prompt.id === 'common')).toMatchObject({ revision: 2, updatedAt: expect.any(String) })
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
    const saved = kind === 'prototype-key' ? stored(store).replace('"schemaVersion":2', '"__proto__":{},"schemaVersion":2') : JSON.stringify(value)
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


function legacyDocument() {
  const time = '2026-10-27T12:00:00.000Z'
  const persona = { id: '12345678-1234-4123-8123-123456789abc', name: '原人格 🐟', body: '旧人格\r\n{{当前时间}} {{人格名称}} 末尾  ', revision: 3, createdAt: time, updatedAt: time }
  return { schemaVersion: 1, revision: 9, prompts: [
    { id: 'main', title: ' 原通用标题 ', body: ' 主人原策略\r\n{{当前时间}} {{人格名称}} 🐟 \u0000  ', revision: 4, updatedAt: time },
    { id: 'group', title: '原群输入', body: ' 原群输入\r\n{{消息列表}}\n正文：{{消息内容}}\n{{发送者列表}} 🐟  ', revision: 6, updatedAt: time },
    { id: 'private', title: '原私聊输入', body: ' 原私输入\r\n{{消息内容}}\n{{消息列表}} {{平台}} {{机器人账号}} {{会话编号}} {{会话类型}} {{消息数量}} {{批次编号}}  ', revision: 7, updatedAt: time },
  ], personas: [persona], activePersonaId: persona.id }
}
function role(id = 'qq.private', kind: 'private' | 'group' = 'private'): RegisteredAgentType {
  return { id, title: kind === 'private' ? 'QQ 私聊' : 'QQ 群聊', description: '通讯执行者', conversationKind: kind, defaultPrompt: `类型 ${id} {{主人}} {{管理员}} {{目标编号}}`,
    availableTools: ['qq.send'], defaultTools: ['qq.send'], enabledTools: ['qq.send'], pluginId: 'qq', pluginName: 'QQ', enabled: true, identity: { owners: ['100', '200'], administrators: ['300'] } }
}
function instruction(): RegisteredAgentInstructions {
  return { id: 'qq.instructions', title: 'QQ 使用说明', body: 'QQ 工具说明 {{主人}}', pluginId: 'qq', pluginName: 'QQ', enabled: true }
}

describe('AuthoringService lossless v1 migration', () => {
  it('migrates entirely in memory, preserves original prompt/persona characters and revisions, and never marks the old setting dirty on reads', () => {
    const store = fixture().open()
    const old = legacyDocument()
    const raw = JSON.stringify(old, null, 2) + '\n'
    store.setSetting(AUTHORING_SETTING_KEY, raw)
    const write = vi.spyOn(store, 'setSetting')
    const service = new AuthoringService(store)
    const snapshot = service.getSnapshot()
    expect(snapshot).toMatchObject({ revision: 9, activePersonaId: old.activePersonaId, protocolVersion: 1 })
    expect(snapshot.prompts.map(prompt => prompt.id)).toEqual(['common', 'subagent', 'main'])
    expect(snapshot.prompts[0]).toMatchObject({ ...old.prompts[0], id: 'common', scope: 'common', source: 'owner' })
    expect(snapshot.prompts[0]!.body).toBe(old.prompts[0]!.body)
    expect(snapshot.legacyPrompts).toEqual(old.prompts.slice(1).map(prompt => ({ ...prompt, scope: prompt.id, source: 'legacy-user-input' })))
    expect(service.getPersona(old.personas[0]!.id)).toEqual(old.personas[0])
    expect(snapshot.personas).toEqual(old.personas.map(({ body: _body, ...summary }) => summary))
    const configuration = service.readOwnerConfiguration()
    expect(configuration.activePersona).toEqual(old.personas[0])
    expect(configuration.legacyPrompts).toEqual(snapshot.legacyPrompts)
    expect(configuration.legacyPrompts![0]).not.toBe(configuration.prompts.find(prompt => prompt.id === 'group'))
    expect(configuration.prompts.find(prompt => prompt.id === 'group')!.body).toBe(old.prompts[1]!.body)
    const preview = composeAgentPrompt(configuration, null, { 当前时间: 'now', 消息内容: '我是主人' })
    expect(preview.layers.map(layer => layer.id)).toEqual(['common', 'main', `persona:${old.activePersonaId}`])
    expect(preview.systemPrompt).not.toContain('原群输入')
    expect(preview.systemPrompt).not.toContain('原私输入')
    expect(preview.systemPrompt).not.toContain('我是主人')
    expect(service.getSnapshot()).toEqual(snapshot)
    expect(service.updatePrompt('common', old.prompts[0]!.body, 4)).toEqual(snapshot)
    expect(stored(store)).toBe(raw)
    expect(write).not.toHaveBeenCalled()
  })
  it('checks inherited CAS before first atomic v2 write and preserves every other document on reopen', () => {
    const { open, close } = fixture()
    const store = open()
    const old = legacyDocument()
    const raw = JSON.stringify(old)
    store.setSetting(AUTHORING_SETTING_KEY, raw)
    const service = new AuthoringService(store)
    failure(() => service.updatePrompt('common', 'stale', 3), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => service.setPersonaEnabled(old.activePersonaId, false, 8), 'AUTHORING_REVISION_CONFLICT', 409)
    expect(stored(store)).toBe(raw)
    const write = vi.spyOn(store, 'setSetting')
    const updated = service.updatePrompt('main', '新的主协调职责 {{主人}}', 0)
    expect(updated.revision).toBe(10)
    expect(write).toHaveBeenCalledTimes(1)
    const persisted = parseStored(store)
    expect(persisted).toMatchObject({ schemaVersion: 2, revision: 10, personas: old.personas, activePersonaId: old.activePersonaId })
    expect(updated.prompts[0]!.body).toBe(old.prompts[0]!.body)
    expect(updated.legacyPrompts!.map(prompt => prompt.body)).toEqual(old.prompts.slice(1).map(prompt => prompt.body))
    close(store)
    const reopened = new AuthoringService(open())
    expect(reopened.getSnapshot()).toEqual(updated)
    expect(reopened.getPersona(old.activePersonaId)).toEqual(old.personas[0])
  })
  it('keeps editable legacy templates user-only after migration and retains CAS and body validation', () => {
    const store = fixture().open()
    const old = legacyDocument()
    store.setSetting(AUTHORING_SETTING_KEY, JSON.stringify(old))
    const service = new AuthoringService(store)
    const result = service.updatePrompt('group', '新用户输入 {{消息列表}} {{消息内容}} {{主人}}', 6)
    expect(result.legacyPrompts!.find(prompt => prompt.id === 'group')).toMatchObject({ revision: 7, source: 'legacy-user-input', scope: 'group', body: '新用户输入 {{消息列表}} {{消息内容}} {{主人}}' })
    expect(result.prompts[0]!.body).toBe(old.prompts[0]!.body)
    failure(() => service.updatePrompt('group', '过期输入', 6), 'AUTHORING_REVISION_CONFLICT', 409)
    failure(() => service.updatePrompt('private', '{{不存在}}', 7), 'INVALID_TEMPLATE')
    const saved = stored(store)
    expect(service.getSnapshot()).toEqual(result)
    expect(stored(store)).toBe(saved)
  })
  it.each(['missing', 'duplicate', 'main-external', 'persona-external', 'unknown-key', 'new-v1-variable'] as const)('rejects corrupt old %s data without overwriting any byte', kind => {
    const store = fixture().open()
    const old = legacyDocument()
    if (kind === 'missing') old.prompts.pop()
    if (kind === 'duplicate') old.prompts[1]!.id = 'main'
    if (kind === 'main-external') old.prompts[0]!.body = '{{消息内容}}'
    if (kind === 'persona-external') old.personas[0]!.body = '{{平台}}'
    if (kind === 'new-v1-variable') old.prompts[0]!.body = '{{主人}}'
    const raw = JSON.stringify(kind === 'unknown-key' ? { ...old, extra: true } : old)
    store.setSetting(AUTHORING_SETTING_KEY, raw)
    const write = vi.spyOn(store, 'setSetting')
    const service = new AuthoringService(store)
    failure(() => service.getSnapshot(), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.updatePrompt('main', '正文', 0), 'AUTHORING_STORAGE_CORRUPTED', 500)
    expect(write).not.toHaveBeenCalled()
    expect(stored(store)).toBe(raw)
  })
})

describe('AuthoringService plugin prompt lifecycle and trusted configuration', () => {
  it('builds three base documents plus two roles and instructions, without synthesizing legacy templates or persisting plugin defaults', () => {
    const store = fixture().open()
    const contribution = { agentTypes: [role(), role('qq.group', 'group')], pluginInstructions: [instruction()], bindings: { 主人: '["qq:100","qq:200"]', 管理员: '["qq:300"]' } }
    const service = new AuthoringService(store, () => contribution)
    const snapshot = service.getSnapshot()
    expect(snapshot.prompts.map(prompt => prompt.id)).toEqual(['common', 'subagent', 'main', 'agent:qq.private', 'agent:qq.group', 'plugin:qq.instructions'])
    expect(snapshot).not.toHaveProperty('legacyPrompts')
    expect(snapshot.prompts[3]).toMatchObject({ scope: 'agent', source: 'plugin', pluginId: 'qq', agentTypeId: 'qq.private', available: true, enabled: true, defaultBody: role().defaultPrompt, revision: 0 })
    failure(() => service.updatePrompt('group', '不能捏造旧模板', 0), 'PROMPT_NOT_FOUND', 404)
    failure(() => service.updatePrompt('agent:unknown.private', '未知类型', 0), 'PROMPT_NOT_FOUND', 404)
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
    service.createPersona('人', '人格')
    expect((parseStored(store).prompts as unknown[])).toHaveLength(3)
  })
  it('refreshes unedited plugin defaults across upgrades, while preserving explicit owner overrides and independent CAS', () => {
    const store = fixture().open()
    let contribution = { agentTypes: [role(), role('qq.group', 'group')], pluginInstructions: [instruction()] }
    const service = new AuthoringService(store, () => contribution)
    service.updatePrompt('agent:qq.private', '主人私聊修改 {{主人}}', 0)
    service.updatePrompt('plugin:qq.instructions', '主人插件说明', 0)
    service.updatePrompt('common', '主人通用修改 {{当前时间}}', 0)
    const raw = stored(store)
    contribution = { agentTypes: contribution.agentTypes.map(item => ({ ...item, defaultPrompt: `升级默认 ${item.id}`, title: '升级标题' })), pluginInstructions: [{ ...instruction(), body: '升级插件说明' }] }
    const snapshot = service.getSnapshot()
    expect(stored(store)).toBe(raw)
    expect(snapshot.prompts.find(prompt => prompt.id === 'agent:qq.private')).toMatchObject({ body: '主人私聊修改 {{主人}}', defaultBody: '升级默认 qq.private', revision: 1, title: '升级标题' })
    expect(snapshot.prompts.find(prompt => prompt.id === 'agent:qq.group')).toMatchObject({ body: '升级默认 qq.group', defaultBody: '升级默认 qq.group', revision: 0 })
    expect(snapshot.prompts.find(prompt => prompt.id === 'plugin:qq.instructions')).toMatchObject({ body: '主人插件说明', defaultBody: '升级插件说明', revision: 1 })
    failure(() => service.updatePrompt('agent:qq.private', '过期角色修改', 0), 'AUTHORING_REVISION_CONFLICT', 409)
    expect(stored(store)).toBe(raw)
    service.updatePrompt('agent:qq.group', '主人群聊修改', 0)
    expect(service.getSnapshot().prompts.find(prompt => prompt.id === 'agent:qq.private')!.body).toBe('主人私聊修改 {{主人}}')
  })
  it('revokes disabled execution, preserves overrides across uninstall and unrelated saves, and restores the same stable IDs on reinstall', () => {
    const { open, close } = fixture()
    const store = open()
    let contribution: { agentTypes: RegisteredAgentType[]; pluginInstructions: RegisteredAgentInstructions[] } = { agentTypes: [role()], pluginInstructions: [instruction()] }
    const service = new AuthoringService(store, () => contribution)
    service.updatePrompt('agent:qq.private', '原主人角色覆盖', 0)
    service.updatePrompt('plugin:qq.instructions', '原主人说明覆盖', 0)
    contribution = { agentTypes: [{ ...role(), enabled: false }], pluginInstructions: [{ ...instruction(), enabled: false }] }
    expect(service.getSnapshot().prompts.find(prompt => prompt.id === 'agent:qq.private')).toMatchObject({ body: '原主人角色覆盖', enabled: false, available: true })
    failure(() => composeAgentPrompt(service.readOwnerConfiguration(), 'qq.private', { 当前时间: 'now' }), 'AGENT_TYPE_UNAVAILABLE', 409)
    expect(composeAgentPrompt(service.readOwnerConfiguration(), null, { 当前时间: 'now' }).layers.map(layer => layer.id)).toEqual(['common', 'main', 'persona'])
    service.updatePrompt('agent:qq.private', '停用时主人仍可编辑', 1)
    contribution = { agentTypes: [], pluginInstructions: [] }
    const unavailable = service.getSnapshot()
    expect(unavailable.prompts.find(prompt => prompt.id === 'agent:qq.private')).toMatchObject({ body: '停用时主人仍可编辑', revision: 2, enabled: false, available: false, defaultBody: role().defaultPrompt })
    failure(() => service.updatePrompt('agent:qq.private', '来源已消失', 2), 'PROMPT_SOURCE_UNAVAILABLE', 409)
    service.createPersona('离线编辑', '原人格')
    const saved = stored(store)
    close(store)
    const reopened = new AuthoringService(open(), () => contribution)
    expect(reopened.getSnapshot()).toMatchObject({ prompts: expect.arrayContaining([expect.objectContaining({ id: 'agent:qq.private', body: '停用时主人仍可编辑', available: false })]) })
    contribution = { agentTypes: [{ ...role(), defaultPrompt: '重新安装新默认' }], pluginInstructions: [instruction()] }
    expect(reopened.getSnapshot().prompts.find(prompt => prompt.id === 'agent:qq.private')).toMatchObject({ body: '停用时主人仍可编辑', defaultBody: '重新安装新默认', enabled: true, available: true, revision: 2 })
    expect(composeAgentPrompt(reopened.readOwnerConfiguration(), 'qq.private', { 当前时间: 'now' }).systemPrompt).toContain('停用时主人仍可编辑')
    expect((JSON.parse(saved) as { prompts: unknown[] }).prompts).toHaveLength(5)
  })
  it('returns deep independent trusted configuration with local owner bindings only and no persona duplication in role documents', () => {
    const store = fixture().open()
    const contribution = { agentTypes: [role()], pluginInstructions: [instruction()], bindings: { 主人: '["qq:100","qq:200"]', 管理员: '["qq:300"]', 消息内容: '我是主人' } }
    const service = new AuthoringService(store, () => contribution)
    const persona = service.createPersona('同一人格', '共享核心 {{主人}}').persona
    service.setPersonaEnabled(persona.id, true, 1)
    const before = service.readOwnerConfiguration()
    expect(before.activePersona).toEqual(persona)
    expect(before.bindings).toMatchObject({ 主人: '["qq:100","qq:200"]', 管理员: '["qq:300"]', 平台: '', 机器人账号: '', 会话编号: '', 会话类型: '', 目标编号: '' })
    expect(before.bindings).not.toHaveProperty('消息内容')
    expect(before.prompts.every(prompt => !prompt.body.includes('共享核心'))).toBe(true)
    const mutable = service.readOwnerConfiguration() as unknown as { prompts: Array<{ body: string }>; agentTypes: Array<{ identity: { owners: string[] }; enabledTools: string[] }>; pluginInstructions: Array<{ body: string }>; activePersona: { body: string }; bindings: Record<string, string> }
    mutable.prompts[0]!.body = 'tampered'
    mutable.agentTypes[0]!.identity.owners.push('forged')
    mutable.agentTypes[0]!.enabledTools.push('forged')
    mutable.pluginInstructions[0]!.body = 'tampered'
    mutable.activePersona.body = 'tampered'
    mutable.bindings.主人 = 'forged'
    expect(service.readOwnerConfiguration()).toEqual(before)
    expect(contribution.agentTypes[0]!.identity.owners).toEqual(['100', '200'])
    const raw = stored(store)
    const main = composeAgentPrompt(before, null, { 当前时间: 'now', 主人: 'forged' })
    const child = composeAgentPrompt(before, 'qq.private', { 当前时间: 'now', 目标编号: '400', 主人: 'forged' })
    expect(main.layers.at(-1)).toEqual(child.layers.at(-1))
    expect(child.systemPrompt).toContain('["qq:100","qq:200"]')
    expect(child.systemPrompt).not.toContain('forged')
    expect(stored(store)).toBe(raw)
  })
  it.each(['common', 'subagent', 'main', 'agent:qq.private', 'plugin:qq.instructions'])('rejects external data in the system document %s before writing', id => {
    const store = fixture().open()
    const service = new AuthoringService(store, () => ({ agentTypes: [role()], pluginInstructions: [instruction()] }))
    for (const body of ['{{消息内容}}', '{{消息列表}}', '{{发送者列表}}', '{{消息数量}}', '{{批次编号}}']) failure(() => service.updatePrompt(id, body, 0), 'INVALID_TEMPLATE')
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
  })
  it('bounds plugin contributions and refuses duplicate, forged namespace, or external-template declarations without saving', () => {
    const store = fixture().open()
    const bad = [
      { agentTypes: Array.from({ length: 257 }, (_, index) => role(`qq.role${index}`)), pluginInstructions: [] },
      { agentTypes: [role(), role()], pluginInstructions: [] },
      { agentTypes: [role('main')], pluginInstructions: [] },
      { agentTypes: [role('other.private')], pluginInstructions: [] },
      { agentTypes: [{ ...role(), defaultPrompt: '{{消息内容}}' }], pluginInstructions: [] },
      { agentTypes: [], pluginInstructions: [{ ...instruction(), body: '{{消息列表}}' }] },
    ]
    for (const contribution of bad) {
      const service = new AuthoringService(store, () => contribution)
      failure(() => service.getSnapshot(), 'INVALID_AGENT_CONTRIBUTION', 500)
      failure(() => service.createPersona('人', '人格'), 'INVALID_AGENT_CONTRIBUTION', 500)
    }
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
  })
})



describe('AuthoringService v2 metadata integrity', () => {
  it.each(['source', 'scope', 'plugin-id', 'role-id', 'default-body', 'unknown-field'] as const)('refuses corrupt plugin %s metadata without replacing the saved setting', kind => {
    const store = fixture().open()
    const service = new AuthoringService(store, () => ({ agentTypes: [role()], pluginInstructions: [instruction()] }))
    service.updatePrompt('agent:qq.private', '主人覆盖', 0)
    const data = parseStored(store)
    const document = (data.prompts as Array<Record<string, unknown>>).find(prompt => prompt.id === 'agent:qq.private')!
    if (kind === 'source') document.source = 'owner'
    if (kind === 'scope') document.scope = 'group'
    if (kind === 'plugin-id') document.pluginId = 'other'
    if (kind === 'role-id') document.agentTypeId = 'qq.group'
    if (kind === 'default-body') document.defaultBody = '{{消息内容}}'
    if (kind === 'unknown-field') document.untrustedOwner = true
    const raw = JSON.stringify(data)
    store.setSetting(AUTHORING_SETTING_KEY, raw)
    const write = vi.spyOn(store, 'setSetting')
    failure(() => service.readOwnerConfiguration(), 'AUTHORING_STORAGE_CORRUPTED', 500)
    failure(() => service.updatePrompt('common', '正常正文', 0), 'AUTHORING_STORAGE_CORRUPTED', 500)
    expect(write).not.toHaveBeenCalled()
    expect(stored(store)).toBe(raw)
  })
  it('checks persona and prompt exhaustion without persisting a partially incremented document', () => {
    const store = fixture().open()
    const service = new AuthoringService(store)
    service.createPersona('原人格', '原正文')
    const data = parseStored(store)
    data.revision = Number.MAX_SAFE_INTEGER
    const prompts = data.prompts as Array<Record<string, unknown>>
    prompts[0]!.revision = Number.MAX_SAFE_INTEGER
    prompts[0]!.updatedAt = '2026-10-27T12:00:00.000Z'
    const raw = JSON.stringify(data)
    store.setSetting(AUTHORING_SETTING_KEY, raw)
    const write = vi.spyOn(store, 'setSetting')
    failure(() => service.updatePrompt('common', '新正文', Number.MAX_SAFE_INTEGER), 'AUTHORING_REVISION_EXHAUSTED', 500)
    failure(() => service.updatePrompt('main', '新正文', 0), 'AUTHORING_REVISION_EXHAUSTED', 500)
    failure(() => service.createPersona('新人格', '新正文'), 'AUTHORING_REVISION_EXHAUSTED', 500)
    expect(write).not.toHaveBeenCalled()
    expect(stored(store)).toBe(raw)
  })
  it('preserves the original v1 JSON when its first v2 write fails and can retry the same inherited CAS', () => {
    const store = fixture().open()
    const old = legacyDocument()
    const raw = JSON.stringify(old, null, 2)
    store.setSetting(AUTHORING_SETTING_KEY, raw)
    const service = new AuthoringService(store)
    const write = vi.spyOn(store, 'setSetting').mockImplementationOnce(() => { throw new Error('Test SQLite migration write failure') })
    expect(() => service.updatePrompt('common', '新通用正文', 4)).toThrow('Test SQLite migration write failure')
    expect(stored(store)).toBe(raw)
    expect(service.getSnapshot().prompts[0]!.revision).toBe(4)
    write.mockRestore()
    expect(service.updatePrompt('common', '新通用正文', 4)).toMatchObject({ revision: 10, legacyPrompts: expect.any(Array) })
    expect(parseStored(store).schemaVersion).toBe(2)
    expect(service.getPersona(old.activePersonaId)).toEqual(old.personas[0])
  })
})


describe('AuthoringService localized source titles', () => {
  it('clones registered titles into snapshots and trusted configuration, keeps overrides free of presentation metadata, and refreshes display titles without changing CAS', () => {
    const store = fixture().open()
    let contribution = { agentTypes: [{ ...role(), localizedTitles: { 'zh-CN': 'QQ 私聊', en: 'QQ private messages' } }],
      pluginInstructions: [{ ...instruction(), localizedTitles: { 'zh-CN': 'QQ 使用说明', en: 'QQ instructions' } }] }
    const service = new AuthoringService(store, () => contribution)
    const initial = service.getSnapshot()
    const roleDocument = initial.prompts.find(prompt => prompt.id === 'agent:qq.private')!
    const instructionsDocument = initial.prompts.find(prompt => prompt.id === 'plugin:qq.instructions')!
    expect(roleDocument.localizedTitles).toEqual(contribution.agentTypes[0]!.localizedTitles)
    expect(instructionsDocument.localizedTitles).toEqual(contribution.pluginInstructions[0]!.localizedTitles)
    expect(roleDocument.localizedTitles).not.toBe(contribution.agentTypes[0]!.localizedTitles)
    ;(roleDocument.localizedTitles as Record<string, string>).en = 'tampered'
    ;(instructionsDocument.localizedTitles as Record<string, string>).en = 'tampered'
    expect(service.getSnapshot().prompts.find(prompt => prompt.id === 'agent:qq.private')!.localizedTitles!.en).toBe('QQ private messages')
    expect(service.getSnapshot().prompts.find(prompt => prompt.id === 'plugin:qq.instructions')!.localizedTitles!.en).toBe('QQ instructions')
    const configuration = service.readOwnerConfiguration()
    ;(configuration.prompts.find(prompt => prompt.id === 'agent:qq.private')!.localizedTitles as Record<string, string>).en = 'tampered'
    ;(configuration.agentTypes![0]!.localizedTitles as Record<string, string>).en = 'tampered'
    ;(configuration.pluginInstructions![0]!.localizedTitles as Record<string, string>).en = 'tampered'
    expect(contribution.agentTypes[0]!.localizedTitles.en).toBe('QQ private messages')
    expect(contribution.pluginInstructions[0]!.localizedTitles.en).toBe('QQ instructions')
    service.updatePrompt('agent:qq.private', '主人原角色正文', 0)
    const saved = service.updatePrompt('plugin:qq.instructions', '主人原插件正文', 0)
    const raw = stored(store)
    expect(raw).not.toContain('localizedTitles')
    expect(service.getSnapshot()).toEqual(saved)
    const write = vi.spyOn(store, 'setSetting')
    contribution = { agentTypes: [{ ...contribution.agentTypes[0]!, localizedTitles: { 'zh-CN': 'QQ 私聊新版', en: 'Updated private title' } }],
      pluginInstructions: [{ ...contribution.pluginInstructions[0]!, localizedTitles: { 'zh-CN': 'QQ 说明新版', en: 'Updated instructions title' } }] }
    const refreshed = service.getSnapshot()
    expect(refreshed.revision).toBe(saved.revision)
    expect(refreshed.prompts.find(prompt => prompt.id === 'agent:qq.private')).toMatchObject({ title: role().title, localizedTitles: contribution.agentTypes[0]!.localizedTitles, body: '主人原角色正文', revision: 1 })
    expect(refreshed.prompts.find(prompt => prompt.id === 'plugin:qq.instructions')).toMatchObject({ title: instruction().title, localizedTitles: contribution.pluginInstructions[0]!.localizedTitles, body: '主人原插件正文', revision: 1 })
    expect(stored(store)).toBe(raw)
    expect(write).not.toHaveBeenCalled()
  })
  it('accepts empty maps and the finite locale-count, locale-length and title-length boundaries', () => {
    const store = fixture().open()
    const titles = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [index === 0 ? 'abcdefgh-abcdefgh-abcdefgh-abcdefgh' : `en-X${index}`, '字'.repeat(80)]))
    const service = new AuthoringService(store, () => ({ agentTypes: [{ ...role(), localizedTitles: titles }], pluginInstructions: [{ ...instruction(), localizedTitles: {} }] }))
    expect(service.getSnapshot().prompts.find(prompt => prompt.id === 'agent:qq.private')!.localizedTitles).toEqual(titles)
    expect(service.getSnapshot().prompts.find(prompt => prompt.id === 'plugin:qq.instructions')!.localizedTitles).toEqual({})
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
  })
  it.each([
    null, [], 'English title', { '': 'missing locale' }, { en_US: 'underscore locale' },
    { 'abcdefgh-abcdefgh-abcdefgh-abcdefghx': 'too long locale' },
    { en: '' }, { en: ' \n ' }, { en: 'x'.repeat(81) }, { en: 1 },
    JSON.parse('{"__proto__":"invalid locale"}') as unknown,
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`en-X${index}`, 'title'])),
  ])('rejects invalid or unbounded localized metadata without saving (%#)', titles => {
    const store = fixture().open()
    const localizedTitles = titles as Readonly<Record<string, string>>
    for (const contribution of [
      { agentTypes: [{ ...role(), localizedTitles }], pluginInstructions: [instruction()] },
      { agentTypes: [role()], pluginInstructions: [{ ...instruction(), localizedTitles }] },
    ]) {
      const service = new AuthoringService(store, () => contribution)
      failure(() => service.getSnapshot(), 'INVALID_AGENT_CONTRIBUTION', 500)
      failure(() => service.createPersona('原名称', '原正文'), 'INVALID_AGENT_CONTRIBUTION', 500)
    }
    expect(store.getSetting(AUTHORING_SETTING_KEY)).toBeNull()
  })
})
