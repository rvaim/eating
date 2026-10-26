import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import type { BackendPlugin, BackendPluginEntry, HostPluginContext, JsonObject } from '../../../packages/platform-contract/src/index'
import { PlatformError, isJsonObject } from '../../../packages/platform-contract/src/index'
import { HostStore } from './store'
import { HarnessGateway } from './harness'
import { acquireWorkspaceLock } from './lock'
import { persistedEnabledIds } from './discovery'
import { failedPlugin } from './failed-plugin'
import { createPluginMcpHandler } from './mcp'
import { SESSION_COOKIE, getBearer, json, readJson, requireSession, safeError, sameSecret, secret, validateLocalRequest } from './security'

export interface HostOptions {
  readonly dataDirectory: string
  readonly entries: readonly BackendPluginEntry[]
  readonly port?: number
  readonly allowedUiOrigins?: readonly string[]
  readonly staticDirectory?: string
}

export class EatingHost {
  readonly store: HostStore
  readonly harness: HarnessGateway
  private readonly server: Server
  private readonly plugins = new Map<string, BackendPlugin>()
  private readonly enabled = new Set<string>()
  private readonly mcp = new Map<string, ReturnType<typeof createPluginMcpHandler>>()
  private readonly ownerSession = secret()
  private readonly csrf = secret()
  private readonly releaseLock: () => void
  private readonly allowedOrigins: Set<string>
  private readonly allowedHosts = new Set<string>()
  private readonly mutations = new Set<string>()
  private url = ''
  private closed = false

  constructor(private readonly options: HostOptions) {
    this.releaseLock = acquireWorkspaceLock(resolve(options.dataDirectory, 'host'))
    let openedStore: HostStore | undefined
    try {
      this.store = openedStore = new HostStore(resolve(options.dataDirectory, 'host', 'Eating.sqlite'))
      this.harness = new HarnessGateway(this.store)
      const enabledIds = persistedEnabledIds(this.store.getSetting('platforms.enabled'), options.entries.map(entry => entry.id))
      const storageDirectories = new Set<string>()
      for (const entry of options.entries) {
        if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || this.plugins.has(entry.id) || !/^[a-z][a-z0-9-]*-bot$/.test(entry.storageDirectory)) throw new Error('平台标识或 bot 目录声明非法。')
        if (storageDirectories.has(entry.storageDirectory)) throw new Error('平台 bot 数据目录重复，拒绝共同写入。')
        storageDirectories.add(entry.storageDirectory)
        const context: HostPluginContext = {
          dataDirectory: resolve(options.dataDirectory, 'bot', entry.storageDirectory),
          getSetting: key => this.store.getSetting(`${entry.id}:${key}`),
          setSetting: (key, value) => this.store.setSetting(`${entry.id}:${key}`, value),
          recordEvent: (pluginId, key, event, harnessEvent, metadata) => {
            if (pluginId !== entry.id) throw new PlatformError('PLUGIN_SCOPE_VIOLATION', '插件不能写入其他平台事件。', 403)
            const result = this.store.recordEvent(pluginId, key, event, harnessEvent, metadata)
            if (result.inserted && harnessEvent) this.harness.notify()
            return result
          },
          listMessages: (pluginId, filters) => {
            if (pluginId !== entry.id) throw new PlatformError('PLUGIN_SCOPE_VIOLATION', '插件不能读取其他平台消息。', 403)
            return this.store.listMessages(pluginId, filters)
          },
          executeIdempotent: (pluginId, action, params, requestId, execute, scope) => {
            if (pluginId !== entry.id) throw new PlatformError('PLUGIN_SCOPE_VIOLATION', '插件不能使用其他平台动作权限。', 403)
            return this.store.executeIdempotent(pluginId, action, params, requestId, execute, scope)
          },
        }
        let plugin: BackendPlugin
        try { plugin = entry.create(context) }
        catch (error) { plugin = failedPlugin(entry, error) }
        if (plugin.id !== entry.id) throw new Error('插件后台身份不匹配。')
        this.plugins.set(plugin.id, plugin)
        if (enabledIds.includes(plugin.id)) this.enabled.add(plugin.id)
      }
      this.allowedOrigins = new Set(options.allowedUiOrigins ?? ['http://127.0.0.1:5180', 'http://localhost:5180', 'http://127.0.0.1:4180'])
      for (const origin of this.allowedOrigins) this.allowedHosts.add(new URL(origin).host)
      this.server = createServer((request, response) => { void this.route(request, response) })
    } catch (error) { openedStore?.close(); this.releaseLock(); throw error }
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolveListen, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port ?? 5181, '127.0.0.1', () => { this.server.off('error', reject); resolveListen() })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Host 未取得监听地址。')
    this.url = `http://127.0.0.1:${address.port}`
    this.allowedHosts.add(`127.0.0.1:${address.port}`)
    this.allowedHosts.add(`localhost:${address.port}`)
    this.allowedOrigins.add(this.url)
    for (const plugin of this.plugins.values()) {
      if (this.enabled.has(plugin.id) && plugin.getPublicConfiguration().autoConnect === true) void plugin.connect().catch(() => { /* The connector exposes the actual error in getStatus(). */ })
    }
    return this.url
  }

  getWorkspace(): JsonObject {
    return { protocolVersion: 1, registeredIds: [...this.enabled],
      plugins: [...this.plugins.values()].map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version,
        enabled: this.enabled.has(plugin.id), configuration: plugin.getPublicConfiguration(),
        status: plugin.getStatus(), capabilities: plugin.capabilities, tools: plugin.tools })),
      harness: this.harness.getStatus(),
    } as unknown as JsonObject
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.closed) throw new PlatformError('HOST_STOPPED', 'Host 正在停止。', 503)
      validateLocalRequest(request, this.allowedHosts, this.allowedOrigins)
      const pathname = new URL(request.url ?? '/', this.url || 'http://127.0.0.1').pathname
      if (pathname.startsWith('/mcp/')) {
        const id = pathname.slice('/mcp/'.length)
        const plugin = this.requirePlugin(id, true)
        if (!sameSecret(getBearer(request), this.getMcpToken(id))) throw new PlatformError('MCP_UNAUTHENTICATED', 'MCP 访问令牌无效。', 401)
        let handler = this.mcp.get(id)
        if (!handler) { handler = createPluginMcpHandler(plugin); this.mcp.set(id, handler) }
        await handler.handle(request, response, request.method === 'POST' ? await readJson(request) : undefined)
        return
      }
      if (pathname === '/api/bootstrap' && request.method === 'GET') {
        response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${this.ownerSession}; HttpOnly; SameSite=Strict; Path=/api`)
        json(response, 200, { protocolVersion: 1, csrfToken: this.csrf })
        return
      }
      if (pathname.startsWith('/api/')) {
        requireSession(request, this.ownerSession)
        if (request.method !== 'GET' && !sameSecret(typeof request.headers['x-eating-csrf'] === 'string' ? request.headers['x-eating-csrf'] : undefined, this.csrf)) throw new PlatformError('INVALID_CSRF_TOKEN', '管理请求校验失败，请刷新页面。', 403)
        if (pathname === '/api/workspace' && request.method === 'GET') { json(response, 200, this.getWorkspace()); return }
        const match = /^\/api\/plugins\/([a-z][a-z0-9-]*)\/(configuration|connect|disconnect|enable|disable|invoke|mcp-registration)$/.exec(pathname)
        if (!match) throw new PlatformError('NOT_FOUND', '接口不存在。', 404)
        const id = match[1]!
        const operation = match[2]!
        const plugin = this.requirePlugin(id, !['enable', 'disable', 'configuration'].includes(operation))
        if (request.method === 'GET' && operation === 'configuration') { json(response, 200, plugin.getPublicConfiguration()); return }
        if (request.method !== 'POST') throw new PlatformError('METHOD_NOT_ALLOWED', '此接口需使用 POST。', 405)
        const body = await readJson(request)
        if (operation === 'invoke') {
          if (!isJsonObject(body) || typeof body.name !== 'string' || !isJsonObject(body.arguments) || typeof body.requestId !== 'string') throw new PlatformError('INVALID_INPUT', '工具调用参数不完整。')
          const tool = plugin.tools.find(entry => entry.name === body.name)
          if (!tool) throw new PlatformError('TOOL_NOT_FOUND', '平台未提供该功能。', 404)
          if (!tool.readOnly && body.confirmed !== true) throw new PlatformError('ACTION_CONFIRMATION_REQUIRED', '发送或撤回会影响真实 QQ，请确认目标和内容。', 409)
          const args = { ...body.arguments }
          if (isJsonObject(tool.inputSchema.properties) && tool.inputSchema.properties.request_id !== undefined && args.request_id === undefined) args.request_id = body.requestId
          const result = await plugin.invoke(body.name, args, body.requestId)
          json(response, 200, { ok: true, requestId: body.requestId, result }); return
        }
        if (operation === 'mcp-registration') {
          const endpoint = `${this.url}/mcp/${id}`
          json(response, 200, { transport: 'streamable-http', url: endpoint,
            headers: { Authorization: `Bearer ${this.getMcpToken(id)}` },
            note: '这是插件 MCP 连接参数；尚未自动注册到 Harness。请仅交给可信的主 Harness。' }); return
        }
        if (this.mutations.has(id)) throw new PlatformError('PLUGIN_BUSY', '平台正在变更连接或配置，请稍后重试。', 409)
        this.mutations.add(id)
        try {
          if (operation === 'configuration') json(response, 200, await plugin.updateConfiguration(body))
          else if (operation === 'connect') { await plugin.connect(); json(response, 200, plugin.getStatus()) }
          else if (operation === 'disconnect') { await plugin.disconnect(); json(response, 200, plugin.getStatus()) }
          else if (operation === 'enable') { await this.setEnabled(id, true); json(response, 200, { ok: true }) }
          else if (operation === 'disable') { await this.setEnabled(id, false); json(response, 200, { ok: true }) }
        } finally { this.mutations.delete(id) }
        return
      }
      if (request.method === 'GET' && this.options.staticDirectory) { await this.serveStatic(pathname, response); return }
      throw new PlatformError('NOT_FOUND', '接口不存在。', 404)
    } catch (error) {
      if (response.headersSent || response.destroyed) { if (!response.writableEnded) response.end(); return }
      const failure = safeError(error)
      json(response, failure.statusCode, { ok: false, error: { code: failure.code, message: failure.message, outcome: failure.outcome } })
    }
  }

  private requirePlugin(id: string, requireEnabled: boolean): BackendPlugin {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new PlatformError('PLUGIN_NOT_FOUND', '平台插件不存在。', 404)
    if (requireEnabled && !this.enabled.has(id)) throw new PlatformError('PLUGIN_DISABLED', '平台插件已停用。', 409, 'not-sent')
    return plugin
  }

  private getMcpToken(id: string): string {
    const key = `${id}:mcp-token`
    const existing = this.store.getSetting(key)
    if (existing) return existing
    const token = secret(); this.store.setSetting(key, token); return token
  }

  private async setEnabled(id: string, enabled: boolean): Promise<void> {
    const next = new Set(this.enabled)
    if (enabled) next.add(id)
    else {
      await this.plugins.get(id)?.disconnect()
      await this.mcp.get(id)?.close()
      this.mcp.delete(id)
      next.delete(id)
    }
    this.store.setSetting('platforms.enabled', JSON.stringify({ version: 1, ids: [...next] }))
    this.enabled.clear(); for (const entry of next) this.enabled.add(entry)
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const directory = resolve(this.options.staticDirectory!)
    const path = pathname === '/' ? resolve(directory, 'index.html') : resolve(directory, `.${pathname}`)
    if (path !== directory && !path.startsWith(directory + sep)) throw new PlatformError('INVALID_PATH', '非法资源路径。', 403)
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
    try {
      const bytes = await readFile(path)
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" })
      response.end(bytes)
    } catch { throw new PlatformError('NOT_FOUND', '页面资源不存在，请先构建前端。', 404) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const stopped = new Promise<void>(resolveClose => this.server.listening ? this.server.close(() => resolveClose()) : resolveClose())
    this.server.closeIdleConnections()
    await Promise.allSettled([...this.plugins.values()].map(plugin => plugin.dispose()))
    await Promise.allSettled([...this.mcp.values()].map(handler => handler.close()))
    await this.harness.close()
    await stopped
    this.store.close()
    this.releaseLock()
  }
}

export function newRequestId(): string { return randomUUID() }
