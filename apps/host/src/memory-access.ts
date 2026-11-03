import { createHash } from 'node:crypto'
import { groupHarnessEvents, PlatformError } from '@eating/plugin-sdk'
import type { BackendPlugin, HarnessMemoryServices, MemoryAppendInput, MemoryBeginInput, MemoryContext, MemoryFinishInput, MemoryFlushInput, MemoryMessage, MemoryRecallResult } from '@eating/plugin-sdk'

interface Source { readonly context: MemoryContext; readonly messages: readonly MemoryMessage[]; readonly label: string }
interface Flight { readonly context: MemoryContext; current: MemoryContext | null; readonly sources: readonly Source[]; steering: MemoryMessage[]; readonly abort: AbortController }
interface Options { plugins(): Iterable<BackendPlugin>; enabled(id: string): boolean }
const empty = (): MemoryRecallResult => ({ text: '', items: [] })
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
const invalid = (): never => { throw new PlatformError('MEMORY_CONTEXT_INVALID', '记忆调用缺少有效的会话来源。', 400, 'not-sent') }
function messages(value: readonly MemoryMessage[]): MemoryMessage[] {
  if (!Array.isArray(value)) return invalid()
  return value.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.text.length > 32768 || typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp))
      || message.senderId !== undefined && !identifier(message.senderId) || message.messageId !== undefined && !identifier(message.messageId)
      || message.senderRole !== undefined && !['owner', 'administrator', 'user'].includes(message.senderRole)) return invalid()
    return { role: message.role, text: message.text, timestamp: message.timestamp,
      ...(message.senderId ? { senderId: message.senderId } : {}), ...(message.senderRole ? { senderRole: message.senderRole } : {}), ...(message.messageId ? { messageId: message.messageId } : {}) }
  })
}
function segments(value: readonly MemoryMessage[]): MemoryMessage[][] {
  const result: MemoryMessage[][] = []
  const budget = 256 * 1024 - 1024
  let segment: MemoryMessage[] = [], bytes = 2
  for (const message of value) {
    const size = Buffer.byteLength(JSON.stringify(message))
    if (size + 2 > budget) return invalid()
    if (segment.length && (segment.length >= 200 || bytes + 1 + size > budget)) { result.push(segment); segment = []; bytes = 2 }
    bytes += size + (segment.length ? 1 : 0); segment.push(message)
  }
  if (segment.length || !result.length) result.push(segment)
  return result
}
function merged(results: readonly MemoryRecallResult[]): MemoryRecallResult {
  const errors = results.flatMap(result => result.errors ?? [])
  return { text: results.map(result => result.text).filter(Boolean).join('\n\n').slice(0, 64000), items: results.flatMap(result => result.items).slice(0, 20), ...(errors.length ? { errors } : {}) }
}
const selfScope = (owner: boolean): MemoryContext['scope'] => ({ kind: 'self', platform: '', accountId: '', targetId: '', owner })
const label = (scope: MemoryContext['scope'], source = {}): string => 'Memory recall scope (trusted routing): ' + JSON.stringify({ ...source, ...scope })

/** Bounded current-turn coordination only. All long-term content stays in the selected provider. */
export class MemoryAccess {
  private readonly flights = new Map<string, Flight>()
  constructor(private readonly options: Options) {}
  private key(harnessId: string, agentId: string): string { return harnessId + '\0' + agentId }
  private providers(): BackendPlugin[] { return [...this.options.plugins()].filter(plugin => plugin.kind === 'capability' && plugin.memory && this.options.enabled(plugin.id) && plugin.getStatus().state === 'connected') }
  context(harnessId: string, agentId: string): MemoryContext | null | undefined {
    const flight = this.flights.get(this.key(harnessId, agentId))
    return flight && !flight.abort.signal.aborted ? structuredClone(flight.current) : undefined
  }
  services(harnessId: string): HarnessMemoryServices {
    return { begin: (input, signal) => this.begin(harnessId, input, signal), append: (input, signal) => this.append(harnessId, input, signal), finish: input => this.finish(harnessId, input), flush: input => this.flush(harnessId, input), end: (agentId, turnId) => this.end(harnessId, agentId, turnId) }
  }
  private async begin(harnessId: string, input: MemoryBeginInput, signal?: AbortSignal): Promise<MemoryRecallResult> {
    if (!this.options.enabled(harnessId) || !identifier(input.agentId) || input.agentTypeId !== 'main' || !identifier(input.turnId)) return invalid()
    const key = this.key(harnessId, input.agentId), previous = this.flights.get(key)
    if (previous?.context.turnId === input.turnId) return empty()
    if (previous) { previous.abort.abort(); this.flights.delete(key) }
    if (this.flights.size >= 512) throw new PlatformError('MEMORY_CAPACITY', '当前记忆会话数量达到容量上限。', 429, 'not-sent')
    const sources: Source[] = []
    if (input.batch) {
      const batch = input.batch
      if (batch.protocolVersion !== 1 || !Array.isArray(batch.events) || !batch.events.length
        || batch.conversationId !== null && !identifier(batch.conversationId)
        || batch.events.some(event => !event || event.protocolVersion !== 1 || !event.source || event.source.trust !== 'external' || !['private', 'group'].includes(event.source.kind)
          || !identifier(event.pluginId) || !identifier(event.instanceId) || !identifier(event.conversationId) || !identifier(event.targetId) || !identifier(event.platform) || !identifier(event.accountId) || !identifier(event.senderId)
          || event.source.senderRole !== undefined && !['owner', 'administrator', 'user'].includes(event.source.senderRole))) return invalid()
      const groups = groupHarnessEvents(batch.events)
      if (batch.conversationId !== (groups.length === 1 ? batch.events[0]!.conversationId : null)) return invalid()
      for (const events of groups) {
        const first = events[0]!
        if (events.some(event => event.platform !== first.platform)) return invalid()
        const type = [...this.options.plugins()].find(plugin => plugin.id === first.pluginId && plugin.kind === 'communication' && this.options.enabled(plugin.id))
        if (!type) return invalid()
        const owners = type.getAgentIdentity?.().owners ?? []
        const owner = first.source.kind === 'private' && events.every(event => event.source.senderRole === 'owner' && owners.includes(event.senderId) && event.senderId === event.targetId)
        const scope: MemoryContext['scope'] = { kind: first.source.kind, platform: first.platform, accountId: first.accountId, targetId: first.targetId!, owner }
        const captured = messages(events.map(event => ({ role: 'user', text: event.text, timestamp: event.receivedAt, senderId: event.senderId, senderRole: event.source.senderRole ?? 'user', ...(event.messageId !== undefined ? { messageId: event.messageId } : {}) })))
        sources.push({ context: { agentId: input.agentId, agentTypeId: 'main', turnId: input.turnId, scope }, messages: captured,
          label: label(scope, { pluginId: first.pluginId, instanceId: first.instanceId, conversationId: first.conversationId }) })
      }
    } else {
      const scope = selfScope(input.autonomous !== true)
      sources.push({ context: { agentId: input.agentId, agentTypeId: 'main', turnId: input.turnId, scope }, messages: messages(input.messages ?? []).filter(message => message.role === 'user'), label: label(scope) })
    }
    const context = sources[0]!.context, abort = new AbortController()
    const flight: Flight = { context, current: sources.length === 1 ? context : null, sources, steering: [], abort }
    this.flights.set(key, flight)
    const results: MemoryRecallResult[] = []
    for (const source of sources) {
      if (abort.signal.aborted || signal?.aborted || this.flights.get(key) !== flight) break
      const query = (!input.batch && input.query !== undefined ? input.query : source.messages.map(message => message.text).join('\n')).slice(0, 4000)
      results.push(await this.recall(harnessId, key, flight, source.context, source.label, query, signal))
    }
    return this.flights.get(key) === flight && !abort.signal.aborted && !signal?.aborted ? merged(results) : empty()
  }
  private async append(harnessId: string, input: MemoryAppendInput, signal?: AbortSignal): Promise<MemoryRecallResult> {
    const key = this.key(harnessId, input.agentId), flight = this.flights.get(key)
    if (!flight || flight.context.turnId !== input.turnId || flight.abort.signal.aborted || !this.options.enabled(harnessId)) return empty()
    const additions = messages(input.messages).filter(message => message.role === 'user')
    const seen = new Set([...flight.sources.filter(source => source.context.scope.kind === 'self').flatMap(source => source.messages), ...flight.steering].flatMap(message => message.messageId ? [message.messageId] : []))
    const fresh = additions.filter(message => { if (!message.messageId) return true; if (seen.has(message.messageId)) return false; seen.add(message.messageId); return true })
    if (!fresh.length) return empty()
    flight.steering.push(...fresh)
    const context: MemoryContext = { ...flight.context, scope: selfScope(true) }
    flight.current = flight.sources.length === 1 && flight.context.scope.kind === 'self' ? context : null
    return this.recall(harnessId, key, flight, context, label(context.scope), fresh.map(message => message.text).join('\n').slice(0, 4000), signal)
  }
  private async recall(harnessId: string, key: string, flight: Flight, context: MemoryContext, sourceLabel: string, query: string, signal?: AbortSignal): Promise<MemoryRecallResult> {
    const providers = this.providers(), abort = flight.abort
    if (!providers.length || !query.trim()) return empty()
    const items: MemoryRecallResult['items'][number][] = [], blocks: string[] = [], errors: string[] = []
    for (const plugin of providers) {
      if (abort.signal.aborted || signal?.aborted) break
      try {
        const result = await plugin.memory!.recall(context, query, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]))
        if (this.flights.get(key) !== flight || !this.options.enabled(plugin.id) || !this.options.enabled(harnessId) || abort.signal.aborted || signal?.aborted) continue
        items.push(...result.items.slice(0, 12).map(item => ({ ...item, text: sourceLabel + '\n' + item.text }))); if (result.text) blocks.push(sourceLabel + '\n' + result.text.slice(0, 50000))
      } catch (error) { errors.push(error instanceof PlatformError ? error.code : 'MEMORY_RECALL_FAILED') }
    }
    return { text: blocks.join('\n\n').slice(0, 64000), items: items.slice(0, 20), ...(errors.length ? { errors } : {}) }
  }
  private async finish(harnessId: string, input: MemoryFinishInput): Promise<void> {
    const key = this.key(harnessId, input.agentId), flight = this.flights.get(key)
    if (!flight || flight.context.turnId !== input.turnId || flight.abort.signal.aborted || !this.options.enabled(harnessId)) return
    if (typeof input.assistantText !== 'string' || input.assistantText.length > 32768 || !['completed', 'failed', 'cancelled'].includes(input.outcome) || !Array.isArray(input.actions) || input.actions.length > 128 || input.actions.some(action => !identifier(action.tool) || !['returned', 'succeeded', 'failed', 'unknown'].includes(action.outcome))) return invalid()
    this.flights.delete(key)
    const text = input.assistantText.trim(), assistant: MemoryMessage[] = text ? [{ role: 'assistant', text, timestamp: new Date().toISOString() }] : []
    const mixed = flight.sources.length > 1 || flight.context.scope.kind !== 'self' && flight.steering.length > 0
    const captures = flight.sources.map(source => {
      if (mixed) return { context: source.context, messages: [...source.messages], actions: [] }
      const output = [...source.messages, ...flight.steering, ...assistant]
      const isolated = source.context.scope.kind !== 'self' && segments(output).length > 1
      return { context: source.context, messages: isolated ? [...source.messages] : output, actions: isolated ? [] : input.actions }
    })
    if (mixed && flight.steering.length) captures.push({ context: { ...flight.context, scope: selfScope(true) }, messages: [...flight.steering, ...assistant], actions: input.actions })
    const failures: unknown[] = []
    for (const plugin of this.providers()) {
      for (const [sourceIndex, capture] of captures.entries()) {
        const parts = segments(capture.messages)
        for (const [partIndex, part] of parts.entries()) {
          const turnId = captures.length === 1 && parts.length === 1 ? capture.context.turnId : 'memory-' + createHash('sha256').update(JSON.stringify([flight.context.turnId, sourceIndex, partIndex])).digest('hex')
          try {
            await plugin.memory!.capture({ context: { ...capture.context, turnId }, messages: part, actions: partIndex === parts.length - 1 ? capture.actions : [], outcome: input.outcome })
          } catch (error) { failures.push(error) }
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Memory capture failed')
  }
  private async flush(harnessId: string, input: MemoryFlushInput): Promise<void> {
    if (!this.options.enabled(harnessId) || !identifier(input.agentId) || !['compaction', 'session-end'].includes(input.reason)) return invalid()
    const failures: unknown[] = []
    for (const plugin of this.providers()) {
      try { await plugin.memory!.flush?.(input.reason) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Memory flush failed')
  }
  private end(harnessId: string, agentId: string, turnId: string): void {
    const key = this.key(harnessId, agentId), flight = this.flights.get(key)
    if (flight?.context.turnId === turnId) { flight.abort.abort(); this.flights.delete(key) }
  }
  revokeHarness(harnessId: string): void { for (const [key, flight] of this.flights) if (key.startsWith(harnessId + '\0')) { flight.abort.abort(); this.flights.delete(key) } }
  revokeAgent(harnessId: string, agentId: string): void { const key = this.key(harnessId, agentId); this.flights.get(key)?.abort.abort(); this.flights.delete(key) }
  close(): void { for (const flight of this.flights.values()) flight.abort.abort(); this.flights.clear() }
}
