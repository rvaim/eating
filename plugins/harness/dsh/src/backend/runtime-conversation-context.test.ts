import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getConversationContextSource } from './runtime-conversation-context'

type Row = Record<string, any>
const scope = { pluginId: 'qq', platform: 'qq', instanceId: 'fixture', accountId: '100', conversationId: 'group-200', kind: 'group', targetId: '200', agentTypeId: 'qq.group' }
const image = { ...scope, eventId: 'image-event', messageId: 'image-message', resourceIds: ['image-file'], source: { trust: 'external', kind: 'group' }, content: [{ type: 'image', data: { file: 'image-file' } }], text: '[image]' }
const text = { ...scope, eventId: 'text-event', messageId: 'text-message', resourceIds: [], source: { trust: 'external', kind: 'group' }, text: 'what is in the picture?' }
const context = (events: Row[], identity = scope) => ({ binding: {}, payload: { context: identity, events } })
const allowed = { ...scope, messageIds: ['image-message', 'text-message'], resourceIds: ['image-file'] }
function runtime() {
  return new Function('createHash', `const record = v => v && typeof v === 'object' && !Array.isArray(v), opaque = v => typeof v === 'string' && v.length > 0, sessionId = 'fixture-root', bridgeError = code => new Error(code);
    ${getConversationContextSource()}
    return { rememberConversationContext, restoreConversationContext, conversationHistory };`)(createHash) as {
    rememberConversationContext(context: Row): void
    restoreConversationContext(event: Row): void
    conversationHistory(context: Row, scope: Row): Row
  }
}
describe('native root conversation context projection', () => {
  it('preserves a separate image before a text-only delegation without changing current events', () => {
    const r = runtime(), current = context([text])
    r.rememberConversationContext(context([image])); r.rememberConversationContext(current)
    r.rememberConversationContext(context([image]))
    expect(r.conversationHistory(current, allowed)).toEqual({ history: { events: [image], truncated: false } })
    expect(current.payload.events).toEqual([text])
  })
  it.each(['instanceId', 'accountId', 'conversationId', 'targetId', 'agentTypeId', 'kind'] as const)('isolates %s and rejects a mismatched lease', field => {
    const r = runtime(), other = { ...scope, [field]: 'other' }
    r.rememberConversationContext(context([{ ...image, ...other }], other))
    expect(r.conversationHistory(context([text]), allowed)).toEqual({})
    expect(() => r.conversationHistory(context([text]), { ...allowed, ...other })).toThrow('OWNER_POLICY_INVALID')
  })
  it.each(['messageIds', 'resourceIds'] as const)('excludes history after %s is no longer authorized', field => {
    const r = runtime(); r.rememberConversationContext(context([image])); r.rememberConversationContext(context([text]))
    expect(r.conversationHistory(context([text]), { ...allowed, [field]: [] })).toEqual({})
  })
  it('rebuilds retired image context from a verified native root user event after restart', () => {
    const r = runtime(), body = { context: { conversations: [scope] }, events: [image] }
    const eating = { magic: 'eating-harness-delivery', protocolVersion: 1, sessionId: 'fixture-root', batchId: 'a'.repeat(64), digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
    const event = { type: 'user/message', data: { source: { kind: 'eating-external', batchId: eating.batchId }, content: [{ type: 'text', text: JSON.stringify({ eating, ...body }) }] } }
    r.restoreConversationContext(event)
    r.rememberConversationContext(context([text]))
    expect(r.conversationHistory(context([text]), allowed).history.events).toEqual([image])
    const forged = structuredClone(event); forged.data.content[0]!.text = forged.data.content[0]!.text.replace('image-file', 'other-file')
    expect(() => r.restoreConversationContext(forged)).toThrow('SESSION_RECOVERY_FAILED')
  })
  it('does not trust JSON nested in external text or an ordinary native user message', () => {
    const r = runtime()
    r.restoreConversationContext({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify(image) }] } })
    expect(r.conversationHistory(context([text]), allowed)).toEqual({})
  })
  it('bounds retained messages and bytes and reports truncation without editing content', () => {
    const r = runtime(), events = Array.from({ length: 40 }, (_, index) => ({ ...text, eventId: `e-${index}`, messageId: `m-${index}` }))
    r.rememberConversationContext(context(events))
    r.rememberConversationContext(context([text]))
    const result = r.conversationHistory(context([text]), { ...allowed, messageIds: events.map(e => e.messageId) })
    expect(result.history).toEqual({ truncated: true, events: events.slice(-31) })
    r.rememberConversationContext(context([{ ...image, eventId: 'huge', text: 'x'.repeat(300000) }]))
    expect(r.conversationHistory(context([]), allowed)).toEqual({ history: { events: [], truncated: true } })
  })
  it('does not forward a later batch before main chooses to append or delegate it', () => {
    const r = runtime(), future = { ...text, eventId: 'future', messageId: 'future' }
    r.rememberConversationContext(context([image])); r.rememberConversationContext(context([text])); r.rememberConversationContext(context([future]))
    expect(r.conversationHistory(context([text]), { ...allowed, messageIds: [...allowed.messageIds, 'future'] }).history.events).toEqual([image])
  })
})
