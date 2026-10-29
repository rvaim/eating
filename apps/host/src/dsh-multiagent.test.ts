import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackendPluginEntry, JsonObject } from '@eating/plugin-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import { DshPlugin } from '../../../plugins/harness/dsh/src/backend/adapter'
import { EatingHost } from './app'
import qqEntry from '../../../plugins/communication/qq/src/server'
import { testRuntimeBin, testSystemDsh } from '../../../tests/fixtures/system-dsh'
import { readModelFixtureBatch } from '../../../tests/fixtures/openai'
import type { ModelFixtureRequest } from '../../../tests/fixtures/openai'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'

const runtimeDirectory = process.env.EATING_DSH_TEST_RUNTIME
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function isolatedHome() {
  const parent = await realpath(tmpdir())
  const home = await realpath(await mkdtemp(join(parent, 'Eating_dsh_multiagent_')))
  cleanups.push(async () => {
    const target = await realpath(home)
    if (target !== home || dirname(target) !== parent || !basename(target).startsWith('Eating_dsh_multiagent_')) throw new Error('Unsafe multiagent fixture cleanup')
    await rm(target, { recursive: true })
  })
  return home
}

async function modelFixture(choose: (request: ModelFixtureRequest, index: number) => { name: string; arguments: object } | string) {
  const requests: ModelFixtureRequest[] = []
  const errors: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return }
      const parts: Buffer[] = []; let length = 0
      for await (const part of request) { length += part.length; if (length > 1024 * 1024) throw new Error('Fixture input too large'); parts.push(Buffer.from(part)) }
      const payload = JSON.parse(Buffer.concat(parts).toString('utf8')) as ModelFixtureRequest
      requests.push(payload)
      const reply = choose(payload, requests.length - 1)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: object, finish: string | null) => response.write(`data: ${JSON.stringify({ id: `multiagent-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
      if (typeof reply === 'string') { chunk({ role: 'assistant', content: reply }, null); chunk({}, 'stop') }
      else { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_multiagent_${requests.length}`, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] }, null); chunk({}, 'tool_calls') }
      response.end('data: [DONE]\n\n')
    })().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
  cleanups.push(async () => { const closed = new Promise<void>(accept => server.close(() => accept())); server.closeAllConnections(); await closed })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests, errors }
}

// Only fixed independent npm packages and loopback protocol fixtures are executed.
describe.runIf(Boolean(runtimeDirectory))('真实DSH原生多代理隔离', () => {
  it('awaits child initialization, isolates system/tools and returns actual MCP→OneBot results to its parent', async () => {
    const home = await isolatedHome()
    const rootId = randomUUID(), childId = randomUUID()
    const runtimeBin = testRuntimeBin(resolve(runtimeDirectory!))
    const runtimeRequire = createRequire(join(dirname(dirname(runtimeBin)), 'package.json'))
    const packageEntry = (name: string) => runtimeRequire.resolve(`@deepseek-ai/${name}`)
    const onebot = await startOneBotFixture(); cleanups.push(() => onebot.close())
    const sockets = new Set<WebSocket>()
    cleanups.push(() => { for (const peer of sockets) peer.terminate() })
    let mcpCalls = 0
    const transports = new Set<StreamableHTTPServerTransport>()
    const mcp = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== 'Bearer fixture-child-private-scope') { response.writeHead(401); response.end(); return }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        const server = new Server({ name: 'scope-fixture', version: '1' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'qq_send_private_message', description: 'Only this private target', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, message: { type: 'string' } }, required: ['user_id', 'message'], additionalProperties: false } }] }))
        server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
          if (params.name !== 'qq_send_private_message' || params.arguments?.user_id !== '987654321') return { isError: true, content: [{ type: 'text', text: 'SCOPE_DENIED' }] }
          mcpCalls++
          const peer = new WebSocket(onebot.endpoint); sockets.add(peer)
          try {
            await once(peer, 'open')
            const reply = once(peer, 'message')
            peer.send(JSON.stringify({ action: 'send_private_msg', params: { user_id: Number(params.arguments.user_id), message: params.arguments.message }, echo: 'scope-poc' }))
            const [raw] = await reply
            return { content: [{ type: 'text', text: String(raw) }] }
          } finally { peer.terminate(); sockets.delete(peer) }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); transports.add(transport)
        try { await server.connect(transport); await transport.handleRequest(request, response, body) }
        finally { transports.delete(transport); await server.close(); await transport.close() }
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
    })
    await new Promise<void>(accept => mcp.listen(0, '127.0.0.1', accept))
    cleanups.push(async () => { for (const transport of transports) await transport.close(); const closed = new Promise<void>(accept => mcp.close(() => accept())); mcp.closeAllConnections(); await closed })
    const mcpAddress = mcp.address(); if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('No MCP fixture port')
    let childRequests = 0
    const model = await modelFixture(request => {
      const system = JSON.stringify(request.messages?.filter(message => message.role === 'system'))
      if (system.includes('CHILD-PRIVATE-SYSTEM')) {
        childRequests++
        if (childRequests === 1) return { name: 'eating_delegate_task', arguments: { task: 'forbidden child delegation' } }
        if (childRequests === 2) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: '987654321', message: '真实原生子代理回复' } }
        return 'CHILD-SUMMARY'
      }
      if (!request.messages?.some(message => message.role === 'tool')) return { name: 'eating_delegate_task', arguments: { task: 'EXTERNAL-USER-DATA' } }
      return 'MAIN-AFTER-DELEGATE'
    })
    const bridge = join(home, 'poc-bridge.mjs')
    await writeFile(bridge, `import * as Mcp from ${JSON.stringify(pathToFileURL(packageEntry('dsh-mcp-client')).href)};
export const name='native-scope-poc';
export const inject=['agents','subagents','tools','systemPrompt','sessions'];
export function apply(ctx){
  ctx.on('agent/created',async ({agent})=>{
    const root=agent.id===${JSON.stringify(rootId)};
    agent.ctx.systemPrompt.section({name:'poc:system',order:0,complete:true,interpolate:false,text:root?'MAIN-SYSTEM':'CHILD-PRIVATE-SYSTEM'});
    if(root){agent.ctx.tools.register({name:'eating_delegate_task',description:'Delegate to the bound private child',parameters:{type:'object',properties:{task:{type:'string'}},required:['task'],additionalProperties:false},output:{schema:{type:'object',properties:{childId:{type:'string'},status:{type:'string'},summary:{type:'string'}},required:['childId','status','summary'],additionalProperties:false},render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){const activation=await ctx.subagents.startActivation({provider:'spawn',childId:${JSON.stringify(childId)},label:'private-child',request:{parent:exec.agent,prompt:[{type:'text',text:args.task}],maxDepth:1},signal:exec.signal,delivery:'caller'});const result=await activation.result;return {childId:activation.childId,status:result.stopReason,summary:result.output.filter(x=>x.type==='text').map(x=>x.text).join('')};}});}
    else {await agent.ctx.plugin(Mcp,{transport:'streamable-http',serverName:'qq',url:${JSON.stringify(`http://127.0.0.1:${mcpAddress.port}/mcp`)},headers:{Authorization:'Bearer fixture-child-private-scope'},toolCallTimeoutMs:5000,failOnStartupError:true});}
  });
}`)
    const disabled = ['llm-deepseek', 'tool-fs', 'tool-working-directory', 'persistent-bash', 'persistent-pwsh', 'mcp-resources', 'terminal-bash', 'terminal-pwsh', 'pty', 'subprocess']
    const patch = join(home, 'poc.patch.yml')
    await writeFile(patch, disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + '- insert:\n' + [
      { id: 'poc-provider', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { fixture: { api: 'openai-completions', baseURL: model.endpoint, apiKeyEnv: 'EATING_POC_MODEL_KEY', models: [{ id: 'fixture-model', input: ['text'], reasoningEfforts: false }] } } } },
      { id: 'native-subagents', name: packageEntry('dsh-subagent') },
      { id: 'native-spawn', name: packageEntry('dsh-subagent-spawn-in-process') },
      { id: 'native-query', name: packageEntry('dsh-session-query-sqlite'), config: { path: ':memory:', openAt: 'never' } },
      { id: 'scope-poc', name: bridge },
    ].map(entry => `    - ${JSON.stringify(entry)}\n`).join(''))
    const workspace = join(home, 'workspace'); await mkdir(workspace)
    const sdkRequire = createRequire(new URL('../../../plugins/harness/dsh/package.json', import.meta.url))
    const sdk = await import(/* @vite-ignore */ pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-sdk-client')).href) as { DeepSeekHarness: new (options: object) => { start(): Promise<void>; run(input: string, options: object): Promise<{ finalResponse: string; events: Array<{ type: string; data: unknown }>; notifications: Array<{ method: string; params: Record<string, unknown> }> }>; close(): Promise<void> } }
    const harness = new sdk.DeepSeekHarness({ dshBin: runtimeBin, profile: 'sdk-minimal', patches: [patch], cwd: workspace, processCwd: workspace, dshHome: join(home, 'dsh-home'), provider: 'fixture', model: 'fixture-model', initializeTimeoutMs: 15000, requestTimeoutMs: 20000, disposeEofGraceMs: 500, disposeGraceMs: 500,
      env: { EATING_POC_MODEL_KEY: 'fixture-poc-model-key', PATH: process.env.PATH, HOME: join(home, 'runtime-home'), DSH_HOME: join(home, 'dsh-home'), DSH_AGENTS_HOME: join(home, 'agents-home') } })
    cleanups.push(() => harness.close())
    await harness.start()
    const result = await harness.run('ROOT-EXTERNAL-ORIGINAL', { sessionId: rootId })
    expect(result.finalResponse, JSON.stringify({ turns: result.events.filter(event => event.type === 'turn/end'), requests: model.requests.length })).toBe('MAIN-AFTER-DELEGATE')
    const root = model.requests.filter(request => JSON.stringify(request.messages?.filter(message => message.role === 'system')).includes('MAIN-SYSTEM'))
    const child = model.requests.filter(request => JSON.stringify(request.messages?.filter(message => message.role === 'system')).includes('CHILD-PRIVATE-SYSTEM'))
    expect(root[0]?.tools?.map(tool => tool.function?.name)).toEqual(['eating_delegate_task'])
    expect(child).toHaveLength(3)
    expect(child[0]?.tools?.map(tool => tool.function?.name)).toEqual(['mcp__qq__qq_send_private_message'])
    expect(JSON.stringify(child[0]?.messages)).not.toContain('ROOT-EXTERNAL-ORIGINAL')
    expect(JSON.stringify(child[1]?.messages)).toContain('unknown tool')
    expect(JSON.stringify(root.at(-1)?.messages)).toContain('CHILD-SUMMARY')
    expect(mcpCalls).toBe(1)
    expect(onebot.requests).toHaveLength(1)
    expect(onebot.requests[0]?.params.message).toBe('真实原生子代理回复')
    expect(result.notifications).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'subagent.started', params: { parentSessionId: rootId, childSessionId: childId } })]))
    await harness.close()
    expect(model.requests).toHaveLength(5)
    expect(model.errors).toEqual([])
  }, 60000)

  it('uses the production bridge, scoped Host MCP, persistent child identity and offline native session reader', async () => {
    const home = await isolatedHome()
    const systemDsh = () => testSystemDsh(resolve(runtimeDirectory!))
    const onebot = await startOneBotFixture(); cleanups.push(() => onebot.close())
    let currentBatch = ''
    let currentType = ''
    const delegated = new Set<string>()
    const childTurns = new Set<string>()
    const model = await modelFixture(request => {
      const names = request.tools?.map(tool => tool.function?.name) ?? []
      if (names.includes('eating_delegate_task')) {
        const users = request.messages?.filter(message => message.role === 'user') ?? []
        for (const user of [...users].reverse()) {
          try {
            const payload: unknown = JSON.parse(String(user.content))
            if (isJsonObject(payload) && isJsonObject(payload.context) && typeof payload.context.contextRef === 'string') {
              currentBatch = payload.context.contextRef; currentType = String(payload.context.agentTypeId); break
            }
          } catch { /* Native runtime context is ordinary user text. */ }
        }
        if (!delegated.has(currentBatch)) { delegated.add(currentBatch); return { name: 'eating_delegate_task', arguments: { type_id: currentType, context_ref: currentBatch, task: '处理绑定会话并仅通过已授权工具回复。' } } }
        return '主Agent已核对返回结果，不自动发送文本。'
      }
      if (!childTurns.has(currentBatch)) {
        childTurns.add(currentBatch)
        const privateTool = names.find(name => name?.endsWith('qq_send_private_message'))
        return { name: privateTool ?? 'mcp__qq__qq_send_group_message', arguments: privateTool
          ? { user_id: '987654321', message: '正式桥私聊回复', request_id: `send-${currentBatch.slice(0, 32)}` }
          : { group_id: '123456', message: '正式桥群聊回复', request_id: `send-${currentBatch.slice(0, 32)}` } }
      }
      return '子Agent处理完成。'
    })
    let plugin!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { plugin = new DshPlugin(context, { locateSystemDsh: systemDsh }); return plugin } }
    const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); cleanups.push(() => host.close())
    const url = await host.listen()
    const bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const boot: unknown = await bootstrap.json(); if (!isJsonObject(boot)) throw new Error('Invalid bootstrap')
    const api = async (path: string, body: JsonObject) => {
      const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const value: unknown = await response.json(); if (!response.ok) throw new Error(`Fixture API ${path}: ${JSON.stringify(value)}`)
      return value
    }
    const qqConfiguration = await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
    if (!isJsonObject(qqConfiguration) || !isJsonObject(qqConfiguration.agentTools)) throw new Error('No QQ agent policy')
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-model', apiKey: 'production-bridge-fixture-key', timeoutMs: 10000, maxTokens: 1024, autoConnect: false })
    await api('/plugins/dsh/connect', {})
    const until = async (test: () => boolean, label: string) => { const end = Date.now() + 15000; while (!test() && Date.now() < end) await new Promise<void>(accept => setTimeout(accept, 20)); if (!test()) throw new Error(label) }
    const emit = (id: number, group = false) => onebot.emitEvent({ post_type: 'message', message_type: group ? 'group' : 'private', self_id: 123456789, user_id: 987654321, ...(group ? { group_id: 123456 } : {}), message_id: id, message: '外部上下文只进入user数据 api_key=production-bridge-fixture-key cookie=fixture-cookie-value' })
    emit(99301)
    await until(() => host.harness.getStatus().accepted === 1 && plugin.isReady(), 'first production delegation timed out')
    const firstList = await plugin.manage('list-sessions', {})
    expect(isJsonObject(firstList) && Array.isArray(firstList.sessions) ? firstList.sessions : []).toHaveLength(2)
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    const common = host.authoring.getSnapshot().prompts.find(prompt => prompt.id === 'common')!
    host.authoring.updatePrompt('common', 'COMMON-UPDATED-ON-TASK-BOUNDARY', common.revision)
    const persona = host.authoring.createPersona('persona-v2', 'PERSONA-UPDATED-ON-TASK-BOUNDARY')
    host.authoring.setPersonaEnabled(persona.persona.id, true, persona.snapshot.revision)
    await api('/plugins/qq/manage', { operation: 'save-agent-policy', input: { expectedRevision: qqConfiguration.policyRevision!, owners: [], administrators: [], agentTools: { ...qqConfiguration.agentTools, 'qq.private': ['qq_send_private_message'] } } })
    emit(99302)
    await until(() => host.harness.getStatus().accepted === 2 && plugin.isReady(), 'child cold continuation timed out')
    const secondList = await plugin.manage('list-sessions', {})
    expect(isJsonObject(secondList) && Array.isArray(secondList.sessions) ? secondList.sessions : []).toHaveLength(2)
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(2)
    const privateRequests = model.requests.filter(request => request.tools?.some(tool => tool.function?.name === 'mcp__qq__qq_send_private_message'))
    expect(privateRequests.at(-1)?.tools?.map(tool => tool.function?.name)).toEqual(['mcp__qq__qq_send_private_message'])
    const latestSystem = JSON.stringify(privateRequests.at(-1)?.messages?.filter(message => message.role === 'system'))
    expect(latestSystem).toContain('COMMON-UPDATED-ON-TASK-BOUNDARY')
    expect(latestSystem).toContain('PERSONA-UPDATED-ON-TASK-BOUNDARY')
    expect(firstList).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ id: isJsonObject(secondList) && Array.isArray(secondList.sessions) ? secondList.sessions.find(row => isJsonObject(row) && row.agentTypeId === 'qq.private') && (secondList.sessions.find(row => isJsonObject(row) && row.agentTypeId === 'qq.private') as JsonObject).id : null })]) })
    await plugin.disconnect()
    const fingerprints = async () => {
      const values: Record<string, string> = {}
      const walk = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) values[path] = createHash('sha256').update(await readFile(path)).digest('hex') } }
      await walk(join(home, 'harness/dsh/dsh-home/sessions')); return values
    }
    const beforeRead = await fingerprints()
    const catalog = host.getWorkspace().plugins
    if (!Array.isArray(catalog)) throw new Error('No plugin catalog')
    const qqPlugin = catalog.find(value => isJsonObject(value) && value.id === 'qq')
    if (!isJsonObject(qqPlugin) || !isJsonObject(qqPlugin.status) || typeof qqPlugin.status.accountId !== 'string') throw new Error('No verified QQ account')
    const accountId = qqPlugin.status.accountId
    const offline = await plugin.manage('list-sessions', {})
    expect(offline).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ parentId: null }), expect.objectContaining({ agentTypeId: 'qq.private', title: `QQ-${accountId}-私聊-987654321`, accountId, pluginName: 'QQ', pluginId: 'qq', conversationKind: 'private', targetId: '987654321', updatedAt: null })]) })
    if (!isJsonObject(offline) || !Array.isArray(offline.sessions)) throw new Error('No native session rows')
    const child = offline.sessions.find(row => isJsonObject(row) && row.agentTypeId === 'qq.private')
    if (!isJsonObject(child)) throw new Error('No native private child')
    const content = await plugin.manage('read-session', { sessionId: child.id!, limit: 200 })
    expect(content).toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ role: 'user', classification: 'agent-message' }), expect.objectContaining({ role: 'assistant' }), expect.objectContaining({ role: 'tool' })]) })
    expect(JSON.stringify(content)).toContain('外部上下文只进入user数据')
    expect(JSON.stringify(content)).not.toContain('production-bridge-fixture-key')
    expect(JSON.stringify(content)).not.toContain('fixture-cookie-value')
    expect(await fingerprints()).toEqual(beforeRead)
    await plugin.connect()
    emit(99303, true)
    await until(() => host.harness.getStatus().accepted === 3 && plugin.isReady(), 'group production delegation timed out')
    expect(onebot.requests.filter(request => request.action === 'send_group_msg')).toHaveLength(1)
    expect(model.errors).toEqual([])
    const requests = model.requests
    expect(requests).toHaveLength(12)
    for (const request of requests) {
      const batch = readModelFixtureBatch(request)
      if (!batch) throw new Error('Missing current native batch envelope')
      expect(Object.keys(batch.payload).sort()).toEqual(batch.kind === 'root' ? ['context', 'eating', 'events'] : ['context', 'eating', 'events', 'task'])
    }
    const rootRequests = requests.filter(request => request.tools?.some(tool => tool.function?.name === 'eating_delegate_task'))
    expect(rootRequests.every(request => request.tools?.length === 2)).toBe(true)
    expect(requests.filter(request => request.tools?.some(tool => tool.function?.name === 'mcp__qq__qq_send_private_message')).every(request => !request.tools?.some(tool => tool.function?.name === 'mcp__qq__qq_send_group_message'))).toBe(true)
    expect(JSON.stringify(rootRequests.flatMap(request => request.messages?.filter(message => message.role === 'tool') ?? []))).toContain('succeeded')
  }, 90000)

  it('lets the main Agent query then send through two native calls in one verified batch using the same child', async () => {
    const home = await isolatedHome()
    const systemDsh = () => testSystemDsh(resolve(runtimeDirectory!))
    const onebot = await startOneBotFixture(); cleanups.push(() => onebot.close())
    let contextRef = ''
    const model = await modelFixture((request, index) => {
      if (index === 0) {
        for (const message of request.messages ?? []) {
          if (message.role !== 'user') continue
          try { const payload: unknown = JSON.parse(String(message.content)); if (isJsonObject(payload) && isJsonObject(payload.context) && typeof payload.context.contextRef === 'string') contextRef = payload.context.contextRef }
          catch { /* Other runtime user context is plain text. */ }
        }
        return { name: 'eating_delegate_task', arguments: { type_id: 'qq.private', context_ref: contextRef, task: '先查询此私聊对象资料，报告真实结果，不发送。' } }
      }
      if (index === 1) return { name: 'mcp__qq__qq_get_stranger_info', arguments: { user_id: '987654321' } }
      if (index === 2) return 'QUERY-SUMMARY：已查询当前私聊对象资料，下一步交主Agent决定。'
      if (index === 3) {
        const previous: unknown = JSON.parse(String(request.messages?.find(message => message.role === 'tool' && String(message.content).includes('QUERY-SUMMARY'))?.content))
        if (!isJsonObject(previous) || previous.status !== 'completed' || !Array.isArray(previous.actions) || previous.actions.length) throw new Error('Main Agent did not receive the completed query result before deciding to send')
        return { name: 'eating_delegate_task', arguments: { type_id: 'qq.private', context_ref: contextRef, task: '根据刚才查询的资料，向同一对象发送一次确认。' } }
      }
      if (index === 4) return { name: 'mcp__qq__qq_send_private_message', arguments: { user_id: '987654321', message: '同批分阶段委派确认', request_id: 'same-batch-stage-send-0001' } }
      if (index === 5) return 'SEND-SUMMARY：发送已获得真实QQ工具回执。'
      const sent: unknown = JSON.parse(String(request.messages?.find(message => message.role === 'tool' && String(message.content).includes('SEND-SUMMARY'))?.content))
      if (!isJsonObject(sent) || sent.status !== 'completed' || !Array.isArray(sent.actions) || sent.actions.length !== 1 || !isJsonObject(sent.actions[0]) || sent.actions[0].outcome !== 'succeeded') throw new Error('Main Agent did not receive the actual successful Host send receipt')
      return 'MAIN-FINAL：已核对查询和发送的分阶段结果。'
    })
    let plugin!: DshPlugin
    const entry: BackendPluginEntry = { id: 'dsh', kind: 'harness', storageDirectory: 'dsh', create(context) { plugin = new DshPlugin(context, { locateSystemDsh: systemDsh }); return plugin } }
    const host = new EatingHost({ dataDirectory: home, entries: [qqEntry, entry], port: 0, allowedUiOrigins: [] }); cleanups.push(() => host.close())
    const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const boot: unknown = await bootstrap.json(); if (!isJsonObject(boot)) throw new Error('Invalid bootstrap')
    const api = async (path: string, body: JsonObject) => {
      const response = await fetch(url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Eating-Csrf': String(boot.csrfToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const value: unknown = await response.json(); if (!response.ok) throw new Error(`Staged fixture API ${path}: ${JSON.stringify(value)}`)
    }
    await api('/plugins/qq/configuration', { endpoint: onebot.endpoint, timeoutMs: 1000, forwardToHarness: true, receiveGroups: true, autoConnect: false })
    await api('/plugins/qq/connect', {})
    await api('/plugins/dsh/configuration', { endpoint: model.endpoint, model: 'fixture-model', apiKey: 'staged-delegation-fixture-key', timeoutMs: 15000, maxTokens: 1024, autoConnect: false })
    await api('/plugins/dsh/connect', {})
    onebot.emitEvent({ post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 987654321, message_id: 99401, message: '请先查询再由主代理决定是否发送。' })
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !(host.harness.getStatus().accepted === 1 && plugin.isReady() && model.requests.length >= 7)) await new Promise<void>(accept => setTimeout(accept, 20))
    expect(plugin.getStatus().lastError).toBeNull()
    expect(model.requests).toHaveLength(7)
    expect(model.errors).toEqual([])
    expect(plugin.isReady()).toBe(true)
    const names = model.requests.map(request => request.tools?.map(tool => tool.function?.name) ?? [])
    expect(names[0]).toEqual(['eating_delegate_task', 'eating_list_agent_types'])
    expect(names[3]).toEqual(names[0])
    expect(names[6]).toEqual(names[0])
    expect(names[1]).toContain('mcp__qq__qq_get_stranger_info')
    expect(names[4]).toContain('mcp__qq__qq_send_private_message')
    expect(JSON.stringify(model.requests[2]?.messages)).toContain('夹具陌生人')
    const firstParentTools = model.requests[3]!.messages!.filter(message => message.role === 'tool')
    const finalParentTools = model.requests[6]!.messages!.filter(message => message.role === 'tool')
    const firstResult = JSON.parse(String(firstParentTools.find(message => String(message.content).includes('QUERY-SUMMARY'))?.content)) as Record<string, unknown>
    const secondResult = JSON.parse(String(finalParentTools.find(message => String(message.content).includes('SEND-SUMMARY'))?.content)) as Record<string, unknown>
    expect(firstResult.status).toBe('completed')
    expect(firstResult.actions).toEqual([])
    expect(secondResult.status).toBe('completed')
    expect(secondResult.childId).toBe(firstResult.childId)
    expect(secondResult.actions).toEqual([expect.objectContaining({ tool: 'qq_send_private_message', outcome: 'succeeded', result: expect.objectContaining({ message_id: expect.any(Number) }) })])
    expect(onebot.requests.filter(request => request.action === 'get_stranger_info')).toHaveLength(1)
    expect(onebot.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(1)
    const list = await plugin.manage('list-sessions', {})
    expect(list).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ id: firstResult.childId, agentTypeId: 'qq.private' })]) })
    if (!isJsonObject(list) || !Array.isArray(list.sessions)) throw new Error('Missing native session list')
    expect(list.sessions).toHaveLength(2)
    const bindings: unknown = JSON.parse(await readFile(join(home, 'harness/dsh/agent-bindings.json'), 'utf8'))
    if (!isJsonObject(bindings) || !Array.isArray(bindings.bindings) || !isJsonObject(bindings.bindings[0])) throw new Error('Missing staged binding')
    expect(bindings.schemaVersion).toBe(2)
    expect(bindings.bindings[0].taskRefs).toEqual([expect.objectContaining({ contextRef, state: 'completed' }), expect.objectContaining({ contextRef, state: 'completed' })])
    const taskRefs = bindings.bindings[0].taskRefs
    if (!Array.isArray(taskRefs) || !isJsonObject(taskRefs[0]) || !isJsonObject(taskRefs[1])) throw new Error('Missing native call references')
    expect(taskRefs[0].taskId).not.toBe(taskRefs[1].taskId)
  }, 60000)
})
