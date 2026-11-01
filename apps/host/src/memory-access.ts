import { PlatformError } from '@eating/plugin-sdk'
import type { BackendPlugin, HarnessMemoryServices, MemoryAppendInput, MemoryBeginInput, MemoryContext, MemoryFinishInput, MemoryMessage, MemoryRecallResult } from '@eating/plugin-sdk'

interface Flight { readonly context: MemoryContext; current: MemoryContext; readonly messages: readonly MemoryMessage[]; steering: MemoryMessage[]; readonly abort: AbortController }
interface Options { plugins(): Iterable<BackendPlugin>; enabled(id: string): boolean }
const empty = (): MemoryRecallResult => ({ text: '', items: [] })
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
const invalid = (): never => { throw new PlatformError('MEMORY_CONTEXT_INVALID', '记忆调用缺少有效的会话来源。', 400, 'not-sent') }
function messages(value: readonly MemoryMessage[]): MemoryMessage[] {
  if (!Array.isArray(value) || value.length > 200) return invalid()
  let bytes = 0
  return value.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.text.length > 32768 || !Number.isFinite(Date.parse(message.timestamp))) return invalid()
    bytes += Buffer.byteLength(message.text)
    if (bytes > 256 * 1024) return invalid()
    return { role: message.role, text: message.text, timestamp: message.timestamp,
      ...(message.senderId ? { senderId: message.senderId } : {}), ...(message.senderRole ? { senderRole: message.senderRole } : {}), ...(message.messageId ? { messageId: message.messageId } : {}) }
  })
}

/** Bounded current-turn coordination only. All long-term content stays in the selected provider. */
export class MemoryAccess {
  private readonly flights = new Map<string, Flight>()
  constructor(private readonly options: Options) {}
  private key(harnessId: string, agentId: string): string { return harnessId + '\0' + agentId }
  private providers(): BackendPlugin[] { return [...this.options.plugins()].filter(plugin => plugin.kind === 'capability' && plugin.memory && this.options.enabled(plugin.id) && plugin.getStatus().state === 'connected') }
  context(harnessId: string, agentId: string): MemoryContext | undefined {
    const flight = this.flights.get(this.key(harnessId, agentId))
    return flight && !flight.abort.signal.aborted ? structuredClone(flight.current) : undefined
  }
  services(harnessId: string): HarnessMemoryServices {
    return { begin: (input, signal) => this.begin(harnessId, input, signal), append: (input, signal) => this.append(harnessId, input, signal), finish: input => this.finish(harnessId, input), end: (agentId, turnId) => this.end(harnessId, agentId, turnId) }
  }
  private async begin(harnessId: string, input: MemoryBeginInput, signal?: AbortSignal): Promise<MemoryRecallResult> {
    if (!this.options.enabled(harnessId) || !identifier(input.agentId) || input.agentTypeId !== 'main' || !identifier(input.turnId)) return invalid()
    const key = this.key(harnessId, input.agentId), previous = this.flights.get(key)
    if (previous?.context.turnId === input.turnId) return empty()
    if (previous) { previous.abort.abort(); this.flights.delete(key) }
    if (this.flights.size >= 512) throw new PlatformError('MEMORY_CAPACITY', '当前记忆会话数量达到容量上限。', 429, 'not-sent')
    let captured: MemoryMessage[], scope: MemoryContext['scope']
    if (input.batch) {
      const batch = input.batch, first = batch.events[0]
      if (batch.protocolVersion !== 1 || !first || !identifier(first.targetId) || !identifier(first.platform) || !identifier(first.accountId)
        || batch.events.some(event => event.source.trust !== 'external' || event.platform !== first.platform || event.instanceId !== first.instanceId || event.accountId !== first.accountId || event.targetId !== first.targetId || event.conversationId !== batch.conversationId || event.source.kind !== first.source.kind)) return invalid()
      const type = [...this.options.plugins()].find(plugin => plugin.id === first.pluginId && plugin.kind === 'communication' && this.options.enabled(plugin.id))
      if (!type) return invalid()
      const owners = type.getAgentIdentity?.().owners ?? []
      // Re-evaluate owner identity from trusted plugin configuration, not message prose.
      const owner = first.source.kind === 'private' && batch.events.every(event => event.source.senderRole === 'owner' && owners.includes(event.senderId) && event.senderId === event.targetId)
      scope = { kind: first.source.kind, platform: first.platform, accountId: first.accountId, targetId: first.targetId, owner }
      captured = messages(batch.events.map(event => ({ role: 'user', text: event.text, timestamp: event.receivedAt, senderId: event.senderId, senderRole: event.source.senderRole ?? 'user', ...(event.messageId ? { messageId: event.messageId } : {}) })))
    } else {
      scope = { kind: 'self', platform: '', accountId: '', targetId: '', owner: input.autonomous !== true }
      captured = messages(input.messages ?? []).filter(message => message.role === 'user')
    }
    const context: MemoryContext = { agentId: input.agentId, agentTypeId: 'main', turnId: input.turnId, scope }, abort = new AbortController()
    const flight: Flight = { context, current: context, messages: captured, steering: [], abort }
    this.flights.set(key, flight)
    const query = (input.batch ? captured.map(message => message.text).join('\n') : input.query ?? captured.map(message => message.text).join('\n')).slice(0, 4000)
    return this.recall(harnessId, key, flight, context, query, signal)
  }
  private async append(harnessId: string, input: MemoryAppendInput, signal?: AbortSignal): Promise<MemoryRecallResult> {
    const key = this.key(harnessId, input.agentId), flight = this.flights.get(key)
    if (!flight || flight.context.turnId !== input.turnId || flight.abort.signal.aborted || !this.options.enabled(harnessId)) return empty()
    const additions = messages(input.messages).filter(message => message.role === 'user')
    const seen = new Set([...flight.messages, ...flight.steering].flatMap(message => message.messageId ? [message.messageId] : []))
    const fresh = additions.filter(message => !message.messageId || !seen.has(message.messageId))
    if (!fresh.length) return empty()
    flight.steering = messages([...flight.steering, ...fresh])
    const context: MemoryContext = { ...flight.context, scope: { kind: 'self', platform: '', accountId: '', targetId: '', owner: true } }
    flight.current = context
    return this.recall(harnessId, key, flight, context, fresh.map(message => message.text).join('\n').slice(0, 4000), signal)
  }
  private async recall(harnessId: string, key: string, flight: Flight, context: MemoryContext, query: string, signal?: AbortSignal): Promise<MemoryRecallResult> {
    const providers = this.providers(), abort = flight.abort
    if (!providers.length || !query.trim()) return empty()
    const items: MemoryRecallResult['items'][number][] = [], blocks: string[] = [], errors: string[] = []
    for (const plugin of providers) {
      if (abort.signal.aborted || signal?.aborted) break
      try {
        const result = await plugin.memory!.recall(context, query, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]))
        if (this.flights.get(key) !== flight || !this.options.enabled(plugin.id) || !this.options.enabled(harnessId) || abort.signal.aborted || signal?.aborted) continue
        items.push(...result.items.slice(0, 12)); if (result.text) blocks.push(result.text.slice(0, 50000))
      } catch (error) { errors.push(error instanceof PlatformError ? error.code : 'MEMORY_RECALL_FAILED') }
    }
    return { text: blocks.join('\n\n').slice(0, 64000), items: items.slice(0, 20), ...(errors.length ? { errors } : {}) }
  }
  private async finish(harnessId: string, input: MemoryFinishInput): Promise<void> {
    const key = this.key(harnessId, input.agentId), flight = this.flights.get(key)
    if (!flight || flight.context.turnId !== input.turnId || flight.abort.signal.aborted || !this.options.enabled(harnessId)) return
    if (typeof input.assistantText !== 'string' || input.assistantText.length > 32768 || !['completed', 'failed', 'cancelled'].includes(input.outcome) || !Array.isArray(input.actions) || input.actions.length > 128 || input.actions.some(action => !identifier(action.tool) || !['returned', 'succeeded', 'failed', 'unknown'].includes(action.outcome))) return invalid()
    // Remove before asynchronous provider calls; late completions cannot clear a new context.
    this.flights.delete(key)
    const text = input.assistantText.trim(), assistant: MemoryMessage[] = text ? [{ role: 'assistant', text, timestamp: new Date().toISOString() }] : []
    const mixed = flight.context.scope.kind !== 'self' && flight.steering.length > 0
    const output = mixed ? [...flight.messages] : [...flight.messages, ...flight.steering, ...assistant]
    const failures: unknown[] = []
    for (const plugin of this.providers()) {
      try {
        await plugin.memory!.capture({ context: flight.context, messages: output, actions: mixed ? [] : input.actions, outcome: input.outcome })
        if (mixed) await plugin.memory!.capture({ context: { ...flight.current, turnId: flight.context.turnId + ':native' }, messages: [...flight.steering, ...assistant], actions: input.actions, outcome: input.outcome })
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Memory capture failed')
  }
  private end(harnessId: string, agentId: string, turnId: string): void {
    const key = this.key(harnessId, agentId), flight = this.flights.get(key)
    if (flight?.context.turnId === turnId) { flight.abort.abort(); this.flights.delete(key) }
  }
  revokeHarness(harnessId: string): void { for (const [key, flight] of this.flights) if (key.startsWith(harnessId + '\0')) { flight.abort.abort(); this.flights.delete(key) } }
  revokeAgent(harnessId: string, agentId: string): void { const key = this.key(harnessId, agentId); this.flights.get(key)?.abort.abort(); this.flights.delete(key) }
  close(): void { for (const flight of this.flights.values()) flight.abort.abort(); this.flights.clear() }
}
