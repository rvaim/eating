import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { AndroidEngine, resultContent } from './engine'
import { locateAdb } from './config'
import { failure, object, readDocument, text } from './files'
import { androidTools } from './tools'

const internal = ['android_executor_state', 'android_executor_release', 'android_executor_takeover', 'android_executor_prune']
export async function startAndroidExecutor(configFile: string) {
  const config = object(readDocument(configFile), ['schemaVersion', 'host', 'port', 'token', 'adbPath', 'workspace'], ['schemaVersion', 'host', 'port', 'token', 'adbPath', 'workspace'])
  if (config.schemaVersion !== 1 || !text(config.host) || !config.host || !Number.isSafeInteger(config.port) || Number(config.port) < 0 || Number(config.port) > 65535 || !text(config.token, 256) || !/^[A-Za-z0-9_-]{32,256}$/.test(config.token) || !text(config.adbPath) || !text(config.workspace)) throw failure('ANDROID_CONFIGURATION_INVALID')
  const engine = new AndroidEngine(join(dirname(configFile), 'executor-state'), locateAdb(config.adbPath), config.workspace)
  const server = createServer((request, response) => {
    void (async () => {
      const header = request.headers.authorization, expected = 'Bearer ' + config.token
      if (typeof header !== 'string' || header.length !== expected.length || !timingSafeEqual(Buffer.from(header), Buffer.from(expected))) { response.writeHead(401); response.end(); return }
      if (request.url !== '/mcp' || request.method !== 'POST') { response.writeHead(405); response.end(); return }
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw failure('ANDROID_ARGUMENTS_INVALID'); chunks.push(Buffer.from(chunk)) }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const mcp = new Server({ name: 'eating-android-executor', version: '0.2.0' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...androidTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...internal.map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }))] }))
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        try {
          const meta = params._meta, actor = isJsonObject(meta) && typeof meta.actor_id === 'string' ? meta.actor_id : ''
          if (!/^[A-Za-z0-9_-]{1,160}$/.test(actor)) throw failure('ANDROID_ACCESS_REVOKED')
          if (params.name === 'android_executor_state') return resultContent(engine.list())
          if (params.name === 'android_executor_release') { await engine.revoke(actor); return resultContent({ released: true }) }
          if (params.name === 'android_executor_takeover') { await engine.takeover(); return resultContent({ released: true }) }
          if (params.name === 'android_executor_prune') return resultContent(engine.prune())
          if (!androidTools.some(tool => tool.name === params.name)) throw failure('TOOL_NOT_FOUND')
          const args = params.arguments ?? {}, id = isJsonObject(meta) && typeof meta.request_id === 'string' ? meta.request_id : ''
          if (!id || !isJsonObject(args)) throw failure('ANDROID_ARGUMENTS_INVALID')
          return await engine.invoke(params.name, args, actor, id)
        } catch (error) {
          const known = error instanceof PlatformError
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: known ? error.code : 'ANDROID_EXECUTOR_FAILED', message: known ? error.message : '执行端请求未完成。', outcome: known ? error.outcome : 'unknown' }) }] }
        }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      try { await mcp.connect(transport); await transport.handleRequest(request, response, body) } finally { await transport.close(); await mcp.close() }
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end() })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(Number(config.port), String(config.host), accept) })
  return { engine, server, address: server.address(), close: async () => { await engine.close(); const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); server.closeAllConnections(); await closed } }
}

export class RemoteExecutor {
  private readonly client = new Client({ name: 'eating-android-control', version: '0.2.0' }, { capabilities: {} })
  private readonly transport: StreamableHTTPClientTransport
  constructor(endpoint: string, token: string) { this.transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }) }
  async connect(): Promise<void> {
    await this.client.connect(this.transport)
    const tools = (await this.client.listTools()).tools
    if (JSON.stringify(tools.map(t => t.name).sort()) !== JSON.stringify([...androidTools.map(t => t.name), ...internal].sort())) throw failure('ANDROID_EXECUTOR_PROTOCOL_INVALID', '远程执行端工具版本不匹配。', 'not-sent', 409)
  }
  async invoke(name: string, args: JsonObject, actorId: string, requestId: string = randomUUID(), signal?: AbortSignal): Promise<JsonObject> {
    const result = await this.client.callTool({ name, arguments: args, _meta: { actor_id: actorId, request_id: requestId } }, undefined, { timeout: 45000, ...(signal ? { signal } : {}) })
    if (result.isError) {
      const block = Array.isArray(result.content) ? result.content.find(item => isJsonObject(item) && item.type === 'text') : undefined
      let value: unknown; try { value = isJsonObject(block) && typeof block.text === 'string' ? JSON.parse(block.text) : undefined } catch { /* Invalid remote responses remain explicit failures. */ }
      if (isJsonObject(value) && typeof value.code === 'string' && typeof value.message === 'string' && ['not-sent', 'failed', 'unknown'].includes(String(value.outcome))) throw failure(value.code, value.message, value.outcome as 'unknown', 502)
      throw failure('ANDROID_EXECUTOR_FAILED', '远程执行结果未能确认，请查询原request_id或进程。', 'unknown', 502)
    }
    const content = result.content, structured = result.structuredContent
    if (!Array.isArray(content) || !content.length) throw failure('ANDROID_EXECUTOR_PROTOCOL_INVALID', '远程执行端响应格式无效。', 'unknown', 502)
    return { content: content as JsonValue[], ...(isJsonObject(structured) ? { structuredContent: structured } : {}) }
  }
  async close(): Promise<void> { await this.client.close() }
}
