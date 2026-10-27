import type { JsonValue, PluginLogEntry, PluginLogSource } from '@eating/plugin-sdk'

type Subscription = { readonly listener: (entry: PluginLogEntry) => void }

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) freezeJson(child)
  Object.freeze(value)
}

function snapshot(entry: PluginLogEntry): PluginLogEntry {
  const metadata = entry.metadata === undefined ? undefined : structuredClone(entry.metadata)
  if (metadata !== undefined) freezeJson(metadata)
  return Object.freeze({
    id: entry.id,
    timestamp: entry.timestamp,
    level: entry.level,
    event: entry.event,
    message: entry.message,
    ...(metadata === undefined ? {} : { metadata }),
  })
}

/** Viewer-scoped delivery only: no retained entries, replay, or background work. */
export class LiveLogChannel implements PluginLogSource {
  private readonly subscriptions = new Set<Subscription>()
  private disposed = false

  subscribe(listener: (entry: PluginLogEntry) => void): () => void {
    if (this.disposed) return () => {}
    const subscription: Subscription = { listener }
    this.subscriptions.add(subscription)
    return () => { this.subscriptions.delete(subscription) }
  }

  publish(factory: () => PluginLogEntry): void {
    if (this.disposed || this.subscriptions.size === 0) return
    const subscriptions = [...this.subscriptions]
    const entry = snapshot(factory())
    for (const subscription of subscriptions) {
      if (!this.subscriptions.has(subscription)) continue
      try { subscription.listener(entry) }
      catch { this.subscriptions.delete(subscription) }
    }
  }

  dispose(): void {
    this.disposed = true
    this.subscriptions.clear()
  }
}
