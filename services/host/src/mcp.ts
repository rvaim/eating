import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { isJsonObject, PlatformError } from '../../../packages/platform-contract/src/index'
import type { BackendPlugin, PluginToolDefinition } from '../../../packages/platform-contract/src/index'

function describeTool(tool: PluginToolDefinition): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    // The plugin publishes its JSON Schema and owns argument validation in invoke().
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
  }
}

function toolError(error: unknown, requestId?: string): CallToolResult {
  const failure = error instanceof PlatformError
    ? { code: error.code, outcome: error.outcome, message: error.message }
    : { code: 'INTERNAL_ERROR', outcome: 'unknown', message: '插件工具执行失败。' }
  const structuredContent = { ...failure, ...(requestId ? { request_id: requestId } : {}) }
  return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] }
}

function createServer(plugin: BackendPlugin): Server {
  const server = new Server(
    { name: plugin.id, title: plugin.name, version: plugin.version },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: plugin.tools.map(describeTool) }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = plugin.tools.find(entry => entry.name === params.name)
    if (!tool) return toolError(new PlatformError('TOOL_NOT_FOUND', '此插件未提供所请求的工具。', 404, 'not-sent'))

    const args = params.arguments ?? {}
    const acceptsRequestId = isJsonObject(tool.inputSchema.properties) && Object.hasOwn(tool.inputSchema.properties, 'request_id')
    if (!tool.readOnly && (!acceptsRequestId || typeof args.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(args.request_id))) {
      return toolError(new PlatformError('REQUEST_ID_REQUIRED', '此工具必须声明 request_id，且调用方需提供8至128位合法稳定标识；重试必须复用原值。', 400, 'not-sent'))
    }
    // Side-effect keys must survive lost responses; never invent one for the caller.
    // JSON-RPC IDs are local to a client connection, never persistent action keys.
    const requestId = acceptsRequestId && typeof args.request_id === 'string' ? args.request_id : randomUUID()
    const input = acceptsRequestId && args.request_id === undefined ? { ...args, request_id: requestId } : args
    try {
      const result = await plugin.invoke(tool.name, input, requestId)
      return {
        isError: false,
        structuredContent: { result, request_id: requestId },
        content: [{ type: 'text', text: JSON.stringify(result) }],
      }
    } catch (error) {
      // Unexpected exceptions may contain credentials, request headers or stacks.
      // Only the plugin's intentional public PlatformError crosses this boundary.
      return toolError(error, requestId)
    }
  })
  return server
}

function httpError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(message)
}

/** Host authenticates and validates the HTTP boundary before calling this handler. */
export function createPluginMcpHandler(plugin: BackendPlugin): {
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>
  close(): Promise<void>
} {
  const active = new Set<() => Promise<void>>()
  let closed = false
  let closePromise: Promise<void> | undefined

  return {
    async handle(req, res, body) {
      if (closed) { httpError(res, 503, '插件 MCP 入口已关闭。', { Connection: 'close' }); return }
      // No standalone SSE stream or session exists in this stateless JSON endpoint.
      if (req.method !== 'POST') { httpError(res, 405, '此 MCP 入口仅接受 POST 请求。', { Allow: 'POST' }); return }

      const server = createServer(plugin)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      let cleanupPromise: Promise<void> | undefined
      let signalStopped!: () => void
      const stopped = new Promise<void>(resolve => { signalStopped = resolve })
      const cleanup = (destroyResponse = false): Promise<void> => {
        if (destroyResponse && !res.destroyed) res.destroy()
        if (cleanupPromise) return cleanupPromise
        req.off('aborted', onDisconnect)
        res.off('close', onDisconnect)
        res.off('error', onDisconnect)
        res.off('finish', onFinish)
        signalStopped()
        // Assign before closing: SDK close callbacks may run synchronously.
        cleanupPromise = Promise.resolve().then(async () => {
          try { await server.close() }
          finally { await transport.close() }
        }).finally(() => { active.delete(stop) })
        return cleanupPromise
      }
      const onCleanupError = () => { if (!res.destroyed) res.destroy() }
      const onFinish = () => { void cleanup().catch(onCleanupError) }
      const onDisconnect = () => { void cleanup(true).catch(onCleanupError) }
      const stop = () => cleanup(true)
      active.add(stop)
      req.once('aborted', onDisconnect)
      res.once('close', onDisconnect)
      res.once('error', onDisconnect)
      res.once('finish', onFinish)

      try {
        if (req.aborted || res.destroyed) { await stop(); return }
        await server.connect(transport)
        if (closed || cleanupPromise) { await stop(); return }
        // SDK JSON mode can remain pending after transport.close(); shutdown and
        // disconnection must still release the Host's request handler immediately.
        await Promise.race([transport.handleRequest(req, res, body), stopped])
      } catch {
        httpError(res, 500, 'MCP 请求处理失败。')
      } finally {
        await cleanup()
      }
    },
    close() {
      closed = true
      closePromise ??= Promise.all([...active].map(stop => stop())).then(() => undefined)
      return closePromise
    },
  }
}
