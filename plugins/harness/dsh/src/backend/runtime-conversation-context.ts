/** A bounded projection of the root's native log, never a second history store. */
export function getConversationContextSource(): string {
  return String.raw`
  const conversationContexts = new Map();
  let conversationContextBytes = 0;
  const conversationIdentityKeys = ['pluginId', 'platform', 'instanceId', 'accountId', 'conversationId', 'kind', 'targetId', 'agentTypeId'];
  const conversationContextKey = scope => JSON.stringify(conversationIdentityKeys.map(key => scope[key]));
  function rememberConversationContext(context) {
    if (context.binding?.routingError) return;
    const key = conversationContextKey(context.payload.context);
    let history = conversationContexts.get(key);
    if (!history) history = { events: new Map(), bytes: 0, truncated: false };
    conversationContexts.delete(key); conversationContexts.set(key, history);
    for (const event of context.payload.events) {
      if (!opaque(event.eventId) || history.events.has(event.eventId)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (bytes > 256 * 1024) { history.truncated = true; continue; }
      history.events.set(event.eventId, { event, bytes });
      history.bytes += bytes; conversationContextBytes += bytes;
      while (history.events.size > 32 || history.bytes > 256 * 1024) {
        const [id, first] = history.events.entries().next().value;
        history.events.delete(id); history.bytes -= first.bytes; conversationContextBytes -= first.bytes; history.truncated = true;
      }
    }
    while (conversationContexts.size > 100 || conversationContextBytes > 4 * 1024 * 1024) {
      const [oldKey, oldest] = conversationContexts.entries().next().value;
      conversationContexts.delete(oldKey); conversationContextBytes -= oldest.bytes;
    }
  }
  function restoreConversationContext(event) {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'eating-external') return;
    const message = event.data;
    if (!Array.isArray(message.content) || message.content.some(block => block.type !== 'text' || typeof block.text !== 'string')) throw bridgeError('SESSION_RECOVERY_FAILED');
    const payload = JSON.parse(message.content.map(block => block.text).join(''));
    if (!record(payload.eating) || payload.eating.magic !== 'eating-harness-delivery' || payload.eating.protocolVersion !== 1 || payload.eating.sessionId !== sessionId || payload.eating.batchId !== message.source.batchId || !record(payload.context) || !Array.isArray(payload.context.conversations) || !Array.isArray(payload.events) || createHash('sha256').update(JSON.stringify({ context: payload.context, events: payload.events })).digest('hex') !== payload.eating.digest) throw bridgeError('SESSION_RECOVERY_FAILED');
    for (const conversation of payload.context.conversations) {
      const events = payload.events.filter(item => ['pluginId', 'platform', 'instanceId', 'accountId', 'conversationId', 'targetId'].every(key => item[key] === conversation[key]) && item.source?.kind === conversation.kind);
      rememberConversationContext({ binding: conversation, payload: { context: conversation, events } });
    }
  }
  function conversationHistory(context, scope) {
    if (!record(scope) || conversationIdentityKeys.some(key => key !== 'platform' && scope[key] !== context.payload.context[key]) || !Array.isArray(scope.messageIds) || !Array.isArray(scope.resourceIds)) throw bridgeError('OWNER_POLICY_INVALID');
    const history = conversationContexts.get(conversationContextKey(context.payload.context));
    if (!history) return {};
    const current = new Set(context.payload.events.map(event => event.eventId));
    const messages = new Set(scope.messageIds), resources = new Set(scope.resourceIds);
    const retained = [...history.events.values()].map(item => item.event);
    const boundary = retained.findIndex(event => current.has(event.eventId));
    if (boundary < 0) return { history: { events: [], truncated: true } };
    const events = retained.slice(0, boundary).filter(event => messages.has(event.messageId) && (event.resourceIds || []).every(id => resources.has(id)));
    return events.length || history.truncated ? { history: { events, truncated: history.truncated } } : {};
  }
`;
}
