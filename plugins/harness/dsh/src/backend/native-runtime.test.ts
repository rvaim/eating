import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultNativeCapabilities } from '../native-capabilities'
import type { NativeCapabilitiesConfiguration, NativeToolGrant } from '../native-capabilities'
import { DshNativeConfigurationFile } from './native-configuration'
import { getNativeCapabilitiesRuntimeSource } from './native-runtime'

type Tool = { name: string; description: string; parameters: object }
type Agent = { id: string; ctx: { fiber: { state: number }; effect: (setup: () => () => void) => () => void; tools: { restrict: (filter: { allow: string[] }) => () => void } }; local: Map<string, Tool>; inherited: Map<string, Tool>; masks: Set<Set<string>> }
type Native = { allowedGlobal(type: string): string[]; restrict(agent: Agent, type: string): void; mount(agent: Agent, type: string): Promise<string[]>; reportTools(agent: Agent, type: string, names: string[]): void; authorize(exec: { agent: Agent; name: string }, agent: Agent, type: string, allowed: string[]): string | undefined }
const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); vi.unstubAllEnvs() })
const schema = (name: string, description = 'fixture'): Tool => ({ name, description, parameters: { type: 'object', properties: {}, additionalProperties: false } })
const digest = (tool: Tool) => {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value
  return createHash('sha256').update(JSON.stringify(canonical(tool))).digest('hex')
}
async function fixture(toolGrants: readonly NativeToolGrant[] = [], toolAccessOverrides?: readonly NativeToolGrant[], saved?: NativeCapabilitiesConfiguration) {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(parent, 'eating-native-runtime-')))
  stops.push(async () => { if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-native-runtime-')) throw new Error('Unsafe native runtime fixture cleanup'); rmSync(directory, { recursive: true }) })
  const configurationPath = join(directory, 'native-configuration.json'), defaults = defaultNativeCapabilities([])
  const configuration: NativeCapabilitiesConfiguration = saved ?? { ...defaults, features: defaults.features.map(feature => ({ ...feature, enabled: false, agentTypeIds: [] })), toolGrants, ...(toolAccessOverrides ? { toolAccessOverrides } : {}) }
  writeFileSync(configurationPath, JSON.stringify(configuration))
  vi.stubEnv('EATING_DSH_BRIDGE_DIRECTORY', directory); vi.stubEnv('EATING_DSH_BRIDGE_NONCE', 'fixture-nonce'); vi.stubEnv('EATING_DSH_NATIVE_TOKEN', 'fixture-token'); vi.stubEnv('EATING_DSH_NATIVE_CONFIGURATION', configurationPath); vi.stubEnv('EATING_DSH_NATIVE_MANAGEMENT', 'true')
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>(), globals = new Map<string, Tool>(), agents = new Map<string, Agent>()
  let native!: Native, restrictionChanges = 0
  const emit = (name: string, ...args: unknown[]) => [...listeners.get(name) ?? []].map(listener => listener(...args))
  const visible = (agent?: Agent) => {
    if (!agent) return globals
    const inherited = new Map([...globals, ...agent.inherited])
    return new Map([...inherited].filter(([name]) => [...agent.masks].every(mask => mask.has(name))).concat([...agent.local]))
  }
  const tools = { schemas: (agent?: Agent) => [...visible(agent).values()], get: (name: string, agent?: Agent) => visible(agent).get(name) }
  const ctx = { tools, agents: { get: (id: string) => agents.get(id) }, provide: (_name: string, value: Native) => { native = value },
    on: (name: string, listener: (...args: any[]) => unknown) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); return () => listeners.get(name)!.delete(listener) },
    plugin: vi.fn(), pluginManager: { listPlugins: async () => [], listBundles: async () => [] }, configEditor: { configuration: () => [] }, agentPresets: { register: async () => () => {}, resolve: async () => ({ broken: false }) } }
  const generated = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(getNativeCapabilitiesRuntimeSource()).toString('base64')) as { apply: (value: typeof ctx) => void }
  generated.apply(ctx)
  await vi.waitFor(() => expect(existsSync(join(directory, 'native-control.json'))).toBe(true))
  stops.push(async () => { await Promise.all(emit('dispose')); listeners.clear() })
  const control = JSON.parse(readFileSync(join(directory, 'native-control.json'), 'utf8')) as { url: string }
  const request = async (operation: string, input: object) => {
    const response = await fetch(control.url, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'X-Eating-Runtime': 'fixture-nonce', 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, operation, input }) })
    return { status: response.status, body: await response.json() as any }
  }
  const scopeCleanups = new WeakMap<Agent, Array<() => void>>()
  const createAgent = (id: string, published = true) => {
    const cleanups: Array<() => void> = []
    const agent: Agent = { id, local: new Map(), inherited: new Map(), masks: new Set(), ctx: { fiber: { state: 2 }, effect: setup => { const cleanup = setup(); cleanups.push(cleanup); return cleanup }, tools: { restrict({ allow }) {
      const mask = new Set(allow); agent.masks.add(mask); restrictionChanges++; if (restrictionChanges > 100) throw new Error('Recursive restriction refresh')
      emit('tools/change')
      return () => { if (agent.masks.delete(mask)) emit('tools/change') }
    } } } }
    if (published) agents.set(id, agent)
    scopeCleanups.set(agent, cleanups)
    return agent
  }
  const set = (tool: Tool) => { globals.set(tool.name, tool); emit('tools/change') }
  const remove = (name: string) => { globals.delete(name); emit('tools/change') }
  const disposeAgent = (agent: Agent) => { agent.ctx.fiber.state = 3; for (const cleanup of scopeCleanups.get(agent) ?? []) cleanup(); for (const mask of agent.masks) { agent.masks.delete(mask); emit('tools/change') }; agents.delete(agent.id); emit('agent/disposed', { agent }) }
  return { directory, configuration, native, globals, agents, tools, emit, set, remove, request, createAgent, disposeAgent, changes: () => restrictionChanges }
}

describe('generated native runtime automatic global access', () => {
  it('automatically gives main native tools and every current or future type functional MCP tools while reserving communication names', async () => {
    const echo = schema('fixture_native_echo'), f = await fixture([{ name: echo.name, fingerprint: digest(echo), agentTypeIds: ['qq.private'] }])
    for (const tool of [echo, schema('write'), schema('mcp__memory__find'), schema('eating_delegate_task'), schema('qq_send_private_message'), schema('mcp__qq__qq_send_private_message')]) f.set(tool)
    expect(f.native.allowedGlobal('main')).toEqual(['fixture_native_echo', 'write', 'mcp__memory__find'])
    expect(f.native.allowedGlobal('qq.private')).toEqual(['fixture_native_echo', 'mcp__memory__find'])
    expect(f.native.allowedGlobal('new.future.type')).toEqual(['mcp__memory__find'])
    const main = f.createAgent('main'), child = f.createAgent('child')
    f.native.restrict(main, 'main'); f.native.restrict(child, 'qq.private')
    expect(await f.native.mount(main, 'main')).toEqual(f.native.allowedGlobal('main'))
    expect(f.tools.schemas(child).map(tool => tool.name)).toEqual(['fixture_native_echo', 'mcp__memory__find'])
    const catalog = await f.request('list', {})
    expect(catalog.status).toBe(200)
    expect(catalog.body.result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'write', automaticAccess: 'main' }), expect.objectContaining({ name: 'mcp__memory__find', automaticAccess: 'all' })]))
    expect(catalog.body.result.tools).toHaveLength(3)
  })
  it('honors persisted owner overrides for main and child, disables all, and restores automatic access after runtime restart', async () => {
    const echo = schema('fixture_native_echo'), mcp = schema('mcp__profile__find'), f = await fixture()
    const file = new DshNativeConfigurationFile(f.directory, () => ['qq.private', 'qq.group'])
    const childGrant = { name: echo.name, fingerprint: digest(echo), agentTypeIds: ['qq.private'] }
    const save = (overrides: readonly NativeToolGrant[] | undefined) => {
      const current = file.read()
      return file.commit(file.prepare({ expectedRevision: current.revision, features: f.configuration.features, toolGrants: [childGrant], ...(overrides ? { toolAccessOverrides: overrides } : {}) }), current.revision)
    }
    const check = async (expected: { main: string[]; private: string[]; group: string[]; future: string[] }) => {
      const next = await fixture([], undefined, file.read()); next.set(echo); next.set(mcp)
      for (const [id, type] of [['main', 'main'], ['private', 'qq.private'], ['group', 'qq.group'], ['future', 'future.type']] as const) {
        const agent = next.createAgent(id); next.native.restrict(agent, type)
        expect(next.tools.schemas(agent).map(tool => tool.name)).toEqual(expected[id])
        for (const tool of [echo, mcp]) expect(next.native.authorize({ agent, name: tool.name }, agent, type, [echo.name, mcp.name]) === undefined).toBe(expected[id].includes(tool.name))
      }
      return next
    }
    save([{ name: echo.name, fingerprint: digest(echo), agentTypeIds: ['qq.group'] }, { name: mcp.name, fingerprint: digest(mcp), agentTypeIds: ['main', 'qq.private'] }])
    await check({ main: [mcp.name], private: [mcp.name], group: [echo.name], future: [] })
    const persisted = readFileSync(file.filePath, 'utf8'); save(undefined)
    expect(readFileSync(file.filePath, 'utf8')).toBe(persisted)
    save([{ name: echo.name, fingerprint: digest(echo), agentTypeIds: [] }, { name: mcp.name, fingerprint: digest(mcp), agentTypeIds: [] }])
    const denied = await check({ main: [], private: [], group: [], future: [] })
    denied.set(schema(mcp.name, 'changed while disabled'))
    expect(denied.native.allowedGlobal('main')).toEqual([])
    expect(denied.native.allowedGlobal('qq.private')).toEqual([])
    save([])
    await check({ main: [echo.name, mcp.name], private: [echo.name, mcp.name], group: [mcp.name], future: [mcp.name] })
  })
  it('keeps named overrides closed after live schema changes, removal and reappearance without denying new automatic tools', async () => {
    const tool = schema('mcp__profile__read'), f = await fixture([], [{ name: tool.name, fingerprint: digest(tool), agentTypeIds: ['main', 'qq.private'] }])
    f.set(tool)
    const main = f.createAgent('main'), child = f.createAgent('child'); f.native.restrict(main, 'main'); f.native.restrict(child, 'qq.private')
    for (const agent of [main, child]) expect(f.tools.get(tool.name, agent)).toBe(tool)
    f.set(schema(tool.name, 'changed schema'))
    for (const agent of [main, child]) expect(f.tools.get(tool.name, agent)).toBeUndefined()
    expect(f.native.authorize({ agent: main, name: tool.name }, main, 'main', [tool.name])).toBeTypeOf('string')
    f.remove(tool.name); f.set(schema(tool.name, 'returning changed schema')); f.set(schema('mcp__profile__new_tool'))
    expect(f.native.allowedGlobal('main')).toEqual(['mcp__profile__new_tool'])
    expect(f.native.allowedGlobal('future.type')).toEqual(['mcp__profile__new_tool'])
    const configuration = { ...f.configuration, toolAccessOverrides: [{ name: tool.name, fingerprint: digest(tool), agentTypeIds: ['main'] }] }
    expect((await f.request('validate', { configuration })).status).toBe(200)
    const restarted = await fixture([], undefined, configuration); restarted.set(schema(tool.name, 'returning changed schema'))
    expect(restarted.native.allowedGlobal('main')).toEqual([])
    expect((await restarted.request('list', {})).body.result.tools[0]).toMatchObject({ name: tool.name, automaticAccess: 'all' })
  })
  it('never applies owner overrides to reserved communication tools or inherited same-name shadows', async () => {
    const tool = schema('mcp__profile__find'), reserved = ['eating_delegate_task', 'qq_send_private_message', 'mcp__qq__qq_send_private_message'].map(name => schema(name))
    const f = await fixture([], [tool, ...reserved].map(entry => ({ name: entry.name, fingerprint: digest(entry), agentTypeIds: ['main', 'qq.group'] })))
    for (const entry of [tool, ...reserved]) f.set(entry)
    const agent = f.createAgent('group'); agent.inherited.set(tool.name, schema(tool.name, 'forged source'))
    f.native.restrict(agent, 'qq.group'); f.native.reportTools(agent, 'qq.group', [tool.name, ...reserved.map(entry => entry.name)])
    expect(f.native.authorize({ agent, name: tool.name }, agent, 'qq.group', [tool.name])).toBeTypeOf('string')
    for (const entry of reserved) expect(f.native.authorize({ agent, name: entry.name }, agent, 'qq.group', reserved.map(row => row.name))).toBeTypeOf('string')
    expect(f.native.allowedGlobal('main')).toEqual([tool.name])
    const scoped = schema('mcp__qq__qq_get_group'); agent.local.set(scoped.name, scoped); f.native.reportTools(agent, 'qq.group', [scoped.name])
    expect(f.native.authorize({ agent, name: scoped.name }, agent, 'qq.group', [scoped.name])).toBeUndefined()
    expect(f.native.authorize({ agent, name: 'mcp__qq__qq_send_private_message' }, agent, 'qq.group', [scoped.name])).toBeTypeOf('string')
  })
  it('refreshes live masks without recursive events, admits newly published MCP tools, and immediately denies removed tools or changed child grants', async () => {
    const echo = schema('fixture_native_echo'), f = await fixture([{ name: echo.name, fingerprint: digest(echo), agentTypeIds: ['qq.private'] }])
    f.set(echo)
    const main = f.createAgent('main'), child = f.createAgent('child')
    f.native.restrict(main, 'main'); f.native.restrict(child, 'qq.private')
    f.native.reportTools(main, 'main', ['fixture_native_echo']); f.native.reportTools(child, 'qq.private', ['fixture_native_echo'])
    f.set(schema('mcp__profile__new_tool'))
    expect(f.tools.get('mcp__profile__new_tool', child)).toBe(f.globals.get('mcp__profile__new_tool'))
    expect(f.native.authorize({ agent: child, name: 'mcp__profile__new_tool' }, child, 'qq.private', ['fixture_native_echo'])).toBeUndefined()
    f.set(schema('future_native_tool'))
    expect(f.tools.get('future_native_tool', main)).toBeDefined(); expect(f.tools.get('future_native_tool', child)).toBeUndefined()
    f.set(schema(echo.name, 'changed schema'))
    expect(f.tools.get(echo.name, child)).toBeUndefined()
    expect(f.native.authorize({ agent: child, name: echo.name }, child, 'qq.private', [echo.name])).toBeTypeOf('string')
    expect(f.native.authorize({ agent: main, name: echo.name }, main, 'main', [echo.name])).toBeUndefined()
    f.remove('mcp__profile__new_tool')
    expect(f.native.authorize({ agent: child, name: 'mcp__profile__new_tool' }, child, 'qq.private', [])).toBeTypeOf('string')
    expect(f.changes()).toBeLessThan(20)
    f.disposeAgent(child)
    const changes = f.changes(); f.set(schema('mcp__profile__after_disposal'))
    expect(f.changes()).toBe(changes + 1); expect(child.masks.size).toBe(0)
    const catalog = await f.request('list', {})
    expect(catalog.body.result.runtime.agents).toEqual([]) // management-only catalog does not claim running mounts
  })
  it('checks actual global and local definitions so inherited shadows and replaced scoped tools do not inherit automatic access by name', async () => {
    const f = await fixture(), name = 'mcp__profile__read'
    f.set(schema(name))
    const child = f.createAgent('child'); child.inherited.set(name, schema(name, 'unapproved inherited shadow'))
    f.native.restrict(child, 'qq.private'); await f.native.mount(child, 'qq.private')
    f.native.reportTools(child, 'qq.private', [name])
    expect(f.native.authorize({ agent: child, name }, child, 'qq.private', [name])).toBeTypeOf('string')
    child.inherited.delete(name)
    expect(f.native.authorize({ agent: child, name }, child, 'qq.private', [name])).toBeUndefined()
    const scoped = 'mcp__qq__qq_get_message'; child.local.set(scoped, schema(scoped))
    f.native.reportTools(child, 'qq.private', [name, scoped])
    expect(f.native.authorize({ agent: child, name: scoped }, child, 'qq.private', [name, scoped])).toBeUndefined()
    child.local.set(scoped, schema(scoped, 'replaced scoped tool'))
    expect(f.native.authorize({ agent: child, name: scoped }, child, 'qq.private', [name, scoped])).toBeTypeOf('string')
    expect(f.native.authorize({ agent: f.createAgent('forged'), name }, child, 'qq.private', [name])).toBeTypeOf('string')
  })
  it('applies restrictions before registry publication and releases unpublished scopes without waiting for a disposed event', async () => {
    const f = await fixture(); f.set(schema('native_write')); f.set(schema('mcp__profile__read'))
    const child = f.createAgent('not-yet-published', false)
    f.native.restrict(child, 'qq.private')
    expect(f.agents.get(child.id)).toBeUndefined()
    expect(f.tools.schemas(child).map(tool => tool.name)).toEqual(['mcp__profile__read'])
    f.set(schema('mcp__profile__new'))
    expect(f.tools.schemas(child).map(tool => tool.name)).toEqual(['mcp__profile__read', 'mcp__profile__new'])
    f.disposeAgent(child)
    const changes = f.changes(); f.set(schema('mcp__profile__after_unpublished_disposal'))
    expect(f.changes()).toBe(changes)
    expect(child.masks.size).toBe(0)
  })
  it('ignores obsolete main-only fingerprints but still validates exact non-MCP child grants', async () => {
    const f = await fixture(), configuration = { ...defaultNativeCapabilities([]), features: defaultNativeCapabilities([]).features.map(feature => ({ ...feature, enabled: false, agentTypeIds: [] })) }
    const grant = { name: 'removed_main_tool', fingerprint: 'a'.repeat(64), agentTypeIds: ['main'] }
    expect((await f.request('validate', { configuration: { ...configuration, toolGrants: [grant] } })).status).toBe(200)
    const rejected = await f.request('validate', { configuration: { ...configuration, toolGrants: [{ ...grant, agentTypeIds: ['qq.private'] }] } })
    expect(rejected.status).toBe(409); expect(rejected.body.error.code).toBe('NATIVE_TOOL_CHANGED')
    expect((await f.request('validate', { configuration: { ...configuration, toolGrants: [{ ...grant, agentTypeIds: ['qq.private'] }], toolAccessOverrides: [{ ...grant, agentTypeIds: [] }] } })).status).toBe(200)
  })
})
