import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import type { BackendPlugin, BackendPluginEntry, HarnessHostServices, HarnessMessageSink, HostPluginContext, JsonObject } from '@eating/plugin-sdk'
import { PlatformError, isJsonObject, validateDeliverySettings } from '@eating/plugin-sdk'
import { AuthoringService } from './authoring'
import { HostStore } from './store'
import { HarnessGateway } from './harness'
import { acquireWorkspaceLock } from './lock'
import { persistedEnabledIds } from './discovery'
import { failedPlugin } from './failed-plugin'
import { createPluginMcpHandler } from './mcp'
import { servePluginLogStream } from './plugin-log-stream'
import { SESSION_COOKIE, getBearer, json, readJson, requireSession, safeError, sameSecret, secret, validateLocalRequest } from './security'

export interface HostOptions {
  readonly dataDirectory: string
  readonly entries: readonly BackendPluginEntry[]
  readonly port?: number
  readonly allowedUiOrigins?: readonly string[]
  readonly staticDirectory?: string
  readonly workspaceLock?: () => void
}

export class EatingHost {
  readonly store: HostStore
  readonly harness: HarnessGateway
  readonly authoring: AuthoringService
  private readonly server: Server
  private readonly plugins = new Map<string, BackendPlugin>()
  private readonly entries = new Map<string, BackendPluginEntry>()
  private readonly enabled = new Set<string>()
  private readonly logStreams = new Map<string, Set<() => void>>()
  private readonly mcp = new Map<string, ReturnType<typeof createPluginMcpHandler>>()
  private readonly ownerSession = secret()
  private readonly csrf = secret()
  private readonly releaseLock: () => void
  private readonly allowedOrigins: Set<string>
  private readonly allowedHosts = new Set<string>()
  private readonly mutations = new Map<string, string>()
  private readonly sinkRegistrations = new Map<string, Set<() => void>>()
  private url = ''
  private closed = false

  constructor(private readonly options: HostOptions) {
    this.releaseLock = options.workspaceLock ?? acquireWorkspaceLock(resolve(options.dataDirectory, 'host'))
    let openedStore: HostStore | undefined
    try {
      this.store = openedStore = new HostStore(resolve(options.dataDirectory, 'host', 'Eating.sqlite'))
      this.harness = new HarnessGateway(this.store)
      this.authoring = new AuthoringService(this.store)
      const enabledIds = persistedEnabledIds(this.store.getSetting('platforms.enabled'), options.entries.map(entry => entry.id))
      const storageDirectories = new Set<string>()
      for (const entry of options.entries) {
        const kind = entry.installed?.manifest.kind ?? entry.kind ?? 'communication'
        const validId = (value: string) => value.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)
        if (!validId(entry.id) || this.entries.has(entry.id) || !validId(entry.storageDirectory)
          || !['communication', 'harness'].includes(kind) || (kind === 'communication' && !entry.storageDirectory.endsWith('-bot'))) throw new Error('插件标识、类型或数据目录声明非法。')
        const storageKey = `${kind}/${entry.storageDirectory}`
        if (storageDirectories.has(storageKey)) throw new Error('插件数据目录重复，拒绝共同写入。')
        storageDirectories.add(storageKey)
        this.entries.set(entry.id, entry)
        if (enabledIds.includes(entry.id)) this.enabled.add(entry.id)
        const context: HostPluginContext = {
          ...(kind === 'harness' ? { harness: this.harnessServices(entry.id) } : {}),
          dataDirectory: resolve(options.dataDirectory, kind === 'harness' ? 'harness' : 'bot', entry.storageDirectory),
          getSetting: key => this.store.getSetting(`${entry.id}:${key}`),
          setSetting: (key, value) => this.store.setSetting(`${entry.id}:${key}`, value),
          recordEvent: (pluginId, key, event, harnessEvent, metadata) => {
            if (pluginId !== entry.id) throw new PlatformError('PLUGIN_SCOPE_VIOLATION', '插件不能写入其他平台事件。', 403)
            const result = this.store.recordEvent(pluginId, key, event, harnessEvent, metadata)
            if (result.inserted && harnessEvent && result.queued !== false) this.harness.notify()
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
        catch (error) { this.revokeHarnessSinks(entry.id); plugin = failedPlugin(entry, error) }
        if (plugin.id !== entry.id) throw new Error('插件后台身份不匹配。')
        this.plugins.set(plugin.id, plugin)
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
      if (this.enabled.has(plugin.id) && plugin.getPublicConfiguration().autoConnect === true) void this.mutatePlugin(plugin.id, 'connect', () => plugin.connect()).catch(() => { /* The connector exposes the actual error in getStatus(). */ })
    }
    return this.url
  }

  getWorkspace(): JsonObject {
    return { protocolVersion: 1, registeredIds: [...this.enabled],
      plugins: [...this.plugins.values()].map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version, kind: this.pluginKind(plugin.id),
        enabled: this.enabled.has(plugin.id), logsSupported: Boolean(plugin.logs), logViewerCount: this.logStreams.get(plugin.id)?.size ?? 0, configuration: plugin.getPublicConfiguration(), frontend: this.frontendContribution(plugin.id),
        status: plugin.getStatus(), capabilities: plugin.capabilities, tools: plugin.tools })),
      harness: this.harness.getStatus(),
    } as unknown as JsonObject
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.closed) {
        response.setHeader('Connection', 'close')
        throw new PlatformError('HOST_STOPPED', 'Host 正在停止。', 503)
      }
      validateLocalRequest(request, this.allowedHosts, this.allowedOrigins)
      const pathname = new URL(request.url ?? '/', this.url || 'http://127.0.0.1').pathname
      if (pathname.startsWith('/mcp/')) {
        const id = pathname.slice('/mcp/'.length)
        const plugin = this.requirePlugin(id, true)
        if (!sameSecret(getBearer(request), this.getMcpToken(id))) throw new PlatformError('MCP_UNAUTHENTICATED', 'MCP 访问令牌无效。', 401)
        let handler = this.mcp.get(id)
        if (!handler) { handler = createPluginMcpHandler(plugin); this.mcp.set(id, handler) }
        await handler.handle(request, response, request.method === 'POST' ? await readJson(request, 1024 * 1024) : undefined)
        return
      }
      if (request.method === 'GET' && pathname.startsWith('/plugins/')) { await this.servePluginAsset(pathname, response); return }
      if (pathname === '/api/bootstrap' && request.method === 'GET') {
        response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${this.ownerSession}; HttpOnly; SameSite=Strict; Path=/api`)
        json(response, 200, { protocolVersion: 1, csrfToken: this.csrf })
        return
      }
      if (pathname.startsWith('/api/')) {
        requireSession(request, this.ownerSession)
        if (request.method !== 'GET' && !sameSecret(typeof request.headers['x-eating-csrf'] === 'string' ? request.headers['x-eating-csrf'] : undefined, this.csrf)) throw new PlatformError('INVALID_CSRF_TOKEN', '管理请求校验失败，请刷新页面。', 403)
        if (pathname === '/api/workspace' && request.method === 'GET') { json(response, 200, this.getWorkspace()); return }
        if (pathname === '/api/authoring') {
          if (request.method !== 'GET') throw new PlatformError('METHOD_NOT_ALLOWED', '配置目录仅支持 GET。', 405)
          json(response, 200, this.authoring.getSnapshot()); return
        }
        const promptMatch = /^\/api\/prompts\/(main|group|private)$/.exec(pathname)
        if (promptMatch) {
          if (request.method !== 'POST') throw new PlatformError('METHOD_NOT_ALLOWED', '保存提示词需使用 POST。', 405)
          const input = await readJson(request)
          if (!isJsonObject(input) || typeof input.body !== 'string' || typeof input.expectedRevision !== 'number') throw new PlatformError('INVALID_AUTHORING_REQUEST', '请提供提示词正文与版本。')
          json(response, 200, this.authoring.updatePrompt(promptMatch[1] as 'main' | 'group' | 'private', input.body, input.expectedRevision)); return
        }
        const personaMatch = /^\/api\/personas(?:\/([a-zA-Z0-9-]{1,80})(?:\/(activate|delete))?)?$/.exec(pathname)
        if (personaMatch) {
          const id = personaMatch[1], operation = personaMatch[2]
          if (id && !operation && request.method === 'GET') { json(response, 200, this.authoring.getPersona(id)); return }
          if (request.method !== 'POST') throw new PlatformError('METHOD_NOT_ALLOWED', '人格管理操作需使用 POST。', 405)
          const input = await readJson(request)
          if (!isJsonObject(input)) throw new PlatformError('INVALID_AUTHORING_REQUEST', '人格配置必须为对象。')
          if (!id) {
            if (typeof input.name !== 'string' || typeof input.body !== 'string') throw new PlatformError('INVALID_AUTHORING_REQUEST', '请提供人格名称和设定。')
            json(response, 201, this.authoring.createPersona(input.name, input.body)); return
          }
          if (typeof input.expectedRevision !== 'number') throw new PlatformError('INVALID_AUTHORING_REQUEST', '人格操作缺少版本，请重新读取。')
          if (operation === 'activate') {
            if (typeof input.enabled !== 'boolean') throw new PlatformError('INVALID_AUTHORING_REQUEST', '请明确选择启用或停用人格。')
            json(response, 200, this.authoring.setPersonaEnabled(id, input.enabled, input.expectedRevision)); return
          }
          if (operation === 'delete') {
            if (input.confirmed !== true) throw new PlatformError('PERSONA_DELETE_CONFIRMATION_REQUIRED', '请确认删除此人格配置。', 409)
            json(response, 200, this.authoring.deletePersona(id, input.expectedRevision)); return
          }
          if (typeof input.name !== 'string' || typeof input.body !== 'string') throw new PlatformError('INVALID_AUTHORING_REQUEST', '请提供人格名称和设定。')
          json(response, 200, this.authoring.updatePersona(id, input.name, input.body, input.expectedRevision)); return
        }
        if (pathname === '/api/settings' || pathname === '/api/settings/queue/clear') {
          if (pathname === '/api/settings' && request.method === 'GET') { json(response, 200, this.store.getDeliverySettingsSnapshot()); return }
          if (request.method !== 'POST') throw new PlatformError('METHOD_NOT_ALLOWED', '设置操作仅支持 GET 或 POST。', 405)
          const body = await readJson(request)
          if (!isJsonObject(body) || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new PlatformError('INVALID_SETTINGS_REQUEST', '设置请求缺少有效版本，请重新读取设置。')
          if (pathname.endsWith('/clear')) {
            if (body.confirmed !== true) throw new PlatformError('QUEUE_CLEAR_CONFIRMATION_REQUIRED', '请明确确认清空尚未投递及结果待核对的消息。', 409)
            if (body.expectedRevision !== this.store.getDeliverySettingsSnapshot().revision) throw new PlatformError('SETTINGS_REVISION_CONFLICT', '设置已被其他页面修改，请重新读取。', 409)
            const result = this.store.clearDeliveryQueue()
            this.harness.reconfigure()
            json(response, 200, result); return
          }
          const result = this.store.updateDeliverySettings(validateDeliverySettings(body.values), body.expectedRevision)
          this.harness.reconfigure()
          json(response, 200, result); return
        }
        const logMatch = /^\/api\/plugins\/([a-z][a-z0-9-]*)\/logs\/stream$/.exec(pathname)
        if (logMatch) {
          if (request.method !== 'GET') throw new PlatformError('METHOD_NOT_ALLOWED', '实时日志需使用 GET。', 405)
          const id = logMatch[1]!
          const plugin = this.requirePlugin(id, true)
          if (this.mutations.has(id)) throw new PlatformError('PLUGIN_BUSY', '插件正在变更，暂不能打开实时日志。', 409)
          if (!plugin.logs) throw new PlatformError('PLUGIN_LOGS_UNSUPPORTED', '此插件未提供实时日志。', 404)
          const streams = this.logStreams.get(id) ?? new Set<() => void>()
          if (streams.size >= 8) throw new PlatformError('TOO_MANY_LOG_VIEWERS', '此插件已打开过多日志页面，请先关闭其他页面。', 429)
          this.logStreams.set(id, streams)
          let stop: () => void = () => {}
          stop = servePluginLogStream(request, response, plugin.logs, () => { streams.delete(stop); if (!streams.size) this.logStreams.delete(id) })
          if (!response.destroyed && !response.writableEnded) streams.add(stop)
          return
        }
        const match = /^\/api\/plugins\/([a-z][a-z0-9-]*)\/(configuration|connect|disconnect|enable|disable|manage|invoke|mcp-registration)$/.exec(pathname)
        if (!match) throw new PlatformError('NOT_FOUND', '接口不存在。', 404)
        const id = match[1]!
        const operation = match[2]!
        const plugin = this.requirePlugin(id, !['enable', 'disable', 'configuration'].includes(operation))
        if (request.method === 'GET' && operation === 'configuration') { json(response, 200, plugin.getPublicConfiguration()); return }
        if (request.method !== 'POST') throw new PlatformError('METHOD_NOT_ALLOWED', '此接口需使用 POST。', 405)
        const body = await readJson(request, operation === 'invoke' ? 1024 * 1024 : undefined)
        if (operation === 'invoke') {
          if (!isJsonObject(body) || typeof body.name !== 'string' || !isJsonObject(body.arguments) || typeof body.requestId !== 'string') throw new PlatformError('INVALID_INPUT', '工具调用参数不完整。')
          const tool = plugin.tools.find(entry => entry.name === body.name)
          if (!tool) throw new PlatformError('TOOL_NOT_FOUND', '平台未提供该功能。', 404)
          if (!tool.readOnly && body.confirmed !== true) throw new PlatformError('ACTION_CONFIRMATION_REQUIRED', '此操作会影响真实账号、消息或群组，请确认目标和参数。', 409)
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
        await this.mutatePlugin(id, operation, async () => {
          if (operation === 'configuration') json(response, 200, await plugin.updateConfiguration(body))
          else if (operation === 'connect') { await plugin.connect(); json(response, 200, plugin.getStatus()) }
          else if (operation === 'disconnect') { this.revokeHarnessSinks(id); await plugin.disconnect(); json(response, 200, plugin.getStatus()) }
          else if (operation === 'enable') { await this.setEnabled(id, true); json(response, 200, { ok: true }) }
          else if (operation === 'disable') { await this.setEnabled(id, false); json(response, 200, { ok: true }) }
          else if (operation === 'manage') {
            if (!plugin.manage) throw new PlatformError('PLUGIN_MANAGEMENT_UNSUPPORTED', '此插件未提供管理操作。', 404)
            if (!isJsonObject(body) || typeof body.operation !== 'string' || !body.operation.trim()) throw new PlatformError('INVALID_INPUT', '请提供有效的插件管理操作。')
            json(response, 200, await plugin.manage(body.operation, body.input))
          }
        })
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

  private pluginKind(id: string): 'communication' | 'harness' {
    const entry = this.entries.get(id)
    return entry?.installed?.manifest.kind ?? entry?.kind ?? 'communication'
  }

  private requireHarnessAccess(id: string): void {
    if (this.closed) throw new PlatformError('HOST_STOPPED', 'Host 正在停止。', 503)
    if (!this.enabled.has(id)) throw new PlatformError('PLUGIN_DISABLED', 'Harness 插件已停用。', 409, 'not-sent')
  }

  private harnessServices(id: string): HarnessHostServices {
    return Object.freeze({
      registerSink: (sink: HarnessMessageSink) => {
        this.requireHarnessAccess(id)
        if (this.mutations.has(id) && this.mutations.get(id) !== 'connect') throw new PlatformError('PLUGIN_BUSY', '插件正在变更，暂不能登记 Harness 接收者。', 409)
        if (sink.id !== id) throw new PlatformError('PLUGIN_SCOPE_VIOLATION', 'Harness 接收者身份必须属于当前插件。', 403)
        const detach = this.harness.register({
          id,
          isReady: () => !this.closed && this.enabled.has(id) && (sink.isReady?.() ?? true),
          ...(typeof sink.deliverBatch === 'function' ? { deliverBatch: (batch, signal) => {
            this.requireHarnessAccess(id)
            return sink.deliverBatch!(batch, signal)
          } } satisfies Pick<HarnessMessageSink, 'deliverBatch'> : {}),
          ...(typeof sink.deliver === 'function' ? { deliver: (event, signal) => {
            this.requireHarnessAccess(id)
            return sink.deliver!(event, signal)
          } } satisfies Pick<HarnessMessageSink, 'deliver'> : {}),
        })
        const registrations = this.sinkRegistrations.get(id) ?? new Set<() => void>()
        this.sinkRegistrations.set(id, registrations)
        const unregister = () => {
          if (!registrations.delete(unregister)) return
          if (!registrations.size) this.sinkRegistrations.delete(id)
          detach()
        }
        registrations.add(unregister)
        return unregister
      },
      wake: () => {
        if (!this.closed && this.enabled.has(id) && this.sinkRegistrations.get(id)?.size) this.harness.notify()
      },
      readOwnerConfiguration: () => {
        this.requireHarnessAccess(id)
        const snapshot = this.authoring.getSnapshot()
        return Object.freeze({ revision: snapshot.revision,
          prompts: Object.freeze(snapshot.prompts.map(prompt => Object.freeze({ ...prompt }))),
          activePersona: snapshot.activePersonaId ? Object.freeze({ ...this.authoring.getPersona(snapshot.activePersonaId) }) : null,
        })
      },
      getMcpConnection: (pluginId: string) => {
        this.requireHarnessAccess(id)
        if (!this.url) throw new PlatformError('HOST_NOT_LISTENING', 'Host 尚未监听，无法登记 MCP 连接。', 503)
        this.requirePlugin(pluginId, true)
        if (this.pluginKind(pluginId) !== 'communication') throw new PlatformError('PLUGIN_SCOPE_VIOLATION', 'Harness 仅可取得已启用通讯插件的 MCP 连接。', 403)
        return Object.freeze({ url: `${this.url}/mcp/${pluginId}`, headers: Object.freeze({ Authorization: `Bearer ${this.getMcpToken(pluginId)}` }) })
      },
    })
  }

  private revokeHarnessSinks(id: string): void {
    for (const unregister of this.sinkRegistrations.get(id) ?? []) unregister()
    this.sinkRegistrations.delete(id)
  }

  private async mutatePlugin<T>(id: string, operation: string, run: () => Promise<T>): Promise<T> {
    if (this.mutations.has(id)) throw new PlatformError('PLUGIN_BUSY', '插件正在变更连接或配置，请稍后重试。', 409)
    this.mutations.set(id, operation)
    try { return await run() }
    finally { this.mutations.delete(id) }
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
    else next.delete(id)
    this.store.setSetting('platforms.enabled', JSON.stringify({ version: 1, ids: [...next] }))
    this.enabled.clear(); for (const entry of next) this.enabled.add(entry)
    if (!enabled) {
      for (const stop of this.logStreams.get(id) ?? []) stop()
      this.logStreams.delete(id)
      this.revokeHarnessSinks(id)
      try { await this.plugins.get(id)?.disconnect() }
      finally {
        try { await this.mcp.get(id)?.close() }
        finally { this.mcp.delete(id) }
      }
    }
  }

  private frontendContribution(id: string): JsonObject | null {
    const installed = this.entries.get(id)?.installed
    if (!installed) return null
    const prefix = `/plugins/${id}/${installed.manifest.version}/`
    return { entry: prefix + installed.manifest.frontend.entry, style: prefix + installed.manifest.frontend.style }
  }

  private async servePluginAsset(pathname: string, response: ServerResponse): Promise<void> {
    const match = /^\/plugins\/([a-z][a-z0-9-]*)\/([^/]+)\/(.+)$/.exec(pathname)
    const installed = match ? this.entries.get(match[1]!)?.installed : undefined
    if (!match || !installed || match[2] !== installed.manifest.version) throw new PlatformError('NOT_FOUND', '插件资源不存在。', 404)
    const name = match[3]!
    const frontend = installed.manifest.frontend
    if (name !== frontend.entry && name !== frontend.style) throw new PlatformError('NOT_FOUND', '插件未声明此页面资源。', 404)
    const path = resolve(installed.directory, name)
    if (!path.startsWith(resolve(installed.directory) + sep)) throw new PlatformError('INVALID_PATH', '非法插件资源路径。', 403)
    const bytes = await readFile(path)
    if (createHash('sha256').update(bytes).digest('hex') !== installed.manifest.integrity[name]) throw new PlatformError('PLUGIN_INTEGRITY_FAILED', '插件资源已改变，拒绝加载。', 409)
    response.writeHead(200, { 'Content-Type': name === frontend.entry ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(bytes)
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
    for (const streams of this.logStreams.values()) for (const stop of streams) stop()
    this.logStreams.clear()
    for (const id of this.sinkRegistrations.keys()) this.revokeHarnessSinks(id)
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
