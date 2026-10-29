export type ObjectValue = Record<string, unknown>
export const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
export const textBlocks = (value: unknown): string => Array.isArray(value) ? value.filter(object).filter(block => block.type === 'text').map(block => typeof block.text === 'string' ? block.text : '').join('') : ''
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)

export interface PlatformEnvelope { readonly task?: string; readonly events: readonly ObjectValue[] }
/** Interpret the complete trusted transport envelope; JSON fragments in an external text never enter this path. */
export function platformEnvelope(source: unknown, content: unknown, sessionId: string, rootId: string): PlatformEnvelope | undefined {
  if (!object(source) || !['user', 'agent-message'].includes(String(source.kind)) || 'rpcId' in source || !Array.isArray(content) || content.length === 0 || content.some(block => !object(block) || block.type !== 'text' || typeof block.text !== 'string')) return undefined
  let value: unknown
  try { value = JSON.parse(textBlocks(content)) } catch { return undefined }
  if (!object(value) || Object.keys(value).some(key => !['eating', 'context', 'events', 'task'].includes(key)) || !object(value.eating) || !object(value.context) || !Array.isArray(value.events) || !value.events.length || value.events.length > 200) return undefined
  const { eating, context, events } = value
  if (eating.protocolVersion !== 1 || !digest(context.contextRef) || !identity(context.agentTypeId) || !identity(context.accountId) || !identity(context.instanceId) || !identity(context.conversationId) || !['private', 'group'].includes(String(context.kind))) return undefined
  if (sessionId === rootId) {
    if (source.kind !== 'user' || eating.magic !== 'eating-harness-delivery' || eating.sessionId !== rootId || eating.batchId !== context.contextRef || !digest(eating.digest) || !identity(eating.nonce) || 'task' in value) return undefined
  } else if (typeof value.task !== 'string' || eating.contextRef !== context.contextRef || eating.agentTypeId !== context.agentTypeId || source.kind === 'agent-message' && source.senderSessionId !== rootId) return undefined
  const first = events[0]
  if (!object(first) || !identity(first.pluginId) || !identity(first.platform) || !identity(first.targetId)) return undefined
  for (const event of events) {
    if (!object(event) || !object(event.source) || event.protocolVersion !== 1 || event.source.trust !== 'external' || event.source.kind !== context.kind || event.pluginId !== first.pluginId || event.platform !== first.platform || event.accountId !== context.accountId || event.instanceId !== context.instanceId || event.conversationId !== context.conversationId || event.targetId !== first.targetId || !identity(event.eventId) || !identity(event.senderId) || !identity(event.receivedAt) || !Number.isFinite(Date.parse(event.receivedAt))) return undefined
  }
  return { ...(typeof value.task === 'string' ? { task: value.task } : {}), events: events as ObjectValue[] }
}

/** Native tool success and a known external action outcome are separate facts. */
export function toolOutcome(tool: unknown): 'succeeded' | 'failed' | 'unknown' | 'not-sent' | 'running' {
  if (!object(tool)) return 'unknown'
  if (tool.kind !== 'tool-result') return 'running'
  let value: unknown
  try { value = JSON.parse(textBlocks(tool.content)) } catch { value = undefined }
  if (object(value) && ['succeeded', 'failed', 'unknown', 'not-sent'].includes(String(value.outcome))) return value.outcome as 'succeeded' | 'failed' | 'unknown' | 'not-sent'
  return tool.isError === true ? 'failed' : 'succeeded'
}

/** Never render provider reasoning, credentials, image bytes, or native transport nonce/digest fields as raw details. */
export function displayValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[…]'
  if (Array.isArray(value)) return value.filter(item => !object(item) || !['reasoning', 'thinking', 'redacted_thinking'].includes(String(item.type))).map(item => displayValue(item, depth + 1))
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:reasoning|reasoning_content|thinking|signature|nonce|digest|data)$/.test(key)).map(([key, item]) => [key, /api.?key|token|authorization|cookie|credential|secret|pass(?:word)|headers/i.test(key) ? '[REDACTED]' : displayValue(item, depth + 1)]))
  return value
}
