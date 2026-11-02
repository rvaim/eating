import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { isJsonObject } from '@eating/plugin-sdk'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import { EatingHost } from '../../../../../apps/host/src/app'
import qqEntry from '../../../../communication/qq/src/server'
import { startOneBotFixture } from '../../../../../tests/fixtures/onebot'
import { readModelFixtureBatch } from '../../../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../../../tests/fixtures/openai'
import { testSystemDsh } from '../../../../../tests/fixtures/system-dsh'
import { DshPlugin } from './adapter'

const stops: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })
function object(value: unknown): JsonObject { if (!isJsonObject(value)) throw new Error('Expected native fixture object'); return value }
const nativeName = 'fixture_native_echo', mcpName = 'mcp__profile__echo'

// Opt-in system SDK, fresh Profile and local protocol fixtures only. Native
// plugin and official Profile MCP tools execute through their real services.
describe.runIf(Boolean(process.env.EATING_DSH_TEST_SYSTEM_BIN))('system DSH native owner tool policies', () => {
  it('persists main/child overrides across restarts, keeps changed schemas closed, disables all and restores automatic defaults', async () => {
    const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-native-access-')))
    stops.push(async () => { const target = await realpath(home); if (target !== home || dirname(target) !== parent || !basename(target).startsWith('eating-native-access-')) throw new Error('Unsafe native access fixture cleanup'); await rm(target, { recursive: true }) })
    const requests: ModelFixtureRequest[] = [], errors: string[] = [], delegated = new Set<string>(), called = new Set<string>()
    let mcpDescription = 'Isolated original native access fixture'
    const mcpCalls: string[] = [], transports = new Set<StreamableHTTPServerTransport>()
    const mcpServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8'), body: unknown = text ? JSON.parse(text) : undefined
        const server = new Server({ name: 'native-profile-access-fixture', version: '1' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: mcpDescription, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] }))
        server.setRequestHandler(CallToolRequestSchema, async ({ params }) => { if (params.name !== 'echo' || typeof params.arguments?.value !== 'string') throw new Error('Invalid native MCP fixture call'); mcpCalls.push(params.arguments.value); return { content: [{ type: 'text', text: 'NATIVE-ECHO:' + mcpName + ':' + params.arguments.value }] } })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); transports.add(transport)
        try { await server.connect(transport); await transport.handleRequest(request, response, body) }
        finally { transports.delete(transport); await server.close(); await transport.close() }
      })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
    })
    await new Promise<void>(resolve => mcpServer.listen(0, '127.0.0.1', resolve))
    stops.push(async () => { for (const transport of transports) await transport.close(); const closed = new Promise<void>(resolve => mcpServer.close(() => resolve())); mcpServer.closeAllConnections(); await closed })
    const mcpAddress = mcpServer.address(); if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('Missing MCP fixture port')
    const model = createServer((request, response) => {
      void (async () => {
        if (request.url !== '/v1/chat/completions' || request.method !== 'POST' || request.headers.authorization !== 'Bearer isolated-native-access-key') throw new Error('Unexpected isolated model request')
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Native access fixture model body too large'); chunks.push(Buffer.from(chunk)) }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelFixtureRequest
        requests.push(payload)
        const batch = readModelFixtureBatch(payload)
        if (!batch) throw new Error('Missing actual native batch')
        const names = payload.tools?.map(tool => tool.function?.name) ?? [], key = batch.contextRef + '/' + batch.kind
        let call: { name: string; arguments: JsonObject } | undefined
        const available = [nativeName, mcpName].find(name => names.includes(name))
        if (available && !called.has(key)) { called.add(key); call = { name: available, arguments: { value: key } } }
        else if (batch.kind === 'root' && !delegated.has(batch.contextRef)) { delegated.add(batch.contextRef); call = { name: 'eating_delegate_task', arguments: { type_id: batch.agentTypeId, context_ref: batch.contextRef, task: 'Use the available isolated echo tool once and report its result. Do not send communication messages.' } } }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
        const chunk = (delta: object, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'native-access-' + requests.length, object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
        if (call) { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'native-access-call-' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, null); chunk({}, 'tool_calls') }
        else { chunk({ role: 'assistant', content: 'NATIVE-ACCESS-COMPLETE:' + key }, null); chunk({}, 'stop') }
        response.end('data: [DONE]\n\n')
      })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    stops.push(async () => { const closed = new Promise<void>(resolve => model.close(() => resolve())); model.closeAllConnections(); await closed })
    const address = model.address(); if (!address || typeof address === 'string') throw new Error('Missing model fixture port')
    const onebot = await startOneBotFixture({ login: { user_id: 12345678, nickname: 'Isolated native policy fixture' } }); stops.push(() => onebot.close())
    let plugin!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { plugin = new DshPlugin(context, { locateSystemDsh: testSystemDsh }); return plugin } }
    const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); stops.push(() => host.close())
    const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!, boot = object(await bootstrap.json())
    const api = async (path: string, body: JsonObject) => { const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result }
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
    await api('/plugins/qq/connect', {})
    await plugin.updateConfiguration({ endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'native-access-fixture', apiKey: 'isolated-native-access-key', timeoutMs: 10000, maxTokens: 256, autoConnect: false })
    const packageDirectory = join(home, 'fixture-native-package'); await mkdir(packageDirectory)
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@fixture/native-access', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(packageDirectory, 'cordis.patch.yml'), '- insert:\n    - id: fixture-native-access\n      name: "@fixture/native-access"\n')
    const source = `import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; const request=createRequire(process.argv[1]); const Mcp=await import(pathToFileURL(request.resolve('@deepseek-ai/dsh-mcp-client')).href); export const name='fixture-native-access'; export const inject=['tools']; export async function apply(ctx){ const name=${JSON.stringify(nativeName)}; ctx.tools.register({name,description:'Isolated original native access fixture',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},async execute(args){return 'NATIVE-ECHO:'+name+':'+args.value;}}); await ctx.plugin(Mcp,{transport:'streamable-http',serverName:'profile',url:${JSON.stringify(`http://127.0.0.1:${mcpAddress.port}/mcp`)},toolCallTimeoutMs:5000,failOnStartupError:true}); }`
    await writeFile(join(packageDirectory, 'index.mjs'), source)
    await plugin.manage('native-install', { requestId: randomUUID(), spec: packageDirectory, confirmed: true })
    let snapshot = object(await plugin.manage('native-list', {})), catalog = object(snapshot.catalog), configuration = object(snapshot.configuration)
    expect(Object.hasOwn(configuration, 'toolAccessOverrides')).toBe(false)
    const path = join(home, 'harness/dsh/native-capabilities.json')
    expect(existsSync(path)).toBe(false)
    const bundle = (catalog.bundles as JsonObject[]).find(row => row.name === '@fixture/native-access')!
    const enabled = object(await plugin.manage('native-bundle', { requestId: randomUUID(), name: bundle.name!, enabled: true, expectedFingerprint: bundle.fingerprint! }))
    expect(enabled.application, JSON.stringify(enabled)).not.toBe('failed')
    snapshot = object(await plugin.manage('native-list', {})); catalog = object(snapshot.catalog); configuration = object(snapshot.configuration)
    const native = (catalog.tools as JsonObject[]).find(tool => tool.name === nativeName)!, mcp = (catalog.tools as JsonObject[]).find(tool => tool.name === mcpName)!
    expect(native, JSON.stringify(catalog.plugins)).toMatchObject({ automaticAccess: 'main' }); expect(mcp).toMatchObject({ automaticAccess: 'all' })
    const features = (configuration.features as JsonObject[]).map(feature => ({ ...feature, enabled: feature.id === 'time', agentTypeIds: feature.id === 'time' ? feature.agentTypeIds! : [] }))
    const save = async (toolAccessOverrides?: JsonObject[]) => {
      const input: JsonObject = { expectedRevision: configuration.revision!, features, toolGrants: [], ...(toolAccessOverrides ? { toolAccessOverrides } : {}) }
      configuration = object(object(await plugin.manage('native-save', input)).configuration)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(configuration)
    }
    let cycles = 0
    const run = async (main: string[], child: string[]) => {
      await plugin.connect()
      const start = requests.length; cycles++
      onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 12345678, user_id: 87654321, message_id: 81000 + cycles, message: 'Isolated native access cycle ' + cycles })
      const deadline = Date.now() + 20000
      while ((host.harness.getStatus().accepted !== cycles || !plugin.isReady()) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20))
      expect(host.harness.getStatus().accepted, JSON.stringify(plugin.getStatus())).toBe(cycles); expect(plugin.isReady()).toBe(true)
      const current = requests.slice(start), first = (kind: string) => current.find(request => readModelFixtureBatch(request)?.kind === kind)
      for (const [kind, allowed] of [['root', main], ['child', child]] as const) {
        expect(first(kind)).toBeDefined()
        expect(first(kind)?.tools?.map(tool => tool.function?.name).filter(name => name === nativeName || name === mcpName)).toEqual(allowed)
        if (allowed.length) expect(JSON.stringify(current.filter(request => readModelFixtureBatch(request)?.kind === kind))).toContain('NATIVE-ECHO:' + allowed[0])
      }
      expect(current.filter(request => readModelFixtureBatch(request)?.kind === 'root').every(request => !request.tools?.some(tool => tool.function?.name?.startsWith('mcp__qq__')))).toBe(true)
      expect(current.filter(request => readModelFixtureBatch(request)?.kind === 'child').every(request => !request.tools?.some(tool => tool.function?.name?.includes('qq_send_group_message')))).toBe(true)
      const runtime = object(object(object(await plugin.manage('native-list', {})).catalog).runtime)
      expect(runtime.appliedRevision).toBe(configuration.revision)
      await plugin.disconnect()
    }
    await save(); expect(Object.hasOwn(configuration, 'toolAccessOverrides')).toBe(false)
    await run([nativeName, mcpName], [mcpName])
    const overrides = [{ name: nativeName, fingerprint: native.fingerprint!, agentTypeIds: ['qq.private'] }, { name: mcpName, fingerprint: mcp.fingerprint!, agentTypeIds: ['main'] }]
    await save(overrides); const bytes = await readFile(path, 'utf8'); await save(); expect(await readFile(path, 'utf8')).toBe(bytes)
    await expect(plugin.manage('native-save', { expectedRevision: 0, features, toolGrants: [], toolAccessOverrides: [] })).rejects.toMatchObject({ code: 'NATIVE_CAPABILITIES_CONFLICT' })
    await run([mcpName], [nativeName])
    await writeFile(join(packageDirectory, 'index.mjs'), source.replace('Isolated original native access fixture', 'Changed native access fixture schema')); mcpDescription = 'Changed native access fixture schema'
    await run([], [])
    await save(overrides.map(override => ({ ...override, agentTypeIds: [] }))); await run([], [])
    await save([]); await run([nativeName, mcpName], [mcpName])
    expect(onebot.requests.filter(request => request.action.startsWith('send_'))).toEqual([])
    expect(mcpCalls).toHaveLength(3)
    expect(errors).toEqual([])
  }, 180000)
})
