import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { PlatformError } from '@eating/plugin-sdk'
import type { DirectMcpConfiguration, JsonObject, JsonValue, McpGrant, McpServiceSummary, PluginToolDefinition } from '@eating/plugin-sdk'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024
const MAX_SERVICES = 100
const MAX_TOOLS = 1000
const CONNECT_MS = 15_000
const CALL_MS = 60_000
const idPattern = /^direct\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const toolPattern = /^[A-Za-z0-9_.-]{1,128}$/
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const ownKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))

function failure(code: string, message: string, status = 409, outcome: 'not-sent' | 'failed' | 'unknown' = 'not-sent'): PlatformError { return new PlatformError(code, message, status, outcome) }
function invalid(): never { throw failure('MCP_CONFIGURATION_INVALID', 'MCP 连接配置无效，请检查名称、传输参数和授权。', 400) }
function storageError(): PlatformError { return failure('MCP_STORAGE_INVALID', 'MCP 配置文件损坏或格式不匹配，原数据未被覆盖。', 500) }
function busy(): PlatformError { return failure('MCP_CONNECTION_BUSY', 'MCP 连接正在使用或清理，请先断开连接再修改。') }
function closed(): PlatformError { return failure('MCP_MANAGER_CLOSED', 'MCP 连接管理已关闭。', 503) }

function stringList(value: unknown, max: number, valid: (item: string) => boolean, unique = true): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !valid(item)) || unique && new Set(value).size !== value.length) return invalid()
  return [...value] as string[]
}
function grant(value: unknown): McpGrant {
  if (!object(value) || !ownKeys(value, ['agentTypeIds', 'toolNames'])) return invalid()
  return { agentTypeIds: stringList(value.agentTypeIds, 200, item => /^[a-z][a-z0-9]*(?:[.:-][a-z0-9-]+)*$/.test(item) && item.length <= 160), toolNames: stringList(value.toolNames, MAX_TOOLS, item => toolPattern.test(item)) }
}
function secretMap(value: unknown, previous: Readonly<Record<string, string>>, clear: unknown, headers: boolean): Record<string, string> {
  const validKey = (key: string) => !['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase()) && (headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) && !['host', 'content-length', 'connection', 'transfer-encoding', 'accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'].includes(key.toLowerCase()) : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
  const result = { ...previous }
  const remove = clear === undefined ? [] : stringList(clear, 128, validKey)
  const provided = new Set<string>()
  if (value !== undefined) {
    if (!object(value) || Object.keys(value).length > 128) return invalid()
    for (const [rawKey, entry] of Object.entries(value)) {
      const key = headers ? rawKey.toLowerCase() : rawKey
      if (!validKey(rawKey) || provided.has(key) || typeof entry !== 'string' || entry.length > 16_384 || (headers ? /[^\u0020-\u007e\u0080-\u00ff]/ : /\0/).test(entry)) return invalid()
      provided.add(key); result[key] = entry
    }
  }
  for (const rawKey of remove) {
    const key = headers ? rawKey.toLowerCase() : rawKey
    if (provided.has(key)) return invalid()
    delete result[key]
  }
  if (Object.keys(result).length > 128) return invalid()
  return result
}
function parseConfiguration(value: unknown, id: string, previous?: DirectMcpConfiguration, stored = false): DirectMcpConfiguration {
  if (!object(value) || !text(value.name, 80) || !value.name.trim() || typeof value.autoConnect !== 'boolean' || !['stdio', 'streamable-http'].includes(String(value.transport))) return invalid()
  const common = stored ? ['id', 'name', 'transport', 'autoConnect', 'grant'] : ['expectedRevision', 'name', 'transport', 'autoConnect', 'grant']
  const optional = stored ? [] : ['id']
  const base = { id, name: value.name.trim(), autoConnect: value.autoConnect, grant: grant(value.grant) }
  if (value.transport === 'stdio') {
    if (!ownKeys(value, [...common, 'command', 'args', ...(stored ? ['env'] : [])], [...optional, ...(!stored ? ['env', 'clearEnvKeys'] : [])]) || !text(value.command, 2048) || !value.command.trim()) return invalid()
    const args = stringList(value.args, 128, item => item.length <= 8192 && !item.includes('\0'), false)
    return { ...base, transport: 'stdio', command: value.command, args, env: secretMap(value.env, previous?.transport === 'stdio' ? previous.env ?? {} : {}, value.clearEnvKeys, false) }
  }
  const preserveUrl = !stored && previous?.transport === 'streamable-http'
  if (!ownKeys(value, [...common, ...(!preserveUrl ? ['url'] : []), ...(stored ? ['headers'] : [])], [...optional, ...(preserveUrl ? ['url'] : []), ...(!stored ? ['headers', 'clearHeaderKeys'] : [])])) return invalid()
  const address = value.url === undefined && preserveUrl ? previous.url : value.url
  if (!text(address, 4096) || !address.trim()) return invalid()
  let url: URL
  try { url = new URL(address) } catch { return invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || /^[a-z]+:\/\/[^/?#]*@/i.test(url.href) || address.includes('#')) return invalid()
  return { ...base, transport: 'streamable-http', url: url.href, headers: secretMap(value.headers, previous?.transport === 'streamable-http' ? previous.headers ?? {} : {}, value.clearHeaderKeys, true) }
}

interface Snapshot { readonly schemaVersion: 1; readonly revision: number; readonly connections: readonly DirectMcpConfiguration[] }
interface LiveConnection {
  readonly client: Client
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport
  readonly lifetime: AbortController
  cleanup?: Promise<void>
  fault?: PlatformError
}
interface Entry {
  configuration: DirectMcpConfiguration
  state: McpServiceSummary['state']
  lastError: string | null
  tools: PluginToolDefinition[]
  connection?: LiveConnection
  connecting?: Promise<void>
  stopping?: Promise<void>
  removing?: boolean
}

function json(value: unknown): value is JsonValue {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++nodes > 50_000 || entry.depth > 64) return false
    if (entry.value === null || typeof entry.value === 'string' || typeof entry.value === 'boolean' || typeof entry.value === 'number' && Number.isFinite(entry.value)) continue
    if (!object(entry.value) && !Array.isArray(entry.value)) return false
    const children = Array.isArray(entry.value) ? entry.value : Object.values(entry.value)
    if (children.length + pending.length + nodes > 50_000 || object(entry.value) && Object.keys(entry.value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return false
    for (const child of children) pending.push({ value: child, depth: entry.depth + 1 })
  }
  return true
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const abort = () => reject(new Error('interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(accept, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Native MCP transport connections; grants and external-action idempotency are enforced by the Host gateway. */
export class DirectMcpConnections {
  private readonly directory: string
  private readonly file: string
  private readonly entries = new Map<string, Entry>()
  private currentRevision = 0
  private ended = false
  private closing?: Promise<void>

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory)
    try {
      let existing: ReturnType<typeof lstatSync> | undefined
      try { existing = lstatSync(this.directory) } catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error }
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw storageError()
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700)
    } catch { throw storageError() }
    this.file = join(this.directory, 'connections.json')
    const snapshot = this.readSnapshot()
    this.currentRevision = snapshot.revision
    for (const configuration of snapshot.connections) this.entries.set(configuration.id, { configuration, state: 'disconnected', lastError: null, tools: [] })
  }

  get revision(): number { return this.currentRevision }
  list(): readonly McpServiceSummary[] { return [...this.entries.keys()].map(id => this.get(id)) }
  get(id: string): McpServiceSummary {
    const entry = this.require(id)
    const config = entry.configuration
    const url = config.transport === 'streamable-http' ? new URL(config.url) : null
    const configuration: JsonObject = config.transport === 'stdio'
      ? { command: config.command, args: [...config.args], envKeys: Object.keys(config.env ?? {}) }
      : { url: `${url!.origin}${url!.pathname}`, urlHasQuery: Boolean(url!.search), queryKeys: [...new Set(url!.searchParams.keys())], headerKeys: Object.keys(config.headers ?? {}) }
    return structuredClone({ id: config.id, name: config.name, source: { kind: 'direct' as const }, transport: config.transport, enabled: true, autoConnect: config.autoConnect,
      state: entry.state, lastError: entry.lastError, tools: entry.tools, grant: config.grant, configuration })
  }

  save(input: unknown): McpServiceSummary {
    if (this.ended) throw closed()
    if (!object(input) || !revision(input.expectedRevision) || input.id !== undefined && typeof input.id !== 'string') return invalid()
    this.checkRevision(input.expectedRevision)
    const id = input.id ? String(input.id) : `direct.${randomUUID()}`
    if (!idPattern.test(id)) return invalid()
    const previous = input.id ? this.require(id) : undefined
    if (previous && (previous.connection || previous.connecting || previous.stopping || previous.removing)) throw busy()
    if (!previous && this.entries.size >= MAX_SERVICES) throw failure('MCP_SERVICE_LIMIT', 'MCP 连接数量已达到上限。', 409)
    const configuration = parseConfiguration(input, id, previous?.configuration)
    const connections = [...this.entries.values()].map(entry => entry.configuration.id === id ? configuration : entry.configuration)
    if (!previous) connections.push(configuration)
    this.persist(connections, input.expectedRevision)
    this.entries.set(id, { configuration, state: 'disconnected', lastError: null, tools: [] })
    return this.get(id)
  }

  setGrant(id: string, next: McpGrant, expectedRevision: number): McpServiceSummary {
    if (this.ended) throw closed()
    this.checkRevision(expectedRevision)
    const entry = this.require(id)
    if (entry.removing) throw busy()
    const configuration = { ...entry.configuration, grant: grant(next) }
    this.persist([...this.entries.values()].map(item => item === entry ? configuration : item.configuration), expectedRevision)
    entry.configuration = configuration
    return this.get(id)
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    if (this.ended) throw closed()
    this.checkRevision(expectedRevision)
    const entry = this.require(id)
    if (entry.removing) throw busy()
    entry.removing = true
    try {
      await this.disconnect(id)
      if (this.ended) throw closed()
      this.persist([...this.entries.values()].filter(item => item !== entry).map(item => item.configuration), expectedRevision)
      this.entries.delete(id)
    } finally { entry.removing = false }
  }

  connect(id: string): Promise<void> {
    if (this.ended) return Promise.reject(closed())
    const entry = this.require(id)
    if (entry.removing || entry.stopping) return Promise.reject(busy())
    if (entry.connecting) return entry.connecting
    if (entry.state === 'connected') return Promise.resolve()
    entry.state = 'connecting'; entry.lastError = null; entry.tools = []
    const task = this.start(entry)
    entry.connecting = task
    void task.finally(() => { if (entry.connecting === task) entry.connecting = undefined }).catch(() => {})
    return task
  }

  disconnect(id: string): Promise<void> {
    const entry = this.require(id)
    const connection = entry.connection
    entry.connection = undefined; entry.state = 'disconnected'; entry.tools = []; entry.lastError = null
    if (entry.stopping) return entry.stopping
    if (!connection) return Promise.resolve()
    connection.lifetime.abort()
    return this.stop(entry, connection)
  }

  async call(id: string, name: string, args: JsonObject, signal?: AbortSignal): Promise<CallToolResult> {
    if (this.ended) throw closed()
    const entry = this.require(id)
    const connection = entry.connection
    if (entry.state !== 'connected' || !connection || connection.lifetime.signal.aborted) throw failure('MCP_NOT_CONNECTED', 'MCP 服务尚未连接。')
    if (!entry.tools.some(tool => tool.name === name)) throw failure('MCP_TOOL_NOT_FOUND', '此 MCP 服务未提供该工具。', 404)
    if (!object(args) || !json(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_FILE_BYTES) throw failure('MCP_ARGUMENTS_INVALID', 'MCP 工具参数无效或超出大小限制。', 400)
    if (signal?.aborted) throw failure('MCP_REQUEST_ABORTED', 'MCP 请求已取消。')
    const timeout = new AbortController()
    const combined = AbortSignal.any([connection.lifetime.signal, timeout.signal, ...(signal ? [signal] : [])])
    let expired = false
    const timer = setTimeout(() => { expired = true; timeout.abort() }, CALL_MS)
    timer.unref()
    try {
      const result = await abortable(connection.client.callTool({ name, arguments: args }, CallToolResultSchema, { signal: combined, timeout: CALL_MS, maxTotalTimeout: CALL_MS }), combined)
      if (entry.connection !== connection || combined.aborted || this.ended) throw new Error('stale')
      return CallToolResultSchema.parse(result)
    } catch (error) {
      const interrupted = combined.aborted || error instanceof McpError && error.code === ErrorCode.RequestTimeout
      if (interrupted && entry.connection === connection) this.lose(entry, connection)
      if (signal?.aborted) throw failure('MCP_REQUEST_ABORTED', 'MCP 请求已取消，工具执行结果可能尚未确认。', 409, 'unknown')
      if (expired || error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw failure('MCP_CALL_TIMEOUT', 'MCP 工具调用超时，执行结果尚未确认，请勿自动重试。', 504, 'unknown')
      if (entry.connection !== connection || connection.lifetime.signal.aborted || this.ended) throw failure('MCP_CALL_INTERRUPTED', 'MCP 连接已中断，工具执行结果尚未确认。', 503, 'unknown')
      if (error instanceof McpError && [ErrorCode.InvalidParams, ErrorCode.MethodNotFound, ErrorCode.InvalidRequest].includes(error.code)) throw failure('MCP_CALL_FAILED', 'MCP 服务拒绝了此工具请求，请检查工具参数。', 502, 'failed')
      throw failure('MCP_CALL_FAILED', 'MCP 工具调用失败，执行结果尚未确认，请先核对服务状态。', 502, 'unknown')
    } finally { clearTimeout(timer) }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.ended = true
    this.closing = Promise.allSettled([...this.entries.keys()].map(id => this.disconnect(id))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw failure('MCP_CLOSE_FAILED', '部分 MCP 连接未能完成清理。', 500, 'failed')
    })
    return this.closing
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw failure('MCP_SERVICE_NOT_FOUND', 'MCP 连接不存在。', 404)
    return entry
  }
  private checkRevision(expected: number): void {
    if (!revision(expected) || expected !== this.currentRevision) throw failure('MCP_REVISION_CONFLICT', 'MCP 配置已改变，请刷新后重试。')
  }

  private readSnapshot(): Snapshot {
    let descriptor: number | undefined
    try {
      const directory = lstatSync(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw storageError()
      try { lstatSync(this.file) } catch (error) { if (object(error) && error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, connections: [] }; throw error }
      const info = lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw storageError()
      descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      if (!fstatSync(descriptor).isFile()) throw storageError()
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
      const size = readSync(descriptor, bytes, 0, bytes.length, 0)
      if (size > MAX_FILE_BYTES) throw storageError()
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
      if (!object(value) || !ownKeys(value, ['schemaVersion', 'revision', 'connections']) || value.schemaVersion !== 1 || !revision(value.revision) || !Array.isArray(value.connections) || value.connections.length > MAX_SERVICES) throw storageError()
      const ids = new Set<string>()
      const connections = value.connections.map(item => {
        if (!object(item) || typeof item.id !== 'string' || !idPattern.test(item.id) || ids.has(item.id)) throw storageError()
        ids.add(item.id)
        return parseConfiguration(item, item.id, undefined, true)
      })
      chmodSync(this.file, 0o600)
      return { schemaVersion: 1, revision: value.revision, connections }
    } catch { throw storageError() }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
  }

  private persist(connections: readonly DirectMcpConfiguration[], expected: number): void {
    this.checkRevision(expected)
    if (this.readSnapshot().revision !== expected) throw failure('MCP_REVISION_CONFLICT', 'MCP 配置已改变，请刷新后重试。')
    if (expected === Number.MAX_SAFE_INTEGER) throw failure('MCP_REVISION_EXHAUSTED', 'MCP 配置版本已达到上限。', 500)
    const bytes = JSON.stringify({ schemaVersion: 1, revision: expected + 1, connections } satisfies Snapshot) + '\n'
    if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw failure('MCP_CONFIGURATION_TOO_LARGE', 'MCP 配置超出大小限制，未保存修改。', 400)
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    let descriptor: number | undefined
    let created = false
    let replaced = false
    try {
      const info = lstatSync(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw storageError()
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true
      writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
      renameSync(temporary, this.file); created = false; replaced = true
      this.currentRevision = expected + 1
      const ids = new Set(connections.map(configuration => configuration.id))
      for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id)
      for (const configuration of connections) {
        const entry = this.entries.get(configuration.id)
        if (entry) entry.configuration = configuration
        else this.entries.set(configuration.id, { configuration, state: 'disconnected', lastError: null, tools: [] })
      }
      if (process.platform !== 'win32') {
        const directory = openSync(this.directory, constants.O_RDONLY)
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } catch {
      if (replaced) throw failure('MCP_SAVE_UNCERTAIN', 'MCP 配置已替换，但未能确认持久保存，请刷新核对后再操作。', 500, 'unknown')
      throw failure('MCP_SAVE_FAILED', 'MCP 配置保存失败，请检查目录权限与磁盘空间。', 500, 'failed')
    }
    finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (created && dirname(resolve(temporary)) === this.directory) { try { unlinkSync(temporary) } catch { /* Only our verified exclusive temporary file. */ } }
    }
  }

  private async start(entry: Entry): Promise<void> {
    const config = entry.configuration
    const lifetime = new AbortController()
    const transport = config.transport === 'stdio' ? new StdioClientTransport({ command: config.command, args: [...config.args], env: { ...config.env }, cwd: this.directory, stderr: 'ignore', maxBufferSize: MAX_MESSAGE_BYTES })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { ...config.headers }, redirect: 'error' }, fetch: (input, init) => this.http(input, init, lifetime.signal), reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
    const closeTransport = transport.close.bind(transport)
    let transportClosing: Promise<void> | undefined
    transport.close = () => transportClosing ??= closeTransport()
    const client = new Client({ name: 'eating-direct-mcp', version: '1.0.0' }, { capabilities: {}, enforceStrictCapabilities: true, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
    const connection: LiveConnection = { client, transport, lifetime }
    entry.connection = connection
    client.onclose = () => this.lose(entry, connection)
    client.onerror = () => this.lose(entry, connection)
    const timeout = new AbortController()
    const combined = AbortSignal.any([lifetime.signal, timeout.signal])
    const timer = setTimeout(() => timeout.abort(), CONNECT_MS); timer.unref()
    try {
      const tools = await abortable((async () => {
        await client.connect(transport, { signal: combined, timeout: CONNECT_MS, maxTotalTimeout: CONNECT_MS })
        const result: PluginToolDefinition[] = []
        let cursor: string | undefined
        const cursors = new Set<string>()
        const names = new Set<string>()
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal: combined, timeout: CONNECT_MS, maxTotalTimeout: CONNECT_MS })
          for (const tool of page.tools) {
            if (!toolPattern.test(tool.name) || names.has(tool.name) || !json(tool.inputSchema) || !object(tool.inputSchema) || result.length === MAX_TOOLS) throw failure('MCP_TOOLS_INVALID', 'MCP 工具目录格式无效或超出限制。', 502, 'failed')
            names.add(tool.name)
            result.push({ name: tool.name, title: tool.title ?? tool.annotations?.title ?? tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as JsonObject, readOnly: tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructiveHint ?? tool.annotations?.readOnlyHint !== true, resultFormat: 'content' })
          }
          cursor = page.nextCursor
          if (cursor !== undefined && (!cursor || cursor.length > 4096 || cursors.has(cursor) || cursors.size >= 100)) throw failure('MCP_TOOLS_INVALID', 'MCP 工具目录分页无效或超出限制。', 502, 'failed')
          if (cursor) cursors.add(cursor)
        } while (cursor !== undefined)
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * MAX_FILE_BYTES) throw failure('MCP_TOOLS_INVALID', 'MCP 工具目录超出大小限制。', 502, 'failed')
        return result
      })(), combined)
      if (entry.connection !== connection || combined.aborted || this.ended) throw new Error('stale')
      entry.tools = tools; entry.state = 'connected'
    } catch (error) {
      const result = timeout.signal.aborted ? failure('MCP_CONNECT_TIMEOUT', 'MCP 连接超时，请检查服务后手动重试。', 504, 'failed')
        : entry.connection !== connection || lifetime.signal.aborted || this.ended ? connection.fault ?? failure('MCP_CONNECT_INTERRUPTED', 'MCP 连接已取消。', 409, 'not-sent')
          : error instanceof PlatformError ? error : failure('MCP_CONNECT_FAILED', 'MCP 服务连接失败，请检查命令、地址、认证与服务状态。', 502, 'failed')
      if (entry.connection === connection) { entry.connection = undefined; entry.state = 'error'; entry.lastError = result.message; entry.tools = [] }
      lifetime.abort()
      void this.stop(entry, connection).catch(() => {})
      throw result
    } finally { clearTimeout(timer) }
  }

  private lose(entry: Entry, connection: LiveConnection): void {
    if (entry.connection !== connection) return
    connection.fault = failure('MCP_CONNECTION_LOST', 'MCP 连接已中断，请检查服务后手动重新连接。', 503, 'failed')
    entry.connection = undefined; entry.state = 'error'; entry.lastError = connection.fault.message; entry.tools = []
    connection.lifetime.abort()
    void this.stop(entry, connection).catch(() => {})
  }
  private stop(entry: Entry, connection: LiveConnection): Promise<void> {
    if (!connection.cleanup) connection.cleanup = (async () => {
      let unsuccessful = false
      if (connection.transport instanceof StreamableHTTPClientTransport && connection.transport.sessionId) {
        try { await connection.transport.terminateSession() } catch { unsuccessful = true }
      }
      try { await connection.client.close() } catch { unsuccessful = true }
      if (unsuccessful) throw failure('MCP_DISCONNECT_FAILED', 'MCP 连接清理未全部完成，请检查服务状态。', 502, 'failed')
    })()
    entry.stopping = connection.cleanup
    void connection.cleanup.finally(() => { if (entry.stopping === connection.cleanup) entry.stopping = undefined }).catch(() => {})
    return connection.cleanup
  }

  private async http(input: string | URL, init: RequestInit | undefined, lifetime: AbortSignal): Promise<Response> {
    const timeout = new AbortController()
    const deleting = init?.method === 'DELETE'
    const timer = setTimeout(() => timeout.abort(), deleting ? 2000 : CALL_MS); timer.unref()
    const combined = AbortSignal.any([timeout.signal, ...(init?.signal ? [init.signal] : []), ...(!deleting ? [lifetime] : [])])
    let retained = false
    try {
      const response = await fetch(input, { ...init, redirect: 'error', signal: combined })
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {})
        return new Response(null, { status: response.status, headers: response.headers })
      }
      if (init?.method === 'GET') clearTimeout(timer)
      const advertised = response.headers.get('content-length')
      if (advertised && Number(advertised) > MAX_MESSAGE_BYTES) throw new Error('oversized MCP response')
      const reader = response.body.getReader()
      let bytes = 0
      const finish = () => { clearTimeout(timer); timeout.abort() }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) { finish(); reader.releaseLock(); controller.close(); return }
            bytes += chunk.value.byteLength
            if (bytes > MAX_MESSAGE_BYTES) throw new Error('oversized MCP response')
            controller.enqueue(chunk.value)
          } catch { finish(); controller.error(new Error('MCP response unavailable')) }
        },
        async cancel() { finish(); try { await reader.cancel() } catch { /* The lifetime is already aborted. */ } finally { reader.releaseLock() } },
      })
      retained = true
      return new Response(body, { status: response.status, headers: response.headers })
    } finally { if (!retained) { clearTimeout(timer); timeout.abort() } }
  }
}
