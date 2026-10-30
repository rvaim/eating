import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, McpDirectorySnapshot, McpGrant, McpServiceSummary, PluginToolDefinition } from '@eating/plugin-sdk'
import { HostApiError } from '@eating/ui-sdk'

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const textValue = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
function invalid(): never { throw new HostApiError('INVALID_HOST_RESPONSE', '', 'failed') }
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const stringList = (value: unknown, maxItems: number, maxLength: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > maxItems || !value.every(item => text(item, maxLength))) return invalid()
  return [...value] as string[]
}

function readTool(value: unknown): PluginToolDefinition {
  if (!isJsonObject(value) || !onlyKeys(value, ['name', 'title', 'description', 'inputSchema', 'readOnly', 'destructive', 'resultFormat', 'protocolAction', 'sensitiveResult'])
    || !text(value.name, 160) || !textValue(value.title, 200) || !textValue(value.description, 4000) || !isJsonObject(value.inputSchema)
    || typeof value.readOnly !== 'boolean' || typeof value.destructive !== 'boolean'
    || (value.resultFormat !== 'json' && value.resultFormat !== 'content')
    || value.protocolAction !== undefined && !text(value.protocolAction, 200)
    || value.sensitiveResult !== undefined && typeof value.sensitiveResult !== 'boolean') return invalid()
  return { name: value.name, title: value.title, description: value.description, inputSchema: value.inputSchema,
    readOnly: value.readOnly, destructive: value.destructive, resultFormat: value.resultFormat,
    ...(typeof value.protocolAction === 'string' ? { protocolAction: value.protocolAction } : {}),
    ...(typeof value.sensitiveResult === 'boolean' ? { sensitiveResult: value.sensitiveResult } : {}) }
}

function readGrant(value: unknown): McpGrant {
  if (!isJsonObject(value) || !onlyKeys(value, ['agentTypeIds', 'toolNames'])) return invalid()
  return { agentTypeIds: stringList(value.agentTypeIds, 100, 160), toolNames: stringList(value.toolNames, 500, 200) }
}

function readConfiguration(value: unknown): JsonObject {
  if (!isJsonObject(value)) return invalid()
  const arrays = ['args', 'envKeys', 'headerKeys', 'queryKeys'] as const
  for (const key of arrays) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 500 || !value[key].every(item => text(item, key === 'args' ? 2000 : 200)))) return invalid()
  for (const key of ['command', 'url'] as const) if (value[key] !== undefined && !text(value[key], 4096)) return invalid()
  if (value.urlHasQuery !== undefined && typeof value.urlHasQuery !== 'boolean') return invalid()
  if (value.permissionsManagedByPlugin !== undefined && typeof value.permissionsManagedByPlugin !== 'boolean') return invalid()
  if (value.pluginKind !== undefined && !['communication', 'harness', 'capability'].includes(String(value.pluginKind))) return invalid()
  return value
}

function readSource(value: unknown): McpServiceSummary['source'] {
  if (!isJsonObject(value)) return invalid()
  if (value.kind === 'direct' && onlyKeys(value, ['kind'])) return { kind: 'direct' }
  if (value.kind === 'plugin' && onlyKeys(value, ['kind', 'pluginId', 'pluginName']) && text(value.pluginId, 160) && text(value.pluginName, 200)) {
    return { kind: 'plugin', pluginId: value.pluginId, pluginName: value.pluginName }
  }
  return invalid()
}

function readService(value: unknown): McpServiceSummary {
  if (!isJsonObject(value) || !onlyKeys(value, ['id', 'name', 'source', 'transport', 'enabled', 'autoConnect', 'state', 'lastError', 'tools', 'grant', 'configuration'])
    || !text(value.id, 160) || !text(value.name, 200)
    || !['stdio', 'streamable-http', 'plugin'].includes(String(value.transport))
    || typeof value.enabled !== 'boolean' || typeof value.autoConnect !== 'boolean'
    || !['disconnected', 'connecting', 'connected', 'error'].includes(String(value.state))
    || value.lastError !== null && !text(value.lastError, 4000)
    || !Array.isArray(value.tools) || value.tools.length > 500) return invalid()
  return { id: value.id, name: value.name, source: readSource(value.source), transport: value.transport as McpServiceSummary['transport'],
    enabled: value.enabled, autoConnect: value.autoConnect, state: value.state as McpServiceSummary['state'],
    lastError: value.lastError as string | null, tools: value.tools.map(readTool), grant: readGrant(value.grant), configuration: readConfiguration(value.configuration) }
}

export function readMcpDirectory(value: unknown): McpDirectorySnapshot {
  if (!isJsonObject(value) || !onlyKeys(value, ['protocolVersion', 'revision', 'services', 'agentTypes'])
    || value.protocolVersion !== 1 || !integer(value.revision)
    || !Array.isArray(value.services) || value.services.length > 200
    || !Array.isArray(value.agentTypes) || value.agentTypes.length > 100) return invalid()
  const seen = new Set<string>()
  const services = value.services.map(readService)
  for (const service of services) { if (seen.has(service.id)) return invalid(); seen.add(service.id) }
  const agentTypes = value.agentTypes.map(entry => {
    if (!isJsonObject(entry) || !onlyKeys(entry, ['id', 'title']) || !text(entry.id, 160) || !text(entry.title, 200)) return invalid()
    return { id: entry.id, title: entry.title }
  })
  return { protocolVersion: 1, revision: value.revision, services, agentTypes }
}

export interface McpMutationResult { readonly snapshot: McpDirectorySnapshot; readonly harnessStopped: boolean }

/** POST /api/mcp returns the latest snapshot plus an optional stop notice. */
export function readMcpMutationResult(value: unknown): McpMutationResult {
  if (!isJsonObject(value)) return invalid()
  const { harnessStopped, ...snapshot } = value
  if (harnessStopped !== undefined && typeof harnessStopped !== 'boolean') return invalid()
  return { snapshot: readMcpDirectory(snapshot), harnessStopped: harnessStopped === true }
}

export interface DirectMcpSaveInput {
  readonly expectedRevision: number
  readonly id?: string
  readonly name: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly clearEnvKeys?: readonly string[]
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly clearHeaderKeys?: readonly string[]
  readonly autoConnect: boolean
  readonly grant: McpGrant
}

/** Wire helpers keep the two transports mutually exclusive. */
export function stdioSaveInput(input: DirectMcpSaveInput) {
  return { expectedRevision: input.expectedRevision, ...(input.id ? { id: input.id } : {}), name: input.name, transport: 'stdio',
    command: input.command ?? '', args: [...(input.args ?? [])], ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
    ...(input.clearEnvKeys && input.clearEnvKeys.length ? { clearEnvKeys: input.clearEnvKeys } : {}), autoConnect: input.autoConnect, grant: input.grant }
}
export function httpSaveInput(input: DirectMcpSaveInput) {
  return { expectedRevision: input.expectedRevision, ...(input.id ? { id: input.id } : {}), name: input.name, transport: 'streamable-http',
    ...(input.url && input.url.trim() ? { url: input.url.trim() } : {}), ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
    ...(input.clearHeaderKeys && input.clearHeaderKeys.length ? { clearHeaderKeys: input.clearHeaderKeys } : {}), autoConnect: input.autoConnect, grant: input.grant }
}
