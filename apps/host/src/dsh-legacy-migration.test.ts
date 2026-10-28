import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { AUTHORING_SETTING_KEY } from './authoring'
import { createInstalledHost } from './installed-host'
import { installPluginPackage } from './plugin-installation'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { readModelFixtureBatch, startOpenAiFixture } from '../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const legacyPluginsDirectory = process.env.EATING_DSH_TEST_LEGACY_PLUGINS
const exec = promisify(execFile)
const stops: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of stops.splice(0).reverse()) { try { await stop() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Legacy migration cleanup failed')
})
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected structured migration data'); return value }
function latestEnvelope(request: ModelFixtureRequest) {
  for (const [index, message] of [...(request.messages ?? []).entries()].reverse()) {
    if (message.role !== 'user') continue
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(isJsonObject).filter(block => block.type === 'text').map(block => block.text).join('') : ''
    let value: unknown
    try { value = JSON.parse(text) } catch { continue }
    if (!isJsonObject(value) || !isJsonObject(value.eating) || value.eating.magic !== 'eating-harness-delivery' || !Array.isArray(value.events) || value.events.length !== 1) continue
    return { index, value, messageId: String(object(value.events[0]).messageId) }
  }
  throw new Error('Expected real legacy or current root user envelope')
}
function toolNames(request: ModelFixtureRequest) { return request.tools?.map(tool => tool.function?.name).sort() ?? [] }
function system(request: ModelFixtureRequest) { return JSON.stringify(request.messages?.filter(message => message.role === 'system')) }
async function until(test: () => boolean, label: string, diagnostics: () => unknown) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (test()) return; await new Promise<void>(accept => setTimeout(accept, 50)) }
  throw new Error(`Legacy migration timed out: ${label} ${JSON.stringify(diagnostics())}`)
}
function once(close: () => Promise<void>) {
  let closed: Promise<void> | undefined
  return () => closed ??= close()
}
async function nativeSessionIds(root: string): Promise<string[]> {
  const ids: string[] = []
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) if (session.isDirectory()) ids.push(session.name)
  }
  return ids.sort()
}
async function fingerprints(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name), name = prefix + entry.name
      if (entry.isDirectory()) await walk(path, name + '/')
      else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(path)).digest('hex')
      else throw new Error('Unexpected special file in isolated native sessions')
    }
  }
  await walk(directory, '')
  return result
}

// Both paths are explicit opt-ins. Only public plugin code is copied from the legacy installation.
describe.runIf(Boolean(runtimeDirectory && legacyPluginsDirectory))('真实旧DSH 0.2 → 原生多代理0.3迁移', () => {
  it('keeps its actual legacy root, tool history and unchanged model configuration when installed plugins are upgraded', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'Eating_dsh_legacy_')))
    stops.push(async () => {
      const target = await realpath(home)
      if (target !== home || dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith('Eating_dsh_legacy_')) throw new Error('Unsafe legacy migration cleanup')
      await rm(target, { recursive: true })
    })
    const publicFiles = ['eating-plugin.json', 'server.mjs', 'ui/index.js', 'ui/style.css'] as const
    const oldSources = join(home, 'approved-legacy-artifacts')
    for (const [id, version] of [['qq', '0.7.1'], ['dsh', '0.2.0']] as const) {
      const source = join(resolve(legacyPluginsDirectory!), id, 'versions', version)
      const target = join(oldSources, id)
      await mkdir(join(target, 'ui'), { recursive: true })
      for (const file of publicFiles) await copyFile(join(source, file), join(target, file))
      const installed = await installPluginPackage(home, target)
      expect(installed.manifest).toMatchObject({ id, version })
    }
    if (dirname(await realpath(oldSources)) !== home) throw new Error('Unsafe legacy source cleanup')
    await rm(oldSources, { recursive: true })
    await cp(join(resolve(runtimeDirectory!), 'runtime'), join(home, 'harness/dsh/runtime'), { recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: source => !source.includes('/.installer-home') })
    const onebot = await startOneBotFixture(), closeOnebot = once(() => onebot.close()); stops.push(closeOnebot)
    const selected: string[] = []
    const modelOptions = { apiKey: 'legacy-migration-model-key', nativeDelegation: false, chooseReply: (request: ModelFixtureRequest) => {
      const current = latestEnvelope(request)
      if (current.messageId === '93001') {
        if (request.messages?.slice(current.index + 1).some(message => message.role === 'tool')) return null
        selected.push('93001')
        return { target: 'private' as const, targetId: '987654321', text: '旧版主代理发送93001', requestId: 'sdk-legacy-send-93001' }
      }
      if (current.messageId === '93002') {
        selected.push('93002')
        return { target: 'private' as const, targetId: '987654321', text: '新版子代理发送93002', requestId: 'sdk-migrated-send-93002' }
      }
      throw new Error(`Unexpected migration protocol event ${current.messageId}`)
    } }
    const model = await startOpenAiFixture(modelOptions), closeModel = once(() => model.close()); stops.push(closeModel)
    let host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [] })
    stops.push(() => host.close())
    // Supply old owner input documents in this temporary database; native session records are created only by the real old plugin/SDK.
    host.store.setSetting(AUTHORING_SETTING_KEY, JSON.stringify({ schemaVersion: 1, revision: 0, prompts: [
      { id: 'main', title: '旧通用策略', body: 'LEGACY-OWNER-V1', revision: 0, updatedAt: null },
      { id: 'group', title: '旧群聊输入', body: 'LEGACY-GROUP-INPUT {{消息列表}}', revision: 0, updatedAt: null },
      { id: 'private', title: '旧私聊输入', body: 'LEGACY-PRIVATE-INPUT {{消息列表}}', revision: 0, updatedAt: null },
    ], personas: [], activePersonaId: null }))
    host.authoring.updatePrompt('main', 'LEGACY-MAIN-POLICY。通过真实QQ工具回复。', 0)
    const persona = host.authoring.createPersona('迁移人格', 'MIGRATION-PERSONA')
    host.authoring.setPersonaEnabled(persona.persona.id, true, persona.snapshot.revision)
    let url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap')
    let csrf = String(object(await bootstrap.json()).csrfToken), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const api = async (path: string, body: JsonObject) => {
      const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const value = object(await response.json()); if (!response.ok) throw new Error(`Migration API ${path}: ${JSON.stringify(value)}`)
      return value
    }
    const plugin = (id: string) => {
      const rows = host.getWorkspace().plugins
      if (!Array.isArray(rows)) throw new Error('Missing installed plugin catalog')
      const row = rows.map(object).find(entry => entry.id === id)
      if (!row) throw new Error(`Missing installed plugin ${id}`)
      return row
    }
    const runtime = () => object(object(plugin('dsh').configuration).runtimeStatus)
    const diagnostics = () => ({ runtime: runtime(), queue: host.harness.getStatus(), modelRequests: model.requests.length, errors: model.errors })
    const sends = () => onebot.requests.filter(request => request.action.startsWith('send_'))
    const emit = (id: number, text: string) => onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: id, message: text })
    expect(plugin('dsh').version).toBe('0.2.0')
    expect(plugin('qq').version).toBe('0.7.1')
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-model', apiKey: modelOptions.apiKey, timeoutMs: 60000, maxTokens: 1024, autoConnect: false })
    await api('/plugins/dsh/connect', {})
    const rootId = runtime().sessionId
    expect(typeof rootId).toBe('string')
    emit(93001, 'LEGACY-EXTERNAL-93001')
    await until(() => host.harness.getStatus().accepted === 1 && runtime().busy === false && host.harness.getStatus().queueMessages === 0, 'actual old root send', diagnostics)
    expect(model.requests).toHaveLength(2)
    expect(toolNames(model.requests[0]!)).toHaveLength(39)
    expect(toolNames(model.requests[0]!).every(name => name?.startsWith('mcp__qq__'))).toBe(true)
    expect(system(model.requests[0]!)).toContain('LEGACY-MAIN-POLICY')
    expect(JSON.stringify(model.requests[1]!.messages?.filter(message => message.role === 'tool'))).toContain('1001')
    expect(sends()).toHaveLength(1)
    expect(sends()[0]).toMatchObject({ action: 'send_private_msg', params: { user_id: 987654321, message: '旧版主代理发送93001', auto_escape: true } })
    await host.close()
    const configurationPath = join(home, 'harness/dsh/config.json'), nativeRoot = join(home, 'harness/dsh/dsh-home/sessions')
    const oldConfiguration = await readFile(configurationPath)
    expect(object(JSON.parse(oldConfiguration.toString('utf8')))).toMatchObject({ schemaVersion: 1, configuration: { endpoint: model.endpoint, apiKey: modelOptions.apiKey } })
    expect(object(JSON.parse(await readFile(join(home, 'harness/dsh/session.json'), 'utf8')))).toMatchObject({ schemaVersion: 1, sessionId: rootId, created: true })
    const beforeUpgrade = await fingerprints(nativeRoot)
    expect(Object.keys(beforeUpgrade).length).toBeGreaterThan(0)
    expect(await nativeSessionIds(nativeRoot)).toEqual([rootId])

    // The production installer CLI changes only approved executable versions while the Host is stopped.
    const cli = fileURLToPath(new URL('../dist/plugin-cli.mjs', import.meta.url))
    for (const [directory, version] of [['communication/qq', '0.8.0'], ['harness/dsh', '0.3.1']] as const) {
      const source = fileURLToPath(new URL(`../../../plugins/${directory}/dist/`, import.meta.url))
      const installed = await exec(process.execPath, [cli, 'install', source], { env: { ...process.env, EATING_HOME: home }, timeout: 15000, maxBuffer: 1024 * 1024 })
      expect(installed.stdout).toContain(version)
    }
    expect(await readFile(configurationPath)).toEqual(oldConfiguration)
    expect(await fingerprints(nativeRoot)).toEqual(beforeUpgrade)
    modelOptions.nativeDelegation = true
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [] })
    expect(plugin('dsh').version).toBe('0.3.1')
    expect(plugin('qq').version).toBe('0.8.0')
    const currentCommon = host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'common')!
    host.authoring.updatePrompt('common', 'MIGRATED-COMMON-POLICY', currentCommon.revision)
    const currentMain = host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'main')!
    host.authoring.updatePrompt('main', 'MIGRATED-MAIN-POLICY。自主委派并核对结果。', currentMain.revision)
    url = await host.listen(); bootstrap = await fetch(url + '/api/bootstrap'); csrf = String(object(await bootstrap.json()).csrfToken); cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    expect(runtime().sessionId).toBe(rootId)
    expect(model.requests).toHaveLength(2)
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/connect', {})
    expect(runtime().sessionId).toBe(rootId)
    expect(runtime().ready).toBe(true)
    emit(93002, 'MIGRATED-EXTERNAL-93002')
    await until(() => host.harness.getStatus().accepted === 2 && runtime().busy === false && host.harness.getStatus().queueMessages === 0, 'same legacy root with native child', diagnostics)
    expect(model.requests, JSON.stringify(diagnostics())).toHaveLength(6)
    const migrated = model.requests.slice(2)
    expect(migrated.map(request => readModelFixtureBatch(request)?.kind)).toEqual(['root', 'child', 'child', 'root'])
    for (const request of [migrated[0]!, migrated[3]!]) {
      expect(toolNames(request)).toEqual(['eating_delegate_task', 'eating_list_agent_types'])
      expect(system(request)).toContain('MIGRATED-MAIN-POLICY')
      expect(system(request)).not.toContain('LEGACY-MAIN-POLICY')
    }
    expect(JSON.stringify(migrated[0]!.messages)).toContain('LEGACY-EXTERNAL-93001')
    expect(JSON.stringify(migrated[0]!.messages)).toContain('sdk-legacy-send-93001')
    expect(JSON.stringify(migrated[0]!.messages?.filter(message => message.role === 'tool'))).toContain('1001')
    const privateTools = object(object(plugin('qq').configuration).agentTools)['qq.private']
    if (!Array.isArray(privateTools)) throw new Error('No migrated private Agent tool policy')
    for (const request of [migrated[1]!, migrated[2]!]) {
      expect(toolNames(request)).toEqual(privateTools.map(name => `mcp__qq__${String(name)}`).sort())
      expect(toolNames(request)).toContain('mcp__qq__qq_send_private_message')
      expect(toolNames(request).length).toBeLessThan(39)
      expect(toolNames(request).every(name => name?.startsWith('mcp__qq__'))).toBe(true)
      expect(system(request)).not.toContain('MIGRATED-MAIN-POLICY')
      expect(JSON.stringify(request.messages)).not.toContain('LEGACY-EXTERNAL-93001')
    }
    for (const request of migrated) {
      expect(system(request)).toContain('MIGRATED-COMMON-POLICY')
      expect(system(request)).toContain('MIGRATION-PERSONA')
      expect(system(request)).not.toContain('MIGRATED-EXTERNAL-93002')
      expect(readModelFixtureBatch(request)?.payload.events).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: '93002' })]))
    }
    const contextRef = readModelFixtureBatch(migrated[0]!)!.contextRef
    expect(JSON.stringify(migrated[3]!.messages?.filter(message => message.role === 'tool'))).toContain(`CHILD-SUMMARY:${contextRef}`)
    expect(JSON.stringify(migrated[3]!.messages?.filter(message => message.role === 'tool'))).toContain('succeeded')
    expect(sends()).toHaveLength(2)
    expect(sends()[1]).toMatchObject({ action: 'send_private_msg', params: { user_id: 987654321, message: '新版子代理发送93002', auto_escape: true } })
    expect(selected).toEqual(['93001', '93002'])
    expect(model.errors).toEqual([])
    expect(JSON.stringify(model.requests)).not.toContain(modelOptions.apiKey)
    expect(runtime().sessionId).toBe(rootId)
    await api('/plugins/dsh/disconnect', {})
    const listed = await api('/plugins/dsh/manage', { operation: 'list-sessions', input: {} })
    if (!Array.isArray(listed.sessions)) throw new Error('No migrated native hierarchy')
    const rows = listed.sessions.map(object)
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: rootId, parentId: null }), expect.objectContaining({ agentTypeId: 'qq.private', parentId: rootId })]))
    const childId = rows.find(row => row.agentTypeId === 'qq.private')!.id
    expect(childId).not.toBe(rootId)
    const content = await api('/plugins/dsh/manage', { operation: 'read-session', input: { sessionId: rootId!, limit: 200 } })
    expect(JSON.stringify(content)).toContain('LEGACY-EXTERNAL-93001')
    expect(JSON.stringify(content)).toContain('sdk-legacy-send-93001')
    expect(JSON.stringify(content)).toContain(`MAIN-SUMMARY:${contextRef}`)
    await host.close(); await closeModel(); await closeOnebot()
    expect(createHash('sha256').update(await readFile(configurationPath)).digest('hex')).toBe(createHash('sha256').update(oldConfiguration).digest('hex'))
    expect(await nativeSessionIds(nativeRoot)).toEqual([rootId, childId].sort())
    expect(model.requests).toHaveLength(6)
    expect(sends()).toHaveLength(2)
  }, 120000)
})
